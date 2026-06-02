// ---------------------------------------------------------------------------
// dashboard-state-snapshot.ts — daily capture + read helpers for the
// Command Center's point-in-time STATE metrics (Backlog, Active Jobs,
// Workforce).
//
// Background
// ----------
// GET /api/dashboard/overview accepts a `period` filter ("all" or a
// "YYYY-MM" month). The flow / sum metrics (revenue, orders created,
// deliveries, fabric meters…) are correctly scoped to the selected month's
// date range. But three widgets are point-in-time STATE counts, not sums:
//
//   • Backlog     — minutes/days of not-yet-completed work right now
//   • Active Jobs — production orders still in production right now
//   • Workforce   — active headcount right now
//
// Those are NOT reconstructible for a PAST month (the DB only holds current
// state). To stop the dashboard silently showing today's live value as
// though it were a past month's true figure, we:
//
//   1. capture a daily row of these state metrics from now on, and
//   2. when a past month's last in-range day has a captured row, serve the
//      snapshot for those widgets instead of live (and drop the "live" tag).
//
// Pattern mirrors src/api/lib/dashboard-snapshot.ts /
// src/api/lib/delivery-snapshot.ts. See
// migrations-postgres/0145_dashboard_state_snapshots.sql for the table.
//
// Multi-tenant: every row is scoped by org_id; (org_id, snap_date) is the
// primary key, so the daily write is idempotent (re-reading the dashboard
// many times in one day overwrites the same row).
// ---------------------------------------------------------------------------

// The state-metric payload we persist and restore. Mirrors the matching
// fields the dashboard read route builds, so a restored snapshot drops
// straight back into the response shape (incl. the drill-down sub-objects).
export type DashboardStateMetrics = {
  backlogMin: number;
  backlogDays: number;
  backlogByDept: unknown[];
  backlogGrandMin: number;
  activeJobs: {
    bedframeUnits: number;
    sofaSets: number;
    byCustomer: unknown[];
  };
  activeHeadcount: number;
};

export type DashboardStateSnapshotRow = {
  snapDate: string; // YYYY-MM-DD
  metrics: DashboardStateMetrics;
  capturedAt: string;
};

// ---------------------------------------------------------------------------
// Idempotent UPSERT of today's state metrics. (org_id, snap_date) PK means
// repeated reads on the same day just overwrite the row — no duplicate
// accumulation. Headline count columns are stored alongside the JSON blob
// for at-a-glance queryability; the blob carries the full drill-down
// sub-objects so the read path can restore them.
// ---------------------------------------------------------------------------
export async function writeStateSnapshot(
  db: D1Database,
  orgId: string,
  snapDate: string,
  metrics: DashboardStateMetrics,
): Promise<void> {
  const activeJobsCount =
    (Number(metrics.activeJobs?.bedframeUnits) || 0) +
    (Number(metrics.activeJobs?.sofaSets) || 0);
  const dataJson = JSON.stringify(metrics);
  const capturedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO dashboard_state_snapshots
         (org_id, snap_date, backlog_count, active_jobs_count, workforce_count, data, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, snap_date) DO UPDATE
       SET backlog_count     = EXCLUDED.backlog_count,
           active_jobs_count = EXCLUDED.active_jobs_count,
           workforce_count   = EXCLUDED.workforce_count,
           data              = EXCLUDED.data,
           captured_at       = EXCLUDED.captured_at`,
    )
    .bind(
      orgId,
      snapDate,
      Math.round(Number(metrics.backlogMin) || 0),
      activeJobsCount,
      Math.round(Number(metrics.activeHeadcount) || 0),
      dataJson,
      capturedAt,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Read the snapshot that best represents the END-OF-MONTH state for a past
// month. Returns the most recent captured row whose snap_date falls within
// the month (i.e. the last in-range day we have), or null if no row exists
// for that month (it predates this table → caller serves live + tag).
//
// `period` is a "YYYY-MM" string. Caller is responsible for only calling
// this for PAST months — the current month and the all-time view always
// serve live (the current value IS truthful for "now").
// ---------------------------------------------------------------------------
export async function readStateSnapshotForMonth(
  db: D1Database,
  orgId: string,
  period: string,
): Promise<DashboardStateSnapshotRow | null> {
  if (!/^\d{4}-\d{2}$/.test(period)) return null;
  const monthStart = `${period}-01`;
  // Exclusive upper bound = first day of the next month.
  const [y, m] = period.split("-").map((n) => parseInt(n, 10));
  const nextMonth =
    m === 12
      ? `${y + 1}-01-01`
      : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const row = await db
    .prepare(
      `SELECT snap_date AS "snapDate", data, captured_at AS "capturedAt"
         FROM dashboard_state_snapshots
        WHERE org_id = ? AND snap_date >= ? AND snap_date < ?
        ORDER BY snap_date DESC
        LIMIT 1`,
    )
    .bind(orgId, monthStart, nextMonth)
    .first<{ snapDate: string; data: string; capturedAt: string }>();
  if (!row) return null;
  let metrics: DashboardStateMetrics;
  try {
    // D1 stores TEXT JSON; the Postgres adapter returns JSONB already
    // parsed. Handle both.
    metrics =
      typeof row.data === "string"
        ? (JSON.parse(row.data) as DashboardStateMetrics)
        : (row.data as unknown as DashboardStateMetrics);
  } catch {
    return null;
  }
  return {
    snapDate: row.snapDate,
    metrics,
    capturedAt: row.capturedAt,
  };
}
