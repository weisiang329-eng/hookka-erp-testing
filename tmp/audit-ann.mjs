// READ-ONLY: ANN (EMP-004) July 2026 — punches, hours, duplicates.
import postgres from "postgres";
const url =
  "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
try {
  console.log("=== workers named ANN ===");
  console.table(await sql`
    SELECT id, emp_no, name, department_code, status, basic_salary_sen,
           working_hours_per_day, join_date
      FROM workers WHERE name ILIKE '%ANN%' OR emp_no = 'EMP-004'`);

  console.log("=== ANN July punches ===");
  console.table(await sql`
    SELECT a.date, a.clock_in, a.clock_out, a.employee_id, a.notes
      FROM attendance_records a JOIN workers w ON w.id = a.employee_id
     WHERE w.emp_no = 'EMP-004' AND a.date LIKE '2026-07%' ORDER BY a.date`);

  console.log("=== ANN working hours by month ===");
  console.table(await sql`
    SELECT LEFT(e.date, 7) AS month, COUNT(DISTINCT e.date) AS days, SUM(e.hours) AS hours
      FROM working_hour_entries e JOIN workers w ON w.id = e.worker_id
     WHERE w.emp_no = 'EMP-004' GROUP BY 1 ORDER BY 1`);

  console.log("=== ANN July docks ===");
  console.table(await sql`
    SELECT d.date, d.hours, d.source, d.note FROM payroll_hour_deductions d
      JOIN workers w ON w.id = d.worker_id
     WHERE w.emp_no = 'EMP-004' AND d.date LIKE '2026-07%' ORDER BY d.date`);

  console.log("=== orphan working_hour_entries (worker_id not in workers), July ===");
  console.table(await sql`
    SELECT e.worker_id, COUNT(*) AS rows FROM working_hour_entries e
     WHERE e.date LIKE '2026-07%' AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.id = e.worker_id)
     GROUP BY 1`);
} finally {
  await sql.end();
}
