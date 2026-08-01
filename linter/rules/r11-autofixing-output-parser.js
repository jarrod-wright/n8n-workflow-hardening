// R11 — A model is used to repair another model's output.
//
// The auto-fixing output parser handles a malformed response by sending it to a
// second model and asking for a corrected version. It is appealing because it
// makes the error go away in testing.
//
// It also means the step whose entire job is to be the deterministic one — the
// place where "is this answer usable?" gets a reliable answer — is itself a
// model call. Two non-deterministic steps now have to succeed instead of one,
// the failure mode is harder to reason about, every malformed response costs a
// second call, and the repair can quietly change the meaning of the answer
// rather than rejecting it.
//
// Parse and validate in code. If the answer is unusable, fall back to a
// different provider or hand the item to a person — both are decisions you can
// reason about afterwards.
import { disallowedValidator } from '../classification.js';

export default {
  id: 'R11',
  title: "A model is used to repair another model's output",
  severity: 'error',
  check(workflow) {
    const out = [];
    for (const node of workflow.nodes) {
      const bad = disallowedValidator(node.type);
      if (!bad) continue;
      out.push({
        message: `"${node.name}" (${node.type}) ${bad.reason} — validate in code and fall back or escalate instead`,
        node: node.name,
      });
    }
    return out;
  },
};
