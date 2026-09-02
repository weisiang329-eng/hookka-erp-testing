-- 0231_bank_reco_sessions.sql
--
-- Finance — monthly bank-reconciliation sessions (owner 2026-09-01:
-- 「我要做到每个月我upload文件自动对账」). The owner uploads the bank's own
-- PDF statement; the client parses it (src/lib/hlbb-statement.ts, refusing
-- any file whose running balances / footer totals don't tie), and the import
-- becomes that month's session in bank_statement_lines.
--
-- ⚠ THIS FILE IS A RECORD, NOT THE MECHANISM. Deploys in this repo do NOT
-- replay migrations-postgres/*.sql — a migration file alone is INERT on prod.
-- The load-bearing copy is the runtime self-apply `ensureBankRecoCols` in
-- src/api/routes/accounting.ts, awaited at the top of every bank-reco handler
-- that touches these columns. Keep the two in step; this file exists so the
-- schema history is readable and a database built from the migrations
-- matches prod.
--
-- ADDITIVE ONLY — nothing existing changes shape. All three are nullable and
-- NOT backfilled: rows imported before sessions existed simply have no month
-- tag / no per-row balance, which is readable as "imported pre-sessions".
--
--   stmt_month   TEXT     'YYYY-MM' — which monthly session the line belongs
--                         to. Re-importing a month replaces its unmatched
--                         lines by this tag (matched lines are kept).
--   balance_sen  INTEGER  the statement's own running balance after this
--                         line, in sen — kept so a disputed line can be
--                         re-checked against the paper without the PDF.
--   ignored_at   TEXT     ISO instant when the owner ignored the line
--                         (bank-side noise he chooses to leave out of the
--                         reconciliation report). NULL = live.

ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS stmt_month TEXT;
ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS balance_sen INTEGER;
ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS ignored_at TEXT;
