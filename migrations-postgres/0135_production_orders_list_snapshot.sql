-- ---------------------------------------------------------------------------
-- 0135_production_orders_list_snapshot.sql — cache-aside snapshot table for
-- the Production page's main fetch:
--   GET /api/production-orders        (?fields=minimal&dept=...&excludeCompleted=...)
--
-- After Phase 1-4 perf work, the dept-tab response still does ~3.9MB
-- decompressed JSON + 1086 PO scan + 8-dept JC join + lead-time + BOM
-- pre-loads. On a cold fetch that's 2-3s wall + 250-500ms main-thread
-- freeze. The Production page is hit every time the operator opens
-- /production/* (which is hundreds of times a day per operator) and the
-- underlying data is mostly static between writes — so a cache-aside
-- snapshot with sourceTables = (production_orders, job_cards) gives a
-- near-zero-cost repeat fetch while staying invalidation-safe (any PO /
-- JC update bumps updated_at and the next fetch recomputes).
--
-- cache_key encodes the request's query params (dept, fields, excludeCompleted,
-- dueFrom, dueTo, cat) so dept tabs each get their own cached payload.
-- Built by buildPoListCacheKey() in production-orders.ts; same canonical
-- sort + encoding used by the prior KV-cache path so existing test
-- coverage carries over.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS production_orders_list_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);
