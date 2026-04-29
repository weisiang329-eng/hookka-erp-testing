-- ============================================================================
-- Migration 0090 — R&D Projects: source product price (for clone projects)
--
-- Per design 2026-04-29 follow-up: when we buy a competitor's sofa to
-- reverse-engineer, we want to record what we paid for it directly on the
-- R&D project so the cost trace is one-look. This becomes the implicit
-- "source costing reference" for the clone.
--
-- Stored in sen (RM × 100) for consistency with every other money column
-- in this codebase (totalBudget, basePriceSen, etc). Nullable — only
-- meaningful for projectType = 'CLONE' but we don't enforce that at the
-- DB layer (UI gates input).
-- ============================================================================

ALTER TABLE rd_projects ADD COLUMN IF NOT EXISTS source_price_sen INTEGER;
