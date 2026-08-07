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
import { runSelfApply } from "../lib/self-apply";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { customerScopeSql } from "../lib/customer-scope";
import { computeInvoicePrintExtras } from "../lib/invoice-print-extras";
import { invoiceLineUnitSen } from "../../lib/invoice-line-price";
// Rollup: S3 won the audit/journal-hash signature change (batched into the
// invoice txn via buildAuditStatement + buildJournalEntryStatements). S4's
// pre-S3 emitAudit/appendJournalEntries variants are superseded. S4's
// getOrgId import is additive and stays.
import {
  buildAuditStatement,
  emitAudit,
  recordAuditCreatedMetric,
} from "../lib/audit";
import {
  buildJournalEntryStatements,
  ledgerHasSource,
  type LedgerEntryInput,
} from "../lib/journal-hash";
import { getOrgId } from "../lib/tenant";
import { checkInvoiceLocked, lockedResponse } from "../lib/lock-helpers";
import { readIdempotencyKey, withIdempotency } from "../lib/idempotency";
import { parseDebtorCode } from "../../lib/debtor";
import { nextMonthDueDate } from "../../lib/terms";
import { readGstRatePct } from "../lib/note-ledger";
import { ensureInvoicePoLinkColumn, readInvoiceItemPoLink } from "../lib/invoice-po-link";
import { matchInvoiceLinesToDoLines, type BackfillInvLine, type BackfillDoLine } from "../../lib/invoice-po-backfill";
import { compareDoLinesByCustomerPO } from "../../lib/do-item-order";
// The sales-side convert chain — per-line consumed counters on
// delivery_order_items + the DO-line link on invoice_items, so one delivery
// order can be billed by several invoices and every draw-down has its paired
// restore. Arithmetic lives in src/lib/convert-chain.ts (shared with
// purchasing); the DB half is src/api/lib/do-partial-invoice.ts.
import {
  ensureDoPartialInvoiceColumns,
  loadDoBillingState,
  doBillingRefusal,
  buildDrawdownStatements,
  buildInvoiceLineReleaseStatements,
  buildDoStatusSyncStatement,
} from "../lib/do-partial-invoice";
import type { DoDraw } from "../lib/do-partial-invoice";

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
//
// Phase 2 (2026-06) — `taxSenOverride`: tax is decided ONCE when the
// invoice is created and stored on the row (taxSen, with totalSen gross).
// Post / void / reversal call sites pass the STORED value so a mid-flight
// rate change can never make the reversal differ from the original
// posting. Pass null/undefined to compute from the current kv rate
// (creation-time call sites only).
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
  taxSenOverride?: number | null,
  itemsOverride?: { productCode: string; totalSen: number }[],
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
  //    Phase 2 fix — `itemsOverride`: the auto-on-delivered path builds
  //    legs in the SAME batch as the invoice INSERT, so the invoice_items
  //    query below saw NOTHING and every auto-invoice fell back to the
  //    generic BEDFRAME sales account — sofa revenue never reached
  //    500-0020. Creation-time callers now pass their in-memory items.
  const [itemsRes, prodRes] = await Promise.all([
    itemsOverride
      ? Promise.resolve({ results: itemsOverride })
      : db
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

  // 3. Tax: STORED value when the caller supplies one (post/void/reversal
  //    of an existing row), else computed from the operator-configured
  //    rate (creation-time call sites).
  let taxSen: number;
  if (taxSenOverride != null && Number.isFinite(taxSenOverride)) {
    taxSen = Math.max(0, Math.round(taxSenOverride));
  } else {
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
    taxSen = Math.max(0, Math.round((subtotal * pct) / 100));
  }

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
  // Phase 2: SST stored at creation; totalSen is GROSS (subtotal + tax).
  taxSen: number;
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
  // Per-line discount (migration 0179). snake_case DB col `discount_sen`
  // mapped via column-rename-map.json → reads back as `discountSen`.
  discountSen: number | null;
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
    // Per-line discount (migration 0179). Default 0 for rows predating the column.
    discountSen: row.discountSen ?? 0,
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

// Build the GL statements that neutralise a cancelled invoice: mirror-reverse
// whatever the invoice's doc family (invoice / invoice_restate_* / prior
// invoice_void legs) currently nets VISIBLY, per account. Org-agnostic read —
// the legs' own orgId is authoritative (BUG-2026-07-23-002: five cancels
// skipped their reversal because the old posted-check ran under a fallback
// org and read "never posted"). Naturally idempotent: once net is zero there
// is nothing to reverse.
async function buildCancelReversalStatements(
  db: D1Database,
  invoiceId: string,
  actorUserId: string | null,
  fallbackOrgId: string,
): Promise<{ statements: D1PreparedStatement[]; reversedNetSen: number }> {
  const cur =
    (
      await db
        .prepare(
          `SELECT accountCode, debitSen, creditSen, orgId FROM ledger_journal_entries
            WHERE sourceId = ? AND hidden = 0 AND sourceType LIKE 'invoice%'`,
        )
        .bind(invoiceId)
        .all<{ accountCode: string; debitSen: number; creditSen: number; orgId?: string | null }>()
    ).results ?? [];
  const net = new Map<string, number>(); // account → DR−CR
  let legOrg: string | null = null;
  for (const l of cur) {
    net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0));
    if (!legOrg && l.orgId) legOrg = String(l.orgId);
  }
  // Continue leg numbering after any existing invoice_void legs — the ledger
  // is UNIQUE(orgId, sourceType, sourceId, legNo), and a partially-reversed
  // invoice already owns the low leg numbers.
  const maxRow = await db
    .prepare(
      "SELECT COALESCE(MAX(legNo), 0) AS m FROM ledger_journal_entries WHERE sourceType = 'invoice_void' AND sourceId = ?",
    )
    .bind(invoiceId)
    .first<{ m: number }>();
  const legs: LedgerEntryInput[] = [];
  let legNo = (Number(maxRow?.m) || 0) + 1;
  let reversedNetSen = 0;
  for (const [acct, n] of net) {
    if (n === 0) continue;
    reversedNetSen += Math.abs(n);
    legs.push({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: "invoice_void",
      sourceId: invoiceId,
      legNo: legNo++,
      accountCode: acct,
      debitSen: n < 0 ? -n : 0,
      creditSen: n > 0 ? n : 0,
      description: `Void reversal · ${invoiceId}`,
      actorUserId,
      orgId: legOrg ?? fallbackOrgId,
    });
  }
  if (legs.length === 0) return { statements: [], reversedNetSen: 0 };
  const { statements } = await buildJournalEntryStatements(db, legOrg ?? fallbackOrgId, legs);
  return { statements, reversedNetSen };
}

