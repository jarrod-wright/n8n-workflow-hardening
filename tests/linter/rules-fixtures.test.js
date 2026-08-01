// Rule/fixture guarantee: every rule flags its bad fixture, and the good
// set — including the real wf01 and the global error handler — produces ZERO
// findings. The good set is what keeps the linter honest: a rule that fires on
// clean, hardened workflows is noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorkflow } from '../../linter/parser.js';
import { runRules } from '../../linter/engine.js';
import { rules } from '../../linter/rules/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const badDir = join(repoRoot, 'linter', 'fixtures', 'bad');

// Every shipped workflow belongs in this set. A rule that fires on the product
// this repo exists to demonstrate is the exact false positive the gate is for,
// and it is far more likely than a rule firing on a synthetic fixture written
// to be clean.
const GOOD = [
  '01-order-intake/workflow.json',
  '02-crm-sync/workflow.json',
  '03-support-triage/workflow.json',
  '_shared/global-error-handler/workflow.json',
  '_shared/sync-watchdog/workflow.json',
  '_shared/dlq-replay/workflow.json',
  'linter/fixtures/good/webhook-respond-clean.workflow.json',
  'linter/fixtures/good/http-forward-clean.workflow.json',
  'linter/fixtures/good/ai-triage-clean.workflow.json',
];

function lint(absPath) {
  return runRules(parseWorkflow(readFileSync(absPath, 'utf8'), absPath), rules);
}

// --- Good set: zero false positives ---
for (const rel of GOOD) {
  test(`good fixture has zero findings: ${rel}`, () => {
    const findings = lint(join(repoRoot, rel));
    assert.equal(findings.length, 0, `unexpected findings: ${JSON.stringify(findings, null, 2)}`);
  });
}

test('the good set covers every shipped workflow', () => {
  assert.equal(GOOD.length, 9);
  for (const shipped of [
    '01-order-intake/workflow.json',
    '02-crm-sync/workflow.json',
    '03-support-triage/workflow.json',
    '_shared/global-error-handler/workflow.json',
    '_shared/sync-watchdog/workflow.json',
    '_shared/dlq-replay/workflow.json',
  ]) {
    assert.ok(GOOD.includes(shipped), `${shipped} must be in the zero-false-positive set`);
  }
});

test('the good set includes a clean AI workflow, or the AI rules are untested against a passing case', () => {
  assert.ok(GOOD.includes('linter/fixtures/good/ai-triage-clean.workflow.json'));
});

// --- Bad set: each fixture triggers exactly its rule ---
const badFiles = readdirSync(badDir).filter((f) => f.endsWith('.json')).sort();

test('the bad set has one fixture per registered rule', () => {
  assert.equal(badFiles.length, rules.length,
    `${rules.length} rules but ${badFiles.length} bad fixtures — every rule needs one`);
});

for (const file of badFiles) {
  const ruleId = `R${file.match(/^r(\d+)-/)[1]}`;
  test(`bad fixture ${file} triggers exactly ${ruleId}`, () => {
    const findings = lint(join(badDir, file));
    const ids = [...new Set(findings.map((f) => f.ruleId))];
    assert.ok(ids.includes(ruleId), `expected ${ruleId}, got ${JSON.stringify(ids)}`);
    assert.deepEqual(ids, [ruleId], `expected ONLY ${ruleId}, got ${JSON.stringify(ids)}`);
  });
}

test('every rule is exercised by a bad fixture', () => {
  const covered = new Set(badFiles.map((f) => `R${f.match(/^r(\d+)-/)[1]}`));
  for (const r of rules) {
    assert.ok(covered.has(r.id), `rule ${r.id} has no bad fixture`);
  }
});
