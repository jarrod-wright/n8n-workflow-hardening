import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(repoRoot, 'linter', 'cli.js');

// Run the CLI; return { code, stdout, stderr } without throwing on non-zero.
function run(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { cwd: repoRoot, encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

test('lint on the hardened wf01 is clean and exits 0', () => {
  const r = run(['lint', '01-order-intake/workflow.json']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no findings/);
});

test('lint emits a finding and exits 1 on a workflow with no error workflow', () => {
  const r = run(['lint', 'tests/fixtures/queue-mode-probe.workflow.json']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /R1/);
});

test('--json produces machine-readable output', () => {
  const r = run(['lint', 'tests/fixtures/queue-mode-probe.workflow.json', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.results[0].findings[0].ruleId, 'R1');
});

test('a missing file exits 2', () => {
  assert.equal(run(['lint', 'does-not-exist.json']).code, 2);
});

test('bad usage exits non-zero', () => {
  assert.notEqual(run(['nonsense']).code, 0);
});
