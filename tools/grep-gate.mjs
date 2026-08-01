#!/usr/bin/env node
// Clean-room grep gate (G-4).
//
// Scans the public product surface for any term on the internal-vocab
// denylist and exits non-zero if a match is found, so internal process or
// codename vocabulary never leaks into the published exhibit.
//
// Scope: every git-tracked and every untracked-but-not-git-ignored file,
// EXCEPT the excluded paths below (builder-only artefacts, the denylist and
// this script itself, and binary/vendor noise). Run via `npm run grep-gate`
// or as part of `npm test`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const denylistPath = join(repoRoot, 'tools', 'internal-vocab-denylist.txt');

// Builder-only or self-referential paths that must never be scanned. Anything
// here is either excluded from the public publish or is the gate's own input.
const EXCLUDE_PREFIXES = [
  'builder-inputs/',
  'tools/internal-vocab-denylist.txt',
  'tools/grep-gate.mjs',
  'node_modules/',
  '.git/',
];
const EXCLUDE_EXACT = new Set([
  'package-lock.json',
]);
// Builder-only file name patterns (session records, per-task results).
const EXCLUDE_NAME_RE = /(^|\/)(SESSION-RECORD|result-\d+)/i;
// Skip obvious binary/media by extension.
const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mov)$/i;

function parseDenylist(text) {
  const matchers = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const re = line.match(/^\/(.*)\/([a-z]*)$/);
    if (re) {
      matchers.push({ label: line, regex: new RegExp(re[1], re[2].includes('g') ? re[2] : re[2] + 'g') });
    } else {
      // Case-insensitive literal substring.
      const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matchers.push({ label: line, regex: new RegExp(escaped, 'gi') });
    }
  }
  return matchers;
}

function listCandidateFiles() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const set = new Set(
    (tracked + '\n' + untracked)
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean),
  );
  return [...set].filter((f) => {
    if (EXCLUDE_PREFIXES.some((p) => f === p || f.startsWith(p))) return false;
    if (EXCLUDE_EXACT.has(f)) return false;
    if (EXCLUDE_NAME_RE.test(f)) return false;
    if (BINARY_EXT_RE.test(f)) return false;
    return true;
  });
}

function main() {
  const matchers = parseDenylist(readFileSync(denylistPath, 'utf8'));
  const files = listCandidateFiles();
  const findings = [];

  for (const file of files) {
    let content;
    try {
      content = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      continue; // unreadable / vanished — skip
    }
    const lines = content.split('\n');
    for (const m of matchers) {
      m.regex.lastIndex = 0;
      let match;
      while ((match = m.regex.exec(content)) !== null) {
        const lineNo = content.slice(0, match.index).split('\n').length;
        findings.push({
          file,
          line: lineNo,
          term: match[0],
          matcher: m.label,
          text: (lines[lineNo - 1] || '').trim().slice(0, 120),
        });
        if (match.index === m.regex.lastIndex) m.regex.lastIndex++; // avoid zero-width loop
      }
    }
  }

  if (findings.length === 0) {
    console.log(`grep-gate: OK — scanned ${files.length} files, no internal vocabulary found.`);
    process.exit(0);
  }

  console.error(`grep-gate: FAIL — ${findings.length} internal-vocabulary match(es):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.matcher} -> "${f.term}"]`);
    console.error(`      ${f.text}`);
  }
  console.error('\nRemove internal vocabulary from the public product surface before proceeding.');
  process.exit(1);
}

main();
