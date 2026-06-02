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
import { computeMonthlyLabor, absenceCutoffDay } from "../../lib/labor-engine";

// Data-entry grace before an unrecorded working day is treated as a confirmed
// absence. Spec (Wei Siang, 2026-06-02): the office keys Working Hours a few
// days late, so the most recent working days with no hours are "maybe just not
// entered yet" — only count a day as absent once it is this many working days
// in the past. Finished months are unaffected (the whole month is past grace).
const ABSENCE_GRACE_WORKING_DAYS = 2;

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

function calcStatutory(basicSalarySen: number, flags: StatutoryFlags = {}) {
  const epfOn = flags.epfEnabled !== false;
  const socsoOn = flags.socsoEnabled !== false;
  const eisOn = flags.eisEnabled !== false;
  const pcbOn = flags.pcbEnabled !== false;
  return {
    epfEmployee: epfOn ? Math.round(basicSalarySen * 0.11) : 0,
    epfEmployer: epfOn ? Math.round(basicSalarySen * 0.13) : 0,
    socsoEmployee: socsoOn ? 745 : 0,
    socsoEmployer: socsoOn ? 2615 : 0,
    eisEmployee: eisOn ? 390 : 0,
    eisEmployer: eisOn ? 390 : 0,
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
  }
  const sql = `SELECT * FROM payslips WHERE ${clauses.join(" AND ")} ORDER BY period DESC, employeeNo`;
  const res = await c.var.DB.prepare(sql).bind(...binds).all<PayslipRow>();
  const data = (res.results ?? []).map(rowToPayslip);
  return c.json({ success: true, data, total: data.length });
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
      "SELECT id, empNo, name, departmentCode, status, basicSalarySen, workingDaysPerMonth, workingHoursPerDay, otMultiplier, epfEnabled, socsoEnabled, eisEnabled, pcbEnabled, resignedAt FROM workers WHERE status = 'ACTIVE' OR (status = 'RESIGNED' AND resignedAt LIKE ?)",
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
      ABSENCE_GRACE_WORKING_DAYS,
      publicHolidays,
    );

    const rows: PayslipRow[] = [];
    for (const worker of activeWorkers) {
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

      // One engine call per worker — the SAME computeMonthlyLabor that
      // drives production labor cost and the worker phone view, so a
      // payslip and the worker's phone always agree.
      const labor = computeMonthlyLabor({
        worker: {
          basicSalarySen: worker.basicSalarySen,
          workingDaysPerMonth: worker.workingDaysPerMonth,
          workingHoursPerDay: worker.workingHoursPerDay,
          otMultiplier: worker.otMultiplier,
        },
        year: pYear,
        month: pMonth,
        days: daysByWorker.get(worker.id) ?? [],
        publicHolidays,
        absenceThroughDay,
        employmentEndDay: resignedDay,
        prorateToService: resignedDay !== undefined,
      });

      const allowances = 0;
      // Statutory deductions stay computed on the full monthly salary —
      // unchanged from before; the engine rework only touches basic + OT.
      const stat = calcStatutory(worker.basicSalarySen, {
        epfEnabled: worker.epfEnabled,
        socsoEnabled: worker.socsoEnabled,
        eisEnabled: worker.eisEnabled,
        pcbEnabled: worker.pcbEnabled,
      });
      // Gross = basic earned (full salary − absences) + OT + allowances.
      const grossPay = labor.payroll.grossSen + allowances;
      const totalDeductions =
        stat.epfEmployee + stat.socsoEmployee + stat.eisEmployee + stat.pcb;
      const netPay = grossPay - totalDeductions;
      const bankAccount = `CIMB-${worker.empNo.replace("EMP-", "")}XXXX`;

      // Base hourly rate (full salary ÷ 26 ÷ hours/day) for the payslip's
      // OT-calculation display. The engine returns ONE overtime figure —
      // the operator's model is a single OT rate — so it goes in the
      // weekday slot; the Sunday / public-holiday slots stay 0.
      const hourlyRate =
        worker.workingHoursPerDay > 0
          ? Math.round(labor.payrollDailyRateSen / worker.workingHoursPerDay)
          : 0;
      const otHoursWhole = Math.round(labor.otHours);

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
          worker.basicSalarySen,
          worker.workingDaysPerMonth,
          labor.payroll.absentDays,
          labor.payroll.absenceDeductionSen,
          otHoursWhole,
          0,
          0,
          hourlyRate,
          labor.payroll.otPaySen,
          0,
          0,
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

  return c.json({
    success: true,
    data: rowToPayslip(payslip),
    ytd,
    monthsIncluded: employeeSlips.length,
  });
});

export default app;
