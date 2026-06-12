-- ============================================================================
-- HOOKKA ERP — opening-balance flags
-- (SQLite mirror of migrations-postgres/0158_opening_balance.sql — D1
--  retired; kept for the rename-map identifier scan + schema parity.)
-- ============================================================================

ALTER TABLE invoices ADD COLUMN isOpening INTEGER NOT NULL DEFAULT 0;

ALTER TABLE purchase_invoices ADD COLUMN isOpening INTEGER NOT NULL DEFAULT 0;
