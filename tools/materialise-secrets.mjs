#!/usr/bin/env node
// Materialise the secret-delivery surface for the n8n services from `.env`.
//
// WHY THIS EXISTS
// `N8N_BLOCK_ENV_ACCESS_IN_NODE` is `false` and has to stay that way: n8n Code
// nodes cannot read credentials on any version, so the HMAC secret must remain
// reachable through `$env`. What that flag does NOT force is how much *else*
// `$env` can reach. This script is what makes "exactly one secret" true by
// construction, before the stack ever starts:
//
//   * the three secrets n8n itself consumes are written as individual files and
//     delivered by their `_FILE` form, so their values never enter the process
//     environment and `$env` cannot read them even with the flag `false`;
//   * every other secret in `.env` is simply never handed to the n8n services.
//
// `deployment/docker-compose.yml` used to give both n8n services
// `env_file: ../.env`, which delivered the WHOLE file — the DB password, the
// broker password, the encryption key, the n8n API key and both provider API
// keys — into the environment of the two containers that run Code nodes. The
// narrow env file written here replaces that.
//
// WHY GENERATED RATHER THAN COMMITTED
// It carries a real secret value, so it cannot live in the repo. `.env` stays
// the single file an operator edits; this derives the delivery surface from it.
// Everything written here is git-ignored (see .gitignore) and mode 0600.
//
// Runs automatically as the `pre` hook of `stack:up`, `stack:config` and
// `test:offline`, so the documented commands are unchanged.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(repoRoot, '.env');
const outDir = join(repoRoot, 'deployment', 'secrets');

// The three secrets n8n consumes, each delivered by its `_FILE` form.
// Every one was measured to support `_FILE` on this n8n version —
// two-sided: `_FILE` at a missing path makes n8n refuse to start with ENOENT,
// and `_FILE` at a real file with the plain form absent brings the dependent
// service healthy. None is assumed.
const SECRET_FILES = [
  { file: 'n8n_encryption_key', from: 'N8N_ENCRYPTION_KEY' },
  { file: 'db_password', from: 'DB_POSTGRESDB_PASSWORD' },
  { file: 'broker_password', from: 'QUEUE_BULL_REDIS_PASSWORD' },
];

// EXACTLY what the n8n services are allowed to see in their environment.
//
// This list is the invariant expressed as construction rather than convention,
// and `tests/env-secret-surface.test.js` is the same invariant expressed as a
// gate. Adding a secret here breaks that test — which is the point.
//
// The single secret is ORDER_INTAKE_HMAC_SECRET. Both HMAC-authenticated
// webhook surfaces (wf01 order-intake, wf03 support-triage) consume the SAME
// secret, so two entry points still means one entry here.
const N8N_ENV_ALLOWLIST = [
  // --- the one irreducible secret: read by the Verify HMAC Code node via $env ---
  'ORDER_INTAKE_HMAC_SECRET',
  // --- non-secret configuration n8n itself consumes ---
  'DB_POSTGRESDB_DATABASE',
  'DB_POSTGRESDB_USER',
];

// Deliberately NOT delivered to n8n, with the reason each one is withheld.
// Recorded here because a reader's first question is "where did these go?".
//
//   POSTGRES_PASSWORD     the postgres service's own variable; n8n reaches the
//                         database through DB_POSTGRESDB_PASSWORD (now _FILE)
//   VALKEY_PASSWORD       the valkey service's own variable; n8n reaches the
//                         broker through QUEUE_BULL_REDIS_PASSWORD (now _FILE)
//   N8N_API_KEY           host-side tooling only; nothing in the container reads it
//   LLM_PRIMARY_API_KEY   read HOST-side and imported as n8n CREDENTIALS
//   LLM_FALLBACK_API_KEY  (tests/helpers/stack.mjs ensureLlmCredentials) — the
//                         credential store is what keeps them out of $env
//   UPSTREAM_API_URL      the four workflow URLs. No workflow reads them any
//   ALERT_WEBHOOK_URL     more: each workflow carries its own configuration in a
//   CRM_DELTA_URL         labelled `Workflow Config` node, so there is nothing
//   CRM_SYNC_URL          left in the container to resolve them
//   LLM_PRIMARY_BASE_URL  read HOST-side only, as the `url` field of the two
//   LLM_FALLBACK_BASE_URL provider credentials (same ensureLlmCredentials call)
//
// Removing the six above is what makes the corpus-level claim true by
// construction rather than by convention: `tests/env-corpus-surface.test.js`
// proves no workflow REACHES FOR them, and their absence here means the n8n
// process could not answer if one did.

function parseEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

if (!existsSync(envPath)) {
  // A fresh clone before `cp .env.example .env`. Not an error: `docker compose
  // config` must still render (env_file is required:false), and the clean-clone
  // gate depends on exactly that.
  console.log('materialise-secrets: no .env yet — nothing to materialise. Run `cp .env.example .env` first.');
  process.exit(0);
}

const env = parseEnv(envPath);

// Fail CLOSED, in the same spirit as the broker guard: a missing value here
// would otherwise produce an empty secret file, and an empty secret is how a
// stack comes up unauthenticated while every gate still reports green.
const missing = [
  ...SECRET_FILES.filter((s) => !env[s.from]).map((s) => s.from),
  ...N8N_ENV_ALLOWLIST.filter((k) => env[k] === undefined),
];
if (missing.length > 0) {
  console.error('\n================= SECRETS NOT MATERIALISED =================');
  console.error('These variables are missing or empty in .env:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('\nRefusing to write empty secret files. Set them in .env first.');
  console.error('===========================================================\n');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true, mode: 0o700 });
chmodSync(outDir, 0o700);

for (const { file, from } of SECRET_FILES) {
  const target = join(outDir, file);
  // No trailing newline: the file's exact bytes become the secret. A stray "\n"
  // would be part of the password. n8n presents the file's contents verbatim —
  // measured: a deliberately wrong value in the file produced WRONGPASS from the
  // broker, so it is the bytes that are consumed, not merely the file's presence.
  writeFileSync(target, env[from], { mode: 0o600 });
  chmodSync(target, 0o600);
}

const lines = [
  '# GENERATED by tools/materialise-secrets.mjs — do not edit, do not commit.',
  '#',
  '# The ONLY environment the n8n services receive. Everything absent from this',
  '# file is unreachable from $env inside a Code node, which is the entire point.',
  '# Exactly one secret appears below; tests/env-secret-surface.test.js enforces it.',
  '',
  ...N8N_ENV_ALLOWLIST.map((k) => `${k}=${env[k]}`),
  '',
];
const n8nEnvPath = join(outDir, 'n8n.env');
writeFileSync(n8nEnvPath, lines.join('\n'), { mode: 0o600 });
chmodSync(n8nEnvPath, 0o600);

const secretCount = N8N_ENV_ALLOWLIST.filter((k) => k === 'ORDER_INTAKE_HMAC_SECRET').length;
console.log(
  `materialise-secrets: wrote ${SECRET_FILES.length} secret file(s) + n8n.env ` +
    `(${N8N_ENV_ALLOWLIST.length} vars, ${secretCount} secret) to deployment/secrets/`,
);
