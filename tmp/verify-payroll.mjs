// Full-month payroll verification, run through the REAL engine against prod.
// Mirrors GET /api/payslips/projected exactly (same queries, same helpers) and
// additionally prints/exports the DEDUCTION DETAIL: which days were absent,
// which days were docked and why, and the arithmetic behind every figure.
//
//   node --import tsx/esm tmp/verify-payroll.mjs 2026-07 [out.csv]
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { SupabaseAdapter } from "../src/api/lib/supabase-compat.ts";
import {
  computeMonthlyLabor,
  computeAttendanceDayDetail,
  absenceCutoffDay,
  effectiveSalarySenForMonth,
} from "../src/lib/labor-engine.ts";
import {
  computeMonthlyEfficiencyByWorker,
  resolveEfficiencyAllowanceSen,
  monthBounds,
} from "../src/api/lib/efficiency-allowance.ts";
import { resolvePayRulesAsOf } from "../src/lib/pay-rules.ts";
import { loadPayRuleVersions } from "../src/api/lib/pay-rules-store.ts";
import { calcStatutory } from "../src/api/routes/payslips.ts";

const period = process.argv[2] || "2026-07";
const outPath = process.argv[3] || `tmp/payroll-${period}-verified.csv`;
const url =
  "postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres";
// Same client config as src/api/lib/db-pg.ts getSql() — in particular the
// snake_case → camelCase column transform, without which every camelCase read
// in the route code silently reads undefined. (ssl relaxed to `require` because
// `verify-full` can't validate Supabase's chain from this machine; read-only.)
const renameMap = (await import("../src/api/lib/column-rename-map.json", { with: { type: "json" } })).default;
const snakeToCamel = Object.fromEntries(Object.entries(renameMap).map(([c, s]) => [s, c]));
const DB = new SupabaseAdapter(
  postgres(url, {
    ssl: "require", max: 1, idle_timeout: 5, prepare: false, fetch_types: false,
    types: { bigint: { to: 20, from: [20], parse: (x) => Number(x), serialize: (x) => String(x) } },
    transform: { column: { from: (col) => snakeToCamel[col] ?? postgres.toCamel(col) } },
  }),
);
const rm = (sen) => (sen / 100).toFixed(2);

const wres = await DB.prepare(
  "SELECT id, empNo, name, departmentCode, status, basicSalarySen, workingDaysPerMonth, workingHoursPerDay, otMultiplier, epfEnabled, socsoEnabled, eisEnabled, pcbEnabled, resignedAt, joinDate, efficiencyAllowanceSen, efficiencyThresholdPct FROM workers WHERE (status = 'ACTIVE' OR (status = 'RESIGNED' AND resignedAt LIKE ?)) AND empNo NOT LIKE 'TEST%'",
).bind(`${period}-%`).all();
const activeWorkers = wres.results ?? [];

const phRow = await DB.prepare("SELECT value FROM kv_config WHERE key = ?")
  .bind("public_holidays").first();
const publicHolidays = new Set();
try {
  for (const d of JSON.parse(phRow?.value ?? "[]"))
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) publicHolidays.add(d);
} catch { /* none */ }

const wheRes = await DB.prepare(
  "SELECT workerId, date, hours, notes FROM working_hour_entries WHERE date LIKE ?",
).bind(`${period}-%`).all();
const daysByWorker = new Map();
const notesByKey = new Map();
for (const r of wheRes.results ?? []) {
  const arr = daysByWorker.get(r.workerId) ?? [];
  arr.push({ date: r.date, hours: Number(r.hours) || 0 });
  daysByWorker.set(r.workerId, arr);
  const k = `${r.workerId}|${r.date}`;
  notesByKey.set(k, `${notesByKey.get(k) ?? ""}${r.notes ?? ""}`);
}

const deductionHoursByWorker = new Map();
const deductionDaysByWorker = new Map();
const dedRes = await DB.prepare(
  "SELECT workerId, date, hours, note, source FROM payroll_hour_deductions WHERE date LIKE ? ORDER BY date",
).bind(`${period}-%`).all();
for (const r of dedRes.results ?? []) {
  const h = Number(r.hours) || 0;
  deductionHoursByWorker.set(r.workerId, (deductionHoursByWorker.get(r.workerId) ?? 0) + h);
  if (h > 0) {
    const arr = deductionDaysByWorker.get(r.workerId) ?? [];
    arr.push({ date: r.date, hours: Math.round(h * 100) / 100, note: r.note, source: r.source });
    deductionDaysByWorker.set(r.workerId, arr);
  }
}

// Punches, to flag "came to work but the day has no hours" anomalies.
const punchRes = await DB.prepare(
  "SELECT employeeId, date, clockIn, clockOut, notes FROM attendance_records WHERE date LIKE ?",
).bind(`${period}-%`).all();
const punchByKey = new Map();
for (const p of punchRes.results ?? [])
  punchByKey.set(`${p.employeeId}|${p.date}`, p);

