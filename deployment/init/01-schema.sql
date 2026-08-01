-- Runs once on first Postgres init (empty data dir). Creates the two tables the
-- order-intake workflow relies on, alongside n8n's own schema in the same DB.

-- Exactly-once ledger. The workflow performs an ATOMIC unique-constraint insert
-- keyed by idempotency_key: INSERT ... ON CONFLICT DO NOTHING RETURNING. A row
-- returned means "first time, proceed"; no row means "already processed, skip".
-- The uniqueness of idempotency_key is what makes processing exactly-once even
-- under retries or duplicate deliveries.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key text PRIMARY KEY,
    order_id        text        NOT NULL,
    execution_id    text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Dead-letter store. Orders that exhaust retries or are structurally
-- unrecoverable land here (never silently dropped), together with enough
-- context to replay or investigate.
CREATE TABLE IF NOT EXISTS dead_letter (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow     text        NOT NULL,
    execution_id text,
    order_id     text,
    reason       text        NOT NULL,
    payload      jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- Set when a replay has successfully reprocessed this row. Replay claims
    -- rows with a conditional UPDATE on this column, which is what makes replay
    -- exactly-once: two concurrent replays cannot both claim the same row, and
    -- the evidence is marked rather than deleted.
    replayed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS dead_letter_order_id_idx ON dead_letter (order_id);
-- Partial index: the replay path only ever scans rows that are still outstanding.
CREATE INDEX IF NOT EXISTS dead_letter_unreplayed_idx ON dead_letter (created_at) WHERE replayed_at IS NULL;


-- ---------------------------------------------------------------------------
-- Scheduled delta-sync tables (nightly CRM sync)
-- ---------------------------------------------------------------------------

-- Resume cursor, one row per workflow.
--
-- The critical invariant is WHERE this advances to: the cursor of the last item
-- that was successfully processed, never the last item that was *fetched*. A
-- sync that reads 50 records, writes 12, and dies must resume at record 13 — if
-- it stored the end of the page instead, records 13-50 are silently skipped and
-- nothing anywhere reports an error. That failure is invisible in every log and
-- every dashboard; it only shows up as missing data weeks later.
CREATE TABLE IF NOT EXISTS sync_watermark (
    workflow     text PRIMARY KEY,
    cursor_value text,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per run. cursor_before/cursor_after make a watermark regression
-- auditable after the fact, rather than only observable while it happens.
CREATE TABLE IF NOT EXISTS sync_audit (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow      text        NOT NULL,
    execution_id  text,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    items_read    integer     NOT NULL DEFAULT 0,
    items_synced  integer     NOT NULL DEFAULT 0,
    items_failed  integer     NOT NULL DEFAULT 0,
    cursor_before text,
    cursor_after  text,
    status        text        NOT NULL DEFAULT 'running'
);

CREATE INDEX IF NOT EXISTS sync_audit_workflow_idx ON sync_audit (workflow, started_at DESC);

-- Liveness, one row per workflow.
--
-- last_run_at and last_success_at are deliberately separate. A heartbeat that
-- only records "it ran" cannot distinguish a healthy sync from one that has
-- been failing every night for a week — the watchdog would stay quiet through
-- the entire outage. Staleness is measured against last_success_at.
CREATE TABLE IF NOT EXISTS sync_heartbeat (
    workflow        text PRIMARY KEY,
    last_run_at     timestamptz,
    last_success_at timestamptz,
    status          text,
    detail          text
);


-- ---------------------------------------------------------------------------
-- AI support-triage tables
-- ---------------------------------------------------------------------------

-- The action taken. `provider` records WHICH chain produced the result, so a
-- silent drift onto the fallback provider is visible in the data rather than
-- only in a log nobody reads.
CREATE TABLE IF NOT EXISTS triage_result (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id      text        NOT NULL UNIQUE,
    execution_id   text,
    category       text        NOT NULL,
    urgency        text        NOT NULL,
    summary        text        NOT NULL,
    requires_human boolean     NOT NULL,
    provider       text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Tickets no provider could triage into a usable shape. These are NOT failures
-- to be retried forever: they are handed to a person, with the raw model output
-- attached so whoever picks it up can see what the model actually said.
CREATE TABLE IF NOT EXISTS human_review_queue (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id    text        NOT NULL,
    execution_id text,
    reason       text        NOT NULL,
    raw_output   text,
    payload      jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz
);

CREATE INDEX IF NOT EXISTS human_review_unresolved_idx ON human_review_queue (created_at) WHERE resolved_at IS NULL;
