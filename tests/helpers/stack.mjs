// Shared helpers for the integration tests that drive the docker compose stack.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as nodeHttpRequest, Agent as HttpAgent } from 'node:http';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const composeFile = join(repoRoot, 'deployment', 'docker-compose.yml');
const envPath = join(repoRoot, '.env');

// Base compose args: explicit compose file + repo-root .env for substitution.
const BASE = ['compose', '-f', composeFile, '--env-file', envPath];

export function loadEnv() {
  const env = {};
  if (!existsSync(envPath)) return env;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

// Run a docker/compose command, returning { code, stdout, stderr }. Never
// throws on a non-zero exit — the caller asserts on the result.
export function docker(args, opts = {}) {
  try {
    const stdout = execFileSync('docker', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 120000,
      env: { ...process.env, ...(opts.env || {}) },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : String(e.message || e),
    };
  }
}

export function compose(args, opts = {}) {
  return docker([...BASE, ...args], opts);
}

// Is a service running (health not considered)?
export function isServiceRunning(service) {
  const r = compose(['ps', '--status', 'running', '--services']);
  return r.code === 0 && r.stdout.split('\n').map((s) => s.trim()).includes(service);
}

// valkey-cli from an ephemeral sibling container on the internal network.
export function valkeyCli(cliArgs, opts = {}) {
  return compose(
    ['run', '--rm', '--no-deps', '--entrypoint', 'valkey-cli', 'valkey', '-h', 'valkey', ...cliArgs],
    opts,
  );
}

// Run a SQL statement in the postgres container; returns trimmed stdout.
export function psql(sql, opts = {}) {
  const env = loadEnv();
  return compose(
    [
      'exec', '-T', 'postgres',
      'psql', '-U', env.POSTGRES_USER || 'n8n', '-d', env.POSTGRES_DB || 'n8n',
      '-tAc', sql,
    ],
    opts,
  );
}

// Hit the internal mock-api from inside its own container (busybox wget).
export function mockApi(method, path, body, opts = {}) {
  const args = ['exec', '-T', 'mock-api', 'wget', '-qO-'];
  if (method === 'POST') {
    args.push('--post-data', body ? JSON.stringify(body) : '{}', '--header', 'content-type: application/json');
  }
  args.push(`http://localhost:3000${path}`);
  return compose(args, opts);
}

// Hit the internal mock-llm the same way. `headers` carries the scenario header
// where a caller can set one; the workflow path instead rides the
// [[scenario:…]] marker, which the mock resolves identically.
export function mockLlm(method, path, body, headers = {}, opts = {}) {
  const args = ['exec', '-T', 'mock-llm', 'wget', '-qO-'];
  if (method === 'POST') {
    args.push('--post-data', body ? JSON.stringify(body) : '{}', '--header', 'content-type: application/json');
  }
  for (const [k, v] of Object.entries(headers)) args.push('--header', `${k}: ${v}`);
  args.push(`http://localhost:3001${path}`);
  return compose(args, opts);
}

// Parse a helper result whose stdout is JSON; returns null on a non-zero exit.
export function asJson(result) {
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Workflow lifecycle + HTTP helpers (used by the workflow integration tests) ---

const N8N_BASE = 'http://127.0.0.1:5678';
const PROM_BASE = 'http://127.0.0.1:9090';

// --- Transport resilience across the restart this harness performs itself ----
//
// `registerWebhook()` below restarts the n8n main process to make it pick up a
// newly imported workflow. That restart leaves THIS process's HTTP connection
// pool holding keep-alive sockets to a server that no longer exists. The next
// request assigned to one of them fails in 2–4 ms with
// `SocketError: other side closed [UND_ERR_SOCKET]` — no HTTP response, no
// status — and the caller's catch turns that into `status: 0`, which surfaces as
// an arbitrary test failing for a reason that has nothing to do with what it
// asserts. Measured: three of three cold cycles reproduce it, zero of nine warm
// runs do, and the failure lands on a different test each time.
//
// This is a documented property of HTTP keep-alive rather than an n8n defect:
// the request is handed to a socket that is already being destroyed and cannot
// know it. Waiting longer cannot fix it — the endpoint is ready, the socket is
// dead — so the remedy is connection handling, in two parts:
//
//   * drain the pool deterministically at the boundary where it is known to have
//     been poisoned (see `registerWebhook`), and
//   * retry, at most twice and ONLY on a transport failure, over a connection
//     that cannot have come from the pool.
//
// The safety boundary is the important part: a retry happens only when NO HTTP
// response was received. Any response at all — 200, 401, 403, 500 — is returned
// to the caller unchanged and unretried. An authentication rejection is a
// successful transport outcome and a meaningful result, so no auth or HMAC
// assertion can be masked or made flaky-passing by anything here.

const TRANSPORT_FAILURE_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

// Walk the error's cause chain and report the transport code, or null when the
// failure is anything else. `ECONNREFUSED` deliberately does NOT appear in the
// set above: a stack that is genuinely down must fail fast and loudly, not be
// retried into a slow, confusing failure.
function transportFailureCode(err) {
  for (let cur = err; cur; cur = cur.cause) {
    if (cur.code && TRANSPORT_FAILURE_CODES.has(cur.code)) return cur.code;
  }
  return null;
}

// stdlib `node:http` with keep-alive off: a fresh socket every call, which by
// construction cannot have come from the poisoned pool. Used for readiness
// probes and for every retry. No dependency is added to reach this — the
// zero-dependency posture is part of what this repository demonstrates.
export function httpNoPool(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = nodeHttpRequest(
      url,
      { method, headers, agent: new HttpAgent({ keepAlive: false }) },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

// The shared request path for everything this suite sends to n8n. Returns
// `{ status, text }`. Throws only when every attempt failed at the transport
// layer, and throws the ORIGINAL error so the caller sees the real cause rather
// than a synthesised one.
export async function httpRequest(url, { method = 'GET', headers = {}, body, retries = 2 } = {}) {
  let firstError = null;
  const log = [];

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // The first attempt goes through the ordinary pooled path, so the tests
      // exercise what a real caller does. Retries do not.
      if (attempt === 0) {
        const res = await fetch(url, { method, headers, body });
        return { status: res.status, text: await res.text() };
      }
      return await httpNoPool(url, { method, headers, body });
    } catch (err) {
      const code = transportFailureCode(err);
      // No response was received AND the cause is not one of the transport
      // codes: not ours to retry. Rethrow untouched.
      if (code === null) throw err;

      firstError ??= err;
      log.push(`attempt ${attempt + 1}: ${code}`);

      if (attempt === retries) {
        // Never silent, never swallowed — §2.6: a retry nobody can see is a
        // broken instrument that hides a real regression behind a green run.
        console.error(
          `[transport-retry] ${method} ${url} — exhausted after ${attempt + 1} attempt(s): ${log.join('; ')}`,
        );
        throw firstError;
      }
      console.error(
        `[transport-retry] ${method} ${url} — attempt ${attempt + 1} failed at the transport layer ` +
          `(${code}), no HTTP response; retrying over a non-pooled connection`,
      );
      await sleep(250 * (attempt + 1));
    }
  }
  /* unreachable */
  throw firstError;
}

export async function httpPost(path, body, headers = {}) {
  try {
    return await httpRequest(`${N8N_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    });
  } catch (e) {
    return { status: 0, text: String(e.message || e) };
  }
}

// Readiness is judged over a non-pooled connection on purpose. A readiness
// probe that draws a dead socket reports "not up yet" about a server that is
// perfectly up, and one that draws a live socket says nothing about whether the
// pool is clean.
export async function waitHealthy(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpNoPool(`${N8N_BASE}/healthz`);
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  return false;
}

// Wait until Prometheus reports every named scrape job as `up`.
//
// `waitHealthy()` above answers a different question, and the difference is the
// whole reason this exists. It asks n8n whether n8n is ready. This asks
// PROMETHEUS whether Prometheus has yet noticed. Those are separated by up to a
// full scrape interval: after a restart, Prometheus keeps the target marked
// `down` until its next SUCCESSFUL scrape, so a test that waits only for
// `/healthz` and then asserts on target health is asserting the second thing
// having waited for the first. Measured on this stack: the target lags the
// health endpoint by up to 10.9 s, and with `scrape_interval: 15s` plus
// `scrape_timeout: 10s` the worst case is ~25 s.
//
// The default timeout is deliberately sized on that derived bound rather than on
// the largest lag observed. A timeout fitted to a measurement is a flake waiting
// for a slower machine — which is the exact defect this primitive removes.
//
// It THROWS on timeout rather than returning false. A readiness wait that
// silently returns on timeout converts a hard, legible failure into a flaky one:
// the caller proceeds to assert against a target it was told nothing about, and
// the resulting failure points at the assertion instead of at the wait. Callers
// that want a boolean can catch; callers that forget cannot be silently wrong.
export async function waitTargetsUp(jobs, { timeoutMs = 60000, pollMs = 1000 } = {}) {
  const wanted = Array.isArray(jobs) ? jobs : [jobs];
  // A caller of the general primitive, not a reimplementation of it: the SHAPE
  // of this wait generalises, its target does not.
  return waitReady([readinessConditions.prometheusTargetsUp(wanted)], { timeoutMs, pollMs });
}

// --- named readiness conditions --------------------------------------------
//
// One process restart produces SEVERAL readiness signals that come back at
// different times, and this harness has now been bitten twice by treating one of
// them as a stand-in for another. `/healthz` answering 200 does not mean the
// metrics endpoint is mounted; measured on this stack, `/metrics` still returns
// 404 for 3.5–7.8 s after `/healthz` is green, 4 of 4 forced trials. Prometheus
// target health lags differently again, by up to a full scrape interval.
//
// So a readiness condition carries the SIGNAL it is judged against as data, not
// as a comment. That makes "this condition is judged on its own signal" a thing a
// test can assert structurally, rather than a property a reviewer has to notice —
// which is what stops the proxy defect coming back on a later edit.
//
// The rule this encodes, in one line: a condition is satisfied only by its own
// signal. Never by one that merely correlates with it.
export const readinessConditions = {
  metricsMounted: () => ({
    name: 'metricsMounted',
    describes: 'the n8n metrics endpoint is mounted and serving',
    // Judged on /metrics ITSELF. Deliberately not `/healthz` (a liveness probe
    // that does not even validate database connectivity) and deliberately not
    // `/healthz/readiness` (which certifies database connection and migration
    // completion). Neither says anything about whether /metrics is mounted.
    signal: `${N8N_BASE}/metrics`,
    async observe() {
      try {
        const res = await httpNoPool(`${N8N_BASE}/metrics`);
        return { ok: res.status === 200, observed: `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, observed: `unreachable (${e.code || e.message})` };
      }
    },
  }),

  prometheusTargetsUp: (jobs = ['n8n-main', 'n8n-worker']) => ({
    name: `prometheusTargetsUp(${jobs.join(', ')})`,
    describes: 'Prometheus reports every named scrape job as up',
    signal: `${PROM_BASE}/api/v1/targets?state=active`,
    async observe() {
      try {
        const res = await httpNoPool(`${PROM_BASE}/api/v1/targets?state=active`);
        if (res.status !== 200) return { ok: false, observed: `targets API returned HTTP ${res.status}` };
        const health = Object.fromEntries(
          JSON.parse(res.text).data.activeTargets.map((t) => [t.labels.job, t.health]),
        );
        // An absent job is a scrape-config fault and a `down` job is an
        // unreachable target; they need different fixes, so they read differently.
        const bad = jobs
          .filter((job) => health[job] !== 'up')
          .map((job) => `${job}="${health[job] ?? 'absent from the active target list'}"`);
        return { ok: bad.length === 0, observed: bad.length ? bad.join(', ') : 'all up' };
      } catch (e) {
        return { ok: false, observed: `unreachable (${e.code || e.message})` };
      }
    },
  }),
};

