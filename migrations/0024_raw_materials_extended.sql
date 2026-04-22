-- ============================================================================
-- HOOKKA ERP — Raw Materials master extended fields
--
-- Source: AutoCount "raw material.xlsx" export. Adds the item-master columns
-- that the existing raw_materials table was missing:
--   - uomCount         : numeric multiplier for the base UOM (default 1)
--   - itemType         : optional sub-classification (blank in current export,
--                        reserved for future per-type rules)
--   - stockControl     : whether inventory is tracked (AutoCount "Stock Control"
--                        flag; defaults to 1 = tracked)
--   - mainSupplierCode : soft FK to suppliers.code (not enforced — AutoCount
--                        masters frequently reference suppliers by code string)
--
-- ALTERs are intentionally non-idempotent (wrangler tracks the migration
-- number). Re-running the migration file directly will fail on duplicate
-- column — expected.
-- ============================================================================

ALTER TABLE raw_materials ADD COLUMN uomCount REAL NOT NULL DEFAULT 1;
ALTER TABLE raw_materials ADD COLUMN itemType TEXT;
ALTER TABLE raw_materials ADD COLUMN stockControl INTEGER NOT NULL DEFAULT 1;
ALTER TABLE raw_materials ADD COLUMN mainSupplierCode TEXT;

CREATE INDEX IF NOT EXISTS idx_raw_materials_mainSupplierCode
  ON raw_materials(mainSupplierCode);
CREATE INDEX IF NOT EXISTS idx_raw_materials_itemType
  ON raw_materials(itemType);
