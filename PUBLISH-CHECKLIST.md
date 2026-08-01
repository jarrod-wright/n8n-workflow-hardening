# Publish checklist

**Every item on this list is manual, and deliberately so.** These are judgements
about the outside world on the day of publication — whether a number is still
roughly right, whether somebody else's licence has changed, whether a claim about
a current n8n version still holds. None of them can be honestly automated, and
writing an assertion that passes regardless would be worse than having no
assertion: it would report a check that never happened.

Everything that *can* be measured already is. `npm test` covers it, and the
suite fails rather than skips when its stack is not up. This file is the
remainder — the part that needs a person, kept visible instead of hidden inside a
green run.

Work through it immediately before publishing. Tick nothing you have not
personally checked.

---

## Accuracy of outside claims

These go stale on their own, without anyone touching this repository.

- [ ] **Re-verify every star count.** Each one in
      [`curated/curated-collections.md`](curated/curated-collections.md) is
      written as `~N stars (observed YYYY-MM-DD)`. Re-observe each, update both
      the number and the date, or remove the count. A count with a stale date is
      honest; a stale count with a fresh date is not.
- [ ] **Confirm the FlowLint licence.** The CLI was MIT at the last check, via
      the npm registry; the hosted app's terms were never confirmed. Re-check
      both. If the CLI licence can no longer be confirmed, demote the entry from
      a recommendation to a note and say why.
- [ ] **Re-check every linked outside resource still resolves.** n8n restructured
      its documentation once already during this work, and one previously listed
      repository is now a 404. Follow every external link.
- [ ] **Re-check each curated entry still meets the stated criteria** —
      maintained, genuine engineering content, correct for current n8n, licence
      confirmed where it matters. Remove anything that no longer qualifies rather
      than leaving it because it was there last time.

## Compatibility with current n8n

- [ ] **Re-check node `typeVersion` values against a current v2.x instance.**
      Every version this repository depends on is pinned in
      [`typeversions.json`](typeversions.json) and asserted by the suite — but
      the suite asserts consistency with the *pinned* image, not with whatever
      n8n ships today. Stand up a current instance and confirm the pinned
      versions still exist and still behave as documented.
- [ ] **Re-confirm the licence-gating claims.** This repository states that
      multi-main high availability and log streaming require a self-hosted
      Enterprise plan and that Prometheus metrics do not. Re-read n8n's
      feature-availability notes; if that boundary has moved, several documents
      need correcting together.
- [ ] **Re-scrape `/metrics` and confirm the dashboard panel names.** Metric
      names are version-dependent. A renamed metric leaves the dashboard
      provisioning cleanly and rendering nothing.

## Clean-room vocabulary

The repository-wide scan runs as the first step of `npm test` and covers every
tracked file. These two items exist because one surface is not a file and the
other is worth re-running deliberately at the moment of publication.

- [ ] **Re-run the vocabulary scan across every file.** `npm run grep-gate`.
      Confirm it exits zero and reports the file count it scanned.
- [ ] **Scrub commit messages.** The scan covers file *contents*, not `git log`.
      Read the commit messages that will become public and confirm none carries
      internal process vocabulary. This is a content check on messages only —
      **do not alter commit authorship, and do not rewrite history.**

## Secrets

- [ ] **Scan `.env.example` for value-shaped secrets.** Automated in the suite,
      and worth eyeballing once more: every value must be a placeholder, and no
      value may look like a real token, key, or signature.
- [ ] **Confirm no real `.env` is in the published tree**, and that
      `deployment/secrets/` is absent. Both are git-ignored; confirm rather than
      assume.
- [ ] **Confirm no credential import file survives.** These are written, used,
      and deleted in the same operation, and a test asserts their absence from
      the working tree and from history — confirm the test ran.

## Build scaffolding

- [ ] **Strip build scaffolding from the published tree.** The working
      repository carries inputs, session records and per-task result files that
      are not part of the product. Confirm none of them appears in what is
      published, including in history if the published repository shares it.
- [ ] **Confirm `.gitignore` still excludes** `.env`, `.env.*` (except the
      example), `deployment/secrets/`, `.build/`, and `node_modules/`.

## Repository presentation

- [ ] **Confirm the licence is recognised.** GitHub should display *MIT* on the
      repository page. If it does not, `LICENSE` has been altered in a way that
      broke detection.
- [ ] **Set the description and topics** so the repository is findable by what it
      actually is.
- [ ] **Confirm no private path or internal hostname appears in any remote URL,
      badge, or link.**
- [ ] **Confirm every relative link in `README.md` resolves** in the published
      tree. Automated in the suite; re-confirm after any move or rename.

## Coordination

- [ ] **Coordinate the profile README and any hub listing** with the repository
      owner before or alongside publication, so the repository is not published
      into an empty context. This one is not a code change and cannot be done
      from a checkout.

---

## Before you tick the last box

Run the full suite one more time, from a clean clone, on a cold stack:

```bash
git clone <url> && cd <repo>
cp .env.example .env      # then set real values
npm ci
npm run stack:up
npm test
```

A clean clone is the only configuration that proves the repository works for
somebody who is not you. Record the measured pass/fail counts; do not report
expected ones.
