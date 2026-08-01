// The secret-surface invariant.
//
// `N8N_BLOCK_ENV_ACCESS_IN_NODE` is `false` and must stay that way: n8n Code
// nodes cannot read credentials on any version, so the HMAC secret has to remain
// reachable through `$env`. That is a platform constraint, not a preference.
//
// What is NOT forced is how much else `$env` can reach. This file turns
// "exactly one secret is reachable" from a claim in a README into an invariant
// the build enforces. Adding a second secret to either n8n service's environment
// breaks this test, which is the entire point: claims rot, gates do not.
//
// WHY THE RENDERED COMPOSE CONFIG IS THE SUBJECT
// The obvious place to assert this would be from inside a Code node, where the
// risk actually lives. That is impossible, and it was measured rather than
// guessed: `Object.keys($env)` returns `[]` inside a Code node while property
// access on the same object returns real values. `$env` is a non-enumerable
// proxy, so a workflow cannot enumerate its own secret surface.
//
// A second measurement showed where the surface is really decided. With task
// runners enabled, the runner process's OWN environment is scrubbed — it carries
// NODE_FUNCTION_ALLOW_BUILTIN and runner-control variables and not one secret —
// yet a Code node running inside it still reads the HMAC secret. Workflow-visible
// `$env` is therefore forwarded to the runner from the parent n8n process, which
// makes the n8n *service* environment the thing that bounds the blast radius.
// The rendered compose config is where that environment is decided.
//
// WHY BOTH SERVICES
// In queue mode there are two execution hosts, not one — also measured, by having
// a Code node report the hostname it sees. The webhook path runs it on
// `n8n-worker`; the documented on-demand path `npm run wf:run` runs it on `n8n`.
// Either host exposes whatever its own environment holds, so holding only one to
// the invariant would leave the other free to widen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { docker, composeFile, repoRoot, loadEnv } from './helpers/stack.mjs';

const N8N_SERVICES = ['n8n', 'n8n-worker'];

// THE ALLOWLIST. Exactly one entry, and it is the one secret whose entire
// purpose is to be read by a Code node.
//
// It stays at one entry even though there are two HMAC-authenticated webhook
// surfaces: order-intake and support-triage consume the SAME secret. Two
// consumers of one secret is not two secrets. Widening this list is a deliberate
// policy change, never an incidental one — which is why the length is asserted
// and not merely the contents.
const ENV_ALLOWLIST = ['ORDER_INTAKE_HMAC_SECRET'];

// Secrets n8n itself consumes. Each is delivered by its `_FILE` form so the
// value never enters the process environment and `$env` cannot reach it even
// with the block flag `false`.
//
// n8n's documentation says MOST variables accept the `_FILE` form, not all, so
// each of these was measured against this stack rather than assumed. The
// measurement was two-sided, because a healthy boot on its own cannot tell
// "`_FILE` worked" apart from "`_FILE` was ignored and something else supplied
// the value": pointing `_FILE` at a missing path made n8n refuse to start with
// ENOENT (proving the variable is genuinely read), and pointing it at a real
// file with the plain form absent brought the dependent service healthy.
const VIA_FILE = ['N8N_ENCRYPTION_KEY', 'DB_POSTGRESDB_PASSWORD', 'QUEUE_BULL_REDIS_PASSWORD'];

// All three were supported, so there is no exception to declare. The list is
// kept — empty, named, and still consulted by the assertions below — because an
// unsupported variable must one day be an explicit, reasoned exception rather
// than a silent skip. Deleting it is how the next such case would disappear
// quietly instead of being forced into the open.
const FILE_UNSUPPORTED_EXCEPTIONS = [];

// Secrets that must not reach the n8n services in ANY form. These are not n8n's
// to hold: POSTGRES_PASSWORD and VALKEY_PASSWORD belong to the postgres and
// valkey services, and N8N_API_KEY plus the two provider keys are consumed
// host-side by tooling and by `import:credentials` (see
// tests/helpers/stack.mjs ensureLlmCredentials) — the provider keys reach n8n as
// stored CREDENTIALS, which is the mechanism that actually keeps them away from
// `$env`. Delivering them to n8n's environment would widen the blast radius for
// nothing.
const NOT_DELIVERED = [
  'POSTGRES_PASSWORD', 'VALKEY_PASSWORD', 'N8N_API_KEY',
  'LLM_PRIMARY_API_KEY', 'LLM_FALLBACK_API_KEY',
];

