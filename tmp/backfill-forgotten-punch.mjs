// BUG-2026-08-01-001 backfill — write the working_hour_entries that the
// forgotten-punch auto-close never wrote, so those days stop counting as
// absences. DRY RUN by default; pass --apply to write.
//
// Scope: every attendance row flagged "Forgot to punch out" that has ZERO
// logged hours. Hours = the worker's CONTRACTED shift (same figure the fixed
// autoCloseForgottenPunch now writes). Department = the day's dept scans if
// any, else the worker's home department. Rows carry a distinctive note so the
// whole backfill is reversible with one DELETE.
import postgres from "postgres";
import { buildDeptBuckets, prorateHours } from "../src/lib/dept-scan-split.ts";

const APPLY = process.argv.includes("--apply");
const url =
  "postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

const NOTE = "Backfill: no punch-out — standard shift (BUG-2026-08-01-001)";
const PRODUCTION_DEPTS = new Set([
  "FAB_CUT", "FAB_SEW", "FRAMING", "UPHOLSTERY", "FOAM", "WEBBING",
  "PACKING", "WOOD_CUT",
]);
const hhmm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h > 23 || mi > 59 ? null : h * 60 + mi;
};

try {
  const days = await sql`
    SELECT a.id AS attendance_id, a.employee_id, a.date, a.clock_in, a.clock_out,
           a.department_code AS att_dept, w.emp_no, w.name,
           w.department_code AS home_dept,
           COALESCE(w.working_hours_per_day, 9) AS whpd,
           w.basic_salary_sen, COALESCE(w.working_days_per_month, 26) AS wdpm
      FROM attendance_records a
      JOIN workers w ON w.id = a.employee_id
     WHERE a.notes ILIKE '%Forgot to punch out%'
       AND NOT EXISTS (SELECT 1 FROM working_hour_entries e
                        WHERE e.worker_id = a.employee_id AND e.date = a.date)
     ORDER BY a.date, w.emp_no`;

  console.log(`${days.length} forgotten-punch days with ZERO logged hours\n`);
  const byWorker = new Map();
  const plan = [];

  for (const d of days) {
    const hours = Number(d.whpd) || 9;
    const scans = await sql`
      SELECT departmentcode, category, atmin FROM dept_scan_events
       WHERE workerid = ${d.employee_id} AND date = ${d.date} ORDER BY atmin`;
    let inMin = hhmm(d.clock_in), outMin = hhmm(d.clock_out);
    if (inMin == null || outMin == null || outMin <= inMin) { inMin = 480; outMin = 1080; }
    const home = String(d.home_dept ?? d.att_dept ?? "").trim().toUpperCase();
    const buckets = buildDeptBuckets(
      inMin, outMin, home,
      scans.map((s) => ({
        departmentCode: String(s.departmentcode ?? ""),
        category: s.category ?? null,
        atMin: Number(s.atmin) || 0,
      })),
    );
    if (buckets.length === 0) {
      console.warn(`  !! ${d.emp_no} ${d.date}: no home dept and no scans — SKIPPED`);
      continue;
    }
    const rows = prorateHours(
      hours,
      buckets.map((b) => ({ departmentCode: b.departmentCode, category: b.category, weight: b.minutes })),
    ).map((r) => ({
      departmentCode: r.departmentCode,
      // Production rows need a category; leave blank when unscanned so the
      // office sets it (never guess — owner 2026-06-15).
      category: PRODUCTION_DEPTS.has(r.departmentCode) ? (r.category ?? "") : "",
      hours: r.hours,
    }));
    plan.push({ ...d, hours, rows, scans: scans.length });
    const cur = byWorker.get(d.emp_no) ?? {
      name: d.name, days: 0, hours: 0,
      dayRateRM: (Number(d.basic_salary_sen) / 100) / (Number(d.wdpm) || 26),
    };
    cur.days++; cur.hours += hours;
    byWorker.set(d.emp_no, cur);
  }

  console.log("=== per worker ===");
  let totalRM = 0;
  for (const [emp, v] of [...byWorker].sort()) {
    const rm = v.days * v.dayRateRM;
    totalRM += rm;
    console.log(`  ${emp.padEnd(9)} ${String(v.name).padEnd(18)} ${String(v.days).padStart(2)} days  ${String(v.hours).padStart(5)}h  →  RM ${rm.toFixed(2)} wrongly deducted`);
  }
  console.log(`\n  TOTAL: ${plan.length} days, RM ${totalRM.toFixed(2)}\n`);

  console.log("=== rows to insert (first 12) ===");
  for (const p of plan.slice(0, 12)) {
    console.log(`  ${p.emp_no} ${p.date} (${p.scans} scans) → ${p.rows.map((r) => `${r.departmentCode}${r.category ? "·" + r.category : ""} ${r.hours}h`).join(", ")}`);
  }
  const rowCount = plan.reduce((s, p) => s + p.rows.length, 0);
  console.log(`\n  ${rowCount} working_hour_entries rows total`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to write.");
  } else {
    let n = 0;
    for (const p of plan) {
      for (const r of p.rows) {
        const id = `whe-bf${Math.random().toString(16).slice(2, 10)}`;
        await sql`
          INSERT INTO working_hour_entries
            (id, attendance_id, worker_id, date, department_code, category, hours, notes)
          VALUES (${id}, ${p.attendance_id}, ${p.employee_id}, ${p.date},
                  ${r.departmentCode}, ${r.category}, ${r.hours}, ${NOTE})`;
        n++;
      }
    }
    console.log(`\nAPPLIED — inserted ${n} rows.`);
    console.log(`Undo: DELETE FROM working_hour_entries WHERE notes = '${NOTE}';`);
  }
} finally {
  await sql.end();
}
