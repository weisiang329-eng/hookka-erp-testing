// ---------------------------------------------------------------------------
// D1-backed payroll route.
//
// Mirrors the old src/api/routes/payroll.ts shape. Eligibility (active workers)
// is derived from the `workers` table at run-time.
//
//   GET  /api/payroll?period=2026-04  → list payroll records for a period
//   POST /api/payroll                  → generate run for all ACTIVE workers
//   PUT  /api/payroll                  → bulk update status for a period
//
// Response shape matches legacy mock: camelCase *Sen fields, no timestamps.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";

const app = new Hono<Env>();

type WorkerRow = {
  id: string;
  empNo: string;
  name: string;
  status: string;
  basicSalarySen: number;
  workingDaysPerMonth: number;
};

type PayrollRow = {
  id: string;
  workerId: string;
  workerName: string;
  period: string;
  basicSalarySen: number;
  workingDays: number;
  otHoursWeekday: number;
  otHoursSunday: number;
  otHoursHoliday: number;
  otAmountSen: number;
  grossSalarySen: number;
  epfEmployeeSen: number;
  epfEmployerSen: number;
  socsoEmployeeSen: number;
  socsoEmployerSen: number;
  eisEmployeeSen: number;
  eisEmployerSen: number;
  pcbSen: number;
  totalDeductionsSen: number;
  netPaySen: number;
  status: "DRAFT" | "APPROVED" | "PAID";
  createdAt: string;
  updatedAt: string;
};

