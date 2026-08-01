#!/usr/bin/env node
// n8n workflow linter — CLI.
//
//   node linter/cli.js lint <file.json> [--json]
//
// Parses an exported workflow, runs the rule set, prints findings, and exits
// non-zero if any error-severity finding is present (so it drops into CI).

import { readFileSync } from 'node:fs';
import { parseWorkflows } from './parser.js';
import { runRules, hasErrors, summarize } from './engine.js';
import { rules } from './rules/index.js';

const SEVERITY_TAG = { error: 'ERROR', warning: 'WARN ', info: 'INFO ' };

function usage(code) {
  const out = code === 0 ? console.log : console.error;
  out('Usage: n8n-lint lint <file.json> [--json]');
  process.exit(code);
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const [command, file] = positional;

  if (command !== 'lint' || !file) return usage(command ? 1 : 0);

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    process.exit(2);
  }

  let workflows;
  try {
    workflows = parseWorkflows(text, file);
  } catch (e) {
    console.error(`parse error: ${e.message}`);
    process.exit(2);
  }

  const results = workflows.map((wf) => ({
    workflow: wf.name || wf.id || '<unnamed>',
    findings: runRules(wf, rules),
  }));

  if (asJson) {
    console.log(JSON.stringify({ file, results }, null, 2));
  } else {
    report(file, results);
  }

  const anyError = results.some((r) => hasErrors(r.findings));
  process.exit(anyError ? 1 : 0);
}

function report(file, results) {
  let total = 0;
  for (const { workflow, findings } of results) {
    console.log(`\n${file} › ${workflow}`);
    if (findings.length === 0) {
      console.log('  ✓ no findings');
      continue;
    }
    for (const f of findings) {
      total += 1;
      const where = f.node ? ` [${f.node}]` : '';
      console.log(`  ${SEVERITY_TAG[f.severity] || f.severity} ${f.ruleId}${where}: ${f.message}`);
    }
  }
  const totals = summarize(results.flatMap((r) => r.findings));
  console.log(
    `\n${total} finding(s): ${totals.error} error, ${totals.warning} warning, ${totals.info} info`,
  );
}

main(process.argv);
