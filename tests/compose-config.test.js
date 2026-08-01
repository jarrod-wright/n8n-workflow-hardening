// Compose-interpolation gate.
//
// A reader who renders the stack with `docker compose config` and NO --env-file
// must not be warned that a variable "is not set", and no secret may be baked
// (interpolation-expanded) into the rendered model. Every reference the
// *container* consumes is written `$$VAR`, so compose emits a literal `$VAR` and
// the container's own shell expands it from env_file at run time.
//
// Two things are proven:
//  1. Clean clone (no `.env` present, as a reviewer first sees the repo): the
//     rendered config contains NONE of the real secret values and emits no
//     "variable is not set" warning. `env_file` is required:false so this
//     renders instead of erroring.
//  2. Real repo (with `.env`): the broker command and health probe carry the
//     literal `$VALKEY_PASSWORD` reference, never an expanded secret value. (The
//     env_file `environment:` map does surface the referenced values — that is
//     the intended by-reference delivery, not an interpolation leak.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docker, composeFile, repoRoot, loadEnv } from './helpers/stack.mjs';

// Render config with the given docker compose args; returns {code,stdout,stderr}.
function config(extraArgs) {
  return docker(['compose', ...extraArgs, 'config']);
}

// The real secret values, to assert their ABSENCE in a clean-clone render.
//
// This function is the input to the clean-clone secret check, and it has a
// failure mode that matters more than it looks: if `.env` is absent, loadEnv()
// yields nothing, the array empties, the caller's loop never executes, and the
// test PASSES having asserted nothing whatsoever about secrets — in the test
// whose entire purpose is the secret check. A gate that reports green while
// verifying less than it claims is worse than no gate.
//
// So the emptiness is not tolerated here: see the hard assertion at the top of
// the clean-clone test, which fails loudly rather than vacuously passing.
const SECRET_NAMES = [
  'VALKEY_PASSWORD', 'QUEUE_BULL_REDIS_PASSWORD', 'POSTGRES_PASSWORD',
  'DB_POSTGRESDB_PASSWORD', 'N8N_ENCRYPTION_KEY', 'N8N_API_KEY', 'ORDER_INTAKE_HMAC_SECRET',
];

function secretValues() {
  const env = loadEnv();
  return SECRET_NAMES.map((k) => env[k]).filter((v) => v && v.length >= 8);
}

test('clean clone: `docker compose config` (no --env-file, no .env) is warning-free and secret-free', () => {
  // Copy the compose file to a temp dir where `../.env` does not exist — this is
  // exactly a fresh clone before `cp .env.example .env`.
  const dir = mkdtempSync(join(tmpdir(), 'compose-cleanclone-'));
  const tmpCompose = join(dir, 'docker-compose.yml');
  writeFileSync(tmpCompose, readFileSync(composeFile, 'utf8'));
  assert.ok(!existsSync(join(dir, '..', '.env')) || join(dir, '..', '.env') !== join(repoRoot, '.env'),
    'temp render dir must not resolve ../.env to the repo .env');

  // This check can only prove something if it has real secret values to look
  // for. An empty set MUST NOT pass as verification — it would mean the loop
  // below runs zero times and the test asserts nothing at all.
  const secrets = secretValues();
  assert.ok(
    secrets.length >= 3,
    'clean-clone secret check cannot run without a populated .env — ' +
      `found ${secrets.length} usable secret value(s) of ${SECRET_NAMES.length} names. ` +
      'Run `cp .env.example .env` and set real local values before running this gate.',
  );

  const r = config(['-f', tmpCompose]);
  assert.equal(r.code, 0, `clean-clone config failed:\n${r.stderr}`);

  const unset = r.stderr.split('\n').filter((l) => /variable is not set/i.test(l));
  assert.equal(unset.length, 0, `clean-clone config warned about unset variables:\n${unset.join('\n')}`);

  for (const secret of secrets) {
    assert.ok(
      !r.stdout.includes(secret),
      `a real secret value leaked into the clean-clone rendered config (len ${secret.length})`,
    );
  }
});

