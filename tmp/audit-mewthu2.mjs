// READ-ONLY: any MEW THU data at all, any month? Plus July absence math check.
import postgres from "postgres";
const url =
  "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
const WID = "worker-142e3aaa"; // MEW THU
try {
  console.log("=== MEW THU: working hours by month (all time) ===");
  console.table(await sql`
    SELECT LEFT(date, 7) AS month, COUNT(DISTINCT date) AS days, SUM(hours) AS hours
      FROM working_hour_entries WHERE worker_id = ${WID}
     GROUP BY 1 ORDER BY 1`);

  console.log("=== MEW THU: punches by month (all time) ===");
  console.table(await sql`
    SELECT LEFT(date, 7) AS month, COUNT(*) AS rows
      FROM attendance_records WHERE employee_id = ${WID} GROUP BY 1 ORDER BY 1`);

  console.log("=== MEW THU: docks by month ===");
  console.table(await sql`
    SELECT LEFT(date, 7) AS month, COUNT(*) AS rows, SUM(hours) AS hours
      FROM payroll_hour_deductions WHERE worker_id = ${WID} GROUP BY 1 ORDER BY 1`);

  console.log("=== whole DB: working_hour_entries by month ===");
  console.table(await sql`
    SELECT LEFT(date, 7) AS month, COUNT(*) AS rows, COUNT(DISTINCT worker_id) AS workers
      FROM working_hour_entries GROUP BY 1 ORDER BY 1`);

  console.log("=== July 2026 saved payslip runs ===");
  console.table(await sql`
    SELECT period, status, COUNT(*) AS rows FROM payslips GROUP BY period, status ORDER BY period`);

  console.log("=== EMP-001 July: latest 3 working-hour rows with timestamps ===");
  console.table(await sql`
    SELECT date, department_code, category, hours, notes, created_at
      FROM working_hour_entries WHERE worker_id = 'worker-b311d39e' AND date LIKE '2026-07%'
     ORDER BY date`);
} finally {
  await sql.end();
}
