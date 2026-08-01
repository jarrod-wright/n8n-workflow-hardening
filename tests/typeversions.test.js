// Schema-grounding gate: node typeVersion pins.
//
// `typeversions.json` is the authoritative record of which node version each
// workflow in this repo targets. Every value in it was confirmed by live
// node-registry introspection against the pinned n8n image — instantiating the
// node class and reading its authoritative default version — not read off a
// documentation page that may describe a different release.
//
// Two properties are enforced here:
//   1. Forward coverage — every node in every shipped workflow declares exactly
//      the pinned typeVersion. A node that drifts, or a node type nobody
//      remembered to pin, fails.
//   2. The recorded pin set covers the node types the workflows in this repo
//      are built from, at the exact versions confirmed live.
//
// Pure file check — no stack required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

const pinFile = JSON.parse(readFileSync(join(repoRoot, 'typeversions.json'), 'utf8'));
const pins = pinFile.nodeTypes;

// Every shipped workflow: <dir>/workflow.json at depth 1 or 2. A shipped
// workflow lives either in a numbered product directory (`01-…`, `02-…`) or
// under `_shared/`. Scoping by that naming convention — rather than by a
// skip-list — means the linter's deliberately-broken fixtures (which exist to
// violate these very rules) can never be picked up, and neither can any
// non-product directory added later.
const PRODUCT_DIR_RE = /^(\d{2}-|_shared$)/;

function shippedWorkflowFiles() {
  const found = [];
  for (const entry of readdirSync(repoRoot)) {
    if (!PRODUCT_DIR_RE.test(entry)) continue;
    const dir = join(repoRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const direct = join(dir, 'workflow.json');
    if (existsSync(direct)) found.push(direct);
    for (const sub of readdirSync(dir)) {
      const nested = join(dir, sub, 'workflow.json');
      if (statSync(join(dir, sub)).isDirectory() && existsSync(nested)) found.push(nested);
    }
  }
  return found;
}

test('every node in every shipped workflow declares the pinned typeVersion', () => {
  const files = shippedWorkflowFiles();
  assert.ok(files.length >= 2, `expected to find shipped workflows, found ${files.length}`);

  const problems = [];
  for (const file of files) {
    const rel = file.slice(repoRoot.length + 1);
    const wf = JSON.parse(readFileSync(file, 'utf8'));
    for (const node of wf.nodes) {
      const pin = pins[node.type];
      if (!pin) {
        problems.push(`${rel}: node "${node.name}" uses ${node.type}, which is not pinned in typeversions.json`);
        continue;
      }
      if (node.typeVersion !== pin.typeVersion) {
        problems.push(
          `${rel}: node "${node.name}" (${node.type}) declares typeVersion ${node.typeVersion}, pinned is ${pin.typeVersion}`,
        );
      }
    }
  }
  assert.deepEqual(problems, [], `typeVersion drift:\n  ${problems.join('\n  ')}`);
});

test('the pin file records a confirmation method and matches the deployed image', () => {
  assert.match(pinFile.n8n.image, /^n8nio\/n8n:\d+\.\d+\.\d+$/);
  assert.match(pinFile.n8n.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(pinFile.n8n.method && /live/i.test(pinFile.n8n.method), 'pins must record a live confirmation method');

  const compose = readFileSync(join(repoRoot, 'deployment', 'docker-compose.yml'), 'utf8');
  assert.ok(
    compose.includes(`${pinFile.n8n.image}@${pinFile.n8n.digest}`),
    'typeversions.json must name the same image:tag@digest the compose file deploys',
  );
});

test('every pin carries a numeric typeVersion and a display name', () => {
  for (const [type, pin] of Object.entries(pins)) {
    assert.equal(typeof pin.typeVersion, 'number', `${type}: typeVersion must be numeric (a pinned version, not a range)`);
    assert.ok(pin.typeVersion > 0, `${type}: typeVersion must be positive`);
    assert.ok(pin.displayName && pin.displayName.length > 0, `${type}: missing displayName`);
    assert.match(type, /^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./, `${type}: unexpected node package prefix`);
  }
});

// The node types the scheduled-sync and AI-triage workflows are built from,
// at the versions confirmed by live introspection against the pinned image.
// Listed explicitly (rather than derived from the workflows) so that dropping a
// pin AND the node that used it still fails — coverage that a purely forward
// check cannot give.
const REQUIRED_PINS = {
  // Scheduled delta-sync workflow
  'n8n-nodes-base.scheduleTrigger': 1.3,
  'n8n-nodes-base.splitInBatches': 3,
  'n8n-nodes-base.wait': 1.1,
  'n8n-nodes-base.noOp': 1,
  // AI triage workflow — the LangChain cluster
  '@n8n/n8n-nodes-langchain.agent': 3.1,
  '@n8n/n8n-nodes-langchain.chainLlm': 1.9,
  '@n8n/n8n-nodes-langchain.lmChatOpenAi': 1.3,
  '@n8n/n8n-nodes-langchain.lmChatDeepSeek': 1,
  // Carried from the order-intake workflow, reused by both
  'n8n-nodes-base.postgres': 2.7,
  'n8n-nodes-base.httpRequest': 4.4,
  'n8n-nodes-base.code': 2,
  'n8n-nodes-base.if': 2.3,
  'n8n-nodes-base.webhook': 2.1,
  'n8n-nodes-base.respondToWebhook': 1.5,
  'n8n-nodes-base.stopAndError': 1,
};

test('the pin file records every node type these workflows are built from', () => {
  const problems = [];
  for (const [type, expected] of Object.entries(REQUIRED_PINS)) {
    const pin = pins[type];
    if (!pin) {
      problems.push(`${type} is not pinned in typeversions.json`);
      continue;
    }
    if (pin.typeVersion !== expected) {
      problems.push(`${type} is pinned at ${pin.typeVersion}, live-confirmed value is ${expected}`);
    }
  }
  assert.deepEqual(problems, [], `pin set incomplete or drifted:\n  ${problems.join('\n  ')}`);
});
