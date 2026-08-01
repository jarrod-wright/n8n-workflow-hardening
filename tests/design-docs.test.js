// The two design-decision documents.
//
// Both exist to record reasoning that would otherwise be re-derived — or, worse,
// silently reversed by someone who assumed the current shape was a default
// rather than a choice. A stub satisfies "the file exists" while recording
// nothing, so these assertions check that the reasoning is actually present:
// each document must name the alternative it rejected and the conditions under
// which that alternative would be correct.
//
// Paths are `linter/` and `03-support-triage/` — the directories that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { denylistHits } from './helpers/denylist.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROADMAP = join(repoRoot, 'linter', 'ROADMAP.md');
const DESIGN = join(repoRoot, '03-support-triage', 'DESIGN-DECISIONS.md');

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

test('neither document was written to a path that does not exist', () => {
  // The specification named `tools/n8n-workflow-linter/` and `workflows/…`.
  // Neither directory exists, and creating one would leave a phantom tree
  // beside the real one that every later cross-reference check would trip over.
  assert.ok(existsSync(ROADMAP), 'linter/ROADMAP.md must exist');
  assert.ok(existsSync(DESIGN), '03-support-triage/DESIGN-DECISIONS.md must exist');
  assert.ok(
    !existsSync(join(repoRoot, 'workflows')),
    'no `workflows/` directory may be created — the workflows live at the repository root',
  );
  assert.ok(
    !existsSync(join(repoRoot, 'tools', 'n8n-workflow-linter')),
    'no `tools/n8n-workflow-linter/` directory may be created — the linter lives at `linter/`',
  );
});

test('the linter roadmap covers repo-scan mode, the cross-file limit, and the deferred rule', () => {
  const doc = read(ROADMAP);
  for (const [label, needle] of [
    ['repo-scan mode', 'repo-scan'],
    ['the cross-file limitation', 'cross-file'],
    ['the deferred rule id', 'R14'],
    ['the watchdog-presence candidate', 'watchdog-presence'],
  ]) {
    assert.ok(doc.includes(needle), `linter/ROADMAP.md must cover ${label} (missing "${needle}")`);
  }
});

test('the roadmap states the deferral REASON, not just the deferral', () => {
  const doc = read(ROADMAP);
  // "R14 is deferred" is a status. The document has to say why, or the next
  // reader re-proposes it.
  assert.match(
    doc, /cannot soundly answer|cannot be made\s+sound|soundness is not automatic/i,
    'the roadmap must state why a single-file linter cannot answer a cross-file question',
  );
  assert.match(
    doc, /crying[- ]wolf|false[- ]positive/i,
    'the roadmap must connect the deferral to the zero-false-positive mandate',
  );
  assert.match(
    doc, /_shared\/sync-watchdog/,
    'the roadmap must cite the working watchdog it offers as the stronger near-term evidence',
  );
});

test('the roadmap describes the development path concretely', () => {
  const doc = read(ROADMAP);
  assert.match(doc, /lint-repo/, 'the roadmap must name the repo-scan entry point');
  assert.match(doc, /graph/i, 'the roadmap must describe building a workflow graph');
  assert.match(
    doc, /errorWorkflow/,
    'the candidate repo-level rules must include the dangling cross-workflow errorWorkflow reference',
  );
  assert.match(doc, /credential/i, 'the candidate rules must include credential-reference completeness');
});

test('the wf03 design document covers the trigger choice and the parser choice', () => {
  const doc = read(DESIGN);
  for (const [label, needle] of [
    ['the webhook trigger', 'webhook'],
    ['the schedule alternative', 'schedule'],
    ['scheduled batch triage', 'batch triage'],
    ['the deterministic parser', 'deterministic'],
    ['the Code node', 'Code node'],
  ]) {
    assert.ok(
      new RegExp(needle, 'i').test(doc),
      `03-support-triage/DESIGN-DECISIONS.md must cover ${label} (missing "${needle}")`,
    );
  }
});

test('the design document says when the REJECTED alternative would be right', () => {
  const doc = read(DESIGN);
  // A decision record that only argues for what was built is advocacy. The
  // value is in the conditions that would flip the decision.
  assert.match(
    doc, /When a schedule is the right answer instead/i,
    'the document must state when a scheduled trigger would be the correct choice',
  );
  assert.match(
    doc, /When an LLM repair chain \*?is\*? appropriate/i,
    'the document must state when an LLM repair chain would be the correct choice',
  );
  assert.match(
    doc, /02-crm-sync/,
    'the scheduled alternative must point at the workflow that already implements that shape',
  );
  assert.match(
    doc, /R11/,
    'the parser decision must cite the linter rule that encodes it',
  );
});

test('both documents are substantive rather than stubs', () => {
  for (const [path, doc] of [['linter/ROADMAP.md', read(ROADMAP)], ['03-support-triage/DESIGN-DECISIONS.md', read(DESIGN)]]) {
    assert.ok(doc.length > 2000, `${path} is ${doc.length} chars — too short to carry the reasoning it claims to`);
  }
});

test('neither document carries internal vocabulary', () => {
  for (const [path, doc] of [['linter/ROADMAP.md', read(ROADMAP)], ['03-support-triage/DESIGN-DECISIONS.md', read(DESIGN)]]) {
    const hits = denylistHits(doc);
    assert.deepEqual(hits, [], `${path} carries internal vocabulary:\n  ${hits.join('\n  ')}`);
  }
});
