// ---------------------------------------------------------------------------
// employee_advances route — the cash the owner hands a worker mid-month.
//
//   GET    /api/employee-advances?period=YYYY-MM[&workerId=]  — list
//   GET    /api/employee-advances/payout-listing?period=      — the HR listing
//   POST   /api/employee-advances                             — record one
//   PUT    /api/employee-advances/:id                         — edit (unsettled)
//   DELETE /api/employee-advances/:id                         — remove (unsettled)
//
// Gated on `payslips` (the same resource the payroll screens use) — an advance
// IS payroll money, and giving it a resource of its own would have handed it to
// every role that can merely read the employee list.
//
// The period an advance belongs to is the month of its DATE; see the reasoning
// in ../lib/employee-advances.ts. Editing/deleting is refused once the period's
// payroll has been approved (status SETTLED) — a 409, not a silent no-op, so
// the operator is told WHY rather than watching a save do nothing.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  ensureAdvanceTables,
  rowToAdvance,
  ADVANCE_SETTLED,
  type AdvanceRow,
} from "../lib/employee-advances";

const app = new Hono<Env>();

const SELECT_COLS =
  "id, worker_id, advance_date, amount_sen, note, entered_by, status, settled_period, created_at";

function genId(): string {
  return `adv-${crypto.randomUUID().slice(0, 8)}`;
}

const ctxGet = (c: Context<Env>, k: string): string =>
  (c as unknown as { get: (k: string) => string | undefined }).get(k) ?? "";

/** YYYY-MM-DD, and a real calendar date (not 2026-02-31). */
function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

/**
 * Amount in integer sen. Money is ALWAYS integer sen in this repo, so a
 * fractional sen is a caller bug (a float that escaped MoneyInput) and is
 * rejected rather than rounded — rounding here would hide the leak.
 */
function parseAmountSen(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// GET /?period=YYYY-MM&workerId=…  — the period's advances (omit period → all)
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const denied = await requirePermission(c, "payslips", "read");
  if (denied) return denied;
  await ensureAdvanceTables(c.var.DB);
  const period = (c.req.query("period") ?? "").trim();
  const workerId = (c.req.query("workerId") ?? "").trim();

  const clauses: string[] = [];
  const binds: string[] = [];
  if (/^\d{4}-\d{2}$/.test(period)) {
    clauses.push("advance_date LIKE ?");
    binds.push(`${period}-%`);
  }
  if (workerId) {
    clauses.push("worker_id = ?");
    binds.push(workerId);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const res = await c.var.DB.prepare(
    `SELECT ${SELECT_COLS} FROM employee_advances${where} ORDER BY advance_date DESC, id`,
  )
    .bind(...binds)
    .all<AdvanceRow>();
  const data = (res.results ?? []).map(rowToAdvance);
  const totalSen = data.reduce((s, r) => s + r.amountSen, 0);
  return c.json({ success: true, data, total: data.length, totalSen });
});

// ---------------------------------------------------------------------------
// GET /payout-listing?period=YYYY-MM
//
// Owner: "可以导出一个我要出钱的 listing 给到我的 HR." ONE row per employee who
// took an advance in the month — who, which days, how much in total. This is
// the sheet the cash is counted against, so it carries the dates rather than a
// single lump sum nobody can check.
//
// Registered BEFORE "/:id" so "payout-listing" is not parsed as an id.
// ---------------------------------------------------------------------------
app.get("/payout-listing", async (c) => {
  const denied = await requirePermission(c, "payslips", "read");
  if (denied) return denied;
  await ensureAdvanceTables(c.var.DB);
  const period = (c.req.query("period") ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return c.json({ success: false, error: "Period (YYYY-MM) is required" }, 400);
  }

  const res = await c.var.DB.prepare(
    `SELECT ${SELECT_COLS} FROM employee_advances WHERE advance_date LIKE ? ORDER BY advance_date, id`,
  )
    .bind(`${period}-%`)
    .all<AdvanceRow>();
  const advances = (res.results ?? []).map(rowToAdvance);

  // Worker identity for the sheet. TEST accounts are excluded for the same
  // reason the payroll list excludes them — they are not real payees.
  const wres = await c.var.DB.prepare(
    "SELECT id, empNo, name, departmentCode FROM workers WHERE empNo NOT LIKE 'TEST%'",
  ).all<{
    id: string;
    empNo: string;
    name: string;
    departmentCode: string | null;
  }>();
  const workerById = new Map((wres.results ?? []).map((w) => [w.id, w] as const));

  const byWorker = new Map<
    string,
    {
      workerId: string;
      employeeNo: string;
      employeeName: string;
      departmentCode: string;
      advances: Array<{ id: string; date: string; amountSen: number; note: string }>;
      totalSen: number;
    }
  >();
  for (const a of advances) {
    const w = workerById.get(a.workerId);
    if (!w) continue; // orphan / TEST account — never handed cash from this sheet
    const row =
      byWorker.get(a.workerId) ?? {
        workerId: a.workerId,
        employeeNo: w.empNo ?? "",
        employeeName: w.name ?? "",
        departmentCode: w.departmentCode ?? "",
        advances: [],
        totalSen: 0,
      };
    row.advances.push({ id: a.id, date: a.date, amountSen: a.amountSen, note: a.note });
    row.totalSen += a.amountSen;
    byWorker.set(a.workerId, row);
  }
  const data = [...byWorker.values()].sort((a, b) =>
    a.employeeNo.localeCompare(b.employeeNo),
  );
  const grandTotalSen = data.reduce((s, r) => s + r.totalSen, 0);
  return c.json({
    success: true,
    data,
    total: data.length,
    period,
    grandTotalSen,
  });
});