// Order invoice items the way the DELIVERY ORDER prints (owner 2026-07-23
// 「invoice 的顺序要和 DO 一样，别太散」): customer PO ascending with natural
// numbers, blank POs LAST, then our SO — the SAME shared comparator print-do
// uses, resolved through each line's production_order_id link. Ordering only:
// nothing stored moves, amounts untouched; unlinked lines keep their relative
// order at the end (stable sort).
async function orderInvoiceItemsLikeDo(
  db: D1Database,
  items: InvoiceItemRow[],
): Promise<InvoiceItemRow[]> {
  const ids = [
    ...new Set(
      items
        .map((r) => readInvoiceItemPoLink(r as unknown as Record<string, unknown>))
        .filter((v): v is string => !!v),
    ),
  ];
  if (ids.length === 0) return items;
  const refs = new Map<string, { customerPOId: string; salesOrderNo: string }>();
  try {
    const marks = ids.map(() => "?").join(",");
    const res = await db
      .prepare(
        `SELECT id, customerPOId, companySOId, salesOrderId FROM production_orders WHERE id IN (${marks})`,
      )
      .bind(...ids)
      .all<{ id: string; customerPOId?: string | null; companySOId?: string | null; salesOrderId?: string | null }>();
    for (const r of res.results ?? []) {
      refs.set(String(r.id), {
        customerPOId: String(r.customerPOId ?? ""),
        salesOrderNo: String(r.companySOId ?? r.salesOrderId ?? ""),
      });
    }
  } catch {
    return items; // refs unavailable — keep the original order rather than guess
  }
  return items
    .map((it) => ({
      it,
      k: refs.get(readInvoiceItemPoLink(it as unknown as Record<string, unknown>) ?? "") ?? { customerPOId: "", salesOrderNo: "" },
    }))
    .sort((a, b) => compareDoLinesByCustomerPO(a.k, b.k))
    .map((x) => x.it);
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
    await orderInvoiceItemsLikeDo(db, itemsRes.results ?? []),
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
// POST /api/invoices/backfill-po-links
//
// One-shot legacy repair completing BUG-2026-07-17-001. Pre-fix invoices never
// stored invoice_items.production_order_id, so their printouts reconstruct the
// per-line customer PO by product|fabric|size guessing — the 2026-07-23 audit
// found 77 invoices (~179 lines) printing the wrong PO. This aligns each
// invoice's items to its DO's items via the STRICT pure matcher
// (src/lib/invoice-po-backfill.ts — refuses any invoice whose line groups
// don't match exactly) and writes ONLY production_order_id. Amounts,
// quantities, prices and statuses are untouched by construction (owner
// 2026-07-23: 「切记不要动到金额」).
//
// DEFAULTS TO DRY-RUN. Pass ?execute=1 to write (lesson of 2026-07-03: a
// query-param dry flag nobody noticed ran a live backfill — so this one
// requires an explicit OPT-IN to write, never an opt-out).
// Registered BEFORE /:id (Hono static-before-wildcard ordering).
app.post("/backfill-po-links", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;
  const execute = c.req.query("execute") === "1";
  await ensureInvoicePoLinkColumn(c.var.DB as never);

  // Invoices with a DO and at least one unlinked line.
  const invRes = await c.var.DB.prepare(
    `SELECT DISTINCT i.id, i.invoiceNo, i.deliveryOrderId
       FROM invoices i
       JOIN invoice_items ii ON ii.invoiceId = i.id
      WHERE i.deliveryOrderId IS NOT NULL AND i.deliveryOrderId <> ''
        AND (ii.production_order_id IS NULL OR ii.production_order_id = '')`,
  ).all<{ id: string; invoiceNo?: string; invoice_no?: string; deliveryOrderId?: string; delivery_order_id?: string }>();
  const invoices = invRes.results ?? [];

  const statements: D1PreparedStatement[] = [];
  const skipped: { invoiceNo: string; reason: string }[] = [];
  let linkedInvoices = 0;
  let linkedLines = 0;
  let unlinkableLines = 0;

  for (const inv of invoices) {
    const invoiceNo = String(inv.invoiceNo ?? inv.invoice_no ?? inv.id);
    const doId = String(inv.deliveryOrderId ?? inv.delivery_order_id ?? "");
    const [itemsRes, doRes] = await Promise.all([
      c.var.DB.prepare(
        `SELECT id, productCode, fabricCode, sizeLabel, production_order_id
           FROM invoice_items WHERE invoiceId = ? ORDER BY id`,
      ).bind(inv.id).all<{
        id: string; productCode?: string | null; product_code?: string | null;
        fabricCode?: string | null; fabric_code?: string | null;
        sizeLabel?: string | null; size_label?: string | null;
      }>(),
      c.var.DB.prepare(
        `SELECT productionOrderId, productCode, fabricCode, sizeLabel
           FROM delivery_order_items WHERE deliveryOrderId = ? ORDER BY id`,
      ).bind(doId).all<{
        productionOrderId?: string | null; production_order_id?: string | null;
        productCode?: string | null; product_code?: string | null;
        fabricCode?: string | null; fabric_code?: string | null;
        sizeLabel?: string | null; size_label?: string | null;
      }>(),
    ]);
    const invLines: BackfillInvLine[] = (itemsRes.results ?? []).map((r) => ({
      id: String(r.id),
      productCode: (r.productCode ?? r.product_code ?? null) as string | null,
      fabricCode: (r.fabricCode ?? r.fabric_code ?? null) as string | null,
      sizeLabel: (r.sizeLabel ?? r.size_label ?? null) as string | null,
      productionOrderId: readInvoiceItemPoLink(r as Record<string, unknown>),
    }));
    const doLines: BackfillDoLine[] = (doRes.results ?? []).map((r) => ({
      productCode: (r.productCode ?? r.product_code ?? null) as string | null,
      fabricCode: (r.fabricCode ?? r.fabric_code ?? null) as string | null,
      sizeLabel: (r.sizeLabel ?? r.size_label ?? null) as string | null,
      productionOrderId: (r.productionOrderId ?? r.production_order_id ?? null) as string | null,
    }));
    const match = matchInvoiceLinesToDoLines(invLines, doLines);
    if (!match.ok) { skipped.push({ invoiceNo, reason: match.reason }); continue; }
    if (match.assignments.length === 0) continue;
    linkedInvoices++;
    linkedLines += match.assignments.length;
    unlinkableLines += match.unlinkableLines;
    for (const a of match.assignments) {
      statements.push(
        c.var.DB.prepare(
          `UPDATE invoice_items SET production_order_id = ?
            WHERE id = ? AND (production_order_id IS NULL OR production_order_id = '')`,
        ).bind(a.productionOrderId, a.invoiceItemId),
      );
    }
  }

  if (execute && statements.length) {
    // Chunked batches — 77 invoices ≈ a few hundred single-column UPDATEs.
    for (let i = 0; i < statements.length; i += 100) {
      await c.var.DB.batch(statements.slice(i, i + 100));
    }
  }

  return c.json({
    success: true,
    data: {
      dry: !execute,
      scannedInvoices: invoices.length,
      linkedInvoices,
      linkedLines,
      unlinkableLines,
      skipped,
    },
  });
});

// Nightly-callable sweep for BUG-2026-07-23-002 — shared by the manual
// backfill endpoint below and /api/internal/nightly-gl-selfheal.
export async function sweepCancelledInvoiceReversals(
  db: D1Database,
  execute: boolean,
): Promise<{ scanned: number; needingReversal: number; fixed: { invoiceNo: string; reversedNetSen: number }[] }> {
  const cancelled = await db.prepare(
    "SELECT id, invoiceNo, orgId FROM invoices WHERE status = 'CANCELLED'",
  ).all<{ id: string; invoiceNo?: string; invoice_no?: string; orgId?: string | null }>();
  const fixed: { invoiceNo: string; reversedNetSen: number }[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const inv of cancelled.results ?? []) {
    const r = await buildCancelReversalStatements(db, inv.id, null, String(inv.orgId ?? 'hookka'));
    if (r.statements.length === 0) continue;
    fixed.push({ invoiceNo: String(inv.invoiceNo ?? inv.invoice_no ?? inv.id), reversedNetSen: r.reversedNetSen });
    statements.push(...r.statements);
  }
  if (execute && statements.length) {
    for (let i = 0; i < statements.length; i += 100) {
      await db.batch(statements.slice(i, i + 100));
    }
  }
  return { scanned: (cancelled.results ?? []).length, needingReversal: fixed.length, fixed };
}

