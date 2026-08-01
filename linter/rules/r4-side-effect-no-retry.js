// R4 — Network/messaging side-effecting node without retry.
//
// External calls fail transiently. A side-effecting node in a category that
// requires retry (see side-effecting-nodes.json) but without retryOnFail will
// drop the item on the first blip.
import { classify } from '../classification.js';

export default {
  id: 'R4',
  title: 'Side-effecting call without retry',
  severity: 'warning',
  check(workflow) {
    const out = [];
    for (const node of workflow.nodes) {
      const c = classify(node.type);
      if (c && c.requiresRetry && node.retryOnFail !== true) {
        out.push({
          message: `"${node.name}" (${node.type}) performs a ${c.category} call without retryOnFail — a transient failure will drop the item`,
          node: node.name,
        });
      }
    }
    return out;
  },
};
