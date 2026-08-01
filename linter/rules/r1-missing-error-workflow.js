// R1 — No error workflow configured.
//
// A production workflow with no `settings.errorWorkflow` has nowhere for a
// failed execution to go: no alert, no dead-letter, no operator visibility.
export default {
  id: 'R1',
  title: 'No error workflow configured',
  severity: 'error',
  check(workflow) {
    // An error handler itself (triggered by an Error Trigger) doesn't reference
    // its own error workflow — that would recurse. Exempt it.
    if (workflow.nodesOfType('n8n-nodes-base.errorTrigger').length > 0) return [];
    const ref = workflow.settings && workflow.settings.errorWorkflow;
    if (typeof ref === 'string' && ref.length > 0) return [];
    return [
      {
        message:
          'settings.errorWorkflow is not set — failures will not trigger a global error handler',
      },
    ];
  },
};
