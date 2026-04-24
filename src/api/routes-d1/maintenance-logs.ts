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
  created_at: string;
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
    createdAt: row.created_at,
  };
}

function genId(): string {
  return `ml-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/maintenance-logs?equipmentId=...
app.get("/", async (c) => {
  const equipmentId = c.req.query("equipmentId");
  const sql = equipmentId
    ? "SELECT * FROM maintenance_logs WHERE equipmentId = ? ORDER BY date DESC"
    : "SELECT * FROM maintenance_logs ORDER BY date DESC";
  const stmt = equipmentId
    ? c.var.DB.prepare(sql).bind(equipmentId)
    : c.var.DB.prepare(sql);
  const res = await stmt.all<MaintenanceLogRow>();
  const data = (res.results ?? []).map(rowToLog);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/maintenance-logs
app.post("/", async (c) => {
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
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      `INSERT INTO maintenance_logs (id, equipmentId, equipmentName, type,
         description, performedBy, date, costSen, downtimeHours, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        now,
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
