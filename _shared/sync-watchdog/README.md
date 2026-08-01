# Sync watchdog

Runs hourly. Alerts when a scheduled sync has not **succeeded** within its
threshold, and stays silent otherwise.

```bash
npm run wf:run -- --id=syncwatchdog001
```

## Why a workflow needs a watchdog at all

Every other guard in this repo fires when something *happens*: a call fails, a
signature is wrong, a record is rejected. None of them fire when nothing happens
at all.

A scheduled workflow that stops being triggered — deactivated during an incident
and never reactivated, or broken by a credential that expired — produces no
errors, because it produces nothing. The dashboards stay green. The only signal
is an absence, and absence is exactly what alerting systems are worst at
noticing.

This workflow inverts that: it watches for silence and treats it as the fault.

## Staleness is measured against `last_success_at`

This is the whole design, in one column choice.

`sync_heartbeat` records `last_run_at` and `last_success_at` separately. A
watchdog reading `last_run_at` would see a nightly sync that runs every night and
fails every night as perfectly healthy — it *ran*, after all — and would stay
quiet through the entire outage. Reading `last_success_at` catches it on the
second night.

```sql
WHERE coalesce(last_success_at, TIMESTAMPTZ 'epoch') < now() - ($1::text)::interval
```

The `coalesce` matters too: a sync that has **never** succeeded has a NULL there.
Without the coalesce it would fall out of the comparison entirely and never
alert — the worst case would be the one case that stayed invisible.

## The threshold

**26 hours** for a nightly sync: 24 hours of cadence plus a 2-hour grace window,
so a run that starts late or takes a while does not page anyone.

The number is a bound value, not a literal buried in the SQL, and a test asserts
it is above 24h (or it would alert every single day) and below 48h (or it would
hide an entire missed night).

## The query always returns exactly one row

```sql
SELECT count(*)::int AS stale_count, coalesce(string_agg(...), '') AS stale_detail
  FROM sync_heartbeat WHERE ...
```

A query that returned the stale rows themselves would return **zero rows when
everything is healthy**, and a zero-row result stops the branch dead. The healthy
path would simply never execute — so the workflow could not distinguish "all
clear" from "the watchdog itself is broken", which is a strange property for a
watchdog to have.

Aggregating means the check always produces a result, and the `if` decides what
to do with it.

## What the alert says

```json
{
  "source": "sync-watchdog",
  "severity": "warning",
  "threshold": "26 hours",
  "stale_count": 1,
  "detail": "02-crm-sync (last success: 2026-07-23 02:15:00Z, status: partial)",
  "message": "1 scheduled sync(s) have not succeeded within 26 hours: ..."
}
```

An alert that only said "a sync is stale" would send whoever is on call straight
back to the database to find out which one, since when, and against what
threshold. This one carries all three.

The alert POST retries — a dropped alert is indistinguishable from no alert.

## What it does not cover

The heartbeat row is created by a sync's first run, so a workflow that has
**never run once** has no row and cannot be found here. That is a deployment
check, not a liveness check, and it belongs where the workflow is deployed rather
than in a watchdog that reads runtime state.
