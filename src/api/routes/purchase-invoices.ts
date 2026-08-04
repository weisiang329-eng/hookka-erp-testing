// ---------------------------------------------------------------------------
// D1-backed purchase_invoices route.
//
// Wired 2026-04-26 to replace the previous client-side mock in
// src/pages/procurement/pi.tsx (audit #2). Shape matches the old in-memory
// PurchaseInvoice type so the SPA upgrade is a swap-out, not a rewrite.
//
// Lifecycle (owner ruling 2026-06-29): DRAFT → CONFIRMED → PAID. PAID is
// terminal. PENDING_APPROVAL / APPROVED were dropped — CONFIRMED replaces both
// and is treated as locked-for-editing (same as PAID). Legacy rows in those
// statuses are backfilled to CONFIRMED by ensurePiMigrations() below.
// DELETE is gated to DRAFT only — once confirmed we keep the row for audit.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { runSelfApply } from "../lib/self-apply";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";
import { learnSupplierBindings } from "../lib/supplier-binding-learn";
import { getOrgId } from "../lib/tenant";
import {
  buildJournalEntryStatements,
  ledgerHasSource,
} from "../lib/journal-hash";
import { nextMonthDueDate } from "../../lib/terms";
import { issueDocNumber } from "../lib/doc-number-service";
import { checkConvertAvailability, clampDecrement, type ConvertLineRequest } from "../../lib/convert-chain";
import { buildPiApprovalLegs } from "../../lib/pi-posting";
import { isPiEditable, piEditBlockedError } from "../../lib/purchase-edit-rules";

// ---------------------------------------------------------------------------
// Runtime schema self-apply — convert-chain columns (PO→GRN→PI). All
// snake_case so no column-rename-map.json entry is needed. Awaited at the top
// of POST / PUT / DELETE before any write that touches them. Idempotent; a
// sibling self-apply in grn.ts may have already added these (whichever route
// boots first wins).
//   • purchase_invoices.grn_id        — the GRN this PI was raised from
//   • purchase_invoice_items.grn_item_id — the grn_items row a line consumed
//   • grn_items.invoiced_qty          — qty pulled into a PI off that GRN line
// ---------------------------------------------------------------------------
let piMigrationPromise: Promise<void> | null = null;
function ensurePiMigrations(db: D1Database): Promise<void> {
  if (piMigrationPromise) return piMigrationPromise;
  piMigrationPromise = (async () => {
    const stmts = [
      "ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS grn_id TEXT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN IF NOT EXISTS grn_item_id TEXT",
      // Which purchase order this invoice LINE bills (owner 2026-08-04 — one
      // supplier invoice routinely covers several POs, e.g. ADD WOOD printing
      // `P/O No : 2607-003/2607-020`). `purchase_invoices.purchaseOrderId`
      // stays as the header/display PO. A GRN-sourced line can already derive
      // its PO through grn_item_id → grn_items.po_id; this column carries it
      // for lines invoiced straight off a PO with no receipt in between.
      "ALTER TABLE purchase_invoice_items ADD COLUMN IF NOT EXISTS po_id TEXT",
      "ALTER TABLE grn_items ADD COLUMN IF NOT EXISTS invoiced_qty NUMERIC DEFAULT 0",
      // Supplier reference numbers (owner 2026-06-21): the supplier's own
      // invoice number AND their delivery-order number. snake_case → no
      // column-rename-map.json entry needed.
      "ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS supplier_invoice_no TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS supplier_do_no TEXT",
      // 0200 — per-document purchase company override (HOOKKA / OHANA / HOUZS).
      // Inherits PO → GRN → supplier → HOOKKA on create; never null.
      "ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS purchase_org_code TEXT",
      "UPDATE purchase_invoices SET purchase_org_code = 'HOOKKA' WHERE purchase_org_code IS NULL",
      // Lifecycle simplification (owner 2026-06-29): the old CHECK constraint
      // listed PENDING_APPROVAL / APPROVED and did NOT include the new
      // CONFIRMED — owner hit it on the backfill UPDATE. Drop and recreate
      // with both the new vocab AND the legacy values so the transition
      // window is safe (idempotent — re-running is fine, the IF EXISTS / re-
      // ADD pattern doesn't double-add).
      "ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_status_chk",
      "ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_status_chk " +
        "CHECK (status IN ('DRAFT','CONFIRMED','PAID','CANCELLED','PENDING_APPROVAL','APPROVED'))",
      // Now collapse PENDING_APPROVAL / APPROVED rows into CONFIRMED. Safe
      // because the CHECK above accepts CONFIRMED. Idempotent.
      "UPDATE purchase_invoices SET status = 'CONFIRMED' WHERE status IN ('PENDING_APPROVAL','APPROVED')",
      // SST breakdown (owner 2026-06-30): per-line SST + header Subtotal / SST.
      // Replaces the legacy single TAX line. snake_case → no rename-map entry.
      // Legacy TAX-line PIs keep working: on read we synthesize subtotal/tax
      // from the existing rows when header values are 0.
      "ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS subtotal_sen INTEGER DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS tax_sen INTEGER DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN IF NOT EXISTS tax_sen INTEGER DEFAULT 0",
      // Source supplier document (owner 2026-06-30). When the PI was created
      // from a scan-queue auto-split chunk, this points to the file_assets
      // row holding THAT specific chunk's PDF — the operator can re-open the
      // source supplier document straight from the PI detail page. snake_case
      // → no column-rename-map.json entry needed.
      "ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS source_document_file_id TEXT",
    ];
    await runSelfApply(db, "purchase-invoices", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    piMigrationPromise = null;
    throw err;
  });
  return piMigrationPromise;
}

const AP_CONTROL = "400-0000"; // Trade Creditors
const FX_GAIN_ACCT = "530-0000"; // GAIN ON FOREIGN EXCHANGE (realised; debit = loss)
export const DEFAULT_PURCHASE_ACCT = "704-0010";
// Fallback raw-material item_group → purchase account. The owner's
// editable kv_config `coa_stock_map` (rm[<group>].purchase /
// rmDefault.purchase) overrides this — purchase account is decided by
// the material bought, per the owner. Exported for the Maintenance
// stock-group grid (effective-mapping view).
export const DEFAULT_PURCHASE_MAP: Record<string, string> = {
  // REAL AutoCount stock-group codes (owner's grid screenshot 2026-06-12).
  // raw_materials.itemGroup carries these values — the previous keys
  // (FABRIC/FOAM/MECHANISM…) never matched, so every purchase silently
  // fell to the default account.
  "B.M-FABR": "701-0010",
  "S-FABRIC": "701-0020",
  "S.M-FABR": "701-0030",
  PLYWOOD: "702-0010",
  "WD STRIP": "702-0030",
  "B.FILLER": "703-0010",
  "S.FILLER": "703-0020",
  "B.OTHERS": "704-0010",
  "S.OTHERS": "704-0011",
  "B.ACCE": "704-0020",
  "S.ACC": "704-0021",
  MAINTENA: "704-0030",
  "B.MECHAN": "704-0040",
  "S.MECH": "704-0041",
  "B.WEBB": "704-0050",
  "S.WEBB": "704-0051",
  EQUIPMEN: "704-0060",
  "R&D": "900-R002",
  PACKING: "705-0020",
  // Legacy aspirational keys kept harmless for any stragglers.
  FABRIC: "701-0010",
  WOOD: "702-0010",
  FOAM: "703-0010",
  WEBBING: "704-0050",
  MECHANISM: "704-0040",
  ACCESSORY: "704-0020",
};
function apBankAcct(method: string | null | undefined): string {
  return String(method ?? "").toUpperCase() === "CASH"
    ? "320-0000"
    : "310-0010";
}

// Map purchase-document lines to GL purchase accounts — the SINGLE place
// that decides which 70x account a bought line belongs to (owner-editable
// kv `coa_stock_map` → DEFAULT_PURCHASE_MAP fallback → pdefault). Shared
// by the PI APPROVED posting and the purchase-credit-note posting so a
// supplier CN always reverses into the SAME accounts its PI debited.
// Phase 2 (2026-06): lines typed 'TAX' go to 706-0000 SST CHARGES —
// Malaysian SST is single-stage with no input credit, so supplier-billed
// tax is a manufacturing COST (matches the owner's P&L sample), not a
// recoverable asset.
export async function mapPurchaseLinesToAccounts(
  db: Env["Variables"]["DB"],
  // `taxAmt` (owner 2026-06-30): per-line SST in sen. Routed to 706-0000 SST
  // CHARGES on top of the goods amount so DR side stays in lockstep with AP
  // (total = subtotal + tax). Optional — legacy callers that pass only goods
  // amounts via lt='TAX' still work.
  lines: { mc: string | null; amt: number; lt: string; taxAmt?: number }[],
): Promise<{ bucket: Record<string, number>; pdefault: string }> {
  const rmRes = await db
    .prepare("SELECT * FROM raw_materials")
    .all<Record<string, unknown>>();
  const grpByCode = new Map<string, string>();
  for (const r of rmRes.results ?? []) {
    const code = String(r.item_code ?? r.itemCode ?? "");
    const grp = String(r.item_group ?? r.itemGroup ?? "");
    if (code) grpByCode.set(code, grp);
  }
  let pmap: Record<string, string> = {};
  let pdefault = DEFAULT_PURCHASE_ACCT;
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("coa_stock_map")
      .first<{ value: string }>();
    const m = JSON.parse(row?.value ?? "null") as {
      rm?: Record<string, { purchase?: string }>;
      rmDefault?: { purchase?: string };
    } | null;
    if (m?.rmDefault?.purchase) pdefault = m.rmDefault.purchase;
    if (m?.rm)
      for (const [g, v] of Object.entries(m.rm))
        if (v?.purchase) pmap[g] = v.purchase;
  } catch {
    pmap = {};
  }
  const bucket: Record<string, number> = {};
  for (const ln of lines) {
    if (ln.lt === "TAX") {
      bucket["706-0000"] = (bucket["706-0000"] ?? 0) + (Number(ln.amt) || 0);
      continue;
    }
    const grp = ln.mc ? grpByCode.get(ln.mc) ?? "" : "";
    const acct =
      (grp && (pmap[grp] ?? DEFAULT_PURCHASE_MAP[grp])) || pdefault;
    bucket[acct] = (bucket[acct] ?? 0) + (Number(ln.amt) || 0);
    // Per-line SST (owner 2026-06-30): route this line's tax to 706-0000 SST
    // CHARGES so DR side ties to AP (total = subtotal + tax). Goods amt stays
    // pre-tax in the purchase account.
    const tax = Number(ln.taxAmt) || 0;
    if (tax > 0) {
      bucket["706-0000"] = (bucket["706-0000"] ?? 0) + tax;
    }
  }
  return { bucket, pdefault };
}

const app = new Hono<Env>();

type PurchaseInvoiceRow = {
  id: string;
  piNo: string;
  purchaseOrderId: string | null;
  poRef: string | null;
  supplierId: string;
  supplierName: string;
  invoiceDate: string | null;
  dueDate: string | null;
  amountSen: number;
  paidAmountSen: number;
  status: string;
  remarks: string | null;
  created_at: string | null;
  updated_at: string | null;
};

