# Linter roadmap

Where this linter is, what it deliberately does not do yet, and what the next
step actually costs. This is a design document, not a release schedule.

## Where it is now

Per-file static analysis of exported n8n workflow JSON:

- **R1–R13**, each mapping to a production incident catalogued in
  [`../docs/anti-patterns.md`](../docs/anti-patterns.md).
- **A zero-false-positive mandate.** A rule that fires on clean, hardened
  workflows trains people to ignore the linter, at which point it is worse than
  not having one. The bar is zero findings across the whole good-fixture set,
  which includes this repository's own shipped workflows.
- **Standard library only.** No dependencies, so `npx` distribution and CI use
  need no install step and no supply-chain review.
- **Data-driven classification.** `side-effecting-nodes.json`, `llm-nodes.json`
  and `validation-nodes.json` hold the node knowledge, so supporting a new
  provider or validator is a data change, not a code change.

The unit of analysis is **one file**. Everything below follows from that.

## The next step: repo-scan mode

```
n8n-lint lint-repo <dir>
```

Three parts, in dependency order:

**1 — Discovery by convention.** Walk a directory for workflow JSON, recognising
a file as a workflow by its shape (a `nodes` array with `type`/`typeVersion`
entries and a `connections` object) rather than by filename. Shape-based
detection is what stops the tool silently ignoring a workflow because someone
named it `flow.json`, and it is also what stops it trying to lint
`package.json`.

**2 — Build a workflow graph.** One node per workflow, with edges for the
relationships that cross a file boundary:

- `settings.errorWorkflow` → the workflow it names;
- Execute Workflow / sub-workflow calls → the callee;
- shared credential ids → the workflows that reference them;
- webhook paths → collisions between workflows claiming the same path.

The graph is the artefact. Every repo-level rule is a question asked of it, so
the graph has to be right before any rule built on it is trustworthy.

**3 — Repo-level rules over that graph.** Candidates, in the order their value
divided by their false-positive risk suggests:

| Candidate | Question it answers | Why it needs the graph |
|---|---|---|
| dangling `errorWorkflow` reference | Does the error workflow this names actually exist in the repo? | The referent is in another file |
| duplicate webhook path | Do two workflows claim the same path, so one silently shadows the other? | Collision is a property of the set |
| credential-reference completeness | Is every credential a workflow references declared somewhere the deployment provides? | Credentials are shared across files |
| watchdog-presence | Does this scheduled workflow have a paired watchdog? | The watchdog is a different workflow |

The first three are decidable: a reference either resolves or it does not. They
are near-certain to reach the zero-false-positive bar.

## Why R14 (watchdog-presence) is deferred

`watchdog-presence` is the rule this repository most obviously *wants*, because
the trap it targets — a scheduled workflow that stops running and alerts nobody —
is one of the two headline traps in the anti-pattern catalogue. It is deferred
anyway.

**A single-file linter cannot soundly answer a cross-file question.** Asked
"does this scheduled workflow have a watchdog?", a per-file rule has no way to
see the watchdog even when one exists, so it must either stay silent (useless) or
fire on every scheduled workflow (noise). Firing on every scheduled workflow in a
repository that *does* have a watchdog is precisely the crying-wolf failure the
zero-false-positive mandate exists to prevent.

**Even with the graph, soundness is not automatic.** A watchdog is recognisable
by behaviour, not by structure: it reads a heartbeat table, compares a last
*success* timestamp against a threshold, and alerts. Deciding that some other
workflow is *the* watchdog *for this workflow* means matching the heartbeat key
the scheduled workflow writes against the one the watchdog reads — a data-flow
question, through a database table, across two files. Get it wrong in the
permissive direction and the rule certifies unmonitored jobs as monitored, which
is worse than no rule at all.

**What exists instead is stronger near-term evidence.** The repository ships a
working watchdog — [`../_shared/sync-watchdog/`](../_shared/sync-watchdog/) —
that alerts on the absence of a success rather than the absence of a run, with
tests covering the never-succeeded case, and the trap is documented in
[`../docs/anti-patterns.md`](../docs/anti-patterns.md). A working mechanism plus
a written explanation demonstrates more than a rule that cannot yet be made
sound, and it does not spend the linter's credibility to do it.

R14 is therefore reserved, not cancelled. It becomes tractable once repo-scan
mode exists and the heartbeat-key correspondence can be resolved from the graph.

## Deliberately still out of scope

- **Anything requiring execution.** No running workflows, no database, no
  credential resolution. A static tool that quietly needs a live instance is a
  different tool with a misleading name.
- **Proving correctness.** The linter proves the absence of specific traps, never
  the presence of correct behaviour. That is what the failure-injection suite is
  for — see [`../docs/testing.md`](../docs/testing.md).
- **Auto-fix.** Every one of R1–R13 has more than one legitimate remedy, and a
  tool that picks one silently makes design decisions the author never reviewed.
