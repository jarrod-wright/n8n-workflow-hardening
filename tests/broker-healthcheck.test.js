// The health probe must not report Healthy while authentication is absent.
//
// `valkey-cli -a "" ping` returns PONG against an open broker, so a probe that
// only checks "does PING return PONG" reports Healthy on a completely
// unprotected instance — a fail-open control. The probe must instead assert
// that authentication is actually ENFORCED.
//
// This test stands up a broker with auth deliberately DISABLED (and keeps the
// real healthcheck from the committed compose file, only accelerating its
// cadence) and asserts the container is reported unhealthy — never healthy.
//
// RED (before remediation): the probe pings with the (empty) password and gets
// PONG, so docker reports the open broker Healthy and this test fails.
//
// GREEN (after remediation): the probe first requires that an UNauthenticated
// ping is refused, so the open broker is reported unhealthy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { labCompose, labPsAll, labDown, sleep } from './helpers/broker-lab.mjs';

const PROJECT = 'n8n-hardening-healthprobe';
const OPTS = { timeout: 180000 };

// Disable auth (no requirepass, bypass the guard) but keep the committed
// healthcheck `test:`; only speed up its cadence so "unhealthy" is reached in
// seconds instead of the production retry budget.
const OVERRIDE = join(tmpdir(), 'broker-noauth.override.yml');
writeFileSync(
  OVERRIDE,
  [
    'services:',
    '  valkey:',
    '    command: ["sh", "-c", "exec valkey-server --save \'\' --appendonly no"]',
    '    restart: "no"',
    '    healthcheck:',
    '      interval: 2s',
    '      timeout: 3s',
    '      retries: 3',
    '      start_period: 1s',
    '',
  ].join('\n'),
);

let observed = { healthy: false, unhealthy: false, last: '' };

before(async () => {
  labDown(PROJECT, { overrideFiles: [OVERRIDE] });
  labCompose(PROJECT, ['up', '-d', 'valkey'], { overrideFiles: [OVERRIDE] });
  // Poll health until it settles (unhealthy) or a healthy reading appears.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const row = labPsAll(PROJECT, 'valkey', { overrideFiles: [OVERRIDE] }).row;
    observed.last = row ? `${row.state}/${row.health}` : '(none)';
    if (row && /healthy/i.test(row.health) && !/unhealthy/i.test(row.health)) observed.healthy = true;
    if (row && /unhealthy/i.test(row.health)) { observed.unhealthy = true; break; }
    await sleep(2000);
  }
}, OPTS);

after(() => {
  labDown(PROJECT, { overrideFiles: [OVERRIDE] });
});

test('an unauthenticated broker is never reported Healthy', OPTS, () => {
  assert.equal(
    observed.healthy,
    false,
    `the probe reported Healthy on an unauthenticated broker (fail-open); last=${observed.last}`,
  );
});

test('an unauthenticated broker is reported unhealthy', OPTS, () => {
  assert.equal(
    observed.unhealthy,
    true,
    `expected the probe to mark the open broker unhealthy; last=${observed.last}`,
  );
});
