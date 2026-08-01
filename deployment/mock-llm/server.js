'use strict';
// Mock LLM provider for the AI-triage failure-injection tests. Dependency-free
// Node http, OpenAI-compatible wire format.
//
// WHY A MOCK AND NOT A REAL MODEL
// -------------------------------
// A test that calls a real model is not a test — it is a sample. The same
// prompt can return valid JSON on Tuesday and a chatty preamble on Wednesday,
// so a suite built on one would be green or red for reasons that have nothing
// to do with the code under test. Every response here is a STATIC FIXTURE: the
// same request returns byte-identical bytes forever, including the `id` and
// `created` fields that a real provider varies. That is what makes "the parser
// survives a fenced response" a fact rather than an anecdote.
//
// TWO PROVIDERS, ONE PROCESS
// --------------------------
// The workflow under test has a primary chain and a distinct fallback chain, so
// this server answers on two independent base paths:
//
//   /primary/v1/chat/completions    <- the first-choice provider
//   /fallback/v1/chat/completions   <- the second, distinct provider
//
// Both speak the OpenAI wire format because both n8n chat-model nodes point
// `configuration.baseURL` at whatever URL their credential carries. Counting
// requests per base path is what gives per-provider counters for free: the
// evidence that a fallback actually happened comes from the transport, not from
// the workflow's own self-report.
//
// SCENARIO SELECTION (deterministic, in priority order)
//   1. `x-mock-scenario: <name>` request header.
//   2. a `[[scenario:<name>]]` marker anywhere in the request messages — this
//      lets a scenario ride along with the request through an agent that does
//      not let a caller set headers per request, with no shared mutable state.
//   3. the default set by `POST /config { "scenario": "<name>" }`.
//   4. `valid`.

const http = require('http');

const PORT = Number(process.env.PORT || 3001);

// Fixed so responses are byte-identical run to run. A real provider varies
// both; a fixture that varied them would make "deterministic" untestable.
const FIXED_CREATED = 1767225600; // 2026-01-01T00:00:00Z
const MODEL = 'mock-triage-1';

// The triage object the workflow's parser is expected to recover. Kept as data
// (not a string) so every scenario below is a different *encoding* of the same
// underlying answer — which is exactly the axis the parser is tested on.
function triageFor(provider) {
  return {
    category: 'billing',
    urgency: 'high',
    summary: `duplicate charge reported; resolved by the ${provider} provider`,
    requires_human: false,
  };
}

const SCENARIOS = {
  // Clean, bare JSON — the case that always works and proves nothing on its own.
  valid: (provider) => ({ kind: 'content', content: JSON.stringify(triageFor(provider)) }),

  // Markdown-fenced JSON. The single most common real-world response shape, and
  // the one that breaks a naive JSON.parse().
  fenced: (provider) => ({
    kind: 'content',
    content: '```json\n' + JSON.stringify(triageFor(provider), null, 2) + '\n```',
  }),

  // Fenced JSON buried in conversational prose on both sides.
  prose: (provider) => ({
    kind: 'content',
    content:
      "Sure! Here's the triage result for that ticket:\n\n```json\n" +
      JSON.stringify(triageFor(provider), null, 2) +
      '\n```\n\nLet me know if you would like me to adjust the urgency.',
  }),

  // Syntactically invalid JSON — unquoted keys, trailing comma, missing value.
  malformed: () => ({
    kind: 'content',
    content: '```json\n{ category: billing, urgency: "high", summary: "unterminated, requires_human: }\n```',
  }),

  // Parses cleanly, but violates the contract: unknown category, urgency as a
  // number, requires_human as a string. Proves that "it parsed" is not the same
  // claim as "it is usable", which is the whole reason the schema exists.
  'schema-violation': () => ({
    kind: 'content',
    content: JSON.stringify({
      category: 'sales-enquiry-maybe',
      urgency: 7,
      summary: '',
      requires_human: 'probably',
    }),
  }),

  // Model returns nothing at all.
  empty: () => ({ kind: 'content', content: '' }),

  // Provider-side failures.
  'http-500': () => ({ kind: 'status', status: 500, body: { error: { message: 'mock upstream failure', type: 'server_error' } } }),
  'http-429': () => ({ kind: 'status', status: 429, retryAfter: 1, body: { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } } }),

  // Responds after a configurable delay, to trip a node-level timeout.
  slow: (provider) => ({ kind: 'slow', content: JSON.stringify(triageFor(provider)) }),
};

const state = {
  defaultScenario: 'valid',
  slowMs: 5000,
  total: 0,
  byProvider: Object.create(null),
  byScenario: Object.create(null),
  requests: [],
};

