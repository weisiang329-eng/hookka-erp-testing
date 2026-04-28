// ---------------------------------------------------------------------------
// D1-backed three_pl_drivers route — per-provider individuals.
//
// The legacy `drivers` table holds COMPANIES (3PL providers — see migration
// 0014's naming-misnomer note); this route serves the actual driver people
// each provider employs. Vehicle and driver are independent at DO time —
// the operator picks one of each from this provider's lists.
//
// Shape mirrors three-pl-vehicles.ts: list returns `{ success, data, total }`,
// single ops `{ success, data }`, errors `{ success: false, error }`. List
// supports ?providerId=... so the provider edit dialog + DO dialog can scope.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type DriverRow = {
  id: string;
  providerId: string;
  name: string;
  phone: string | null;
  status: string;
  remarks: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function rowToDriver(row: DriverRow) {
  return {
    id: row.id,
    providerId: row.providerId,
    name: row.name,
    phone: row.phone ?? "",
    status: row.status,
    remarks: row.remarks ?? "",
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

function genId(): string {
  return `tpd-${crypto.randomUUID().slice(0, 8)}`;
}

const ALLOWED_STATUS = ["ACTIVE", "INACTIVE"] as const;
type AllowedStatus = (typeof ALLOWED_STATUS)[number];
function coerceStatus(v: unknown, fallback: AllowedStatus = "ACTIVE"): AllowedStatus {
  return typeof v === "string" && (ALLOWED_STATUS as readonly string[]).includes(v)
    ? (v as AllowedStatus)
    : fallback;
}

// GET /api/three-pl-drivers?providerId=...
app.get("/", async (c) => {
  const providerId = c.req.query("providerId");
  const sql = providerId
    ? "SELECT * FROM three_pl_drivers WHERE providerId = ? ORDER BY name"
    : "SELECT * FROM three_pl_drivers ORDER BY name";
  const stmt = providerId
    ? c.var.DB.prepare(sql).bind(providerId)
    : c.var.DB.prepare(sql);
  const res = await stmt.all<DriverRow>();
  const data = (res.results ?? []).map(rowToDriver);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/three-pl-drivers
app.post("/", async (c) => {
  const denied = await requirePermission(c, "drivers", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const providerId =
      typeof body.providerId === "string" ? body.providerId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!providerId || !name) {
      return c.json(
        { success: false, error: "providerId and name are required" },
        400,
      );
    }
    // FK sanity — referenced provider must exist in `drivers`.
    const provider = await c.var.DB.prepare(
      "SELECT id FROM drivers WHERE id = ?",
    )
      .bind(providerId)
      .first<{ id: string }>();
    if (!provider) {
      return c.json({ success: false, error: "Provider not found" }, 400);
    }

    const id = genId();
    const now = new Date().toISOString();
    const status = coerceStatus(body.status);
    await c.var.DB.prepare(
      `INSERT INTO three_pl_drivers (id, providerId, name, phone, status,
         remarks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        providerId,
        name,
        typeof body.phone === "string" ? body.phone.trim() : "",
        status,
        typeof body.remarks === "string" ? body.remarks : "",
        now,
        now,
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM three_pl_drivers WHERE id = ?",
    )
      .bind(id)
      .first<DriverRow>();
    return c.json({ success: true, data: rowToDriver(created!) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/three-pl-drivers/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM three_pl_drivers WHERE id = ?",
  )
    .bind(id)
    .first<DriverRow>();
  if (!row) {
    return c.json({ success: false, error: "Driver not found" }, 404);
  }
  return c.json({ success: true, data: rowToDriver(row) });
});

// PUT /api/three-pl-drivers/:id
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "drivers", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM three_pl_drivers WHERE id = ?",
    )
      .bind(id)
      .first<DriverRow>();
    if (!existing) {
      return c.json({ success: false, error: "Driver not found" }, 404);
    }
    const body = await c.req.json();
    const nextStatus = coerceStatus(body.status, existing.status as AllowedStatus);
    const merged = {
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : existing.name,
      phone:
        body.phone !== undefined
          ? String(body.phone || "")
          : existing.phone ?? "",
      status: nextStatus,
      remarks:
        body.remarks !== undefined
          ? String(body.remarks || "")
          : existing.remarks ?? "",
    };
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      `UPDATE three_pl_drivers SET
         name = ?, phone = ?, status = ?, remarks = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        merged.name,
        merged.phone,
        merged.status,
        merged.remarks,
        now,
        id,
      )
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM three_pl_drivers WHERE id = ?",
    )
      .bind(id)
      .first<DriverRow>();
    return c.json({ success: true, data: rowToDriver(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/three-pl-drivers/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "drivers", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM three_pl_drivers WHERE id = ?",
  )
    .bind(id)
    .first<DriverRow>();
  if (!existing) {
    return c.json({ success: false, error: "Driver not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM three_pl_drivers WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true, data: rowToDriver(existing) });
});

export default app;
