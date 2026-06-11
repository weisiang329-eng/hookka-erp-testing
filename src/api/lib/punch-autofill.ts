// ---------------------------------------------------------------------------
// Punch → Working Hours auto-fill (owner 2026-06-11).
//
// Flow: a worker's day defaults to their HOME department; scanning a
// department QR ("deptscan") moves the clock to that department from that
// minute; punch-out closes the day and this module writes the
// working_hour_entries rows the office used to key by hand:
//   • day hours = the SAME attendance-rules figure the office grid auto-fills
//     from the punch (lunch deducted, late ceiled, OT floored, effective-dated
//     rules) — pay maths is unchanged, scans only decide the SPLIT;
//   • department split = pro-rata by scanned segments (no scans → home dept);
//   • category (mode A, owner-picked): pro-rata by the job cards that
//     department actually worked — completed that day first, else its
//     currently-open cards, else a flagged single row for the office to fix.
//
// SAFETY: never overwrites — if ANY entries already exist for the attendance
// (office keyed them, or a previous punch-out wrote them), it does nothing.
// Rows carry an "Auto from punch" note so the office can tell them apart and
// correct freely in the grid. Callers wrap in try/catch: a failure here must
// NEVER fail the punch itself.
//
// dept_scan_events uses deliberately ALL-LOWERCASE column names (adapter rule:
// unknown camelCase identifiers fold to lowercase in Postgres — lowercase from
// day one means reads and writes can never disagree).
// ---------------------------------------------------------------------------
import {
  buildDeptBuckets,
  prorateHours,
  type DeptScanEvent,
} from "../../lib/dept-scan-split";
import { computeAttendanceDay, hhmmToMinutes } from "../../lib/attendance-rules";
import { resolvePayRulesAsOf, toAttendanceRules } from "../../lib/pay-rules";
import { loadPayRuleVersions } from "./pay-rules-store";
import {
  PRODUCTION_DEPTS,
  VALID_CATEGORIES,
} from "../routes/working-hour-entries";

let _deptScanMig: Promise<void> | null = null;
export function ensureDeptScanEvents(db: D1Database): Promise<void> {
  if (_deptScanMig) return _deptScanMig;
  _deptScanMig = (async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS dept_scan_events (
           id TEXT PRIMARY KEY,
           workerid TEXT NOT NULL,
           date TEXT NOT NULL,
           departmentcode TEXT NOT NULL,
           atmin INTEGER NOT NULL,
           createdat TEXT
         )`,
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_dept_scan_events_worker_date ON dept_scan_events (workerid, date)",
      )
      .run();
  })();
  return _deptScanMig;
}

/** Record one "I am now working in <dept>" scan. */
export async function recordDeptScan(
  db: D1Database,
  args: { workerId: string; date: string; departmentCode: string; atMin: number },
): Promise<void> {
  await ensureDeptScanEvents(db);
  await db
    .prepare(
      `INSERT INTO dept_scan_events (id, workerid, date, departmentcode, atmin, createdat)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `dse-${crypto.randomUUID().slice(0, 8)}`,
      args.workerId,
      args.date,
      args.departmentCode,
      Math.round(args.atMin),
      new Date().toISOString(),
    )
    .run();
}

type CatWeight = { category: string; weight: number };

// Mode A category signal for one department on one date: what that department
// actually worked. Completed-that-day first; else its currently-open cards.
async function categoryWeightsFor(
  db: D1Database,
  departmentCode: string,
  date: string,
): Promise<CatWeight[]> {
  const pick = (rows: Array<{ cat: string | null; n: number }> | undefined) =>
    (rows ?? [])
      .map((r) => ({
        category: String(r.cat ?? "").toUpperCase(),
        weight: Number(r.n) || 0,
      }))
      .filter((r) => VALID_CATEGORIES.has(r.category) && r.weight > 0);

  const done = await db
    .prepare(
      `SELECT po.itemCategory AS cat, COUNT(*) AS n
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE jc.departmentCode = ? AND jc.completedDate = ?
          AND jc.status IN ('COMPLETED','TRANSFERRED')
        GROUP BY po.itemCategory`,
    )
    .bind(departmentCode, date)
    .all<{ cat: string | null; n: number }>();
  const doneW = pick(done.results);
  if (doneW.length > 0) return doneW;

  const open = await db
    .prepare(
      `SELECT po.itemCategory AS cat, COUNT(*) AS n
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE jc.departmentCode = ? AND jc.status IN ('PENDING','WAITING','IN_PROGRESS')
        GROUP BY po.itemCategory`,
    )
    .bind(departmentCode)
    .all<{ cat: string | null; n: number }>();
  return pick(open.results);
}

