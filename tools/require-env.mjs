#!/usr/bin/env node
// Front-of-chain legibility guard for a run with no `.env`.
//
// THE DEFECT THIS CLOSES
// `npm test` is an `&&` chain: grep gate, offline suite, stack preflight,
// integration suite. On a fresh clone with no `.env`, sixteen offline
// assertions fail — correctly, because the values they check genuinely are not
// there — and the chain then aborts. `tools/require-stack.mjs`, which is where
// the legible "create your .env" guidance lives, sits AFTER the offline suite
// and so never runs. The operator's first experience of this repository is
// sixteen assertion failures with no explanation, and the one message that
// would have explained them is unreachable.
//
// WHAT THIS DOES, AND DELIBERATELY DOES NOT DO
// It prints the explanation FIRST, and then gets out of the way. It exits ZERO
// even when `.env` is missing, so the chain proceeds and exactly the same
// assertions run and fail as before. That is the point: this changes how a
// failing run READS, not what it checks. Turning it into a hard gate would
// suppress sixteen real assertions, which would be a different — and worse —
// change wearing the same clothes.
//
// The path is an optional argument purely so the behaviour is testable without
// moving an operator's real `.env` out from under a running stack.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, '.env');
const examplePath = join(repoRoot, '.env.example');

export const GUIDANCE_MARKER = 'NO .env FILE';

export function guidanceFor(envExists, exampleExists = true) {
  if (envExists) return null;
  return [
    '',
    '================== NO .env FILE — READ THIS FIRST ==================',
    'There is no .env in the repository root, so the values this suite checks',
    'are not set. The assertion failures that follow are a CONSEQUENCE of that,',
    'not sixteen separate defects.',
    '',
    'Fix it:',
    '',
    '    cp .env.example .env      # then set real values locally',
    '    npm run stack:up',
    '    npm test',
    '',
    exampleExists
      ? '.env.example lists every variable, with placeholders and the reason for each.'
      : 'WARNING: .env.example is missing too — this clone is incomplete.',
    '.env is git-ignored and must never be committed.',
    '',
    'The run continues below so you can still see exactly what is being checked.',
    '====================================================================',
    '',
  ].join('\n');
}

// Only act when run as a program, so importing it for a test is side-effect free.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const message = guidanceFor(existsSync(envPath), existsSync(examplePath));
  if (message !== null) {
    // stdout, not stderr: it must interleave with the runner's own output in
    // the order it was produced, so "first" means first on the operator's
    // screen rather than first in a stream they may be discarding.
    console.log(message);
  }
  process.exit(0);
}
