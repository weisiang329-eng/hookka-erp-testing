-- ============================================================================
-- HOOKKA ERP — Finance Phase 2: purchase credit notes (supplier CN)
--
-- Pure finance document for purchase returns / supplier price credits:
-- never touches PO/GRN operations. POSTED legs mirror the PI APPROVED
-- posting EXACTLY, flipped: DR 400-0000 TRADE CREDITORS (gross), CR the
-- mapped purchase accounts per line (TAX lines → 706-0000 SST CHARGES).
-- items JSON mirrors purchase_invoice_items' line shape
-- [{materialCode?, description, quantity, unitPriceSen, lineType}].
-- ============================================================================

CREATE TABLE IF NOT EXISTS purchase_credit_notes (
  id                  TEXT PRIMARY KEY,
  note_number         TEXT NOT NULL,
  supplier_id         TEXT NOT NULL,
  supplier_name       TEXT NOT NULL DEFAULT '',
  purchase_invoice_id TEXT,
  pi_no               TEXT,
  date                TEXT NOT NULL,
  reason              TEXT,
  reason_detail       TEXT,
  items               TEXT,
  total_amount        INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED')),
  org_id              TEXT NOT NULL DEFAULT 'hookka',
  created_at          TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_pcn_supplier ON purchase_credit_notes (org_id, supplier_id, status);
