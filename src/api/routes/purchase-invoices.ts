// ---------------------------------------------------------------------------
// D1-backed purchase_invoices route.
//
// Wired 2026-04-26 to replace the previous client-side mock in
// src/pages/procurement/pi.tsx (audit #2). Shape matches the old in-memory
// PurchaseInvoice type so the SPA upgrade is a swap-out, not a rewrite.
//
// Lifecycle: DRAFT → PENDING_APPROVAL → APPROVED → PAID. PAID is terminal.
// DELETE is gated to DRAFT only — once approved we keep the row for audit.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";
import { getOrgId } from "../lib/tenant";
import {
  buildJournalEntryStatements,
  ledgerHasSource,
} from "../lib/journal-hash";
import { nextMonthDueDate } from "../../lib/terms";
import { issueDocNumber } from "../lib/doc-number-service";

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
  lines: { mc: string | null; amt: number; lt: string }[],
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
  lineType: PurchaseInvoiceItemLineType;
  notes: string | null;
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
  notes: string | null;
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

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["PENDING_APPROVAL", "APPROVED"],
  PENDING_APPROVAL: ["APPROVED", "DRAFT"],
  APPROVED: ["PAID"],
  PAID: [],
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
  };
  return {
    id: r.id,
    piNo: r.piNo,
    purchaseOrderId: r.purchaseOrderId ?? "",
    poRef: r.poRef ?? "",
    supplierId: r.supplierId,
    supplier: r.supplierName, // SPA reads `.supplier` (legacy field name)
    supplierName: r.supplierName,
    invoiceDate: r.invoiceDate ?? "",
    dueDate: r.dueDate ?? "",
    amountSen: r.amountSen,
    paidAmountSen: Number(fx.paid_amount_sen ?? r.paidAmountSen ?? 0),
    status: r.status,
    remarks: r.remarks ?? "",
    currency: fx.currency ?? "MYR",
    fxRate: fx.fxRate ?? null,
    foreignAmountSen: fx.foreignAmountSen ?? null,
    payFxRate: fx.payFxRate ?? null,
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
    lineType: VALID_LINE_TYPES.includes(lineType) ? lineType : "OTHER",
    notes: r.notes ?? null,
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
  lineType?: string;
  notes?: string | null;
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
    lineType: PurchaseInvoiceItemLineType;
    notes: string | null;
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
    lineType: PurchaseInvoiceItemLineType;
    notes: string | null;
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
    rows.push({
      id: `pii-${crypto.randomUUID().slice(0, 8)}`,
      materialCode: matCode,
      materialName,
      supplierSku: supSku,
      qty,
      unitPriceSen,
      lineTotalSen: Math.round(qty * unitPriceSen),
      lineType,
      notes: it.notes == null ? null : String(it.notes),
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
//   ?status=DRAFT,PENDING_APPROVAL  (CSV)
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
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.var.DB;
  const row = await db
    .prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .first<PurchaseInvoiceRow>();
  if (!row) return c.json({ success: false, error: "PI not found" }, 404);
  const items = await loadItemsForPI(db, id);
  return c.json({ success: true, data: { ...rowToPI(row), items } });
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
  const body = await c.req.json().catch(() => ({})) as {
    purchaseOrderId?: string;
    supplierId?: string;
    supplierName?: string;
    invoiceDate?: string;
    dueDate?: string;
    amountSen?: number;
    remarks?: string;
    status?: string;
    items?: PurchaseInvoiceItemInput[];
    currency?: string;
    fxRate?: number;
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

  // Validate items[] up-front so we can fail before any insert.
  let normalizedItems: ReturnType<typeof normalizeItems> | null = null;
  if (body.items !== undefined) {
    normalizedItems = normalizeItems(body.items);
    if (!normalizedItems.ok) {
      return c.json({ success: false, error: normalizedItems.error }, 400);
    }
  }

  // Resolve poRef from purchaseOrderId if given.
  let poRef: string | null = null;
  if (body.purchaseOrderId) {
    const po = await db
      .prepare("SELECT poNo FROM purchase_orders WHERE id = ?")
      .bind(body.purchaseOrderId)
      .first<{ poNo: string }>();
    poRef = po?.poNo ?? null;
  }

  const piNo = await generatePiNo(db);
  const id = `pi-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  // Owner term: fixed 1 month, by calendar month — due = end of next
  // month (src/lib/terms.ts). Enforced server-side.
  const piInvoiceDate = body.invoiceDate ?? now.split("T")[0];
  const piDueDate = nextMonthDueDate(piInvoiceDate);

  // When items[] is provided, the PI's amountSen is the sum of line totals
  // (overrides any explicit body.amountSen). When omitted, fall back to
  // body.amountSen for backward compat with the header-only API shape.
  // Foreign PIs: incoming amounts are in the document currency — the
  // FOREIGN total is preserved in foreignAmountSen, everything stored is
  // converted to home MYR at the booking rate.
  const foreignTotalSen = normalizedItems && normalizedItems.ok
    ? normalizedItems.rows.reduce((s, r) => s + r.lineTotalSen, 0)
    : body.amountSen ?? 0;
  const amountSen = toHome(foreignTotalSen);

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO purchase_invoices (
           id, piNo, purchaseOrderId, poRef, supplierId, supplierName,
           invoiceDate, dueDate, amountSen, status, remarks,
           currency, fxRate, foreignAmountSen,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        piNo,
        body.purchaseOrderId ?? null,
        poRef,
        body.supplierId,
        body.supplierName,
        piInvoiceDate,
        piDueDate,
        amountSen,
        status,
        body.remarks ?? null,
        currency,
        isForeign ? fxRate : null,
        isForeign ? foreignTotalSen : null,
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
               qty, unit_price_sen, line_total_sen, line_type, notes,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            r.lineType,
            r.notes,
            now,
            null,
          ),
      );
    }
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
    statements[0] = db
      .prepare(
        `INSERT INTO purchase_invoices (
           id, piNo, purchaseOrderId, poRef, supplierId, supplierName,
           invoiceDate, dueDate, amountSen, status, remarks,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id, piNo, body.purchaseOrderId ?? null, poRef, body.supplierId,
        body.supplierName, piInvoiceDate, piDueDate, amountSen, status,
        body.remarks ?? null, now, now,
      );
    await db.batch(statements);
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
// PUT /api/purchase-invoices/:id — update fields + status (with transition
// guard). Body: { status?, remarks?, invoiceDate?, dueDate?, amountSen? }
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  const db = c.var.DB;
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
    // Line-item edits are DRAFT-only — mirrors the Edit gate on the detail page.
    // Rewriting lines after APPROVED/PAID would desync the already-posted GL
    // entry (and the amountSen the GL was posted against). Reject, don't paper.
    if (existing.status !== "DRAFT") {
      return c.json(
        {
          success: false,
          error: `Line items can only be edited while the invoice is DRAFT (current: ${existing.status}).`,
        },
        409,
      );
    }
    normalizedItems = normalizeItems(body.items);
    if (!normalizedItems.ok) {
      return c.json({ success: false, error: normalizedItems.error }, 400);
    }
  }

  const recomputedAmount = normalizedItems && normalizedItems.ok
    ? normalizedItems.rows.reduce((s, r) => s + r.lineTotalSen, 0)
    : null;

  const merged = {
    status: body.status ?? existing.status,
    remarks: body.remarks ?? existing.remarks,
    invoiceDate: body.invoiceDate ?? existing.invoiceDate,
    dueDate: body.dueDate ?? existing.dueDate,
    amountSen: recomputedAmount ?? body.amountSen ?? existing.amountSen,
  };
  const now = new Date().toISOString();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE purchase_invoices SET
           status = ?, remarks = ?, invoiceDate = ?, dueDate = ?, amountSen = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        merged.status,
        merged.remarks,
        merged.invoiceDate,
        merged.dueDate,
        merged.amountSen,
        now,
        id,
      ),
  ];

  // Replace-all semantics for items[] when provided: DELETE existing, then
  // INSERT new. CASCADE on the FK doesn't help us here — that's only on PI
  // delete. Doing it inside the same batch keeps the swap atomic.
  if (normalizedItems && normalizedItems.ok) {
    statements.push(
      db.prepare("DELETE FROM purchase_invoice_items WHERE pi_id = ?").bind(id),
    );
    for (const r of normalizedItems.rows) {
      statements.push(
        db
          .prepare(
            `INSERT INTO purchase_invoice_items (
               id, pi_id, material_code, material_name, supplier_sku,
               qty, unit_price_sen, line_total_sen, line_type, notes,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            r.lineType,
            r.notes,
            now,
            null,
          ),
      );
    }
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
        merged.status === "APPROVED" &&
        !(await ledgerHasSource(db, orgId, "purchase_invoice", id))
      ) {
        const lines = normalizedItems?.ok
          ? normalizedItems.rows.map((r) => ({
              mc: r.materialCode,
              amt: r.lineTotalSen,
              lt: r.lineType,
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
            }));
        const { bucket, pdefault } = await mapPurchaseLinesToAccounts(
          db,
          lines,
        );
        const apTotal = Math.round(Number(merged.amountSen) || 0);
        const sumLines = Object.values(bucket).reduce((s, v) => s + v, 0);
        if (sumLines !== apTotal)
          bucket[pdefault] = (bucket[pdefault] ?? 0) + (apTotal - sumLines);
        const legs: Parameters<typeof buildJournalEntryStatements>[2] = [];
        let legNo = 1;
        for (const [acct, amt] of Object.entries(bucket)) {
          if (amt === 0) continue;
          legs.push({
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: "purchase_invoice",
            sourceId: id,
            legNo: legNo++,
            accountCode: acct,
            debitSen: amt,
            creditSen: 0,
            description: `Purchase · PI ${piNo}`,
            actorUserId,
            orgId,
          });
        }
        legs.push({
          id: `lje-${crypto.randomUUID().slice(0, 12)}`,
          sourceType: "purchase_invoice",
          sourceId: id,
          legNo: legNo++,
          accountCode: AP_CONTROL,
          debitSen: 0,
          creditSen: apTotal,
          description: `AP · PI ${piNo} · ${existing.supplierName ?? ""}`,
          actorUserId,
          orgId,
        });
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
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "delete");
  if (denied) return denied;

  const id = c.req.param("id");
  const db = c.var.DB;
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
  await db
    .prepare("DELETE FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .run();
  await emitAudit(c, {
    resource: "purchase-invoices",
    resourceId: id,
    action: "delete",
    before: existing,
  });
  return c.json({ success: true });
});

export default app;
