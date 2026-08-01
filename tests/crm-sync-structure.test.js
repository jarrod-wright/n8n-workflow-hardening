// Scheduled CRM sync (wf02) structure test — static assertions on the exported
// JSON. Encodes the hardening invariants the workflow must keep, and is safe to
// run without the stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

const wf = JSON.parse(readFileSync(join(repoRoot, '02-crm-sync', 'workflow.json'), 'utf8'));
const pins = JSON.parse(readFileSync(join(repoRoot, 'typeversions.json'), 'utf8')).nodeTypes;
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const pgNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres');

function outputs(nodeName) {
  return (wf.connections[nodeName] || {}).main || [];
}
function targets(nodeName, outputIndex) {
  return (outputs(nodeName)[outputIndex] || []).map((c) => c.node);
}

test('every node uses the pinned typeVersion', () => {
  for (const node of wf.nodes) {
    const pin = pins[node.type];
    assert.ok(pin, `node type ${node.type} is not pinned in typeversions.json`);
    assert.equal(node.typeVersion, pin.typeVersion, `${node.name} (${node.type})`);
  }
});

test('the workflow references the global error handler', () => {
  assert.equal(wf.settings?.errorWorkflow, 'globalerrhandler');
});

// --- the schedule ---------------------------------------------------------

test('the schedule declares an explicit IANA timezone', () => {
  const tz = wf.settings?.timezone;
  assert.ok(tz, 'workflow settings must pin a timezone — otherwise the schedule follows the host');
  assert.match(tz, /^[A-Za-z]+\/[A-Za-z_]+$/, `timezone must be an IANA zone name, got ${JSON.stringify(tz)}`);
  assert.notEqual(tz, 'UTC', 'a nightly business schedule must name the business zone, not fall back to UTC');
});

test('the trigger is a schedule trigger with a concrete daily time', () => {
  const t = byName['Nightly Trigger'];
  assert.ok(t && t.type === 'n8n-nodes-base.scheduleTrigger');
  const interval = t.parameters.rule?.interval?.[0];
  assert.ok(interval, 'the trigger must declare an interval rule');
  assert.equal(interval.field, 'days');
  assert.equal(typeof interval.triggerAtHour, 'number', 'the run hour must be explicit');
  assert.equal(typeof interval.triggerAtMinute, 'number', 'the run minute must be explicit');
});

// --- the watermark --------------------------------------------------------

test('the watermark lives in Postgres, not in workflow static data', () => {
  const read = byName['Read Watermark'];
  assert.ok(read && read.type === 'n8n-nodes-base.postgres', 'the cursor must be read from the database');
  assert.match(read.parameters.query, /sync_watermark/i);

  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    assert.doesNotMatch(
      node.parameters.jsCode, /getWorkflowStaticData/,
      `${node.name} keeps the cursor in workflow static data — it would not survive a re-import ` +
        'and is invisible to any other process',
    );
  }
});

test('the watermark is seeded atomically, so the first run has a cursor', () => {
  const q = byName['Read Watermark'].parameters.query;
  assert.match(q, /INSERT INTO sync_watermark/i);
  assert.match(q, /ON CONFLICT \(workflow\) DO UPDATE/i,
    'must be an upsert-returning: a plain CTE insert would not be visible to a SELECT in the same statement');
  assert.match(q, /RETURNING cursor_value/i);
});

