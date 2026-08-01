// The two readiness call sites, protected from deletion.
//
// THIS FILE IS A GUARD, NOT A CONTROL, and the difference is the whole point of
// it. A control proves a fix causes an effect. A guard catches a future
// regression. This file does the second and does not attempt the first: the
// causal proof that the readiness wait is what makes the metrics endpoint serve
// lives in a boundary measurement recorded elsewhere — with the call site,
// /metrics answered 200; without it, 404, same instrumentation, same moment.
// Nothing below re-establishes that. Presenting a guard as a control would be
// exactly the claim-outruns-evidence defect this suite exists to prevent.
//
// What it protects, and why protection is needed at all:
//
//   * `registerWebhook` waits on the metrics endpoint after it restarts n8n.
//     That branch runs only on a FIRST import of a workflow, so on a warm stack
//     it never executes — measured 0 times across 9 registrations in a full
//     green run. Delete the line and every test still passes. The one run it
//     does matter for is a reader's first run against a fresh stack, which is
//     the documented, expected first experience of this repository.
//
//   * `observability.test.js` waits for the Prometheus scrape targets before it
//     asserts they are up. Same shape of exposure: it currently passes because
//     of timing, and it would keep passing for a while after the wait was
//     removed, on this machine, until it did not.
//
// A measured property that explains why neither call site can be protected
// behaviourally at its outer boundary: `registerWebhook`'s post-restart webhook
// poll OUTLASTS the /metrics mount. Measured, both variants returned 200 at that
// function's return whether or not the wait was present — the poll masks the
// race there. A behavioural test asserting discrimination at that boundary is
// therefore structurally incapable of discriminating, and is deliberately not
// attempted. The readiness wait exists precisely so that correctness does not
// depend on that ordering continuing to hold: on a faster machine, or after a
// change to the poll, it stops holding, and the call site becomes the only
// thing between this harness and a returning flake.
//
// So the assertion is source-level: it is deterministic, offline, costs no
// runtime and mutates nothing. It follows the cross-reference sweep's shape —
// the check is a pure function over a map of path to content, so the positive
// control can drive it with a defect injected into an IN-MEMORY copy and never
// write that defect to the working tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

const HELPER = 'tests/helpers/stack.mjs';
const OBSERVABILITY = 'tests/observability.test.js';

// --- region extraction ------------------------------------------------------
//
// Whole-file matching would be too weak to be worth committing: it would keep
// passing if the call were moved OUT of the function that needs it and left
// somewhere else in the file. So each call site is checked inside its own
// enclosing block, located by balancing braces from the block that opens after
// its declaration.