// Wait until every named condition is satisfied against its own signal.
//
// Bounded, and it THROWS on timeout rather than returning false — the same
// reasoning as `waitTargetsUp`: a readiness wait that silently returns converts a
// hard, legible failure into a flaky one, because the caller then asserts against
// a thing it was told nothing about and the failure lands on the assertion
// instead of on the wait.
//
// The default timeout is derived, not fitted. The largest mount lag observed was
// 7,787 ms — itself well above the 3.9 s "maximum" an earlier and smaller sample
// suggested, which is precisely why an observation must not become the bound. The
// metrics endpoint mounts as part of the same n8n start-up that makes `/healthz`
// answer, and `waitHealthy` already bounds that start-up at 60 s; this wait
// therefore inherits that same start-up bound rather than inventing a number
// fitted to the largest lag anyone happened to see.
export async function waitReady(conditions, { timeoutMs = 60000, pollMs = 500 } = {}) {
  const list = Array.isArray(conditions) ? conditions : [conditions];
  // A wait on nothing would return instantly and truthfully report success,
  // which is the silent no-op this whole primitive exists to prevent.
  if (list.length === 0) throw new Error('waitReady called with no conditions — that is a no-op, not a wait');

  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await Promise.all(list.map(async (c) => ({ c, r: await c.observe() })));
    if (last.every(({ r }) => r.ok)) return true;
    await sleep(pollMs);
  }
  const unmet = last
    .filter(({ r }) => !r.ok)
    .map(({ c, r }) => `${c.name} (judged on ${c.signal}): ${r.observed}`);
  throw new Error(
    `readiness conditions not met within ${timeoutMs} ms — unmet: ${unmet.join('; ')}`,
  );
}

