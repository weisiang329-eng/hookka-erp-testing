-- 0232_cash_board.sql
--
-- Daily Cash Position board (owner 2026-09-03 — his external "BANK BALANCE
-- AVAILABLE" tool rebuilt inside the ERP).
--
-- ⚠ THIS FILE IS A RECORD, NOT THE MECHANISM. Deploys do NOT replay
-- migrations-postgres/*.sql — the load-bearing copy is the runtime
-- self-apply `ensureCashBoardTables` in src/api/routes/accounting.ts,
-- awaited at the top of every cash-position handler.
--
--   bank_board_cleared — the owner's DAILY TICK: he sees a voucher go
--   through in his banking app and ticks it, so the board's bank estimate
--   is daily-accurate between monthly statements. Board metadata only: the
--   statement import + matching supersedes it, and a ticked leg whose month
--   has a statement but no match raises a warning.
--
--   planned_payments — money he intends to pay that has no voucher yet
--   (a default-off board section feeding future-date projections).

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
