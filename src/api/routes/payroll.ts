// ---------------------------------------------------------------------------
// D1-backed payroll route.
//
// Mirrors the old src/api/routes/payroll.ts shape. Eligibility (active workers)
// is derived from the `workers` table at run-time.
//
//   GET  /api/payroll?period=2026-04  → list payroll records for a period
//   POST /api/payroll                  → DISABLED (501) — it fabricated OT;
//                                       use POST /api/payslips instead
//   PUT  /api/payroll                  → bulk update status for a period
//
// Response shape matches legacy mock: camelCase *Sen fields, no timestamps.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";

const app = new Hono<Env>();

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
// POST /api/payroll — DISABLED. It fabricated overtime. BUG-2026-08-13-014.
//
// Every run did this, per ACTIVE worker:
//
//     const hourlyRateSen  = worker.basicSalarySen / (26 * 9);
//     const otHoursWeekday = Math.floor(Math.random() * 16) + 2;
//     const otHoursSunday  = Math.random() > 0.5 ? Math.floor(Math.random() * 8) : 0;
//     const otHoursHoliday = Math.random() > 0.8 ? Math.floor(Math.random() * 8) : 0;
//
// Those three dice rolls were multiplied by 1.5x / 2.0x / 3.0x the hourly rate,
// added to basic pay, and INSERTed into `payroll_records` as `otHours*`,
// `otAmountSen`, `grossSalarySen` and `netPaySen`. No attendance table was read
// at any point. The hourly rate itself hardcoded a 26-day x 9-hour month while
// `workingDaysPerMonth` sat unused in the very same SELECT, and SOCSO (745),
// EIS (390) and PCB (0) were flat constants regardless of salary band.
//
// Nothing in src/pages calls `/api/payroll` — but the route is mounted
// (worker.ts) and the assistant's `get_payroll` tool READS `payroll_records`
// (src/api/lib/assistant-tools.ts), so one call would have fed random net pay
// back to the owner as an answer to "what did this worker earn".
//
// The REAL payroll engine is **POST /api/payslips**: `computeMonthlyLabor`
// (src/lib/labor-engine.ts) over `working_hour_entries` and effective-dated pay
// rules, with day-typed weekday / Sunday / public-holiday OT and per-worker
// statutory toggles. This route is a legacy duplicate of it.
//
// Refusing is the fix, not deriving OT here: a second payroll engine beside the
// real one is how two net-pay figures come to disagree. GET and PUT are left
// alone so any pre-existing rows stay readable (and auditable) — see the PR for
// the owner question about deleting them.
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — payroll:create (run payroll).
  const denied = await requirePermission(c, "payroll", "create");
  if (denied) return denied;
  return c.json(
    {
      success: false,
      error:
        "Payroll generation is disabled on this endpoint: it invented overtime " +
        "hours with a random number generator instead of reading attendance. " +
        "Generate payroll from the Payroll page (POST /api/payslips), which " +
        "computes day-typed OT from working_hour_entries.",
    },
    501,
  );
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
