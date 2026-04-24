-- ============================================================================
-- HOOKKA ERP — Cash Flow module (bank accounts + transactions)
--
-- Previous stub tables existed from an earlier scaffold; drop first so the
-- clean schema takes effect. camelCase columns (project convention) with
-- snake_case timestamps per repo-wide rule.
-- ============================================================================

DROP TABLE IF EXISTS bank_transactions CASCADE;
DROP TABLE IF EXISTS bank_accounts CASCADE;

CREATE TABLE bank_accounts (
  id          TEXT PRIMARY KEY,
  bank_name    TEXT NOT NULL,
  account_no   TEXT NOT NULL,
  account_name TEXT NOT NULL,
  balance_sen  INTEGER NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'MYR',
  created_at  TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE bank_transactions (
  id                TEXT PRIMARY KEY,
  bank_account_id     TEXT NOT NULL,
  date              TEXT NOT NULL,                   -- YYYY-MM-DD
  description       TEXT NOT NULL DEFAULT '',
  amount_sen         INTEGER NOT NULL DEFAULT 0,      -- positive deposit, negative withdrawal
  type              TEXT NOT NULL,                   -- DEPOSIT | WITHDRAWAL | TRANSFER
  reference         TEXT NOT NULL DEFAULT '',
  is_reconciled      INTEGER NOT NULL DEFAULT 0,
  matched_journal_id  TEXT,
  created_at        TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_bank_tx_account ON bank_transactions(bank_account_id);
CREATE INDEX idx_bank_tx_date    ON bank_transactions(date);
CREATE INDEX idx_bank_tx_recon   ON bank_transactions(is_reconciled);

-- Seed default company bank accounts.
INSERT INTO bank_accounts (id, bank_name, account_no, account_name, balance_sen, currency) VALUES
  ('bank-1', 'Maybank',   '512345678901', 'Hookka Sdn Bhd — Operating',  5000000, 'MYR'),
  ('bank-2', 'CIMB Bank', '800123456789', 'Hookka Sdn Bhd — Payroll',     800000, 'MYR') ON CONFLICT DO NOTHING;
