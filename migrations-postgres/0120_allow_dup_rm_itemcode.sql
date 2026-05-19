-- ============================================================================
-- HOOKKA ERP — temporarily allow duplicate raw-material item codes
--
-- Migration 0008 added `idx_rm_item_code_unique` (UNIQUE on
-- raw_materials.item_code). Wei Siang is consolidating/renaming the item
-- code catalogue and needs to PARK several rows under the same code on
-- purpose, then merge them by hand afterwards. Drop the hard DB lock so
-- the app (which no longer guards on this either) can write duplicates.
--
-- RE-TIGHTEN after the merge: recreate the unique index (de-dupe first):
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_item_code_unique
--     ON raw_materials(item_code);
-- ============================================================================

DROP INDEX IF EXISTS idx_rm_item_code_unique;