// POST /api/invoices/backfill-cancel-reversals
//
// One-shot + nightly-callable repair for BUG-2026-07-23-002: CANCELLED
// invoices whose GL was never reversed (the old void path's posted-check
// could skip under an orgId mismatch). Mirror-reverses each cancelled
// invoice's VISIBLE doc-family net via buildCancelReversalStatements —
// org-agnostic, idempotent (net 0 → nothing to post). DEFAULTS TO DRY-RUN;
// ?execute=1 writes. Registered BEFORE /:id.
app.post("/backfill-cancel-reversals", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;
  const execute = c.req.query("execute") === "1";
  const r = await sweepCancelledInvoiceReversals(c.var.DB, execute);
  return c.json({ success: true, data: { dry: !execute, ...r } });
});

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
    `SELECT i.id, i.invoiceNo, i.invoiceDate AS old_date,
            d.deliveredAt, d.deliveryDate, d.status AS do_status
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
  // Owner 2026-08-05: "包括 invoice 也会看到 total amount，也不是根据我自己的."
  // The grid was already empty; the KPI cards and `total` were not, because
  // they are aggregates with no customer on them to filter.
  const invScope = await customerScopeSql(c, "customerId");
  if (invScope.clause) {
    where.push(invScope.clause);
    params.push(...invScope.binds);
  }
  if (customerId) {
    where.push("customerId = ?");
    params.push(customerId);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  // Date range (owner 2026-06-27): the Invoices page date filter is applied
  // SERVER-SIDE so it spans the whole table, not just the loaded page — and so
  // the list agrees with the (also filter-aware) KPI cards.
  const fromDate = c.req.query("from");
  const toDate = c.req.query("to");
  if (fromDate) {
    where.push("invoiceDate >= ?");
    params.push(fromDate);
  }
  if (toDate) {
    where.push("invoiceDate <= ?");
    params.push(toDate);
  }
  // Optional index-backed search (global Ctrl+K palette, ?search=). Partial
  // match on invoice number + customer name; fires only when present, so the
  // Invoices list page (no search param) is untouched.
  const q = (c.req.query("search") || c.req.query("q") || "").trim();
  if (q) {
    // Match the operator's real lookup keys: invoice no, customer name, the
    // linked DO no, our company SO, and the customer's PO. All live on the
    // invoices row (camelCase columns). Fires only when a term is present.
    where.push(
      "(invoiceNo ILIKE ? OR COALESCE(customerName, '') ILIKE ? OR COALESCE(doNo, '') ILIKE ? OR COALESCE(companySOId, '') ILIKE ? OR COALESCE(customerPOId, '') ILIKE ?)",
    );
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
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

  // Optional filter (owner 2026-06-27): the Invoices KPI cards FOLLOW the page's
  // status / customer / date filter. When any filter is active we compute a
  // fresh filter-scoped aggregate and BYPASS the snapshot (which only caches the
  // unfiltered whole-dataset totals). `period`-safe: date bounds come straight
  // from the page's From/To inputs (YYYY-MM-DD).
  const fCustomer = c.req.query("customerId");
  const fStatus = c.req.query("status");
  const fFrom = c.req.query("from");
  const fTo = c.req.query("to");
  // A scoped caller's KPI cards must be computed from their own rows, and must
  // never read or write the org-wide snapshot — the cards read 433 invoices and
  // RM 944,105.37 over an empty grid (owner 2026-08-05).
  const statScope = await customerScopeSql(c, "customerId");
  const filtered = !!(fCustomer || fStatus || fFrom || fTo) || !!statScope.clause;
  const fWhere: string[] = ["orgId = ?"];
  const fParams: unknown[] = [orgId];
  if (statScope.clause) { fWhere.push(statScope.clause); fParams.push(...statScope.binds); }
  if (fCustomer) { fWhere.push("customerId = ?"); fParams.push(fCustomer); }
  if (fStatus) { fWhere.push("status = ?"); fParams.push(fStatus); }
  if (fFrom) { fWhere.push("invoiceDate >= ?"); fParams.push(fFrom); }
  if (fTo) { fWhere.push("invoiceDate <= ?"); fParams.push(fTo); }
  const fClause = `WHERE ${fWhere.join(" AND ")}`;

  // PR 4 (2026-05-20) — cache-aside snapshot (UNFILTERED whole-dataset only).
  if (!filtered) {
    const { readInvoiceStatsSnapshot, getInvoiceStatsSignature, isSnapshotFresh } =
      await import("../lib/invoice-snapshot");
    const [snap, sig] = await Promise.all([
      readInvoiceStatsSnapshot(c.var.DB, orgId),
      // Signature = timestamp AND row count. The timestamp alone cannot see a
      // deleted invoice, so the stats card kept quoting one that was gone.
      getInvoiceStatsSignature(c.var.DB),
    ]);
    const currentMax = sig.maxUpdatedAt;
    if (isSnapshotFresh(snap, currentMax, sig.rowCount) && snap) {
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
      .prepare(
        `SELECT status, COUNT(*) AS n FROM invoices ${filtered ? fClause : ""} GROUP BY status`,
      )
      .bind(...(filtered ? fParams : []))
      .all<{ status: string; n: number }>(),
    c.var.DB
      .prepare(
        // Filtered: outstanding + collected within the filtered set. Unfiltered:
        // collected is month-to-date (the "Collected (MTD)" card's whole-table
        // meaning). Outstanding is the same formula either way.
        filtered
          ? `SELECT
               COALESCE(SUM(CASE WHEN status IN ('SENT','OVERDUE','PARTIAL_PAID')
                                  THEN totalSen - paidAmount ELSE 0 END), 0) AS "outstandingSen",
               COALESCE(SUM(CASE WHEN status = 'PAID'
                                  THEN paidAmount ELSE 0 END), 0)            AS "paidMTDSen"
               FROM invoices ${fClause}`
          : `SELECT
               COALESCE(SUM(CASE WHEN status IN ('SENT','OVERDUE','PARTIAL_PAID')
                                  THEN totalSen - paidAmount ELSE 0 END), 0) AS "outstandingSen",
               COALESCE(SUM(CASE WHEN status = 'PAID' AND invoiceDate LIKE ?
                                  THEN paidAmount ELSE 0 END), 0)            AS "paidMTDSen"
               FROM invoices`,
      )
      .bind(...(filtered ? fParams : [currentMonthLike]))
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

  // Only the UNFILTERED whole-dataset payload is cacheable; a filtered view is
  // per-request and must never overwrite the canonical snapshot.
  if (!filtered) {
    try {
      const { writeInvoiceStatsSnapshot, getInvoiceStatsSignature } =
        await import("../lib/invoice-snapshot");
      const sig = await getInvoiceStatsSignature(c.var.DB);
      await writeInvoiceStatsSnapshot(
        c.var.DB,
        orgId,
        payload as Record<string, unknown>,
        sig.maxUpdatedAt ?? new Date().toISOString(),
        sig.rowCount,
      );
    } catch (e) {
      console.warn("[invoice-stats-snapshot] write-back failed:", e);
    }
  }

  return c.json({ success: true, ...payload });
});

// ---------------------------------------------------------------------------
// GET /api/invoices/aging — whole-dataset AR Aging (2026-07-14 bug fix).
//
// BUG: the Invoices page's AR Aging tab bucketed per-customer overdue money over
// the client-loaded page ONLY (PAGE_SIZE 200) — so past page 1 the aging report
// silently DROPPED invoices (measured live: 341 total, page 200 → 141 missing,
// ~41% of receivables uncounted). Same class the KPI cards already fixed via
// /stats; the Aging tab was missed. This computes the SAME buckets the FE did,
// with the IDENTICAL logic, but over the WHOLE table (owner: 做账要准).
//
// Bucket logic is a VERBATIM port of invoices/index.tsx agingData: exclude
// PAID/CANCELLED/DRAFT + balance>0; daysOverdue = floor((now - dueDate)/day);
// <=30 -> current, 31-60 -> days31_60, 61-90 -> days61_90, >90 -> days90plus;
// group by customerName; sort by total desc. Honors the page's customer/date
// filter (the status filter is subsumed by the not-in-PAID/CANCELLED/DRAFT rule).
// Invoice volume is small (hundreds) so a plain aggregate is fine — no snapshot.
// Registered BEFORE /:id (Hono static-first).
// ---------------------------------------------------------------------------
app.get("/aging", async (c) => {
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);

  const where: string[] = [
    "orgId = ?",
    "status NOT IN ('PAID','CANCELLED','DRAFT')",
    "(totalSen - paidAmount) > 0",
  ];
  const params: unknown[] = [orgId];
  const fCustomer = c.req.query("customerId");
  const fStatus = c.req.query("status");
  const fFrom = c.req.query("from");
  const fTo = c.req.query("to");
  if (fCustomer) { where.push("customerId = ?"); params.push(fCustomer); }
  // The page's status filter also scopes the aging tab (the old client
  // computation ran over the status-filtered list). Combined with the
  // NOT IN (PAID/CANCELLED/DRAFT) rule above so e.g. status=PAID -> empty.
  if (fStatus) { where.push("status = ?"); params.push(fStatus); }
  if (fFrom) { where.push("invoiceDate >= ?"); params.push(fFrom); }
  if (fTo) { where.push("invoiceDate <= ?"); params.push(fTo); }

  const res = await c.var.DB
    .prepare(
      `SELECT customerName, totalSen, paidAmount, dueDate
         FROM invoices WHERE ${where.join(" AND ")}`,
    )
    .bind(...params)
    .all<{
      customerName: string;
      totalSen: number;
      paidAmount: number;
      dueDate: string;
    }>();

  const today = new Date();
  const customerMap: Record<
    string,
    {
      customerName: string;
      current: number;
      days31_60: number;
      days61_90: number;
      days90plus: number;
      total: number;
    }
  > = {};
  for (const inv of res.results ?? []) {
    const balance = Number(inv.totalSen) - Number(inv.paidAmount);
    if (balance <= 0) continue;
    const dueDate = new Date(inv.dueDate);
    const daysOverdue = Math.floor(
      (today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const name = inv.customerName;
    if (!customerMap[name]) {
      customerMap[name] = {
        customerName: name,
        current: 0,
        days31_60: 0,
        days61_90: 0,
        days90plus: 0,
        total: 0,
      };
    }
    const row = customerMap[name];
    if (daysOverdue <= 30) row.current += balance;
    else if (daysOverdue <= 60) row.days31_60 += balance;
    else if (daysOverdue <= 90) row.days61_90 += balance;
    else row.days90plus += balance;
    row.total += balance;
  }
  const data = Object.values(customerMap).sort((a, b) => b.total - a.total);
  return c.json({ success: true, data });
});

// POST /api/invoices — create from a DELIVERED delivery order.
// 0179 self-apply — Postgres migration files are applied manually (deploy.yml
// does NOT replay them), so ensure the per-line discount column exists before
// any invoice write touches it. Idempotent ADD COLUMN IF NOT EXISTS, once/isolate.
// A BOOLEAN, not the promise — see src/api/lib/self-apply.ts. The old shape
// cached the promise AND swallowed the error, so one transient DDL reject left
// both columns unapplied and remembered as done for the life of the isolate.
let _invDiscountColMig = false;
async function ensureDiscountColumn(db: D1Database): Promise<void> {
  if (_invDiscountColMig) return;
  try {
    await db
      .prepare("ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS discount_sen INTEGER NOT NULL DEFAULT 0")
      .run();
    // 0209 — total-height component column (see sales-orders self-apply).
    await db
      .prepare("ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS total_height_price_sen INTEGER NOT NULL DEFAULT 0")
      .run();
    _invDiscountColMig = true;
  } catch {
    /* transient — leave the flag unset so the next request retries */
  }
}

// 0208 self-apply — the DB-level guarantee that one delivery order can have at
// most ONE active (non-cancelled) invoice. See migrations-postgres/0208.
// BUG-2026-07-14-006: the application check-then-write guard has a race window;
// two concurrent create requests both pass it and both INSERT. This partial-
// unique index makes the second INSERT fail at the storage layer, so the race
// can never produce a duplicate. Idempotent (IF NOT EXISTS), once per isolate.
// Failure is swallowed (e.g. a lingering duplicate would make CREATE fail) so a
// wedged index build never blocks invoicing — but the dups were cleaned first.
// Reverse-lookup indexes for the credit/debit notes raised against an invoice
// (owner 2026-08-01). GET /:id now answers "what was credited/debited back off
// this invoice" by querying credit_notes.invoice_id / debit_notes.invoice_id —
// the reverse of the direction the notes themselves are stored in. 0001_init
// declared these indexes, but migration files are NOT replayed on deploy, so
// the only guarantee they exist in prod is this runtime self-apply. Idempotent
// (IF NOT EXISTS) with the SAME index names, so it is a no-op wherever the
// init migration was applied by hand. Memoised once per isolate; failure is
// swallowed with a warn — an index that will not build must never take the
// invoice detail page down with it.
let _invNoteIndexMig: Promise<void> | null = null;
function ensureInvoiceNoteIndexes(db: D1Database): Promise<void> {
  if (!_invNoteIndexMig) {
    _invNoteIndexMig = (async () => {
      const stmts = [
        `CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice_id ON credit_notes (invoice_id)`,
        `CREATE INDEX IF NOT EXISTS idx_debit_notes_invoice_id ON debit_notes (invoice_id)`,
      ];
      await runSelfApply(db, "invoices", stmts);
    })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    _invNoteIndexMig = null;
    throw err;
  });
  }
  return _invNoteIndexMig;
}

// Shared row shape for both note tables — identical columns in 0001_init.
type NoteLinkRow = {
  id: string;
  noteNumber: string | null;
  date: string | null;
  reason: string | null;
  totalAmount: number | null;
  status: string | null;
};
function rowToNoteLink(r: NoteLinkRow) {
  return {
    id: r.id,
    noteNumber: r.noteNumber ?? "",
    date: r.date ?? "",
    reason: r.reason ?? "",
    totalAmount: r.totalAmount ?? 0,
    status: r.status ?? "",
  };
}

// uniq_invoice_active_delivery_order is GONE (2026-08-07). It enforced "one
// delivery order has at most ONE active invoice" at the storage layer — which
// is precisely what one-DO-many-invoices has to undo. Its job (stopping a
// concurrent double-create, BUG-2026-07-14-006) is now done by the CHECK
// constraint `chk_doi_invoiced_qty` on delivery_order_items: the race worth
// guarding is no longer "two invoices exist" but "two concurrent bills that
// together draw more than the delivery delivered", and the CHECK makes the
// second batch fail rather than over-bill the customer. Both the index DROP
// and the CHECK live in ensureDoPartialInvoiceColumns
// (src/api/lib/do-partial-invoice.ts) so they can never be applied apart.

app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — invoices:create.
  const denied = await requirePermission(c, "invoices", "create");
  if (denied) return denied;
  await ensureDiscountColumn(c.var.DB);
  await ensureDoPartialInvoiceColumns(c.var.DB);
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
    // Guarantee the delivered-with-issues column exists before we read it
    // (call-time import — same cycle-avoidance the line-pricing import below
    // uses; delivery-orders already imports nextInvoiceNo from here).
    const { ensureDeliveryIncompleteColumn, fireCustomerNoticeBestEffort } =
      await import("./delivery-orders");
    await ensureDeliveryIncompleteColumn(c.var.DB);
    const doRow = await c.var.DB.prepare(
      `SELECT id, doNo, salesOrderId, companySOId, customerId, customerName,
              customerState, deliveryAddress, contactPerson, contactPhone,
              customerPOId, hubId, hubName, status, delivery_incomplete
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
        delivery_incomplete: number | null;
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
    // Double-invoice guard (2026-07-14, re-based on the per-line counters
    // 2026-08-07). Root cause of the 64-DO / 77-extra duplicate-invoice bug:
    // the DO-status check alone is racy (wide read→write window) and does not
    // cover the case where a prior invoice did not flip the DO to INVOICED.
    //
    // The question it asks is now "is there anything LEFT to bill", not "does
    // an invoice exist" — a delivery may legitimately carry several invoices,
    // one per part of it. loadDoBillingState answers with Σ invoiced_qty vs
    // Σ quantity, and separately reports a LEGACY whole-document invoice (one
    // whose lines predate the per-line link). A legacy invoice still means
    // "fully billed", so every delivery order in today's book keeps behaving
    // exactly as it does today and nothing becomes newly re-billable.
    const billing = await loadDoBillingState(c.var.DB, deliveryOrderId);
    const refusal = doBillingRefusal(doRow.doNo, billing);
    if (refusal) {
      return c.json(
        {
          success: false,
          error: refusal,
          existingInvoiceId: billing.legacyInvoice?.id ?? null,
          existingInvoiceNo: billing.legacyInvoice?.invoiceNo ?? null,
        },
        409,
      );
    }
    // Delivered-with-issues hold: the goods arrived but the paperwork was
    // incomplete, so billing is withheld until an operator resolves it
    // (POST /api/delivery-orders/:id/resolve-incomplete, which itself creates
    // the invoice). Mirrors the same block in the PUT "Convert to Invoice".
    if (Number(doRow.delivery_incomplete) === 1) {
      return c.json(
        {
          success: false,
          error:
            "This delivery was marked DELIVERED WITH ISSUES — resolve the paperwork (Mark documents complete) before it can be invoiced.",
        },
        409,
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
    // WHICH lines / quantities this invoice bills. Omit `lines` and it bills
    // everything still un-invoiced — the behaviour every existing caller (and
    // the auto-on-delivery cascade) relies on, and identical to today on a
    // fresh delivery. Send `lines` and the operator's own pick wins.
    const requestedLines: DoDraw[] | null = Array.isArray(body.lines)
      ? (body.lines as Array<Record<string, unknown>>)
          .map((l) => ({
            deliveryOrderItemId: String(
              l.deliveryOrderItemId ?? l.delivery_order_item_id ?? "",
            ),
            quantity: Math.max(0, Math.round(Number(l.quantity) || 0)),
          }))
          .filter((l) => l.deliveryOrderItemId && l.quantity > 0)
      : null;
    if (requestedLines && requestedLines.length === 0) {
      return c.json(
        {
          success: false,
          error:
            "Pick at least one line (and a quantity above zero) to invoice.",
        },
        400,
      );
    }
    const { invItems, computedTotal, draws } = await computeDoInvoiceLines(
      c.var.DB,
      doRow.id,
      soIdsForInvoice,
      requestedLines,
    );
    if (invItems.length === 0 && computedTotal === 0) {
      return c.json(
        {
          success: false,
          error: `Nothing to invoice on ${doRow.doNo} — the lines you picked are already billed. Reload the delivery order to see what is left.`,
        },
        409,
      );
    }
    // Over-draw guard + the draw-down statements, from the SAME seam the
    // purchasing chain uses. computeDoInvoiceLines already clamps to the
    // remainder, so a rejection here means the picker was stale — say so with
    // the numbers rather than silently billing a different amount.
    const drawn = buildDrawdownStatements(c.var.DB, billing, draws);
    if (!drawn.ok) {
      return c.json({ success: false, error: drawn.error }, 409);
    }
    const drawnQty = draws.reduce((n, d) => n + d.quantity, 0);
    const fullyBilledAfter =
      draws.length === 0 || billing.remainingQty - drawnQty <= 0;
    const items = invItems;
    const subtotalSen = computedTotal;
    // Phase 2 (2026-06) — SST billed to the customer: tax is computed ONCE
    // at creation from the operator-configured rate and stored; posting,
    // void, payments, aging and the CN cap all read the STORED values, so
    // a mid-flight rate change can never split the GL from the subledger.
    // totalSen is the GROSS amount the customer owes (subtotal + SST).
    const ratePct = await readGstRatePct(c.var.DB);
    const taxSen = Math.max(0, Math.round((subtotalSen * ratePct) / 100));
    const totalSen = subtotalSen + taxSen;
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
           subtotalSen, taxSen, totalSen, status, invoiceDate, dueDate, paidAmount,
           paymentDate, paymentMethod, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        taxSen,
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
             quantity, unitPriceSen, discountSen, totalSen,
             production_order_id, delivery_order_item_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          id,
          item.productCode,
          item.productName,
          item.sizeLabel,
          item.fabricCode,
          item.quantity,
          item.unitPriceSen,
          // Auto-created invoices (from DO) carry no discount by default.
          0,
          item.totalSen,
          // BUG-2026-07-17-001 — the manual create path dropped this link the
          // auto path already carried, so a hand-raised invoice went back to
          // guessing the customer PO by product code at print time.
          item.productionOrderId,
          // The convert-chain link. Without it this invoice reads as a legacy
          // whole-document bill and locks the delivery order to itself.
          item.deliveryOrderItemId,
        ),
      ),
      // Draw the billed quantity down on each DO line, same batch as the
      // invoice — build and consume are one decision.
      ...drawn.statements,
      // Phase 2 (2026-06) — closes a long-noted gap: the auto-created
      // invoice (delivery-orders.ts) bumped customers.outstandingSen on
      // create but this manual path never did, so manually-invoiced
      // customers under-reported what they owe. Bump GROSS (incl. SST) —
      // void/cancel/delete already reverse the unpaid portion for both
      // paths.
      c.var.DB.prepare(
        `UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?`,
      ).bind(totalSen, doRow.customerId),
    ];

    // Flip the DO to INVOICED only when this invoice bills the LAST of it.
    // The flag is no longer the source of truth (Σ invoiced_qty vs Σ quantity
    // is), but it greys the "Transfer to Invoice" button and gates this very
    // handler — so a half-billed delivery that flipped to INVOICED could never
    // be finished. Same batch, so it rolls back with the invoice.
    if (fullyBilledAfter) {
      statements.push(
        c.var.DB.prepare(
          `UPDATE delivery_orders SET status = 'INVOICED', overdue = 'INVOICED', updated_at = ? WHERE id = ?`,
        ).bind(now, doRow.id),
      );
    }

    try {
      await c.var.DB.batch(statements);
    } catch (batchErr) {
      // The 0208 partial-unique index (uniq_invoice_active_delivery_order) is
      // the last line of defence against the double-invoice race: if a
      // concurrent request already created the active invoice for this DO
      // between our guard check above and this INSERT, Postgres rejects the
      // second row. Turn that storage-layer rejection into the SAME graceful
      // 409 the guard returns, pointing at the invoice that won the race —
      // instead of a raw 500. Any other batch failure re-throws.
      const m = batchErr instanceof Error ? batchErr.message : String(batchErr);
      // chk_doi_invoiced_qty is the storage-layer backstop that replaced the
      // old uniq_invoice_active_delivery_order index: a concurrent bill that
      // together with ours draws more than the delivery delivered fails HERE.
      // Turn it into the same graceful 409 the guard above returns, with the
      // now-current numbers, instead of a raw 500.
      if (/chk_doi_invoiced_qty|check constraint/i.test(m)) {
        const fresh = await loadDoBillingState(c.var.DB, deliveryOrderId);
        return c.json(
          {
            success: false,
            error: `Another invoice billed part of ${doRow.doNo} while this one was being raised — only ${fresh.remainingQty} unit(s) are still un-invoiced. Reload the delivery order and pick again.`,
          },
          409,
        );
      }
      if (/uniq_invoice_active_delivery_order|duplicate key|23505/i.test(m)) {
        const existing = await c.var.DB
          .prepare(
            "SELECT id, invoiceNo FROM invoices WHERE deliveryOrderId = ? AND status != 'CANCELLED' LIMIT 1",
          )
          .bind(deliveryOrderId)
          .first<{ id: string; invoiceNo: string }>();
        return c.json(
          {
            success: false,
            error: `An invoice (${existing?.invoiceNo ?? "unknown"}) already exists for this delivery order.`,
            existingInvoiceId: existing?.id ?? null,
            existingInvoiceNo: existing?.invoiceNo ?? null,
          },
          409,
        );
      }
      throw batchErr;
    }

    // BACKEND customer-notice trigger (BUG-2026-06-23 safety net). The manual
    // "Generate Invoice" button (DELIVERED → INVOICED via this POST) does NOT
    // pass through applyDeliveryOrderUpdate, so its choke-point notice never
    // fires here — wire the same fire-and-forget invoice notice so this path
    // also emails the customer. Idempotency-stamped (deliveredEmailAt), so if
    // the DELIVERED-time notice already went out this no-ops; if it never did
    // (the Houzs signature), this is the catch-all that finally sends it. The
    // invoice row is now committed, so queueDoCustomerNotice resolves it.
    fireCustomerNoticeBestEffort(c, doRow.id, "DELIVERED");

    const created = await fetchInvoiceWithChildren(c.var.DB, id);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create invoice" },
        500,
      );
    }
    // Invoice creation was entirely unaudited — the core revenue document
    // appeared with no record of who raised it. `before` is null by definition
    // for a create; `after` is the persisted row, so the original figures are
    // recoverable even if the invoice is later edited.
    await emitAudit(c, {
      resource: "invoices",
      resourceId: created?.id ?? id,
      action: "create",
      after: created,
    });
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
  const extras = await computeInvoicePrintExtras(c.var.DB, id);
  if (!extras) {
    return c.json({ success: false, error: "Invoice not found" }, 404);
  }
  return c.json({ success: true, data: extras });
});

