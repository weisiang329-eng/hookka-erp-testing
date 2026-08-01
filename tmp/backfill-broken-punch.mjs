// Owner decision 2026-08-01: 「忘了打卡算他们有来吧那三天」 — the three days where
// the worker punched IN and OUT in the same minute (forgot the morning punch,
// did both at knock-off) count as attended, standard shift.
// Also clears the AUTO hour dock those broken windows produced, which was
// stacked on top of the day's absence (BUG-2026-08-01-002).
// DRY RUN by default; pass --apply.
import postgres from "postgres";
import { buildDeptBuckets, prorateHours } from "../src/lib/dept-scan-split.ts";

const APPLY = process.argv.includes("--apply");
const url =
  "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

const NOTE = "Backfill: broken punch — counted as attended, standard shift (owner 2026-08-01)";
const PRODUCTION_DEPTS = new Set([
  "FAB_CUT", "FAB_SEW", "FRAMING", "UPHOLSTERY", "FOAM", "WEBBING", "PACKING", "WOOD_CUT",
]);
const TARGETS = [["EMP-003", "2026-07-01"], ["EMP-018", "2026-07-02"], ["EMP-022", "2026-07-01"]];

try {
  for (const [emp, date] of TARGETS) {
    const [d] = await sql`
      SELECT a.id AS attendance_id, a.employee_id, a.date, a.clock_in, a.clock_out,
             w.emp_no, w.name, w.department_code AS home_dept,
             COALESCE(w.working_hours_per_day, 9) AS whpd,
             w.basic_salary_sen, COALESCE(w.working_days_per_month, 26) AS wdpm
        FROM attendance_records a JOIN workers w ON w.id = a.employee_id
       WHERE w.emp_no = ${emp} AND a.date = ${date}`;
    if (!d) { console.log(`  !! ${emp} ${date}: no attendance row — skipped`); continue; }

    const existing = await sql`
      SELECT COUNT(*)::int AS n FROM working_hour_entries
       WHERE worker_id = ${d.employee_id} AND date = ${date}`;
    if (existing[0].n > 0) { console.log(`  -- ${emp} ${date}: already has hours — skipped`); continue; }

    const hours = Number(d.whpd) || 9;
    const scans = await sql`
      SELECT departmentcode, category, atmin FROM dept_scan_events
       WHERE workerid = ${d.employee_id} AND date = ${date} ORDER BY atmin`;
    // Broken window → carve the split from the standard shift instead.
    const home = String(d.home_dept ?? "").trim().toUpperCase();
    const buckets = buildDeptBuckets(480, 1080, home, scans.map((s) => ({
      departmentCode: String(s.departmentcode ?? ""),
      category: s.category ?? null,
      atMin: Number(s.atmin) || 0,
    })));
    const rows = prorateHours(hours, buckets.map((b) => ({
      departmentCode: b.departmentCode, category: b.category, weight: b.minutes,
    }))).map((r) => ({
      departmentCode: r.departmentCode,
      category: PRODUCTION_DEPTS.has(r.departmentCode) ? (r.category ?? "") : "",
      hours: r.hours,
    }));

    const dayRate = (Number(d.basic_salary_sen) / 100) / (Number(d.wdpm) || 26);
    const dock = await sql`
      SELECT id, hours, note FROM payroll_hour_deductions
       WHERE worker_id = ${d.employee_id} AND date = ${date}`;
    const dockRM = dock[0]
      ? (Number(dock[0].hours) * ((Number(d.basic_salary_sen) / 100) / (Number(d.wdpm) || 26)) / (hours + 1))
      : 0;

    console.log(`  ${emp} ${d.name} ${date}  punch ${d.clock_in}–${d.clock_out}`);
    console.log(`     + ${rows.map((r) => `${r.departmentCode}${r.category ? "·" + r.category : ""} ${r.hours}h`).join(", ")}   (absence −RM ${dayRate.toFixed(2)} removed)`);
    if (dock[0]) console.log(`     − clear AUTO dock ${dock[0].hours}h ≈ RM ${dockRM.toFixed(2)}  "${dock[0].note}"`);

    if (APPLY) {
      for (const r of rows) {
        await sql`
          INSERT INTO working_hour_entries
            (id, attendance_id, worker_id, date, department_code, category, hours, notes)
          VALUES (${`whe-bp${Math.random().toString(16).slice(2, 10)}`}, ${d.attendance_id},
                  ${d.employee_id}, ${date}, ${r.departmentCode}, ${r.category}, ${r.hours}, ${NOTE})`;
      }
      if (dock[0] && String(dock[0].note ?? "").startsWith("Auto:")) {
        await sql`DELETE FROM payroll_hour_deductions WHERE id = ${dock[0].id}`;
      }
    }
  }
  console.log(APPLY
    ? `\nAPPLIED.\nUndo: DELETE FROM working_hour_entries WHERE notes = '${NOTE}';`
    : "\nDRY RUN — nothing written. Re-run with --apply.");
} finally {
  await sql.end();
}
