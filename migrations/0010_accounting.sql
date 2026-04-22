-- ============================================================================
-- HOOKKA ERP — Accounting module (Chart of Accounts + Journals + Aging + PL)
--
-- Previous stub tables with the same names existed from an earlier scaffold
-- but nothing was writing to them (routes were still mock-backed). Drop first
-- so the new schema takes effect cleanly.
--
-- Columns use the project-wide camelCase convention; only the timestamp
-- columns are snake_case per repo-wide rule (see migrations/0013_leaves.sql).
-- ============================================================================

DROP TABLE IF EXISTS journal_lines;
DROP TABLE IF EXISTS journal_entries;
DROP TABLE IF EXISTS ar_aging;
DROP TABLE IF EXISTS ap_aging;
DROP TABLE IF EXISTS pl_entries;
DROP TABLE IF EXISTS balance_sheet_entries;
DROP TABLE IF EXISTS chart_of_accounts;

CREATE TABLE chart_of_accounts (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,                 -- ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE
  parentCode  TEXT,
  balanceSen  INTEGER NOT NULL DEFAULT 0,
  isActive    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_coa_type ON chart_of_accounts(type);

CREATE TABLE journal_entries (
  id          TEXT PRIMARY KEY,
  entryNo     TEXT NOT NULL UNIQUE,
  date        TEXT NOT NULL,                 -- YYYY-MM-DD
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | POSTED | REVERSED
  createdBy   TEXT NOT NULL DEFAULT 'admin',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_journal_entries_date   ON journal_entries(date);
CREATE INDEX idx_journal_entries_status ON journal_entries(status);

CREATE TABLE journal_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  journalEntryId TEXT NOT NULL,
  lineOrder      INTEGER NOT NULL DEFAULT 0,
  accountCode    TEXT NOT NULL,
  accountName    TEXT NOT NULL DEFAULT '',
  debitSen       INTEGER NOT NULL DEFAULT 0,
  creditSen      INTEGER NOT NULL DEFAULT 0,
  description    TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (journalEntryId) REFERENCES journal_entries(id) ON DELETE CASCADE
);

CREATE INDEX idx_journal_lines_je      ON journal_lines(journalEntryId);
CREATE INDEX idx_journal_lines_account ON journal_lines(accountCode);

CREATE TABLE ar_aging (
  customerId   TEXT PRIMARY KEY,
  customerName TEXT NOT NULL DEFAULT '',
  currentSen   INTEGER NOT NULL DEFAULT 0,
  days30Sen    INTEGER NOT NULL DEFAULT 0,
  days60Sen    INTEGER NOT NULL DEFAULT 0,
  days90Sen    INTEGER NOT NULL DEFAULT 0,
  over90Sen    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE ap_aging (
  supplierId   TEXT PRIMARY KEY,
  supplierName TEXT NOT NULL DEFAULT '',
  currentSen   INTEGER NOT NULL DEFAULT 0,
  days30Sen    INTEGER NOT NULL DEFAULT 0,
  days60Sen    INTEGER NOT NULL DEFAULT 0,
  days90Sen    INTEGER NOT NULL DEFAULT 0,
  over90Sen    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE pl_entries (
  id              TEXT PRIMARY KEY,
  period          TEXT NOT NULL,            -- YYYY-MM
  accountCode     TEXT NOT NULL,
  accountName     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL,            -- REVENUE | COGS | OPERATING_EXPENSE | OTHER_INCOME | OTHER_EXPENSE
  amountSen       INTEGER NOT NULL DEFAULT 0,
  productCategory TEXT,                     -- BEDFRAME | SOFA | ACCESSORY | ALL
  customerId      TEXT,
  customerName    TEXT,
  state           TEXT
);

CREATE INDEX idx_pl_entries_period   ON pl_entries(period);
CREATE INDEX idx_pl_entries_category ON pl_entries(category);

CREATE TABLE balance_sheet_entries (
  id          TEXT PRIMARY KEY,
  accountCode TEXT NOT NULL,
  accountName TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,               -- CURRENT_ASSET | FIXED_ASSET | CURRENT_LIABILITY | LONG_TERM_LIABILITY | EQUITY
  balanceSen  INTEGER NOT NULL DEFAULT 0,
  asOfDate    TEXT NOT NULL                -- YYYY-MM-DD
);

CREATE INDEX idx_bs_as_of ON balance_sheet_entries(asOfDate);

-- Seed a minimal COA so the accounting page shows something on first load.
INSERT OR IGNORE INTO chart_of_accounts (code, name, type, parentCode, balanceSen, isActive) VALUES
  ('1000', 'Assets',                    'ASSET',     NULL,   0, 1),
  ('1100', 'Current Assets',            'ASSET',     '1000', 0, 1),
  ('1110', 'Cash at Bank',              'ASSET',     '1100', 0, 1),
  ('1120', 'Accounts Receivable',       'ASSET',     '1100', 0, 1),
  ('1130', 'Inventory',                 'ASSET',     '1100', 0, 1),
  ('1200', 'Fixed Assets',              'ASSET',     '1000', 0, 1),
  ('2000', 'Liabilities',               'LIABILITY', NULL,   0, 1),
  ('2100', 'Current Liabilities',       'LIABILITY', '2000', 0, 1),
  ('2110', 'Accounts Payable',          'LIABILITY', '2100', 0, 1),
  ('3000', 'Equity',                    'EQUITY',    NULL,   0, 1),
  ('3100', 'Retained Earnings',         'EQUITY',    '3000', 0, 1),
  ('4000', 'Revenue',                   'REVENUE',   NULL,   0, 1),
  ('4100', 'Product Sales',             'REVENUE',   '4000', 0, 1),
  ('5000', 'Cost of Goods Sold',        'EXPENSE',   NULL,   0, 1),
  ('5100', 'Raw Materials Consumed',    'EXPENSE',   '5000', 0, 1),
  ('5200', 'Direct Labour',             'EXPENSE',   '5000', 0, 1),
  ('6000', 'Operating Expenses',        'EXPENSE',   NULL,   0, 1),
  ('6100', 'Salaries & Wages',          'EXPENSE',   '6000', 0, 1),
  ('6200', 'Rent',                      'EXPENSE',   '6000', 0, 1),
  ('6300', 'Utilities',                 'EXPENSE',   '6000', 0, 1);