function reset() {
  state.defaultScenario = 'valid';
  state.slowMs = 5000;
  state.total = 0;
  state.byProvider = Object.create(null);
  state.byScenario = Object.create(null);
  state.requests = [];
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ __unparseable: data });
      }
    });
  });
}

function json(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', ...extraHeaders });
  res.end(body);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Flatten every message's content to one searchable string, tolerating both the
// plain-string and the content-parts array shapes.
function promptText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts = [];
  for (const m of messages) {
    if (typeof m.content === 'string') parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content) if (c && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n');
}

function resolveScenario(req, body, provider) {
  const header = req.headers['x-mock-scenario'];
  if (typeof header === 'string' && SCENARIOS[header.trim()]) return header.trim();

  const text = promptText(body);

  // A provider-scoped marker wins, so one ticket can drive the primary and the
  // fallback down different paths in a single request — which is exactly what
  // "the primary returned rubbish, did the fallback save it?" needs. Without
  // this, both chains would see the same marker and always agree.
  const scoped = text.match(new RegExp('\\[\\[scenario-' + provider + ':([a-z0-9-]+)\\]\\]', 'i'));
  if (scoped && SCENARIOS[scoped[1].toLowerCase()]) return scoped[1].toLowerCase();

  const marker = text.match(/\[\[scenario:([a-z0-9-]+)\]\]/i);
  if (marker && SCENARIOS[marker[1].toLowerCase()]) return marker[1].toLowerCase();

  if (SCENARIOS[state.defaultScenario]) return state.defaultScenario;
  return 'valid';
}

function completion(provider, scenario, content) {
  return {
    id: `chatcmpl-mock-${provider}-${scenario}`,
    object: 'chat.completion',
    created: FIXED_CREATED,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: null, tool_calls: [] },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = (req.url || '').split('?')[0];

  if (method === 'GET' && url === '/healthz') {
    return json(res, 200, { status: 'ok' });
  }

  if (method === 'GET' && url === '/counters') {
    return json(res, 200, {
      total: state.total,
      byProvider: { ...state.byProvider },
      byScenario: { ...state.byScenario },
      requests: state.requests,
    });
  }

  if (method === 'POST' && url === '/reset') {
    reset();
    return json(res, 200, { status: 'reset' });
  }

  if (method === 'POST' && url === '/config') {
    const body = await readBody(req);
    if (typeof body.scenario === 'string') {
      if (!SCENARIOS[body.scenario]) {
        return json(res, 400, { error: `unknown scenario "${body.scenario}"`, known: Object.keys(SCENARIOS) });
      }
      state.defaultScenario = body.scenario;
    }
    if (Number.isFinite(body.slowMs)) state.slowMs = Number(body.slowMs);
    return json(res, 200, { scenario: state.defaultScenario, slowMs: state.slowMs });
  }

  if (method === 'GET' && url === '/scenarios') {
    return json(res, 200, { scenarios: Object.keys(SCENARIOS) });
  }

  // ---- OpenAI-compatible surface, namespaced per provider -------------------
  const m = url.match(/^\/(primary|fallback)\/v1\/(chat\/completions|models)$/);
  if (!m) return json(res, 404, { error: { message: `no mock route for ${method} ${url}` } });

  const provider = m[1];
  const route = m[2];

  if (route === 'models' && method === 'GET') {
    return json(res, 200, {
      object: 'list',
      data: [{ id: MODEL, object: 'model', created: FIXED_CREATED, owned_by: 'mock' }],
    });
  }

  if (route !== 'chat/completions' || method !== 'POST') {
    return json(res, 405, { error: { message: 'method not allowed' } });
  }

  const body = await readBody(req);
  const scenario = resolveScenario(req, body, provider);

  state.total += 1;
  state.byProvider[provider] = (state.byProvider[provider] || 0) + 1;
  state.byScenario[scenario] = (state.byScenario[scenario] || 0) + 1;
  state.requests.push({ provider, scenario, at: state.total });

  const fixture = SCENARIOS[scenario](provider);

  if (fixture.kind === 'status') {
    const headers = fixture.retryAfter ? { 'retry-after': String(fixture.retryAfter) } : {};
    return json(res, fixture.status, fixture.body, headers);
  }

  if (fixture.kind === 'slow') {
    await sleep(state.slowMs);
    return json(res, 200, completion(provider, scenario, fixture.content));
  }

  return json(res, 200, completion(provider, scenario, fixture.content));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`mock-llm listening on ${PORT} (providers: primary, fallback)`);
});
