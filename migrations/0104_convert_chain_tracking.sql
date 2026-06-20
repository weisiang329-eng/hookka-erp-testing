-- ---------------------------------------------------------------------------
-- 0104 — Purchasing convert-chain per-line availability tracking (SQLite mirror)
-- Mirrors migrations-postgres/0182_convert_chain_tracking.sql for local dev /
-- SQLite test environment. Runtime self-apply (ensurePiMigrations in
-- purchase-invoices.ts, ensureGrnMigrations in grn.ts) handles prod.
--
--   • grn_items.invoiced_qty            — qty already pulled into a PI
--   • purchase_invoices.grn_id          — source GRN of the PI
--   • purchase_invoice_items.grn_item_id — source grn_items line of a PI line
-- ---------------------------------------------------------------------------

ALTER TABLE grn_items ADD COLUMN invoiced_qty NUMERIC DEFAULT 0;
ALTER TABLE purchase_invoices ADD COLUMN grn_id TEXT;
ALTER TABLE purchase_invoice_items ADD COLUMN grn_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_grn_id
  ON purchase_invoices(grn_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_grn_item_id
  ON purchase_invoice_items(grn_item_id);
