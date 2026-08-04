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
import { runSelfApply } from "../lib/self-apply";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { makeLedgerEntry } from "../../lib/costing";
import { emitAudit } from "../lib/audit";
import { learnSupplierBindings } from "../lib/supplier-binding-learn";
import { availableQty as computeAvailableQty, clampDecrement } from "../../lib/convert-chain";
import { checkGrnLineQtyEdit, isGrnLockedByDownstreamPi, grnLockedByDownstreamPiError } from "../../lib/purchase-edit-rules";
import { PO_ITEMS_ORDER, ensurePoItemLineNo } from "./purchase-orders";

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
      // 0200 — per-document purchase company override. Inherits from source PO
      // → supplier → HOOKKA on create; never null.
      "ALTER TABLE grns ADD COLUMN IF NOT EXISTS purchase_org_code TEXT",
      "UPDATE grns SET purchase_org_code = 'HOOKKA' WHERE purchase_org_code IS NULL",
      // Arrival-vs-status integrity fix (owner 2026-06-29): the legacy cascade
      // import (one-shot endpoints) created `GRN-IMPORT-PI-*` rows that landed
      // POSTED with QC PASSED but never had arrival_state set — leaving the UI
      // showing "Planning" arrival on already-posted, already-consumed stock.
      // Since POSTED requires arrived goods (cost already in ledger, stock
      // already incremented), backfill those rows to ARRIVED. Idempotent.
      "UPDATE grns SET arrival_state = 'ARRIVED' " +
        "WHERE status = 'POSTED' AND (arrival_state IS NULL OR arrival_state <> 'ARRIVED')",
    ];
    await runSelfApply(db, "grn", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    grnMigrationPromise = null;
    throw err;
  });
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
  // Per-document purchase company override; nullable until ensureGrnMigrations
  // backfills legacy rows to HOOKKA.
  purchase_org_code: string | null;
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
  // toCamel may fold purchase_org_code → purchaseOrgCode; dual-key on read.
  purchaseOrgCode?: string | null;
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
    // Supplier SKU is filled by fillGrnSupplierSku after the GRN is built (it
    // needs the parent GRN's supplierId). grn_items doesn't store it — recovered
    // from supplier_material_bindings by supplier + code + price (BUG-2026-07-02-002).
    supplierSKU: "",
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

type GrnLike = { supplierId: string; items: Array<{ supplierSKU: string; materialCode: string; unitPrice: number }> };

