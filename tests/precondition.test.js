// Precondition gate.
//
// Everything later work stands on has to be present and wired before that work
// is trusted. A missing artefact is cheap to find here and expensive to find
// three tasks later, where it surfaces as an unrelated gate failing for a reason
// that makes no sense.
//
// This complements tests/baseline-presence.test.js rather than repeating it:
// that file asserts the Sprint-1 foundation, this one asserts the FULL merged
// surface — all six workflows, the queue-mode stack, the linter with a complete
// R1..R13 registry and its fixtures, the schema contract, the database DDL, the
// mock containers, the scoped-secret tooling, and the per-workflow configuration
// nodes — plus repo-root housekeeping and the scaffolding exclusion.
//
// It is a pure file/graph check. No stack required, so it always runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const present = (rel) => existsSync(join(repoRoot, rel));

function assertAllPresent(label, paths) {
  const missing = paths.filter((p) => !present(p));
  assert.deepEqual(
    missing, [],
    `${label}: ${missing.length} required artefact(s) missing from this HEAD:\n  ${missing.join('\n  ')}`,
  );
}

// --- The merged workflow corpus -------------------------------------------

const WORKFLOWS = [
  '01-order-intake',
  '02-crm-sync',
  '03-support-triage',
  '_shared/global-error-handler',
  '_shared/sync-watchdog',
  '_shared/dlq-replay',
];

test('all six workflows are present, each with its workflow JSON and README', () => {
  assertAllPresent('workflow corpus', WORKFLOWS.flatMap((w) => [`${w}/workflow.json`, `${w}/README.md`]));
});

test('the queue-mode deployment stack is present', () => {
  assertAllPresent('deployment', [
    'deployment/docker-compose.yml',
    'deployment/README.md',
    'deployment/init/01-schema.sql',
    'deployment/mock-api/server.js',
    'deployment/mock-llm/server.js',
    '.env.example',
  ]);
});

