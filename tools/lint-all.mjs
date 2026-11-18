#!/usr/bin/env node
// Lint every workflow this repository ships, and fail on any ERROR.
//
// `npm run lint` lints one file at a time and the reader has to know which
// files those are. This script is the aggregate the CI and `npm test` use:
// it walks the repository for shipped workflow JSON (the three curated
// workflows and the shared ones, not the linter's own fixtures), lints each
// with the same public linter, and exits non-zero if any workflow carries an
// ERROR finding. Warnings are printed and tolerated: the fixtures that
// exercise the linter's rules live in their own tree and are never scanned.
import { readdirSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'deployment']);

function findWorkflows(dir = repoRoot) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findWorkflows(full));
    else if (entry.name === 'workflow.json') out.push(full);
  }
  return out;
}

const workflows = findWorkflows();
if (workflows.length === 0) {
  console.error('lint-all: no workflow.json found - refusing to pass an empty scan');
  process.exit(2);
}

let errors = 0;
for (const wf of workflows) {
  const rel = relative(repoRoot, wf);
  let out = '';
  try {
    out = execFileSync('node', [join(repoRoot, 'linter', 'cli.js'), 'lint', wf], { encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  const summary = out.trim().split('\n').pop() || '';
  const errs = [...out.matchAll(/^\s*ERROR\s+/gm)].length;
  const warns = [...out.matchAll(/^\s*WARN\s+/gm)].length;
  if (errs > 0) {
    errors += errs;
    console.log(`${rel}: ${summary} <-- fix or justify`);
  } else {
    console.log(`${rel}: ${summary}${errs + warns ? '' : ' (clean)'}`);
  }
}

if (errors > 0) {
  console.error(`lint-all: ${errors} ERROR finding(s) across ${workflows.length} workflow(s)`);
  process.exit(1);
}
console.log(`lint-all: ${workflows.length} workflow(s), no ERROR findings`);
