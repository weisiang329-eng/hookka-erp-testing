-- ---------------------------------------------------------------------------
-- 0071_maintenance_config_history.sql (Postgres)
--
-- Effective-dated history for the Maintenance config — see the D1 sibling
-- file for the full rationale. Postgres flavour: snake_case columns,
-- ON CONFLICT DO NOTHING for idempotency, gen_random_uuid() for ids.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS maintenance_config_history (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  config TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_mch_scope_eff
  ON maintenance_config_history(scope, effective_from DESC, created_at DESC);

-- Auto-baseline from kv_config namespace 'variants-config[:<customerId>]'.
INSERT INTO maintenance_config_history (id, scope, config, effective_from, notes)
SELECT
  'mch-baseline-' || replace(gen_random_uuid()::text, '-', ''),
  CASE WHEN key = 'variants-config'
       THEN 'master'
       ELSE 'customer:' || substr(key, length('variants-config:') + 1)
  END,
  value,
  '2020-01-01',
  'Auto-baseline from kv_config'
FROM kv_config
WHERE key = 'variants-config' OR key LIKE 'variants-config:%'
ON CONFLICT (id) DO NOTHING;
