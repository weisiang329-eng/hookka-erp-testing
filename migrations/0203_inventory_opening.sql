-- Task 2.2 — WIP / finished-goods opening-stock seed (sqlite mirror of
-- migrations-postgres/0201_inventory_opening.sql).
--
-- Holds the pre-opening WIP and FG stock totals the system cannot reconstruct
-- from transactions. loadMaterialCostData injects these into the wipByYm /
-- fgByYm month-end snapshots at the cutover month (as_of_date's YYYY-MM) so
-- they surface as the first system month's OPENING and are absorbed into that
-- month's COGS. Runtime self-applies via ensureInventoryOpening().
CREATE TABLE IF NOT EXISTS inventory_opening (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL DEFAULT 'hookka',
  layer      TEXT NOT NULL,
  value_sen  INTEGER NOT NULL DEFAULT 0,
  as_of_date TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_opening_key ON inventory_opening (org_id, layer);
