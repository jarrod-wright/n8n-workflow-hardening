// Loads the side-effecting-nodes classification contract and resolves a node
// type to its category + hardening requirements.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const contract = JSON.parse(readFileSync(join(here, 'side-effecting-nodes.json'), 'utf8'));

// Returns { category, requiresRetry, requiresTimeout, sqlSensitive } or null.
export function classify(nodeType) {
  const entry = contract.nodes[nodeType];
  if (!entry) return null;
  return { category: entry.category, ...(contract.categories[entry.category] || {}) };
}

// --- AI classification (llm-nodes.json / validation-nodes.json) -------------

export const llmContract = JSON.parse(readFileSync(join(here, 'llm-nodes.json'), 'utf8'));
export const validationContract = JSON.parse(readFileSync(join(here, 'validation-nodes.json'), 'utf8'));

// A node that supplies a model to a chain/agent. Returns { vendor } or null.
export function llmProvider(nodeType) {
  return llmContract.providers[nodeType] || null;
}

// A node that emits a model's answer into the main data flow.
export function llmConsumer(nodeType) {
  return llmContract.consumers[nodeType] || null;
}

// Does this node validate a model's answer before anything acts on it?
export function isValidator(node) {
  if (validationContract.nodes[node.type]) return true;
  if (node.type !== 'n8n-nodes-base.code') return false;
  const js = (node.parameters && node.parameters.jsCode) || '';
  const { requireAll = [], requireAny = [] } = validationContract.code;
  if (!requireAll.every((m) => js.includes(m))) return false;
  return requireAny.length === 0 || requireAny.some((m) => js.includes(m));
}

export function disallowedValidator(nodeType) {
  return validationContract.disallowed[nodeType] || null;
}
