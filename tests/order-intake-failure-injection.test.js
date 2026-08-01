// Order-intake failure-injection suite: five faults driven through wf01,
// each observed via the mock-api dual counters (attempts vs commits) and the
// Postgres tables. Assertions are keyed per order_id so they are robust to any
// shared state, and every test resets the mock-api first.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { psql, mockApi, countRows, sleep } from './helpers/stack.mjs';
import { setupOrderIntake, sendOrder } from './helpers/order-intake.mjs';

let ready = false;
before(async () => {
  ready = await setupOrderIntake();
});
beforeEach(() => {
  if (ready) mockApi('POST', '/reset', {});
});

function counters() {
  return JSON.parse(mockApi('GET', '/counters').stdout);
}
function alerts() {
  return JSON.parse(mockApi('GET', '/alerts').stdout);
}
const uid = (p) => `${p}-${Date.now()}-${Math.floor(process.hrtime()[1] % 100000)}`;

// 1. Retry fires: two injected upstream failures, then success.
test('retry fires: upstream is retried until it succeeds', async (t) => {
  assert.ok(ready, 'order-intake stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');
  const orderId = uid('retry');
  mockApi('POST', '/config', { failuresByOrder: { [orderId]: 2 } });

  const res = await sendOrder({ order_id: orderId, amount: 10 });
  assert.equal(res.status, 200, `expected eventual success, got ${res.status}: ${res.text}`);
  assert.equal(res.json?.status, 'ok');

  await sleep(500);
  const c = counters();
  assert.equal(c.attemptsByOrder[orderId], 3, 'expected 2 failed attempts + 1 success = 3');
  assert.ok(c.committedOrders.includes(orderId), 'order should have committed once retries passed');
});

// 2. Idempotency exactly-once: same order twice -> upstream called once.
test('idempotency: a duplicate delivery is not reprocessed', async (t) => {
  assert.ok(ready, 'order-intake stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');
  const orderId = uid('dup');

  const first = await sendOrder({ order_id: orderId, amount: 10 });
  assert.equal(first.json?.status, 'ok', `first send should be ok, got ${first.text}`);

  const second = await sendOrder({ order_id: orderId, amount: 10 });
  assert.equal(second.status, 200);
  assert.equal(second.json?.status, 'duplicate', `second send should be duplicate, got ${second.text}`);

  await sleep(300);
  const c = counters();
  assert.equal(c.attemptsByOrder[orderId], 1, 'upstream must be called exactly once across both deliveries');
  assert.equal(countRows(`select count(*) from idempotency_keys where order_id='${orderId}';`), 1);
});

// 3. Input validation: a signed but invalid order is rejected before any effect.
test('input validation: an invalid order is rejected with no side effects', async (t) => {
  assert.ok(ready, 'order-intake stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');
  const orderId = uid('invalid');
  // amount is not a positive number -> validation fails (but the request IS signed).
  const res = await sendOrder({ order_id: orderId, amount: -5 });

  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
  assert.equal(res.json?.status, 'invalid');

  await sleep(300);
  const c = counters();
  assert.equal(c.attemptsByOrder[orderId], undefined, 'upstream must not be called for an invalid order');
  assert.equal(countRows(`select count(*) from idempotency_keys where order_id='${orderId}';`), 0);
});

// 4. Unrecoverable -> DLQ + handler: upstream always fails.
test('unrecoverable failure is dead-lettered and the error handler fires', async (t) => {
  assert.ok(ready, 'order-intake stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');
  const orderId = uid('dlq');
  mockApi('POST', '/config', { failEverything: true });

  const res = await sendOrder({ order_id: orderId, amount: 10 });
  assert.equal(res.status, 502, `expected 502, got ${res.status}: ${res.text}`);
  assert.equal(res.json?.status, 'failed');

  // Dead-letter row written.
  await sleep(500);
  assert.equal(
    countRows(`select count(*) from dead_letter where order_id='${orderId}';`), 1,
    'expected the order in the dead_letter table',
  );

  // Retries were exhausted (maxTries = 3).
  assert.equal(counters().attemptsByOrder[orderId], 3, 'expected the upstream to be tried 3 times');

  // The global error handler fired for this failed execution.
  let fired = null;
  for (let i = 0; i < 15; i++) {
    fired = alerts().alerts.find((a) => a.workflowName === '01-order-intake');
    if (fired) break;
    await sleep(1000);
  }
  assert.ok(fired, 'expected the error handler to alert for the failed order-intake execution');
  assert.ok(String(fired.executionId).length > 0, 'alert must carry the execution id');
});

// 5. Webhook auth: a bad signature is rejected before any effect.
test('webhook auth: a bad signature is rejected', async (t) => {
  assert.ok(ready, 'order-intake stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');
  const orderId = uid('badauth');
  const res = await sendOrder(
    { order_id: orderId, amount: 10 },
    { signed: false, extraHeaders: { 'x-signature': 'sha256=deadbeef' } },
  );

  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${res.text}`);
  assert.equal(res.json?.status, 'unauthorized');

  await sleep(300);
  const c = counters();
  assert.equal(c.attemptsByOrder[orderId], undefined, 'upstream must not be called for a bad signature');
  assert.equal(countRows(`select count(*) from idempotency_keys where order_id='${orderId}';`), 0);
});
