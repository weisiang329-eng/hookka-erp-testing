// ---------------------------------------------------------------------------
// D1-backed maintenance-logs route.
//
// Legacy route only exposed GET (read-only aggregate), so that's what the
// SPA expects here. We add POST/DELETE for completeness but the shape of
// GET is the primary compatibility target. Most log inserts happen via
// PUT /api/equipment/:id with a `logMaintenance` body.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

type MaintenanceLogRow = {
  id: string;
  equipmentId: string;
  equipmentName: string;
  type: string;
  description: string;
  performedBy: string;
  date: string;
  costSen: number;
  downtimeHours: number;
  // The production table has no created_at (0001_init's shape — see the POST
  // handler), so this never arrives. Typed optional rather than asserted.
  createdAt?: string | null;
};

function rowToLog(row: MaintenanceLogRow) {
  return {
    id: row.id,
    equipmentId: row.equipmentId,
    equipmentName: row.equipmentName,
    type: row.type,
    description: row.description,
    performedBy: row.performedBy,
    date: row.date,
    costSen: row.costSen,
    downtimeHours: row.downtimeHours,
    createdAt: row.createdAt ?? null,
  };
}

function genId(): string {
  return `ml-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/maintenance-logs?equipmentId=...
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const equipmentId = c.req.query("equipmentId");
  const sql = equipmentId
    ? "SELECT * FROM maintenance_logs WHERE orgId = ? AND equipmentId = ? ORDER BY date DESC"
    : "SELECT * FROM maintenance_logs WHERE orgId = ? ORDER BY date DESC";
  const stmt = equipmentId
    ? c.var.DB.prepare(sql).bind(orgId, equipmentId)
    : c.var.DB.prepare(sql).bind(orgId);
  const res = await stmt.all<MaintenanceLogRow>();
  const data = (res.results ?? []).map(rowToLog);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/maintenance-logs
app.post("/", async (c) => {
  const denied = await requirePermission(c, "maintenance-logs", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    if (!body.equipmentId || !body.date) {
      return c.json(
        { success: false, error: "equipmentId and date are required" },
        400,
      );
    }
    const eq = await c.var.DB.prepare(
      "SELECT id, name FROM equipment WHERE id = ?",
    )
      .bind(body.equipmentId)
      .first<{ id: string; name: string }>();
    if (!eq) {
      return c.json({ success: false, error: "Equipment not found" }, 400);
    }
    const id = genId();
    await c.var.DB.prepare(
      // NOTE: `maintenance_logs` in production is 0001_init's table — no
      // created_at. 0015_equipment_maintenance.sql, which declares one, is a
      // `CREATE TABLE IF NOT EXISTS` and was a no-op against the existing
      // table, and no runtime self-apply adds it. Naming it here made the
      // INSERT throw into the catch below and answer 400 "Invalid request
      // body". (BUG-2026-08-13-031)
      `INSERT INTO maintenance_logs (id, equipmentId, equipmentName, type,
         description, performedBy, date, costSen, downtimeHours)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        body.equipmentId,
        eq.name,
        body.type || "PREVENTIVE",
        body.description || "",
        body.performedBy || "",
        body.date,
        Number(body.costSen) || 0,
        Number(body.downtimeHours) || 0,
      )
      .run();
    const created = await c.var.DB.prepare(
      "SELECT * FROM maintenance_logs WHERE id = ?",
    )
      .bind(id)
      .first<MaintenanceLogRow>();
    return c.json({ success: true, data: rowToLog(created!) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/maintenance-logs/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM maintenance_logs WHERE id = ?",
  )
    .bind(id)
    .first<MaintenanceLogRow>();
  if (!row) {
    return c.json(
      { success: false, error: "Maintenance log not found" },
      404,
    );
  }
  return c.json({ success: true, data: rowToLog(row) });
});

// DELETE /api/maintenance-logs/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "maintenance-logs", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM maintenance_logs WHERE id = ?",
  )
    .bind(id)
    .first<MaintenanceLogRow>();
  if (!existing) {
    return c.json(
      { success: false, error: "Maintenance log not found" },
      404,
    );
  }
  await c.var.DB.prepare("DELETE FROM maintenance_logs WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true, data: rowToLog(existing) });
});

export default app;
