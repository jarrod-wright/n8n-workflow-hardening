// The broker must FAIL CLOSED on a missing password.
//
// A silently-unauthenticated broker is the worst failure mode for a queue that
// is meant to be authenticated, so an empty/unset password must abort startup
// with a fatal message — never yield a running, open broker.
//
// RED (before remediation): nothing guards the password, so an empty value just
// starts `valkey-server --requirepass ""` — the container keeps RUNNING and this
// test fails because it never exited.
//
// GREEN (after remediation): a guard ahead of `exec valkey-server` detects the
// empty value, logs a fatal message naming VALKEY_PASSWORD, and exits non-zero.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { labCompose, labPsAll, labLogs, labDown, sleep } from './helpers/broker-lab.mjs';

const PROJECT = 'n8n-hardening-failclosed';
const OPTS = { timeout: 180000 };

// Override that forces an EMPTY password (overriding env_file) and disables the
// restart policy so an aborted container stays observably exited.
const OVERRIDE = join(tmpdir(), 'broker-empty-password.override.yml');
writeFileSync(
  OVERRIDE,
  [
    'services:',
    '  valkey:',
    '    environment:',
    '      - VALKEY_PASSWORD=',
    '    restart: "no"',
    '',
  ].join('\n'),
);

let psRow = null;
let logs = '';

before(async () => {
  labDown(PROJECT, { overrideFiles: [OVERRIDE] });
  labCompose(PROJECT, ['up', '-d', 'valkey'], { overrideFiles: [OVERRIDE] });
  await sleep(4000);
  psRow = labPsAll(PROJECT, 'valkey', { overrideFiles: [OVERRIDE] }).row;
  logs = labLogs(PROJECT, 'valkey', { overrideFiles: [OVERRIDE] });
}, OPTS);

after(() => {
  labDown(PROJECT, { overrideFiles: [OVERRIDE] });
});

test('an empty VALKEY_PASSWORD aborts broker startup (non-zero exit)', OPTS, () => {
  assert.ok(psRow, 'valkey container was never created');
  assert.match(
    psRow.state,
    /exited|dead/i,
    `broker must not keep running with an empty password — state was "${psRow.state}" (exit ${psRow.exit})`,
  );
  assert.notEqual(psRow.exit, 0, 'broker must exit non-zero when the password is empty');
});

test('the abort names VALKEY_PASSWORD in a fatal log line', OPTS, () => {
  assert.match(logs, /VALKEY_PASSWORD/, `expected the fatal log to name VALKEY_PASSWORD, got:\n${logs}`);
  assert.match(logs, /fatal/i, `expected an explicit fatal message, got:\n${logs}`);
});