// GET /api/invoices/:id — single
// GET /api/invoices/:id — invoice + children + the notes raised against it.
//
// Reverse links (owner 2026-08-01): credit_notes.invoice_id and
// debit_notes.invoice_id point AT the invoice, so an adjustment was only
// discoverable from the Credit/Debit Notes lists. An invoice could have been
// half credited back and its own page still showed the original total with no
// hint the amount receivable had moved — the single most misleading number on
// the page. See ensureInvoiceNoteIndexes() for the index self-apply.
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  // Reverse-lookup indexes — awaited (not fire-and-forget) so the very first
  // detail read on a fresh isolate does not run the two note queries against
  // an unindexed column. Memoised, so it costs one round trip per isolate.
  await ensureInvoiceNoteIndexes(c.var.DB);
  const [inv, lockReason, cnRes, dnRes] = await Promise.all([
    fetchInvoiceWithChildren(c.var.DB, id),
    // Lock status (payment recorded / status=PAID?) — surfaced to the
    // detail page so it can render a "credit note required" banner.
    checkInvoiceLocked(c.var.DB, id),
    c.var.DB.prepare(
      `SELECT id, noteNumber, date, reason, totalAmount, status
         FROM credit_notes
        WHERE invoiceId = ?
        ORDER BY date DESC`,
    )
      .bind(id)
      .all<NoteLinkRow>(),
    c.var.DB.prepare(
      `SELECT id, noteNumber, date, reason, totalAmount, status
         FROM debit_notes
        WHERE invoiceId = ?
        ORDER BY date DESC`,
    )
      .bind(id)
      .all<NoteLinkRow>(),
  ]);
  if (!inv) {
    return c.json({ success: false, error: "Invoice not found" }, 404);
  }
  // Reverse CN link (2026-08-01). A CN can be converted into a DRAFT
  // invoice via POST /api/consignment-notes/:id/convert-to-invoice — an
  // official flow (owner re-confirmed 2026-08-01). That path writes the
  // link ONE-WAY onto consignment_notes.converted_invoice_id (mig 0070):
  // the invoice row itself keeps deliveryOrderId / doNo / salesOrderId
  // null, so before this lookup a CN-origin invoice gave the viewer no
  // indication where it came from. Index
  // idx_consignment_notes_converted_invoice_id already covers this
  // predicate, so it is a cheap single-row probe.
  let sourceConsignmentNote: { id: string; noteNumber: string } | null = null;
  try {
    const cnRow = await c.var.DB.prepare(
      "SELECT id, noteNumber FROM consignment_notes WHERE convertedInvoiceId = ?",
    )
      .bind(id)
      .first<{
        id: string;
        noteNumber?: string | null;
        note_number?: string | null;
      }>();
    if (cnRow) {
      sourceConsignmentNote = {
        id: cnRow.id,
        noteNumber: cnRow.noteNumber ?? cnRow.note_number ?? "",
      };
    }
  } catch (err) {
    // Best-effort enrichment — never fail the invoice read over it.
    console.error(
      "[GET /api/invoices/:id] source CN lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return c.json({
    success: true,
    data: inv,
    lockReason,
    linkedCreditNotes: (cnRes.results ?? []).map(rowToNoteLink),
    linkedDebitNotes: (dnRes.results ?? []).map(rowToNoteLink),
    sourceConsignmentNote,
  });
});

