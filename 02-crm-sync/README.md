# 02 — Nightly CRM sync

A scheduled delta sync: every night it reads the records that changed since the
last run, writes each one to the CRM, and moves a stored cursor forward. It is
the shape of workflow that quietly loses data for months before anyone notices,
so almost everything here is about making a partial failure **visible and
resumable** instead of silent.

Run it on demand with:

```bash
npm run wf:run -- --id=crmsync000000001
```

## The failure this workflow is built around

A nightly sync fetches 50 changed records, writes 12, and dies. Tomorrow it asks
"what changed since last night?".

If the cursor was moved to the end of the fetched page — the obvious
implementation — records 13 to 50 are never fetched again. **No error is raised,
nothing appears in a log, and no dashboard turns red.** The records are simply
gone from the sync, and it surfaces weeks later as "the CRM is missing some
customers" with no trail back to the night it happened.

So the cursor advances **only to the last record that succeeded with no failure
before it**. In `Summarize Run`:

```js
for (const r of results) {
  if (!r.ok) break;   // stop at the first failure; do NOT skip over it
  lastGood = r.cursor;
}
```

Note it is *not* "the highest cursor that succeeded". If record 3 fails and
record 4 succeeds, the highest successful cursor is 4 — and resuming there skips
record 3 forever. Holding at 2 costs one harmless re-read of record 4 next run,
because the write is idempotent. **A cheap re-read beats a silent loss.**

## Structure

```
Nightly Trigger ──┐
                  ├─→ Read Watermark → Start Run Audit → Fetch Delta ─┬─→ Any Changes? ─┬─→ Prepare Contacts → Loop Over Contacts
On-demand Re-run ─┘                                                   │                 └─→ No Changes ──┐          │        ▲
                                                                      └─→ Fetch Failed ─────────────────┤          │        │
                                                                                                         ▼          │        │
                    Summarize Run ←──────────────────────────────────────────────────────────────────────┘    (done)│        │
                          │                                                                                          │        │
                          ▼                                                       ┌──→ Mark Synced ──────────────────┐│        │
                  Advance Watermark → Complete Run Audit → Update Heartbeat       │                                   ▼        │
                          │                                      │        Sync Contact ─┤                    Pace Between Batches
                          │                                      ▼                      └──→ Describe Failure → Dead-letter Contact → Confirm Dead-lettered
                          │                                   Run OK? ─┬─→ Sync Complete
                          │                                            └─→ Stop And Error
```

### Two entry points, one body

`Nightly Trigger` runs the schedule. `On-demand Re-run` lets an operator run it
now — after an upstream outage, after replaying dead letters, or when the
watchdog reports the sync has gone stale and the cause has just been fixed.

Both feed the **same** first node. An operator-triggered run is not a separate
code path that can drift from the scheduled one.

### The schedule names its timezone

`settings.timezone` is an explicit IANA zone (`Australia/Brisbane`). Without it
the schedule follows whatever the host or container is set to, and "02:15
nightly" silently means a different instant after a deploy to a differently
configured host.

Brisbane does not observe daylight saving, which is a deliberate simplification.
In a zone that does, avoid scheduling inside the transition window: a local time
in the skipped hour does not exist on the spring-forward date, and occurs twice
on the autumn date. Either pick a time outside it, or accept that one run a year
is skipped or duplicated — but decide it, don't discover it.

## The three tables

| Table | Holds | Why |
|---|---|---|
| `sync_watermark` | the resume cursor, one row per workflow | keyed per workflow, so a second sync cannot clobber this one's position |
| `sync_audit` | one row per run: counts + `cursor_before`/`cursor_after` | makes a cursor regression auditable **after** the fact, not only while it happens |
| `sync_heartbeat` | `last_run_at` and `last_success_at`, separately | see below |

The cursor lives in Postgres, **not** in workflow static data. Static data does
not survive a re-import, and nothing else — no watchdog, no operator, no query —
can see it.

The cursor update is also monotonic:

```sql
cursor_value = CASE WHEN cursor_value IS NULL OR $2 > cursor_value
               THEN $2 ELSE cursor_value END
```

so a late, retried or replayed run can never rewind the cursor and cause a
re-sync of everything.

### `last_run_at` vs `last_success_at`

These are deliberately separate columns. A heartbeat that only records "it ran"
cannot tell a healthy sync from one that has been failing every night for a
week — and a watchdog reading it would stay quiet through the entire outage.
Staleness is measured against `last_success_at`, which only moves when the run
status is `ok`.

Run status is one of:

| Status | Meaning | `last_success_at` |
|---|---|---|
| `ok` | everything read was synced (including "nothing changed") | refreshed |
| `partial` | some contacts dead-lettered; cursor held at the last good one | **not** refreshed |
| `failed` | the delta fetch itself failed; nothing read | **not** refreshed |

`partial` deliberately does not refresh the success timestamp. If one contact
fails permanently, the cursor genuinely cannot advance past it — the sync *is*
stuck, and the watchdog should say so.

## Per-contact failure isolation

`Sync Contact` retries (3 attempts, 1s apart, 10s timeout) and then uses
`onError: continueErrorOutput`, so a single bad contact routes to its own branch
instead of aborting the run. The other contacts still get synced.

The failed contact is written to `dead_letter` with its full payload, and then —
this is the part that is easy to get wrong — **it re-enters the loop as a result
record with `ok: false`**. A failure that never reaches the watermark decision is
exactly how a cursor jumps over an unprocessed record.

## Pacing

`Pace Between Batches` (a Wait node) sits on **both** the success and the failure
path, so a run made entirely of failures still paces itself instead of hammering
a struggling API. The batch size is 1: for a per-record, rate-limited API that is
the safe default, and it means each result is unambiguously tied to the contact
that produced it. Raise it when the destination supports bulk writes.

The stack's mock CRM answers `429` with `Retry-After` when driven too fast, so
the pacing and the retry behaviour are both exercised by real responses rather
than asserted in a comment.

## What every run leaves behind

Even a run that does nothing writes an audit row and refreshes the heartbeat.
Silence is never evidence of health — an absent audit row means the workflow did
not run at all, which is a different problem with a different fix.
