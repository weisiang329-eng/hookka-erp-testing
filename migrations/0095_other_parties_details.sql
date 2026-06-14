-- ============================================================================
-- HOOKKA ERP — Other Debtor/Creditor extra detail columns
-- (SQLite mirror of migrations-postgres/0163_other_parties_details.sql — D1
--  retired; kept for the rename-map identifier scan + schema parity.)
-- ============================================================================

ALTER TABLE other_parties ADD COLUMN tin TEXT;
ALTER TABLE other_parties ADD COLUMN registrationNo TEXT;
ALTER TABLE other_parties ADD COLUMN address TEXT;
