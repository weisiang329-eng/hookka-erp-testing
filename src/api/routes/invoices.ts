// ---------------------------------------------------------------------------
// D1-backed invoices route.
//
// Mirrors the old src/api/routes/invoices.ts response shape so the SPA
// frontend doesn't need any changes. `items` joins invoice_items; `payments`
// joins invoice_payments. Invoice creation still requires a DELIVERED
// deliveryOrderId, and flips the DO status to INVOICED in the same batch.
//
// When an invoice transitions to PAID (either via a direct PUT setting
// status=PAID / paidAmount ≥ totalSen, or via a payment allocation in
// payments.ts), we cascade the linked SO to CLOSED *once every invoice
// attached to that SO is PAID*. An SO can fan out to multiple DOs →
// multiple invoices; closing the SO on the first fully-paid invoice would
// be wrong. The exported helper `previewCascadeSOClosed` walks back
// invoice → DO → SO, probes every sibling invoice, and returns the batch
// statements to flip the SO + write a so_status_changes audit row.
// Idempotent — running against an already-CLOSED SO is a no-op.
// payments.ts imports the same helper so both paths stay in lock-step.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
// Rollup: S3 won the audit/journal-hash signature change (batched into the
// invoice txn via buildAuditStatement + buildJournalEntryStatements). S4's
// pre-S3 emitAudit/appendJournalEntries variants are superseded. S4's
// getOrgId import is additive and stays.
import {
  buildAuditStatement,
  recordAuditCreatedMetric,
} from "../lib/audit";
import {
  buildJournalEntryStatements,
  ledgerHasSource,
} from "../lib/journal-hash";
import { getOrgId } from "../lib/tenant";
import { checkInvoiceLocked, lockedResponse } from "../lib/lock-helpers";
import { readIdempotencyKey, withIdempotency } from "../lib/idempotency";
import { parseDebtorCode } from "../../lib/debtor";
import { nextMonthDueDate } from "../../lib/terms";

const app = new Hono<Env>();

// Product-category → sales account (Phase 4). Bedframe & "everything else"
// fall to the generic SALES account; sofa & accessory have their own.
const SALES_ACCT: Record<string, string> = {
  BEDFRAME: "500-0000",
  SOFA: "500-0020",
  ACCESSORY: "500-0030",
};
export type InvLedgerLeg = {
  id: string;
  sourceType: string;
  sourceId: string;
  legNo: number;
  accountCode: string;
  debitSen: number;
  creditSen: number;
  description: string;
  actorUserId: string | null;
  orgId: string;
};

// Build the double-entry legs for a sales-invoice post (or its reversal):
//   DR  <debtor control>          subtotal + tax
//   CR  500-0000/0020/0030        subtotal (split by product category)
//   CR  350-0000 GST output       tax        (only if > 0)
// Credits are reconciled to EXACTLY subtotalSen so debits == credits even
// when invoice_items don't sum cleanly. `reverse` swaps DR/CR and tags the
// source 'invoice_void' for an idempotent, auditable reversal.
export async function buildInvoiceLedgerLegs(
  db: Env["Variables"]["DB"],
  orgId: string,
  inv: {
    id: string;
    invoiceNo: string;
    customerId: string;
    subtotalSen: number;
  },
  actorUserId: string | null,
  reverse: boolean,
): Promise<{ legs: InvLedgerLeg[]; taxSen: number }> {
  const subtotal = Math.max(0, Math.round(inv.subtotalSen) || 0);

  // 1. Debtor control account from the customer's debtor code.
  const cust = await db
    .prepare("SELECT code FROM customers WHERE id = ?")
    .bind(inv.customerId)
    .first<{ code: string }>();
  const parsed = parseDebtorCode(cust?.code);
  const controlCode = parsed.ok ? parsed.controlCode : "300-0000";

  // 2. Split subtotal by product category (from invoice_items ⨝ products),
  //    allocated proportionally and reconciled to subtotal exactly.
  const [itemsRes, prodRes] = await Promise.all([
    db
      .prepare(
        "SELECT productCode, totalSen FROM invoice_items WHERE invoiceId = ?",
      )
      .bind(inv.id)
      .all<{ productCode: string; totalSen: number }>(),
    db.prepare("SELECT code, category FROM products").all<{
      code: string;
      category: string;
    }>(),
  ]);
  const cat = new Map<string, string>();
  for (const p of prodRes.results ?? []) cat.set(p.code, p.category);
  const bucket: Record<string, number> = {};
  for (const it of itemsRes.results ?? []) {
    const acct =
      SALES_ACCT[cat.get(it.productCode) ?? ""] ?? SALES_ACCT.BEDFRAME;
    bucket[acct] = (bucket[acct] ?? 0) + (Number(it.totalSen) || 0);
  }
  const itemsTotal = Object.values(bucket).reduce((s, v) => s + v, 0);
  const salesLegs: { acct: string; amt: number }[] = [];
  if (itemsTotal <= 0 || Object.keys(bucket).length === 0) {
    salesLegs.push({ acct: SALES_ACCT.BEDFRAME, amt: subtotal });
  } else {
    const codes = Object.keys(bucket);
    let allocated = 0;
    codes.forEach((code, i) => {
      const amt =
        i === codes.length - 1
          ? subtotal - allocated // last bucket absorbs rounding
          : Math.round((bucket[code] / itemsTotal) * subtotal);
      allocated += amt;
      salesLegs.push({ acct: code, amt });
    });
  }

  // 3. GST from the operator-configured rate.
  const gstRow = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("gst_rate_pct")
    .first<{ value: string }>();
  let pct = 0;
  try {
    const v = JSON.parse(gstRow?.value ?? "null") as { pct?: number } | null;
    if (v && typeof v.pct === "number" && isFinite(v.pct)) pct = v.pct;
  } catch {
    pct = 0;
  }
  const taxSen = Math.max(0, Math.round((subtotal * pct) / 100));

  const sourceType = reverse ? "invoice_void" : "invoice";
  const tag = reverse ? "REVERSAL · " : "";
  const dr = (n: number) => (reverse ? 0 : n);
  const cr = (n: number) => (reverse ? n : 0);
  // On reversal the debtor leg flips to a credit, sales/GST to debits.
  const rdr = (n: number) => (reverse ? n : 0);
  const rcr = (n: number) => (reverse ? 0 : n);
  const legs: InvLedgerLeg[] = [];
  let legNo = 1;
  legs.push({
    id: `lje-${crypto.randomUUID().slice(0, 12)}`,
    sourceType,
    sourceId: inv.id,
    legNo: legNo++,
    accountCode: controlCode,
    debitSen: dr(subtotal + taxSen),
    creditSen: cr(subtotal + taxSen),
    description: `${tag}AR · invoice ${inv.invoiceNo}`,
    actorUserId,
    orgId,
  });
  for (const s of salesLegs) {
    if (s.amt === 0) continue;
    legs.push({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType,
      sourceId: inv.id,
      legNo: legNo++,
      accountCode: s.acct,
      debitSen: rdr(s.amt),
      creditSen: rcr(s.amt),
      description: `${tag}Sales · invoice ${inv.invoiceNo}`,
      actorUserId,
      orgId,
    });
  }
  if (taxSen > 0) {
    legs.push({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType,
      sourceId: inv.id,
      legNo: legNo++,
      accountCode: "350-0000",
      debitSen: rdr(taxSen),
      creditSen: rcr(taxSen),
      description: `${tag}GST output · invoice ${inv.invoiceNo}`,
      actorUserId,
      orgId,
    });
  }
  return { legs, taxSen };
}

type InvoiceRow = {
  id: string;
  invoiceNo: string;
  deliveryOrderId: string | null;
  doNo: string | null;
  salesOrderId: string | null;
  companySOId: string | null;
  customerId: string;
  customerName: string;
  customerState: string | null;
  // PR 5 (2026-05-20) — full customer contact block snapshotted from
  // the source DO at invoice-create time. Source: delivery_orders'
  // delivery_address / contact_person / contact_phone / customer_po_id.
  customerAddress: string | null;
  attention: string | null;
  customerPhone: string | null;
  customerPOId: string | null;
  hubId: string | null;
  hubName: string | null;
  subtotalSen: number;
  totalSen: number;
  status: string;
  invoiceDate: string | null;
  dueDate: string | null;
  paidAmount: number;
  paymentDate: string | null;
  paymentMethod: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type InvoiceItemRow = {
  id: string;
  invoiceId: string;
  productCode: string | null;
  productName: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
  // Per-line price build-up (migration 0121). Editable on the invoice;
  // priceEdited=1 means the invoice's own figures are authoritative and
  // override the sales-order-derived fallback at print time.
  basePriceSen: number | null;
  divanPriceSen: number | null;
  legPriceSen: number | null;
  specialOrderPriceSen: number | null;
  priceEdited: number | null;
};

type InvoicePaymentRow = {
  id: string;
  invoiceId: string;
  date: string;
  amountSen: number;
  method: string | null;
  reference: string | null;
};

const INV_VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["PAID", "PARTIAL_PAID", "OVERDUE", "CANCELLED"],
  PARTIAL_PAID: ["PAID", "OVERDUE", "CANCELLED"],
  OVERDUE: ["PAID", "PARTIAL_PAID", "CANCELLED"],
  PAID: [],
  CANCELLED: [],
};