// PUT /api/invoices/:id — update (status transitions, payments, fields)
app.put("/:id", async (c) => {
  // RBAC gate (P3.3-followup) — base permission is invoices:update.
  // Sensitive transitions get additional row-level checks below:
  //   • DRAFT → SENT  (the "post" action)        ⇒ invoices:post
  //   • *     → CANCELLED  (the "void" action)   ⇒ invoices:void
  const baseDenied = await requirePermission(c, "invoices", "update");
  if (baseDenied) return baseDenied;
  await ensureDiscountColumn(c.var.DB);
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
      // Wholesale line replacement is DRAFT-only. On a SENT/posted invoice it
      // rewrites subtotal/tax/total + customer A/R but does NOT restate the GL
      // journal (the per-line "price edit" path below is the one that correctly
      // reverses + re-posts the GL for a sent invoice). Skipping the GL restate
      // means a later void reverses against the ORIGINAL posting and orphans the
      // difference in revenue/AR. Block it; sent-invoice edits go via price-edit.
      if (existing.status !== "DRAFT") {
        return c.json(
          {
            success: false,
            error: "Line items can only be replaced while the invoice is a DRAFT. Use the per-line price edit on a sent invoice.",
          },
          409,
        );
      }
      await ensureDoPartialInvoiceColumns(c.var.DB);
      // Removing a line from a DRAFT invoice must GIVE THE QUANTITY BACK — the
      // same release discipline the purchasing chain has (a PI edit hands the
      // GRN line's invoiced_qty back before the new lines re-consume). Without
      // it, deleting a line off a draft would leave that delivery quantity
      // consumed by an invoice that no longer charges for it, and nobody could
      // ever bill it again.
      //
      // Shape: release the WHOLE old line set, then re-consume what survives.
      // Net-delta arithmetic would be equivalent but has two failure modes this
      // does not — a line that changed which DO line it points at, and a line
      // dropped entirely. Release-then-reconsume is the same order the void /
      // delete path uses, so there is one rule.
      const oldLinksRes = await c.var.DB.prepare(
        `SELECT id, delivery_order_item_id AS "deliveryOrderItemId",
                production_order_id AS "productionOrderId", quantity
           FROM invoice_items WHERE invoiceId = ?`,
      )
        .bind(id)
        .all<{
          id: string;
          deliveryOrderItemId?: string | null;
          delivery_order_item_id?: string | null;
          productionOrderId?: string | null;
          production_order_id?: string | null;
          quantity: number;
        }>();
      const oldRows = oldLinksRes.results ?? [];
      const oldLinkById = new Map(
        oldRows.map((r) => [
          String(r.id),
          {
            doItemId: r.deliveryOrderItemId ?? r.delivery_order_item_id ?? null,
            poId: r.productionOrderId ?? r.production_order_id ?? null,
          },
        ]),
      );
      const releasedByLine = new Map<string, number>();
      for (const r of oldRows) {
        const k = r.deliveryOrderItemId ?? r.delivery_order_item_id ?? null;
        if (!k) continue;
        releasedByLine.set(
          String(k),
          (releasedByLine.get(String(k)) ?? 0) + (Number(r.quantity) || 0),
        );
      }
      statements.push(...(await buildInvoiceLineReleaseStatements(c.var.DB, id)));

      statements.push(
        c.var.DB.prepare(
          "DELETE FROM invoice_items WHERE invoiceId = ?",
        ).bind(id),
      );
      let computedSubtotal = 0;
      const reconsume: DoDraw[] = [];
      const newRows: Array<{
        id: string;
        doItemId: string | null;
        poId: string | null;
        quantity: number;
        unitPriceSen: number;
        discountSen: number;
        totalSen: number;
        raw: Record<string, unknown>;
      }> = [];
      for (const raw of body.items as Array<Record<string, unknown>>) {
        const quantity = Number(raw.quantity) || 0;
        const unitPriceSen = Number(raw.unitPriceSen) || 0;
        // Per-line discount (migration 0179). Clamped ≥ 0.
        const discountSen = Math.max(0, Math.round(Number(raw.discountSen) || 0));
        // Tier D D4 fix 2026-05-21 — back-door write. Always recompute
        // totalSen server-side; caller-supplied totalSen is ignored.
        // Line total = max(0, qty × unitPrice − discount).
        const totalSen = Math.max(0, unitPriceSen * quantity - discountSen);
        computedSubtotal += totalSen;
        const rowId = (raw.id as string) || genInvoiceItemId();
        const prior = oldLinkById.get(rowId);
        // The links are carried across the replacement. A caller that echoes
        // the rows back unchanged keeps them implicitly; one that omits them
        // inherits from the row it is replacing. Dropping them here is what
        // used to turn an edited invoice into a link-less legacy bill (and,
        // before that, cost the printout its customer PO — BUG-2026-07-17-001).
        const doItemId =
          (raw.deliveryOrderItemId as string | undefined) ??
          prior?.doItemId ??
          null;
        const poId =
          (raw.productionOrderId as string | undefined) ?? prior?.poId ?? null;
        if (doItemId && quantity > 0) {
          reconsume.push({ deliveryOrderItemId: doItemId, quantity });
        }
        newRows.push({
          id: rowId,
          doItemId,
          poId,
          quantity,
          unitPriceSen,
          discountSen,
          totalSen,
          raw,
        });
      }

      // Can the surviving lines still be covered? Project each DO line's
      // consumption as (current − what THIS invoice is handing back) and check
      // the new draw against that. A line another invoice claimed while this
      // draft sat open is refused with the numbers, not silently trimmed.
      if (reconsume.length > 0) {
        const st = await loadDoBillingState(
          c.var.DB,
          existing.deliveryOrderId ?? "",
        );
        const projected = {
          ...st,
          lines: st.lines.map((l) => {
            const back = releasedByLine.get(l.id) ?? 0;
            const invoicedQty = Math.max(0, l.invoicedQty - back);
            return {
              ...l,
              invoicedQty,
              remainingQty: Math.max(0, l.quantity - invoicedQty),
            };
          }),
        };
        const redraw = buildDrawdownStatements(c.var.DB, projected, reconsume);
        if (!redraw.ok) {
          return c.json({ success: false, error: redraw.error }, 409);
        }
        statements.push(...redraw.statements);
      }

      for (const r of newRows) {
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO invoice_items (
               id, invoiceId, productCode, productName, sizeLabel, fabricCode,
               quantity, unitPriceSen, discountSen, totalSen,
               production_order_id, delivery_order_item_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            r.id,
            id,
            (r.raw.productCode as string) ?? "",
            (r.raw.productName as string) ?? "",
            (r.raw.sizeLabel as string) ?? "",
            (r.raw.fabricCode as string) ?? "",
            r.quantity,
            r.unitPriceSen,
            r.discountSen,
            r.totalSen,
            r.poId,
            r.doItemId,
          ),
        );
      }

      // And keep the DO's own flag in step with the counters this edit moved.
      if (existing.deliveryOrderId) {
        const doNow = await c.var.DB.prepare(
          "SELECT status FROM delivery_orders WHERE id = ?",
        )
          .bind(existing.deliveryOrderId)
          .first<{ status: string }>();
        const stAfter = await loadDoBillingState(
          c.var.DB,
          existing.deliveryOrderId,
        );
        const releasedTotal = [...releasedByLine.values()].reduce((a, b) => a + b, 0);
        const reconsumedTotal = reconsume.reduce((a, b) => a + b.quantity, 0);
        const remainingAfter =
          stAfter.remainingQty + releasedTotal - reconsumedTotal;
        const sync = buildDoStatusSyncStatement(
          c.var.DB,
          existing.deliveryOrderId,
          doNow?.status ?? "",
          stAfter.legacyInvoice !== null ||
            (stAfter.totalQty > 0 && remainingAfter <= 0),
          now,
        );
        if (sync) statements.push(sync);
      }
      // Phase 2 — re-derive tax with the subtotal (same rule as creation)
      // and keep totalSen GROSS; adjust the customer's outstanding by the
      // gross delta in the same batch.
      const replRatePct = await readGstRatePct(c.var.DB);
      const replTaxSen = Math.max(
        0,
        Math.round((computedSubtotal * replRatePct) / 100),
      );
      const replGrossSen = computedSubtotal + replTaxSen;
      statements.push(
        c.var.DB.prepare(
          "UPDATE invoices SET subtotalSen = ?, taxSen = ?, totalSen = ? WHERE id = ?",
        ).bind(computedSubtotal, replTaxSen, replGrossSen, id),
      );
      const replDelta = replGrossSen - (Number(existing.totalSen) || 0);
      const replCustId =
        (existing as unknown as { customerId?: string }).customerId ?? "";
      if (replDelta !== 0 && replCustId) {
        statements.push(
          c.var.DB.prepare(
            `UPDATE customers SET outstandingSen = GREATEST(0, outstandingSen + ?) WHERE id = ?`,
          ).bind(replDelta, replCustId),
        );
      }
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
        { base: number; divan: number; leg: number; special: number; totalHeight: number; discount: number }
      >();
      for (const e of body.priceEdits as Array<Record<string, unknown>>) {
        const lid = String(e.id || "");
        if (!lid) continue;
        editById.set(lid, {
          base: Math.max(0, Math.round(Number(e.baseSen) || 0)),
          divan: Math.max(0, Math.round(Number(e.divanSen) || 0)),
          leg: Math.max(0, Math.round(Number(e.legSen) || 0)),
          special: Math.max(0, Math.round(Number(e.specialSen) || 0)),
          // Total-height surcharge (0209) — the 4th component, editable like the rest.
          totalHeight: Math.max(0, Math.round(Number(e.totalHeightSen) || 0)),
          // Per-line discount (migration 0179). Clamped ≥ 0.
          discount: Math.max(0, Math.round(Number(e.discountSen) || 0)),
        });
      }
      const allRes = await c.var.DB.prepare(
        "SELECT id, quantity, unitPriceSen, discountSen FROM invoice_items WHERE invoiceId = ?",
      )
        .bind(id)
        .all<{ id: string; quantity: number; unitPriceSen: number; discountSen: number | null }>();
      let newSubtotal = 0;
      let touched = 0;
      for (const r of allRes.results ?? []) {
        const q = Number(r.quantity) || 0;
        const ed = editById.get(r.id);
        if (ed) {
          touched++;
          // Rule 5 (src/lib/invoice-line-price.ts): the charge IS the sum of the
          // components the operator typed. Same function the editor previews
          // with, so a component can never be counted on one side only.
          const unit = invoiceLineUnitSen({
            baseSen: ed.base,
            divanSen: ed.divan,
            legSen: ed.leg,
            specialSen: ed.special,
            totalHeightSen: ed.totalHeight,
          });
          // Line total = max(0, unit × qty − discount).
          const lineTotal = Math.max(0, unit * q - ed.discount);
          newSubtotal += lineTotal;
          statements.push(
            c.var.DB.prepare(
              `UPDATE invoice_items SET
                 basePriceSen = ?, divanPriceSen = ?, legPriceSen = ?,
                 specialOrderPriceSen = ?, totalHeightPriceSen = ?, unitPriceSen = ?, discountSen = ?,
                 totalSen = ?, priceEdited = 1
               WHERE id = ?`,
            ).bind(
              ed.base,
              ed.divan,
              ed.leg,
              ed.special,
              ed.totalHeight,
              unit,
              ed.discount,
              lineTotal,
              r.id,
            ),
          );
        } else {
          // Untouched line: re-use stored discount when computing subtotal.
          const existingDiscount = Number(r.discountSen) || 0;
          const existingUnit = Number(r.unitPriceSen) || 0;
          newSubtotal += Math.max(0, existingUnit * q - existingDiscount);
        }
      }
      if (touched > 0) {
        // Phase 2 — an item edit re-derives the subtotal, so it re-derives
        // tax too (same rule as creation); totalSen stays GROSS. The
        // customer's outstanding moves by the gross delta in the same
        // batch (the old code never adjusted it on a price edit).
        const editRatePct = await readGstRatePct(c.var.DB);
        const newTaxSen = Math.max(
          0,
          Math.round((newSubtotal * editRatePct) / 100),
        );
        const newGrossSen = newSubtotal + newTaxSen;
        statements.push(
          c.var.DB.prepare(
            "UPDATE invoices SET subtotalSen = ?, taxSen = ?, totalSen = ? WHERE id = ?",
          ).bind(newSubtotal, newTaxSen, newGrossSen, id),
        );
        const grossDelta =
          newGrossSen - (Number(existing.totalSen) || 0);
        const custIdForOutstanding =
          (existing as unknown as { customerId?: string }).customerId ?? "";
        if (grossDelta !== 0 && custIdForOutstanding) {
          statements.push(
            c.var.DB.prepare(
              `UPDATE customers SET outstandingSen = GREATEST(0, outstandingSen + ?) WHERE id = ?`,
            ).bind(grossDelta, custIdForOutstanding),
          );
        }

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
                // Reverse EXACTLY what was posted (stored tax).
                existing.taxSen ?? 0,
              );
              const { legs: postLegs } =
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
                  // Re-post with the freshly-derived tax persisted above.
                  newTaxSen,
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
              // Collapse the restate in the GL: hide the original invoice legs,
              // the reversal just posted, and any prior restate legs — leave ONLY
              // this newest restate_post visible (the current amount). The net is
              // unchanged and the full history stays in the audit log. Runs after
              // the rev/post INSERTs in the batch.
              statements.push(
                c.var.DB.prepare(
                  "UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'invoice%' AND sourceType <> ?",
                ).bind(id, orgId, `invoice_restate_post:${stamp}`),
              );
              const auditStmt = await buildAuditStatement(c, {
                resource: "invoices",
                resourceId: id,
                action: "update",
                before: existing,
                after: {
                  ...existing,
                  subtotalSen: newSubtotal,
                  totalSen: newGrossSen,
                  taxSen: newTaxSen,
                  updatedAt: now,
                },
              });
              if (auditStmt) statements.push(auditStmt);
            }
          } catch (e) {
            // Phase 1 (2026-06) — abort instead of silently saving a price
            // edit whose GL restatement failed to build (ledger would keep
            // the OLD amounts while the invoice shows the new ones).
            console.error(
              `[ledger] failed to BUILD restatement for invoice ${id} price edit — aborting:`,
              e,
            );
            return c.json(
              {
                success: false,
                error:
                  "Failed to build the GL restatement for this price edit — nothing was saved. Retry, and report if it persists.",
              },
              500,
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
          // Phase 2 — post the STORED tax (decided at creation), never a
          // recompute: a rate change between create and post must not
          // split the GL from the row's gross totalSen.
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
            false,
            existing.taxSen ?? 0,
          );
          const { statements: ledgerStmts } =
            await buildJournalEntryStatements(c.var.DB, orgId, legs);
          statements.push(...ledgerStmts);
        }
      } catch (e) {
        // Phase 1 (2026-06) — abort: an invoice must never flip to SENT
        // without its DR debtor / CR sales / CR tax legs in the ledger.
        console.error(
          `[ledger] failed to BUILD statements for invoice ${id} post — aborting:`,
          e,
        );
        return c.json(
          {
            success: false,
            error:
              "Failed to build the GL posting for this invoice — the status change was NOT saved. Retry, and report if it persists.",
          },
          500,
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
        // BUG-2026-07-23-002 — mirror-reverse whatever the invoice's doc
        // family VISIBLY nets, per account, org-agnostic. The old
        // posted/reversed gate + recompute skipped the reversal whenever
        // the legs sat under a different orgId than the fallback (five
        // Carress cancels left +31,677.52 live on 300-0000), and a
        // recompute could drift from edited invoices' actual legs.
        const { statements: revStmts } = await buildCancelReversalStatements(
          c.var.DB,
          id,
          actorUserId,
          orgId,
        );
        statements.push(...revStmts);
      } catch (e) {
        // Phase 1 (2026-06) — abort: a void must reverse the original
        // posting or the ledger keeps revenue/AR for a cancelled invoice.
        console.error(
          `[ledger] failed to BUILD reversal for invoice ${id} void — aborting:`,
          e,
        );
        return c.json(
          {
            success: false,
            error:
              "Failed to build the GL reversal for this void — the status change was NOT saved. Retry, and report if it persists.",
          },
          500,
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
      // GREATEST(0, ...) clamps in case the original create path didn't bump
      // outstandingSen for this invoice (the manual POST /api/invoices
      // path doesn't, only the auto-create-from-DO path does). Matches
      // the guard pattern used in credit-notes.ts:256 and payments.ts:389.
      const unpaidSen = existing.totalSen - existing.paidAmount;
      if (unpaidSen > 0 && existing.customerId) {
        statements.push(
          c.var.DB.prepare(
            `UPDATE customers SET outstandingSen = GREATEST(0, outstandingSen - ?) WHERE id = ?`,
          ).bind(unpaidSen, existing.customerId),
        );
      }

      // Release the source (2026-08-07). The void above reverses the GL and
      // the customer's A/R, but until now it wrote NOTHING back to
      // delivery_orders — so the DO stayed at INVOICED forever and the
      // delivered goods could never be billed again. Step the DO (and any SO
      // this invoice family bumped) back to DELIVERED, but ONLY when no other
      // live invoice still bills them. Same batch as the void, so the release
      // and the reversal land or roll back together.
      {
        const { buildInvoiceDeathReleaseStatements } = await import(
          "./delivery-orders"
        );
        statements.push(
          ...(await buildInvoiceDeathReleaseStatements(c.var.DB, {
            invoiceId: id,
            deliveryOrderId: existing.deliveryOrderId,
            salesOrderId: existing.salesOrderId,
            now,
            reason: "void",
          })),
        );
      }

      // Hide the cancelled invoice's GL legs (original + reversal) so the void
      // doesn't show in the GL — the same effect applyLifecycle gives the
      // lifecycle-managed doc types. Pushed AFTER the reversal INSERTs, so the
      // batch sets hidden=1 on both the original `invoice` and `invoice_void` legs.
      statements.push(
        c.var.DB.prepare(
          "UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceType IN ('invoice','invoice_void') AND sourceId = ? AND orgId = ?",
        ).bind(id, getOrgId(c)),
      );
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
  // GREATEST(0, ...) guard below handles both paths safely.)
  // deliveryOrderId / salesOrderId (2026-08-07) — deleting the invoice must
  // also hand its source DO back for re-invoicing, so we need to know what it
  // was billing. See buildInvoiceDeathReleaseStatements below.
  const existing = await c.var.DB.prepare(
    "SELECT id, status, customerId, totalSen, paidAmount, deliveryOrderId, salesOrderId FROM invoices WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      status: string;
      customerId: string;
      totalSen: number;
      paidAmount: number;
      deliveryOrderId: string | null;
      salesOrderId: string | null;
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
        `UPDATE customers SET outstandingSen = GREATEST(0, outstandingSen - ?) WHERE id = ?`,
      ).bind(unpaidSen, existing.customerId),
    );
  }
  // Release the source, exactly as the void path does. A DRAFT invoice can
  // only exist because the auto-on-delivery cascade created it — and that
  // cascade flipped the DO to INVOICED. Deleting the invoice without stepping
  // the DO back left the delivery permanently unbillable.
  {
    const { buildInvoiceDeathReleaseStatements } = await import(
      "./delivery-orders"
    );
    stmts.push(
      ...(await buildInvoiceDeathReleaseStatements(c.var.DB, {
        invoiceId: id,
        deliveryOrderId: existing.deliveryOrderId,
        salesOrderId: existing.salesOrderId,
        now: new Date().toISOString(),
        reason: "delete",
      })),
    );
  }
  await c.var.DB.batch(stmts);

  // Deleting an invoice also reverses the customer's outstanding balance, so
  // without this the money moved with no record of who moved it or what the
  // document said. The row is gone — this event is the only surviving copy.
  await emitAudit(c, {
    resource: "invoices",
    resourceId: id,
    action: "delete",
    before: existing,
  });
  return c.json({ success: true });
});

export default app;
