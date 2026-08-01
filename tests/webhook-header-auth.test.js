// Header Auth on both public webhook surfaces.
//
// The claim under test is not merely "an unauthenticated request is refused" —
// it is that the refusal happens BEFORE an execution is created. That
// distinction is the whole reason this layer was added on top of the HMAC check
// that was already there.
//
// In queue mode the HMAC check runs inside the workflow, on the worker. A
// request that fails it has already cost an enqueue, a worker cycle and a row in
// the execution log. An attacker who cannot forge a signature can still push
// that cost indefinitely. Header Auth is evaluated by n8n at the HTTP layer, so
// a caller without the token never reaches the queue at all.
//
// So each surface is checked twice: the request without the token must be
// refused AND leave the execution count unchanged, and the request with it must
// go on to be HMAC-verified exactly as before. Asserting only the status code
// would pass just as happily if n8n were rejecting the request after running the
// workflow, which is the thing this test exists to rule out.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { countRows, sleep } from './helpers/stack.mjs';
import { setupOrderIntake, sendOrder } from './helpers/order-intake.mjs';
import { setupTriage, sendTicket, resetTriageState } from './helpers/support-triage.mjs';

let orderReady = false;
let triageReady = false;
before(async () => {
  orderReady = await setupOrderIntake();
  triageReady = await setupTriage();
});

const uid = (p) => `${p}-${Date.now()}-${Math.floor(process.hrtime()[1] % 100000)}`;

// Executions recorded for one workflow. The count is per-workflow so unrelated
// traffic on the other surface, or the error handler firing, cannot move it.
function executionsFor(workflowId) {
  return countRows(`select count(*) from execution_entity where "workflowId"='${workflowId}';`);
}

// n8n answers a failed Webhook-node authentication with 403 (the request was
// understood and refused), as distinct from the workflow's own 401 for a bad
// HMAC signature. Both are rejections; they are raised by different layers, and
// keeping them distinguishable is deliberate — it is how an operator reading
// logs can tell "unknown caller" apart from "known caller, tampered payload".
const AUTH_REJECT_STATUS = 403;

test('order intake: a request WITHOUT the auth header is refused before any execution is created', async () => {
  assert.ok(orderReady, 'order-intake stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');

  const before = executionsFor('orderintake00001');
  assert.ok(before >= 0, 'could not read the execution count — the assertion below would be meaningless');

  // Correctly SIGNED, but carrying no auth header. Signing it matters: it proves
  // the rejection is the auth layer's doing and not the HMAC check's.
  const res = await sendOrder({ order_id: uid('noauth'), amount: 10 }, { auth: false });

  assert.equal(
    res.status, AUTH_REJECT_STATUS,
    `a request without the auth header must be refused with ${AUTH_REJECT_STATUS}, got ${res.status}: ${res.text}`,
  );

  await sleep(1000);
  assert.equal(
    executionsFor('orderintake00001'), before,
    'an unauthenticated request created an execution. The refusal must happen at the HTTP layer, ' +
      'before anything is queued — otherwise every rejected request still costs a worker cycle ' +
      'and a row in the execution log, which is exactly the abuse this layer prevents.',
  );
});

test('support triage: a request WITHOUT the auth header is refused before any execution is created', async () => {
  assert.ok(triageReady, 'support-triage stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');

  const before = executionsFor('supporttriage001');
  assert.ok(before >= 0, 'could not read the execution count — the assertion below would be meaningless');

  const res = await sendTicket(
    { ticket_id: uid('TCK-noauth'), subject: 'No auth header', body: 'Signed but unauthenticated.' },
    { auth: false },
  );

  assert.equal(
    res.status, AUTH_REJECT_STATUS,
    `a request without the auth header must be refused with ${AUTH_REJECT_STATUS}, got ${res.status}: ${res.text}`,
  );

  await sleep(1000);
  assert.equal(
    executionsFor('supporttriage001'), before,
    'an unauthenticated request created an execution. Authentication must precede the queue — and ' +
      'on this surface it also precedes a paid model call.',
  );
});

