-- 0206_other_party_bills_opening.sql — is_opening support for Other Party
-- Bills (owner rule 2026-07-01). Mirrors migration 0158's is_opening column on
-- invoices/purchase_invoices. INERT double-track record — prod gets the
-- column via ensureOtherPartyBillOpening() runtime self-apply in
-- src/api/routes/accounting.ts.
ALTER TABLE other_party_bills
  ADD COLUMN IF NOT EXISTS is_opening INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_other_party_bills_is_opening
  ON other_party_bills (is_opening) WHERE is_opening = 1;
