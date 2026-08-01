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
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

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
  // Asset identity + provenance (owner 2026-08-01). Runtime self-applied —
  // migration files are inert on deploy (CLAUDE.md). snake_case in the DB,
  // dual-keyed on read because the Supabase adapter folds either way.
  model?: string | null;
  serialNo?: string | null;
  serial_no?: string | null;
  manufacturer?: string | null;
  supplier?: string | null;
  purchasePriceSen?: number | null;
  purchase_price_sen?: number | null;
  warrantyExpiry?: string | null;
  warranty_expiry?: string | null;
  createdAt: string;
  updatedAt: string;
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
  createdAt: string;
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
    model: row.model ?? "",
    serialNo: row.serialNo ?? row.serial_no ?? "",
    manufacturer: row.manufacturer ?? "",
    supplier: row.supplier ?? "",
    // Money is integer sen everywhere in this system (CLAUDE.md) — never a
    // float. The form sends ringgit and converts on the way in.
    purchasePriceSen: Number(row.purchasePriceSen ?? row.purchase_price_sen ?? 0) || 0,
    warrantyExpiry: row.warrantyExpiry ?? row.warranty_expiry ?? "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
    createdAt: row.createdAt,
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
  await ensureEquipmentAssetColumns(c.var.DB);
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    "SELECT * FROM equipment WHERE orgId = ? ORDER BY name",
  )
    .bind(orgId)
    .all<EquipmentRow>();
  const data = (res.results ?? []).map(rowToEquipment);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/equipment
// The asset-identity columns were added 2026-08-01. Migration files are inert
// on deploy (CLAUDE.md), so the columns have to be self-applied at runtime
// before the first write that names them. Idempotent, once per isolate; a
// failure is logged rather than thrown so the module keeps working on an engine
// that lacks IF NOT EXISTS.
let _equipColsMig: Promise<void> | null = null;
function ensureEquipmentAssetColumns(db: D1Database): Promise<void> {
  if (!_equipColsMig) {
    _equipColsMig = (async () => {
      for (const sql of [
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS serial_no TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS manufacturer TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS supplier TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS purchase_price_sen INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS warranty_expiry TEXT NOT NULL DEFAULT ''",
      ]) {
        try {
          await db.prepare(sql).run();
        } catch (e) {
          console.warn(
            "[equipment] column ensure:",
            e instanceof Error ? e.message : e,
          );
        }
      }
    })();
  }
  return _equipColsMig;
}

/** Ringgit (what the form sends) → integer sen (what everything stores). */
function toSen(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

app.post("/", async (c) => {
  const denied = await requirePermission(c, "equipment", "create");
  if (denied) return denied;
  try {
    await ensureEquipmentAssetColumns(c.var.DB);
    const body = await c.req.json();
    const id = genId("eq");
    const now = new Date().toISOString();
    const today = now.split("T")[0];
    await c.var.DB.prepare(
      `INSERT INTO equipment (id, code, name, department, type, status,
         lastMaintenanceDate, nextMaintenanceDate, maintenanceCycleDays,
         purchaseDate, notes, model, serial_no, manufacturer, supplier,
         purchase_price_sen, warranty_expiry, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        body.model ?? "",
        body.serialNo ?? "",
        body.manufacturer ?? "",
        body.supplier ?? "",
        toSen(body.purchasePriceRM),
        body.warrantyExpiry ?? "",
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
  const denied = await requirePermission(c, "equipment", "update");
  if (denied) return denied;
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
    await ensureEquipmentAssetColumns(c.var.DB);
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
    // Same "only overwrite what was sent" rule as the existing fields, so a
    // partial PUT from one dialog can't blank what another dialog owns.
    const pick = <T,>(fresh: T | undefined, current: T): T =>
      fresh === undefined ? current : fresh;
    const merged = {
      model: pick(body.model, existing.model ?? ""),
      serialNo: pick(body.serialNo, existing.serialNo ?? existing.serial_no ?? ""),
      manufacturer: pick(body.manufacturer, existing.manufacturer ?? ""),
      supplier: pick(body.supplier, existing.supplier ?? ""),
      // The form sends ringgit; storage is integer sen.
      purchasePriceSen:
        body.purchasePriceRM !== undefined
          ? toSen(body.purchasePriceRM)
          : Number(existing.purchasePriceSen ?? existing.purchase_price_sen ?? 0) || 0,
      warrantyExpiry: pick(
        body.warrantyExpiry,
        existing.warrantyExpiry ?? existing.warranty_expiry ?? "",
      ),
      purchaseDate: pick(body.purchaseDate, existing.purchaseDate ?? ""),
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
         notes = ?, model = ?, serial_no = ?, manufacturer = ?, supplier = ?,
         purchase_price_sen = ?, warranty_expiry = ?, purchaseDate = ?, updated_at = ?
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
        merged.model,
        merged.serialNo,
        merged.manufacturer,
        merged.supplier,
        merged.purchasePriceSen,
        merged.warrantyExpiry,
        merged.purchaseDate,
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
  const denied = await requirePermission(c, "equipment", "delete");
  if (denied) return denied;
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
