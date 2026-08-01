// R10 — A model's answer is acted on without being validated.
//
// A model will eventually return something you did not ask for: fenced JSON,
// prose around the JSON, a field that is a number where the contract says
// string, an enum value that does not exist. If that answer reaches a node with
// a real side effect — a database write, an HTTP call, a message — the workflow
// acts on it anyway.
//
// This walks forward from every node that emits a model's answer and reports a
// path that reaches a side-effecting node without passing through anything that
// checks the shape first. `validation-nodes.json` defines what counts as a
// check, and deliberately does not count "any Code node that happens to be in
// the way".
import { classify, llmConsumer, isValidator } from '../classification.js';

export default {
  id: 'R10',
  title: "A model's answer is acted on without validation",
  severity: 'error',
  check(workflow) {
    const out = [];

    for (const source of workflow.nodes.filter((n) => llmConsumer(n.type))) {
      // Breadth-first from the model's output. A branch that hits a validator is
      // safe and is not explored further; a branch that hits a side effect first
      // is the finding.
      const seen = new Set([source.name]);
      const queue = workflow.outgoingData(source.name).map((c) => c.node);
      let reached = null;

      while (queue.length > 0 && !reached) {
        const name = queue.shift();
        if (seen.has(name)) continue;
        seen.add(name);

        const node = workflow.getNode(name);
        if (!node) continue;
        if (isValidator(node)) continue;           // this branch is checked

        if (classify(node.type)) {
          reached = node;                           // side effect, unchecked
          break;
        }
        for (const c of workflow.outgoingData(name)) queue.push(c.node);
      }

      if (reached) {
        out.push({
          message:
            `"${source.name}" emits a model's answer that reaches "${reached.name}" (${reached.type}) ` +
            'without passing through any validation — a malformed or off-contract response will be acted on',
          node: source.name,
        });
      }
    }

    return out;
  },
};