// Copy a workflow JSON into the main container and import it. Tolerant: returns
// the import result without throwing.
export function importWorkflowFile(localPath) {
  const tmp = `/tmp/${localPath.split('/').pop()}`;
  const cp = compose(['cp', localPath, `n8n:${tmp}`]);
  if (cp.code !== 0) return cp;
  return compose(['exec', '-T', 'n8n', 'n8n', 'import:workflow', `--input=${tmp}`]);
}

export function activateWorkflow(id) {
  return compose(['exec', '-T', 'n8n', 'n8n', 'update:workflow', `--id=${id}`, '--active=true']);
}

export function restartService(service) {
  return compose(['restart', service]);
}

export function workflowExists(name) {
  const r = psql(`select count(*) from workflow_entity where name='${name}';`);
  return r.code === 0 && parseInt(r.stdout.trim(), 10) > 0;
}

export function countRows(sql) {
  const r = psql(sql);
  if (r.code !== 0) return -1;
  return parseInt(r.stdout.trim(), 10);
}

// Provision the Postgres credential the order-intake workflow references, from
// .env values. The credential JSON is written to a temp file (never committed)
// and imported via the CLI; n8n encrypts it at rest with the instance key.
export function ensurePostgresCredential() {
  if (countRows("select count(*) from credentials_entity where id='pgcredential0001';") > 0) {
    return true;
  }
  const env = loadEnv();
  const cred = [
    {
      id: 'pgcredential0001',
      name: 'Postgres order-intake',
      type: 'postgres',
      data: {
        host: 'postgres',
        port: 5432,
        database: env.POSTGRES_DB || 'n8n',
        user: env.POSTGRES_USER || 'n8n',
        password: env.POSTGRES_PASSWORD || '',
        ssl: 'disable',
        allowUnauthorizedCerts: false,
      },
    },
  ];
  const tmp = join(tmpdir(), 'pg-cred.json');
  writeFileSync(tmp, JSON.stringify(cred), { mode: 0o600 });
  compose(['cp', tmp, 'n8n:/tmp/pg-cred.json']);
  return compose(['exec', '-T', 'n8n', 'n8n', 'import:credentials', '--input=/tmp/pg-cred.json']).code === 0;
}