// A name is secret-shaped if it ends in one of these. Name-shape alone is a weak
// classifier — a secret can always be given an innocuous name — so it is paired
// below with a value-aliasing sweep that catches exactly that evasion.
const SECRET_NAME_RE = /(PASSWORD|SECRET|API_KEY|_KEY|TOKEN|CREDENTIALS?)$/;

function isSecretName(name) {
  return SECRET_NAME_RE.test(name);
}

// The rendered model, via the documented compose file and env file.
function renderedServices() {
  const r = docker([
    'compose', '-f', composeFile, '--env-file', join(repoRoot, '.env'),
    'config', '--format', 'json',
  ]);
  assert.equal(r.code, 0, `docker compose config failed:\n${r.stderr}`);
  return JSON.parse(r.stdout).services;
}

function envOf(services, name) {
  const svc = services[name];
  assert.ok(svc, `service "${name}" is missing from the rendered compose config`);
  const env = svc.environment || {};
  // An empty environment would let every sweep below iterate nothing and report
  // green having verified nothing at all.
  assert.ok(
    Object.keys(env).length >= 10,
    `service "${name}" rendered only ${Object.keys(env).length} environment entries — ` +
      'too few to be the real model; the sweeps below would pass vacuously',
  );
  return env;
}

// Secret VALUES as .env delivers them, mapped to every name that carries them.
// One value legitimately arrives under two names (DB_POSTGRESDB_PASSWORD equals
// POSTGRES_PASSWORD, QUEUE_BULL_REDIS_PASSWORD equals VALKEY_PASSWORD — the
// env-consistency test requires exactly that), so this is a value -> Set(names)
// map rather than value -> name. Keyed the other way it would report a different
// "source" depending on iteration order.
//
// Used for the aliasing sweep: a secret smuggled in under a harmless name is
// still the same bytes, and the bytes are what leak.
function secretValuesFromEnvFile() {
  const env = loadEnv();
  const out = new Map(); // value -> Set(names in .env carrying it)
  for (const [k, v] of Object.entries(env)) {
    if (!isSecretName(k) || !v || v.length < 16) continue;
    if (!out.has(v)) out.set(v, new Set());
    out.get(v).add(k);
  }
  return out;
}

test('the .env used by this gate is populated — otherwise every sweep below is vacuous', () => {
  const secrets = secretValuesFromEnvFile();
  assert.ok(
    secrets.size >= 3,
    `found ${secrets.size} secret-shaped value(s) in .env. This gate cannot prove anything ` +
      'without real local values. Run `cp .env.example .env` and set them first.',
  );
});

test('the allowlist is exactly one entry — a gate must not pass by iterating an empty set', () => {
  assert.ok(Array.isArray(ENV_ALLOWLIST), 'the allowlist must be a list');
  assert.notEqual(ENV_ALLOWLIST.length, 0, 'an empty allowlist would make the sweep below vacuous');
  assert.equal(
    ENV_ALLOWLIST.length, 1,
    'the allowlist must hold exactly one entry. Two consumers of one secret is not two ' +
      'secrets; a genuinely second secret is a new blast radius and a deliberate decision.',
  );
  assert.equal(ENV_ALLOWLIST[0], 'ORDER_INTAKE_HMAC_SECRET');
});

