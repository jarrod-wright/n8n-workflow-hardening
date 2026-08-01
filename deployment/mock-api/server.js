'use strict';
// Mock upstream API for failure-injection tests. Dependency-free Node http.
//
// Dual counters:
//   attempts — every POST /process call, whether it succeeds or is failed.
//   commits  — distinct order_ids that were successfully processed (the real
//              side-effect). commits is what proves exactly-once: no matter how
//              many times an order is retried or redelivered, commits counts it
//              at most once.
//
// Failure injection: POST /config { "failuresByOrder": { "<order_id>": 2 } }
// makes the next 2 calls for that order return 503 (retryable) before it
// succeeds — used to drive the retry path. { "failEverything": true } fails all
// calls (used to drive the exhaust-retries -> dead-letter path).

// CRM delta-sync surface (used by the scheduled sync workflow)
// ------------------------------------------------------------
// GET  /crm/contacts?since=<iso>&limit=<n>  paged delta feed, cursor = updated_at
// POST /crm/sync                            the per-contact side effect
//
// The contact set is generated deterministically from a fixed base timestamp, so
// "the fourth contact" means the same record on every run and on every machine.
// Cursors are therefore stable and a watermark assertion can name an exact value
// instead of "whatever the last one was".
//
// The rate limiter models the thing that actually breaks nightly syncs: a
// provider that answers 429 with Retry-After once you go too fast. It is off by
// default so it can never perturb the tests that are about something else.

const http = require('http');

const PORT = Number(process.env.PORT || 3000);

// 2026-01-01T00:00:00.000Z. Contact N has updated_at = BASE + N minutes.
const CRM_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const DEFAULT_CONTACT_COUNT = 12;

function buildContacts(count) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      id: `CRM-${String(n).padStart(3, '0')}`,
      name: `Contact ${n}`,
      email: `contact${n}@example.invalid`,
      updated_at: new Date(CRM_BASE_MS + n * 60_000).toISOString(),
    };
  });
}

const state = {
  attempts: 0,
  commits: 0,
  attemptsByOrder: Object.create(null),
  committedOrders: new Set(),
  failuresByOrder: Object.create(null),
  failEverything: false,
  alerts: [],

  // --- CRM delta-sync state ---
  contacts: buildContacts(DEFAULT_CONTACT_COUNT),
  syncAttempts: 0,
  syncCommits: 0,
  syncedContacts: new Set(),
  syncAttemptsByContact: Object.create(null),
  failuresByContact: Object.create(null),
  failFromContact: null,   // this contact and every later one fail permanently
  rateLimited: 0,
  rateLimit: null,         // { limit, windowMs }
  failDelta: false,        // make the delta feed itself fail
  rateWindowStart: 0,
  rateWindowCount: 0,
};

function reset() {
  state.attempts = 0;
  state.commits = 0;
  state.attemptsByOrder = Object.create(null);
  state.committedOrders = new Set();
  state.failuresByOrder = Object.create(null);
  state.failEverything = false;
  state.alerts = [];

  state.contacts = buildContacts(DEFAULT_CONTACT_COUNT);
  state.syncAttempts = 0;
  state.syncCommits = 0;
  state.syncedContacts = new Set();
  state.syncAttemptsByContact = Object.create(null);
  state.failuresByContact = Object.create(null);
  state.failFromContact = null;
  state.rateLimited = 0;
  state.rateLimit = null;
  state.failDelta = false;
  state.rateWindowStart = 0;
  state.rateWindowCount = 0;
}

