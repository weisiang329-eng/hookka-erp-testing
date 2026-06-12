-- ============================================================================
-- HOOKKA ERP — purchase-invoice multi-currency columns
-- (SQLite mirror of migrations-postgres/0162_pi_multicurrency.sql — D1
--  retired; kept for the rename-map identifier scan + schema parity.)
-- ============================================================================

ALTER TABLE purchase_invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'MYR';
ALTER TABLE purchase_invoices ADD COLUMN fxRate REAL;
ALTER TABLE purchase_invoices ADD COLUMN foreignAmountSen INTEGER;
ALTER TABLE purchase_invoices ADD COLUMN payFxRate REAL;
