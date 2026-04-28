// ---------------------------------------------------------------------------
// D1-backed lorries (internal fleet) route.
//
// Matches the legacy shape. Old endpoint had only GET + PUT (body-based,
// no `/:id`), so we preserve that and add POST/DELETE/`/:id` for completeness.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

type LorryRow = {
  id: string;
  name: string;
  plateNumber: string;
  capacity: number;
  driverName: string;
  driverContact: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function rowToLorry(row: LorryRow) {
  return {
    id: row.id,
    name: row.name,
    plateNumber: row.plateNumber,
    capacity: row.capacity,
    driverName: row.driverName,
    driverContact: row.driverContact,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function genId(): string {
  return `lorry-${crypto.randomUUID().slice(0, 8)}`;
}

const ALLOWED_STATUS = ["AVAILABLE", "IN_USE", "MAINTENANCE"] as const;

// GET /api/lorries
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    "SELECT * FROM lorries WHERE orgId = ? ORDER BY name",
  )
    .bind(orgId)
    .all<LorryRow>();
  const data = (res.results ?? []).map(rowToLorry);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/lorries
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }
    const id = genId();
    const now = new Date().toISOString();
    const status =
      typeof body.status === "string" &&
      (ALLOWED_STATUS as readonly string[]).includes(body.status)
        ? body.status
        : "AVAILABLE";
    await c.var.DB.prepare(
      `INSERT INTO lorries (id, name, plateNumber, capacity, driverName, driverContact, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        name,
        typeof body.plateNumber === "string" ? body.plateNumber : "",
        Number(body.capacity) || 0,
        typeof body.driverName === "string" ? body.driverName : "",
        typeof body.driverContact === "string" ? body.driverContact : "",
        status,
        now,
        now,
      )
      .run();
    const created = await c.var.DB.prepare(
      "SELECT * FROM lorries WHERE id = ?",
    )
      .bind(id)
      .first<LorryRow>();
    return c.json({ success: true, data: rowToLorry(created!) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /api/lorries — legacy body-only update
app.put("/", async (c) => {
  try {
    const body = await c.req.json();
    const { id } = body;
    if (!id) {
      return c.json({ success: false, error: "id is required" }, 400);
    }
    const existing = await c.var.DB.prepare(
      "SELECT * FROM lorries WHERE id = ?",
    )
      .bind(id)
      .first<LorryRow>();
    if (!existing) {
      return c.json({ success: false, error: "Lorry not found" }, 404);
    }
    const merged = {
      status:
        typeof body.status === "string" &&
        (ALLOWED_STATUS as readonly string[]).includes(body.status)
          ? body.status
          : existing.status,
      driverName:
        body.driverName !== undefined
          ? String(body.driverName || "")
          : existing.driverName,
      driverContact:
        body.driverContact !== undefined
          ? String(body.driverContact || "")
          : existing.driverContact,
    };
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      `UPDATE lorries SET status = ?, driverName = ?, driverContact = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        merged.status,
        merged.driverName,
        merged.driverContact,
        now,
        id,
      )
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM lorries WHERE id = ?",
    )
      .bind(id)
      .first<LorryRow>();
    return c.json({ success: true, data: rowToLorry(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/lorries/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare("SELECT * FROM lorries WHERE id = ?")
    .bind(id)
    .first<LorryRow>();
  if (!row) {
    return c.json({ success: false, error: "Lorry not found" }, 404);
  }
  return c.json({ success: true, data: rowToLorry(row) });
});

// PUT /api/lorries/:id
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM lorries WHERE id = ?",
    )
      .bind(id)
      .first<LorryRow>();
    if (!existing) {
      return c.json({ success: false, error: "Lorry not found" }, 404);
    }
    const body = await c.req.json();
    const merged = {
      name: body.name ?? existing.name,
      plateNumber: body.plateNumber ?? existing.plateNumber,
      capacity:
        body.capacity !== undefined
          ? Number(body.capacity) || 0
          : existing.capacity,
      driverName: body.driverName ?? existing.driverName,
      driverContact: body.driverContact ?? existing.driverContact,
      status:
        typeof body.status === "string" &&
        (ALLOWED_STATUS as readonly string[]).includes(body.status)
          ? body.status
          : existing.status,
    };
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      `UPDATE lorries SET name = ?, plateNumber = ?, capacity = ?,
         driverName = ?, driverContact = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        merged.name,
        merged.plateNumber,
        merged.capacity,
        merged.driverName,
        merged.driverContact,
        merged.status,
        now,
        id,
      )
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM lorries WHERE id = ?",
    )
      .bind(id)
      .first<LorryRow>();
    return c.json({ success: true, data: rowToLorry(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/lorries/:id
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT * FROM lorries WHERE id = ?")
    .bind(id)
    .first<LorryRow>();
  if (!existing) {
    return c.json({ success: false, error: "Lorry not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM lorries WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: rowToLorry(existing) });
});

export default app;
