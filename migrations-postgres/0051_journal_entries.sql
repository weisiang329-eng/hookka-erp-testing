-- ---------------------------------------------------------------------------
-- 0051_journal_entries.sql — Postgres mirror of migrations/0051.
--
-- Immutable accounting ledger with SHA-256 hash chain (Phase C #2 quick-win).
-- See migrations/0051_journal_entries.sql for the design rationale and
-- naming note about the legacy `journal_entries` table.
--
-- Postgres conventions:
--   * snake_case column names (d1-compat translates from D1 camelCase).
--   * Money columns end in `_sen` and use BIGINT to match how other money
--     totals are stored across the live Postgres schema (sen, no decimals).
--   * IF NOT EXISTS on every CREATE so re-runs are safe.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ledger_journal_entries (
  id            TEXT PRIMARY KEY,
  posted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  leg_no        INTEGER NOT NULL,
  account_code  TEXT NOT NULL,
  debit_sen     BIGINT NOT NULL DEFAULT 0,
  credit_sen    BIGINT NOT NULL DEFAULT 0,
  description   TEXT NOT NULL DEFAULT '',
  prev_hash     TEXT NOT NULL DEFAULT '',
  row_hash      TEXT NOT NULL,
  actor_user_id TEXT,
  org_id        TEXT NOT NULL DEFAULT 'hookka',
  reversed_by_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_lje_source     ON ledger_journal_entries(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_lje_account    ON ledger_journal_entries(account_code, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_lje_org        ON ledger_journal_entries(org_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_lje_unreversed ON ledger_journal_entries(reversed_by_id) WHERE reversed_by_id IS NULL;
