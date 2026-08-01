// Global error handler: it fires when a workflow that references it fails, and
// the alert it emits carries the failed execution's id.
//
// Proof path: a probe workflow (webhook -> Stop And Error) declares the global
// handler as its errorWorkflow. Triggering it fails the execution, n8n runs the
// error workflow, and the handler POSTs an alert to the mock-api sink. The test
// reads the sink and asserts an alert arrived carrying execution.id.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  repoRoot, isServiceRunning, importWorkflowFile, activateWorkflow,
  workflowExists, httpPost, registerWebhook, mockApi, sleep,
} from './helpers/stack.mjs';

const HANDLER = join(repoRoot, '_shared', 'global-error-handler', 'workflow.json');
const PROBE = join(repoRoot, 'tests', 'fixtures', 'error-handler-fail-probe.workflow.json');

let ready = false;

function alerts() {
  const r = mockApi('GET', '/alerts');
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { count: 0, alerts: [] };
  }
}

before(async () => {
  if (!isServiceRunning('n8n') || !isServiceRunning('n8n-worker') || !isServiceRunning('mock-api')) {
    return;
  }
  // Import the handler if its file exists and it isn't loaded yet. The error
  // workflow must be ACTIVE to be invocable as another workflow's errorWorkflow.
  if (existsSync(HANDLER) && !workflowExists('global-error-handler')) {
    importWorkflowFile(HANDLER);
  }
  activateWorkflow('globalerrhandler');

  if (!workflowExists('error-handler-fail-probe')) {
    importWorkflowFile(PROBE);
  }
  activateWorkflow('errhandlerprobe1');

  // registerWebhook restarts main, which picks up both active flags.
  ready = await registerWebhook('fail-probe');
});

test('handler fires on referenced-workflow failure and the alert carries execution.id', async (t) => {
  assert.ok(ready, 'error-handler stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');

  mockApi('POST', '/reset', {});

  // Trigger the failing workflow (it returns 500; the error workflow runs async).
  await httpPost('/webhook/fail-probe', { probe: true });

  // Poll the alert sink.
  let got = { count: 0, alerts: [] };
  for (let i = 0; i < 15; i++) {
    got = alerts();
    if (got.count >= 1) break;
    await sleep(1000);
  }

  assert.ok(got.count >= 1, `expected the error handler to POST an alert, got ${got.count}`);
  const alert = got.alerts[got.alerts.length - 1];
  assert.ok(
    alert.executionId !== undefined && String(alert.executionId).length > 0,
    `expected the alert to carry a non-empty execution id, got: ${JSON.stringify(alert)}`,
  );
});
