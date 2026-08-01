// Header Auth for the two public webhook surfaces.
//
// This is the layer that answers "who is calling". The HMAC signature answers a
// different question — "is this message authentic and untampered" — and both are
// kept, because either one alone leaves a real gap:
//
//   * Header Auth alone: anyone holding the token can send any body they like.
//   * HMAC alone: an unauthenticated caller still gets an execution queued and a
//     worker cycle burned before the signature is checked.
//
// n8n's Webhook node evaluates Header Auth at the HTTP layer, BEFORE an
// execution is created, so junk traffic never reaches the queue. The HMAC check
// then runs inside the workflow, on the raw body, in constant time.
//
// One credential per surface rather than one shared between them: the two
// endpoints serve different upstream systems, and a shared token would mean
// revoking a compromised order-intake caller also takes support triage down.
// The arrangement is uniform in kind across both — each webhook holds its own.
import { loadEnv } from './stack.mjs';

// One header name, two values. The name is shared because it is not a secret;
// the values are per-surface because they are.
export const AUTH_HEADER_NAME = 'x-webhook-auth';

// Credential ids are fixed so `import:credentials` is idempotent — re-importing
// updates in place rather than creating a second copy each run.
export const ORDER_INTAKE_CREDENTIAL_ID = 'orderintakeauth1';
export const SUPPORT_TRIAGE_CREDENTIAL_ID = 'supporttriageau1';

export const ORDER_INTAKE_CREDENTIAL_NAME = 'Order intake webhook auth';
export const SUPPORT_TRIAGE_CREDENTIAL_NAME = 'Support triage webhook auth';

export function orderIntakeToken() {
  return loadEnv().ORDER_INTAKE_WEBHOOK_AUTH_TOKEN || '';
}

export function supportTriageToken() {
  return loadEnv().SUPPORT_TRIAGE_WEBHOOK_AUTH_TOKEN || '';
}

// The header a legitimate caller sends. Callers that need to exercise the
// rejection path pass `{ auth: false }` to the send helpers instead.
export function orderIntakeAuthHeader() {
  return { [AUTH_HEADER_NAME]: orderIntakeToken() };
}

export function supportTriageAuthHeader() {
  return { [AUTH_HEADER_NAME]: supportTriageToken() };
}
