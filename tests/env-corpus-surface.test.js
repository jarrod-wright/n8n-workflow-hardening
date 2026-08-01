// The CORPUS-level `$env` invariant.
//
// `tests/env-secret-surface.test.js` bounds what the n8n *services* can see:
// exactly one secret is delivered to their environment. This file asserts the
// other half of the same claim, from the workflow side: **the only `$env`
// reference in the entire reference-workflow corpus is that one secret.**
//
// The two are not redundant. The service-side gate proves nothing else is
// REACHABLE; this one proves nothing else is REACHED FOR. A workflow reading
// `$env.SOME_URL` is not a secret leak, but it does mean the exhibit cannot
// claim its configuration surface is closed — and it is the reason four URL
// variables had to stay in the container environment. Once no workflow reaches
// for them, they can leave it entirely (see tools/materialise-secrets.mjs).
//
// WHAT COUNTS AS "THE CORPUS"
// The six SHIPPED reference workflows, and only those. The exclusions are
// deliberate and are asserted rather than assumed:
//
//   * `linter/fixtures/**` are specimens the linter is tested against. Several
//     are DELIBERATE anti-patterns; `bad/r4-http-no-retry` and
//     `bad/r8-http-no-timeout` reference `$env.UPSTREAM_API_URL` on purpose,
//     because the defect they encode is the missing retry/timeout, not the
//     reference. Rewriting them would change what the linter's own tests mean.
//   * `tests/fixtures/*-unhardened.workflow.json` are the BEFORE half of
//     before/after pairs. Their whole evidentiary value is being the version
//     that was not hardened.
//
// This matches the measured inventory the migration was planned from, which
// enumerated nine `$env` references across exactly these six files and no
// fixture.
//
// WHY THE MATCHER IS THE INTERESTING PART
// A sweep is only as good as what it can see. `$env.NAME` and `$env["NAME"]`
// are the same read at runtime, so a matcher that catches only dot-notation
// would report a closed corpus while a bracket-form reference sat in it. The
// corpus contains no bracket-form reference today, which is exactly why that
// blind spot would go unnoticed — a false green with nothing to contradict it.
// The matcher therefore recognises all three forms, and the test below proves
// it against constructed input rather than trusting the corpus to contain an
// example.
//
// One consequence of scanning workflow FILES rather than parsed expressions:
// inside a JSON string a bracket reference is escaped on disk, as
// `$env[\"NAME\"]`. The scan therefore runs over both the raw bytes (with an
// escape-tolerant pattern) and every parsed string value, and takes the union.
// Either alone has a hiding place; together they do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, loadEnv } from './helpers/stack.mjs';

// The shipped reference workflows, relative to the repo root. Written out in
// full rather than globbed: this list IS the corpus definition, and a silent
// change to it would silently change what the gate covers.
const CORPUS = [
  '01-order-intake/workflow.json',
  '02-crm-sync/workflow.json',
  '03-support-triage/workflow.json',
  '_shared/dlq-replay/workflow.json',
  '_shared/global-error-handler/workflow.json',
  '_shared/sync-watchdog/workflow.json',
];

// THE EXPECTED SET. Exactly one name, and it is the one secret a Code node can
// only reach through `$env` — n8n Code nodes cannot read credentials on any
// version, which is why this reference is irreducible rather than untidy.
const EXPECTED_ENV_REFS = ['ORDER_INTAKE_HMAC_SECRET'];

// `$env.NAME`, `$env["NAME"]`, `$env['NAME']`, and the on-disk escaped form
// `$env[\"NAME\"]`. Names are restricted to identifier characters because that
// is what an environment variable name is; keeping it tight avoids matching
// prose that merely mentions `$env`.
const ENV_REF_RE =
  /\$env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*\\?(["'])([A-Za-z_][A-Za-z0-9_]*)\\?\2\s*\])/g;

function refsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(ENV_REF_RE)) found.add(m[1] || m[3]);
  return found;
}

// Every string value anywhere in the parsed document, however deeply nested.
function everyString(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) everyString(v, out);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) everyString(v, out);
  return out;
}

// Union of the raw-byte scan and the parsed-string scan.
function envRefsInFile(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const found = refsIn(raw);
  for (const s of everyString(JSON.parse(raw))) for (const r of refsIn(s)) found.add(r);
  return found;
}

test('the corpus is exactly the six shipped workflows, and every one of them exists', () => {
  assert.notEqual(CORPUS.length, 0, 'an empty corpus would make every sweep below vacuous');
  assert.equal(CORPUS.length, 6, 'the corpus is the six shipped reference workflows');

  for (const rel of CORPUS) {
    assert.ok(existsSync(join(repoRoot, rel)), `corpus file is missing: ${rel}`);
  }

  // A workflow added outside the declared corpus would otherwise be swept by
  // nothing at all. Discover the shipped layout and require it to match.
  const discovered = [];
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    if (existsSync(join(repoRoot, entry.name, 'workflow.json'))) {
      discovered.push(`${entry.name}/workflow.json`);
    }
    if (entry.name === '_shared') {
      for (const sub of readdirSync(join(repoRoot, '_shared'), { withFileTypes: true })) {
        if (sub.isDirectory() && existsSync(join(repoRoot, '_shared', sub.name, 'workflow.json'))) {
          discovered.push(`_shared/${sub.name}/workflow.json`);
        }
      }
    }
  }

  assert.deepEqual(
    discovered.sort(), [...CORPUS].sort(),
    'the set of shipped workflows on disk no longer matches the declared corpus.\n' +
      `  on disk:  ${discovered.sort().join(', ')}\n` +
      `  declared: ${[...CORPUS].sort().join(', ')}\n` +
      'A new reference workflow must be added to CORPUS above, or this gate silently stops ' +
      'covering it.',
  );
});

