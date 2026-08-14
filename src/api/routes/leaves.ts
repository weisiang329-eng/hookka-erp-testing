// ---------------------------------------------------------------------------
// D1-backed leaves route.
//
// Mirrors the old src/api/routes/leaves.ts shape: flat list with
// `{ success, data, total }` on GET, worker FK validated against the
// D1 `workers` table on POST. PUT accepts either a path-less body (legacy
// shape: `{ id, status, approvedBy }`) or `/:id` + body.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { ensureLeaveEntitlementColumns } from "../lib/ensure-leave-columns";
import {
  calendarLeaveDays,
  computeLeaveBalance,
  currentLeaveYear,
  parsePublicHolidays,
  type EntitledLeaveType,
  type LeaveLike,
  type WorkerEntitlementFields,
} from "../../lib/leave-entitlement";

const app = new Hono<Env>();

/**
 * Load the owner's configured public holidays.
 *
 * `kv_config['public_holidays']` is the SAME row the payroll paths read
 * (`payslips.ts`, `payroll-hour-deductions.ts`, `dashboard-overview.ts`). There
 * is deliberately no second holiday list — the owner maintains one, in
 * Employees, and everything reads it.
 */
async function loadPublicHolidays(db: Env["Variables"]["DB"]): Promise<Set<string>> {
  const row = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("public_holidays")
    .first<{ value: string | null }>();
  return parsePublicHolidays(row?.value ?? null);
}

