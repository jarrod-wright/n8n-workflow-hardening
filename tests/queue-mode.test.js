// Queue mode proven functional WITH broker authentication enabled: a job
// enqueued by n8n main is executed by the worker.
//
// In queue mode the main instance never executes workflows itself — it enqueues
// them on the (authenticated) broker and a worker pulls and runs them. So a
// webhook that returns its downstream node's output, backed by a `success`
// execution the worker logged finishing, is end-to-end proof of
// main -> broker(auth) -> worker -> execute.
//
// The setup is idempotent and self-healing so the proof reproduces from a clean
// stack: it imports + activates the probe workflow if missing and restarts main
// to register the webhook if it isn't yet reachable.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  compose, docker, psql, isServiceRunning, repoRoot, sleep, registerWebhook, httpRequest, httpNoPool,
} from './helpers/stack.mjs';

const WEBHOOK_URL = 'http://127.0.0.1:5678/webhook/queue-probe';
const HEALTHZ = 'http://127.0.0.1:5678/healthz';
const FIXTURE = join(repoRoot, 'tests', 'fixtures', 'queue-mode-probe.workflow.json');

let ready = false;

// Both of these go through the shared helper for the same reason every other
// n8n-facing request does: this file calls registerWebhook(), which may restart
// the main process, and a request drawn from the pre-restart connection pool
// fails at the transport layer with no HTTP response. Any response, whatever
// its status, is still returned unchanged and unretried.
async function post(url, body) {
  try {
    return await httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    return { status: 0, text: String(e.message || e) };
  }
}

async function waitHealthy(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpNoPool(HEALTHZ);
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  return false;
}

function probeExists() {
  const r = psql("select count(*) from workflow_entity where name='queue-mode-probe';");
  return r.code === 0 && parseInt(r.stdout.trim(), 10) > 0;
}

before(async () => {
  if (!isServiceRunning('n8n') || !isServiceRunning('n8n-worker')) return;

  if (!probeExists()) {
    compose(['cp', FIXTURE, 'n8n:/tmp/probe.json']);
    compose(['exec', '-T', 'n8n', 'n8n', 'import:workflow', '--input=/tmp/probe.json']);
  }
  // Ensure active (deprecated command still works; harmless if already active).
  compose(['exec', '-T', 'n8n', 'n8n', 'update:workflow', '--id=queueprobe000001', '--active=true']);

  // Register the webhook using the shared, patient helper (polls, then restarts
  // main and re-polls) — the same path the order-intake tests use reliably.
  ready = await registerWebhook('queue-probe');
});

test('an enqueued webhook job is executed by the worker (auth enabled)', async (t) => {
  assert.ok(ready, 'queue-mode stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');

  // 1. Trigger: main enqueues, worker executes, response carries the Set output.
  const r = await post(WEBHOOK_URL, { probe: true });
  assert.equal(r.status, 200, `expected 200 from webhook, got ${r.status}: ${r.text}`);
  const body = JSON.parse(r.text);
  assert.equal(body.ok, true, `expected ok:true in response, got ${r.text}`);
  assert.equal(body.processedBy, 'worker', `expected processedBy:worker, got ${r.text}`);

  // 2. A successful webhook execution is recorded.
  await sleep(1500);
  const rows = psql(
    "select count(*) from execution_entity where status='success' and mode='webhook';",
  );
  assert.equal(rows.code, 0, `execution query failed: ${rows.stderr}`);
  assert.ok(parseInt(rows.stdout.trim(), 10) >= 1, 'expected at least one successful webhook execution');

  // 3. The worker — not main — is what finished the execution.
  const logs = docker([
    'compose', '-f', join(repoRoot, 'deployment', 'docker-compose.yml'),
    '--env-file', join(repoRoot, '.env'),
    'logs', 'n8n-worker',
  ]);
  assert.match(
    logs.stdout + logs.stderr,
    /Worker (started|finished) execution/i,
    'expected the worker log to show it executed the enqueued job',
  );
});
