-- Mirror of migrations-postgres/0185 (sqlite/camelCase, for the rename-map scanner).
-- Runtime self-applied by the endpoint; CI does not run this file.
CREATE TABLE IF NOT EXISTS material_opening_stock (
  id           TEXT PRIMARY KEY,
  rmId         TEXT NOT NULL,
  qty          REAL NOT NULL DEFAULT 0,
  unitCostSen  INTEGER NOT NULL DEFAULT 0,
  asOfDate     TEXT NOT NULL,
  orgId        TEXT NOT NULL DEFAULT 'hookka',
  createdAt    TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mos_key ON material_opening_stock (orgId, rmId);
