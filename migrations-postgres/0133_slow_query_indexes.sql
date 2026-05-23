-- ---------------------------------------------------------------------------
-- 0133_slow_query_indexes.sql — targeted indexes + snapshot table for the
-- two slow API queries diagnosed in the 2026-05-23 perf investigation.
--
-- !! RUN OUTSIDE A TRANSACTION !!
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Most
-- migration runners default to wrapping each file in BEGIN/COMMIT; this
-- one MUST be applied with the per-file transaction disabled (psql via
-- `psql -1=false` / wrangler-equivalent / Supabase SQL editor "without
-- transaction"). CONCURRENTLY is used deliberately so the build does not
-- take an ACCESS EXCLUSIVE lock on the source tables — fabric_tracking
-- and the sales-orders list are hot paths and a blocking CREATE INDEX
-- would freeze the API for minutes.
--
-- Why each index:
--   idx_so_org_created       — sales-orders main list ORDER BY (org_id,
--                              created_at DESC). Today's plan is a
--                              full-table sort; this covers it.
--   idx_so_updated_at        — sales_orders freshness probe used by the
--                              snapshot helper (MAX(updated_at)).
--   idx_so_items_updated_at  — sales_order_items freshness probe (same).
--   idx_jc_dept_status       — fabric-tracking FAB_CUT demand query:
--                              WHERE departmentCode = 'FAB_CUT' AND
--                                    status IN ('WAITING', ...). Composite
--                              so both predicates land on one index seek.
--   idx_cost_ledger_type_date — fabric-tracking RM_ISSUE 30-day rollup:
--                               WHERE type = 'RM_ISSUE' AND date >= ?.
--
-- Snapshot table:
--   fabric_tracking_snapshot — cache-aside for GET /api/fabric-tracking.
--   The endpoint stitches together 6 source tables (job_cards,
--   production_orders, raw_materials, purchase_order_items, cost_ledger,
--   bom_templates) and the result is stable between fabric movements.
--   Same shape as 0127/0129 (composite PK org_id + cache_key) so the
--   ?category= and ?shortageOnly= query-string variants each get their
--   own row via cache_key without stomping each other.
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_so_org_created
  ON sales_orders(org_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_so_updated_at
  ON sales_orders(updated_at);

-- NOTE: `sales_order_items` has no `updated_at` column in this schema
-- (verified 2026-05-23 against prod information_schema). The agent that
-- drafted this migration assumed it did. The snapshot-freshness probe
-- (src/api/lib/snapshot-freshness.ts) skips source tables that lack a
-- timestamp-typed column, so item-only edits never trip snapshot
-- invalidation today anyway — the parent sales_orders.updated_at bump
-- on every items-touching route handles it. If a future migration adds
-- sales_order_items.updated_at, add the index back here.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jc_dept_status
  ON job_cards(department_code, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cost_ledger_type_date
  ON cost_ledger(type, date);

CREATE TABLE IF NOT EXISTS fabric_tracking_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);
