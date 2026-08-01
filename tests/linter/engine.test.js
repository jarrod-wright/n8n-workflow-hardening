import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRules, hasErrors, summarize } from '../../linter/engine.js';
import { Workflow } from '../../linter/parser.js';

const wf = new Workflow({ name: 'x', nodes: [{ name: 'A', type: 't' }] }, 'test');

test('the engine emits findings produced by a rule', () => {
  const rule = {
    id: 'T-1',
    title: 'test rule',
    severity: 'warning',
    check: () => [{ message: 'flagged', node: 'A' }],
  };
  const findings = runRules(wf, [rule]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'T-1');
  assert.equal(findings[0].severity, 'warning'); // inherited from the rule
  assert.equal(findings[0].node, 'A');
});

test('a per-finding severity overrides the rule default', () => {
  const rule = { id: 'T-2', title: 't', severity: 'info', check: () => [{ message: 'm', severity: 'error' }] };
  assert.equal(runRules(wf, [rule])[0].severity, 'error');
});

test('a rule that throws is reported, not fatal', () => {
  const bad = { id: 'T-3', title: 'boom', check: () => { throw new Error('kaboom'); } };
  const findings = runRules(wf, [bad]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /threw: kaboom/);
  assert.equal(findings[0].severity, 'error');
});

test('hasErrors and summarize reflect severities', () => {
  const findings = [
    { severity: 'error' }, { severity: 'warning' }, { severity: 'warning' },
  ];
  assert.equal(hasErrors(findings), true);
  assert.deepEqual(summarize(findings), { error: 1, warning: 2, info: 0 });
  assert.equal(hasErrors([{ severity: 'warning' }]), false);
});
