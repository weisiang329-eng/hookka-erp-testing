-- ============================================================================
-- Migration 0061 — working_hour_entries + 4 non-production depts + workers.otMultiplier
--
-- Working Hours revamp: the existing attendance_records row is the daily clock
-- in/out summary (one row per worker per day). It can only attribute time to a
-- single department via deptBreakdown JSON, which is too coarse to answer
-- "how much labor cost did dept X × category Y burn this month vs the revenue
-- it generated?" — the question Labor Cost reporting needs.
--
-- working_hour_entries is the per-segment breakdown: one row per
-- (attendance × department × category). A worker who spends 4h on Sofa
-- upholstery and 3h on Bedframe upholstery on the same day produces two rows
-- here, both pointing at the same parent attendance_records row. The clock
-- in/out summary stays in attendance_records (still the source of truth for
-- "did they show up"); the breakdown sums let payroll + Labor Cost reports
-- attribute hours to specific dept × category buckets.
--
-- New non-production departments (per spec):
--   WAREHOUSING            — 借工: lent out to warehouse (off the line)
--   REPAIR                 — 修货: reworking returns / quality fixes
--   MAINTENANCE            — 维护: machine / facility maintenance
--   PRODUCTION_SHORTFALL   — 闲置: idle, no order to work on
-- These do NOT carry a category (production-only field), and Labor Cost
-- reports show PRODUCTION_SHORTFALL only at the department total level
-- (not per-employee) to avoid finger-pointing politics.
--
-- workers.otMultiplier — per-worker OT premium multiplier. Default 1.5
-- (= 1.5× hourly rate for OT hours). 1.0 means OT is paid at flat hourly
-- rate (no premium). Hourly rate itself is fixed at basicSalarySen ÷ 26 ÷ 9
-- in app code (calendar-month days are intentionally NOT used).
-- ============================================================================

CREATE TABLE working_hour_entries (
  id TEXT PRIMARY KEY,
  attendance_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  date TEXT NOT NULL,                 -- YYYY-MM-DD, denormalized from attendance_records for fast range queries
  department_code TEXT NOT NULL,
  category TEXT,                       -- 'SOFA' | 'BEDFRAME' | 'ACCESSORY' for production depts; NULL/'' for non-production
  hours DOUBLE PRECISION NOT NULL DEFAULT 0,       -- decimal hours; UI inputs e.g. 7.5h directly
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (NOW()),
  updated_at TEXT NOT NULL DEFAULT (NOW()),
  FOREIGN KEY (attendance_id) REFERENCES attendance_records(id) ON DELETE CASCADE,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_working_hour_entries_attendance
  ON working_hour_entries(attendance_id);

CREATE INDEX IF NOT EXISTS idx_working_hour_entries_worker_date
  ON working_hour_entries(worker_id, date);

CREATE INDEX IF NOT EXISTS idx_working_hour_entries_date_dept
  ON working_hour_entries(date, department_code);

-- ----------------------------------------------------------------------------
-- Seed 4 new department codes. INSERT OR IGNORE so re-running is safe.
-- Sequence continues from the existing 8 production depts (FAB_CUT=1 …
-- PACKING=8). Colors picked to be visually distinct from the production set.
-- ----------------------------------------------------------------------------
INSERT INTO departments (id, code, name, short_name, sequence, color, working_hours_per_day) VALUES
  ('dept-9',  'WAREHOUSING',          'Warehousing',          'Warehouse',  9, '#14B8A6', 9),
  ('dept-10', 'REPAIR',               'Repair',               'Repair',    10, '#EAB308', 9),
  ('dept-11', 'MAINTENANCE',          'Maintenance',          'Maint',     11, '#64748B', 9),
  ('dept-12', 'PRODUCTION_SHORTFALL', 'Production Shortfall', 'Shortfall', 12, '#DC2626', 9) ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- workers.otMultiplier — per-worker OT premium. Default 1.5× hourly rate.
-- ----------------------------------------------------------------------------
ALTER TABLE workers ADD COLUMN IF NOT EXISTS ot_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.5;
