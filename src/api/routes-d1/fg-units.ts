// ---------------------------------------------------------------------------
// D1-backed FG Unit tracking route.
//
// Mirrors src/api/routes/fg-units.ts shape. One FGUnit = one physical box
// (specific piece of a specific unit in a production order). Stickers print
// per FGUnit. This route handles listing, generating (per PO — idempotent)
// and status transitions driven by QR scans (PACK, LOAD, DELIVER, RETURN).
//
// Schema-note: The `fg_units` table exposes most FGUnit fields natively.
// `pieces` metadata comes from the related Product row (JSON column). We
// use the same unitSerial / shortCode format as the in-memory helper so
// existing stickers keep scanning correctly.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type FGUnitRow = {
  id: string;
  unitSerial: string;
  shortCode: string | null;
  soId: string | null;
  soNo: string | null;
  soLineNo: number | null;
  poId: string | null;
  poNo: string | null;
  productCode: string | null;
  productName: string | null;
  unitNo: number | null;
  totalUnits: number | null;
  pieceNo: number | null;
  totalPieces: number | null;
  pieceName: string | null;
  customerName: string | null;
  customerHub: string | null;
  mfdDate: string | null;
  status: string;
  packerId: string | null;
  packerName: string | null;
  packedAt: string | null;
  loadedAt: string | null;
  deliveredAt: string | null;
  returnedAt: string | null;
  batchId: string | null;
  sourcePieceIndex: number | null;
  sourceSlotIndex: number | null;
  upholsteredBy: string | null;
  upholsteredByName: string | null;
  upholsteredAt: string | null;
  doId: string | null;
};

type ProductionOrderRow = {
  id: string;
  poNo: string;
  salesOrderId: string | null;
  salesOrderNo: string | null;
  lineNo: number;
  customerName: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  quantity: number;
  startDate: string | null;
  completedDate: string | null;
};

type ProductRow = {
  id: string;
  code: string;
  pieces: string | null;
};

type WorkerRow = {
  id: string;
  name: string;
};

type SalesOrderMini = {
  id: string;
  customerId: string;
};

type DeliveryHubMini = {
  shortName: string | null;
};

function rowToFGUnit(r: FGUnitRow) {
  // Build the object with optional fields only when set — matches the
  // in-memory FGUnit shape (undefined vs empty string).
  const out: Record<string, unknown> = {
    id: r.id,
    unitSerial: r.unitSerial,
    shortCode: r.shortCode ?? "",
    soId: r.soId ?? "",
    soNo: r.soNo ?? "",
    soLineNo: r.soLineNo ?? 0,
    poId: r.poId ?? "",
    poNo: r.poNo ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    unitNo: r.unitNo ?? 1,
    totalUnits: r.totalUnits ?? 1,
    pieceNo: r.pieceNo ?? 1,
    totalPieces: r.totalPieces ?? 1,
    pieceName: r.pieceName ?? "",
    customerName: r.customerName ?? "",
    mfdDate: r.mfdDate,
    status: r.status,
  };
  if (r.customerHub) out.customerHub = r.customerHub;
  if (r.packerId) out.packerId = r.packerId;
  if (r.packerName) out.packerName = r.packerName;
  if (r.packedAt) out.packedAt = r.packedAt;
  if (r.loadedAt) out.loadedAt = r.loadedAt;
  if (r.deliveredAt) out.deliveredAt = r.deliveredAt;
  if (r.returnedAt) out.returnedAt = r.returnedAt;
  if (r.batchId) out.batchId = r.batchId;
  if (r.sourcePieceIndex !== null) out.sourcePieceIndex = r.sourcePieceIndex;
  if (r.sourceSlotIndex !== null) out.sourceSlotIndex = r.sourceSlotIndex;
  if (r.upholsteredBy) out.upholsteredBy = r.upholsteredBy;
  if (r.upholsteredByName) out.upholsteredByName = r.upholsteredByName;
  if (r.upholsteredAt) out.upholsteredAt = r.upholsteredAt;
  if (r.doId) out.doId = r.doId;
  return out;
}

function genFGUnitId(poId: string, unitNo: number, pieceNo: number): string {
  return `fgu-${poId}-${unitNo}-${pieceNo}-${crypto.randomUUID().slice(0, 8)}`;
}

function parsePieces(
  raw: string | null,
): { count: number; names: string[] } {
  if (!raw) return { count: 1, names: ["Full Product"] };
  try {
    const parsed = JSON.parse(raw) as { count?: number; names?: string[] };
    if (parsed?.count && parsed.count > 0) {
      return {
        count: parsed.count,
        names: Array.isArray(parsed.names) ? parsed.names : ["Full Product"],
      };
    }
  } catch {
    // fall through
  }
  return { count: 1, names: ["Full Product"] };
}

