// Shared setup and drivers for the AI support-triage workflow (wf03).
import crypto from 'node:crypto';
import { join } from 'node:path';
import {
  repoRoot, loadEnv, isServiceRunning, ensurePostgresCredential, ensureLlmCredentials,
  ensureWebhookAuthCredentials,
  importWorkflowFile, activateWorkflow, workflowExists, registerWebhook,
  psql, mockLlm, asJson, httpRequest,
} from './stack.mjs';
import { supportTriageAuthHeader } from './webhook-auth.mjs';

export const WF03 = join(repoRoot, '03-support-triage', 'workflow.json');
export const WF03_ID = 'supporttriage001';
export const WF03_NAME = '03-support-triage';
export const HANDLER = join(repoRoot, '_shared', 'global-error-handler', 'workflow.json');
export const TRIAGE_WEBHOOK = '/webhook/support-triage';

export function stackReady() {
  return ['n8n', 'n8n-worker', 'postgres', 'mock-llm'].every(isServiceRunning);
}

// Idempotent, self-healing setup: credentials + error handler + wf03, both
// active, with the production webhook actually registered.
export async function setupTriage() {
  if (!stackReady()) return false;
  ensurePostgresCredential();
  ensureLlmCredentials();
  ensureWebhookAuthCredentials();
  if (!workflowExists('global-error-handler')) importWorkflowFile(HANDLER);
  activateWorkflow('globalerrhandler');
  if (!workflowExists(WF03_NAME)) importWorkflowFile(WF03);
  activateWorkflow(WF03_ID);
  return registerWebhook('support-triage');
}

// The identical signing scheme the order-intake webhook uses.
export function sign(rawBody) {
  const secret = loadEnv().ORDER_INTAKE_HMAC_SECRET || '';
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Send a ticket. By default it is correctly signed AND carries the Header Auth
// token, because that is what a legitimate caller sends. The two controls are
// independent and separately suppressible:
//   { auth: false }   -> no auth token; n8n refuses at the HTTP layer (403)
//   { signed: false } -> no valid signature; the workflow refuses (401)
//
// `scenario` / `fallbackScenario` are carried inside the ticket body as markers.
// The mock provider resolves them per request, which is what lets one ticket
// drive the primary and the fallback down different paths.
export async function sendTicket(ticket, { signed = true, auth = true, extraHeaders = {}, scenario, fallbackScenario } = {}) {
  const markers = [
    scenario ? `[[scenario:${scenario}]]` : '',
    fallbackScenario ? `[[scenario-fallback:${fallbackScenario}]]` : '',
  ].filter(Boolean).join(' ');

  const payload = { ...ticket };
  if (markers) payload.body = `${payload.body || ''} ${markers}`.trim();

  const raw = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    ...(auth ? supportTriageAuthHeader() : {}),
    ...extraHeaders,
  };
  if (signed && !('x-signature' in extraHeaders)) headers['x-signature'] = sign(raw);

  try {
    // Shared transport path: retried ONLY when no HTTP response was received.
    // Any status the workflow produces — 200, 202, 401 — comes back unchanged
    // and unretried, so nothing here can soften an authentication result.
    const { status, text } = await httpRequest(`http://127.0.0.1:5678${TRIAGE_WEBHOOK}`, {
      method: 'POST', headers, body: raw,
    });
    return { status, text, json: safeJson(text) };
  } catch (e) {
    return { status: 0, text: String(e.message || e), json: null };
  }
}

// --- state readers --------------------------------------------------------

export function resetTriageState() {
  psql("delete from triage_result where ticket_id like 'TCK-%';");
  psql("delete from human_review_queue where ticket_id like 'TCK-%';");
  psql("delete from dead_letter where workflow='03-support-triage';");
  mockLlm('POST', '/reset', {});
}

export function triageRow(ticketId) {
  const r = psql(
    "select category || '|' || urgency || '|' || requires_human::int || '|' || provider || '|' || summary " +
    `from triage_result where ticket_id='${ticketId}';`,
  );
  if (r.code !== 0 || !r.stdout.trim()) return null;
  const [category, urgency, requiresHuman, provider, ...rest] = r.stdout.trim().split('|');
  return { category, urgency, requires_human: requiresHuman === '1', provider, summary: rest.join('|') };
}

export function humanQueueRow(ticketId) {
  const r = psql(
    `select reason || '||' || coalesce(raw_output,'') from human_review_queue where ticket_id='${ticketId}';`,
  );
  if (r.code !== 0 || !r.stdout.trim()) return null;
  const [reason, ...rest] = r.stdout.trim().split('||');
  return { reason, raw_output: rest.join('||') };
}

export function deadLetterCount(ticketId) {
  const r = psql(
    `select count(*) from dead_letter where workflow='03-support-triage' and order_id='${ticketId}';`,
  );
  return r.code === 0 ? Number(r.stdout.trim()) : -1;
}

export function providerCounts() {
  const c = asJson(mockLlm('GET', '/counters')) || {};
  return { primary: 0, fallback: 0, ...(c.byProvider || {}), total: c.total || 0, requests: c.requests || [] };
}