// Provision the two Header Auth credentials the webhook nodes reference — the
// mechanism n8n DOES support for keeping a secret out of `$env`, in contrast to
// the HMAC secret, which a Code node can only reach through `$env`.
//
// The import file carries real token values, so it is written into a git-ignored
// path, imported, and deleted in the same call — host copy and container copy
// both. `tests/credential-import-hygiene.test.js` asserts it is absent from the
// working tree and from git history, because "we remembered to delete it" is not
// a control.
export function ensureWebhookAuthCredentials() {
  const env = loadEnv();
  const creds = [
    {
      id: 'orderintakeauth1',
      name: 'Order intake webhook auth',
      type: 'httpHeaderAuth',
      data: { name: 'x-webhook-auth', value: env.ORDER_INTAKE_WEBHOOK_AUTH_TOKEN || '' },
    },
    {
      id: 'supporttriageau1',
      name: 'Support triage webhook auth',
      type: 'httpHeaderAuth',
      // A DIFFERENT value from the order-intake token: one leaked caller must
      // not open both doors.
      data: { name: 'x-webhook-auth', value: env.SUPPORT_TRIAGE_WEBHOOK_AUTH_TOKEN || '' },
    },
  ];

  // Fail closed rather than provisioning an empty token, which would authenticate
  // any caller that sends the header at all.
  if (creds.some((c) => !c.data.value)) return false;

  const hostPath = join(repoRoot, 'deployment', 'secrets', 'webhook-auth-credentials.json');
  const containerPath = '/tmp/webhook-auth-credentials.json';
  try {
    mkdirSync(dirname(hostPath), { recursive: true, mode: 0o700 });
    writeFileSync(hostPath, JSON.stringify(creds), { mode: 0o600 });
    compose(['cp', hostPath, `n8n:${containerPath}`]);
    return compose(['exec', '-T', 'n8n', 'n8n', 'import:credentials', `--input=${containerPath}`]).code === 0;
  } finally {
    // Same step, always — including if the import threw.
    rmSync(hostPath, { force: true });
    compose(['exec', '-T', 'n8n', 'rm', '-f', containerPath]);
  }
}

