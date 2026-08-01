// Shared setup + request signing for the order-intake workflow, used by the
// happy-path test and the failure-injection suite.
import crypto from 'node:crypto';
import { join } from 'node:path';
import {
  repoRoot, loadEnv, isServiceRunning, ensurePostgresCredential, ensureWebhookAuthCredentials,
  importWorkflowFile, activateWorkflow, workflowExists, registerWebhook, httpRequest,
} from './stack.mjs';
import { orderIntakeAuthHeader } from './webhook-auth.mjs';

export const WF01 = join(repoRoot, '01-order-intake', 'workflow.json');
export const HANDLER = join(repoRoot, '_shared', 'global-error-handler', 'workflow.json');
export const ORDER_WEBHOOK = '/webhook/order-intake';

// HMAC-SHA256 over the exact raw body bytes, as an `sha256=<hex>` header value.
export function sign(rawBody) {
  const secret = loadEnv().ORDER_INTAKE_HMAC_SECRET || '';
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// Idempotent, self-healing setup: credential + handler (active) + wf01 (active)
// + webhook registered. Returns false if the stack isn't up.
export async function setupOrderIntake() {
  if (!isServiceRunning('n8n') || !isServiceRunning('n8n-worker') || !isServiceRunning('mock-api')) {
    return false;
  }
  ensurePostgresCredential();
  ensureWebhookAuthCredentials();
  if (!workflowExists('global-error-handler')) importWorkflowFile(HANDLER);
  activateWorkflow('globalerrhandler');
  if (!workflowExists('01-order-intake')) importWorkflowFile(WF01);
  activateWorkflow('orderintake00001');
  return registerWebhook('order-intake');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Send an order to the webhook. By default it is correctly signed AND carries
// the Header Auth token, because that is what a legitimate caller sends.
//
// The two controls are independent and separately suppressible, which is what
// lets the tests exercise them one at a time:
//   { auth: false }   -> no auth token; n8n refuses at the HTTP layer (403)
//   { signed: false } -> no valid signature; the workflow refuses (401)
export async function sendOrder(body, { signed = true, auth = true, extraHeaders = {} } = {}) {
  const raw = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json',
    ...(auth ? orderIntakeAuthHeader() : {}),
    ...extraHeaders,
  };
  if (signed && !('x-signature' in extraHeaders)) headers['x-signature'] = sign(raw);
  try {
    // Shared transport path: retried ONLY when no HTTP response was received.
    // A 401 from the HMAC check or a 403 from Header Auth is a response, so it
    // is returned unchanged and unretried.
    const { status, text } = await httpRequest(`http://127.0.0.1:5678${ORDER_WEBHOOK}`, {
      method: 'POST', headers, body: raw,
    });
    return { status, text, json: safeJson(text) };
  } catch (e) {
    return { status: 0, text: String(e.message || e), json: null };
  }
}