// ---------------------------------------------------------------------------
// generateFGUnitsForPO — pure helper, used by both the HTTP route below and
// the internal PO-completion cascade in production-orders.ts.
//
// Idempotent: if any fg_units already exist for the given poId, returns them
// untouched with `generated: false`. Otherwise creates one FGUnit per
// (unit, piece) combination derived from PO quantity and product pieces
// metadata, then returns the freshly created rows with `generated: true`.
// ---------------------------------------------------------------------------
export async function generateFGUnitsForPO(
  db: D1Database,
  poId: string,
): Promise<{
  status: "not-found" | "ok";
  generated: boolean;
  units: ReturnType<typeof rowToFGUnit>[];
  po?: ProductionOrderRow;
}> {
  const po = await db
    .prepare(
      `SELECT id, poNo, salesOrderId, salesOrderNo, lineNo, customerName,
         productId, productCode, productName, quantity, startDate, completedDate
       FROM production_orders WHERE id = ?`,
    )
    .bind(poId)
    .first<ProductionOrderRow>();
  if (!po) {
    return { status: "not-found", generated: false, units: [] };
  }

  // Idempotency check — return existing set untouched
  const existingRes = await db
    .prepare("SELECT * FROM fg_units WHERE poId = ? ORDER BY id ASC")
    .bind(poId)
    .all<FGUnitRow>();
  const existing = existingRes.results ?? [];
  if (existing.length > 0) {
    return {
      status: "ok",
      generated: false,
      units: existing.map(rowToFGUnit),
      po,
    };
  }

  // Resolve Product (by id, then by code) to get pieces metadata
  let product: ProductRow | null = null;
  if (po.productId) {
    product = await db
      .prepare("SELECT id, code, pieces FROM products WHERE id = ? LIMIT 1")
      .bind(po.productId)
      .first<ProductRow>();
  }
  if (!product && po.productCode) {
    product = await db
      .prepare("SELECT id, code, pieces FROM products WHERE code = ? LIMIT 1")
      .bind(po.productCode)
      .first<ProductRow>();
  }

  const pieces = parsePieces(product?.pieces ?? null);
  const totalUnits = Math.max(1, po.quantity || 1);
  const totalPieces = pieces.count;

  // Pick a customer hub — best-effort, matches in-memory helper
  let hubShort: string | null = null;
  if (po.salesOrderId) {
    const so = await db
      .prepare("SELECT id, customerId FROM sales_orders WHERE id = ?")
      .bind(po.salesOrderId)
      .first<SalesOrderMini>();
    if (so?.customerId) {
      const hub = await db
        .prepare(
          "SELECT shortName FROM delivery_hubs WHERE customerId = ? ORDER BY isDefault DESC, id ASC LIMIT 1",
        )
        .bind(so.customerId)
        .first<DeliveryHubMini>();
      hubShort = hub?.shortName ?? null;
    }
  }

  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const unitWidth = Math.max(2, String(totalUnits).length);
  const baseBatch = String(100000 + Math.floor(Math.random() * 900000));
  const mfdDate = po.completedDate || po.startDate || null;
  const newUnits: Array<{
    id: string;
    unitSerial: string;
    shortCode: string;
    unitNo: number;
    pieceNo: number;
    pieceName: string;
  }> = [];

  for (let u = 1; u <= totalUnits; u++) {
    for (let p = 1; p <= totalPieces; p++) {
      const pieceName = pieces.names[p - 1] ?? `Piece ${p}`;
      const unitSerial = `${po.salesOrderNo ?? ""}-R${po.lineNo}-U${pad(u, unitWidth)}-P${p}/${totalPieces}`;
      const unitBatch = String(Number(baseBatch) + (u - 1))
        .slice(-6)
        .padStart(6, "0");
      const shortCode = `${unitBatch}-${p}`;
      newUnits.push({
        id: genFGUnitId(po.id, u, p),
        unitSerial,
        shortCode,
        unitNo: u,
        pieceNo: p,
        pieceName,
      });
    }
  }

  const statements = newUnits.map((unit) =>
    db
      .prepare(
        `INSERT INTO fg_units (id, unitSerial, shortCode, soId, soNo, soLineNo,
           poId, poNo, productCode, productName, unitNo, totalUnits,
           pieceNo, totalPieces, pieceName, customerName, customerHub,
           mfdDate, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      )
      .bind(
        unit.id,
        unit.unitSerial,
        unit.shortCode,
        po.salesOrderId ?? null,
        po.salesOrderNo ?? null,
        po.lineNo,
        po.id,
        po.poNo,
        po.productCode ?? null,
        po.productName ?? null,
        unit.unitNo,
        totalUnits,
        unit.pieceNo,
        totalPieces,
        unit.pieceName,
        po.customerName ?? null,
        hubShort,
        mfdDate,
      ),
  );
  if (statements.length > 0) {
    await db.batch(statements);
  }

  const createdRes = await db
    .prepare("SELECT * FROM fg_units WHERE poId = ? ORDER BY id ASC")
    .bind(poId)
    .all<FGUnitRow>();
  const created = createdRes.results ?? [];
  return {
    status: "ok",
    generated: true,
    units: created.map(rowToFGUnit),
    po,
  };
}

// GET /api/fg-units?poId=&soId=&status=&serial=
app.get("/", async (c) => {
  const poId = c.req.query("poId");
  const soId = c.req.query("soId");
  const status = c.req.query("status");
  const serial = c.req.query("serial");

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (poId) {
    clauses.push("poId = ?");
    binds.push(poId);
  }
  if (soId) {
    clauses.push("soId = ?");
    binds.push(soId);
  }
  if (status) {
    clauses.push("status = ?");
    binds.push(status);
  }
  if (serial) {
    clauses.push("(unitSerial = ? OR shortCode = ?)");
    binds.push(serial, serial);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM fg_units ${where} ORDER BY id ASC`;

  const res = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<FGUnitRow>();
  const rows = (res.results ?? []).map(rowToFGUnit);
  return c.json({ success: true, data: rows, total: rows.length });
});

// GET /api/fg-units/:id — single unit
// (must be registered AFTER /generate/:poId and /scan so more specific
// routes match first — Hono picks in insertion order)
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const unit = await c.env.DB.prepare("SELECT * FROM fg_units WHERE id = ?")
    .bind(id)
    .first<FGUnitRow>();
  if (!unit) {
    return c.json({ success: false, error: "Unit not found" }, 404);
  }
  return c.json({ success: true, data: rowToFGUnit(unit) });
});

