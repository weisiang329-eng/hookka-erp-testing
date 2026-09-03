-- sqlite mirror of migrations-postgres/0232_cash_board.sql (feeds the
-- rename-map identifier scan; columns are snake_case in BOTH dialects, so no
-- column-rename-map entries). Runtime self-applied (`ensureCashBoardTables`
-- in src/api/routes/accounting.ts) — record only.

CREATE TABLE IF NOT EXISTS bank_board_cleared (
  leg_id       TEXT PRIMARY KEY,
  account_code TEXT NOT NULL,
  cleared_on   TEXT NOT NULL,
  created_at   TEXT
);

CREATE TABLE IF NOT EXISTS planned_payments (
  id            TEXT PRIMARY KEY,
  party_name    TEXT NOT NULL,
  ref           TEXT,
  expected_date TEXT NOT NULL,
  amount_sen    INTEGER NOT NULL,
  created_at    TEXT,
  done_at       TEXT
);
