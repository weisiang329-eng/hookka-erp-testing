// ---------------------------------------------------------------------------
// employee-state-snapshot.ts — daily capture + read helpers for the
// Employees page's point-in-time STATE metrics (Headcount, Working Minutes,
// Labor Cost, Efficiency).
//
// Background
// ----------
// The Employees page (src/pages/employees.tsx) is backed by routes such as
// /api/department-performance, /api/reports/efficiency and /api/payslips. Its
// summary cards show workforce figures that are point-in-time STATE counts,
// not sums reconstructible for a PAST period:
//
//   • Active Headcount     — distinct workers contributing right now
//   • Working Minutes       — total clocked minutes in the window
//   • Labor Cost            — payroll cost in sen for the window
//   • Avg Efficiency        — production-minutes / working-minutes
//
// The DB only holds current-state workers / working_hour_entries rows, so a
// past period silently shows the CURRENT value as though it were that
// period's true figure. To stop that, we:
//
//   1. capture a daily row of these state metrics from now on, and
//   2. let a caller serve the snapshot for a past period instead of live.
//
// Pattern mirrors src/api/lib/dashboard-state-snapshot.ts. See
// migrations-postgres/0146_employee_state_snapshots.sql for the table.
//
// The capture is a BACKGROUND side-effect of GET /api/department-performance
// (fire-and-forget via c.executionCtx.waitUntil) — it reuses the totals that
// handler already computed and NEVER slows the Employees page render.
//
// Multi-tenant: every row is scoped by org_id; (org_id, snap_date) is the
// primary key, so the daily write is idempotent (re-reading the page many
// times in one day overwrites the same row).
// ---------------------------------------------------------------------------

// The state-metric payload we persist and restore. Mirrors the matching
// fields the department-performance read route builds (totals + range), so a
// restored snapshot drops straight back into the response shape.
export type EmployeeStateMetrics = {
  activeHeadcount: number;
  totalWorkingMinutes: number;
  laborCostSen: number;
  avgEfficiencyPct: number;
  range: { from: string; to: string };
};

export type EmployeeStateSnapshotRow = {
  snapDate: string; // YYYY-MM-DD
  metrics: EmployeeStateMetrics;
  capturedAt: string;
};

// ---------------------------------------------------------------------------
// Idempotent UPSERT of today's state metrics. (org_id, snap_date) PK means
// repeated reads on the same day just overwrite the row — no duplicate
// accumulation. Headline count columns are stored alongside the JSON blob
// for at-a-glance queryability; the blob carries the full sub-objects so the
// read path can restore them.
// ---------------------------------------------------------------------------
export async function writeEmployeeStateSnapshot(
  db: D1Database,
  orgId: string,
  snapDate: string,
  metrics: EmployeeStateMetrics,
): Promise<void> {
  const dataJson = JSON.stringify(metrics);
  const capturedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO employee_state_snapshots
         (org_id, snap_date, active_headcount, total_working_minutes, labor_cost_sen, avg_efficiency_pct, data, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, snap_date) DO UPDATE
       SET active_headcount      = EXCLUDED.active_headcount,
           total_working_minutes = EXCLUDED.total_working_minutes,
           labor_cost_sen        = EXCLUDED.labor_cost_sen,
           avg_efficiency_pct    = EXCLUDED.avg_efficiency_pct,
           data                  = EXCLUDED.data,
           captured_at           = EXCLUDED.captured_at`,
    )
    .bind(
      orgId,
      snapDate,
      Math.round(Number(metrics.activeHeadcount) || 0),
      Math.round(Number(metrics.totalWorkingMinutes) || 0),
      Math.round(Number(metrics.laborCostSen) || 0),
      Math.round(Number(metrics.avgEfficiencyPct) || 0),
      dataJson,
      capturedAt,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Read the snapshot that best represents the END-OF-MONTH state for a past
// month. Returns the most recent captured row whose snap_date falls within
// the month (i.e. the last in-range day we have), or null if no row exists
// for that month (it predates this table → caller serves live).
//
// `period` is a "YYYY-MM" string. Caller is responsible for only calling
// this for PAST months — the current month always serves live (the current
// value IS truthful for "now").
// ---------------------------------------------------------------------------
export async function readEmployeeStateSnapshotForMonth(
  db: D1Database,
  orgId: string,
  period: string,
): Promise<EmployeeStateSnapshotRow | null> {
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
         FROM employee_state_snapshots
        WHERE org_id = ? AND snap_date >= ? AND snap_date < ?
        ORDER BY snap_date DESC
        LIMIT 1`,
    )
    .bind(orgId, monthStart, nextMonth)
    .first<{ snapDate: string; data: string; capturedAt: string }>();
  if (!row) return null;
  let metrics: EmployeeStateMetrics;
  try {
    // D1 stores TEXT JSON; the Postgres adapter returns JSONB already
    // parsed. Handle both.
    metrics =
      typeof row.data === "string"
        ? (JSON.parse(row.data) as EmployeeStateMetrics)
        : (row.data as unknown as EmployeeStateMetrics);
  } catch {
    return null;
  }
  return {
    snapDate: row.snapDate,
    metrics,
    capturedAt: row.capturedAt,
  };
}
