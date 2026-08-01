# Deployment stack

A queue-mode n8n stack you can bring up locally with one command. It exists to
make the hardening claims in this repo *runnable* — the failure-injection tests
in [`../tests/`](../tests) drive real workflows against these real services.

## Services

| Service | Image | Role | Exposed to host? |
|---|---|---|---|
| `n8n` | `n8nio/n8n:2.32.3` | Main: webhook ingress, enqueues executions | `127.0.0.1:5678` only |
| `n8n-worker` | `n8nio/n8n:2.32.3` | Worker: executes the enqueued jobs | no |
| `valkey` | `valkey/valkey:9.1` | Redis-protocol broker for the Bull queue | **no** (see below) |
| `postgres` | `postgres:16.14` | n8n data store + `idempotency_keys` / `dead_letter` | no |
| `mock-api` | `node:20-alpine` | Mock upstream API with dual counters (test double) | no |

Only the webhook ingress is published, and only to loopback. The broker, the
database, and the mock upstream are reachable **only** on the internal compose
network.

## Bring-up

From the repo root:

```bash
cp .env.example .env      # then set real values (.env is git-ignored)
npm run stack:up          # brings the full stack up and waits for healthy
npm run stack:down        # tears it down (and removes volumes)
```

`stack:up` runs `docker compose -f deployment/docker-compose.yml --env-file .env
up -d --wait`. Prefer the script over a bare `docker compose ... up`: it is the
one invocation that is correct from a clean clone, so there is no faster-but-wrong
path to reach for.

Two independent mechanisms make secrets safe here, and it is worth being precise
about which does what:

- **`env_file: ../.env`** delivers every secret into each container at run time,
  by reference. No secret literal is written into the compose file.
- **`$$VAR` escaping** inside every `command:`/`healthcheck:` string means the
  *container's* shell expands the variable, not compose. A single `$VAR` would be
  interpolated by compose at parse time and — with no `--env-file` — collapse to
  an empty string, which is how an earlier revision shipped an unauthenticated
  broker. `docker compose config` on a fresh clone (before `.env` exists) now
  renders with no secrets and no "variable is not set" warnings.

## Version pinning (why every image carries a tag **and** a digest)

Every `image:` in the compose file is pinned to an explicit version tag *and* a
`sha256:` digest — `latest` appears nowhere. This is the same discipline the
exhibit applies to node `typeVersion`s (see [`../typeversions.json`](../typeversions.json)):
a workflow — or a stack — that isn't pinned is one upstream release away from
behaving differently with no change on your side.

There is a concrete broker-specific reason too. A current, explicitly pinned
Redis-protocol client is required: an older client has a known
HELLO/CLIENT-INFO negotiation edge case against a modern Valkey server. Pinning
both ends keeps that negotiation deterministic.

A test enforces this: [`../tests/compose-pinning.test.js`](../tests/compose-pinning.test.js)
renders `docker compose config` and fails if any image resolves to `latest` or
carries no digest.

## Broker authentication

Valkey ships with protected mode off, so a *published* port would be reachable
with no password at all. This stack does three things about that:

1. The broker port is not published to the host (`expose:` only).
2. Valkey runs with `requirepass`, delivered from `.env` and expanded by the
   container's own shell (`$$VALKEY_PASSWORD`). Both n8n main and the worker
   authenticate with `QUEUE_BULL_REDIS_PASSWORD` (the same secret, by reference).
3. It **fails closed.** If the password is empty or unset the broker refuses to
   start (fatal log, non-zero exit) rather than come up open, and the health
   probe reports an unauthenticated broker *unhealthy* instead of healthy — it
   requires that an unauthenticated `ping` is refused, not merely that some
   `ping` returns `PONG`.

Verify:

```bash
# From a sibling container on the internal network — refused without the password:
docker compose -f deployment/docker-compose.yml --env-file .env run --rm --no-deps \
  --entrypoint valkey-cli valkey -h valkey ping                       # -> NOAUTH ...

# ...and accepted with it:
docker compose -f deployment/docker-compose.yml --env-file .env run --rm --no-deps \
  --entrypoint valkey-cli valkey -h valkey -a "$VALKEY_PASSWORD" ping  # -> PONG
```

