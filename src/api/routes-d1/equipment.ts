// ---------------------------------------------------------------------------
// D1-backed equipment route.
//
// Matches the legacy `{ success, data, total }` shape. GET /:id returns
// `{ ...equipment, logs }` where logs is the maintenance_logs list. The PUT
// endpoint supports the special `{ logMaintenance: {...} }` body that both
// appends a log row and bumps the equipment's last/next maintenance dates
// (preserving the old in-memory behaviour verbatim).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type EquipmentRow = {
  id: string;
  code: string;
  name: string;
  department: string;
  type: string;
  status: string;
  lastMaintenanceDate: string;
  nextMaintenanceDate: string;
  maintenanceCycleDays: number;
  purchaseDate: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

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

function rowToEquipment(row: EquipmentRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    department: row.department,
    type: row.type,
    status: row.status,
    lastMaintenanceDate: row.lastMaintenanceDate,
    nextMaintenanceDate: row.nextMaintenanceDate,
    maintenanceCycleDays: row.maintenanceCycleDays,
    purchaseDate: row.purchaseDate,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate || new Date().toISOString().split("T")[0]);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// GET /api/equipment
app.get("/", async (c) => {
  const res = await c.var.DB.prepare(
    "SELECT * FROM equipment ORDER BY name",
  ).all<EquipmentRow>();
  const data = (res.results ?? []).map(rowToEquipment);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/equipment
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const id = genId("eq");
    const now = new Date().toISOString();
    const today = now.split("T")[0];
    await c.var.DB.prepare(
      `INSERT INTO equipment (id, code, name, department, type, status,
         lastMaintenanceDate, nextMaintenanceDate, maintenanceCycleDays,
         purchaseDate, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        body.code ?? "",
        body.name ?? "",
        body.department ?? "",
        body.type ?? "OTHER",
        body.status ?? "OPERATIONAL",
        body.lastMaintenanceDate ?? today,
        body.nextMaintenanceDate ?? "",
        Number(body.maintenanceCycleDays) || 30,
        body.purchaseDate ?? today,
        body.notes ?? "",
        now,
        now,
      )
      .run();
    const created = await c.var.DB.prepare(
      "SELECT * FROM equipment WHERE id = ?",
    )
      .bind(id)
      .first<EquipmentRow>();
    return c.json({ success: true, data: rowToEquipment(created!) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/equipment/:id — includes nested logs
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [eq, logsRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM equipment WHERE id = ?")
      .bind(id)
      .first<EquipmentRow>(),
    c.var.DB.prepare(
      "SELECT * FROM maintenance_logs WHERE equipmentId = ? ORDER BY date DESC",
    )
      .bind(id)
      .all<MaintenanceLogRow>(),
  ]);
  if (!eq) {
    return c.json({ success: false, error: "Equipment not found" }, 404);
  }
  const logs = (logsRes.results ?? []).map(rowToLog);
  return c.json({
    success: true,
    data: { ...rowToEquipment(eq), logs },
  });
});

// PUT /api/equipment/:id — either logMaintenance insert OR regular update
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM equipment WHERE id = ?",
    )
      .bind(id)
      .first<EquipmentRow>();
    if (!existing) {
      return c.json({ success: false, error: "Equipment not found" }, 404);
    }
    const body = await c.req.json();
    const now = new Date().toISOString();

    // ── Log-maintenance path ──
    if (body.logMaintenance) {
      const lm = body.logMaintenance;
      const today = now.split("T")[0];
      const logDate = lm.date || today;
      const logId = genId("ml");
      await c.var.DB.prepare(
        `INSERT INTO maintenance_logs (id, equipmentId, equipmentName, type,
           description, performedBy, date, costSen, downtimeHours, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          logId,
          id,
          existing.name,
          lm.type || "PREVENTIVE",
          lm.description || "",
          lm.performedBy || "",
          logDate,
          Number(lm.costSen) || 0,
          Number(lm.downtimeHours) || 0,
          now,
        )
        .run();

      const nextDate = addDays(logDate, existing.maintenanceCycleDays);
      let newStatus = existing.status;
      if (newStatus === "MAINTENANCE" || newStatus === "REPAIR") {
        newStatus = "OPERATIONAL";
      }

      await c.var.DB.prepare(
        `UPDATE equipment SET
           lastMaintenanceDate = ?, nextMaintenanceDate = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(logDate, nextDate, newStatus, now, id)
        .run();

      const [updated, logRow] = await Promise.all([
        c.var.DB.prepare("SELECT * FROM equipment WHERE id = ?")
          .bind(id)
          .first<EquipmentRow>(),
        c.var.DB.prepare("SELECT * FROM maintenance_logs WHERE id = ?")
          .bind(logId)
          .first<MaintenanceLogRow>(),
      ]);
      return c.json({
        success: true,
        data: rowToEquipment(updated!),
        log: rowToLog(logRow!),
      });
    }

    // ── Regular update path ──
    const merged = {
      code: body.code !== undefined ? body.code : existing.code,
      name: body.name !== undefined ? body.name : existing.name,
      department:
        body.department !== undefined ? body.department : existing.department,
      type: body.type !== undefined ? body.type : existing.type,
      status: body.status !== undefined ? body.status : existing.status,
      lastMaintenanceDate:
        body.lastMaintenanceDate !== undefined
          ? body.lastMaintenanceDate
          : existing.lastMaintenanceDate,
      nextMaintenanceDate:
        body.nextMaintenanceDate !== undefined
          ? body.nextMaintenanceDate
          : existing.nextMaintenanceDate,
      maintenanceCycleDays:
        body.maintenanceCycleDays !== undefined
          ? Number(body.maintenanceCycleDays) || 0
          : existing.maintenanceCycleDays,
      notes: body.notes !== undefined ? body.notes : existing.notes,
    };
    await c.var.DB.prepare(
      `UPDATE equipment SET
         code = ?, name = ?, department = ?, type = ?, status = ?,
         lastMaintenanceDate = ?, nextMaintenanceDate = ?, maintenanceCycleDays = ?,
         notes = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        merged.code,
        merged.name,
        merged.department,
        merged.type,
        merged.status,
        merged.lastMaintenanceDate,
        merged.nextMaintenanceDate,
        merged.maintenanceCycleDays,
        merged.notes,
        now,
        id,
      )
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM equipment WHERE id = ?",
    )
      .bind(id)
      .first<EquipmentRow>();
    return c.json({ success: true, data: rowToEquipment(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/equipment/:id
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM equipment WHERE id = ?",
  )
    .bind(id)
    .first<EquipmentRow>();
  if (!existing) {
    return c.json({ success: false, error: "Equipment not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM equipment WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: rowToEquipment(existing) });
});

export default app;
