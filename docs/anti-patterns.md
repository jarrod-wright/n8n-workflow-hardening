# n8n production anti-patterns

Every linter rule exists because a specific, recognisable way of building an n8n
workflow causes a specific production incident. This is that catalogue: the
anti-pattern, why it hurts, and the rule that catches it.

## Headline: retries that silently don't happen (n8n #9236)

The one that surprises people most has its own upstream report,
[n8n-io/n8n#9236 — "HTTP Request Node · Incompatible error handling options"](https://github.com/n8n-io/n8n/issues/9236).

You enable **Retry On Fail** on an HTTP Request node and, in the same node, set
**On Error** to a *continue* option. The reasonable expectation is "retry N
times, then continue." What was reported instead: the node fails once and
continues immediately — the retry configuration is ignored. Your workflow looks
resilient on the canvas and isn't: a single transient blip drops the item, with
no retry and no error.

The lesson isn't "never combine these." It's that **retry behaviour is a claim
you have to test, not a checkbox you can trust.** This repo does exactly that.
The reference workflow ([`01-order-intake`](../01-order-intake/)) sets
`retryOnFail` together with `onError: continueErrorOutput` — the *route-to-error-
output* variant — and a failure-injection test measures the real attempt count
via the mock upstream's counters:

- two injected failures, then success → the upstream is hit **3 times** and the
  order commits once;
- upstream failing forever → the upstream is hit **3 times**, then the item is
  dead-lettered and the error handler fires.

So on the pinned n8n version this repo runs against, retries *do* fire before the
error branch — and it's proven on every test run rather than assumed. Pin your
version, and assert your retry count.

## The rule catalogue

| Rule | Anti-pattern | Incident it prevents |
|---|---|---|
| [R1](#r1--no-error-workflow) | No error workflow configured | Failures vanish — no alert, no dead-letter, no trace. |
| [R2](#r2--unpinned-typeversion) | Node with no pinned `typeVersion` | An n8n upgrade silently changes node behaviour. |
| [R3](#r3--webhook-with-no-response-node) | Webhook `responseNode` with no responder | Callers hang until they time out. |
| [R4](#r4--side-effecting-call-without-retry) | Side-effecting call without retry | A transient blip drops the item. |
| [R5](#r5--sql-built-from-an-expression) | SQL built from an inline expression | SQL injection. |
| [R6](#r6--hardcoded-secret) | Hardcoded secret in a node | Credential leaked into version control. |
| [R7](#r7--errors-swallowed) | Errors continued into the normal output | Failures processed as successes. |
| [R8](#r8--network-call-without-a-timeout) | Network call with no timeout | A stuck upstream ties up workers indefinitely. |
| [R9](#r9--scheduled-workflow-with-no-timezone) | Schedule Trigger with no explicit IANA timezone | A nightly job runs at a different hour after a deploy. |
| [R10](#r10--a-model-answer-acted-on-without-validation) | Model output acted on without validation | Off-contract output is written to a real system. |
| [R11](#r11--a-model-repairing-another-model) | Auto-fixing output parser | The deterministic check is itself a model call. |
| [R12](#r12--one-provider-behind-a-workflow-that-acts) | Single provider behind an acting workflow | One vendor outage stops the automation entirely. |
| [R13](#r13--resumable-state-in-workflow-static-data) | Cursor kept in workflow static data | A re-import silently resets the cursor. |

### R1 · No error workflow

**Anti-pattern.** A production workflow with no `settings.errorWorkflow`.

**Incident.** When an execution fails, nothing happens: no alert, nothing in a
dead-letter table, no operator ever finds out until a customer does. The failure
is invisible.

**Fix.** Point every production workflow at a shared error workflow (see
[`_shared/global-error-handler`](../_shared/global-error-handler/)). Error
handlers themselves are exempt — they can't reference themselves.

### R2 · Unpinned typeVersion

**Anti-pattern.** A node with no explicit numeric `typeVersion`.

**Incident.** Node behaviour is versioned. An unpinned node picks up new default
behaviour on the next n8n upgrade — an expression that used to coerce a value
now doesn't, an option's default flips — and a workflow you didn't touch starts
producing different output. Pin node versions the way you pin image tags (see
[`typeversions.json`](../typeversions.json)).

### R3 · Webhook with no response node

**Anti-pattern.** A webhook set to `responseMode: responseNode` with no Respond
to Webhook node anywhere in the workflow.

**Incident.** The webhook is now waiting for a node that will never run. Every
caller blocks until its own client timeout, which looks like a hung integration
and burns a connection slot the whole time.

**Fix.** Ensure a Respond to Webhook node is reachable on every branch — this
repo's order workflow responds on all five (auth-fail, invalid, duplicate, ok,
dead-lettered).

### R4 · Side-effecting call without retry

**Anti-pattern.** A network or messaging node (per
[`side-effecting-nodes.json`](../linter/side-effecting-nodes.json)) with
`retryOnFail` off.

**Incident.** Networks fail transiently — a DNS hiccup, a rolling deploy on the
upstream, a momentary 503. Without a bounded retry, the first blip drops the
item silently. See the headline above for the subtler failure mode where retry
is configured but skipped.

### R5 · SQL built from an expression

**Anti-pattern.** A database node whose query string interpolates a `{{ }}`
expression instead of binding parameters.

**Incident.** Classic SQL injection: an `order_id` of `'; DROP TABLE orders; --`
is now your query. The fix is query parameters — this repo's Postgres nodes bind
`$1..$n` via `queryReplacement` and never concatenate values into SQL.

### R6 · Hardcoded secret

**Anti-pattern.** A literal secret in a node parameter — a `Bearer` token, a
Basic auth string, a password-named field set to a literal.

**Incident.** The secret is now in git history forever, readable by everyone with
repo access and every fork. Use a credential or an `$env` reference; the rule
treats `={{ $env.X }}` as safe precisely because it's a reference, not a value.

### R7 · Errors swallowed

**Anti-pattern.** A node with `continueOnFail` / `onError: continueRegularOutput`
that merges failed items back into the normal output.

**Incident.** A failed item flows downstream as if it succeeded — a half-built
record gets written, a customer gets a confirmation for an order that never
processed. Routing to a dedicated error output (`continueErrorOutput`) or
stopping is fine; blending errors into the happy path is not.

### R8 · Network call without a timeout

**Anti-pattern.** A network node with no `options.timeout`.

**Incident.** An upstream that accepts the connection but never responds holds
the request open indefinitely. In queue mode that's a worker slot pinned on a
dead call; enough of them and the queue backs up. Set an explicit timeout on
every outbound call.

### R9 · Scheduled workflow with no timezone

**Anti-pattern.** A Schedule Trigger in a workflow whose `settings.timezone` is
unset, or set to something that is not an IANA zone name.

**Incident.** A nightly job scheduled for 02:15 runs against whatever timezone
the n8n instance happens to be configured with, and nothing in the workflow
records which one that was. Move to a new host, change a base image, or fail over
to another region, and 02:15 quietly becomes a different instant — often landing
inside the maintenance window the job was carefully scheduled to avoid. Nothing
errors; the job just starts running at the wrong time.

Pinning an IANA zone makes the schedule a property of the **workflow** rather
than of the machine it happens to be running on. See
[`02-crm-sync`](../02-crm-sync/), which pins `Australia/Brisbane`.

One extra trap, worth knowing before you pick a time: in a zone that observes
daylight saving, a local time inside the transition hour **does not exist** on
the spring-forward date and **occurs twice** on the autumn one. Either schedule
outside that window or accept that one run a year is skipped or duplicated — but
decide it, rather than discover it.

### R10 · A model answer acted on without validation

**Anti-pattern.** The output of an AI Agent or LLM chain reaching a node with a
real side effect — a database write, an HTTP call, a message — without passing
through anything that checks its shape.

**Incident.** The prompt says "reply with only a JSON object", and for weeks the
model does. Then it replies with a fenced block, or a sentence of preamble, or
`"urgency": 7` where the contract says one of four strings, or a category that
does not correspond to any queue you have. A workflow that calls
`JSON.parse($json.output)` throws on the first two. Worse, a workflow that parses
successfully and acts immediately writes the last two straight into a real
system, because **parsing successfully is not the same claim as being usable**.

Parse and validate as two separate steps, in code, against a schema you can
review on its own. [`03-support-triage`](../03-support-triage/) does this: a
deterministic Code node strips fences, parses, and validates against
[`schemas/triage-output.schema.json`](../schemas/triage-output.schema.json), and
its test suite includes a fixture that parses perfectly and still fails the
contract.

### R11 · A model repairing another model

**Anti-pattern.** An auto-fixing output parser, which handles a malformed
response by sending it to a second model and asking for a corrected version.

**Incident.** It is appealing because it makes the error disappear in testing.
What it actually does is make the one step whose entire job is to be
deterministic — deciding whether an answer is usable — into another model call.
Two non-deterministic steps now have to succeed instead of one; every malformed
response costs a second call; and the repair can quietly *change the meaning* of
the answer rather than rejecting it, which is worse than a clean failure because
nothing downstream can tell.

Validate in code. When the answer is unusable, fall back to a different provider
or hand the item to a person — both are outcomes you can reason about afterwards.

### R12 · One provider behind a workflow that acts

**Anti-pattern.** A workflow that takes action on a model's answer, with only one
provider vendor behind it.

**Incident.** Providers have outages, rate limits, capacity rationing and account
suspensions. When the only one is unavailable, an automation that *acts* on its
answer stops doing its job completely — and because the fault is upstream, there
is nothing in the workflow to fix while it is happening. Retrying the same
provider does not help: it fails for the same reason at the same moment.

A second chain on a **genuinely different vendor** is the fix; two nodes from the
same vendor share an outage, a rate limit, and usually an account, so the linter
counts distinct vendors rather than distinct nodes. See
[`03-support-triage`](../03-support-triage/), whose fallback is a different node
type with a different credential against a different endpoint — and whose stored
result records which chain produced it, so a silent drift onto the fallback (the
symptom of a primary that has quietly started failing) shows up in the data.

The rule stays quiet when the answer is not acted on: a workflow that only
summarises something for a human has no automation to keep running, so a second
provider there is cost without resilience.

### R13 · Resumable state in workflow static data

**Anti-pattern.** A sync cursor, watermark, last-seen id or checkpoint kept in
`$getWorkflowStaticData()`.

**Incident.** It is the obvious place to put it, and it fails in three ways that
all surface long after the change that caused them:

- **It does not survive a re-import.** Deploying the workflow silently resets the
  cursor. Either everything is reprocessed, or — if the code treats a missing
  cursor as "start from now" — everything before the deploy is skipped forever.
- **Nothing else can read it.** No watchdog, no operator, no query. When the sync
  is stuck, the single number that would explain why is invisible.
- **It is written at the end of a successful execution.** A run that dies
  part-way leaves it holding a value that does not describe what actually
  happened.

A cursor is state your recovery depends on. Put it in the database, where it can
be read, audited, and corrected by hand at 3am.
[`02-crm-sync`](../02-crm-sync/) keeps it in `sync_watermark`, advances it only
to the last record that succeeded with **no failure before it**, and guards the
update so a replayed run can never rewind it.

---

## Headline: the two traps that need a whole workflow to fix

R1–R13 are each caught by a static check. These two are not — they are absences,
and a linter cannot see a workflow you did not write. Both are demonstrated by
working workflows in this repo rather than described in the abstract.

### Nothing alerts on a workflow that stops running

Every guard in this repo fires when something *happens*: a call fails, a
signature is wrong, a record is rejected. None of them fire when **nothing
happens at all**.

A scheduled workflow that stops being triggered — deactivated during an incident
and never reactivated, or broken by a credential that expired — produces no
errors, because it produces nothing. Dashboards stay green. The only signal is an
absence, and absence is what alerting is worst at noticing. The failure is
typically found by a person asking why last week's data is missing.

The fix is a workflow whose job is to watch for silence:
[`_shared/sync-watchdog`](../_shared/sync-watchdog/) runs hourly and alerts when
a sync has not **succeeded** within its threshold.

No rule in this linter catches the absence of that workflow, and that is a
deliberate limit rather than an oversight: a single-file static check cannot see
a watchdog that lives in another file. What it would take to make the check
sound — repo-scan mode, a workflow graph, and matching a heartbeat key across two
files — is set out in [`../linter/ROADMAP.md`](../linter/ROADMAP.md).

The word *succeeded* is the whole design. `sync_heartbeat` records `last_run_at`
and `last_success_at` as separate columns, and the watchdog reads the second one.
A watchdog reading "did it run?" would see a nightly job that runs every night
and fails every night as perfectly healthy, and stay silent through the entire
outage. It also treats a sync that has **never** succeeded as stale rather than
as missing data — otherwise the worst case is the one case that never alerts.

### The fallback that is not a fallback

The second trap is a fallback that shares fate with the thing it is protecting:
a retry against the same endpoint, a second node with the same credential, a
"backup" model from the same vendor. It passes review because there are visibly
two of something. It buys nothing, because the failure it is meant to survive
takes out both at once — and it costs latency and money on every real failure
while doing so.

A fallback is only a fallback if it fails independently. In
[`03-support-triage`](../03-support-triage/) the second chain is a different node
type, a different credential, and a different vendor endpoint — and the test
suite asserts the two differ, rather than trusting that they do.

Why that workflow parses deterministically instead of asking a second model to
repair the first one's output — the same fate-sharing mistake in a different
place — is recorded in
[`../03-support-triage/DESIGN-DECISIONS.md`](../03-support-triage/DESIGN-DECISIONS.md).

The same workflow shows the other half of the discipline: knowing **what** to
fall back on. Unusable *output* falls back to the second provider. A dead
*provider* does not — it stops the workflow so the caller redelivers. Falling
back on a transport error would make a total primary outage invisible: every
request still returns 200, spend doubles, and nobody finds out until the invoice.
