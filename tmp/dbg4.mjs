import postgres from "postgres";
const url = "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
console.log("=== the 3 same-minute punch days ===");
console.table(await sql`
  SELECT w.emp_no, w.name, a.id, a.date, a.clock_in, a.clock_out, a.notes,
         COALESCE((SELECT SUM(e.hours) FROM working_hour_entries e
                    WHERE e.worker_id=a.employee_id AND e.date=a.date),0) AS logged,
         (SELECT d.hours FROM payroll_hour_deductions d
           WHERE d.worker_id=a.employee_id AND d.date=a.date) AS dock_hours,
         (SELECT d.note FROM payroll_hour_deductions d
           WHERE d.worker_id=a.employee_id AND d.date=a.date) AS dock_note
    FROM attendance_records a JOIN workers w ON w.id=a.employee_id
   WHERE (w.emp_no,a.date) IN (('EMP-003','2026-07-01'),('EMP-018','2026-07-02'),('EMP-022','2026-07-01'))`);

console.log("=== ALL July docks on a day with ZERO logged hours (absence + dock = double) ===");
console.table(await sql`
  SELECT w.emp_no, w.name, d.date, d.hours, d.source, d.note
    FROM payroll_hour_deductions d JOIN workers w ON w.id=d.worker_id
   WHERE d.date LIKE '2026-07%'
     AND NOT EXISTS (SELECT 1 FROM working_hour_entries e
                      WHERE e.worker_id=d.worker_id AND e.date=d.date AND e.hours>0)
   ORDER BY w.emp_no, d.date`);
await sql.end();
