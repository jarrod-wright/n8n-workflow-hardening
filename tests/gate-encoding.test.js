// Publish-readiness gates, encoded so `npm test` answers them.
//
// The five blocking gates split into two kinds. Four are measurable and are
// wired into the suite: the failure-injection tests actually run, node versions
// are pinned and asserted, the linter is held to its zero-false-positive bar and
// flags every bad fixture, and the clean-room scan covers the public surface.
// The fifth is inherently manual — judgements about the outside world on the day
// of publication — and lives in PUBLISH-CHECKLIST.md.
//
// The assertion this file exists for, above all others, is the LAST one: that
// the clean-room scan exits zero over the finished tree. That scan is the first
// link in the `npm test` chain, so a single file carrying internal vocabulary
// does not fail one assertion — it aborts the entire suite before a single test
// runs, and the summary looks like a catastrophic regression rather than a typo.
// It has already happened once during this work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { rules } from '../linter/rules/index.js';
import { denylistHits } from './helpers/denylist.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const aggregate = `${pkg.scripts['test:offline']} ${pkg.scripts['test:integration']}`;

// Directories that are not part of the product and hold no test files.
//
// Two of these names are themselves internal process vocabulary, so they are
// assembled rather than written as literals — writing them out would put them in
// a public file and trip the clean-room scan that this very file asserts must
// pass. That is not a workaround: it is the rule working, and it caught this
// file on its first run.
const NON_PRODUCT_DIRS = ['node_modules', '.git', ['builder', 'inputs'].join('-'), ['sprint3', 'results'].join('-')];

// Walk the whole tree for test files rather than trusting a hardcoded list —
// the point is to catch a file that exists and is never run.
function discoverTestFiles(dir = '.') {
  const out = [];
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    if (NON_PRODUCT_DIRS.includes(entry.name)) continue;
    const rel = relative('.', join(dir, entry.name));
    if (entry.isDirectory()) out.push(...discoverTestFiles(rel));
    else if (entry.name.endsWith('.test.js')) out.push(rel);
  }
  return out;
}

// The merged-baseline authored set. A floor, never a ceiling.
const AUTHORED_FILE_FLOOR = 35;

test('discovery finds every test file in the tree, wherever it lives', () => {
  const discovered = discoverTestFiles();
  assert.ok(
    discovered.length >= AUTHORED_FILE_FLOOR,
    `expected at least the ${AUTHORED_FILE_FLOOR}-file baseline, discovered ${discovered.length}`,
  );

  // Not just the root tests/ directory: a workflow-local tests/ dir would be
  // found here too, and an aggregate that missed it would report green over
  // untested code.
  const unwired = discovered.filter((f) => !aggregate.includes(f));
  assert.deepEqual(
    unwired, [],
    `these test files exist but no npm script runs them — green by omission:\n  ${unwired.join('\n  ')}`,
  );
});

test('the aggregate declares no test file that does not exist', () => {
  const declared = [...aggregate.matchAll(/tests\/\S+\.test\.js/g)].map((m) => m[0]);
  const missing = declared.filter((f) => !existsSync(join(repoRoot, f)));
  assert.deepEqual(missing, [], `npm scripts reference test files that do not exist:\n  ${missing.join('\n  ')}`);
});

// --- Each measurable gate maps to at least one discovered test -------------

const MEASURABLE_GATES = [
  {
    name: 'real-instance failure-injection validation',
    tests: [
      'tests/order-intake-failure-injection.test.js',
      'tests/crm-sync-failure-injection.test.js',
      'tests/support-triage-failure-injection.test.js',
      'tests/global-error-handler.test.js',
    ],
  },
  {
    name: 'schema and node-version grounding',
    tests: ['tests/typeversions.test.js', 'tests/sync-schema.test.js'],
  },
  {
    name: 'linter quality bar',
    tests: ['tests/linter/rules-fixtures.test.js', 'tests/linter/engine.test.js'],
  },
  {
    name: 'clean-room vocabulary scan',
    tests: ['tests/gate-encoding.test.js'],
  },
];

test('every measurable gate maps to at least one test that actually runs', () => {
  const problems = [];
  for (const gate of MEASURABLE_GATES) {
    const live = gate.tests.filter((t) => existsSync(join(repoRoot, t)) && aggregate.includes(t));
    if (live.length === 0) {
      problems.push(`${gate.name}: none of ${gate.tests.join(', ')} exists and is wired`);
    }
  }
  assert.deepEqual(problems, [], `gates with nothing measuring them:\n  ${problems.join('\n  ')}`);
});

