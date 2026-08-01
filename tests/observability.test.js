// Observability: metrics, dashboard, retention, environment reference.
//
// The failure mode this file exists to prevent is a dashboard that is
// PROVISIONED but EMPTY. Grafana answers 200 for a dashboard whose panels query
// metric names that do not exist, so "the dashboard is provisioned" and "the
// dashboard shows anything" are completely different claims — and only the first
// one is easy to assert. The queue metrics on this n8n version are
// `n8n_scaling_mode_queue_jobs_*`, while various third-party write-ups publish
// `n8n_queue_*`; a dashboard built on the published names would provision
// cleanly and render nothing.
//
// So every panel expression is executed against Prometheus here, and the gate is
// that panels return series — not that the dashboard exists.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isServiceRunning, httpNoPool, sleep, waitTargetsUp, mockApi } from './helpers/stack.mjs';
import { setupOrderIntake, sendOrder } from './helpers/order-intake.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

const N8N_METRICS = 'http://127.0.0.1:5678/metrics';
const PROM = 'http://127.0.0.1:9090';
const GRAFANA = 'http://127.0.0.1:3030';
const DASHBOARD_FILE = 'deployment/grafana/dashboards/n8n-ops-overview.json';
const DASHBOARD_UID = 'n8n-ops-overview';

async function getJson(url) {
  const res = await httpNoPool(url);
  return { status: res.status, json: res.status === 200 ? JSON.parse(res.text) : null, text: res.text };
}

