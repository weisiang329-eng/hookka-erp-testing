-- ============================================================================
-- HOOKKA ERP — Finance Phase 3.6: per-document multi-currency on purchase
-- invoices (owner decision 2026-06-12: rate keyed PER DOCUMENT, no monthly
-- rate table).
--
-- A foreign PI (USD/CNY) carries its own booking rate: every money field
-- is entered in the foreign currency and converted to MYR at fx_rate on
-- entry (amount_sen and item line totals stay HOME MYR, so the stock-map
-- buckets and AP control keep working unchanged). foreign_amount_sen
-- preserves the original document total. On PAID the payment rate
-- (pay_fx_rate) may differ — the realised difference posts to 530-0000
-- GAIN ON FOREIGN EXCHANGE (debit when a loss).
-- ============================================================================

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'MYR';

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS fx_rate REAL;

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS foreign_amount_sen INTEGER;

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS pay_fx_rate REAL;
