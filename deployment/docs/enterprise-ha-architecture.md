# High availability on n8n: the multi-main architecture

This document describes the architecture that makes n8n itself highly available,
and states plainly which parts of it this repository ships and which it does not.

> **Licence boundary, stated once and up front.**
> **The multi-main setup described here is Enterprise-licensed.** It requires a
> self-hosted n8n Enterprise plan; n8n's own documentation marks the feature
> *"Available on Self-hosted Enterprise plans."*
>
> The stack in this repository is **single-main queue mode on the
> source-available Community distribution**. It is not multi-main, it is not
> highly available, and nothing here should be read as claiming otherwise.

Documentation re-resolved 2026-07-28 against
[Enable queue mode](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/enable-queue-mode).
n8n restructured its hosting documentation, so older `/hosting/...` paths
redirect; the path above is the one that currently resolves.

---

## What this repository actually ships

One `main` process, one `worker` process, one Valkey broker, one Postgres.

```
                 ┌──────────────┐
   webhook  ───▶ │  n8n  main   │ ── enqueue ──▶ ┌────────┐
   schedule ───▶ │  (single)    │                │ Valkey │
                 └──────┬───────┘ ◀── result ─── └───┬────┘
                        │                            │
                        │                        ┌───▼──────────┐
                        └────────────────────────│  n8n worker  │
                                 Postgres        └──────────────┘
```

This is a **scalability** topology, not an **availability** one. Adding workers
increases execution throughput. It does nothing for availability, because the
single `main` process remains a single point of failure: it owns webhook
ingress, schedule triggers, and the editor UI. If it stops, webhooks stop being
accepted and scheduled workflows stop firing, however many workers are healthy.

Saying so is the point. A queue-mode diagram with two boxes is routinely
presented as "highly available" because it *looks* redundant. It is not.

---

## The multi-main architecture

High availability requires more than one `main` process, and n8n supports that
only under an Enterprise licence.

```
                     ┌───────────────────────────┐
   clients ────────▶ │  load balancer            │
                     │  sticky sessions REQUIRED │
                     └───────┬───────────┬───────┘
                             │           │
                    ┌────────▼───┐  ┌────▼───────┐
                    │ main #1    │  │ main #2    │   … n mains
                    │ (leader)   │  │ (follower) │
                    └─────┬──────┘  └─────┬──────┘
                          │               │
              ┌───────────┴───────────────┴───────────┐
              │                                       │
        ┌─────▼──────┐                        ┌───────▼───────┐
        │  Postgres  │  shared state          │    Redis      │  queue +
        │  (shared)  │                        │   (shared)    │  leader key
        └────────────┘                        └───────┬───────┘
                                                      │
                                        ┌─────────────▼─────────────┐
                                        │  workers (n)              │
                                        └───────────────────────────┘
```

### The four properties that make it work

**1 — Multiple main processes behind a load balancer.** Every `main` serves the
UI and accepts webhooks. Losing one costs the requests in flight on it, not the
service.

**2 — Sticky sessions are mandatory, not a tuning option.** n8n's documentation
requires session persistence on the load balancer. Without it, an editor session
and its push channel can land on different mains and the UI misbehaves in ways
that look like random flakiness rather than a misconfigured balancer. This is the
single most commonly skipped requirement in the architecture.

**3 — Leader election over the shared Redis.** Exactly one main holds leadership
at a time. The leader runs the *at-most-once* work — schedule triggers, polling
triggers, and pruning — while followers handle regular request-serving work. If
the leader disappears, a follower takes over, transparently. The relevant knobs:

| Variable | What it controls |
|---|---|
| `N8N_MULTI_MAIN_SETUP_ENABLED` | turns the multi-main setup on |
| `N8N_MULTI_MAIN_SETUP_KEY_TTL` | how long a leadership key survives without renewal |
| `N8N_MULTI_MAIN_SETUP_CHECK_INTERVAL` | how often leadership is re-checked |

The election is what stops a scheduled workflow firing once per main. Running
several mains *without* it would turn one nightly job into `n` nightly jobs —
which, for anything that writes, is a data-integrity incident rather than an
availability improvement.

**4 — Shared Postgres and shared Redis.** Every main and every worker addresses
the same database and the same broker. A distributed n8n on SQLite is not
supported, and the reason is structural rather than a limitation to work around:
there is no shared state for the second process to join.

