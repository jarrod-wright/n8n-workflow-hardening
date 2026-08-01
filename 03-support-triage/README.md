# 03 — AI support triage

A signed webhook receives a support ticket, an LLM classifies it, and the result
is written to `triage_result` and routed. If the model's answer is unusable, a
**different** provider is tried; if that is unusable too, a person gets the
ticket and the automation dead-letters itself.

The interesting part of this workflow is not the model. It is everything built
around the assumption that **the model will eventually return something you did
not ask for.**

## The failure this workflow is built around

The prompt says "reply with only a JSON object". Most of the time the model does.
Then one day it replies:

````
Sure! Here's the triage result:

```json
{ "category": "billing", ... }
```

Let me know if you'd like me to adjust the urgency.
````

A workflow that does `JSON.parse($json.output)` throws. A workflow that "handles"
it by asking another model to fix the output has replaced one non-deterministic
step with two. And a workflow that skips validation because the JSON parsed will
happily route a ticket whose `category` is `"sales-enquiry-maybe"` to a queue
that does not exist.

## Structure

```
Ticket Webhook → Verify HMAC → Auth OK? ─┬─(no)→ Respond Unauthorized 401
                                          └─(yes)→ Build Ticket → Ticket Valid? ─(no)→ Respond Invalid 400
                                                                        │(yes)
                                                                        ▼
                                        [Primary Model] ──→ Triage Agent → Parse Triage → Triage Valid? ─(yes)─┐
                                                                                                │(no)           │
                                        [Fallback Model] ─→ Fallback Triage → Parse Fallback → Fallback Valid? ─┤(yes)
                                                                                                │(no)           │
                                                                                                ▼               ▼
                                                            Queue For Human → Dead-letter Ticket        Record Triage
                                                                    ▼                                          ▼
                                                            Respond Needs Human 202                   Respond Triaged 200
```

## Authentication uses the order-intake verification code, character-for-character

HMAC-SHA256 over the exact raw body bytes, constant-time compare — the identical
code the order-intake webhook uses. A test asserts the two implementations are
**character-for-character identical** up to the point where the verdict is
settled.

That test proves the two `Verify HMAC` **node bodies** match. It does not prove
the two authentication **paths** match, and since Sprint 3 they do not: wf01's
webhook now feeds `Workflow Config` before `Verify HMAC`, while wf03's webhook
still feeds `Verify HMAC` directly (see the diagram above). The verification
each performs is identical; what reaches it travels one hop further in wf01.
Both are covered by their own green auth tests, which is the evidence that the
difference is inert — the character-for-character assertion says nothing about
it either way.

That assertion exists because the realistic failure is not someone writing bad
crypto on purpose. It is a second entry point getting a second, slightly
different copy of the same idea, and nobody noticing that one of them compares
with `===`.

## The parser is code, and only code

`Parse Triage` and `Parse Fallback` are ordinary Code nodes that do three things
in a fixed order:

1. **Strip the wrapping.** A fenced block, or prose on either side of one. This
   is not politeness toward the model — it is recognising what models actually
   return, so that a recoverable response never costs a second provider call.
2. **`JSON.parse`.**
3. **Validate against `schemas/triage-output.schema.json`.**

Step 3 is separate from step 2 on purpose. *Parsing successfully is not the same
claim as being usable.* The `schema-violation` fixture in the stack's mock
provider parses perfectly and is still garbage:

```json
{ "category": "sales-enquiry-maybe", "urgency": 7, "summary": "", "requires_human": "probably" }
```

Every field is wrong in a way that only a schema catches: an unroutable category,
urgency as a number, an empty summary, and a boolean that is a word. A router
that trusted `JSON.parse` would act on all of it.

### There is no auto-fixing output parser

n8n ships one. It works by sending a malformed response to *another model* and
asking it to correct it. It is deliberately not used here, and a structure test
asserts the node type appears nowhere in the workflow. The whole point of this
stage is to be the one part of an LLM pipeline that behaves the same way every
single time.

### The schema is a file, and it cannot drift

A Code node cannot read from disk, so the schema is embedded in the parser. An
embedded copy that can silently diverge from a reviewable file is worse than
having no file — so a test parses the literal back out of the node and asserts it
deep-equals `schemas/triage-output.schema.json`.

### The fallback is held to the same standard

Both parsers are byte-identical apart from a one-line provider label, and a test
enforces it. A fallback validated more loosely than the primary is not a
fallback — it is a way to accept output you already decided was unusable.

## The second chain is a second *provider*

`Primary Model` is an OpenAI Chat Model node; `Fallback Model` is a DeepSeek Chat
Model node. Different node type, different credential, different endpoint.

A "fallback" that retries the same provider fails for the same reason at the same
moment — it adds latency and cost and buys nothing. Tests assert the node types
and credential ids differ, and the stack's mock provider serves the two chains on
separate base paths so **which chain answered is observable from the transport**,
not from the workflow's own report of itself.

`triage_result.provider` records it too, so a silent drift onto the fallback —
the symptom of a primary that has quietly started failing — shows up in the data.

## What is bounded

| Control | Value | Why |
|---|---|---|
| `maxIterations` | 3 | an agent with no ceiling can spend unbounded money and wall-clock on one ticket |
| model `timeout` | 20s | a hung provider must not hold the HTTP request open indefinitely |
| model `maxRetries` | 1 | the fallback chain is the real retry; a long internal retry just delays it |
| `temperature` | 0 | a triage router is not a creative writing task |
| agent `onError` | `stopWorkflow` | see below |

### Why a provider outage stops the workflow

A dead provider is not a bad answer to route around — it is a failure. The agent
retries once and then **stops**, which fires the global error handler and leaves
the caller without a 200 so it redelivers.

The alternative — falling through to the fallback chain on a transport error —
sounds appealing but means a total primary outage is invisible: every ticket
still returns 200, the bill doubles, and nobody finds out until the invoice. The
fallback exists for *unusable output*, which is a different fault with a
different correct response.

## When nothing works

The ticket goes to `human_review_queue` **with the raw model output attached**,
and a `dead_letter` row records that automated triage failed, carrying the
parser errors from both chains. The caller gets `202` — accepted, not triaged.

A human queue that does not include what the model actually said just moves the
mystery to a different table.
