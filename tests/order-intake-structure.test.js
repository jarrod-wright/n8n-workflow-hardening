// Order-intake (wf01) structure test — static assertions on the exported JSON.
// Encodes the hardening invariants the workflow must keep, and is safe to run
// without the stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

const wf = JSON.parse(readFileSync(join(repoRoot, '01-order-intake', 'workflow.json'), 'utf8'));
const pins = JSON.parse(readFileSync(join(repoRoot, 'typeversions.json'), 'utf8')).nodeTypes;
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));

test('every node uses the pinned typeVersion from typeversions.json', () => {
  for (const node of wf.nodes) {
    const pin = pins[node.type];
    assert.ok(pin, `node type ${node.type} is not pinned in typeversions.json`);
    assert.equal(
      node.typeVersion, pin.typeVersion,
      `${node.name} (${node.type}) uses typeVersion ${node.typeVersion}, pinned is ${pin.typeVersion}`,
    );
  }
});

test('the workflow references the global error handler', () => {
  assert.equal(wf.settings?.errorWorkflow, 'globalerrhandler');
});

test('the webhook authenticates over the raw body', () => {
  const wh = byName['Order Webhook'];
  assert.ok(wh, 'expected an Order Webhook node');
  assert.equal(wh.parameters.httpMethod, 'POST');
  assert.equal(wh.parameters.responseMode, 'responseNode');
  assert.equal(wh.parameters.options?.rawBody, true, 'rawBody must be on so HMAC signs the exact bytes');
});

test('HMAC verification uses a real MAC and constant-time compare', () => {
  const v = byName['Verify HMAC'];
  assert.ok(v && v.type === 'n8n-nodes-base.code', 'expected a Verify HMAC code node');
  assert.match(v.parameters.jsCode, /createHmac\(\s*['"]sha256['"]/);
  assert.match(v.parameters.jsCode, /timingSafeEqual/, 'compare must be constant-time');
});

test('idempotency is an atomic unique-constraint insert', () => {
  const q = byName['Idempotency Insert'];
  assert.ok(q && q.type === 'n8n-nodes-base.postgres');
  assert.match(q.parameters.query, /insert into idempotency_keys/i);
  assert.match(q.parameters.query, /on conflict/i);
});

test('dead-letter path inserts into dead_letter', () => {
  const q = byName['DLQ Insert'];
  assert.ok(q && q.type === 'n8n-nodes-base.postgres');
  assert.match(q.parameters.query, /insert into dead_letter/i);
});

test('Postgres queries are parameterized (no expression interpolated into SQL)', () => {
  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres')) {
    assert.match(node.parameters.query, /\$1/, `${node.name} should bind parameters with $1..`);
    assert.doesNotMatch(
      node.parameters.query, /\{\{/,
      `${node.name} must not interpolate an expression into the SQL string (injection risk)`,
    );
    assert.ok(
      node.parameters.options?.queryReplacement,
      `${node.name} must pass values via queryReplacement, not string-built SQL`,
    );
  }
});

test('the upstream call retries and dead-letters on exhaustion', () => {
  const h = byName['Call Upstream'];
  assert.ok(h && h.type === 'n8n-nodes-base.httpRequest');
  assert.equal(h.retryOnFail, true, 'upstream call must retry');
  assert.ok(h.maxTries >= 2, 'must allow more than one attempt');
  assert.equal(h.onError, 'continueErrorOutput', 'exhausted retries must route to the error branch');
});

test('an explicit stop-and-error surfaces the unrecoverable failure', () => {
  const s = byName['Stop And Error'];
  assert.ok(s && s.type === 'n8n-nodes-base.stopAndError');
});

test('the webhook always gets a response node on every branch', () => {
  const responders = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.respondToWebhook');
  assert.ok(responders.length >= 4, `expected a response on each terminal branch, found ${responders.length}`);
});