async function promQuery(expr) {
  const res = await getJson(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`);
  if (res.status !== 200 || !res.json || res.json.status !== 'success') return null;
  return res.json.data.result;
}

before(async () => {
  for (const svc of ['n8n', 'n8n-worker', 'prometheus', 'grafana']) {
    assert.ok(isServiceRunning(svc), `the ${svc} service must be up (npm run stack:up) — this gate cannot be skipped`);
  }
});

// --- (a) the metrics endpoint is live and emits n8n metrics ----------------

test('the n8n main /metrics endpoint returns Prometheus text with n8n_ metrics', async () => {
  const res = await httpNoPool(N8N_METRICS);
  assert.equal(res.status, 200, `expected 200 from /metrics, got ${res.status}`);

  const names = [...res.text.matchAll(/^# TYPE (n8n_\w+)/gm)].map((m) => m[1]);
  assert.ok(
    names.length > 0,
    `the scrape emitted no n8n_-prefixed metrics at all — metrics are not enabled:\n${res.text.slice(0, 400)}`,
  );

  // The specific families the dashboard depends on. Naming them individually
  // means a rename in a future n8n version fails HERE, pointing at the cause,
  // rather than as an empty panel nobody notices.
  for (const required of [
    'n8n_workflow_execution_duration_seconds',
    'n8n_scaling_mode_queue_jobs_waiting',
    'n8n_nodejs_eventloop_lag_p99_seconds',
    'n8n_process_resident_memory_bytes',
    'n8n_active_workflow_count',
  ]) {
    assert.ok(
      names.includes(required),
      `the live scrape does not emit ${required}; names present:\n  ${names.slice(0, 40).join('\n  ')}`,
    );
  }
});

// --- (b) the dashboard is provisioned AND populated ------------------------

test('the Grafana dashboard is provisioned', async () => {
  const res = await getJson(`${GRAFANA}/api/dashboards/uid/${DASHBOARD_UID}`);
  assert.equal(res.status, 200, `Grafana returned ${res.status} for the provisioned dashboard`);
  assert.equal(res.json.dashboard.uid, DASHBOARD_UID);
  assert.ok(res.json.dashboard.panels.length > 0, 'the provisioned dashboard has no panels');
});

test('the Prometheus datasource is provisioned and its n8n targets are up', async () => {
  // A preceding test in this suite may have restarted n8n, and Prometheus keeps
  // a target marked `down` until its next successful scrape — up to a full
  // scrape interval after n8n is answering /healthz again. Without this wait the
  // assertion below races that interval and fails for a reason that has nothing
  // to do with whether the datasource is provisioned. This THROWS on timeout, so
  // a genuinely dead target still fails loudly rather than being waited away.
  await waitTargetsUp(['n8n-main', 'n8n-worker']);

  const targets = await getJson(`${PROM}/api/v1/targets?state=active`);
  assert.equal(targets.status, 200);
  const byJob = Object.fromEntries(
    targets.json.data.activeTargets.map((t) => [t.labels.job, t.health]),
  );
  // Both processes, deliberately: main owns the queue metrics, the worker is
  // where execution pressure actually shows up.
  for (const job of ['n8n-main', 'n8n-worker']) {
    assert.equal(byJob[job], 'up', `Prometheus target ${job} is "${byJob[job]}", not up`);
  }
});

// --- diagnosing an empty bare-name panel -----------------------------------
//
// An empty bare-name panel is always a defect worth failing on, but WHICH defect
// is not established by the emptiness. The message used to assert a single cause
// — "the name is wrong" — and that claim has measured counterexamples on this
// very stack: several families are declared in the live `# TYPE` inventory and
// return no series at all, because nothing has exercised them yet. Telling a
// reader to rename `n8n_token_exchange_failures_total` would send them to fix a
// name that was never wrong.
//
// So the cause is derived from evidence, and where the evidence cannot separate
// two causes, both are named and neither is asserted.
function diagnoseEmptyBareName(name, evidence) {
  if (evidence.declared.has(name)) {
    return {
      verdict: 'no-data-yet',
      detail:
        `${name} IS declared in the live # TYPE inventory, so the name is correct — ` +
        'the family is present but has no series yet, because nothing on this stack has ' +
        'exercised it. This is a no-data-yet condition, not a naming fault.',
    };
  }

  if (evidence.knownToPrometheus.has(name)) {
    return {
      verdict: 'no-longer-exposed',
      detail:
        `${name} is known to Prometheus but is absent from the current n8n # TYPE inventory — ` +
        'the family stopped being exposed (a version or configuration change), so this is a ' +
        'scrape-state fault rather than a dashboard typo.',
    };
  }

  // Neither declared by n8n nor known to Prometheus. Two causes remain and this
  // test cannot separate them, so it reports both plus the evidence needed to
  // tell them apart, rather than picking the one that sounds likeliest.
  const flags = Object.entries(evidence.includeFlags)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ') || '(none set in the compose file)';
  return {
    verdict: 'not-exposed',
    detail:
      `${name} is absent from BOTH the live # TYPE inventory and Prometheus metadata, so this ` +
      'stack does not expose it at all. Two causes are consistent with that and this check ' +
      'cannot separate them: the metric name is wrong, or the family is gated off by an ' +
      'N8N_METRICS_INCLUDE_* setting (several default to false). The gating flags in force ' +
      `here are: ${flags} — a family gated by a flag absent from that list is off by default.`,
  };
}

// The three independent signals the diagnosis is allowed to reason from. Each is
// measured at test time; none is a hardcoded list that could go stale.
async function gatherMetricEvidence() {
  // (1) What this n8n actually DECLARES. `# TYPE` lines, not series — a family
  // is declared whether or not anything has populated it yet, and that is
  // precisely the distinction the old message collapsed.
  const scrape = await httpNoPool(N8N_METRICS);
  const declared = new Set(
    scrape.status === 200 ? [...scrape.text.matchAll(/^# TYPE (n8n_\w+)/gm)].map((m) => m[1]) : [],
  );

  // (2) What Prometheus knows about, across every scraped job — so a family
  // exposed only by the worker is not mistaken for a wrong name.
  let knownToPrometheus = new Set();
  const meta = await getJson(`${PROM}/api/v1/metadata`);
  if (meta.status === 200 && meta.json && meta.json.data) {
    knownToPrometheus = new Set(Object.keys(meta.json.data).filter((n) => n.startsWith('n8n_')));
  }

  // (3) Which metric families are gated OFF on this stack. n8n hides whole
  // families behind N8N_METRICS_INCLUDE_* flags that default to false, so
  // "absent from the scrape" and "wrongly named" are genuinely different causes
  // and the difference is visible in the compose file.
  const compose = read('deployment/docker-compose.yml');
  const includeFlags = Object.fromEntries(
    [...compose.matchAll(/^\s*-\s*(N8N_METRICS_INCLUDE_\w+)=(\S+)/gm)].map((m) => [m[1], m[2]]),
  );

  return { declared, knownToPrometheus, includeFlags };
}

test('the dashboard is POPULATED — panel queries return real series', async () => {
  const dashboard = JSON.parse(read(DASHBOARD_FILE));
  const targets = dashboard.panels.flatMap((p) =>
    (p.targets || []).map((t) => ({ panel: p.id, title: p.title, refId: t.refId, expr: t.expr })),
  );
  assert.ok(targets.length > 0, 'the dashboard defines no queries');

  const results = [];
  for (const t of targets) {
    const series = await promQuery(t.expr);
    results.push({ ...t, count: series === null ? -1 : series.length });
  }

  const errored = results.filter((r) => r.count < 0);
  assert.deepEqual(
    errored.map((r) => `panel ${r.panel} ${r.refId}: ${r.expr}`), [],
    'these panel expressions are not valid PromQL against this Prometheus',
  );

  const populated = results.filter((r) => r.count > 0);
  assert.ok(
    populated.length > 0,
    'NO panel query returned a series — the dashboard is provisioned and empty, which is exactly ' +
      'the failure this gate exists to catch:\n  ' +
      results.map((r) => `panel ${r.panel} ${r.refId} -> ${r.count} series: ${r.expr}`).join('\n  '),
  );

  // Every metric-name-only panel must resolve. A panel whose expression is a
  // bare metric name and which returns nothing is a defect — unlike a rate() or
  // a filtered query, which can legitimately be empty on an idle stack. WHICH
  // defect it is, is not something the emptiness alone establishes, so the
  // cause is diagnosed against evidence rather than asserted.
  const bareNamePanels = results.filter((r) => /^n8n_\w+$/.test(r.expr.trim()));
  const emptyBare = bareNamePanels.filter((r) => r.count === 0);
  const evidence = emptyBare.length ? await gatherMetricEvidence() : null;
  assert.deepEqual(
    emptyBare.map(
      (r) => `panel ${r.panel} ${r.refId}: ${r.expr} — ${diagnoseEmptyBareName(r.expr.trim(), evidence).detail}`,
    ), [],
    'these panels query a bare metric name that returns nothing',
  );
});

test('an empty bare-name panel is diagnosed from evidence, not misattributed to a wrong name', async () => {
  // The gate above used to answer "why is this panel empty?" with a single fixed
  // claim: the name is wrong. That reasoning assumes a bare name returning
  // nothing CAN only mean a wrong name. It cannot — a family may be correctly
  // named and simply have no series yet, which is measurable on this stack.
  const evidence = await gatherMetricEvidence();

  // A family that is DECLARED in the live # TYPE inventory but emits no series.
  // Chosen from the set measured on an otherwise-idle stack; the test verifies
  // both properties live rather than trusting the list, so it cannot rot into a
  // tautology if n8n starts populating one of them.
  const candidates = [
    'n8n_token_exchange_failures_total',
    'n8n_embed_login_failures_total',
    'n8n_instance_ai_runs_total',
    'n8n_nodejs_active_requests',
  ];
  const declaredButEmpty = [];
  for (const name of candidates) {
    if (!evidence.declared.has(name)) continue;
    const series = await promQuery(name);
    if (series && series.length === 0) declaredButEmpty.push(name);
  }
  assert.ok(
    declaredButEmpty.length > 0,
    'no declared-but-unpopulated family was found, so this control cannot prove anything; ' +
      `candidates checked: ${candidates.join(', ')}`,
  );

  // The load-bearing assertion: a correctly-named family must NOT be reported as
  // a wrong name. This is the misattribution, and it is a false statement that
  // sends whoever reads it to rename a metric that was never misnamed.
  for (const name of declaredButEmpty) {
    const d = diagnoseEmptyBareName(name, evidence);
    assert.notEqual(
      d.verdict, 'wrong-name',
      `${name} is declared in the live # TYPE inventory, so its name is correct, ` +
        `but the diagnosis reported "${d.detail}"`,
    );
    assert.match(
      d.detail, /declared/i,
      `the diagnosis for ${name} should cite that the family is declared; got "${d.detail}"`,
    );
  }

  // And the discrimination must work in the other direction, or the fix would
  // just be a blanket refusal to ever say "wrong name" — which would be the
  // same defect inverted.
  const bogus = 'n8n_queue_jobs_waiting'; // the third-party name this stack does not use
  assert.ok(!evidence.declared.has(bogus), 'precondition: the bogus name must not be declared');
  const bogusDiagnosis = diagnoseEmptyBareName(bogus, evidence);
  assert.equal(
    bogusDiagnosis.verdict, 'not-exposed',
    `a name absent from the live inventory should be reported as not exposed; got "${bogusDiagnosis.detail}"`,
  );
});

// --- resolving panel metric names against the live inventory ---------------
//
// Resolution and population are different questions. A family can be correctly
// named and carry no series (see the diagnosis above), so this resolves against
// what n8n DECLARES — the `# TYPE` inventory — cross-checked against Prometheus
// metadata. Deliberately NOT against /api/v1/label/__name__/values or any other
// series-derived endpoint: those list only families that currently have series,
// so a declared-but-unpopulated family would fail a gate it should pass.
function extractMetricNames(expr) {
  return [...new Set([...expr.matchAll(/\bn8n_[a-zA-Z0-9_]+/g)].map((m) => m[0]))];
}

// Try the referenced name AS-IS first; only if that fails, strip ONE histogram or
// summary suffix and try the base family.
//
// The order is load-bearing and is not a stylistic choice. `n8n_active_workflow_count`
// is itself a declared family (`# TYPE n8n_active_workflow_count gauge`) while
// `n8n_active_workflow` does not exist, so stripping unconditionally rewrites a
// correct panel into a name that resolves nowhere and false-fails it.
function resolveFamily(name, evidence) {
  const known = (n) => evidence.declared.has(n) || evidence.knownToPrometheus.has(n);
  if (known(name)) return { resolved: true, via: 'as-is', family: name };

  const base = name.replace(/_(count|sum|bucket)$/, '');
  if (base !== name && known(base)) return { resolved: true, via: 'suffix-stripped', family: base };

  return {
    resolved: false,
    via: null,
    family: null,
    detail:
      `${name} resolves neither as-is nor as the base family ${base} against the live # TYPE ` +
      'inventory or Prometheus metadata',
  };
}

// Panel 3's expression, read from the dashboard rather than restated here, so
// the gate cannot silently drift away from what the panel actually queries.
function panel3Expr() {
  const dashboard = JSON.parse(read(DASHBOARD_FILE));
  const panel = dashboard.panels.find((p) => p.id === 3);
  return panel.targets[0].expr;
}

function panel3Numerator() {
  const expr = panel3Expr();
  const cut = expr.indexOf(' / clamp_min(');
  assert.ok(cut > 0, `panel 3 no longer has the expected "numerator / clamp_min(...)" shape: ${expr}`);
  return expr.slice(0, cut);
}

const scalarOf = (series) => (series && series.length ? Number(series[0].value[1]) : 0);

test('every panel expression resolves to a declared metric family — not only the bare-name panels', async () => {
  // The population gate above inspects bare-name panels only.
  // `rate(n8n_nonexistent_total[5m])` is valid PromQL, returns zero series, and
  // would sail through it. This gate reads EVERY expression.
  await waitTargetsUp(['n8n-main', 'n8n-worker']);
  const evidence = await gatherMetricEvidence();
  assert.ok(evidence.declared.size > 0, 'the live # TYPE inventory came back empty; the gate would prove nothing');

  const dashboard = JSON.parse(read(DASHBOARD_FILE));
  const targets = dashboard.panels.flatMap((p) =>
    (p.targets || []).map((t) => ({ panel: p.id, refId: t.refId, expr: t.expr })),
  );

  const unresolved = [];
  let checked = 0;
  for (const t of targets) {
    for (const name of extractMetricNames(t.expr)) {
      checked += 1;
      const r = resolveFamily(name, evidence);
      if (!r.resolved) unresolved.push(`panel ${t.panel} ${t.refId}: ${r.detail}`);
    }
  }
  assert.ok(checked >= targets.length, 'no metric names were extracted; the extractor is broken');
  assert.deepEqual(
    unresolved, [],
    'these panel expressions reference metric families this n8n does not declare',
  );
});

test('n8n_active_workflow_count resolves AS-IS — regression control for unconditional suffix stripping', async () => {
  // A real family whose own name ends in `_count`. Stripping unconditionally
  // rewrites it to `n8n_active_workflow`, which does not exist, and false-fails
  // a correct panel. Without this control that defect can return silently.
  const evidence = await gatherMetricEvidence();
  assert.ok(
    !evidence.declared.has('n8n_active_workflow'),
    'precondition: the suffix-stripped name must NOT exist, or this control proves nothing',
  );
  const r = resolveFamily('n8n_active_workflow_count', evidence);
  assert.equal(r.resolved, true, 'n8n_active_workflow_count must resolve');
  assert.equal(
    r.via, 'as-is',
    'it must resolve as-is; resolving it any other way means the name was stripped first',
  );
});

test('the panel-metric resolution gate can actually fail — positive control', async () => {
  const evidence = await gatherMetricEvidence();

  // A non-existent name inside a rate(), which is exactly the shape the
  // population gate cannot catch.
  const bogusExpr = 'sum(rate(n8n_nonexistent_total[5m]))';
  assert.deepEqual(extractMetricNames(bogusExpr), ['n8n_nonexistent_total'], 'the extractor missed the name');
  const bogus = await promQuery(bogusExpr);
  assert.ok(bogus !== null && bogus.length === 0, 'the bogus expression must be valid PromQL returning nothing');
  assert.equal(
    resolveFamily('n8n_nonexistent_total', evidence).resolved, false,
    'a non-existent metric name passed the resolution gate, so the gate proves nothing',
  );

  // And a real one must resolve, or the control is measuring a broken gate
  // rather than a wrong name.
  assert.equal(
    resolveFamily('n8n_workflow_execution_duration_seconds_count', evidence).resolved, true,
    'a real metric name failed to resolve; the gate is broken, not the dashboard',
  );
});

test('the /metrics inventory and Prometheus metadata agree — disagreement is a finding', async () => {
  await waitTargetsUp(['n8n-main', 'n8n-worker']);
  const evidence = await gatherMetricEvidence();
  const inScrapeOnly = [...evidence.declared].filter((n) => !evidence.knownToPrometheus.has(n)).sort();
  const inPromOnly = [...evidence.knownToPrometheus].filter((n) => !evidence.declared.has(n)).sort();
  assert.deepEqual(
    { inScrapeOnly, inPromOnly }, { inScrapeOnly: [], inPromOnly: [] },
    'the live scrape and Prometheus metadata disagree about which families exist — report this as a finding',
  );
});

// --- panel 3 must be structurally capable of reporting a fault -------------

test('every status value on the execution histogram is a TERMINAL status — domain-drift guard', async () => {
  // Written as a hypothesis this gate TESTS, not as settled fact. The probe that
  // informed the panel observed only `success` and `failed` across two
  // executions, which cannot establish the label's domain. If an unexpected
  // value appears, that is a finding to report — never a reason to narrow the
  // matcher back to an enumerated list.
  //
  // THIS GATE SEEDS ITS OWN PRECONDITION, and the reason is measured rather than
  // assumed. It previously read the histogram straight out of Prometheus and
  // depended on some earlier test having populated it. That is a check that
  // depends on state it does not establish, and it failed on a cold stack while
  // passing on a warm one — a non-deterministic gate, which is the one thing
  // this suite may not be.
  //
  // TWO distinct mechanisms produce the identical empty-histogram symptom, and
  // both were measured live on this stack. They need different remedies, so both
  // are applied:
  //
  //   1. NO EXECUTIONS HAVE OCCURRED. The family is declared in the `# TYPE`
  //      inventory from start-up, but prom-client creates a label combination
  //      only on first observation, so there are no series to expose at all.
  //      Measured on a freshly restarted stack: `/metrics` carried the `# TYPE`
  //      line and zero `_count` series, and Prometheus returned zero series.
  //      Remedy: drive an execution.
  //
  //   2. EXECUTIONS HAVE OCCURRED BUT PROMETHEUS HAS NOT YET SCRAPED THEM.
  //      `/metrics` already carries the series while the query still returns
  //      nothing. Measured by reading `/metrics` at the same moments the query
  //      was issued: the series appeared on `/metrics` 0.6 s after the execution
  //      and Prometheus did not report it for a further 9.5 s — consistent with
  //      the 15 s scrape interval. Remedy: poll for the scrape, never sleep a
  //      fixed guess, exactly as the fault-reporting gate below already does.
  //
  // A restart resets this: the histogram lives in the n8n processes, so main's
  // series vanish when main restarts — and `registerWebhook` restarts main. That
  // is why inheriting the precondition was never safe, warm runs notwithstanding.
  assert.ok(await setupOrderIntake(), 'the order-intake workflow must be available to seed the histogram');
  await waitTargetsUp(['n8n-main', 'n8n-worker']);

  // The CHEAPEST seeding that works. A successful execution costs one webhook
  // round trip; the failure-injection path costs a mock reconfiguration and a
  // global-error-handler run. This gate enumerates whatever status values are
  // present and requires no particular one, so the cheap path is sufficient.
  const seeded = await sendOrder({
    order_id: `t5e4-${Date.now()}`,
    customer_email: 'domain-drift@example.test',
    amount: 1.25,
    currency: 'USD',
    items: [{ sku: 'DD-1', qty: 1, price: 1.25 }],
  });
  assert.equal(seeded.status, 200, `the seeding execution did not complete: HTTP ${seeded.status} — ${seeded.text}`);

  // Mechanism 2: wait for the scrape to land rather than guessing at it. Bounded
  // and derived — `scrape_interval: 15s` plus `scrape_timeout: 10s` puts the
  // worst case at ~25 s, and the bound below is that with room for the execution
  // itself, sized the same way the fault-reporting gate's is.
  let series = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    series = await promQuery('n8n_workflow_execution_duration_seconds_count');
    if (series && series.length > 0) break;
    await sleep(2000);
  }

  // STILL EMPTY AFTER SEEDING IS A REAL FAILURE, and it is reported as one. Not a
  // skip, not a pass-on-empty, not a conditional: a guard that quietly passes
  // when it cannot see anything is vacuous, and a vacuous gate is worse than no
  // gate because it reads as evidence.
  assert.ok(
    series && series.length > 0,
    'the execution histogram returned nothing; the guard cannot run — and this gate drove its own ' +
      'execution first, so this is not a missing-precondition artefact: a completed execution did not ' +
      'reach Prometheus within 120 s.',
  );
  const observed = [...new Set(series.map((s) => s.metric.status))].sort();

  // Terminal = the execution has finished and will not change again. A duration
  // histogram observes on completion, so only these should ever appear.
  const TERMINAL = new Set(['success', 'failed', 'error', 'crashed', 'canceled', 'cancelled']);
  const unexpected = observed.filter((s) => !TERMINAL.has(s));
  assert.deepEqual(
    unexpected, [],
    `an unrecognised status value appeared on the execution histogram; observed set: ${JSON.stringify(observed)}. ` +
      'If any of these is a non-terminal status (running, waiting, new) the negative matcher in panel 3 ' +
      'would count in-flight executions as errors. Report this as a finding.',
  );
});

// A genuine failure through the real signed webhook path, injected upstream —
// the same mechanism the failure-injection suite uses. Not a synthetic metric.
// The mock is always put back, including if the send threw.
async function driveFailedExecution(tag) {
  await mockApi('POST', '/config', { failEverything: true });
  let status = null;
  try {
    const res = await sendOrder({
      order_id: `${tag}-${Date.now()}`,
      customer_email: 'obs@example.test',
      amount: 4.25,
      currency: 'USD',
      items: [{ sku: 'OBS-1', qty: 1, price: 4.25 }],
    });
    status = res.status;
  } finally {
    await mockApi('POST', '/config', { failEverything: false });
    await mockApi('POST', '/reset', {});
  }
  assert.equal(status, 502, 'the injected failure did not produce a failed execution');
}

test('panel 3 can REPORT A FAULT — a real failed execution drives the numerator above zero', async () => {
  // The defect this replaces: a matcher that selects a value n8n never emits
  // makes the numerator permanently zero, and clamp_min then renders a
  // confident, healthy-looking flat 0% error rate that cannot ever move.
  assert.ok(await setupOrderIntake(), 'the order-intake workflow must be available to drive a real failure');
  await waitTargetsUp(['n8n-main', 'n8n-worker']);

  const numerator = panel3Numerator();

  // WHY THERE ARE TWO FAILURES AND NOT ONE. This gate used to drive a single
  // failure and require the numerator to rise. It seeded an execution, so it
  // looked self-sufficient — but it silently inherited something else: a
  // non-success series that ALREADY EXISTED. `rate()` reports change, and a
  // counter that is BORN inside the range window has none to report.
  //
  // Measured on a freshly restarted stack, one failed execution and nine
  // consecutive scrapes:
  //
  //   n8n_workflow_execution_duration_seconds_count{status="failed",...}
  //     1, 1, 1, 1, 1, 1, 1, 1, 1        <- born at 1, flat forever after
  //   sum(rate(...{status!="success"}[5m])) = 0
  //
  // The assertion then failed with `0 -> 0` after polling the full 120 s. On a
  // warm stack the series already existed, the single failure incremented it,
  // and the gate passed — the same cold/warm split, and the same defect class,
  // as the domain-drift guard above.
  //
  // So the first failure ESTABLISHES the series and the second MEASURES against
  // it. The claim the gate makes is unchanged: a genuine failed execution moves
  // panel 3's numerator. It now establishes the state that claim is measured in.
  await driveFailedExecution('t5e-seed');

  // The panel's own matcher, unnarrowed. This waits for the series to EXIST —
  // a different question from whether the rate has moved, and the one that has
  // to be answered before `before` can be measured meaningfully.
  let born = null;
  const bornBy = Date.now() + 120000;
  while (Date.now() < bornBy) {
    born = await promQuery('n8n_workflow_execution_duration_seconds_count{status!="success"}');
    if (born && born.length > 0) break;
    await sleep(2000);
  }
  assert.ok(
    born && born.length > 0,
    'the seeding failure never produced a non-success series in Prometheus, so the measurement below ' +
      'would be made against a counter that does not exist',
  );

  const before = scalarOf(await promQuery(numerator));

  await driveFailedExecution('t5e');

  // rate() needs the counter to INCREASE across at least two samples inside the
  // window, so wait for scrapes rather than guessing a sleep.
  let after = before;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(5000);
    after = scalarOf(await promQuery(numerator));
    if (after > 0 && after > before) break;
  }

  assert.ok(
    after > before,
    `panel 3's numerator did not respond to a genuine failed execution: ${before} -> ${after}. ` +
      `numerator: ${numerator}`,
  );
  assert.ok(after > 0, `panel 3's numerator is ${after} after a real failure; the panel cannot report a fault`);
});

test('the defective matcher is driven to zero at the same instant — negative control', async () => {
  // The value measured as emitted ZERO times becomes its own control, which is
  // why this control is guaranteed correct rather than assumed correct. If the
  // bound matcher and the defective one both returned something, the gate above
  // would prove nothing.
  //
  // THIS TEST INHERITS ITS PRECONDITION, DELIBERATELY, and the reason is worth
  // stating because two of its neighbours were repaired for doing exactly that.
  // "At the same instant" is the whole content of the control: both matchers
  // must be evaluated against ONE state of the counter, the state the gate above
  // just produced. Seeding again here would move the measurement to a different
  // instant and dissolve what is being controlled for.
  //
  // What makes the inheritance safe is that the state is established by the
  // immediately preceding test IN THIS FILE, which now establishes it itself —
  // not by ambient stack state or by another file. node:test runs top-level
  // tests one at a time by default — `concurrency` defaults to `false` — so
  // the ordering holds by construction. It is not `--test-concurrency` that
  // provides this: with process-level isolation enabled, that flag caps how
  // many test FILES run as concurrent child processes, and within-file
  // ordering holds regardless of its value. The guarantee is therefore
  // stronger than the flag suggests, and cannot be removed by changing it.
  // What would invalidate the inheritance is `--test-randomize`, which
  // randomizes execution order for test files and queued tests alike.
  //
  // The residual, stated rather than presumed away: this test cannot be run in
  // isolation. Selected alone it fails on `boundValue > 0`. That failure is
  // loud and names its own cause in the assertion message below, which is the
  // safe direction — it cannot pass for the wrong reason.
  const bound = panel3Numerator();
  const defective = bound.replace('status!="success"', 'status="error"');
  assert.notEqual(defective, bound, 'the negative control did not actually substitute the matcher');

  const boundValue = scalarOf(await promQuery(bound));
  const defectiveValue = scalarOf(await promQuery(defective));

  assert.equal(
    defectiveValue, 0,
    `the defective matcher returned ${defectiveValue}; it was measured as emitted zero times, ` +
      'so this control is no longer valid',
  );
  assert.ok(
    boundValue > 0,
    `the bound matcher returned ${boundValue} at the same instant the defective one returned 0; ` +
      'the fault-reporting gate above must run first and leave a failure inside the window',
  );
});

test('the panel-population check can actually fail — positive control', async () => {
  // §2.6. The assertion above reports a presence, and a presence check built on
  // a broken query path would pass for the wrong reason. A deliberately wrong
  // metric name — the shape a documentation-derived dashboard would have used —
  // must come back empty.
  const wrong = await promQuery('n8n_queue_jobs_waiting');
  assert.notEqual(wrong, null, 'the control query did not execute; the check itself is broken');
  assert.equal(
    wrong.length, 0,
    'the deliberately-wrong metric name returned data, so the population check proves nothing',
  );

  // And the corresponding right name must return data, or the control is
  // measuring an unreachable Prometheus rather than a wrong name.
  const right = await promQuery('n8n_scaling_mode_queue_jobs_waiting');
  assert.ok(
    right && right.length > 0,
    'the correct queue metric name returned nothing — Prometheus is not scraping n8n',
  );
});

// --- (c) retention is tuned, and documented consistently -------------------

const RETENTION = {
  EXECUTIONS_DATA_PRUNE: 'true',
  EXECUTIONS_DATA_MAX_AGE: '168',
  EXECUTIONS_DATA_PRUNE_MAX_COUNT: '10000',
  EXECUTIONS_DATA_HARD_DELETE_BUFFER: '1',
};

test('.env carries the retention settings', () => {
  const env = read('.env');
  for (const key of ['EXECUTIONS_DATA_PRUNE', 'EXECUTIONS_DATA_MAX_AGE', 'EXECUTIONS_DATA_PRUNE_MAX_COUNT']) {
    assert.match(env, new RegExp(`^${key}=`, 'm'), `.env must set ${key}`);
  }
});

test('the compose file and .env agree on every retention value', () => {
  // Drift between "what runs" and "what is documented" is invisible until
  // someone relies on the documented number.
  const compose = read('deployment/docker-compose.yml');
  const env = read('.env');
  const mismatched = [];
  for (const [key, expected] of Object.entries(RETENTION)) {
    const inCompose = compose.match(new RegExp(`^\\s*-\\s*${key}=(.*)$`, 'm'));
    const inEnv = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (!inCompose) mismatched.push(`${key}: not set in docker-compose.yml`);
    else if (inCompose[1].trim() !== expected) mismatched.push(`${key}: compose has ${inCompose[1].trim()}, expected ${expected}`);
    if (inEnv && inEnv[1].trim() !== expected) mismatched.push(`${key}: .env has ${inEnv[1].trim()}, expected ${expected}`);
  }
  assert.deepEqual(mismatched, [], `retention configuration drift:\n  ${mismatched.join('\n  ')}`);
});

test('the SQLite-only vacuum variable is NOT present', () => {
  // This stack is Postgres in queue mode. Setting a SQLite-only variable would
  // be a visible correctness error to a reviewing engineer.
  const compose = read('deployment/docker-compose.yml');
  assert.ok(
    !/DB_SQLITE_VACUUM_ON_STARTUP\s*=/.test(compose),
    'DB_SQLITE_VACUUM_ON_STARTUP is SQLite-only and must not appear in a Postgres queue-mode stack',
  );
});

// --- (d) .env.example is a superset of what deployment/ references ---------

test('.env.example is a superset of every variable deployment/ references', () => {
  const example = read('.env.example');
  const declared = new Set([...example.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]));

  // Comments are stripped first. This file explains its own `$VAR` versus
  // `$$VAR` convention in prose, and scanning that prose makes the check report
  // a variable named "VAR" that nothing actually references — a scanner reading
  // its own documentation as data.
  const compose = read('deployment/docker-compose.yml')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  // A "reference" is a value the compose model expects to receive, i.e. an
  // interpolation. A literal assignment in the compose file is configuration,
  // not a reference, and does not need an entry.
  const referenced = new Set(
    [...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}|(?<!\$)\$([A-Z_][A-Z0-9_]*)/g)]
      .map((m) => m[1] || m[2])
      .filter(Boolean),
  );

  const missing = [...referenced].filter((v) => !declared.has(v)).sort();
  assert.deepEqual(
    missing, [],
    `deployment/ references these variables but .env.example does not declare them:\n  ${missing.join('\n  ')}`,
  );
});

