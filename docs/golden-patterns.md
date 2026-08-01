# Golden patterns

Eleven patterns that separate a workflow that survives production from one that
works on the first try and fails quietly afterwards.

**Every pattern here is implemented by a workflow in this repository.** Each entry
names that workflow, so the claim can be checked rather than believed. Where a
linter rule catches the *inverse* of a pattern, the rule is named too. Patterns
with no rule are tagged **`[structural]`** — a static check on a single file
cannot see them, and the honest thing is to say so rather than imply coverage
that does not exist.

| Pattern | Implemented by | Rule |
|---|---|---|
| [GP-01](#gp-01--wire-the-error-handler-first) error-handler-first | wf01, wf02, wf03 | R1 |
| [GP-02](#gp-02--idempotency-before-the-side-effect) idempotency-before-side-effect | wf01 | `[structural]` |
| [GP-03](#gp-03--retry-with-stopworkflow-the-9236-defence) retry with `stopWorkflow` | wf01 | R4 |
| [GP-04](#gp-04--validate-before-you-act) validate-before-act | wf01 | R7 |
| [GP-05](#gp-05--authenticate-the-webhook-twice-and-compare-in-constant-time) webhook auth, constant-time | wf01, wf03 | R6 |
| [GP-06](#gp-06--rate-limit-by-batching-and-waiting-not-by-retrying) rate-limit via batching + Wait | wf02 | `[structural]` |
| [GP-07](#gp-07--pin-the-timezone-on-every-schedule) timezone-explicit schedule | wf02 | R9 |
| [GP-08](#gp-08--watch-for-silence-not-just-for-errors) stale-run watchdog | sync-watchdog | `[structural]` |
| [GP-09](#gp-09--isolate-partial-failure-to-a-dead-letter-queue-with-a-replay) partial-failure to DLQ + replay | wf02, dlq-replay | R13 |
| [GP-10](#gp-10--separate-parsing-from-the-model-and-validate-the-shape) separate-parse + schema validation | wf03 | R10, R11 |
| [GP-11](#gp-11--fall-back-to-a-provider-that-fails-independently) provider fallback + degradation | wf03 | R12 |

---

## GP-01 · Wire the error handler first

**Implemented by** [`01-order-intake/`](../01-order-intake/),
[`02-crm-sync/`](../02-crm-sync/), [`03-support-triage/`](../03-support-triage/)
· **Rule R1**

Every production workflow sets `settings.errorWorkflow` to a shared handler —
[`_shared/global-error-handler/`](../_shared/global-error-handler/) — before it
does anything else. The handler receives the failed workflow's name and execution
id and raises an alert carrying both.

**Why first.** An unhandled failure in n8n is not loud. The execution is marked
failed in a list nobody is watching, and the workflow appears to be running fine.
Wiring the handler after the logic means every failure during development is
invisible, which is exactly when you most need to see them.

The execution id in the alert is what makes it actionable: an alert saying
"wf02 failed" starts an investigation, one carrying the execution id ends it.

**The inverse, R1:** a workflow with no `errorWorkflow` configured. Error handlers
themselves are exempt — a handler pointing at itself loops.

## GP-02 · Idempotency before the side effect

**Implemented by** [`01-order-intake/`](../01-order-intake/) · **`[structural]`**

Before the order is forwarded anywhere, its id is inserted into
`idempotency_keys` under a **unique constraint**. The insert is the claim. If it
fails on conflict, this delivery is a duplicate and the workflow stops without
repeating the side effect.

**Why a constraint rather than a check.** The obvious implementation — `SELECT`,
then `INSERT` if absent — has a race between the two statements. Two concurrent
deliveries of the same order both see nothing and both proceed. It survives
testing because tests rarely fire concurrent duplicates, and fails in production
during precisely the retry storm it was meant to protect against. A single
`INSERT` that the database rejects is atomic and has no window.

**Why it comes before the side effect, not after.** Claiming afterwards means the
side effect already happened. The claim is only a claim if nothing irreversible
precedes it.

**Tagged structural:** no static rule can decide whether a given insert is an
idempotency claim, or whether the node order puts it before the side effect. This
is a design property, verified by the failure-injection tests — which deliver the
same order twice and assert exactly one row downstream — not by the linter.

## GP-03 · Retry with `stopWorkflow`, the #9236 defence

**Implemented by** [`01-order-intake/`](../01-order-intake/) · **Rule R4**

Side-effecting network calls carry `retryOnFail` with bounded attempts, and
`onError` is set to `stopWorkflow`.

**Why the `onError` setting is the load-bearing half.** This is the trap behind
[n8n issue #9236](https://github.com/n8n-io/n8n/issues/9236): with
`onError: continueRegularOutput`, a node's retries happen, all of them fail, and
the workflow *continues down the success path anyway* carrying an error object
where the response should be. Downstream nodes act on it. The retry configuration
looks correct in the editor, the execution is marked successful, and the failure
is silent.

Configuring retries without checking the error behaviour is the most common way a
workflow appears hardened and is not.

**The inverse, R4:** a side-effecting network or messaging node with no
`retryOnFail`. Which nodes count is declared in
[`../linter/side-effecting-nodes.json`](../linter/side-effecting-nodes.json), so
classifying a new node is a data change.

## GP-04 · Validate before you act

**Implemented by** [`01-order-intake/`](../01-order-intake/) · **Rule R7**

The inbound payload is checked for the fields the workflow depends on before any
side effect. A payload that fails is rejected with a 4xx and stops — it is not
dead-lettered, because there is nothing to retry: the same bad request will be
just as bad next time.

**Why rejection, not dead-lettering.** Dead-lettering is for work that *should*
have succeeded. Putting malformed input there fills the queue with items no
replay can ever process, and buries the transient failures that replay exists for.

**The inverse, R7:** a node configured to swallow its error into the normal
output path. That is the mechanism by which "validate before you act" is most
often violated in practice — not by omitting a check, but by letting a failed one
flow onward as if it had passed.

## GP-05 · Authenticate the webhook twice, and compare in constant time

**Implemented by** [`01-order-intake/`](../01-order-intake/),
[`03-support-triage/`](../03-support-triage/) · **Rule R6**

Two independent controls, answering two different questions:

1. **Header Auth**, checked by n8n *before an execution is created*. Answers
   "who is calling". An unauthenticated request never reaches the workflow, so it
   cannot consume an execution slot or a paid API call.
2. **HMAC-SHA256** over the raw body bytes, verified in a Code node with
   `crypto.timingSafeEqual`. Answers "is this message authentic and untampered".

They are complementary, not alternatives. Header Auth alone permits a valid caller
to send tampered content; HMAC alone lets any anonymous caller cost you an
execution before being rejected.

**Constant-time comparison matters.** `a === b` on strings returns as soon as it
finds a differing byte, so the time it takes leaks how much of a guessed
signature was right — enough, over many attempts, to reconstruct one.
`timingSafeEqual` always takes the same time.

**Signing over the raw bytes matters just as much.** Re-serialising the parsed
body before verifying produces a different byte sequence — key order, whitespace,
number formatting — and the signature stops matching for reasons that look like a
bug rather than an attack.

Each of the two webhook surfaces holds a **different** Header Auth token so one
leaked caller does not open both doors, while both share the single HMAC secret.

**The inverse, R6:** a secret written as a literal in the workflow instead of
referenced. No static rule can prove a signature check is *correct* — the test
suite does that, by sending a signature computed over different bytes than the
ones delivered and asserting rejection.

## GP-06 · Rate-limit by batching and waiting, not by retrying

**Implemented by** [`02-crm-sync/`](../02-crm-sync/) · **`[structural]`**

Records are processed with SplitInBatches and a Wait between batches, pacing the
workflow under the downstream API's limit rather than discovering it.

**Why not just retry on 429.** Retrying into a rate limit adds load to a service
that has already said it has too much, and with several workers it converges on a
synchronised retry storm. Retry is the recovery path; pacing is what stops you
needing it.

**Tagged structural:** the correct batch size and wait depend on a quota the
linter cannot know. A rule firing on "no Wait node" would flag every workflow
whose downstream has no limit.

## GP-07 · Pin the timezone on every schedule

**Implemented by** [`02-crm-sync/`](../02-crm-sync/) · **Rule R9**

The workflow sets an explicit IANA timezone in `settings.timezone` rather than
inheriting the instance default.

**Why.** A schedule inheriting the instance timezone silently changes meaning when
the instance moves, when the host's zone changes, or when the deployment is
copied to another region. A nightly job set for 02:00 becomes 02:00 somewhere
else, and the daily window it reads shifts under it — so it re-reads or skips
records with no error. Under a zone that observes daylight saving, one run a year
happens twice and one never happens at all.

`GENERIC_TIMEZONE` is set on the containers as well, so the default is defined
even for workflows that forget.

**The inverse, R9:** a Schedule Trigger in a workflow with no explicit timezone.

## GP-08 · Watch for silence, not just for errors

**Implemented by** [`_shared/sync-watchdog/`](../_shared/sync-watchdog/) ·
**`[structural]`**

An hourly workflow alerts when a sync has not **succeeded** within its threshold.

**Why "succeeded" is the whole design.** A watchdog asking "did it run?" sees a
nightly job that runs and fails every night as perfectly healthy, and stays
silent through the entire outage. `sync_heartbeat` records `last_run_at` and
`last_success_at` as separate columns and the watchdog reads the second.

A sync that has **never** succeeded is treated as stale rather than as missing
data — otherwise the worst case is the one case that never alerts.

**Tagged structural:** the watchdog is a *different workflow*, and a single-file
linter cannot see it. Why that rule is deferred rather than written is set out in
[`../linter/ROADMAP.md`](../linter/ROADMAP.md).

## GP-09 · Isolate partial failure to a dead-letter queue, with a replay

**Implemented by** [`02-crm-sync/`](../02-crm-sync/),
[`_shared/dlq-replay/`](../_shared/dlq-replay/) · **Rule R13**

One record failing does not fail the batch. The failure is written to
`dead_letter` with enough context to reprocess it, the rest of the batch
continues, and a separate replay workflow reprocesses outstanding rows —
claiming each with a single atomic statement so a second replay is a no-op.

**The watermark is the subtle part.** `sync_watermark` advances only as far as
the last record that succeeded **with no failure before it**. Advancing past a
failure would mark unprocessed records as done and lose them silently; not
advancing at all would reprocess the whole history every run.

**A dead-letter queue with no replay is a log.** The replay is what makes it a
queue, and its correctness requirement is that reprocessing twice must not
double-process — hence the atomic claim.

**The inverse, R13:** resumable state kept in workflow static data. A watermark
there is invisible to SQL, unbacked up, easily reset by an edit, and unusable by
a second worker. This state belongs in the database.

## GP-10 · Separate parsing from the model, and validate the shape

**Implemented by** [`03-support-triage/`](../03-support-triage/) ·
**Rules R10, R11**

The model's answer is extracted and parsed by a deterministic Code node, then
validated against
[`../schemas/triage-output.schema.json`](../schemas/triage-output.schema.json).
Only an answer satisfying the schema reaches anything that acts.

**Parsing is not validation.** `{"urgency": 7, "requires_human": "probably"}` is
valid JSON and completely unactionable. The schema is what rejects it — and that
is the case a parse-only implementation misses entirely, because nothing throws.

**Why not a second model to repair the first.** A repair chain fails when models
fail, so it is least available exactly when it is most needed; it costs a second
billable call and its latency on every failure; and it has a third outcome that
deterministic parsing does not — plausible output that is subtly wrong, which
looks like success. The reasoning is recorded in
[`../03-support-triage/DESIGN-DECISIONS.md`](../03-support-triage/DESIGN-DECISIONS.md).

**The inverses:** R10, a model's answer reaching a side-effecting node without
passing through validation; R11, an auto-fixing output parser.

## GP-11 · Fall back to a provider that fails independently

**Implemented by** [`03-support-triage/`](../03-support-triage/) · **Rule R12**

The fallback chain is a different node type, a different credential, and a
different vendor endpoint. When neither provider returns anything usable, the
ticket is queued for a human with the raw output attached, and the failed
automation is dead-lettered.

**A fallback sharing fate with the primary buys nothing.** A retry against the
same endpoint, or a "backup" model from the same vendor, fails for the same
reason at the same moment — while costing latency and money on every real
failure. It passes review because there are visibly two of something.

**Knowing what to fall back *on* is the other half.** Unusable *output* falls
back to the second provider. A dead *provider* does not — it stops the workflow
and raises an alert, so the caller redelivers. Falling back on a transport error
would make a total primary outage invisible: every request still returns 200,
spend doubles, and nobody finds out until the invoice.

**Graceful degradation has a floor.** When automation cannot produce a usable
answer, the ticket reaches a person rather than vanishing. Degrading to "nothing
happened" is not degradation.

**The inverse, R12:** a workflow that acts on a model's answer with only one
vendor behind it. `vendor` in
[`../linter/llm-nodes.json`](../linter/llm-nodes.json) is what makes this
meaningful — two nodes from the same vendor are one provider.

---

Each pattern's failure mode, and the defence wired against it, is catalogued in
[`failure-mode-taxonomy.md`](failure-mode-taxonomy.md). The rules are catalogued
with their incidents in [`anti-patterns.md`](anti-patterns.md). How any of it is
verified is in [`testing.md`](testing.md).
