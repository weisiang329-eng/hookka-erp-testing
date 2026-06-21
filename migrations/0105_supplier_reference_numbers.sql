-- ---------------------------------------------------------------------------
-- 0105 — Supplier reference numbers on GRN + Purchase Invoice (SQLite mirror)
-- Mirrors migrations-postgres/0183_supplier_reference_numbers.sql for local dev
-- / SQLite test environment. Runtime self-apply (ensureGrnMigrations in grn.ts,
-- ensurePiMigrations in purchase-invoices.ts) handles prod.
--
--   • grns.supplier_do_no                 — supplier's DO number on this receipt
--   • purchase_invoices.supplier_do_no    — supplier's DO number on this PI
--   • purchase_invoices.supplier_invoice_no — supplier's own invoice number
-- ---------------------------------------------------------------------------

ALTER TABLE grns ADD COLUMN supplier_do_no TEXT;
ALTER TABLE purchase_invoices ADD COLUMN supplier_do_no TEXT;
ALTER TABLE purchase_invoices ADD COLUMN supplier_invoice_no TEXT;
