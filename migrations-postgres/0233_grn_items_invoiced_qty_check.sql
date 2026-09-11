-- 0233_grn_items_invoiced_qty_check.sql
--
-- T-006 R5 — DB backstop for the GRN→PI / PO→PI invoice ceiling. Mirrors the
-- sales-side chk_doi_invoiced_qty constraint (0214_do_partial_invoice.sql)
-- so the purchasing side gets the same last-line-of-defense the sales side
-- already has: two concurrent purchase-invoice creates against the same GRN
-- line can no longer both commit, even if the application-level check races.
--
-- ⚠ THIS FILE IS A RECORD, NOT THE MECHANISM. Deploys in this repo do NOT
-- replay migrations-postgres/*.sql — a migration file alone is INERT on prod.
-- The load-bearing copy is the runtime self-apply `ensureGrnInvoicedQtyCheck`
-- in src/api/routes/purchase-invoices.ts, awaited before every write that
-- increments grn_items.invoiced_qty. Keep the two in step.
-- NOT VALID: a new CHECK is normally validated against every EXISTING row
-- immediately, and this repo has already measured real over-invoicing
-- history (that is the reason this constraint exists). If even one old
-- grn_items row already fails it, a validating ADD CONSTRAINT would refuse
-- to install — and since this self-apply runs before every PI create/edit,
-- that failure would block the whole feature, not just future races.
-- NOT VALID skips checking history and enforces the rule for every write
-- from here on; nobody has queried whether historical rows are clean, so
-- this does not claim they are (see CLAUDE.md "never state prod state you
-- did not measure"). Run `VALIDATE CONSTRAINT chk_grn_items_invoiced_qty`
-- separately, later, once someone has actually checked.
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS` — guard with a DO block.
DO $$
BEGIN
  ALTER TABLE grn_items
    ADD CONSTRAINT chk_grn_items_invoiced_qty
    CHECK (invoiced_qty >= 0 AND invoiced_qty <= accepted_qty) NOT VALID;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
