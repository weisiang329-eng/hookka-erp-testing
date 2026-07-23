-- 0208 — the definitive fix for BUG-2026-07-14-006 (double invoicing).
--
-- The manual create-invoice POST guards on "does this DO already have an active
-- invoice?" — a check-then-write with a wide window. Two concurrent requests
-- (or an auto-invoice racing the manual one) both pass the check and both
-- INSERT, producing two identical invoices for one DO. The guard was added and
-- the dups were cleaned twice (staging 07-14, prod 07-23), but with no DB-level
-- constraint the race keeps re-creating them. This partial-unique index makes a
-- second ACTIVE invoice for the same DO impossible at the storage layer, so the
-- race can no longer win regardless of application timing.
--
-- Partial (WHERE status <> 'CANCELLED') because a CANCELLED invoice must NOT
-- block a legitimate re-invoice after a void. NULL delivery_order_id rows
-- (manual invoices not tied to a DO) are exempt — Postgres treats NULLs as
-- distinct in a unique index, so any number of them coexist.
--
-- Runtime self-apply lives in src/api/routes/invoices.ts (ensureInvoiceDedupeIndex)
-- because deploy.yml does not replay migration files. This file is the record.
-- Safe to create only AFTER existing duplicates are cleaned (done 2026-07-23).

CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_active_delivery_order
  ON invoices (delivery_order_id)
  WHERE status <> 'CANCELLED' AND delivery_order_id IS NOT NULL;
