// R12 — A workflow acts on a model's answer with only one provider behind it.
//
// Model providers have outages, rate limits, capacity rationing, and account
// suspensions. When the only provider is down, a workflow that ACTS on a
// model's answer stops doing its job entirely — and because the failure is
// upstream, there is nothing in the workflow to fix while it is happening.
//
// Retrying the same provider does not help: it fails for the same reason at the
// same moment. What helps is a second chain on a genuinely different vendor.
//
// Scope is deliberately narrow to keep this from being noise: it fires only when
// the model's answer reaches a node with a real side effect. A workflow that
// merely summarises something for a human has no automation to keep running, and
// a second provider would be cost for no resilience.
import { classify, llmProvider, llmConsumer } from '../classification.js';

export default {
  id: 'R12',
  title: 'Workflow acts on a model answer with a single provider',
  severity: 'warning',
  check(workflow) {
    const providers = workflow.nodes.filter((n) => llmProvider(n.type));
    if (providers.length === 0) return [];

    // Only care when the answer is acted on — reachable side effect downstream.
    const consumers = workflow.nodes.filter((n) => llmConsumer(n.type));
    const actsOnAnswer = consumers.some((c) => {
      const seen = new Set([c.name]);
      const queue = workflow.outgoingData(c.name).map((x) => x.node);
      while (queue.length > 0) {
        const name = queue.shift();
        if (seen.has(name)) continue;
        seen.add(name);
        const node = workflow.getNode(name);
        if (!node) continue;
        if (classify(node.type)) return true;
        for (const x of workflow.outgoingData(name)) queue.push(x.node);
      }
      return false;
    });
    if (!actsOnAnswer) return [];

    const vendors = new Set(providers.map((n) => llmProvider(n.type).vendor));
    if (vendors.size > 1) return [];

    const only = [...vendors][0];
    const detail = providers.length === 1
      ? `"${providers[0].name}" is the only model provider`
      : `all ${providers.length} model providers are ${only}`;

    return [{
      message:
        `${detail}, and this workflow acts on the answer — a ${only} outage stops it completely. ` +
        'Add a fallback chain on a different vendor; retrying the same provider fails for the same reason.',
      node: providers[0].name,
    }];
  },
};
