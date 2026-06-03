-- ---------------------------------------------------------------------------
-- 0146_employee_state_snapshots.sql — Daily point-in-time snapshot of the
-- Employees page STATE metrics (Headcount, Working Minutes, Labor Cost,
-- Efficiency).
--
-- WHY
-- ---
-- The Employees page (src/pages/employees.tsx, backed by routes like
-- src/api/routes/department-performance.ts, efficiency-report,
-- payslips) summarises point-in-time and period-to-date workforce figures:
--
--   • Active Headcount    — distinct workers contributing right now
--   • Working Minutes      — total clocked minutes in the working window
--   • Labor Cost           — payroll cost in sen for the window
--   • Avg Efficiency       — production-minutes / working-minutes, averaged
--
-- Some of those (headcount especially) are point-in-time STATE counts, not
-- sums reconstructible for a PAST period: the DB only holds current-state
-- workers / working_hour_entries rows, so a past period silently shows the
-- CURRENT value as though it were that period's figure — misleading.
--
-- This table starts capturing a DAILY row of those state metrics from now on
-- so future "past periods" can be shown truthfully. The
-- /api/department-performance GET handler upserts today's row as a
-- side-effect (c.executionCtx.waitUntil so the response is never slowed),
-- reusing the figures it already computed — NO added page-load cost. Periods
-- before this table existed have no row → caller falls back to live.
--
-- Pattern mirrors migrations-postgres/0145_dashboard_state_snapshots.sql.
-- See src/api/lib/employee-state-snapshot.ts for the read/write helpers.
--
-- COLUMNS
-- -------
--   org_id                — tenant scope (multi-tenant per migration 0049).
--   snap_date             — the calendar day (YYYY-MM-DD) this state was
--                           captured for. (org_id, snap_date) is the PK so the
--                           write is idempotent: re-reading the Employees page
--                           many times in one day just overwrites the row.
--   active_headcount      — distinct workers credited in the capture window
--                           (totals.workerCount) as of capture.
--   total_working_minutes — totals.workingMinutes (clocked minutes) as of
--                           capture; stored for at-a-glance queryability.
--   labor_cost_sen        — payroll labor cost in sen for the window, when the
--                           handler has it available; 0 when not computed.
--   avg_efficiency_pct    — totals.efficiencyPct (production/working %) as of
--                           capture.
--   data                  — JSONB blob holding the FULL totals + range
--                           sub-objects so the read path can restore the
--                           drill-downs, not just the headline numbers. Same
--                           shape the read route builds.
--   captured_at           — wall-clock capture time, observability only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_state_snapshots (
  org_id                TEXT NOT NULL,
  snap_date             TEXT NOT NULL,
  active_headcount      INTEGER NOT NULL DEFAULT 0,
  total_working_minutes INTEGER NOT NULL DEFAULT 0,
  labor_cost_sen        INTEGER NOT NULL DEFAULT 0,
  avg_efficiency_pct    INTEGER NOT NULL DEFAULT 0,
  data                  JSONB NOT NULL,
  captured_at           TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, snap_date)
);

COMMENT ON TABLE employee_state_snapshots IS
  'Daily point-in-time snapshot of the Employees page state metrics (Headcount / Working Minutes / Labor Cost / Efficiency). Lets past-period employee views show the true historical figure instead of the current live value. Written by GET /api/department-performance via waitUntil. See migrations-postgres/0146_employee_state_snapshots.sql header.';

COMMENT ON COLUMN employee_state_snapshots.snap_date IS
  'Calendar day (YYYY-MM-DD) the state was captured for. (org_id, snap_date) PK makes the daily upsert idempotent.';

COMMENT ON COLUMN employee_state_snapshots.data IS
  'Full totals + range sub-objects so drill-downs restore, not just headline counts.';
