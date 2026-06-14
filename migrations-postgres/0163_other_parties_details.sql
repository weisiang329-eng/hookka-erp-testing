-- ============================================================================
-- HOOKKA ERP — Finance: richer Other Debtor / Other Creditor details.
--
-- Owner: the registry needs the same identifying fields a customer/supplier
-- has — TIN (LHDN e-Invoice tax id), business registration no (SSM), and
-- address — for statements, e-Invoice and correspondence.
-- ============================================================================

ALTER TABLE other_parties ADD COLUMN IF NOT EXISTS tin TEXT;
ALTER TABLE other_parties ADD COLUMN IF NOT EXISTS registration_no TEXT;
ALTER TABLE other_parties ADD COLUMN IF NOT EXISTS address TEXT;
