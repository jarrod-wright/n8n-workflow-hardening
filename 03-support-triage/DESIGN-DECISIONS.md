# Design decisions — support triage (wf03)

Two decisions in this workflow have a defensible alternative, so the reasoning is
recorded rather than left to be re-derived. Both were choices, not defaults.

---

## 1 — Why a webhook trigger, and when a schedule would be right instead

### The choice

wf03 is triggered by an authenticated **webhook**.

### Why

**Support triage is event-driven.** A ticket's value decays: an outage report
triaged four hours after it arrives has already been overtaken by the incident it
was reporting. Triage is one of the cases where latency is part of correctness,
not a nice-to-have.

**It reuses a hardened front door.** The webhook surface already exists and is
already hardened, from wf01: Header Auth checked by n8n before an execution is
even created, then an HMAC signature verified in constant time over the raw body
bytes. wf03 consumes the *same* HMAC secret and a *different* Header Auth token —
two entry points, one secret, separately revocable callers. Adding a second
trigger class here would have meant a second security surface to reason about for
no gain.

**It makes the repository span both trigger classes.** With wf01 and wf03 on
webhooks and wf02 on a schedule, the three workflows between them demonstrate
event-driven ingress and scheduled batch processing — including the failure modes
unique to each. A third webhook workflow would have added a third example of
something already shown twice.

### When a schedule is the right answer instead

Batch triage on a cadence is correct when:

- **Tickets accumulate in a queue or inbox you poll**, rather than arriving as a
  push. If there is no push, a webhook has nothing to receive, and inventing one
  means building an ingestion service that did not need to exist.
- **Latency is genuinely not part of the requirement** — an overnight backlog
  triaged before the morning shift is worth more than each ticket triaged three
  seconds sooner.
- **Provider cost or rate limits dominate.** Batching amortises overhead and lets
  you pace calls deliberately instead of absorbing whatever arrival rate the
  senders produce.

The pattern for that already exists in this repository: wf02's Schedule Trigger
with an explicit IANA timezone, SplitInBatches, and a Wait between batches to
respect the rate limit, with a Postgres watermark advanced only as far as the
last record that succeeded with no failure before it. Substituting AI triage for
the CRM upsert is a small change to a proven shape — see
[`../02-crm-sync/`](../02-crm-sync/).

A real deployment might well run **both**: a webhook for tickets flagged urgent
at intake, and a scheduled sweep for the long tail. They are not alternatives so
much as different latency budgets.

### What the webhook choice costs

Honesty about the trade: the webhook path inherits webhook problems. The caller
must redeliver on a non-2xx response, because there is no queue in front to
retry from — which is why the workflow answers a failed run with a non-2xx status
rather than a polite 200. Idempotency has to be enforced on the ticket id, since
a redelivering sender will send the same ticket twice. And per-request execution
gives up the batching that would otherwise smooth provider spend.

---

## 2 — Why a deterministic Code-node parser, not a second model

### The choice

The model's answer is parsed and validated by a **Code node** running ordinary
JavaScript — extract the JSON, parse it, validate it against
[`../schemas/triage-output.schema.json`](../schemas/triage-output.schema.json) —
and never by a second model chain.

The obvious alternative, and the one n8n makes easiest to reach for, is an
auto-fixing output parser: when the first model returns something unusable, send
it to another model with "fix this JSON".

### Why the Code node wins

**It is testable.** A deterministic parser returns byte-identical output for
identical input, so the fixture suite can assert exactly what it does with fenced
JSON, with prose wrapped around JSON, with an empty string, and with JSON that
parses but violates the contract. A repair chain's behaviour is a distribution,
not a value: you cannot write an assertion about what it will return, only about
what it usually returns.

**It cannot fail in the same way as the thing it is protecting.** A repair chain
is a model call, so it fails when models fail — the outage, the rate limit, the
malformed response. Reaching for a second model to fix the first model's output
is the same fate-sharing mistake as a "fallback" pointing at the same vendor. The
repair path is most likely to be needed exactly when it is least likely to work.

**It is free and instant.** Parsing costs microseconds and nothing. A repair
chain adds a second billable call and its full latency to every failure, in a
path that runs precisely when things are already going wrong.

**It fails loudly.** A parser either produces a value satisfying the schema or it
does not, and "it does not" is a branch the workflow handles: fall back to the
second provider, and if that also fails, queue the ticket for a human with the
raw output attached. A repair chain has a third outcome — plausible output that
is subtly wrong — and that one is invisible. It is the failure mode that reaches
production, because it looks like success.

This is codified as linter rule **R11** (auto-fixing output parser), with its
rationale in [`../docs/anti-patterns.md`](../docs/anti-patterns.md).

### The schema is the actual contract

Parsing is necessary but not sufficient. `{"urgency": 7, "requires_human":
"probably"}` is perfectly valid JSON and completely unactionable. The JSON Schema
is what rejects it: `urgency` must be one of the enumerated levels,
`requires_human` must be a boolean. The test suite asserts this case
specifically, because it is the one a parse-only implementation misses entirely.

### When an LLM repair chain *is* appropriate

Not never — the trade just has to be worth it:

- **High-value, low-volume items** where a parse failure is expensive enough to
  justify a second billable call, and the volume is low enough that the added
  latency and spend stay bounded.
- **After deterministic parsing has been tried and failed**, never in front of
  it. Repair is a last resort before a human, not a first response.
- **Never for anything that then acts unreviewed.** If a repaired answer goes
  straight to a side-effecting node, a plausible-but-wrong repair becomes a
  wrong action with no one in the loop.
- **With the repair on a different vendor from the primary**, for the same
  fate-sharing reason the provider fallback uses a different vendor.

wf03 meets none of the first two conditions: triage is high-volume and
individually low-value, so the deterministic parser plus a genuinely independent
provider fallback plus a human queue is both cheaper and more predictable.

---

## What the tests hold to these decisions

Neither decision is enforced by prose. `tests/support-triage-failure-injection.test.js`
asserts, against the transport and the database rather than the workflow's own
account of itself:

- unparseable output is rescued by the **fallback provider**, not by a repair
  call — and the provider counters prove the order;
- output that parses but breaks the schema is rejected exactly as firmly as
  output that does not parse;
- when neither provider returns anything usable, the ticket reaches a human with
  the raw output attached, and exactly two provider calls were made;
- a provider **outage** stops the workflow and raises an alert instead of being
  papered over by the fallback;
- an unsigned, wrongly signed, or tampered request is rejected before any
  provider is called at all.