function rowToItem(row: InvoiceItemRow) {
  return {
    id: row.id,
    productCode: row.productCode ?? "",
    productName: row.productName ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricCode: row.fabricCode ?? "",
    quantity: row.quantity,
    unitPriceSen: row.unitPriceSen,
    totalSen: row.totalSen,
    basePriceSen: Number(row.basePriceSen) || 0,
    divanPriceSen: Number(row.divanPriceSen) || 0,
    legPriceSen: Number(row.legPriceSen) || 0,
    specialOrderPriceSen: Number(row.specialOrderPriceSen) || 0,
    priceEdited: Number(row.priceEdited) || 0,
  };
}

function rowToPayment(row: InvoicePaymentRow) {
  return {
    id: row.id,
    date: row.date,
    amountSen: row.amountSen,
    method: row.method ?? "BANK_TRANSFER",
    reference: row.reference ?? "",
  };
}

function rowToInvoice(
  row: InvoiceRow,
  items: InvoiceItemRow[] = [],
  payments: InvoicePaymentRow[] = [],
) {
  return {
    id: row.id,
    invoiceNo: row.invoiceNo,
    deliveryOrderId: row.deliveryOrderId ?? "",
    doNo: row.doNo ?? "",
    salesOrderId: row.salesOrderId ?? "",
    companySOId: row.companySOId ?? "",
    customerId: row.customerId,
    customerName: row.customerName,
    customerState: row.customerState ?? "",
    // PR 5 — return the new customer-block fields so the PDF
    // generator's `invoice.customerAddress || invoice.customerState`
    // fallback at generate-invoice-pdf.ts:77 finally has a real value
    // to read instead of always falling back to state.
    customerAddress: row.customerAddress ?? "",
    attention: row.attention ?? "",
    customerPhone: row.customerPhone ?? "",
    customerPOId: row.customerPOId ?? "",
    hubId: row.hubId,
    hubName: row.hubName ?? "",
    items: items
      .filter((i) => i.invoiceId === row.id)
      .map(rowToItem),
    subtotalSen: row.subtotalSen,
    totalSen: row.totalSen,
    status: row.status,
    invoiceDate: row.invoiceDate ?? "",
    dueDate: row.dueDate ?? "",
    paidAmount: row.paidAmount,
    paymentDate: row.paymentDate,
    paymentMethod: row.paymentMethod ?? "",
    payments: payments
      .filter((p) => p.invoiceId === row.id)
      .map(rowToPayment),
    notes: row.notes ?? "",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// rowToInvoiceList — slim variant of rowToInvoice for the LIST endpoint
// (GET /api/invoices). The Invoices list page (src/pages/invoices/index.tsx)
// — its DataGrid columns (invoiceNo, doNo, customerName, invoiceDate,
// dueDate, totalSen, paidAmount, status), its global search / per-column
// filters (all read column `key` only), its status/customer/date filters,
// its KPI cards (Total, Outstanding, Collected MTD, Overdue read status /
// totalSen / paidAmount / invoiceDate), and its AR Aging tab (status /
// totalSen / paidAmount / dueDate / customerName) — only ever read the
// invoice's own scalar columns. It NEVER reads the nested `items` or
// `payments` arrays of a row. There is no CSV export on this page and no
// base64 image field anywhere in the invoice payload.
//
// So the list-only slim payload drops the two heavy nested arrays — full
// invoice_items rows (incl. the per-line price build-up) and invoice_payments
// rows — down to empty arrays. The `items` / `payments` keys are kept so the
// response shape and the `Invoice` type contract (items: InvoiceItem[],
// payments: InvoicePayment[]) stay valid. The detail endpoint GET /:id keeps
// the full rowToInvoice payload — double-clicking into an invoice fetches
// everything separately. MONEY-PAGE SAFE: every visible/filterable/sortable/
// KPI figure is a top-level scalar and is returned untouched by rowToInvoice
// via the spread below.
// ---------------------------------------------------------------------------
function rowToInvoiceList(row: InvoiceRow) {
  return {
    ...rowToInvoice(row, [], []),
    items: [] as ReturnType<typeof rowToItem>[],
    payments: [] as ReturnType<typeof rowToPayment>[],
  };
}

function genInvoiceId(): string {
  return `inv-${crypto.randomUUID().slice(0, 8)}`;
}

function genInvoiceItemId(): string {
  return `invi-${crypto.randomUUID().slice(0, 8)}`;
}

function genInvoicePaymentId(): string {
  return `invpay-${crypto.randomUUID().slice(0, 8)}`;
}

// INV-YYMM-NNN sequential. Bug fix 2026-04-28: previous random hex tail was
// not monotonic and could collide. Pulls max-existing-suffix+1 in the
// (year, month) bucket so new invoices always increment.
// Exported so delivery-orders.ts can share the same source of truth.
export async function nextInvoiceNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}`;
  const prefix = `INV-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT invoiceNo FROM invoices WHERE invoiceNo LIKE ? ORDER BY invoiceNo DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ invoiceNo: string }>();
  if (!res) return `${prefix}001`;
  const tail = res.invoiceNo.replace(prefix, "");
  const seq = parseInt(tail, 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

function genStatusChangeId(): string {
  return `sc-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// previewCascadeSOClosed
//
// Called from inside a PUT handler that is about to flip an invoice to PAID
// as part of its own batch. The current invoice's PAID status is in-flight
// (not yet on disk); every sibling invoice is read straight from D1.
//
// Returns the extra batch statements that, when appended to the caller's
// batch, flip the linked SO to CLOSED and append a so_status_changes audit
// row *only if* every invoice against every DO of that SO is PAID or
// CANCELLED (the in-flight invoice is treated as PAID).
//
// Idempotent:
//   * no-op if invoice has no linked DO / SO;
//   * no-op if the SO is already CLOSED or CANCELLED;
//   * no-op if any sibling invoice is still unpaid.
//
// Handles missing `so_status_changes` table gracefully by probing once
// before appending the INSERT (so older deployments still close the SO
// even without the audit row).
// ---------------------------------------------------------------------------
export async function previewCascadeSOClosed(
  db: D1Database,
  invoiceId: string,
  deliveryOrderId: string | null,
  nowIso: string,
  changedBy = "System",
): Promise<D1PreparedStatement[]> {
  if (!deliveryOrderId) return [];
  const doRow = await db
    .prepare("SELECT id, salesOrderId FROM delivery_orders WHERE id = ?")
    .bind(deliveryOrderId)
    .first<{ id: string; salesOrderId: string | null }>();
  if (!doRow || !doRow.salesOrderId) return [];

  const soRow = await db
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(doRow.salesOrderId)
    .first<{ id: string; status: string }>();
  if (!soRow) return [];
  if (soRow.status === "CLOSED" || soRow.status === "CANCELLED") return [];

  // Sibling invoices that are still unpaid (excluding *this* invoice —
  // its PAID status is in-flight and will land in the same batch).
  const unpaidProbe = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM invoices i
         JOIN delivery_orders d ON d.id = i.deliveryOrderId
        WHERE d.salesOrderId = ?
          AND i.id != ?
          AND i.status != 'PAID'
          AND i.status != 'CANCELLED'`,
    )
    .bind(soRow.id, invoiceId)
    .first<{ n: number }>();
  if ((unpaidProbe?.n ?? 0) > 0) return [];

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE sales_orders SET status = 'CLOSED', updated_at = ? WHERE id = ?",
      )
      .bind(nowIso, soRow.id),
  ];

  // Probe for so_status_changes — skip audit insert if the table isn't
  // present (older deployments that haven't applied migration 0001's
  // status-history tables yet).
  const hasAudit = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'so_status_changes' LIMIT 1",
    )
    .first<{ name: string }>()
    .catch(() => null);
  if (hasAudit) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO so_status_changes
             (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          genStatusChangeId(),
          soRow.id,
          soRow.status,
          "CLOSED",
          changedBy,
          nowIso,
          "All invoices fully paid",
          JSON.stringify([`Invoice ${invoiceId} PAID closed SO`]),
        ),
    );
  }

  return stmts;
}

async function fetchInvoiceWithChildren(db: D1Database, id: string) {
  const [inv, itemsRes, paymentsRes] = await Promise.all([
    db
      .prepare("SELECT * FROM invoices WHERE id = ?")
      .bind(id)
      .first<InvoiceRow>(),
    db
      .prepare("SELECT * FROM invoice_items WHERE invoiceId = ?")
      .bind(id)
      .all<InvoiceItemRow>(),
    db
      .prepare("SELECT * FROM invoice_payments WHERE invoiceId = ?")
      .bind(id)
      .all<InvoicePaymentRow>(),
  ]);
  if (!inv) return null;
  return rowToInvoice(
    inv,
    itemsRes.results ?? [],
    paymentsRes.results ?? [],
  );
}

