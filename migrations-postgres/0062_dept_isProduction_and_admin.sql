-- ============================================================================
-- Migration 0062 — departments.isProduction column + R&D non-production seed
--
-- Adds the isProduction column for the dept-aware UI to distinguish production
-- depts (which carry a SOFA / BEDFRAME / ACCESSORY category on
-- working_hour_entries) from non-production depts (no category). Replaces the
-- previously hardcoded PRODUCTION_DEPT_CODES set in the frontend, so future
-- dept additions via the new admin UI just work without a code change.
--
-- Also seeds R&D as a non-production dept (per spec).
-- ============================================================================

ALTER TABLE departments ADD COLUMN IF NOT EXISTS is_production INTEGER NOT NULL DEFAULT 1;

-- Mark existing depts: 8 production = 1; 4 non-production = 0.
UPDATE departments SET is_production = 0 WHERE code IN
  ('WAREHOUSING','REPAIR','MAINTENANCE','PRODUCTION_SHORTFALL');

-- New R&D dept (non-production, sequence 13).
INSERT INTO departments (id, code, name, short_name, sequence, color, working_hours_per_day, is_production)
VALUES ('dept-13', 'R_AND_D', 'R&D', 'R&D', 13, '#0EA5E9', 9, 0) ON CONFLICT DO NOTHING;
