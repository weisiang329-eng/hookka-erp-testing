-- ---------------------------------------------------------------------------
-- 0145_dashboard_state_snapshots.sql — Daily point-in-time snapshot of the
-- Command Center's STATE metrics (Backlog, Active Jobs, Workforce).
--
-- WHY
-- ---
-- The Command Center (src/pages/dashboard-b/index.tsx, backed by
-- src/api/routes/dashboard-overview.ts) has a period selector. The flow /
-- sum metrics (revenue, orders created, deliveries, fabric meters issued…)
-- are correctly scoped to the selected month's date range. But three
-- widgets are point-in-time STATE counts, not sums over a range:
--
--   • Backlog       — minutes/days of not-yet-completed work right now
--   • Active Jobs   — production orders still in production right now
--   • Workforce     — active headcount right now
--
-- Those are NOT reconstructible for a PAST month: the DB only holds current
-- state (no historical job_cards / production_orders / workers row versions).
-- Selecting a past month used to silently show the CURRENT value as though
-- it were that month's figure — misleading.
--
-- This table starts capturing a DAILY row of those state counts from now on
-- so future "past months" can be shown truthfully. The dashboard-overview
-- GET handler upserts today's row as a side-effect (c.executionCtx.waitUntil
-- so the response is never slowed). When a past month's last in-range day
-- has a row here, the read path serves the snapshot instead of live and
-- drops the "live (no history)" tag. Months before this table existed →
-- live value + tag.
--
-- Pattern mirrors migrations-postgres/0122_dashboard_snapshot.sql and
-- 0124_delivery_snapshots.sql. See src/api/lib/dashboard-state-snapshot.ts
-- for the read/write helpers.
--
-- COLUMNS
-- -------
--   org_id            — tenant scope (multi-tenant per migration 0049).
--   snap_date         — the calendar day (YYYY-MM-DD) this state was
--                       captured for. (org_id, snap_date) is the PK so the
--                       write is idempotent: re-reading the dashboard many
--                       times in one day just overwrites the same row.
--   backlog_count     — production.backlogMin (minutes of active backlog)
--                       as of capture. Stored as the raw minutes figure the
--                       widget shows; the widget derives backlogDays from it.
--   active_jobs_count — total still-in-production units shown on the Active
--                       Jobs widget (bedframeUnits + sofaSets), for quick
--                       at-a-glance / queryability.
--   workforce_count   — employee.activeHeadcount as of capture.
--   data              — JSONB blob holding the FULL widget sub-objects
--                       (production.backlogMin/backlogDays/backlogByDept/
--                       backlogGrandMin/activeJobs, employee) so the read
--                       path can fully restore the drill-downs, not just the
--                       headline numbers. Same shape the read route builds.
--   captured_at       — wall-clock capture time, observability only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dashboard_state_snapshots (
  org_id            TEXT NOT NULL,
  snap_date         TEXT NOT NULL,
  backlog_count     INTEGER NOT NULL DEFAULT 0,
  active_jobs_count INTEGER NOT NULL DEFAULT 0,
  workforce_count   INTEGER NOT NULL DEFAULT 0,
  data              JSONB NOT NULL,
  captured_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, snap_date)
);

COMMENT ON TABLE dashboard_state_snapshots IS
  'Daily point-in-time snapshot of the Command Center state metrics (Backlog / Active Jobs / Workforce). Lets past-month dashboard views show the true historical figure instead of the current live value. Written by GET /api/dashboard/overview via waitUntil. See migrations-postgres/0145_dashboard_state_snapshots.sql header.';

COMMENT ON COLUMN dashboard_state_snapshots.snap_date IS
  'Calendar day (YYYY-MM-DD) the state was captured for. (org_id, snap_date) PK makes the daily upsert idempotent.';

COMMENT ON COLUMN dashboard_state_snapshots.data IS
  'Full widget sub-objects (production state + employee headcount) so drill-downs restore, not just headline counts.';