type LeaveRow = {
  id: string;
  workerId: string;
  workerName: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  reason: string;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowToLeave(row: LeaveRow) {
  return {
    id: row.id,
    workerId: row.workerId,
    workerName: row.workerName,
    type: row.type,
    startDate: row.startDate,
    endDate: row.endDate,
    days: row.days,
    status: row.status,
    reason: row.reason ?? "",
    approvedBy: row.approvedBy ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function genId(): string {
  return `lv-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/leaves?workerId=...&status=...
app.get("/", async (c) => {
  const workerId = c.req.query("workerId");
  const status = c.req.query("status");

  const orgId = getOrgId(c);
  const wheres: string[] = ["orgId = ?"];
  const binds: (string | number)[] = [orgId];
  if (workerId) {
    wheres.push("workerId = ?");
    binds.push(workerId);
  }
  if (status) {
    wheres.push("status = ?");
    binds.push(status);
  }

  const sql = `SELECT * FROM leaves WHERE ${wheres.join(" AND ")} ORDER BY startDate DESC`;
  const res = await c.var.DB.prepare(sql).bind(...binds).all<LeaveRow>();
  const data = (res.results ?? []).map(rowToLeave);
  return c.json({ success: true, data, total: data.length });
});

// GET /api/leaves/balances?year=YYYY
//
// Per-worker leave balances, computed SERVER-side from the one shared policy
// module. Replaces the arithmetic that used to sit in the office screen with a
// hardcoded entitlement, no leave-year boundary and no holiday exclusion.
app.get("/balances", async (c) => {
  // The SELECT below names the two override columns, so the self-apply has to
  // land first — reading a column that does not exist fails exactly like
  // writing one.
  await ensureLeaveEntitlementColumns(c.var.DB);

  const orgId = getOrgId(c);
  const yearParam = Number(c.req.query("year"));
  const leaveYear =
    Number.isFinite(yearParam) && yearParam > 1970 ? Math.floor(yearParam) : currentLeaveYear();

  const [wres, lres, publicHolidays] = await Promise.all([
    c.var.DB.prepare(
      `SELECT id, name, annual_leave_entitlement_days, medical_leave_entitlement_days
         FROM workers WHERE orgId = ? AND status = 'ACTIVE'`,
    )
      .bind(orgId)
      .all<{ id: string; name: string } & WorkerEntitlementFields>(),
    c.var.DB.prepare(
      `SELECT workerId, type, status, startDate, endDate, days
         FROM leaves WHERE orgId = ?`,
    )
      .bind(orgId)
      .all<LeaveLike & { workerId: string }>(),
    loadPublicHolidays(c.var.DB),
  ]);

  // Bucket the leaves per worker ONCE rather than re-scanning the whole array
  // inside the per-worker map — bug class C14.
  const leavesByWorker = new Map<string, LeaveLike[]>();
  for (const l of lres.results ?? []) {
    const arr = leavesByWorker.get(l.workerId) ?? [];
    arr.push(l);
    leavesByWorker.set(l.workerId, arr);
  }

  const types: EntitledLeaveType[] = ["ANNUAL", "MEDICAL"];
  const data = (wres.results ?? []).map((w) => {
    const mine = leavesByWorker.get(w.id) ?? [];
    const [annual, medical] = types.map((type) =>
      computeLeaveBalance({ leaves: mine, worker: w, type, leaveYear, publicHolidays }),
    );
    return {
      workerId: w.id,
      workerName: w.name,
      leaveYear,
      annualUsed: annual.usedDays,
      annualEntitlement: annual.entitlementDays,
      annualRemaining: annual.remainingDays,
      medicalUsed: medical.usedDays,
      medicalEntitlement: medical.entitlementDays,
      medicalRemaining: medical.remainingDays,
    };
  });

  return c.json({ success: true, data, total: data.length, leaveYear });
});

// POST /api/leaves — create pending leave request
app.post("/", async (c) => {
  const denied = await requirePermission(c, "leaves", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { workerId, type, startDate, endDate, reason } = body;

    if (!workerId || !type || !startDate || !endDate) {
      return c.json(
        { success: false, error: "workerId, type, startDate, endDate are required" },
        400,
      );
    }

    const worker = await c.var.DB.prepare(
      "SELECT id, name FROM workers WHERE id = ?",
    )
      .bind(workerId)
      .first<{ id: string; name: string }>();
    if (!worker) {
      return c.json({ success: false, error: "Worker not found" }, 400);
    }

    const id = genId();
    const now = new Date().toISOString();
    // Derived from the dates, NOT taken from the client's `days`. The two
    // clients that POST here compute the span with two different helpers
    // (`Math.ceil` in employees.tsx, `Math.round` in worker.ts) and the server
    // used to store whatever arrived — bug class C1. The dates fully determine
    // the span, so deriving it is byte-identical for a well-behaved client and
    // correct for every other caller. The holiday exclusion is NOT applied here:
    // `days` keeps meaning the calendar span, and the holidays the owner
    // configures are applied on READ, so that a holiday added later still
    // credits leave already approved across it.
    const daysNum = calendarLeaveDays(startDate, endDate);

    await c.var.DB.prepare(
      `INSERT INTO leaves (id, workerId, workerName, type, startDate, endDate,
         days, status, reason, approvedBy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL, ?, ?)`,
    )
      .bind(
        id,
        workerId,
        worker.name,
        type,
        startDate,
        endDate,
        daysNum,
        reason ?? "",
        now,
        now,
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM leaves WHERE id = ?",
    )
      .bind(id)
      .first<LeaveRow>();
    if (!created) {
      return c.json({ success: false, error: "Failed to create leave" }, 500);
    }
    return c.json({ success: true, data: rowToLeave(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /api/leaves — legacy body-only update `{ id, status, approvedBy }`
app.put("/", async (c) => {
  const denied = await requirePermission(c, "leaves", "update");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { id, status, approvedBy } = body;
    if (!id) {
      return c.json({ success: false, error: "id is required" }, 400);
    }
    const existing = await c.var.DB.prepare(
      "SELECT * FROM leaves WHERE id = ?",
    )
      .bind(id)
      .first<LeaveRow>();
    if (!existing) {
      return c.json({ success: false, error: "Leave record not found" }, 404);
    }
    const nextStatus = status ?? existing.status;
    const nextApprover =
      approvedBy !== undefined ? approvedBy : existing.approvedBy;
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      "UPDATE leaves SET status = ?, approvedBy = ?, updated_at = ? WHERE id = ?",
    )
      .bind(nextStatus, nextApprover, now, id)
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM leaves WHERE id = ?",
    )
      .bind(id)
      .first<LeaveRow>();
    return c.json({ success: true, data: rowToLeave(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /api/leaves/:id — RESTful variant
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "leaves", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM leaves WHERE id = ?",
    )
      .bind(id)
      .first<LeaveRow>();
    if (!existing) {
      return c.json({ success: false, error: "Leave record not found" }, 404);
    }
    const body = await c.req.json();
    const nextStartDate = body.startDate ?? existing.startDate;
    const nextEndDate = body.endDate ?? existing.endDate;
    const datesChanged =
      nextStartDate !== existing.startDate || nextEndDate !== existing.endDate;
    const merged = {
      status: body.status ?? existing.status,
      approvedBy:
        body.approvedBy !== undefined ? body.approvedBy : existing.approvedBy,
      reason: body.reason ?? existing.reason,
      // An explicit `days` is an APPROVER'S deliberate adjustment and is kept.
      // Otherwise the span is re-derived whenever the dates move — previously a
      // date edit left the old day count behind, so the stored span silently
      // stopped matching the stored dates.
      days:
        body.days !== undefined
          ? Number(body.days)
          : datesChanged
            ? calendarLeaveDays(nextStartDate, nextEndDate)
            : existing.days,
      startDate: nextStartDate,
      endDate: nextEndDate,
      type: body.type ?? existing.type,
    };
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      `UPDATE leaves SET status = ?, approvedBy = ?, reason = ?, days = ?,
         startDate = ?, endDate = ?, type = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        merged.status,
        merged.approvedBy,
        merged.reason,
        merged.days,
        merged.startDate,
        merged.endDate,
        merged.type,
        now,
        id,
      )
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM leaves WHERE id = ?",
    )
      .bind(id)
      .first<LeaveRow>();
    return c.json({ success: true, data: rowToLeave(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/leaves/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "leaves", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT * FROM leaves WHERE id = ?")
    .bind(id)
    .first<LeaveRow>();
  if (!existing) {
    return c.json({ success: false, error: "Leave record not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM leaves WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: rowToLeave(existing) });
});

export default app;
