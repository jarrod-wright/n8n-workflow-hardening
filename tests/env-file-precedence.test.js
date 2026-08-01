// No variable is ever set in both its plain and its `_FILE` form.
//
// WHY THIS IS A GATE AND NOT A STYLE RULE
// Sources disagree about which form wins when both are set — one ordering the
// environment above `_FILE`, another stating the file wins. Rather than pick a
// reading, this repo measured it against the n8n version it pins, in both
// directions:
//
//   plain form CORRECT + file WRONG   -> stack healthy, 0 broker auth failures
//   plain form WRONG   + file CORRECT -> WRONGPASS, worker never became healthy
//
// The plain environment form wins, and the `_FILE` form is then ignored.
//
// That is the dangerous direction. It does not error, it does not warn, and it
// does not fail a health check — a stale `VAR` left beside a new `VAR_FILE`
// silently reverts the indirection to a no-op while every gate in this repo
// still reports green, and the secret it was supposed to keep out of the
// environment is back in the environment.
//
// So the dependency on precedence is not resolved here, it is ELIMINATED: if
// both forms are never set at once, which one would have won stops mattering,
// on this version and on any future one that reverses the order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { docker, composeFile, repoRoot } from './helpers/stack.mjs';

// The rendered config is the authoritative subject: Compose merges `env_file`
// contents into each service's `environment` map, so it shows the EFFECTIVE
// environment each container will receive, whatever combination of sources
// produced it. Checking the compose source alone would miss a plain form
// arriving from an env file.
function renderedServices() {
  const r = docker([
    'compose', '-f', composeFile, '--env-file', join(repoRoot, '.env'),
    'config', '--format', 'json',
  ]);
  assert.equal(r.code, 0, `docker compose config failed:\n${r.stderr}`);
  return JSON.parse(r.stdout).services;
}

// Every `VAR`/`VAR_FILE` collision in a name->value map.
function collisions(names) {
  const present = new Set(names);
  return names
    .filter((n) => n.endsWith('_FILE'))
    .map((n) => n.slice(0, -'_FILE'.length))
    .filter((base) => base.length > 0 && present.has(base))
    .sort();
}

function parseEnvFileNames(path) {
  const names = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) names.push(m[1]);
  }
  return names;
}

test('the rendered stack actually uses the _FILE form somewhere — otherwise this gate is vacuous', () => {
  const services = renderedServices();
  const fileVars = Object.values(services)
    .flatMap((svc) => Object.keys(svc.environment || {}))
    .filter((n) => n.endsWith('_FILE'));

  assert.ok(
    fileVars.length >= 3,
    `found ${fileVars.length} *_FILE variable(s) in the rendered config. This gate can only ` +
      'prove something where the indirection is actually in use; with none present it would ' +
      'pass by checking nothing.',
  );
});

test('no service receives a variable in both its plain and its _FILE form', () => {
  const services = renderedServices();
  const names = Object.keys(services);
  assert.ok(names.length >= 4, `expected the full stack in the render, found ${names.length} service(s)`);

  const offenders = [];
  for (const service of names) {
    for (const base of collisions(Object.keys(services[service].environment || {}))) {
      offenders.push(`${service}: ${base} and ${base}_FILE are both set`);
    }
  }

  assert.deepEqual(
    offenders, [],
    'a variable is set in both forms:\n' + offenders.map((o) => `  - ${o}`).join('\n') +
      '\nOn this n8n version the plain form wins and the _FILE form is ignored — silently, with ' +
      'no error and no failing health check. Remove the plain form.',
  );
});

test('no env file sets a variable in both its plain and its _FILE form', () => {
  // `.env` and `.env.example` are authored by hand, which is exactly where this
  // mistake gets made. `deployment/secrets/n8n.env` is generated, and is checked
  // too so that a future change to the generator cannot introduce the collision.
  const candidates = [
    join(repoRoot, '.env'),
    join(repoRoot, '.env.example'),
    join(repoRoot, 'deployment', 'secrets', 'n8n.env'),
  ].filter(existsSync);

  assert.ok(candidates.length >= 1, 'expected at least .env.example to exist');

  const offenders = [];
  for (const path of candidates) {
    for (const base of collisions(parseEnvFileNames(path))) {
      offenders.push(`${path.replace(repoRoot + '/', '')}: ${base} and ${base}_FILE are both set`);
    }
  }

  assert.deepEqual(
    offenders, [],
    'an env file sets a variable in both forms:\n' + offenders.map((o) => `  - ${o}`).join('\n'),
  );
});
