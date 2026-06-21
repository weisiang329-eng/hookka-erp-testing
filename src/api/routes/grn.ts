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
//
// Arrival pipeline (separate from status): arrival_state tracks
// NOT_ARRIVED → IN_TRANSIT → AT_CUSTOMS → ARRIVED independently of the
// DRAFT/CONFIRMED/POSTED commitment lifecycle. Post-to-stock requires
// arrival_state = 'ARRIVED'.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { makeLedgerEntry } from "../../lib/costing";
import { emitAudit } from "../lib/audit";
import { availableQty as computeAvailableQty, clampDecrement } from "../../lib/convert-chain";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Runtime schema self-apply — runs once per isolate boot.
// All columns are snake_case so no column-rename-map.json entry is needed.
// ---------------------------------------------------------------------------
let grnMigrationPromise: Promise<void> | null = null;

function ensureGrnMigrations(db: D1Database): Promise<void> {
  if (grnMigrationPromise) return grnMigrationPromise;
  grnMigrationPromise = (async () => {
    const stmts = [
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS arrival_state TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS shipping_method TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS carrier_name TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS tracking_number TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS container_number TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS expected_arrival TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS shipped_date TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS actual_arrival TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS customs_status TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS customs_clearance_date TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS shipping_cost_sen INTEGER DEFAULT 0",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS customs_duty_sen INTEGER DEFAULT 0",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS exchange_rate REAL",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS currency TEXT",
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS landed_cost_sen INTEGER DEFAULT 0",
      // Supplier reference number (owner 2026-06-21): the supplier's own
      // delivery-order number on this receipt. snake_case → no
      // column-rename-map.json entry needed.
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS supplier_do_no TEXT",
      // Convert-chain (PO→GRN→PI): per-line consumed-by-PI tracking. A GRN
      // line's available-to-invoice = accepted_qty − invoiced_qty. snake_case
      // so no column-rename-map.json entry is needed; self-applied here AND in
      // purchase-invoices.ts (whichever route boots first wins, idempotent).
      "ALTER TABLE grn_items ADD COLUMN IF NOT EXISTS invoiced_qty NUMERIC DEFAULT 0",
      // purchase_invoices.grn_id — the GRN this PI was raised from. Owned by
      // purchase-invoices.ts but also self-applied here so the GRN DELETE
      // guard ("already invoiced?") never 500s on a missing column when the
      // GRN route boots first.
      "ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS grn_id TEXT",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        // ADD COLUMN IF NOT EXISTS is idempotent; log unexpected errors but
        // do not abort — a missing column is better caught on first write.
        console.warn("[grn] ensureGrnMigrations:", sql, err);
      }
    }
  })();
  return grnMigrationPromise;
}

// ---------------------------------------------------------------------------
// Arrival state machine
// ---------------------------------------------------------------------------
export const VALID_ARRIVAL_TRANSITIONS: Record<string, string[]> = {
  // Any forward jump is allowed: local goods go straight to ARRIVED,
  // imports may skip AT_CUSTOMS if cleared informally.
  NOT_ARRIVED: ["IN_TRANSIT", "AT_CUSTOMS", "ARRIVED"],
  IN_TRANSIT: ["AT_CUSTOMS", "ARRIVED"],
  AT_CUSTOMS: ["ARRIVED"],
  ARRIVED: [],
};

type ArrivalState = "NOT_ARRIVED" | "IN_TRANSIT" | "AT_CUSTOMS" | "ARRIVED";

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
  // Arrival pipeline columns (nullable — may not exist on old rows)
  arrival_state: string | null;
  shipping_method: string | null;
  carrier_name: string | null;
  tracking_number: string | null;
  container_number: string | null;
  expected_arrival: string | null;
  shipped_date: string | null;
  actual_arrival: string | null;
  customs_status: string | null;
  customs_clearance_date: string | null;
  shipping_cost_sen: number | null;
  customs_duty_sen: number | null;
  exchange_rate: number | null;
  currency: string | null;
  landed_cost_sen: number | null;
  supplier_do_no: string | null;
  supplierDoNo?: string | null;
  // toCamel folds the snake_case DB columns to camelCase on read — dual-key
  // the reads below so the stored arrival/shipment/cost values are recovered.
  arrivalState?: string | null;
  shippingMethod?: string | null;
  carrierName?: string | null;
  trackingNumber?: string | null;
  containerNumber?: string | null;
  expectedArrival?: string | null;
  shippedDate?: string | null;
  actualArrival?: string | null;
  customsStatus?: string | null;
  customsClearanceDate?: string | null;
  shippingCostSen?: number | null;
  customsDutySen?: number | null;
  exchangeRate?: number | null;
  landedCostSen?: number | null;
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
  // Convert-chain: qty already pulled into a PI off this GRN line. Postgres
  // folds invoiced_qty → invoicedQty on read; dual-key for raw/mock rows.
  invoicedQty?: number | null;
  invoiced_qty?: number | null;
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
  material_code: string | null;
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