function regionOf(source, opener) {
  const m = opener.exec(source);
  if (!m) return null;
  const start = source.indexOf('{', m.index + m[0].length);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

// A comment naming a call is not a call. Stripping comments before the presence
// check is what stops the guard from being satisfied by the very commentary that
// explains the call — and both of these blocks carry exactly that commentary
// today. Both comment forms are stripped: a guard that handled only one would be
// fail-silent against the other, which is the defect it exists to prevent.
//
// BLOCK COMMENTS ARE STRIPPED FIRST, and the order is load-bearing. Doing line
// comments first has a fail-SILENT path. Given
//
//     /*
//     await waitReady([readinessConditions.metricsMounted()]);
//     // */
//
// the call is genuinely commented out — inside a block comment, `//` means
// nothing and the `*/` closes it. But strip `// */` first and the block is left
// unterminated, the block strip then matches nothing, and the call survives into
// the presence check: the guard reports clean over a call site that is gone.
// Stripping blocks first cannot do that. Its own failure mode is over-stripping,
// which reports the call site MISSING — a false failure, which is loud, and loud
// is the safe direction for a guard.
//
// RESIDUAL LIMIT, stated rather than presumed away: a regex stripper cannot tell
// a comment delimiter from the same characters occurring inside a LITERAL. Two
// kinds of literal carry that hazard, by one identical mechanism — the stripper
// matches characters, not syntax, so it cannot know it is inside anything:
//
//   * a STRING literal containing `//` or `/*`; and
//   * a REGEX literal containing the same — a pattern written to match a comment
//     delimiter, or any pattern in which those characters happen to appear.
//
// Naming only strings would understate the class, and would be a particularly
// odd omission in this file, which is itself dense with regex literals: every
// `opener`, every `anchor`, every `outside`, and every `re` in every `required`
// array is one. A guard pattern that carries a comment delimiter is not a
// hypothetical here — it is the ordinary shape of the data this file holds.
//
// Either way the consequence is identical: on or around a line holding a
// required call, the stripper removes live code, and the guard reports that call
// site missing — a FALSE FAILURE. It is loud, it is the safe direction, and it
// is the price of the trade. No false-PASS path is known to remain once blocks
// are stripped
// first. Closing even that would mean parsing JavaScript structurally: Node
// bundles acorn internally but exposes no public parser or AST API, so it would
// mean taking a new runtime dependency in an exhibit whose thesis is that its
// own guarantees are cheap and verifiable. That trade is refused deliberately,
// and the limit is written down instead — a guard whose weaknesses are
// documented is stronger than one presumed total.
const stripComments = (block) => block
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

const CALL_SITES = [
  {
    id: 'the metrics-endpoint wait inside registerWebhook',
    file: HELPER,
    opener: /export async function registerWebhook\s*\([\s\S]*?\)\s*(?=\{)/,
    // Both halves matter: `waitReady` alone could be waiting on anything, and
    // the condition alone could be constructed and never awaited.
    required: [
      { re: /waitReady\s*\(/, why: 'nothing waits after the restart' },
      { re: /metricsMounted\s*\(/, why: 'the wait is no longer on the metrics endpoint' },
    ],
    anchor: /restartService\('n8n'\)/,
    outside: /ensureLlmCredentials/,
  },
  {
    id: 'the scrape-target wait before the targets-are-up assertion',
    file: OBSERVABILITY,
    opener: /test\('the Prometheus datasource[^']*',\s*async\s*\(\s*\)\s*=>\s*(?=\{)/,
    required: [
      { re: /waitTargetsUp\s*\(/, why: 'the assertion races the scrape interval again' },
    ],
    anchor: /api\/v1\/targets/,
    outside: /diagnoseEmptyBareName/,
  },
];

// The check, as a pure function over `sources` so the control can drive it.
function unguarded(sources) {
  const findings = [];
  for (const site of CALL_SITES) {
    const source = sources[site.file];
    if (typeof source !== 'string') {
      findings.push(`${site.file}: not readable — ${site.id} cannot be checked`);
      continue;
    }
    const region = regionOf(source, site.opener);
    if (!region) {
      findings.push(`${site.file}: could not locate the block holding ${site.id}`);
      continue;
    }
    const code = stripComments(source.slice(region.start, region.end));
    for (const { re, why } of site.required) {
      if (!re.test(code)) findings.push(`${site.file}: ${site.id} is gone (${re.source} not found) — ${why}`);
    }
  }
  return findings;
}

const liveSources = () => Object.fromEntries([HELPER, OBSERVABILITY].map((f) => [f, read(f)]));

// --- the extractor is checked before anything is concluded from it ----------

test('the extractor isolates the intended block, in both directions', () => {
  const sources = liveSources();
  for (const site of CALL_SITES) {
    const region = regionOf(sources[site.file], site.opener);
    assert.ok(region, `could not locate the block holding ${site.id} in ${site.file}`);

    const block = sources[site.file].slice(region.start, region.end);
    assert.ok(block.length > 100, `the extracted block for ${site.id} is ${block.length} bytes — that is not the function`);

    // Under-extraction would make the check fail loudly, which is safe.
    // OVER-extraction is the dangerous direction: a block that swallowed the
    // whole file would report clean while guarding nothing. So both are tested.
    assert.match(block, site.anchor, `the block extracted for ${site.id} does not contain its own anchor`);
    assert.doesNotMatch(
      block, site.outside,
      `the block extracted for ${site.id} reaches past the end of its own function, so this guard is weaker than it looks`,
    );
  }
});

// --- positive control: prove the check can fail, per call site, in memory ----

test('deleting either call site is caught, and each is caught independently', () => {
  const sources = liveSources();

  for (const site of CALL_SITES) {
    for (const { re } of site.required) {
      const source = sources[site.file];
      const region = regionOf(source, site.opener);
      const block = source.slice(region.start, region.end);

      // Delete the call from an in-memory copy only. The working tree is never
      // written to — a suite that plants a real defect to prove a check works
      // is one interrupted run away from committing it.
      const damaged = block.replace(new RegExp(`${re.source}[^;]*;?`), '');
      assert.notEqual(damaged, block, `the injection changed nothing for ${site.id}; this control would be vacuous`);

      const injected = { ...sources, [site.file]: source.slice(0, region.start) + damaged + source.slice(region.end) };
      const findings = unguarded(injected);

      assert.ok(
        findings.some((f) => f.startsWith(site.file) && f.includes(site.id)),
        `removing ${re.source} from ${site.id} was not caught; findings were:\n  ${findings.join('\n  ')}`,
      );

      // Independence: damaging one call site must not implicate the other, or a
      // single failure would name both and point a reader at the wrong file.
      const others = findings.filter((f) => !f.includes(site.id));
      assert.deepEqual(others, [], `damaging ${site.id} also reported unrelated findings:\n  ${others.join('\n  ')}`);
    }
  }
});

// Commenting a call out is deletion that leaves a trace, and it is the likelier
// way a call site actually disappears — someone disables it "temporarily" while
// chasing something else. Each comment FORM gets its own control, and each
// control's name is exactly as broad as what it injects. A single test named for
// comments in general, injecting only one form, would be a claim wider than its
// evidence, which is the defect this whole exhibit argues against.

// Comment out the line holding a required call, one form per key. Every form is
// applied to a copy; the working tree is never touched.
function commentedForms(block, re) {
  const lines = block.split('\n');
  const i = lines.findIndex((l) => re.test(l));
  if (i === -1) return null;
  const line = lines[i];
  const indent = line.match(/^\s*/)[0];
  const body = line.slice(indent.length);
  const withLine = (replacement) => [...lines.slice(0, i), replacement, ...lines.slice(i + 1)].join('\n');
  return {
    'a line comment': withLine(`${indent}// ${body}`),
    'a single-line block comment': withLine(`${indent}/* ${body} */`),
    'a multi-line block comment': withLine(`${indent}/*\n${line}\n${indent}*/`),
  };
}

for (const form of ['a line comment', 'a single-line block comment', 'a multi-line block comment']) {
  test(`a call disabled with ${form} does not satisfy the guard, at either call site`, () => {
    const sources = liveSources();

    for (const site of CALL_SITES) {
      const source = sources[site.file];
      const region = regionOf(source, site.opener);
      const block = source.slice(region.start, region.end);

      const forms = commentedForms(block, site.required[0].re);
      assert.ok(forms, `could not find the line holding ${site.required[0].re.source} in ${site.id}`);
      const damaged = forms[form];
      assert.notEqual(damaged, block, `${form} changed nothing for ${site.id}; this control would be vacuous`);

      const injected = { ...sources, [site.file]: source.slice(0, region.start) + damaged + source.slice(region.end) };
      const findings = unguarded(injected);

      assert.ok(
        findings.some((f) => f.startsWith(site.file) && f.includes(site.id)),
        `${site.id} disabled with ${form} was not caught — the guard is matching prose rather than code; ` +
          `findings were:\n  ${findings.join('\n  ')}`,
      );

      const others = findings.filter((f) => !f.includes(site.id));
      assert.deepEqual(others, [], `disabling ${site.id} also reported unrelated findings:\n  ${others.join('\n  ')}`);
    }
  });
}

// --- clean over the real tree, asserted after the control proved it can fail --

test('both readiness call sites are present in the source as committed', () => {
  const findings = unguarded(liveSources());
  assert.deepEqual(
    findings, [],
    `readiness call sites missing:\n  ${findings.join('\n  ')}`,
  );
});
