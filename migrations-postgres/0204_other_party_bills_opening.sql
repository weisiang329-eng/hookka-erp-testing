-- 0204_other_party_bills_opening.sql — is_opening support for Other Party
-- Bills (owner rule 2026-07-01). Mirrors migration 0158's is_opening column on
-- invoices/purchase_invoices (same name, same floor-bypass semantics via
-- rowBeforeOpening — src/lib/opening-floor.ts). An opening bill still posts
-- its OWN balanced GL entry immediately at creation (DR the chosen
-- counterAccount, CR 405-0000/305-0000 — see buildBillLegs); is_opening only
-- changes whether the Other Debtor/Creditor aging report floors it out for
-- being dated before the opening cutoff.
--
-- INERT double-track record — prod gets this column via
-- ensureOtherPartyBillOpening() runtime self-apply in
-- src/api/routes/accounting.ts (deploys do NOT run migration files).
ALTER TABLE other_party_bills
  ADD COLUMN IF NOT EXISTS is_opening INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_other_party_bills_is_opening
  ON other_party_bills (is_opening) WHERE is_opening = 1;