// POST /api/fg-units/generate/:poId — idempotent
// Thin HTTP wrapper around generateFGUnitsForPO(). Returns existing units
// untouched if already generated; otherwise creates one FGUnit per
// (unit, piece) combination derived from PO quantity and product pieces.
app.post("/generate/:poId", async (c) => {
  const poId = c.req.param("poId");
  const result = await generateFGUnitsForPO(c.env.DB, poId);
  if (result.status === "not-found") {
    return c.json(
      { success: false, error: "Production order not found" },
      404,
    );
  }
  const body = {
    success: true,
    data: result.units,
    total: result.units.length,
    generated: result.generated,
  };
  return result.generated ? c.json(body, 201) : c.json(body);
});

// POST /api/fg-units/scan
// Body: { serial: string, action: "PACK"|"LOAD"|"DELIVER"|"RETURN", workerId?: string }
type ScanAction = "PACK" | "LOAD" | "DELIVER" | "RETURN";
app.post("/scan", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { serial, action, workerId } = body as {
    serial?: string;
    action?: ScanAction;
    workerId?: string;
  };

  if (!serial || !action) {
    return c.json(
      { success: false, error: "serial and action are required" },
      400,
    );
  }

  const unit = await c.env.DB.prepare(
    "SELECT * FROM fg_units WHERE unitSerial = ? OR shortCode = ? LIMIT 1",
  )
    .bind(serial, serial)
    .first<FGUnitRow>();
  if (!unit) {
    return c.json(
      { success: false, error: `Unit not found for serial "${serial}"` },
      404,
    );
  }

  const now = new Date().toISOString();
  let updateSql = "";
  let binds: unknown[] = [];

  switch (action) {
    case "PACK": {
      if (unit.status !== "PENDING") {
        return c.json(
          {
            success: false,
            error: `Cannot PACK — unit already ${unit.status}`,
          },
          400,
        );
      }
      if (!workerId) {
        return c.json(
          { success: false, error: "workerId required for PACK action" },
          400,
        );
      }
      const worker = await c.env.DB.prepare(
        "SELECT id, name FROM workers WHERE id = ?",
      )
        .bind(workerId)
        .first<WorkerRow>();
      if (!worker) {
        return c.json({ success: false, error: "Worker not found" }, 400);
      }
      updateSql =
        "UPDATE fg_units SET status = 'PACKED', packerId = ?, packerName = ?, packedAt = ? WHERE id = ?";
      binds = [worker.id, worker.name, now, unit.id];
      break;
    }
    case "LOAD": {
      if (unit.status !== "PACKED") {
        return c.json(
          {
            success: false,
            error: `Cannot LOAD — unit is ${unit.status}, must be PACKED first`,
          },
          400,
        );
      }
      updateSql =
        "UPDATE fg_units SET status = 'LOADED', loadedAt = ? WHERE id = ?";
      binds = [now, unit.id];
      break;
    }
    case "DELIVER": {
      if (unit.status !== "LOADED") {
        return c.json(
          {
            success: false,
            error: `Cannot DELIVER — unit is ${unit.status}, must be LOADED first`,
          },
          400,
        );
      }
      updateSql =
        "UPDATE fg_units SET status = 'DELIVERED', deliveredAt = ? WHERE id = ?";
      binds = [now, unit.id];
      break;
    }
    case "RETURN": {
      // Returns can come from any state (customer rejection, damage, etc.)
      updateSql =
        "UPDATE fg_units SET status = 'RETURNED', returnedAt = ? WHERE id = ?";
      binds = [now, unit.id];
      break;
    }
    default:
      return c.json(
        { success: false, error: `Unknown action "${action}"` },
        400,
      );
  }

  await c.env.DB.prepare(updateSql)
    .bind(...binds)
    .run();

  const updated = await c.env.DB.prepare("SELECT * FROM fg_units WHERE id = ?")
    .bind(unit.id)
    .first<FGUnitRow>();
  return c.json({ success: true, data: updated ? rowToFGUnit(updated) : null });
});

export default app;
