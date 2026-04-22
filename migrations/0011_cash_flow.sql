-- ============================================================================
-- HOOKKA ERP — Cash Flow module (bank accounts + transactions)
--
-- Previous stub tables existed from an earlier scaffold; drop first so the
-- clean schema takes effect. camelCase columns (project convention) with
-- snake_case timestamps per repo-wide rule.
-- ============================================================================

DROP TABLE IF EXISTS bank_transactions;
DROP TABLE IF EXISTS bank_accounts;

CREATE TABLE bank_accounts (
  id          TEXT PRIMARY KEY,
  bankName    TEXT NOT NULL,
  accountNo   TEXT NOT NULL,
  accountName TEXT NOT NULL,
  balanceSen  INTEGER NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'MYR',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE bank_transactions (
  id                TEXT PRIMARY KEY,
  bankAccountId     TEXT NOT NULL,
  date              TEXT NOT NULL,                   -- YYYY-MM-DD
  description       TEXT NOT NULL DEFAULT '',
  amountSen         INTEGER NOT NULL DEFAULT 0,      -- positive deposit, negative withdrawal
  type              TEXT NOT NULL,                   -- DEPOSIT | WITHDRAWAL | TRANSFER
  reference         TEXT NOT NULL DEFAULT '',
  isReconciled      INTEGER NOT NULL DEFAULT 0,
  matchedJournalId  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (bankAccountId) REFERENCES bank_accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_bank_tx_account ON bank_transactions(bankAccountId);
CREATE INDEX idx_bank_tx_date    ON bank_transactions(date);
CREATE INDEX idx_bank_tx_recon   ON bank_transactions(isReconciled);

-- Seed default company bank accounts.
INSERT OR IGNORE INTO bank_accounts (id, bankName, accountNo, accountName, balanceSen, currency) VALUES
  ('bank-1', 'Maybank',   '512345678901', 'Hookka Sdn Bhd — Operating',  5000000, 'MYR'),
  ('bank-2', 'CIMB Bank', '800123456789', 'Hookka Sdn Bhd — Payroll',     800000, 'MYR');
