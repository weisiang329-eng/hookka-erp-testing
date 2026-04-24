// ---------------------------------------------------------------------------
// D1-backed GRN (Goods Received Note) route.
//
// Mirrors src/api/routes/grn.ts shape. Keeps the same PUT-driven state
// transitions and side-effect behaviour: when a GRN moves DRAFT →
// CONFIRMED/POSTED we write:
//   • one rm_batches row per accepted line (source='GRN', sourceRefId=grn.id)
//   • one cost_ledger RM_RECEIPT entry per batch
//   • bump raw_materials.balanceQty for the resolved RM
//
// Idempotency: re-triggering the same transition is a no-op because we
// short-circuit when rm_batches already has rows for this GRN.
//
// Schema-note: grns has no created_at/updated_at columns. Items are stored
// in grn_items with a synthetic INTEGER id; the API returns items as a
// nested array without that id (to match the in-memory GRNItem shape).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { makeLedgerEntry } from "../../lib/costing";

const app = new Hono<Env>();

type GRNRow = {
  id: string;
  grnNumber: string;
  poId: string | null;
  poNumber: string | null;
  supplierId: string | null;
  supplierName: string | null;
  receiveDate: string | null;
  receivedBy: string | null;
  totalAmount: number;
  qcStatus: string | null;
  status: string | null;
  notes: string | null;
};

type GRNItemRow = {
  id: number;
  grnId: string;
  poItemIndex: number | null;
  materialCode: string | null;
  materialName: string | null;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason: string | null;
  unitPrice: number;
};

type PurchaseOrderRow = {
  id: string;
  poNo: string;
  supplierId: string;
  supplierName: string | null;
};

type PurchaseOrderItemRow = {
  id: string;
  purchaseOrderId: string;
  materialCategory: string | null;
  materialName: string | null;
  supplierSKU: string | null;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
  receivedQty: number;
  unit: string | null;
};

type RawMaterialRow = {
  id: string;
  itemCode: string;
  description: string;
  balanceQty: number;
};

type SupplierBindingRow = {
  materialCode: string;
  supplierSku: string;
};

const COMMITTED_STATUSES = new Set(["CONFIRMED", "POSTED"]);

function rowToItem(r: GRNItemRow) {
  return {
    poItemIndex: r.poItemIndex ?? 0,
    materialCode: r.materialCode ?? "",
    materialName: r.materialName ?? "",
    orderedQty: r.orderedQty,
    receivedQty: r.receivedQty,
    acceptedQty: r.acceptedQty,
    rejectedQty: r.rejectedQty,
    rejectionReason: r.rejectionReason,
    unitPrice: r.unitPrice,
  };
}

function rowToGRN(row: GRNRow, items: GRNItemRow[] = []) {
  const lines = items
    .filter((i) => i.grnId === row.id)
    .sort((a, b) => (a.poItemIndex ?? 0) - (b.poItemIndex ?? 0))
    .map(rowToItem);
  return {
    id: row.id,
    grnNumber: row.grnNumber,
    poId: row.poId ?? "",
    poNumber: row.poNumber ?? "",
    supplierId: row.supplierId ?? "",
    supplierName: row.supplierName ?? "",
    receiveDate: row.receiveDate ?? "",
    receivedBy: row.receivedBy ?? "",
    items: lines,
    totalAmount: row.totalAmount,
    qcStatus: (row.qcStatus ?? "PENDING") as
      | "PENDING"
      | "PASSED"
      | "PARTIAL"
      | "FAILED",
    status: (row.status ?? "DRAFT") as "DRAFT" | "CONFIRMED" | "POSTED",
    notes: row.notes ?? "",
  };
}

function genGrnId(): string {
  return `grn-${crypto.randomUUID().slice(0, 8)}`;
}

function genBatchId(grnId: string, lineIdx: number): string {
  return `rmb-grn-${grnId}-${lineIdx + 1}`;
}

