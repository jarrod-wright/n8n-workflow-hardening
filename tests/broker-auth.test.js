// Broker authentication.
//
// RED-first: this test is authored BEFORE requirepass is wired. With the broker
// running unauthenticated, an unauthenticated PING succeeds, so the "refused"
// assertion below FAILS for the correct reason (the broker is open). After
// requirepass is sourced from .env, an unauthenticated PING returns NOAUTH and
// an authenticated PING returns PONG — both assertions then hold.
//
// All broker access is from a sibling container on the internal compose
// network; the broker port is never published to the host.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { valkeyCli, isServiceRunning, loadEnv } from './helpers/stack.mjs';

let stackUp = false;
before(() => {
  stackUp = isServiceRunning('valkey');
});

test('unauthenticated PING is refused (NOAUTH)', (t) => {
  assert.ok(stackUp, 'valkey service not running — the stack must be up for this gate (no skip: a masked gate is a fail)');
  const r = valkeyCli(['ping']);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(
    out,
    /NOAUTH|Authentication required/i,
    `expected an unauthenticated PING to be refused, got: ${out.trim()}`,
  );
});

test('authenticated PING returns PONG', (t) => {
  assert.ok(stackUp, 'valkey service not running — the stack must be up for this gate (no skip: a masked gate is a fail)');
  const password = loadEnv().VALKEY_PASSWORD || '';
  const r = valkeyCli(['-a', password, '--no-auth-warning', 'ping']);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /PONG/, `expected PONG with the password, got: ${out.trim()}`);
});
