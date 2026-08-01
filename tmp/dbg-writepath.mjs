import postgres from "postgres";
const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres",{ssl:"require",max:1,idle_timeout:5});
console.log("=== 所有 Forgot-to-punch-out 的日子，现在有没有工时 ===");
console.table(await sql`
  SELECT a.date, w.emp_no, w.name, a.clock_in,
         COALESCE((SELECT SUM(e.hours) FROM working_hour_entries e
                    WHERE e.worker_id=a.employee_id AND e.date=a.date),0) AS hours
    FROM attendance_records a JOIN workers w ON w.id=a.employee_id
   WHERE a.notes ILIKE '%Forgot to punch out%' ORDER BY a.date DESC LIMIT 12`);
console.log("=== 还有 0 工时的漏打卡日吗（应为 0 笔）===");
const bad = await sql`
  SELECT COUNT(*)::int AS n FROM attendance_records a
   WHERE a.notes ILIKE '%Forgot to punch out%'
     AND NOT EXISTS (SELECT 1 FROM working_hour_entries e
                      WHERE e.worker_id=a.employee_id AND e.date=a.date AND e.hours>0)`;
console.log("  ", bad[0].n, "笔");
console.log("=== 今天还开着的打卡（今晚 00:30 cron 会用新程式关掉）===");
console.table(await sql`
  SELECT w.emp_no, w.name, a.date, a.clock_in, a.clock_out
    FROM attendance_records a JOIN workers w ON w.id=a.employee_id
   WHERE a.clock_in IS NOT NULL AND a.clock_out IS NULL ORDER BY a.date DESC LIMIT 6`);
await sql.end();
