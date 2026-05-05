-- ============================================================================
-- Migration 0107 — purchase_invoice_items table
--
-- Background: purchase_invoices (migration 0057) has been header-only since
-- it was wired in 2026-04-26 — a single amountSen total and supplier link,
-- no line breakdown. The 2026-05-05 historical-purchases backfill imported
-- 556 PIs (some with up to 21 lines each) but had to drop the per-line
-- detail because the schema couldn't hold it. This migration adds that
-- detail in a real, persistent table so PI detail screens can show line
-- breakdown without drilling through to the source PO.
--
-- Mirrors the column conventions of purchase_order_items / grn_items
-- (snake_case columns, TEXT id, FK CASCADE) with two PI-specific additions:
--   * material_code is NULLABLE — fee/tax/rebate lines from supplier
--     invoices don't link to a stocked raw_material.
--   * line_type CHECK enum — distinguishes STOCKED from FEE/TAX/REBATE/
--     DISCOUNT/OTHER so the detail screen can label non-stock lines and
--     downstream code (cost cascades, tax reporting) can filter cleanly.
--
-- The PI's amount_sen is recomputed by the API from sum(line_total_sen)
-- when items[] is provided on POST/PUT, so the existing column stays as
-- the canonical total — no data drift.
-- ============================================================================
CREATE TABLE IF NOT EXISTS purchase_invoice_items (
  id              TEXT PRIMARY KEY,
  pi_id           TEXT NOT NULL,
  material_code   TEXT,
  material_name   TEXT NOT NULL,
  supplier_sku    TEXT,
  qty             DOUBLE PRECISION NOT NULL,
  unit_price_sen  INTEGER NOT NULL,
  line_total_sen  INTEGER NOT NULL,
  line_type       TEXT NOT NULL DEFAULT 'STOCKED' CHECK (line_type IN (
    'STOCKED','FEE','TAX','REBATE','DISCOUNT','OTHER'
  )),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at      TEXT,
  FOREIGN KEY (pi_id) REFERENCES purchase_invoices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_pi_id
  ON purchase_invoice_items(pi_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_material_code
  ON purchase_invoice_items(material_code);
