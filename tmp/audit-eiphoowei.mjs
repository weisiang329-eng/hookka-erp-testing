// READ-ONLY audit: why is EI PHOO WEI (EMP-001) docked so much in 2026-07?
import postgres from "postgres";

const url =
  "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

const P = "2026-07";
try {
  console.log("=== worker ===");
  const w = await sql`
    SELECT id, emp_no, name, department_code, status, basic_salary_sen,
           working_hours_per_day, working_days_per_month, join_date, resigned_at, ot_multiplier
      FROM workers WHERE emp_no = 'EMP-001' OR name ILIKE '%EI PHOO WEI%'`;
  console.log(JSON.stringify(w, null, 2));
  const wid = w[0]?.id;

  console.log("\n=== attendance 2026-07 ===");
  const att = await sql`
    SELECT date, clock_in, clock_out, status, working_minutes, notes
      FROM attendance_records WHERE employee_id = ${wid} AND date LIKE ${P + "%"}
     ORDER BY date`;
  console.log(att.length, "punch rows");
  console.table(att.map((r) => ({ date: r.date, in: r.clock_in, out: r.clock_out, st: r.status, wm: r.working_minutes, notes: (r.notes || "").slice(0, 45) })));

  console.log("\n=== working_hour_entries 2026-07 (per day) ===");
  const whe = await sql`
    SELECT date, SUM(hours) AS hours, COUNT(*) AS n, string_agg(DISTINCT notes, ' | ') AS notes
      FROM working_hour_entries WHERE worker_id = ${wid} AND date LIKE ${P + "%"}
     GROUP BY date ORDER BY date`;
  console.log(whe.length, "days logged");
  console.table(whe.map((r) => ({ date: r.date, hours: Number(r.hours), rows: Number(r.n), notes: (r.notes || "").slice(0, 45) })));

  console.log("\n=== payroll_hour_deductions 2026-07 ===");
  const phd = await sql`
    SELECT date, hours, note, source FROM payroll_hour_deductions
     WHERE worker_id = ${wid} AND date LIKE ${P + "%"} ORDER BY date`;
  console.table(phd.map((r) => ({ date: r.date, hours: Number(r.hours), source: r.source, note: r.note })));

  console.log("\n=== public holidays (July) ===");
  const ph = await sql`SELECT value FROM kv_config WHERE key = 'public_holidays'`;
  const list = (() => { try { return JSON.parse(ph[0]?.value ?? "[]"); } catch { return []; } })();
  console.log(list.filter((d) => String(d).startsWith(P)));

  console.log("\n=== saved payslip row 2026-07 ===");
  const ps = await sql`
    SELECT employee_no, employee_name, basic_salary_sen, working_days, absent_days,
           absence_deduction_sen, total_ot_sen, allowances_sen, gross_pay_sen, net_pay_sen, status
      FROM payslips WHERE period = ${P} AND employee_no = 'EMP-001'`;
  console.log(JSON.stringify(ps, null, 2));

  console.log("\n=== factory-wide July: punches vs logged hours ===");
  const wide = await sql`
    SELECT (SELECT COUNT(*) FROM attendance_records WHERE date LIKE ${P + "%"}) AS punch_rows,
           (SELECT COUNT(*) FROM attendance_records WHERE date LIKE ${P + "%"} AND clock_out IS NULL) AS no_clockout,
           (SELECT COUNT(*) FROM attendance_records WHERE date LIKE ${P + "%"} AND notes ILIKE '%Forgot to punch out%') AS auto_closed,
           (SELECT COUNT(*) FROM working_hour_entries WHERE date LIKE ${P + "%"}) AS whe_rows,
           (SELECT COUNT(*) FROM payroll_hour_deductions WHERE date LIKE ${P + "%"}) AS docks`;
  console.log(wide[0]);

  console.log("\n=== July: punched days that logged NO working hours (whole factory) ===");
  const orphan = await sql`
    SELECT a.date, w.emp_no, w.name, a.clock_in, a.clock_out, a.notes
      FROM attendance_records a
      JOIN workers w ON w.id = a.employee_id
     WHERE a.date LIKE ${P + "%"} AND a.clock_in IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM working_hour_entries e
          WHERE e.worker_id = a.employee_id AND e.date = a.date AND e.hours > 0)
     ORDER BY w.emp_no, a.date`;
  console.log(orphan.length, "punched-but-no-hours worker-days");
  console.table(orphan.slice(0, 40).map((r) => ({ date: r.date, emp: r.emp_no, name: r.name, in: r.clock_in, out: r.clock_out, notes: (r.notes || "").slice(0, 40) })));
} finally {
  await sql.end();
}