The automated proofs live in [`../tests/broker-auth.test.js`](../tests/broker-auth.test.js)
(live stack), [`../tests/broker-auth-documented-path.test.js`](../tests/broker-auth-documented-path.test.js)
(the documented `up` path, no `--env-file`), [`../tests/broker-fail-closed.test.js`](../tests/broker-fail-closed.test.js)
(empty password aborts startup), and [`../tests/broker-healthcheck.test.js`](../tests/broker-healthcheck.test.js)
(an unauthenticated broker is never reported healthy).

## Environment access inside Code nodes — one secret, and a test that keeps it that way

Both n8n services set **`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`**, and it cannot be
set to `true`. That is a property of the platform, not a preference of this
stack, so the honest thing is to state the constraint, bound its consequence, and
then enforce the bound.

### Why the flag cannot be `true`

**n8n Code nodes cannot access credentials, by design, on any version.**
`this.getCredentials()` and `$getCredentials` do not exist inside that sandbox,
and the expression base map exposes no `$credentials`, `$vars` or `$secrets`.
This is documented behaviour, not a gap — see n8n's Code node documentation and
its "environment variables" security page.

Both public webhooks verify an HMAC signature inside a Code node, and that node
has exactly one way to obtain the shared secret: `$env.ORDER_INTAKE_HMAC_SECRET`.
Block env access and the read returns nothing, the signature never matches, and
every legitimate request is rejected.

The flag also governs **expressions**, not just Code nodes, so setting it `true`
would additionally break non-secret configuration references throughout the
workflows.

### What that would have exposed, and what it exposes now

With the flag `false`, any Code node on the instance can read the process
environment of the container it runs in. The question that matters is therefore
not *whether* `$env` is readable — it is *what is in there to read*.

It used to be everything. Both n8n services were given the whole `.env` file, so
a Code node could read the database password, the broker password, the encryption
key, the n8n API key and both provider API keys. Measured from inside a Code
node, before and after the change:

| Read via `$env` in a Code node | Before | Now |
| --- | --- | --- |
| `ORDER_INTAKE_HMAC_SECRET` | readable | **readable — by necessity** |
| `POSTGRES_PASSWORD` | readable | **not present** |
| `DB_POSTGRESDB_PASSWORD` | readable | **not present** |
| `QUEUE_BULL_REDIS_PASSWORD` | readable | **not present** |
| `N8N_ENCRYPTION_KEY` | readable | **not present** |
| `N8N_API_KEY` | readable | **not present** |
| `LLM_PRIMARY_API_KEY` / `LLM_FALLBACK_API_KEY` | readable | **not present** |

**Exactly one secret is reachable from a Code node, and it is the one whose
entire purpose is to be read by that Code node.**

### How the other secrets were removed

Two mechanisms, both first-party n8n or Docker:

1. **`_FILE` indirection** for the three secrets n8n itself consumes —
   `N8N_ENCRYPTION_KEY`, `DB_POSTGRESDB_PASSWORD` and
   `QUEUE_BULL_REDIS_PASSWORD`. n8n reads each from a mounted file, so the value
   never enters the process environment and `$env` cannot reach it *even with the
   flag `false`*. It also keeps the value out of `docker inspect` output.

   n8n documents `_FILE` for *most* variables, not all, so each of these three was
   measured on this version rather than assumed — pointing `_FILE` at a missing
   path (n8n must refuse to start) and then at a real file with the plain form
   removed (the dependent service must come healthy).

2. **Scoped delivery.** The n8n services no longer read `../.env` at all. They
   read `deployment/secrets/n8n.env`, generated by
   [`../tools/materialise-secrets.mjs`](../tools/materialise-secrets.mjs) from an
   explicit allowlist. Secrets that are not n8n's to hold — the postgres and
   valkey passwords, the API key, the provider keys — are simply never handed to
   it. The provider keys reach n8n as **stored credentials**, which is the
   mechanism that keeps them out of `$env` in the first place.

