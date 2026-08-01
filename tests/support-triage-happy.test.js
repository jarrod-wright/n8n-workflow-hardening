// AI support triage (wf03) — happy path, on the live stack.
//
// Proves the ordinary case works end to end, and — just as importantly — that
// the ordinary case uses ONLY the primary provider. A workflow that quietly
// falls back on every request still looks green from the outside while costing
// twice as much and hiding a broken primary.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupTriage, resetTriageState, sendTicket, stackReady,
  triageRow, humanQueueRow, deadLetterCount, providerCounts,
} from './helpers/support-triage.mjs';

before(async () => {
  assert.ok(stackReady(), 'the stack must be up (npm run stack:up) — these gates cannot be skipped');
  assert.ok(await setupTriage(), 'failed to set up the support-triage workflow');
});

test('a signed ticket is triaged by the primary provider and recorded', async () => {
  resetTriageState();

  const res = await sendTicket({
    ticket_id: 'TCK-100',
    subject: 'Charged twice this month',
    body: 'My card was billed twice for the same subscription.',
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.equal(res.json.status, 'triaged');
  assert.equal(res.json.ticket_id, 'TCK-100');
  assert.equal(res.json.provider, 'primary');
  assert.equal(res.json.category, 'billing');
  assert.equal(res.json.urgency, 'high');
  assert.equal(res.json.requires_human, false);

  const row = triageRow('TCK-100');
  assert.ok(row, 'the triage result must be persisted, not only returned');
  assert.equal(row.category, 'billing');
  assert.equal(row.provider, 'primary', 'the stored row must record which chain produced it');

  const counts = providerCounts();
  assert.equal(counts.primary, 1, 'exactly one call to the primary provider');
  assert.equal(
    counts.fallback, 0,
    'the fallback must NOT be called on a healthy request — a workflow that always falls back ' +
      'looks green while costing double and hiding a broken primary',
  );

  assert.equal(humanQueueRow('TCK-100'), null, 'a clean triage needs no human');
  assert.equal(deadLetterCount('TCK-100'), 0);
});

test('a fenced response is recovered by the parser without a fallback', async () => {
  resetTriageState();

  // Markdown-fenced JSON is the single most common real response shape and the
  // one that breaks a naive JSON.parse. Recovering it in the parser is what
  // stops it from becoming a needless (and billable) second provider call.
  const res = await sendTicket(
    { ticket_id: 'TCK-101', subject: 'Cannot log in', body: 'Password reset never arrives.' },
    { scenario: 'fenced' },
  );

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.equal(res.json.provider, 'primary');
  assert.ok(triageRow('TCK-101'), 'the fenced response must have been parsed and stored');

  const counts = providerCounts();
  assert.equal(counts.fallback, 0, 'a response the parser can recover must not trigger a fallback');
});

test('prose wrapped around the JSON is also recovered without a fallback', async () => {
  resetTriageState();

  const res = await sendTicket(
    { ticket_id: 'TCK-102', subject: 'Refund request', body: 'I would like a refund please.' },
    { scenario: 'prose' },
  );

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.equal(res.json.provider, 'primary');
  assert.equal(providerCounts().fallback, 0);
});

test('a ticket missing its identifier is rejected before any provider is called', async () => {
  resetTriageState();

  const res = await sendTicket({ subject: 'No id here', body: 'This ticket has no identifier.' });

  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
  assert.equal(res.json.status, 'invalid');
  assert.ok(res.json.errors.some((e) => /ticket_id/.test(e)));
  assert.equal(
    providerCounts().total, 0,
    'input validation must happen before the expensive call, not after it',
  );
});

test('the same ticket delivered twice does not create a second result row', async () => {
  resetTriageState();

  const ticket = { ticket_id: 'TCK-103', subject: 'Duplicate delivery', body: 'Sent twice by the sender.' };
  const first = await sendTicket(ticket);
  const second = await sendTicket(ticket);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const { psql } = await import('./helpers/stack.mjs');
  const rows = Number(psql("select count(*) from triage_result where ticket_id='TCK-103';").stdout.trim());
  assert.equal(rows, 1, 'a redelivered ticket must update its row, not accumulate rows');
});