// ---------------------------------------------------------------------------
// POST /  — record one advance. Body: { workerId, amountSen, date, note? }
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "payslips", "update");
  if (denied) return denied;
  let body: {
    workerId?: unknown;
    amountSen?: unknown;
    date?: unknown;
    note?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const amountSen = parseAmountSen(body.amountSen);
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!workerId || !isIsoDate(date)) {
    return c.json(
      { success: false, error: "workerId and date (YYYY-MM-DD) are required" },
      400,
    );
  }
  if (amountSen === null) {
    return c.json(
      { success: false, error: "amountSen must be a positive whole number of sen" },
      400,
    );
  }
  // Guard against a stale id — an advance against a worker who does not exist
  // is money that can never be recovered by any payroll run.
  const worker = await c.var.DB.prepare("SELECT id FROM workers WHERE id = ?")
    .bind(workerId)
    .first<{ id: string }>();
  if (!worker) return c.json({ success: false, error: "Worker not found" }, 400);

  // Awaited BEFORE the first write — the table exists on prod only because of
  // this call (migration files are inert on deploy).
  await ensureAdvanceTables(c.var.DB);

  const id = genId();
  await c.var.DB.prepare(
    `INSERT INTO employee_advances
       (id, worker_id, advance_date, amount_sen, note, entered_by, status, org_id)
     VALUES (?, ?, ?, ?, ?, ?, 'UNSETTLED', ?)`,
  )
    .bind(
      id,
      workerId,
      date,
      amountSen,
      note || null,
      ctxGet(c, "userId") || null,
      getOrgId(c),
    )
    .run();
  const row = await c.var.DB.prepare(
    `SELECT ${SELECT_COLS} FROM employee_advances WHERE id = ?`,
  )
    .bind(id)
    .first<AdvanceRow>();
  return c.json({ success: true, data: rowToAdvance(row!) }, 201);
});

// ---------------------------------------------------------------------------
// PUT /:id  — edit amount / date / note while the advance is unsettled.
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "payslips", "update");
  if (denied) return denied;
  await ensureAdvanceTables(c.var.DB);
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    `SELECT ${SELECT_COLS} FROM employee_advances WHERE id = ?`,
  )
    .bind(id)
    .first<AdvanceRow>();
  if (!existing) return c.json({ success: false, error: "Not found" }, 404);
  const current = rowToAdvance(existing);
  if (current.status === ADVANCE_SETTLED) {
    return c.json(
      {
        success: false,
        error:
          "This advance is settled — its payroll period is already approved. Un-approve that period first.",
      },
      409,
    );
  }

  let body: { amountSen?: unknown; date?: unknown; note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const date = body.date === undefined ? current.date : String(body.date).trim();
  const amountSen =
    body.amountSen === undefined ? current.amountSen : parseAmountSen(body.amountSen);
  const note = body.note === undefined ? current.note : String(body.note).trim();
  if (!isIsoDate(date)) {
    return c.json({ success: false, error: "date must be YYYY-MM-DD" }, 400);
  }
  if (amountSen === null) {
    return c.json(
      { success: false, error: "amountSen must be a positive whole number of sen" },
      400,
    );
  }

  await c.var.DB.prepare(
    `UPDATE employee_advances
        SET advance_date = ?, amount_sen = ?, note = ?, updated_at = now()
      WHERE id = ?`,
  )
    .bind(date, amountSen, note || null, id)
    .run();
  const row = await c.var.DB.prepare(
    `SELECT ${SELECT_COLS} FROM employee_advances WHERE id = ?`,
  )
    .bind(id)
    .first<AdvanceRow>();
  return c.json({ success: true, data: rowToAdvance(row!) });
});

// ---------------------------------------------------------------------------
// DELETE /:id  — remove an advance while it is unsettled.
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "payslips", "update");
  if (denied) return denied;
  await ensureAdvanceTables(c.var.DB);
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    `SELECT ${SELECT_COLS} FROM employee_advances WHERE id = ?`,
  )
    .bind(id)
    .first<AdvanceRow>();
  if (!existing) return c.json({ success: false, error: "Not found" }, 404);
  if (rowToAdvance(existing).status === ADVANCE_SETTLED) {
    return c.json(
      {
        success: false,
        error:
          "This advance is settled — its payroll period is already approved. Un-approve that period first.",
      },
      409,
    );
  }
  await c.var.DB.prepare("DELETE FROM employee_advances WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: { id } });
});

export default app;
