// ---------------------------------------------------------------------------
// D1-backed Raw Materials CRUD.
//
// GET    /api/raw-materials             -> list all (optional ?status=)
// GET    /api/raw-materials/:id         -> one
// POST   /api/raw-materials             -> create
// PUT    /api/raw-materials/:id         -> update
// DELETE /api/raw-materials/:id         -> delete
// POST   /api/raw-materials/bulk-import -> upsert an array of rows
//                                          body: { rows: [...] }
//
// The legacy /api/inventory endpoint already surfaces raw materials in its
// aggregated payload (see routes/inventory.ts). This route exposes the
// CRUD surface that the Inventory page + batch-import dialog call directly.
//
// Schema note: 0008_raw_materials.sql added minStock/maxStock/status/notes/
// created_at/updated_at on top of the 0001 base schema. 0024 added AutoCount
// mirror fields (uomCount/itemType/stockControl/mainSupplierCode).
// `baseUOM` / `unit` are the same column — we accept either key in POST/PUT
// bodies for consistency with the Inventory form + the mock-data RawMaterial
// type (which uses baseUOM). API response always exposes both `baseUOM` and
// `unit` with the same value for backwards compatibility.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { checkRawMaterialDeleteLocked, lockedResponse } from "../lib/lock-helpers";
import {
  buildFabricDeleteStatements,
  buildFabricUpsertStatements,
  countActiveSalesOrderRefs,
  isFabricGroup,
} from "./_fabric-cascade";

const app = new Hono<Env>();

type RawMaterialRow = {
  id: string;
  itemCode: string;
  description: string;
  baseUOM: string;
  itemGroup: string;
  isActive: number;
  balanceQty: number;
  minStock: number;
  maxStock: number;
  status: string;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  uomCount: number | null;
  itemType: string | null;
  stockControl: number | null;
  mainSupplierCode: string | null;
};

type RawMaterialBody = {
  itemCode?: string;
  description?: string;
  baseUOM?: string;
  unit?: string;
  itemGroup?: string;
  isActive?: boolean;
  balanceQty?: number;
  minStock?: number;
  maxStock?: number;
  status?: string;
  notes?: string | null;
  uomCount?: number;
  itemType?: string | null;
  stockControl?: boolean | number;
  mainSupplierCode?: string | null;
};

function rowToApi(r: RawMaterialRow) {
  return {
    id: r.id,
    itemCode: r.itemCode,
    description: r.description,
    baseUOM: r.baseUOM,
    unit: r.baseUOM, // alias for UI that expects `unit`
    itemGroup: r.itemGroup,
    isActive: r.isActive === 1,
    balanceQty: r.balanceQty,
    minStock: r.minStock ?? 0,
    maxStock: r.maxStock ?? 0,
    status: r.status ?? (r.isActive === 1 ? "ACTIVE" : "INACTIVE"),
    notes: r.notes ?? "",
    created_at: r.createdAt ?? "",
    updated_at: r.updatedAt ?? "",
    uomCount: r.uomCount ?? 1,
    itemType: r.itemType ?? null,
    stockControl: (r.stockControl ?? 1) === 1,
    mainSupplierCode: r.mainSupplierCode ?? null,
  };
}

function stockControlFromBody(body: RawMaterialBody, fallback = 1): number {
  if (body.stockControl === undefined) return fallback;
  if (typeof body.stockControl === "boolean") return body.stockControl ? 1 : 0;
  return Number(body.stockControl) === 0 ? 0 : 1;
}

function genId(): string {
  return `rm-${crypto.randomUUID().slice(0, 8)}`;
}

/** Pick baseUOM value from either `baseUOM` or `unit` body key. */
function pickUnit(body: RawMaterialBody, fallback = "PCS"): string {
  if (typeof body.baseUOM === "string" && body.baseUOM.trim()) return body.baseUOM.trim();
  if (typeof body.unit === "string" && body.unit.trim()) return body.unit.trim();
  return fallback;
}