// Draw and discard whatever this process has pooled for the n8n origin.
//
// Called at the one boundary where the pool is KNOWN to have been poisoned — a
// restart this harness issued. Each request either completes over a live socket
// or fails at the transport layer and is retried over a fresh one, so when this
// returns, the sockets left in the pool are sockets to the process that is
// actually running. The cost of the poisoning lands here, deliberately, instead
// of on an arbitrary assertion several tests later.
async function drainConnectionPool(rounds = 4) {
  await Promise.all(
    Array.from({ length: rounds }, () => httpRequest(`${N8N_BASE}/healthz`).catch(() => null)),
  );
}

// Ensure a production webhook is registered on main. n8n registers active
// webhooks a beat after /healthz goes 200, so poll (a 404 means not yet
// registered) and restart main between rounds if needed.
//
// The poll runs over a non-pooled connection: this function may have just
// restarted n8n, and a probe drawing a socket from the pre-restart pool would
// report "not registered" about a webhook that is registered and serving.
export async function registerWebhook(path, { restarts = 3 } = {}) {
  for (let attempt = 0; attempt <= restarts; attempt++) {
    for (let i = 0; i < 6; i++) {
      const r = await httpNoPool(`${N8N_BASE}/webhook/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).catch(() => ({ status: 0 }));
      if (r.status && r.status !== 404) {
        await drainConnectionPool();
        return true;
      }
      await sleep(2000);
    }
    restartService('n8n');
    await waitHealthy();
    // The one readiness call site, placed at the restart rather than at the
    // assertions. Restarts originate here and only here; assertions happen in
    // dozens of places, so waiting defensively at each of them would be the same
    // patch applied N times. A caller needing a condition this site does not
    // wait on requests it explicitly at its own site — `observability.test.js`
    // does exactly that for Prometheus target health.
    await waitReady([readinessConditions.metricsMounted()]);
    await sleep(2000);
  }
  return false;
}

// Provision the two LLM provider credentials the triage workflow references.
// Deliberately two DIFFERENT credential types pointed at two DIFFERENT base
// paths, because that is what makes the fallback a genuinely separate provider
// chain rather than the same one called twice.
export function ensureLlmCredentials() {
  const env = loadEnv();
  const creds = [
    {
      id: 'llmprimary000001',
      name: 'LLM primary',
      type: 'openAiApi',
      data: { apiKey: env.LLM_PRIMARY_API_KEY || 'mock', url: env.LLM_PRIMARY_BASE_URL || '' },
    },
    {
      id: 'llmfallback00001',
      name: 'LLM fallback',
      type: 'deepSeekApi',
      data: { apiKey: env.LLM_FALLBACK_API_KEY || 'mock', url: env.LLM_FALLBACK_BASE_URL || '' },
    },
  ];
  const have = countRows(
    "select count(*) from credentials_entity where id in ('llmprimary000001','llmfallback00001');",
  );
  if (have >= 2) return true;
  const tmp = join(tmpdir(), 'llm-creds.json');
  writeFileSync(tmp, JSON.stringify(creds), { mode: 0o600 });
  compose(['cp', tmp, 'n8n:/tmp/llm-creds.json']);
  return compose(['exec', '-T', 'n8n', 'n8n', 'import:credentials', '--input=/tmp/llm-creds.json']).code === 0;
}
