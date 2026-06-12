-- ============================================================================
-- HOOKKA ERP — account-code rename aliases
-- (SQLite mirror of migrations-postgres/0157_account_aliases.sql — D1
--  retired; kept for the rename-map identifier scan + schema parity.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS account_aliases (
  oldCode   TEXT PRIMARY KEY,
  newCode   TEXT NOT NULL,
  renamedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_aliases_new ON account_aliases (newCode);
