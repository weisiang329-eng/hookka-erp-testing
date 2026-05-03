-- ---------------------------------------------------------------------------
-- 0071_maintenance_config_history.sql
--
-- Effective-dated history for the Maintenance config (Bedframe Divan/Total/
-- Gap/Leg/Specials, Sofa Sizes/Leg/Specials, Common Fabrics).
--
-- Until now this was stored as a single JSON blob in kv_config under
-- 'variants-config' (master) or 'variants-config:<customerId>' (per
-- customer). Saves overwrote the blob with no history and no support for
-- scheduling future-dated changes.
--
-- This migration adds an append-only history table mirroring the
-- product_prices / customer_product_prices pattern. Each save inserts a
-- new row; resolver picks the newest row WHERE effective_from <= today
-- per scope. Auto-baseline: every existing kv_config row for the
-- variants-config namespace is converted into an effective_from='2020-01-01'
-- baseline so the resolver always finds something even before the first
-- post-feature edit.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS maintenance_config_history (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,           -- 'master' or 'customer:<customerId>'
  config TEXT NOT NULL,          -- full JSON blob (same shape as kv_config 'variants-config')
  effective_from TEXT NOT NULL,  -- YYYY-MM-DD
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_mch_scope_eff
  ON maintenance_config_history(scope, effective_from DESC, created_at DESC);

-- Auto-baseline. Maps:
--   key = 'variants-config'             -> scope = 'master'
--   key = 'variants-config:<custId>'    -> scope = 'customer:<custId>'
INSERT OR IGNORE INTO maintenance_config_history (id, scope, config, effective_from, notes)
SELECT
  'mch-baseline-' || lower(hex(randomblob(8))),
  CASE WHEN key = 'variants-config'
       THEN 'master'
       ELSE 'customer:' || substr(key, length('variants-config:') + 1)
  END,
  value,
  '2020-01-01',
  'Auto-baseline from kv_config'
FROM kv_config
WHERE key = 'variants-config' OR key LIKE 'variants-config:%';
