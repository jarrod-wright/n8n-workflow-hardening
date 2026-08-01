// Stack-extension gate (live).
//
// Proves three things about the surface the scheduled-sync and AI-triage
// workflows are built on, BEFORE either workflow exists — so that a later
// workflow failure can never be explained away as "the mock was flaky":
//
//   1. The scheduled-sync tables exist in the database the stack actually
//      brought up, created by the init script rather than by hand.
//   2. The CRM delta feed is deterministic and its cursor semantics are
//      strictly greater-than, and the rate limiter answers 429 + Retry-After.
//   3. The mock LLM returns byte-identical fixtures for the same request, honours
//      the scenario header AND the in-prompt marker, and counts requests per
//      provider so a fallback is observable from the transport.
//
// The stack is expected to be up via the documented bring-up (`npm run
// stack:up`); the preflight in `npm test` fails the run outright if it is not,
// so nothing here can pass by skipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psql, mockApi, mockLlm, asJson } from './helpers/stack.mjs';

// --- 1. schema ------------------------------------------------------------

const SYNC_TABLES = {
  sync_watermark: ['workflow', 'cursor_value', 'updated_at'],
  sync_audit: [
    'workflow', 'execution_id', 'started_at', 'finished_at',
    'items_read', 'items_synced', 'items_failed', 'cursor_before', 'cursor_after', 'status',
  ],
  sync_heartbeat: ['workflow', 'last_run_at', 'last_success_at', 'status'],
};

test('the scheduled-sync tables exist in the running database', () => {
  for (const table of Object.keys(SYNC_TABLES)) {
    const r = psql(`select to_regclass('public.${table}') is not null;`);
    assert.equal(r.code, 0, `psql failed for ${table}: ${r.stderr}`);
    assert.equal(
      r.stdout.trim(), 't',
      `${table} is missing from the running database — the init script did not create it`,
    );
  }
});

test('each scheduled-sync table carries the columns the workflow depends on', () => {
  for (const [table, columns] of Object.entries(SYNC_TABLES)) {
    const r = psql(
      `select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name='${table}';`,
    );
    assert.equal(r.code, 0, `psql failed for ${table}: ${r.stderr}`);
    const present = new Set(r.stdout.trim().split(','));
    const missing = columns.filter((c) => !present.has(c));
    assert.deepEqual(missing, [], `${table} is missing column(s): ${missing.join(', ')}`);
  }
});

test('dead_letter can record a replay without destroying the evidence', () => {
  const r = psql(
    "select count(*) from information_schema.columns where table_name='dead_letter' and column_name='replayed_at';",
  );
  assert.equal(r.stdout.trim(), '1', 'dead_letter.replayed_at is missing — replay cannot be exactly-once');
});

// --- 2. CRM delta feed + rate limiter -------------------------------------

test('the CRM delta feed is deterministic across identical requests', () => {
  mockApi('POST', '/reset', {});
  const a = mockApi('GET', '/crm/contacts?since=&limit=5');
  const b = mockApi('GET', '/crm/contacts?since=&limit=5');
  assert.equal(a.code, 0, a.stderr);
  assert.equal(
    a.stdout, b.stdout,
    'the same delta request returned different bytes — the feed is not a fixture',
  );

  const page = asJson(a);
  assert.equal(page.count, 5);
  assert.equal(page.items[0].id, 'CRM-001', 'first contact must be stable across runs');
  assert.equal(page.items[0].updated_at, '2026-01-01T00:01:00.000Z', 'cursors must be fixed, not now-relative');
  assert.equal(page.remaining, 7);
});

test('the delta cursor is strictly greater-than: no re-read, no skip', () => {
  mockApi('POST', '/reset', {});
  const first = asJson(mockApi('GET', '/crm/contacts?since=&limit=4'));
  const cursor = first.items[first.items.length - 1].updated_at;

  const next = asJson(mockApi('GET', `/crm/contacts?since=${encodeURIComponent(cursor)}&limit=4`));
  assert.equal(next.items[0].id, 'CRM-005', 'resuming from a committed cursor must not re-read it');

  const ids = new Set([...first.items, ...next.items].map((i) => i.id));
  assert.equal(ids.size, 8, 'the two pages overlap — the cursor is not strictly greater-than');
});

test('a contact sync commits at most once per contact, however many attempts', () => {
  mockApi('POST', '/reset', {});
  for (let i = 0; i < 3; i++) mockApi('POST', '/crm/sync', { id: 'CRM-001' });
  const counters = asJson(mockApi('GET', '/crm/counters'));
  assert.equal(counters.syncAttempts, 3);
  assert.equal(counters.syncCommits, 1, 'repeated delivery must not double-commit');
});

test('the rate limiter answers 429 with Retry-After once the window is exceeded', () => {
  mockApi('POST', '/reset', {});
  mockApi('POST', '/config', { rateLimit: { limit: 2, windowMs: 60000 } });

  // Two calls inside the window succeed; the third is limited. Using a long
  // window makes this a counted assertion rather than a timing race.
  assert.equal(asJson(mockApi('POST', '/crm/sync', { id: 'CRM-001' })).status, 'ok');
  assert.equal(asJson(mockApi('POST', '/crm/sync', { id: 'CRM-002' })).status, 'ok');

  // busybox wget exits non-zero on a 4xx, so assert on the transport failure
  // and then on the counter the limiter incremented.
  const limited = mockApi('POST', '/crm/sync', { id: 'CRM-003' });
  assert.notEqual(limited.code, 0, 'the third call inside the window should have been rejected');
  assert.match(limited.stderr, /429/, `expected a 429 response, got:\n${limited.stderr}`);

  const counters = asJson(mockApi('GET', '/crm/counters'));
  assert.equal(counters.rateLimited, 1, 'the limiter must count what it rejected');
  assert.equal(counters.syncCommits, 2, 'a rate-limited call must not commit');

  mockApi('POST', '/config', { rateLimit: null });
});

