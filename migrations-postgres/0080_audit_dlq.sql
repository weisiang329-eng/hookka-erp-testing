-- ============================================================================
-- Migration 0080 — audit_dlq (dead-letter queue for failed audit writes).
--
-- Sprint 2 task 6. Background:
--   * production-orders.ts batches up job_card_events INSERTs after a JC
--     mutation. If that batch fails (D1 transient, schema drift, NOT NULL
--     constraint surprise), the previous behaviour was just a `console.error`
--     — the audit rows were silently lost.
--   * Compliance / forensics need every failed audit write to be RECOVERABLE.
--     This DLQ table captures the original payload + the error so a sweeper
--     job can replay them once the underlying issue is fixed.
--
-- Schema:
--   id               TEXT PK, generated client-side ("dlq_<hex>" prefix).
--   original_payload JSON — the array of JobCardEventInput rows the caller
--                          tried to write, JSON-stringified.
--   error_message    TEXT — the err.message (truncated to 1024 chars to
--                          keep DB volume bounded).
--   error_kind       TEXT — short tag the writer can pick (e.g.
--                          "job_card_events.batch_failed", "audit_events.insert_failed")
--                          so consumers can filter by failing subsystem.
--   attempted_at     TEXT NOT NULL DEFAULT now() — when the write attempt
--                          ran. ISO 8601 string for easy joins with
--                          audit_events.
--   replayed_at      TEXT NULL — set by the replay sweeper when the row
--                          has been successfully re-written. Null = pending.
--
-- Re-runnable: every CREATE / INDEX is IF NOT EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_dlq (
  id               TEXT PRIMARY KEY,
  original_payload TEXT NOT NULL,
  error_message    TEXT NOT NULL DEFAULT '',
  error_kind       TEXT NOT NULL DEFAULT 'unknown',
  attempted_at     TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  replayed_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_dlq_pending
  ON audit_dlq (attempted_at)
  WHERE replayed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_dlq_kind
  ON audit_dlq (error_kind);
