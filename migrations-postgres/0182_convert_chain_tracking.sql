-- ---------------------------------------------------------------------------
-- 0182 — Purchasing convert-chain per-line availability tracking (PO→GRN→PI)
--
-- Adds the consumed-quantity columns + lineage links the convert chain needs
-- to (a) consolidate upstream docs, (b) prevent double-convert/double-bill at
-- the LINE level, and (c) restore availability when a converted line is
-- deleted/cancelled.
--
--   • grn_items.invoiced_qty            — qty of this GRN line already pulled
--                                          into a PI. available-to-invoice =
--                                          accepted_qty − invoiced_qty.
--   • purchase_invoices.grn_id          — the GRN this PI was raised from.
--   • purchase_invoice_items.grn_item_id — the grn_items row a PI line consumed
--                                          (drives the increment + restore).
--
-- All columns snake_case → no column-rename-map.json entry needed.
--
-- NOTE: This file is for the record / manual migration only. Production
-- schema is applied at runtime via ensurePiMigrations() in
-- src/api/routes/purchase-invoices.ts and ensureGrnMigrations() in
-- src/api/routes/grn.ts (ADD COLUMN IF NOT EXISTS — idempotent).
-- ---------------------------------------------------------------------------

ALTER TABLE grn_items ADD COLUMN IF NOT EXISTS invoiced_qty NUMERIC DEFAULT 0;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS grn_id TEXT;
ALTER TABLE purchase_invoice_items ADD COLUMN IF NOT EXISTS grn_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_grn_id
  ON purchase_invoices(grn_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_grn_item_id
  ON purchase_invoice_items(grn_item_id);