> **Never set a variable in both `VAR` and `VAR_FILE` form.** On this version the
> plain environment form **wins** and `_FILE` is ignored — measured in both
> directions. It does not error, warn, or fail a health check; it just silently
> reverts the indirection to a no-op. [`../tests/env-file-precedence.test.js`](../tests/env-file-precedence.test.js)
> makes the collision impossible to introduce by accident.

### The claim is a build gate, not a paragraph

[`../tests/env-secret-surface.test.js`](../tests/env-secret-surface.test.js)
enumerates the rendered compose environment for **both** n8n services and fails
if any secret-shaped value is present other than the single allowlisted
`ORDER_INTAKE_HMAC_SECRET`. Adding a second secret **breaks the build**.

It checks both services because in queue mode there are two execution hosts: the
webhook path runs the Code node on `n8n-worker`, and the documented on-demand
path `npm run wf:run` runs it on `n8n`. It matches on variable **names** and on
**values**, so renaming a secret to something innocuous does not evade it.

### The stronger claim: exactly one `$env` reference in the whole workflow corpus

The gate above bounds what a Code node *could* read. A second gate bounds what
the workflows actually *do* read, and it is the stronger statement:

**Every `$env` reference in every shipped workflow is `ORDER_INTAKE_HMAC_SECRET`.
There is exactly one, and it is the one that cannot be anything else.**

The four URL variables the workflows used to read — `UPSTREAM_API_URL`,
`ALERT_WEBHOOK_URL`, `CRM_DELTA_URL` and `CRM_SYNC_URL` — were configuration, not
secrets, but they still had to be delivered into the container for `$env` to
resolve them. Each workflow now carries its own configuration in a labelled
**`Workflow Config`** node at its head, and the nodes that need a value reference
that node instead:

```
"url": "={{ $('Workflow Config').first().json.ALERT_WEBHOOK_URL }}"
```

This is the pattern the n8n community converged on — one obvious place per
workflow, referenced rather than repeated. It is deliberately **not** the
alternative of pasting the URL into the node that uses it, which is the
most-cited mistake in published n8n workflows: it trades an auditable reference
for a hidden one and scatters the same value across a canvas.

Because no workflow reaches for them any more, those four variables — plus
`LLM_PRIMARY_BASE_URL` and `LLM_FALLBACK_BASE_URL`, which only ever had a
host-side consumer — were removed from the allowlist in
[`../tools/materialise-secrets.mjs`](../tools/materialise-secrets.mjs). The
narrow env file the n8n services receive went from nine variables to **three**.
They are not merely unreferenced; they are no longer present to reference.

[`../tests/env-corpus-surface.test.js`](../tests/env-corpus-surface.test.js)
enforces this by reading **every shipped workflow file** and failing if any
`$env` reference appears other than the one secret. It matches `$env.NAME`,
`$env["NAME"]` and `$env['NAME']` — all three, because a matcher that saw only
dot-notation would report a clean corpus while a bracket-form reference sat in
it. It also sweeps every workflow file for the *values* of `.env` secrets, so a
config node cannot become a hiding place for the thing this whole section removes.

Two companion gates keep the pattern honest as it scales:
[`../tests/workflow-config-consistency.test.js`](../tests/workflow-config-consistency.test.js)
fails the build if a value shared by two workflows drifts apart between their
config nodes, or if a config value is an expression that could reach back into
`$env`; and
[`../tests/dlq-replay-destination-map.test.js`](../tests/dlq-replay-destination-map.test.js)
executes the replayer's destination map against every producer, including the
unknown-producer error path.

### Defence in depth: credential-backed Header Auth

Both public webhooks additionally require an authentication header, backed by a
stored n8n credential — the credential mechanism the platform *does* support.

This is **additive to** the HMAC check, not a replacement for it. The two answer
different questions:

