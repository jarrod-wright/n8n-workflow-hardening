# 01 · Order intake (wf01)

The reference production workflow. It takes an authenticated order over a
webhook and drives it through validation, exactly-once processing, a bounded
retry, and a dead-letter path — responding to the caller on every branch and
handing unrecoverable failures to the [global error
handler](../_shared/global-error-handler/).

## Flow

```
Order Webhook ─▶ Workflow Config ─▶ Verify HMAC ─▶ Auth OK? ──no──▶ Respond 401
                                                      │yes
                                                      ▼
                                               Validate Order ─▶ Valid? ──no──▶ Respond 400
                                                                    │yes
                                                                    ▼
                                                          Idempotency Insert ─▶ Is New? ──no──▶ Respond 200 (duplicate)
                                                                                   │yes
                                                                                   ▼
                                                                             Call Upstream ──success──▶ Respond 200 (ok)
                                                                                   │ (retries, then error)
                                                                                   ▼
                                                                              DLQ Insert ─▶ Respond 502 ─▶ Stop And Error ─▶ error workflow
```

## The hardening decisions

- **Authentication — HMAC over the raw body.** The webhook keeps the raw request
  bytes (`options.rawBody`), and `Verify HMAC` recomputes `HMAC-SHA256(secret,
  rawBody)` and compares it to the `x-signature` header with a **constant-time**
  compare (`crypto.timingSafeEqual`). Signing the raw bytes — not a
  re-serialized object — is what makes the signature verifiable. The secret is
  read from `ORDER_INTAKE_HMAC_SECRET`, never hardcoded.

  The `Verify HMAC` node itself is byte-identical to the pre-`Workflow Config`
  version, proven by content hash at both commits. That is a claim about the
  **node**, not about the **path**: since `Workflow Config` was introduced the
  webhook no longer feeds `Verify HMAC` directly, so the authentication path did
  change even though the verifying code did not. The signed bytes survive the
  extra hop because `Workflow Config` is a Set node with
  `includeOtherFields: true`, which passes the webhook item through untouched —
  and that is what the green HMAC tests demonstrate. The hash proves the first
  claim; the tests are what carry the second.
- **Validation** happens before any side effect: `order_id` must be a non-empty
  string and `amount` a positive number, else `400`.
- **Exactly-once — atomic unique-constraint insert.** `Idempotency Insert` runs

  ```sql
  WITH ins AS (
    INSERT INTO idempotency_keys (idempotency_key, order_id, execution_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key
  )
  SELECT EXISTS (SELECT 1 FROM ins) AS inserted;
  ```

  The `idempotency_key` primary key makes this the single point of truth: the
  first delivery inserts and returns `inserted = true`; any retry or duplicate
  delivery conflicts and returns `false`, short-circuiting to a `200 duplicate`
  response without re-calling the upstream. The check and the claim are one
  atomic statement, so two concurrent deliveries can't both win.

  *Alternative:* a broker-side `SET key value NX EX <ttl>` against Valkey is a
  valid idempotency guard when a short dedupe window is acceptable and you don't
  want a durable ledger. This workflow uses the Postgres unique constraint
  because it is durable, survives a broker flush, and doubles as an audit trail.

- **Bounded retry, then dead-letter.** `Call Upstream` retries (`retryOnFail`,
  `maxTries: 3`) and, on exhaustion, routes to its **error output** rather than
  failing silently. That branch writes the order to `dead_letter`, responds
  `502`, and hits `Stop And Error` so the execution is marked failed and the
  **error workflow fires** — the failure is durable (DLQ), visible to the caller
  (502), and alerted (handler). Nothing is dropped.
- **No SQL injection.** Both Postgres nodes bind values as query parameters
  (`$1..$n` via `queryReplacement`); no expression is ever concatenated into the
  SQL string. The structure test enforces this.
- **Pinned node versions.** Every node declares the `typeVersion` from
  [`../typeversions.json`](../typeversions.json).

## Prerequisites

- A Postgres credential the two Postgres nodes reference (id
  `pgcredential0001`, "Postgres order-intake"). Create it in n8n (or import it)
  pointing at the stack's `postgres` service.
- Environment: `ORDER_INTAKE_HMAC_SECRET`, `UPSTREAM_API_URL` (see
  [`../.env.example`](../.env.example)).
- Import and **activate** the global error handler first (an inactive error
  workflow is skipped), then import and activate this workflow.

## Sending a signed order

```bash
SECRET="$ORDER_INTAKE_HMAC_SECRET"
BODY='{"order_id":"ord-1001","amount":42}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')
curl -s -X POST http://127.0.0.1:5678/webhook/order-intake \
  -H 'content-type: application/json' \
  -H "x-signature: sha256=$SIG" \
  --data-raw "$BODY"
# -> {"status":"ok","order_id":"ord-1001"}
```

Send it again with the same body and you get `{"status":"duplicate",...}` — the
upstream is not called a second time.
