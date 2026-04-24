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

const app = new Hono<Env>();

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
  created_at: string;
  updated_at: string;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function genId(): string {
  return `lv-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/leaves?workerId=...&status=...
app.get("/", async (c) => {
  const workerId = c.req.query("workerId");
  const status = c.req.query("status");

  const wheres: string[] = [];
  const binds: (string | number)[] = [];
  if (workerId) {
    wheres.push("workerId = ?");
    binds.push(workerId);
  }
  if (status) {
    wheres.push("status = ?");
    binds.push(status);
  }

  const sql = `SELECT * FROM leaves${wheres.length ? " WHERE " + wheres.join(" AND ") : ""} ORDER BY startDate DESC`;
  const res = await c.var.DB.prepare(sql).bind(...binds).all<LeaveRow>();
  const data = (res.results ?? []).map(rowToLeave);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/leaves — create pending leave request
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { workerId, type, startDate, endDate, days, reason } = body;

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
    const daysNum = Number(days) || 1;

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
    const merged = {
      status: body.status ?? existing.status,
      approvedBy:
        body.approvedBy !== undefined ? body.approvedBy : existing.approvedBy,
      reason: body.reason ?? existing.reason,
      days: body.days !== undefined ? Number(body.days) : existing.days,
      startDate: body.startDate ?? existing.startDate,
      endDate: body.endDate ?? existing.endDate,
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
