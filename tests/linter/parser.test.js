// Parser mechanics.
//
// WHY THE EXACT-SHAPE ASSERTIONS RUN AGAINST A FROZEN FIXTURE
// These tests prove the parser turns a real n8n export into a queryable model:
// node lookup, connection resolution, fan-out, and both accepted wrapper forms.
// None of that needs the CURRENT shape of a shipped workflow.
//
// They used to assert against `01-order-intake/workflow.json` — pinning its node
// count and its first-hop topology. That coupled the parser's test suite to a
// living product artefact: the assertions failed whenever the flagship
// legitimately gained a node, which says nothing about whether the parser is
// correct. A test that cannot tell a regression from an intended change is
// testing the fixture, not the code.
//
// So the exact-shape assertions moved onto `parser-shape.workflow.json`, a
// purpose-built export that exists only to be parsed and is expected never to
// change. The strictness did not move with them by accident — it is preserved
// deliberately: every count and every hop below is an exact `===`, the same as
// before. Relocating an assertion must not spend it.
//
// The flagship is still parsed here, but only through properties a node
// addition cannot break. Its real linting coverage is unaffected: the live
// `01-order-intake/workflow.json` is still parsed and linted every run by
// `tests/linter/rules-fixtures.test.js`, which requires it to produce zero
// findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorkflow, parseWorkflows, Workflow } from '../../linter/parser.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wf01Text = readFileSync(join(repoRoot, '01-order-intake', 'workflow.json'), 'utf8');
const shapeText = readFileSync(
  join(repoRoot, 'linter', 'fixtures', 'parser', 'parser-shape.workflow.json'), 'utf8',
);

// --- Exact shape, against the frozen fixture -------------------------------

test('parses an n8n export into a queryable model', () => {
  const wf = parseWorkflow(shapeText, 'parser-shape');
  assert.ok(wf instanceof Workflow);
  assert.equal(wf.name, 'parser-shape');
  assert.equal(wf.nodes.length, 7);
  assert.equal(wf.settings.errorWorkflow, 'parsershapeerr01');
});

test('model helpers resolve nodes and connections', () => {
  const wf = parseWorkflow(shapeText, 'parser-shape');
  assert.equal(wf.nodesOfType('n8n-nodes-base.postgres').length, 2);
  assert.ok(wf.getNode('Check Signature'));

  const out = wf.outgoing('Intake Webhook');
  assert.equal(out[0].node, 'Check Signature');
  const inc = wf.incoming('Check Signature');
  assert.equal(inc[0].from, 'Intake Webhook');

  // IF node fans out to two branches (true/false).
  assert.equal(wf.outgoing('Route Request').length, 2);
});

test('a multi-output node resolves each branch to its own target', () => {
  const wf = parseWorkflow(shapeText, 'parser-shape');
  const branches = wf.outgoing('Route Request');
  assert.equal(branches[0].node, 'Store Record');
  assert.equal(branches[1].node, 'Reject Request');
  assert.equal(wf.incoming('Reject Request')[0].from, 'Route Request');
});

test('accepts array and { workflows: [] } wrappers', () => {
  assert.equal(parseWorkflows(`[${shapeText}]`).length, 1);
  assert.equal(parseWorkflows(JSON.stringify({ workflows: [JSON.parse(shapeText)] })).length, 1);
});

test('rejects invalid JSON and non-workflow shapes', () => {
  assert.throws(() => parseWorkflow('{not json'));
  assert.throws(() => parseWorkflow('{"foo":1}'), /not an n8n workflow/);
});

// --- The real flagship, asserted only on properties a node addition survives ---

test('a real shipped export parses, and its declared connections resolve to real nodes', () => {
  const wf = parseWorkflow(wf01Text, 'wf01');
  assert.ok(wf instanceof Workflow);
  assert.equal(wf.name, '01-order-intake');
  assert.equal(wf.settings.errorWorkflow, 'globalerrhandler');

  // Shape-invariant: the entry point is a webhook node and its parameters
  // survive parsing. True whatever else the workflow gains or loses.
  const webhooks = wf.nodesOfType('n8n-nodes-base.webhook');
  assert.equal(webhooks.length, 1, 'the flagship has exactly one webhook entry point');
  assert.ok(webhooks[0].parameters, 'webhook parameters must survive parsing');
  assert.ok(webhooks[0].parameters.path, 'the webhook must retain its path');

  // Shape-invariant: every connection names a node that exists. This is a real
  // parser property — a dangling edge means the model is wrong — and it holds
  // no matter how many nodes the workflow has.
  const names = new Set(wf.nodes.map((n) => n.name));
  let edges = 0;
  for (const node of wf.nodes) {
    for (const edge of wf.outgoing(node.name)) {
      edges += 1;
      assert.ok(names.has(edge.node), `connection from "${node.name}" names missing node "${edge.node}"`);
      assert.ok(
        wf.incoming(edge.node).some((i) => i.from === node.name),
        `outgoing ${node.name} -> ${edge.node} has no matching incoming edge`,
      );
    }
  }
  assert.ok(edges > 0, 'the flagship must declare connections, or this check verified nothing');
});
