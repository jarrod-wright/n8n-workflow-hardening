# Broker choice: why Valkey (and how to run Redis instead)

## Why a broker at all

n8n's **queue mode** runs executions on separate worker processes instead of the
main process. Main and workers coordinate through a job queue, and that queue is
built on [BullMQ](https://docs.bullmq.io/), which stores its jobs in a
**Redis-protocol** data store. So queue mode needs a Redis-protocol broker; it's
the thing the main instance enqueues into and the workers pull from. No broker,
no horizontal scaling of executions.

## The 2024 licensing split, briefly

In March 2024, Redis Inc. changed the Redis license from the permissive BSD
license to a dual RSALv2 / SSPLv1 model, which is source-available rather than
open source. In response, the Linux Foundation created **Valkey**, a fork of the
last BSD-licensed Redis, continuing under the BSD license. Both speak the same
protocol; they differ in license and governance. This note states that as
background, not as a position on which license anyone should prefer.

## Why this repo runs Valkey

Two practical reasons, no advocacy:

1. **Copyability.** This is a public reference others clone and adapt. A
   BSD-licensed broker means anyone can reuse the whole stack without stopping to
   evaluate a source-available license against their situation.
2. **Ecosystem default.** Valkey is now the default Redis-protocol package in
   several major Linux distributions and the managed offering behind several
   cloud "Redis-compatible" services, so it's a mainstream, well-supported
   choice rather than an exotic one.

## How to run Redis instead

Some environments mandate Redis. The swap is the broker **image**:

```yaml
# deployment/docker-compose.yml — the valkey service
-    image: valkey/valkey:9.1@sha256:3acc0687f2a2e1091fae6450d7842dd658c941338cf0a873ddd9e14b9e4ea4dd
+    image: redis:7.4@sha256:<pin-the-digest-you-pull>
```

Because this compose file invokes the broker binaries by name, also change the
two `valkey-` references to their `redis-` equivalents — `valkey-server` →
`redis-server` in `command`, and `valkey-cli` → `redis-cli` in the healthcheck.
(Both binaries exist under both names: the Valkey image ships `redis-server` /
`redis-cli` compatibility symlinks, and the Redis image ships the `redis-`
originals.) Nothing on the n8n side changes — same
`QUEUE_BULL_REDIS_HOST` / `_PORT` / `_PASSWORD`, same `requirepass`, same
"broker not published to the host" posture. Keep the digest pin.

## The compatibility boundary, stated honestly

n8n officially documents and tests queue mode against **Redis** — that is the
supported configuration its maintainers name. Valkey is wire-identical at the
Redis protocol level and works with BullMQ, which is why queue mode runs on it
unchanged, and this repo verifies that on every test run: a job enqueued by main
is executed by a worker against the authenticated Valkey broker.

What this note does **not** claim is that Valkey is an officially certified n8n
dependency. It isn't. If you need a vendor-supported configuration, run Redis
(above). If you're optimising for a permissive license and a mainstream default,
Valkey is a sound choice — and the one-line swap above means the decision isn't a
lock-in either way.
