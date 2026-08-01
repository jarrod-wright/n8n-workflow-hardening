# Curated references

A short, annotated list of the outside material that is genuinely useful when
hardening n8n workflows. Each entry says what it is and why it earns a place.

Everything here was checked on the observation date given against it. Star counts
are **dated observations, not current claims** — they move, and a number with no
date attached is a number nobody can check. Re-verification before publication is
a manual checklist item in
[`../PUBLISH-CHECKLIST.md`](../PUBLISH-CHECKLIST.md).

## Selection criteria

An entry earns a place by meeting all of these:

- **Maintained** — commits, releases, or answered issues within a timeframe that
  suggests someone is still there.
- **Genuine engineering content** — it explains a mechanism, shows a method, or
  does work. A list of links is not engineering content.
- **Correct for current n8n** — accurate against n8n v2.x, not a v0.x artefact
  left to drift.
- **Permissively licensed where the licence matters** — anything you might vendor,
  fork, or run in CI. For a hosted service or a reference document the licence
  matters less, and where it could not be confirmed that is stated.

## What is excluded, and why

Automatically generated catalogues — scraped aggregations of workflow JSON, dumps
of every template a crawler could reach, and lists assembled by bulk export — are
deliberately out of scope. This is a criterion, not a judgement about any
particular project.

The reason is that such collections are **catalogues, not engineering
references**. They are optimised for volume, so nothing in them has been read,
tested, or version-checked. That matters more here than it would elsewhere: an
independent scan of 12,750 published n8n templates (see the audit writeup below)
found roughly one in five carried a genuinely exploitable high-severity flaw
reachable pre-authentication. Copying from an unreviewed catalogue means
inheriting whatever it happened to collect, which is the opposite of what a
hardening reference is for.

---

## Reference documentation

### n8n official documentation

<https://docs.n8n.io/>

The primary reference, and the one to check before any third-party claim. Node
behaviour, the queue-mode and scaling architecture, environment variables, and
the feature-availability notes that tell you which capabilities need an
Enterprise plan.

**Why recommended.** It is the only source that is authoritative by construction,
and the only one guaranteed to track the version you are running. n8n restructured
its hosting documentation, so older `/hosting/...` paths now redirect — resolve
links fresh rather than trusting a bookmark. Where this repository's
documentation and n8n's disagree about tool semantics, n8n's wins, and a live
probe of the deployed version beats both.

### n8n's built-in security audit

<https://docs.n8n.io/hosting/securing/security-audit/>

n8n ships a security audit as a first-party feature: run it from the n8n node
(*Resource → Audit*) or the CLI, and it reports risks it finds across the
instance — credential exposure, unprotected webhooks, database and filesystem
risk, and outdated instance versions.

**Why recommended.** It is official, it needs nothing installed, and it operates
on your *actual instance* rather than on exported JSON. That makes it
complementary to a static linter rather than a substitute: this repository's
linter reads one exported workflow and reasons about structure, while the audit
inspects the running deployment. Run both — they see different things.

---

## Tools

### `czlonkowski/n8n-mcp`

<https://github.com/czlonkowski/n8n-mcp> — MIT · ~22,400 stars (observed 2026-07-28)

A Model Context Protocol server that gives an AI assistant structured access to
n8n node documentation, properties, and operations, covering the node catalogue
rather than a curated subset.

**Why recommended.** Meets every criterion: actively maintained, MIT licensed,
current with n8n v2.x, and it does real work rather than aggregating links. It
is worth knowing about for a specific hardening reason — the most common way a
hand-written or model-generated workflow breaks is a wrong `typeVersion` or a
misremembered parameter name, and a tool grounded in the real node schema is what
stops that at authoring time rather than at 3 a.m. This repository takes the
same position from the other end, by pinning every `typeVersion` it depends on in
`typeversions.json` and asserting it in tests.

### FlowLint

<https://flowlint.dev/> · CLI: <https://github.com/Replikanti/flowlint-cli> ·
npm [`flowlint`](https://www.npmjs.com/package/flowlint)

Static analysis for n8n workflows, available as a CLI and as a GitHub App that
annotates pull requests through Check Runs. It flags missing retry and backoff
configuration, absent error handling, and similar structural problems.

**Why recommended.** It is the closest independent work to this repository's own
linter, and reviewing a second implementation of the same idea is worth more than
reading one twice — the rule sets differ, and the differences are informative.
The pull-request integration is a genuinely different delivery model from a CLI
that runs in CI.

> **Licence, checked precisely.** The **CLI** is **MIT**: the npm package
> `flowlint` declares `"license": "MIT"` (version 0.9.3, observed 2026-07-28),
> with its source at `Replikanti/flowlint-cli`. The **hosted GitHub App** is a
> separate product and its licence and terms were **not** confirmed, so treat the
> CLI as the vendorable component and the App as a service you evaluate on its
> own terms. Re-confirm both before relying on either.

---

## Engineering writing

### A static-analysis audit of 12,750 published n8n templates

<https://blog.aironclaw.com/n8n-12k-templates-critical-vulnerabilities/> —
published 2026-05-19

A scan of 12,750 published workflow templates, reporting 34,880 findings and
reproducing six end-to-end exploits, with the pre-authentication reachable subset
separated from findings that require adopter misconfiguration.

**Why recommended.** It states its method, publishes its counts, and distinguishes
"a scanner flagged this" from "we reproduced it" — the distinction most security
content elides. The author sells a scanner, which is disclosed and worth knowing
while reading; the numbers and reproductions stand on their own, and the
separation of exploitable from theoretical findings is the part worth copying.
It is also the empirical basis for the exclusion criterion above.

### Piotr Sikora — n8n linting and workflow robustness

<https://www.piotr-sikora.com/blog/2025-11-28-n8n-flow-lint> ·
<https://www.piotr-sikora.com/blog/2025-12-03-flowlint-cli-n8n-linter-in-terminal>

A working-through of what static analysis of n8n workflows can and cannot catch,
covering both the pull-request and terminal workflows.

**Why recommended.** It is written from use rather than from a feature list, and
it is specific about the limits of the approach — which is the part that
transfers regardless of which linter you end up running.
