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

let _deptScanMig = false;
export async function ensureDeptScanEvents(db: D1Database): Promise<void> {
  if (_deptScanMig) return;

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
  // v2 (owner 2026-06-11): production QRs carry the CATEGORY (Sofa /
  // Bedframe / Accessory line) — per-person line attribution, not the
  // department average. Nullable: dept-only scans + non-production depts.
  await db
    .prepare(
      "ALTER TABLE dept_scan_events ADD COLUMN IF NOT EXISTS category TEXT",
    )
    .run();
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_dept_scan_events_worker_date ON dept_scan_events (workerid, date)",
    )
    .run();
  _deptScanMig = true;
}

/** Record one "I am now working in <dept> (on <category> line)" scan. */
export async function recordDeptScan(
  db: D1Database,
  args: {
    workerId: string;
    date: string;
    departmentCode: string;
    category?: string | null;
    atMin: number;
  },
): Promise<void> {
  await ensureDeptScanEvents(db);
  await db
    .prepare(
      `INSERT INTO dept_scan_events (id, workerid, date, departmentcode, category, atmin, createdat)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `dse-${crypto.randomUUID().slice(0, 8)}`,
      args.workerId,
      args.date,
      args.departmentCode,
      args.category ?? null,
      Math.round(args.atMin),
      new Date().toISOString(),
    )
    .run();
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
    /**
     * FORGOTTEN-PUNCH path (BUG-2026-08-01-004). A day closed by the
     * auto-clockout (worker punched in, never out) pays as a NORMAL shift —
     * standard hours, no OT, no short dock — so the caller passes that fixed
     * figure instead of letting the punch window decide. Set, it also relaxes
     * the window gate: those rows can carry a missing or INVERTED window (a
     * worker who forgot the morning punch and clocked in at 18:03 is closed at
     * 18:00), which the normal path rejects. Omit for a real punch-out.
     */
    fixedHours?: number | null;
  },
): Promise<{ created: number }> {
  const inMinRaw = hhmmToMinutes(args.clockIn);
  const outMinRaw = hhmmToMinutes(args.clockOut);
  const fixedHours = Number(args.fixedHours) || 0;
  if (
    fixedHours <= 0 &&
    (inMinRaw == null || outMinRaw == null || outMinRaw <= inMinRaw)
  )
    return { created: 0 };

  // Never overwrite — the office's rows (or a previous punch-out) win.
  // EXCEPTION (owner report 2026-07-04, the "AUNG KYAW SOE 1.33h day"): rows
  // created by an APPROVED non-production request must NOT block the punch
  // rows. When the approval landed BEFORE this autofill ran, the old blanket
  // COUNT(*) gate skipped the whole day and the worker's ~9 punched hours
  // were never logged — the day showed only the approved 1.33h. Those rows
  // are recognisable by their notes prefix (working-hour-entries.ts approval
  // INSERT). When they are the ONLY rows, still autofill — minus the hours
  // the approval already claimed (its usual deduct-from-production step had
  // nothing to deduct from at approval time).
  const existingRes = await db
    .prepare(
      "SELECT hours, notes FROM working_hour_entries WHERE attendanceId = ?",
    )
    .bind(args.attendanceId)
    .all<{ hours: number; notes: string | null }>();
  const existingRows = existingRes.results ?? [];
  const nonProdApproved = existingRows.filter((r) =>
    String(r.notes ?? "").startsWith("Non-production (approved)"),
  );
  if (existingRows.length > nonProdApproved.length) return { created: 0 };
  const nonProdApprovedHours = nonProdApproved.reduce(
    (s, r) => s + (Number(r.hours) || 0),
    0,
  );

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
  // The window the dept/category SPLIT is carved from. A forgotten punch may
  // have no usable window (inverted times); fall back to the standard shift so
  // the scans still split the day sensibly. Pay is unaffected either way — the
  // split only decides WHICH department rows the fixed total lands in.
  let inMin = inMinRaw;
  let outMin = outMinRaw;
  if (inMin == null || outMin == null || outMin <= inMin) {
    inMin = rules.startMin;
    outMin = rules.endMin;
  }
  const dayHours =
    fixedHours > 0
      ? fixedHours
      : (() => {
          const day = computeAttendanceDay(inMin, outMin, rules);
          return (day.regularWorkMin + day.otMin) / 60;
        })();
  // Subtract hours an approved non-production request already claimed for
  // this day (see the gate above) so the day's TOTAL stays the punch total.
  const totalHours = Math.max(
    0,
    Math.round((dayHours - nonProdApprovedHours) * 100) / 100,
  );
  if (totalHours <= 0) return { created: 0 };

  await ensureDeptScanEvents(db);
  const evRes = await db
    .prepare(
      "SELECT departmentcode, category, atmin FROM dept_scan_events WHERE workerid = ? AND date = ? ORDER BY atmin",
    )
    .bind(args.workerId, args.date)
    .all<{ departmentcode: string; category: string | null; atmin: number }>();
  const events: DeptScanEvent[] = (evRes.results ?? []).map((r) => ({
    departmentCode: String(r.departmentcode ?? ""),
    category: r.category ?? null,
    atMin: Number(r.atmin) || 0,
  }));

  const home = (args.homeDeptCode ?? "").trim().toUpperCase();
  const buckets = buildDeptBuckets(inMin, outMin, home, events);
  if (buckets.length === 0) return { created: 0 };

  const deptRows = prorateHours(
    totalHours,
    buckets.map((b) => ({
      departmentCode: b.departmentCode,
      category: b.category,
      weight: b.minutes,
    })),
  );

  const scanned = events.length > 0;
  let created = 0;
  type Row = { departmentCode: string; category: string; hours: number; notes: string };
  const allRows: Row[] = [];
  for (const d of deptRows) {
    let rows: Row[];
    if (PRODUCTION_DEPTS.has(d.departmentCode)) {
      if (d.category && VALID_CATEGORIES.has(d.category)) {
        // The worker SCANNED the line (owner v2): per-person truth — use it
        // directly, no job-card derivation.
        rows = [
          {
            departmentCode: d.departmentCode,
            category: d.category,
            hours: d.hours,
            notes: "Auto from punch + line scan",
          },
        ];
      } else {
        // No category scanned (dept-only QR or home default). Owner
        // 2026-06-15 ("打卡类别,remove 猜测"): do NOT guess the category from
        // job cards — attribute strictly to what the worker scanned. Leave the
        // category BLANK so the office sets it (the office grid requires a
        // category on production rows, so it surfaces as "needs category"
        // rather than a wrong guess).
        rows = [
          {
            departmentCode: d.departmentCode,
            category: "",
            hours: d.hours,
            notes: scanned
              ? "Auto from punch + dept scan — set category"
              : "Auto from punch — set category",
          },
        ];
      }
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
    allRows.push(...rows);
  }

  // Tag the forgotten-punch rows so the office can tell them from a real
  // punch-out: these hours are the CONTRACTED shift, not a measured window.
  if (fixedHours > 0) {
    for (const r of allRows) r.notes = `${r.notes} (no punch-out — standard shift)`;
  }

  // Merge rows that land on the same (department × category) — e.g. a
  // scanned Sofa stretch plus a home-default stretch whose job-card mix also
  // resolved to Sofa. One Working Hours row each, hours summed (2-dp safe:
  // every part came out of prorateHours' cent arithmetic).
  const merged = new Map<string, { departmentCode: string; category: string; hours: number; notes: string }>();
  for (const r of allRows) {
    const key = `${r.departmentCode}|${r.category}`;
    const cur = merged.get(key);
    if (cur) {
      cur.hours = Math.round((cur.hours + r.hours) * 100) / 100;
      // Keep the flagged note if either part carried it.
      if (r.notes.includes("please check")) cur.notes = r.notes;
    } else {
      merged.set(key, { ...r });
    }
  }

  for (const r of merged.values()) {
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
  return { created };
}
