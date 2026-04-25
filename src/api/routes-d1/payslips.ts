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

const app = new Hono<Env>();

type WorkerRow = {
  id: string;
  empNo: string;
  name: string;
  departmentCode: string | null;
  status: string;
  basicSalarySen: number;
  workingDaysPerMonth: number;
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
function calcHourlyRate(basicSalarySen: number): number {
  return Math.round(basicSalarySen / (26 * 9));
}
function calcOT(
  hourlyRateSen: number,
  weekdayHrs: number,
  sundayHrs: number,
  phHrs: number,
) {
  const weekday = Math.round(hourlyRateSen * 1.5 * weekdayHrs);
  const sunday = Math.round(hourlyRateSen * 2.0 * sundayHrs);
  const ph = Math.round(hourlyRateSen * 3.0 * phHrs);
  return { weekday, sunday, ph, total: weekday + sunday + ph };
}
function calcStatutory(basicSalarySen: number) {
  return {
    epfEmployee: Math.round(basicSalarySen * 0.11),
    epfEmployer: Math.round(basicSalarySen * 0.13),
    socsoEmployee: 745,
    socsoEmployer: 2615,
    eisEmployee: 390,
    eisEmployer: 390,
    pcb: 0,
  };
}

async function nextPayslipId(db: D1Database): Promise<string> {
  const res = await db
    .prepare("SELECT COUNT(*) AS c FROM payslips WHERE id LIKE 'PS-%'")
    .first<{ c: number }>();
  const seq = (res?.c ?? 0) + 1;
  return `PS-${String(seq).padStart(5, "0")}`;
}

// ---------------------------------------------------------------------------
// GET /api/payslips?period=&employeeId=
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const period = c.req.query("period");
  const employeeId = c.req.query("employeeId");

  let sql = "SELECT * FROM payslips";
  const clauses: string[] = [];
  const binds: (string | number)[] = [];
  if (period) {
    clauses.push("period = ?");
    binds.push(period);
  }
  if (employeeId) {
    clauses.push("employeeId = ?");
    binds.push(employeeId);
  }
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += " ORDER BY period DESC, employeeNo";

  const stmt = c.var.DB.prepare(sql);
  const res = await (binds.length ? stmt.bind(...binds) : stmt).all<PayslipRow>();
  const data = (res.results ?? []).map(rowToPayslip);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// POST /api/payslips — generate a run for ACTIVE workers
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { period } = body;
    if (!period) {
      return c.json(
        { success: false, error: "Period is required (e.g. 2026-04)" },
        400,
      );
    }

    const existing = await c.var.DB.prepare(
      "SELECT COUNT(*) AS c FROM payslips WHERE period = ?",
    )
      .bind(period)
      .first<{ c: number }>();
    if ((existing?.c ?? 0) > 0) {
      return c.json(
        { success: false, error: "Payslips already generated for this period." },
        400,
      );
    }

    const wres = await c.var.DB.prepare(
      "SELECT id, empNo, name, departmentCode, status, basicSalarySen, workingDaysPerMonth FROM workers WHERE status = 'ACTIVE'",
    ).all<WorkerRow>();
    const activeWorkers = wres.results ?? [];

    const rows: PayslipRow[] = [];
    for (const worker of activeWorkers) {
      const hourlyRate = calcHourlyRate(worker.basicSalarySen);
      const otWeekday = Math.floor(Math.random() * 16) + 2;
      const otSunday = Math.random() > 0.5 ? Math.floor(Math.random() * 8) : 0;
      const otPH = Math.random() > 0.8 ? Math.floor(Math.random() * 8) : 0;
      const allowances = 0;

      const ot = calcOT(hourlyRate, otWeekday, otSunday, otPH);
      const grossPay = worker.basicSalarySen + ot.total + allowances;
      const stat = calcStatutory(worker.basicSalarySen);
      const totalDeductions =
        stat.epfEmployee + stat.socsoEmployee + stat.eisEmployee + stat.pcb;
      const netPay = grossPay - totalDeductions;
      const bankAccount = `CIMB-${worker.empNo.replace("EMP-", "")}XXXX`;

      const id = await nextPayslipId(c.var.DB);
      await c.var.DB.prepare(
        `INSERT OR IGNORE INTO payslips (
           id, employeeId, employeeName, employeeNo, departmentCode, period,
           basicSalarySen, workingDays, otWeekdayHours, otSundayHours, otPhHours,
           hourlyRateSen, otWeekdayAmtSen, otSundayAmtSen, otPhAmtSen, totalOtSen,
           allowancesSen, grossPaySen, epfEmployeeSen, epfEmployerSen,
           socsoEmployeeSen, socsoEmployerSen, eisEmployeeSen, eisEmployerSen, pcbSen,
           totalDeductionsSen, netPaySen, bankAccount, status
         ) VALUES (
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
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
          otWeekday,
          otSunday,
          otPH,
          hourlyRate,
          ot.weekday,
          ot.sunday,
          ot.ph,
          ot.total,
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
