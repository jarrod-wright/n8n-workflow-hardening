// Baseline-artefact presence gate.
//
// The foundation this repo builds on — the order-intake workflow, the global
// error handler, the compose stack, the linter, the clean-room tooling, and the
// broker-hardening test suite — must still be present and wired up before any
// later work is trusted. A file that quietly disappears (a bad merge, a
// truncated clone, a rebase that drops a path) would otherwise surface much
// later as a confusing failure in an unrelated gate, or worse, as a gate that
// passes because the thing it checks is simply gone.
//
// This is a pure file/graph check — no stack required — so it always runs, and
// it is the first thing in the offline suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

function present(relPath) {
  return existsSync(join(repoRoot, relPath));
}

function assertAllPresent(label, paths) {
  const missing = paths.filter((p) => !present(p));
  assert.deepEqual(
    missing, [],
    `${label}: ${missing.length} required artefact(s) missing from this HEAD:\n  ${missing.join('\n  ')}`,
  );
}

// --- Product surface -------------------------------------------------------

test('the workflow product surface is present', () => {
  assertAllPresent('workflows', [
    '01-order-intake/workflow.json',
    '01-order-intake/README.md',
    '_shared/global-error-handler/workflow.json',
    '_shared/global-error-handler/README.md',
    'typeversions.json',
  ]);
});

test('the deployment surface is present', () => {
  assertAllPresent('deployment', [
    'deployment/docker-compose.yml',
    'deployment/README.md',
    'deployment/init/01-schema.sql',
    'deployment/mock-api/server.js',
    '.env.example',
  ]);
});

test('the linter is present, with every rule module and its classification contract', () => {
  assertAllPresent('linter', [
    'linter/cli.js',
    'linter/engine.js',
    'linter/parser.js',
    'linter/classification.js',
    'linter/rules/index.js',
    'linter/side-effecting-nodes.json',
    'linter/README.md',
  ]);
});

test('the clean-room and preflight tooling is present', () => {
  assertAllPresent('tooling', [
    'tools/grep-gate.mjs',
    'tools/internal-vocab-denylist.txt',
    'tools/require-stack.mjs',
  ]);
});

test('the docs surface is present', () => {
  assertAllPresent('docs', [
    'docs/anti-patterns.md',
    'docs/broker-choice.md',
  ]);
});

// --- Broker-hardening test suite -------------------------------------------
//
// These five files are the remediation that made the broker fail CLOSED and put
// the documented bring-up path under test. Losing any one of them silently
// re-opens the exact defect they were written to close, so their presence is
// asserted by name rather than left to the suite's own file globbing.

test('the broker-hardening and compose-interpolation tests are present', () => {
  assertAllPresent('broker-hardening suite', [
    'tests/compose-config.test.js',
    'tests/broker-fail-closed.test.js',
    'tests/broker-healthcheck.test.js',
    'tests/broker-auth-documented-path.test.js',
    'tests/env-consistency.test.js',
  ]);
});

// --- Documented bring-up path ----------------------------------------------
//
// The documented path is a property of package.json, not of any test helper.
// If these scripts vanish or stop pointing at the compose file, every test that
// claims to exercise "the documented path" is claiming something untrue.

test('package.json still defines the documented stack scripts', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};
  for (const name of ['stack:up', 'stack:down', 'stack:config']) {
    assert.ok(
      typeof scripts[name] === 'string' && scripts[name].length > 0,
      `package.json must define the "${name}" script — it is the documented bring-up path`,
    );
    assert.match(
      scripts[name], /deployment\/docker-compose\.yml/,
      `"${name}" must target deployment/docker-compose.yml`,
    );
  }
  assert.match(scripts['stack:up'], /\bup\b/, 'stack:up must bring the stack up');
  assert.match(scripts['stack:down'], /\bdown\b/, 'stack:down must take the stack down');
  assert.match(scripts['stack:config'], /\bconfig\b/, 'stack:config must render the config');
});

// --- Rule registry ---------------------------------------------------------

test('the linter still registers its full rule set with no gaps', async () => {
  const { rules } = await import('../linter/rules/index.js');
  const ids = rules.map((r) => r.id);
  assert.ok(ids.length >= 8, `expected at least the 8 foundation rules, found ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, `duplicate rule id(s) registered: ${ids.join(', ')}`);

  // Rule ids are R<n> and must be contiguous from R1 — a hole means a rule
  // module was dropped from the registry without its id being reused.
  const numbers = ids.map((id) => {
    assert.match(id, /^R\d+$/, `rule id "${id}" is not of the form R<n>`);
    return Number(id.slice(1));
  }).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i++) {
    assert.equal(numbers[i], i + 1, `rule registry has a hole: expected R${i + 1}, found R${numbers[i]}`);
  }

  for (const rule of rules) {
    assert.equal(typeof rule.check, 'function', `rule ${rule.id} has no check()`);
    assert.ok(rule.title && rule.title.length > 0, `rule ${rule.id} has no title`);
  }
});
