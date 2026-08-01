// Paired-secret consistency gate.
//
// Several secrets are referenced under two names — one on the producer's side,
// one on the consumer's side — and MUST hold the same value:
//   * VALKEY_PASSWORD (broker requirepass) == QUEUE_BULL_REDIS_PASSWORD (n8n)
//   * POSTGRES_PASSWORD (db superuser)     == DB_POSTGRESDB_PASSWORD (n8n)
// A divergence fails silently at connect time (the broker/db just rejects the
// client), which is exactly the kind of quiet misconfiguration this repo exists
// to prevent. This gate makes any mismatch fail loudly, naming both variables.
//
// It is a pure file check — no stack required — so it always runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env parser (KEY=VALUE, optional quotes, ignores comments/blanks).
export function parseEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

// The pairs that must match, by variable name (producer-side, consumer-side).
const PAIRS = [
  ['VALKEY_PASSWORD', 'QUEUE_BULL_REDIS_PASSWORD'],
  ['POSTGRES_PASSWORD', 'DB_POSTGRESDB_PASSWORD'],
  ['POSTGRES_DB', 'DB_POSTGRESDB_DATABASE'],
  ['POSTGRES_USER', 'DB_POSTGRESDB_USER'],
];

export function assertPairsMatch(env, label) {
  for (const [a, b] of PAIRS) {
    assert.ok(a in env, `${label}: ${a} is missing`);
    assert.ok(b in env, `${label}: ${b} is missing`);
    assert.equal(
      env[a],
      env[b],
      `${label}: ${a} and ${b} must hold the same value, but they differ ` +
        `(${a}=${JSON.stringify(env[a])} vs ${b}=${JSON.stringify(env[b])})`,
    );
  }
}

test('.env.example keeps every paired secret in sync', () => {
  const env = parseEnvFile(join(repoRoot, '.env.example'));
  assertPairsMatch(env, '.env.example');
});

test('.env keeps every paired secret in sync (when present)', () => {
  const path = join(repoRoot, '.env');
  if (!existsSync(path)) {
    // No local .env — nothing to check here; .env.example is covered above.
    return;
  }
  assertPairsMatch(parseEnvFile(path), '.env');
});
