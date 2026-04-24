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

DROP TABLE IF EXISTS journal_lines CASCADE;
DROP TABLE IF EXISTS journal_entries CASCADE;
DROP TABLE IF EXISTS ar_aging CASCADE;
DROP TABLE IF EXISTS ap_aging CASCADE;
DROP TABLE IF EXISTS pl_entries CASCADE;
DROP TABLE IF EXISTS balance_sheet_entries CASCADE;
DROP TABLE IF EXISTS chart_of_accounts CASCADE;

CREATE TABLE chart_of_accounts (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,                 -- ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE
  parent_code  TEXT,
  balance_sen  INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX idx_coa_type ON chart_of_accounts(type);

CREATE TABLE journal_entries (
  id          TEXT PRIMARY KEY,
  entry_no     TEXT NOT NULL UNIQUE,
  date        TEXT NOT NULL,                 -- YYYY-MM-DD
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | POSTED | REVERSED
  created_by   TEXT NOT NULL DEFAULT 'admin',
  created_at  TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX idx_journal_entries_date   ON journal_entries(date);
CREATE INDEX idx_journal_entries_status ON journal_entries(status);

CREATE TABLE journal_lines (
  id             BIGSERIAL PRIMARY KEY,
  journal_entry_id TEXT NOT NULL,
  line_order      INTEGER NOT NULL DEFAULT 0,
  account_code    TEXT NOT NULL,
  account_name    TEXT NOT NULL DEFAULT '',
  debit_sen       INTEGER NOT NULL DEFAULT 0,
  credit_sen      INTEGER NOT NULL DEFAULT 0,
  description    TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE
);

CREATE INDEX idx_journal_lines_je      ON journal_lines(journal_entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_code);

CREATE TABLE ar_aging (
  customer_id   TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL DEFAULT '',
  current_sen   INTEGER NOT NULL DEFAULT 0,
  days30_sen    INTEGER NOT NULL DEFAULT 0,
  days60_sen    INTEGER NOT NULL DEFAULT 0,
  days90_sen    INTEGER NOT NULL DEFAULT 0,
  over90_sen    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE ap_aging (
  supplier_id   TEXT PRIMARY KEY,
  supplier_name TEXT NOT NULL DEFAULT '',
  current_sen   INTEGER NOT NULL DEFAULT 0,
  days30_sen    INTEGER NOT NULL DEFAULT 0,
  days60_sen    INTEGER NOT NULL DEFAULT 0,
  days90_sen    INTEGER NOT NULL DEFAULT 0,
  over90_sen    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE pl_entries (
  id              TEXT PRIMARY KEY,
  period          TEXT NOT NULL,            -- YYYY-MM
  account_code     TEXT NOT NULL,
  account_name     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL,            -- REVENUE | COGS | OPERATING_EXPENSE | OTHER_INCOME | OTHER_EXPENSE
  amount_sen       INTEGER NOT NULL DEFAULT 0,
  product_category TEXT,                     -- BEDFRAME | SOFA | ACCESSORY | ALL
  customer_id      TEXT,
  customer_name    TEXT,
  state           TEXT
);

CREATE INDEX idx_pl_entries_period   ON pl_entries(period);
CREATE INDEX idx_pl_entries_category ON pl_entries(category);

CREATE TABLE balance_sheet_entries (
  id          TEXT PRIMARY KEY,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,               -- CURRENT_ASSET | FIXED_ASSET | CURRENT_LIABILITY | LONG_TERM_LIABILITY | EQUITY
  balance_sen  INTEGER NOT NULL DEFAULT 0,
  as_of_date    TEXT NOT NULL                -- YYYY-MM-DD
);

CREATE INDEX idx_bs_as_of ON balance_sheet_entries(as_of_date);

-- Seed a minimal COA so the accounting page shows something on first load.
INSERT INTO chart_of_accounts (code, name, type, parent_code, balance_sen, is_active) VALUES
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
  ('6300', 'Utilities',                 'EXPENSE',   '6000', 0, 1) ON CONFLICT DO NOTHING;