// Recover blank Supplier SKUs on GRN lines from supplier_material_bindings —
// same rule as purchase-orders.ts: unambiguous only (one binding for the code,
// or one whose price matches the line). Mutates the built GRN objects.
async function fillGrnSupplierSku(db: D1Database, grns: GrnLike[]): Promise<void> {
  const ids = Array.from(new Set(grns.map((g) => g.supplierId).filter(Boolean)));
  if (ids.length === 0) return;
  const ph = ids.map(() => "?").join(", ");
  const res = await db
    .prepare(`SELECT * FROM supplier_material_bindings WHERE supplierId IN (${ph})`)
    .bind(...ids)
    .all<Record<string, unknown>>();
  const map = new Map<string, Array<{ sku: string; priceSen: number }>>();
  for (const r of res.results ?? []) {
    const sid = String(r.supplierId ?? r.supplier_id ?? "");
    const code = String(r.materialCode ?? r.material_code ?? "").trim().toUpperCase();
    const sku = String(r.supplierSku ?? r.supplierSKU ?? r.supplier_sku ?? "").trim();
    const priceSen = Number(r.unitPrice ?? r.unit_price ?? 0) || 0;
    if (!sid || !code || !sku) continue;
    const key = `${sid}::${code}`;
    (map.get(key) ?? map.set(key, []).get(key)!).push({ sku, priceSen });
  }
  for (const g of grns) {
    if (!g.supplierId) continue;
    for (const it of g.items) {
      if (it.supplierSKU) continue;
      const code = String(it.materialCode ?? "").trim().toUpperCase();
      const cands = map.get(`${g.supplierId}::${code}`);
      if (!cands || cands.length === 0) continue;
      let pick = "";
      if (cands.length === 1) pick = cands[0].sku;
      else {
        const pm = cands.filter((c) => c.priceSen === it.unitPrice);
        if (pm.length === 1) pick = pm[0].sku;
      }
      if (pick) it.supplierSKU = pick;
    }
  }
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
    // Per-document purchase company override (HOOKKA default).
    purchaseOrgCode: row.purchaseOrgCode ?? row.purchase_org_code ?? "HOOKKA",
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
// Compensating stock movement for editing a POSTED GRN line's accepted qty.
//
// A POSTED GRN already wrote one rm_batches row + one cost_ledger RM_RECEIPT +
// a raw_materials.balanceQty bump per line (postGRNToStock). When the operator
// corrects an accepted qty (e.g. 5 → 3), we post the DELTA the SAME way — using
// the SAME helpers (resolveRmForGRNItem, makeLedgerEntry, genBatchId) so the
// inventory + cost stay exactly in sync and editing-then-reverting is a true
// no-op:
//   • raw_materials.balanceQty += delta            (down on a reduction)
//   • the original batch's originalQty/remainingQty += delta (clamped ≥ 0)
//   • one cost_ledger entry for the delta: RM_RECEIPT IN for +delta, a signed
//     ADJUSTMENT OUT for −delta (negative qty reduces inventory value).
//
// Returns the prepared statements to run in the caller's batch (atomic with the
// grn_items rewrite). `lineDeltas` maps the ORIGINAL line index (0-based, the
// post-time batch key) to its qty delta and the line's unit cost / material.
// ---------------------------------------------------------------------------
async function buildPostedGRNStockAdjustment(
  db: D1Database,
  grnId: string,
  grnNumber: string,
  lineDeltas: Array<{
    lineIdx: number;
    delta: number;
    unitCostSen: number;
    materialCode: string;
    materialName: string;
  }>,
): Promise<{ statements: D1PreparedStatement[]; unresolved: { materialCode: string; materialName: string }[] }> {
  const statements: D1PreparedStatement[] = [];
  const unresolved: { materialCode: string; materialName: string }[] = [];
  const nowIso = new Date().toISOString();

  for (const ld of lineDeltas) {
    const delta = Number(ld.delta) || 0;
    if (delta === 0) continue;

    const rm = await resolveRmForGRNItem(db, ld.materialCode, ld.materialName);
    if (!rm) {
      unresolved.push({ materialCode: ld.materialCode, materialName: ld.materialName });
      continue;
    }

    const batchId = genBatchId(grnId, ld.lineIdx);
    const unitCostSen = Number(ld.unitCostSen) || 0;

    // Compensating cost_ledger entry. makeLedgerEntry stores qty as ABS and a
    // signed totalCostSen = qty × unitCost; we set direction by the delta sign
    // (IN = received more, OUT = received less / reversal). Same builder the
    // post path uses, so aggregation stays consistent.
    const ledgerEntry = makeLedgerEntry({
      date: nowIso,
      type: delta > 0 ? "RM_RECEIPT" : "ADJUSTMENT",
      itemType: "RM",
      itemId: rm.id,
      batchId,
      qty: Math.abs(delta),
      direction: delta > 0 ? "IN" : "OUT",
      unitCostSen,
      refType: "GRN",
      refId: grnId,
      notes: `Edit ${grnNumber}: accepted qty adjusted by ${delta > 0 ? "+" : ""}${delta}`,
    });

    statements.push(
      // 1) cost_ledger compensating entry
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
      // 2) bump the on-hand balance by the signed delta
      db
        .prepare("UPDATE raw_materials SET balanceQty = balanceQty + ? WHERE id = ?")
        .bind(delta, rm.id),
    );

    // 3) keep the GRN's own batch row in step. The batch may not exist (line
    // was unresolved at post time, or a metre line skipped). For a positive
    // delta with no batch, create one so the added stock is FIFO-consumable;
    // for a negative delta with no batch, the balance/ledger entries above are
    // enough (nothing to shrink). Clamp remaining/original at ≥ 0 so a reversal
    // can't drive the batch negative.
    const batch = await db
      .prepare("SELECT id, originalQty, remainingQty FROM rm_batches WHERE id = ?")
      .bind(batchId)
      .first<{ id: string; originalQty?: number | null; remainingQty?: number | null }>();
    if (batch) {
      // Clamp in JS, NOT SQL: Postgres has no 2-arg scalar MAX (that is
      // GREATEST), and translateSql does not convert SQLite's `MAX(a, b)` — a
      // negative delta hit "function max(integer, double precision) does not
      // exist" on prod. The batch is already loaded above, so compute the
      // clamped (≥ 0) values here and write literals (works on both dialects).
      const newOriginal = Math.max(0, (Number(batch.originalQty) || 0) + delta);
      const newRemaining = Math.max(0, (Number(batch.remainingQty) || 0) + delta);
      statements.push(
        db
          .prepare(
            `UPDATE rm_batches SET originalQty = ?, remainingQty = ? WHERE id = ?`,
          )
          .bind(newOriginal, newRemaining, batchId),
      );
    } else if (delta > 0) {
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
            nowIso,
            delta,
            delta,
            unitCostSen,
            nowIso,
            `GRN ${grnNumber} line ${ld.lineIdx + 1} (added on edit)`,
          ),
      );
    }
  }

  return { statements, unresolved };
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

  // Targets carry their OWN PO — a receipt may span several purchase orders,
  // so the header PO is only a fallback for legacy positional lines.
  const targets = await resolveGrnLineTargets(db, grnId, grn?.poId ?? null);
  if (targets.length === 0) return;

  const statements: D1PreparedStatement[] = [];
  for (const t of targets) {
    statements.push(
      db
        .prepare(
          "UPDATE purchase_order_items SET receivedQty = receivedQty + ? WHERE id = ?",
        )
        .bind(t.qty, t.poItemId),
    );
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }

  // Refresh EVERY purchase order this receipt touched. Recomputing only the
  // header PO would leave a second PO sitting at CONFIRMED while its goods are
  // already in the building.
  for (const poId of [...new Set(targets.map((t) => t.poId))]) {
    await recomputePoStatusFromReceipts(db, poId);
  }
}
// ---------------------------------------------------------------------------
// Per-line PO ownership (owner 2026-08-04: "正常都是 GR 会 generate from 好几张
// PO 的").
//
// A GRN historically belonged to ONE purchase order: `grns.poId`, with each
// line carrying `po_item_index` — a POSITION into that single PO's item list.
// Two consequences:
//
//   1. a receipt spanning several POs could not be represented at all; and
//   2. the position is only meaningful while the PO's line order is stable.
//      The existing comment already warned that a changed order routes
//      acceptedQty to the WRONG PO line.
//
// Each GRN line now records the PO line it actually receives (`po_id` +
// `po_item_id`). Both the post cascade and its reversal already ACTED on a PO
// line id — only the lookup was positional — so this replaces the lookup and
// leaves the arithmetic untouched.
//
// Legacy rows have no `po_item_id`, so the positional path stays as a fallback
// rather than requiring a backfill to be correct.
let grnItemPoRefEnsured = false;
async function ensureGrnItemPoRef(db: D1Database): Promise<void> {
  if (grnItemPoRefEnsured) return;
  try {
    await db
      .prepare("ALTER TABLE grn_items ADD COLUMN IF NOT EXISTS po_id TEXT")
      .run();
    await db
      .prepare("ALTER TABLE grn_items ADD COLUMN IF NOT EXISTS po_item_id TEXT")
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_grn_items_po_item ON grn_items(po_item_id)",
      )
      .run();
    grnItemPoRefEnsured = true;
  } catch (err) {
    // Never block a receipt — the positional fallback still resolves.
    console.warn("[grn] po-ref self-apply:", err);
  }
}

