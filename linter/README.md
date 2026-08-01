# Workflow linter

A dependency-free static linter for **exported n8n workflow JSON**. It reads a
workflow file, runs a set of rules, and reports the production anti-patterns it
finds. It drops into CI: a non-zero exit means an error-severity finding.

```bash
node linter/cli.js lint <file.json> [--json]
# or, once installed: n8n-lint lint <file.json>
```

## What this proves

This linter is not the first tool to check n8n workflows for production risk,
and it is not offered as a competing product — see **Prior art**, below. What
it demonstrates is different: that the thirteen failure modes below are
understood precisely enough to encode mechanically, each with a rule, a
fixture that trips it, and a fixture that doesn't. Read it as evidence of
rule-level command over the failure taxonomy in
[`../docs/anti-patterns.md`](../docs/anti-patterns.md) — proof you can verify
for yourself, not a tool you're being asked to trust on faith.

## Prior art

Two existing tools cover adjacent ground, and naming them plainly is more
useful than pretending this is the only option:

- **[FlowLint](https://flowlint.dev/)** — a [GitHub App](https://github.com/apps/flowlint)
  that reviews n8n workflow JSON directly inside a pull request as a GitHub
  Check Run, plus a CLI and a Chrome extension for ad-hoc checks. It covers
  much of the same ground — retry/backoff, error handling, dead ends,
  idempotence, hardcoded secrets — and, for continuous PR-level coverage on a
  live repository, does more than this linter attempts.
- **[n8n-workflow-validator](https://github.com/yigitkonur/n8n-workflow-validator)**
  loads the actual n8n runtime packages (`n8n-workflow`, `n8n-nodes-base`) and
  runs the same parameter validation n8n's own editor runs on import. That is
  structurally stronger than a standalone static rule can be for
  parameter-shape correctness — it catches a malformed field the way n8n
  itself would, which this linter does not attempt to.

Neither maps the thirteen production-incident classes below to one place,
cross-referenced against a written failure catalogue with a fix explained for
each. That gap — not tool novelty — is what this fills.

## Rules

Each rule maps to a production incident catalogued in
[`../docs/anti-patterns.md`](../docs/anti-patterns.md).

| Rule | Severity | Catches |
|---|---|---|
| [R1](../docs/anti-patterns.md#r1--no-error-workflow) | error | No `errorWorkflow` configured (error handlers themselves are exempt). |
| [R2](../docs/anti-patterns.md#r2--unpinned-typeversion) | error | A node with no pinned numeric `typeVersion`. |
| [R3](../docs/anti-patterns.md#r3--webhook-with-no-response-node) | error | A webhook set to `responseNode` with no Respond to Webhook node (callers hang). |
| [R4](../docs/anti-patterns.md#r4--side-effecting-call-without-retry) | warning | A network/messaging side-effecting node without `retryOnFail`. |
| [R5](../docs/anti-patterns.md#r5--sql-built-from-an-expression) | error | SQL built by interpolating a `{{ }}` expression into the query (injection). |
| [R6](../docs/anti-patterns.md#r6--hardcoded-secret) | error | A hardcoded secret (`Bearer …`, secret-named literal) instead of a credential/`$env`. |
| [R7](../docs/anti-patterns.md#r7--errors-swallowed) | warning | A node that swallows errors into its normal output (`continueRegularOutput`). |
| [R8](../docs/anti-patterns.md#r8--network-call-without-a-timeout) | warning | A network node with no request timeout (can hang a worker). |
| [R9](../docs/anti-patterns.md#r9--scheduled-workflow-with-no-timezone) | warning | A Schedule Trigger in a workflow with no explicit IANA `settings.timezone`. |
| [R10](../docs/anti-patterns.md#r10--a-model-answer-acted-on-without-validation) | error | A model's answer reaching a side-effecting node without passing through validation. |
| [R11](../docs/anti-patterns.md#r11--a-model-repairing-another-model) | error | An auto-fixing output parser — a second model used to repair the first one's output. |
| [R12](../docs/anti-patterns.md#r12--one-provider-behind-a-workflow-that-acts) | warning | A workflow that *acts on* a model's answer with only one provider vendor behind it. |
| [R13](../docs/anti-patterns.md#r13--resumable-state-in-workflow-static-data) | error | Resumable state (a cursor, watermark, checkpoint) kept in workflow static data. |

Three classification contracts hold the node lists, so adding a provider or a
validator is a data change rather than a code change:

| File | Declares |
|---|---|
| [`side-effecting-nodes.json`](side-effecting-nodes.json) | which node types cause external side effects, and whether each demands a retry or a timeout |
| [`llm-nodes.json`](llm-nodes.json) | which nodes speak to a model **provider** (with its vendor), and which **consume** a model's answer into the data flow |
| [`validation-nodes.json`](validation-nodes.json) | what counts as validating a model's answer — and what only looks like it |

`vendor` in `llm-nodes.json` is what makes R12 meaningful: two provider nodes
from the same vendor share an outage, a rate limit, and usually an account, so
they are not a fallback for one another.

### How the graph rules avoid crying wolf

R10 and R12 walk forward from a model's answer to see whether anything acts on
it. They follow **data** outputs only: a node with
`onError: 'continueErrorOutput'` gains a final output carrying n8n error objects,
and following that would treat "the call failed" as though it were a value the
workflow is acting on. That refinement came directly from the zero-false-positive
gate — the first draft of R10 fired on this repo's own triage workflow, whose
fallback error branch correctly escalates to a human.

## Scope statement

This linter is deliberately **narrow and high-signal**, not a general validator.

- **In scope:** static, structural checks on a single exported workflow — the
  thirteen anti-patterns above, each chosen because it maps to a concrete failure
  mode and can be detected with low false-positive risk.
- **Out of scope:** anything requiring execution or external state. It does not
  run the workflow, reach a database, resolve credentials, verify that a webhook
  is authenticated end-to-end, or reason across multiple workflows. It cannot
  prove a workflow is *correct* — only that it avoids these specific traps.
- **False-positive stance:** a rule that fires on clean, hardened workflows is
  noise that trains people to ignore the linter, so the bar is zero false
  positives on the good-fixture set — which includes the repo's own
  [`01-order-intake`](../01-order-intake/),
  [`02-crm-sync`](../02-crm-sync/) and
  [`03-support-triage`](../03-support-triage/) workflows. The
  secret check (R6) errs toward missing an obfuscated secret rather than
  flagging a legitimate value. When in doubt, a rule stays quiet.

  The good set contains **every workflow this repo ships**, not just synthetic
  fixtures written to be clean. A rule that fires on the product the repo exists
  to demonstrate is the exact false positive that matters, and it is far more
  likely than one firing on a fixture built to pass.
- **Severity:** `error` findings fail CI (structural guarantees); `warning`
  findings are strong recommendations that may have a justified exception.

## Fixtures

`fixtures/good/` and `fixtures/bad/` back the guarantee: every rule flags its
`fixtures/bad/rN-*.json`, and nothing fires on `fixtures/good/*` — enforced by
[`../tests/linter/rules-fixtures.test.js`](../tests/linter/rules-fixtures.test.js).

## Adding a rule

1. Add `rules/rN-<slug>.js` exporting `{ id, title, severity, check(workflow) }`.
2. Register it in `rules/index.js`.
3. Add a `fixtures/bad/rN-*.json` that trips it and confirm the good set stays
   clean.
4. Document the incident it prevents in `../docs/anti-patterns.md`.
