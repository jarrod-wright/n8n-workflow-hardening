// R2 — Node has no pinned typeVersion.
//
// A node without an explicit numeric typeVersion floats: an n8n upgrade can
// change the node's behaviour with no change on your side.
export default {
  id: 'R2',
  title: 'Node has no pinned typeVersion',
  severity: 'error',
  check(workflow) {
    const out = [];
    for (const node of workflow.nodes) {
      if (typeof node.typeVersion !== 'number') {
        out.push({
          message: `node "${node.name}" (${node.type}) has no numeric typeVersion — it is not pinned`,
          node: node.name,
        });
      }
    }
    return out;
  },
};
