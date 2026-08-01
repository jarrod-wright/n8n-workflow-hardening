// The curated reference collection.
//
// Two failure modes are worth guarding against here, and neither is "the file is
// missing".
//
// The first is the undated star count. "12k stars" is a claim about today that
// silently becomes false, and a reader cannot tell a stale number from a fresh
// one. Every count must carry the date it was observed, which turns a claim into
// a record.
//
// The second is naming and shaming. The collection excludes scraped aggregations
// on a stated principle; doing that by pointing at somebody's repository turns a
// selection criterion into a public callout, and is not something this repository
// does. The exclusion section is therefore asserted to be free of any specific
// project or person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { denylistHits } from './helpers/denylist.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(repoRoot, 'curated', 'curated-collections.md');

test('the curated collection exists and is substantive', () => {
  assert.ok(existsSync(DOC), 'curated/curated-collections.md must exist');
  const doc = readFileSync(DOC, 'utf8');
  assert.ok(doc.length > 1000, `the collection is ${doc.length} chars — an annotated list is more than a link dump`);
});

const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';

// An entry is a level-3 heading under one of the topic sections.
const entries = [...doc.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].trim());

test('there are at least four entries', () => {
  assert.ok(entries.length >= 4, `expected at least 4 entries, found ${entries.length}: ${entries.join(' | ')}`);
});

test('every entry states why it is recommended', () => {
  // Split the document at entry headings so each entry is checked against its
  // OWN prose — a single "Why recommended" anywhere would otherwise satisfy a
  // naive whole-document match.
  const sections = doc.split(/^###\s+/m).slice(1);
  const missing = sections
    .filter((s) => !/\*\*Why recommended\.?\*\*|Why recommended|Criteria/i.test(s))
    .map((s) => s.split('\n')[0].trim());
  assert.deepEqual(missing, [], `entries with no "Why recommended" rationale:\n  ${missing.join('\n  ')}`);
});

test('the selection criteria are stated explicitly', () => {
  assert.match(doc, /## Selection criteria/i, 'the collection must state the criteria an entry has to meet');
  for (const [label, re] of [
    ['maintenance', /maintain/i],
    ['engineering content', /engineering content/i],
    ['version currency', /v2\.x/],
    ['licensing', /licen[cs]/i],
  ]) {
    assert.match(doc, re, `the criteria must cover ${label}`);
  }
});

test('every star count carries the date it was observed', () => {
  // Matches a count in any of the forms someone might write it, then requires an
  // observation date beside it.
  const counts = [...doc.matchAll(/~?[\d,.]+\s*(?:k\b)?\s*stars/gi)];
  assert.ok(counts.length > 0, 'expected at least one star count in the collection');
  const undated = counts
    .filter((m) => {
      const window = doc.slice(m.index, m.index + 80);
      return !/observed\s+\d{4}-\d{2}-\d{2}/i.test(window);
    })
    .map((m) => m[0]);
  assert.deepEqual(
    undated, [],
    `star counts with no observation date — an undated count is a claim nobody can check:\n  ${undated.join('\n  ')}`,
  );
});

test('the exclusion principle is generic and names no project or person', () => {
  const start = doc.search(/^## What is excluded/m);
  assert.ok(start >= 0, 'the collection must state its exclusion principle');
  const rest = doc.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end >= 0 ? rest.slice(0, end) : rest;

  // A callout would take one of these shapes: a repository path, a link, or an
  // @-handle.
  const named = [
    ...section.matchAll(/\bgithub\.com\/[\w.-]+/gi),
    ...section.matchAll(/(?:^|\s)`?[\w.-]+\/[\w.-]+`?(?=\s|$|[,.])/gm),
    ...section.matchAll(/(?:^|\s)@[\w-]+/g),
  ]
    .map((m) => m[0].trim())
    // A bare path like `docs/anti-patterns.md` is a link into this repository,
    // not somebody else's project.
    .filter((s) => !/\.(md|json|js|mjs|yml|yaml)$/.test(s) && !s.startsWith('../') && !s.startsWith('./'));

  assert.deepEqual(
    named, [],
    `the exclusion section names specific projects or people — state the principle generically instead:\n  ${named.join('\n  ')}`,
  );
});

test('the exclusion principle is stated once, not repeated per entry', () => {
  const scoldings = [...doc.matchAll(/scraped aggregation|auto-generated dump|automatically generated catalogue/gi)];
  assert.ok(
    scoldings.length <= 2,
    `the exclusion principle should be stated once; found ${scoldings.length} restatements`,
  );
});

test('the licence caveat on any entry whose licence could not be confirmed is explicit', () => {
  // FlowLint is the named case: if its licence cannot be confirmed it must be
  // demoted from a pin to a note. It can be confirmed for the CLI and cannot for
  // the hosted app, so the document has to distinguish them rather than let one
  // stand for both.
  if (/FlowLint/i.test(doc)) {
    assert.match(doc, /Licence, checked|licence.{0,40}not.{0,20}confirmed|not\*\* confirmed/i,
      'the FlowLint entry must state precisely what was and was not licence-confirmed');
    assert.match(doc, /MIT/, 'the confirmed component must name the licence it was confirmed to carry');
  }
});

test('the collection carries no internal vocabulary', () => {
  const hits = denylistHits(doc);
  assert.deepEqual(hits, [], `curated-collections.md carries internal vocabulary:\n  ${hits.join('\n  ')}`);
});
