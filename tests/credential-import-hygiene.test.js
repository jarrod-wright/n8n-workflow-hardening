// Credential import files must not survive the import that consumed them.
//
// Provisioning n8n credentials headlessly means writing their values to a file
// and handing it to `import:credentials`. That file holds live secrets in
// plaintext for as long as it exists. The helper deletes it in the same call
// that creates it — but "we remembered to delete it" is a habit, not a control,
// and a habit is exactly what fails on the run nobody is watching.
//
// So the absence is asserted, in the working tree and in git history. History
// matters more than the tree: a secret committed once is a secret forever,
// because deleting it in a later commit leaves it perfectly readable in the
// earlier one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';
import { execFileSync } from 'node:child_process';

// Every path this repo has ever used to stage a credential import.
const IMPORT_PATHS = [
  'deployment/secrets/webhook-auth-credentials.json',
];

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch (e) {
    return `__GIT_ERROR__ ${e.status}`;
  }
}

test('the credential import path list is not empty — an empty list would assert nothing', () => {
  assert.ok(IMPORT_PATHS.length >= 1, 'at least one staged import path must be under watch');
});

for (const rel of IMPORT_PATHS) {
  test(`${rel}: absent from the working tree after import`, () => {
    assert.ok(
      !existsSync(join(repoRoot, rel)),
      `${rel} still exists. It carries live credential values in plaintext and must be deleted ` +
        'by the same step that creates it.',
    );
  });

  test(`${rel}: git-ignored, so it cannot be committed by accident`, () => {
    // `check-ignore` echoes the path and exits 0 only when it IS ignored.
    const out = git(['check-ignore', rel]);
    assert.equal(
      out, rel,
      `${rel} is not covered by .gitignore. Being deleted quickly is not protection — a run that ` +
        'is interrupted between write and delete would leave it stageable.',
    );
  });

  test(`${rel}: never appears anywhere in git history`, () => {
    // --all covers every ref, not just the current branch; a secret introduced
    // on any branch that was ever pushed is still a leaked secret.
    const log = git(['log', '--all', '--oneline', '--', rel]);
    assert.equal(
      log, '',
      `${rel} appears in git history:\n${log}\n` +
        'A secret committed once stays readable in that commit forever, whatever a later commit ' +
        'removes.',
    );
  });
}

test('no credential import file is currently tracked or staged under deployment/secrets/', () => {
  const tracked = git(['ls-files', '--', 'deployment/secrets/']);
  assert.equal(
    tracked, '',
    `deployment/secrets/ has tracked files:\n${tracked}\nNothing in that directory may ever be committed.`,
  );
});
