// ---------------------------------------------------------------------------
// D1-backed three_pl_vehicles route — per-provider lorries.
//
// Each provider (row in the legacy `drivers` table — see migration 0014's
// naming-misnomer note) can own many vehicles, and pricing follows the
// truck (a 3-ton and a 5-ton from the same dispatcher quote different
// rates). DO POST/PUT looks up the chosen vehicle here to denormalize
// plate + type onto the DO row and recompute deliveryCostSen using the
// vehicle's per-trip + per-extra-drop rates.
//
// Shape mirrors the sibling drivers.ts (companies) route: list returns
// `{ success, data, total }`, single ops `{ success, data }`, errors
// `{ success: false, error }`. List supports ?providerId=... so the
// frontend's provider edit dialog and DO create dialog can scope.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Self-applying schema migration — cargo box dimensions (mig 0159).
//
// Dimensions are in FEET (the unit the owner's fleet is quoted in); the FE
// auto-computes Cap (m³) from them.
//
// The d1-compat adapter rewrites only STATIC-known identifiers; unknown
// camelCase passes through unquoted and Postgres folds it to all-lowercase.
// So the ALTER uses unquoted camelCase (boxLengthFt etc.) which folds to
// boxlengthft / boxwidthft / boxheightft on disk. rowToVehicle() reads with
// dual-key (camelCase ?? folded) to handle both adapter modes. See
// BUG-2026-06-10-001 and BUG-2026-06-11-007 for prior art.
// ---------------------------------------------------------------------------
let pendingMigrations: Promise<void> | null = null;
function ensurePendingMigrations(db: D1Database): Promise<void> {
  if (pendingMigrations) return pendingMigrations;
  pendingMigrations = (async () => {
    const stmts = [
      // 0159 — cargo box L/W/H in feet. Unquoted camelCase folds to lowercase.
      "ALTER TABLE three_pl_vehicles ADD COLUMN IF NOT EXISTS boxLengthFt DOUBLE PRECISION",
      "ALTER TABLE three_pl_vehicles ADD COLUMN IF NOT EXISTS boxWidthFt DOUBLE PRECISION",
      "ALTER TABLE three_pl_vehicles ADD COLUMN IF NOT EXISTS boxHeightFt DOUBLE PRECISION",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        console.warn("[three-pl-vehicles.migrations] ALTER skipped", {
          sql,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
  return pendingMigrations;
}

// ---------------------------------------------------------------------------
// Validation helper for box dimensions.
// Each value, when provided, must be a finite positive number < 100 ft
// (a 40 ft container is the realistic ceiling; 100 catches typos like 450).
// ---------------------------------------------------------------------------
function validateDimension(
  val: unknown,
  label: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (val === undefined || val === null || val === "") {
    return { ok: true, value: null };
  }
  const n = Number(val);
  if (!isFinite(n) || n <= 0) {
    return { ok: false, error: `${label} must be a positive number` };
  }
  if (n >= 100) {
    return { ok: false, error: `${label} must be less than 100 ft` };
  }
  return { ok: true, value: n };
}

type VehicleRow = {
  id: string;
  providerId: string;
  plateNo: string;
  vehicleType: string | null;
  capacityM3: number;
  ratePerTripSen: number;
  ratePerExtraDropSen: number;
  status: string;
  remarks: string | null;
  created_at: string | null;
  updated_at: string | null;
  // Cargo box dimensions — stored as folded-lowercase by Postgres (see above).
  // The adapter may return either the camelCase key (if it rewrites the column)
  // or the folded key; rowToVehicle uses dual-key access for safety.
  boxLengthFt?: number | null;
  boxlengthft?: number | null;
  boxWidthFt?: number | null;
  boxwidthft?: number | null;
  boxHeightFt?: number | null;
  boxheightft?: number | null;
};

function rowToVehicle(row: VehicleRow) {
  return {
    id: row.id,
    providerId: row.providerId,
    plateNo: row.plateNo,
    vehicleType: row.vehicleType ?? "",
    capacityM3: row.capacityM3,
    ratePerTripSen: row.ratePerTripSen,
    ratePerExtraDropSen: row.ratePerExtraDropSen,
    status: row.status,
    remarks: row.remarks ?? "",
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
    // Dual-key reads: folded-lowercase is what Postgres actually stores;
    // camelCase key is a fallback in case the adapter rewrites on a future
    // column-rename-map update.
    boxLengthFt: row.boxLengthFt ?? row.boxlengthft ?? null,
    boxWidthFt: row.boxWidthFt ?? row.boxwidthft ?? null,
    boxHeightFt: row.boxHeightFt ?? row.boxheightft ?? null,
  };
}

function genId(): string {
  return `tpv-${crypto.randomUUID().slice(0, 8)}`;
}

const ALLOWED_STATUS = ["ACTIVE", "INACTIVE"] as const;
type AllowedStatus = (typeof ALLOWED_STATUS)[number];
function coerceStatus(v: unknown, fallback: AllowedStatus = "ACTIVE"): AllowedStatus {
  return typeof v === "string" && (ALLOWED_STATUS as readonly string[]).includes(v)
    ? (v as AllowedStatus)
    : fallback;
}

// GET /api/three-pl-vehicles?providerId=...
app.get("/", async (c) => {
  await ensurePendingMigrations(c.var.DB);
  const orgId = getOrgId(c);
  const providerId = c.req.query("providerId");
  const sql = providerId
    ? "SELECT * FROM three_pl_vehicles WHERE orgId = ? AND providerId = ? ORDER BY plateNo"
    : "SELECT * FROM three_pl_vehicles WHERE orgId = ? ORDER BY plateNo";
  const stmt = providerId
    ? c.var.DB.prepare(sql).bind(orgId, providerId)
    : c.var.DB.prepare(sql).bind(orgId);
  const res = await stmt.all<VehicleRow>();
  const data = (res.results ?? []).map(rowToVehicle);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/three-pl-vehicles
app.post("/", async (c) => {
  const denied = await requirePermission(c, "lorries", "create");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  try {
    const body = await c.req.json();
    const providerId =
      typeof body.providerId === "string" ? body.providerId.trim() : "";
    const plateNo =
      typeof body.plateNo === "string" ? body.plateNo.trim() : "";
    if (!providerId || !plateNo) {
      return c.json(
        { success: false, error: "providerId and plateNo are required" },
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

    // Validate box dimensions.
    const dimL = validateDimension(body.boxLengthFt, "Length");
    if (!dimL.ok) return c.json({ success: false, error: dimL.error }, 400);
    const dimW = validateDimension(body.boxWidthFt, "Width");
    if (!dimW.ok) return c.json({ success: false, error: dimW.error }, 400);
    const dimH = validateDimension(body.boxHeightFt, "Height");
    if (!dimH.ok) return c.json({ success: false, error: dimH.error }, 400);

    const id = genId();
    const now = new Date().toISOString();
    const status = coerceStatus(body.status);
    await c.var.DB.prepare(
      `INSERT INTO three_pl_vehicles (id, providerId, plateNo, vehicleType,
         capacityM3, ratePerTripSen, ratePerExtraDropSen, status, remarks,
         boxLengthFt, boxWidthFt, boxHeightFt,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        providerId,
        plateNo,
        typeof body.vehicleType === "string" ? body.vehicleType.trim() : "",
        Number(body.capacityM3) || 0,
        Number(body.ratePerTripSen) || 0,
        Number(body.ratePerExtraDropSen) || 0,
        status,
        typeof body.remarks === "string" ? body.remarks : "",
        dimL.value,
        dimW.value,
        dimH.value,
        now,
        now,
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM three_pl_vehicles WHERE id = ?",
    )
      .bind(id)
      .first<VehicleRow>();
    return c.json({ success: true, data: rowToVehicle(created!) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/three-pl-vehicles/:id
app.get("/:id", async (c) => {
  await ensurePendingMigrations(c.var.DB);
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM three_pl_vehicles WHERE id = ?",
  )
    .bind(id)
    .first<VehicleRow>();
  if (!row) {
    return c.json({ success: false, error: "Vehicle not found" }, 404);
  }
  return c.json({ success: true, data: rowToVehicle(row) });
});

// PUT /api/three-pl-vehicles/:id
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "lorries", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM three_pl_vehicles WHERE id = ?",
    )
      .bind(id)
      .first<VehicleRow>();
    if (!existing) {
      return c.json({ success: false, error: "Vehicle not found" }, 404);
    }
    const body = await c.req.json();
    const nextStatus = coerceStatus(body.status, existing.status as AllowedStatus);

    // Validate box dimensions when present in the request body.
    const dimL = validateDimension(
      body.boxLengthFt !== undefined ? body.boxLengthFt : undefined,
      "Length",
    );
    if (!dimL.ok) return c.json({ success: false, error: dimL.error }, 400);
    const dimW = validateDimension(
      body.boxWidthFt !== undefined ? body.boxWidthFt : undefined,
      "Width",
    );
    if (!dimW.ok) return c.json({ success: false, error: dimW.error }, 400);
    const dimH = validateDimension(
      body.boxHeightFt !== undefined ? body.boxHeightFt : undefined,
      "Height",
    );
    if (!dimH.ok) return c.json({ success: false, error: dimH.error }, 400);

    // Resolve final dimension values: use incoming if provided, else keep existing.
    const existingL = existing.boxLengthFt ?? existing.boxlengthft ?? null;
    const existingW = existing.boxWidthFt ?? existing.boxwidthft ?? null;
    const existingH = existing.boxHeightFt ?? existing.boxheightft ?? null;
    const nextL = body.boxLengthFt !== undefined ? dimL.value : existingL;
    const nextW = body.boxWidthFt !== undefined ? dimW.value : existingW;
    const nextH = body.boxHeightFt !== undefined ? dimH.value : existingH;

    const merged = {
      plateNo:
        typeof body.plateNo === "string" && body.plateNo.trim()
          ? body.plateNo.trim()
          : existing.plateNo,
      vehicleType:
        body.vehicleType !== undefined
          ? String(body.vehicleType || "")
          : existing.vehicleType ?? "",
      capacityM3:
        body.capacityM3 !== undefined
          ? Number(body.capacityM3) || 0
          : existing.capacityM3,
      ratePerTripSen:
        body.ratePerTripSen !== undefined
          ? Number(body.ratePerTripSen) || 0
          : existing.ratePerTripSen,
      ratePerExtraDropSen:
        body.ratePerExtraDropSen !== undefined
          ? Number(body.ratePerExtraDropSen) || 0
          : existing.ratePerExtraDropSen,
      status: nextStatus,
      remarks:
        body.remarks !== undefined
          ? String(body.remarks || "")
          : existing.remarks ?? "",
    };
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      `UPDATE three_pl_vehicles SET
         plateNo = ?, vehicleType = ?, capacityM3 = ?, ratePerTripSen = ?,
         ratePerExtraDropSen = ?, status = ?, remarks = ?,
         boxLengthFt = ?, boxWidthFt = ?, boxHeightFt = ?,
         updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        merged.plateNo,
        merged.vehicleType,
        merged.capacityM3,
        merged.ratePerTripSen,
        merged.ratePerExtraDropSen,
        merged.status,
        merged.remarks,
        nextL,
        nextW,
        nextH,
        now,
        id,
      )
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM three_pl_vehicles WHERE id = ?",
    )
      .bind(id)
      .first<VehicleRow>();
    return c.json({ success: true, data: rowToVehicle(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/three-pl-vehicles/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "lorries", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM three_pl_vehicles WHERE id = ?",
  )
    .bind(id)
    .first<VehicleRow>();
  if (!existing) {
    return c.json({ success: false, error: "Vehicle not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM three_pl_vehicles WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true, data: rowToVehicle(existing) });
});

export default app;
