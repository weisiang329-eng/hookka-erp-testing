-- ============================================================================
-- Migration 0070 - Consignment Note → Sales Invoice link
--
-- Renumbered from the originally-spec'd 0068: that slot was already taken
-- by 0068_qc_module_phase1.sql which landed in main while this branch was
-- in flight, and 0069_service_orders.sql followed. Bumping to 0070 keeps
-- the migration log monotonically increasing without renaming the in-flight
-- siblings.
--
-- BACKGROUND:
--   Consignment Notes are the post-production dispatch document for CO-origin
--   goods (see 0066_consignment_notes_dispatch_linkage.sql for the broader
--   CN refactor). Once the goods are at the customer's branch and the
--   customer reports a sale, the operator converts the CN to a Sales
--   Invoice — but the linkage was previously one-way (only by reading the
--   invoice's notes). This migration adds an explicit FK column on
--   consignment_notes pointing at the generated invoice.
--
-- WHY ONE-WAY (CN → Invoice, not Invoice → CN):
--   Invoices already have a `delivery_order_id` column (see invoices.do_no
--   in 0001_init.sql line 533). Adding a parallel `consignment_note_id`
--   would force every read path that joins invoice→source-doc to handle
--   the XOR, complicating downstream queries (e-invoicing, AR aging, etc.).
--   By keeping the link on the CN side only, invoices stay a single-shape
--   record (FK to a DO is canonical; CN-origin invoices simply have a NULL
--   delivery_order_id and the CN page is the only surface that cares).
--
-- IDEMPOTENCY:
--   ADD COLUMN IF NOT EXISTS — re-running the migration is a no-op.
--
-- LINKED CHANGES:
--   - src/api/routes/consignment-notes.ts gains POST /:id/convert-to-invoice
--     which writes this column.
--   - src/api/lib/consignment-note-shared.ts row→object mapper exposes the
--     new field on every CN response.
--   - src/api/lib/column-rename-map.json adds the camelCase ↔ snake_case
--     pair so D1Compat translates "convertedInvoiceId" → "converted_invoice_id"
--     transparently.
--
-- DEPLOYMENT:
--   Apply manually via Supabase SQL Editor. The CI step that auto-applies
--   D1 migrations was retired 2026-04-27 (see MEMORY.md).
-- ============================================================================

ALTER TABLE consignment_notes
  ADD COLUMN IF NOT EXISTS converted_invoice_id TEXT
  REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_consignment_notes_converted_invoice_id
  ON consignment_notes(converted_invoice_id);