function rowToPayroll(r: PayrollRow) {
  return {
    id: r.id,
    workerId: r.workerId,
    workerName: r.workerName,
    period: r.period,
    basicSalarySen: r.basicSalarySen,
    workingDays: r.workingDays,
    otHoursWeekday: r.otHoursWeekday,
    otHoursSunday: r.otHoursSunday,
    otHoursHoliday: r.otHoursHoliday,
    otAmountSen: r.otAmountSen,
    grossSalarySen: r.grossSalarySen,
    epfEmployeeSen: r.epfEmployeeSen,
    epfEmployerSen: r.epfEmployerSen,
    socsoEmployeeSen: r.socsoEmployeeSen,
    socsoEmployerSen: r.socsoEmployerSen,
    eisEmployeeSen: r.eisEmployeeSen,
    eisEmployerSen: r.eisEmployerSen,
    pcbSen: r.pcbSen,
    totalDeductionsSen: r.totalDeductionsSen,
    netPaySen: r.netPaySen,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// PAY-YYMM-NNN sequential, bucketed by payroll period. Bug fix 2026-04-28:
// previous PAY-NNNNN format was a global counter without month context.
// Now derives YYMM from the `period` (YYYY-MM) so all rows for a given
// run share the same prefix and number monotonically inside it. Falls
// back to the current month if the period is malformed.
async function nextPayrollId(
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
  const prefix = `PAY-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT id FROM payroll_records WHERE id LIKE ? ORDER BY id DESC LIMIT 1",
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
// GET /api/payroll?period=YYYY-MM
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — payroll:read.
  const denied = await requirePermission(c, "payroll", "read");
  if (denied) return denied;
  const period = c.req.query("period");
  const stmt = period
    ? c.var.DB.prepare(
        "SELECT * FROM payroll_records WHERE period = ? ORDER BY workerId",
      ).bind(period)
    : c.var.DB.prepare("SELECT * FROM payroll_records ORDER BY period DESC, workerId");
  const res = await stmt.all<PayrollRow>();
  const data = (res.results ?? []).map(rowToPayroll);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// POST /api/payroll — generate a run for all ACTIVE workers
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — payroll:create (run payroll).
  const denied = await requirePermission(c, "payroll", "create");
  if (denied) return denied;
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
      "SELECT COUNT(*) AS c FROM payroll_records WHERE period = ?",
    )
      .bind(period)
      .first<{ c: number }>();
    if ((existing?.c ?? 0) > 0) {
      return c.json(
        {
          success: false,
          error: "Payroll already generated for this period. Delete first to regenerate.",
        },
        400,
      );
    }

    const wres = await c.var.DB.prepare(
      "SELECT id, empNo, name, status, basicSalarySen, workingDaysPerMonth FROM workers WHERE status = 'ACTIVE'",
    ).all<WorkerRow>();
    const activeWorkers = wres.results ?? [];

    const rows: PayrollRow[] = [];
    for (const worker of activeWorkers) {
      const hourlyRateSen = worker.basicSalarySen / (26 * 9);

      const otHoursWeekday = Math.floor(Math.random() * 16) + 2;
      const otHoursSunday = Math.random() > 0.5 ? Math.floor(Math.random() * 8) : 0;
      const otHoursHoliday = Math.random() > 0.8 ? Math.floor(Math.random() * 8) : 0;

      const otWeekdayAmountSen = Math.round(hourlyRateSen * otHoursWeekday * 1.5);
      const otSundayAmountSen = Math.round(hourlyRateSen * otHoursSunday * 2.0);
      const otHolidayAmountSen = Math.round(hourlyRateSen * otHoursHoliday * 3.0);
      const otAmountSen = otWeekdayAmountSen + otSundayAmountSen + otHolidayAmountSen;

      const grossSalarySen = worker.basicSalarySen + otAmountSen;

      const epfEmployeeSen = Math.round(worker.basicSalarySen * 0.11);
      const epfEmployerSen = Math.round(worker.basicSalarySen * 0.13);
      const socsoEmployeeSen = 745;
      const socsoEmployerSen = 2615;
      const eisEmployeeSen = 390;
      const eisEmployerSen = 390;
      const pcbSen = 0;

      const totalDeductionsSen = epfEmployeeSen + socsoEmployeeSen + eisEmployeeSen + pcbSen;
      const netPaySen = grossSalarySen - totalDeductionsSen;

      const id = await nextPayrollId(c.var.DB, period);
      await c.var.DB.prepare(
        `INSERT OR IGNORE INTO payroll_records (
           id, workerId, workerName, period, basicSalarySen, workingDays,
           otHoursWeekday, otHoursSunday, otHoursHoliday, otAmountSen, grossSalarySen,
           epfEmployeeSen, epfEmployerSen, socsoEmployeeSen, socsoEmployerSen,
           eisEmployeeSen, eisEmployerSen, pcbSen, totalDeductionsSen, netPaySen, status
         ) VALUES (?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?, ?, 'DRAFT')`,
      )
        .bind(
          id,
          worker.id,
          worker.name,
          period,
          worker.basicSalarySen,
          worker.workingDaysPerMonth,
          otHoursWeekday,
          otHoursSunday,
          otHoursHoliday,
          otAmountSen,
          grossSalarySen,
          epfEmployeeSen,
          epfEmployerSen,
          socsoEmployeeSen,
          socsoEmployerSen,
          eisEmployeeSen,
          eisEmployerSen,
          pcbSen,
          totalDeductionsSen,
          netPaySen,
        )
        .run();

      const inserted = await c.var.DB.prepare(
        "SELECT * FROM payroll_records WHERE id = ?",
      )
        .bind(id)
        .first<PayrollRow>();
      if (inserted) rows.push(inserted);
    }

    const data = rows.map(rowToPayroll);
    return c.json({ success: true, data, total: data.length }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/payroll — bulk status update for a period
// ---------------------------------------------------------------------------
app.put("/", async (c) => {
  // RBAC gate (P3.3-followup) — bulk status flip is the "post" semantic.
  // The 0045 seed has read/create/update/delete for payroll; spec asked
  // for `payroll:post` which doesn't exist — fall back to :update which
  // is the closest match (and what the audit row says about this PUT).
  const denied = await requirePermission(c, "payroll", "update");
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
    // Snapshot the prior status distribution so the audit row captures the
    // pre-state alongside the post-state.
    const beforeRes = await c.var.DB.prepare(
      "SELECT status, COUNT(*) AS n FROM payroll_records WHERE period = ? GROUP BY status",
    )
      .bind(period)
      .all<{ status: string; n: number }>();
    const beforeStatuses = (beforeRes.results ?? []).reduce<Record<string, number>>(
      (acc, r) => {
        acc[r.status] = r.n;
        return acc;
      },
      {},
    );

    const res = await c.var.DB.prepare(
      `UPDATE payroll_records
         SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE period = ?`,
    )
      .bind(status, period)
      .run();
    const updated = res.meta?.changes ?? 0;

    // Audit emit (P3.4) — payroll post / finalize. The PUT bulk-flips the
    // whole period; resourceId is the period (e.g. "2026-04") so audit
    // queries can scope by month. Only emit when at least one row changed
    // — no-op runs don't generate noise.
    if (updated > 0) {
      await emitAudit(c, {
        resource: "payroll",
        resourceId: String(period),
        action: "post",
        before: { period, statuses: beforeStatuses },
        after: { period, status, recordsUpdated: updated },
      });
    }

    return c.json({ success: true, updated });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
