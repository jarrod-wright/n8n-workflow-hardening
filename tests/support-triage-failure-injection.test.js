// AI support triage (wf03) — failure injection, on the live stack.
//
// Five model/provider faults plus an authentication rejection. Every assertion
// is made against the transport (which provider was actually called) and the
// database (what was actually stored), never against the workflow's own account
// of itself.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mockApi, asJson, psql } from './helpers/stack.mjs';
import {
  setupTriage, resetTriageState, sendTicket, sign, stackReady,
  triageRow, humanQueueRow, deadLetterCount, providerCounts,
} from './helpers/support-triage.mjs';

const alerts = () => asJson(mockApi('GET', '/alerts')) || { count: 0, alerts: [] };

before(async () => {
  assert.ok(stackReady(), 'the stack must be up (npm run stack:up) — these gates cannot be skipped');
  assert.ok(await setupTriage(), 'failed to set up the support-triage workflow');
});

// 1 ---------------------------------------------------------------------------
test('unparseable output from the primary is rescued by the second provider', async () => {
  resetTriageState();

  const res = await sendTicket(
    { ticket_id: 'TCK-200', subject: 'Cannot pay', body: 'Payment page errors out.' },
    { scenario: 'malformed', fallbackScenario: 'valid' },
  );

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.equal(res.json.provider, 'fallback', 'the answer must be attributed to the chain that produced it');

  const counts = providerCounts();
  assert.equal(counts.primary, 1, 'the primary is tried first');
  assert.equal(counts.fallback, 1, 'the fallback is tried exactly once, only after the primary failed');
  assert.deepEqual(
    counts.requests.map((r) => r.provider), ['primary', 'fallback'],
    'the order matters: a fallback called first is not a fallback',
  );

  const row = triageRow('TCK-200');
  assert.ok(row, 'a rescued ticket must still be stored');
  assert.equal(row.provider, 'fallback');
  assert.match(row.summary, /fallback provider/, 'the STORED answer must be the fallback\'s, not the primary\'s');

  assert.equal(humanQueueRow('TCK-200'), null, 'a rescued ticket needs no human');
  assert.equal(deadLetterCount('TCK-200'), 0);
});

// 2 ---------------------------------------------------------------------------
test('output that PARSES but breaks the contract is rejected just as firmly', async () => {
  resetTriageState();

  // This is the fault a naive implementation misses entirely: the response is
  // perfectly valid JSON. Only the schema catches that `urgency: 7` and
  // `requires_human: "probably"` are not decisions anything can act on.
  const res = await sendTicket(
    { ticket_id: 'TCK-201', subject: 'Account locked', body: 'Locked out after a password change.' },
    { scenario: 'schema-violation', fallbackScenario: 'valid' },
  );

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.equal(res.json.provider, 'fallback');
  assert.equal(providerCounts().fallback, 1, 'a schema violation must trigger the fallback, exactly like a parse failure');

  const row = triageRow('TCK-201');
  assert.equal(row.urgency, 'high', 'the stored urgency must come from the valid fallback answer');
  assert.notEqual(row.category, 'sales-enquiry-maybe', 'the unroutable category must never have been stored');
});

// 3 ---------------------------------------------------------------------------
test('an empty response is unusable output, not an absent one', async () => {
  resetTriageState();

  const res = await sendTicket(
    { ticket_id: 'TCK-202', subject: 'Silence', body: 'The model said nothing.' },
    { scenario: 'empty', fallbackScenario: 'valid' },
  );

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.equal(res.json.provider, 'fallback',
    'an empty string must fail validation rather than being stored as a blank triage');
  assert.ok(triageRow('TCK-202'));
});