const [prY, prM] = period.split("-").map(Number);
const periodEndYmd = `${period}-${String(new Date(prY, prM, 0).getDate()).padStart(2, "0")}`;
const payRuleVersions = await loadPayRuleVersions(DB);
const statutoryRules = resolvePayRulesAsOf(payRuleVersions, periodEndYmd);

const salaryHistoryByWorker = new Map();
try {
  const wsh = await DB.prepare(
    "SELECT workerId, basicSalarySen, effectiveFrom FROM worker_salary_history",
  ).all();
  for (const r of wsh.results ?? []) {
    const arr = salaryHistoryByWorker.get(r.workerId) ?? [];
    arr.push({ effectiveFrom: r.effectiveFrom, basicSalarySen: Number(r.basicSalarySen) || 0 });
    salaryHistoryByWorker.set(r.workerId, arr);
  }
} catch { /* none */ }

const today = new Date();
const absenceThroughDay = absenceCutoffDay(
  prY, prM, today, statutoryRules.absenceGraceWorkingDays, publicHolidays);
const periodLastIso = periodEndYmd;
const effBounds = monthBounds(period);
const effByWorker = await computeMonthlyEfficiencyByWorker(DB, effBounds.start, effBounds.end);

console.log(`Period ${period} · absence counted through day ${absenceThroughDay} ` +
  `(grace ${statutoryRules.absenceGraceWorkingDays} working days) · ` +
  `public holidays: ${[...publicHolidays].filter((d) => d.startsWith(period)).join(", ") || "none"}\n`);

const rows = [];
const anomalies = [];
for (const worker of activeWorkers) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(worker.joinDate ?? "") && worker.joinDate > periodLastIso) continue;
  const joinedDay = String(worker.joinDate ?? "").startsWith(`${period}-`)
    ? Number(worker.joinDate.slice(8, 10)) : undefined;
  const resignedDay = worker.status === "RESIGNED" && String(worker.resignedAt ?? "").startsWith(`${period}-`)
    ? Number(worker.resignedAt.slice(8, 10)) : undefined;
  const effectiveSalarySen = effectiveSalarySenForMonth(
    salaryHistoryByWorker.get(worker.id) ?? [], worker.basicSalarySen, prY, prM, publicHolidays);
  const input = {
    worker: {
      basicSalarySen: effectiveSalarySen,
      workingDaysPerMonth: worker.workingDaysPerMonth,
      workingHoursPerDay: worker.workingHoursPerDay,
      otMultiplier: worker.otMultiplier,
    },
    year: prY, month: prM,
    days: daysByWorker.get(worker.id) ?? [],
    publicHolidays,
    absenceThroughDay,
    employmentStartDay: joinedDay,
    employmentEndDay: resignedDay,
    prorateToService: joinedDay !== undefined || resignedDay !== undefined,
    shortHourDeductionHours: deductionHoursByWorker.get(worker.id) ?? 0,
    payRuleVersions,
  };
  const labor = computeMonthlyLabor(input);
  const detail = computeAttendanceDayDetail(input);
  const allowances = resolveEfficiencyAllowanceSen(
    effByWorker.get(worker.id), worker.efficiencyAllowanceSen, worker.efficiencyThresholdPct);
  const stat = calcStatutory(effectiveSalarySen, worker, statutoryRules);
  const grossPay = labor.payroll.grossSen + allowances;
  const totalDeductions = stat.epfEmployee + stat.socsoEmployee + stat.eisEmployee + stat.pcb;
  const dayRate = labor.payrollDailyRateSen;
  const shortHours = deductionHoursByWorker.get(worker.id) ?? 0;
  const shortRate = labor.payroll.shortHourDeductionSen && shortHours
    ? labor.payroll.shortHourDeductionSen / shortHours : 0;
  const docks = deductionDaysByWorker.get(worker.id) ?? [];

  // ANOMALY: an absent date the worker actually punched for = evidence the day
  // was worked but no hours were logged. This is what BUG-2026-08-01-001 was.
  for (const d of detail.absentDates) {
    const p = punchByKey.get(`${worker.id}|${d}`);
    if (p?.clockIn)
      anomalies.push(`${worker.empNo} ${worker.name}: ${d} counted ABSENT (−RM ${rm(dayRate)}) but has a punch ${p.clockIn}–${p.clockOut ?? "?"}`);
  }

  rows.push({
    empNo: worker.empNo, name: worker.name, dept: worker.departmentCode ?? "",
    basic: effectiveSalarySen,
    workingDays: worker.workingDaysPerMonth,
    daysWorked: labor.daysWorked,
    dayRate,
    absentDays: labor.payroll.absentDays,
    absenceDeduction: labor.payroll.absenceDeductionSen,
    absenceFormula: labor.payroll.absentDays > 0
      ? `${rm(effectiveSalarySen)} ÷ ${worker.workingDaysPerMonth} × ${labor.payroll.absentDays} = ${rm(labor.payroll.absenceDeductionSen)}`
      : "",
    absentDates: detail.absentDates.join(" "),
    shortHours: Math.round(shortHours * 100) / 100,
    shortDeduction: labor.payroll.shortHourDeductionSen,
    shortFormula: shortHours > 0
      ? `${Math.round(shortHours * 100) / 100}h × ${rm(shortRate)}/h = ${rm(labor.payroll.shortHourDeductionSen)}`
      : "",
    shortDays: docks.map((d) => `${d.date.slice(5)} ${d.hours}h${d.source === "MANUAL" ? " (manual)" : ""}`).join("; "),
    basicEarned: labor.payroll.basicEarnedSen,
    otWkH: labor.otWeekdayHours, otSunH: labor.otSundayHours, otPhH: labor.otHolidayHours,
    otPay: labor.payroll.otPaySen,
    otDays: detail.otDays.map((d) => `${d.date.slice(5)} ${d.hours}h`).join("; "),
    allowances, grossPay,
    epfEE: stat.epfEmployee, epfER: stat.epfEmployer,
    socsoEE: stat.socsoEmployee, socsoER: stat.socsoEmployer,
    eisEE: stat.eisEmployee, eisER: stat.eisEmployer, pcb: stat.pcb,
    totalDeductions, netPay: grossPay - totalDeductions,
  });
}

