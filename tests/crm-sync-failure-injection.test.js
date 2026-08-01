// Scheduled CRM sync (wf02) — failure injection, on the live stack.
//
// Five faults, each observed through the mock's counters and the three sync
// tables rather than through the workflow's own report of itself. A workflow
// that says it synced everything while the destination saw three calls is
// exactly the failure these tests exist to catch, so nothing here trusts the
// workflow's self-description.
//
// The tests run in order and deliberately share state where a cursor has to
// survive between runs — a watermark is only proven across runs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { psql, mockApi, asJson } from './helpers/stack.mjs';
import {
  setupCrmSync, resetSyncState, configureCrm, runSync, stackReady,
  watermark, latestAudit, heartbeat, deadLettered, crmCounters, cursorOf,
} from './helpers/crm-sync.mjs';

before(() => {
  assert.ok(stackReady(), 'the stack must be up (npm run stack:up) — these gates cannot be skipped');
  assert.ok(setupCrmSync(), 'failed to import the CRM sync workflow');
});

// 1 ---------------------------------------------------------------------------
test('a transient failure is retried and never reaches the dead-letter table', () => {
  resetSyncState();
  configureCrm({ contactCount: 4, failuresByContact: { 'CRM-002': 2 } });

  const run = runSync();
  assert.equal(run.code, 0, `run failed:\n${run.stderr}`);

  const c = crmCounters();
  assert.equal(c.syncCommits, 4, 'a transient failure must not cost a record');
  assert.equal(
    c.syncAttemptsByContact['CRM-002'], 3,
    'the failing contact should have been attempted three times (two failures, then success)',
  );
  assert.equal(c.syncAttemptsByContact['CRM-001'], 1, 'the healthy contacts must not be retried');

  assert.deepEqual(deadLettered(), [], 'a contact that eventually succeeded must not be dead-lettered');
  assert.equal(watermark(), cursorOf(4), 'a fully recovered run advances the cursor all the way');

  const audit = latestAudit();
  assert.equal(audit.items_failed, 0);
  assert.equal(audit.status, 'ok');
  assert.ok(heartbeat().succeeded, 'a recovered run is a successful run');
});

// 2 ---------------------------------------------------------------------------
test('a permanently failing contact is isolated, dead-lettered, and reported as partial', () => {
  resetSyncState();
  // 99 forced failures is more than the node will ever retry, so this contact
  // can never succeed — while every other contact is perfectly healthy.
  configureCrm({ contactCount: 4, failuresByContact: { 'CRM-002': 99 } });

  const run = runSync();

  const c = crmCounters();
  assert.deepEqual(
    c.syncedContacts, ['CRM-001', 'CRM-003', 'CRM-004'],
    'one bad contact must not stop the others — isolation is the whole point of the error branch',
  );
  assert.equal(c.syncAttemptsByContact['CRM-002'], 3, 'the failing contact must exhaust its retries');

  assert.deepEqual(deadLettered(), ['CRM-002'], 'the failed contact must be recoverable, not lost');

  const audit = latestAudit();
  assert.equal(audit.items_read, 4);
  assert.equal(audit.items_synced, 3);
  assert.equal(audit.items_failed, 1);
  assert.equal(audit.status, 'partial');

  const hb = heartbeat();
  assert.equal(hb.status, 'partial');
  assert.equal(
    hb.succeeded, false,
    'a partial run must NOT refresh last_success_at — the cursor is stuck behind the failure, ' +
      'so the sync genuinely is not healthy and the watchdog must be able to see that',
  );

  assert.notEqual(run.code, 0, 'a partial run must surface as a workflow error, not exit clean');

  const payload = psql(
    "select payload::text from dead_letter where workflow='02-crm-sync' and order_id='CRM-002';",
  );
  assert.match(payload.stdout, /CRM-002/, 'the dead-letter row must carry enough payload to replay from');
});

// 3 ---------------------------------------------------------------------------
test('rate limiting costs time, not records', () => {
  resetSyncState();
  // One call per 1.5s window. The workflow paces at 1s, so it WILL trip the
  // limiter, and the per-item retry has to carry it through.
  configureCrm({ contactCount: 4, rateLimit: { limit: 1, windowMs: 1500 } });

  const run = runSync();
  assert.equal(run.code, 0, `run failed:\n${run.stderr}`);

  const c = crmCounters();
  assert.ok(c.rateLimited > 0, 'the limiter must actually have fired, or this test proves nothing');
  assert.equal(c.syncCommits, 4, 'every contact must still be synced — a 429 is a delay, not a loss');
  assert.deepEqual(deadLettered(), [], 'a rate-limited contact must not be dead-lettered');
  assert.equal(watermark(), cursorOf(4));
  assert.equal(latestAudit().status, 'ok');

  mockApi('POST', '/config', { rateLimit: null });
});

