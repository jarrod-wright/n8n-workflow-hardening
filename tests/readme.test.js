// The root README.
//
// Two things make a README of this kind go wrong, and neither is being short.
//
// The first is a dangling link. A navigation table is the most-read part of a
// repository and the least-checked, and a link that 404s in the published tree
// costs more credibility than the section was worth. Every relative link here is
// resolved against the filesystem.
//
// The second is a claim with nothing behind it. Superlatives are the visible
// form of that, so the denylisted ones are asserted absent — but the substantive
// version is a section describing an artefact that does not exist, which the
// link resolution also catches.
//
// The link set is the set of directories that EXIST: `01-order-intake/`,
// `02-crm-sync/`, `03-support-triage/`, `_shared/`, `deployment/`, `linter/`,
// `docs/`, `curated/`, `schemas/`. There is no `workflows/` directory in this
// repository, and inventing one to satisfy a link would create exactly the
// phantom tree this assertion exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { denylistHits } from './helpers/denylist.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

const REQUIRED_LINKS = [
  '01-order-intake/',
  '02-crm-sync/',
  '03-support-triage/',
  '_shared/',
  'deployment/',
  'linter/',
  'docs/',
  'curated/',
  'schemas/',
];

test('the README is a long-form guide, not a stub', () => {
  assert.ok(readme.length > 3000, `README.md is ${readme.length} chars; the guide is meant to be long-form`);
});

test('the README links every key artefact directory', () => {
  const missing = REQUIRED_LINKS.filter((p) => !new RegExp(`\\]\\(${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(readme));
  assert.deepEqual(missing, [], `README.md does not link: ${missing.join(', ')}`);
});

test('no link points at a directory that does not exist', () => {
  // The specification originally called for a `workflows/` link. There is no
  // such directory, and clause (f) requires every link to resolve — so creating
  // it to satisfy the link would have been the wrong repair.
  assert.ok(!existsSync(join(repoRoot, 'workflows')), 'no `workflows/` directory may be invented to satisfy a link');
  assert.doesNotMatch(readme, /\]\(workflows\//, 'README.md must not link a `workflows/` directory that does not exist');
});

test('every relative link in the README resolves to something that exists', () => {
  // Markdown links, minus anchors and external URLs.
  const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((l) => !/^(https?:|mailto:|#)/.test(l))
    .map((l) => l.split('#')[0])
    .filter(Boolean);

  assert.ok(links.length > 0, 'the README has no relative links at all, which cannot be right');

  const dangling = [...new Set(links)].filter((l) => !existsSync(join(repoRoot, l)));
  assert.deepEqual(
    dangling, [],
    `README.md links these paths, which do not exist:\n  ${dangling.join('\n  ')}`,
  );
});

test('the README states the version and compatibility facts', () => {
  assert.match(readme, /n8n v2/, 'the README must state the n8n major version this targets');
  assert.match(readme, /PostgreSQL/, 'the README must state that PostgreSQL is required for queue mode');
  assert.match(readme, /MIT/, 'the README must name the licence');
});

test('the README carries no superlatives', () => {
  // Each of these is a claim with no technical substance behind it, and each is
  // the kind of thing a reviewing engineer discounts the whole document for.
  const SUPERLATIVES = ['best', 'unmatched', 'unparalleled', 'world-class'];
  const found = SUPERLATIVES.filter((s) => new RegExp(`\\b${s}\\b`, 'i').test(readme));
  assert.deepEqual(found, [], `README.md uses superlatives with no substance behind them: ${found.join(', ')}`);
});

test('the README carries no internal vocabulary', () => {
  const hits = denylistHits(readme);
  assert.deepEqual(hits, [], `README.md carries internal vocabulary:\n  ${hits.join('\n  ')}`);
});

test('the README describes the thesis rather than only listing contents', () => {
  // A navigation table alone is an index. The guide has to say what it is
  // arguing, or the reader has no reason to read any of the linked documents.
  assert.match(
    readme, /failure path/i,
    'the README must state the thesis: failure paths are designed, tested, wired mechanisms',
  );
  assert.match(readme, /queue mode/i, 'the README must describe how the stack actually runs');
  assert.match(readme, /npm test/, 'the README must tell a reader how to verify the claims themselves');
});