rows.sort((a, b) => a.empNo.localeCompare(b.empNo));
console.log("=== pay side ===");
for (const r of rows) {
  console.log(
    `${r.empNo.padEnd(9)} ${r.name.padEnd(18)} basic ${rm(r.basic).padStart(8)}` +
    `  worked ${String(r.daysWorked).padStart(2)}d  absent ${String(r.absentDays).padStart(2)}d −${rm(r.absenceDeduction).padStart(8)}` +
    `  short ${String(r.shortHours).padStart(5)}h −${rm(r.shortDeduction).padStart(7)}` +
    `  OT +${rm(r.otPay).padStart(7)}  gross ${rm(r.grossPay).padStart(8)}  net ${rm(r.netPay).padStart(8)}`,
  );
}

console.log(`\n=== anomalies (punched but counted absent) ===`);
if (anomalies.length === 0) console.log("  none ✓");
else for (const a of anomalies) console.log("  ⚠ " + a);

// Arithmetic self-check: every row must reconcile to the cent.
console.log("\n=== reconciliation check ===");
let bad = 0;
for (const r of rows) {
  const expect = Math.max(0, Math.max(0, r.basic - r.absenceDeduction) - r.shortDeduction);
  if (expect !== r.basicEarned) { console.log(`  ✗ ${r.empNo} basicEarned ${r.basicEarned} ≠ ${expect}`); bad++; }
  if (r.basicEarned + r.otPay + r.allowances !== r.grossPay) { console.log(`  ✗ ${r.empNo} gross mismatch`); bad++; }
  if (r.grossPay - r.totalDeductions !== r.netPay) { console.log(`  ✗ ${r.empNo} net mismatch`); bad++; }
}
console.log(bad === 0 ? `  all ${rows.length} rows reconcile ✓` : `  ${bad} problems`);

const H = [
  "Employee No", "Employee Name", "Department", "Basic Salary", "Working Days",
  "Days Worked", "Day Rate", "Absent Days", "Absence Deduction", "Absence Formula",
  "Absent Dates", "Short Hours", "Short Hour Deduction", "Short Hour Formula",
  "Short Hour Days", "Basic Earned", "OT Weekday Hrs", "OT Sunday Hrs", "OT PH Hrs",
  "Total OT", "OT Days", "Allowances", "Gross Pay", "EPF EE", "EPF ER", "SOCSO EE",
  "SOCSO ER", "EIS EE", "EIS ER", "PCB", "Total Deductions", "Net Pay",
];
const esc = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = [H.join(",")].concat(rows.map((r) => [
  r.empNo, r.name, r.dept, rm(r.basic), r.workingDays, r.daysWorked, rm(r.dayRate),
  r.absentDays, rm(r.absenceDeduction), r.absenceFormula, r.absentDates,
  r.shortHours, rm(r.shortDeduction), r.shortFormula, r.shortDays,
  rm(r.basicEarned), r.otWkH, r.otSunH, r.otPhH, rm(r.otPay), r.otDays,
  rm(r.allowances), rm(r.grossPay), rm(r.epfEE), rm(r.epfER), rm(r.socsoEE),
  rm(r.socsoER), rm(r.eisEE), rm(r.eisER), rm(r.pcb), rm(r.totalDeductions), rm(r.netPay),
].map(esc).join(","))).join("\n");
writeFileSync(outPath, csv);
console.log(`\nWrote ${outPath} (${rows.length} rows)`);
process.exit(0);
