// Watchdog and dead-letter replay — static structure gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

const load = (dir) => JSON.parse(readFileSync(join(repoRoot, '_shared', dir, 'workflow.json'), 'utf8'));
const watchdog = load('sync-watchdog');
const replay = load('dlq-replay');

const index = (wf) => Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const wd = index(watchdog);
const rp = index(replay);
const targets = (wf, node, out) => ((wf.connections[node] || {}).main?.[out] || []).map((c) => c.node);

// --- watchdog -------------------------------------------------------------

test('the watchdog measures staleness against the LAST SUCCESS, not the last run', () => {
  const q = wd['Find Stale Syncs'].parameters.query;
  assert.match(q, /last_success_at/i);
  assert.doesNotMatch(
    q, /WHERE[\s\S]*last_run_at/i,
    'staleness measured against last_run_at would stay silent through an outage where the sync ' +
      'runs nightly and fails nightly',
  );
  assert.match(q, /coalesce\(last_success_at, TIMESTAMPTZ 'epoch'\)/i,
    'a sync that has never succeeded must count as stale, not as missing data');
});

test('the staleness threshold is explicit and allows for a nightly cadence', () => {
  const repl = wd['Find Stale Syncs'].parameters.options.queryReplacement;
  assert.match(repl, /\d+\s*hours/, 'the threshold must be a named interval, not a magic number in SQL');
  const hours = Number(repl.match(/(\d+)\s*hours/)[1]);
  assert.ok(hours > 24, `a nightly sync needs a threshold beyond 24h or it alerts every day; got ${hours}h`);
  assert.ok(hours < 48, `a threshold of ${hours}h would hide a whole missed night`);
});

test('the stale query always returns exactly one row, so the all-clear path runs', () => {
  const q = wd['Find Stale Syncs'].parameters.query;
  assert.match(q, /count\(\*\)::int AS stale_count/i);
  assert.match(q, /string_agg/i, 'the alert must name which syncs are stale');
  assert.doesNotMatch(q, /GROUP BY/i, 'grouping would return zero rows when healthy and stall the branch');
});

test('the watchdog alerts on the stale branch and stays silent on the healthy one', () => {
  assert.deepEqual(targets(watchdog, 'Any Stale?', 0), ['Build Stale Alert']);
  assert.deepEqual(targets(watchdog, 'Build Stale Alert', 0), ['Send Stale Alert']);
  assert.deepEqual(
    targets(watchdog, 'Any Stale?', 1), ['All Syncs Fresh'],
    'the healthy branch must terminate without alerting — a watchdog that always alerts is noise',
  );
  const alert = wd['Send Stale Alert'];
  assert.equal(alert.type, 'n8n-nodes-base.httpRequest');
  assert.equal(alert.retryOnFail, true, 'a dropped alert is the same as no alert');
  assert.ok(alert.parameters.options?.timeout > 0);
});

test('the alert says which sync, how stale, and against what threshold', () => {
  const js = wd['Build Stale Alert'].parameters.jsCode;
  for (const field of ['stale_count', 'detail', 'threshold', 'message']) {
    assert.match(js, new RegExp(field), `the alert payload must carry ${field}`);
  }
});

// --- dead-letter replay ---------------------------------------------------

test('the claim is a single atomic UPDATE — selection and claim in one statement', () => {
  const q = rp['Claim Dead Letters'].parameters.query;
  assert.match(q, /^UPDATE dead_letter SET replayed_at = now\(\)/i,
    'claiming must BE the update; a SELECT followed by a separate UPDATE can double-claim');
  assert.match(q, /replayed_at IS NULL/i, 'only unclaimed rows are eligible');
  assert.match(q, /FOR UPDATE SKIP LOCKED/i,
    'a concurrent replay must skip locked rows rather than block on them');
  assert.match(q, /LIMIT \$2::int/i, 'the claim must be bounded');
  assert.match(q, /RETURNING/i);
});

test('a failed replay is re-queued as a NEW row, so a claim is never undone', () => {
  const q = rp['Re-dead-letter'].parameters.query;
  assert.match(q, /INSERT INTO dead_letter/i);
  for (const node of replay.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres')) {
    assert.doesNotMatch(
      node.parameters.query, /SET replayed_at = NULL/i,
      'clearing the claim would reopen the double-replay window the atomic claim closes',
    );
  }
  // The reason is a bound value, not part of the SQL text — which is itself the
  // point: it travels through queryReplacement like every other user-supplied
  // string in this repo.
  assert.match(
    rp['Re-dead-letter'].parameters.options.queryReplacement, /replay failed/i,
    'the requeued row must say why it came back',
  );
});

test('replay keeps running when one item fails', () => {
  const h = rp['Replay Item'];
  assert.equal(h.onError, 'continueErrorOutput');
  assert.equal(h.retryOnFail, true);
  assert.ok(h.parameters.options?.timeout > 0);
  assert.deepEqual(targets(replay, 'Replay Item', 1), ['Re-dead-letter']);
  assert.deepEqual(targets(replay, 'Re-dead-letter', 0), ['Replay Failed']);
  assert.deepEqual(targets(replay, 'Replay Failed', 0), ['Loop Over Dead Letters']);
});

test('an empty claim still produces a result instead of ending in silence', () => {
  assert.equal(rp['Claim Dead Letters'].alwaysOutputData, true,
    'a zero-row claim would otherwise stop the branch, leaving no record the replay ran');
  assert.deepEqual(targets(replay, 'Anything Claimed?', 1), ['Nothing To Replay']);
  assert.match(rp['Nothing To Replay'].parameters.jsCode, /nothing_to_replay/);
});

test('the replay destination is resolved per producing workflow', () => {
  const js = rp['Resolve Destination'].parameters.jsCode;
  assert.match(js, /01-order-intake/);
  assert.match(js, /02-crm-sync/);
  assert.match(js, /throw new Error/,
    'an unknown producer must fail loudly rather than silently POST nowhere');
});

test('both companions keep the shared hardening invariants', () => {
  for (const [label, wf] of [['sync-watchdog', watchdog], ['dlq-replay', replay]]) {
    assert.equal(wf.settings?.errorWorkflow, 'globalerrhandler', `${label} must reference the error handler`);
    for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres')) {
      assert.match(node.parameters.query, /\$1/, `${label}/${node.name} must bind parameters`);
      assert.doesNotMatch(node.parameters.query, /\{\{/, `${label}/${node.name} must not build SQL from an expression`);
      assert.ok(node.credentials?.postgres?.id, `${label}/${node.name} needs a credential`);
    }
  }
});
