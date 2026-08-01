// The dead-letter replay destination map — both branches, and the error path.
//
// WHY THIS EXISTS AS A UNIT TEST RATHER THAN A LIVE ONE
// The replayer is a parameterised sub-workflow: its `Execute Sub-workflow`
// trigger takes a `{ workflow }` input, and `Claim Dead Letters` filters on
// `{{ $json.workflow || '02-crm-sync' }}`. A CALLING workflow supplies that
// selector, the way arguments are supplied to a function. The `n8n execute --id`
// CLI path has no flag that injects an input item, so on that path the selector
// always falls back to the default producer and only that producer's rows are
// ever claimed.
//
// That is a property of the sub-workflow contract, not a defect: no
// correctly-designed parameterised sub-workflow can exercise a caller-supplied
// parameter on a path that structurally cannot supply one. So the live gate
// proves what live execution can prove — that the config reference resolves from
// inside the loop branch and the resolved URL is actually called — and this file
// proves what it cannot: that the map is complete and correct for EVERY
// producer, including the unknown-producer failure that no happy path reaches.
//
// WHAT MAKES THIS A REAL TEST AND NOT A RESTATEMENT
// It does not reimplement the map. It reads the SHIPPED `jsCode` out of
// `_shared/dlq-replay/workflow.json` and executes it, with the config values
// taken from that same file's config node. A drift between the map and the
// config node — a renamed key, a dropped producer, a renamed config node — fails
// here, because both sides come from the artefact rather than from this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

const workflow = JSON.parse(
  readFileSync(join(repoRoot, '_shared', 'dlq-replay', 'workflow.json'), 'utf8'),
);
const nodeNamed = (name) => workflow.nodes.find((n) => n.name === name);

const RESOLVER = 'Resolve Destination';
const CONFIG = 'Workflow Config';

// The producers that write into `dead_letter`. Both must be routable, or a
// replay of that producer's backlog throws instead of delivering.
const PRODUCERS = ['01-order-intake', '02-crm-sync'];

// Config values as the shipped config node declares them.
function configuredValues() {
  const cfg = nodeNamed(CONFIG);
  assert.ok(cfg, `the workflow no longer has a "${CONFIG}" node`);
  const pairs = cfg.parameters.assignments.assignments.map((a) => [a.name, a.value]);
  return Object.fromEntries(pairs);
}

// The shipped map code, executed with the two globals n8n gives a Code node.
function runResolver(row, cfg = configuredValues()) {
  const { jsCode } = nodeNamed(RESOLVER).parameters;
  const $ = (name) => {
    assert.equal(
      name, CONFIG,
      `the map reads from node "${name}", which is not the config node this test provides`,
    );
    return { first: () => ({ json: cfg }) };
  };
  // eslint-disable-next-line no-new-func
  return new Function('$', '$json', jsCode)($, row);
}

test('the map reads from a node that actually exists in the workflow', () => {
  const { jsCode } = nodeNamed(RESOLVER).parameters;
  const referenced = [...jsCode.matchAll(/\$\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

  assert.notEqual(referenced.length, 0, 'the map must reference the config node by name');
  for (const name of referenced) {
    assert.ok(
      nodeNamed(name),
      `"${RESOLVER}" references node "${name}", which does not exist. Renaming a node does not ` +
        'update the expressions that reference it — this fails at run time, on the replay path, ' +
        'not at import.',
    );
  }
});

test('the config node supplies a distinct, non-empty URL for every producer', () => {
  const cfg = configuredValues();
  assert.notEqual(Object.keys(cfg).length, 0, 'an empty config node would make the map vacuous');

  const urls = Object.values(cfg);
  for (const [name, value] of Object.entries(cfg)) {
    assert.match(value, /^https?:\/\/\S+$/, `${name} must be an absolute URL, got "${value}"`);
  }
  assert.equal(
    new Set(urls).size, urls.length,
    'two producers configured to the same URL would silently replay one backlog into the other',
  );
});

test('EVERY producer resolves to its own configured destination', () => {
  const cfg = configuredValues();
  assert.notEqual(PRODUCERS.length, 0, 'an empty producer list would verify nothing');

  const resolved = new Map();
  for (const workflowName of PRODUCERS) {
    const out = runResolver({ workflow: workflowName, id: 7, payload: { a: 1 } });
    assert.equal(out.length, 1, `${workflowName} must resolve to exactly one item`);
    resolved.set(workflowName, out[0].json.destination);
  }

  // The map's two branches must land on the two DIFFERENT configured URLs. This
  // is the assertion the CLI path cannot make: it can only ever claim rows for
  // the default producer, so it only ever takes one branch.
  assert.equal(resolved.get('01-order-intake'), cfg.UPSTREAM_API_URL);
  assert.equal(resolved.get('02-crm-sync'), cfg.CRM_SYNC_URL);
  assert.equal(
    new Set(resolved.values()).size, PRODUCERS.length,
    `each producer must replay to its own destination; got ${JSON.stringify([...resolved])}`,
  );
});

test('the replayed row is carried through, not replaced by the destination', () => {
  const row = { workflow: '02-crm-sync', id: 42, entity_id: 'CRM-1', payload: { name: 'keep me' } };
  const [{ json }] = runResolver(row);

  for (const [k, v] of Object.entries(row)) {
    assert.deepEqual(json[k], v, `the resolver dropped "${k}" — the replay would POST an incomplete payload`);
  }
  assert.ok(json.destination, 'the resolver must add the destination alongside the row');
});

test('an unknown producer throws instead of silently POSTing nowhere', () => {
  assert.throws(
    () => runResolver({ workflow: 'not-a-real-workflow', id: 1 }),
    (err) => {
      assert.match(
        err.message, /no replay destination is configured for workflow not-a-real-workflow/,
        'the error must name the producer, or whoever is paged cannot tell which backlog is stranded',
      );
      return true;
    },
    'an unroutable row must fail loudly. Returning no destination would let the HTTP node POST to ' +
      'an empty URL, and the row would be marked replayed having gone nowhere.',
  );
});

test('a producer whose configured URL went missing throws rather than POSTing to nothing', () => {
  // The failure mode a config node introduces that `$env` did not: the map key
  // survives a rename of the config field, but resolves to undefined.
  assert.throws(
    () => runResolver({ workflow: '01-order-intake', id: 1 }, { CRM_SYNC_URL: 'http://x/y' }),
    /no replay destination is configured for workflow 01-order-intake/,
    'a config key that no longer matches the map must fail loudly, not resolve to undefined',
  );
});
