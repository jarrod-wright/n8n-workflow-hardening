// A run with no `.env` must explain itself before it fails.
//
// The underlying assertions are correct and intentional: without `.env` the
// values they check are genuinely absent, and sixteen of them fail. What was
// wrong was that the `&&` chain aborted at the offline suite, so the guidance
// explaining WHY sat in a step that never ran. A newcomer's first contact with
// this repository was sixteen unexplained assertion failures.
//
// This is a legibility gate, and it has a second job that matters more: making
// sure the fix stayed a legibility fix. Suppressing those sixteen assertions
// would also produce a "clean" first run, and would be a far worse change
// wearing the same clothes — so the ordering is asserted AND the guard is
// asserted to be non-blocking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { guidanceFor, GUIDANCE_MARKER } from '../tools/require-env.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(repoRoot, 'tools', 'require-env.mjs');

// Run the guard against a path that does not exist, so the missing-.env
// behaviour is measured without moving the operator's real file out from under
// a running stack.
function runGuard(envPath) {
  return execFileSync('node', [GUARD, envPath], { cwd: repoRoot, encoding: 'utf8' });
}

test('with no .env, the guard emits legible guidance naming the exact fix', () => {
  const out = runGuard(join(repoRoot, 'definitely-not-a-real-env-file'));
  assert.match(out, new RegExp(GUIDANCE_MARKER), 'the guidance must be unmissable, not a buried log line');
  assert.match(out, /cp \.env\.example \.env/, 'it must give the exact command that fixes it');
  assert.match(out, /npm run stack:up/, 'it must give the next step after that');
  assert.match(
    out, /CONSEQUENCE of that|not sixteen separate defects/,
    'it must tell the reader the failures below are downstream of this one cause',
  );
});

test('with .env present, the guard says nothing at all', () => {
  // A guard that talks on every healthy run is noise, and noise is how the
  // signal gets ignored.
  const out = runGuard(join(repoRoot, '.env.example')); // any file that exists
  assert.equal(out.trim(), '', `the guard must be silent when .env is present, got:\n${out}`);
});

test('the guard never blocks the run — it exits zero even with no .env', () => {
  // The whole point. A non-zero exit here would abort the chain and suppress
  // the sixteen assertions this task must leave firing.
  let exitCode = 0;
  try {
    execFileSync('node', [GUARD, join(repoRoot, 'definitely-not-a-real-env-file')], {
      cwd: repoRoot, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (e) {
    exitCode = e.status;
  }
  assert.equal(exitCode, 0, 'the guard must exit 0 so the same assertions still run and still fail');
});

test('the guidance is emitted BEFORE any assertion runs, per the npm test chain', () => {
  // Ordering is a property of package.json, not of any single process, so it is
  // asserted there. The guard must precede every step that can produce
  // assertion output.
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const chain = pkg.scripts.test;

  const guardAt = chain.indexOf('require-env');
  assert.ok(guardAt >= 0, '`npm test` must run tools/require-env.mjs');

  for (const later of ['grep-gate', 'test:offline', 'require-stack', 'test:integration']) {
    const at = chain.indexOf(later);
    assert.ok(at >= 0, `\`npm test\` must still run ${later}`);
    assert.ok(
      guardAt < at,
      `the guidance must come before ${later}; the chain is: ${chain}`,
    );
  }
});

test('the chain still runs every step it ran before — legibility, not suppression', () => {
  // M-R1 in miniature. If a later refactor "fixes" the no-.env experience by
  // dropping a step, this is what catches it.
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const chain = pkg.scripts.test;
  for (const step of ['grep-gate', 'test:offline', 'require-stack', 'test:integration']) {
    assert.ok(chain.includes(step), `the ${step} step must still be in the npm test chain`);
  }
  assert.ok(
    !/require-env[^&]*\|\|/.test(chain),
    'the guard must be chained with && as an ordinary step, not swallowed by ||',
  );
});

test('the guidance function is pure and reports both states', () => {
  assert.equal(guidanceFor(true), null, 'no guidance is due when .env exists');
  assert.match(guidanceFor(false), /cp \.env\.example \.env/);
  assert.match(
    guidanceFor(false, false), /\.env\.example is missing too/,
    'a clone missing .env.example as well must be told that, not sent to copy a file that is not there',
  );
});
