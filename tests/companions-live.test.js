// Watchdog and dead-letter replay — live behaviour on the running stack.
//
// Two gates:
//   * the watchdog alerts ONLY when a sync is genuinely stale;
//   * replay is exactly-once — a second replay of the same rows is a no-op.
//
// Both workflows are driven through the documented `npm run wf:run` script, the
// same command the READMEs give the reader.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  repoRoot, psql, mockApi, asJson, isServiceRunning,
  ensurePostgresCredential, importWorkflowFile, workflowExists,
} from './helpers/stack.mjs';

const WATCHDOG_ID = 'syncwatchdog001';
const REPLAY_ID = 'dlqreplay000001';
const SYNC = '02-crm-sync';

function runWorkflow(id, timeout = 240000) {
  try {
    const stdout = execFileSync('npm', ['run', '--silent', 'wf:run', '--', `--id=${id}`], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message || e) };
  }
}

const alerts = () => asJson(mockApi('GET', '/alerts')) || { count: 0, alerts: [] };
const count = (sql) => Number((psql(sql).stdout || '0').trim());

// Put the heartbeat into a chosen state. Writing the timestamp directly is the
// only way to test a 26-hour threshold without waiting 26 hours.
function setHeartbeat({ hoursAgo, status = 'ok' }) {
  psql(`delete from sync_heartbeat where workflow='${SYNC}';`);
  const lastSuccess = hoursAgo === null ? 'NULL' : `now() - interval '${hoursAgo} hours'`;
  psql(
    `insert into sync_heartbeat (workflow, last_run_at, last_success_at, status, detail) ` +
    `values ('${SYNC}', now(), ${lastSuccess}, '${status}', 'set by the companion test');`,
  );
}

before(() => {
  assert.ok(['n8n', 'postgres', 'mock-api'].every(isServiceRunning),
    'the stack must be up (npm run stack:up) — these gates cannot be skipped');
  ensurePostgresCredential();
  for (const [name, dir] of [['sync-watchdog', 'sync-watchdog'], ['dlq-replay', 'dlq-replay']]) {
    if (!workflowExists(name)) importWorkflowFile(join(repoRoot, '_shared', dir, 'workflow.json'));
    assert.ok(workflowExists(name), `failed to import ${name}`);
  }
});

// --- watchdog -------------------------------------------------------------

test('the watchdog stays SILENT when the sync succeeded recently', () => {
  mockApi('POST', '/reset', {});
  setHeartbeat({ hoursAgo: 1 });

  const run = runWorkflow(WATCHDOG_ID);
  assert.equal(run.code, 0, `watchdog run failed:\n${run.stderr}`);
  assert.equal(alerts().count, 0, 'a fresh sync must not alert — a watchdog that always fires is noise');
});

test('the watchdog ALERTS when the last success is older than the threshold', () => {
  mockApi('POST', '/reset', {});
  setHeartbeat({ hoursAgo: 30 });

  const run = runWorkflow(WATCHDOG_ID);
  assert.equal(run.code, 0, `watchdog run failed:\n${run.stderr}`);

  const got = alerts();
  assert.equal(got.count, 1, 'a stale sync must alert exactly once per check');
  const alert = got.alerts[0];
  assert.equal(alert.source, 'sync-watchdog');
  assert.ok(alert.stale_count >= 1);
  assert.match(alert.detail, new RegExp(SYNC), 'the alert must name the stale workflow');
  assert.match(alert.message, /26 hours/, 'the alert must state the threshold that was breached');
});

test('a sync that has NEVER succeeded is stale, not invisible', () => {
  mockApi('POST', '/reset', {});
  // Ran ten minutes ago, has never once succeeded — the shape of a sync that has
  // been failing since the day it was deployed.
  setHeartbeat({ hoursAgo: null, status: 'failed' });

  const run = runWorkflow(WATCHDOG_ID);
  assert.equal(run.code, 0, `watchdog run failed:\n${run.stderr}`);

  const got = alerts();
  assert.equal(got.count, 1, 'a never-successful sync must alert; a NULL last-success is the worst case, not a gap');
  assert.match(got.alerts[0].detail, /never/, 'the alert should say it has never succeeded');
});

test('the watchdog goes quiet again once the sync recovers', () => {
  mockApi('POST', '/reset', {});
  setHeartbeat({ hoursAgo: 0 });

  const run = runWorkflow(WATCHDOG_ID);
  assert.equal(run.code, 0, `watchdog run failed:\n${run.stderr}`);
  assert.equal(alerts().count, 0, 'recovery must clear the alert without anyone acknowledging it');
});

