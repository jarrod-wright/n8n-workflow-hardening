# Dead-letter replay

Reprocesses rows in `dead_letter` that have not been replayed yet, exactly once
each.

```bash
npm run wf:run -- --id=dlqreplay000001
```

## Which producer gets replayed

The replayer is a **parameterised sub-workflow**. Its `Execute Sub-workflow`
trigger takes a `{ workflow }` input, and the claim filters on it:

```js
{{ [ $json.workflow || '02-crm-sync', 50 ] }}
```

A **calling workflow** supplies that value, the way arguments are supplied to a
function. That is the mechanism for replaying a specific producer's backlog.

**On the CLI path above, the producer is always the default, `02-crm-sync`.**
`n8n execute --id` runs a saved workflow by id and has no flag that injects an
input item, so `$json.workflow` is undefined and the filter falls back. This is
a property of the sub-workflow contract, not a limitation to work around: a
parameter supplied by a caller cannot be supplied by a path that has no caller.

So: to replay `01-order-intake`, invoke this workflow from another workflow with
`{ workflow: '01-order-intake' }`. The CLI command is the operator's shortcut for
the common case, not a general selector.

## Why dead-lettering needs a replay at all

A dead-letter table with no replay path is a graveyard. It converts "we lost the
record" into "we know exactly which record we lost", which is better — but only
just. The value of dead-lettering is realised when the upstream cause is fixed
and the backlog can be pushed through without anyone hand-writing SQL at 2am.

## Exactly-once: the claim IS the update

```sql
UPDATE dead_letter SET replayed_at = now()
 WHERE id IN (
   SELECT id FROM dead_letter
    WHERE replayed_at IS NULL AND workflow = $1
    ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2::int
 )
RETURNING id, workflow, order_id, reason, payload;
```

Three things are load-bearing:

**One statement, not two.** The obvious implementation — `SELECT` the
unreplayed rows, process them, then `UPDATE` — has a window between the select
and the update in which a second replay reads the same rows. Both then process
them, and every side effect happens twice. Here the selection and the claim are
the same atomic statement, so a row is claimed by exactly one replay or by none.

**`FOR UPDATE SKIP LOCKED`.** A concurrent replay skips rows another run is
already claiming rather than blocking behind them. Two replays running at once
divide the work; they never duplicate it and never deadlock.

**`RETURNING`.** The rows this run actually won come back from the same
statement. Nothing has to be re-read, so there is no second read to disagree with
the first.

## A failed replay comes back as a NEW row

The tempting alternative is to clear `replayed_at` when a replay fails, putting
the row back in the queue. That reopens exactly the window the atomic claim
closes, and it also destroys the record of the attempt.

Instead the original row **stays claimed**, and the failure is inserted as a new
dead-letter row whose reason begins `replay failed:`. So:

- a claim is never undone, and exactly-once holds even when replays fail;
- the history is additive — you can see a record was dead-lettered, replayed,
  and dead-lettered again, with the reason at each step;
- the retry is a normal outstanding row that the next replay picks up.

## Marked, not deleted

`replayed_at` is stamped; the row stays. After a replay you can still answer "what
failed last Tuesday, and did it eventually go through?" — which is the question
that actually gets asked, usually by someone who is not you, some weeks later.

## Destinations are resolved per producing workflow

```js
const cfg = $("Workflow Config").first().json;
const DESTINATIONS = {
  "01-order-intake": cfg.UPSTREAM_API_URL,
  "02-crm-sync": cfg.CRM_SYNC_URL,
};
```

Resolved at replay time rather than stored on the row. A stored URL would strand
every row written before an endpoint moved. An unknown producer throws instead of
silently POSTing nowhere.

The two URLs come from the **`Workflow Config`** node at the head of the
workflow, not from `$env` — one labelled place per workflow holds its
configuration, and the nodes that use a value reference it rather than repeating
it. `tests/dlq-replay-destination-map.test.js` executes this map against every
producer, and against an unknown one, because the CLI path only ever exercises
the default producer's branch.

## Empty is a result, not an absence

The claim node sets `alwaysOutputData`, and a zero-row claim routes to
`Nothing To Replay`. Without that, an empty run would stop at the claim and leave
no evidence it happened at all — indistinguishable from a replay that never
started.

## Verified behaviour

The live tests assert, in order: three outstanding rows are all reprocessed and
stamped; a second replay calls the destination **zero** times (not merely
committing zero — an idempotent destination would hide a double claim); a
permanently failing replay leaves the original claimed and produces exactly one
new outstanding row; and an empty replay exits successfully.