test('the run advances the cursor ONLY to the last contiguous success', () => {
  const s = byName['Summarize Run'];
  assert.ok(s && s.type === 'n8n-nodes-base.code');
  const js = s.parameters.jsCode;

  // The loop must stop at the first failure rather than continue past it.
  assert.match(js, /if\s*\(!r\.ok\)\s*break;/,
    'the cursor loop must break at the first failure — continuing past it is what silently skips records');
  assert.doesNotMatch(js, /filter\(\s*\(?r\)?\s*=>\s*r\.ok\s*\)\s*\.\s*pop\(\)/,
    'the cursor must not be the highest successful cursor — that skips a failure that sits before it');

  // Results are ordered before the decision; an unordered scan would make the
  // "last contiguous success" meaningless.
  assert.match(js, /\.sort\(/, 'results must be ordered by cursor before the contiguity scan');
});

test('a failed fetch and an empty delta both hold the cursor exactly where it was', () => {
  const js = byName['Summarize Run'].parameters.jsCode;
  const fetchFailed = js.slice(js.indexOf('fetch_failed'));
  assert.match(fetchFailed, /cursor_after:\s*cursorBefore/,
    'a failed fetch must not move the cursor by even one record');
  const noChanges = js.slice(js.indexOf('no_changes'));
  assert.match(noChanges, /cursor_after:\s*cursorBefore/);
});

test('the cursor update is monotonic — it can never move backwards', () => {
  const q = byName['Advance Watermark'].parameters.query;
  assert.match(q, /UPDATE sync_watermark/i);
  assert.match(
    q, /CASE WHEN cursor_value IS NULL OR \$2 > cursor_value THEN \$2 ELSE cursor_value END/i,
    'the update must guard against a regression, so a late or replayed run cannot rewind the cursor',
  );
  assert.match(q, /RETURNING/i, 'the node must return a row, or the completion chain stops here');
});

// --- per-item failure handling -------------------------------------------

test('the per-contact call retries, then routes that item to its own error branch', () => {
  const h = byName['Sync Contact'];
  assert.ok(h && h.type === 'n8n-nodes-base.httpRequest');
  assert.equal(h.retryOnFail, true);
  assert.ok(h.maxTries >= 2);
  assert.equal(h.onError, 'continueErrorOutput',
    'a failing contact must not abort the run — the other contacts still have to be synced');
  assert.ok(h.parameters.options?.timeout > 0, 'a sync call without a timeout can hang the whole nightly run');
});

test('a failed contact is dead-lettered and still re-enters the loop as a result', () => {
  assert.deepEqual(targets('Sync Contact', 1), ['Describe Failure']);
  assert.deepEqual(targets('Describe Failure', 0), ['Dead-letter Contact']);
  assert.deepEqual(targets('Dead-letter Contact', 0), ['Confirm Dead-lettered']);

  const dlq = byName['Dead-letter Contact'];
  assert.match(dlq.parameters.query, /INSERT INTO dead_letter/i);
  assert.match(dlq.parameters.query, /RETURNING/i);

  // The failure must reach the watermark decision. A failure that never gets
  // there is exactly how a cursor jumps over an unprocessed record.
  assert.deepEqual(targets('Confirm Dead-lettered', 0), ['Pace Between Batches']);
  assert.deepEqual(targets('Pace Between Batches', 0), ['Loop Over Contacts']);
  assert.match(byName['Confirm Dead-lettered'].parameters.jsCode, /ok:\s*false/);
});

test('the loop paces itself between batches', () => {
  const w = byName['Pace Between Batches'];
  assert.ok(w && w.type === 'n8n-nodes-base.wait', 'a rate-limited API needs deliberate pacing, not a tight loop');
  assert.ok(w.parameters.amount > 0);
  assert.ok(['seconds', 'minutes'].includes(w.parameters.unit));

  // Both the success and the failure path go through it — otherwise a run made
  // entirely of failures would hammer the API with no pacing at all.
  assert.deepEqual(targets('Mark Synced', 0), ['Pace Between Batches']);
});

test('the loop wiring uses the done/loop outputs the right way round', () => {
  const loop = byName['Loop Over Contacts'];
  assert.ok(loop && loop.type === 'n8n-nodes-base.splitInBatches');
  // output 0 = done, output 1 = loop
  assert.deepEqual(targets('Loop Over Contacts', 0), ['Summarize Run'],
    'the done output must go to the summary, not back into the loop');
  assert.deepEqual(targets('Loop Over Contacts', 1), ['Sync Contact']);
});

// --- audit + heartbeat ----------------------------------------------------

test('every run opens and closes an audit row recording the cursor movement', () => {
  const open = byName['Start Run Audit'];
  assert.match(open.parameters.query, /INSERT INTO sync_audit/i);
  assert.match(open.parameters.query, /cursor_before/i);
  assert.match(open.parameters.query, /RETURNING id/i);

  const close = byName['Complete Run Audit'];
  assert.match(close.parameters.query, /UPDATE sync_audit/i);
  for (const col of ['finished_at', 'items_read', 'items_synced', 'items_failed', 'cursor_after', 'status']) {
    assert.match(close.parameters.query, new RegExp(col, 'i'), `the audit close must record ${col}`);
  }
});

test('the heartbeat only records a SUCCESS when the run actually succeeded', () => {
  const q = byName['Update Heartbeat'].parameters.query;
  assert.match(q, /INSERT INTO sync_heartbeat/i);
  assert.match(q, /last_run_at = now\(\)/i, 'every run updates the attempt timestamp');
  assert.match(
    q, /last_success_at = CASE WHEN \$2 = 'ok' THEN now\(\) ELSE sync_heartbeat\.last_success_at END/i,
    'a failed or partial run must leave last_success_at alone — otherwise a sync that has been ' +
      'broken for a week still looks fresh to the watchdog',
  );
});

test('a run that did not fully succeed ends in an explicit error', () => {
  assert.deepEqual(targets('Update Heartbeat', 0), ['Run OK?']);
  assert.deepEqual(targets('Run OK?', 1), ['Stop And Error'],
    'a partial or failed run must surface as a workflow error so the error workflow fires');
  const s = byName['Stop And Error'];
  assert.ok(s && s.type === 'n8n-nodes-base.stopAndError');
});

test('every path reaches the completion chain — no run ends silently', () => {
  for (const source of ['Summarize Run', 'No Changes', 'Fetch Failed']) {
    assert.ok(wf.connections[source], `${source} must be connected onward`);
  }
  assert.deepEqual(targets('No Changes', 0), ['Summarize Run']);
  assert.deepEqual(targets('Fetch Failed', 0), ['Summarize Run']);
  assert.deepEqual(targets('Fetch Delta', 1), ['Fetch Failed'],
    'a failed delta fetch must still record a run and refresh the heartbeat status');
});

// --- SQL hygiene ----------------------------------------------------------

test('every Postgres query is parameterized', () => {
  for (const node of pgNodes) {
    assert.match(node.parameters.query, /\$1/, `${node.name} must bind parameters`);
    assert.doesNotMatch(
      node.parameters.query, /\{\{/,
      `${node.name} interpolates an expression into the SQL string (injection risk)`,
    );
    assert.ok(node.parameters.options?.queryReplacement, `${node.name} must use queryReplacement`);
  }
});

test('every Postgres node carries an explicit credential', () => {
  for (const node of pgNodes) {
    assert.ok(node.credentials?.postgres?.id, `${node.name} has no Postgres credential`);
  }
});