/**
 * Write the day's working_hour_entries from the punch + dept scans.
 * No-op when entries already exist, the punch window is empty, or there is
 * nothing attributable (no home department AND no scans).
 */
export async function autofillWorkingHoursFromPunch(
  db: D1Database,
  args: {
    attendanceId: string;
    workerId: string;
    date: string;
    clockIn: string;
    clockOut: string;
    homeDeptCode: string | null | undefined;
  },
): Promise<{ created: number }> {
  const inMin = hhmmToMinutes(args.clockIn);
  const outMin = hhmmToMinutes(args.clockOut);
  if (inMin == null || outMin == null || outMin <= inMin) return { created: 0 };

  // Never overwrite — the office's rows (or a previous punch-out) win.
  const existing = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM working_hour_entries WHERE attendanceId = ?",
    )
    .bind(args.attendanceId)
    .first<{ n: number }>();
  if ((Number(existing?.n) || 0) > 0) return { created: 0 };

  // Day hours — IDENTICAL to the office grid's punch auto-fill: the
  // effective-dated rules engine (lunch, late ceiling, OT floors, same-day
  // OT offset). The grid saves regular+OT as one Hours figure.
  let versions: Awaited<ReturnType<typeof loadPayRuleVersions>> = [];
  try {
    versions = await loadPayRuleVersions(db);
  } catch {
    versions = [];
  }
  const rules = toAttendanceRules(resolvePayRulesAsOf(versions, args.date));
  const day = computeAttendanceDay(inMin, outMin, rules);
  const totalHours =
    Math.round(((day.regularWorkMin + day.otMin) / 60) * 100) / 100;
  if (totalHours <= 0) return { created: 0 };

  await ensureDeptScanEvents(db);
  const evRes = await db
    .prepare(
      "SELECT departmentcode, atmin FROM dept_scan_events WHERE workerid = ? AND date = ? ORDER BY atmin",
    )
    .bind(args.workerId, args.date)
    .all<{ departmentcode: string; atmin: number }>();
  const events: DeptScanEvent[] = (evRes.results ?? []).map((r) => ({
    departmentCode: String(r.departmentcode ?? ""),
    atMin: Number(r.atmin) || 0,
  }));

  const home = (args.homeDeptCode ?? "").trim().toUpperCase();
  const buckets = buildDeptBuckets(inMin, outMin, home, events);
  if (buckets.length === 0) return { created: 0 };

  const deptRows = prorateHours(
    totalHours,
    buckets.map((b) => ({ departmentCode: b.departmentCode, weight: b.minutes })),
  );

  const scanned = events.length > 0;
  let created = 0;
  for (const d of deptRows) {
    type Row = { departmentCode: string; category: string; hours: number; notes: string };
    let rows: Row[];
    if (PRODUCTION_DEPTS.has(d.departmentCode)) {
      const weights = await categoryWeightsFor(db, d.departmentCode, args.date);
      const split = prorateHours(d.hours, weights);
      rows =
        split.length > 0
          ? split.map((s) => ({
              departmentCode: d.departmentCode,
              category: s.category,
              hours: s.hours,
              notes: scanned ? "Auto from punch + dept scan" : "Auto from punch",
            }))
          : [
              {
                departmentCode: d.departmentCode,
                // No job-card signal at all for this dept — flag for the
                // office instead of inventing a category silently.
                category: "SOFA",
                hours: d.hours,
                notes: "Auto from punch — category unknown, please check",
              },
            ];
    } else {
      rows = [
        {
          departmentCode: d.departmentCode,
          category: "",
          hours: d.hours,
          notes: scanned ? "Auto from punch + dept scan" : "Auto from punch",
        },
      ];
    }
    for (const r of rows) {
      await db
        .prepare(
          `INSERT INTO working_hour_entries (id, attendanceId, workerId, date, departmentCode, category, hours, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `whe-${crypto.randomUUID().slice(0, 8)}`,
          args.attendanceId,
          args.workerId,
          args.date,
          r.departmentCode,
          r.category,
          r.hours,
          r.notes,
        )
        .run();
      created++;
    }
  }
  return { created };
}
