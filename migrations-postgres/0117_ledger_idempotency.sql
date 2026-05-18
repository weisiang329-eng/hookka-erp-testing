-- ============================================================================
-- HOOKKA ERP — Immutable-ledger idempotency guard
--
-- ledger_journal_entries is the single source of truth for BS/PL (Phase 3,
-- Option C). The invoice/payment/manual posters were NOT idempotent at the
-- ledger level: re-flipping an invoice DRAFT→SENT, a backfill replay, or a
-- retry would append a SECOND double-entry pair — silently doubling
-- revenue/AR with no way to tell which pair is real (the hash chain makes
-- the bad legs permanent). Same failure class as the wip_items idempotency
-- gap.
--
-- A business event writes one row PER LEG sharing (source_type, source_id);
-- leg_no distinguishes legs within the event. So the natural idempotency
-- key is (org_id, source_type, source_id, leg_no): legitimate legs 1,2,3
-- coexist; a re-post of the same event collides and is rejected. Reversals
-- are a DIFFERENT source (credit_note / void) so they are unaffected.
--
-- App-level pre-check: ledgerHasSource() in src/api/lib/journal-hash.ts
-- lets posters skip cleanly; THIS index is the hard guarantee against
-- races / backfills / direct writes.
--
-- SAFE-APPLY GUARD: if duplicate keys already exist this migration FAILS
-- LOUDLY with the detection query instead of a cryptic index violation —
-- the existing legs must be inspected/voided by hand first (per owner:
-- report, don't auto-fix money rows).
-- ============================================================================

DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT org_id, source_type, source_id, leg_no
      FROM ledger_journal_entries
     GROUP BY org_id, source_type, source_id, leg_no
    HAVING COUNT(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add ledger idempotency index: % duplicate (org_id, source_type, source_id, leg_no) ledger row(s) exist — these are double-posted legs that must be reviewed/voided by hand first. Find them with:  SELECT org_id, source_type, source_id, leg_no, COUNT(*) FROM ledger_journal_entries GROUP BY org_id, source_type, source_id, leg_no HAVING COUNT(*) > 1;',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lje_idempotent
  ON ledger_journal_entries (org_id, source_type, source_id, leg_no);
