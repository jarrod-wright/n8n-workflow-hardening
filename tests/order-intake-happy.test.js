// Order-intake (wf01) happy path: a correctly signed, valid order is accepted,
// the upstream is called and commits exactly once, and an idempotency row is
// written.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { psql, mockApi, sleep } from './helpers/stack.mjs';
import { setupOrderIntake, sendOrder } from './helpers/order-intake.mjs';

let ready = false;
before(async () => {
  ready = await setupOrderIntake();
});

test('valid signed order is accepted, upstream commits once, idempotency row written', async (t) => {
  assert.ok(ready, 'order-intake stack/webhook not ready — cannot verify this gate (no skip: a masked gate is a fail)');

  mockApi('POST', '/reset', {});
  const orderId = `happy-${Date.now()}`;
  const res = await sendOrder({ order_id: orderId, amount: 42 });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.equal(res.json?.status, 'ok', `expected status ok, got: ${res.text}`);
  assert.equal(res.json?.order_id, orderId);

  // Upstream was called and committed exactly once.
  await sleep(500);
  const counters = JSON.parse(mockApi('GET', '/counters').stdout);
  assert.equal(counters.commits, 1, `expected exactly one upstream commit, got ${counters.commits}`);

  // Idempotency ledger has the row.
  const rows = psql(`select count(*) from idempotency_keys where order_id='${orderId}';`);
  assert.equal(rows.stdout.trim(), '1', 'expected one idempotency row for the order');
});
