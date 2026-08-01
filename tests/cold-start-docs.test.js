// Documentation gate for the deferred cold-start cost.
//
// A deferral a reader cannot see is the same evidence gap this repository exists
// to close, pointing the other way — so the cost of the restarts that were NOT
// removed is written down, and this file ties that writing to the thing that
// causes it. Same discipline as the env-access documentation gate: a claim with
// no implementation is a lie waiting to happen, and an implementation with no
// claim is a decision nobody can review.
//
// Every number asserted here was measured, not estimated:
//   * 4 newly-imported webhook workflows      — registration calls instrumented
//                                               across two full suite runs
//   * ~30 s per first-import registration     — 29.1 / 30.3 / 30.9 / 31.7 s
//   * 20–106 ms on a warm stack               — all 9 registrations, both runs
//   * 0 restarts / 517 s warm run             — instrumented, positive-controlled
//   * ~120 s first-run cost                   — 4 x ~30 s
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

// Prose wraps, so every phrase assertion runs against a whitespace-normalised
// copy. Matching raw markdown would make these gates fail on a reflow, which
// would train the next reader to loosen them.
const normalise = (s) => s.replace(/\s+/g, ' ');
const testingDoc = normalise(readFileSync(join(repoRoot, 'docs', 'testing.md'), 'utf8'));
const stackHelper = readFileSync(join(repoRoot, 'tests', 'helpers', 'stack.mjs'), 'utf8');

test('the first-run cost is documented where a reader running the suite meets it', () => {
  assert.match(
    testingDoc, /first run against a fresh stack is slower/i,
    'docs/testing.md must tell a reader why their first run is slow, in the section about running it',
  );
  for (const measured of ['120 seconds', 'zero', '517-second', '120 ms', 'four', '30 seconds']) {
    assert.match(
      testingDoc, new RegExp(measured, 'i'),
      `the documented cost must carry the measured figure "${measured}"`,
    );
  }
});

test('the cost is attributed upstream, not implied to be a defect in this repository', () => {
  assert.match(
    testingDoc, /cause is upstream/i,
    'the n8n-side cause must be named as upstream behaviour rather than left to read as a local defect',
  );
  assert.match(
    testingDoc, /Please restart n8n for changes to take effect/,
    "n8n's own CLI message is the evidence for the upstream attribution and must be quoted",
  );
});

test('the documented reason still matches the harness — a restart per newly-imported workflow', () => {
  // If the harness ever stops restarting on registration, this documentation
  // becomes false and must change with it.
  assert.match(
    stackHelper, /restartService\('n8n'\)/,
    'the documented cost assumes registerWebhook restarts n8n; it no longer does',
  );
});

test('the readiness fix the deferral is paired with is documented as signal-specific', () => {
  // The deferral is only defensible because the race those restarts exposed was
  // fixed. If that sentence disappears, the deferral reads as "we did nothing".
  assert.match(
    testingDoc, /waits for each readiness signal on that signal itself/i,
    'the paired readiness fix must be stated, or the deferral reads as inaction',
  );
  assert.match(
    testingDoc, /never by asking a health probe/i,
    'the proxy prohibition is the substance of the fix and must survive in the documentation',
  );
});
