// READ-ONLY: MEW THU (EMP-028) 2026-07 — punches vs manually keyed working hours.
import postgres from "postgres";
const url =
  "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
const P = "2026-07";
try {
  const w = await sql`
    SELECT id, emp_no, name, department_code, status, basic_salary_sen,
           working_hours_per_day, working_days_per_month, join_date, resigned_at
      FROM workers WHERE emp_no = 'EMP-028' OR name ILIKE '%MEW THU%'`;
  console.log("=== worker ===");
  console.log(JSON.stringify(w, null, 2));
  const wid = w[0]?.id;

  const att = await sql`
    SELECT date, clock_in, clock_out, notes FROM attendance_records
     WHERE employee_id = ${wid} AND date LIKE ${P + "%"} ORDER BY date`;
  console.log("\n=== punches ===", att.length);
  console.table(att.map((r) => ({ date: r.date, in: r.clock_in, out: r.clock_out })));

  const whe = await sql`
    SELECT date, SUM(hours) AS hours, COUNT(*) AS n,
           string_agg(DISTINCT COALESCE(notes,''), ' | ') AS notes,
           MIN(created_at) AS first_created
      FROM working_hour_entries WHERE worker_id = ${wid} AND date LIKE ${P + "%"}
     GROUP BY date ORDER BY date`;
  console.log("\n=== working_hour_entries ===", whe.length, "days");
  console.table(whe.map((r) => ({ date: r.date, hours: Number(r.hours), rows: Number(r.n), notes: (r.notes || "").slice(0, 40), created: String(r.first_created).slice(0, 16) })));

  // Is the worker id used by the entries the SAME id? Check entries keyed to
  // any worker whose name matches, in case of a duplicate worker record.
  const byName = await sql`
    SELECT e.worker_id, w.emp_no, w.name, COUNT(*) AS rows, SUM(e.hours) AS hours
      FROM working_hour_entries e LEFT JOIN workers w ON w.id = e.worker_id
     WHERE e.date LIKE ${P + "%"} AND (w.name ILIKE '%MEW%' OR w.emp_no = 'EMP-028')
     GROUP BY e.worker_id, w.emp_no, w.name`;
  console.log("\n=== entries by any MEW-ish worker id ===");
  console.table(byName.map((r) => ({ worker_id: r.worker_id, emp: r.emp_no, name: r.name, rows: Number(r.rows), hours: Number(r.hours) })));

  const dup = await sql`SELECT id, emp_no, name, status FROM workers WHERE name ILIKE '%MEW%'`;
  console.log("\n=== workers named MEW* ===");
  console.table(dup);

  const phd = await sql`
    SELECT date, hours, note, source FROM payroll_hour_deductions
     WHERE worker_id = ${wid} AND date LIKE ${P + "%"} ORDER BY date`;
  console.log("\n=== docks ===");
  console.table(phd.map((r) => ({ date: r.date, hours: Number(r.hours), source: r.source, note: r.note })));

  // Whole-factory: who has logged hours in July, and how many days each.
  const all = await sql`
    SELECT w.emp_no, w.name, COUNT(DISTINCT e.date) AS days, SUM(e.hours) AS hours
      FROM working_hour_entries e JOIN workers w ON w.id = e.worker_id
     WHERE e.date LIKE ${P + "%"} GROUP BY w.emp_no, w.name ORDER BY w.emp_no`;
  console.log("\n=== July logged days per worker ===");
  console.table(all.map((r) => ({ emp: r.emp_no, name: r.name, days: Number(r.days), hours: Number(r.hours) })));
} finally {
  await sql.end();
}