### The reference implementation

n8n publishes a Terraform module for this topology:
[`n8n-io/terraform-aws-n8n`](https://github.com/n8n-io/terraform-aws-n8n). It
provisions the production-grade multi-main deployment — multiple main instances,
dedicated worker pods, managed PostgreSQL (RDS), Redis (ElastiCache), S3 for
shared binary storage, and an application load balancer in front. It requires an
Enterprise licence, and at the time of writing it is pre-1.0, so treat its
interface as unstable.

Reproducing that module's output by hand is not a shortcut. The parts that are
easy to hand-roll are the parts that were never the hard bit.

---

## Observability: what is gated and what is not

This distinction matters when planning a deployment, and it is easy to get
backwards.

| Capability | Licence | Used here |
|---|---|---|
| **Prometheus metrics** (`/metrics`) | **Not gated.** Available on the Community distribution. | **Yes** — see [`deployment/docs/environment-reference.md`](environment-reference.md) |
| **Log streaming** to external systems | **Enterprise.** n8n's documentation states *"Log Streaming is available on all Enterprise plans."* | No |
| **Multi-main setup** | **Enterprise** | No |
| **Viewing running workers in the UI** | **Enterprise** | No |

So this exhibit demonstrates **metrics and dashboards**, which anyone can run,
rather than log streaming, which most readers could not reproduce. Building a
hardening demonstration on a licensed feature would make it a brochure rather
than something a reader can stand up and verify.

Log-streaming reference:
[Stream logs to external systems](https://docs.n8n.io/administer/observe-and-log/stream-logs-to-external-systems).

---

## What to do if you need HA without an Enterprise licence

There is no honest way to get multi-main on the Community distribution. What is
available is reducing the cost of the single main being down:

- **Keep the main process stateless and quick to replace.** Everything durable is
  already in Postgres and the broker, so a replacement main is a container start
  rather than a restore.
- **Have the caller redeliver.** The order-intake workflow answers a failed run
  with a non-2xx status precisely so a sender with retries redelivers it — see
  [`01-order-intake/`](../../01-order-intake/). An ingress that returns 200 for
  work it did not do converts an outage into silent data loss.
- **Make an outage visible.** A workflow that stops running produces no errors,
  because it produces nothing. [`_shared/sync-watchdog/`](../../_shared/sync-watchdog/)
  alerts on the absence of a *success*, which is the only signal a stopped main
  leaves behind.
- **Restart with supervision.** Every service in
  [`deployment/docker-compose.yml`](../docker-compose.yml) carries
  `restart: unless-stopped` and a health check that fails closed.

None of that is high availability. It is a shorter outage that someone finds out
about, which is a different and more modest claim.

---

## Composing this with the other two planes

Securing a self-hosted n8n means securing three different things. This document,
and this repository, are about one of them.

| Plane | What it covers | Where it is covered |
|---|---|---|
| **Workflow** | Authenticated ingress, idempotency, bounded retries, dead lettering, deterministic model-output handling, liveness | **this repository** — [`docs/golden-patterns.md`](../../docs/golden-patterns.md) |
| **Stack and container** | Compose topology for public exposure, reverse proxy and TLS termination, queue mode, secret delivery, capability drops, database privileges | the `n8n-hardened-reference` project |
| **Host and OS** | CIS Ubuntu 24.04 Level 1 — Server, SSH policy, kernel and sysctl parameters, host firewall, auditd, patch posture | the `vps-hardening-reference` project — in development, nothing published yet |

**Where this repository's own stack sits.** [`deployment/`](../) is a hardened,
runnable harness, not a public-internet deployment reference: the broker
authenticates and fails closed, secrets are scoped per service, and every image
carries a tag and a digest — but the only published port is bound to loopback,
and the upstreams are test doubles. A stack built to face the internet, with TLS
termination in front of it and its own threat model, is the container-plane
project above.

Each plane is incomplete alone. Host hardening with unhardened workflows leaves a
locked-down machine running a workflow that silently drops orders. Hardened
workflows on an unhardened host leave correct logic behind an open door. A
hardened stack on an unhardened host is still an unhardened host. That is why the
three are cross-referenced rather than duplicated.
