// R7 — Node silently swallows errors.
//
// `continueOnFail` (legacy) or `onError: continueRegularOutput` sends a failed
// item down the normal output as if nothing happened — the failure vanishes
// with no branch to handle it. Routing to an error output
// (`continueErrorOutput`) or stopping is fine; merging errors into the happy
// path is not.
export default {
  id: 'R7',
  title: 'Node silently swallows errors',
  severity: 'warning',
  check(workflow) {
    const out = [];
    for (const node of workflow.nodes) {
      if (node.continueOnFail === true || node.onError === 'continueRegularOutput') {
        out.push({
          message: `"${node.name}" continues on error into its normal output — failures are swallowed with no handling`,
          node: node.name,
        });
      }
    }
    return out;
  },
};
