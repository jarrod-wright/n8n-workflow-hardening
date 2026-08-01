// Broker authentication, proven through the DOCUMENTED bring-up command path.
//
// The earlier broker-auth test only ever reached the broker through a helper
// that injected the env file explicitly, so it could not observe a broker that
// was authenticated ONLY because of that injection. This test brings a broker
// up the way the README tells a reader to — `docker compose -f <file> up -d`,
// with NO --env-file — in an isolated compose project, and asserts the broker
// still refuses an unauthenticated client.
//
// RED (before remediation): compose interpolates the password reference inside
// the server command at parse time; with no --env-file it resolves to an empty
// string, so the broker starts with `--requirepass ""` and an unauthenticated
// PING returns PONG — this test FAILS for that exact reason.
//
// GREEN (after remediation): the password reaches the container's own shell via
// env_file and is expanded there, independent of --env-file, so an
// unauthenticated PING is refused (NOAUTH).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './helpers/stack.mjs';
import { labUpValkey, labPing, labDown, sleep } from './helpers/broker-lab.mjs';

const PROJECT = 'n8n-hardening-docpath';
const OPTS = { timeout: 180000 };

let started = false;

before(async () => {
  labDown(PROJECT);
  // The documented command: no --env-file. This is the path a reader takes.
  const up = labUpValkey(PROJECT);
  started = up.code === 0;
  // Give the server a moment to accept connections regardless of health state.
  await sleep(4000);
}, OPTS);

after(() => {
  labDown(PROJECT);
});

test('documented `up` path: an unauthenticated PING is refused (NOAUTH)', OPTS, () => {
  assert.ok(started, 'valkey did not come up via the documented path');
  const r = labPing(PROJECT); // no auth
  assert.match(
    r.out,
    /NOAUTH|Authentication required/i,
    `documented bring-up left the broker open — unauthenticated PING was accepted: ${r.out.trim()}`,
  );
});

test('documented `up` path: the configured password authenticates (PONG)', OPTS, () => {
  assert.ok(started, 'valkey did not come up via the documented path');
  const password = loadEnv().VALKEY_PASSWORD || '';
  const r = labPing(PROJECT, { auth: password });
  assert.match(r.out, /PONG/, `expected PONG with the configured password, got: ${r.out.trim()}`);
});
