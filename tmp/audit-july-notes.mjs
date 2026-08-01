// READ-ONLY: July 2026 — are ANY working hours keyed by hand (vs auto-from-punch)?
import postgres from "postgres";
const url =
  "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
try {
  console.log("=== July 2026 working_hour_entries by note kind ===");
  console.table(await sql`
    SELECT CASE
             WHEN notes IS NULL OR notes = '' THEN '(blank = keyed by office)'
             WHEN notes LIKE 'Auto from punch%' THEN 'Auto from punch'
             ELSE notes END AS kind,
           COUNT(*) AS rows, SUM(hours) AS hours
      FROM working_hour_entries WHERE date LIKE '2026-07%'
     GROUP BY 1 ORDER BY rows DESC`);

  console.log("=== same, June 2026 (for comparison) ===");
  console.table(await sql`
    SELECT CASE
             WHEN notes IS NULL OR notes = '' THEN '(blank = keyed by office)'
             WHEN notes LIKE 'Auto from punch%' THEN 'Auto from punch'
             ELSE notes END AS kind,
           COUNT(*) AS rows, SUM(hours) AS hours
      FROM working_hour_entries WHERE date LIKE '2026-06%'
     GROUP BY 1 ORDER BY rows DESC`);

  console.log("=== July: forgot-to-punch-out days, and whether hours got logged ===");
  console.table(await sql`
    SELECT w.emp_no, w.name, a.date, a.clock_in, a.clock_out,
           COALESCE((SELECT SUM(e.hours) FROM working_hour_entries e
                      WHERE e.worker_id = a.employee_id AND e.date = a.date), 0) AS logged_hours
      FROM attendance_records a JOIN workers w ON w.id = a.employee_id
     WHERE a.date LIKE '2026-07%' AND a.notes ILIKE '%Forgot to punch out%'
     ORDER BY w.emp_no, a.date`);
} finally {
  await sql.end();
}