test('.env.example documents the observability and retention variables it introduces', () => {
  const example = read('.env.example');
  for (const key of [
    'N8N_METRICS',
    'N8N_METRICS_INCLUDE_QUEUE_METRICS',
    ...Object.keys(RETENTION),
  ]) {
    assert.match(example, new RegExp(`^${key}=`, 'm'), `.env.example must document ${key}`);
  }
});

// --- the environment reference ---------------------------------------------

test('the environment reference covers every group with a reason, not just a value', () => {
  const doc = read('deployment/docs/environment-reference.md');
  for (const [label, re] of [
    ['core', /## Core/],
    ['queue mode', /## Queue mode/],
    ['security', /## Security/],
    ['observability', /## Observability/],
    ['retention', /## Execution data retention/],
  ]) {
    assert.match(doc, re, `the environment reference must have a ${label} section`);
  }
  assert.match(doc, /do(es)? \*\*not\*\* fire on restart|no catch-up/i,
    'the no-catch-up caveat must be stated');
  assert.match(doc, /concurrency/i, 'the queue-mode concurrency recommendation must be stated');
  assert.match(doc, /timezone/i, 'the timezone-explicit requirement must be stated');
  assert.match(doc, /DB_SQLITE_VACUUM_ON_STARTUP/,
    'the reference must say why the SQLite vacuum variable is deliberately absent');
});

test('every N8N_-prefixed variable set in the compose file appears in the reference', () => {
  const compose = read('deployment/docker-compose.yml');
  const doc = read('deployment/docs/environment-reference.md');
  const set = new Set(
    [...compose.matchAll(/^\s*-\s*(N8N_[A-Z0-9_]+|EXECUTIONS_[A-Z0-9_]+|QUEUE_[A-Z0-9_]+|DB_[A-Z0-9_]+|WEBHOOK_URL|GENERIC_TIMEZONE)=/gm)]
      .map((m) => m[1]),
  );
  const undocumented = [...set].filter((v) => !doc.includes(v)).sort();
  assert.deepEqual(
    undocumented, [],
    `set in docker-compose.yml but absent from the environment reference:\n  ${undocumented.join('\n  ')}`,
  );
});

void sleep;