test('the deployment stack is queue mode against Postgres, not a default single-process stack', () => {
  const compose = read('deployment/docker-compose.yml');
  assert.match(compose, /EXECUTIONS_MODE\s*[:=]\s*["']?queue/i, 'the stack must run n8n in queue mode');
  assert.match(compose, /DB_TYPE\s*[:=]\s*["']?postgresdb/i, 'queue mode requires Postgres, never the SQLite default');
  assert.match(compose, /\bn8n-worker\b/, 'queue mode is only queue mode if a worker actually consumes the queue');
});

// --- Linter core, full rule registry, classification data, fixtures --------

test('the linter core and its classification data are present', () => {
  assertAllPresent('linter core', [
    'linter/cli.js',
    'linter/engine.js',
    'linter/parser.js',
    'linter/classification.js',
    'linter/rules/index.js',
    'linter/README.md',
    'linter/side-effecting-nodes.json',
    'linter/validation-nodes.json',
    'linter/llm-nodes.json',
  ]);
});

test('the rule registry carries R1..R13 with no holes and every rule is callable', async () => {
  const { rules } = await import('../linter/rules/index.js');
  const ids = rules.map((r) => r.id);
  const numbers = ids.map((id) => {
    assert.match(id, /^R\d+$/, `rule id "${id}" is not of the form R<n>`);
    return Number(id.slice(1));
  }).sort((a, b) => a - b);

  assert.deepEqual(
    numbers, Array.from({ length: 13 }, (_, i) => i + 1),
    `the merged baseline is R1..R13; found ${ids.length} rule(s): ${ids.join(', ')}`,
  );
  for (const rule of rules) {
    assert.equal(typeof rule.check, 'function', `rule ${rule.id} has no check()`);
    assert.ok(rule.title && rule.title.length > 0, `rule ${rule.id} has no title`);
  }
});

// The fixture sets are deliberately asymmetric. Each rule owns a BAD fixture
// that it alone must flag, while the GOOD fixtures are shared: the
// zero-false-positive mandate means every rule must stay silent on every clean
// workflow, so a per-rule good fixture would test less, not more.
test('every registered rule owns a bad fixture, and the shared clean set is non-empty', async () => {
  const { rules } = await import('../linter/rules/index.js');
  const bad = readdirSync(join(repoRoot, 'linter', 'fixtures', 'bad'));
  const good = readdirSync(join(repoRoot, 'linter', 'fixtures', 'good'))
    .filter((f) => f.endsWith('.workflow.json'));

  const missing = rules
    .map((r) => r.id.toLowerCase())
    .filter((tag) => !bad.some((f) => f.toLowerCase().startsWith(`${tag}-`)))
    .map((tag) => `linter/fixtures/bad/${tag}-*`);
  assert.deepEqual(missing, [], `rule bad-fixtures missing:\n  ${missing.join('\n  ')}`);

  assert.ok(
    good.length >= 3,
    `the zero-false-positive mandate is measured against the clean set; found ${good.length} clean fixture(s)`,
  );
});

// --- Documentation and schema contract ------------------------------------

test('the anti-pattern catalogue documents every rule R1..R13', () => {
  const doc = read('docs/anti-patterns.md');
  const documented = new Set([...doc.matchAll(/^###\s+(R\d+)\b/gm)].map((m) => m[1]));
  const missing = Array.from({ length: 13 }, (_, i) => `R${i + 1}`).filter((id) => !documented.has(id));
  assert.deepEqual(missing, [], `docs/anti-patterns.md has no entry for: ${missing.join(', ')}`);
});

test('the triage output schema contract is present and is a real JSON Schema', () => {
  assert.ok(present('schemas/triage-output.schema.json'), 'schemas/triage-output.schema.json must exist');
  const schema = JSON.parse(read('schemas/triage-output.schema.json'));
  assert.ok(schema.properties, 'the schema must declare properties for the model output it constrains');
  assert.ok(Array.isArray(schema.required) && schema.required.length > 0,
    'a schema with no required fields cannot reject an empty answer');
});

// --- Database schema -------------------------------------------------------

test('the init schema declares every table the workflows depend on', () => {
  const sql = read('deployment/init/01-schema.sql');
  const missing = ['idempotency_keys', 'dead_letter', 'sync_audit', 'sync_heartbeat', 'sync_watermark']
    .filter((t) => !new RegExp(`create\\s+table[^;]*\\b${t}\\b`, 'i').test(sql));
  assert.deepEqual(missing, [], `deployment/init/01-schema.sql declares no table: ${missing.join(', ')}`);
});

// --- Scoped-secret tooling and its gates ----------------------------------

test('the scoped secret-delivery tooling and both env-surface gates are present', () => {
  assertAllPresent('secret surface', [
    'tools/materialise-secrets.mjs',
    'tests/env-secret-surface.test.js',
    'tests/env-corpus-surface.test.js',
    'tools/grep-gate.mjs',
    'tools/internal-vocab-denylist.txt',
    'tools/require-stack.mjs',
  ]);
});

// --- Per-workflow configuration nodes -------------------------------------
//
// Five of the six workflows carry their non-secret configuration in a labelled
// `Workflow Config` node instead of reaching into the process environment.
// wf03 is the sixth: its two provider endpoints are credential fields, so it has
// no configuration left to hold. Asserting "five, and specifically these five"
// rather than "at least one" is what makes a silently dropped config node fail.

const CONFIG_NODE_WORKFLOWS = [
  '01-order-intake',
  '02-crm-sync',
  '_shared/global-error-handler',
  '_shared/sync-watchdog',
  '_shared/dlq-replay',
];

test('each of the five migrated workflows carries its `Workflow Config` node', () => {
  const without = CONFIG_NODE_WORKFLOWS.filter((w) => {
    const wf = JSON.parse(read(`${w}/workflow.json`));
    return !wf.nodes.some((n) => n.name === 'Workflow Config');
  });
  assert.deepEqual(without, [], `no \`Workflow Config\` node in: ${without.join(', ')}`);
});

test('the parser shape fixture the linter parser is measured against is present', () => {
  assert.ok(
    present('linter/fixtures/parser/parser-shape.workflow.json'),
    'linter/fixtures/parser/parser-shape.workflow.json must exist — it is the frozen fixture the ' +
      'parser shape assertions are made against, so that a product workflow can change shape without ' +
      'a parser test needing to be weakened',
  );
});

// --- Repo-root housekeeping ------------------------------------------------

test('the repo-root housekeeping files are present', () => {
  assertAllPresent('housekeeping', ['LICENSE', 'SECURITY.md', '.env.example', '.gitignore']);
});

test('LICENSE is the MIT licence in full, not a stub', () => {
  const licence = read('LICENSE');
  assert.match(licence, /\bMIT\b/, 'LICENSE must name the MIT licence');
  assert.match(licence, /Permission is hereby granted, free of charge/,
    'LICENSE must carry the full MIT text, not just its name');
  assert.match(licence, /WITHOUT WARRANTY OF ANY KIND/,
    'LICENSE must carry the warranty disclaimer — a truncated licence grants nothing clearly');
});

test('SECURITY.md gives a reporting route and names no real contact address', () => {
  const policy = read('SECURITY.md');
  assert.match(policy, /report/i, 'SECURITY.md must tell a reporter how to report');
  assert.match(policy, /vulnerabilit/i);
  assert.match(policy, /PLACEHOLDER|example\.invalid/,
    'the contact must stay an explicit placeholder — this repository publishes no real address');
});

// --- Secret-shape scan over the committed environment example -------------
//
// A prefix on its own is not a finding: `.env.example` is *supposed* to talk
// about tokens and keys. What must never appear is a value SHAPED like a live
// credential, so every matcher below requires the body of a secret, not its
// label.

const SECRET_SHAPES = [
  { label: 'PEM private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { label: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'provider API key', re: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/ },
];
// Value-shaped high-entropy literals, applied to the right-hand side of an
// assignment only, so prose in the comments cannot trip them.
const SECRET_VALUE_SHAPES = [
  { label: 'long hex literal', re: /^[0-9a-fA-F]{32,}$/ },
  { label: 'long base64 literal', re: /^[A-Za-z0-9+/]{40,}={0,2}$/ },
];

function scanForSecretShapes(text, sourceLabel) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const { label, re } of SECRET_SHAPES) {
      if (re.test(line)) findings.push(`${sourceLabel}:${i + 1} ${label}`);
    }
    const m = line.match(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/);
    if (!m) return;
    const value = m[1].replace(/^["']|["']$/g, '');
    for (const { label, re } of SECRET_VALUE_SHAPES) {
      if (re.test(value)) findings.push(`${sourceLabel}:${i + 1} ${label}`);
    }
  });
  return findings;
}

test('the secret-shape scan can actually fail — positive control', () => {
  // §2.6: a scan that reports "no findings" is worthless until it has been shown
  // to report a finding. Every matcher is exercised against a synthetic sample.
  const control = [
    'PRIV=-----BEGIN RSA PRIVATE KEY-----',
    'JWT=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r1wV',
    'AWS=AKIAIOSFODNN7EXAMPLE',
    'GH=ghp_0123456789abcdefghijklmnopqrstuvwx',
    'SLACK=xoxb-000000000000-abcdefghij',
    'OPENAI=sk-0123456789abcdefghijklmnop',
    'HEX=0123456789abcdef0123456789abcdef',
    'B64=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
  ].join('\n');
  const findings = scanForSecretShapes(control, 'control');
  assert.equal(findings.length, 8, `every matcher must fire on the control, got:\n  ${findings.join('\n  ')}`);
});

test('.env.example carries placeholders only — no value-shaped secret', () => {
  const findings = scanForSecretShapes(read('.env.example'), '.env.example');
  assert.deepEqual(findings, [], `.env.example contains value-shaped secret(s):\n  ${findings.join('\n  ')}`);
});

// --- Build scaffolding stays out of the published tree --------------------

test('build scaffolding is git-ignored and never tracked', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^\.build\/$/m, '.gitignore must exclude .build/');
  assert.match(ignore, /^\.env$/m, '.gitignore must exclude .env');
  assert.match(ignore, /^deployment\/secrets\/$/m, '.gitignore must exclude the materialised secret surface');
});

// --- Aggregate wiring ------------------------------------------------------
//
// The measured suite total is recorded from a real run; it cannot be asserted by
// re-invoking `npm test` from inside `npm test`. What IS assertable here, and is
// the property that number actually depends on, is that the aggregate runs every
// authored test file — an aggregate that silently omits a file reports green
// over untested code.

function authoredTestFiles(dir = 'tests') {
  const out = [];
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'helpers' || entry.name === 'fixtures') continue;
      out.push(...authoredTestFiles(rel));
    } else if (entry.name.endsWith('.test.js')) {
      out.push(rel);
    }
  }
  return out.map((p) => relative('', p));
}

// The 246-era authored set: 23 offline + 12 integration files, measured at the
// merged baseline. A floor, never a ceiling — new tests raise it.
const AUTHORED_FILE_FLOOR = 35;

test('every authored test file is wired into the npm test aggregate', () => {
  const pkg = JSON.parse(read('package.json'));
  const aggregate = `${pkg.scripts['test:offline']} ${pkg.scripts['test:integration']}`;
  const unwired = authoredTestFiles().filter((f) => !aggregate.includes(f));
  assert.deepEqual(
    unwired, [],
    `these test files exist but no npm script runs them, so they are green by omission:\n  ${unwired.join('\n  ')}`,
  );
});

test('the aggregate is at or above the merged-baseline authored file count', () => {
  const files = authoredTestFiles();
  assert.ok(
    files.length >= AUTHORED_FILE_FLOOR,
    `the merged baseline authored ${AUTHORED_FILE_FLOOR} test files; this tree has ${files.length}. ` +
      'A drop means a file was deleted rather than fixed.',
  );
});
