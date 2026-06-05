-- 0151_workers_efficiency_allowance.sql
-- Per-worker efficiency bonus config for the Employee Master (Phase 1: storage
-- + editing only; the Payroll entitlement engine that pays it out is Phase 2).
--
--   efficiency_allowance_sen  — the flat bonus (money, in sen) paid when the
--                               worker's efficiency over the selected payroll
--                               period reaches efficiency_threshold_pct.
--                               Mirrors basic_salary_sen (INTEGER, sen).
--   efficiency_threshold_pct  — the efficiency % the worker must reach to
--                               qualify (0–100). DOUBLE PRECISION mirrors
--                               ot_multiplier (0061) — returned to JS as a
--                               plain number.
--
-- Both default 0 so every existing worker earns NO bonus until the operator
-- sets a real allowance amount — a 0 amount can never pay out regardless of
-- threshold. Idempotent (IF NOT EXISTS) so a re-run is a no-op.
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS efficiency_allowance_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS efficiency_threshold_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
