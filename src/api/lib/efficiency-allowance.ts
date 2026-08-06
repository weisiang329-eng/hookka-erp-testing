// ---------------------------------------------------------------------------
// Efficiency allowance — month-cumulative efficiency per worker + the gate that
// turns that efficiency into the flat bonus.
//
// The efficiency number here is THE SAME one the operator reads on the
// Employees → Efficiency Overview tab (their monthly reference for "did this
// worker hit the target"), so the bonus that auto-pays always agrees with what
// they see on screen:
//
//   efficiency% = production minutes / (production-dept working hours × 60) × 100
//
//   • production minutes — job_cards.productionTimeMinutes × wipQty, for cards
//     that are COMPLETED/TRANSFERRED with a completedDate inside the month.
//     Split in half when BOTH PIC slots are filled, full when solo. (Exact
//     mirror of GET /api/job-cards/summary.)
//   • production-dept working hours — SUM(working_hour_entries.hours) for the
//     month, counting ONLY departments flagged isProduction. Hours logged to
//     Warehousing / Repair / Maintenance / Shortfall are NOT available
//     production time and are excluded from the denominator. (Exact mirror of
//     the Efficiency Overview denominator + GET /api/working-hour-entries/summary.)
//
// When a worker has no production-dept hours (or no working-hour rows at all)
// in the month, efficiency is null — the Overview shows "—" and NO allowance is
// paid.
//
// The bonus itself is configured per worker (efficiencyAllowanceSen +
// efficiencyThresholdPct, migration 0151). It is a PURE non-statutory bonus:
// every caller adds it to gross pay AFTER calcStatutory, so it never moves
// EPF / SOCSO / EIS / PCB — it is extra money on top, exactly as Wei Siang
// specified ("不算法定纯额外奖金").
//
// For an in-progress month the queries only ever see elapsed job cards + keyed
// hours, so the same call naturally returns the cumulative-to-date efficiency
// (a live estimate); at month-end it is the final figure.
// ---------------------------------------------------------------------------

// D1-compat shape exposed by the SupabaseAdapter installed in worker.ts —
// matches the DbLike used across src/api/lib.
interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

export type WorkerMonthlyEfficiency = {
  /** job_cards production minutes credited to the worker in the month. */
  prodMinutes: number;
  /** Production-dept working hours — the Efficiency % denominator. */
  prodHours: number;
  /** Distinct dates the worker logged ANY working_hour_entries in the month. */
  daysWithEntries: number;
  /**
   * prodMinutes / (prodHours × 60) × 100, or null when it can't be computed
   * (no production-dept hours / no entries at all). null ⇒ no allowance.
   */
  pct: number | null;
};

// Per-worker production minutes for the window — mirrors GET /api/job-cards/
// summary byte-for-byte (PIC halving when both slots filled, × wipQty, only
// COMPLETED/TRANSFERRED cards with a completedDate in range). Output aliases
// are snake_case so Postgres preserves them through the unquoted-identifier
// lowercase fold; the driver's transform.column.from restores worker_id →
// workerId and production_minutes → productionMinutes on the way back.
// FAB_CUT exception (mirrors jcMinutesTotal + the cost cascade + /summary):
// merged FABRIC CUTTING cards store productionTimeMinutes as the per-SET TOTAL
// already (wipQty = piece count), so the ×wipQty would triple-count there —
// JC_TOTAL_MIN uses the stored total as-is for FAB_CUT and ×wipQty everywhere
// else. This feeds the (money-adjacent) efficiency-allowance gate, so the
// over-count must not leak in.
const JC_TOTAL_MIN =
  "CASE WHEN departmentCode = 'FAB_CUT' THEN COALESCE(productionTimeMinutes, 0) " +
  "ELSE COALESCE(productionTimeMinutes, 0) * GREATEST(1, COALESCE(wipQty, 1)) END";
const JC_PROD_MINUTES_SQL = `
  SELECT wid AS worker_id, SUM(contrib_min) AS production_minutes
    FROM (
      SELECT pic1Id AS wid,
             CASE WHEN pic2Id IS NOT NULL AND pic2Id != ''
                  THEN (${JC_TOTAL_MIN}) / 2.0
                  ELSE (${JC_TOTAL_MIN})
             END AS contrib_min
        FROM job_cards
       WHERE pic1Id IS NOT NULL AND pic1Id != ''
         AND status IN ('COMPLETED','TRANSFERRED')
         AND completedDate IS NOT NULL
         AND completedDate >= ? AND completedDate <= ?

      UNION ALL

      SELECT pic2Id AS wid,
             CASE WHEN pic1Id IS NOT NULL AND pic1Id != ''
                  THEN (${JC_TOTAL_MIN}) / 2.0
                  ELSE (${JC_TOTAL_MIN})
             END AS contrib_min
        FROM job_cards
       WHERE pic2Id IS NOT NULL AND pic2Id != ''
         AND status IN ('COMPLETED','TRANSFERRED')
         AND completedDate IS NOT NULL
         AND completedDate >= ? AND completedDate <= ?
    ) sub
   WHERE wid IS NOT NULL AND wid != ''
   GROUP BY wid
`;

