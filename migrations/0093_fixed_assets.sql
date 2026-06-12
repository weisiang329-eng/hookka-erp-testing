-- ============================================================================
-- HOOKKA ERP — fixed-asset register + monthly depreciation rows
-- (SQLite mirror of migrations-postgres/0161_fixed_assets.sql — D1 retired;
--  kept for the rename-map identifier scan + schema parity.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS fixed_assets (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  assetAccount     TEXT NOT NULL,
  accumAccount     TEXT NOT NULL,
  expenseAccount   TEXT NOT NULL,
  purchaseDate     TEXT NOT NULL,
  costSen          INTEGER NOT NULL,
  residualSen      INTEGER NOT NULL DEFAULT 0,
  usefulLifeMonths INTEGER NOT NULL,
  openingAccumSen  INTEGER NOT NULL DEFAULT 0,
  disposedAt       TEXT,
  remarks          TEXT,
  created_at       TEXT,
  updated_at       TEXT
);

CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
  id        TEXT PRIMARY KEY,
  assetId   TEXT NOT NULL,
  month     TEXT NOT NULL,
  amountSen INTEGER NOT NULL,
  postedAt  TEXT
);
