-- ---------------------------------------------------------------------------
-- 0095_rd_material_issuances_backfill.sql
--
-- One-shot backfill: copy any rows from the legacy rd_projects.material_issuances
-- JSON column into the dedicated rd_material_issuances table (introduced in
-- migration 0092).
--
-- Background:
--   * Migration 0092 introduced rd_material_issuances and the API began
--     dual-writing into both the JSON column and the table.
--   * The follow-up cutover (this commit) drops dual-write and makes the
--     table the sole source of truth — frontend reads from
--     GET /api/rd-projects/:id/issuances.
--   * Without a backfill, any issuance written to the JSON column BEFORE
--     0092 was deployed would disappear from the UI after the cutover.
--
-- Strategy:
--   For each rd_projects row, expand material_issuances JSONB array and
--   INSERT one row per element into rd_material_issuances — but ONLY if a
--   row with the same id doesn't already exist (so the backfill is safe to
--   re-run, and it won't duplicate the dual-write window's entries).
--
-- Field mapping (legacy JSON shape → table columns):
--   id            → id
--   materialId    → raw_material_id
--   materialCode  → material_code
--   materialName  → material_name
--   qty           → qty
--   unit          → unit
--   unitCostSen   → unit_cost_sen        (default 0 if missing)
--   totalCostSen  → total_cost_sen       (default 0 if missing)
--   issuedDate    → issued_at            (DATE — fall back to created_date)
--   issuedBy      → issued_by
--   notes         → notes
--   (no JSON equivalent) → stock_movement_id  (NULL — pre-0092 issuances
--                                              didn't link the movement row)
--   project's org_id → org_id            (defaults to 'hookka' on missing)
--
-- Edge cases handled:
--   * NULL or empty JSON array on rd_projects.material_issuances → no-op
--   * JSON entry missing an `id` → skipped (without a stable id we can't
--     guarantee idempotency on re-run)
--   * JSON entry with qty <= 0 → skipped (CHECK (qty > 0) on the table)
--
-- Idempotent: ON CONFLICT (id) DO NOTHING. Safe to re-run.
--
-- After this migration, the rd_projects.material_issuances JSON column is
-- still on the row (untouched). A future migration can drop it once we're
-- sure nothing reads it.
-- ---------------------------------------------------------------------------

INSERT INTO rd_material_issuances (
  id,
  project_id,
  raw_material_id,
  material_code,
  material_name,
  qty,
  unit,
  unit_cost_sen,
  total_cost_sen,
  issued_at,
  issued_by,
  notes,
  stock_movement_id,
  org_id,
  created_at
)
SELECT
  (elem->>'id')                                  AS id,
  p.id                                           AS project_id,
  (elem->>'materialId')                          AS raw_material_id,
  COALESCE(elem->>'materialCode', '')            AS material_code,
  COALESCE(elem->>'materialName', '')            AS material_name,
  (elem->>'qty')::numeric                        AS qty,
  COALESCE(elem->>'unit', '')                    AS unit,
  COALESCE((elem->>'unitCostSen')::integer, 0)   AS unit_cost_sen,
  COALESCE((elem->>'totalCostSen')::integer, 0)  AS total_cost_sen,
  COALESCE(
    (elem->>'issuedDate')::date,
    p.created_date::date,
    CURRENT_DATE
  )                                              AS issued_at,
  elem->>'issuedBy'                              AS issued_by,
  elem->>'notes'                                 AS notes,
  NULL                                           AS stock_movement_id,
  COALESCE(p.org_id, 'hookka')                   AS org_id,
  COALESCE(p.created_date::timestamptz, NOW())   AS created_at
FROM rd_projects p
   , jsonb_array_elements(
       CASE
         WHEN p.material_issuances IS NULL OR p.material_issuances = '' THEN '[]'::jsonb
         ELSE p.material_issuances::jsonb
       END
     ) AS elem
WHERE elem->>'id' IS NOT NULL
  AND elem->>'materialId' IS NOT NULL
  AND COALESCE((elem->>'qty')::numeric, 0) > 0
ON CONFLICT (id) DO NOTHING;

-- Recompute rd_projects.actual_cost from the post-backfill table totals so
-- the budget cards stay in sync. This handles the case where a project had
-- legacy JSON-only issuances whose totals were never propagated to the
-- table-backed sum (the API now derives actual_cost from rd_material_issuances).
UPDATE rd_projects p
   SET actual_cost = COALESCE(s.total, 0)
  FROM (
    SELECT project_id, SUM(total_cost_sen) AS total
      FROM rd_material_issuances
     GROUP BY project_id
  ) s
 WHERE s.project_id = p.id;
