// Post-restart readiness: one restart, several signals, each returning at its
// own time.
//
// The failure mode this file exists to prevent is a readiness wait that
// certifies one signal and is then used as a proxy for another. That defect has
// now appeared twice in this harness: once as a claim that a byte-unchanged node
// meant an unchanged authentication path, and once as `waitHealthy()` being used
// to mean "the metrics endpoint is up". Measured here, 4 of 4 forced trials:
// `/healthz` answers 200 while `/metrics` is still 404, for 3.5–7.8 s.
//
// So the gate is that every readiness condition is judged against ITS OWN
// signal, asserted structurally, so the prohibition survives a later edit rather
// than depending on a reviewer noticing.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  isServiceRunning, httpNoPool, restartService, waitHealthy,
  waitReady, waitTargetsUp, readinessConditions,
} from './helpers/stack.mjs';

const N8N_BASE = 'http://127.0.0.1:5678';
const HEALTH_ENDPOINTS = ['/healthz', '/healthz/readiness'];

const get = async (url) => {
  try {
    const res = await httpNoPool(url);
    return { status: res.status };
  } catch (e) {
    return { status: 0, err: e.code || e.message };
  }
};

before(async () => {
  for (const svc of ['n8n', 'n8n-worker', 'prometheus']) {
    assert.ok(isServiceRunning(svc), `the ${svc} service must be up (npm run stack:up) — this gate cannot be skipped`);
  }
});

// --- the proxy prohibition, asserted structurally --------------------------

test('every readiness condition is judged on its own signal, and never on a health endpoint', () => {
  const all = [
    readinessConditions.metricsMounted(),
    readinessConditions.prometheusTargetsUp(['n8n-main', 'n8n-worker']),
  ];
  assert.ok(all.length > 0, 'no conditions to check; this gate would prove nothing');

  for (const c of all) {
    assert.ok(c.name, 'a condition must name itself');
    assert.ok(typeof c.signal === 'string' && c.signal.length > 0,
      `${c.name} must declare the signal it is judged against`);
    assert.equal(typeof c.observe, 'function', `${c.name} must be observable`);

    // The prohibition itself. A health endpoint may correlate with any number of
    // other readiness facts; correlation is expressly not sufficient.
    for (const health of HEALTH_ENDPOINTS) {
      assert.ok(
        !c.signal.endsWith(health),
        `${c.name} is judged on ${c.signal}, which is a health endpoint — a health probe ` +
          'is not an acceptable stand-in for any other readiness condition',
      );
    }
  }
});

test('the metrics condition is judged on the metrics endpoint specifically', () => {
  const c = readinessConditions.metricsMounted();
  assert.equal(
    c.signal, `${N8N_BASE}/metrics`,
    'the "metrics mounted" condition must be judged on /metrics itself; n8n\'s liveness probe ' +
      'does not validate database connectivity and its readiness probe certifies database and ' +
      'migration state — neither certifies that /metrics is mounted',
  );
});

// --- the primitive's contract ----------------------------------------------

test('waitReady refuses an empty condition set — a wait on nothing is not a wait', async () => {
  await assert.rejects(
    () => waitReady([]),
    /no conditions/,
    'waitReady([]) must throw; returning true would be a silent no-op that reports success',
  );
});

test('waitReady returns once every condition is satisfied', async () => {
  const ok = await waitReady(
    [readinessConditions.metricsMounted(), readinessConditions.prometheusTargetsUp(['n8n-main', 'n8n-worker'])],
    { timeoutMs: 60000 },
  );
  assert.equal(ok, true);
});

test('waitReady THROWS on timeout, bounded, naming the unmet condition and what it saw', async () => {
  // Cheap control: a condition that cannot be satisfied, and a short timeout.
  const unsatisfiable = {
    name: 'neverSatisfied',
    describes: 'a condition that cannot be met',
    signal: `${N8N_BASE}/a-path-that-does-not-exist`,
    async observe() {
      const r = await get(this.signal);
      return { ok: false, observed: `HTTP ${r.status}` };
    },
  };

  const t0 = Date.now();
  let threw = false;
  let message = null;
  try {
    await waitReady([unsatisfiable], { timeoutMs: 3000, pollMs: 500 });
  } catch (e) {
    threw = true;
    message = e.message;
  }
  const elapsed = Date.now() - t0;

  assert.equal(threw, true, 'waitReady must throw on timeout, not return false — a silent return makes a hard failure flaky');
  assert.ok(elapsed >= 3000 && elapsed < 20000, `the wait must be bounded by its timeout; took ${elapsed} ms`);
  assert.match(message, /neverSatisfied/, 'the failure must name the unmet condition');
  assert.match(message, /judged on/, 'the failure must name the signal the condition was judged against');
  assert.match(message, /HTTP \d+/, 'the failure must report what was actually observed');
});

test('waitTargetsUp still throws and still names the job and its observed state', async () => {
  // waitTargetsUp is now a CALLER of waitReady rather than a reimplementation.
  // Its contract must be unchanged: bounded, throwing, self-diagnosing.
  let message = null;
  try {
    await waitTargetsUp(['n8n-main', 'no-such-job-xyz'], { timeoutMs: 3000, pollMs: 500 });
    assert.fail('waitTargetsUp must throw when a named job never reports up');
  } catch (e) {
    message = e.message;
  }
  assert.match(message, /no-such-job-xyz/, 'the failure must name the job that is not up');
  assert.match(
    message, /absent from the active target list/,
    'an absent job must read differently from a down one — they need different fixes',
  );
});

// --- the race itself, and the proof the condition tracks its own signal ------

test('after a restart the metrics endpoint is waited for on ITS OWN signal, not on health', async () => {
  // Force the race rather than waiting for it: restart, let waitHealthy() return,
  // then sample every signal at the same instant with no settling time.
  restartService('n8n');
  const healthy = await waitHealthy();
  assert.equal(healthy, true, 'n8n did not come back after the restart');

  const metrics = await get(`${N8N_BASE}/metrics`);
  const liveness = await get(`${N8N_BASE}/healthz`);
  const readiness = await get(`${N8N_BASE}/healthz/readiness`);
  const verdict = await readinessConditions.metricsMounted().observe();

  // The load-bearing assertion, and it is unconditional: the condition's verdict
  // tracks /metrics EXACTLY. It is not merely "usually right" — it is judged on
  // that endpoint and on nothing else, whatever the health endpoints happen to
  // say at the same moment.
  assert.equal(
    verdict.ok, metrics.status === 200,
    `the metrics condition reported ok=${verdict.ok} while /metrics returned ${metrics.status}; ` +
      'the condition is not being judged on its own signal',
  );

  // Recorded as an observation, deliberately not relied upon: at this instant
  // liveness is typically 200 while /metrics is still 404, which is exactly why
  // it is not an acceptable stand-in. Readiness has been measured returning 503
  // here, so it happens to correlate — and a correlation is still not the signal.
  assert.ok(
    [200, 503, 0].includes(liveness.status) && [200, 503, 0].includes(readiness.status),
    `unexpected health endpoint statuses: /healthz=${liveness.status} /healthz/readiness=${readiness.status}`,
  );

  // And the primitive resolves the race it was built for.
  await waitReady([readinessConditions.metricsMounted()]);
  const after = await get(`${N8N_BASE}/metrics`);
  assert.equal(after.status, 200, 'waitReady returned but /metrics is still not serving');
});