test('the expected reference set is exactly one entry — a gate must not pass on an empty set', () => {
  assert.ok(Array.isArray(EXPECTED_ENV_REFS), 'the expected set must be a list');
  assert.notEqual(EXPECTED_ENV_REFS.length, 0, 'an empty expected set would make the sweep vacuous');
  assert.equal(
    EXPECTED_ENV_REFS.length, 1,
    'exactly one `$env` reference is permitted in the corpus. A second is a deliberate policy ' +
      'change — n8n Code nodes cannot read credentials, so each one is a permanent widening ' +
      'of what every Code node on the instance can read.',
  );
  assert.equal(EXPECTED_ENV_REFS[0], 'ORDER_INTAKE_HMAC_SECRET');
});

test('the matcher recognises all three `$env` notations — dot, double-quote and single-quote', () => {
  // The corpus contains no bracket-form reference, so this is proven against
  // constructed input rather than against the corpus. Without it, a
  // dot-notation-only matcher would pass every other test in this file.
  assert.deepEqual([...refsIn('={{ $env.PLAIN_DOT }}')], ['PLAIN_DOT']);
  assert.deepEqual([...refsIn('={{ $env["DOUBLE_QUOTED"] }}')], ['DOUBLE_QUOTED']);
  assert.deepEqual([...refsIn("={{ $env['SINGLE_QUOTED'] }}")], ['SINGLE_QUOTED']);

  // The form a bracket reference actually takes on disk, inside a JSON string.
  assert.deepEqual([...refsIn('"={{ $env[\\"ESCAPED_ON_DISK\\"] }}"')], ['ESCAPED_ON_DISK']);

  // Whitespace variants, so a reformat cannot slip a reference past the sweep.
  assert.deepEqual([...refsIn('$env [ "SPACED" ]')], ['SPACED']);
  assert.deepEqual([...refsIn('$env . SPACED_DOT')], ['SPACED_DOT']);
});

test('the ONLY `$env` reference in the entire workflow corpus is the one secret', () => {
  const byFile = new Map();
  const all = new Set();

  for (const rel of CORPUS) {
    const refs = envRefsInFile(join(repoRoot, rel));
    if (refs.size > 0) byFile.set(rel, [...refs].sort());
    for (const r of refs) all.add(r);
  }

  // The corpus must reference SOMETHING, or the sweep proves nothing: the HMAC
  // secret is irreducible, so zero references means the scan broke, not that
  // the corpus got cleaner.
  assert.notEqual(
    all.size, 0,
    'no `$env` reference was found anywhere in the corpus. The HMAC secret is irreducible — ' +
      'a Code node has no other way to read it — so an empty result means this sweep is broken, ' +
      'not that the corpus is clean.',
  );

  const unexpected = [...all].filter((r) => !EXPECTED_ENV_REFS.includes(r)).sort();

  assert.deepEqual(
    [...all].sort(), [...EXPECTED_ENV_REFS].sort(),
    'the workflow corpus reaches for `$env` names beyond the one permitted secret.\n' +
      `  found:      ${[...all].sort().join(', ')}\n` +
      `  permitted:  ${EXPECTED_ENV_REFS.join(', ')}\n` +
      `  unexpected: ${unexpected.join(', ') || '(none)'}\n\n` +
      'per file:\n' +
      [...byFile.entries()].map(([f, r]) => `  ${f}\n      ${r.join(', ')}`).join('\n') +
      '\n\nNon-secret configuration belongs in a dedicated config node at the head of the ' +
      'workflow, not in `$env`. Do NOT inline the value into the consuming node parameter ' +
      'instead — a URL pasted into the node that uses it is the most-cited mistake in ' +
      'published n8n workflows, and it trades an auditable reference for a hidden one.',
  );
});

// The name-shaped sweep above says nothing about VALUES. A config node holding
// URLs is legitimate; the same node holding a secret value would be a laundering
// route for exactly the thing this migration removed, and R6 (hardcoded secret)
// keys off name shape, so it may not fire. This is the byte-level sweep that
// bounds the service environment, extended to the workflow files themselves.
const SECRET_NAME_RE = /(PASSWORD|SECRET|API_KEY|_KEY|TOKEN|CREDENTIALS?)$/;

function secretValuesFromEnvFile() {
  const env = loadEnv();
  const out = new Map(); // value -> Set(names in .env carrying it)
  for (const [k, v] of Object.entries(env)) {
    if (!SECRET_NAME_RE.test(k) || !v || v.length < 16) continue;
    if (!out.has(v)) out.set(v, new Set());
    out.get(v).add(k);
  }
  return out;
}

test('no secret VALUE from .env appears anywhere in any workflow file', () => {
  const known = secretValuesFromEnvFile();
  assert.ok(
    known.size >= 3,
    `found ${known.size} secret-shaped value(s) in .env. This sweep cannot prove anything ` +
      'without real local values. Run `cp .env.example .env` and set them first.',
  );

  const leaked = [];
  for (const rel of CORPUS) {
    const raw = readFileSync(join(repoRoot, rel), 'utf8');
    for (const [value, names] of known) {
      if (raw.includes(value)) {
        leaked.push(`${rel} carries the bytes of .env ${[...names].sort().join('/')}`);
      }
    }
  }

  assert.deepEqual(
    leaked.sort(), [],
    'a secret VALUE is committed inside a workflow file:\n' +
      leaked.map((l) => `  - ${l}`).join('\n') +
      '\nA config node is for non-secret configuration. Secrets reach a workflow through the ' +
      'credential store, or — for the one case n8n gives no alternative — through `$env`.',
  );
});