// 4 ---------------------------------------------------------------------------
test('a failed delta fetch moves nothing at all', () => {
  resetSyncState();
  configureCrm({ contactCount: 3 });

  // A healthy run first, so there is a cursor and a success timestamp to
  // protect. Asserting "nothing moved" from a zero state proves nothing.
  assert.equal(runSync().code, 0);
  assert.equal(watermark(), cursorOf(3));
  const successBefore = heartbeat().successAt;
  assert.ok(successBefore, 'precondition: the healthy run recorded a success');
  // Counted from here, not from zero: the healthy setup run above legitimately
  // made three calls, and the claim under test is that the FAILED run makes none.
  const attemptsBefore = crmCounters().syncAttempts;

  mockApi('POST', '/config', { failDelta: true });
  const run = runSync();

  assert.equal(watermark(), cursorOf(3), 'nothing was read, so the cursor must not move by one record');

  const audit = latestAudit();
  assert.equal(audit.items_read, 0);
  assert.equal(audit.status, 'failed');
  assert.equal(audit.cursor_before, cursorOf(3));
  assert.equal(audit.cursor_after, cursorOf(3));

  const hb = heartbeat();
  assert.equal(hb.status, 'failed');
  assert.equal(
    hb.successAt, successBefore,
    'a failed run must leave last_success_at untouched — that timestamp is what the watchdog reads',
  );
  assert.notEqual(run.code, 0, 'a failed fetch must surface as a workflow error');

  assert.equal(
    crmCounters().syncAttempts, attemptsBefore,
    'nothing was read, so nothing may be written — the failed run must make zero further calls',
  );

  mockApi('POST', '/config', { failDelta: false });
});

// 5 — T4.5 --------------------------------------------------------------------
test('watermark integrity: a mid-batch failure holds the cursor at the LAST GOOD record', () => {
  resetSyncState();
  // Six contacts. The third fails permanently; the fourth, fifth and sixth are
  // perfectly healthy and WILL succeed. That is the trap: the highest
  // successful cursor is contact 6, and advancing there loses contact 3 forever.
  configureCrm({ contactCount: 6, failuresByContact: { 'CRM-003': 99 } });

  const run = runSync();

  const c = crmCounters();
  assert.deepEqual(
    c.syncedContacts, ['CRM-001', 'CRM-002', 'CRM-004', 'CRM-005', 'CRM-006'],
    'the contacts after the failure must still be synced — they are not the ones at risk',
  );

  // THE GATE.
  assert.equal(
    watermark(), cursorOf(2),
    'the cursor must sit on contact 2 — the last record that succeeded with no failure before it. ' +
      `Contact 6 (${cursorOf(6)}) is the highest successful cursor and is the WRONG answer: ` +
      'resuming there would skip contact 3 permanently, with no error and no log line.',
  );

  const audit = latestAudit();
  assert.equal(audit.items_read, 6);
  assert.equal(audit.items_synced, 5);
  assert.equal(audit.items_failed, 1);
  assert.equal(audit.cursor_after, cursorOf(2), 'the audit must record where the cursor actually stopped');
  assert.equal(audit.status, 'partial');
  assert.deepEqual(deadLettered(), ['CRM-003']);
  assert.notEqual(run.code, 0);
});

test('watermark integrity: the next run resumes AT the failed record and loses nothing', () => {
  // Continues from the previous test on purpose — the cursor left at contact 2
  // is the input to this one. The upstream cause is now fixed.
  assert.equal(watermark(), cursorOf(2), 'precondition: the cursor is held at the last good record');

  const before = crmCounters();
  mockApi('POST', '/config', { failuresByContact: { 'CRM-003': 0 } });

  const run = runSync();
  assert.equal(run.code, 0, `the recovery run failed:\n${run.stderr}`);

  const after = crmCounters();
  assert.ok(
    after.syncAttemptsByContact['CRM-003'] > before.syncAttemptsByContact['CRM-003'],
    'the previously failed contact must be re-read and retried — that is what the held cursor bought',
  );
  assert.ok(
    after.syncedContacts.includes('CRM-003'),
    'contact 3 must finally be synced; if the cursor had advanced past it, it never would be',
  );

  const audit = latestAudit();
  assert.equal(audit.items_read, 4, 'the run must re-read contacts 3 through 6, starting at the failure');
  assert.equal(audit.items_synced, 4);
  assert.equal(audit.items_failed, 0);
  assert.equal(audit.cursor_before, cursorOf(2));
  assert.equal(audit.cursor_after, cursorOf(6));
  assert.equal(audit.status, 'ok');

  assert.equal(watermark(), cursorOf(6), 'with nothing failing, the cursor finally advances to the end');
  assert.ok(heartbeat().succeeded, 'a clean recovery run refreshes last_success_at');

  // Re-syncing 4, 5 and 6 is the cost of holding the cursor. It is harmless
  // precisely because the write is idempotent: attempts rose, commits did not.
  assert.equal(
    after.syncCommits, before.syncCommits + 1,
    'only contact 3 is a new commit — re-reading 4-6 must not double-write them',
  );
});