// GET /api/invoices — list all, nested items + payments. Optional filters.
//
// Filters: ?customerId= and ?status= (existing; applied at the SQL layer).
// Pagination: opt-in via ?page=N&limit=M. When either is supplied, SQL
// LIMIT/OFFSET applies to the filtered set, and items + payments are
// scoped to only the page's invoice IDs. Default limit=50, cap=500.
//
// ?includeArchive=true — phase-5 flag accepted for API symmetry with the
// other list endpoints, but invoices are NOT archived (compliance/tax
// retention rules). So this is a no-op on the invoices endpoint; the
// query param is consumed-and-ignored rather than forwarded to SQL.
// POST /api/invoices/backfill-customer-fields
//
// One-shot historical repair (Wei Siang 2026-06-03). Migration 0081 added
// invoices.customerPOId / customerAddress / attention / customerPhone (snapshot
// from the parent DO) with NO backfill, so EVERY pre-0081 invoice has them
// blank — Customer PO can't be found, and the printed invoice shows no customer
// address / contact. This copies each missing field from the invoice's linked
// delivery order (whose customerPOId was itself just backfilled).
//
//   ?dry=1 → preview only. Idempotent (only fills blank fields). Temporary.
// Registered BEFORE /:id (Hono static-before-wildcard ordering).
app.post("/backfill-customer-fields", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";

  const invRes = await c.var.DB.prepare(
    `SELECT id, invoiceNo, deliveryOrderId, customerId, customerPOId, customerAddress, attention, customerPhone
       FROM invoices
      WHERE orgId = ?
        AND deliveryOrderId IS NOT NULL AND deliveryOrderId <> ''
        AND (customerPOId IS NULL OR customerPOId = ''
          OR customerAddress IS NULL OR customerAddress = ''
          OR attention IS NULL OR attention = ''
          OR customerPhone IS NULL OR customerPhone = '')`,
  )
    .bind(orgId)
    .all<{
      id: string;
      invoiceNo: string;
      deliveryOrderId: string;
      customerId: string | null;
      customerPOId: string | null;
      customerAddress: string | null;
      attention: string | null;
      customerPhone: string | null;
    }>();
  const invs = invRes.results ?? [];

  let scanned = 0;
  let filled = 0;
  const fieldsFilled = {
    customerPOId: 0,
    customerAddress: 0,
    attention: 0,
    customerPhone: 0,
  };
  // How many of the address/phone fills came from the CUSTOMER master (the
  // 2nd pass) rather than the DO, for the dry-run report.
  const fromCustomerMaster = { customerAddress: 0, customerPhone: 0 };
  const samples: { invoiceNo: string; customerPOId: string }[] = [];
  const updates: D1PreparedStatement[] = [];

  const blank = (v: string | null) => !v || v.trim() === "";

  for (const inv of invs) {
    scanned++;
    const d = await c.var.DB.prepare(
      "SELECT customerPOId, deliveryAddress, contactPerson, contactPhone FROM delivery_orders WHERE id = ?",
    )
      .bind(inv.deliveryOrderId)
      .first<{
        customerPOId: string | null;
        deliveryAddress: string | null;
        contactPerson: string | null;
        contactPhone: string | null;
      }>();
    if (!d) continue;

    const po = blank(inv.customerPOId) ? (d.customerPOId ?? "").trim() : null;
    let addr = blank(inv.customerAddress) ? (d.deliveryAddress ?? "").trim() : null;
    const att = blank(inv.attention) ? (d.contactPerson ?? "").trim() : null;
    let phone = blank(inv.customerPhone) ? (d.contactPhone ?? "").trim() : null;

    // 2nd pass — 87 invoices stayed blank on address/phone because their DO
    // had none. Fall back to the CUSTOMER master (customers.companyAddress /
    // customers.phone) via the invoice's customerId so the printed invoice
    // still shows the customer's address. Only fills what's STILL blank (the
    // invoice value is empty AND the DO contributed nothing). attention has no
    // customer-master equivalent — left to the DO contact only.
    const needAddr = blank(inv.customerAddress) && !addr;
    const needPhone = blank(inv.customerPhone) && !phone;
    if ((needAddr || needPhone) && inv.customerId) {
      const cust = await c.var.DB.prepare(
        "SELECT companyAddress, phone FROM customers WHERE id = ?",
      )
        .bind(inv.customerId)
        .first<{ companyAddress: string | null; phone: string | null }>();
      if (cust) {
        if (needAddr && cust.companyAddress && cust.companyAddress.trim()) {
          addr = cust.companyAddress.trim();
          fromCustomerMaster.customerAddress++;
        }
        if (needPhone && cust.phone && cust.phone.trim()) {
          phone = cust.phone.trim();
          fromCustomerMaster.customerPhone++;
        }
      }
    }

    if (!po && !addr && !att && !phone) continue;
    filled++;
    if (po) fieldsFilled.customerPOId++;
    if (addr) fieldsFilled.customerAddress++;
    if (att) fieldsFilled.attention++;
    if (phone) fieldsFilled.customerPhone++;
    if (samples.length < 10) samples.push({ invoiceNo: inv.invoiceNo, customerPOId: po ?? inv.customerPOId ?? "" });

    if (!dry) {
      updates.push(
        c.var.DB.prepare(
          `UPDATE invoices
              SET customerPOId   = COALESCE(NULLIF(?, ''), customerPOId),
                  customerAddress = COALESCE(NULLIF(?, ''), customerAddress),
                  attention      = COALESCE(NULLIF(?, ''), attention),
                  customerPhone  = COALESCE(NULLIF(?, ''), customerPhone)
            WHERE id = ?`,
        ).bind(po ?? "", addr ?? "", att ?? "", phone ?? "", inv.id),
      );
    }
  }

  if (!dry && updates.length > 0) {
    await c.var.DB.batch(updates);
  }

  return c.json({
    success: true,
    dry,
    scanned,
    filled,
    fieldsFilled,
    fromCustomerMaster,
    samples,
  });
});

// ---------------------------------------------------------------------------
// POST /api/invoices/backfill-date-from-delivery
//
// One-shot historical repair (Wei Siang 2026-06-03). An invoice's date must
// equal the date its DO was DELIVERED, not the day the invoice row happened to
// be created. The live transition now does this (delivery-orders.ts), but
// every pre-fix invoice was dated "today" at creation. This walks each invoice
// linked to a delivered DO and resets invoiceDate to that DO's delivered date
// (deliveredAt → deliveryDate fallback). dueDate is re-derived as
// deliveredDate + 30 days so terms stay anchored to the (corrected) date.
//
//   ?dry=1 → preview only: how many would change + samples (old→new).
// Idempotent: skips invoices whose date already equals the delivered date, and
// skips DOs with no resolvable delivered date. Temporary migration endpoint.
// Registered BEFORE /:id (Hono static-before-wildcard ordering).
// ---------------------------------------------------------------------------
app.post("/backfill-date-from-delivery", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";

  const invRes = await c.var.DB.prepare(
    `SELECT i.id, i.invoiceNo, i.invoiceDate AS oldDate,
            d.deliveredAt, d.deliveryDate, d.status AS doStatus
       FROM invoices i
       JOIN delivery_orders d ON d.id = i.deliveryOrderId
      WHERE i.orgId = ?
        AND i.deliveryOrderId IS NOT NULL AND i.deliveryOrderId <> ''
        AND d.status IN ('DELIVERED','INVOICED')`,
  )
    .bind(orgId)
    .all<{
      id: string;
      invoiceNo: string;
      oldDate: string | null;
      deliveredAt: string | null;
      deliveryDate: string | null;
      doStatus: string;
    }>();
  const invs = invRes.results ?? [];

  let scanned = 0;
  let changed = 0;
  let skippedNoDate = 0;
  let alreadyMatching = 0;
  const samples: { invoiceNo: string; oldDate: string; newDate: string }[] = [];
  const updates: D1PreparedStatement[] = [];

  const datePart = (v: string | null): string =>
    v && v.trim() ? v.trim().split("T")[0] : "";

  for (const inv of invs) {
    scanned++;
    const newDate = datePart(inv.deliveredAt) || datePart(inv.deliveryDate);
    if (!newDate) {
      skippedNoDate++;
      continue;
    }
    const oldDate = datePart(inv.oldDate);
    if (oldDate === newDate) {
      alreadyMatching++;
      continue;
    }
    changed++;
    if (samples.length < 10) {
      samples.push({ invoiceNo: inv.invoiceNo, oldDate, newDate });
    }
    if (!dry) {
      const due = new Date(`${newDate}T00:00:00.000Z`);
      due.setDate(due.getDate() + 30);
      const dueDate = due.toISOString().split("T")[0];
      updates.push(
        c.var.DB.prepare(
          "UPDATE invoices SET invoiceDate = ?, dueDate = ? WHERE id = ?",
        ).bind(newDate, dueDate, inv.id),
      );
    }
  }

  if (!dry && updates.length > 0) {
    await c.var.DB.batch(updates);
  }

  return c.json({
    success: true,
    dry,
    scanned,
    changed,
    skippedNoDate,
    alreadyMatching,
    samples,
  });
});

