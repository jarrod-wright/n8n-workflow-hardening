// Shared setup and drivers for the scheduled CRM sync (wf02).
//
// Running the workflow goes through the DOCUMENTED script — `npm run wf:run --
// --id=<id>` — rather than reaching into docker directly. That matters: a helper
// that quietly supplies arguments the documented path does not is how a suite
// ends up more capable than its user, proving something the reader cannot
// reproduce. Everything these tests do, an operator can do from the README.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  repoRoot, isServiceRunning, ensurePostgresCredential, importWorkflowFile,
  workflowExists, psql, mockApi, asJson,
} from './stack.mjs';

export const WF02 = join(repoRoot, '02-crm-sync', 'workflow.json');
export const WF02_ID = 'crmsync000000001';
export const WF02_NAME = '02-crm-sync';

// Contact N has cursor BASE + N minutes; see deployment/mock-api/server.js.
export function cursorOf(n) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 60_000).toISOString();
}
export const EPOCH_CURSOR = '1970-01-01T00:00:00.000Z';

export function stackReady() {
  return ['n8n', 'postgres', 'mock-api'].every(isServiceRunning);
}

// Import + credential. Idempotent, so each test file can call it.
export function setupCrmSync() {
  if (!stackReady()) return false;
  ensurePostgresCredential();
  if (!workflowExists(WF02_NAME)) importWorkflowFile(WF02);
  return workflowExists(WF02_NAME);
}

// Wipe only this workflow's rows, so a run starts from a known cursor and the
// order-intake tests' data is left alone.
export function resetSyncState() {
  psql(`delete from sync_audit where workflow='${WF02_NAME}';`);
  psql(`delete from sync_heartbeat where workflow='${WF02_NAME}';`);
  psql(`delete from sync_watermark where workflow='${WF02_NAME}';`);
  psql(`delete from dead_letter where workflow='${WF02_NAME}';`);
}

// Reset the mock and shape the contact set / injected failures for one scenario.
export function configureCrm({ contactCount = 5, ...injection } = {}) {
  mockApi('POST', '/reset', {});
  mockApi('POST', '/config', { contactCount, ...injection });
}

// Run the workflow through the documented script. Returns { code, stdout, stderr }.
export function runSync({ timeout = 240000 } = {}) {
  try {
    const stdout = execFileSync('npm', ['run', '--silent', 'wf:run', '--', `--id=${WF02_ID}`], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : String(e.message || e),
    };
  }
}

// --- state readers --------------------------------------------------------

export function watermark() {
  const r = psql(`select cursor_value from sync_watermark where workflow='${WF02_NAME}';`);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function latestAudit() {
  const cols = 'items_read,items_synced,items_failed,cursor_before,cursor_after,status';
  const r = psql(
    `select ${cols.split(',').join(" || '|' || ")} from sync_audit ` +
    `where workflow='${WF02_NAME}' order by id desc limit 1;`,
  );
  if (r.code !== 0 || !r.stdout.trim()) return null;
  const [read, synced, failed, before, after, status] = r.stdout.trim().split('|');
  return {
    items_read: Number(read), items_synced: Number(synced), items_failed: Number(failed),
    cursor_before: before, cursor_after: after, status,
  };
}

export function auditCount() {
  const r = psql(`select count(*) from sync_audit where workflow='${WF02_NAME}';`);
  return r.code === 0 ? Number(r.stdout.trim()) : -1;
}

export function heartbeat() {
  // Note: concatenating a boolean into text renders it as 'true'/'false', not
  // the 't'/'f' psql shows for a boolean COLUMN. Casting to int removes the
  // ambiguity rather than leaving the test to guess which form it will get.
  const r = psql(
    "select status || '|' || (last_run_at is not null)::int || '|' || (last_success_at is not null)::int " +
    `|| '|' || coalesce(last_success_at::text,'') from sync_heartbeat where workflow='${WF02_NAME}';`,
  );
  if (r.code !== 0 || !r.stdout.trim()) return null;
  const [status, ran, succeeded, successAt] = r.stdout.trim().split('|');
  return { status, ran: ran === '1', succeeded: succeeded === '1', successAt };
}

export function deadLettered() {
  const r = psql(
    `select order_id from dead_letter where workflow='${WF02_NAME}' order by order_id;`,
  );
  if (r.code !== 0) return [];
  return r.stdout.trim() ? r.stdout.trim().split('\n').map((s) => s.trim()) : [];
}

export function crmCounters() {
  return asJson(mockApi('GET', '/crm/counters')) || {};
}
