# Environment reference

Every environment variable this stack sets, grouped by what it is for, with the
**reason** rather than just the value. A configuration reference that only
restates the value is a copy of the compose file; the reason is the part that
tells you whether you may change it.

Read alongside [`../docker-compose.yml`](../docker-compose.yml), which is where
these are set, and [`../../.env.example`](../../.env.example), which is the file
an operator edits.

---

## How values reach the containers

Not every service gets every variable, and that is the point.

| Service | Gets | Why |
|---|---|---|
| `postgres`, `valkey` | `../.env` directly | The passwords in it are theirs. |
| `n8n`, `n8n-worker` | `deployment/secrets/n8n.env` — **one** secret plus non-secret config | These containers run Code nodes, and a Code node can read the whole process environment. |
| `n8n`, `n8n-worker` secrets | three `*_FILE` secrets | A value delivered by file never enters the process environment, so `$env` cannot reach it — and it stays out of `docker inspect` too. |
| `prometheus`, `grafana` | no secrets at all | Neither holds any. |

`tools/materialise-secrets.mjs` derives that scoped surface from `.env` before
the stack starts, and `tests/env-secret-surface.test.js` fails the build if a
second secret ever becomes reachable from a Code node.

---

## Core

| Variable | Value | Why |
|---|---|---|
| `N8N_HOST` | `localhost` | Host n8n believes it is serving. Wrong here and generated webhook URLs point somewhere nothing is listening. |
| `N8N_PORT` | `5678` | Listening port inside the container. |
| `N8N_PROTOCOL` | `http` | Plain HTTP is acceptable **only** because the port is bound to loopback. Terminate TLS in front of n8n in any real deployment. |
| `WEBHOOK_URL` | `http://localhost:5678/` | The externally reachable base URL n8n advertises. Behind a reverse proxy this must be the *public* URL, not the container's — getting it wrong produces webhook URLs that work in the editor and 404 for callers. |
| `GENERIC_TIMEZONE` | `UTC` | Instance default timezone. See the timezone note below: this is a floor, not a substitute for setting it per workflow. |
| `N8N_DIAGNOSTICS_ENABLED` | `false` | No telemetry off this deployment. |
| `N8N_HIRING_BANNER_ENABLED` | `false` | Removes console noise. |

## Queue mode

| Variable | Value | Why |
|---|---|---|
| `EXECUTIONS_MODE` | `queue` | Main enqueues, workers execute. Without this, "scaling" by adding workers does nothing — main runs everything itself. |
| `QUEUE_BULL_REDIS_HOST` / `QUEUE_BULL_REDIS_PORT` | `valkey` / `6379` | The broker, on the internal network only. The port is **not** published to the host. |
| `QUEUE_BULL_REDIS_PASSWORD_FILE` | `/run/secrets/broker_password` | Broker password by file. The broker refuses to start without a password set, so an unauthenticated broker cannot come up by accident. |
| `QUEUE_HEALTH_CHECK_ACTIVE` (worker) | `true` | Gives the worker an HTTP health endpoint, so an unhealthy worker is visible to Compose rather than silently idle. |
| `DB_TYPE` | `postgresdb` | Queue mode requires a shared database. SQLite cannot serve a distributed deployment, and MySQL was removed in n8n v2.0. |
| `DB_POSTGRESDB_HOST` / `DB_POSTGRESDB_PORT` | `postgres` / `5432` | Internal only. |
| `DB_POSTGRESDB_DATABASE` / `_USER` | via `secrets/n8n.env` | Non-secret, but delivered through the same narrow file rather than broadcast. |
| `DB_POSTGRESDB_PASSWORD_FILE` | `/run/secrets/db_password` | Must equal `POSTGRES_PASSWORD`. A mismatch is caught by `tests/env-consistency.test.js`; otherwise it fails silently at connect time. |