/**
 * Approved EXTRA-PRODUCTION-TIME minutes per worker for [periodStart, periodEnd]
 * (inclusive YYYY-MM-DD), keyed on the request's `date`.
 *
 * These are `worker_nonprod_requests` rows with kind = 'ADD_PROD' and status =
 * 'APPROVED' — a worker's claim that a job took longer than its WIP standard
 * (e.g. a 1h-standard customize job that actually took 3h → +2h). Approving the
 * claim is what makes the time count: it is added to the efficiency NUMERATOR
 * (credited production minutes), NOT the denominator. The hours never become a
 * working_hour_entries row, so they can't inflate production-dept clock-hours.
 *
 * Returns minutes (hours × 60, rounded). A worker with no approved ADD_PROD
 * claims simply isn't in the map → 0 added → byte-identical to the old number.
 *
 * Soft-fails to an empty map if the column/table isn't there yet (a cold
 * isolate that hasn't run ensureNonprodRequests) so efficiency never 500s.
 */
export async function computeApprovedAddProdMinutesByWorker(
  db: DbLike,
  periodStart: string,
  periodEnd: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const res = await db
      .prepare(
        `SELECT worker_id AS workerId, COALESCE(approved_hours, hours) AS hours
           FROM worker_nonprod_requests
          WHERE kind = 'ADD_PROD'
            AND status = 'APPROVED'
            AND date >= ? AND date <= ?`,
      )
      .bind(periodStart, periodEnd)
      .all<{ workerId: string; hours: number | string | null }>();
    for (const r of res.results ?? []) {
      const wid = r.workerId;
      if (!wid) continue;
      const h = typeof r.hours === "number" ? r.hours : Number(r.hours) || 0;
      out.set(wid, (out.get(wid) ?? 0) + Math.round(h * 60));
    }
  } catch {
    // Table/column not present yet, or any read hiccup → no extra credit.
    // Efficiency falls back to the exact pre-feature number.
  }
  return out;
}

/**
 * Month-cumulative efficiency per worker for [periodStart, periodEnd]
 * (inclusive YYYY-MM-DD). Returns one entry per worker seen in either the
 * job-card or working-hour data for the window.
 */
export async function computeMonthlyEfficiencyByWorker(
  db: DbLike,
  periodStart: string,
  periodEnd: string,
): Promise<Map<string, WorkerMonthlyEfficiency>> {
  // 1. Which departments count toward the efficiency denominator. Truthy
  //    isProduction (1 / true) only — same test the Overview uses.
  const deptRes = await db
    .prepare("SELECT code, isProduction FROM departments")
    .bind()
    .all<{ code: string; isProduction: number | boolean | null }>();
  const productionDeptCodes = new Set<string>();
  for (const d of deptRes.results ?? []) {
    if (d.isProduction) productionDeptCodes.add(d.code);
  }

  // 2. Production minutes per worker (numerator).
  const jcRes = await db
    .prepare(JC_PROD_MINUTES_SQL)
    .bind(periodStart, periodEnd, periodStart, periodEnd)
    .all<{ workerId: string; productionMinutes: number | string | null }>();
  const prodMinByWorker = new Map<string, number>();
  for (const r of jcRes.results ?? []) {
    prodMinByWorker.set(
      r.workerId,
      Math.round(Number(r.productionMinutes) || 0),
    );
  }

  // 2b. Approved EXTRA PRODUCTION TIME (kind='ADD_PROD') → add to the NUMERATOR.
  // A worker who legitimately spent longer than the WIP standard on a job gets
  // that approved extra time credited as production output. Excluded entirely
  // when there are no approved claims (map empty) → unchanged efficiency.
  const addProdByWorker = await computeApprovedAddProdMinutesByWorker(
    db,
    periodStart,
    periodEnd,
  );
  for (const [wid, mins] of addProdByWorker) {
    prodMinByWorker.set(wid, (prodMinByWorker.get(wid) ?? 0) + mins);
  }

  // 3. Working-hour rows for the window — sum production-dept hours (the
  //    denominator) and count distinct entry-days per worker. Raw rows are
  //    aggregated in JS so the distinct-date count is exact across depts.
  const wheRes = await db
    .prepare(
      `SELECT workerId, departmentCode, date, hours
         FROM working_hour_entries
        WHERE date >= ? AND date <= ?`,
    )
    .bind(periodStart, periodEnd)
    .all<{
      workerId: string;
      departmentCode: string;
      date: string;
      hours: number | string | null;
    }>();
  const prodHoursByWorker = new Map<string, number>();
  const entryDaysByWorker = new Map<string, Set<string>>();
  for (const r of wheRes.results ?? []) {
    let days = entryDaysByWorker.get(r.workerId);
    if (!days) {
      days = new Set<string>();
      entryDaysByWorker.set(r.workerId, days);
    }
    days.add(r.date);
    if (productionDeptCodes.has(r.departmentCode)) {
      const h = typeof r.hours === "number" ? r.hours : Number(r.hours) || 0;
      prodHoursByWorker.set(
        r.workerId,
        (prodHoursByWorker.get(r.workerId) ?? 0) + h,
      );
    }
  }

  // 4. Assemble per-worker efficiency over the UNION of both sources.
  const out = new Map<string, WorkerMonthlyEfficiency>();
  const allWorkerIds = new Set<string>([
    ...prodMinByWorker.keys(),
    ...entryDaysByWorker.keys(),
  ]);
  for (const wid of allWorkerIds) {
    const prodMinutes = prodMinByWorker.get(wid) ?? 0;
    const prodHours = prodHoursByWorker.get(wid) ?? 0;
    const daysWithEntries = entryDaysByWorker.get(wid)?.size ?? 0;
    // Same "—" rule as the Efficiency Overview: a zero denominator (no
    // production-dept hours) OR no working-hour rows at all ⇒ efficiency is
    // not defined for this worker this month.
    const pct =
      prodHours > 0 && daysWithEntries > 0
        ? (prodMinutes / (prodHours * 60)) * 100
        : null;
    out.set(wid, { prodMinutes, prodHours, daysWithEntries, pct });
  }
  return out;
}

