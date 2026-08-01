// Docs gate: 1:1 coverage between linter rules and the anti-pattern catalogue,
// the #9236 headline, and a present, substantive broker-choice note with a
// runnable Redis substitution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rules } from '../linter/rules/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const antiPatterns = readFileSync(join(repoRoot, 'docs', 'anti-patterns.md'), 'utf8');
const brokerChoicePath = join(repoRoot, 'docs', 'broker-choice.md');

test('every rule has an anti-pattern section (1:1, both directions)', () => {
  const documented = new Set([...antiPatterns.matchAll(/^###\s+(R\d+)\b/gm)].map((m) => m[1]));
  const ruleIds = new Set(rules.map((r) => r.id));

  for (const id of ruleIds) {
    assert.ok(documented.has(id), `rule ${id} has no section in docs/anti-patterns.md`);
  }
  for (const id of documented) {
    assert.ok(ruleIds.has(id), `docs/anti-patterns.md documents ${id}, which is not a registered rule`);
  }
  assert.equal(documented.size, ruleIds.size, '1:1 rule↔anti-pattern coverage');
});

test('the anti-pattern catalogue headlines n8n #9236', () => {
  assert.match(antiPatterns, /#9236/);
  assert.match(antiPatterns, /github\.com\/n8n-io\/n8n\/issues\/9236/);
});

test('docs/broker-choice.md exists and is substantive', () => {
  assert.ok(existsSync(brokerChoicePath), 'docs/broker-choice.md must exist');
  const doc = readFileSync(brokerChoicePath, 'utf8');
  // Covers: why a broker (queue mode / BullMQ), the licensing split, and honesty.
  assert.match(doc, /queue mode/i);
  assert.match(doc, /BullMQ/);
  assert.match(doc, /licens/i);
});

test('broker-choice contains a runnable Redis substitution', () => {
  const doc = readFileSync(brokerChoicePath, 'utf8');
  assert.match(doc, /redis:7\.4/, 'must show the exact Redis image to swap in');
  assert.match(doc, /valkey\/valkey/, 'must show the Valkey image being replaced');
  assert.match(doc, /redis-server/, 'must note the server binary substitution');
});

test('the headline traps a static check cannot catch are documented, citing working workflows', () => {
  // These two are absences, not patterns: a linter cannot see a workflow you did
  // not write. Describing them abstractly would be cheap, so each must point at
  // something in this repo that actually implements the fix.
  const headline = antiPatterns.slice(antiPatterns.indexOf('## Headline: the two traps'));
  assert.ok(headline.length > 0, 'the catalogue must carry a headline section for the non-static traps');

  assert.match(headline, /_shared\/sync-watchdog/,
    'the "nothing alerts when a workflow stops running" trap must cite the working watchdog');
  assert.match(headline, /03-support-triage/,
    'the single-provider trap must cite the working workflow with a real second provider');

  // The watchdog entry is only correct if it names the distinction it turns on.
  assert.match(headline, /last_success_at/);
  assert.match(headline, /last_run_at/);
});

test('every rule section names both the anti-pattern and the incident', () => {
  const sections = antiPatterns.split(/^### /m).slice(1);
  for (const section of sections) {
    const title = section.split('\n')[0];
    if (!/^R\d+/.test(title)) continue;
    assert.match(section, /\*\*Anti-pattern\.\*\*/, `${title}: no anti-pattern statement`);
    assert.match(section, /\*\*Incident\.\*\*/, `${title}: no incident — a rule without a consequence is an opinion`);
  }
});