// Derive default arrival_state from the GRN row.
// - If the column is already set, use it.
// - Manual receipt (no poId) → ARRIVED (goods already in hand).
// - PO-linked receipt → NOT_ARRIVED (assume imported / en-route by default).
function deriveArrivalState(row: GRNRow): ArrivalState {
  const stored = row.arrivalState ?? row.arrival_state;
  if (stored) return stored as ArrivalState;
  return row.poId ? "NOT_ARRIVED" : "ARRIVED";
}

function rowToItem(r: GRNItemRow) {
  // Convert-chain: invoiced_qty may be absent on rows predating the column
  // (defaults to 0). available = accepted − invoiced, floored at 0. Exposed
  // so the PI picker can show remaining-to-invoice per GRN line.
  const invoicedQty = Number(r.invoicedQty ?? r.invoiced_qty ?? 0) || 0;
  return {
    id: r.id,
    poItemIndex: r.poItemIndex ?? 0,
    materialCode: r.materialCode ?? "",
    materialName: r.materialName ?? "",
    orderedQty: r.orderedQty,
    receivedQty: r.receivedQty,
    acceptedQty: r.acceptedQty,
    rejectedQty: r.rejectedQty,
    rejectionReason: r.rejectionReason,
    unitPrice: r.unitPrice,
    invoicedQty,
    availableQty: computeAvailableQty(Number(r.acceptedQty) || 0, invoicedQty),
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
    // Arrival pipeline
    arrival_state: deriveArrivalState(row),
    shipping_method: row.shippingMethod ?? row.shipping_method ?? null,
    carrier_name: row.carrierName ?? row.carrier_name ?? null,
    tracking_number: row.trackingNumber ?? row.tracking_number ?? null,
    container_number: row.containerNumber ?? row.container_number ?? null,
    expected_arrival: row.expectedArrival ?? row.expected_arrival ?? null,
    shipped_date: row.shippedDate ?? row.shipped_date ?? null,
    actual_arrival: row.actualArrival ?? row.actual_arrival ?? null,
    customs_status: row.customsStatus ?? row.customs_status ?? null,
    customs_clearance_date: row.customsClearanceDate ?? row.customs_clearance_date ?? null,
    shipping_cost_sen: row.shippingCostSen ?? row.shipping_cost_sen ?? 0,
    customs_duty_sen: row.customsDutySen ?? row.customs_duty_sen ?? 0,
    exchange_rate: row.exchangeRate ?? row.exchange_rate ?? null,
    currency: row.currency ?? null,
    landed_cost_sen: row.landedCostSen ?? row.landed_cost_sen ?? 0,
    supplier_do_no: row.supplierDoNo ?? row.supplier_do_no ?? null,
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
      // ORDER BY id — SQLite happened to return rows in insertion order, but
      // Postgres heap-scan order is undefined and can shift after any UPDATE.
      // GRN lines key to PO lines by index, so a scan-order flip silently
      // routes acceptedQty to the WRONG PO line (wrong stock, wrong status).
      // IDs are time-ordered (chronological suffix) so ORDER BY id matches
      // insertion order deterministically.
      "SELECT id, quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ? ORDER BY id",
    )
    .bind(poId)
    .all<{ id: string; quantity: number; receivedQty: number }>();
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
    // PO is now fully received — clear the goods_in_transit row keyed to
    // this PO so the In Transit sidebar count reconciles. Stays a no-op
    // if there is no in-transit row (e.g. local supplier that skipped the
    // shipping leg). Mirrors the cleanup the operator would otherwise do
    // by hand, and keeps the bulk Convert-to-GRN action in line with the
    // workflow Wei Siang described.
    await db
      .prepare("DELETE FROM goods_in_transit WHERE poId = ?")
      .bind(poId)
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

// ---------------------------------------------------------------------------
// RESTORE the parent PO's per-line availability when a posted GRN is
// un-posted, cancelled, or deleted. The inverse of
// cascadePOStatusAfterGRNPost: decrements purchase_order_items.receivedQty by
// each GRN line's acceptedQty (clamped at 0 so a double-restore can't drive a
// line negative) and recomputes the PO status:
//   - no items received → CONFIRMED (back to the pre-receipt committed state)
//   - some received      → PARTIAL_RECEIVED
//   - all still full      → RECEIVED (unchanged — e.g. another GRN covered it)
//
// Scope note: this only restores the AVAILABILITY counter. The inventory the
// GRN posted (rm_batches / cost_ledger / raw_materials.balanceQty) is NOT
// reversed here — postGRNToStock stays intact (a stock reversal is a separate
// concern). Returns the qty restored per PO line for the caller's audit/notes.
// ---------------------------------------------------------------------------
async function restorePOReceivedQtyForGRN(
  db: D1Database,
  grnId: string,
): Promise<{ poId: string | null; restored: { poItemId: string; qty: number }[] }> {
  const grn = await db
    .prepare("SELECT poId FROM grns WHERE id = ?")
    .bind(grnId)
    .first<{ poId: string | null }>();
  if (!grn?.poId) return { poId: null, restored: [] };
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
      // Same deterministic ORDER BY id as the post cascade — GRN lines key to
      // PO lines by index, so scan order must match the original mapping.
      "SELECT id, quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ? ORDER BY id",
    )
    .bind(poId)
    .all<{ id: string; quantity: number; receivedQty: number }>();
  const poItemsOrdered = poItemsRes.results ?? [];

  const statements: D1PreparedStatement[] = [];
  const restored: { poItemId: string; qty: number }[] = [];
  for (const gi of grnItems) {
    const idx = gi.poItemIndex ?? -1;
    if (idx < 0 || idx >= poItemsOrdered.length) continue;
    const poItem = poItemsOrdered[idx];
    // Clamp so a re-delete / double-restore never drives receivedQty < 0.
    const dec = clampDecrement(
      Number(poItem.receivedQty) || 0,
      Number(gi.acceptedQty) || 0,
    );
    if (dec <= 0) continue;
    statements.push(
      db
        .prepare(
          "UPDATE purchase_order_items SET receivedQty = receivedQty - ? WHERE id = ?",
        )
        .bind(dec, poItem.id),
    );
    restored.push({ poItemId: poItem.id, qty: dec });
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }

  // Recompute PO status from the post-restore receivedQty totals.
  const afterRes = await db
    .prepare(
      "SELECT quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ?",
    )
    .bind(poId)
    .all<{ quantity: number; receivedQty: number }>();
  const after = afterRes.results ?? [];
  if (after.length === 0) return { poId, restored };
  const allFull = after.every(
    (r) => (Number(r.receivedQty) || 0) >= (Number(r.quantity) || 0),
  );
  const anyReceived = after.some((r) => (Number(r.receivedQty) || 0) > 0);

  const nowIso = new Date().toISOString();
  if (allFull) {
    // Still fully received (another GRN covers it) — leave status RECEIVED.
    return { poId, restored };
  }
  if (anyReceived) {
    await db
      .prepare(
        "UPDATE purchase_orders SET status = 'PARTIAL_RECEIVED', receivedDate = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(nowIso, poId)
      .run();
  } else {
    // Nothing received anymore — drop back to CONFIRMED (the committed,
    // pre-receipt state). Only move a PO that was sitting in a received
    // status; never resurrect a CANCELLED/CLOSED/DRAFT PO.
    await db
      .prepare(
        `UPDATE purchase_orders SET status = 'CONFIRMED', receivedDate = NULL, updated_at = ?
           WHERE id = ? AND status IN ('RECEIVED','PARTIAL_RECEIVED')`,
      )
      .bind(nowIso, poId)
      .run();
  }
  return { poId, restored };
}

// GET /api/grn — list all GRNs (optional ?poId=&supplierId= filters)
app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — grn:read.
  const denied = await requirePermission(c, "grn", "read");
  if (denied) return denied;
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

// POST /api/grn — create a new DRAFT GRN.
//
// Two modes:
//   PO mode   — body.poId present; derives line fields from the PO.
//   Manual    — body.supplierId present (no poId); client supplies all line
//               fields. poId / poNumber / po_item_index stored as null.
//
// Guard: items must be non-empty AND (poId OR supplierId) must be present.
//
// arrival_state defaults:
//   Manual (no poId) → ARRIVED  (goods already physically in hand)
//   PO-linked        → NOT_ARRIVED (shipment yet to depart / arrive)
//   Caller can override by passing arrival_state in the body.
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — grn:create.
  const denied = await requirePermission(c, "grn", "create");
  if (denied) return denied;

  // Ensure arrival-pipeline columns exist before any INSERT
  await ensureGrnMigrations(c.var.DB);

  try {
    const body = await c.req.json();
    const {
      poId,
      supplierId: bodySupplierId,
      supplierName: bodySupplierName,
      items,
      receivedBy,
      notes,
      qcStatus,
    } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ success: false, error: "items are required" }, 400);
    }
    if (!poId && !bodySupplierId) {
      return c.json(
        {
          success: false,
          error: "Provide either a purchase order (poId) or a supplier (supplierId)",
        },
        400,
      );
    }

    const grnId = genGrnId();
    const grnNumber = await generateGrnNumber(c.var.DB);
    const receiveDate =
      body.receiveDate || new Date().toISOString().split("T")[0];
    const finalQcStatus = (qcStatus as string) || "PENDING";

    // Arrival state: caller may override; otherwise apply the default rule.
    // Manual receipt (no poId) → goods in hand → ARRIVED.
    // PO-linked (imported/shipped) → NOT_ARRIVED.
    const defaultArrivalState: ArrivalState = poId ? "NOT_ARRIVED" : "ARRIVED";
    const initialArrivalState: ArrivalState =
      (body.arrival_state as ArrivalState) ?? defaultArrivalState;

    // Validate caller-supplied arrival_state is a known value
    if (!Object.prototype.hasOwnProperty.call(VALID_ARRIVAL_TRANSITIONS, initialArrivalState)) {
      return c.json(
        { success: false, error: `Invalid arrival_state: ${initialArrivalState}` },
        400,
      );
    }

    let grnPoId: string | null = null;
    let grnPoNumber: string | null = null;
    let grnSupplierId: string | null = null;
    let grnSupplierName: string | null = null;
    let grnItems: Array<{
      poItemIndex: number | null;
      materialCode: string;
      materialName: string;
      orderedQty: number;
      receivedQty: number;
      acceptedQty: number;
      rejectedQty: number;
      rejectionReason: string | null;
      unitPrice: number;
    }>;

    if (poId) {
      // ── PO mode ─────────────────────────────────────────────────────────
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

      const poItems = poItemsRes.results ?? [];

      // Over-receipt validation (110% tolerance)
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

      grnPoId = po.id;
      grnPoNumber = po.poNo;
      grnSupplierId = po.supplierId;
      grnSupplierName = po.supplierName ?? "";

      grnItems = (
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
          materialCode: poItem?.material_code || poItem?.supplierSKU || "",
          materialName: poItem?.materialName ?? "",
          orderedQty: poItem?.quantity ?? 0,
          receivedQty: item.receivedQty,
          acceptedQty: item.acceptedQty,
          rejectedQty: item.rejectedQty,
          rejectionReason: item.rejectionReason || null,
          unitPrice: poItem?.unitPriceSen ?? 0,
        };
      });
    } else {
      // ── Manual mode — no PO ──────────────────────────────────────────────
      grnPoId = null;
      grnPoNumber = null;
      grnSupplierId = String(bodySupplierId);
      grnSupplierName = String(bodySupplierName ?? "");

      grnItems = (
        items as Array<{
          materialName: string;
          materialCode?: string | null;
          receivedQty: number;
          acceptedQty: number;
          rejectedQty: number;
          rejectionReason?: string | null;
          unitPriceSen?: number | null;
        }>
      ).map((item) => ({
        poItemIndex: null,
        materialCode: item.materialCode ?? "",
        materialName: item.materialName ?? "",
        // orderedQty has no PO reference — mirror receivedQty so it reads sensibly
        orderedQty: item.receivedQty,
        receivedQty: item.receivedQty,
        acceptedQty: item.acceptedQty,
        rejectedQty: item.rejectedQty,
        rejectionReason: item.rejectionReason || null,
        unitPrice: item.unitPriceSen ?? 0,
      }));
    }

    const totalAmount = grnItems.reduce(
      (sum, i) => sum + i.acceptedQty * i.unitPrice,
      0,
    );

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO grns (id, grnNumber, poId, poNumber, supplierId,
           supplierName, receiveDate, receivedBy, totalAmount, qcStatus,
           status, notes,
           arrival_state, shipping_method, carrier_name, tracking_number,
           container_number, expected_arrival, shipped_date, actual_arrival,
           customs_status, customs_clearance_date,
           shipping_cost_sen, customs_duty_sen, exchange_rate, currency,
           landed_cost_sen, supplier_do_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        grnId,
        grnNumber,
        grnPoId,
        grnPoNumber,
        grnSupplierId,
        grnSupplierName,
        receiveDate,
        receivedBy || "",
        totalAmount,
        finalQcStatus,
        notes || "",
        // arrival pipeline
        initialArrivalState,
        body.shipping_method ?? null,
        body.carrier_name ?? null,
        body.tracking_number ?? null,
        body.container_number ?? null,
        body.expected_arrival ?? null,
        body.shipped_date ?? null,
        body.actual_arrival ?? null,
        body.customs_status ?? null,
        body.customs_clearance_date ?? null,
        body.shipping_cost_sen ?? 0,
        body.customs_duty_sen ?? 0,
        body.exchange_rate ?? null,
        body.currency ?? null,
        body.landed_cost_sen ?? 0,
        body.supplier_do_no ?? null,
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
    // Audit emit (P3.4) — GRN create. Snapshot the after-state for the journal.
    await emitAudit(c, {
      resource: "grn",
      resourceId: grnId,
      action: "create",
      after: created,
    });
    return c.json({ success: true, data: created }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/grn] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error creating GRN" }, 500);
  }
});