// Returns true when this call must be rejected with 429.
function rateLimitExceeded() {
  if (!state.rateLimit) return false;
  const now = Date.now();
  const { limit, windowMs } = state.rateLimit;
  if (now - state.rateWindowStart >= windowMs) {
    state.rateWindowStart = now;
    state.rateWindowCount = 0;
  }
  state.rateWindowCount += 1;
  return state.rateWindowCount > limit;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
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

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = req.url;
  const path = (url || '').split('?')[0];

  if (method === 'GET' && path === '/healthz') {
    return json(res, 200, { status: 'ok' });
  }

  // ---- CRM delta feed -----------------------------------------------------
  // Cursor semantics are strictly greater-than: a caller that resumes from the
  // cursor it last committed re-reads nothing and skips nothing.
  if (method === 'GET' && path === '/crm/contacts') {
    // The delta feed itself going down is a different failure from a single
    // record failing: nothing is read, so the cursor must not move at all.
    if (state.failDelta) {
      return json(res, 503, { status: 'error', retryable: true, detail: 'delta feed unavailable' });
    }
    const qs = new URLSearchParams((url.split('?')[1] || ''));
    const since = qs.get('since') || '';
    const limit = Math.max(1, Math.min(500, Number(qs.get('limit') || 50)));

    const sinceMs = since ? Date.parse(since) : NaN;
    const all = [...state.contacts].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    const delta = Number.isNaN(sinceMs)
      ? all
      : all.filter((c) => Date.parse(c.updated_at) > sinceMs);
    const page = delta.slice(0, limit);

    return json(res, 200, {
      items: page,
      count: page.length,
      remaining: Math.max(0, delta.length - page.length),
      since: since || null,
    });
  }

  if (method === 'GET' && path === '/crm/counters') {
    return json(res, 200, {
      syncAttempts: state.syncAttempts,
      syncCommits: state.syncCommits,
      syncedContacts: [...state.syncedContacts].sort(),
      syncAttemptsByContact: { ...state.syncAttemptsByContact },
      rateLimited: state.rateLimited,
      contactCount: state.contacts.length,
    });
  }

  // The per-contact side effect. Everything that can go wrong with a nightly
  // sync goes wrong here: rate limits, transient failures, and a permanent
  // failure part-way through a batch.
  if (method === 'POST' && path === '/crm/sync') {
    const body = await readBody(req);
    const id = String(body.id ?? body.contact_id ?? '');

    if (rateLimitExceeded()) {
      state.rateLimited += 1;
      return json(res, 429, { status: 'rate_limited', id }, { 'retry-after': '1' });
    }

    state.syncAttempts += 1;
    state.syncAttemptsByContact[id] = (state.syncAttemptsByContact[id] || 0) + 1;

    // Permanent failure from a nominated contact onwards — the mid-batch
    // failure that a watermark must survive without skipping the survivors.
    if (state.failFromContact && id >= state.failFromContact) {
      return json(res, 500, { status: 'error', retryable: false, id });
    }

    const remaining = state.failuresByContact[id] || 0;
    if (remaining > 0) {
      state.failuresByContact[id] = remaining - 1;
      return json(res, 503, { status: 'error', retryable: true, id });
    }

    const duplicate = state.syncedContacts.has(id);
    if (!duplicate) {
      state.syncedContacts.add(id);
      state.syncCommits += 1;
    }
    return json(res, 200, { status: 'ok', id, duplicate });
  }

  if (method === 'GET' && path === '/counters') {
    return json(res, 200, {
      attempts: state.attempts,
      commits: state.commits,
      committedOrders: [...state.committedOrders],
      attemptsByOrder: { ...state.attemptsByOrder },
    });
  }

  if (method === 'POST' && path === '/reset') {
    reset();
    return json(res, 200, { status: 'reset' });
  }

  // Alert sink — stands in for a real alerting endpoint (PagerDuty/Slack/etc.).
  // The global error handler POSTs here; tests read /alerts to prove the handler
  // fired and that the alert carries the execution id.
  if (method === 'POST' && path === '/alert') {
    const body = await readBody(req);
    state.alerts.push(body);
    return json(res, 200, { status: 'received', count: state.alerts.length });
  }

  if (method === 'GET' && path === '/alerts') {
    return json(res, 200, { count: state.alerts.length, alerts: state.alerts });
  }

  if (method === 'POST' && path === '/config') {
    const body = await readBody(req);
    if (body.failuresByOrder && typeof body.failuresByOrder === 'object') {
      for (const [k, v] of Object.entries(body.failuresByOrder)) {
        state.failuresByOrder[k] = Number(v) || 0;
      }
    }
    if (typeof body.failEverything === 'boolean') {
      state.failEverything = body.failEverything;
    }

    // --- CRM delta-sync injection ---
    if (body.failuresByContact && typeof body.failuresByContact === 'object') {
      for (const [k, v] of Object.entries(body.failuresByContact)) {
        state.failuresByContact[k] = Number(v) || 0;
      }
    }
    if ('failFromContact' in body) {
      state.failFromContact = body.failFromContact ? String(body.failFromContact) : null;
    }
    if ('rateLimit' in body) {
      if (body.rateLimit && Number.isFinite(body.rateLimit.limit)) {
        state.rateLimit = {
          limit: Number(body.rateLimit.limit),
          windowMs: Number(body.rateLimit.windowMs) || 1000,
        };
      } else {
        state.rateLimit = null;
      }
      state.rateWindowStart = 0;
      state.rateWindowCount = 0;
    }
    if (typeof body.failDelta === 'boolean') {
      state.failDelta = body.failDelta;
    }
    if (Number.isFinite(body.contactCount)) {
      state.contacts = buildContacts(Math.max(0, Math.min(500, Number(body.contactCount))));
    }

    return json(res, 200, {
      failuresByOrder: { ...state.failuresByOrder },
      failEverything: state.failEverything,
      failuresByContact: { ...state.failuresByContact },
      failFromContact: state.failFromContact,
      rateLimit: state.rateLimit,
      failDelta: state.failDelta,
      contactCount: state.contacts.length,
    });
  }

  if (method === 'POST' && path === '/process') {
    const body = await readBody(req);
    const orderId = String(body.order_id ?? body.orderId ?? '');
    state.attempts += 1;
    state.attemptsByOrder[orderId] = (state.attemptsByOrder[orderId] || 0) + 1;

    // Forced, injected failures (retryable).
    if (state.failEverything) {
      return json(res, 503, { status: 'error', retryable: true, order_id: orderId });
    }
    const remaining = state.failuresByOrder[orderId] || 0;
    if (remaining > 0) {
      state.failuresByOrder[orderId] = remaining - 1;
      return json(res, 503, { status: 'error', retryable: true, order_id: orderId });
    }

    // Success. Count the commit at most once per distinct order.
    const duplicate = state.committedOrders.has(orderId);
    if (!duplicate) {
      state.committedOrders.add(orderId);
      state.commits += 1;
    }
    return json(res, 200, { status: 'ok', order_id: orderId, duplicate });
  }

  return json(res, 404, { status: 'not_found' });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`mock-api listening on ${PORT}`);
});
