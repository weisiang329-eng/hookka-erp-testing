-- ---------------------------------------------------------------------------
-- 0024: Align raw_materials with AutoCount master fields.
--
-- Adds UOM Count, Item Type, Stock Control, Main Supplier Code so the raw
-- materials list can mirror AutoCount. All new columns are nullable / have
-- defaults so existing rows keep working.
--
-- Apply (idempotent via IF NOT EXISTS-style guards expressed as separate
-- statements; SQLite doesn't support IF NOT EXISTS on ALTER TABLE ADD COLUMN,
-- so the remote application was done column-by-column. Re-applying this file
-- will fail on the first duplicate column, which is expected once applied).
--   npx wrangler d1 execute hookka-erp-db --remote --file migrations/0024_raw_materials_autocount.sql
-- ---------------------------------------------------------------------------

ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS uom_count DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS item_type TEXT;
ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS stock_control INTEGER NOT NULL DEFAULT 1;
ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS main_supplier_code TEXT;