// --- dead-letter replay ---------------------------------------------------

function seedDeadLetters(ids) {
  psql(`delete from dead_letter where workflow='${SYNC}';`);
  for (const id of ids) {
    const payload = JSON.stringify({ id, name: `Contact ${id}`, email: `${id}@example.invalid` });
    psql(
      `insert into dead_letter (workflow, execution_id, order_id, reason, payload) ` +
      `values ('${SYNC}', 'seed', '${id}', 'seeded by the replay test', '${payload}'::jsonb);`,
    );
  }
}

test('replay reprocesses every outstanding row and claims each exactly once', () => {
  mockApi('POST', '/reset', {});
  mockApi('POST', '/config', { contactCount: 0 });
  seedDeadLetters(['CRM-101', 'CRM-102', 'CRM-103']);

  assert.equal(count(`select count(*) from dead_letter where workflow='${SYNC}' and replayed_at is null;`), 3);

  const run = runWorkflow(REPLAY_ID);
  assert.equal(run.code, 0, `replay run failed:\n${run.stderr}`);

  const counters = asJson(mockApi('GET', '/crm/counters'));
  assert.equal(counters.syncCommits, 3, 'every dead-lettered contact must be reprocessed');
  assert.deepEqual(counters.syncedContacts, ['CRM-101', 'CRM-102', 'CRM-103']);

  assert.equal(
    count(`select count(*) from dead_letter where workflow='${SYNC}' and replayed_at is null;`), 0,
    'every claimed row must be stamped',
  );
  assert.equal(
    count(`select count(*) from dead_letter where workflow='${SYNC}';`), 3,
    'replay must mark the evidence, not delete it',
  );
});

test('a second replay is a no-op — nothing is reprocessed twice', () => {
  // Deliberately continues from the previous test's state: the rows are already
  // claimed. Exactly-once is only meaningful across repeated attempts.
  const commitsBefore = asJson(mockApi('GET', '/crm/counters')).syncCommits;
  const attemptsBefore = asJson(mockApi('GET', '/crm/counters')).syncAttempts;

  const run = runWorkflow(REPLAY_ID);
  assert.equal(run.code, 0, `second replay run failed:\n${run.stderr}`);

  const after = asJson(mockApi('GET', '/crm/counters'));
  assert.equal(after.syncCommits, commitsBefore, 'a replayed row must never be replayed again');
  assert.equal(
    after.syncAttempts, attemptsBefore,
    'the destination must not even be CALLED again — an idempotent destination would hide a double claim',
  );
});

test('a replay that fails again is re-queued as a new row, and the original stays claimed', () => {
  mockApi('POST', '/reset', {});
  mockApi('POST', '/config', { contactCount: 0, failFromContact: 'CRM-200' });
  seedDeadLetters(['CRM-201']);

  const originalId = count(
    `select id from dead_letter where workflow='${SYNC}' and order_id='CRM-201' order by id desc limit 1;`,
  );

  const run = runWorkflow(REPLAY_ID);
  assert.equal(run.code, 0, `replay run failed:\n${run.stderr}`);

  assert.equal(
    count(`select count(*) from dead_letter where workflow='${SYNC}' and id=${originalId} and replayed_at is not null;`),
    1, 'the original row must stay claimed — clearing the claim reopens the double-replay window',
  );
  assert.equal(
    count(`select count(*) from dead_letter where workflow='${SYNC}' and replayed_at is null;`), 1,
    'the failure must come back as exactly one new outstanding row',
  );
  assert.equal(
    count(`select count(*) from dead_letter where workflow='${SYNC}' and reason like 'replay failed%';`), 1,
    'the requeued row must record that it came back from a failed replay',
  );

  mockApi('POST', '/config', { failFromContact: null });
});

test('replay with nothing outstanding completes cleanly instead of erroring', () => {
  psql(`delete from dead_letter where workflow='${SYNC}';`);
  mockApi('POST', '/reset', {});

  const run = runWorkflow(REPLAY_ID);
  assert.equal(run.code, 0, `an empty replay must succeed, not fail:\n${run.stderr}`);
  assert.equal(asJson(mockApi('GET', '/crm/counters')).syncAttempts, 0, 'nothing outstanding means nothing called');
});
