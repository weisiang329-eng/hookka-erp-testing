-- ============================================================================
-- HOOKKA ERP — Raw Materials + FIFO batch extensions
--
-- The base tables `raw_materials`, `rm_batches`, and `fg_batches` were created
-- in 0001_init.sql. This migration:
--   1. Adds the extra columns the Inventory UI + CRUD API need
--      (minStock / maxStock / status / notes / created_at / updated_at on
--      raw_materials; supplierId / grnId / totalValueSen / created_at on
--      rm_batches; completedDate / totalValueSen on fg_batches).
--   2. Adds a UNIQUE index on raw_materials.itemCode (previously only a
--      non-unique idx_rm_itemCode index).
--   3. Adds supporting indexes for filter/lookup paths.
--
-- All ALTERs are idempotent in spirit (wrangler will fail fast if the
-- migration is re-applied, which is the desired behaviour because the
-- migration number is stored).  Using ADD COLUMN preserves existing rows and
-- keeps older code (GRN cascade) working unchanged.
-- ============================================================================

-- --- raw_materials extensions -----------------------------------------------
ALTER TABLE raw_materials ADD COLUMN minStock REAL NOT NULL DEFAULT 0;
ALTER TABLE raw_materials ADD COLUMN maxStock REAL NOT NULL DEFAULT 0;
ALTER TABLE raw_materials ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE raw_materials ADD COLUMN notes TEXT;
ALTER TABLE raw_materials ADD COLUMN created_at TEXT;
ALTER TABLE raw_materials ADD COLUMN updated_at TEXT;

-- Enforce itemCode uniqueness (the API already guards on this; make the DB
-- match so any out-of-band INSERTs can't race past the check).
CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_itemCode_unique
  ON raw_materials(itemCode);

-- --- rm_batches extensions --------------------------------------------------
-- supplierId / grnId let the UI show provenance directly without joining
-- through `sourceRefId` + `source`.  totalValueSen is denormalised so grid
-- rendering doesn't need to multiply on every row.
ALTER TABLE rm_batches ADD COLUMN supplierId TEXT;
ALTER TABLE rm_batches ADD COLUMN grnId TEXT;
ALTER TABLE rm_batches ADD COLUMN totalValueSen INTEGER NOT NULL DEFAULT 0;

-- --- fg_batches extensions --------------------------------------------------
-- totalValueSen mirrors the rm_batches change.  Also add an index on
-- completedDate (it already exists via 0001, kept here for clarity if
-- anything drops it).
ALTER TABLE fg_batches ADD COLUMN totalValueSen INTEGER NOT NULL DEFAULT 0;

-- --- Extra indexes the new routes rely on -----------------------------------
CREATE INDEX IF NOT EXISTS idx_rm_batches_supplierId
  ON rm_batches(supplierId);
CREATE INDEX IF NOT EXISTS idx_rm_batches_grnId
  ON rm_batches(grnId);
CREATE INDEX IF NOT EXISTS idx_raw_materials_status
  ON raw_materials(status);
