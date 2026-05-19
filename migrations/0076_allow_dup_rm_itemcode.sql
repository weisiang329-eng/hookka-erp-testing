-- ============================================================================
-- HOOKKA ERP — temporarily allow duplicate raw-material item codes (SQLite
-- parity for the local / d1-compat path; the prod-critical copy is
-- migrations-postgres/0120_allow_dup_rm_itemcode.sql).
--
-- Migration 0008 added `idx_rm_itemCode_unique` (UNIQUE on
-- raw_materials.itemCode). Dropped here so duplicate codes can be parked
-- on purpose during the item-code consolidation, then merged by hand.
--
-- RE-TIGHTEN after the merge (de-dupe first):
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_itemCode_unique
--     ON raw_materials(itemCode);
-- ============================================================================

DROP INDEX IF EXISTS idx_rm_itemCode_unique;
