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
import { getOrgId } from "../lib/tenant";
import { checkRawMaterialDeleteLocked, lockedResponse } from "../lib/lock-helpers";
import { requirePermission } from "../lib/rbac";
import {
  buildFabricDeleteStatements,
  buildFabricUpsertStatements,
  countActiveSalesOrderRefs,
  isFabricGroup,
} from "./_fabric-cascade";

import { emitAudit } from "../lib/audit";
import {
  accountsForItemGroup,
  accountDiff,
  type StockGroupAccounts,
} from "../lib/stock-group-accounts";

const app = new Hono<Env>();

// Duplicate item codes are intentionally allowed during the item-code
// consolidation (Wei Siang). Migration 0008's UNIQUE index is a hard DB
// lock that a code deploy does NOT touch, so rather than make the
// operator click a button / run a CLI migration, every raw-material
// write idempotently drops it first. `DROP INDEX IF EXISTS` is a cheap
// no-op once it's gone; the in-memory flag keeps it to ~once per worker
// instance. RE-TIGHTEN with POST /_relock-duplicate-codes once the
// manual merge is done (it refuses while duplicates still exist).
let dupUnlockEnsured = false;
async function ensureDupCodesUnlocked(
  DB: { prepare: (sql: string) => { run: () => Promise<unknown> } },
): Promise<void> {
  if (dupUnlockEnsured) return;
  for (const idx of ["idx_rm_item_code_unique", "idx_rm_itemCode_unique"]) {
    try {
      await DB.prepare(`DROP INDEX IF EXISTS ${idx}`).run();
    } catch {
      /* absent / engine mismatch — IF EXISTS intent, ignore */
    }
  }
  dupUnlockEnsured = true;
}

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
  // Sheet dimensions for FILLER (sponge) area-based consumption (owner
  // 2026-07-30). snake_case runtime-added columns; SELECT * returns them
  // lowercase, read dual-keyed. Area per piece = length × width (inches).
  sheet_length_in?: number | null;
  sheet_width_in?: number | null;
  sheetLengthIn?: number | null;
  sheetWidthIn?: number | null;
};

type RawMaterialBody = {
  sheetLengthIn?: number | null;
  sheetWidthIn?: number | null;
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
    // Read dual-keyed — runtime-added columns come back snake_case from SELECT *.
    sheetLengthIn: (r.sheet_length_in ?? r.sheetLengthIn) ?? null,
    sheetWidthIn: (r.sheet_width_in ?? r.sheetWidthIn) ?? null,
  };
}

