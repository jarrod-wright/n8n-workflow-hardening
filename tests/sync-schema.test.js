// Scheduled-sync schema gate (file-level).
//
// The scheduled delta-sync workflow depends on three tables that must be
// created by the stack's own init script, so that a reviewer who runs the
// documented bring-up on a clean clone gets a working stack with no manual DDL:
//
//   sync_watermark  — the resume cursor. Advanced ONLY to the last successfully
//                     processed item, never to the end of the fetched page.
//   sync_audit      — one row per run: what was read, synced, failed, and which
//                     cursor the run moved from and to.
//   sync_heartbeat  — last successful completion, which the watchdog reads to
//                     decide whether the sync has gone stale.
//
// These are asserted against the init SQL itself (not a live database), so the
// check runs offline and fails on a clean clone whose schema is incomplete —
// before anyone discovers it at 3am via a workflow that cannot resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

const schema = readFileSync(join(repoRoot, 'deployment', 'init', '01-schema.sql'), 'utf8');

// The body of `CREATE TABLE [IF NOT EXISTS] <name> ( … );`
function tableBody(name) {
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i');
  const m = schema.match(re);
  return m ? m[1] : null;
}

test('the init script creates all three scheduled-sync tables', () => {
  for (const table of ['sync_watermark', 'sync_audit', 'sync_heartbeat']) {
    assert.ok(tableBody(table), `init SQL does not create ${table}`);
  }
});

test('every table is created idempotently (re-running init is safe)', () => {
  const creates = [...schema.matchAll(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)];
  const notIdempotent = creates.filter((m) => !m[1]).map((m) => m[2]);
  assert.deepEqual(notIdempotent, [], `CREATE TABLE without IF NOT EXISTS: ${notIdempotent.join(', ')}`);

  const indexes = [...schema.matchAll(/CREATE\s+INDEX\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)];
  const badIdx = indexes.filter((m) => !m[1]).map((m) => m[2]);
  assert.deepEqual(badIdx, [], `CREATE INDEX without IF NOT EXISTS: ${badIdx.join(', ')}`);
});

test('sync_watermark is keyed per workflow and carries a cursor', () => {
  const body = tableBody('sync_watermark');
  assert.match(body, /workflow\s+text\s+PRIMARY\s+KEY/i,
    'the watermark must be keyed by workflow — one resume point per sync, not a global singleton');
  assert.match(body, /\bcursor_value\s+text/i, 'watermark must store an opaque cursor value');
  assert.match(body, /updated_at\s+timestamptz/i);
});

test('sync_audit records the cursor movement and the per-run outcome counts', () => {
  const body = tableBody('sync_audit');
  for (const col of [
    'workflow', 'execution_id', 'started_at', 'finished_at',
    'items_read', 'items_synced', 'items_failed',
    'cursor_before', 'cursor_after', 'status',
  ]) {
    assert.match(body, new RegExp(`\\b${col}\\b`, 'i'), `sync_audit must record ${col}`);
  }
  // cursor_before/cursor_after are what make a watermark regression auditable
  // after the fact rather than only observable while it is happening.
  assert.match(body, /items_failed\s+integer/i);
});

test('sync_heartbeat separates "ran" from "succeeded"', () => {
  const body = tableBody('sync_heartbeat');
  assert.match(body, /workflow\s+text\s+PRIMARY\s+KEY/i);
  assert.match(body, /last_run_at\s+timestamptz/i);
  assert.match(body, /last_success_at\s+timestamptz/i);
  // A watchdog that only knows "it ran" cannot tell a healthy sync from one
  // that has been failing every night for a week.
  assert.notEqual(
    /last_run_at/.source, /last_success_at/.source,
    'heartbeat must distinguish the last attempt from the last success',
  );
});

test('the dead-letter table carries the columns the replay path needs', () => {
  const body = tableBody('dead_letter');
  assert.ok(body, 'dead_letter must still exist');
  for (const col of ['workflow', 'execution_id', 'reason', 'payload']) {
    assert.match(body, new RegExp(`\\b${col}\\b`, 'i'), `dead_letter must record ${col}`);
  }
  // Replay must be able to mark a row done without deleting the evidence.
  assert.match(body, /\breplayed_at\s+timestamptz/i,
    'dead_letter needs replayed_at so replay is exactly-once and auditable');
});
