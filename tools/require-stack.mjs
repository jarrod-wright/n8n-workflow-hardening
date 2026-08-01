#!/usr/bin/env node
// Preflight for the stack-dependent gates.
//
// `npm test` must never report success while the gate-bearing integration tests
// silently skipped because the stack was down. This preflight exits NON-ZERO
// (it never skips) when the persistent stack is not fully up, and names every
// gate that could not be verified — so a green-and-skipped run is impossible.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(repoRoot, 'deployment', 'docker-compose.yml');
const envPath = join(repoRoot, '.env');

const REQUIRED = [
  'postgres', 'valkey', 'n8n', 'n8n-worker', 'mock-api', 'mock-llm',
  // The observability pair is required for the same reason as the rest: a
  // dashboard gate that quietly does not run reports nothing while looking
  // identical to a dashboard gate that passed.
  'prometheus', 'grafana',
];
const GATE_TESTS = [
  'tests/broker-auth.test.js               — broker auth enforced on the live stack',
  'tests/queue-mode.test.js                — enqueue -> authenticated broker -> worker',
  'tests/order-intake-happy.test.js        — wf01 happy path',
  'tests/order-intake-failure-injection.test.js — the five failure-injection gates',
  'tests/global-error-handler.test.js      — global error handler fires its alert',
  'tests/stack-mocks.test.js               — sync schema, CRM delta feed + rate limiter, mock provider',
  'tests/observability.test.js             — live metric names, dashboard provisioned AND populated',
];

function runningServices() {
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-f', composeFile, '--env-file', envPath, 'ps', '--status', 'running', '--services'],
      { encoding: 'utf8' },
    );
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

const running = runningServices();
const missing = REQUIRED.filter((s) => !running.has(s));

if (missing.length === 0) {
  console.log(`require-stack: OK — all ${REQUIRED.length} services running.`);
  process.exit(0);
}

console.error('\n================= GATES UNVERIFIED =================');
console.error(`The stack is not fully up (missing: ${missing.join(', ')}).`);
console.error('These gate-bearing tests could NOT run and must not be reported as passing:');
for (const t of GATE_TESTS) console.error(`  - ${t}`);
console.error('\nBring the stack up first:  npm run stack:up');
console.error('===================================================\n');
process.exit(1);
