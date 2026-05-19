-- ============================================================================
-- HOOKKA ERP — per-line price build-up on invoice_items (SQLite parity;
-- the prod-critical copy is migrations-postgres/0121_*).
--
-- invoice_items only stored unit_price_sen + total_sen. The operator needs
-- to edit each component of the price (Base / Divan / Leg / Special order)
-- ON THE INVOICE and have the invoice be the source of truth (override the
-- sales-order-derived figures the printout used to read back).
--
-- price_edited = 1 once the operator has saved an edit on this line, so the
-- print path knows to use the invoice's own build-up instead of the
-- sales-order fallback. Until then everything stays 0 and the existing
-- SO-derived behaviour is unchanged (safe no-op for every legacy row).
-- ============================================================================

ALTER TABLE invoice_items ADD COLUMN base_price_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN divan_price_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN leg_price_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN special_order_price_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN price_edited INTEGER NOT NULL DEFAULT 0;
