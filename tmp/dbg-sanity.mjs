import postgres from "postgres";
const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres",{ssl:"require",max:1,idle_timeout:5});
console.log("=== 已产生的 payslip run（有没有真的出过粮）===");
console.table(await sql`SELECT period, status, COUNT(*) AS n FROM payslips GROUP BY period,status ORDER BY period`);
console.log("=== 7 月：每人有工时的天数（该月 27 个工作日）===");
console.table(await sql`
  SELECT t.days_logged, COUNT(*) AS workers FROM (
    SELECT worker_id, COUNT(DISTINCT date) AS days_logged
      FROM working_hour_entries WHERE date LIKE '2026-07%' GROUP BY worker_id) t
   GROUP BY t.days_logged ORDER BY t.days_logged`);
console.log("=== 7 月仍有扣款的日子（抽查是否合理）===");
console.table(await sql`
  SELECT w.emp_no, w.name, COUNT(*) AS dock_days, SUM(d.hours) AS hours
    FROM payroll_hour_deductions d JOIN workers w ON w.id=d.worker_id
   WHERE d.date LIKE '2026-07%' GROUP BY w.emp_no,w.name ORDER BY SUM(d.hours) DESC LIMIT 8`);
await sql.end();
