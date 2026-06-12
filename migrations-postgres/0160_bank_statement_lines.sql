-- ============================================================================
-- HOOKKA ERP — Finance Phase 3.4: bank reconciliation statement lines.
--
-- The owner imports a monthly bank statement (CSV paste with column
-- mapping) into bank_statement_lines, then ticks each line off against
-- the matching ledger leg of that SBK/SCH account. amount_sen is SIGNED:
-- positive = money in (bank credit), negative = money out. A line is
-- reconciled when matched_leg_id points at a ledger_journal_entries row;
-- whatever remains unmatched on either side IS the 未达账项 list.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id             TEXT PRIMARY KEY,
  account_code   TEXT NOT NULL,
  txn_date       TEXT NOT NULL,
  description    TEXT,
  amount_sen     INTEGER NOT NULL,
  matched_leg_id TEXT,
  matched_at     TEXT,
  imported_at    TEXT,
  created_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_bsl_account_date
  ON bank_statement_lines (account_code, txn_date);

CREATE INDEX IF NOT EXISTS idx_bsl_matched_leg
  ON bank_statement_lines (matched_leg_id) WHERE matched_leg_id IS NOT NULL;