// GET /api/grn/:id — single GRN + items
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "grn", "read");
  if (denied) return denied;
  const grn = await fetchGRN(c.var.DB, c.req.param("id"));
  if (!grn) {
    return c.json({ success: false, error: "GRN not found" }, 404);
  }
  return c.json({ success: true, data: grn });
});

// PUT /api/grn/:id — update status/qc/items; post to stock on DRAFT → committed
//
// Arrival gate: if body.status is moving into CONFIRMED or POSTED, and
// arrival_state is NOT 'ARRIVED', the request is rejected 409 with a clear
// message. The arrival_state must be advanced first via PUT /api/grn/:id/arrival.
app.put("/:id", async (c) => {
  // RBAC gate (P3.3-followup) — grn:update covers status / item edits.
  // The 0045 seed only has read/create/update/delete for grn (no separate
  // post/commit action), so reuse update for the DRAFT → POSTED flip.
  const denied = await requirePermission(c, "grn", "update");
  if (denied) return denied;

  // Ensure arrival-pipeline columns exist before any UPDATE
  await ensureGrnMigrations(c.var.DB);

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
    // Supplier DO No. — only overwrite when present in the body; trimmed, empty
    // → null. Read existing dual-keyed (toCamel folds the snake_case column).
    const existingSupplierDoNo =
      (existing as GRNRow).supplierDoNo ?? existing.supplier_do_no ?? null;
    const newSupplierDoNo =
      body.supplier_do_no !== undefined
        ? (String(body.supplier_do_no ?? "").trim() || null)
        : existingSupplierDoNo;

    // ── Lock POSTED (received) GRNs from un-posting ──────────────────────
    // Owner ruling 2026-06-21 (option A): once a GRN is POSTED its stock is in
    // (rm_batches/cost_ledger/balanceQty). It must NOT be un-posted/cancelled by
    // a status change — that would free the PO line while the stock stays, a
    // double-count hole. To undo a receipt, do a deliberate stock adjustment.
    if (prevStatus === "POSTED" && newStatus !== "POSTED") {
      return c.json(
        {
          success: false,
          error: "This GRN is already received into stock — it can't be un-posted. Reverse it with a stock adjustment instead.",
        },
        409,
      );
    }

    // ── Arrival gate on post-to-stock ────────────────────────────────────
    // Crossing into a committed status requires goods to have physically
    // arrived. This is checked against the effective arrival_state (column
    // value or the legacy-default fallback).
    const effectiveArrivalState = deriveArrivalState(existing);
    if (
      COMMITTED_STATUSES.has(newStatus) &&
      !COMMITTED_STATUSES.has(prevStatus) &&
      effectiveArrivalState !== "ARRIVED"
    ) {
      return c.json(
        {
          success: false,
          error: `Goods not yet marked arrived (current arrival state: ${effectiveArrivalState}). Advance arrival_state to ARRIVED before posting to stock.`,
        },
        409,
      );
    }

    const statements: D1PreparedStatement[] = [];
    let totalAmount = existing.totalAmount;

    // Replace items if provided; recompute totalAmount
    if (body.items) {
      // Once a GRN is committed (POSTED/CONFIRMED) its receipt has already
      // written rm_batches + cost_ledger + raw_materials.balanceQty. Re-writing
      // grn_items/totalAmount here would silently desync the GRN record from
      // that committed stock (the post is idempotent, so stock never re-applies
      // — only the document drifts). Lock line edits to the pre-commit state.
      if (COMMITTED_STATUSES.has(prevStatus)) {
        return c.json(
          {
            success: false,
            error: "This GRN is already posted to stock — its line items are locked. Reverse the receipt before editing.",
          },
          409,
        );
      }
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
           receivedBy = ?, totalAmount = ?, supplier_do_no = ? WHERE id = ?`,
      ).bind(newQcStatus, newStatus, newNotes, newReceivedBy, totalAmount, newSupplierDoNo, id),
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

    // Un-post / cancel: leaving a committed status (POSTED/CONFIRMED) back to
    // DRAFT/CANCELLED RESTORES the parent PO's per-line availability — the
    // receivedQty bumped at post time is decremented and the PO status is
    // recomputed (RECEIVED → PARTIAL_RECEIVED / CONFIRMED). The posted stock
    // (rm_batches/cost_ledger) is intentionally NOT reversed here.
    let restoreSummary: { poId: string | null; restored: unknown[] } | undefined;
    if (
      newStatus !== prevStatus &&
      COMMITTED_STATUSES.has(prevStatus) &&
      !COMMITTED_STATUSES.has(newStatus)
    ) {
      restoreSummary = await restorePOReceivedQtyForGRN(c.var.DB, id);
    }

    const updated = await fetchGRN(c.var.DB, id);
    return c.json({
      success: true,
      data: updated,
      costing: postSummary,
      restore: restoreSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/grn/:id] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error updating GRN" }, 500);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/grn/:id/arrival — advance the arrival_state of a GRN.
//
// Body:
//   arrival_state  (required) — target state; must be a valid next state
//   shipping_method, carrier_name, tracking_number, container_number,
//   expected_arrival, shipped_date, actual_arrival, customs_status,
//   customs_clearance_date, shipping_cost_sen, customs_duty_sen,
//   exchange_rate, currency, landed_cost_sen  (all optional, updated in place)
//
// Invalid transitions → 409.
// ---------------------------------------------------------------------------
app.put("/:id/arrival", async (c) => {
  const denied = await requirePermission(c, "grn", "update");
  if (denied) return denied;

  // Ensure columns exist before any UPDATE
  await ensureGrnMigrations(c.var.DB);

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
    const targetState = body.arrival_state as string | undefined;

    if (!targetState) {
      return c.json(
        { success: false, error: "arrival_state is required" },
        400,
      );
    }

    const currentState = deriveArrivalState(existing);
    const allowedNext = VALID_ARRIVAL_TRANSITIONS[currentState] ?? [];

    // Allow same-state call for fields-only updates (no state transition).
    // Only reject when targeting a truly invalid next state.
    if (targetState !== currentState && !allowedNext.includes(targetState)) {
      return c.json(
        {
          success: false,
          error: `Invalid arrival transition: ${currentState} → ${targetState}. Allowed: [${allowedNext.join(", ") || "none"}]`,
        },
        409,
      );
    }

    // Build update — only overwrite columns that are present in the body
    await c.var.DB.prepare(
      `UPDATE grns SET
         arrival_state             = ?,
         shipping_method           = COALESCE(?, shipping_method),
         carrier_name              = COALESCE(?, carrier_name),
         tracking_number           = COALESCE(?, tracking_number),
         container_number          = COALESCE(?, container_number),
         expected_arrival          = COALESCE(?, expected_arrival),
         shipped_date              = COALESCE(?, shipped_date),
         actual_arrival            = COALESCE(?, actual_arrival),
         customs_status            = COALESCE(?, customs_status),
         customs_clearance_date    = COALESCE(?, customs_clearance_date),
         shipping_cost_sen         = COALESCE(?, shipping_cost_sen),
         customs_duty_sen          = COALESCE(?, customs_duty_sen),
         exchange_rate             = COALESCE(?, exchange_rate),
         currency                  = COALESCE(?, currency),
         landed_cost_sen           = COALESCE(?, landed_cost_sen)
       WHERE id = ?`,
    )
      .bind(
        targetState,
        body.shipping_method ?? null,
        body.carrier_name ?? null,
        body.tracking_number ?? null,
        body.container_number ?? null,
        body.expected_arrival ?? null,
        body.shipped_date ?? null,
        body.actual_arrival ?? null,
        body.customs_status ?? null,
        body.customs_clearance_date ?? null,
        body.shipping_cost_sen ?? null,
        body.customs_duty_sen ?? null,
        body.exchange_rate ?? null,
        body.currency ?? null,
        body.landed_cost_sen ?? null,
        id,
      )
      .run();

    const updated = await fetchGRN(c.var.DB, id);
    return c.json({ success: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/grn/:id/arrival] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error updating arrival state" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/grn/:id — delete a GRN and RESTORE the parent PO's per-line
// availability.
//
// Guards:
//   • A GRN already consumed by a purchase invoice (purchase_invoices.grn_id
//     points here, status != CANCELLED) cannot be deleted — cancel/delete the
//     PI first so the PI side's restore runs and the books stay consistent.
//
// Restore: if the GRN was POSTED/CONFIRMED, its acceptedQty had bumped
// purchase_order_items.receivedQty — that is decremented back and the PO
// status recomputed (RECEIVED → PARTIAL_RECEIVED / CONFIRMED). The grn_items
// rows go via the ON DELETE CASCADE FK. Posted stock (rm_batches/cost_ledger)
// is intentionally NOT reversed — out of scope for this phase.
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "grn", "delete");
  if (denied) return denied;

  await ensureGrnMigrations(c.var.DB);

  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare("SELECT * FROM grns WHERE id = ?")
      .bind(id)
      .first<GRNRow>();
    if (!existing) {
      return c.json({ success: false, error: "GRN not found" }, 404);
    }

    // Owner ruling 2026-06-21 (option A): a POSTED (received) GRN is locked —
    // deleting it would free the PO line while the posted stock stays (a
    // double-count hole). Undo a receipt with a stock adjustment, not by delete.
    if ((existing.status ?? "DRAFT") === "POSTED") {
      return c.json(
        {
          success: false,
          error: "This GRN is already received into stock — it can't be deleted. Reverse it with a stock adjustment instead.",
        },
        409,
      );
    }

    // Block delete when a live PI was raised from this GRN — the PI must be
    // cancelled/deleted first so its own restore (grn_items.invoiced_qty)
    // runs. Dual-key the column read for raw/mock rows.
    const linkedPi = await c.var.DB.prepare(
      "SELECT piNo FROM purchase_invoices WHERE grn_id = ? AND status != 'CANCELLED' LIMIT 1",
    )
      .bind(id)
      .first<{ piNo: string }>();
    if (linkedPi) {
      return c.json(
        {
          success: false,
          error: `This goods receipt has been invoiced (${linkedPi.piNo}). Cancel or delete that invoice before deleting the GRN.`,
        },
        409,
      );
    }

    const prevStatus = existing.status ?? "DRAFT";
    // Restore PO availability BEFORE the row is gone (the helper reads
    // grn_items, which the cascade is about to remove).
    let restoreSummary: { poId: string | null; restored: unknown[] } | undefined;
    if (COMMITTED_STATUSES.has(prevStatus)) {
      restoreSummary = await restorePOReceivedQtyForGRN(c.var.DB, id);
    }

    await c.var.DB.prepare("DELETE FROM grns WHERE id = ?").bind(id).run();

    await emitAudit(c, {
      resource: "grn",
      resourceId: id,
      action: "delete",
      before: rowToGRN(existing),
    });

    return c.json({ success: true, restore: restoreSummary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[DELETE /api/grn/:id] failed:", msg, err);
    return c.json({ success: false, error: msg || "Internal error deleting GRN" }, 500);
  }
});

export default app;