- **Header Auth** answers *who is calling*. n8n evaluates it at the HTTP layer,
  **before an execution is queued**, so in queue mode an unauthenticated request
  costs no worker cycle and no row in the execution log. Rejected with **403**.
- **HMAC over the raw body** answers *is this message authentic and untampered*.
  It runs inside the workflow, in constant time. Rejected with **401**.

Either alone leaves a real gap: Header Auth alone lets a token-holder send any
body, and HMAC alone lets an anonymous caller burn an execution before the
signature is checked. Keeping the two rejections on distinct status codes is
deliberate — it is how an operator tells "unknown caller" from "known caller,
tampered payload".

Each webhook holds **its own** credential, so a compromised caller on one
endpoint can be revoked without taking the other down. The credentials are
provisioned headlessly via `import:credentials`; the import file is written to a
git-ignored path and deleted in the same step, and
[`../tests/credential-import-hygiene.test.js`](../tests/credential-import-hygiene.test.js)
asserts it is absent from the working tree **and from git history**.

### Why the JWT redesign was considered and declined

The obvious way to make the flag `true` is to stop needing `$env` in a Code node
at all: drop the HMAC check and authenticate the webhook with n8n's built-in JWT
auth, which is credential-backed.

It was declined:

- It **trades a standard pattern for an unusual one**. HMAC-over-raw-body is what
  Stripe, GitHub, Shopify and Slack actually send. A JWT-only webhook cannot
  verify a provider-signed payload at all, so the redesign narrows what this
  stack can integrate with.
- It **answers a different question**. JWT establishes who is calling; it says
  nothing about whether the body was tampered with in transit. Header Auth above
  already covers the caller-identity half, and it does so without discarding
  payload authenticity.
- It **would delete the strongest evidence in the repo** — the failure-injection
  suite around constant-time signature verification, including the tampering case
  where a signature valid in isolation is computed over different bytes than
  those sent.
- The exposure it buys back is **already gone**. With one secret in `$env`, the
  redesign would remove a single reachable value, at the cost of everything above.

An engineer who knows n8n already knows Code nodes cannot read credentials.
Meeting that constraint stated precisely, bounded, and enforced by a test reads
as command of the platform; meeting a redesign that quietly avoids it does not.

### `N8N_ENCRYPTION_KEY` — set it, keep it, back it up

n8n encrypts every stored credential at rest with `N8N_ENCRYPTION_KEY`. If it is
absent at first boot, n8n generates one and writes it into its own config.

**Losing or changing this key makes every stored credential permanently
undecryptable. There is no recovery path** — the credentials must be deleted and
re-created by hand. That now includes the Postgres credential, both provider
credentials, and the two webhook Header Auth credentials, so an instance that
loses this key loses the ability to authenticate its own webhooks.

Set it explicitly before the first production boot, keep it stable across
restarts, and back it up somewhere other than the machine running the stack. In
this stack it is delivered by `N8N_ENCRYPTION_KEY_FILE`, so the value is a file
you can back up directly and never appears in the environment or in
`docker inspect`.

### The residual risk, stated plainly

One secret remains reachable from any Code node on the instance. The trust
boundary therefore still sits at **"who may edit workflows"**: an author who can
add a Code node can read `ORDER_INTAKE_HMAC_SECRET` and forge webhook
signatures — though not, now, reach the database, the broker, the encryption key
or the provider accounts.

That residue is irreducible without abandoning HMAC verification. It is bounded
to its minimum, measured from inside the sandbox where the risk lives, and
enforced by a test that fails the build if it ever grows.

## Verify queue mode

In queue mode the main instance does not execute workflows itself — it enqueues
them and a worker pulls them off the broker. So a completed execution is proof
the full enqueue → broker(auth) → worker → execute round-trip worked:

```bash
docker compose -f deployment/docker-compose.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select workflowId, finished, status from execution_entity order by \"startedAt\" desc limit 5;"
```

The automated proof lives in [`../tests/queue-mode.test.js`](../tests/queue-mode.test.js).