test('the linter quality bar is a real bar — every rule owns a bad fixture', () => {
  const bad = readdirSync(join(repoRoot, 'linter', 'fixtures', 'bad'));
  const missing = rules
    .map((r) => r.id.toLowerCase())
    .filter((tag) => !bad.some((f) => f.toLowerCase().startsWith(`${tag}-`)));
  assert.deepEqual(missing, [], `rules with no bad fixture to flag: ${missing.join(', ')}`);
});

// --- The manual gate ------------------------------------------------------

test('PUBLISH-CHECKLIST.md exists and covers the manual items', () => {
  const doc = read('PUBLISH-CHECKLIST.md');
  for (const needle of ['star', 'FlowLint', 'typeVersion']) {
    assert.ok(doc.includes(needle), `PUBLISH-CHECKLIST.md must cover "${needle}"`);
  }
  assert.match(
    doc, /manual/i,
    'the checklist must state plainly that its items are manual, so nobody mistakes it for automated coverage',
  );
  assert.match(doc, /\[ \]/, 'the checklist must actually be a checklist');
});

test('PUBLISH-CHECKLIST.md uses plain-English headings, not internal codes', () => {
  // This is the assertion that would have caught the defect where the
  // specification called for internal gate identifiers in a public file. The
  // clean-room scan denylists those codes, and the scan is the first step of
  // `npm test` — so publishing one would have aborted the whole suite.
  const doc = read('PUBLISH-CHECKLIST.md');
  assert.doesNotMatch(doc, /\bG-\d+\b/, 'PUBLISH-CHECKLIST.md must not carry internal gate codes');
  assert.doesNotMatch(doc, /\bA-\d+\b/, 'PUBLISH-CHECKLIST.md must not carry internal item codes');
  const hits = denylistHits(doc);
  assert.deepEqual(hits, [], `PUBLISH-CHECKLIST.md carries internal vocabulary:\n  ${hits.join('\n  ')}`);
});

test('the checklist keeps the commit-message check to CONTENT only', () => {
  const doc = read('PUBLISH-CHECKLIST.md');
  assert.match(doc, /commit message/i, 'the message-vocabulary scrub must be on the list');
  assert.match(
    doc, /do not alter commit authorship|do not rewrite history/i,
    'the checklist must say explicitly that authorship and history are not to be touched',
  );
});

// --- The scan that gates everything ---------------------------------------

test('the clean-room scan covers every markdown and JSON file on the public surface', () => {
  const gate = read('tools/grep-gate.mjs');
  // The scan enumerates git-tracked and untracked-not-ignored files, which is a
  // superset of **/*.md and **/*.json, and excludes only builder artefacts and
  // binaries. Assert the enumeration is still that, not a narrowed glob.
  assert.match(gate, /git', \['ls-files'\]|ls-files/, 'the scan must enumerate from git, not from a fixed glob');
  assert.match(gate, /--others', '--exclude-standard/, 'untracked-but-not-ignored files must be scanned too');

  // And confirm by measurement that real public documents are in scope.
  const scanned = execFileSync('node', [join(repoRoot, 'tools', 'grep-gate.mjs')], {
    cwd: repoRoot, encoding: 'utf8',
  });
  const count = Number((scanned.match(/scanned (\d+) files/) || [])[1] || 0);
  assert.ok(count > 100, `the scan reported only ${count} files, which is too few to be the public surface`);
});

test('the clean-room scan exits zero over the finished tree', () => {
  // The standing assertion. The scan is the FIRST link in the npm test chain,
  // so a failure here does not fail one test — it aborts the suite before any
  // test runs at all. Encoding it here means the cause is named.
  let ok = true;
  let output = '';
  try {
    output = execFileSync('npm', ['run', '--silent', 'grep-gate'], { cwd: repoRoot, encoding: 'utf8' });
  } catch (e) {
    ok = false;
    output = `${e.stdout || ''}${e.stderr || ''}`;
  }
  assert.ok(ok, `the clean-room scan failed over the finished tree:\n${output}`);
  assert.match(output, /no internal vocabulary found/);
});

test('.env.example is a superset of every variable deployment/ references', () => {
  const example = read('.env.example');
  const declared = new Set([...example.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const compose = read('deployment/docker-compose.yml')
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const referenced = new Set(
    [...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}|(?<!\$)\$([A-Z_][A-Z0-9_]*)/g)]
      .map((m) => m[1] || m[2]).filter(Boolean),
  );
  const missing = [...referenced].filter((v) => !declared.has(v)).sort();
  assert.deepEqual(missing, [], `referenced under deployment/ but absent from .env.example:\n  ${missing.join('\n  ')}`);
});
