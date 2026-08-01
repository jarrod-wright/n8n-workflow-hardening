# Global error handler

A single reusable error workflow that every production workflow points to via
its **Error Workflow** setting. When a referenced workflow's execution fails,
n8n runs this workflow, which builds a structured log entry and sends an alert.

## Flow

```
Error Trigger  →  Build Log Entry (Set)  →  Send Alert (HTTP Request)
```

1. **Error Trigger** — fires when a workflow that names this one as its
   `errorWorkflow` fails. Its input carries the failed `execution` and
   `workflow` metadata.
2. **Workflow Config** — one labelled place holding this workflow's
   configuration, currently `ALERT_WEBHOOK_URL`. It passes its input through, so
   the error metadata reaches the next node untouched.
3. **Build Log Entry** — projects that metadata into a flat, structured record:
   `source`, `executionId`, `executionUrl`, `workflowId`, `workflowName`,
   `lastNode`, `errorMessage`. Carrying **`executionId`** is what makes an alert
   actionable — you can jump straight to the failed run.
4. **Send Alert** — `POST`s the record as JSON to `ALERT_WEBHOOK_URL`, read from
   the config node (`{{ $('Workflow Config').first().json.ALERT_WEBHOOK_URL }}`).
   The destination lives in one labelled node rather than being repeated in the
   node that uses it, so re-pointing this workflow at a real alerting endpoint is
   a single edit in an obvious place.

## Wiring it up

Two requirements, both of which the tests enforce:

- **Import and activate it.** An error workflow must be *active* to be invocable
  — an inactive one is silently skipped.
- **Reference it.** In each production workflow's settings, set the Error
  Workflow to `global-error-handler`. In the exported JSON that is
  `settings.errorWorkflow`.

## Node versions

Pinned to the values in [`../../typeversions.json`](../../typeversions.json):
`errorTrigger` 1, `set` 3.5, `httpRequest` 4.4.
