// R5 — SQL built from an inline expression (injection risk).
//
// A SQL-sensitive node whose query string contains an n8n `{{ }}` expression is
// concatenating (often user-controlled) values into the SQL text. Bind values
// as query parameters instead.
import { classify } from '../classification.js';

export default {
  id: 'R5',
  title: 'SQL built from an inline expression (injection risk)',
  severity: 'error',
  check(workflow) {
    const out = [];
    for (const node of workflow.nodes) {
      const c = classify(node.type);
      if (!c || !c.sqlSensitive) continue;
      const query = node.parameters && node.parameters.query;
      if (typeof query === 'string' && query.includes('{{')) {
        out.push({
          message: `"${node.name}" builds SQL with an inline {{ }} expression — use query parameters instead of interpolating values`,
          node: node.name,
        });
      }
    }
    return out;
  },
};
