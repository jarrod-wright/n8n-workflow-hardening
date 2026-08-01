# n8n Production Hardening

A worked reference for taking n8n workflows from "it runs on my machine" to
something that survives production: authenticated ingress, exactly-once
processing, bounded retries with a dead-letter path and a replay, resumable
scheduled syncs, deterministic handling of model output, liveness alerting for
work that silently stops happening, and a static linter for the anti-patterns
behind the most common incidents.

**The thesis: a hardened workflow treats every failure path as a designed,
tested, wired mechanism — not a TODO.** Anyone can draw the happy path. What
separates a workflow that works from one that keeps working is what happens when
the upstream returns a 503, when the same order arrives twice, when the model
returns prose instead of JSON, when a provider goes down, and when a nightly job
quietly stops running. Each of those has a defined response here, and each
response is verified by a test that causes the failure on purpose.

Everything runs locally with Docker Compose and a Node.js test suite. No SaaS
accounts, no hosted state, and no dependencies — `package.json` declares none.

## The three planes

Self-hosting n8n means securing three different things, and they are not the same
job. Most material treats them as one. This repository covers one of them, and
says plainly which.

| Plane | What it covers | Where it lives |
|---|---|---|
| **Workflow** ← *you are here* | The automations themselves: authenticated ingress, idempotency, bounded retries, dead-lettering, model-output validation, liveness | **this repository** |
| **Stack and container** | Compose topology, reverse proxy and TLS termination, queue mode, secret delivery, capability drops, database privileges | [`n8n-hardened-reference`](https://github.com/jarrod-wright/n8n-hardened-reference) |
| **Host and OS** | CIS Ubuntu 24.04 Level 1 — Server, SSH policy, kernel and sysctl parameters, host firewall, auditd, patch posture | `vps-hardening-reference` — in development, not yet published |

They compose without overlapping, and each is incomplete on its own. Hardened
workflows on an unhardened host leave correct logic behind an open door. A
locked-down host running unhardened workflows silently drops orders. A hardened
stack on an unhardened host is still an unhardened host.

**What this repository does not cover.** The host and OS plane — nothing here
makes any claim about the machine underneath, and you should not read one into
it. Nor is the Compose stack below a production deployment reference: it exists
to run and exercise these workflows on loopback, and a stack built to face the
public internet, with TLS termination and its own threat model, is the
container-plane project above.

## What is in this repository

| Path | What it is |
|---|---|
| [`01-order-intake/`](01-order-intake/) | HMAC-authenticated webhook → validation → idempotent claim → bounded retry → dead-letter → response. |
| [`02-crm-sync/`](02-crm-sync/) | Scheduled delta sync with a PostgreSQL watermark advanced only to the last record that succeeded with no failure before it. |
| [`03-support-triage/`](03-support-triage/) | Model-assisted triage with a deterministic parser, a JSON Schema contract, and a fallback on a genuinely different vendor. |
| [`_shared/`](_shared/) | The global error handler every workflow points at, the stale-run watchdog, and the dead-letter replay. |
| [`deployment/`](deployment/) | The Compose stack: n8n main + worker in queue mode, Valkey broker, PostgreSQL, a mock upstream API, a mock model provider, Prometheus and Grafana. |
| [`linter/`](linter/) | A dependency-free static linter for exported workflow JSON, rules R1–R13. |
| [`docs/`](docs/) | Golden patterns, the failure-mode taxonomy, the anti-pattern catalogue, the testing methodology, and the broker-choice rationale. |
| [`schemas/`](schemas/) | The output contract the triage workflow validates every model response against. |
| [`curated/`](curated/) | Annotated outside references, with dated observations. |
| [`tests/`](tests/) | Failure-injection and structural tests, run with `node:test`. |
| [`typeversions.json`](typeversions.json) | Every node `typeVersion` this repository is pinned to, confirmed against a live instance. |
| [`PUBLISH-CHECKLIST.md`](PUBLISH-CHECKLIST.md) | The publish-readiness checks that cannot honestly be automated. |

## Quick start

```bash
cp .env.example .env      # then set local values; .env is git-ignored
npm run stack:up          # Compose up, waits for every service healthy
npm test                  # the whole suite; fails loudly if the stack is down
```

Then:

- n8n — <http://127.0.0.1:5678>
- Grafana ops overview — <http://127.0.0.1:3030>
- Prometheus — <http://127.0.0.1:9090>

All three are bound to loopback only.

## The hardening patterns

Eleven patterns, each implemented by a workflow here and each explained in
[`docs/golden-patterns.md`](docs/golden-patterns.md): error-handler-first,
idempotency before the side effect, retry with an explicit stop, validate before
acting, two-layer webhook authentication with constant-time comparison, rate
limiting by pacing rather than retrying, timezone-pinned schedules, a watchdog
for silence, partial-failure isolation with a replay, deterministic parsing with
schema validation, and a provider fallback that fails independently.

Patterns no static check can see are tagged `[structural]` rather than left
implying coverage that does not exist.

The six classes of failure those patterns answer — transient, permanent,
invalid-input, silent-skip, rate-limit, and model-or-provider failure — are set
out with their wired defences in
[`docs/failure-mode-taxonomy.md`](docs/failure-mode-taxonomy.md).

## The anti-patterns

Each linter rule maps to a production incident, catalogued in
[`docs/anti-patterns.md`](docs/anti-patterns.md). The headline entry is n8n issue
[#9236](https://github.com/n8n-io/n8n/issues/9236): a node configured with
retries whose error behaviour lets the workflow continue down the *success* path
carrying an error object, so the retries happen, all of them fail, and the
execution is still recorded as successful.

The catalogue also covers the two traps that need a whole workflow to fix rather
than a rule — nothing alerting when a workflow stops running, and a "fallback"
that shares fate with the thing it is protecting.

## The linter

```bash
node linter/cli.js lint 01-order-intake/workflow.json
```

Thirteen rules over exported workflow JSON: missing error workflow, unpinned
`typeVersion`, a webhook with no response node, a side-effecting call with no
retry, SQL built from an expression, a hardcoded secret, swallowed errors, a
network call with no timeout, a schedule with no timezone, unvalidated model
output, a model repairing another model's output, single-vendor dependency, and
resumable state kept in workflow static data.

It is standard-library only and runs from a checkout with nothing installed. The
bar is **zero false positives** across the clean fixture set, which includes this
repository's own workflows — a rule that fires on hardened, working workflows
trains people to ignore the linter. Scope, the repo-scan design, and why one
obvious rule is deliberately deferred are in
[`linter/ROADMAP.md`](linter/ROADMAP.md).

## The deployment stack

[`deployment/`](deployment/) runs n8n in **queue mode**: main handles ingress and
enqueues, a worker executes. The broker is authenticated and unpublished to the
host, and the stack fails closed if its password is unset. Secrets are delivered
per service rather than broadcast, so exactly one secret is reachable from a Code
node — enforced by a test, not by convention.

Observability is wired in. Prometheus scrapes both n8n processes, and a
pre-provisioned Grafana dashboard covers execution rate, duration, error rate,
queue depth, event-loop lag and memory. Panel expressions use metric names taken
from a **live scrape**, because a dashboard built on names copied from
documentation renders empty while the API still returns HTTP 200.

- [`deployment/README.md`](deployment/README.md) — stack walkthrough, pinning
  rationale, and how to verify queue mode.
- [`deployment/docs/environment-reference.md`](deployment/docs/environment-reference.md)
  — every variable with its reason, retention tuning, and the no-catch-up caveat.
- [`deployment/docs/enterprise-ha-architecture.md`](deployment/docs/enterprise-ha-architecture.md)
  — the multi-main architecture, what it requires, and why this stack is not it.

Host and OS hardening — SSH policy, kernel and sysctl parameters, host firewall,
auditd, patch posture — is out of scope here, and it is not the container-plane
project's job either: it is the third plane, still in development. Public-internet
exposure and TLS termination belong to the container plane. See
[The three planes](#the-three-planes).

## Testing

The suite injects failures rather than confirming the happy path, and asserts
against the transport and the database rather than the workflow's own account of
itself. Methodology, the dual-counter pattern, the fixture-response pattern, and
an explicit list of what the suite does **not** cover are in
[`docs/testing.md`](docs/testing.md).

## Curated references

Outside material worth reading, with the criteria each entry had to meet and the
date each claim was observed:
[`curated/curated-collections.md`](curated/curated-collections.md).

## Version and compatibility

- **n8n v2.x.** The stack pins an exact image tag *and* digest, and
  [`typeversions.json`](typeversions.json) pins every node `typeVersion` in use.
- **PostgreSQL is required** for queue mode. SQLite cannot back a distributed
  deployment, and MySQL support was removed in n8n v2.0.
- **Task runners are external** in v2.0 and later; the stack enables them
  explicitly rather than relying on a default.
- n8n is distributed under the **fair-code** Sustainable Use License, which is
  not an OSI-approved open-source licence. Multi-main high availability and log
  streaming require a self-hosted Enterprise plan; **Prometheus metrics do not**,
  which is why this repository can demonstrate them.

## Licence

[MIT](LICENSE) — see [`LICENSE`](LICENSE). To report a vulnerability, see
[`SECURITY.md`](SECURITY.md).
