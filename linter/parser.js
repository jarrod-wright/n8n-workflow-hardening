// Parser: turns an exported n8n workflow JSON into a small, queryable model.
// Dependency-free. Accepts a single workflow object, an array of workflows, or
// an { workflows: [...] } wrapper (all shapes n8n's export can produce).

export class Workflow {
  constructor(wf, source = '<input>') {
    this.name = wf.name ?? null;
    this.id = wf.id ?? null;
    this.nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
    this.connections = wf.connections ?? {};
    this.settings = wf.settings ?? {};
    this.active = wf.active ?? false;
    this.source = source;
    this.raw = wf;
  }

  nodesOfType(type) {
    return this.nodes.filter((n) => n.type === type);
  }

  getNode(name) {
    return this.nodes.find((n) => n.name === name);
  }

  // Outgoing connections from a node: [{ node, type, index, outputIndex }].
  outgoing(name) {
    const c = this.connections[name];
    if (!c || !c.main) return [];
    const out = [];
    c.main.forEach((slot, outputIndex) => {
      (slot || []).forEach((conn) => {
        if (conn) out.push({ ...conn, outputIndex });
      });
    });
    return out;
  }

  // Outgoing connections that carry DATA, excluding a node's error output.
  //
  // A node with `onError: 'continueErrorOutput'` gains an extra, final output
  // whose items are n8n error objects, not results. Following it would treat
  // "the call failed" as though it were a value the workflow is acting on —
  // which is how a graph-walking rule ends up reporting a false positive
  // against a workflow that handles its failures properly.
  outgoingData(name) {
    const node = this.getNode(name);
    const conns = this.outgoing(name);
    if (!node || node.onError !== 'continueErrorOutput') return conns;
    const indices = [...new Set(conns.map((c) => c.outputIndex))];
    if (indices.length < 2) return conns;   // nothing wired to the error output
    const errorIndex = Math.max(...indices);
    return conns.filter((c) => c.outputIndex !== errorIndex);
  }

  // Incoming connections to a node: [{ from, outputIndex }].
  incoming(name) {
    const res = [];
    for (const [from, c] of Object.entries(this.connections)) {
      if (!c || !c.main) continue;
      c.main.forEach((slot, outputIndex) => {
        (slot || []).forEach((conn) => {
          if (conn && conn.node === name) res.push({ from, outputIndex });
        });
      });
    }
    return res;
  }
}

// Parse text into one or more Workflow models. Throws on invalid JSON or a
// shape that carries no nodes array.
export function parseWorkflows(text, source = '<input>') {
  const data = JSON.parse(text);
  let list;
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data.workflows)) list = data.workflows;
  else list = [data];

  const workflows = list.map((wf, i) => {
    if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes)) {
      throw new Error(`${source}: entry ${i} is not an n8n workflow (missing "nodes" array)`);
    }
    return new Workflow(wf, source);
  });
  if (workflows.length === 0) throw new Error(`${source}: no workflows found`);
  return workflows;
}

// Convenience for the common single-workflow case.
export function parseWorkflow(text, source = '<input>') {
  return parseWorkflows(text, source)[0];
}