app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — invoices:read.
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const customerId = c.req.query("customerId");
  const status = c.req.query("status");
  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;

  // Sprint 4: org_id is always the leading predicate so list endpoints
  // can never leak across tenants regardless of optional filters.
  const orgId = getOrgId(c);
  const where: string[] = ["orgId = ?"];
  const params: unknown[] = [orgId];
  if (customerId) {
    where.push("customerId = ?");
    params.push(customerId);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  const clause = `WHERE ${where.join(" AND ")}`;

  if (!paginate) {
    // List payload trim (2026-05-21): the Invoices list page never reads
    // any invoice's nested `items` / `payments` arrays (see rowToInvoiceList
    // above). Only the invoice rows themselves are fetched here now — the
    // previously-fetched invoice_items + invoice_payments result sets are
    // dropped entirely, and rowToInvoiceList ships `items: []` / `payments:
    // []`. This also retires the 2026-04-26 ROWS_HARD_CAP workaround whose
    // sole purpose was capping those two unbounded child fetches.
    const invs = await db
      .prepare(`SELECT * FROM invoices ${clause} ORDER BY created_at DESC`)
      .bind(...params)
      .all<InvoiceRow>();

    const data = (invs.results ?? []).map((inv) => rowToInvoiceList(inv));
    return c.json({ success: true, data, total: data.length });
  }

  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const offset = (page - 1) * limit;

  const [countRes, pageRes] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM invoices ${clause}`)
      .bind(...params)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT * FROM invoices ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit, offset)
      .all<InvoiceRow>(),
  ]);
  const total = countRes?.n ?? 0;
  const invRows = pageRes.results ?? [];

  // List payload trim (2026-05-21): the Invoices list page never reads any
  // invoice's nested `items` / `payments` arrays (see rowToInvoiceList). The
  // per-page invoice_items + invoice_payments fetches are dropped; the slim
  // mapper ships `items: []` / `payments: []`.
  const data = invRows.map((inv) => rowToInvoiceList(inv));
  return c.json({ success: true, data, page, limit, total });
});

// ---------------------------------------------------------------------------
// GET /api/invoices/stats — whole-dataset status bucket counts.
//
// Returns { byStatus: Record<string, number>, total }. Used by the invoices
// list page KPI cards so counts reflect the full table rather than only the
// current paginated page. Registered BEFORE /:id (Hono route ordering).
// ---------------------------------------------------------------------------
app.get("/stats", async (c) => {
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;

  const orgId = getOrgId(c);

  // PR 4 (2026-05-20) — cache-aside snapshot. See lib/invoice-snapshot.ts.
  // Same pattern as dashboard-snapshot (PR 1) and delivery-snapshot (PR 3).
  {
    const { readInvoiceStatsSnapshot, getInvoiceStatsMaxUpdatedAt, isSnapshotFresh } =
      await import("../lib/invoice-snapshot");
    const [snap, currentMax] = await Promise.all([
      readInvoiceStatsSnapshot(c.var.DB, orgId),
      getInvoiceStatsMaxUpdatedAt(c.var.DB),
    ]);
    if (isSnapshotFresh(snap, currentMax) && snap) {
      return c.json({ success: true, ...snap.data });
    }
  }

  // 2026-05-26 filter-audit fix — extend /stats with whole-dataset money
  // aggregates so the Invoices KPI cards (Outstanding RM, Collected MTD)
  // stop computing on the current 200-row page only. Pre-fix, an account
  // with >200 invoices showed an undercounted Outstanding figure that
  // shrank as the user paginated. Two SQL round-trips in parallel — one
  // for the byStatus map, one for the cross-status money sums.
  const currentMonthLike = `${new Date().toISOString().slice(0, 7)}%`;
  const [byStatusRes, sumsRes] = await Promise.all([
    c.var.DB
      .prepare("SELECT status, COUNT(*) AS n FROM invoices GROUP BY status")
      .all<{ status: string; n: number }>(),
    c.var.DB
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status IN ('SENT','OVERDUE','PARTIAL_PAID')
                              THEN totalSen - paidAmount ELSE 0 END), 0) AS "outstandingSen",
           COALESCE(SUM(CASE WHEN status = 'PAID' AND invoiceDate LIKE ?
                              THEN paidAmount ELSE 0 END), 0)              AS "paidMTDSen"
           FROM invoices`,
      )
      .bind(currentMonthLike)
      .first<{ outstandingSen: number; paidMTDSen: number }>(),
  ]);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of byStatusRes.results ?? []) {
    byStatus[row.status] = row.n;
    total += row.n;
  }
  const payload = {
    byStatus,
    total,
    outstandingSen: Number(sumsRes?.outstandingSen ?? 0),
    paidMTDSen: Number(sumsRes?.paidMTDSen ?? 0),
  };

  try {
    const { writeInvoiceStatsSnapshot, getInvoiceStatsMaxUpdatedAt } =
      await import("../lib/invoice-snapshot");
    const currentMax = await getInvoiceStatsMaxUpdatedAt(c.var.DB);
    await writeInvoiceStatsSnapshot(
      c.var.DB,
      orgId,
      payload as Record<string, unknown>,
      currentMax ?? new Date().toISOString(),
    );
  } catch (e) {
    console.warn("[invoice-stats-snapshot] write-back failed:", e);
  }

  return c.json({ success: true, ...payload });
});

// POST /api/invoices — create from a DELIVERED delivery order.
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — invoices:create.
  const denied = await requirePermission(c, "invoices", "create");
  if (denied) return denied;
  // Sprint 3 #4 — idempotency. POSTing an invoice for the same DO twice
  // produces two distinct invoice rows today (the only guard is DO status
  // = DELIVERED, which the first request flips to INVOICED — but the
  // window between read and write is wide). Wrap so a duplicate retry
  // returns the cached response instead.
  const idemKey = readIdempotencyKey(c);
  return withIdempotency(c, "invoices", idemKey, async () => {
  try {
    const body = await c.req.json();
    const deliveryOrderId: string | undefined = body.deliveryOrderId;
    if (!deliveryOrderId) {
      return c.json(
        { success: false, error: "deliveryOrderId is required" },
        400,
      );
    }

    // PR 5 (2026-05-20) — pull the full customer-contact block from the
    // source DO so invoice PDF stops showing "Address: KL" and
    // "Contact: -" (BUG-2026-05-20-009, Agent B Tier 1 findings B1/B2/B3).
    const doRow = await c.var.DB.prepare(
      `SELECT id, doNo, salesOrderId, companySOId, customerId, customerName,
              customerState, deliveryAddress, contactPerson, contactPhone,
              customerPOId, hubId, hubName, status
         FROM delivery_orders WHERE id = ?`,
    )
      .bind(deliveryOrderId)
      .first<{
        id: string;
        doNo: string;
        salesOrderId: string | null;
        companySOId: string | null;
        customerId: string;
        customerName: string;
        customerState: string | null;
        deliveryAddress: string | null;
        contactPerson: string | null;
        contactPhone: string | null;
        customerPOId: string | null;
        hubId: string | null;
        hubName: string | null;
        status: string;
      }>();
    if (!doRow) {
      return c.json(
        { success: false, error: "Delivery order not found" },
        404,
      );
    }
    if (doRow.status !== "DELIVERED") {
      return c.json(
        {
          success: false,
          error: `Cannot create invoice: Delivery Order is "${doRow.status}". Only DELIVERED delivery orders can be invoiced.`,
        },
        400,
      );
    }

    // Price every delivered item through the SHARED whole-org resolver
    // (computeDoInvoiceLines in ./delivery-orders) — the SAME basis the DO
    // "value" and the auto-on-delivered invoice use, so a manually-created
    // invoice can't under-bill the way the old narrow single-SO lookup did
    // (BUG-2026-05-18-004, 2nd instance). Call-time import avoids the
    // route<->route static import cycle (delivery-orders already imports
    // nextInvoiceNo from here).
    const { resolveDoSalesOrderIds, computeDoInvoiceLines } = await import(
      "./delivery-orders"
    );
    const soIdsForInvoice = await resolveDoSalesOrderIds(
      c.var.DB,
      doRow.id,
      doRow.salesOrderId,
    );
    const { invItems, computedTotal } = await computeDoInvoiceLines(
      c.var.DB,
      doRow.id,
      soIdsForInvoice,
    );
    const items = invItems;
    const subtotalSen = computedTotal;
    const totalSen = subtotalSen;
    const now = new Date().toISOString();
    const invoiceDate = now.split("T")[0];
    // Owner term: fixed 1 month, by calendar month — due = end of next
    // month (src/lib/terms.ts). Enforced server-side, not client-supplied.
    const dueDate = nextMonthDueDate(invoiceDate);
    const id = genInvoiceId();
    const invoiceNo = body.invoiceNo || (await nextInvoiceNo(c.var.DB));

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        // PR 5 — INSERT also captures customerAddress / attention /
        // customerPhone / customerPOId from the DO. These columns were
        // added by migration 0119 (postgres) / 0079 (d1).
        `INSERT INTO invoices (
           id, invoiceNo, deliveryOrderId, doNo, salesOrderId, companySOId,
           customerId, customerName, customerState, customerAddress,
           attention, customerPhone, customerPOId, hubId, hubName,
           subtotalSen, totalSen, status, invoiceDate, dueDate, paidAmount,
           paymentDate, paymentMethod, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        invoiceNo,
        doRow.id,
        doRow.doNo,
        doRow.salesOrderId,
        doRow.companySOId,
        doRow.customerId,
        doRow.customerName,
        doRow.customerState,
        doRow.deliveryAddress,
        doRow.contactPerson,
        doRow.contactPhone,
        doRow.customerPOId,
        doRow.hubId,
        doRow.hubName,
        subtotalSen,
        totalSen,
        "DRAFT",
        invoiceDate,
        dueDate,
        0,
        null,
        "",
        body.notes ?? "",
        now,
        now,
      ),
      ...items.map((item) =>
        c.var.DB.prepare(
          `INSERT INTO invoice_items (
             id, invoiceId, productCode, productName, sizeLabel, fabricCode,
             quantity, unitPriceSen, totalSen
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          id,
          item.productCode,
          item.productName,
          item.sizeLabel,
          item.fabricCode,
          item.quantity,
          item.unitPriceSen,
          item.totalSen,
        ),
      ),
      // Flip DO to INVOICED in the same batch so we roll back together.
      c.var.DB.prepare(
        `UPDATE delivery_orders SET status = 'INVOICED', overdue = 'INVOICED', updated_at = ? WHERE id = ?`,
      ).bind(now, doRow.id),
    ];

    await c.var.DB.batch(statements);

    const created = await fetchInvoiceWithChildren(c.var.DB, id);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create invoice" },
        500,
      );
    }
    return c.json({ success: true, data: created }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/invoices] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error creating invoice" }, 500);
  }
  });
});