**Concurrency.** Worker concurrency defaults to 10. Treat that as a starting
point, not a recommendation: the right number is bounded by what the *downstream*
services tolerate, not by the worker's own capacity. Ten workers × ten concurrent
executions against an API that permits fifty requests a minute produces a
self-inflicted rate limit. Raise it only alongside the pacing in
[`../../docs/golden-patterns.md`](../../docs/golden-patterns.md#gp-06--rate-limit-by-batching-and-waiting-not-by-retrying).

## Security

| Variable | Value | Why |
|---|---|---|
| `N8N_ENCRYPTION_KEY_FILE` | `/run/secrets/n8n_encryption_key` | Encrypts stored credentials at rest. **Keep it stable and back it up** — losing it makes every stored credential permanently undecryptable, with no recovery path but deleting and re-entering each one. |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` | Deliberate, and it cannot be `true`. n8n Code nodes cannot read credentials on any version, so the `Verify HMAC` node has no way to reach its secret except `$env`. The blast radius is bounded by *delivery* instead: exactly one secret is reachable, and a test fails the build if a second appears. |
| `NODE_FUNCTION_ALLOW_BUILTIN` | `crypto` | The narrowest allowance that lets the HMAC check run. Not `*`. |
| `N8N_RUNNERS_ENABLED` | `true` | Task runners execute Code nodes in a separate process. External runners are the default posture in n8n v2.0+. |
| `N8N_RUNNERS_MODE` | `internal` | Runner lifecycle managed by n8n itself. |

**Never set a `*_FILE` variable alongside its plain form.** On this version the
plain form **wins** and the `_FILE` form is silently ignored — so a leftover
plain variable reverts the hardening to a no-op with no error, no warning, and
every health check still green. `tests/env-file-precedence.test.js` makes that
impossible to do by accident.

## Observability

Prometheus metrics are **not** an Enterprise-gated feature; log streaming is.
That is why this stack demonstrates metrics and dashboards — a reader can
reproduce all of it. See
[`enterprise-ha-architecture.md`](enterprise-ha-architecture.md).

| Variable | Value | Why |
|---|---|---|
| `N8N_METRICS` | `true` (main **and** worker) | Exposes `/metrics` in Prometheus format on the same port. Set on the worker too, because the worker is the process that actually executes workflows — its event-loop lag and memory are the numbers that reflect execution pressure. Scraping only main shows a healthy event loop while the container doing the work is saturated. |
| `N8N_METRICS_INCLUDE_QUEUE_METRICS` | `true` | Adds Bull queue metrics. These are gathered on **main** regardless of where executions run; setting `N8N_METRICS` on workers does not produce them. |
| `N8N_METRICS_QUEUE_METRICS_INTERVAL` | `20` | Seconds between queue metric refreshes. |

**Take metric names from a live scrape, never from documentation.** The queue
metrics this version emits are `n8n_scaling_mode_queue_jobs_waiting`,
`_active`, `_completed` and `_failed` — not the `n8n_queue_*` names published by
various third parties. A dashboard built on a wrong name **renders empty while
the Grafana API still returns HTTP 200**, so it looks provisioned and is useless.
Confirm with:

```bash
curl -s http://127.0.0.1:5678/metrics | grep '^# TYPE n8n_'
```

The `prometheus` and `grafana` services are bound to **loopback only**
(`127.0.0.1:9090` and `127.0.0.1:3030`). Grafana runs anonymous and read-only:
it holds no data of its own, and giving it the stack's `.env` just to set one
password would have broadcast every secret to it. **Exposing Grafana beyond
loopback requires putting real authentication in front of it first.**

## Execution data retention

n8n **prunes by default**. Everything here *tunes* that policy; none of it
enables it. The values are stated explicitly so the policy is visible in the
configuration rather than inherited silently — an unbounded execution table is
one of the commonest ways a working n8n deployment degrades over months, and it
degrades slowly enough that nobody attributes it to configuration.

| Variable | Value | Default | Why |
|---|---|---|---|
| `EXECUTIONS_DATA_PRUNE` | `true` | `true` | Set explicitly so the policy is legible, not inferred. |
| `EXECUTIONS_DATA_MAX_AGE` | `168` (7 days) | `336` (14 days) | Age ceiling in **hours**. Seven days covers a working week of debugging. |
| `EXECUTIONS_DATA_PRUNE_MAX_COUNT` | `10000` | `10000` | Count ceiling, applied alongside the age ceiling. Age alone does not bound a burst; count alone does not bound a slow trickle. |
| `EXECUTIONS_DATA_HARD_DELETE_BUFFER` | `1` | `1` | Hours of grace between soft delete and hard delete, so data somebody is actively debugging does not vanish mid-investigation. |

**`DB_SQLITE_VACUUM_ON_STARTUP` is deliberately absent.** It is SQLite-only, and
this stack runs Postgres in queue mode. Including it would be a visible
correctness error rather than a harmless extra.

Prometheus carries the same discipline for its own storage:
`--storage.tsdb.retention.time=15d`. A time-series database with no ceiling fills
the disk eventually, and it does it on the day the incident starts.

---

## Two caveats worth stating plainly

### Schedules do not catch up

A Schedule Trigger that was due while n8n was down does **not** fire on restart.
There is no catch-up run. The window it would have processed is simply skipped,
and nothing reports that it was — the workflow produces no error because it
produces nothing at all.

This is why [`../../_shared/sync-watchdog/`](../../_shared/sync-watchdog/) exists
and why it alerts on the absence of a **success** rather than the absence of a
run. It is also why `02-crm-sync` advances a watermark instead of processing "the
last 24 hours": a watermark resumes correctly after any outage of any length,
whereas a fixed lookback silently loses whatever fell outside it.

### Set the timezone on every scheduled workflow

`GENERIC_TIMEZONE=UTC` is the instance default, and a default is not a decision.
Any workflow with a Schedule Trigger must set its own IANA timezone in
`settings.timezone`, and linter rule **R9** enforces it.

A schedule inheriting the instance timezone silently changes meaning when the
instance moves, when the host's zone changes, or when the deployment is copied to
another region: a nightly job set for 02:00 becomes 02:00 somewhere else, and the
daily window it reads shifts under it with no error. Under a zone observing
daylight saving, one run a year happens twice and one never happens at all.
