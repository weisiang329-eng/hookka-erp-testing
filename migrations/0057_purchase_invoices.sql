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
  piNo            TEXT NOT NULL UNIQUE,
  purchaseOrderId TEXT,
  poRef           TEXT,
  supplierId      TEXT NOT NULL,
  supplierName    TEXT NOT NULL,
  invoiceDate     TEXT,
  dueDate         TEXT,
  amountSen       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN (
    'DRAFT','PENDING_APPROVAL','APPROVED','PAID'
  )),
  remarks         TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  FOREIGN KEY (purchaseOrderId) REFERENCES purchase_orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_supplierId
  ON purchase_invoices(supplierId);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_status
  ON purchase_invoices(status);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_invoiceDate
  ON purchase_invoices(invoiceDate);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_purchaseOrderId
  ON purchase_invoices(purchaseOrderId);
