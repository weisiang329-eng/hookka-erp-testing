-- Task 2.2 — WIP / finished-goods opening-stock seed.
--
-- Holds the pre-opening WIP and FG stock totals the system cannot reconstruct
-- from transactions (no pre-opening production history). loadMaterialCostData
-- injects these into the wipByYm / fgByYm month-end snapshots AT THE CUTOVER
-- MONTH (as_of_date's YYYY-MM), so they surface as the first system month's
-- OPENING and are absorbed into that month's COGS. See
-- src/lib/inventory-opening.ts + 财务模块-存货期初与历史PNL-设计.md §3b.
--
-- Runtime self-applies via ensureInventoryOpening() (deploys do not run
-- migrations); this file is the migration of record.
CREATE TABLE IF NOT EXISTS inventory_opening (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL DEFAULT 'hookka',
  layer      TEXT NOT NULL,
  value_sen  INTEGER NOT NULL DEFAULT 0,
  as_of_date TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_opening_key ON inventory_opening (org_id, layer);
