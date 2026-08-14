-- 0226_invoice_items_so_item_id.sql
--
-- BUG-2026-08-13-096 — the per-line link from an invoice line back to the
-- SALES ORDER line it bills.
--
-- Measured on prod 2026-08-13: 2,854 of 2,897 invoice lines (98.5%, carrying
-- RM 1,584,007.08) had no route back to a sales order at all, so both of the
-- system's own reconciliation planners reported "0 items to fix" while three
-- invoices demonstrably diverged from their sales orders. "0 items" meant
-- "cannot see", not "nothing wrong".
--
-- ⚠ THIS FILE IS A RECORD, NOT THE MECHANISM. Deploys in this repo do NOT
-- replay migrations-postgres/*.sql — a migration file alone is INERT on prod.
-- The load-bearing copy is the runtime self-apply in
-- src/api/lib/invoice-so-item-link.ts (`ensureInvoiceSoItemLinkColumn`), which
-- is awaited at the top of every handler that writes the column. Keep the two
-- in step; this file exists so the schema history is readable and so a fresh
-- database built from the migrations matches production.
--
-- Nullable on purpose. NULL is the honest value for a line whose sales-order
-- line cannot be identified UNIQUELY, and it stays NULL: a wrong link is worse
-- than a missing one, because it makes a bad audit look authoritative.

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS so_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_invoice_items_so_item_id
  ON invoice_items (so_item_id);
