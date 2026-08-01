# Testing methodology

How the claims in this repository are verified, and why the suite is built the
way it is.

## Running it

```bash
cp .env.example .env      # then set local values; .env is git-ignored
npm run stack:up          # docker compose up, waits for every service healthy
npm test                  # the whole suite
```

`npm test` runs four steps in order, and stops at the first that fails:

1. **the clean-room grep gate** — scans the public surface for internal
   vocabulary;
2. **the offline suite** — structure, configuration, documentation and linter
   tests, no containers required;
3. **a stack preflight** — exits non-zero, naming every gate it could not verify,
   if the stack is not fully up;
4. **the integration suite** — failure injection against the running stack.

The preflight is there because of a specific failure mode: a suite that *skips*
its integration tests when the stack is down reports success while proving
nothing, and "0 failures" reads identically whether the gates passed or never
ran. It exits non-zero instead, and names the gates that went unverified.

### The first run against a fresh stack is slower, and why

The first `npm test` against a stack that has never run these workflows takes
roughly **120 seconds longer** than later runs. Every subsequent run on a warm
stack pays **none** of it: measured at **zero** n8n restarts across a full
517-second green run.

The cause is upstream, not something in this repository. n8n does not register a
newly-imported active workflow until the main process restarts — its own CLI
says so when you activate one (`Please restart n8n for changes to take effect if
n8n is currently running`), and a workflow imported this way was measured still
returning 404 after 60 seconds of polling without a restart. A workflow n8n
already knows re-registers in about 120 ms with no restart at all, which is why
the cost falls entirely on the first run.

So the harness restarts n8n once per newly-imported webhook workflow. There are
**four** of them, and one such registration cycle was measured at about **30
seconds**, against 20–106 ms on a warm stack.

This is recorded rather than removed. Removing it would mean working around a
platform behaviour rather than fixing a defect here, and the measured cost is a
one-off 120 seconds against an unmeasured risk. What *was* fixed is the readiness
race those restarts used to expose: the harness now waits for each readiness
signal on that signal itself — the metrics endpoint is waited for by polling the
metrics endpoint, never by asking a health probe, which answers a different
question and was measured answering `200` while `/metrics` was still `404`.

## The core idea: failure injection, not happy paths

**A happy-path test proves the workflow works when nothing goes wrong, which is
the case nobody needed reassurance about.** Every hardening claim in this
repository is a claim about behaviour *under failure*, so the suite's job is to
cause those failures on purpose and assert what happens.

So the upstream API is made to fail a set number of times. The rate limiter is
switched on. The model is made to return fenced JSON, prose, an empty string, and
JSON that parses but violates the contract. A provider is taken down entirely.
Requests are sent unsigned, wrongly signed, and signed over different bytes than
those delivered. The same order is delivered twice.

Each of those has a defined correct response, and the test asserts that response —
not the absence of an exception.

## Assert against the transport and the database, never the workflow's own account

A workflow reporting `{"status": "ok"}` is evidence that it *said* ok. The
assertions here are made against things the workflow does not author:

- **the transport** — which provider was actually called, in what order, and how
  many times, read from counters kept by the mock services;
- **the database** — what rows actually exist afterwards.

This is what lets the suite catch a whole class of defect that self-reporting
cannot. A workflow that returns 200 while its fallback silently absorbed a total
provider outage looks perfect from the outside; the provider counters show the
fallback was called when it should not have been.

## The mock-API dual-counter pattern

The mock upstream keeps **two** counters: how many times it was *called*, and how
many times the side effect actually *happened*.

One counter is not enough. "Retried three times" is consistent with both
"retried three times and acted once" — correct — and "retried three times and
acted three times" — a triple-charged customer. Only the pair distinguishes them,
and that pair is what makes the idempotency claim in
[`golden-patterns.md`](golden-patterns.md#gp-02--idempotency-before-the-side-effect)
a measured property rather than a design intention.

## The mock-LLM fixture-response pattern

The model provider is a deterministic stand-in serving the same wire format on
two independent base paths, so the primary chain and the fallback chain are
separately observable. Every response is a static fixture selected by a scenario
marker.

**A real model cannot be a test dependency.** It is non-deterministic, so the same
input yields different output and a test asserting on that output is a coin toss.
It costs money on every run. It is a network dependency that turns an offline
suite into a flaky one. And the interesting cases — malformed output, schema
violation, empty response, outage — cannot be produced on demand from a real
provider at all, which means the failure paths would go untested precisely
because they are the ones that matter.

The fixtures make those cases reachable and repeatable, and the mock's own tests
assert that every declared scenario is reachable and typed as advertised — so the
instrument itself is checked.

## Structural assertions for the linter

The linter is tested from both directions, because a static analyser has two
distinct ways to be useless:

- **Every rule flags its own bad fixture.** A rule that never fires catches
  nothing. Each of R1–R13 owns a fixture in `linter/fixtures/bad/` exhibiting the
  anti-pattern it targets.
- **No rule fires on any clean fixture.** The good-fixture set is shared, not
  per-rule, precisely so that every rule is measured against every clean
  workflow — including this repository's own shipped workflows. A rule that fires
  on hardened, working workflows trains people to ignore the linter, at which
  point it is worse than not having one.

The second direction is the one that shapes the rules. R10's first draft fired on
this repository's own triage workflow, whose fallback error branch correctly
escalates to a human; the zero-false-positive gate is what caught it, and the fix
was to follow data outputs only rather than error outputs.

## Validate the instrument before trusting a clean result

**A broken instrument looks exactly like a good result.** A scan that fails to run
reports "no findings". A revert that silently does nothing reports a clean
baseline. A dashboard with the wrong metric names renders empty and still returns
HTTP 200.

So anything in this suite whose evidence is an *absence* carries a positive
control: a deliberately planted defect that the check must catch and name, before
its clean result is believed. The secret-shape scan over `.env.example` is
asserted against a synthetic sample of every shape it claims to detect, in the
same test file. The transport-retry boundary is asserted by a server that
destroys sockets on purpose.

This is not belt-and-braces. A check that cannot fail is decoration, and it is
indistinguishable from one that works until the day it matters.

## What the suite does not cover

Being specific about this is part of the point.

- **It does not prove correctness.** It proves the absence of specific, named
  failure modes. A workflow can pass everything here and still be wrong about the
  business it implements.
- **It does not test against a real n8n cloud instance**, only the pinned
  self-hosted image in `deployment/docker-compose.yml`.
- **It does not test the linter against every possible workflow**, only against
  its fixtures and this repository's own workflows.
- **Some publish-readiness checks cannot be automated at all.** Confirming a star
  count is still roughly right, confirming a third party's licence has not
  changed, and re-checking node `typeVersion` values against a current instance
  are all judgements about the outside world on the day of publication. They are
  written down as an explicit manual list in
  [`../PUBLISH-CHECKLIST.md`](../PUBLISH-CHECKLIST.md) rather than faked with an
  assertion that would pass regardless. A check that cannot be honest as code
  belongs on a checklist, visibly, not hidden inside a green suite.

## Why any of this

Happy-path tests do not prove resilience. They prove the code runs.

Every mechanism in this repository — the retry, the idempotency claim, the dead
letter queue, the watchdog, the schema contract, the provider fallback — exists
because of a specific way production breaks. A test suite that never breaks
anything cannot tell you whether those mechanisms work, or whether they are
decoration that has never once been exercised.

The difference shows up exactly once, in production, at which point you find out
which of the two you had.
