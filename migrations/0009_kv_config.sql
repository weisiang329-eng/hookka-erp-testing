-- ============================================================================
-- HOOKKA ERP — Generic key/value config store.
--
-- A thin wrapper that replaces the final batch of business-data localStorage
-- keys used by the UI. Each row is a JSON blob stored under an arbitrary key;
-- the UI parses/stringifies. Today only one key is in active use:
--
--   'variants-config'  — the legacy 'hookka-variants-config' localStorage blob
--                         covering fabricGroups, productionTimes, divanHeights,
--                         legHeights, totalHeights, gaps, specials,
--                         sofaLegHeights, sofaSpecials, sofaSizes.
--
-- Schema intentionally generic (key/value/updated_at) so future small settings
-- don't need their own table + migration every time.
-- ============================================================================

CREATE TABLE IF NOT EXISTS kv_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