for (const service of N8N_SERVICES) {
  test(`${service}: the ONLY secret present as a direct env value is the allowlisted one`, () => {
    const env = envOf(renderedServices(), service);

    // `_FILE` variables carry a path, not a secret, so they are not direct
    // values — that is the whole point of the indirection.
    const direct = Object.keys(env)
      .filter((k) => !k.endsWith('_FILE'))
      .filter(isSecretName)
      .sort();

    assert.deepEqual(
      direct, [...ENV_ALLOWLIST].sort(),
      `service "${service}" exposes secret-shaped environment values beyond the allowlist.\n` +
        `  found:     ${direct.join(', ') || '(none)'}\n` +
        `  allowed:   ${ENV_ALLOWLIST.join(', ')}\n` +
        `  unexpected:${direct.filter((k) => !ENV_ALLOWLIST.includes(k)).join(', ') || ' (none)'}\n` +
        'With N8N_BLOCK_ENV_ACCESS_IN_NODE=false every one of these is readable by any Code ' +
        'node on this instance. Deliver it by its _FILE form, or do not deliver it to n8n at all.',
    );
  });

  test(`${service}: every other n8n-consumed secret arrives by its _FILE form`, () => {
    const env = envOf(renderedServices(), service);

    assert.notEqual(VIA_FILE.length, 0, 'an empty _FILE list would make the loop below verify nothing');

    for (const name of VIA_FILE) {
      if (FILE_UNSUPPORTED_EXCEPTIONS.includes(name)) continue; // named, never silent
      assert.ok(
        Object.prototype.hasOwnProperty.call(env, `${name}_FILE`),
        `service "${service}": ${name} must be delivered as ${name}_FILE. ${name}_FILE was ` +
          'measured as supported on this n8n version, so there is no exception to claim.',
      );
      assert.ok(
        !Object.prototype.hasOwnProperty.call(env, name),
        `service "${service}": ${name} is set in BOTH forms. On this n8n version the plain env ` +
          'form WINS and the _FILE form is then ignored — measured in both directions. That does ' +
          'not fail loudly; it quietly reverts the hardening to a no-op while every gate stays green.',
      );
    }

    // An exception may exist one day; if it does it must be declared here with a
    // reason, and it must be a real member of the set it exempts.
    for (const name of FILE_UNSUPPORTED_EXCEPTIONS) {
      assert.ok(VIA_FILE.includes(name), `${name} is exempted but is not in the _FILE set`);
    }
  });

  test(`${service}: secrets that are not n8n's to hold are not delivered to it at all`, () => {
    const env = envOf(renderedServices(), service);
    assert.notEqual(NOT_DELIVERED.length, 0, 'an empty list would make the loop below verify nothing');

    for (const name of NOT_DELIVERED) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(env, name) &&
          !Object.prototype.hasOwnProperty.call(env, `${name}_FILE`),
        `service "${service}": ${name} is delivered to n8n but n8n does not consume it. ` +
          'It belongs to another service or to host-side tooling; shipping it here only widens ' +
          'what a Code node can read.',
      );
    }
  });

  // The name-shape sweep above can be evaded by naming a secret something that
  // does not look like one. This sweep closes that by matching on the bytes
  // instead: once the migration is done, the ONLY secret value permitted
  // anywhere in an n8n service's environment is the allowlisted HMAC secret,
  // under its own name. Any other entry carrying any known secret value is a
  // violation whatever it is called.
  test(`${service}: no secret VALUE reaches the environment under any other name`, () => {
    const env = envOf(renderedServices(), service);
    const known = secretValuesFromEnvFile();
    assert.ok(known.size >= 3, 'the value sweep needs real secret values to match against');

    const leaked = [];
    for (const [name, value] of Object.entries(env)) {
      if (value === null || value === undefined) continue;
      const carriedBy = known.get(String(value));
      if (!carriedBy) continue;                      // not a secret value at all
      if (ENV_ALLOWLIST.includes(name)) continue;    // the one permitted secret, under its own name
      leaked.push(`${name} (same bytes as .env ${[...carriedBy].sort().join('/')})`);
    }

    assert.deepEqual(
      leaked.sort(), [],
      `service "${service}" carries secret VALUES that are not the allowlisted one:\n` +
        leaked.map((l) => `  - ${l}`).join('\n') +
        '\nRenaming a secret does not reduce the blast radius — a Code node reads the value, ' +
        'not the name.',
    );
  });
}
