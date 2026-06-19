-- ============================================================================
-- HOOKKA ERP — Document lifecycle (F3). `hidden` is NON-HASHED ledger metadata
-- (the row hash excludes it) so toggling it never breaks the chain; hidden=1
-- rows are excluded from ALL GL/financial reports. document_lifecycle tracks
-- per-document state (ACTIVE/VOID/DELETED) for the Audit Log + UI.
-- ============================================================================

ALTER TABLE ledger_journal_entries ADD COLUMN IF NOT EXISTS hidden INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_lje_hidden ON ledger_journal_entries (org_id, hidden);

CREATE TABLE IF NOT EXISTS document_lifecycle (
  id            TEXT PRIMARY KEY,
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','VOID','DELETED')),
  action_at     TEXT,
  actor_user_id TEXT,
  org_id        TEXT NOT NULL DEFAULT 'hookka',
  created_at    TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doclifecycle_key ON document_lifecycle (org_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_doclifecycle_state ON document_lifecycle (org_id, state);
