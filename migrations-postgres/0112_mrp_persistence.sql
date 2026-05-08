-- ---------------------------------------------------------------------------
-- 0112_mrp_persistence.sql
--
-- Phase A1.1 (2026-05-09): wire /api/mrp to actually persist runs into the
-- mrp_runs / mrp_requirements tables that have existed since 0001 but have
-- never been written to. Each POST /api/mrp computes a fresh MRPRun then
-- INSERTs it; GET /api/mrp returns the latest, GET /api/mrp/runs lists,
-- GET /api/mrp/runs/:id reloads a snapshot.
--
-- Schema additions:
--   * mrp_runs.org_id / created_by — tenant scope + audit. Single-tenant
--     prod has only "hookka" today, but properly scope so any future
--     re-tenanting (the migration scaffold is in place; see worker.ts
--     middleware) doesn't leak runs between orgs.
--   * mrp_runs.fabric_detail — JSON-as-text. Storing the ~80-row fabric
--     panel state inline lets a re-load of a historical run rebuild the
--     same two-tab UI without recomputing computeFabricMetrics() — that
--     helper walks every active FAB_CUT JC and is the second-heaviest
--     thing the route does.
--   * mrp_runs.matched_pos / unmatched_pos — meta returned alongside data.
--   * mrp_requirements.material_code — the actual SKU code (different from
--     material_name which is the label). Needed by the Phase A1.2 "Create
--     PO from MRP" endpoint to look up supplier_material_bindings.
--   * mrp_requirements.bucket_this_week / next_week / week_3_4 / beyond —
--     per-bucket demand. Currently lives on the in-memory MRPRun but we
--     need it persisted to rebuild the UI from a stored run.
--   * mrp_requirements.lead_time_days / suggested_order_date — populated
--     from supplier_material_bindings at compute time; stored so the
--     "order by" date stays stable when re-loading a historical run.
--
-- Indexes:
--   * idx_mrp_runs_org_run_date — drives GET /api/mrp (latest per org) and
--     /api/mrp/runs (paginated history per org).
--   * idx_mrp_requirements_run — drives the per-run requirement fetch on
--     /api/mrp/runs/:id and the ON DELETE CASCADE the existing FK uses.
-- ---------------------------------------------------------------------------

ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS org_id TEXT;
ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS fabric_detail TEXT;
ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS matched_pos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mrp_runs ADD COLUMN IF NOT EXISTS unmatched_pos INTEGER NOT NULL DEFAULT 0;

ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS material_code TEXT;
ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS bucket_this_week DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS bucket_next_week DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS bucket_week34 DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS bucket_beyond DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS lead_time_days INTEGER;
ALTER TABLE mrp_requirements ADD COLUMN IF NOT EXISTS suggested_order_date TEXT;

CREATE INDEX IF NOT EXISTS idx_mrp_runs_org_run_date ON mrp_runs(org_id, run_date DESC);
CREATE INDEX IF NOT EXISTS idx_mrp_requirements_run ON mrp_requirements(mrp_run_id);
