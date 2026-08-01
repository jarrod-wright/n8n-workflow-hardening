// Coverage and grounding for the three reference documents.
//
// The rule this enforces is the one that keeps the documentation honest: no
// pattern may be claimed without a working example in this repository. Prose
// about hardening is cheap to write and impossible to check, so every golden
// pattern must name the workflow that implements it, and every pattern that a
// linter rule actually backs must name that rule.
//
// Patterns with no rule are legitimate — a single-file static check cannot see a
// watchdog living in another workflow — but they must be TAGGED `[structural]`
// rather than left ambiguous, because an untagged pattern implies static
// coverage that does not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rules } from '../linter/rules/index.js';
import { denylistHits } from './helpers/denylist.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  golden: join(repoRoot, 'docs', 'golden-patterns.md'),
  taxonomy: join(repoRoot, 'docs', 'failure-mode-taxonomy.md'),
  testing: join(repoRoot, 'docs', 'testing.md'),
};
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

const golden = read(paths.golden);
const taxonomy = read(paths.taxonomy);
const testing = read(paths.testing);

// The workflow directories that actually exist. A citation has to point at one
// of these, so "cites a workflow" cannot be satisfied by a plausible-looking
// path that resolves to nothing.
const WORKFLOW_DIRS = [
  '01-order-intake',
  '02-crm-sync',
  '03-support-triage',
  '_shared/global-error-handler',
  '_shared/sync-watchdog',
  '_shared/dlq-replay',
];

test('all three reference documents exist', () => {
  for (const [name, p] of Object.entries(paths)) {
    assert.ok(existsSync(p), `docs/${name} document missing: ${p}`);
  }
});

// --- Coverage --------------------------------------------------------------

test('every golden pattern GP-01..GP-11 has a section', () => {
  const present = new Set([...golden.matchAll(/^##\s+(GP-\d+)/gm)].map((m) => m[1]));
  const missing = Array.from({ length: 11 }, (_, i) => `GP-${String(i + 1).padStart(2, '0')}`)
    .filter((id) => !present.has(id));
  assert.deepEqual(missing, [], `docs/golden-patterns.md has no section for: ${missing.join(', ')}`);
});

test('every failure class FC-01..FC-06 has a section', () => {
  const present = new Set([...taxonomy.matchAll(/^##\s+(FC-\d+)/gm)].map((m) => m[1]));
  const missing = Array.from({ length: 6 }, (_, i) => `FC-${String(i + 1).padStart(2, '0')}`)
    .filter((id) => !present.has(id));
  assert.deepEqual(missing, [], `docs/failure-mode-taxonomy.md has no section for: ${missing.join(', ')}`);
});

// --- Grounding: nothing claimed without something built --------------------

// Split the document into one chunk per GP section.
function goldenSections() {
  const out = [];
  const re = /^##\s+(GP-\d+)[^\n]*$/gm;
  const marks = [...golden.matchAll(re)];
  marks.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < marks.length ? marks[i + 1].index : golden.length;
    out.push({ id: m[1], body: golden.slice(start, end) });
  });
  return out;
}

test('every golden pattern cites a workflow that exists in this repository', () => {
  const bad = [];
  for (const { id, body } of goldenSections()) {
    const cited = WORKFLOW_DIRS.filter((d) => body.includes(d));
    if (cited.length === 0) {
      bad.push(`${id}: cites no workflow`);
      continue;
    }
    for (const dir of cited) {
      if (!existsSync(join(repoRoot, dir))) bad.push(`${id}: cites ${dir}, which does not exist`);
    }
  }
  assert.deepEqual(bad, [], `golden patterns with no working implementation behind them:\n  ${bad.join('\n  ')}`);
});

test('every rule-backed pattern cites a real rule, and every other is tagged structural', () => {
  const ruleIds = new Set(rules.map((r) => r.id));
  const bad = [];

  for (const { id, body } of goldenSections()) {
    const structural = /\[structural\]|`\[structural\]`/.test(body);
    const cited = [...body.matchAll(/\bR(\d+)\b/g)].map((m) => `R${m[1]}`);

    if (!structural && cited.length === 0) {
      bad.push(`${id}: cites no rule and is not tagged [structural] — one or the other is required`);
    }
    for (const r of cited) {
      if (!ruleIds.has(r)) {
        bad.push(`${id}: cites ${r}, which is not a registered linter rule`);
      }
    }
  }
  assert.deepEqual(bad, [], `rule citations that do not hold up:\n  ${bad.join('\n  ')}`);
});

test('the summary table and the sections agree on which patterns are structural', () => {
  // A table saying `[structural]` beside a section that claims a rule (or the
  // reverse) is exactly the kind of drift a reader would never notice.
  const bad = [];
  for (const { id, body } of goldenSections()) {
    const sectionStructural = /\*\*`?\[structural\]`?\*\*/.test(body);
    const tableRow = golden.match(new RegExp(`^\\|\\s*\\[${id}\\].*$`, 'm'));
    if (!tableRow) {
      bad.push(`${id}: no row in the summary table`);
      continue;
    }
    const rowStructural = /\[structural\]/.test(tableRow[0]);
    if (sectionStructural !== rowStructural) {
      bad.push(`${id}: summary table says ${rowStructural ? 'structural' : 'rule-backed'}, section says the opposite`);
    }
  }
  assert.deepEqual(bad, [], `summary table and sections disagree:\n  ${bad.join('\n  ')}`);
});

test('every failure class names both a defence and a demonstrating workflow', () => {
  const bad = [];
  const re = /^##\s+(FC-\d+)[^\n]*$/gm;
  const marks = [...taxonomy.matchAll(re)];
  marks.forEach((m, i) => {
    const body = taxonomy.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : taxonomy.length);
    if (!/\*\*Defence:?\*\*/i.test(body)) bad.push(`${m[1]}: states no defence`);
    if (!WORKFLOW_DIRS.some((d) => body.includes(d))) bad.push(`${m[1]}: names no demonstrating workflow`);
  });
  assert.deepEqual(bad, [], `failure classes with nothing wired behind them:\n  ${bad.join('\n  ')}`);
});

// --- The testing document --------------------------------------------------

test('the testing document is runnable guidance', () => {
  assert.match(testing, /npm test/, 'docs/testing.md must tell the reader how to run the suite');
  assert.match(testing, /npm run stack:up/, 'the suite needs the stack, so bringing it up must be documented');
  assert.match(testing, /failure[- ]injection/i, 'the methodology is failure injection and must be named as such');
  assert.match(testing, /dual-counter|two counters|\*\*two\*\* counters/i,
    'the mock-API dual-counter pattern must be explained');
  assert.match(testing, /fixture/i, 'the mock-LLM fixture-response pattern must be explained');
  assert.match(testing, /false[- ]positive/i, 'the linter structural assertions must cover the zero-false-positive bar');
  assert.match(testing, /happy[- ]path/i,
    'the document must say why happy-path tests do not prove resilience');
});

test('the testing document is honest about what cannot be automated', () => {
  assert.match(
    testing, /cannot be automated|cannot be honest as code|manual/i,
    'docs/testing.md must state that some publish-readiness checks are inherently manual',
  );
  assert.match(
    testing, /PUBLISH-CHECKLIST\.md/,
    'it must point the reader at the checklist where those manual items live',
  );
});

// --- Clean room ------------------------------------------------------------

test('none of the three documents carries internal vocabulary', () => {
  for (const [name, p] of Object.entries(paths)) {
    const hits = denylistHits(read(p));
    assert.deepEqual(hits, [], `${name} carries internal vocabulary:\n  ${hits.join('\n  ')}`);
  }
});
