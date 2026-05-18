-- ============================================================================
-- HOOKKA ERP — Invoice tax (GST/SST) storage
--
-- Phase 4: a sales invoice posts CR GST 350-0000 for the tax portion. The
-- rate is operator-configurable (kv_config key `gst_rate_pct`, default 0)
-- and tax = round(subtotal_sen * rate%). We persist the computed tax on
-- the invoice so the posted GST leg is auditable and re-derivable.
--
-- Additive, safe: NOT NULL DEFAULT 0 — every existing invoice keeps tax 0
-- (matches today's no-GST reality; nothing recomputed retroactively).
-- ============================================================================

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_sen INTEGER NOT NULL DEFAULT 0;