// 4 ---------------------------------------------------------------------------
test('when NEITHER provider returns anything usable, a person gets the ticket', async () => {
  resetTriageState();

  const res = await sendTicket(
    { ticket_id: 'TCK-203', subject: 'Total mess', body: 'Nothing works.' },
    { scenario: 'malformed', fallbackScenario: 'schema-violation' },
  );

  assert.equal(res.status, 202, `expected 202 accepted-not-triaged, got ${res.status}: ${res.text}`);
  assert.equal(res.json.status, 'queued_for_human');

  const counts = providerCounts();
  assert.equal(counts.primary, 1);
  assert.equal(counts.fallback, 1);
  assert.equal(counts.total, 2, 'exactly two provider calls — no unbounded retry loop chasing a good answer');

  assert.equal(triageRow('TCK-203'), null, 'nothing usable was produced, so nothing may be stored as a result');

  const queued = humanQueueRow('TCK-203');
  assert.ok(queued, 'the ticket must reach a human, not vanish');
  assert.match(queued.reason, /no provider returned a usable triage/);
  assert.ok(
    queued.raw_output && queued.raw_output.length > 0,
    'the human must be able to see what the model actually said — a queue without it just moves the mystery',
  );

  assert.equal(deadLetterCount('TCK-203'), 1, 'the failed automation must be dead-lettered for analysis');
  const dl = psql(
    "select payload::text from dead_letter where workflow='03-support-triage' and order_id='TCK-203';",
  );
  assert.match(dl.stdout, /primary_errors/, 'the dead-letter row must carry BOTH chains\' parser errors');
  assert.match(dl.stdout, /fallback_errors/);
});

// 5 ---------------------------------------------------------------------------
test('a provider outage stops the workflow and raises an alert, instead of silently falling back', async () => {
  resetTriageState();
  mockApi('POST', '/reset', {});

  const res = await sendTicket(
    { ticket_id: 'TCK-204', subject: 'Provider down', body: 'The upstream model is unavailable.' },
    { scenario: 'http-500', fallbackScenario: 'valid' },
  );

  // The transport claim: the fallback must NOT have been used to paper over an
  // outage. If it had, every ticket would still return 200 while the primary was
  // completely dead — and nobody would find out until the invoice arrived.
  const counts = providerCounts();
  assert.equal(
    counts.fallback, 0,
    'a dead provider is a failure, not a bad answer to route around — the fallback must not mask an outage',
  );
  assert.ok(counts.primary >= 1, 'the primary was attempted');

  assert.notEqual(res.status, 200, `a failed run must not report success; got ${res.status}: ${res.text}`);
  assert.equal(triageRow('TCK-204'), null, 'nothing may be stored for a run that never got an answer');

  // Wait for the error workflow, which runs asynchronously after the failure.
  let fired = 0;
  for (let i = 0; i < 15 && fired === 0; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    fired = alerts().count;
  }
  assert.ok(fired >= 1, 'the global error handler must fire for an unrecoverable provider failure');
  const alert = alerts().alerts.find((a) => a.workflowName === '03-support-triage');
  assert.ok(alert, 'the alert must name the workflow that failed');
  assert.ok(alert.executionId, 'the alert must carry the execution id so the run can be found');
});

// 6 — T6.6 --------------------------------------------------------------------
test('an unsigned or wrongly signed ticket is rejected before any provider is called', async () => {
  resetTriageState();

  const unsigned = await sendTicket(
    { ticket_id: 'TCK-205', subject: 'No signature', body: 'Unsigned request.' },
    { signed: false },
  );
  assert.equal(unsigned.status, 401, `an unsigned request must be rejected, got ${unsigned.status}`);
  assert.equal(unsigned.json.status, 'unauthorized');

  const wrong = await sendTicket(
    { ticket_id: 'TCK-206', subject: 'Bad signature', body: 'Wrongly signed request.' },
    { extraHeaders: { 'x-signature': 'sha256=' + 'de'.repeat(32) } },
  );
  assert.equal(wrong.status, 401, `a wrongly signed request must be rejected, got ${wrong.status}`);

  // Signed over DIFFERENT bytes than the ones sent: a signature that is valid in
  // isolation but does not match this body. This is the tampering case, and it
  // is the one a length-only or non-constant-time check would let through.
  const tampered = await sendTicket(
    { ticket_id: 'TCK-207', subject: 'Tampered', body: 'Body changed after signing.' },
    { extraHeaders: { 'x-signature': sign(JSON.stringify({ ticket_id: 'TCK-207', subject: 'something else' })) } },
  );
  assert.equal(tampered.status, 401, `a signature over different bytes must be rejected, got ${tampered.status}`);

  assert.equal(
    providerCounts().total, 0,
    'authentication must happen before the expensive call — an unauthenticated request must never ' +
      'reach a paid provider, or an attacker can run up the bill without ever being authorised',
  );
  for (const id of ['TCK-205', 'TCK-206', 'TCK-207']) {
    assert.equal(triageRow(id), null, `${id} must leave no trace`);
    assert.equal(humanQueueRow(id), null);
    assert.equal(deadLetterCount(id), 0);
  }
});