function statusFromBody(body: RawMaterialBody, fallback = "ACTIVE"): string {
  if (typeof body.status === "string" && body.status.trim()) return body.status.trim();
  if (body.isActive === false) return "INACTIVE";
  if (body.isActive === true) return "ACTIVE";
  return fallback;
}

// GET /api/raw-materials  (optional ?status=ACTIVE)
app.get("/", async (c) => {
  const status = c.req.query("status");
  const sql = status
    ? "SELECT * FROM raw_materials WHERE status = ? ORDER BY itemCode"
    : "SELECT * FROM raw_materials ORDER BY itemCode";
  const stmt = status
    ? c.var.DB.prepare(sql).bind(status)
    : c.var.DB.prepare(sql);
  const res = await stmt.all<RawMaterialRow>();
  const data = (res.results ?? []).map(rowToApi);
  return c.json({ success: true, data, total: data.length });
});

// GET /api/raw-materials/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM raw_materials WHERE id = ?",
  )
    .bind(id)
    .first<RawMaterialRow>();
  if (!row) {
    return c.json({ success: false, error: "Raw material not found" }, 404);
  }
  return c.json({ success: true, data: rowToApi(row) });
});

// POST /api/raw-materials
app.post("/", async (c) => {
  let body: RawMaterialBody;
  try {
    body = (await c.req.json()) as RawMaterialBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const itemCode = (body.itemCode ?? "").trim();
  const description = (body.description ?? "").trim();
  if (!itemCode || !description) {
    return c.json(
      { success: false, error: "itemCode and description are required" },
      400,
    );
  }

  const existing = await c.var.DB.prepare(
    "SELECT id FROM raw_materials WHERE itemCode = ? LIMIT 1",
  )
    .bind(itemCode)
    .first<{ id: string }>();
  if (existing) {
    return c.json(
      { success: false, error: `Raw material ${itemCode} already exists` },
      400,
    );
  }

  const id = genId();
  const baseUOM = pickUnit(body);
  const itemGroup = (body.itemGroup ?? "OTHERS").trim() || "OTHERS";
  const status = statusFromBody(body);
  const isActive = status === "ACTIVE" ? 1 : 0;
  const balanceQty = Number(body.balanceQty) || 0;
  const minStock = Number(body.minStock) || 0;
  const maxStock = Number(body.maxStock) || 0;
  const notes = typeof body.notes === "string" ? body.notes : null;
  const uomCount = body.uomCount !== undefined && Number.isFinite(Number(body.uomCount))
    ? Number(body.uomCount)
    : 1;
  const itemType = typeof body.itemType === "string" && body.itemType.trim()
    ? body.itemType.trim()
    : null;
  const stockControl = stockControlFromBody(body);
  const mainSupplierCode = typeof body.mainSupplierCode === "string" && body.mainSupplierCode.trim()
    ? body.mainSupplierCode.trim()
    : null;
  const nowIso = new Date().toISOString();

  const insertStmt = c.var.DB.prepare(
    `INSERT INTO raw_materials
       (id, itemCode, description, baseUOM, itemGroup, isActive, balanceQty,
        minStock, maxStock, status, notes, created_at, updated_at,
        uomCount, itemType, stockControl, mainSupplierCode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    itemCode,
    description,
    baseUOM,
    itemGroup,
    isActive,
    balanceQty,
    minStock,
    maxStock,
    status,
    notes,
    nowIso,
    nowIso,
    uomCount,
    itemType,
    stockControl,
    mainSupplierCode,
  );

  // If this row is a fabric group, cascade into fabrics + fabric_trackings
  // atomically in a single batch. Non-fabrics take the single-statement path.
  if (isFabricGroup(itemGroup)) {
    const cascadeStmts = await buildFabricUpsertStatements(c.var.DB, {
      itemCode,
      description,
      itemGroup,
      balanceQty,
    });
    await c.var.DB.batch([insertStmt, ...cascadeStmts]);
  } else {
    await insertStmt.run();
  }

  const created = await c.var.DB.prepare(
    "SELECT * FROM raw_materials WHERE id = ?",
  )
    .bind(id)
    .first<RawMaterialRow>();
  if (!created) {
    return c.json(
      { success: false, error: "Failed to create raw material" },
      500,
    );
  }
  return c.json({ success: true, data: rowToApi(created) }, 201);
});

// PUT /api/raw-materials/:id
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM raw_materials WHERE id = ?",
  )
    .bind(id)
    .first<RawMaterialRow>();
  if (!existing) {
    return c.json({ success: false, error: "Raw material not found" }, 404);
  }
  let body: RawMaterialBody;
  try {
    body = (await c.req.json()) as RawMaterialBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  // Reject itemCode collisions on rename.
  if (body.itemCode && body.itemCode !== existing.itemCode) {
    const dupe = await c.var.DB.prepare(
      "SELECT id FROM raw_materials WHERE itemCode = ? AND id != ? LIMIT 1",
    )
      .bind(body.itemCode, id)
      .first<{ id: string }>();
    if (dupe) {
      return c.json(
        { success: false, error: `Raw material ${body.itemCode} already exists` },
        400,
      );
    }
  }

  const merged = {
    itemCode: body.itemCode ?? existing.itemCode,
    description: body.description ?? existing.description,
    baseUOM: pickUnit(body, existing.baseUOM),
    itemGroup: body.itemGroup ?? existing.itemGroup,
    balanceQty:
      body.balanceQty !== undefined ? Number(body.balanceQty) : existing.balanceQty,
    minStock:
      body.minStock !== undefined ? Number(body.minStock) : existing.minStock ?? 0,
    maxStock:
      body.maxStock !== undefined ? Number(body.maxStock) : existing.maxStock ?? 0,
    status: statusFromBody(body, existing.status ?? "ACTIVE"),
    notes: body.notes !== undefined ? body.notes : existing.notes,
    uomCount:
      body.uomCount !== undefined && Number.isFinite(Number(body.uomCount))
        ? Number(body.uomCount)
        : existing.uomCount ?? 1,
    itemType:
      body.itemType !== undefined
        ? (typeof body.itemType === "string" && body.itemType.trim()
            ? body.itemType.trim()
            : null)
        : existing.itemType,
    stockControl:
      body.stockControl !== undefined
        ? stockControlFromBody(body, existing.stockControl ?? 1)
        : existing.stockControl ?? 1,
    mainSupplierCode:
      body.mainSupplierCode !== undefined
        ? (typeof body.mainSupplierCode === "string" && body.mainSupplierCode.trim()
            ? body.mainSupplierCode.trim()
            : null)
        : existing.mainSupplierCode,
  };
  const isActive = merged.status === "ACTIVE" ? 1 : 0;
  const nowIso = new Date().toISOString();

  const updateStmt = c.var.DB.prepare(
    `UPDATE raw_materials SET
       itemCode = ?, description = ?, baseUOM = ?, itemGroup = ?,
       isActive = ?, balanceQty = ?, minStock = ?, maxStock = ?,
       status = ?, notes = ?, updated_at = ?,
       uomCount = ?, itemType = ?, stockControl = ?, mainSupplierCode = ?
     WHERE id = ?`,
  ).bind(
    merged.itemCode,
    merged.description,
    merged.baseUOM,
    merged.itemGroup,
    isActive,
    merged.balanceQty,
    merged.minStock,
    merged.maxStock,
    merged.status,
    merged.notes,
    nowIso,
    merged.uomCount,
    merged.itemType,
    merged.stockControl,
    merged.mainSupplierCode,
    id,
  );

  // Fabric cascade with transition handling:
  //   was fabric  → now fabric  : upsert mirror rows (code may have renamed).
  //   was fabric  → not fabric  : delete old mirror rows.
  //   not fabric  → now fabric  : insert new mirror rows.
  //   neither                   : plain update.
  const wasFabric = isFabricGroup(existing.itemGroup);
  const isFab = isFabricGroup(merged.itemGroup);
  const cascadeStmts: D1PreparedStatement[] = [];
  if (wasFabric && isFab) {
    // If the code changed, drop old mirror rows (old code) then upsert new.
    if (existing.itemCode !== merged.itemCode) {
      cascadeStmts.push(
        ...buildFabricDeleteStatements(c.var.DB, existing.itemCode),
      );
    }
    cascadeStmts.push(
      ...(await buildFabricUpsertStatements(c.var.DB, {
        itemCode: merged.itemCode,
        description: merged.description,
        itemGroup: merged.itemGroup,
        balanceQty: merged.balanceQty,
      })),
    );
  } else if (wasFabric && !isFab) {
    cascadeStmts.push(
      ...buildFabricDeleteStatements(c.var.DB, existing.itemCode),
    );
  } else if (!wasFabric && isFab) {
    cascadeStmts.push(
      ...(await buildFabricUpsertStatements(c.var.DB, {
        itemCode: merged.itemCode,
        description: merged.description,
        itemGroup: merged.itemGroup,
        balanceQty: merged.balanceQty,
      })),
    );
  }

  if (cascadeStmts.length > 0) {
    await c.var.DB.batch([updateStmt, ...cascadeStmts]);
  } else {
    await updateStmt.run();
  }

  const updated = await c.var.DB.prepare(
    "SELECT * FROM raw_materials WHERE id = ?",
  )
    .bind(id)
    .first<RawMaterialRow>();
  if (!updated) {
    return c.json(
      { success: false, error: "Failed to reload raw material" },
      500,
    );
  }
  return c.json({ success: true, data: rowToApi(updated) });
});

// DELETE /api/raw-materials/:id
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM raw_materials WHERE id = ?",
  )
    .bind(id)
    .first<RawMaterialRow>();
  if (!existing) {
    return c.json({ success: false, error: "Raw material not found" }, 404);
  }

  // Cascade-lock guard: refuse deletion if the material is still referenced
  // by an active BOM component, a pending purchase-order line, or has any
  // batch on hand. This catches BOTH fabric and non-fabric items.
  const lockMsg = await checkRawMaterialDeleteLocked(
    c.var.DB,
    existing.itemCode,
  );
  if (lockMsg) {
    return c.json(lockedResponse(lockMsg), 409);
  }

  // Fabric extra guard: block deletion if any active (non-cancelled)
  // sales_order_items still reference this fabricCode. Then cascade-delete
  // the fabric mirror rows; FK cascade handles rm_batches for non-fabric.
  if (isFabricGroup(existing.itemGroup)) {
    const refs = await countActiveSalesOrderRefs(c.var.DB, existing.itemCode);
    if (refs > 0) {
      return c.json(
        {
          success: false,
          error: `Cannot delete fabric ${existing.itemCode}: still referenced by ${refs} active sales order line(s)`,
        },
        409,
      );
    }
    const cascadeStmts = buildFabricDeleteStatements(c.var.DB, existing.itemCode);
    await c.var.DB.batch([
      c.var.DB.prepare("DELETE FROM raw_materials WHERE id = ?").bind(id),
      ...cascadeStmts,
    ]);
  } else {
    // FK cascade on rm_batches.rmId removes dependent batch rows.
    await c.var.DB.prepare("DELETE FROM raw_materials WHERE id = ?")
      .bind(id)
      .run();
  }
  return c.json({ success: true, data: rowToApi(existing) });
});

// POST /api/raw-materials/bulk-import
// Upserts by itemCode.  Body: { rows: RawMaterialBody[] }
//
// IMPORTANT: On UPDATE we DO NOT touch balanceQty — D1 is the source of truth
// for current stock (GRNs keep it fresh; the AutoCount sheet's `Total Bal.
// Qty` gets stale the moment a GRN posts). On INSERT balanceQty defaults
// to 0; the first GRN against the new code will bring it up to level.
app.post("/bulk-import", async (c) => {
  let body: { rows?: RawMaterialBody[] };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return c.json({ success: true, data: { created: 0, updated: 0 } });
  }

  // Fetch existing itemCodes in one shot for the match test.
  const existingRes = await c.var.DB.prepare(
    "SELECT id, itemCode FROM raw_materials",
  ).all<{ id: string; itemCode: string }>();
  const codeToId = new Map<string, string>();
  for (const r of existingRes.results ?? []) codeToId.set(r.itemCode, r.id);

  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  let created = 0;
  let updated = 0;

  for (const r of rows) {
    const itemCode = (r.itemCode ?? "").trim();
    if (!itemCode) continue;
    const description = (r.description ?? "").trim() || itemCode;
    const baseUOM = pickUnit(r);
    const itemGroup = (r.itemGroup ?? "OTHERS").trim() || "OTHERS";
    const status = statusFromBody(r);
    const isActive = status === "ACTIVE" ? 1 : 0;
    const minStock = Number(r.minStock) || 0;
    const maxStock = Number(r.maxStock) || 0;
    const notes = typeof r.notes === "string" ? r.notes : null;
    const uomCount = r.uomCount !== undefined && Number.isFinite(Number(r.uomCount))
      ? Number(r.uomCount)
      : 1;
    const itemType = typeof r.itemType === "string" && r.itemType.trim()
      ? r.itemType.trim()
      : null;
    const stockControl = stockControlFromBody(r);
    const mainSupplierCode = typeof r.mainSupplierCode === "string" && r.mainSupplierCode.trim()
      ? r.mainSupplierCode.trim()
      : null;

    const existingId = codeToId.get(itemCode);
    if (existingId) {
      // UPDATE — do NOT touch balanceQty (preserve current stock level).
      statements.push(
        c.var.DB.prepare(
          `UPDATE raw_materials SET
             description = ?, baseUOM = ?, itemGroup = ?, isActive = ?,
             minStock = ?, maxStock = ?, status = ?,
             notes = ?, updated_at = ?,
             uomCount = ?, itemType = ?, stockControl = ?, mainSupplierCode = ?
           WHERE id = ?`,
        ).bind(
          description,
          baseUOM,
          itemGroup,
          isActive,
          minStock,
          maxStock,
          status,
          notes,
          nowIso,
          uomCount,
          itemType,
          stockControl,
          mainSupplierCode,
          existingId,
        ),
      );
      updated++;
    } else {
      // INSERT — balanceQty defaults to 0; the sheet's Total Bal. Qty is ignored.
      const id = genId();
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO raw_materials
             (id, itemCode, description, baseUOM, itemGroup, isActive,
              balanceQty, minStock, maxStock, status, notes,
              created_at, updated_at,
              uomCount, itemType, stockControl, mainSupplierCode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          itemCode,
          description,
          baseUOM,
          itemGroup,
          isActive,
          0, // balanceQty defaults to 0 for new rows
          minStock,
          maxStock,
          status,
          notes,
          nowIso,
          nowIso,
          uomCount,
          itemType,
          stockControl,
          mainSupplierCode,
        ),
      );
      codeToId.set(itemCode, id);
      created++;
    }

    // Fabric cascade — mirror into fabrics + fabric_trackings for fabric groups.
    if (isFabricGroup(itemGroup)) {
      const cascadeStmts = await buildFabricUpsertStatements(c.var.DB, {
        itemCode,
        description,
        itemGroup,
        balanceQty: 0,
      });
      statements.push(...cascadeStmts);
    }
  }

  if (statements.length > 0) {
    await c.var.DB.batch(statements);
  }

  return c.json({ success: true, data: { created, updated } });
});

export default app;
