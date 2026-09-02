-- sqlite mirror of migrations-postgres/0231_bank_reco_sessions.sql (feeds the
-- rename-map identifier scan; the new columns are snake_case in BOTH dialects,
-- so no column-rename-map entries). Runtime self-applied (`ensureBankRecoCols`
-- in src/api/routes/accounting.ts) — record only.

ALTER TABLE bank_statement_lines ADD COLUMN stmt_month TEXT;
ALTER TABLE bank_statement_lines ADD COLUMN balance_sen INTEGER;
ALTER TABLE bank_statement_lines ADD COLUMN ignored_at TEXT;
