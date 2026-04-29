// ---------------------------------------------------------------------------
// D1-backed drivers (3PL providers) route.
//
// Matches the legacy mock shape: list returns `{ success, data, total }`,
// single ops return `{ success, data }`. Money fields are integers in sen.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type DriverRow = {
  id: string;
  name: string;
  phone: string;
  contactPerson: string;
  vehicleNo: string;
  vehicleType: string;
  capacityM3: number;
  ratePerTripSen: number;
  ratePerExtraDropSen: number;
  status: string;
  remarks: string;
  createdAt: string;
  updatedAt: string;
};

function rowToDriver(row: DriverRow) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    contactPerson: row.contactPerson,
    vehicleNo: row.vehicleNo,
    vehicleType: row.vehicleType,
    capacityM3: row.capacityM3,
    ratePerTripSen: row.ratePerTripSen,
    ratePerExtraDropSen: row.ratePerExtraDropSen,
    status: row.status,
    remarks: row.remarks,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function genId(): string {
  return `3pl-${crypto.randomUUID().slice(0, 8)}`;
}

const ALLOWED_STATUS = ["ACTIVE", "INACTIVE", "ON_LEAVE"] as const;
type AllowedStatus = (typeof ALLOWED_STATUS)[number];
function coerceStatus(v: unknown, fallback: AllowedStatus = "ACTIVE"): AllowedStatus {
  return typeof v === "string" && (ALLOWED_STATUS as readonly string[]).includes(v)
    ? (v as AllowedStatus)
    : fallback;
}

// GET /api/drivers
app.get("/", async (c) => {
  const res = await c.var.DB.prepare(
    "SELECT * FROM drivers ORDER BY name",
  ).all<DriverRow>();
  const data = (res.results ?? []).map(rowToDriver);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/drivers
app.post("/", async (c) => {
  const denied = await requirePermission(c, "drivers", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!name || !phone) {
      return c.json(
        { success: false, error: "Name and phone are required" },
        400,
      );
    }
    const id = genId();
    const now = new Date().toISOString();
    const status = coerceStatus(body.status);

    await c.var.DB.prepare(
      `INSERT INTO drivers (id, name, phone, contactPerson, vehicleNo, vehicleType,
         capacityM3, ratePerTripSen, ratePerExtraDropSen, status, remarks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        name,
        phone,
        typeof body.contactPerson === "string" ? body.contactPerson.trim() : "",
        typeof body.vehicleNo === "string" ? body.vehicleNo.trim() : "",
        typeof body.vehicleType === "string" ? body.vehicleType.trim() : "",
        Number(body.capacityM3) || 0,
        Number(body.ratePerTripSen) || 30000,
        Number(body.ratePerExtraDropSen) || 5000,
        status,
        typeof body.remarks === "string" ? body.remarks : "",
        now,
        now,
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM drivers WHERE id = ?",
    )
      .bind(id)
      .first<DriverRow>();
    return c.json({ success: true, data: rowToDriver(created!) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/drivers/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare("SELECT * FROM drivers WHERE id = ?")
    .bind(id)
    .first<DriverRow>();
  if (!row) {
    return c.json({ success: false, error: "3PL provider not found" }, 404);
  }
  return c.json({ success: true, data: rowToDriver(row) });
});

// PUT /api/drivers/:id
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "drivers", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM drivers WHERE id = ?",
    )
      .bind(id)
      .first<DriverRow>();
    if (!existing) {
      return c.json({ success: false, error: "3PL provider not found" }, 404);
    }
    const body = await c.req.json();
    const nextStatus = coerceStatus(body.status, existing.status as AllowedStatus);
    const merged = {
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : existing.name,
      phone:
        typeof body.phone === "string" && body.phone.trim()
          ? body.phone.trim()
          : existing.phone,
      contactPerson:
        body.contactPerson !== undefined
          ? String(body.contactPerson || "")
          : existing.contactPerson,
      vehicleNo:
        body.vehicleNo !== undefined
          ? String(body.vehicleNo || "")
          : existing.vehicleNo,
      vehicleType:
        body.vehicleType !== undefined
          ? String(body.vehicleType || "")
          : existing.vehicleType,
      capacityM3:
        body.capacityM3 !== undefined
          ? Number(body.capacityM3) || 0
          : existing.capacityM3,
      ratePerTripSen:
        body.ratePerTripSen !== undefined
          ? Number(body.ratePerTripSen)
          : existing.ratePerTripSen,
      ratePerExtraDropSen:
        body.ratePerExtraDropSen !== undefined
          ? Number(body.ratePerExtraDropSen)
          : existing.ratePerExtraDropSen,
      status: nextStatus,
      remarks:
        body.remarks !== undefined
          ? String(body.remarks || "")
          : existing.remarks,
    };
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      `UPDATE drivers SET
         name = ?, phone = ?, contactPerson = ?, vehicleNo = ?, vehicleType = ?,
         capacityM3 = ?, ratePerTripSen = ?, ratePerExtraDropSen = ?, status = ?,
         remarks = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        merged.name,
        merged.phone,
        merged.contactPerson,
        merged.vehicleNo,
        merged.vehicleType,
        merged.capacityM3,
        merged.ratePerTripSen,
        merged.ratePerExtraDropSen,
        merged.status,
        merged.remarks,
        now,
        id,
      )
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM drivers WHERE id = ?",
    )
      .bind(id)
      .first<DriverRow>();
    return c.json({ success: true, data: rowToDriver(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/drivers/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "drivers", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT * FROM drivers WHERE id = ?")
    .bind(id)
    .first<DriverRow>();
  if (!existing) {
    return c.json({ success: false, error: "3PL provider not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM drivers WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: rowToDriver(existing) });
});

export default app;
