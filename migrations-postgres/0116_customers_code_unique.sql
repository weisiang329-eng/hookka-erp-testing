-- ============================================================================
-- HOOKKA ERP — Customer code (debtor sub-account) uniqueness
--
-- `customers.code` is the debtor sub-account code (UI "Creditor Code",
-- e.g. 300-H). It rolls up to the SDC control account and is the key the
-- invoice auto-post (Phase 4) uses to identify the debtor — duplicates
-- would corrupt the AR sub-ledger / aging.
--
-- Frontend + backend already reject duplicates on create/edit (Phase 2).
-- This index is the hard guarantee against races / backfills / direct
-- writes. Scoped per org (multi-tenant: org_id default 'hookka').
--
-- SAFE-APPLY GUARD: if duplicate (org_id, code) rows already exist this
-- migration FAILS LOUDLY with the exact detection query instead of a
-- cryptic index-violation — resolve the dupes by hand first, then re-run.
-- It does NOT auto-merge/rename anything (per owner: report, don't fix).
-- ============================================================================

DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT org_id, code
      FROM customers
     GROUP BY org_id, code
    HAVING COUNT(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add unique index: % duplicate (org_id, code) customer row(s) exist. Resolve them first, then re-run. Find them with:  SELECT org_id, code, COUNT(*) FROM customers GROUP BY org_id, code HAVING COUNT(*) > 1;',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_code_unique
  ON customers (org_id, code);