// GET /api/invoices/:id/print-extras
//
// Read-only print enrichment for the redesigned A4 invoice. Option 2A:
// the price build-up (base / divan / leg / special) is NOT stored on
// invoice_items — it lives on sales_order_items. We read it back at
// print time by salesOrderId + productCode (best-effort first match),
// plus customerSO / customerRef. Scoped to ONE invoice; zero impact on
// the core invoice API. Registered BEFORE /:id (Hono order).
app.get("/:id/print-extras", async (c) => {
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const inv = await c.var.DB.prepare(
    "SELECT id, salesOrderId, deliveryOrderId FROM invoices WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      salesOrderId: string | null;
      deliveryOrderId: string | null;
    }>();
  if (!inv) {
    return c.json({ success: false, error: "Invoice not found" }, 404);
  }
  let customerSO = "";
  if (inv.salesOrderId) {
    const so = await c.var.DB.prepare(
      "SELECT customerSO FROM sales_orders WHERE id = ?",
    )
      .bind(inv.salesOrderId)
      .first<{ customerSO: string | null }>();
    customerSO = so?.customerSO ?? "";
  }
  let customerRef = "";
  if (inv.deliveryOrderId) {
    const refRow = await c.var.DB.prepare(
      `SELECT po.customerReference AS r
         FROM delivery_order_items di
         JOIN production_orders po ON po.id = di.productionOrderId
        WHERE di.deliveryOrderId = ?
          AND po.customerReference IS NOT NULL
          AND po.customerReference != ''
        LIMIT 1`,
    )
      .bind(inv.deliveryOrderId)
      .first<{ r: string | null }>();
    customerRef = refRow?.r ?? "";
  }
  // ---------------------------------------------------------------------
  // Per-line spec + price build-up.
  //
  // An invoice billed off a CONSOLIDATED delivery order spans MANY sales
  // orders, so reading only invoice.salesOrderId left every line but the
  // first with no spec and no price breakdown (operator report: invoice
  // description ≠ DO description; leg / special prices never showed).
  // Resolve the full set of sales orders behind the invoice — directly
  // (invoice.salesOrderId) AND through the delivery order's lines — then
  // match each invoice line to its sales-order line by
  // productCode|fabricCode|sizeLabel (tight) so duplicate product codes
  // with different fabric / price land on the right figures.
  // ---------------------------------------------------------------------
  const soIdSeeds = new Set<string>();
  if (inv.salesOrderId) soIdSeeds.add(inv.salesOrderId);
  if (inv.deliveryOrderId) {
    const doLines = await c.var.DB.prepare(
      `SELECT po.salesOrderId, po.companySOId, di.salesOrderNo
         FROM delivery_order_items di
         LEFT JOIN production_orders po ON po.id = di.productionOrderId
        WHERE di.deliveryOrderId = ?`,
    )
      .bind(inv.deliveryOrderId)
      .all<{
        salesOrderId: string | null;
        companySOId: string | null;
        salesOrderNo: string | null;
      }>();
    for (const d of doLines.results ?? []) {
      if (d.salesOrderId) soIdSeeds.add(d.salesOrderId);
      if (d.companySOId) soIdSeeds.add(d.companySOId);
      if (d.salesOrderNo) soIdSeeds.add(d.salesOrderNo);
    }
  }
  // Normalise every seed (real id / companySOId / companySO) to the
  // sales_orders primary key.
  const realSoIds = new Set<string>();
  type SoRef = {
    companySO: string | null;
    customerPO: string | null;
    customerSO: string | null;
    reference: string | null;
  };
  const soRefByKey = new Map<string, SoRef>();
  if (soIdSeeds.size > 0) {
    const seeds = Array.from(soIdSeeds);
    const ph = seeds.map(() => "?").join(",");
    const soRes = await c.var.DB.prepare(
      `SELECT id, companySO, companySOId, customerPO, customerSO, reference
         FROM sales_orders
        WHERE id IN (${ph}) OR companySOId IN (${ph}) OR companySO IN (${ph})`,
    )
      .bind(...seeds, ...seeds, ...seeds)
      .all<{
        id: string | null;
        companySO: string | null;
        companySOId: string | null;
        customerPO: string | null;
        customerSO: string | null;
        reference: string | null;
      }>();
    for (const s of soRes.results ?? []) {
      if (s.id) realSoIds.add(s.id);
      const v: SoRef = {
        // companySOId holds the canonical code (SO-2605-215); companySO
        // is a legacy free-text label ("Sales Order 215") on ~half the
        // rows. Always prefer the proper code.
        companySO: s.companySOId ?? s.companySO ?? null,
        customerPO: s.customerPO ?? null,
        customerSO: s.customerSO ?? null,
        reference: s.reference ?? null,
      };
      for (const k of [s.id, s.companySOId, s.companySO])
        if (k) soRefByKey.set(k, v);
    }
  }

  type LineVal = {
    itemCategory: string | null;
    gapInches: number | null;
    divanHeightInches: number | null;
    legHeightInches: number | null;
    totalHeightInches: number | null;
    specialOrder: string | null;
    baseSen: number;
    divanSen: number;
    legSen: number;
    specialSen: number;
    unitSen: number;
    // Per-line customer references — a consolidated DO/invoice carries a
    // DIFFERENT customer PO / SO / our company SO on every line, exactly
    // like the DO printout. Resolved (not flattened) so the invoice
    // Order column matches the DO line for line.
    customerPOId?: string | null;
    customerSOLine?: string | null;
    customerRefLine?: string | null;
    companySO?: string | null;
  };
  const tight = new Map<string, LineVal>();
  const loose = new Map<string, LineVal>();
  const byCode = new Map<string, LineVal>();
  const priceByCode: Record<
    string,
    { baseSen: number; divanSen: number; legSen: number; specialSen: number; unitSen: number }
  > = {};
  if (realSoIds.size > 0) {
    const ids = Array.from(realSoIds);
    const ph = ids.map(() => "?").join(",");
    const siRes = await c.var.DB.prepare(
      `SELECT productCode, fabricCode, sizeLabel, itemCategory,
              gapInches, divanHeightInches, legHeightInches, specialOrder,
              basePriceSen, divanPriceSen, legPriceSen,
              specialOrderPriceSen, unitPriceSen
         FROM sales_order_items WHERE salesOrderId IN (${ph})`,
    )
      .bind(...ids)
      .all<{
        productCode: string | null;
        fabricCode: string | null;
        sizeLabel: string | null;
        itemCategory: string | null;
        gapInches: number | null;
        divanHeightInches: number | null;
        legHeightInches: number | null;
        specialOrder: string | null;
        basePriceSen: number;
        divanPriceSen: number;
        legPriceSen: number;
        specialOrderPriceSen: number;
        unitPriceSen: number;
      }>();
    for (const r of siRes.results ?? []) {
      const code = (r.productCode ?? "").trim();
      const fab = (r.fabricCode ?? "").trim();
      const size = (r.sizeLabel ?? "").trim();
      const g = r.gapInches ?? null;
      const d = r.divanHeightInches ?? null;
      const l = r.legHeightInches ?? null;
      const v: LineVal = {
        itemCategory: r.itemCategory ?? null,
        gapInches: g,
        divanHeightInches: d,
        legHeightInches: l,
        totalHeightInches:
          g == null && d == null && l == null
            ? null
            : (Number(g) || 0) + (Number(d) || 0) + (Number(l) || 0),
        specialOrder: r.specialOrder ?? null,
        baseSen: Number(r.basePriceSen) || 0,
        divanSen: Number(r.divanPriceSen) || 0,
        legSen: Number(r.legPriceSen) || 0,
        specialSen: Number(r.specialOrderPriceSen) || 0,
        unitSen: Number(r.unitPriceSen) || 0,
      };
      if (code) {
        const tk = `${code}|${fab}|${size}`;
        const lk = `${code}|${fab}`;
        if (!tight.has(tk)) tight.set(tk, v);
        if (!loose.has(lk)) loose.set(lk, v);
        if (!byCode.has(code)) byCode.set(code, v);
        if (!priceByCode[code])
          priceByCode[code] = {
            baseSen: v.baseSen,
            divanSen: v.divanSen,
            legSen: v.legSen,
            specialSen: v.specialSen,
            unitSen: v.unitSen,
          };
      }
    }
  }

  // Per-line customer PO / customer SO / customer Ref / our company SO,
  // resolved through the delivery order's lines exactly like the DO
  // printout (a consolidated DO carries a different one on every line).
  type RefVal = {
    customerPOId: string | null;
    customerSOLine: string | null;
    customerRefLine: string | null;
    companySO: string | null;
  };
  const refTight = new Map<string, RefVal>();
  const refLoose = new Map<string, RefVal>();
  const refByCode = new Map<string, RefVal>();
  if (inv.deliveryOrderId) {
    const dRefRes = await c.var.DB.prepare(
      `SELECT di.productCode, di.fabricCode, di.sizeLabel, di.salesOrderNo,
              po.customerPOId, po.customerReference,
              po.salesOrderId, po.companySOId
         FROM delivery_order_items di
         LEFT JOIN production_orders po ON po.id = di.productionOrderId
        WHERE di.deliveryOrderId = ?`,
    )
      .bind(inv.deliveryOrderId)
      .all<{
        productCode: string | null;
        fabricCode: string | null;
        sizeLabel: string | null;
        salesOrderNo: string | null;
        customerPOId: string | null;
        customerReference: string | null;
        salesOrderId: string | null;
        companySOId: string | null;
      }>();
    for (const d of dRefRes.results ?? []) {
      const so =
        soRefByKey.get(d.salesOrderId || "") ||
        soRefByKey.get(d.companySOId || "") ||
        soRefByKey.get(d.salesOrderNo || "");
      const rv: RefVal = {
        customerPOId: d.customerPOId || so?.customerPO || null,
        customerSOLine: so?.customerSO || null,
        customerRefLine: d.customerReference || so?.reference || null,
        companySO:
          so?.companySO || d.companySOId || d.salesOrderNo || null,
      };
      const code = (d.productCode ?? "").trim();
      const fab = (d.fabricCode ?? "").trim();
      const size = (d.sizeLabel ?? "").trim();
      if (code) {
        const tk = `${code}|${fab}|${size}`;
        const lk = `${code}|${fab}`;
        if (!refTight.has(tk)) refTight.set(tk, rv);
        if (!refLoose.has(lk)) refLoose.set(lk, rv);
        if (!refByCode.has(code)) refByCode.set(code, rv);
      }
    }
  }

  // Emit per invoice line (keyed by invoice_items.id).
  const items: Record<string, LineVal> = {};
  const invItemsRes = await c.var.DB.prepare(
    `SELECT id, productCode, fabricCode, sizeLabel,
            basePriceSen, divanPriceSen, legPriceSen,
            specialOrderPriceSen, priceEdited
       FROM invoice_items WHERE invoiceId = ?`,
  )
    .bind(id)
    .all<{
      id: string;
      productCode: string | null;
      fabricCode: string | null;
      sizeLabel: string | null;
      basePriceSen: number | null;
      divanPriceSen: number | null;
      legPriceSen: number | null;
      specialOrderPriceSen: number | null;
      priceEdited: number | null;
    }>();
  for (const r of invItemsRes.results ?? []) {
    const code = (r.productCode ?? "").trim();
    const fab = (r.fabricCode ?? "").trim();
    const size = (r.sizeLabel ?? "").trim();
    const v =
      tight.get(`${code}|${fab}|${size}`) ||
      loose.get(`${code}|${fab}`) ||
      byCode.get(code);
    const rf =
      refTight.get(`${code}|${fab}|${size}`) ||
      refLoose.get(`${code}|${fab}`) ||
      refByCode.get(code);
    if (!r.id) continue;
    // INVOICE IS SOURCE OF TRUTH: once the operator has edited this
    // line's prices, the invoice's own build-up wins over the
    // sales-order-derived figures. Spec heights still come from the SO
    // (display only — not editable).
    const edited = Number(r.priceEdited) === 1;
    const invBase = Number(r.basePriceSen) || 0;
    const invDivan = Number(r.divanPriceSen) || 0;
    const invLeg = Number(r.legPriceSen) || 0;
    const invSpecial = Number(r.specialOrderPriceSen) || 0;
    if (v || rf || edited) {
      items[r.id] = {
        itemCategory: v?.itemCategory ?? null,
        gapInches: v?.gapInches ?? null,
        divanHeightInches: v?.divanHeightInches ?? null,
        legHeightInches: v?.legHeightInches ?? null,
        totalHeightInches: v?.totalHeightInches ?? null,
        specialOrder: v?.specialOrder ?? null,
        baseSen: edited ? invBase : (v?.baseSen ?? 0),
        divanSen: edited ? invDivan : (v?.divanSen ?? 0),
        legSen: edited ? invLeg : (v?.legSen ?? 0),
        specialSen: edited ? invSpecial : (v?.specialSen ?? 0),
        unitSen: edited
          ? invBase + invDivan + invLeg + invSpecial
          : (v?.unitSen ?? 0),
        customerPOId: rf?.customerPOId ?? null,
        customerSOLine: rf?.customerSOLine ?? null,
        customerRefLine: rf?.customerRefLine ?? null,
        companySO: rf?.companySO ?? null,
      };
    }
  }

  return c.json({
    success: true,
    data: { customerSO, customerRef, priceByCode, items },
  });
});