test('rate limiting is off unless a test asks for it', () => {
  mockApi('POST', '/reset', {});
  for (let i = 1; i <= 6; i++) mockApi('POST', '/crm/sync', { id: `CRM-00${i}` });
  const counters = asJson(mockApi('GET', '/crm/counters'));
  assert.equal(counters.rateLimited, 0, 'the limiter must default to off so it cannot perturb unrelated tests');
  assert.equal(counters.syncCommits, 6);
});

// --- 3. mock LLM -----------------------------------------------------------

const CHAT = { model: 'mock-triage-1', messages: [{ role: 'user', content: 'triage this ticket' }] };

test('the mock provider returns byte-identical bytes for an identical request', () => {
  mockLlm('POST', '/reset', {});
  const a = mockLlm('POST', '/primary/v1/chat/completions', CHAT);
  const b = mockLlm('POST', '/primary/v1/chat/completions', CHAT);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(
    a.stdout, b.stdout,
    'two identical requests returned different bytes — including id/created, which a fixture must fix',
  );
});

test('the scenario header selects the fixture', () => {
  mockLlm('POST', '/reset', {});
  const fenced = asJson(mockLlm('POST', '/primary/v1/chat/completions', CHAT, { 'x-mock-scenario': 'fenced' }));
  const content = fenced.choices[0].message.content;
  assert.match(content, /^```json/, 'the fenced scenario must return markdown-fenced JSON');
  assert.doesNotMatch(content, /^\{/, 'the fenced fixture must not be bare JSON');

  const bare = asJson(mockLlm('POST', '/primary/v1/chat/completions', CHAT, { 'x-mock-scenario': 'valid' }));
  assert.doesNotMatch(bare.choices[0].message.content, /```/);
});

test('an in-prompt scenario marker selects the fixture when a header cannot be set', () => {
  mockLlm('POST', '/reset', {});
  const body = { model: 'mock-triage-1', messages: [{ role: 'user', content: 'ticket text [[scenario:malformed]]' }] };
  const r = asJson(mockLlm('POST', '/primary/v1/chat/completions', body));
  const content = r.choices[0].message.content;
  assert.match(content, /category: billing/, 'the malformed fixture must be syntactically invalid JSON');
  assert.throws(() => JSON.parse(content.replace(/```json|```/g, '')), 'the malformed fixture must not parse');
});

test('the header wins over the in-prompt marker', () => {
  mockLlm('POST', '/reset', {});
  const body = { model: 'mock-triage-1', messages: [{ role: 'user', content: 'x [[scenario:malformed]]' }] };
  const r = asJson(mockLlm('POST', '/primary/v1/chat/completions', body, { 'x-mock-scenario': 'valid' }));
  assert.doesNotThrow(() => JSON.parse(r.choices[0].message.content));
});

test('every declared scenario is reachable and typed as advertised', () => {
  mockLlm('POST', '/reset', {});
  const declared = asJson(mockLlm('GET', '/scenarios')).scenarios;
  assert.ok(declared.includes('valid') && declared.includes('fenced') && declared.includes('prose'));
  assert.ok(declared.includes('malformed') && declared.includes('schema-violation') && declared.includes('empty'));

  // schema-violation must PARSE but not conform — that distinction is the whole
  // reason the workflow validates as a separate step from parsing.
  const sv = asJson(mockLlm('POST', '/primary/v1/chat/completions', CHAT, { 'x-mock-scenario': 'schema-violation' }));
  const parsed = JSON.parse(sv.choices[0].message.content);
  assert.equal(typeof parsed.urgency, 'number', 'schema-violation must parse cleanly yet break the contract');

  const empty = asJson(mockLlm('POST', '/primary/v1/chat/completions', CHAT, { 'x-mock-scenario': 'empty' }));
  assert.equal(empty.choices[0].message.content, '');
});

test('provider errors are real HTTP failures, not success bodies describing failure', () => {
  mockLlm('POST', '/reset', {});
  const err = mockLlm('POST', '/primary/v1/chat/completions', CHAT, { 'x-mock-scenario': 'http-500' });
  assert.notEqual(err.code, 0);
  assert.match(err.stderr, /500/);

  const limited = mockLlm('POST', '/primary/v1/chat/completions', CHAT, { 'x-mock-scenario': 'http-429' });
  assert.notEqual(limited.code, 0);
  assert.match(limited.stderr, /429/);
});

test('requests are counted per provider, so a fallback is visible from the transport', () => {
  mockLlm('POST', '/reset', {});
  mockLlm('POST', '/primary/v1/chat/completions', CHAT);
  mockLlm('POST', '/primary/v1/chat/completions', CHAT);
  mockLlm('POST', '/fallback/v1/chat/completions', CHAT);

  const counters = asJson(mockLlm('GET', '/counters'));
  assert.equal(counters.byProvider.primary, 2);
  assert.equal(counters.byProvider.fallback, 1);
  assert.equal(counters.total, 3);
});

test('the two providers are distinguishable in their output', () => {
  mockLlm('POST', '/reset', {});
  const p = asJson(mockLlm('POST', '/primary/v1/chat/completions', CHAT));
  const f = asJson(mockLlm('POST', '/fallback/v1/chat/completions', CHAT));
  assert.match(JSON.parse(p.choices[0].message.content).summary, /primary provider/);
  assert.match(JSON.parse(f.choices[0].message.content).summary, /fallback provider/);
});