interface GrnLinePoRef {
  poItemIndex: number | null;
  acceptedQty: number;
  poId?: string | null;
  poItemId?: string | null;
  po_id?: string | null;
  po_item_id?: string | null;
}

/**
 * Resolve every GRN line to the PO line it draws down, as (poItemId, qty).
 *
 * Explicit `po_item_id` wins. Only lines still lacking it fall back to the
 * positional lookup against the GRN's header PO — so a legacy receipt behaves
 * exactly as before, and a multi-PO receipt is expressible.
 */
async function resolveGrnLineTargets(
  db: D1Database,
  grnId: string,
  headerPoId: string | null,
): Promise<Array<{ poId: string; poItemId: string; qty: number }>> {
  await ensureGrnItemPoRef(db);
  const res = await db
    .prepare(
      "SELECT poItemIndex, acceptedQty, po_id, po_item_id FROM grn_items WHERE grnId = ? ORDER BY id ASC",
    )
    .bind(grnId)
    .all<GrnLinePoRef>();
  const lines = res.results ?? [];

  const out: Array<{ poId: string; poItemId: string; qty: number }> = [];
  const needPositional = lines.some(
    (l) => !((l.poItemId ?? l.po_item_id) ?? "").trim(),
  );

  let poItemsOrdered: Array<{ id: string }> = [];
  if (needPositional && headerPoId) {
    await ensurePoItemLineNo(db);
    // Same SELECT shape the rest of this file uses for PO lines — one query
    // shape in the money path is worth more than the two unused columns.
    const poRes = await db
      .prepare(
        `SELECT id, quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ? ${PO_ITEMS_ORDER}`,
      )
      .bind(headerPoId)
      .all<{ id: string }>();
    poItemsOrdered = poRes.results ?? [];
  }

  for (const l of lines) {
    const qty = Number(l.acceptedQty) || 0;
    if (qty <= 0) continue;
    const explicitItem = ((l.poItemId ?? l.po_item_id) ?? "").trim();
    if (explicitItem) {
      const explicitPo = ((l.poId ?? l.po_id) ?? headerPoId ?? "").trim();
      if (explicitPo) out.push({ poId: explicitPo, poItemId: explicitItem, qty });
      continue;
    }
    const idx = l.poItemIndex ?? -1;
    if (idx < 0 || idx >= poItemsOrdered.length || !headerPoId) continue;
    out.push({ poId: headerPoId, poItemId: poItemsOrdered[idx].id, qty });
  }
  return out;
}

/**
 * Recompute status for ONE purchase order from its current receivedQty totals.
 * Split out because a multi-PO receipt has to refresh every PO it touched, not
 * just the GRN's header PO — otherwise the second PO stays CONFIRMED forever
 * while its goods are physically in the building.
 */
async function recomputePoStatusFromReceipts(db: D1Database, poId: string): Promise<void> {
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
    await db.prepare("DELETE FROM goods_in_transit WHERE poId = ?").bind(poId).run();
  } else if (anyPartial) {
    await db
      .prepare(
        "UPDATE purchase_orders SET status = 'PARTIAL_RECEIVED', updated_at = ? WHERE id = ?",
      )
      .bind(nowIso, poId)
      .run();
  }
}

