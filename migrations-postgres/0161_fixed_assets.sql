-- ============================================================================
-- HOOKKA ERP — Finance Phase 3.5: fixed-asset register + straight-line
-- monthly depreciation.
--
-- The owner maintains the register himself (name, three accounts, cost,
-- life). Monthly run = preview → check → Post: per active asset,
-- DR expense_account (780-0080/0090 machinery/factory, 900-D001 office)
-- CR accum_account, amount = (cost − residual) / useful_life_months,
-- capped at the remaining book value. One run per month (sourceType
-- 'depreciation', sourceId dep-YYYY-MM); per-asset rows live in
-- fixed_asset_depreciation so NBV never needs the shared GL account.
-- opening_accum_sen carries depreciation taken BEFORE the opening date.
-- ============================================================================

CREATE TABLE IF NOT EXISTS fixed_assets (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  asset_account      TEXT NOT NULL,
  accum_account      TEXT NOT NULL,
  expense_account    TEXT NOT NULL,
  purchase_date      TEXT NOT NULL,
  cost_sen           INTEGER NOT NULL,
  residual_sen       INTEGER NOT NULL DEFAULT 0,
  useful_life_months INTEGER NOT NULL,
  opening_accum_sen  INTEGER NOT NULL DEFAULT 0,
  disposed_at        TEXT,
  remarks            TEXT,
  created_at         TEXT,
  updated_at         TEXT
);

CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
  id        TEXT PRIMARY KEY,
  asset_id  TEXT NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  month     TEXT NOT NULL,
  amount_sen INTEGER NOT NULL,
  posted_at TEXT,
  UNIQUE (asset_id, month)
);

CREATE INDEX IF NOT EXISTS idx_fad_asset ON fixed_asset_depreciation (asset_id);
CREATE INDEX IF NOT EXISTS idx_fad_month ON fixed_asset_depreciation (month);