test('order intake: a request WITH the auth header proceeds to HMAC verification as normal', async () => {
  assert.ok(orderReady, 'order-intake stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');

  const before = executionsFor('orderintake00001');

  // Authenticated but deliberately mis-signed: the request must get PAST the
  // auth layer and then be stopped by the HMAC check, with the workflow's own
  // 401. That is what proves Header Auth is additive rather than a replacement —
  // if it had displaced the signature check, this would have succeeded.
  const badSig = await sendOrder(
    { order_id: uid('authbadsig'), amount: 10 },
    { signed: false, extraHeaders: { 'x-signature': 'sha256=deadbeef' } },
  );
  assert.equal(
    badSig.status, 401,
    `an authenticated request with a bad signature must still be rejected by the HMAC check ` +
      `with 401, got ${badSig.status}: ${badSig.text}`,
  );
  assert.equal(badSig.json?.status, 'unauthorized');

  // And a correctly signed one goes all the way through.
  const orderId = uid('authok');
  const ok = await sendOrder({ order_id: orderId, amount: 10 });
  assert.equal(ok.status, 200, `an authenticated, correctly signed order must succeed, got ${ok.status}: ${ok.text}`);
  assert.equal(ok.json?.status, 'ok');

  await sleep(500);
  assert.ok(
    executionsFor('orderintake00001') > before,
    'an authenticated request must actually reach the queue and be executed',
  );
  assert.equal(countRows(`select count(*) from idempotency_keys where order_id='${orderId}';`), 1);
});

test('support triage: a request WITH the auth header proceeds to HMAC verification as normal', async () => {
  assert.ok(triageReady, 'support-triage stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');
  resetTriageState();

  const before = executionsFor('supporttriage001');

  const badSig = await sendTicket(
    { ticket_id: 'TCK-901', subject: 'Bad signature', body: 'Authenticated but wrongly signed.' },
    { extraHeaders: { 'x-signature': 'sha256=' + 'de'.repeat(32) } },
  );
  assert.equal(
    badSig.status, 401,
    `an authenticated request with a bad signature must still be rejected by the HMAC check ` +
      `with 401, got ${badSig.status}: ${badSig.text}`,
  );

  const ok = await sendTicket(
    { ticket_id: 'TCK-902', subject: 'Cannot log in', body: 'Password reset loops.' },
    { scenario: 'ok' },
  );
  assert.equal(ok.status, 200, `an authenticated, correctly signed ticket must succeed, got ${ok.status}: ${ok.text}`);

  await sleep(500);
  assert.ok(
    executionsFor('supporttriage001') > before,
    'an authenticated request must actually reach the queue and be executed',
  );
});

test('the two surfaces hold DIFFERENT tokens — one leak must not open both doors', async () => {
  assert.ok(orderReady && triageReady, 'both surfaces must be ready to compare their tokens');

  const { orderIntakeToken, supportTriageToken } = await import('./helpers/webhook-auth.mjs');
  const a = orderIntakeToken();
  const b = supportTriageToken();

  assert.ok(a.length >= 16, 'the order-intake token must be a real value, not a placeholder');
  assert.ok(b.length >= 16, 'the support-triage token must be a real value, not a placeholder');
  assert.notEqual(
    a, b,
    'both webhook surfaces are using the same token. Independent tokens are the reason a ' +
      'compromised caller on one endpoint can be revoked without taking the other down.',
  );

  // The sharper proof: the order-intake token must not open the triage door.
  const res = await sendTicket(
    { ticket_id: uid('TCK-crosstoken'), subject: 'Wrong door', body: 'Order-intake token on the triage endpoint.' },
    { auth: false, extraHeaders: { 'x-webhook-auth': a } },
  );
  assert.equal(
    res.status, AUTH_REJECT_STATUS,
    `the order-intake token must not authenticate against the support-triage webhook, got ${res.status}`,
  );
});
