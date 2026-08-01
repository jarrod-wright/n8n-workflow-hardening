// R3 — Webhook expects a response node but none exists.
//
// A webhook set to responseMode "responseNode" hands responsibility for the
// reply to a Respond to Webhook node. If there isn't one, the caller's request
// hangs until it times out.
export default {
  id: 'R3',
  title: 'Webhook expects a response node but none exists',
  severity: 'error',
  check(workflow) {
    const webhooks = workflow
      .nodesOfType('n8n-nodes-base.webhook')
      .filter((n) => n.parameters && n.parameters.responseMode === 'responseNode');
    if (webhooks.length === 0) return [];
    if (workflow.nodesOfType('n8n-nodes-base.respondToWebhook').length > 0) return [];
    return webhooks.map((n) => ({
      message: `webhook "${n.name}" uses responseMode "responseNode" but the workflow has no Respond to Webhook node — callers will hang`,
      node: n.name,
    }));
  },
};