// Sheet-dimension columns are self-applied at runtime (deploy does not replay
// migration files). Awaited at the top of POST / PUT before the first write.
let sheetDimColsEnsured = false;
async function ensureSheetDimCols(db: D1Database): Promise<void> {
  if (sheetDimColsEnsured) return;
  for (const col of ["sheet_length_in DOUBLE PRECISION", "sheet_width_in DOUBLE PRECISION"]) {
    try {
      await db.prepare(`ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS ${col}`).run();
    } catch {
      /* column already exists / DDL transiently rejected */
    }
  }
  sheetDimColsEnsured = true;
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
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
  const orgId = getOrgId(c);
  const status = c.req.query("status");
  const sql = status
    ? "SELECT * FROM raw_materials WHERE orgId = ? AND status = ? ORDER BY itemCode"
    : "SELECT * FROM raw_materials WHERE orgId = ? ORDER BY itemCode";
  const stmt = status
    ? c.var.DB.prepare(sql).bind(orgId, status)
    : c.var.DB.prepare(sql).bind(orgId);
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

// GET /api/raw-materials/:id/used-in — reverse lookup: which products' BOMs
// reference this material. Mobile dc12 design v12 L4 drill-down: tap an
// inventory raw-material row → see "Used in 12 products". Mirrors the
// assistant-tools find_products_using_fabric query, scoped to this org +
// keyed by the material's itemCode.
app.get("/:id/used-in", async (c) => {
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  const rm = await c.var.DB.prepare(
    "SELECT itemCode FROM raw_materials WHERE id = ?",
  )
    .bind(id)
    .first<{ itemCode?: string | null }>();
  if (!rm) {
    return c.json({ success: false, error: "Raw material not found" }, 404);
  }
  const code = rm.itemCode ?? "";
  if (!code) {
    return c.json({ success: true, data: { itemCode: "", products: [] } });
  }
  // Join via bom_components.materialCode → products.code/name. DISTINCT so a
  // product with multiple bom rows for the same material doesn't double-list.
  const rows = await c.var.DB.prepare(
    `SELECT DISTINCT p.code AS productCode, p.name AS productName, p.category AS category
       FROM products p
       JOIN bom_components bc ON bc.productId = p.id
      WHERE p.orgId = ? AND bc.materialCode = ?
   ORDER BY p.code LIMIT 200`,
  )
    .bind(orgId, code)
    .all<{ productCode: string; productName: string; category: string }>();
  return c.json({
    success: true,
    data: {
      itemCode: code,
      products: rows.results ?? [],
      count: rows.results?.length ?? 0,
    },
  });
});

// POST /api/raw-materials
app.post("/", async (c) => {
  const denied = await requirePermission(c, "raw-materials", "create");
  if (denied) return denied;
  await ensureDupCodesUnlocked(c.var.DB);
  await ensureSheetDimCols(c.var.DB);
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

  // Duplicate itemCode is intentionally ALLOWED (Wei Siang, item-code
  // consolidation in progress — duplicates are created on purpose, then
  // merged by hand afterwards). The old "already exists" guard was
  // removed here AND the DB UNIQUE index is dropped by migration
  // 0120 / 0076; re-add both together once the merge is done.

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
        uomCount, itemType, stockControl, mainSupplierCode,
        sheet_length_in, sheet_width_in)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    numOrNull(body.sheetLengthIn),
    numOrNull(body.sheetWidthIn),
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
  const denied = await requirePermission(c, "raw-materials", "update");
  if (denied) return denied;
  await ensureDupCodesUnlocked(c.var.DB);
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

  // Duplicate itemCode on rename is intentionally ALLOWED — see the POST
  // handler note: item-code consolidation is in progress, duplicates are
  // created on purpose and merged by hand afterwards. (DB UNIQUE index
  // dropped by migration 0120 / 0076.)

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
    // Sheet dims — keep the existing value when the body omits the key.
    sheetLengthIn:
      body.sheetLengthIn !== undefined
        ? numOrNull(body.sheetLengthIn)
        : (existing.sheet_length_in ?? existing.sheetLengthIn ?? null),
    sheetWidthIn:
      body.sheetWidthIn !== undefined
        ? numOrNull(body.sheetWidthIn)
        : (existing.sheet_width_in ?? existing.sheetWidthIn ?? null),
  };
  const isActive = merged.status === "ACTIVE" ? 1 : 0;
  const nowIso = new Date().toISOString();
  await ensureSheetDimCols(c.var.DB);

  const updateStmt = c.var.DB.prepare(
    `UPDATE raw_materials SET
       itemCode = ?, description = ?, baseUOM = ?, itemGroup = ?,
       isActive = ?, balanceQty = ?, minStock = ?, maxStock = ?,
       status = ?, notes = ?, updated_at = ?,
       uomCount = ?, itemType = ?, stockControl = ?, mainSupplierCode = ?,
       sheet_length_in = ?, sheet_width_in = ?
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
    merged.sheetLengthIn,
    merged.sheetWidthIn,
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

  // A group change is an ACCOUNTING change — leave a trace.
  //
  // `itemGroup` is the AutoCount stock-group code, and four GL accounts hang
  // off it (see lib/stock-group-accounts.ts). Editing this dropdown re-routes
  // a material's purchases to a different 70x account from the next posting
  // on, and moves its stock value to a different 33x account in every report
  // — including for periods that already closed.
  //
  // Until now that left NOTHING behind: the row's old group was overwritten
  // and `updated_at` moved. "Who moved this material, and when did the
  // account change?" is a question you only think to ask once the numbers
  // look wrong, and by then the answer was gone.
  //
  // Audit failures are swallowed by emitAudit, so this cannot fail the edit.
  if ((existing.itemGroup ?? "") !== (merged.itemGroup ?? "")) {
    const [before, after] = await Promise.all([
      accountsForItemGroup(c.var.DB, existing.itemGroup ?? ""),
      accountsForItemGroup(c.var.DB, merged.itemGroup ?? ""),
    ]);
    await emitAudit(c, {
      resource: "raw-materials",
      resourceId: id,
      action: "update",
      before: {
        itemCode: existing.itemCode,
        itemGroup: existing.itemGroup,
        accounts: before,
      },
      after: {
        itemCode: merged.itemCode,
        itemGroup: merged.itemGroup,
        accounts: after,
        accountsChanged: accountDiff(before, after),
      },
    });
  }

  return c.json({ success: true, data: rowToApi(updated) });
});

// DELETE /api/raw-materials/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "raw-materials", "delete");
  if (denied) return denied;
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
  const denied = await requirePermission(c, "raw-materials", "create");
  if (denied) return denied;
  await ensureDupCodesUnlocked(c.var.DB);
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
  // itemGroup rides along so a bulk sheet cannot RE-GROUP materials
  // silently — see the audit note on the single-row update.
  const existingRes = await c.var.DB.prepare(
    "SELECT id, itemCode, itemGroup FROM raw_materials",
  ).all<{ id: string; itemCode: string; itemGroup: string | null }>();
  const codeToId = new Map<string, string>();
  const codeToGroup = new Map<string, string>();
  for (const r of existingRes.results ?? []) {
    codeToId.set(r.itemCode, r.id);
    codeToGroup.set(r.itemCode, r.itemGroup ?? "");
  }
  const regrouped: { itemCode: string; from: string; to: string }[] = [];

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
      const priorGroup = codeToGroup.get(itemCode) ?? "";
      if (priorGroup !== itemGroup) {
        regrouped.push({ itemCode, from: priorGroup, to: itemGroup });
      }
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

  // One event for the whole sheet, not one per row: a bulk import that
  // re-groups sixty materials is a single act by a single person, and sixty
  // audit rows would bury it. The accounts are resolved once per DISTINCT
  // group pair — a sheet touching two groups costs two lookups, not sixty.
  if (regrouped.length > 0) {
    const groups = [...new Set(regrouped.flatMap((r) => [r.from, r.to]))];
    const accounts: Record<string, StockGroupAccounts> = {};
    for (const g of groups) accounts[g] = await accountsForItemGroup(c.var.DB, g);
    await emitAudit(c, {
      resource: "raw-materials",
      resourceId: "bulk-import",
      action: "update",
      source: "api",
      after: {
        regroupedCount: regrouped.length,
        regrouped,
        accountsByGroup: accounts,
      },
    });
  }

  return c.json({ success: true, data: { created, updated } });
});

// ---------------------------------------------------------------------------
// POST /api/raw-materials/_unlock-duplicate-codes  (one-shot, idempotent)
//
// Migration 0008 put a hard UNIQUE index on raw_materials.item_code. The
// item-code consolidation needs duplicates parked on purpose first, then
// merged by hand. The local `npm run db:migrate:supabase` path needs a
// prod connection string that isn't available in this environment, so
// this endpoint drops the index through the Worker's live DB binding
// instead — same one-shot-migration pattern as the /backfill-* routes.
// `IF EXISTS` makes it safe to call repeatedly. RE-TIGHTEN with
// /_relock-duplicate-codes once the merge is done.
// ---------------------------------------------------------------------------
app.post("/_unlock-duplicate-codes", async (c) => {
  const denied = await requirePermission(c, "raw-materials", "update");
  if (denied) return denied;
  const dropped: string[] = [];
  // Postgres (prod) index name is idx_rm_item_code_unique; the SQLite
  // mirror is idx_rm_itemCode_unique. Try both; IF EXISTS = no-op when
  // absent so this is safe on either engine and on repeat calls.
  for (const idx of ["idx_rm_item_code_unique", "idx_rm_itemCode_unique"]) {
    try {
      await c.var.DB.prepare(`DROP INDEX IF EXISTS ${idx}`).run();
      dropped.push(idx);
    } catch {
      /* index absent / engine mismatch — ignore, IF EXISTS intent */
    }
  }
  return c.json({
    success: true,
    message:
      "Duplicate raw-material item codes are now allowed. Re-tighten with /_relock-duplicate-codes after the merge.",
    dropped,
  });
});

// ---------------------------------------------------------------------------
// POST /api/raw-materials/_relock-duplicate-codes  (one-shot)
//
// The "收紧" step: rebuild the UNIQUE index after the manual merge.
// Fails loudly (success:false, the offending codes) if duplicates still
// exist so the operator knows the merge isn't finished — it does NOT
// silently pick a winner.
// ---------------------------------------------------------------------------
app.post("/_relock-duplicate-codes", async (c) => {
  const denied = await requirePermission(c, "raw-materials", "update");
  if (denied) return denied;
  const dupRes = await c.var.DB.prepare(
    `SELECT itemCode, COUNT(*) AS n FROM raw_materials
      GROUP BY itemCode HAVING COUNT(*) > 1 ORDER BY n DESC`,
  ).all<{ itemCode: string; n: number }>();
  const dups = dupRes.results ?? [];
  if (dups.length > 0) {
    return c.json(
      {
        success: false,
        error: `Cannot re-lock — ${dups.length} item code(s) still duplicated. Merge them first.`,
        duplicates: dups.slice(0, 25),
      },
      409,
    );
  }
  await c.var.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_item_code_unique ON raw_materials(item_code)`,
  ).run();
  return c.json({
    success: true,
    message: "Re-locked — raw-material item codes are unique again.",
  });
});

export default app;
