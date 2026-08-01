import postgres from "postgres";
const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres",{ssl:"require",max:1,idle_timeout:5});
console.log("=== 7 月 payslip 产生时间 vs 我补资料的时间 ===");
console.table(await sql`SELECT MIN(created_at) AS first, MAX(updated_at) AS last, COUNT(*) AS n FROM payslips WHERE period='2026-07'`);
console.log("我的 backfill 写入时间:");
console.table(await sql`SELECT MIN(created_at) AS first, MAX(created_at) AS last, COUNT(*) AS n
  FROM working_hour_entries WHERE notes LIKE 'Backfill:%'`);
console.log("=== 抽 3 张对比：payslip 存的 vs 现在引擎算的 ===");
console.table(await sql`
  SELECT employee_no, employee_name, absent_days, absence_deduction_sen/100.0 AS absence_rm,
         gross_pay_sen/100.0 AS gross_rm, net_pay_sen/100.0 AS net_rm, status
    FROM payslips WHERE period='2026-07' AND employee_no IN ('EMP-001','EMP-004','EMP-021','EMP-022')
   ORDER BY employee_no`);
await sql.end();