test('real repo: no secret is interpolation-baked into the broker command or health probe', () => {
  const r = config(['-f', composeFile]); // no --env-file
  assert.equal(r.code, 0, `docker compose config failed:\n${r.stderr}`);
  const rendered = r.stdout;

  // A literal reference survives (compose renders `$$` as `$$`); it is NOT the
  // collapsed empty string that the interpolation bug produced.
  assert.match(rendered, /requirepass "\$\$?VALKEY_PASSWORD"/,
    'broker command must carry a literal VALKEY_PASSWORD reference (container-side expansion)');
  assert.doesNotMatch(rendered, /requirepass ""/,
    'broker command collapsed to an empty requirepass — interpolation is still happening host-side');
  assert.match(rendered, /pg_isready -U "\$\$?POSTGRES_USER" -d "\$\$?POSTGRES_DB"/);
  assert.doesNotMatch(rendered, /pg_isready -U "" -d ""/);

  // No secret value on any command/probe line.
  const env = loadEnv();
  const bad = rendered.split('\n')
    .filter((l) => /requirepass|valkey-cli|pg_isready/.test(l))
    .filter((l) => [env.VALKEY_PASSWORD, env.POSTGRES_PASSWORD].some((v) => v && l.includes(v)));
  assert.equal(bad.length, 0, `a secret value was baked into a command/probe string:\n${bad.join('\n')}`);
});

// The two assertions above name valkey and postgres explicitly. That is correct
// for the services that exist today and it must not be weakened — but a
// hand-maintained list is exactly the thing that goes stale the moment someone
// adds a service. The sweep below closes that: it discovers EVERY service whose
// `command:` or `healthcheck:` consumes a container-side variable, and holds each
// one to the same positive/negative pair. A new service that carries a `$$VAR`
// is covered the moment it is added — nobody has to remember to add it here.
//
// Reading the source rather than the render is deliberate: the render is what
// the negative assertion inspects, so the expectation has to come from the file
// the author wrote, or the test would be checking the render against itself.

// Collect, per service, the lines that a CONTAINER's own shell will execute —
// the `command:`, `entrypoint:` and `healthcheck:` blocks. Compose source and
// `compose config` output share an indentation shape (services at 2, keys at 4),
// so one scanner reads both.
function execLinesByService(yamlText) {
  const out = new Map();
  let service = null;
  let inExec = false;

  for (const line of yamlText.split('\n')) {
    if (/^ {2}[\w.-]+:\s*$/.test(line)) {            // "  <service>:"
      service = line.trim().replace(/:$/, '');
      inExec = false;
      continue;
    }
    if (!service) continue;

    if (/^ {4}(command|entrypoint|healthcheck):/.test(line)) {
      inExec = true;
    } else if (inExec && line.trim() && (line.length - line.trimStart().length) <= 4) {
      inExec = false;                                 // next key at the service level
    }
    if (!inExec) continue;

    if (!out.has(service)) out.set(service, []);
    out.get(service).push(line);
  }
  return out;
}

test('every service with a container-side variable in command/healthcheck keeps it by reference', () => {
  // Discover the expectation from the file the author wrote. Deriving it from
  // the render instead would only check the render against itself.
  const sourceExec = execLinesByService(readFileSync(composeFile, 'utf8'));
  const refs = new Map(); // service -> Set(varName)
  for (const [svc, lines] of sourceExec) {
    for (const line of lines) {
      for (const m of line.matchAll(/\$\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!refs.has(svc)) refs.set(svc, new Set());
        refs.get(svc).add(m[1]);
      }
    }
  }

  assert.ok(
    refs.size >= 2,
    `expected to discover services with container-side variable references, found ${refs.size}`,
  );

  const r = config(['-f', composeFile]); // no --env-file — the documented shape
  assert.equal(r.code, 0, `docker compose config failed:\n${r.stderr}`);
  const renderedExec = execLinesByService(r.stdout);
  const env = loadEnv();

  for (const [svc, vars] of refs) {
    const lines = renderedExec.get(svc) || [];
    assert.ok(lines.length > 0, `service "${svc}" has no command/healthcheck block in the render`);
    const text = lines.join('\n');

    for (const name of vars) {
      // POSITIVE — the literal reference survives, so the container's own shell
      // is what expands it at run time.
      assert.match(
        text, new RegExp(`\\$\\$?${name}\\b`),
        `service "${svc}": the container-side reference to ${name} did not survive rendering — ` +
          'compose interpolated it host-side instead of leaving it to the container',
      );

      // NEGATIVE (the paired half) — it must not have collapsed to an empty
      // string. That is exactly what a single `$VAR` does when the documented
      // bring-up runs without --env-file, and it is how a broker can come up
      // unauthenticated while every gate still reports green.
      assert.doesNotMatch(
        text, /(requirepass|-a|-U|-d|-p|--pass\w*)\s+""/,
        `service "${svc}": a variable reference collapsed to an empty string — ` +
          'host-side interpolation is still happening',
      );

      // The real value must never be baked into an exec string. (The service's
      // `environment:` map does carry the value — that is the intended
      // by-reference delivery, not an interpolation leak, so it is not scanned.)
      const value = env[name];
      if (value && value.length >= 8) {
        assert.ok(
          !text.includes(value),
          `service "${svc}": the real value of ${name} was baked into a command/probe string`,
        );
      }
    }
  }
});