/**
 * The gate: how much efficiency allowance (in sen) a worker earns for the
 * month, given their monthly efficiency and their per-worker config.
 *
 * Pays the flat efficiencyAllowanceSen iff the worker's monthly efficiency
 * reaches their efficiencyThresholdPct; otherwise 0. A worker with no bonus
 * configured (the default 0/0) or no computable efficiency earns nothing.
 */
export function resolveEfficiencyAllowanceSen(
  eff: WorkerMonthlyEfficiency | undefined,
  allowanceSen: number | null | undefined,
  thresholdPct: number | null | undefined,
  attendance?: { workingDays: number; absentDays: number },
): number {
  const allow = Math.round(Number(allowanceSen) || 0);
  const threshold = Number(thresholdPct) || 0;
  // Not configured. A threshold of 0 is treated as "off" on purpose — the
  // efficiency allowance is a reach-the-target bonus, not an unconditional add.
  if (allow <= 0 || threshold <= 0) return 0;
  // No computable efficiency (em-dash on the Overview) ⇒ no bonus.
  if (!eff || eff.pct === null) return 0;
  // Compare on the SAME one-decimal figure the operator reads on the Efficiency
  // Overview, so "screen shows 100.0% → bonus paid" always holds (avoids a
  // 99.96%-rounds-to-100.0%-but-no-pay surprise).
  const shown = Math.round(eff.pct * 10) / 10;
  if (shown < threshold) return 0;

  // Pro-rate by days actually worked. Owner 2026-08-06: "如果一个月有 27 天的
  // 工作天，他两天没有来，代表这两天其实是没有工作的 … 即使效率达到了也是会
  // 扣钱的."
  //
  // Efficiency is a RATE — minutes produced per hour present — so a worker who
  // came for 24 of 26 days can hit 100% while producing two days less. Paying
  // the full bonus there pays for output that was never made. The threshold
  // still gates: missing it earns nothing regardless of attendance.
  //
  // Uses the SAME absent_days that already drives the salary deduction on the
  // payslip, so the two lines can never tell different stories about the same
  // absence.
  //
  // No attendance passed ⇒ full amount, so any caller not yet updated keeps
  // its old behaviour rather than silently paying everyone zero.
  if (!attendance) return allow;
  const workingDays = Math.max(0, Math.round(Number(attendance.workingDays) || 0));
  const absentDays = Math.max(0, Math.round(Number(attendance.absentDays) || 0));
  if (workingDays <= 0) return allow;
  const worked = Math.max(0, workingDays - absentDays);
  return Math.round((allow * worked) / workingDays);
}

/** period "YYYY-MM" → inclusive first + last calendar day as "YYYY-MM-DD". */
export function monthBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last of this
  return {
    start: `${period}-01`,
    end: `${period}-${String(lastDay).padStart(2, "0")}`,
  };
}
