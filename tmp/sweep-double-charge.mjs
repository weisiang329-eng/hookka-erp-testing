// Class sweep (BUG-2026-08-01-002): every AUTO hour dock sitting on a day with
// ZERO logged hours — i.e. a day the engine already charges as a full absence.
// DRY RUN by default; --apply deletes the AUTO rows (MANUAL docks never touched).
import postgres from "postgres";
const APPLY = process.argv.includes("--apply");
const url = "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const rows = await sql`
    SELECT d.id, w.emp_no, w.name, d.date, d.hours, d.source, d.note,
           (w.basic_salary_sen/100.0) / NULLIF(COALESCE(w.working_days_per_month,26),0) AS day_rate,
           (w.basic_salary_sen/100.0) / NULLIF(COALESCE(w.working_days_per_month,26),0)
             / NULLIF(COALESCE(w.working_hours_per_day,9) + 1,0) AS hour_rate
      FROM payroll_hour_deductions d JOIN workers w ON w.id = d.worker_id
     WHERE NOT EXISTS (SELECT 1 FROM working_hour_entries e
                        WHERE e.worker_id = d.worker_id AND e.date = d.date AND e.hours > 0)
     ORDER BY d.date, w.emp_no`;
  console.log(`${rows.length} dock(s) on a zero-logged (= already absent) day\n`);
  let rm = 0;
  for (const r of rows) {
    const amt = Number(r.hours) * Number(r.hour_rate);
    rm += amt;
    console.log(`  ${r.date} ${r.emp_no} ${String(r.name).padEnd(18)} ${r.source} ${r.hours}h ≈ RM ${amt.toFixed(2)}  (day already docked RM ${Number(r.day_rate).toFixed(2)})  "${r.note}"`);
  }
  console.log(`\n  double-charged total ≈ RM ${rm.toFixed(2)}`);
  if (APPLY) {
    const auto = rows.filter((r) => r.source !== "MANUAL");
    for (const r of auto) await sql`DELETE FROM payroll_hour_deductions WHERE id = ${r.id}`;
    console.log(`\nAPPLIED — deleted ${auto.length} AUTO dock(s); ${rows.length - auto.length} MANUAL left alone.`);
  } else if (rows.length) console.log("\nDRY RUN — re-run with --apply.");
} finally { await sql.end(); }
