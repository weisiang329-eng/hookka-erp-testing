-- ============================================================================
-- HOOKKA ERP — purchase_invoices.status: permit PARTIAL_PAID (+ CANCELLED)
--
-- 0057_purchase_invoices.sql created the table with an inline
--   status TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PAID'))
-- (Postgres auto-named it `purchase_invoices_status_check`). That list omits
-- 'PARTIAL_PAID' and 'CANCELLED', yet the application writes BOTH:
--   - supplier partial payments + the #6 supplier-discount allocation set
--     status='PARTIAL_PAID' (accounting.ts, supplier-payments.ts);
--   - PI cancellation sets status='CANCELLED' (grn.ts filters on it).
-- Against the original CHECK those writes raise a constraint violation and the
-- whole POST fails on prod — the same silent-breakage class as the never-run
-- migration 7 (paid_amount_sen) column.
--
-- Fix: drop whatever CHECK currently constrains purchase_invoices.status (the
-- inline auto-named one, OR a prior run of the named one below) and re-add a
-- permissive, NAMED constraint covering every status the app uses. Fully
-- idempotent and re-runnable. The same relaxation is also self-applied at
-- runtime (src/api/lib/ensure-partial-payment.ts) so it reaches prod even
-- before this migration is pasted into the SQL editor.
-- ============================================================================
DO $$
DECLARE
  conname_var text;
BEGIN
  -- Drop every CHECK constraint on purchase_invoices that references `status`
  -- (covers the inline 0057 auto-name and any earlier named variant).
  FOR conname_var IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'purchase_invoices'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE purchase_invoices DROP CONSTRAINT %I', conname_var);
  END LOOP;

  ALTER TABLE purchase_invoices
    ADD CONSTRAINT purchase_invoices_status_chk
    CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIAL_PAID','PAID','CANCELLED'));
END $$;
