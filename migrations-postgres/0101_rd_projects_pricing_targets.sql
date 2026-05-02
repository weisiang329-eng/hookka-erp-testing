-- ---------------------------------------------------------------------------
-- 0101_rd_projects_pricing_targets.sql
--
-- Add two pricing-target columns to rd_projects so the operator can capture
-- the commercial intent of an R&D project up front, BEFORE the team starts
-- spending material:
--
--   target_selling_price_sen   — what the product is planned to sell for
--                                (e.g. RM 500 → 50000 sen). Drives margin.
--   target_material_cost_sen   — the upper bound for raw-material cost in
--                                production (e.g. RM 200 → 20000 sen). The
--                                R&D team uses this as a ceiling: if a
--                                prototype's BOM blows past it, redesign
--                                before approving for production.
--
-- Both default to NULL — historical rows have no targets and the SPA shows
-- a dash in the Budget card for those. Both are nullable so a draft can be
-- created without committing to a price up front.
--
-- Naming: snake_case to match the rest of rd_projects in Postgres. The
-- column-rename-map (src/api/lib/column-rename-map.json) maps the camelCase
-- API field names back, same pattern as totalBudget / actualCost.
-- ---------------------------------------------------------------------------

ALTER TABLE rd_projects
  ADD COLUMN IF NOT EXISTS target_selling_price_sen INTEGER,
  ADD COLUMN IF NOT EXISTS target_material_cost_sen INTEGER;