async function restorePOReceivedQtyForGRN(
  db: D1Database,
  grnId: string,
): Promise<{ poId: string | null; restored: { poItemId: string; qty: number }[] }> {
  const grn = await db
    .prepare("SELECT poId FROM grns WHERE id = ?")
    .bind(grnId)
    .first<{ poId: string | null }>();

  const targets = await resolveGrnLineTargets(db, grnId, grn?.poId ?? null);
  if (targets.length === 0) return { poId: grn?.poId ?? null, restored: [] };

  // Current receivedQty per target line, so a re-delete / double-restore can
  // never drive a line negative.
  const ids = [...new Set(targets.map((t) => t.poItemId))];
  const ph = ids.map(() => "?").join(",");
  const curRes = await db
    .prepare(`SELECT id, receivedQty FROM purchase_order_items WHERE id IN (${ph})`)
    .bind(...ids)
    .all<{ id: string; receivedQty: number }>();
  const currentById = new Map(
    (curRes.results ?? []).map((r) => [r.id, Number(r.receivedQty) || 0]),
  );

  const statements: D1PreparedStatement[] = [];
  const restored: { poItemId: string; qty: number }[] = [];
  for (const t of targets) {
    const dec = clampDecrement(currentById.get(t.poItemId) ?? 0, t.qty);
    if (dec <= 0) continue;
    // Track the running figure so two lines against the SAME PO line cannot
    // each clamp against the original value and over-restore between them.
    currentById.set(t.poItemId, (currentById.get(t.poItemId) ?? 0) - dec);
    statements.push(
      db
        .prepare(
          "UPDATE purchase_order_items SET receivedQty = receivedQty - ? WHERE id = ?",
        )
        .bind(dec, t.poItemId),
    );
    restored.push({ poItemId: t.poItemId, qty: dec });
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }

  // Recompute EVERY purchase order this receipt had touched.
  const nowIso = new Date().toISOString();
  for (const poId of [...new Set(targets.map((t) => t.poId))]) {
    const afterRes = await db
      .prepare(
        "SELECT quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ?",
      )
      .bind(poId)
      .all<{ quantity: number; receivedQty: number }>();
    const after = afterRes.results ?? [];
    if (after.length === 0) continue;
    const allFull = after.every(
      (r) => (Number(r.receivedQty) || 0) >= (Number(r.quantity) || 0),
    );
    // Still fully received (another GRN covers it) — leave status RECEIVED.
    if (allFull) continue;
    const anyReceived = after.some((r) => (Number(r.receivedQty) || 0) > 0);
    if (anyReceived) {
      await db
        .prepare(
          "UPDATE purchase_orders SET status = 'PARTIAL_RECEIVED', receivedDate = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(nowIso, poId)
        .run();
    } else {
      // Nothing received anymore — back to CONFIRMED (the committed,
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
  }
  return { poId: grn?.poId ?? null, restored };
}

// ---------------------------------------------------------------------------
// Apply a SIGNED accepted-qty delta to the parent PO's receivedQty when a
// POSTED GRN line is edited. Mirrors cascadePOStatusAfterGRNPost but moves each
// PO line by the (possibly negative) delta instead of the full accepted qty,
// then recomputes PO status (RECEIVED / PARTIAL_RECEIVED / CONFIRMED).
// receivedQty is clamped at ≥ 0. Keyed by poItemIndex → PO line (deterministic
// ORDER BY id, the same mapping the post cascade relies on).
// ---------------------------------------------------------------------------
async function cascadePOReceivedQtyDelta(
  db: D1Database,
  grnId: string,
  deltas: { poItemIndex: number; delta: number }[],
): Promise<void> {
  const grn = await db
    .prepare("SELECT poId FROM grns WHERE id = ?")
    .bind(grnId)
    .first<{ poId: string | null }>();
  if (!grn?.poId) return;
  const poId = grn.poId;

  await ensurePoItemLineNo(db);
  const poItemsRes = await db
    .prepare(
      `SELECT id, quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ? ${PO_ITEMS_ORDER}`,
    )
    .bind(poId)
    .all<{ id: string; quantity: number; receivedQty: number }>();
  const poItemsOrdered = poItemsRes.results ?? [];

  const statements: D1PreparedStatement[] = [];
  for (const d of deltas) {
    const idx = d.poItemIndex ?? -1;
    if (idx < 0 || idx >= poItemsOrdered.length) continue;
    const poItem = poItemsOrdered[idx];
    const delta = Number(d.delta) || 0;
    if (delta === 0) continue;
    if (delta > 0) {
      statements.push(
        db
          .prepare("UPDATE purchase_order_items SET receivedQty = receivedQty + ? WHERE id = ?")
          .bind(delta, poItem.id),
      );
    } else {
      // Reduction — clamp so receivedQty can't go negative.
      const dec = clampDecrement(Number(poItem.receivedQty) || 0, -delta);
      if (dec <= 0) continue;
      statements.push(
        db
          .prepare("UPDATE purchase_order_items SET receivedQty = receivedQty - ? WHERE id = ?")
          .bind(dec, poItem.id),
      );
    }
  }
  if (statements.length > 0) await db.batch(statements);

  // Recompute PO status from the post-edit receivedQty totals.
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
  const anyReceived = after.some((r) => (Number(r.receivedQty) || 0) > 0);

  const nowIso = new Date().toISOString();
  if (allFull) {
    await db
      .prepare(
        "UPDATE purchase_orders SET status = 'RECEIVED', receivedDate = ?, updated_at = ? WHERE id = ? AND status IN ('CONFIRMED','PARTIAL_RECEIVED','RECEIVED')",
      )
      .bind(nowIso.split("T")[0], nowIso, poId)
      .run();
  } else if (anyReceived) {
    await db
      .prepare(
        "UPDATE purchase_orders SET status = 'PARTIAL_RECEIVED', receivedDate = NULL, updated_at = ? WHERE id = ? AND status IN ('CONFIRMED','PARTIAL_RECEIVED','RECEIVED')",
      )
      .bind(nowIso, poId)
      .run();
  } else {
    await db
      .prepare(
        "UPDATE purchase_orders SET status = 'CONFIRMED', receivedDate = NULL, updated_at = ? WHERE id = ? AND status IN ('RECEIVED','PARTIAL_RECEIVED')",
      )
      .bind(nowIso, poId)
      .run();
  }
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

  // Opt-in pagination (mirrors purchase-orders / sales-orders). ?page&limit
  // applies SQL LIMIT/OFFSET over the SAME where-clause + returns { total,
  // page, limit }. Omitting both keeps the full-list behavior the list page
  // falls back to whenever a filter/search is active — so a search always sees
  // EVERY GRN, never just the current page. 2026-08-01.
  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(limitParam ?? "50", 10) || 50));

  let total: number | undefined;
  if (paginate) {
    const cnt = await c.var.DB
      .prepare(`SELECT COUNT(*) AS n FROM grns ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    total = Number(cnt?.n ?? 0);
  }

  const grnsSql = paginate
    ? `SELECT * FROM grns ${where} ORDER BY grnNumber DESC LIMIT ? OFFSET ?`
    : `SELECT * FROM grns ${where} ORDER BY grnNumber DESC`;
  const grnsRes = await c.var.DB
    .prepare(grnsSql)
    .bind(...(paginate ? [...binds, limit, (page - 1) * limit] : binds))
    .all<GRNRow>();
  const grnRows = grnsRes.results ?? [];
  // Scope grn_items to just the GRNs we return — the old `SELECT * FROM
  // grn_items` loaded the ENTIRE (forever-growing) items table on every list
  // render. Postgres rejects "IN ()", so guard the empty case.
  const grnIds = grnRows.map((g) => g.id);
  const itemsRes = grnIds.length
    ? await c.var.DB
        .prepare(
          `SELECT * FROM grn_items WHERE grnId IN (${grnIds.map(() => "?").join(", ")})`,
        )
        .bind(...grnIds)
        .all<GRNItemRow>()
    : { results: [] as GRNItemRow[] };
  const data = grnRows.map((g) => rowToGRN(g, itemsRes.results ?? []));
  await fillGrnSupplierSku(c.var.DB, data);
  return c.json(
    paginate
      ? { success: true, data, total, page, limit }
      : { success: true, data },
  );
});

// GET /api/grn/stats — whole-dataset GRN header rows (NO line items) so the
// list page's summary widgets (Total / Draft / Confirmed counts + arrival-state
// tallies) stay whole-dataset even when the grid shows one paginated page.
// rowToGRN reads status/arrival off the row, so an items-less map is correct +
// cheap. Registered before /:id. 2026-08-01.
app.get("/stats", async (c) => {
  const denied = await requirePermission(c, "grn", "read");
  if (denied) return denied;
  const grnsRes = await c.var.DB
    .prepare("SELECT * FROM grns ORDER BY grnNumber DESC")
    .all<GRNRow>();
  const rows = (grnsRes.results ?? []).map((g) => rowToGRN(g, []));
  return c.json({ success: true, data: rows, total: rows.length });
});

// POST /api/grn — create a GRN.
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
//
// No-Draft create status (owner ruling 2026-06-21): a manual GRN is a REAL
// document, not a throwaway draft. The create status is derived from how the
// goods arrived — NOT defaulted to DRAFT:
//   • OCR / scan (body.ocrUsed === true, or body.status === 'DRAFT') → DRAFT.
//     The scanned receipt is parked for operator review, like a scanned SO.
//   • Goods already ARRIVED (local / walk-in: arrival_state === 'ARRIVED') →
//     POSTED. Stock goes in immediately via postGRNToStock + the receivedQty
//     cascade, exactly as the PUT DRAFT→POSTED path does. The arrival gate is
//     satisfied (ARRIVED), so this is the same committed boundary, run at
//     create time.
//   • Import still in transit (arrival_state !== 'ARRIVED') → DRAFT at the
//     document level, BUT the meaningful pre-arrival state is the arrival
//     pipeline (Planning → In Transit → At Customs → Arrived). It is NOT
//     posted to stock now; it posts later when the operator advances arrival to
//     ARRIVED and posts (the existing arrival-gated flow). We never create a
//     committed (CONFIRMED/POSTED) status before goods have ARRIVED — that
//     would bypass the arrival gate the PUT enforces.
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

    // Duplicate-document guard (owner 2026-07): a supplier DO number already on a
    // GRN for this supplier is almost always a re-scan / double-receipt — block
    // it with a clear message so we never silently create a duplicate GRN.
    const grnSupplierDoNo =
      body.supplierDoNo == null || String(body.supplierDoNo).trim() === ""
        ? null
        : String(body.supplierDoNo).trim();
    if (grnSupplierDoNo && bodySupplierId) {
      const dup = await c.var.DB
        .prepare(
          "SELECT grnNumber FROM grns WHERE supplierId = ? AND supplier_do_no = ? LIMIT 1",
        )
        .bind(bodySupplierId, grnSupplierDoNo)
        .first<{ grnNumber: string }>();
      if (dup) {
        return c.json(
          {
            success: false,
            error: `Supplier DO "${grnSupplierDoNo}" is already on ${dup.grnNumber} for this supplier — looks like a duplicate. Delete that GRN first, or change the number if it's genuinely a different document.`,
            duplicateOf: dup.grnNumber,
          },
          409,
        );
      }
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

    // ── No-Draft create status (owner 2026-06-21) ────────────────────────────
    // Derive the create status from how the goods arrived (see handler header):
    //   OCR/scan         → DRAFT (parked for review)
    //   arrived in hand  → POSTED (stock in now; arrival gate already passes)
    //   import in transit→ DRAFT (document slot; tracked by the arrival pipeline,
    //                      posts to stock only once arrival reaches ARRIVED)
    // A caller may force DRAFT explicitly (body.status === 'DRAFT'); any other
    // body.status is ignored here — committing is the PUT's arrival-gated job,
    // never something the create endpoint does ahead of ARRIVED.
    const ocrUsed =
      body.ocrUsed === true || (body.status as string) === "DRAFT";
    const initialStatus: "DRAFT" | "POSTED" =
      !ocrUsed && initialArrivalState === "ARRIVED" ? "POSTED" : "DRAFT";

    let grnPoId: string | null = null;
    let grnPoNumber: string | null = null;
    let grnSupplierId: string | null = null;
    let grnSupplierName: string | null = null;
    let grnItems: Array<{
      poItemIndex: number | null;
      // The PO LINE this receipt line draws down. A receipt may span several
      // purchase orders, so ownership lives on the line, not on grns.poId.
      poId: string | null;
      poItemId: string | null;
      materialCode: string;
      materialName: string;
      orderedQty: number;
      receivedQty: number;
      acceptedQty: number;
      rejectedQty: number;
      rejectionReason: string | null;
      unitPrice: number;
    }>;

    // Per-document purchase company — resolved later in this handler. We need
    // it before the INSERT runs; defaults to HOOKKA if everything in the chain
    // (body → PO → supplier) comes back empty.
    let purchaseOrgCode: string =
      typeof body.purchaseOrgCode === "string" && body.purchaseOrgCode.trim()
        ? body.purchaseOrgCode.trim()
        : "";

    if (poId) {
      // ── PO mode ─────────────────────────────────────────────────────────
      const [po, poItemsRes] = await Promise.all([
        c.var.DB.prepare(
          "SELECT id, poNo, supplierId, supplierName, purchase_org_code FROM purchase_orders WHERE id = ?",
        )
          .bind(poId)
          .first<PurchaseOrderRow & { purchase_org_code?: string | null; purchaseOrgCode?: string | null }>(),
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

      // Inherit purchase company from the source PO when body didn't set it.
      if (!purchaseOrgCode) {
        const poOrg =
          (po as { purchaseOrgCode?: string | null }).purchaseOrgCode ??
          (po as { purchase_org_code?: string | null }).purchase_org_code ??
          null;
        if (poOrg && String(poOrg).trim()) purchaseOrgCode = String(poOrg).trim();
      }

      grnItems = (
        items as Array<{
          poItemIndex: number;
          poId?: string | null;
          poItemId?: string | null;
          receivedQty: number;
          acceptedQty: number;
          rejectedQty: number;
          rejectionReason: string | null;
        }>
      ).map((item) => {
        const poItem = poItems[item.poItemIndex];
        return {
          poItemIndex: item.poItemIndex,
          // Prefer what the caller named; fall back to the header PO line at
          // this index so an older client still writes a resolvable row.
          poId: (item.poId ?? "").trim() || grnPoId,
          poItemId: (item.poItemId ?? "").trim() || poItem?.id || null,
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
        // Manual receipt — no purchase order behind it, so nothing to draw down.
        poItemIndex: null,
        poId: null,
        poItemId: null,
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

    // Final fall-through for purchase company: if body and source PO didn't
    // resolve it, try the supplier; finally default to HOOKKA. Never null.
    if (!purchaseOrgCode && grnSupplierId) {
      const sup = await c.var.DB.prepare(
        "SELECT purchaseOrgCode FROM suppliers WHERE id = ?",
      )
        .bind(grnSupplierId)
        .first<{ purchaseOrgCode?: string | null; purchase_org_code?: string | null }>();
      const supOrg = sup?.purchaseOrgCode ?? sup?.purchase_org_code ?? null;
      if (supOrg && String(supOrg).trim()) purchaseOrgCode = String(supOrg).trim();
    }
    if (!purchaseOrgCode) purchaseOrgCode = "HOOKKA";

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO grns (id, grnNumber, poId, poNumber, supplierId,
           supplierName, receiveDate, receivedBy, totalAmount, qcStatus,
           status, notes,
           arrival_state, shipping_method, carrier_name, tracking_number,
           container_number, expected_arrival, shipped_date, actual_arrival,
           customs_status, customs_clearance_date,
           shipping_cost_sen, customs_duty_sen, exchange_rate, currency,
           landed_cost_sen, supplier_do_no, purchase_org_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        initialStatus,
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
        purchaseOrgCode,
      ),
      ...grnItems.map((item) =>
        c.var.DB.prepare(
          `INSERT INTO grn_items (grnId, poItemIndex, po_id, po_item_id, materialCode, materialName,
             orderedQty, receivedQty, acceptedQty, rejectedQty,
             rejectionReason, unitPrice)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          grnId,
          item.poItemIndex,
          item.poId ?? null,
          item.poItemId ?? null,
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

    // Remember what this receipt just proved: supplier wording ↔ internal code.
    // Until now that pairing was discarded, so the same supplier document was
    // re-picked by hand every time it arrived (owner 2026-08-04).
    await learnSupplierBindings(
      c.var.DB,
      grnSupplierId,
      grnItems.map((i) => ({
        materialCode: i.materialCode,
        materialName: i.materialName,
        supplierSku: (i as { supplierSku?: string | null }).supplierSku ?? null,
        supplierDescription: i.materialName,
        unitPriceSen: i.unitPrice,
      })),
      genGrnId,
    ).catch(() => undefined);

    // ── Post to stock on a born-POSTED (arrived) GRN ─────────────────────────
    // When the create status is POSTED (local / arrived goods), commit the
    // receipt the SAME way the PUT DRAFT→POSTED boundary does: write
    // rm_batches/cost_ledger/balanceQty (idempotent on grn.id) then cascade the
    // parent PO's receivedQty + status. Import-in-transit / OCR GRNs land as
    // DRAFT and skip this — they post later via the arrival-gated PUT. The
    // arrival gate is implicitly honoured: initialStatus is POSTED only when
    // initialArrivalState === 'ARRIVED'.
    let postSummary:
      | { batchesCreated: number; ledgerEntries: number; unresolvedLines: unknown[] }
      | undefined;
    if (initialStatus === "POSTED") {
      postSummary = await postGRNToStock(c.var.DB, grnId);
      await cascadePOStatusAfterGRNPost(c.var.DB, grnId);
    }

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
    return c.json({ success: true, data: created, costing: postSummary }, 201);
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
  await fillGrnSupplierSku(c.var.DB, [grn]);
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
    // Purchase company override — keep existing value unless body provides a
    // non-empty string; never null (HOOKKA fallback applied below).
    const existingOrgCode =
      (existing as GRNRow).purchaseOrgCode ?? existing.purchase_org_code ?? "HOOKKA";
    const newPurchaseOrgCode =
      typeof body.purchaseOrgCode === "string" && body.purchaseOrgCode.trim()
        ? body.purchaseOrgCode.trim()
        : existingOrgCode || "HOOKKA";

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
    // Compensating-stock summary for a POSTED-GRN qty edit (set below).
    let editAdjustSummary:
      | { lineDeltas: { lineIdx: number; delta: number }[]; unresolved: { materialCode: string; materialName: string }[] }
      | undefined;
    // PO receivedQty delta cascade for a POSTED-GRN qty edit (built below).
    const poDeltaStatementsAfter: { run: () => Promise<void> }[] = [];

    // Replace items if provided; recompute totalAmount
    if (body.items) {
      if (COMMITTED_STATUSES.has(prevStatus)) {
        // ── POSTED / CONFIRMED line edit (owner ruling 2026-06-22) ──────────
        // A committed GRN already wrote rm_batches + cost_ledger +
        // raw_materials.balanceQty. The owner wants accepted-qty corrections
        // with stock + cost FOLLOWING the change, not a hard lock. We match the
        // incoming lines to the existing grn_items BY POSITION (the same
        // line-index key postGRNToStock uses for its batch ids), compute each
        // line's accepted-qty delta, BLOCK any line whose new qty drops below
        // what a PI already invoiced, then post the compensating movement for
        // the delta via the SAME helpers the post path uses. We do NOT touch
        // invoiced_qty (PI-owned) and we keep status POSTED (no un-post).
        //
        // Only accepted qty (and the harmless display fields) move; we ignore
        // any attempt to change grn↔PO line keying on a committed GRN.
        const existingItemsRes = await c.var.DB
          .prepare("SELECT * FROM grn_items WHERE grnId = ? ORDER BY id ASC")
          .bind(id)
          .all<GRNItemRow>();
        const existingItems = existingItemsRes.results ?? [];
        // Owner ruling 2026-06-29 (evening): once a PI has billed off any
        // line on this GRN, the entire GRN is locked. Delete the linked PI
        // first to unlock — see isGrnLockedByDownstreamPi.
        if (isGrnLockedByDownstreamPi(existingItems)) {
          return c.json(
            { success: false, error: grnLockedByDownstreamPiError() },
            409,
          );
        }
        const rawItems: Array<Record<string, unknown>> = body.items;
        if (rawItems.length !== existingItems.length) {
          return c.json(
            {
              success: false,
              error:
                "A received GRN's lines can't be added or removed — only the accepted quantity on an existing line can be corrected. Reverse the receipt to restructure it.",
            },
            409,
          );
        }

        const lineDeltas: Array<{
          lineIdx: number;
          delta: number;
          unitCostSen: number;
          materialCode: string;
          materialName: string;
        }> = [];
        const poLineDeltas: { poItemIndex: number; delta: number }[] = [];
        for (let i = 0; i < existingItems.length; i++) {
          const ex = existingItems[i];
          const incoming = rawItems[i];
          const oldAccepted = Number(ex.acceptedQty) || 0;
          const newAccepted = Number(incoming.acceptedQty);
          const invoiced = Number(ex.invoicedQty ?? ex.invoiced_qty ?? 0) || 0;
          const guard = checkGrnLineQtyEdit({
            ref: ex.materialName ?? ex.materialCode ?? `Line ${i + 1}`,
            oldAcceptedQty: oldAccepted,
            newAcceptedQty: newAccepted,
            invoicedQty: invoiced,
          });
          if (!guard.ok) {
            return c.json({ success: false, error: guard.error }, 409);
          }
          const delta = guard.delta;
          // Rewrite the line's accepted qty (+ received, to keep them coherent)
          // and recompute totalAmount from the new accepted qtys. Material /
          // index / unit price stay as the committed values.
          const unitCostSen = Number(ex.unitPrice) || 0;
          // Keep received coherent with the corrected accepted qty:
          // received = accepted + rejected (the rejected count is preserved).
          const newReceived = newAccepted + (Number(ex.rejectedQty) || 0);
          statements.push(
            c.var.DB
              .prepare(
                "UPDATE grn_items SET acceptedQty = ?, receivedQty = ? WHERE id = ?",
              )
              .bind(newAccepted, newReceived, ex.id),
          );
          if (delta !== 0) {
            lineDeltas.push({
              lineIdx: i,
              delta,
              unitCostSen,
              materialCode: ex.materialCode ?? "",
              materialName: ex.materialName ?? "",
            });
            if (ex.poItemIndex != null && ex.poItemIndex >= 0) {
              poLineDeltas.push({ poItemIndex: ex.poItemIndex, delta });
            }
          }
        }

        // Recompute total from the new accepted qtys.
        totalAmount = existingItems.reduce((sum, ex, i) => {
          const newAccepted = Number((rawItems[i] as Record<string, unknown>).acceptedQty) || 0;
          return sum + newAccepted * (Number(ex.unitPrice) || 0);
        }, 0);

        // Build the compensating stock movement for every changed line.
        const adj = await buildPostedGRNStockAdjustment(
          c.var.DB,
          id,
          existing.grnNumber,
          lineDeltas,
        );
        statements.push(...adj.statements);
        editAdjustSummary = {
          lineDeltas: lineDeltas.map((l) => ({ lineIdx: l.lineIdx, delta: l.delta })),
          unresolved: adj.unresolved,
        };

        // Cascade the accepted-qty delta to the parent PO's receivedQty so the
        // PO's per-line consumed counter (and status) tracks the correction.
        // Deferred to after the main batch (it re-reads PO lines / recomputes
        // status, like the post cascade). Keyed by poItemIndex → PO line.
        if (poLineDeltas.length > 0) {
          poDeltaStatementsAfter.push({
            run: async () => {
              await cascadePOReceivedQtyDelta(c.var.DB, id, poLineDeltas);
            },
          });
        }
      } else {
        // ── Pre-commit (DRAFT) replace-items — unchanged behaviour ──────────
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
    }

    statements.push(
      c.var.DB.prepare(
        `UPDATE grns SET qcStatus = ?, status = ?, notes = ?,
           receivedBy = ?, totalAmount = ?, supplier_do_no = ?,
           purchase_org_code = ? WHERE id = ?`,
      ).bind(
        newQcStatus,
        newStatus,
        newNotes,
        newReceivedBy,
        totalAmount,
        newSupplierDoNo,
        newPurchaseOrgCode,
        id,
      ),
    );

    await c.var.DB.batch(statements);

    // Run the PO receivedQty delta cascade for a POSTED-GRN qty edit (after the
    // grn_items rewrite landed, so the recompute reads the new qtys).
    for (const s of poDeltaStatementsAfter) await s.run();

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
    // GRN create and delete were audited; the edit path — which owns the
    // DRAFT → POSTED flip that writes rm_batches and cost_ledger, the un-post
    // that restores the PO's receivedQty, and the compensating stock movements
    // for a qty edit on an already-POSTED GRN — was not. This is where received
    // stock actually changes, so snapshot both sides.
    await emitAudit(c, {
      resource: "grn",
      resourceId: id,
      action: "update",
      before: existing,
      after: updated,
    });
    return c.json({
      success: true,
      data: updated,
      costing: postSummary,
      restore: restoreSummary,
      // Compensating-stock summary for a POSTED-GRN qty edit. unresolved lists
      // any changed line whose material couldn't be resolved — that delta did
      // NOT move stock (the FE surfaces it like the post path's warning).
      editAdjust: editAdjustSummary,
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
    // The arrival pipeline carries the landed-cost inputs — shipping cost,
    // customs duty, exchange rate, landed_cost_sen — which feed the costing of
    // received stock. Editing them was unaudited, so a changed FX rate or duty
    // figure left no trace of who moved it.
    await emitAudit(c, {
      resource: "grn",
      resourceId: id,
      action: "arrival-update",
      before: existing,
      after: updated,
    });
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
