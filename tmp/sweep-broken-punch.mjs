// Owner policy 2026-08-01 (「忘了打卡算他们有来」/「前期我们松一点通融点」):
// a day with a PUNCH but a window the shift maths can't read as work (both
// punches at knock-off, a 1-minute mis-punch, …) and NO logged hours counts as
// ATTENDED — a standard shift — instead of an absence. Generalises the 3 July
// days done by hand. DRY RUN by default; --apply writes.
import postgres from "postgres";
import { computeAttendanceDay, hhmmToMinutes } from "../src/lib/attendance-rules.ts";
import { buildDeptBuckets, prorateHours } from "../src/lib/dept-scan-split.ts";

const APPLY = process.argv.includes("--apply");
const url = "postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
const NOTE = "Backfill: broken punch — counted as attended, standard shift (owner 2026-08-01)";
const PROD = new Set(["FAB_CUT","FAB_SEW","FRAMING","UPHOLSTERY","FOAM","WEBBING","PACKING","WOOD_CUT"]);

try {
  const cands = await sql`
    SELECT a.id AS attendance_id, a.employee_id, a.date, a.clock_in, a.clock_out, a.notes,
           w.emp_no, w.name, w.department_code AS home_dept,
           COALESCE(w.working_hours_per_day,9) AS whpd,
           (w.basic_salary_sen/100.0) / NULLIF(COALESCE(w.working_days_per_month,26),0) AS day_rate
      FROM attendance_records a JOIN workers w ON w.id = a.employee_id
     WHERE a.clock_in IS NOT NULL AND w.emp_no NOT LIKE 'TEST%'
       AND NOT EXISTS (SELECT 1 FROM working_hour_entries e
                        WHERE e.worker_id = a.employee_id AND e.date = a.date AND e.hours > 0)
     ORDER BY a.date, w.emp_no`;

  let n = 0, rm = 0;
  for (const d of cands) {
    const inM = hhmmToMinutes(d.clock_in), outM = hhmmToMinutes(d.clock_out);
    // Only BROKEN windows: no clock-out at all is the forgotten-punch-out case
    // (already handled), a usable window is a real short day (leave it alone).
    const broken = inM == null || outM == null || outM <= inM ||
      (() => { const day = computeAttendanceDay(inM, outM); return day.regularWorkMin <= 0 && day.otMin <= 0; })();
    if (!broken || d.clock_out == null) continue;

    const hours = Number(d.whpd) || 9;
    const scans = await sql`
      SELECT departmentcode, category, atmin FROM dept_scan_events
       WHERE workerid = ${d.employee_id} AND date = ${d.date} ORDER BY atmin`;
    const buckets = buildDeptBuckets(480, 1080, String(d.home_dept ?? "").trim().toUpperCase(),
      scans.map((s) => ({ departmentCode: String(s.departmentcode ?? ""), category: s.category ?? null, atMin: Number(s.atmin) || 0 })));
    if (!buckets.length) { console.log(`  !! ${d.emp_no} ${d.date}: no dept — skipped`); continue; }
    const rows = prorateHours(hours, buckets.map((b) => ({ departmentCode: b.departmentCode, category: b.category, weight: b.minutes })))
      .map((r) => ({ departmentCode: r.departmentCode, category: PROD.has(r.departmentCode) ? (r.category ?? "") : "", hours: r.hours }));

    n++; rm += Number(d.day_rate) || 0;
    console.log(`  ${d.date} ${d.emp_no} ${String(d.name).padEnd(18)} punch ${d.clock_in}–${d.clock_out} → ${rows.map((r)=>`${r.departmentCode}${r.category?"·"+r.category:""} ${r.hours}h`).join(", ")}  (absence −RM ${Number(d.day_rate).toFixed(2)} removed)`);
    if (APPLY) for (const r of rows) {
      await sql`INSERT INTO working_hour_entries (id, attendance_id, worker_id, date, department_code, category, hours, notes)
                VALUES (${`whe-bp${Math.random().toString(16).slice(2,10)}`}, ${d.attendance_id}, ${d.employee_id}, ${d.date}, ${r.departmentCode}, ${r.category}, ${r.hours}, ${NOTE})`;
    }
  }
  console.log(`\n  ${n} broken-punch day(s), RM ${rm.toFixed(2)} of absence removed`);
  console.log(APPLY ? `\nAPPLIED.\nUndo: DELETE FROM working_hour_entries WHERE notes = '${NOTE}';` : "\nDRY RUN — re-run with --apply.");
} finally { await sql.end(); }
