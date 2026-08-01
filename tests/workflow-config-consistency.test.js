// Config nodes must not drift apart.
//
// Moving configuration out of `$env` and into a node per workflow buys one
// obvious place per workflow — and costs a new failure mode. `$env` had exactly
// one definition of `UPSTREAM_API_URL` for the whole stack; five config nodes
// have five, and nothing stops one of them being edited and the others not.
// `01-order-intake` posting to the new endpoint while `dlq-replay` replays its
// backlog to the old one is silent, and it looks like data loss rather than a
// configuration bug.
//
// This is the same invariant the byte-identity check applies to the HMAC secret,
// applied to shared configuration: a value used by more than one workflow must
// be the SAME value in every workflow that uses it, and drift fails the build.
//
// It also holds the line on two things the migration could quietly undo:
// a config node whose value is an expression could smuggle `$env` back in, and a
// renamed config node would break every downstream reference at run time while
// still importing cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

const CORPUS = [
  '01-order-intake/workflow.json',
  '02-crm-sync/workflow.json',
  '03-support-triage/workflow.json',
  '_shared/dlq-replay/workflow.json',
  '_shared/global-error-handler/workflow.json',
  '_shared/sync-watchdog/workflow.json',
];

// One name, every workflow. A per-workflow name would still work, but the point
// of the pattern is that a reader finds the same node in the same place.
const CONFIG_NODE = 'Workflow Config';

// Values known to be shared, with the workflows that must agree on them. Named
// explicitly so that DROPPING a sharer is caught too — a drift check that only
// looks at what it happens to find would silently stop covering a pair.
const SHARED = {
  UPSTREAM_API_URL: ['01-order-intake', '_shared/dlq-replay'],
  CRM_SYNC_URL: ['02-crm-sync', '_shared/dlq-replay'],
  ALERT_WEBHOOK_URL: ['_shared/global-error-handler', '_shared/sync-watchdog'],
};

function configOf(rel) {
  const wf = JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
  const node = wf.nodes.find((n) => n.name === CONFIG_NODE);
  if (!node) return null;
  const pairs = node.parameters.assignments.assignments.map((a) => [a.name, a.value]);
  return Object.fromEntries(pairs);
}

// key -> Map(workflowDir -> value), across every workflow that declares one.
function configIndex() {
  const index = new Map();
  for (const rel of CORPUS) {
    const cfg = configOf(rel);
    if (!cfg) continue;
    const dir = rel.replace(/\/workflow\.json$/, '');
    for (const [k, v] of Object.entries(cfg)) {
      if (!index.has(k)) index.set(k, new Map());
      index.get(k).set(dir, v);
    }
  }
  return index;
}

test('every configured value is a literal, never an expression', () => {
  const seen = [];
  for (const rel of CORPUS) {
    const cfg = configOf(rel);
    if (!cfg) continue;
    for (const [name, value] of Object.entries(cfg)) {
      seen.push(`${rel}:${name}`);
      assert.equal(
        typeof value, 'string', `${rel} config "${name}" must be a string`,
      );
      assert.ok(
        !value.startsWith('=') && !value.includes('{{'),
        `${rel} config "${name}" is an expression (${value}). A config node holding an ` +
          'expression can reach straight back into `$env`, which is exactly what moving ' +
          'configuration into the node was meant to end.',
      );
    }
  }
  assert.notEqual(seen.length, 0, 'no config values were found at all — this gate would be vacuous');
});

test('a value used by more than one workflow is the SAME value in each', () => {
  const index = configIndex();
  assert.notEqual(index.size, 0, 'no config nodes found — nothing to compare');

  const drifted = [];
  let comparedPairs = 0;

  for (const [key, byWorkflow] of index) {
    if (byWorkflow.size < 2) continue;
    comparedPairs += 1;
    const distinct = new Set(byWorkflow.values());
    if (distinct.size > 1) {
      drifted.push(
        `${key}:\n` +
          [...byWorkflow].map(([wf, v]) => `      ${wf} = ${v}`).join('\n'),
      );
    }
  }

  // A drift check that compared nothing would pass. There ARE shared values in
  // this corpus, so finding none means the index broke.
  assert.ok(
    comparedPairs > 0,
    'no configuration key was found in two or more workflows, but several are shared. ' +
      'This gate compared nothing and would pass whatever the config nodes said.',
  );

  assert.deepEqual(
    drifted, [],
    'shared configuration has drifted between workflows:\n  ' + drifted.join('\n  ') +
      '\n\nOne endpoint moved and not every workflow followed. A producer writing to the new ' +
      'address while the replayer retries against the old one loses records silently.',
  );
});

test('every known shared value is still shared by exactly the workflows that use it', () => {
  const index = configIndex();

  for (const [key, expectedOwners] of Object.entries(SHARED)) {
    const byWorkflow = index.get(key);
    assert.ok(byWorkflow, `${key} is no longer declared in any config node`);

    assert.deepEqual(
      [...byWorkflow.keys()].sort(), [...expectedOwners].sort(),
      `${key} is declared by a different set of workflows than expected.\n` +
        `  declared by: ${[...byWorkflow.keys()].sort().join(', ')}\n` +
        `  expected:    ${[...expectedOwners].sort().join(', ')}\n` +
        'If a workflow legitimately gained or lost this configuration, update the expected set ' +
        'here — otherwise the drift check above quietly stops covering the pair.',
    );

    assert.equal(
      new Set(byWorkflow.values()).size, 1,
      `${key} must hold one value across ${expectedOwners.join(' and ')}`,
    );
  }
});

test('every downstream reference points at a config node that exists', () => {
  // A renamed config node imports cleanly and fails at run time, on whichever
  // branch happens to use it.
  let references = 0;

  for (const rel of CORPUS) {
    const raw = readFileSync(join(repoRoot, rel), 'utf8');
    const wf = JSON.parse(raw);
    const names = new Set(wf.nodes.map((n) => n.name));

    for (const m of raw.matchAll(/\$\(\s*\\?["']([^"'\\]+)\\?["']\s*\)/g)) {
      const target = m[1];
      references += 1;
      assert.ok(
        names.has(target),
        `${rel} references node "${target}", which does not exist in that workflow`,
      );
    }
  }

  assert.notEqual(references, 0, 'no node references were scanned — the sweep is broken');
});
