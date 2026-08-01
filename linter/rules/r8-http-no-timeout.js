// R8 — Network call without a timeout.
//
// A node in a category that requires a timeout (see side-effecting-nodes.json)
// with no `options.timeout` can block on an unresponsive upstream indefinitely,
// tying up a worker slot.
import { classify } from '../classification.js';

export default {
  id: 'R8',
  title: 'Network call without a timeout',
  severity: 'warning',
  check(workflow) {
    const out = [];
    for (const node of workflow.nodes) {
      const c = classify(node.type);
      if (!c || !c.requiresTimeout) continue;
      const timeout = node.parameters && node.parameters.options && node.parameters.options.timeout;
      if (!(typeof timeout === 'number' && timeout > 0)) {
        out.push({
          message: `"${node.name}" (${node.type}) has no request timeout — it can hang a worker indefinitely`,
          node: node.name,
        });
      }
    }
    return out;
  },
};
