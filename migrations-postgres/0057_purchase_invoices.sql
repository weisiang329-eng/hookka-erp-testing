-- ============================================================================
-- Migration 0057 — purchase_invoices table
--
-- Background: src/pages/procurement/pi.tsx was 100% client-side mock — it
-- synthesized PI rows from RECEIVED purchase_orders and stored "approve"
-- / "mark paid" actions in useState only. Refresh = state lost. The
-- 2026-04-26 FE/BE audit caught it as case #2 (full module not wired).
--
-- Schema mirrors the in-memory PurchaseInvoice type from pi.tsx with one
-- addition: purchaseOrderId FK so the PI is linked to the source PO row
-- (the old mock just kept a poRef string).
--
-- Status enum mirrors the frontend's PIStatus exactly so the new route
-- can validate transitions without a separate map drift:
--   DRAFT → PENDING_APPROVAL → APPROVED → PAID
-- (PAID is terminal; admins can also cancel by deleting the row while
-- still in DRAFT — no CANCELLED status today, can be added later if AP
-- finds they need to keep cancelled records.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS purchase_invoices (
  id              TEXT PRIMARY KEY,
  pi_no            TEXT NOT NULL UNIQUE,
  purchase_order_id TEXT,
  po_ref           TEXT,
  supplier_id      TEXT NOT NULL,
  supplier_name    TEXT NOT NULL,
  invoice_date     TEXT,
  due_date         TEXT,
  amount_sen       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN (
    'DRAFT','PENDING_APPROVAL','APPROVED','PAID'
  )),
  remarks         TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_supplier_id
  ON purchase_invoices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_status
  ON purchase_invoices(status);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_invoice_date
  ON purchase_invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_purchase_order_id
  ON purchase_invoices(purchase_order_id);
