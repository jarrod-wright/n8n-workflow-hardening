# Failure-mode taxonomy

Six classes of failure a production workflow meets, what each one demands, and
the workflow in this repository that demonstrates the defence.

The classes are separated by **what the correct response is**, not by what the
error looks like. That is the distinction that matters: treating a permanent
failure as transient produces an infinite retry, and treating a transient failure
as permanent throws away work that would have succeeded a second later.

| Class | Failure | Correct response | Demonstrated by |
|---|---|---|---|
| [FC-01](#fc-01--transient-network-5xx-timeout) | transient — network, 5xx, timeout | bounded retry with backoff, then stop | wf01 |
| [FC-02](#fc-02--permanent-and-non-retryable-4xx-bad-data) | permanent — 4xx, bad data | dead-letter, never retry forever | wf01, wf02 |
| [FC-03](#fc-03--input-validation) | invalid input | reject before any side effect | wf01 |
| [FC-04](#fc-04--silent-skip-a-scheduled-run-that-never-happened) | silent skip — a run that never happened | watchdog on absence of success | wf02, sync-watchdog |
| [FC-05](#fc-05--rate-limit-and-throttling-429) | rate limit, 429 | batch, wait, back off | wf02 |
| [FC-06](#fc-06--model-output-malformation-and-provider-outage) | model malformation, provider outage | parse, validate, fall back, degrade | wf03 |

---

## FC-01 · Transient — network, 5xx, timeout

**Defence:** bounded retry with backoff, and `onError: stopWorkflow`.
**Demonstrated by** [`01-order-intake/`](../01-order-intake/).

The call would have succeeded a moment later: a dropped connection, a 503 during
a deploy, a timeout under load. Retrying is right, and retrying **forever** is
not — an unbounded retry against a service that is down converts one failing
workflow into sustained load on a service trying to recover.

The half that is usually missed is what happens when the retries are exhausted.
With the default continue-on-error behaviour the workflow proceeds down the
success path carrying an error object, and downstream nodes act on it while the
execution is recorded as successful. `stopWorkflow` is what makes the failure a
failure — see [n8n issue #9236](https://github.com/n8n-io/n8n/issues/9236) and
[GP-03](golden-patterns.md#gp-03--retry-with-stopworkflow-the-9236-defence).

**Retries require idempotency.** A retried side effect that is not idempotent
duplicates work — which is why the idempotency claim
([GP-02](golden-patterns.md#gp-02--idempotency-before-the-side-effect)) comes
before the retryable call, not after it.

**Verified by:** a failure-injection test that makes the upstream fail a set
number of times and asserts both the retry count *and* the side-effect count. Two
counters, because a retry count alone cannot tell "retried three times, acted
once" from "retried three times, acted three times".

## FC-02 · Permanent and non-retryable — 4xx, bad data

**Defence:** dead-letter with enough context to reprocess; never retry forever.
**Demonstrated by** [`01-order-intake/`](../01-order-intake/),
[`02-crm-sync/`](../02-crm-sync/).

A 400 will be a 400 next time. A record referencing something that does not exist
will still reference it in an hour. Retrying a permanent failure burns quota and
delays every item behind it, and the workflow never drains.

The record goes to `dead_letter` with its payload and the error, one failing
record does not fail the batch, and
[`_shared/dlq-replay/`](../_shared/dlq-replay/) reprocesses outstanding rows once
the underlying problem is fixed — claiming each atomically so a second replay is
a no-op.

**Telling FC-01 from FC-02 is the actual engineering.** Status code alone is not
enough: a 429 is a 4xx that *is* retryable (FC-05), and a 500 from a permanently
malformed request is a 5xx that is not. The workflow branches on the specific
condition rather than on the class of the code.

**Verified by:** a test asserting the dead-letter row exists, carries the payload
and the error, and that replay reprocesses it exactly once.

## FC-03 · Input validation

**Defence:** reject before any side effect. Do not dead-letter.
**Demonstrated by** [`01-order-intake/`](../01-order-intake/).

Structurally invalid input is refused with a 4xx and the workflow stops. Nothing
is written, nothing is forwarded, and nothing is queued.

**Why not dead-letter it.** Dead-lettering is for work that should have
succeeded. Malformed input never should have, so it would sit in the queue
forever, be replayed forever, and bury the transient failures the queue exists
for. A dead-letter queue full of items no replay can process is a queue nobody
reads.

Authentication failure is the same shape: an unsigned or wrongly signed request
is rejected before any provider is called, so an unauthenticated caller can never
cost you a paid API call.

**Verified by:** tests asserting that a request missing its identifier, and a
request with a signature computed over different bytes, are both rejected — and
that no row, no queue entry, and no dead-letter record is left behind by either.

## FC-04 · Silent skip — a scheduled run that never happened

**Defence:** a watchdog alerting on the absence of a *success*.
**Demonstrated by** [`02-crm-sync/`](../02-crm-sync/),
[`_shared/sync-watchdog/`](../_shared/sync-watchdog/).

This is the class every other defence misses, because every other defence fires
when something *happens*. A workflow deactivated during an incident and never
reactivated, or broken by an expired credential, produces no errors — it produces
nothing. Dashboards stay green. It is usually found by someone asking why last
week's data is missing.

The watchdog runs on its own schedule and alerts when `last_success_at` is older
than the threshold. Reading *success* rather than *run* is the whole design: a
job that runs and fails nightly looks healthy to a run-based check. A sync that
has never succeeded is treated as stale rather than as absent, so the worst case
is not the one case that never alerts.

**Verified by:** tests covering four states — recent success stays silent, a stale
success alerts, a never-succeeded sync alerts, and recovery goes quiet again.

## FC-05 · Rate limit and throttling — 429

**Defence:** batch, wait between batches, back off on 429.
**Demonstrated by** [`02-crm-sync/`](../02-crm-sync/).

A 429 is a 4xx that is retryable, which is why status class alone is not a
routing decision. Retrying immediately is worse than not retrying: it adds load
to a service that has just said it has too much, and across several workers the
retries synchronise into a storm.

Pacing comes first — SplitInBatches with a Wait between batches keeps the
workflow under the limit rather than discovering it. Backoff on a 429 is the
recovery path for when pacing was wrong, honouring `Retry-After` when the service
sends it.

**Verified by:** a mock upstream that answers 429 with `Retry-After` once a
window is exceeded, and a test asserting the workflow slows down and completes
rather than failing or hammering.

## FC-06 · Model output malformation and provider outage

**Defence:** deterministic parse → schema validation → independent provider
fallback → graceful degradation to a human.
**Demonstrated by** [`03-support-triage/`](../03-support-triage/).

Two failures with the same appearance and different correct responses.

**Unusable output** — fenced JSON, prose around the answer, an empty string, or
JSON that parses but violates the contract — falls back to the second provider,
which is a different node type, a different credential, and a different vendor. A
deterministic Code node does the parsing, and the schema does the validating; the
`{"urgency": 7}` case is why parsing alone is not enough.

**A dead provider** does not fall back. It stops the workflow and raises an alert,
so the caller redelivers. Falling back on a transport error would make a total
primary outage invisible: every request still returns 200, spend silently
doubles, and nobody finds out until the invoice arrives.

When neither provider produces anything usable, the ticket is queued for a human
with the raw output attached and the automation is dead-lettered. Degrading to
"nothing happened" is not degradation.

**Verified by:** tests asserting against the transport and the database rather
than the workflow's own account of itself — which provider was actually called,
in what order, how many times, and what was actually stored.

---

The patterns these defences implement are in
[`golden-patterns.md`](golden-patterns.md); the static rules that catch their
inverses are in [`anti-patterns.md`](anti-patterns.md); how any of it is measured
is in [`testing.md`](testing.md).
