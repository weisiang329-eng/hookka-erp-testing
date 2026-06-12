-- ============================================================================
-- HOOKKA ERP — Finance Phase 2 follow-up: account-code renames with history
--
-- The immutable ledger hash-chains accountCode into every row, so renaming
-- an account can NEVER rewrite historical legs. Instead a rename:
--   1. copies the COA row to the new code (children re-parented,
--      journal_lines updated directly — that table is not hash-protected),
--   2. records old_code → new_code here,
--   3. deletes the old COA row.
-- Every read surface (P&L/BS, trial balance, GL, AR/AP control, year-end
-- close) resolves codes through this table (transitively, for chained
-- renames), so prior transactions follow the account to its new code while
-- the hash chain stays intact and the rename itself stays auditable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS account_aliases (
  old_code   TEXT PRIMARY KEY,
  new_code   TEXT NOT NULL,
  renamed_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX IF NOT EXISTS idx_account_aliases_new ON account_aliases (new_code);