// Line-item type. Mirrors purchase_order_items / grn_items with two
// PI-specific additions: materialCode is nullable for fee/rebate/tax lines
// that don't link to a stocked raw_material, and lineType labels the
// non-stocked categories so the UI can render a small badge instead of an
// item-code link.
export type PurchaseInvoiceItemLineType =
  | "STOCKED"
  | "FEE"
  | "TAX"
  | "REBATE"
  | "DISCOUNT"
  | "OTHER";

export type PurchaseInvoiceItem = {
  id: string;
  piId: string;
  materialCode: string | null;
  materialName: string;
  supplierSku: string | null;
  qty: number;
  unitPriceSen: number;
  lineTotalSen: number;
  // Per-line SST in sen (owner 2026-06-30). 0 for non-taxable lines and for
  // legacy rows that never recorded per-line tax. lineTotalSen stays PRE-TAX.
  taxSen: number;
  lineType: PurchaseInvoiceItemLineType;
  notes: string | null;
  grnItemId: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type PurchaseInvoiceItemRow = {
  id: string;
  pi_id?: string;
  piId?: string;
  material_code?: string | null;
  materialCode?: string | null;
  material_name?: string;
  materialName?: string;
  supplier_sku?: string | null;
  supplierSku?: string | null;
  qty: number;
  unit_price_sen?: number;
  unitPriceSen?: number;
  line_total_sen?: number;
  lineTotalSen?: number;
  line_type?: string;
  lineType?: string;
  tax_sen?: number | null;
  taxSen?: number | null;
  notes: string | null;
  grn_item_id?: string | null;
  grnItemId?: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const VALID_LINE_TYPES: PurchaseInvoiceItemLineType[] = [
  "STOCKED",
  "FEE",
  "TAX",
  "REBATE",
  "DISCOUNT",
  "OTHER",
];

// Lifecycle (owner 2026-06-29): DRAFT → CONFIRMED → PAID. CONFIRMED is the
// "approved + GL posted" state and is terminal-for-editing; PAID is terminal.
// PENDING_APPROVAL and APPROVED are legacy source states (pre-2026-06-29) —
// kept here as equivalent to CONFIRMED so any row the runtime backfill hasn't
// reached yet still transitions to PAID without a 409 from the FE Confirm
// button. The backfill UPDATE in ensurePiMigrations() is the canonical fix;
// these entries are belt-and-braces.
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["CONFIRMED"],
  CONFIRMED: ["PAID"],
  PAID: [],
  PENDING_APPROVAL: ["CONFIRMED", "PAID"],
  APPROVED: ["CONFIRMED", "PAID"],
};

function rowToPI(r: PurchaseInvoiceRow) {
  // Multi-currency fields read defensively — rows predating migration 0162
  // simply have no columns and fall back to home-currency MYR.
  const fx = r as unknown as {
    currency?: string | null;
    fxRate?: number | null;
    foreignAmountSen?: number | null;
    payFxRate?: number | null;
    paid_amount_sen?: number | null;
    grnId?: string | null;
    grn_id?: string | null;
    supplierInvoiceNo?: string | null;
    supplier_invoice_no?: string | null;
    supplierDoNo?: string | null;
    supplier_do_no?: string | null;
    purchaseOrgCode?: string | null;
    purchase_org_code?: string | null;
    subtotalSen?: number | null;
    subtotal_sen?: number | null;
    taxSen?: number | null;
    tax_sen?: number | null;
    sourceDocumentFileId?: string | null;
    source_document_file_id?: string | null;
  };
  return {
    id: r.id,
    piNo: r.piNo,
    purchaseOrderId: r.purchaseOrderId ?? "",
    poRef: r.poRef ?? "",
    grnId: fx.grnId ?? fx.grn_id ?? "",
    supplierId: r.supplierId,
    supplier: r.supplierName, // SPA reads `.supplier` (legacy field name)
    supplierName: r.supplierName,
    invoiceDate: r.invoiceDate ?? "",
    dueDate: r.dueDate ?? "",
    amountSen: r.amountSen,
    // SST breakdown (owner 2026-06-30). Header columns are authoritative when
    // populated. For legacy rows where they're still 0 the FE falls back to
    // computing subtotal = total − taxLine.amount on render via the items list.
    subtotalSen: Number(fx.subtotalSen ?? fx.subtotal_sen ?? 0) || 0,
    taxSen: Number(fx.taxSen ?? fx.tax_sen ?? 0) || 0,
    paidAmountSen: Number(fx.paid_amount_sen ?? r.paidAmountSen ?? 0),
    status: r.status,
    remarks: r.remarks ?? "",
    // Supplier reference numbers — toCamel folds snake_case to camelCase on
    // read in workers, but raw Postgres/mock rows stay snake_case; dual-key.
    supplierInvoiceNo: fx.supplierInvoiceNo ?? fx.supplier_invoice_no ?? "",
    supplierDoNo: fx.supplierDoNo ?? fx.supplier_do_no ?? "",
    // Per-document purchase company override (HOOKKA default).
    purchaseOrgCode: fx.purchaseOrgCode ?? fx.purchase_org_code ?? "HOOKKA",
    currency: fx.currency ?? "MYR",
    fxRate: fx.fxRate ?? null,
    foreignAmountSen: fx.foreignAmountSen ?? null,
    payFxRate: fx.payFxRate ?? null,
    // Source supplier document (owner 2026-06-30). file_assets row id, or
    // empty string when the PI was created manually (not from a scan).
    sourceDocumentFileId:
      fx.sourceDocumentFileId ?? fx.source_document_file_id ?? "",
    created_at: r.created_at ?? "",
    updated_at: r.updated_at ?? "",
  };
}

// D1Compat translates camelCase identifiers in the SQL string but does NOT
// camelCase result rows, so we accept both shapes (raw Postgres in tests vs.
// D1 in workers — same pattern as src/api/lib/lead-times.ts).
function rowToItem(r: PurchaseInvoiceItemRow): PurchaseInvoiceItem {
  const lineType = (r.line_type ?? r.lineType ?? "STOCKED") as PurchaseInvoiceItemLineType;
  return {
    id: r.id,
    piId: r.pi_id ?? r.piId ?? "",
    materialCode: r.material_code ?? r.materialCode ?? null,
    materialName: r.material_name ?? r.materialName ?? "",
    supplierSku: r.supplier_sku ?? r.supplierSku ?? null,
    qty: Number(r.qty) || 0,
    unitPriceSen: Number(r.unit_price_sen ?? r.unitPriceSen) || 0,
    lineTotalSen: Number(r.line_total_sen ?? r.lineTotalSen) || 0,
    taxSen: Number(r.tax_sen ?? r.taxSen) || 0,
    lineType: VALID_LINE_TYPES.includes(lineType) ? lineType : "OTHER",
    notes: r.notes ?? null,
    grnItemId: r.grnItemId ?? r.grn_item_id ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

type PurchaseInvoiceItemInput = {
  materialCode?: string | null;
  materialName?: string;
  supplierSku?: string | null;
  qty?: number;
  unitPriceSen?: number;
  // Per-line SST (owner 2026-06-30). When omitted the line is treated as
  // non-taxable (taxSen=0). The header pre-tax subtotal is the sum of goods-
  // line amounts; header taxSen is the sum of per-line taxes plus any legacy
  // TAX-line amount (so old payloads using lt='TAX' still produce a sensible
  // breakdown).
  taxSen?: number;
  lineType?: string;
  notes?: string | null;
  // Convert-chain: when this line is sourced from a GRN line, the grn_items
  // row id (BIGSERIAL → number, but accepted as string too). Drives the
  // grn_items.invoiced_qty increment + the restore on delete/cancel.
  grnItemId?: string | number | null;
};

// Validate + normalize an items[] payload. Returns either an array of
// ready-to-insert rows (with computed line_total_sen) or an error string.
function normalizeItems(
  items: unknown,
): { ok: true; rows: Array<{
    id: string;
    materialCode: string | null;
    materialName: string;
    supplierSku: string | null;
    qty: number;
    unitPriceSen: number;
    lineTotalSen: number;
    taxSen: number;
    lineType: PurchaseInvoiceItemLineType;
    notes: string | null;
    grnItemId: string | null;
    /** The PO this LINE bills — one invoice may cover several. */
    poId: string | null;
  }> } | { ok: false; error: string } {
  if (!Array.isArray(items)) {
    return { ok: false, error: "items must be an array" };
  }
  const rows: Array<{
    id: string;
    materialCode: string | null;
    materialName: string;
    supplierSku: string | null;
    qty: number;
    unitPriceSen: number;
    lineTotalSen: number;
    taxSen: number;
    lineType: PurchaseInvoiceItemLineType;
    notes: string | null;
    grnItemId: string | null;
    poId: string | null;
  }> = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as PurchaseInvoiceItemInput;
    if (!it || typeof it !== "object") {
      return { ok: false, error: `items[${i}]: not an object` };
    }
    const qty = Number(it.qty);
    const unitPriceSen = Math.round(Number(it.unitPriceSen));
    const materialName = String(it.materialName ?? "").trim();
    if (!materialName) {
      return { ok: false, error: `items[${i}]: materialName is required` };
    }
    if (!Number.isFinite(qty) || qty < 0) {
      return { ok: false, error: `items[${i}]: qty must be >= 0` };
    }
    if (!Number.isFinite(unitPriceSen) || unitPriceSen < 0) {
      return { ok: false, error: `items[${i}]: unitPriceSen must be >= 0` };
    }
    const lineType = (it.lineType ?? "STOCKED") as PurchaseInvoiceItemLineType;
    if (!VALID_LINE_TYPES.includes(lineType)) {
      return {
        ok: false,
        error: `items[${i}]: lineType must be one of ${VALID_LINE_TYPES.join(", ")}`,
      };
    }
    const matCode = it.materialCode == null ? null : String(it.materialCode).trim() || null;
    const supSku = it.supplierSku == null ? null : String(it.supplierSku).trim() || null;
    const grnItemId =
      it.grnItemId == null || String(it.grnItemId).trim() === ""
        ? null
        : String(it.grnItemId).trim();
    const taxSenIn = Math.round(Number(it.taxSen ?? 0));
    const taxSen = Number.isFinite(taxSenIn) && taxSenIn >= 0 ? taxSenIn : 0;
    rows.push({
      id: `pii-${crypto.randomUUID().slice(0, 8)}`,
      materialCode: matCode,
      materialName,
      supplierSku: supSku,
      qty,
      unitPriceSen,
      lineTotalSen: Math.round(qty * unitPriceSen),
      taxSen,
      lineType,
      notes: it.notes == null ? null : String(it.notes),
      grnItemId,
      poId: (it as { poId?: unknown }).poId == null ? null : String((it as { poId?: unknown }).poId).trim() || null,
    });
  }
  return { ok: true, rows };
}

async function loadItemsForPI(
  db: D1Database,
  piId: string,
): Promise<PurchaseInvoiceItem[]> {
  const res = await db
    .prepare(
      "SELECT * FROM purchase_invoice_items WHERE pi_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(piId)
    .all<PurchaseInvoiceItemRow>();
  return (res.results ?? []).map(rowToItem);
}

// ---------------------------------------------------------------------------
// Convert-chain RESTORE: build the UPDATE statements that decrement
// grn_items.invoiced_qty for every PI line that was sourced from a GRN line.
// Used on PI delete and on PI cancel so the consumed GRN qty becomes
// available again. Reads the line's grn_item_id (dual-keyed) and clamps each
// decrement so a double-restore can't drive invoiced_qty below 0.
// Returns prepared statements to run in the caller's batch (atomic with the
// delete / status flip).
// ---------------------------------------------------------------------------
async function buildGrnRestoreStatements(
  db: D1Database,
  piId: string,
): Promise<D1PreparedStatement[]> {
  const linesRes = await db
    .prepare(
      "SELECT grn_item_id, qty FROM purchase_invoice_items WHERE pi_id = ?",
    )
    .bind(piId)
    .all<{ grn_item_id?: string | null; grnItemId?: string | null; qty: number }>();
  const lines = linesRes.results ?? [];

  // Group requested qty by grn_item_id so we can clamp against the CURRENT
  // invoiced_qty per GRN line (multiple PI lines could point at one GRN line).
  const wantByGrnItem = new Map<string, number>();
  for (const ln of lines) {
    const giId = ln.grnItemId ?? ln.grn_item_id ?? null;
    if (!giId) continue;
    const q = Number(ln.qty) || 0;
    if (q <= 0) continue;
    wantByGrnItem.set(String(giId), (wantByGrnItem.get(String(giId)) ?? 0) + q);
  }
  if (wantByGrnItem.size === 0) return [];

  const statements: D1PreparedStatement[] = [];
  for (const [giId, want] of wantByGrnItem) {
    const gi = await db
      .prepare("SELECT invoiced_qty FROM grn_items WHERE id = ?")
      .bind(giId)
      .first<{ invoiced_qty?: number | null; invoicedQty?: number | null }>();
    const current = Number(gi?.invoicedQty ?? gi?.invoiced_qty ?? 0) || 0;
    const dec = clampDecrement(current, want);
    if (dec <= 0) continue;
    statements.push(
      db
        .prepare("UPDATE grn_items SET invoiced_qty = invoiced_qty - ? WHERE id = ?")
        .bind(dec, giId),
    );
  }
  return statements;
}

// ---------------------------------------------------------------------------
// Convert-chain CEILING guard for an items-replace edit. When a PI's lines are
// rewritten (DRAFT or CONFIRMED), the OLD GRN consumption is given back and the
// NEW lines re-consume. This verifies the NEW consumption can't push any GRN
// line's invoiced_qty past its acceptedQty — the invoice must never claim more
// than the GRN received.
//
// Per GRN line: projected = (currentInvoiced − thisPI'sOldQty) + thisPI'sNewQty
// must be ≤ acceptedQty. We subtract this PI's own old consumption because the
// edit replaces it (it does NOT stack on top of the existing rows).
// ---------------------------------------------------------------------------
async function checkInvoicedQtyCeilingAfterEdit(
  db: D1Database,
  piId: string,
  newRows: Array<{ grnItemId: string | null; qty: number; materialName: string }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // New requested qty per GRN line.
  const newByGrnItem = new Map<string, { qty: number; name: string }>();
  for (const r of newRows) {
    if (!r.grnItemId || r.qty <= 0) continue;
    const prev = newByGrnItem.get(r.grnItemId);
    newByGrnItem.set(r.grnItemId, {
      qty: (prev?.qty ?? 0) + r.qty,
      name: prev?.name ?? r.materialName,
    });
  }
  if (newByGrnItem.size === 0) return { ok: true };

  // This PI's CURRENT (pre-edit) qty per GRN line — the consumption the edit
  // releases.
  const oldLinesRes = await db
    .prepare(
      "SELECT grn_item_id, qty FROM purchase_invoice_items WHERE pi_id = ?",
    )
    .bind(piId)
    .all<{ grn_item_id?: string | null; grnItemId?: string | null; qty: number }>();
  const oldByGrnItem = new Map<string, number>();
  for (const ln of oldLinesRes.results ?? []) {
    const giId = ln.grnItemId ?? ln.grn_item_id ?? null;
    if (!giId) continue;
    oldByGrnItem.set(String(giId), (oldByGrnItem.get(String(giId)) ?? 0) + (Number(ln.qty) || 0));
  }

  for (const [giId, { qty: newQty, name }] of newByGrnItem) {
    const gi = await db
      .prepare("SELECT acceptedQty, invoiced_qty FROM grn_items WHERE id = ?")
      .bind(giId)
      .first<{
        acceptedQty?: number | null;
        accepted_qty?: number | null;
        invoiced_qty?: number | null;
        invoicedQty?: number | null;
      }>();
    if (!gi) {
      return {
        ok: false,
        error: `Line "${name}" references a goods-receipt line (${giId}) that no longer exists.`,
      };
    }
    const accepted = Number(gi.acceptedQty ?? gi.accepted_qty ?? 0) || 0;
    const currentInvoiced = Number(gi.invoicedQty ?? gi.invoiced_qty ?? 0) || 0;
    const oldThisPi = oldByGrnItem.get(giId) ?? 0;
    const projected = currentInvoiced - oldThisPi + newQty;
    if (projected > accepted) {
      const otherPIs = currentInvoiced - oldThisPi;
      const remaining = accepted - otherPIs;
      return {
        ok: false,
        error: `Line "${name}": invoicing ${newQty} would exceed the ${remaining} still available on its goods receipt (received ${accepted}, billed elsewhere ${otherPIs}).`,
      };
    }
  }
  return { ok: true };
}

// Generate next PI number for the current YYMM. Pattern: PI-YYMM-NNN.
async function generatePiNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `PI-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT piNo FROM purchase_invoices WHERE piNo LIKE ? ORDER BY piNo DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ piNo: string }>();
  if (!res) return `${prefix}001`;
  const seq = parseInt(res.piNo.replace(prefix, ""), 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// GET /api/purchase-invoices — list with optional filters.
//   ?status=DRAFT,CONFIRMED  (CSV)
//   ?supplierId=...
//   ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD  (filters invoiceDate)
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const db = c.var.DB;
  const statusParam = c.req.query("status") ?? "";
  const supplierIdParam = c.req.query("supplierId") ?? "";
  const dateFrom = c.req.query("dateFrom") ?? "";
  const dateTo = c.req.query("dateTo") ?? "";

  const wheres: string[] = [];
  const binds: (string | number)[] = [];
  if (statusParam) {
    const statuses = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      wheres.push(`status IN (${statuses.map(() => "?").join(",")})`);
      binds.push(...statuses);
    }
  }
  if (supplierIdParam) {
    wheres.push("supplierId = ?");
    binds.push(supplierIdParam);
  }
  if (dateFrom) {
    wheres.push("invoiceDate >= ?");
    binds.push(dateFrom);
  }
  if (dateTo) {
    wheres.push("invoiceDate <= ?");
    binds.push(dateTo);
  }
  const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql = `SELECT * FROM purchase_invoices ${whereSql} ORDER BY invoiceDate DESC, piNo DESC`;
  const stmt = binds.length > 0 ? db.prepare(sql).bind(...binds) : db.prepare(sql);
  const res = await stmt.all<PurchaseInvoiceRow>();
  return c.json({ success: true, data: (res.results ?? []).map(rowToPI) });
});

// ---------------------------------------------------------------------------
// GET /api/purchase-invoices/:id
//
// Reverse links (owner 2026-08-01):
//   • linkedPayments — supplier_payments.purchase_invoice_id points AT the PI,
//     so cash-out was only visible from the payments list. A PI could be fully
//     settled and its own page gave no indication a payment existed; AP had to
//     open the supplier-payments screen to find out. idx_supplier_payments_pi
//     already exists (0119), so this is one index seek.
//   • linkedGRNs — the PI stores grn_id (the GRN it was raised from), which is
//     a FORWARD key, but the PI page had no way to resolve it to a document, so
//     it downloaded the ENTIRE /api/grn list and matched client-side.
// Same `Promise.all` + `linkedX` shape as sales-orders.ts GET /:id.
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.var.DB;
  const row = await db
    .prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .first<PurchaseInvoiceRow>();
  if (!row) return c.json({ success: false, error: "PI not found" }, 404);
  const projected = rowToPI(row);
  const [items, linkedPayments, linkedGRNs] = await Promise.all([
    loadItemsForPI(db, id),
    (async () => {
      const res = await db
        .prepare(
          `SELECT id, paymentNo, date, amountSen, method, reference
             FROM supplier_payments
            WHERE purchaseInvoiceId = ?
            ORDER BY date`,
        )
        .bind(id)
        .all<{
          id: string;
          paymentNo: string | null;
          date: string | null;
          amountSen: number | null;
          method: string | null;
          reference: string | null;
        }>();
      return (res.results ?? []).map((p) => ({
        id: p.id,
        paymentNo: p.paymentNo ?? "",
        date: p.date ?? "",
        amountSen: p.amountSen ?? 0,
        method: p.method ?? "",
        reference: p.reference ?? "",
      }));
    })(),
    (async () => {
      // grn_id is nullable + only set on GRN-sourced PIs. Skip the query
      // entirely when absent rather than scanning for a NULL match.
      if (!projected.grnId) return [];
      const res = await db
        .prepare(
          `SELECT id, grnNumber, status, receiveDate, totalAmount
             FROM grns
            WHERE id = ?`,
        )
        .bind(projected.grnId)
        .all<{
          id: string;
          grnNumber: string | null;
          status: string | null;
          receiveDate: string | null;
          totalAmount: number | null;
        }>();
      return (res.results ?? []).map((g) => ({
        id: g.id,
        grnNumber: g.grnNumber ?? "",
        status: g.status ?? "",
        receiveDate: g.receiveDate ?? null,
        totalAmount: g.totalAmount ?? 0,
      }));
    })(),
  ]);
  // Legacy synthesis: if header subtotal/tax are still 0 but a TAX line
  // exists (or the line items now carry per-line tax), surface a sensible
  // breakdown on the fly — read-only, no writes.
  if (projected.subtotalSen === 0 && projected.taxSen === 0 && items.length > 0) {
    const legacyTax = items
      .filter((i) => i.lineType === "TAX")
      .reduce((s, i) => s + (Number(i.lineTotalSen) || 0), 0);
    const perLineTax = items.reduce((s, i) => s + (Number(i.taxSen) || 0), 0);
    const goodsTotal = items
      .filter((i) => i.lineType !== "TAX")
      .reduce((s, i) => s + (Number(i.lineTotalSen) || 0), 0);
    const synthTax = perLineTax || legacyTax;
    if (synthTax > 0 || goodsTotal !== projected.amountSen) {
      projected.taxSen = synthTax;
      projected.subtotalSen = projected.amountSen - synthTax;
    }
  }
  return c.json({
    success: true,
    data: { ...projected, items },
    linkedPayments,
    linkedGRNs,
  });
});

// ---------------------------------------------------------------------------
// POST /api/purchase-invoices — create from a PO (or standalone).
// Body: { purchaseOrderId?, supplierId, supplierName, invoiceDate, dueDate,
//         amountSen, remarks?, status? (default DRAFT) }
// PO denorm fields (poRef) auto-resolved when purchaseOrderId is given.
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "create");
  if (denied) return denied;

  const db = c.var.DB;
  // Convert-chain columns must exist before the line-availability guard reads
  // grn_items.invoiced_qty and before the insert writes grn_id / grn_item_id.
  await ensurePiMigrations(db);
  const body = await c.req.json().catch(() => ({})) as {
    purchaseOrderId?: string;
    grnId?: string;
    supplierId?: string;
    supplierName?: string;
    invoiceDate?: string;
    dueDate?: string;
    amountSen?: number;
    remarks?: string;
    status?: string;
    supplierInvoiceNo?: string | null;
    supplierDoNo?: string | null;
    purchaseOrgCode?: string;
    items?: PurchaseInvoiceItemInput[];
    currency?: string;
    fxRate?: number;
    // Source supplier document — file_assets row id of the (possibly chunked)
    // PDF the scan modal uploaded right before this POST. Owner 2026-06-30.
    sourceDocumentFileId?: string | null;
    // Kept in the request shape so the FE can keep sending ocrUsed (legacy flag);
    // status is now ALWAYS DRAFT on create regardless of OCR vs manual.
    ocrUsed?: boolean;
  };

  if (!body.supplierId || !body.supplierName) {
    return c.json(
      { success: false, error: "supplierId and supplierName are required" },
      400,
    );
  }
  // Phase 3.6 multi-currency (owner: rate keyed PER DOCUMENT). A foreign
  // PI is entered entirely in its currency; we convert to HOME MYR at the
  // booking rate right here, so amountSen / line totals / stock-map
  // buckets / AP control all stay MYR and nothing downstream changes.
  // Currency and rate are fixed at creation — re-keying a wrong rate means
  // cancelling and re-raising the PI, same as the SST snapshot rule.
  const currency = String(body.currency || "MYR").toUpperCase();
  const fxRate = Number(body.fxRate) || 0;
  const isForeign = currency !== "MYR";
  if (isForeign && !(fxRate > 0)) {
    return c.json(
      { success: false, error: `A ${currency} invoice needs a positive exchange rate (MYR per 1 ${currency})` },
      400,
    );
  }
  const toHome = (sen: number) => (isForeign ? Math.round(sen * fxRate) : sen);
  const status = body.status || "DRAFT";
  if (!VALID_TRANSITIONS[status] && status !== "DRAFT") {
    return c.json({ success: false, error: `Invalid initial status: ${status}` }, 400);
  }
  // Supplier reference numbers — trimmed, empty → null.
  const supplierInvoiceNo =
    body.supplierInvoiceNo == null || String(body.supplierInvoiceNo).trim() === ""
      ? null
      : String(body.supplierInvoiceNo).trim();
  const supplierDoNo =
    body.supplierDoNo == null || String(body.supplierDoNo).trim() === ""
      ? null
      : String(body.supplierDoNo).trim();

  // Duplicate-document guard (owner 2026-07). A supplier invoice/DO number that
  // already lives on a non-cancelled PI for this supplier is almost always a
  // re-scan or double-entry — block it with a clear message so the operator can
  // never silently create duplicate PIs (the "scanned the same bundle twice"
  // incident). Checks BOTH number fields because the OCR sometimes files the
  // invoice no under the DO field (and vice versa).
  {
    const dupNums = [supplierInvoiceNo, supplierDoNo].filter(
      (n): n is string => !!n,
    );
    // Skip for the one-time historical import (body.piNo supplied) — those
    // preserve original numbers and must not be blocked by dup detection.
    const isHistoricalImport =
      typeof (body as { piNo?: unknown }).piNo === "string";
    if (dupNums.length > 0 && !isHistoricalImport) {
      const ph = dupNums.map(() => "?").join(", ");
      const dup = await db
        .prepare(
          `SELECT piNo,
                  supplier_invoice_no AS "supplierInvoiceNo",
                  supplier_do_no AS "supplierDoNo"
             FROM purchase_invoices
            WHERE supplierId = ?
              AND status <> 'CANCELLED'
              AND (supplier_invoice_no IN (${ph}) OR supplier_do_no IN (${ph}))
            LIMIT 1`,
        )
        .bind(body.supplierId, ...dupNums, ...dupNums)
        .first<{
          piNo: string;
          supplierInvoiceNo: string | null;
          supplierDoNo: string | null;
        }>();
      if (dup) {
        const matched =
          dupNums.find(
            (n) => n === dup.supplierInvoiceNo || n === dup.supplierDoNo,
          ) ?? dupNums[0];
        return c.json(
          {
            success: false,
            error: `Supplier document "${matched}" is already on ${dup.piNo} for this supplier — looks like a duplicate. Void that PI first, or change the number if it's genuinely a different document.`,
            duplicateOf: dup.piNo,
          },
          409,
        );
      }
    }
  }

  // Validate items[] up-front so we can fail before any insert.
  let normalizedItems: ReturnType<typeof normalizeItems> | null = null;
  if (body.items !== undefined) {
    normalizedItems = normalizeItems(body.items);
    if (!normalizedItems.ok) {
      return c.json({ success: false, error: normalizedItems.error }, 400);
    }
  }

  // Resolve poRef + the source PO's purchase company override if given.
  let poRef: string | null = null;
  let sourcePoOrgCode: string | null = null;
  if (body.purchaseOrderId) {
    const po = await db
      .prepare("SELECT poNo, purchase_org_code FROM purchase_orders WHERE id = ?")
      .bind(body.purchaseOrderId)
      .first<{ poNo: string; purchase_org_code?: string | null; purchaseOrgCode?: string | null }>();
    poRef = po?.poNo ?? null;
    sourcePoOrgCode =
      po?.purchaseOrgCode ?? po?.purchase_org_code ?? null;
  }

  // ── LINE-LEVEL double-bill guard (replaces the old PO-level 409) ─────────
  // The old guard blocked ANY 2nd invoice for a PO even when quantity
  // remained — that wrongly stopped legitimate multi-shipment invoicing. Now
  // we validate PER LINE that requested qty ≤ that source line's AVAILABLE:
  //   • GRN source (body.grnId): available = accepted_qty − invoiced_qty.
  //   • PO source (body.purchaseOrderId, no grnId): available = quantity −
  //     already-invoiced (summed across this PO's live PIs).
  // Only an over-drawn line is rejected; a 2nd PI is allowed when qty remains.
  // grnId resolves the GRN → its PO so poRef/header stay populated.
  let sourceGrnId: string | null = null;
  let sourceGrnOrgCode: string | null = null;
  if (body.grnId) {
    const grn = await db
      .prepare("SELECT id, poId, poNumber, purchase_org_code FROM grns WHERE id = ?")
      .bind(body.grnId)
      .first<{
        id: string;
        poId: string | null;
        poNumber: string | null;
        purchase_org_code?: string | null;
        purchaseOrgCode?: string | null;
      }>();
    if (!grn) {
      return c.json({ success: false, error: "Source GRN not found" }, 404);
    }
    sourceGrnId = grn.id;
    sourceGrnOrgCode =
      grn.purchaseOrgCode ?? grn.purchase_org_code ?? null;
    if (!poRef) poRef = grn.poNumber ?? null;

    if (normalizedItems && normalizedItems.ok) {
      // Load this GRN's lines (accepted + already-invoiced) keyed by id.
      const giRes = await db
        .prepare(
          "SELECT id, materialName, acceptedQty, invoiced_qty FROM grn_items WHERE grnId = ?",
        )
        .bind(sourceGrnId)
        .all<{
          id: number | string;
          materialName: string | null;
          acceptedQty: number;
          invoiced_qty?: number | null;
          invoicedQty?: number | null;
        }>();
      const giById = new Map<string, (typeof giRes.results)[number]>();
      for (const gi of giRes.results ?? []) giById.set(String(gi.id), gi);

      const lines: ConvertLineRequest[] = [];
      for (const r of normalizedItems.rows) {
        if (!r.grnItemId) continue; // fee/tax/non-stocked lines don't draw down
        const gi = giById.get(String(r.grnItemId));
        if (!gi) {
          return c.json(
            {
              success: false,
              error: `Line "${r.materialName}" references grn item ${r.grnItemId}, which is not part of GRN ${body.grnId}.`,
            },
            400,
          );
        }
        lines.push({
          ref: gi.materialName ?? r.materialName,
          orderedQty: Number(gi.acceptedQty) || 0,
          consumedQty: Number(gi.invoicedQty ?? gi.invoiced_qty ?? 0) || 0,
          requestedQty: r.qty,
        });
      }
      const guard = checkConvertAvailability(lines);
      if (!guard.ok) {
        return c.json({ success: false, error: guard.error }, 409);
      }
    }
  } else if (body.purchaseOrderId && normalizedItems && normalizedItems.ok) {
    // PO source without a GRN: cap each requested qty at the PO line's
    // remaining (quantity − already-invoiced across live PIs). Match lines to
    // PO lines by materialCode (the stable per-line key on both sides).
    //
    // Grouped BY PURCHASE ORDER (owner 2026-08-04): one supplier invoice
    // routinely covers several POs. Pooling them would measure every line
    // against the header PO's ceiling — over-invoicing one PO while wrongly
    // rejecting a line that is perfectly in budget on its own.
    const byPo = new Map<string, typeof normalizedItems.rows>();
    for (const r of normalizedItems.rows) {
      const poId = r.poId || String(body.purchaseOrderId);
      const bucket = byPo.get(poId) ?? [];
      bucket.push(r);
      byPo.set(poId, bucket);
    }

    for (const [poId, rows] of byPo) {
      const poItemsRes = await db
        .prepare(
          "SELECT material_code, materialName, quantity FROM purchase_order_items WHERE purchaseOrderId = ?",
        )
        .bind(poId)
        .all<{ material_code?: string | null; materialCode?: string | null; materialName: string | null; quantity: number }>();
      // Already-invoiced per material_code against THIS PO. Counts lines by
      // their own po_id as well as PIs whose header points here, so a
      // multi-PO invoice still contributes to the right ceiling.
      const invRes = await db
        .prepare(
          `SELECT pii.material_code AS mc, COALESCE(SUM(pii.qty), 0) AS qty
             FROM purchase_invoice_items pii
             JOIN purchase_invoices pi ON pi.id = pii.pi_id
            WHERE COALESCE(pii.po_id, pi.purchaseOrderId) = ? AND pi.status != 'CANCELLED'
            GROUP BY pii.material_code`,
        )
        .bind(poId)
        .all<{ mc?: string | null; material_code?: string | null; qty: number }>();
      const invByCode = new Map<string, number>();
      for (const row of invRes.results ?? []) {
        const code = String(row.mc ?? row.material_code ?? "");
        if (code) invByCode.set(code, Number(row.qty) || 0);
      }
      const orderedByCode = new Map<string, { name: string; qty: number }>();
      for (const po of poItemsRes.results ?? []) {
        const code = String(po.material_code ?? po.materialCode ?? "");
        if (!code) continue;
        const prev = orderedByCode.get(code);
        orderedByCode.set(code, {
          name: po.materialName ?? code,
          qty: (prev?.qty ?? 0) + (Number(po.quantity) || 0),
        });
      }
      const lines: ConvertLineRequest[] = [];
      for (const r of rows) {
        const code = r.materialCode ?? "";
        const ordered = code ? orderedByCode.get(code) : undefined;
        if (!ordered) continue; // line not matched to a PO line → not guarded here
        lines.push({
          ref: ordered.name,
          orderedQty: ordered.qty,
          consumedQty: invByCode.get(code) ?? 0,
          requestedQty: r.qty,
        });
      }
      const guard = checkConvertAvailability(lines);
      if (!guard.ok) {
        return c.json({ success: false, error: guard.error }, 409);
      }
    }
  }

  // Import override: a one-time historical import can supply the original piNo
  // (e.g. PI-2604-019 from the accounting system) so the number is preserved;
  // otherwise auto-generate the next sequence. A duplicate number is rejected.
  let piNo: string;
  const importPiNo = (body as { piNo?: unknown }).piNo;
  if (typeof importPiNo === "string" && /^PI-\d/.test(importPiNo.trim())) {
    piNo = importPiNo.trim();
    const dup = await db
      .prepare("SELECT piNo FROM purchase_invoices WHERE piNo = ? LIMIT 1")
      .bind(piNo)
      .first<{ piNo: string }>();
    if (dup)
      return c.json(
        { success: false, error: `Purchase invoice ${piNo} already exists` },
        409,
      );
  } else {
    piNo = await generatePiNo(db);
  }
  const id = `pi-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  // Owner term: fixed 1 month, by calendar month — due = end of next
  // month (src/lib/terms.ts). Enforced server-side.
  const piInvoiceDate = body.invoiceDate ?? now.split("T")[0];
  const piDueDate = nextMonthDueDate(piInvoiceDate);

  // When items[] is provided, the PI's amountSen is the sum of line totals
  // PLUS per-line tax PLUS any legacy TAX-line amount (overrides any explicit
  // body.amountSen). When omitted, fall back to body.amountSen for backward
  // compat with the header-only API shape.
  // Foreign PIs: incoming amounts are in the document currency — the
  // FOREIGN total is preserved in foreignAmountSen, everything stored is
  // converted to home MYR at the booking rate.
  // ── SST breakdown (owner 2026-06-30) ────────────────────────────────────
  // subtotal = sum of GOODS line amounts (lt !== 'TAX').
  // tax      = sum of per-line taxSen + any legacy TAX-line amount.
  // total    = subtotal + tax. Always overrides body.amountSen.
  const foreignSubtotalSen = normalizedItems && normalizedItems.ok
    ? normalizedItems.rows
        .filter((r) => r.lineType !== "TAX")
        .reduce((s, r) => s + r.lineTotalSen, 0)
    : 0;
  const foreignTaxSen = normalizedItems && normalizedItems.ok
    ? normalizedItems.rows.reduce(
        (s, r) => s + (r.taxSen || 0) + (r.lineType === "TAX" ? r.lineTotalSen : 0),
        0,
      )
    : 0;
  const foreignTotalSen = normalizedItems && normalizedItems.ok
    ? foreignSubtotalSen + foreignTaxSen
    : body.amountSen ?? 0;
  const amountSen = toHome(foreignTotalSen);
  const subtotalSenHome = toHome(foreignSubtotalSen);
  const taxSenHome = toHome(foreignTaxSen);

  // Resolve per-document purchase company. Order: body → source PO → source
  // GRN → supplier default → "HOOKKA". Never null in writes.
  const bodyOrg =
    typeof body.purchaseOrgCode === "string" && body.purchaseOrgCode.trim()
      ? body.purchaseOrgCode.trim()
      : "";
  let purchaseOrgCode: string = bodyOrg;
  if (!purchaseOrgCode && sourcePoOrgCode && String(sourcePoOrgCode).trim()) {
    purchaseOrgCode = String(sourcePoOrgCode).trim();
  }
  if (!purchaseOrgCode && sourceGrnOrgCode && String(sourceGrnOrgCode).trim()) {
    purchaseOrgCode = String(sourceGrnOrgCode).trim();
  }
  if (!purchaseOrgCode && body.supplierId) {
    const sup = await db
      .prepare("SELECT purchaseOrgCode FROM suppliers WHERE id = ?")
      .bind(body.supplierId)
      .first<{ purchaseOrgCode?: string | null; purchase_org_code?: string | null }>();
    const supOrg = sup?.purchaseOrgCode ?? sup?.purchase_org_code ?? null;
    if (supOrg && String(supOrg).trim()) purchaseOrgCode = String(supOrg).trim();
  }
  if (!purchaseOrgCode) purchaseOrgCode = "HOOKKA";

  // Source supplier document file id — owner 2026-06-30. Trimmed; empty → null.
  const sourceDocumentFileId =
    body.sourceDocumentFileId == null ||
    String(body.sourceDocumentFileId).trim() === ""
      ? null
      : String(body.sourceDocumentFileId).trim();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO purchase_invoices (
           id, piNo, purchaseOrderId, poRef, grn_id, supplierId, supplierName,
           invoiceDate, dueDate, amountSen, subtotal_sen, tax_sen, status, remarks,
           supplier_invoice_no, supplier_do_no,
           currency, fxRate, foreignAmountSen,
           purchase_org_code,
           source_document_file_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        piNo,
        body.purchaseOrderId ?? null,
        poRef,
        sourceGrnId,
        body.supplierId,
        body.supplierName,
        piInvoiceDate,
        piDueDate,
        amountSen,
        subtotalSenHome,
        taxSenHome,
        status,
        body.remarks ?? null,
        supplierInvoiceNo,
        supplierDoNo,
        currency,
        isForeign ? fxRate : null,
        isForeign ? foreignTotalSen : null,
        purchaseOrgCode,
        sourceDocumentFileId,
        now,
        now,
      ),
  ];

  if (normalizedItems && normalizedItems.ok) {
    for (const r of normalizedItems.rows) {
      statements.push(
        db
          .prepare(
            `INSERT INTO purchase_invoice_items (
               id, pi_id, material_code, material_name, supplier_sku,
               qty, unit_price_sen, line_total_sen, tax_sen, line_type, notes,
               grn_item_id, po_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            r.id,
            id,
            r.materialCode,
            r.materialName,
            r.supplierSku,
            r.qty,
            toHome(r.unitPriceSen),
            toHome(r.lineTotalSen),
            toHome(r.taxSen),
            r.lineType,
            r.notes,
            r.grnItemId,
            r.poId ?? body.purchaseOrderId ?? null,
            now,
            null,
          ),
      );
      // Convert-chain: when this line is sourced from a GRN line, increment
      // that grn_items.invoiced_qty IN THE SAME batch as the PI insert — this
      // is what makes the consume atomic (two concurrent PIs can't both bill
      // the same available qty: the second batch's guard already ran, and the
      // increment lands transactionally with the line write).
      if (r.grnItemId && r.qty > 0) {
        statements.push(
          db
            .prepare(
              "UPDATE grn_items SET invoiced_qty = COALESCE(invoiced_qty, 0) + ? WHERE id = ?",
            )
            .bind(r.qty, r.grnItemId),
        );
      }
    }
  }

  // A CONFIRMED-on-create PI must hit the GL exactly like the DRAFT → CONFIRMED
  // transition does (PUT below): DR mapped buckets · CR 400-0000. Without this
  // a PI born CONFIRMED (e.g. a bulk import that sets status directly) feeds AP
  // aging but never the ledger, so 400-0000 drifts from its subsidiary. Same
  // leg builder as the PUT path + ledgerHasSource keep it identical and
  // idempotent. Opening balances use /opening-balance/ap (isOpening, no GL) and
  // never reach this handler. (BUG-2026-06-23-007 — renamed APPROVED→CONFIRMED
  // as part of the 2026-06-29 lifecycle simplification.)
  const orgId = getOrgId(c);
  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ??
    null;
  if (
    status === "CONFIRMED" &&
    !(await ledgerHasSource(db, orgId, "purchase_invoice", id))
  ) {
    const lines =
      normalizedItems && normalizedItems.ok
        ? normalizedItems.rows.map((r) => ({
            mc: r.materialCode,
            amt: toHome(r.lineTotalSen),
            lt: r.lineType,
            taxAmt: toHome(r.taxSen),
          }))
        : [];
    const { bucket, pdefault } = await mapPurchaseLinesToAccounts(db, lines);
    const legs: Parameters<typeof buildJournalEntryStatements>[2] =
      buildPiApprovalLegs({
        piNo,
        supplierName: body.supplierName ?? "",
        apTotalSen: amountSen,
        drBucket: bucket,
        pdefault,
      }).map((leg) => ({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "purchase_invoice",
        sourceId: id,
        legNo: leg.legNo,
        accountCode: leg.accountCode,
        debitSen: leg.debitSen,
        creditSen: leg.creditSen,
        description: leg.description,
        actorUserId,
        orgId,
      }));
    const { statements: ls } = await buildJournalEntryStatements(
      db,
      orgId,
      legs,
    );
    statements.push(...ls);
  }

  try {
    await db.batch(statements);
  } catch (e) {
    // Pre-migration-0162 DB (currency columns absent): a plain MYR PI must
    // still save — retry with the legacy column list. A FOREIGN PI cannot
    // be stored truthfully without the columns, so that one fails loudly.
    if (isForeign) {
      console.error(`[pi] foreign PI ${id} insert failed:`, e);
      return c.json(
        { success: false, error: "Foreign-currency PIs need migration 0162 (currency columns) — run the paste-version SQL first." },
        400,
      );
    }
    // Legacy column list (no multi-currency cols). grn_id is kept — it is
    // self-applied by ensurePiMigrations() at the top of this handler, so it
    // reliably exists even on a pre-0162 DB. subtotal_sen/tax_sen are also
    // self-applied above so we always include them.
    statements[0] = db
      .prepare(
        `INSERT INTO purchase_invoices (
           id, piNo, purchaseOrderId, poRef, grn_id, supplierId, supplierName,
           invoiceDate, dueDate, amountSen, subtotal_sen, tax_sen, status, remarks,
           supplier_invoice_no, supplier_do_no, purchase_org_code,
           source_document_file_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id, piNo, body.purchaseOrderId ?? null, poRef, sourceGrnId, body.supplierId,
        body.supplierName, piInvoiceDate, piDueDate, amountSen, subtotalSenHome, taxSenHome, status,
        body.remarks ?? null, supplierInvoiceNo, supplierDoNo, purchaseOrgCode,
        sourceDocumentFileId,
        now, now,
      );
    await db.batch(statements);
  }

  // Remember what this invoice just proved: supplier wording ↔ internal code.
  // That pairing used to be discarded, so the same supplier document was
  // re-picked by hand every month (owner 2026-08-04).
  if (normalizedItems && normalizedItems.ok) {
    await learnSupplierBindings(
      db,
      String(body.supplierId ?? ""),
      normalizedItems.rows.map((r) => ({
        materialCode: r.materialCode,
        materialName: r.materialName,
        supplierSku: r.supplierSku,
        supplierDescription: r.materialName,
        unitPriceSen: r.unitPriceSen,
      })),
      () => `smb-${crypto.randomUUID().slice(0, 8)}`,
    ).catch(() => undefined);
  }

  await emitAudit(c, {
    resource: "purchase-invoices",
    resourceId: id,
    action: "create",
    after: {
      piNo,
      status,
      amountSen,
      currency,
      itemCount: normalizedItems && normalizedItems.ok ? normalizedItems.rows.length : 0,
    },
  });

  const created = await db
    .prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .first<PurchaseInvoiceRow>();
  const items = await loadItemsForPI(db, id);
  return c.json({
    success: true,
    data: created ? { ...rowToPI(created), items } : null,
  });
});

// ---------------------------------------------------------------------------
// backfillPiGlPostings — core GL-repost logic shared by the owner-facing
// button (POST /backfill-gl-postings below) AND the nightly cron
// (POST /api/internal/nightly-pi-gl-backfill in worker.ts) so the two paths
// can NEVER drift apart.
//
// Posts CONFIRMED PIs that never got their GL legs (created/confirmed before the
// create-as-CONFIRMED posting fix — BUG-2026-06-23-007 — or bulk-imported, so they
// fed AP aging + the P&L but never ledger_journal_entries → 400-0000 drifted from
// its subsidiary). Reuses the EXACT same leg path as create/transition
// (mapPurchaseLinesToAccounts → buildPiApprovalLegs → buildJournalEntryStatements)
// off the STORED items (already home MYR — toHome applied at create), and
// ledgerHasSource for idempotency, so re-running can NEVER double-post. Opening-AP
// PIs (is_opening) carry NO GL entry by design and are skipped.
export async function backfillPiGlPostings(
  db: D1Database,
  orgId: string,
  opts: { dry?: boolean; limit?: number; from?: string; actorUserId?: string | null } = {},
): Promise<{
  dry: boolean; from: string | null; scanned: number; alreadyPosted: number; openingSkipped: number;
  posted: number; postedRm: number; failed: number;
  samples: { piNo: string; rm: number }[]; failures: { piNo: string; error: string }[];
}> {
  const dry = !!opts.dry;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
  const from = (opts.from ?? "").trim();
  const actorUserId = opts.actorUserId ?? null;

  const pisRes = await db
    .prepare(
      `SELECT id, piNo, supplierName, amountSen, is_opening
         FROM purchase_invoices
        WHERE orgId = ? AND status NOT IN ('DRAFT','CANCELLED')${from ? " AND invoiceDate >= ?" : ""}
        ORDER BY invoiceDate ASC, id ASC`,
    )
    .bind(...(from ? [orgId, from] : [orgId]))
    .all<{ id: string; piNo: string | null; supplierName: string | null; amountSen: number | null; isOpening?: number | boolean | null; is_opening?: number | boolean | null }>();
  const pis = pisRes.results ?? [];

  let scanned = 0, alreadyPosted = 0, openingSkipped = 0, posted = 0, postedSen = 0, failed = 0;
  const samples: { piNo: string; rm: number }[] = [];
  const failures: { piNo: string; error: string }[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const pi of pis) {
    scanned++;
    if (pi.isOpening ?? pi.is_opening) { openingSkipped++; continue; }
    if (posted >= limit) break;
    try {
      if (await ledgerHasSource(db, orgId, "purchase_invoice", pi.id)) { alreadyPosted++; continue; }
      const items = await loadItemsForPI(db, pi.id);
      // Stored items are ALREADY home MYR (toHome at create) → no conversion here.
      const lines = items.map((it) => ({
        mc: it.materialCode,
        amt: it.lineTotalSen,
        lt: it.lineType,
        taxAmt: it.taxSen,
      }));
      const { bucket, pdefault } = await mapPurchaseLinesToAccounts(db, lines);
      const apTotalSen = Math.round(Number(pi.amountSen) || 0);
      const legs: Parameters<typeof buildJournalEntryStatements>[2] = buildPiApprovalLegs({
        piNo: pi.piNo ?? pi.id,
        supplierName: pi.supplierName ?? "",
        apTotalSen,
        drBucket: bucket,
        pdefault,
      }).map((leg) => ({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "purchase_invoice",
        sourceId: pi.id,
        legNo: leg.legNo,
        accountCode: leg.accountCode,
        debitSen: leg.debitSen,
        creditSen: leg.creditSen,
        description: leg.description,
        actorUserId,
        orgId,
      }));
      const { statements: ls } = await buildJournalEntryStatements(db, orgId, legs);
      if (!dry) statements.push(...ls);
      posted++;
      postedSen += apTotalSen;
      if (samples.length < 8) samples.push({ piNo: pi.piNo ?? pi.id, rm: apTotalSen / 100 });
    } catch (e) {
      failed++;
      if (failures.length < 8) failures.push({ piNo: pi.piNo ?? pi.id, error: String((e as Error)?.message ?? e) });
    }
  }
  if (!dry && statements.length) await db.batch(statements);

  return {
    dry,
    from: from || null,
    scanned,
    alreadyPosted,
    openingSkipped,
    posted,
    postedRm: Math.round(postedSen) / 100,
    failed,
    samples,
    failures,
  };
}

// POST /api/purchase-invoices/backfill-gl-postings — owner-facing button
// (Purchase Invoices page "Post to GL"). Read-safe knobs:
//   ?dry=1   → report what WOULD post, write nothing.
//   ?limit=N → post at most N new PIs (incremental verification).
// ---------------------------------------------------------------------------
// POST /repair-gl-visibility — one-shot repair (BUG-2026-07-08-003, OCEAN SKY
// "2605-922" RM 723): an ACTIVE purchase invoice whose GL legs are ALL hidden
// (a void/restore cycle that missed the unhide) is invisible to every report
// AND to the backfill (ledgerHasSource sees hidden rows too). If the document
// is ACTIVE and has base legs but zero visible ones, unhide the base legs.
app.post("/repair-gl-visibility", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "update");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { piId?: string };
  const piId = String(body.piId ?? "").trim();
  if (!piId) return c.json({ success: false, error: "piId is required" }, 400);
  const db = c.var.DB;
  const orgId = getOrgId(c);
  const pi = await db
    .prepare("SELECT id, pi_no, status FROM purchase_invoices WHERE id = ?")
    .bind(piId)
    .first<{ id: string; pi_no?: string; piNo?: string; status: string }>();
  if (!pi) return c.json({ success: false, error: "PI not found" }, 404);
  if (["DRAFT", "CANCELLED"].includes(pi.status)) {
    return c.json({ success: false, error: `PI is ${pi.status} — nothing to repair` }, 400);
  }
  const legs =
    (
      await db
        .prepare(
          `SELECT id, hidden FROM ledger_journal_entries
            WHERE source_id = ? AND org_id = ? AND source_type = 'purchase_invoice'`,
        )
        .bind(piId, orgId)
        .all<{ id: string; hidden?: number }>()
    ).results ?? [];
  const total = legs.length;
  const visible = legs.filter((l) => Number(l.hidden) !== 1).length;
  if (total === 0) return c.json({ success: false, error: "No base GL legs exist — use Post to GL instead" }, 400);
  if (visible > 0) return c.json({ success: false, error: `Legs already visible (${visible}/${total}) — nothing to repair` }, 400);
  await db
    .prepare(
      `UPDATE ledger_journal_entries SET hidden = 0
        WHERE source_id = ? AND org_id = ? AND source_type = 'purchase_invoice'`,
    )
    .bind(piId, orgId)
    .run();
  await emitAudit(c, {
    resource: "purchase-invoices",
    resourceId: piId,
    action: "update",
    after: { repair: "gl-visibility", piNo: pi.piNo ?? pi.pi_no ?? "", legsUnhidden: total },
  });
  return c.json({ success: true, data: { piNo: pi.piNo ?? pi.pi_no ?? "", legsUnhidden: total } });
});

app.post("/backfill-gl-postings", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "update");
  if (denied) return denied;
  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";
  const limitRaw = parseInt(c.req.query("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Infinity;
  // Optional floor: only post PIs dated >= from (the owner's opening cutoff —
  // anything earlier is carried by opening balances and must NOT be re-posted).
  const from = (c.req.query("from") ?? "").trim();
  const result = await backfillPiGlPostings(c.var.DB, getOrgId(c), { dry, limit, from, actorUserId });
  return c.json({ success: true, ...result });
});

// ---------------------------------------------------------------------------
// PUT /api/purchase-invoices/:id — update fields + status (with transition
// guard). Body: { status?, remarks?, invoiceDate?, dueDate?, amountSen? }
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  const db = c.var.DB;
  // Convert-chain columns must exist before we read/write invoiced_qty on a
  // cancel or items-replace.
  await ensurePiMigrations(db);
  const existing = await db
    .prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .first<PurchaseInvoiceRow>();
  if (!existing) return c.json({ success: false, error: "PI not found" }, 404);

  const body = await c.req.json().catch(() => ({})) as {
    status?: string;
    remarks?: string;
    invoiceDate?: string;
    dueDate?: string;
    amountSen?: number;
    supplierInvoiceNo?: string | null;
    supplierDoNo?: string | null;
    purchaseOrgCode?: string;
    items?: PurchaseInvoiceItemInput[];
  };

  // Status transition guard.
  if (body.status && body.status !== existing.status) {
    const allowed = VALID_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(body.status)) {
      return c.json(
        {
          success: false,
          error: `Invalid status transition: ${existing.status} → ${body.status}. Allowed: ${allowed.join(", ") || "none"}`,
        },
        400,
      );
    }
  }

  // If items[] is given, validate and use it to recompute amountSen.
  // If items[] is omitted, leave existing items + amountSen logic untouched.
  let normalizedItems: ReturnType<typeof normalizeItems> | null = null;
  if (body.items !== undefined) {
    // Line-item edits are allowed while DRAFT or CONFIRMED (owner ruling
    // 2026-06-22 / re-confirmed 2026-06-29 — "editable, with stock/ledger
    // following the change"). CONFIRMED edits flow into the GL CORRECTION
    // block below which reverses the original PI posting and posts a new one
    // for the delta. PAID has a settled payment (+ realised FX) and CANCELLED
    // has already released its GRN consumption, so both stay locked. The
    // shared rule + message keep the frontend Save handler and this guard in
    // lock-step.
    if (!isPiEditable(existing.status)) {
      return c.json(
        { success: false, error: piEditBlockedError(existing.status) },
        409,
      );
    }
    // A foreign-currency PI snapshots its exchange rate at creation (same as the
    // SST rule). This edit path has NO currency conversion — recomputing
    // amountSen from the new lines would store the FOREIGN figure as home MYR
    // and post a mis-scaled GL correction. Block it: to change a foreign PI,
    // cancel and re-raise it. (BUG-2026-06-23-008)
    const piCurrency = String(
      (existing as unknown as { currency?: string | null }).currency ?? "MYR",
    ).toUpperCase();
    if (piCurrency !== "MYR") {
      return c.json(
        {
          success: false,
          error:
            "A foreign-currency PI can't be line-edited — cancel and re-raise it (the exchange rate is fixed at creation).",
        },
        409,
      );
    }
    normalizedItems = normalizeItems(body.items);
    if (!normalizedItems.ok) {
      return c.json({ success: false, error: normalizedItems.error }, 400);
    }
    // GRN-sourced lines drive grn_items.invoiced_qty. When this PI is being
    // re-lined, the OLD consumption is decremented (buildGrnRestoreStatements)
    // and the NEW lines re-increment. Before we commit, verify the NEW qty per
    // GRN line does not push invoiced_qty PAST that line's acceptedQty — i.e.
    // the edited invoice can't claim more than the GRN received. This is the
    // ceiling counterpart to clampDecrement's floor; together they keep
    // invoiced_qty in [0, acceptedQty].
    const ceilGuard = await checkInvoicedQtyCeilingAfterEdit(
      db,
      id,
      normalizedItems.rows,
    );
    if (!ceilGuard.ok) {
      return c.json({ success: false, error: ceilGuard.error }, 409);
    }
  }

  // SST breakdown (owner 2026-06-30). When items[] is replaced we recompute
  // subtotal (sum of goods-line amounts) + tax (sum of per-line tax + any
  // legacy TAX-line amount); total is their sum. Otherwise the header
  // breakdown is left as-is.
  const recomputedSubtotal = normalizedItems && normalizedItems.ok
    ? normalizedItems.rows
        .filter((r) => r.lineType !== "TAX")
        .reduce((s, r) => s + r.lineTotalSen, 0)
    : null;
  const recomputedTax = normalizedItems && normalizedItems.ok
    ? normalizedItems.rows.reduce(
        (s, r) => s + (r.taxSen || 0) + (r.lineType === "TAX" ? r.lineTotalSen : 0),
        0,
      )
    : null;
  const recomputedAmount = recomputedSubtotal !== null && recomputedTax !== null
    ? recomputedSubtotal + recomputedTax
    : null;

  const existingRefs = existing as unknown as {
    supplierInvoiceNo?: string | null;
    supplier_invoice_no?: string | null;
    supplierDoNo?: string | null;
    supplier_do_no?: string | null;
    purchaseOrgCode?: string | null;
    purchase_org_code?: string | null;
  };
  const normRef = (v: string | null | undefined): string | null =>
    v == null || String(v).trim() === "" ? null : String(v).trim();
  const existingOrgCode =
    existingRefs.purchaseOrgCode ?? existingRefs.purchase_org_code ?? "HOOKKA";
  const existingRefsForBreakdown = existing as unknown as {
    subtotalSen?: number | null;
    subtotal_sen?: number | null;
    taxSen?: number | null;
    tax_sen?: number | null;
  };
  const existingSubtotal = Number(
    existingRefsForBreakdown.subtotalSen ?? existingRefsForBreakdown.subtotal_sen ?? 0,
  ) || 0;
  const existingTax = Number(
    existingRefsForBreakdown.taxSen ?? existingRefsForBreakdown.tax_sen ?? 0,
  ) || 0;
  const merged = {
    status: body.status ?? existing.status,
    remarks: body.remarks ?? existing.remarks,
    invoiceDate: body.invoiceDate ?? existing.invoiceDate,
    dueDate: body.dueDate ?? existing.dueDate,
    amountSen: recomputedAmount ?? body.amountSen ?? existing.amountSen,
    subtotalSen: recomputedSubtotal ?? existingSubtotal,
    taxSen: recomputedTax ?? existingTax,
    supplierInvoiceNo:
      body.supplierInvoiceNo !== undefined
        ? normRef(body.supplierInvoiceNo)
        : (existingRefs.supplierInvoiceNo ?? existingRefs.supplier_invoice_no ?? null),
    supplierDoNo:
      body.supplierDoNo !== undefined
        ? normRef(body.supplierDoNo)
        : (existingRefs.supplierDoNo ?? existingRefs.supplier_do_no ?? null),
    purchaseOrgCode:
      typeof body.purchaseOrgCode === "string" && body.purchaseOrgCode.trim()
        ? body.purchaseOrgCode.trim()
        : existingOrgCode || "HOOKKA",
  };
  const now = new Date().toISOString();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE purchase_invoices SET
           status = ?, remarks = ?, invoiceDate = ?, dueDate = ?, amountSen = ?,
           subtotal_sen = ?, tax_sen = ?,
           supplier_invoice_no = ?, supplier_do_no = ?, purchase_org_code = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        merged.status,
        merged.remarks,
        merged.invoiceDate,
        merged.dueDate,
        merged.amountSen,
        merged.subtotalSen,
        merged.taxSen,
        merged.supplierInvoiceNo,
        merged.supplierDoNo,
        merged.purchaseOrgCode,
        now,
        id,
      ),
  ];

  // Replace-all semantics for items[] when provided: DELETE existing, then
  // INSERT new. CASCADE on the FK doesn't help us here — that's only on PI
  // delete. Doing it inside the same batch keeps the swap atomic.
  //
  // Convert-chain re-sync (DRAFT or APPROVED — guarded above by isPiEditable +
  // the ceiling check): the OLD lines may have consumed grn_items.invoiced_qty.
  // Decrement that consumption first, then the new lines re-increment below —
  // net effect leaves invoiced_qty correct for whatever the operator changed
  // the lines to, never below 0 (clampDecrement) and never above acceptedQty
  // (checkInvoicedQtyCeilingAfterEdit).
  if (normalizedItems && normalizedItems.ok) {
    const restoreOld = await buildGrnRestoreStatements(db, id);
    statements.push(...restoreOld);
    statements.push(
      db.prepare("DELETE FROM purchase_invoice_items WHERE pi_id = ?").bind(id),
    );
    for (const r of normalizedItems.rows) {
      statements.push(
        db
          .prepare(
            `INSERT INTO purchase_invoice_items (
               id, pi_id, material_code, material_name, supplier_sku,
               qty, unit_price_sen, line_total_sen, tax_sen, line_type, notes,
               grn_item_id, po_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            r.id,
            id,
            r.materialCode,
            r.materialName,
            r.supplierSku,
            r.qty,
            r.unitPriceSen,
            r.lineTotalSen,
            r.taxSen,
            r.lineType,
            r.notes,
            r.grnItemId,
            // On update the header PO comes from the stored invoice, not the
            // body — a PUT does not re-declare it.
            r.poId ??
              (existing as unknown as { purchaseOrderId?: string | null }).purchaseOrderId ??
              null,
            now,
            null,
          ),
      );
      // Convert-chain: re-increment grn_items.invoiced_qty for the new lines
      // (the old consumption was decremented just above). Same atomic batch.
      if (r.grnItemId && r.qty > 0) {
        statements.push(
          db
            .prepare(
              "UPDATE grn_items SET invoiced_qty = COALESCE(invoiced_qty, 0) + ? WHERE id = ?",
            )
            .bind(r.qty, r.grnItemId),
        );
      }
    }
  }

  // Convert-chain RESTORE on cancel: if this PUT moves the PI to CANCELLED,
  // give back the GRN consumption. (CANCELLED is not in VALID_TRANSITIONS
  // today — the live remove path is DELETE — but if a cancel status is ever
  // wired this keeps invoiced_qty honest. Skipped when items[] was provided
  // since that branch already re-synced consumption.)
  if (
    !normalizedItems &&
    body.status === "CANCELLED" &&
    existing.status !== "CANCELLED"
  ) {
    const restore = await buildGrnRestoreStatements(db, id);
    statements.push(...restore);
  }

  // ---- GL posting on status transitions (Phase 7b APPROVED / 7c PAID) ----
  if (body.status && body.status !== existing.status) {
    try {
      const orgId = getOrgId(c);
      const actorUserId =
        (c as unknown as { get: (k: string) => string | undefined }).get(
          "userId",
        ) ?? null;
      const piNo = (existing as unknown as { piNo?: string }).piNo ?? id;

      if (
        merged.status === "CONFIRMED" &&
        !(await ledgerHasSource(db, orgId, "purchase_invoice", id))
      ) {
        const lines = normalizedItems?.ok
          ? normalizedItems.rows.map((r) => ({
              mc: r.materialCode,
              amt: r.lineTotalSen,
              lt: r.lineType,
              taxAmt: r.taxSen,
            }))
          : (
              (
                await db
                  .prepare(
                    "SELECT * FROM purchase_invoice_items WHERE pi_id = ?",
                  )
                  .bind(id)
                  .all<Record<string, unknown>>()
              ).results ?? []
            ).map((r) => ({
              mc: (r.material_code ?? r.materialCode ?? null) as
                | string
                | null,
              amt: Number(r.line_total_sen ?? r.lineTotalSen ?? 0),
              lt: String(r.line_type ?? r.lineType ?? "STOCKED"),
              taxAmt: Number(r.tax_sen ?? r.taxSen ?? 0),
            }));
        const { bucket, pdefault } = await mapPurchaseLinesToAccounts(
          db,
          lines,
        );
        const apTotal = Math.round(Number(merged.amountSen) || 0);
        const legs: Parameters<typeof buildJournalEntryStatements>[2] =
          buildPiApprovalLegs({
            piNo,
            supplierName: existing.supplierName ?? "",
            apTotalSen: apTotal,
            drBucket: bucket,
            pdefault,
          }).map((leg) => ({
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: "purchase_invoice",
            sourceId: id,
            legNo: leg.legNo,
            accountCode: leg.accountCode,
            debitSen: leg.debitSen,
            creditSen: leg.creditSen,
            description: leg.description,
            actorUserId,
            orgId,
          }));
        const { statements: ls } = await buildJournalEntryStatements(
          db,
          orgId,
          legs,
        );
        statements.push(...ls);
      } else if (
        merged.status === "PAID" &&
        !(await ledgerHasSource(db, orgId, "supplier_payment", id))
      ) {
        const bookedSen = Math.round(Number(merged.amountSen) || 0);
        // Phase 3.6 — realised FX on settling a FOREIGN PI: the payment-day
        // rate may differ from the booking rate. AP is cleared at the
        // BOOKED MYR, the bank pays the ACTUAL MYR, and the difference
        // posts to 530-0000 GAIN ON FOREIGN EXCHANGE (debit when a loss).
        const piCurrency = String(
          (existing as unknown as { currency?: string | null }).currency ?? "MYR",
        ).toUpperCase();
        const foreignSen =
          Number((existing as unknown as { foreignAmountSen?: number | null }).foreignAmountSen) || 0;
        let paidSen = bookedSen;
        if (piCurrency !== "MYR" && foreignSen > 0) {
          const payRate = Number((body as { payFxRate?: number }).payFxRate) || 0;
          if (!(payRate > 0)) {
            return c.json(
              { success: false, error: `This is a ${piCurrency} invoice — provide payFxRate (MYR per 1 ${piCurrency}, the payment-day rate) when marking it PAID` },
              400,
            );
          }
          paidSen = Math.round(foreignSen * payRate);
          statements.push(
            db.prepare("UPDATE purchase_invoices SET payFxRate = ? WHERE id = ?").bind(payRate, id),
          );
        }
        const spId = `sp-${crypto.randomUUID().slice(0, 8)}`;
        const today = new Date().toISOString().slice(0, 10);
        const payNo = await issueDocNumber(db, {
          bankAccountCode: apBankAcct("BANK_TRANSFER"),
          direction: "out",
          dateIso: today,
        });
        statements.push(
          db
            .prepare(
              `INSERT INTO supplier_payments (
                 id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
                 date, amountSen, bookedSen, method, reference, notes, orgId
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              spId,
              payNo,
              existing.supplierId,
              existing.supplierName ?? "",
              id,
              today,
              paidSen,
              bookedSen,
              "BANK_TRANSFER",
              piNo,
              `Auto on PI ${piNo} PAID`,
              orgId,
            ),
        );
        statements.push(
          db.prepare("UPDATE purchase_invoices SET paid_amount_sen = amount_sen WHERE id = ?").bind(id),
        );
        if (bookedSen > 0) {
          const legs: Parameters<typeof buildJournalEntryStatements>[2] = [
            {
              id: `lje-${crypto.randomUUID().slice(0, 12)}`,
              sourceType: "supplier_payment",
              sourceId: id,
              legNo: 1,
              accountCode: AP_CONTROL,
              debitSen: bookedSen,
              creditSen: 0,
              description: `AP settle · PI ${piNo}`,
              actorUserId,
              orgId,
            },
            {
              id: `lje-${crypto.randomUUID().slice(0, 12)}`,
              sourceType: "supplier_payment",
              sourceId: id,
              legNo: 2,
              accountCode: apBankAcct("BANK_TRANSFER"),
              debitSen: 0,
              creditSen: paidSen,
              description: `AP settle · PI ${piNo}${paidSen !== bookedSen ? ` · paid ${piCurrency} at payment-day rate` : ""}`,
              actorUserId,
              orgId,
            },
          ];
          const fxDiff = bookedSen - paidSen; // +ve → paid less → GAIN
          if (fxDiff !== 0) {
            legs.push({
              id: `lje-${crypto.randomUUID().slice(0, 12)}`,
              sourceType: "supplier_payment",
              sourceId: id,
              legNo: 3,
              accountCode: FX_GAIN_ACCT,
              debitSen: fxDiff < 0 ? -fxDiff : 0,
              creditSen: fxDiff > 0 ? fxDiff : 0,
              description: `Realised FX ${fxDiff > 0 ? "gain" : "loss"} · PI ${piNo}`,
              actorUserId,
              orgId,
            });
          }
          const { statements: ls } = await buildJournalEntryStatements(
            db,
            orgId,
            legs,
          );
          statements.push(...ls);
        }
      }
    } catch (e) {
      // Phase 1 (2026-06) — previously this catch only console.warn'd and
      // let the PI flip to APPROVED/PAID anyway, leaving the GL with NO AP
      // entry (trial balance silently out of sync, discoverable only via
      // logs). A status transition must never apply without its GL legs:
      // abort the whole request so the operator retries explicitly.
      console.error(`[ledger] failed to BUILD PI ${id} posting — aborting:`, e);
      return c.json(
        {
          success: false,
          error:
            "Failed to build the GL posting for this purchase invoice — the status change was NOT saved. Retry, and report if it persists.",
        },
        500,
      );
    }
  }

  // ---- GL CORRECTION on editing an already-CONFIRMED PI's amount ----
  // A CONFIRMED PI already posted its purchase + AP legs at the OLD amount. The
  // ledger is an append-only hash chain (journal-hash.ts) — we must NOT mutate
  // those legs. Instead, when an edit changes the amount, post a CORRECTING
  // double-entry for the DELTA against a fresh sourceId so the trial balance
  // re-syncs to the new total. A reduction reverses (credit purchase / debit
  // AP); an increase posts the same direction as the original. No transition is
  // happening here — this is the amount-changed path, distinct from the
  // status-transition block above. PAID/CANCELLED never reach here (the edit is
  // blocked by isPiEditable); legacy APPROVED rows get backfilled to CONFIRMED
  // by ensurePiMigrations() so they also flow through this path.
  if (
    normalizedItems &&
    normalizedItems.ok &&
    existing.status === "CONFIRMED" &&
    body.status === undefined && // pure edit, not a transition (handled above)
    recomputedAmount !== null &&
    recomputedAmount !== existing.amountSen
  ) {
    const editedItems = normalizedItems; // narrowed: ok-true for closure use
    try {
      const orgId = getOrgId(c);
      const actorUserId =
        (c as unknown as { get: (k: string) => string | undefined }).get(
          "userId",
        ) ?? null;
      const piNo = (existing as unknown as { piNo?: string }).piNo ?? id;
      const oldAmount = Math.round(Number(existing.amountSen) || 0);
      const newAmount = Math.round(Number(recomputedAmount) || 0);
      const delta = newAmount - oldAmount; // +ve → bill more, −ve → bill less

      // Distribute the NEW total across purchase accounts, subtract the OLD
      // distribution → per-account deltas. Each non-zero account delta debits
      // (when +) or credits (when −) the purchase bucket; AP control takes the
      // opposite side for the net delta. Reuses mapPurchaseLinesToAccounts so a
      // correction lands in the SAME 70x accounts the original PI debited.
      const newLines = editedItems.rows.map((r) => ({
        mc: r.materialCode,
        amt: r.lineTotalSen,
        lt: r.lineType,
        taxAmt: r.taxSen,
      }));
      const oldItemsRes = (
        await db
          .prepare("SELECT * FROM purchase_invoice_items WHERE pi_id = ?")
          .bind(id)
          .all<Record<string, unknown>>()
      ).results ?? [];
      const oldLines = oldItemsRes.map((r) => ({
        mc: (r.material_code ?? r.materialCode ?? null) as string | null,
        amt: Number(r.line_total_sen ?? r.lineTotalSen ?? 0),
        lt: String(r.line_type ?? r.lineType ?? "STOCKED"),
        taxAmt: Number(r.tax_sen ?? r.taxSen ?? 0),
      }));
      const { bucket: newBucket } = await mapPurchaseLinesToAccounts(db, newLines);
      const { bucket: oldBucket, pdefault } = await mapPurchaseLinesToAccounts(db, oldLines);
      const deltaBucket: Record<string, number> = {};
      for (const acct of new Set([...Object.keys(newBucket), ...Object.keys(oldBucket)])) {
        const d = (newBucket[acct] ?? 0) - (oldBucket[acct] ?? 0);
        if (d !== 0) deltaBucket[acct] = d;
      }
      // Tie the sum of account deltas to the header delta (rounding / unmapped
      // lines fall to the default purchase account, mirroring the post path).
      const sumDeltas = Object.values(deltaBucket).reduce((s, v) => s + v, 0);
      if (sumDeltas !== delta) {
        deltaBucket[pdefault] = (deltaBucket[pdefault] ?? 0) + (delta - sumDeltas);
      }

      const correctionSourceId = `${id}:edit-${Date.now()}`;
      const legs: Parameters<typeof buildJournalEntryStatements>[2] = [];
      let legNo = 1;
      for (const [acct, amt] of Object.entries(deltaBucket)) {
        if (amt === 0) continue;
        legs.push({
          id: `lje-${crypto.randomUUID().slice(0, 12)}`,
          sourceType: "purchase_invoice",
          sourceId: correctionSourceId,
          legNo: legNo++,
          accountCode: acct,
          debitSen: amt > 0 ? amt : 0,
          creditSen: amt < 0 ? -amt : 0,
          description: `Purchase edit · PI ${piNo}`,
          actorUserId,
          orgId,
        });
      }
      if (delta !== 0) {
        legs.push({
          id: `lje-${crypto.randomUUID().slice(0, 12)}`,
          sourceType: "purchase_invoice",
          sourceId: correctionSourceId,
          legNo: legNo++,
          accountCode: AP_CONTROL,
          debitSen: delta < 0 ? -delta : 0,
          creditSen: delta > 0 ? delta : 0,
          description: `AP edit · PI ${piNo} · ${existing.supplierName ?? ""}`,
          actorUserId,
          orgId,
        });
      }
      if (legs.length > 0) {
        const { statements: ls } = await buildJournalEntryStatements(db, orgId, legs);
        statements.push(...ls);
      }
    } catch (e) {
      console.error(`[ledger] failed to BUILD PI ${id} edit-correction — aborting:`, e);
      return c.json(
        {
          success: false,
          error:
            "Failed to build the GL correction for this invoice edit — the change was NOT saved. Retry, and report if it persists.",
        },
        500,
      );
    }
  }

  await db.batch(statements);

  await emitAudit(c, {
    resource: "purchase-invoices",
    resourceId: id,
    action: "update",
    before: existing,
    after: {
      ...merged,
      itemsReplaced: normalizedItems && normalizedItems.ok
        ? normalizedItems.rows.length
        : undefined,
    },
  });

  const updated = await db
    .prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .first<PurchaseInvoiceRow>();
  const items = await loadItemsForPI(db, id);
  return c.json({
    success: true,
    data: updated ? { ...rowToPI(updated), items } : null,
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/purchase-invoices/:id — only DRAFT rows are deletable.
// Approved / paid PIs are kept for audit (use PUT to flip back to DRAFT
// first if you really need to delete one). Line items are removed by the
// purchase_invoice_items.pi_id ON DELETE CASCADE FK — no app-side delete.
//
// Convert-chain RESTORE: any line that consumed a GRN line's invoiced_qty
// gives it back so the GRN line is available to invoice again. The decrement
// runs in the SAME batch as the row delete (atomic) and is computed BEFORE
// the delete, since the FK cascade is about to remove the lines it reads.
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "delete");
  if (denied) return denied;

  const id = c.req.param("id");
  const db = c.var.DB;
  await ensurePiMigrations(db);
  const existing = await db
    .prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .first<PurchaseInvoiceRow>();
  if (!existing) return c.json({ success: false, error: "PI not found" }, 404);
  if (existing.status !== "DRAFT") {
    return c.json(
      {
        success: false,
        error: `Only DRAFT invoices can be deleted (current: ${existing.status})`,
      },
      409,
    );
  }

  // Restore GRN availability for every line this PI consumed, then delete —
  // both in one atomic batch so a partial failure can't leave invoiced_qty
  // double-counted with the rows gone.
  const restore = await buildGrnRestoreStatements(db, id);
  await db.batch([
    ...restore,
    db.prepare("DELETE FROM purchase_invoices WHERE id = ?").bind(id),
  ]);

  await emitAudit(c, {
    resource: "purchase-invoices",
    resourceId: id,
    action: "delete",
    before: existing,
  });
  return c.json({ success: true });
});

export default app;
