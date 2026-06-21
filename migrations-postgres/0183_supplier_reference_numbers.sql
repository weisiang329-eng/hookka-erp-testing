-- ---------------------------------------------------------------------------
-- 0183 — Supplier reference numbers on GRN + Purchase Invoice
--
-- Owner ruling 2026-06-21: a GRN must carry the supplier's own delivery-order
-- number; a Purchase Invoice must carry the supplier's own delivery-order
-- number AND the supplier's own invoice number — for three-way matching.
--
--   • grns.supplier_do_no                 — supplier's DO number on this receipt
--   • purchase_invoices.supplier_do_no    — supplier's DO number on this PI
--   • purchase_invoices.supplier_invoice_no — supplier's own invoice number
--
-- All columns snake_case → no column-rename-map.json entry needed.
--
-- NOTE: This file is for the record / manual migration only. Production schema
-- is applied at runtime via ensureGrnMigrations() in src/api/routes/grn.ts and
-- ensurePiMigrations() in src/api/routes/purchase-invoices.ts
-- (ADD COLUMN IF NOT EXISTS — idempotent).
-- ---------------------------------------------------------------------------

ALTER TABLE grns ADD COLUMN IF NOT EXISTS supplier_do_no TEXT;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS supplier_do_no TEXT;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS supplier_invoice_no TEXT;