// Generate next GRN number — scans existing numbers for the current YYMM
// prefix and increments. Falls back to 001. Matches the in-memory
// "GRN-YYMM-NNN" format.
async function generateGrnNumber(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `GRN-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT grnNumber FROM grns WHERE grnNumber LIKE ? ORDER BY grnNumber DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ grnNumber: string }>();
  const seq = res?.grnNumber ? Number(res.grnNumber.split("-").pop()) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

async function fetchGRN(db: D1Database, id: string) {
  const [grn, itemsRes] = await Promise.all([
    db.prepare("SELECT * FROM grns WHERE id = ?").bind(id).first<GRNRow>(),
    db
      .prepare("SELECT * FROM grn_items WHERE grnId = ?")
      .bind(id)
      .all<GRNItemRow>(),
  ]);
  if (!grn) return null;
  return rowToGRN(grn, itemsRes.results ?? []);
}

// ---------------------------------------------------------------------------
// Resolve a GRN line to the underlying RawMaterial row. Tries, in order:
//   1. Split materialName on " - " — newer POs encode "itemCode - desc".
//   2. Map materialCode (= supplierSku) via supplier_material_bindings.
//   3. Fall back to description match.
// ---------------------------------------------------------------------------
async function resolveRmForGRNItem(
  db: D1Database,
  materialCode: string,
  materialName: string,
): Promise<RawMaterialRow | null> {
  const dashIdx = materialName.indexOf(" - ");
  if (dashIdx > 0) {
    const codeFragment = materialName.slice(0, dashIdx).trim();
    if (codeFragment) {
      const hit = await db
        .prepare(
          "SELECT id, itemCode, description, balanceQty FROM raw_materials WHERE itemCode = ? LIMIT 1",
        )
        .bind(codeFragment)
        .first<RawMaterialRow>();
      if (hit) return hit;
    }
  }

  if (materialCode) {
    const binding = await db
      .prepare(
        "SELECT materialCode, supplierSku FROM supplier_material_bindings WHERE supplierSku = ? LIMIT 1",
      )
      .bind(materialCode)
      .first<SupplierBindingRow>();
    if (binding) {
      const hit = await db
        .prepare(
          "SELECT id, itemCode, description, balanceQty FROM raw_materials WHERE itemCode = ? LIMIT 1",
        )
        .bind(binding.materialCode)
        .first<RawMaterialRow>();
      if (hit) return hit;
    }
  }

  const byDesc = await db
    .prepare(
      "SELECT id, itemCode, description, balanceQty FROM raw_materials WHERE description = ? LIMIT 1",
    )
    .bind(materialName)
    .first<RawMaterialRow>();
  return byDesc ?? null;
}

// Post committed GRN lines to stock — writes rm_batches, cost_ledger,
// bumps raw_materials.balanceQty. Idempotent on grn.id.
async function postGRNToStock(
  db: D1Database,
  grnId: string,
): Promise<{
  batchesCreated: number;
  ledgerEntries: number;
  unresolvedLines: { materialCode: string; materialName: string }[];
}> {
  const already = await db
    .prepare(
      "SELECT id FROM rm_batches WHERE source = 'GRN' AND sourceRefId = ? LIMIT 1",
    )
    .bind(grnId)
    .first<{ id: string }>();
  if (already) {
    return { batchesCreated: 0, ledgerEntries: 0, unresolvedLines: [] };
  }

  const grn = await db
    .prepare("SELECT * FROM grns WHERE id = ?")
    .bind(grnId)
    .first<GRNRow>();
  if (!grn) {
    return { batchesCreated: 0, ledgerEntries: 0, unresolvedLines: [] };
  }
  const itemsRes = await db
    .prepare("SELECT * FROM grn_items WHERE grnId = ? ORDER BY id ASC")
    .bind(grnId)
    .all<GRNItemRow>();
  const items = itemsRes.results ?? [];

  const nowIso = new Date().toISOString();
  const receivedIso = grn.receiveDate
    ? new Date(grn.receiveDate).toISOString()
    : nowIso;

  const unresolved: { materialCode: string; materialName: string }[] = [];
  const statements: D1PreparedStatement[] = [];
  let batchesCreated = 0;
  let ledgerEntries = 0;

  for (let lineIdx = 0; lineIdx < items.length; lineIdx++) {
    const item = items[lineIdx];
    const qty = Number(item.acceptedQty) || 0;
    if (qty <= 0) continue;

    const rm = await resolveRmForGRNItem(
      db,
      item.materialCode ?? "",
      item.materialName ?? "",
    );
    if (!rm) {
      unresolved.push({
        materialCode: item.materialCode ?? "",
        materialName: item.materialName ?? "",
      });
      continue;
    }

    const batchId = genBatchId(grnId, lineIdx);
    const unitCostSen = Number(item.unitPrice) || 0;
    const ledgerEntry = makeLedgerEntry({
      date: receivedIso,
      type: "RM_RECEIPT",
      itemType: "RM",
      itemId: rm.id,
      batchId,
      qty,
      direction: "IN",
      unitCostSen,
      refType: "GRN",
      refId: grnId,
      notes: `Received via ${grn.grnNumber}`,
    });

    statements.push(
      db
        .prepare(
          `INSERT INTO rm_batches (id, rmId, source, sourceRefId, receivedDate,
             originalQty, remainingQty, unitCostSen, created_at, notes)
           VALUES (?, ?, 'GRN', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          batchId,
          rm.id,
          grnId,
          receivedIso,
          qty,
          qty,
          unitCostSen,
          nowIso,
          `GRN ${grn.grnNumber} line ${lineIdx + 1}`,
        ),
      db
        .prepare(
          `INSERT INTO cost_ledger (id, date, type, itemType, itemId, batchId,
             qty, direction, unitCostSen, totalCostSen, refType, refId, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          ledgerEntry.id,
          ledgerEntry.date,
          ledgerEntry.type,
          ledgerEntry.itemType,
          ledgerEntry.itemId,
          ledgerEntry.batchId ?? null,
          ledgerEntry.qty,
          ledgerEntry.direction,
          ledgerEntry.unitCostSen,
          ledgerEntry.totalCostSen,
          ledgerEntry.refType ?? null,
          ledgerEntry.refId ?? null,
          ledgerEntry.notes ?? null,
        ),
      db
        .prepare(
          "UPDATE raw_materials SET balanceQty = balanceQty + ? WHERE id = ?",
        )
        .bind(qty, rm.id),
    );
    batchesCreated++;
    ledgerEntries++;
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }

  return { batchesCreated, ledgerEntries, unresolvedLines: unresolved };
}

// ---------------------------------------------------------------------------
// Cascade GRN-POSTED side effects into the parent PO:
//   1. Bump receivedQty on each matching purchase_order_items row
//      (keyed by poItemIndex — the index of the PO line the GRN line
//      was created against).
//   2. After the bump, compute total received vs ordered for the PO and
//      transition the PO status:
//        - all items fully received → RECEIVED
//        - some received            → PARTIAL_RECEIVED
//        - none received            → no change (shouldn't happen here)
// Called only on the DRAFT/CONFIRMED → POSTED boundary; postGRNToStock
// already gates on rm_batches rows, but this extra guard keeps the
// purchase_order_items bump idempotent across retries too.
// ---------------------------------------------------------------------------
async function cascadePOStatusAfterGRNPost(
  db: D1Database,
  grnId: string,
): Promise<void> {
  const grn = await db
    .prepare("SELECT poId FROM grns WHERE id = ?")
    .bind(grnId)
    .first<{ poId: string | null }>();
  if (!grn?.poId) return;
  const poId = grn.poId;

  const grnItemsRes = await db
    .prepare(
      "SELECT poItemIndex, acceptedQty FROM grn_items WHERE grnId = ? ORDER BY id ASC",
    )
    .bind(grnId)
    .all<{ poItemIndex: number | null; acceptedQty: number }>();
  const grnItems = grnItemsRes.results ?? [];

  const poItemsRes = await db
    .prepare(
      "SELECT id, quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ?",
    )
    .bind(poId)
    .all<{ id: string; quantity: number; receivedQty: number }>();
  // The GRN creation flow in POST /api/grn keys GRN lines to PO lines via
  // insertion-order array index. D1's SELECT without ORDER BY preserves
  // insertion order so using the raw results array here matches that.
  const poItemsOrdered = poItemsRes.results ?? [];

  const statements: D1PreparedStatement[] = [];
  for (const gi of grnItems) {
    const idx = gi.poItemIndex ?? -1;
    if (idx < 0 || idx >= poItemsOrdered.length) continue;
    const poItem = poItemsOrdered[idx];
    const qty = Number(gi.acceptedQty) || 0;
    if (qty <= 0) continue;
    statements.push(
      db
        .prepare(
          "UPDATE purchase_order_items SET receivedQty = receivedQty + ? WHERE id = ?",
        )
        .bind(qty, poItem.id),
    );
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }

  // Recompute status. Re-read items post-update so we include the bumps.
  const afterRes = await db
    .prepare(
      "SELECT quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ?",
    )
    .bind(poId)
    .all<{ quantity: number; receivedQty: number }>();
  const after = afterRes.results ?? [];
  if (after.length === 0) return;
  const allFull = after.every(
    (r) => (Number(r.receivedQty) || 0) >= (Number(r.quantity) || 0),
  );
  const anyPartial = after.some((r) => (Number(r.receivedQty) || 0) > 0);

  const nowIso = new Date().toISOString();
  if (allFull) {
    await db
      .prepare(
        `UPDATE purchase_orders SET status = 'RECEIVED', receivedDate = ?,
           updated_at = ? WHERE id = ?`,
      )
      .bind(nowIso.split("T")[0], nowIso, poId)
      .run();
  } else if (anyPartial) {
    await db
      .prepare(
        "UPDATE purchase_orders SET status = 'PARTIAL_RECEIVED', updated_at = ? WHERE id = ?",
      )
      .bind(nowIso, poId)
      .run();
  }
}

// GET /api/grn — list all GRNs (optional ?poId=&supplierId= filters)
app.get("/", async (c) => {
  const poId = c.req.query("poId");
  const supplierId = c.req.query("supplierId");
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (poId) {
    clauses.push("poId = ?");
    binds.push(poId);
  }
  if (supplierId) {
    clauses.push("supplierId = ?");
    binds.push(supplierId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const grnsSql = `SELECT * FROM grns ${where} ORDER BY grnNumber DESC`;

  const [grnsRes, itemsRes] = await Promise.all([
    c.var.DB.prepare(grnsSql)
      .bind(...binds)
      .all<GRNRow>(),
    c.var.DB.prepare("SELECT * FROM grn_items").all<GRNItemRow>(),
  ]);
  const data = (grnsRes.results ?? []).map((g) =>
    rowToGRN(g, itemsRes.results ?? []),
  );
  return c.json({ success: true, data });
});

// POST /api/grn — create a new DRAFT GRN from a PO + line info
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { poId, items, receivedBy, notes, qcStatus } = body;
    if (!poId || !Array.isArray(items) || items.length === 0) {
      return c.json(
        { success: false, error: "poId and items are required" },
        400,
      );
    }

    // Fetch PO + its items
    const [po, poItemsRes] = await Promise.all([
      c.var.DB.prepare(
        "SELECT id, poNo, supplierId, supplierName FROM purchase_orders WHERE id = ?",
      )
        .bind(poId)
        .first<PurchaseOrderRow>(),
      c.var.DB.prepare(
        "SELECT * FROM purchase_order_items WHERE purchaseOrderId = ?",
      )
        .bind(poId)
        .all<PurchaseOrderItemRow>(),
    ]);
    if (!po) {
      return c.json({ success: false, error: "Purchase order not found" }, 404);
    }

    // PO items are in insertion order — index used as poItemIndex
    const poItems = poItemsRes.results ?? [];

    // Over-receipt validation (110% tolerance, same as in-memory route)
    for (const item of items as Array<{
      poItemIndex: number;
      receivedQty: number;
    }>) {
      const poItem = poItems[item.poItemIndex];
      if (poItem) {
        const tolerance = poItem.quantity * 1.1;
        if (item.receivedQty > tolerance) {
          return c.json(
            {
              success: false,
              error: `Over-receipt for ${poItem.materialName}: received ${item.receivedQty} exceeds 110% of ordered ${poItem.quantity}. Requires ADMIN approval.`,
            },
            400,
          );
        }
      }
    }

    const grnItems = (
      items as Array<{
        poItemIndex: number;
        receivedQty: number;
        acceptedQty: number;
        rejectedQty: number;
        rejectionReason: string | null;
      }>
    ).map((item) => {
      const poItem = poItems[item.poItemIndex];
      return {
        poItemIndex: item.poItemIndex,
        materialCode: poItem?.supplierSKU ?? "",
        materialName: poItem?.materialName ?? "",
        orderedQty: poItem?.quantity ?? 0,
        receivedQty: item.receivedQty,
        acceptedQty: item.acceptedQty,
        rejectedQty: item.rejectedQty,
        rejectionReason: item.rejectionReason || null,
        unitPrice: poItem?.unitPriceSen ?? 0,
      };
    });

    const totalAmount = grnItems.reduce(
      (sum, i) => sum + i.acceptedQty * i.unitPrice,
      0,
    );
    const grnId = genGrnId();
    const grnNumber = await generateGrnNumber(c.var.DB);
    const receiveDate =
      body.receiveDate || new Date().toISOString().split("T")[0];
    const finalQcStatus = (qcStatus as string) || "PENDING";

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO grns (id, grnNumber, poId, poNumber, supplierId,
           supplierName, receiveDate, receivedBy, totalAmount, qcStatus,
           status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`,
      ).bind(
        grnId,
        grnNumber,
        po.id,
        po.poNo,
        po.supplierId,
        po.supplierName ?? "",
        receiveDate,
        receivedBy || "",
        totalAmount,
        finalQcStatus,
        notes || "",
      ),
      ...grnItems.map((item) =>
        c.var.DB.prepare(
          `INSERT INTO grn_items (grnId, poItemIndex, materialCode, materialName,
             orderedQty, receivedQty, acceptedQty, rejectedQty,
             rejectionReason, unitPrice)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          grnId,
          item.poItemIndex,
          item.materialCode,
          item.materialName,
          item.orderedQty,
          item.receivedQty,
          item.acceptedQty,
          item.rejectedQty,
          item.rejectionReason,
          item.unitPrice,
        ),
      ),
    ];

    await c.var.DB.batch(statements);

    const created = await fetchGRN(c.var.DB, grnId);
    if (!created) {
      return c.json({ success: false, error: "Failed to create GRN" }, 500);
    }
    return c.json({ success: true, data: created }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/grn/:id — single GRN + items
app.get("/:id", async (c) => {
  const grn = await fetchGRN(c.var.DB, c.req.param("id"));
  if (!grn) {
    return c.json({ success: false, error: "GRN not found" }, 404);
  }
  return c.json({ success: true, data: grn });
});

// PUT /api/grn/:id — update status/qc/items; post to stock on DRAFT → committed
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM grns WHERE id = ?",
    )
      .bind(id)
      .first<GRNRow>();
    if (!existing) {
      return c.json({ success: false, error: "GRN not found" }, 404);
    }
    const body = await c.req.json();
    const prevStatus = existing.status ?? "DRAFT";

    const newQcStatus = (body.qcStatus as string) ?? existing.qcStatus ?? "PENDING";
    const newStatus = (body.status as string) ?? existing.status ?? "DRAFT";
    const newNotes =
      body.notes !== undefined ? String(body.notes) : (existing.notes ?? "");
    const newReceivedBy =
      body.receivedBy !== undefined
        ? String(body.receivedBy)
        : (existing.receivedBy ?? "");

    const statements: D1PreparedStatement[] = [];
    let totalAmount = existing.totalAmount;

    // Replace items if provided; recompute totalAmount
    if (body.items) {
      const rawItems: Array<Record<string, unknown>> = body.items;
      const newItems = rawItems.map((item) => ({
        poItemIndex: Number(item.poItemIndex) || 0,
        materialCode: (item.materialCode as string) ?? "",
        materialName: (item.materialName as string) ?? "",
        orderedQty: Number(item.orderedQty) || 0,
        receivedQty: Number(item.receivedQty) || 0,
        acceptedQty: Number(item.acceptedQty) || 0,
        rejectedQty: Number(item.rejectedQty) || 0,
        rejectionReason: (item.rejectionReason as string | null) ?? null,
        unitPrice: Number(item.unitPrice) || 0,
      }));
      totalAmount = newItems.reduce(
        (sum, i) => sum + i.acceptedQty * i.unitPrice,
        0,
      );
      statements.push(
        c.var.DB.prepare("DELETE FROM grn_items WHERE grnId = ?").bind(id),
      );
      for (const item of newItems) {
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO grn_items (grnId, poItemIndex, materialCode, materialName,
               orderedQty, receivedQty, acceptedQty, rejectedQty,
               rejectionReason, unitPrice)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            id,
            item.poItemIndex,
            item.materialCode,
            item.materialName,
            item.orderedQty,
            item.receivedQty,
            item.acceptedQty,
            item.rejectedQty,
            item.rejectionReason,
            item.unitPrice,
          ),
        );
      }
    }

    statements.push(
      c.var.DB.prepare(
        `UPDATE grns SET qcStatus = ?, status = ?, notes = ?,
           receivedBy = ?, totalAmount = ? WHERE id = ?`,
      ).bind(newQcStatus, newStatus, newNotes, newReceivedBy, totalAmount, id),
    );

    await c.var.DB.batch(statements);

    // Post to stock when we crossed into a committed status
    let postSummary:
      | { batchesCreated: number; ledgerEntries: number; unresolvedLines: unknown[] }
      | undefined;
    if (
      newStatus !== prevStatus &&
      COMMITTED_STATUSES.has(newStatus) &&
      !COMMITTED_STATUSES.has(prevStatus)
    ) {
      postSummary = await postGRNToStock(c.var.DB, id);
      // Cascade to the parent PO — bump receivedQty per line and transition
      // status to PARTIAL_RECEIVED / RECEIVED. Only runs on the
      // non-committed → committed boundary, matching postGRNToStock.
      if (newStatus === "POSTED") {
        await cascadePOStatusAfterGRNPost(c.var.DB, id);
      }
    }

    const updated = await fetchGRN(c.var.DB, id);
    return c.json({ success: true, data: updated, costing: postSummary });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
