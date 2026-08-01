// Engine: runs a set of rules over a parsed Workflow and collects findings.
//
// A rule is a plain object: { id, title, severity?, check(workflow) -> finding[] }
// where each finding is { message, node?, severity? }. A rule that throws is
// itself reported (a broken rule must never mask or crash the run).

export const SEVERITIES = ['error', 'warning', 'info'];

export function runRules(workflow, rules) {
  const findings = [];
  for (const rule of rules) {
    let produced;
    try {
      produced = rule.check(workflow) || [];
    } catch (e) {
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        severity: 'error',
        message: `rule ${rule.id} threw: ${e.message}`,
        node: null,
      });
      continue;
    }
    for (const f of produced) {
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        severity: f.severity || rule.severity || 'error',
        message: f.message,
        node: f.node || null,
      });
    }
  }
  return findings;
}

export function hasErrors(findings) {
  return findings.some((f) => f.severity === 'error');
}

// Group findings by severity for reporting.
export function summarize(findings) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}
