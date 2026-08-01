// R6 — Hardcoded secret in a node parameter.
//
// Secrets belong in credentials or environment references, never inline in a
// workflow that gets committed and shared. This walks every parameter value and
// flags literal secrets — a `Bearer <token>`, or a secret-named field set to a
// literal string. n8n expressions (`={{ $env.X }}`, `={{ ... }}`) are
// references, not literals, so they are never flagged.
const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|access[_-]?key)/i;
const BEARER = /^Bearer\s+[A-Za-z0-9._~+/-]{16,}=*$/;
const BASIC = /^Basic\s+[A-Za-z0-9+/]{16,}=*$/;

function isExpression(v) {
  return typeof v === 'string' && (v.startsWith('=') || v.includes('{{'));
}

function looksSecret(value) {
  if (typeof value !== 'string' || value.length < 8) return false;
  if (isExpression(value)) return false;
  return BEARER.test(value) || BASIC.test(value);
}

export default {
  id: 'R6',
  title: 'Hardcoded secret in a node parameter',
  severity: 'error',
  check(workflow) {
    const out = [];
    for (const node of workflow.nodes) {
      const hits = [];
      walk(node.parameters, null, hits);
      for (const h of hits) {
        out.push({ message: `"${node.name}" has a hardcoded secret in ${h.path} — use a credential or an $env reference`, node: node.name });
      }
    }
    return out;
  },
};

function walk(value, keyName, hits, path = 'parameters') {
  if (value == null) return;
  if (typeof value === 'string') {
    const secretByKey = keyName && SECRET_KEY.test(keyName) && value.length >= 8 && !isExpression(value);
    if (secretByKey || looksSecret(value)) hits.push({ path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, keyName, hits, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // For key/value pairs like {name, value}, judge the value against the name.
      const nextKey = k === 'value' && typeof value.name === 'string' ? value.name : k;
      walk(v, nextKey, hits, `${path}.${k}`);
    }
  }
}
