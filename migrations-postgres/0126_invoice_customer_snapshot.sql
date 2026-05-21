-- ---------------------------------------------------------------------------
-- 0126_invoice_customer_snapshot.sql — Snapshot customer contact block
-- onto invoices / credit_notes / debit_notes at creation time.
--
-- Problem (Agent B audit 2026-05-20, owner-reported BUG-2026-05-20-bug):
-- the operator saw an invoice PDF showing "Address: KL" and "Contact: -"
-- because invoice creation never copied the delivery_address /
-- contact_person / contact_phone from the source DO. The fields the
-- PDF tried to read (invoice.customerAddress, invoice.attention,
-- invoice.customerPhone) had no columns to read from — the schema
-- simply never had them.
--
-- DO does it right: delivery_orders has snake-case delivery_address /
-- contact_person / contact_phone columns + the auto-create-from-customer
-- path bumps them at DO creation. Invoice (created from DO) should mirror
-- that. Same gap on credit_notes + debit_notes — they all reuse the
-- same shared customer-block layout in the PDFs.
--
-- This migration is ADDITIVE-ONLY: NULLable columns with no defaults.
-- Existing rows get NULL; the read/PDF path already falls back. The
-- companion route changes (invoices.ts, credit-notes.ts, debit-notes.ts)
-- populate these on every NEW row. A one-shot backfill endpoint
-- (POST /api/invoices/backfill-customer-info) sweeps existing rows.
--
-- Also adds customerPOId on invoices — Agent B finding B5. DO already
-- carries customer_po_id; invoice was dropping it on the way through.
-- ---------------------------------------------------------------------------

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS customer_address TEXT,
  ADD COLUMN IF NOT EXISTS attention TEXT,
  ADD COLUMN IF NOT EXISTS customer_phone TEXT,
  ADD COLUMN IF NOT EXISTS customer_po_id TEXT;

ALTER TABLE credit_notes
  ADD COLUMN IF NOT EXISTS customer_address TEXT,
  ADD COLUMN IF NOT EXISTS attention TEXT,
  ADD COLUMN IF NOT EXISTS customer_phone TEXT,
  ADD COLUMN IF NOT EXISTS customer_state TEXT;

ALTER TABLE debit_notes
  ADD COLUMN IF NOT EXISTS customer_address TEXT,
  ADD COLUMN IF NOT EXISTS attention TEXT,
  ADD COLUMN IF NOT EXISTS customer_phone TEXT,
  ADD COLUMN IF NOT EXISTS customer_state TEXT;
