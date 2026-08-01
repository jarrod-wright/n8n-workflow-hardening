// AI support triage (wf03) structure test — static assertions on the exported
// JSON. Safe to run without the stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

const wf = JSON.parse(readFileSync(join(repoRoot, '03-support-triage', 'workflow.json'), 'utf8'));
const pins = JSON.parse(readFileSync(join(repoRoot, 'typeversions.json'), 'utf8')).nodeTypes;
const schemaFile = readFileSync(join(repoRoot, 'schemas', 'triage-output.schema.json'), 'utf8');
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const targets = (node, out, kind = 'main') =>
  ((wf.connections[node] || {})[kind]?.[out] || []).map((c) => c.node);

test('every node uses the pinned typeVersion', () => {
  for (const node of wf.nodes) {
    const pin = pins[node.type];
    assert.ok(pin, `node type ${node.type} is not pinned in typeversions.json`);
    assert.equal(node.typeVersion, pin.typeVersion, `${node.name} (${node.type})`);
  }
});

test('the workflow references the global error handler', () => {
  assert.equal(wf.settings?.errorWorkflow, 'globalerrhandler');
});

// --- authentication (reused from the order-intake webhook) ----------------

test('the webhook authenticates over the raw body, exactly as the order intake does', () => {
  const wh = byName['Ticket Webhook'];
  assert.equal(wh.type, 'n8n-nodes-base.webhook');
  assert.equal(wh.parameters.httpMethod, 'POST');
  assert.equal(wh.parameters.responseMode, 'responseNode');
  assert.equal(wh.parameters.options?.rawBody, true, 'rawBody must be on so the HMAC signs the exact bytes');

  const v = byName['Verify HMAC'];
  assert.equal(v.type, 'n8n-nodes-base.code');
  assert.match(v.parameters.jsCode, /createHmac\(\s*['"]sha256['"]/);
  assert.match(v.parameters.jsCode, /timingSafeEqual/, 'the compare must be constant-time');
});

test('the auth implementation is the SAME one the order intake uses, not a second copy that can drift', () => {
  const wf01 = JSON.parse(readFileSync(join(repoRoot, '01-order-intake', 'workflow.json'), 'utf8'));
  const theirs = wf01.nodes.find((n) => n.name === 'Verify HMAC').parameters.jsCode;
  const ours = byName['Verify HMAC'].parameters.jsCode;

  // The shared core is the verification itself: read the raw body, take the
  // header, compute the MAC, compare in constant time. It ends at the catch that
  // settles `authOk`. What each workflow does with the verdict afterwards is
  // legitimately different; how it reaches the verdict must not be.
  const END = '} catch (e) { authOk = false; }';
  const core = (js) => {
    const end = js.indexOf(END);
    assert.notEqual(end, -1, 'expected the constant-time compare to be guarded by a catch');
    return js.slice(0, end + END.length);
  };
  assert.equal(
    core(ours), core(theirs),
    'the two public entry points must verify signatures with identical code — two subtly ' +
      'different implementations means one of them is weaker and nobody knows which',
  );
});

test('an unauthenticated request is answered 401 and never reaches a provider', () => {
  assert.deepEqual(targets('Auth OK?', 1), ['Respond Unauthorized']);
  assert.equal(byName['Respond Unauthorized'].parameters.options.responseCode, 401);
  assert.deepEqual(targets('Auth OK?', 0), ['Build Ticket'],
    'only an authenticated request may proceed toward the model');
});

// --- the agent is bounded -------------------------------------------------

test('the agent has a bounded iteration ceiling', () => {
  const a = byName['Triage Agent'];
  assert.equal(a.type, '@n8n/n8n-nodes-langchain.agent');
  const max = a.parameters.options?.maxIterations;
  assert.equal(typeof max, 'number', 'maxIterations must be set explicitly, not left to the default');
  assert.ok(max > 0 && max <= 5,
    `an agent without a tight iteration ceiling can spend unbounded money and time on one ticket; got ${max}`);
});

test('both model nodes carry a timeout and their own credential', () => {
  for (const name of ['Primary Model', 'Fallback Model']) {
    const m = byName[name];
    assert.ok(m, `${name} is missing`);
    const timeout = m.parameters.options?.timeout;
    assert.ok(timeout > 0 && timeout <= 30000,
      `${name} needs a bounded timeout or a hung provider hangs the request; got ${timeout}`);
    assert.equal(m.parameters.options?.temperature, 0,
      `${name} must be deterministic — a triage router is not a creative writing task`);
    assert.ok(Object.keys(m.credentials || {}).length === 1, `${name} must carry exactly one credential`);
  }
});

test('a provider failure stops the workflow rather than half-processing the ticket', () => {
  const a = byName['Triage Agent'];
  assert.equal(a.retryOnFail, true, 'a transient provider failure deserves one retry');
  assert.equal(a.onError, 'stopWorkflow',
    'a dead provider is a failure, not a bad answer to route around — stopping lets the caller redeliver');
});

// --- the deterministic parser --------------------------------------------

test('the parser is a Code node — no model is asked to fix another model output', () => {
  for (const name of ['Parse Triage', 'Parse Fallback']) {
    assert.equal(byName[name].type, 'n8n-nodes-base.code', `${name} must be deterministic code`);
  }
  const types = new Set(wf.nodes.map((n) => n.type));
  assert.ok(
    !types.has('@n8n/n8n-nodes-langchain.outputParserAutofixing'),
    'an auto-fixing output parser asks a second model to repair the first one — that turns one ' +
      'non-deterministic step into two, and is the opposite of a deterministic contract',
  );
});

test('the parser strips fences, then parses, then validates — in that order', () => {
  const js = byName['Parse Triage'].parameters.jsCode;
  const fence = js.indexOf('extractJson');
  const parse = js.indexOf('JSON.parse');
  const valid = js.indexOf('validate(triage, SCHEMA');
  assert.ok(fence > -1 && parse > -1 && valid > -1, 'all three stages must be present');
  assert.ok(parse < valid, 'validation must happen after parsing, on the parsed object');
  assert.match(js, /```/, 'the parser must handle markdown-fenced JSON — the most common real response shape');
});

test('parsing successfully is NOT the same as being usable', () => {
  const js = byName['Parse Triage'].parameters.jsCode;
  // A parsed-but-invalid object must still come out invalid.
  assert.match(js, /errors = validate\(triage, SCHEMA/,
    'a successfully parsed object must still be validated against the contract');
  assert.match(js, /valid: errors\.length === 0/);
});

test('the embedded schema has not drifted from schemas/triage-output.schema.json', () => {
  const js = byName['Parse Triage'].parameters.jsCode;
  const start = js.indexOf('const SCHEMA = ');
  assert.ok(start > -1, 'the parser must embed the schema');
  const literal = js.slice(start + 'const SCHEMA = '.length, js.indexOf('\n\n//', start));
  const embedded = JSON.parse(literal.replace(/;\s*$/, ''));
  assert.deepEqual(
    embedded, JSON.parse(schemaFile),
    'a Code node cannot read from disk, so the schema must be embedded — but an embedded copy that ' +
      'can silently drift from the reviewable file is worse than no file at all',
  );
});

test('the fallback is held to exactly the same standard as the primary', () => {
  const strip = (js) => js.split('\n').slice(1).join('\n'); // drop the PROVIDER line
  assert.equal(
    strip(byName['Parse Triage'].parameters.jsCode),
    strip(byName['Parse Fallback'].parameters.jsCode),
    'a fallback validated more loosely than the primary is not a fallback — it is a way to accept ' +
      'output you already decided was unusable',
  );
  assert.match(byName['Parse Triage'].parameters.jsCode, /^const PROVIDER = 'primary';/);
  assert.match(byName['Parse Fallback'].parameters.jsCode, /^const PROVIDER = 'fallback';/);
});

// --- the second provider chain is genuinely second -----------------------

test('the fallback chain is a DIFFERENT provider, not the same one called twice', () => {
  const primary = byName['Primary Model'];
  const fallback = byName['Fallback Model'];
  assert.notEqual(
    primary.type, fallback.type,
    'a fallback to the same provider fails for the same reason at the same moment',
  );
  assert.notDeepEqual(Object.keys(primary.credentials), Object.keys(fallback.credentials),
    'the two chains must authenticate to different providers');
  assert.notEqual(
    Object.values(primary.credentials)[0].id,
    Object.values(fallback.credentials)[0].id,
  );
});

test('each chain is wired to its own model, and only its own', () => {
  assert.deepEqual(targets('Primary Model', 0, 'ai_languageModel'), ['Triage Agent']);
  assert.deepEqual(targets('Fallback Model', 0, 'ai_languageModel'), ['Fallback Triage']);
});

test('an invalid primary result falls back; a valid one does not', () => {
  assert.deepEqual(targets('Triage Valid?', 0), ['Record Triage']);
  assert.deepEqual(targets('Triage Valid?', 1), ['Fallback Triage'],
    'the fallback must be reached only when the primary produced something unusable');
});

// --- the terminal paths ---------------------------------------------------

test('a ticket no provider could triage goes to a human AND to the dead-letter table', () => {
  // Both ways of failing converge on one normalising node, so the human queue,
  // the dead-letter row and the response cannot disagree about what happened.
  assert.deepEqual(targets('Fallback Valid?', 1), ['Escalate To Human'],
    'unusable fallback output escalates');
  assert.deepEqual(targets('Fallback Triage', 1), ['Escalate To Human'],
    'an unreachable fallback PROVIDER escalates down the same path, rather than being merged ' +
      'into the happy path and rediscovered later as an empty answer');
  assert.deepEqual(targets('Escalate To Human', 0), ['Queue For Human']);
  assert.deepEqual(targets('Queue For Human', 0), ['Dead-letter Ticket']);
  assert.deepEqual(targets('Dead-letter Ticket', 0), ['Respond Needs Human']);

  assert.match(byName['Queue For Human'].parameters.query, /INSERT INTO human_review_queue/i);
  assert.match(
    byName['Queue For Human'].parameters.options.queryReplacement, /raw|r\.raw/,
    'the human who picks this up must be able to see what the model actually said',
  );
  assert.match(byName['Dead-letter Ticket'].parameters.query, /INSERT INTO dead_letter/i);
  assert.equal(byName['Respond Needs Human'].parameters.options.responseCode, 202,
    'the caller should learn the ticket was accepted but not automatically triaged');
});

test('the stored result records WHICH provider produced it', () => {
  const q = byName['Record Triage'].parameters.query;
  assert.match(q, /INSERT INTO triage_result/i);
  assert.match(q, /provider/, 'a silent drift onto the fallback must be visible in the data, not just in logs');
  assert.match(q, /ON CONFLICT \(ticket_id\) DO UPDATE/i, 'a redelivered ticket must not create a second row');
  assert.match(q, /RETURNING/i);
});

test('every branch answers the caller', () => {
  const responders = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.respondToWebhook');
  assert.ok(responders.length >= 4, `expected a response on each terminal branch, found ${responders.length}`);
  const codes = responders.map((r) => r.parameters.options.responseCode).sort();
  assert.deepEqual(codes, [200, 202, 400, 401]);
});

// --- SQL hygiene ----------------------------------------------------------

test('every Postgres query is parameterized and credentialed', () => {
  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres')) {
    assert.match(node.parameters.query, /\$1/, `${node.name} must bind parameters`);
    assert.doesNotMatch(node.parameters.query, /\{\{/, `${node.name} must not build SQL from an expression`);
    assert.ok(node.parameters.options?.queryReplacement, `${node.name} must use queryReplacement`);
    assert.ok(node.credentials?.postgres?.id, `${node.name} has no credential`);
  }
});
