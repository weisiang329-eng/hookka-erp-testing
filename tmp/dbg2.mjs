import postgres from "postgres";
const url = "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
console.log("attendance by date (July):");
console.table(await sql`SELECT date, COUNT(*) AS punches FROM attendance_records WHERE date LIKE '2026-07%' GROUP BY date ORDER BY date`);
console.log("last data anywhere:");
console.table(await sql`
  SELECT 'attendance' AS t, MAX(date) AS last FROM attendance_records
  UNION ALL SELECT 'working_hours', MAX(date) FROM working_hour_entries
  UNION ALL SELECT 'job_cards(completed)', MAX(completed_date) FROM job_cards`);
await sql.end();