// GET /api/invoices/:id — single
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const inv = await fetchInvoiceWithChildren(c.var.DB, id);
  if (!inv) {
    return c.json({ success: false, error: "Invoice not found" }, 404);
  }
  // Lock status (payment recorded / status=PAID?) — surfaced to the
  // detail page so it can render a "credit note required" banner.
  const lockReason = await checkInvoiceLocked(c.var.DB, id);
  return c.json({ success: true, data: inv, lockReason });
});

// PUT /api/invoices/:id — update (status transitions, payments, fields)
app.put("/:id", async (c) => {
  // RBAC gate (P3.3-followup) — base permission is invoices:update.
  // Sensitive transitions get additional row-level checks below:
  //   • DRAFT → SENT  (the "post" action)        ⇒ invoices:post
  //   • *     → CANCELLED  (the "void" action)   ⇒ invoices:void
  const baseDenied = await requirePermission(c, "invoices", "update");
  if (baseDenied) return baseDenied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM invoices WHERE id = ?",
    )
      .bind(id)
      .first<InvoiceRow>();
    if (!existing) {
      return c.json({ success: false, error: "Invoice not found" }, 404);
    }
    // Cascade lock — once a payment is recorded (paidAmountSen > 0 or
    // status='PAID'), the invoice is GL-posted and edits would orphan
    // the accounting trail. Reversals must go through a credit note.
    // Status transitions to CANCELLED still need to flow through, so the
    // status-change branch below runs unconditionally; the lock only
    // blocks field-level edits.
    const lockMsg = await checkInvoiceLocked(c.var.DB, id);
    const body = await c.req.json();
    const isStatusOnly =
      body.status &&
      !body.dueDate &&
      !body.notes &&
      !body.lineItems &&
      !body.subtotalSen;
    if (lockMsg && !isStatusOnly) {
      return c.json(lockedResponse(lockMsg), 403);
    }
    const now = new Date().toISOString();

    // --- validate status transition (same rules as mock-data) ---
    let nextStatus: string = existing.status;
    if (body.status && body.status !== existing.status) {
      const allowed = INV_VALID_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(body.status)) {
        return c.json(
          {
            success: false,
            error: `Cannot transition from ${existing.status} to ${body.status}. Allowed: ${allowed.join(", ") || "none"}`,
          },
          400,
        );
      }
      nextStatus = body.status;

      // Row-level RBAC for the high-impact post/void transitions.
      if (existing.status === "DRAFT" && nextStatus === "SENT") {
        const denied = await requirePermission(c, "invoices", "post");
        if (denied) return denied;
      }
      if (nextStatus === "CANCELLED" && existing.status !== "CANCELLED") {
        const denied = await requirePermission(c, "invoices", "void");
        if (denied) return denied;
      }
    }

    // --- handle payment delta (old impl pushed one InvoicePayment per delta) ---
    let nextPaidAmount = existing.paidAmount;
    let newInvoicePayment: {
      id: string;
      date: string;
      amountSen: number;
      method: string;
      reference: string;
    } | null = null;
    if (body.paidAmount !== undefined) {
      const paymentAmountSen = Number(body.paidAmount) - existing.paidAmount;
      if (paymentAmountSen > 0) {
        newInvoicePayment = {
          id: genInvoicePaymentId(),
          date: body.paymentDate || now.split("T")[0],
          amountSen: paymentAmountSen,
          method: body.paymentMethod || "BANK_TRANSFER",
          reference: body.paymentReference || "",
        };
      }
      nextPaidAmount = Number(body.paidAmount);
      if (nextPaidAmount >= existing.totalSen) {
        nextStatus = "PAID";
      } else if (nextPaidAmount > 0) {
        nextStatus = "PARTIAL_PAID";
      }
    }

    const merged = {
      paymentDate:
        body.paymentDate === undefined
          ? existing.paymentDate
          : body.paymentDate,
      paymentMethod:
        body.paymentMethod === undefined
          ? existing.paymentMethod
          : body.paymentMethod,
      notes: body.notes === undefined ? existing.notes : body.notes,
      dueDate: body.dueDate === undefined ? existing.dueDate : body.dueDate,
    };

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `UPDATE invoices SET
           status = ?, paidAmount = ?, paymentDate = ?, paymentMethod = ?,
           notes = ?, dueDate = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        nextStatus,
        nextPaidAmount,
        merged.paymentDate,
        merged.paymentMethod,
        merged.notes,
        merged.dueDate,
        now,
        id,
      ),
    ];

    if (newInvoicePayment) {
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO invoice_payments (id, invoiceId, date, amountSen, method, reference)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          newInvoicePayment.id,
          id,
          newInvoicePayment.date,
          newInvoicePayment.amountSen,
          newInvoicePayment.method,
          newInvoicePayment.reference,
        ),
      );
    }

    // --- items replacement (optional) ---
    if (Array.isArray(body.items)) {
      statements.push(
        c.var.DB.prepare(
          "DELETE FROM invoice_items WHERE invoiceId = ?",
        ).bind(id),
      );
      let computedSubtotal = 0;
      for (const raw of body.items as Array<Record<string, unknown>>) {
        const quantity = Number(raw.quantity) || 0;
        const unitPriceSen = Number(raw.unitPriceSen) || 0;
        // Tier D D4 fix 2026-05-21 — back-door write. Original code did
        // `Number(raw.totalSen) || unitPriceSen * quantity`, which let
        // the API caller pass an arbitrary totalSen that disagreed with
        // qty × unitPriceSen (e.g. via curl). The operator UI has no
        // input cell for totalSen — it's always displayed = qty × price.
        // Per the memory rule feedback_no_back_door_writes.md, the
        // backend must not accept a value the UI can't supply. Always
        // recompute server-side now; raw.totalSen ignored if present.
        const totalSen = unitPriceSen * quantity;
        computedSubtotal += totalSen;
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO invoice_items (
               id, invoiceId, productCode, productName, sizeLabel, fabricCode,
               quantity, unitPriceSen, totalSen
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            (raw.id as string) || genInvoiceItemId(),
            id,
            (raw.productCode as string) ?? "",
            (raw.productName as string) ?? "",
            (raw.sizeLabel as string) ?? "",
            (raw.fabricCode as string) ?? "",
            quantity,
            unitPriceSen,
            totalSen,
          ),
        );
      }
      statements.push(
        c.var.DB.prepare(
          "UPDATE invoices SET subtotalSen = ?, totalSen = ? WHERE id = ?",
        ).bind(computedSubtotal, computedSubtotal, id),
      );
    }

    // ------------------------------------------------------------------
    // Per-line price edit (the Edit button — Base / Divan / Leg /
    // Special order). The INVOICE becomes the source of truth: edited
    // lines stamp priceEdited=1 so the printout reads back the invoice's
    // own build-up instead of the sales-order figures.
    //
    // Allowed only on DRAFT or unpaid SENT. lockMsg already 403s any
    // invoice with a recorded payment (above); the status guard keeps
    // it to the two states the operator approved.
    // ------------------------------------------------------------------
    if (Array.isArray(body.priceEdits) && body.priceEdits.length > 0) {
      if (existing.status !== "DRAFT" && existing.status !== "SENT") {
        return c.json(
          {
            success: false,
            error: `Prices can only be edited on a DRAFT or unpaid SENT invoice (this one is ${existing.status}).`,
          },
          400,
        );
      }
      const editById = new Map<
        string,
        { base: number; divan: number; leg: number; special: number }
      >();
      for (const e of body.priceEdits as Array<Record<string, unknown>>) {
        const lid = String(e.id || "");
        if (!lid) continue;
        editById.set(lid, {
          base: Math.max(0, Math.round(Number(e.baseSen) || 0)),
          divan: Math.max(0, Math.round(Number(e.divanSen) || 0)),
          leg: Math.max(0, Math.round(Number(e.legSen) || 0)),
          special: Math.max(0, Math.round(Number(e.specialSen) || 0)),
        });
      }
      const allRes = await c.var.DB.prepare(
        "SELECT id, quantity, unitPriceSen FROM invoice_items WHERE invoiceId = ?",
      )
        .bind(id)
        .all<{ id: string; quantity: number; unitPriceSen: number }>();
      let newSubtotal = 0;
      let touched = 0;
      for (const r of allRes.results ?? []) {
        const q = Number(r.quantity) || 0;
        const ed = editById.get(r.id);
        if (ed) {
          touched++;
          const unit = ed.base + ed.divan + ed.leg + ed.special;
          const lineTotal = unit * q;
          newSubtotal += lineTotal;
          statements.push(
            c.var.DB.prepare(
              `UPDATE invoice_items SET
                 basePriceSen = ?, divanPriceSen = ?, legPriceSen = ?,
                 specialOrderPriceSen = ?, unitPriceSen = ?, totalSen = ?,
                 priceEdited = 1
               WHERE id = ?`,
            ).bind(
              ed.base,
              ed.divan,
              ed.leg,
              ed.special,
              unit,
              lineTotal,
              r.id,
            ),
          );
        } else {
          newSubtotal += (Number(r.unitPriceSen) || 0) * q;
        }
      }
      if (touched > 0) {
        statements.push(
          c.var.DB.prepare(
            "UPDATE invoices SET subtotalSen = ?, totalSen = ? WHERE id = ?",
          ).bind(newSubtotal, newSubtotal, id),
        );

        // SENT (unpaid) was already GL-posted at the OLD subtotal.
        // Reverse that posting and re-post the NEW one in the SAME
        // batch so the ledger stays balanced and the hash chain
        // linear. A later void recomputes from the CURRENT subtotal,
        // so original + reversal cancel and the void still nets zero.
        if (existing.status === "SENT") {
          try {
            const orgId =
              (existing as unknown as { orgId?: string | null }).orgId ??
              "hookka";
            const actorUserId =
              (
                c as unknown as { get: (k: string) => string | undefined }
              ).get("userId") ?? null;
            if (await ledgerHasSource(c.var.DB, orgId, "invoice", id)) {
              const stamp = now;
              const custId =
                (existing as unknown as { customerId?: string })
                  .customerId ?? "";
              const { legs: revLegs } = await buildInvoiceLedgerLegs(
                c.var.DB,
                orgId,
                {
                  id,
                  invoiceNo: existing.invoiceNo,
                  customerId: custId,
                  subtotalSen: existing.subtotalSen,
                },
                actorUserId,
                true,
              );
              const { legs: postLegs, taxSen } =
                await buildInvoiceLedgerLegs(
                  c.var.DB,
                  orgId,
                  {
                    id,
                    invoiceNo: existing.invoiceNo,
                    customerId: custId,
                    subtotalSen: newSubtotal,
                  },
                  actorUserId,
                  false,
                );
              for (const l of revLegs)
                l.sourceType = `invoice_restate_rev:${stamp}`;
              for (const l of postLegs)
                l.sourceType = `invoice_restate_post:${stamp}`;
              // ONE call so rev + post chain sequentially off the same
              // head — two calls would each read the same chain head
              // and FORK the journal.
              const { statements: jeStmts } =
                await buildJournalEntryStatements(c.var.DB, orgId, [
                  ...revLegs,
                  ...postLegs,
                ]);
              statements.push(...jeStmts);
              statements.push(
                c.var.DB.prepare(
                  "UPDATE invoices SET taxSen = ? WHERE id = ?",
                ).bind(taxSen, id),
              );
              const auditStmt = await buildAuditStatement(c, {
                resource: "invoices",
                resourceId: id,
                action: "update",
                before: existing,
                after: {
                  ...existing,
                  subtotalSen: newSubtotal,
                  totalSen: newSubtotal,
                  taxSen,
                  updatedAt: now,
                },
              });
              if (auditStmt) statements.push(auditStmt);
            }
          } catch (e) {
            console.warn(
              `[ledger] failed to BUILD restatement for invoice ${id} price edit:`,
              e,
            );
          }
        }
      }
    }

    // Cascade: if this PUT flipped the invoice to PAID, close the linked
    // SO iff all sibling invoices are also PAID. See
    // previewCascadeSOClosed() for the "this invoice is in-flight" logic.
    if (nextStatus === "PAID" && existing.status !== "PAID") {
      const cascadeStmts = await previewCascadeSOClosed(
        c.var.DB,
        id,
        existing.deliveryOrderId,
        now,
      );
      statements.push(...cascadeStmts);
    }

    // 2026-05-26 cascade fix (BUG-2026-05-26-004) — DRAFT → SENT bumps
    // every linked SO from a pre-invoice status (DELIVERED / SHIPPED /
    // READY_TO_SHIP / IN_PRODUCTION / CONFIRMED) to INVOICED. Pre-fix,
    // sending an invoice updated only the invoice row + DO status, so a
    // book with 83 SENT invoices showed 0 SOs at INVOICED (BUG-2026-05-
    // 26-003 user-visible symptom: Completed KPI card stayed at 0
    // forever). Mirrors the DO → DELIVERED cascade in
    // delivery-orders.ts buildDoDeliveredSoAndInvoice — multi-SO aware
    // via resolveDoSalesOrderIds, idempotent via the status-set guard
    // (a re-fire on an already-INVOICED SO no-ops).
    if (existing.status === "DRAFT" && nextStatus === "SENT") {
      const { resolveDoSalesOrderIds } = await import("./delivery-orders");
      const soIds = await resolveDoSalesOrderIds(
        c.var.DB,
        existing.deliveryOrderId ?? "",
        existing.salesOrderId,
      );
      if (soIds.length > 0) {
        const placeholders = soIds.map(() => "?").join(",");
        statements.push(
          c.var.DB
            .prepare(
              `UPDATE sales_orders
                  SET status = 'INVOICED', updated_at = ?
                WHERE id IN (${placeholders})
                  AND status IN ('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP',
                                 'SHIPPED','DELIVERED')`,
            )
            .bind(now, ...soIds),
        );
      }
    }

    // ------------------------------------------------------------------
    // Sprint 3 #2 — fold audit + ledger writes into the SAME batch as
    // the business mutation, instead of running them post-batch with a
    // try/catch. Two transitions trigger side-effects:
    //   • DRAFT → SENT       → audit "post"  + dual-write 2-3 ledger legs
    //   • ANY   → CANCELLED  → audit "void"  (no ledger write — voids are
    //                                          journaled separately when /
    //                                          if a credit-note posts)
    // Skip the remaining payment-driven transitions (SENT →
    // PARTIAL_PAID / PAID / OVERDUE) — those are journaled via payment
    // audit events on payments.ts. Avoid double-logging.
    //
    // We build a projected `afterSnapshot` from the in-flight column
    // values so the audit row can land in the same batch as the UPDATE
    // (we cannot SELECT-back inside the batch). The fields here mirror
    // those that the UPDATE statement above writes; non-mutated fields
    // are inherited from `existing`.
    // ------------------------------------------------------------------
    const isPostTransition =
      existing.status === "DRAFT" && nextStatus === "SENT";
    const isVoidTransition =
      nextStatus === "CANCELLED" && existing.status !== "CANCELLED";

    const afterSnapshot =
      isPostTransition || isVoidTransition
        ? {
            ...existing,
            status: nextStatus,
            paidAmount: nextPaidAmount,
            paymentDate: merged.paymentDate,
            paymentMethod: merged.paymentMethod,
            notes: merged.notes,
            dueDate: merged.dueDate,
            updatedAt: now,
          }
        : null;

    if (isPostTransition && afterSnapshot) {
      const auditStmt = await buildAuditStatement(c, {
        resource: "invoices",
        resourceId: id,
        action: "post",
        before: existing,
        after: afterSnapshot,
      });
      if (auditStmt) statements.push(auditStmt);

      // Phase 4 — post against the real 0115 COA, idempotently:
      //   DR <debtor control 300-x>   subtotal + GST
      //   CR 500-0000/0020/0030       subtotal (split by product category)
      //   CR 350-0000 GST output      tax (operator-configured rate)
      // A re-flip DRAFT→SENT / retry is a no-op (Phase 3a guard). Ledger
      // failure is logged, never blocks the invoice mutation.
      try {
        const orgId =
          (existing as unknown as { orgId?: string | null }).orgId ??
          "hookka";
        const actorUserId =
          (
            c as unknown as { get: (k: string) => string | undefined }
          ).get("userId") ?? null;
        if (await ledgerHasSource(c.var.DB, orgId, "invoice", id)) {
          console.warn(
            `[ledger] invoice ${id} already posted — skipping (idempotent)`,
          );
        } else {
          const { legs, taxSen } = await buildInvoiceLedgerLegs(
            c.var.DB,
            orgId,
            {
              id,
              invoiceNo: existing.invoiceNo,
              customerId:
                (existing as unknown as { customerId?: string })
                  .customerId ?? "",
              subtotalSen: existing.subtotalSen,
            },
            actorUserId,
            false,
          );
          const { statements: ledgerStmts } =
            await buildJournalEntryStatements(c.var.DB, orgId, legs);
          statements.push(...ledgerStmts);
          // Persist computed tax so the GST leg is re-derivable/auditable.
          statements.push(
            c.var.DB.prepare(
              "UPDATE invoices SET taxSen = ? WHERE id = ?",
            ).bind(taxSen, id),
          );
        }
      } catch (e) {
        console.warn(
          `[ledger] failed to BUILD statements for invoice ${id} post:`,
          e,
        );
      }
    } else if (isVoidTransition && afterSnapshot) {
      const auditStmt = await buildAuditStatement(c, {
        resource: "invoices",
        resourceId: id,
        action: "void",
        before: existing,
        after: afterSnapshot,
      });
      if (auditStmt) statements.push(auditStmt);

      // Reverse the original posting (idempotent): only when it was
      // posted and not already reversed. Recomputed from the current
      // invoice subtotal + GST rate — accurate because a SENT invoice's
      // items are locked from edits, so post and void mirror exactly.
      try {
        const orgId =
          (existing as unknown as { orgId?: string | null }).orgId ??
          "hookka";
        const actorUserId =
          (
            c as unknown as { get: (k: string) => string | undefined }
          ).get("userId") ?? null;
        const posted = await ledgerHasSource(c.var.DB, orgId, "invoice", id);
        const reversed = await ledgerHasSource(
          c.var.DB,
          orgId,
          "invoice_void",
          id,
        );
        if (posted && !reversed) {
          const { legs } = await buildInvoiceLedgerLegs(
            c.var.DB,
            orgId,
            {
              id,
              invoiceNo: existing.invoiceNo,
              customerId:
                (existing as unknown as { customerId?: string })
                  .customerId ?? "",
              subtotalSen: existing.subtotalSen,
            },
            actorUserId,
            true,
          );
          const { statements: ledgerStmts } =
            await buildJournalEntryStatements(c.var.DB, orgId, legs);
          statements.push(...ledgerStmts);
        }
      } catch (e) {
        console.warn(
          `[ledger] failed to BUILD reversal for invoice ${id} void:`,
          e,
        );
      }

      // PR 0 (2026-05-20, owner-confirmed) — reverse the customer's
      // outstanding A/R for the unpaid portion of the cancelled invoice.
      // Previously a CANCELLED transition wrote only the audit row, so
      // customers.outstandingSen kept carrying the cancelled amount —
      // AR drifted up forever (every cancelled SENT/PARTIAL_PAID/OVERDUE
      // invoice padded the balance with money the customer no longer owed).
      //
      // unpaidSen = totalSen - paidAmount = the portion that was still on
      // the customer's tab at cancel time. Already-paid portion stays out
      // of the reversal — the cash is real, it just needs a refund / CN
      // path which is a separate decision.
      //
      // MAX(0, ...) clamps in case the original create path didn't bump
      // outstandingSen for this invoice (the manual POST /api/invoices
      // path doesn't, only the auto-create-from-DO path does). Matches
      // the guard pattern used in credit-notes.ts:256 and payments.ts:389.
      const unpaidSen = existing.totalSen - existing.paidAmount;
      if (unpaidSen > 0 && existing.customerId) {
        statements.push(
          c.var.DB.prepare(
            `UPDATE customers SET outstandingSen = MAX(0, outstandingSen - ?) WHERE id = ?`,
          ).bind(unpaidSen, existing.customerId),
        );
      }
    }

    await c.var.DB.batch(statements);

    // Post-batch: success metrics for the audit / ledger writes that
    // landed atomically with the business mutation. Failures swallowed.
    if (isPostTransition) {
      recordAuditCreatedMetric(c, { resource: "invoices", action: "post" });
    } else if (isVoidTransition) {
      recordAuditCreatedMetric(c, { resource: "invoices", action: "void" });
    }

    const updated = await fetchInvoiceWithChildren(c.var.DB, id);

    return c.json({ success: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/invoices/:id] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error updating invoice" }, 500);
  }
});

// DELETE /api/invoices/:id — only DRAFT. Cascades via FK to items + payments.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "invoices", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  // PR 0 (2026-05-20, owner-confirmed) — pull customerId + amounts so we can
  // reverse the customer's outstandingSen if the deleted DRAFT had been
  // bumped on create. (Auto-created DRAFT invoices from delivery-orders.ts
  // bump outstandingSen on create; manual POST invoices.ts does not. The
  // MAX(0, ...) guard below handles both paths safely.)
  const existing = await c.var.DB.prepare(
    "SELECT id, status, customerId, totalSen, paidAmount FROM invoices WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      status: string;
      customerId: string;
      totalSen: number;
      paidAmount: number;
    }>();
  if (!existing) {
    return c.json({ success: false, error: "Invoice not found" }, 404);
  }
  if (existing.status !== "DRAFT") {
    return c.json(
      { success: false, error: "Only DRAFT invoices can be deleted" },
      400,
    );
  }
  // Same reversal logic as the PUT void path (see comment above the
  // isVoidTransition branch in this file). Done as a batch so DELETE +
  // customer adjustment either both land or both roll back.
  const unpaidSen = existing.totalSen - existing.paidAmount;
  const stmts: D1PreparedStatement[] = [
    c.var.DB.prepare("DELETE FROM invoices WHERE id = ?").bind(id),
  ];
  if (unpaidSen > 0 && existing.customerId) {
    stmts.push(
      c.var.DB.prepare(
        `UPDATE customers SET outstandingSen = MAX(0, outstandingSen - ?) WHERE id = ?`,
      ).bind(unpaidSen, existing.customerId),
    );
  }
  await c.var.DB.batch(stmts);
  return c.json({ success: true });
});

export default app;
