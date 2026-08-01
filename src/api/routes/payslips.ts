// ---------------------------------------------------------------------------
// D1-backed payslips route.
//
// Mirrors the old src/api/routes/payslips.ts shape. Malaysian statutory
// deductions (EPF / SOCSO / EIS / PCB) are computed at run-time using the
// helpers below.
//
//   GET  /api/payslips?period=&employeeId=   → list
//   GET  /api/payslips/:id                    → detail with YTD summary
//   POST /api/payslips                        → generate run for ACTIVE workers
//   PUT  /api/payslips                        → bulk status update for period
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  computeMonthlyLabor,
  computeAttendanceDayDetail,
  absenceCutoffDay,
  effectiveSalarySenForMonth,
  type AttendanceDayDetail,
} from "../../lib/labor-engine";
import {
  computeMonthlyEfficiencyByWorker,
  resolveEfficiencyAllowanceSen,
  monthBounds,
} from "../lib/efficiency-allowance";
import {
  DEFAULT_PAY_RULES,
  resolvePayRulesAsOf,
  type PayRulesConfig,
} from "../../lib/pay-rules";
import { loadPayRuleVersions } from "../lib/pay-rules-store";

// Data-entry grace before an unrecorded working day is treated as a confirmed
// absence. Spec (Wei Siang, 2026-06-02): the office keys Working Hours a few
// days late, so the most recent working days with no hours are "maybe just not
// entered yet" — only count a day as absent once it is this many working days
// in the past. Finished months are unaffected (the whole month is past grace).
// (The 2-working-day absence grace now lives in the effective-dated pay rules
// — absenceGraceWorkingDays — resolved per period below.)

const app = new Hono<Env>();

type WorkerRow = {
  id: string;
  empNo: string;
  name: string;
  departmentCode: string | null;
  status: string;
  basicSalarySen: number;
  workingDaysPerMonth: number;
  workingHoursPerDay: number;
  otMultiplier: number;
  // Per-worker statutory toggles (migration 0131). NULL/undefined falls
  // back to true downstream so legacy rows keep their pre-toggle behaviour.
  epfEnabled: boolean | null;
  socsoEnabled: boolean | null;
  eisEnabled: boolean | null;
  pcbEnabled: boolean | null;
  // YYYY-MM-DD last day of employment, or null for current staff (migration
  // 0143). Used only to scope which month a RESIGNED worker is still paid for.
  resignedAt: string | null;
  // YYYY-MM-DD join date, or null. Days before it aren't worked/absent, and a
  // worker who joined in a later month is excluded from this period entirely.
  joinDate: string | null;
  // Per-worker efficiency bonus config (migration 0151). Flat bonus (sen) paid
  // when month-cumulative efficiency reaches the threshold %. Default 0 / 0 on
  // legacy rows ⇒ no bonus.
  efficiencyAllowanceSen?: number | null;
  efficiencyThresholdPct?: number | null;
};

type PayslipRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  departmentCode: string;
  period: string;
  basicSalarySen: number;
  workingDays: number;
  absentDays: number;
  absenceDeductionSen: number;
  otWeekdayHours: number;
  otSundayHours: number;
  otPhHours: number;
  hourlyRateSen: number;
  otWeekdayAmtSen: number;
  otSundayAmtSen: number;
  otPhAmtSen: number;
  totalOtSen: number;
  allowancesSen: number;
  grossPaySen: number;
  epfEmployeeSen: number;
  epfEmployerSen: number;
  socsoEmployeeSen: number;
  socsoEmployerSen: number;
  eisEmployeeSen: number;
  eisEmployerSen: number;
  pcbSen: number;
  totalDeductionsSen: number;
  netPaySen: number;
  bankAccount: string;
  payrollRunId: string | null;
  status: "DRAFT" | "APPROVED" | "PAID";
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Row mapper — preserves legacy shape (no *Sen suffix on most numeric fields)
// ---------------------------------------------------------------------------
function rowToPayslip(r: PayslipRow) {
  return {
    id: r.id,
    employeeId: r.employeeId,
    employeeName: r.employeeName,
    employeeNo: r.employeeNo,
    departmentCode: r.departmentCode,
    period: r.period,
    basicSalary: r.basicSalarySen,
    workingDays: r.workingDays,
    absentDays: r.absentDays,
    absenceDeductionSen: r.absenceDeductionSen,
    otWeekdayHours: r.otWeekdayHours,
    otSundayHours: r.otSundayHours,
    otPHHours: r.otPhHours,
    hourlyRate: r.hourlyRateSen,
    otWeekdayAmount: r.otWeekdayAmtSen,
    otSundayAmount: r.otSundayAmtSen,
    otPHAmount: r.otPhAmtSen,
    totalOT: r.totalOtSen,
    allowances: r.allowancesSen,
    grossPay: r.grossPaySen,
    epfEmployee: r.epfEmployeeSen,
    epfEmployer: r.epfEmployerSen,
    socsoEmployee: r.socsoEmployeeSen,
    socsoEmployer: r.socsoEmployerSen,
    eisEmployee: r.eisEmployeeSen,
    eisEmployer: r.eisEmployerSen,
    pcb: r.pcbSen,
    totalDeductions: r.totalDeductionsSen,
    netPay: r.netPaySen,
    bankAccount: r.bankAccount,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// A payslip row plus the additive per-day absence/OT detail. The day fields are
// display-only (no amounts) and are attached by the GET list + projected paths
// so the Payroll row's expanded layer can show WHICH days were absent / had OT.
type PayslipWithDayDetail = ReturnType<typeof rowToPayslip> &
  AttendanceDayDetail & {
    // Late / short-hours dock — amount + the specific days. Projected path only
    // (mirrors worker My Pay); the office Payroll row itemises it when present.
    shortHourDeductionSen?: number;
    lateDays?: Array<{ date: string; hours: number }>;
  };

// ---------------------------------------------------------------------------
// Malaysian statutory helpers
// ---------------------------------------------------------------------------
// Worker-level toggle flags. NULL/undefined defaults to TRUE so legacy
// workers (and the mock-data path) keep the current behaviour. A FALSE
// flag zeroes the matching line in the result — when all four are false
// the worker's deductions total 0 and Net Pay equals Gross Pay.
type StatutoryFlags = {
  epfEnabled?: boolean | null;
  socsoEnabled?: boolean | null;
  eisEnabled?: boolean | null;
  pcbEnabled?: boolean | null;
};

export function calcStatutory(
  basicSalarySen: number,
  flags: StatutoryFlags = {},
  // Effective-dated statutory rates (owner 2026-06-11) — resolved as of the
  // period's last day; defaults reproduce the previously-hardcoded figures.
  rates: PayRulesConfig = DEFAULT_PAY_RULES,
) {
  const epfOn = flags.epfEnabled !== false;
  const socsoOn = flags.socsoEnabled !== false;
  const eisOn = flags.eisEnabled !== false;
  const pcbOn = flags.pcbEnabled !== false;
  return {
    epfEmployee: epfOn ? Math.round((basicSalarySen * rates.epfEmployeePct) / 100) : 0,
    epfEmployer: epfOn ? Math.round((basicSalarySen * rates.epfEmployerPct) / 100) : 0,
    socsoEmployee: socsoOn ? rates.socsoEmployeeSen : 0,
    socsoEmployer: socsoOn ? rates.socsoEmployerSen : 0,
    eisEmployee: eisOn ? rates.eisEmployeeSen : 0,
    eisEmployer: eisOn ? rates.eisEmployerSen : 0,
    pcb: pcbOn ? 0 : 0, // PCB still 0 baseline; flag is forward-compat for when PCB calc lands.
  };
}

// PS-YYMM-NNN sequential, bucketed by payslip period. Bug fix 2026-04-28:
// previous PS-NNNNN format was a global counter without month context.
// Now derives YYMM from the `period` (YYYY-MM) so all rows for a given
// run share the same prefix and number monotonically inside it. Falls
// back to the current month if the period is malformed.
async function nextPayslipId(
  db: D1Database,
  period: string,
): Promise<string> {
  let yymm: string;
  const m = /^(\d{4})-(\d{2})$/.exec(period ?? "");
  if (m) {
    yymm = `${m[1].slice(2)}${m[2]}`;
  } else {
    const now = new Date();
    yymm = `${String(now.getFullYear()).slice(2)}${String(
      now.getMonth() + 1,
    ).padStart(2, "0")}`;
  }
  const prefix = `PS-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT id FROM payslips WHERE id LIKE ? ORDER BY id DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ id: string }>();
  if (!res) return `${prefix}001`;
  const tail = res.id.replace(prefix, "");
  const seq = parseInt(tail, 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

// Per-period per-day absence/OT detail for a set of workers, computed from the
// SAME working_hour_entries + public holidays + grace-cutoff the engine uses.
// Display-only (no amounts) — lets the stored-payslips list carry the same
// per-day detail the projected estimate does, so the Payroll row's expanded
// layer shows WHICH days were absent / had OT regardless of generated state.
// `period` is YYYY-MM. Returns a map keyed by workerId.
async function buildDayDetailForPeriod(
  db: D1Database,
  period: string,
  workerIds: string[],
): Promise<Map<string, AttendanceDayDetail>> {
  const out = new Map<string, AttendanceDayDetail>();
  if (!/^\d{4}-\d{2}$/.test(period) || workerIds.length === 0) return out;
  const [pYear, pMonth] = period.split("-").map(Number);

  // Worker config (hours/day, join/resign) for the workers in the result.
  const placeholders = workerIds.map(() => "?").join(", ");
  const wres = await db
    .prepare(
      `SELECT id, status, workingHoursPerDay, resignedAt, joinDate FROM workers WHERE id IN (${placeholders})`,
    )
    .bind(...workerIds)
    .all<{
      id: string;
      status: string;
      workingHoursPerDay: number;
      resignedAt: string | null;
      joinDate: string | null;
    }>();
  const workerById = new Map((wres.results ?? []).map((w) => [w.id, w] as const));

  // Public holidays — same kv_config source the engine reads.
  const phRow = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("public_holidays")
    .first<{ value: string | null }>();
  const publicHolidays = new Set<string>();
  if (phRow?.value) {
    try {
      const parsed = JSON.parse(phRow.value);
      if (Array.isArray(parsed)) {
        for (const d of parsed) {
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) publicHolidays.add(d);
        }
      }
    } catch { /* malformed — no holidays */ }
  }

  // Working Hours rows for the period, grouped per worker.
  const wheRes = await db
    .prepare("SELECT workerId, date, hours FROM working_hour_entries WHERE date LIKE ?")
    .bind(`${period}-%`)
    .all<{ workerId: string; date: string; hours: number }>();
  const daysByWorker = new Map<string, { date: string; hours: number }[]>();
  for (const r of wheRes.results ?? []) {
    const arr = daysByWorker.get(r.workerId) ?? [];
    arr.push({ date: r.date, hours: Number(r.hours) || 0 });
    daysByWorker.set(r.workerId, arr);
  }

  // Effective-dated grace — resolved as of the period's last day so the
  // day-detail chips match the engine paths exactly.
  const dayDetailGrace = resolvePayRulesAsOf(
    await loadPayRuleVersions(db),
    `${period}-${String(new Date(pYear, pMonth, 0).getDate()).padStart(2, "0")}`,
  ).absenceGraceWorkingDays;
  const absenceThroughDay = absenceCutoffDay(
    pYear,
    pMonth,
    new Date(),
    dayDetailGrace,
    publicHolidays,
  );

  for (const workerId of workerIds) {
    const w = workerById.get(workerId);
    const joinedDay =
      typeof w?.joinDate === "string" && w.joinDate.startsWith(`${period}-`)
        ? Number(w.joinDate.slice(8, 10))
        : undefined;
    const resignedDay =
      w?.status === "RESIGNED" &&
      typeof w?.resignedAt === "string" &&
      w.resignedAt.startsWith(`${period}-`)
        ? Number(w.resignedAt.slice(8, 10))
        : undefined;
    out.set(
      workerId,
      computeAttendanceDayDetail({
        worker: { workingHoursPerDay: w?.workingHoursPerDay ?? 0 },
        year: pYear,
        month: pMonth,
        days: daysByWorker.get(workerId) ?? [],
        publicHolidays,
        absenceThroughDay,
        employmentStartDay: joinedDay,
        employmentEndDay: resignedDay,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET /api/payslips?period=&employeeId=
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — payslips:read.
  const denied = await requirePermission(c, "payslips", "read");
  if (denied) return denied;
  const period = c.req.query("period");
  const employeeId = c.req.query("employeeId");

  // Sprint 4: leading orgId predicate.
  const orgId = getOrgId(c);
  const clauses: string[] = ["orgId = ?"];
  const binds: (string | number)[] = [orgId];
  if (period) {
    clauses.push("period = ?");
    binds.push(period);
  }
  if (employeeId) {
    clauses.push("employeeId = ?");
    binds.push(employeeId);
  } else {
    // Payroll / Labor Cost admin lists exclude TEST accounts (e.g. TEST-001,
    // TEST-002) — they are not real payees, so they must not inflate the active
    // worker count or the payroll totals (owner 2026-07-04). Single-worker
    // lookups (employeeId set, e.g. the worker portal) are unaffected.
    clauses.push("employeeNo NOT LIKE 'TEST%'");
  }
  const sql = `SELECT * FROM payslips WHERE ${clauses.join(" AND ")} ORDER BY period DESC, employeeNo`;
  const res = await c.var.DB.prepare(sql).bind(...binds).all<PayslipRow>();
  const rows = (res.results ?? []).map(rowToPayslip);

  // When scoped to a single period (the Payroll screen always is), enrich each
  // row with the per-day absence/OT dates — additive, display-only, no amounts.
  // Skipped for unscoped/multi-period lists (the day detail is per-month and the
  // current callers don't need it there). Best-effort: a read failure leaves the
  // base rows intact rather than 500-ing the whole list.
  if (period && rows.length > 0) {
    try {
      const detail = await buildDayDetailForPeriod(
        c.var.DB,
        period,
        rows.map((r) => r.employeeId),
      );
      const data: PayslipWithDayDetail[] = rows.map((r) => {
        const d = detail.get(r.employeeId);
        return { ...r, absentDates: d?.absentDates ?? [], otDays: d?.otDays ?? [] };
      });
      return c.json({ success: true, data, total: data.length });
    } catch (e) {
      console.warn("[payslips] day-detail enrichment skipped:", e);
    }
  }
  return c.json({ success: true, data: rows, total: rows.length });
});

// ---------------------------------------------------------------------------
// GET /api/payslips/projected?period=YYYY-MM — LIVE, NON-STORED estimate.
//
// The admin Payroll screen + Labor Cost / Department Labor reconciliation were
// blank for an in-progress month (payslips aren't generated until month-end),
// while the worker phone already shows a live estimate. This computes the SAME
// estimate for ALL active workers — the IDENTICAL engine (computeMonthlyLabor)
// + statutory + effective-salary + join/resign + grace-cutoff logic the POST
// generation uses — but returns it WITHOUT storing. So the in-progress month is
// no longer empty on the admin side, and these numbers match what the month-end
// "Generate" will produce. Returns the same camelCase shape as the list, with
// status "PROJECTED". POST (real generation) is untouched.
// Registered before GET "/:id" so "projected" isn't parsed as an id.
// ---------------------------------------------------------------------------
app.get("/projected", async (c) => {
  const denied = await requirePermission(c, "payslips", "read");
  if (denied) return denied;
  const period = c.req.query("period");
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return c.json({ success: false, error: "Period (YYYY-MM) is required" }, 400);
  }

  // Same worker scope as POST: ACTIVE, plus RESIGNED in their final month.
  const wres = await c.var.DB.prepare(
    "SELECT id, empNo, name, departmentCode, status, basicSalarySen, workingDaysPerMonth, workingHoursPerDay, otMultiplier, epfEnabled, socsoEnabled, eisEnabled, pcbEnabled, resignedAt, joinDate, efficiencyAllowanceSen, efficiencyThresholdPct FROM workers WHERE (status = 'ACTIVE' OR (status = 'RESIGNED' AND resignedAt LIKE ?)) AND empNo NOT LIKE 'TEST%'",
  )
    .bind(`${period}-%`)
    .all<WorkerRow>();
  const activeWorkers = wres.results ?? [];

  const phRow = await c.var.DB.prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("public_holidays")
    .first<{ value: string | null }>();
  const publicHolidays = new Set<string>();
  if (phRow?.value) {
    try {
      const parsed = JSON.parse(phRow.value);
      if (Array.isArray(parsed)) {
        for (const d of parsed) {
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) publicHolidays.add(d);
        }
      }
    } catch { /* malformed — no holidays */ }
  }

  const wheRes = await c.var.DB.prepare(
    "SELECT workerId, date, hours FROM working_hour_entries WHERE date LIKE ?",
  )
    .bind(`${period}-%`)
    .all<{ workerId: string; date: string; hours: number }>();
  const daysByWorker = new Map<string, { date: string; hours: number }[]>();
  for (const r of wheRes.results ?? []) {
    const arr = daysByWorker.get(r.workerId) ?? [];
    arr.push({ date: r.date, hours: Number(r.hours) || 0 });
    daysByWorker.set(r.workerId, arr);
  }

  const deductionHoursByWorker = new Map<string, number>();
  // Per-day docks so the Payroll row can itemise the late/short deduction down to
  // the specific days — mirrors the worker My Pay drill-down (worker.ts).
  const deductionDaysByWorker = new Map<string, Array<{ date: string; hours: number }>>();
  try {
    const dedRes = await c.var.DB.prepare(
      "SELECT workerId, date, hours FROM payroll_hour_deductions WHERE date LIKE ? ORDER BY date",
    )
      .bind(`${period}-%`)
      .all<{ workerId: string; date: string; hours: number }>();
    for (const r of dedRes.results ?? []) {
      const h = Number(r.hours) || 0;
      deductionHoursByWorker.set(r.workerId, (deductionHoursByWorker.get(r.workerId) ?? 0) + h);
      if (h > 0) {
        const arr = deductionDaysByWorker.get(r.workerId) ?? [];
        arr.push({ date: r.date, hours: Math.round(h * 100) / 100 });
        deductionDaysByWorker.set(r.workerId, arr);
      }
    }
  } catch (e) {
    console.warn("[payslips/projected] payroll_hour_deductions read skipped:", e);
  }

  // Effective-dated pay rules — day-level maths inside the engine resolve per
  // date; statutory uses the rules as of the period's last day.
  const [prY, prM] = period.split("-").map(Number);
  const periodEndYmd = `${period}-${String(new Date(prY, prM, 0).getDate()).padStart(2, "0")}`;
  const payRuleVersions = await loadPayRuleVersions(c.var.DB);
  const statutoryRules = resolvePayRulesAsOf(payRuleVersions, periodEndYmd);

  const salaryHistoryByWorker = new Map<string, Array<{ effectiveFrom: string; basicSalarySen: number }>>();
  try {
    const wshRes = await c.var.DB.prepare(
      "SELECT workerId, basicSalarySen, effectiveFrom FROM worker_salary_history",
    ).all<{ workerId: string; basicSalarySen: number; effectiveFrom: string }>();
    for (const r of wshRes.results ?? []) {
      const arr = salaryHistoryByWorker.get(r.workerId) ?? [];
      arr.push({ effectiveFrom: r.effectiveFrom, basicSalarySen: Number(r.basicSalarySen) || 0 });
      salaryHistoryByWorker.set(r.workerId, arr);
    }
  } catch (e) {
    console.warn("[payslips/projected] worker_salary_history read skipped:", e);
  }

  const [pYear, pMonth] = period.split("-").map(Number);
  const today = new Date();
  const absenceThroughDay = absenceCutoffDay(pYear, pMonth, today, statutoryRules.absenceGraceWorkingDays, publicHolidays);
  const periodLastIso = `${period}-${String(new Date(pYear, pMonth, 0).getDate()).padStart(2, "0")}`;

  // Month-cumulative efficiency per worker (job_cards production minutes ÷
  // production-dept working hours) — drives the efficiency allowance below.
  // One pass for the whole period; an in-progress month yields the to-date
  // figure (only elapsed cards + keyed hours exist yet).
  const effBounds = monthBounds(period);
  const effByWorker = await computeMonthlyEfficiencyByWorker(
    c.var.DB,
    effBounds.start,
    effBounds.end,
  );

  // The estimate rows carry the per-day absence/OT detail (additive display
  // fields) alongside the standard payslip shape.
  const data: PayslipWithDayDetail[] = [];
  for (const worker of activeWorkers) {
    if (
      typeof worker.joinDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(worker.joinDate) &&
      worker.joinDate > periodLastIso
    ) {
      continue; // joined after this month — no slip
    }
    const joinedDay =
      typeof worker.joinDate === "string" && worker.joinDate.startsWith(`${period}-`)
        ? Number(worker.joinDate.slice(8, 10))
        : undefined;
    const resignedDay =
      worker.status === "RESIGNED" &&
      typeof worker.resignedAt === "string" &&
      worker.resignedAt.startsWith(`${period}-`)
        ? Number(worker.resignedAt.slice(8, 10))
        : undefined;
    const effectiveSalarySen = effectiveSalarySenForMonth(
      salaryHistoryByWorker.get(worker.id) ?? [],
      worker.basicSalarySen,
      pYear,
      pMonth,
      publicHolidays,
    );
    const labor = computeMonthlyLabor({
      worker: {
        basicSalarySen: effectiveSalarySen,
        workingDaysPerMonth: worker.workingDaysPerMonth,
        workingHoursPerDay: worker.workingHoursPerDay,
        otMultiplier: worker.otMultiplier,
      },
      year: pYear,
      month: pMonth,
      days: daysByWorker.get(worker.id) ?? [],
      publicHolidays,
      absenceThroughDay,
      employmentStartDay: joinedDay,
      employmentEndDay: resignedDay,
      prorateToService: joinedDay !== undefined || resignedDay !== undefined,
      shortHourDeductionHours: deductionHoursByWorker.get(worker.id) ?? 0,
      payRuleVersions,
    });
    // Per-day absence/OT dates from the SAME inputs the engine just used — a
    // display-only enrichment (no amounts). Lets the Payroll row's expanded
    // layer show WHICH days were absent / had OT.
    const dayDetail = computeAttendanceDayDetail({
      worker: { workingHoursPerDay: worker.workingHoursPerDay },
      year: pYear,
      month: pMonth,
      days: daysByWorker.get(worker.id) ?? [],
      publicHolidays,
      absenceThroughDay,
      employmentStartDay: joinedDay,
      employmentEndDay: resignedDay,
    });
    const allowances = resolveEfficiencyAllowanceSen(
      effByWorker.get(worker.id),
      worker.efficiencyAllowanceSen,
      worker.efficiencyThresholdPct,
    );
    const stat = calcStatutory(effectiveSalarySen, {
      epfEnabled: worker.epfEnabled,
      socsoEnabled: worker.socsoEnabled,
      eisEnabled: worker.eisEnabled,
      pcbEnabled: worker.pcbEnabled,
    }, statutoryRules);
    const grossPay = labor.payroll.grossSen + allowances;
    const totalDeductions = stat.epfEmployee + stat.socsoEmployee + stat.eisEmployee + stat.pcb;
    const hourlyRate =
      worker.workingHoursPerDay > 0
        ? Math.round(labor.payrollDailyRateSen / worker.workingHoursPerDay)
        : 0;
    // Build the SAME camelCase shape rowToPayslip returns — but in-memory.
    // Day-typed OT (owner spec 2026-06-10): weekday / Sunday / public-holiday
    // buckets — hours rounded for the INTEGER columns; money is the engine's
    // exact per-bucket pay.
    data.push({
      id: `projected-${period}-${worker.id}`,
      employeeId: worker.id,
      employeeName: worker.name,
      employeeNo: worker.empNo,
      departmentCode: worker.departmentCode ?? "",
      period,
      basicSalary: effectiveSalarySen,
      workingDays: worker.workingDaysPerMonth,
      absentDays: labor.payroll.absentDays,
      absenceDeductionSen: labor.payroll.absenceDeductionSen,
      otWeekdayHours: Math.round(labor.otWeekdayHours),
      otSundayHours: Math.round(labor.otSundayHours),
      otPHHours: Math.round(labor.otHolidayHours),
      hourlyRate,
      otWeekdayAmount: labor.payroll.otWeekdayPaySen,
      otSundayAmount: labor.payroll.otSundayPaySen,
      otPHAmount: labor.payroll.otHolidayPaySen,
      totalOT: labor.payroll.otPaySen,
      allowances,
      grossPay,
      epfEmployee: stat.epfEmployee,
      epfEmployer: stat.epfEmployer,
      socsoEmployee: stat.socsoEmployee,
      socsoEmployer: stat.socsoEmployer,
      eisEmployee: stat.eisEmployee,
      eisEmployer: stat.eisEmployer,
      pcb: stat.pcb,
      totalDeductions,
      netPay: grossPay - totalDeductions,
      bankAccount: "",
      // Reuse the existing DRAFT status (the response's top-level `projected:true`
      // flag is what the UI keys on to render these as a read-only estimate).
      status: "DRAFT" as const,
      createdAt: "",
      updatedAt: "",
      // Additive per-day detail for the expanded Payroll row.
      absentDates: dayDetail.absentDates,
      otDays: dayDetail.otDays,
      // Late / short-hours dock — the amount (from the engine) + the specific
      // days, so the office Payroll row itemises it like the worker My Pay does
      // (the deduction is already folded into gross/net; this just shows it).
      shortHourDeductionSen: labor.payroll.shortHourDeductionSen,
      lateDays: deductionDaysByWorker.get(worker.id) ?? [],
    });
  }

  return c.json({ success: true, data, total: data.length, projected: true });
});

// ---------------------------------------------------------------------------
// POST /api/payslips — generate a run for ACTIVE workers
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — payslips:create (generate).
  const denied = await requirePermission(c, "payslips", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { period, regenerate } = body;
    if (!period) {
      return c.json(
        { success: false, error: "Period is required (e.g. 2026-04)" },
        400,
      );
    }

    // 2026-05-24 — added `regenerate` body flag. When the operator changes
    // a worker's master-data (statutory toggle, OT multiplier, salary)
    // AFTER the period's drafts were generated, the stored drafts still
    // hold the old numbers. Posting with `regenerate: true` wipes the
    // period's DRAFT rows so the recompute below picks up the current
    // worker config. APPROVED rows are protected — once payroll is
    // signed off the audit trail is inviolate, the operator has to
    // un-approve first (a separate flow) before a regenerate.
    if (regenerate) {
      const approvedRow = await c.var.DB.prepare(
        "SELECT COUNT(*) AS c FROM payslips WHERE period = ? AND status != 'DRAFT'",
      )
        .bind(period)
        .first<{ c: number }>();
      if ((approvedRow?.c ?? 0) > 0) {
        return c.json(
          {
            success: false,
            error: "Cannot regenerate — at least one payslip in this period is already approved. Un-approve first.",
          },
          400,
        );
      }
      await c.var.DB.prepare(
        "DELETE FROM payslips WHERE period = ? AND status = 'DRAFT'",
      )
        .bind(period)
        .run();
    } else {
      const existing = await c.var.DB.prepare(
        "SELECT COUNT(*) AS c FROM payslips WHERE period = ?",
      )
        .bind(period)
        .first<{ c: number }>();
      if ((existing?.c ?? 0) > 0) {
        return c.json(
          {
            success: false,
            error: "Payslips already generated for this period. Use Regenerate to refresh after master-data changes.",
          },
          400,
        );
      }
    }

    const wres = await c.var.DB.prepare(
      // ACTIVE workers are always paid. A RESIGNED worker is paid only for the
      // single month that contains their resignedAt date (their final, usually
      // partial, month) — the existing absence math prorates the days after
      // they left. Later months exclude them because resignedAt no longer
      // matches the period. Earlier months were generated while still ACTIVE.
      "SELECT id, empNo, name, departmentCode, status, basicSalarySen, workingDaysPerMonth, workingHoursPerDay, otMultiplier, epfEnabled, socsoEnabled, eisEnabled, pcbEnabled, resignedAt, joinDate, efficiencyAllowanceSen, efficiencyThresholdPct FROM workers WHERE (status = 'ACTIVE' OR (status = 'RESIGNED' AND resignedAt LIKE ?)) AND empNo NOT LIKE 'TEST%'",
    )
      .bind(`${period}-%`)
      .all<WorkerRow>();
    const activeWorkers = wres.results ?? [];

    // Public holidays — kv_config['public_holidays']. A holiday is never
    // charged as an absence; it does not change the ÷26 payroll divisor.
    const phRow = await c.var.DB.prepare(
      "SELECT value FROM kv_config WHERE key = ?",
    )
      .bind("public_holidays")
      .first<{ value: string | null }>();
    const publicHolidays = new Set<string>();
    if (phRow?.value) {
      try {
        const parsed = JSON.parse(phRow.value);
        if (Array.isArray(parsed)) {
          for (const d of parsed) {
            if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
              publicHolidays.add(d);
            }
          }
        }
      } catch {
        /* malformed payload — treat as no holidays */
      }
    }

    // Every worker's Working Hours rows for the period, fetched in one
    // query and grouped by worker for the engine.
    const wheRes = await c.var.DB.prepare(
      "SELECT workerId, date, hours FROM working_hour_entries WHERE date LIKE ?",
    )
      .bind(`${period}-%`)
      .all<{ workerId: string; date: string; hours: number }>();
    const daysByWorker = new Map<string, { date: string; hours: number }[]>();
    for (const r of wheRes.results ?? []) {
      const arr = daysByWorker.get(r.workerId) ?? [];
      arr.push({ date: r.date, hours: Number(r.hours) || 0 });
      daysByWorker.set(r.workerId, arr);
    }

    // Effective-dated pay rules (same as the projected path).
    const [prY, prM] = period.split("-").map(Number);
    const periodEndYmd = `${period}-${String(new Date(prY, prM, 0).getDate()).padStart(2, "0")}`;
    const payRuleVersions = await loadPayRuleVersions(c.var.DB);
    const statutoryRules = resolvePayRulesAsOf(payRuleVersions, periodEndYmd);

    // Owner-flagged unworked-hour docks for the period (Labor Cost under-recorded
    // review), summed per worker. The engine values them at the worker's
    // ÷working-days hourly rate and subtracts from basic earned.
    // Resilient read: if migration 0152 hasn't been applied yet the table won't
    // exist — treat that as "no docks" so payroll still generates rather than
    // 500-ing. Once the table is created, docks take effect on the next regen.
    let dedResults: Array<{ workerId: string; hours: number }> = [];
    try {
      const dedRes = await c.var.DB.prepare(
        "SELECT workerId, hours FROM payroll_hour_deductions WHERE date LIKE ?",
      )
        .bind(`${period}-%`)
        .all<{ workerId: string; hours: number }>();
      dedResults = dedRes.results ?? [];
    } catch (e) {
      console.warn("[payslips] payroll_hour_deductions read skipped:", e);
    }
    const deductionHoursByWorker = new Map<string, number>();
    for (const r of dedResults) {
      deductionHoursByWorker.set(
        r.workerId,
        (deductionHoursByWorker.get(r.workerId) ?? 0) + (Number(r.hours) || 0),
      );
    }

    // Effective-dated salary history (worker_salary_history). Resilient: if the
    // migration (0153) hasn't run yet, fall back to each worker's current scalar.
    const salaryHistoryByWorker = new Map<
      string,
      Array<{ effectiveFrom: string; basicSalarySen: number }>
    >();
    try {
      const wshRes = await c.var.DB.prepare(
        "SELECT workerId, basicSalarySen, effectiveFrom FROM worker_salary_history",
      ).all<{ workerId: string; basicSalarySen: number; effectiveFrom: string }>();
      for (const r of wshRes.results ?? []) {
        const arr = salaryHistoryByWorker.get(r.workerId) ?? [];
        arr.push({
          effectiveFrom: r.effectiveFrom,
          basicSalarySen: Number(r.basicSalarySen) || 0,
        });
        salaryHistoryByWorker.set(r.workerId, arr);
      }
    } catch (e) {
      console.warn("[payslips] worker_salary_history read skipped:", e);
    }

    // Absences are only counted for elapsed working days, minus a data-entry
    // grace: a finished month counts the whole month; the current month stops
    // ABSENCE_GRACE_WORKING_DAYS working days back from today, so the most
    // recent (likely not-yet-keyed) days aren't charged as absences yet.
    const [pYear, pMonth] = period.split("-").map(Number);
    const today = new Date();
    const absenceThroughDay = absenceCutoffDay(
      pYear,
      pMonth,
      today,
      statutoryRules.absenceGraceWorkingDays,
      publicHolidays,
    );

    const rows: PayslipRow[] = [];
    // Last calendar day of the period, as YYYY-MM-DD, for join-date comparison.
    const periodLastIso = `${period}-${String(new Date(pYear, pMonth, 0).getDate()).padStart(2, "0")}`;

    // Month-cumulative efficiency per worker — the basis for the efficiency
    // allowance written into each generated payslip's allowancesSen.
    const effBounds = monthBounds(period);
    const effByWorker = await computeMonthlyEfficiencyByWorker(
      c.var.DB,
      effBounds.start,
      effBounds.end,
    );

    for (const worker of activeWorkers) {
      // Join date. A worker who joined AFTER this period had not started yet —
      // skip them entirely (no payslip for a month before they were hired).
      // KINM MG HLA joined 2026-06-02, so May must not generate a slip for him.
      if (
        typeof worker.joinDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(worker.joinDate) &&
        worker.joinDate > periodLastIso
      ) {
        continue;
      }
      // Join day-of-month when they joined DURING this period (partial first
      // month). Days before this aren't worked or absent, and pay is prorated.
      const joinedDay =
        typeof worker.joinDate === "string" &&
        worker.joinDate.startsWith(`${period}-`)
          ? Number(worker.joinDate.slice(8, 10))
          : undefined;

      // Resignation proration. A worker whose resignedAt falls inside THIS
      // period was employed only through that day (inclusive) — their last day.
      // Pay them for the days actually served; days after they left are neither
      // worked nor absent. Workers still employed (resignedDay undefined) keep
      // the normal full-salary-minus-absences treatment.
      const resignedDay =
        worker.status === "RESIGNED" &&
        typeof worker.resignedAt === "string" &&
        worker.resignedAt.startsWith(`${period}-`)
          ? Number(worker.resignedAt.slice(8, 10))
          : undefined;

      // Salary effective for this month — day-weighted if it changed mid-month
      // (a raise), else the worker's single salary. Used for pay, statutory, and
      // the stored snapshot so the payslip is internally consistent.
      const effectiveSalarySen = effectiveSalarySenForMonth(
        salaryHistoryByWorker.get(worker.id) ?? [],
        worker.basicSalarySen,
        pYear,
        pMonth,
        publicHolidays,
      );

      // One engine call per worker — the SAME computeMonthlyLabor that
      // drives production labor cost and the worker phone view, so a
      // payslip and the worker's phone always agree.
      const labor = computeMonthlyLabor({
        worker: {
          basicSalarySen: effectiveSalarySen,
          workingDaysPerMonth: worker.workingDaysPerMonth,
          workingHoursPerDay: worker.workingHoursPerDay,
          otMultiplier: worker.otMultiplier,
        },
        year: pYear,
        month: pMonth,
        days: daysByWorker.get(worker.id) ?? [],
        publicHolidays,
        absenceThroughDay,
        employmentStartDay: joinedDay,
        employmentEndDay: resignedDay,
        // Joined OR resigned mid-month → prorate to days served.
        prorateToService: joinedDay !== undefined || resignedDay !== undefined,
        // Owner-flagged unworked hours docked from this worker this period.
        shortHourDeductionHours: deductionHoursByWorker.get(worker.id) ?? 0,
      payRuleVersions,
      });

      const allowances = resolveEfficiencyAllowanceSen(
        effByWorker.get(worker.id),
        worker.efficiencyAllowanceSen,
        worker.efficiencyThresholdPct,
      );
      // Statutory deductions computed on the month's effective monthly salary
      // (= the worker's salary, day-weighted if it changed mid-month).
      const stat = calcStatutory(effectiveSalarySen, {
        epfEnabled: worker.epfEnabled,
        socsoEnabled: worker.socsoEnabled,
        eisEnabled: worker.eisEnabled,
        pcbEnabled: worker.pcbEnabled,
      }, statutoryRules);
      // Gross = basic earned (full salary − absences) + OT + allowances.
      const grossPay = labor.payroll.grossSen + allowances;
      const totalDeductions =
        stat.epfEmployee + stat.socsoEmployee + stat.eisEmployee + stat.pcb;
      const netPay = grossPay - totalDeductions;
      const bankAccount = `CIMB-${worker.empNo.replace("EMP-", "")}XXXX`;

      // Base hourly rate (full salary ÷ 26 ÷ hours/day) for the payslip's
      // OT-calculation display, day-typed (owner spec 2026-06-10): the engine
      // splits OT into weekday / Sunday / public-holiday buckets. Hours are
      // rounded for the INTEGER columns; the money is the engine's exact
      // per-bucket pay (otWeekdayPaySen / otSundayPaySen / otHolidayPaySen).
      const hourlyRate =
        worker.workingHoursPerDay > 0
          ? Math.round(labor.payrollDailyRateSen / worker.workingHoursPerDay)
          : 0;

      const id = await nextPayslipId(c.var.DB, period);
      await c.var.DB.prepare(
        `INSERT OR IGNORE INTO payslips (
           id, employeeId, employeeName, employeeNo, departmentCode, period,
           basicSalarySen, workingDays, absentDays, absenceDeductionSen,
           otWeekdayHours, otSundayHours, otPhHours,
           hourlyRateSen, otWeekdayAmtSen, otSundayAmtSen, otPhAmtSen, totalOtSen,
           allowancesSen, grossPaySen, epfEmployeeSen, epfEmployerSen,
           socsoEmployeeSen, socsoEmployerSen, eisEmployeeSen, eisEmployerSen, pcbSen,
           totalDeductionsSen, netPaySen, bankAccount, status
         ) VALUES (
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?, 'DRAFT'
         )`,
      )
        .bind(
          id,
          worker.id,
          worker.name,
          worker.empNo,
          worker.departmentCode ?? "",
          period,
          effectiveSalarySen,
          worker.workingDaysPerMonth,
          labor.payroll.absentDays,
          labor.payroll.absenceDeductionSen,
          Math.round(labor.otWeekdayHours),
          Math.round(labor.otSundayHours),
          Math.round(labor.otHolidayHours),
          hourlyRate,
          labor.payroll.otWeekdayPaySen,
          labor.payroll.otSundayPaySen,
          labor.payroll.otHolidayPaySen,
          labor.payroll.otPaySen,
          allowances,
          grossPay,
          stat.epfEmployee,
          stat.epfEmployer,
          stat.socsoEmployee,
          stat.socsoEmployer,
          stat.eisEmployee,
          stat.eisEmployer,
          stat.pcb,
          totalDeductions,
          netPay,
          bankAccount,
        )
        .run();

      const inserted = await c.var.DB.prepare(
        "SELECT * FROM payslips WHERE id = ?",
      )
        .bind(id)
        .first<PayslipRow>();
      if (inserted) rows.push(inserted);
    }

    const data = rows.map(rowToPayslip);
    return c.json({ success: true, data, total: data.length }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/payslips — bulk status update for a period
// ---------------------------------------------------------------------------
app.put("/", async (c) => {
  // RBAC gate (P3.3-followup) — payslips:update (bulk status flip).
  const denied = await requirePermission(c, "payslips", "update");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { period, status } = body;
    if (!period || !status) {
      return c.json(
        { success: false, error: "Period and status are required" },
        400,
      );
    }
    const res = await c.var.DB.prepare(
      `UPDATE payslips
         SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE period = ?`,
    )
      .bind(status, period)
      .run();
    return c.json({ success: true, updated: res.meta?.changes ?? 0 });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// GET /api/payslips/:id — detail + YTD summary for this employee's year
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "payslips", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const payslip = await c.var.DB.prepare("SELECT * FROM payslips WHERE id = ?")
    .bind(id)
    .first<PayslipRow>();
  if (!payslip) {
    return c.json({ success: false, error: "Payslip not found" }, 404);
  }

  const year = payslip.period.split("-")[0];
  const ytdRes = await c.var.DB.prepare(
    "SELECT * FROM payslips WHERE employeeId = ? AND period LIKE ?",
  )
    .bind(payslip.employeeId, `${year}-%`)
    .all<PayslipRow>();
  const employeeSlips = ytdRes.results ?? [];

  const ytd = employeeSlips.reduce(
    (acc, p) => ({
      basicSalary: acc.basicSalary + p.basicSalarySen,
      totalOT: acc.totalOT + p.totalOtSen,
      grossPay: acc.grossPay + p.grossPaySen,
      epfEmployee: acc.epfEmployee + p.epfEmployeeSen,
      epfEmployer: acc.epfEmployer + p.epfEmployerSen,
      socsoEmployee: acc.socsoEmployee + p.socsoEmployeeSen,
      socsoEmployer: acc.socsoEmployer + p.socsoEmployerSen,
      eisEmployee: acc.eisEmployee + p.eisEmployeeSen,
      eisEmployer: acc.eisEmployer + p.eisEmployerSen,
      pcb: acc.pcb + p.pcbSen,
      totalDeductions: acc.totalDeductions + p.totalDeductionsSen,
      netPay: acc.netPay + p.netPaySen,
    }),
    {
      basicSalary: 0,
      totalOT: 0,
      grossPay: 0,
      epfEmployee: 0,
      epfEmployer: 0,
      socsoEmployee: 0,
      socsoEmployer: 0,
      eisEmployee: 0,
      eisEmployer: 0,
      pcb: 0,
      totalDeductions: 0,
      netPay: 0,
    },
  );

  // Contracted hours/day for the payslip "Hourly Rate" formula label. Not stored
  // on payslips (only the resulting hourlyRate is), so read it from the worker.
  // Display-only; a missing worker falls back to 9 in the PDF. BUG-2026-07-17-012.
  const w = await c.var.DB.prepare(
    "SELECT workingHoursPerDay FROM workers WHERE id = ?",
  )
    .bind(payslip.employeeId)
    .first<{ workingHoursPerDay: number | null }>();
  const workingHoursPerDay = Number(w?.workingHoursPerDay) || 9;

  return c.json({
    success: true,
    data: { ...rowToPayslip(payslip), workingHoursPerDay },
    ytd,
    monthsIncluded: employeeSlips.length,
  });
});

export default app;
