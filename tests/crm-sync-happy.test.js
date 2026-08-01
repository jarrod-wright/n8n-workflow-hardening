// Scheduled CRM sync (wf02) — happy path, on the live stack.
//
// Proves the whole loop actually works end to end: read the cursor, fetch only
// what changed, sync each contact, advance the cursor to the last good one,
// close the audit row, and refresh the heartbeat. The second run then proves
// the cursor is doing its job — an unchanged source means nothing is re-read.
//
// The stack must already be up via `npm run stack:up`; the `npm test` preflight
// fails the run outright if it is not, so this can never pass by skipping.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupCrmSync, resetSyncState, configureCrm, runSync, stackReady,
  watermark, latestAudit, auditCount, heartbeat, deadLettered, crmCounters,
  cursorOf, EPOCH_CURSOR,
} from './helpers/crm-sync.mjs';

before(() => {
  assert.ok(stackReady(), 'the stack must be up (npm run stack:up) — these gates cannot be skipped');
  assert.ok(setupCrmSync(), 'failed to import the CRM sync workflow');
});

test('a first run syncs every changed contact and advances the cursor to the last one', () => {
  resetSyncState();
  configureCrm({ contactCount: 5 });

  const run = runSync();
  assert.equal(run.code, 0, `the sync run failed:\n${run.stderr}`);

  // The side effect actually happened, once per contact.
  const counters = crmCounters();
  assert.equal(counters.syncCommits, 5, 'every changed contact must be written to the CRM');
  assert.deepEqual(counters.syncedContacts, ['CRM-001', 'CRM-002', 'CRM-003', 'CRM-004', 'CRM-005']);
  assert.equal(counters.rateLimited, 0);

  // The cursor moved to the last successfully synced contact — not further.
  assert.equal(watermark(), cursorOf(5), 'the watermark must sit on the last contact that succeeded');

  const audit = latestAudit();
  assert.deepEqual(
    audit,
    {
      items_read: 5, items_synced: 5, items_failed: 0,
      cursor_before: EPOCH_CURSOR, cursor_after: cursorOf(5), status: 'ok',
    },
    'the audit row must record the full cursor movement and the per-run counts',
  );

  const hb = heartbeat();
  assert.equal(hb.status, 'ok');
  assert.ok(hb.ran, 'the heartbeat must record that a run happened');
  assert.ok(hb.succeeded, 'a fully successful run must refresh last_success_at');

  assert.deepEqual(deadLettered(), [], 'nothing should be dead-lettered on a clean run');
});

test('a second run with no changes re-reads nothing and still reports healthy', () => {
  // Deliberately NOT resetting the sync state: this run must resume from the
  // cursor the previous test left behind. That is the whole point of a
  // watermark, and it is only proven by carrying it across runs.
  const before = watermark();
  assert.equal(before, cursorOf(5), 'precondition: the cursor is where the first run left it');

  const runsBefore = auditCount();
  const run = runSync();
  assert.equal(run.code, 0, `the idle run failed:\n${run.stderr}`);

  const audit = latestAudit();
  assert.equal(audit.items_read, 0, 'nothing changed since the cursor, so nothing may be re-read');
  assert.equal(audit.items_synced, 0);
  assert.equal(audit.items_failed, 0);
  assert.equal(audit.cursor_before, cursorOf(5));
  assert.equal(audit.cursor_after, cursorOf(5), 'an idle run must not move the cursor');
  assert.equal(audit.status, 'ok', 'an idle run is healthy, not a failure');

  assert.equal(auditCount(), runsBefore + 1, 'every run must leave an audit row, including an idle one');
  assert.equal(watermark(), before, 'the cursor must be unchanged');

  const hb = heartbeat();
  assert.ok(hb.succeeded, 'an idle run still refreshes the heartbeat — idle is not stalled');
});

test('new records after the cursor are picked up on the next run, older ones are not', () => {
  // Grow the source. Contacts 1-5 are already behind the cursor; 6-8 are new.
  // Growing the set does not reset the CRM's committed-contact memory, so a
  // re-read of an old contact would show up as a fresh commit and fail here.
  const committedBefore = crmCounters().syncCommits;
  configureCrm({ contactCount: 8 });

  // configureCrm resets the mock's counters, so re-sync contacts 1-5 would be
  // visible as commits. Re-assert the cursor is still where it was: the reset
  // touched the mock, not the database.
  assert.equal(watermark(), cursorOf(5), 'resetting the mock must not disturb the stored cursor');

  const run = runSync();
  assert.equal(run.code, 0, `the incremental run failed:\n${run.stderr}`);

  const counters = crmCounters();
  assert.deepEqual(
    counters.syncedContacts, ['CRM-006', 'CRM-007', 'CRM-008'],
    'only the records after the cursor may be synced — re-reading the earlier ones is the bug a watermark exists to prevent',
  );
  assert.equal(counters.syncCommits, 3);
  assert.ok(committedBefore >= 0);

  const audit = latestAudit();
  assert.equal(audit.items_read, 3);
  assert.equal(audit.items_synced, 3);
  assert.equal(audit.cursor_before, cursorOf(5));
  assert.equal(audit.cursor_after, cursorOf(8));
  assert.equal(audit.status, 'ok');

  assert.equal(watermark(), cursorOf(8));
});
