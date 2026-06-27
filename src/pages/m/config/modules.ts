// ===========================================================================
// Module configs — the single source of truth for every L1 mobile list.
//
// Each ModuleConfig wires an existing desktop endpoint (NO new backend) into
// the generic <ModuleListScreen>. Column labels use the spec's exact
// terminology (Company SO / Customer PO / Amount / Expected DD / Outstanding /
// State / Reference / Order Date / Qty / Items …). Statuses resolve through the
// shared design-tokens maps; unknown → NEUTRAL.
//
// Sub-tabs are mostly client-side predicates over ONE fetched list; modules
// whose sub-tabs are different entities (Delivery, Invoices, Procurement,
// Inventory, Employees, Mail) declare multiple DataSources.
//
// L2 detail routes resolve to /m/<slug>/:id — Phase 3 supplies the detail
// screen; today they land on a ComingSoon detail (see MobileLayout).
// ===========================================================================
import {
  type ModuleConfig,
  type DataSource,
  type RawRow,
  type RowVM,
} from "./types";
import {
  type DetailConfig,
  type FlowStep,
  type RelatedDocVM,
} from "./types";
import {
  read,
  str,
  num,
  dateOnly,
  money,
  resolveStatus,
  STATUS_MAPS,
  PAYMENT_STATUS_MAP,
  selectData,
  selectNested,
  selectDocData,
  selectFromListById,
} from "./helpers";

// ---------------------------------------------------------------------------
// Detail helpers — terse field-grid + line-item + flow builders shared across
// every doc-type's DetailConfig. Status-flow steps are derived from the same
// repo status enums the lists use (above), in lifecycle order.
// ---------------------------------------------------------------------------
type FieldDef = DetailConfig["fields"][number];
type LineItemVM = NonNullable<DetailConfig["lineItems"]> extends (
  d: RawRow,
) => infer R
  ? R extends Array<infer I>
    ? I
    : never
  : never;

const fld = (
  label: string,
  value: (d: RawRow) => string,
  full = false,
): FieldDef => ({ label, value, full });

/** Build flow steps from an UPPER_SNAKE enum list (Title Case labels). */
function flowSteps(keys: string[]): FlowStep[] {
  return keys.map((k) => ({
    key: k,
    label: k
      .split(/[_\s]+/)
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(" "),
  }));
}

/** A doc's line item read dual-keyed for product / qty / price across types. */
function itemVM(it: RawRow, i: number): LineItemVM {
  const qty = num(it, "quantity", "qty", "receivedQty", "orderedQty");
  const unit = num(it, "unitPriceSen", "priceSen", "unitCostSen");
  const line = num(it, "lineTotalSen", "amountSen", "totalSen") || unit * qty;
  return {
    id: str(it, "id", "lineNo") || String(i),
    title:
      str(it, "productName", "description", "itemDescription", "productCode") ||
      "—",
    subLine:
      str(it, "productCode", "itemCode", "sku") || undefined,
    meta1: { label: "Qty", value: qty },
    meta2: { label: "Amount", value: money(line) },
  };
}

/** Map a raw line-items array (under any of the given keys) → LineItemVM[]. */
function itemsOf(doc: RawRow, ...keys: string[]): LineItemVM[] {
  for (const k of keys) {
    const arr = doc[k];
    if (Array.isArray(arr)) return (arr as RawRow[]).map(itemVM);
  }
  return [];
}

/** Coerce an unknown envelope field into a RawRow[] (related-doc lists). */
function asArr(v: unknown): RawRow[] {
  return Array.isArray(v) ? (v as RawRow[]) : [];
}

// Tiny helpers for terse column declarations.
const textCol = (key: string, label: string, get: (r: RawRow) => string) => ({
  key,
  label,
  type: "text" as const,
  value: get,
});
const numCol = (key: string, label: string, get: (r: RawRow) => number) => ({
  key,
  label,
  type: "number" as const,
  value: get,
});
const dateCol = (key: string, label: string, get: (r: RawRow) => string) => ({
  key,
  label,
  type: "date" as const,
  value: get,
});
const enumCol = (
  key: string,
  label: string,
  get: (r: RawRow) => string,
  options: string[],
) => ({ key, label, type: "enum" as const, value: get, options });

// Status enum option lists (the repo's canonical values).
const SO_STATUSES = [
  "DRAFT", "CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "SHIPPED",
  "DELIVERED", "INVOICED", "CLOSED", "ON_HOLD", "CANCELLED",
];
const DO_STATUSES = [
  "DRAFT", "LOADED", "DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED",
  "INVOICED", "CANCELLED",
];
const PROD_STATUSES = [
  "PENDING", "IN_PROGRESS", "COMPLETED", "ON_HOLD", "PAUSED", "CANCELLED",
];

// ---------------------------------------------------------------------------
// SALES ORDERS — one source; sub-tabs filter by status.
// Spec sub-tabs: All / Draft / Confirmed / In Production / Ready / Delivered.
// ---------------------------------------------------------------------------
const salesSource: DataSource = {
  url: "/api/sales-orders",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "companySOId", "companySO"),
    code: str(r, "companySO", "companySOId") || "—",
    title: str(r, "customerName") || "—",
    subLine:
      [str(r, "customerPO", "customerPOId"), str(r, "customerState")]
        .filter(Boolean)
        .join(" · ") || undefined,
    meta1: { label: "Expected DD", value: dateOnly(r, "hookkaExpectedDD") || "—" },
    meta2: { label: "Amount", value: money(num(r, "totalSen")) },
    status: resolveStatus(str(r, "status"), STATUS_MAPS.so),
  }),
  columns: [
    textCol("companySO", "Company SO", (r) => str(r, "companySO", "companySOId")),
    textCol("customerSO", "Customer SO", (r) => str(r, "customerSO", "customerSOId")),
    textCol("customerPO", "Customer PO", (r) => str(r, "customerPO", "customerPOId")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    textCol("state", "State", (r) => str(r, "customerState")),
    textCol("reference", "Reference", (r) => str(r, "reference")),
    dateCol("orderDate", "Order Date", (r) => dateOnly(r, "companySODate")),
    dateCol("expectedDD", "Expected DD", (r) => dateOnly(r, "hookkaExpectedDD")),
    numCol("qty", "Qty", (r) => (Array.isArray(r.items) ? (r.items as unknown[]).reduce((s: number, it) => s + num(it as RawRow, "quantity"), 0) : 0)),
    numCol("items", "Items", (r) => (Array.isArray(r.items) ? (r.items as unknown[]).length : 0)),
    numCol("amount", "Amount", (r) => num(r, "totalSen")),
    enumCol("status", "Status", (r) => str(r, "status"), SO_STATUSES),
  ],
  defaultSort: { key: "expectedDD", dir: "asc" },
  subTabs: [
    { key: "all", label: "All", match: () => true },
    { key: "draft", label: "Draft", match: (r) => str(r, "status") === "DRAFT" },
    { key: "confirmed", label: "Confirmed", match: (r) => str(r, "status") === "CONFIRMED" },
    { key: "in_production", label: "In Production", match: (r) => str(r, "status") === "IN_PRODUCTION" },
    { key: "ready", label: "Ready", match: (r) => str(r, "status") === "READY_TO_SHIP" },
    { key: "delivered", label: "Delivered", match: (r) => str(r, "status") === "DELIVERED" },
  ],
};

// SO detail — single-GET /api/sales-orders/:id returns
// { data: SO(+items), linkedDOs, linkedInvoices, linkedPayments, ... }.
const salesDetail: DetailConfig = {
  url: (id) => `/api/sales-orders/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "companySO", "companySOId") || "—",
  title: (d) => str(d, "customerName") || "—",
  status: (d) => resolveStatus(str(d, "status"), STATUS_MAPS.so),
  flow: {
    // 5-step happy path through the SO lifecycle (the spec's flow indicator).
    steps: flowSteps([
      "CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "DELIVERED", "INVOICED",
    ]),
    current: (d) => str(d, "status"),
  },
  fields: [
    fld("Customer SO", (d) => str(d, "customerSO", "customerSOId")),
    fld("Customer PO", (d) => str(d, "customerPO", "customerPOId")),
    fld("Customer", (d) => str(d, "customerName")),
    fld("State", (d) => str(d, "customerState")),
    fld("Order Date", (d) => dateOnly(d, "companySODate")),
    fld("Expected DD", (d) => dateOnly(d, "hookkaExpectedDD")),
    fld("Customer Delivery", (d) => dateOnly(d, "customerDeliveryDate")),
    fld("Reference", (d) => str(d, "reference")),
    fld("Amount", (d) => money(num(d, "totalSen"))),
  ],
  lineItems: (d) => itemsOf(d, "items"),
  relatedDocs: (_d, resp) => {
    const r = (resp ?? {}) as Record<string, unknown>;
    const out: RelatedDocVM[] = [];
    for (const dd of asArr(r.linkedDOs)) {
      out.push({
        id: str(dd, "id"),
        group: "Delivery Orders",
        code: str(dd, "doNo") || "—",
        subLine: dateOnly(dd, "scheduledDate") || undefined,
        status: resolveStatus(str(dd, "status"), STATUS_MAPS.delivery),
        href: `/m/delivery/${encodeURIComponent(str(dd, "id"))}`,
      });
    }
    for (const iv of asArr(r.linkedInvoices)) {
      out.push({
        id: str(iv, "id"),
        group: "Invoices",
        code: str(iv, "invoiceNo") || "—",
        subLine: money(num(iv, "totalSen")),
        status: resolveStatus(str(iv, "status"), PAYMENT_STATUS_MAP),
        href: `/m/invoices/${encodeURIComponent(str(iv, "id"))}`,
      });
    }
    for (const py of asArr(r.linkedPayments)) {
      out.push({
        id: str(py, "id"),
        group: "Payments",
        code: str(py, "receiptNumber") || "—",
        subLine: money(num(py, "amount")),
        // Payments list has no per-id detail screen yet. // TODO: link when
        // a payment detail route exists.
        href: undefined,
      });
    }
    return out;
  },
  primaryCta: (d) =>
    str(d, "status") === "DRAFT" ? "Confirm" : "Status",
};

export const salesConfig: ModuleConfig = {
  slug: "sales",
  title: "Sales Orders",
  detailPath: (vm) => `/m/sales/${encodeURIComponent(vm.id)}`,
  detail: salesDetail,
  sources: [salesSource],
};

// ---------------------------------------------------------------------------
// DELIVERY — two sources: Delivery Orders (/api/delivery-orders) + 3PL
// Providers (/api/drivers → ThreePLProvider[]).
// ---------------------------------------------------------------------------
const deliveryOrdersSource: DataSource = {
  url: "/api/delivery-orders",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "doNo"),
    code: str(r, "doNo") || "—",
    title: str(r, "customerName") || "—",
    subLine:
      [str(r, "companySO", "companySOId"), str(r, "customerState")]
        .filter(Boolean)
        .join(" · ") || undefined,
    meta1: { label: "Expected DD", value: dateOnly(r, "deliveryDate", "hookkaExpectedDD") || "—" },
    meta2: { label: "Amount", value: money(num(r, "valueSen")) },
    status: resolveStatus(str(r, "status"), STATUS_MAPS.delivery),
  }),
  columns: [
    textCol("doNo", "Customer Delivery", (r) => str(r, "doNo")),
    textCol("companySO", "Company SO", (r) => str(r, "companySO", "companySOId")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    textCol("state", "State", (r) => str(r, "customerState")),
    dateCol("deliveryDate", "Expected DD", (r) => dateOnly(r, "deliveryDate", "hookkaExpectedDD")),
    numCol("items", "Items", (r) => num(r, "totalItems")),
    numCol("amount", "Amount", (r) => num(r, "valueSen")),
    enumCol("status", "Status", (r) => str(r, "status"), DO_STATUSES),
  ],
  defaultSort: { key: "deliveryDate", dir: "desc" },
  subTabs: [{ key: "do", label: "Delivery Orders", match: () => true }],
};

const threePlSource: DataSource = {
  url: "/api/drivers",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id"),
    code: str(r, "vehicleNo") || str(r, "id"),
    title: str(r, "name") || "—",
    subLine:
      [str(r, "contactPerson"), str(r, "phone")].filter(Boolean).join(" · ") ||
      undefined,
    meta1: { label: "Vehicle", value: str(r, "vehicleType") || "—" },
    meta2: { label: "Capacity", value: `${num(r, "capacityM3")} m³` },
    status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
  }),
  columns: [
    textCol("name", "Provider", (r) => str(r, "name")),
    textCol("contact", "Contact", (r) => str(r, "contactPerson")),
    textCol("vehicle", "Vehicle", (r) => str(r, "vehicleNo")),
    numCol("capacity", "Capacity", (r) => num(r, "capacityM3")),
    enumCol("status", "Status", (r) => str(r, "status"), ["ACTIVE", "INACTIVE", "ON_LEAVE"]),
  ],
  defaultSort: { key: "name", dir: "asc" },
  subTabs: [{ key: "providers", label: "3PL Providers", match: () => true }],
};

// DO detail — single-GET /api/delivery-orders/:id returns { data: DO(+items) }.
// The DO carries its SO link (salesOrderId / companySO) so we cross-link back to
// the Sales Order. // TODO: the DO payload doesn't embed its invoice id — leave
// that related link out until the endpoint exposes it.
const deliveryDetail: DetailConfig = {
  url: (id) => `/api/delivery-orders/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "doNo") || "—",
  title: (d) => str(d, "customerName") || "—",
  status: (d) => resolveStatus(str(d, "status"), STATUS_MAPS.delivery),
  flow: {
    steps: flowSteps(["LOADED", "DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED"]),
    current: (d) => str(d, "status"),
  },
  fields: [
    fld("Company SO", (d) => str(d, "companySO", "companySOId")),
    fld("Customer", (d) => str(d, "customerName")),
    fld("State", (d) => str(d, "hubState", "customerState")),
    fld("Expected DD", (d) => dateOnly(d, "deliveryDate", "hookkaExpectedDD")),
    fld("Driver", (d) => str(d, "driverName")),
    fld("Vehicle", (d) => str(d, "vehicleNo", "vehicleType")),
    fld("Items", (d) => String(num(d, "totalItems"))),
    fld("Reference", (d) => str(d, "reference")),
    fld("Delivery Address", (d) => str(d, "deliveryAddress"), true),
  ],
  lineItems: (d) => itemsOf(d, "items"),
  relatedDocs: (d) => {
    const out: RelatedDocVM[] = [];
    const soId = str(d, "salesOrderId");
    const soNo = str(d, "companySO", "companySOId");
    if (soId || soNo) {
      out.push({
        id: soId || soNo,
        group: "Sales Order",
        code: soNo || "—",
        // SO GET resolves a companySOId too, so the No is a safe route param.
        href: `/m/sales/${encodeURIComponent(soId || soNo)}`,
      });
    }
    return out;
  },
  primaryCta: (d) => (str(d, "status") === "DELIVERED" ? "Sign" : "Dispatch"),
};

export const deliveryConfig: ModuleConfig = {
  slug: "delivery",
  title: "Delivery",
  // 3PL provider rows (no doNo) have no document detail.
  detailPath: (vm, row) =>
    str(row, "doNo") ? `/m/delivery/${encodeURIComponent(vm.id)}` : null,
  detail: deliveryDetail,
  sources: [deliveryOrdersSource, threePlSource],
};

// ---------------------------------------------------------------------------
// INVOICES — six sources.
// Invoices / Payments / Supplier Pay / Credit Notes / Debit Notes / e-Invoice.
// ---------------------------------------------------------------------------
const invoicesSource: DataSource = {
  url: "/api/invoices",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "invoiceNo"),
    code: str(r, "invoiceNo") || "—",
    title: str(r, "customerName") || "—",
    subLine: str(r, "doNo", "companySOId") || undefined,
    meta1: { label: "Outstanding", value: money(num(r, "totalSen") - num(r, "paidAmount")) },
    meta2: { label: "Amount", value: money(num(r, "totalSen")) },
    status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
  }),
  columns: [
    textCol("invoiceNo", "Reference", (r) => str(r, "invoiceNo")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    dateCol("invoiceDate", "Order Date", (r) => dateOnly(r, "invoiceDate")),
    dateCol("dueDate", "Expected DD", (r) => dateOnly(r, "dueDate")),
    numCol("amount", "Amount", (r) => num(r, "totalSen")),
    numCol("outstanding", "Outstanding", (r) => num(r, "totalSen") - num(r, "paidAmount")),
    enumCol("status", "Status", (r) => str(r, "status"), ["PAID", "PARTIAL", "UNPAID", "OVERDUE"]),
  ],
  defaultSort: { key: "invoiceDate", dir: "desc" },
  subTabs: [{ key: "invoices", label: "Invoices", match: () => true }],
};

const paymentsSource: DataSource = {
  url: "/api/payments",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "paymentNo"),
    code: str(r, "paymentNo", "reference") || str(r, "id"),
    title: str(r, "customerName") || "—",
    subLine: str(r, "method", "paymentMethod") || undefined,
    meta1: { label: "Order Date", value: dateOnly(r, "date", "paymentDate") || "—" },
    meta2: { label: "Amount", value: money(num(r, "totalSen", "amountSen")) },
  }),
  columns: [
    textCol("paymentNo", "Reference", (r) => str(r, "paymentNo")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    dateCol("date", "Order Date", (r) => dateOnly(r, "date", "paymentDate")),
    numCol("amount", "Amount", (r) => num(r, "totalSen", "amountSen")),
  ],
  defaultSort: { key: "date", dir: "desc" },
  subTabs: [{ key: "payments", label: "Payments", match: () => true }],
};

const supplierPaySource: DataSource = {
  url: "/api/supplier-payments",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "paymentNo"),
    code: str(r, "paymentNo") || str(r, "id"),
    title: str(r, "supplierName") || "—",
    subLine: undefined,
    meta1: { label: "Order Date", value: dateOnly(r, "date", "paymentDate") || "—" },
    meta2: { label: "Amount", value: money(num(r, "totalBankSen", "totalSen", "amountSen")) },
  }),
  columns: [
    textCol("paymentNo", "Reference", (r) => str(r, "paymentNo")),
    textCol("supplier", "Customer", (r) => str(r, "supplierName")),
    dateCol("date", "Order Date", (r) => dateOnly(r, "date", "paymentDate")),
    numCol("amount", "Amount", (r) => num(r, "totalBankSen", "totalSen", "amountSen")),
  ],
  defaultSort: { key: "date", dir: "desc" },
  subTabs: [{ key: "supplier_pay", label: "Supplier Pay", match: () => true }],
};

const creditNotesSource: DataSource = {
  url: "/api/credit-notes",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "cnNo"),
    code: str(r, "cnNo", "creditNoteNo") || str(r, "id"),
    title: str(r, "customerName") || str(r, "reason") || "—",
    subLine: str(r, "reason") || undefined,
    meta1: { label: "Order Date", value: dateOnly(r, "date", "createdAt") || "—" },
    meta2: { label: "Amount", value: money(num(r, "totalSen")) },
  }),
  columns: [
    textCol("cnNo", "Reference", (r) => str(r, "cnNo", "creditNoteNo")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    numCol("amount", "Amount", (r) => num(r, "totalSen")),
    dateCol("date", "Order Date", (r) => dateOnly(r, "date", "createdAt")),
  ],
  defaultSort: { key: "date", dir: "desc" },
  subTabs: [{ key: "credit_notes", label: "Credit Notes", match: () => true }],
};

const debitNotesSource: DataSource = {
  url: "/api/debit-notes",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "dnNo"),
    code: str(r, "dnNo", "debitNoteNo") || str(r, "id"),
    title: str(r, "customerName") || str(r, "reason") || "—",
    subLine: str(r, "reason") || undefined,
    meta1: { label: "Order Date", value: dateOnly(r, "date", "createdAt") || "—" },
    meta2: { label: "Amount", value: money(num(r, "totalSen")) },
  }),
  columns: [
    textCol("dnNo", "Reference", (r) => str(r, "dnNo", "debitNoteNo")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    numCol("amount", "Amount", (r) => num(r, "totalSen")),
    dateCol("date", "Order Date", (r) => dateOnly(r, "date", "createdAt")),
  ],
  defaultSort: { key: "date", dir: "desc" },
  subTabs: [{ key: "debit_notes", label: "Debit Notes", match: () => true }],
};

const eInvoiceSource: DataSource = {
  url: "/api/e-invoices",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "invoiceNo"),
    code: str(r, "invoiceNo") || str(r, "id"),
    title: str(r, "customerName") || "—",
    subLine: undefined,
    meta1: { label: "Amount", value: money(num(r, "totalSen")) },
    status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
  }),
  columns: [
    textCol("invoiceNo", "Reference", (r) => str(r, "invoiceNo")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    numCol("amount", "Amount", (r) => num(r, "totalSen")),
    enumCol("status", "Status", (r) => str(r, "status"), ["VALIDATED", "SUBMITTED", "PENDING"]),
  ],
  defaultSort: { key: "invoiceNo", dir: "desc" },
  subTabs: [{ key: "e_invoice", label: "e-Invoice", match: () => true }],
};

// Invoice detail — single-GET /api/invoices/:id returns
// { data: invoice(+items,+payments), lockReason }. Only the main Invoices
// sub-tab has a per-id endpoint; Payments / Supplier Pay / Credit Notes /
// Debit Notes / e-Invoice have no single-GET, so their rows stay non-tappable.
const invoiceDetail: DetailConfig = {
  url: (id) => `/api/invoices/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "invoiceNo") || "—",
  title: (d) => str(d, "customerName") || "—",
  status: (d) => resolveStatus(str(d, "status"), PAYMENT_STATUS_MAP),
  flow: {
    steps: flowSteps(["UNPAID", "PARTIAL", "PAID"]),
    current: (d) => str(d, "status"),
  },
  fields: [
    fld("Customer", (d) => str(d, "customerName")),
    fld("Customer Delivery", (d) => str(d, "doNo")),
    fld("Company SO", (d) => str(d, "companySOId")),
    fld("Order Date", (d) => dateOnly(d, "invoiceDate")),
    fld("Expected DD", (d) => dateOnly(d, "dueDate")),
    fld("Amount", (d) => money(num(d, "totalSen"))),
    fld("Outstanding", (d) => money(num(d, "totalSen") - num(d, "paidAmount"))),
    fld("Customer PO", (d) => str(d, "customerPOId")),
  ],
  lineItems: (d) => itemsOf(d, "items"),
  relatedDocs: (d) => {
    const out: RelatedDocVM[] = [];
    const soId = str(d, "salesOrderId");
    const soNo = str(d, "companySOId");
    if (soId || soNo) {
      out.push({
        id: soId || soNo,
        group: "Sales Order",
        code: soNo || "—",
        href: `/m/sales/${encodeURIComponent(soId || soNo)}`,
      });
    }
    const doId = str(d, "deliveryOrderId");
    if (doId || str(d, "doNo")) {
      out.push({
        id: doId || str(d, "doNo"),
        group: "Delivery Order",
        code: str(d, "doNo") || "—",
        href: doId ? `/m/delivery/${encodeURIComponent(doId)}` : undefined,
      });
    }
    return out;
  },
  primaryCta: (d) => (str(d, "status") === "PAID" ? "Status" : "Record Payment"),
};

export const invoicesConfig: ModuleConfig = {
  slug: "invoices",
  title: "Invoices",
  // Only main-invoice rows (id "inv-…") open the invoice detail; the other
  // sub-tabs (payments / notes / e-invoice) have no single-GET endpoint.
  detailPath: (vm) =>
    vm.id.startsWith("inv-")
      ? `/m/invoices/${encodeURIComponent(vm.id)}`
      : null,
  detail: invoiceDetail,
  sources: [
    invoicesSource,
    paymentsSource,
    supplierPaySource,
    creditNotesSource,
    debitNotesSource,
    eInvoiceSource,
  ],
};

// ---------------------------------------------------------------------------
// PROCUREMENT — Purchase Orders / Goods Receipt / Purchase Invoice / Maintenance.
// Maintenance has no list endpoint → reuse suppliers (the page is supplier mgmt).
// ---------------------------------------------------------------------------
const poSource: DataSource = {
  url: "/api/purchase-orders",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "poNo"),
    code: str(r, "poNo") || "—",
    title: str(r, "supplierName") || "—",
    subLine: undefined,
    meta1: { label: "Expected DD", value: dateOnly(r, "expectedDate") || "—" },
    meta2: { label: "Amount", value: money(num(r, "totalSen")) },
    status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
  }),
  columns: [
    textCol("poNo", "Reference", (r) => str(r, "poNo")),
    textCol("supplier", "Customer", (r) => str(r, "supplierName")),
    dateCol("orderDate", "Order Date", (r) => dateOnly(r, "orderDate")),
    dateCol("expectedDate", "Expected DD", (r) => dateOnly(r, "expectedDate")),
    numCol("items", "Items", (r) => (Array.isArray(r.items) ? (r.items as unknown[]).length : 0)),
    numCol("amount", "Amount", (r) => num(r, "totalSen")),
    enumCol("status", "Status", (r) => str(r, "status"), ["DRAFT", "AWAITING", "PARTIAL", "RECEIVED", "MATCHED", "CANCELLED"]),
  ],
  defaultSort: { key: "orderDate", dir: "desc" },
  subTabs: [{ key: "po", label: "Purchase Orders", match: () => true }],
};

const grnSource: DataSource = {
  url: "/api/grn",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "grnNo"),
    code: str(r, "grnNo") || "—",
    title: str(r, "supplierName") || "—",
    subLine: str(r, "poRef", "poNo") || undefined,
    meta1: { label: "Order Date", value: dateOnly(r, "receivedDate", "createdAt") || "—" },
    status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
  }),
  columns: [
    textCol("grnNo", "Reference", (r) => str(r, "grnNo")),
    textCol("poRef", "Customer PO", (r) => str(r, "poRef", "poNo")),
    textCol("supplier", "Customer", (r) => str(r, "supplierName")),
    dateCol("receivedDate", "Order Date", (r) => dateOnly(r, "receivedDate", "createdAt")),
    enumCol("status", "Status", (r) => str(r, "status"), ["DRAFT", "PARTIAL", "RECEIVED", "MATCHED", "MISMATCH"]),
  ],
  defaultSort: { key: "receivedDate", dir: "desc" },
  subTabs: [{ key: "grn", label: "Goods Receipt", match: () => true }],
};

const piSource: DataSource = {
  url: "/api/purchase-invoices",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "piNo"),
    code: str(r, "piNo") || "—",
    title: str(r, "supplier", "supplierName") || "—",
    subLine: str(r, "poRef", "poNo") || undefined,
    meta1: { label: "Expected DD", value: dateOnly(r, "dueDate") || "—" },
    meta2: { label: "Amount", value: money(num(r, "amountSen", "totalSen")) },
    status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
  }),
  columns: [
    textCol("piNo", "Reference", (r) => str(r, "piNo")),
    textCol("poRef", "Customer PO", (r) => str(r, "poRef", "poNo")),
    textCol("supplier", "Customer", (r) => str(r, "supplier", "supplierName")),
    dateCol("invoiceDate", "Order Date", (r) => dateOnly(r, "invoiceDate")),
    dateCol("dueDate", "Expected DD", (r) => dateOnly(r, "dueDate")),
    numCol("amount", "Amount", (r) => num(r, "amountSen", "totalSen")),
    enumCol("status", "Status", (r) => str(r, "status"), ["DRAFT", "PARTIAL", "PAID", "UNPAID", "OVERDUE"]),
  ],
  defaultSort: { key: "invoiceDate", dir: "desc" },
  subTabs: [{ key: "pi", label: "Purchase Invoice", match: () => true }],
};

// Maintenance sub-tab: no dedicated list endpoint — the desktop Maintenance
// page is supplier management. Reuse /api/suppliers as the closest existing
// list. TODO: if a real "maintenance" list endpoint lands, swap it here.
const maintenanceSource: DataSource = {
  url: "/api/suppliers",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "code"),
    code: str(r, "code") || "—",
    title: str(r, "name") || "—",
    subLine: [str(r, "contactPerson"), str(r, "phone")].filter(Boolean).join(" · ") || undefined,
    meta1: { label: "State", value: str(r, "state") || "—" },
    status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
  }),
  columns: [
    textCol("code", "Reference", (r) => str(r, "code")),
    textCol("name", "Customer", (r) => str(r, "name")),
    textCol("state", "State", (r) => str(r, "state")),
    enumCol("status", "Status", (r) => str(r, "status"), ["ACTIVE", "INACTIVE"]),
  ],
  defaultSort: { key: "name", dir: "asc" },
  subTabs: [{ key: "maintenance", label: "Maintenance", match: () => true }],
};

// PROCUREMENT detail — three distinct doc types share one slug, dispatched by
// the id prefix (PO = "po-", GRN = "grn-", PI = "pi-"). Each has its own
// single-GET endpoint; suppliers (Maintenance) have no doc detail.
const poDetail: DetailConfig = {
  url: (id) => `/api/purchase-orders/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "poNo") || "—",
  title: (d) => str(d, "supplierName") || "—",
  status: (d) => resolveStatus(str(d, "status"), PAYMENT_STATUS_MAP),
  flow: {
    steps: flowSteps(["DRAFT", "AWAITING", "PARTIAL", "RECEIVED", "MATCHED"]),
    current: (d) => str(d, "status"),
  },
  fields: [
    fld("Supplier", (d) => str(d, "supplierName")),
    fld("Order Date", (d) => dateOnly(d, "orderDate")),
    fld("Expected DD", (d) => dateOnly(d, "expectedDate")),
    fld("Amount", (d) => money(num(d, "totalSen"))),
    fld("Notes", (d) => str(d, "notes"), true),
  ],
  lineItems: (d) => itemsOf(d, "items"),
  primaryCta: (d) => (str(d, "status") === "DRAFT" ? "Submit" : "Status"),
};

const grnDetail: DetailConfig = {
  url: (id) => `/api/grn/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "grnNumber", "grnNo") || "—",
  title: (d) => str(d, "supplierName") || "—",
  status: (d) => resolveStatus(str(d, "status"), PAYMENT_STATUS_MAP),
  flow: {
    steps: flowSteps(["DRAFT", "CONFIRMED", "POSTED"]),
    current: (d) => str(d, "status"),
  },
  fields: [
    fld("Customer PO", (d) => str(d, "poNumber", "poRef", "poNo")),
    fld("Supplier", (d) => str(d, "supplierName")),
    fld("Order Date", (d) => dateOnly(d, "receiveDate", "receivedDate")),
    fld("Received By", (d) => str(d, "receivedBy")),
    fld("QC Status", (d) => str(d, "qcStatus")),
    fld("Notes", (d) => str(d, "notes"), true),
  ],
  lineItems: (d) => itemsOf(d, "items"),
  relatedDocs: (d) => {
    const out: RelatedDocVM[] = [];
    const poId = str(d, "poId");
    if (poId || str(d, "poNumber")) {
      out.push({
        id: poId || str(d, "poNumber"),
        group: "Purchase Order",
        code: str(d, "poNumber", "poNo") || "—",
        href: poId ? `/m/procurement/${encodeURIComponent(poId)}` : undefined,
      });
    }
    return out;
  },
  primaryCta: (d) => (str(d, "status") === "DRAFT" ? "Post to Stock" : "Status"),
};

const piDetail: DetailConfig = {
  url: (id) => `/api/purchase-invoices/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "piNo") || "—",
  title: (d) => str(d, "supplier", "supplierName") || "—",
  status: (d) => resolveStatus(str(d, "status"), PAYMENT_STATUS_MAP),
  flow: {
    steps: flowSteps(["DRAFT", "UNPAID", "PARTIAL", "PAID"]),
    current: (d) => str(d, "status"),
  },
  fields: [
    fld("Customer PO", (d) => str(d, "poRef", "poNo")),
    fld("Supplier", (d) => str(d, "supplier", "supplierName")),
    fld("Supplier Invoice", (d) => str(d, "supplierInvoiceNo")),
    fld("Order Date", (d) => dateOnly(d, "invoiceDate")),
    fld("Expected DD", (d) => dateOnly(d, "dueDate")),
    fld("Amount", (d) => money(num(d, "amountSen", "totalSen"))),
    fld("Outstanding", (d) =>
      money(num(d, "amountSen", "totalSen") - num(d, "paidAmountSen"))),
    fld("Remarks", (d) => str(d, "remarks"), true),
  ],
  lineItems: (d) => itemsOf(d, "items"),
  relatedDocs: (d) => {
    const out: RelatedDocVM[] = [];
    const poId = str(d, "purchaseOrderId");
    if (poId || str(d, "poRef")) {
      out.push({
        id: poId || str(d, "poRef"),
        group: "Purchase Order",
        code: str(d, "poRef", "poNo") || "—",
        href: poId ? `/m/procurement/${encodeURIComponent(poId)}` : undefined,
      });
    }
    const grnId = str(d, "grnId");
    if (grnId) {
      out.push({
        id: grnId,
        group: "Goods Receipt",
        code: grnId,
        href: `/m/procurement/${encodeURIComponent(grnId)}`,
      });
    }
    return out;
  },
  primaryCta: (d) => (str(d, "status") === "PAID" ? "Status" : "Record Payment"),
};

/** Dispatch the procurement detail by id prefix. */
function pickProcurementDetail(id: string): DetailConfig {
  if (id.startsWith("grn-")) return grnDetail;
  if (id.startsWith("pi-")) return piDetail;
  return poDetail; // "po-" (and any unknown) → Purchase Order.
}

// Dispatcher: only url + selectDoc run pre-fetch (keyed by route id prefix);
// `resolve` swaps in the right sub-config once the doc is loaded. The base
// code/title/fields are inert fallbacks (the screen reads the resolved config).
const procurementDetail: DetailConfig = {
  url: (id) => pickProcurementDetail(id).url(id),
  selectDoc: (resp, id) => pickProcurementDetail(id).selectDoc(resp, id),
  resolve: (_doc, id) => pickProcurementDetail(id),
  code: (d) => str(d, "poNo", "grnNumber", "piNo") || "—",
  title: (d) => str(d, "supplierName", "supplier") || "—",
  fields: [],
};

export const procurementConfig: ModuleConfig = {
  slug: "procurement",
  title: "Procurement",
  // Suppliers (Maintenance) have no doc detail — only po/grn/pi ids navigate.
  detailPath: (vm) =>
    /^(po|grn|pi)-/.test(vm.id)
      ? `/m/procurement/${encodeURIComponent(vm.id)}`
      : null,
  detail: procurementDetail,
  sources: [poSource, grnSource, piSource, maintenanceSource],
};

// ---------------------------------------------------------------------------
// PRODUCTION — one source (/api/production-orders). Department sub-tabs filter
// by whether the PO has a job card in that department (rows carry jobCards[]).
// Spec: All + Fab Cut / Fab Sew / Foam / Wood Cut / Framing / Webbing /
// Upholstery / Packing.
// ---------------------------------------------------------------------------
function hasDept(r: RawRow, code: string): boolean {
  const jcs = r.jobCards;
  if (!Array.isArray(jcs)) return false;
  return jcs.some((jc) => str(jc as RawRow, "departmentCode") === code);
}

const DEPT_TABS: { key: string; label: string; code: string }[] = [
  { key: "fab_cut", label: "Fab Cut", code: "FAB_CUT" },
  { key: "fab_sew", label: "Fab Sew", code: "FAB_SEW" },
  { key: "foam", label: "Foam", code: "FOAM" },
  { key: "wood_cut", label: "Wood Cut", code: "WOOD_CUT" },
  { key: "framing", label: "Framing", code: "FRAMING" },
  { key: "webbing", label: "Webbing", code: "WEBBING" },
  { key: "upholstery", label: "Upholstery", code: "UPHOLSTERY" },
  { key: "packing", label: "Packing", code: "PACKING" },
];

const productionSource: DataSource = {
  url: "/api/production-orders",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "poNo"),
    code: str(r, "poNo") || "—",
    title: str(r, "productName", "productCode") || "—",
    subLine:
      [str(r, "customerName"), str(r, "currentDepartment")]
        .filter(Boolean)
        .join(" · ") || undefined,
    meta1: { label: "Qty", value: num(r, "quantity") },
    meta2: { label: "Expected DD", value: dateOnly(r, "targetEndDate") || "—" },
    status: resolveStatus(str(r, "status"), STATUS_MAPS.production),
  }),
  columns: [
    textCol("poNo", "Reference", (r) => str(r, "poNo")),
    textCol("product", "Customer", (r) => str(r, "productName", "productCode")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    numCol("qty", "Qty", (r) => num(r, "quantity")),
    dateCol("targetEndDate", "Expected DD", (r) => dateOnly(r, "targetEndDate")),
    enumCol("status", "Status", (r) => str(r, "status"), PROD_STATUSES),
  ],
  defaultSort: { key: "targetEndDate", dir: "asc" },
  subTabs: [
    { key: "all", label: "All", match: () => true },
    ...DEPT_TABS.map((d) => ({
      key: d.key,
      label: d.label,
      match: (r: RawRow) => hasDept(r, d.code),
    })),
  ],
};

// Production detail — single-GET /api/production-orders/:id → { data: PO }.
// Job cards (per-department progress) are the PO's "line items".
const productionDetail: DetailConfig = {
  url: (id) => `/api/production-orders/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "poNo") || "—",
  title: (d) => str(d, "productName", "productCode") || "—",
  status: (d) => resolveStatus(str(d, "status"), STATUS_MAPS.production),
  flow: {
    steps: flowSteps(["PENDING", "IN_PROGRESS", "COMPLETED"]),
    current: (d) => str(d, "status"),
  },
  fields: [
    fld("Product", (d) => str(d, "productName", "productCode")),
    fld("Customer", (d) => str(d, "customerName")),
    fld("Qty", (d) => String(num(d, "quantity"))),
    fld("Department", (d) => str(d, "currentDepartment")),
    fld("Order Date", (d) => dateOnly(d, "startDate")),
    fld("Expected DD", (d) => dateOnly(d, "targetEndDate")),
  ],
  lineItems: (d) => {
    const jcs = d.jobCards;
    if (!Array.isArray(jcs)) return [];
    return (jcs as RawRow[]).map((jc, i) => ({
      id: str(jc, "id") || String(i),
      title: str(jc, "departmentName", "departmentCode") || "Department",
      subLine: str(jc, "status") || undefined,
      meta1: { label: "Progress", value: `${num(jc, "progress")}%` },
    }));
  },
  relatedDocs: (d) => {
    const out: RelatedDocVM[] = [];
    const soId = str(d, "salesOrderId");
    const soNo = str(d, "companySO", "companySOId", "customerSO");
    if (soId || soNo) {
      out.push({
        id: soId || soNo,
        group: "Sales Order",
        code: soNo || "—",
        href: soId
          ? `/m/sales/${encodeURIComponent(soId)}`
          : soNo
            ? `/m/sales/${encodeURIComponent(soNo)}`
            : undefined,
      });
    }
    return out;
  },
};

export const productionConfig: ModuleConfig = {
  slug: "production",
  title: "Production Orders",
  detailPath: (vm) => `/m/production/${encodeURIComponent(vm.id)}`,
  detail: productionDetail,
  sources: [productionSource],
};

// ---------------------------------------------------------------------------
// PLANNING — Capacity / MRP / Schedule. No dedicated planning list endpoints;
// Capacity + Schedule are derived from production-orders, MRP has none. Wire
// all three to /api/production-orders as the closest live source.
// TODO: replace MRP with a real MRP endpoint when one exists.
// ---------------------------------------------------------------------------
const planningRows = (label: string): SubTabFactory => ({
  url: "/api/production-orders",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "poNo"),
    code: str(r, "poNo") || "—",
    title: str(r, "productName", "productCode") || "—",
    subLine: str(r, "currentDepartment") || undefined,
    meta1: { label: "Qty", value: num(r, "quantity") },
    meta2: { label: "Expected DD", value: dateOnly(r, "targetEndDate") || "—" },
    status: resolveStatus(str(r, "status"), STATUS_MAPS.production),
  }),
  columns: [
    textCol("poNo", "Reference", (r) => str(r, "poNo")),
    textCol("product", "Customer", (r) => str(r, "productName", "productCode")),
    numCol("qty", "Qty", (r) => num(r, "quantity")),
    dateCol("startDate", "Order Date", (r) => dateOnly(r, "startDate")),
    dateCol("targetEndDate", "Expected DD", (r) => dateOnly(r, "targetEndDate")),
    enumCol("status", "Status", (r) => str(r, "status"), PROD_STATUSES),
  ],
  defaultSort: { key: "targetEndDate", dir: "asc" },
  label,
});

type SubTabFactory = Omit<DataSource, "subTabs"> & { label: string };
function planningSource(key: string, label: string): DataSource {
  const base = planningRows(label);
  return {
    ...base,
    subTabs: [{ key, label, match: () => true }],
  };
}

export const planningConfig: ModuleConfig = {
  slug: "planning",
  title: "Planning",
  detailPath: (vm) => `/m/production/${encodeURIComponent(vm.id)}`,
  sources: [
    planningSource("capacity", "Capacity"),
    planningSource("mrp", "MRP"),
    planningSource("schedule", "Schedule"),
  ],
};

// ---------------------------------------------------------------------------
// WAREHOUSE — Rack Overview / Stock In-Out / Movement.
// /api/warehouse returns rack locations. Stock In-Out + Movement have no
// dedicated list endpoints (form / per-rack detail driven) → reuse warehouse
// rows as the closest live data. TODO: wire a movements list endpoint if one
// is added.
// ---------------------------------------------------------------------------
function warehouseSource(key: string, label: string): DataSource {
  return {
    url: "/api/warehouse",
    select: selectData,
    toVM: (r): RowVM => ({
      id: str(r, "id"),
      code: [str(r, "rack"), str(r, "position")].filter(Boolean).join("-") || str(r, "id"),
      title:
        (Array.isArray(r.items) && (r.items as unknown[]).length
          ? str((r.items as RawRow[])[0], "productName", "productCode")
          : "Empty") || "Empty",
      subLine: str(r, "zone", "area") || undefined,
      meta1: { label: "Items", value: Array.isArray(r.items) ? (r.items as unknown[]).length : 0 },
      status: resolveStatus(str(r, "status"), {
        EMPTY: PAYMENT_STATUS_MAP.ACTIVE,
        OCCUPIED: PAYMENT_STATUS_MAP.SUBMITTED,
        RESERVED: PAYMENT_STATUS_MAP.PARTIAL,
      }),
    }),
    columns: [
      textCol("rack", "Reference", (r) => [str(r, "rack"), str(r, "position")].filter(Boolean).join("-")),
      numCol("items", "Items", (r) => (Array.isArray(r.items) ? (r.items as unknown[]).length : 0)),
      enumCol("status", "Status", (r) => str(r, "status"), ["EMPTY", "OCCUPIED", "RESERVED"]),
    ],
    defaultSort: { key: "rack", dir: "asc" },
    subTabs: [{ key, label, match: () => true }],
  };
}

// Warehouse rack detail — GET /api/warehouse/:id/details returns
// { data: { rack, contents[], movements[] } }. The whole `data` object is the
// "doc"; accessors reach into rack / contents / movements. Mirrors the design
// source: a dark rack hero, a small field grid, "In this rack now" (current
// contents), and "Recent movements" (stock_movements, newest-first). All real.
const warehouseDetail: DetailConfig = {
  url: (id) => `/api/warehouse/${encodeURIComponent(id)}/details`,
  selectDoc: selectDocData,
  code: (d) => {
    const rack = (read(d, "rack") ?? {}) as RawRow;
    return str(rack, "rack") || "Rack";
  },
  title: (d) => {
    const rack = (read(d, "rack") ?? {}) as RawRow;
    const label = [str(rack, "rack"), str(rack, "position")]
      .filter(Boolean)
      .join("-");
    return label || str(rack, "rack") || "Rack";
  },
  status: (d) => {
    const rack = (read(d, "rack") ?? {}) as RawRow;
    return resolveStatus(str(rack, "status"), {
      EMPTY: PAYMENT_STATUS_MAP.ACTIVE,
      OCCUPIED: PAYMENT_STATUS_MAP.SUBMITTED,
      RESERVED: PAYMENT_STATUS_MAP.PARTIAL,
    });
  },
  darkStat: (d) => {
    const rack = (read(d, "rack") ?? {}) as RawRow;
    const contents = asArr(read(d, "contents"));
    const label = [str(rack, "rack"), str(rack, "position")]
      .filter(Boolean)
      .join("-") || str(rack, "rack") || "Rack";
    return {
      eyebrow: "Rack",
      value: label,
      caption:
        contents.length > 0
          ? `Currently holds ${contents.length} item${contents.length === 1 ? "" : "s"}.`
          : "Empty — no items stored.",
    };
  },
  fields: (() => {
    const rackField = (
      label: string,
      get: (rack: RawRow, d: RawRow) => string,
    ): FieldDef => ({
      label,
      value: (d) => get((read(d, "rack") ?? {}) as RawRow, d),
    });
    return [
      rackField("Rack", (rack) => str(rack, "rack")),
      rackField("Position", (rack) => str(rack, "position")),
      rackField("Status", (rack) => str(rack, "status")),
      {
        label: "Items",
        value: (d) => String(asArr(read(d, "contents")).length),
      },
    ];
  })(),
  subDocLists: (d) => {
    const contents = asArr(read(d, "contents"));
    const movements = asArr(read(d, "movements"));
    return [
      {
        title: "In this rack now",
        emptyText: "No items in this rack.",
        rows: contents.map((it, i) => ({
          id: str(it, "productCode") + "-" + i,
          title:
            str(it, "productName", "productCode") || "Item",
          subLine:
            [str(it, "customerPOId", "productionOrderId"), str(it, "customerName")]
              .filter(Boolean)
              .join(" · ") || undefined,
          trailing: dateOnly(it, "stockedInDate") || undefined,
          icon: "package" as const,
        })),
      },
      {
        title: "Recent movements",
        emptyText: "No movement history.",
        rows: movements.map((mv) => {
          const dir = str(mv, "type"); // STOCK_IN / STOCK_OUT / TRANSFER
          const isIn = dir === "STOCK_IN";
          return {
            id: str(mv, "id"),
            title: str(mv, "productName", "productCode") || "Movement",
            subLine:
              [isIn ? "Stock in" : dir === "STOCK_OUT" ? "Stock out" : "Transfer",
                str(mv, "docRef"),
                str(mv, "performedBy")]
                .filter(Boolean)
                .join(" · ") || undefined,
            trailing: dateOnly(mv, "createdAt") || undefined,
            icon: isIn ? ("arrow-down" as const) : ("arrow-up" as const),
          };
        }),
      },
    ];
  },
  // Design source: rack detail is a read-only view (no Print/Edit/CTA bar).
  hideActionBar: true,
};

export const warehouseConfig: ModuleConfig = {
  slug: "warehouse",
  title: "Warehouse",
  // Only Rack Overview rows (real rack ids) open the rack detail; the Stock
  // In-Out / Movement sub-tabs reuse the same rack rows, so any rack id is a
  // valid detail target.
  detailPath: (vm) => `/m/warehouse/${encodeURIComponent(vm.id)}`,
  detail: warehouseDetail,
  sources: [
    warehouseSource("racks", "Rack Overview"),
    warehouseSource("stock_io", "Stock In-Out"),
    warehouseSource("movement", "Movement"),
  ],
};

// ---------------------------------------------------------------------------
// INVENTORY — Finished Goods / WIP / Raw Materials / Fabrics / Stock Value /
// Adjustments.
//   • Finished Goods  → /api/inventory (data.finishedProducts)
//   • WIP             → /api/inventory (data.wip if present) — TODO: WIP is
//                       computed from production-orders on desktop; the
//                       inventory meta endpoint may not expose it. Falls back
//                       to empty if absent.
//   • Raw Materials   → /api/raw-materials
//   • Fabrics         → /api/fabric-tracking
//   • Stock Value     → /api/inventory (data.finishedProducts) reused, sorted
//                       by value. TODO: dedicated stock-value endpoint.
//   • Adjustments     → /api/stock-adjustments
// ---------------------------------------------------------------------------
const finishedGoodsSource: DataSource = {
  url: "/api/inventory",
  select: selectNested("data", "finishedProducts"),
  toVM: (r): RowVM => ({
    id: str(r, "id", "code"),
    code: str(r, "code") || "—",
    title: str(r, "name") || "—",
    subLine: str(r, "category") || undefined,
    meta1: { label: "Qty", value: num(r, "stockQty") },
    meta2: { label: "Amount", value: money(num(r, "basePriceSen", "price1Sen") * num(r, "stockQty")) },
  }),
  columns: [
    textCol("code", "Reference", (r) => str(r, "code")),
    textCol("name", "Customer", (r) => str(r, "name")),
    enumCol("category", "State", (r) => str(r, "category"), ["BEDFRAME", "SOFA", "ACCESSORY"]),
    numCol("qty", "Qty", (r) => num(r, "stockQty")),
  ],
  defaultSort: { key: "name", dir: "asc" },
  subTabs: [{ key: "fg", label: "Finished Goods", match: () => true }],
};

const wipSource: DataSource = {
  // WIP rows are surfaced by the inventory meta endpoint when available; if the
  // key is absent the list is empty (desktop computes WIP from production
  // orders). TODO: wire the production-orders WIP derivation here in Phase 3.
  url: "/api/inventory",
  select: selectNested("data", "wip"),
  toVM: (r): RowVM => ({
    id: str(r, "id", "code", "poNo"),
    code: str(r, "code", "poNo") || "—",
    title: str(r, "name", "productName") || "—",
    subLine: str(r, "type", "wipType") || undefined,
    meta1: { label: "Qty", value: num(r, "qty", "quantity") },
  }),
  columns: [
    textCol("code", "Reference", (r) => str(r, "code", "poNo")),
    textCol("name", "Customer", (r) => str(r, "name", "productName")),
    numCol("qty", "Qty", (r) => num(r, "qty", "quantity")),
  ],
  defaultSort: { key: "code", dir: "asc" },
  subTabs: [{ key: "wip", label: "WIP", match: () => true }],
};

const rawMaterialsSource: DataSource = {
  url: "/api/raw-materials",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "itemCode"),
    code: str(r, "itemCode") || "—",
    title: str(r, "description", "itemCode") || "—",
    subLine: str(r, "itemGroup") || undefined,
    meta1: { label: "Qty", value: `${num(r, "balanceQty")} ${str(r, "baseUOM")}`.trim() },
  }),
  columns: [
    textCol("itemCode", "Reference", (r) => str(r, "itemCode")),
    textCol("description", "Customer", (r) => str(r, "description")),
    textCol("itemGroup", "State", (r) => str(r, "itemGroup")),
    numCol("qty", "Qty", (r) => num(r, "balanceQty")),
  ],
  defaultSort: { key: "itemCode", dir: "asc" },
  subTabs: [{ key: "raw", label: "Raw Materials", match: () => true }],
};

const fabricsSource: DataSource = {
  url: "/api/fabric-tracking",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "fabricCode", "code"),
    code: str(r, "fabricCode", "code") || "—",
    title: str(r, "name", "description", "fabricCode") || "—",
    subLine: str(r, "category") || undefined,
    meta1: { label: "Qty", value: `${num(r, "balanceQty", "qty")} ${str(r, "baseUOM", "uom")}`.trim() },
  }),
  columns: [
    textCol("fabricCode", "Reference", (r) => str(r, "fabricCode", "code")),
    textCol("name", "Customer", (r) => str(r, "name", "description")),
    textCol("category", "State", (r) => str(r, "category")),
    numCol("qty", "Qty", (r) => num(r, "balanceQty", "qty")),
  ],
  defaultSort: { key: "fabricCode", dir: "asc" },
  subTabs: [{ key: "fabrics", label: "Fabrics", match: () => true }],
};

const stockValueSource: DataSource = {
  url: "/api/inventory",
  select: selectNested("data", "finishedProducts"),
  toVM: (r): RowVM => ({
    id: str(r, "id", "code"),
    code: str(r, "code") || "—",
    title: str(r, "name") || "—",
    subLine: str(r, "category") || undefined,
    meta1: { label: "Qty", value: num(r, "stockQty") },
    meta2: { label: "Amount", value: money(num(r, "basePriceSen", "price1Sen") * num(r, "stockQty")) },
  }),
  columns: [
    textCol("code", "Reference", (r) => str(r, "code")),
    textCol("name", "Customer", (r) => str(r, "name")),
    numCol("qty", "Qty", (r) => num(r, "stockQty")),
    numCol("amount", "Amount", (r) => num(r, "basePriceSen", "price1Sen") * num(r, "stockQty")),
  ],
  defaultSort: { key: "amount", dir: "desc" },
  subTabs: [{ key: "stock_value", label: "Stock Value", match: () => true }],
};

const adjustmentsSource: DataSource = {
  url: "/api/stock-adjustments",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id"),
    code: str(r, "adjustmentNo", "reference") || str(r, "id"),
    title: str(r, "productName", "productCode", "itemCode") || "—",
    subLine: str(r, "reason") || undefined,
    meta1: { label: "Qty", value: num(r, "qty", "quantity") },
    meta2: { label: "Order Date", value: dateOnly(r, "date", "createdAt") || "—" },
  }),
  columns: [
    textCol("reference", "Reference", (r) => str(r, "adjustmentNo", "reference")),
    textCol("product", "Customer", (r) => str(r, "productName", "productCode", "itemCode")),
    textCol("reason", "State", (r) => str(r, "reason")),
    dateCol("date", "Order Date", (r) => dateOnly(r, "date", "createdAt")),
    numCol("qty", "Qty", (r) => num(r, "qty", "quantity")),
  ],
  defaultSort: { key: "date", dir: "desc" },
  subTabs: [{ key: "adjustments", label: "Adjustments", match: () => true }],
};

export const inventoryConfig: ModuleConfig = {
  slug: "inventory",
  title: "Inventory",
  detailPath: () => null, // L2 inventory detail arrives in Phase 3.
  sources: [
    finishedGoodsSource,
    wipSource,
    rawMaterialsSource,
    fabricsSource,
    stockValueSource,
    adjustmentsSource,
  ],
};

// ---------------------------------------------------------------------------
// EMPLOYEES — Directory / Attendance / Leave / Payroll.
//   • Directory  → /api/workers
//   • Attendance → /api/attendance?date=<today> (the desktop default)
//   • Leave      → /api/leaves
//   • Payroll    → /api/payslips?period=<this month>
// ---------------------------------------------------------------------------
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function thisPeriod(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

const directorySource: DataSource = {
  url: "/api/workers",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "empNo"),
    code: str(r, "empNo") || "—",
    title: str(r, "name") || "—",
    subLine:
      [str(r, "departmentCode"), str(r, "position")].filter(Boolean).join(" · ") ||
      undefined,
    meta1: { label: "Phone", value: str(r, "phone") || "—" },
    status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
  }),
  columns: [
    textCol("empNo", "Reference", (r) => str(r, "empNo")),
    textCol("name", "Customer", (r) => str(r, "name")),
    textCol("dept", "State", (r) => str(r, "departmentCode")),
    textCol("position", "Reference", (r) => str(r, "position")),
    enumCol("status", "Status", (r) => str(r, "status"), ["ACTIVE", "INACTIVE"]),
  ],
  defaultSort: { key: "name", dir: "asc" },
  subTabs: [{ key: "directory", label: "Directory", match: () => true }],
};

const attendanceSource: DataSource = {
  url: `/api/attendance?date=${todayISO()}`,
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id"),
    code: str(r, "date") || todayISO(),
    title: str(r, "employeeName") || "—",
    subLine: str(r, "departmentName", "departmentCode") || undefined,
    meta1: { label: "In/Out", value: `${str(r, "clockIn") || "—"} / ${str(r, "clockOut") || "—"}` },
    status: resolveStatus(str(r, "status"), STATUS_MAPS.attendance),
  }),
  columns: [
    textCol("name", "Customer", (r) => str(r, "employeeName")),
    textCol("dept", "State", (r) => str(r, "departmentName", "departmentCode")),
    dateCol("date", "Order Date", (r) => dateOnly(r, "date")),
    enumCol("status", "Status", (r) => str(r, "status"), [
      "PRESENT", "ABSENT", "HALF_DAY", "MEDICAL_LEAVE", "ANNUAL_LEAVE", "REST_DAY",
    ]),
  ],
  defaultSort: { key: "name", dir: "asc" },
  subTabs: [{ key: "attendance", label: "Attendance", match: () => true }],
};

const leaveSource: DataSource = {
  url: "/api/leaves",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id"),
    code: str(r, "leaveType", "type") || "Leave",
    title: str(r, "employeeName", "workerName", "name") || "—",
    subLine:
      [dateOnly(r, "startDate", "fromDate"), dateOnly(r, "endDate", "toDate")]
        .filter(Boolean)
        .join(" → ") || undefined,
    meta1: { label: "Days", value: num(r, "days", "totalDays") },
    status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
  }),
  columns: [
    textCol("name", "Customer", (r) => str(r, "employeeName", "workerName", "name")),
    textCol("type", "State", (r) => str(r, "leaveType", "type")),
    dateCol("startDate", "Order Date", (r) => dateOnly(r, "startDate", "fromDate")),
    enumCol("status", "Status", (r) => str(r, "status"), ["PENDING", "APPROVED", "CANCELLED"]),
  ],
  defaultSort: { key: "startDate", dir: "desc" },
  subTabs: [{ key: "leave", label: "Leave", match: () => true }],
};

const payrollSource: DataSource = {
  url: `/api/payslips?period=${thisPeriod()}`,
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id", "payslipNo"),
    code: str(r, "period", "periodLabel") || thisPeriod(),
    title: str(r, "employeeName", "workerName", "name") || "—",
    subLine: str(r, "departmentName", "departmentCode") || undefined,
    meta1: { label: "Amount", value: money(num(r, "netPaySen", "netSen", "grossSen")) },
  }),
  columns: [
    textCol("name", "Customer", (r) => str(r, "employeeName", "workerName", "name")),
    textCol("dept", "State", (r) => str(r, "departmentName", "departmentCode")),
    numCol("net", "Amount", (r) => num(r, "netPaySen", "netSen", "grossSen")),
  ],
  defaultSort: { key: "name", dir: "asc" },
  subTabs: [{ key: "payroll", label: "Payroll", match: () => true }],
};

export const employeesConfig: ModuleConfig = {
  slug: "employees",
  title: "Employees",
  // Only stored payslip rows (Payroll sub-tab, id "PS-YYMM-NNN") open a detail —
  // the payslip detail (Earnings / Deductions / Net pay), reached at /m/payslips/:id.
  // Directory / Attendance / Leave rows have no per-id office endpoint that
  // returns the design's composite (attendance strip + payslip list) without
  // fabricating data, so they stay non-tappable. Projected-only payslips
  // ("projected-…") have no GET /:id, so they're excluded too.
  detailPath: (vm) =>
    /^PS-/.test(vm.id)
      ? `/m/payslips/${encodeURIComponent(vm.id)}`
      : null,
  sources: [directorySource, attendanceSource, leaveSource, payrollSource],
};

// ---------------------------------------------------------------------------
// PAYSLIPS — no L1 list of its own in the More menu; reached by tapping a
// Payroll row under Employees. GET /api/payslips/:id → { data, ytd, months }.
// The detail mirrors the design source's payslip screen: Earnings / Deductions
// key-value cards + a dark Net pay band. All figures are REAL (stored sen).
// ---------------------------------------------------------------------------
const payslipDetail: DetailConfig = {
  url: (id) => `/api/payslips/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "period") || "Payslip",
  title: (d) => str(d, "employeeName") || "Payslip",
  status: (d) => resolveStatus(str(d, "status"), PAYMENT_STATUS_MAP),
  fields: [
    fld("Employee", (d) => str(d, "employeeName")),
    fld("Employee No.", (d) => str(d, "employeeNo")),
    fld("Department", (d) => str(d, "departmentCode")),
    fld("Period", (d) => str(d, "period")),
    fld("Working Days", (d) => String(num(d, "workingDays"))),
    fld("Bank Account", (d) => str(d, "bankAccount")),
  ],
  kvSections: (d) => {
    const earnings = [
      { label: "Basic salary", value: money(num(d, "basicSalary", "basicSalarySen")) },
      { label: "Overtime", value: money(num(d, "totalOT", "totalOtSen")) },
      { label: "Allowances", value: money(num(d, "allowances", "allowancesSen")) },
      { label: "Gross pay", value: money(num(d, "grossPay", "grossPaySen")) },
    ];
    // Deductions: only show lines that exist (a zeroed statutory line is still a
    // real figure — keep it so totals reconcile; the absence line is omitted
    // when there's no deduction).
    const deductions = [
      { label: "EPF (employee)", value: money(num(d, "epfEmployee", "epfEmployeeSen")) },
      { label: "SOCSO (employee)", value: money(num(d, "socsoEmployee", "socsoEmployeeSen")) },
      { label: "EIS (employee)", value: money(num(d, "eisEmployee", "eisEmployeeSen")) },
      { label: "PCB (tax)", value: money(num(d, "pcb", "pcbSen")) },
    ];
    const absence = num(d, "absenceDeductionSen");
    if (absence > 0) {
      deductions.push({ label: "Absence", value: money(absence) });
    }
    deductions.push({
      label: "Total deductions",
      value: money(num(d, "totalDeductions", "totalDeductionsSen")),
    });
    return [
      { title: "Earnings", rows: earnings },
      { title: "Deductions", rows: deductions, negative: true },
    ];
  },
  netPay: (d) => ({
    label: "Net pay",
    value: money(num(d, "netPay", "netPaySen")),
  }),
  // Design source: the payslip is a read-only statement — no Print/Edit/CTA bar.
  hideActionBar: true,
};

export const payslipsConfig: ModuleConfig = {
  slug: "payslips",
  title: "Payslip",
  detailPath: () => null,
  detail: payslipDetail,
  // No standalone list source — payslips are reached from the Employees Payroll
  // sub-tab. A minimal source keeps /m/payslips a valid (empty) list route.
  sources: [
    {
      url: `/api/payslips?period=${thisPeriod()}`,
      select: selectData,
      toVM: (r): RowVM => ({
        id: str(r, "id"),
        code: str(r, "period") || thisPeriod(),
        title: str(r, "employeeName") || "—",
        subLine: str(r, "departmentCode") || undefined,
        meta1: { label: "Amount", value: money(num(r, "netPay", "netPaySen")) },
      }),
      columns: [
        textCol("name", "Customer", (r) => str(r, "employeeName")),
        numCol("net", "Amount", (r) => num(r, "netPay", "netPaySen")),
      ],
      defaultSort: { key: "name", dir: "asc" },
      subTabs: [{ key: "payslips", label: "Payslips", match: () => true }],
    },
  ],
};

// ---------------------------------------------------------------------------
// ANNOUNCEMENTS — All / Pinned. /api/announcements; "Pinned" = isActive flag.
// ---------------------------------------------------------------------------
const announcementsSource: DataSource = {
  url: "/api/announcements",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id"),
    code: str(r, "category") || "Notice",
    title: str(r, "title") || "—",
    subLine: str(r, "createdBy") || undefined,
    meta1: { label: "Order Date", value: dateOnly(r, "createdAt") || "—" },
  }),
  columns: [
    textCol("title", "Customer", (r) => str(r, "title")),
    textCol("category", "State", (r) => str(r, "category")),
    dateCol("createdAt", "Order Date", (r) => dateOnly(r, "createdAt")),
  ],
  defaultSort: { key: "createdAt", dir: "desc" },
  subTabs: [
    { key: "all", label: "All", match: () => true },
    { key: "pinned", label: "Pinned", match: (r) => read(r, "isActive") === true },
  ],
};

// Announcement detail — no GET /:id; the list (/api/announcements) already
// carries the full body, so we fetch the list and find the row by id.
const announcementsDetail: DetailConfig = {
  url: () => "/api/announcements",
  selectDoc: selectFromListById(["id"]),
  code: (d) => str(d, "category") || "Notice",
  title: (d) => str(d, "title") || "—",
  status: (d) =>
    read(d, "isActive") === true
      ? resolveStatus("ACTIVE", PAYMENT_STATUS_MAP)
      : undefined,
  fields: [
    fld("Category", (d) => str(d, "category")),
    fld("Posted By", (d) => str(d, "createdBy")),
    fld("Order Date", (d) => dateOnly(d, "createdAt")),
    fld("Expires", (d) => dateOnly(d, "expiresAt")),
  ],
  // Design source: the announcement message renders as its own body card (not a
  // cramped field-grid value). Split paragraphs on blank lines; only the real
  // stored body is shown — no fabricated boilerplate.
  body: (d) =>
    str(d, "body", "message")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean),
  primaryCta: () => "Mark as Read",
};

export const announcementsConfig: ModuleConfig = {
  slug: "announcements",
  title: "Announcements",
  detailPath: (vm) => `/m/announcements/${encodeURIComponent(vm.id)}`,
  detail: announcementsDetail,
  sources: [announcementsSource],
};

// ---------------------------------------------------------------------------
// MAIL CENTER — Inbox / Sent. /api/mail-center/threads returns a bare array.
// Inbox = threads (any with inbound). Sent = threads with hasOutbound. We
// fetch the unfiltered thread list once and split client-side.
// ---------------------------------------------------------------------------
const mailSource: DataSource = {
  url: "/api/mail-center/threads",
  select: (resp) => (Array.isArray(resp) ? (resp as RawRow[]) : selectData(resp)),
  toVM: (r): RowVM => ({
    id: str(r, "id"),
    code: read(r, "unread") === true ? "New" : "Read",
    title: str(r, "subject") || "(No subject)",
    subLine: str(r, "counterpartyName", "counterpartyEmail") || undefined,
    meta1: { label: "Updated", value: dateOnly(r, "lastMessageAt") || "—" },
    meta2: { label: "Msgs", value: num(r, "messageCount") },
  }),
  columns: [
    textCol("subject", "Reference", (r) => str(r, "subject")),
    textCol("from", "Customer", (r) => str(r, "counterpartyName", "counterpartyEmail")),
    dateCol("lastMessageAt", "Order Date", (r) => dateOnly(r, "lastMessageAt")),
  ],
  defaultSort: { key: "lastMessageAt", dir: "desc" },
  subTabs: [
    { key: "inbox", label: "Inbox", match: (r) => read(r, "trashedAt") == null },
    { key: "sent", label: "Sent", match: (r) => read(r, "hasOutbound") === true },
  ],
};

// Mail detail — single-GET /api/mail-center/threads/:id → { thread, messages }.
// The thread is the doc; each message becomes a line item (tap → read body).
const mailDetail: DetailConfig = {
  url: (id) => `/api/mail-center/threads/${encodeURIComponent(id)}`,
  selectDoc: (resp) => {
    if (!resp || typeof resp !== "object") return null;
    const o = resp as { thread?: unknown; messages?: unknown };
    if (!o.thread || typeof o.thread !== "object") return null;
    // Merge the messages onto the thread so the field grid + line items read
    // from one doc object.
    return {
      ...(o.thread as RawRow),
      messages: Array.isArray(o.messages) ? o.messages : [],
    };
  },
  code: (d) => (read(d, "unread") === true ? "New" : "Read"),
  title: (d) => str(d, "subject") || "(No subject)",
  status: (d) =>
    read(d, "hasOutbound") === true
      ? resolveStatus("SENT", PAYMENT_STATUS_MAP)
      : resolveStatus("RECEIVED", PAYMENT_STATUS_MAP),
  fields: [
    fld("From", (d) => str(d, "counterpartyName", "counterpartyEmail")),
    fld("Mailbox", (d) => str(d, "mailboxAddress")),
    fld("Updated", (d) => dateOnly(d, "lastMessageAt")),
    fld("Messages", (d) => String(num(d, "messageCount"))),
    fld("Subject", (d) => str(d, "subject"), true),
  ],
  // Design source: the mail reads as a message body. Show the most recent
  // message's real text as the body card (full thread stays in the line items
  // below). Nothing is fabricated — empty bodies just yield no card.
  body: (d) => {
    const msgs = Array.isArray(d.messages) ? (d.messages as RawRow[]) : [];
    if (msgs.length === 0) return [];
    const latest = msgs[msgs.length - 1];
    const text = str(latest, "textBody", "body", "snippet");
    return text
      ? text
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
  },
  lineItems: (d) => {
    const msgs = d.messages;
    if (!Array.isArray(msgs)) return [];
    return (msgs as RawRow[]).map((m, i) => ({
      id: str(m, "id") || String(i),
      title:
        str(m, "fromName", "fromAddress") ||
        (str(m, "direction") === "outbound" ? "Sent" : "Received"),
      subLine:
        (str(m, "textBody") || str(m, "subject")).slice(0, 80) || undefined,
      meta1: { label: "Date", value: dateOnly(m, "sentAt", "receivedAt", "createdAt") || "—" },
    }));
  },
  primaryCta: () => "Reply",
};

export const mailConfig: ModuleConfig = {
  slug: "mail-center",
  title: "Mail Center",
  detailPath: (vm) => `/m/mail-center/${encodeURIComponent(vm.id)}`,
  detail: mailDetail,
  sources: [mailSource],
};

// ---------------------------------------------------------------------------
// CUSTOMERS / SUPPLIERS / RECEIVABLES / PRODUCTS — simple single-source lists
// (reachable from the More menu).
// ---------------------------------------------------------------------------
export const customersConfig: ModuleConfig = {
  slug: "customers",
  title: "Customers",
  detailPath: () => null,
  sources: [
    {
      url: "/api/customers",
      select: selectData,
      toVM: (r): RowVM => ({
        id: str(r, "id", "code"),
        code: str(r, "code", "debtorCode") || "—",
        title: str(r, "name") || "—",
        subLine: [str(r, "phone"), str(r, "state")].filter(Boolean).join(" · ") || undefined,
        meta1: { label: "Outstanding", value: money(num(r, "outstandingSen")) },
        status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
      }),
      columns: [
        textCol("code", "Reference", (r) => str(r, "code", "debtorCode")),
        textCol("name", "Customer", (r) => str(r, "name")),
        textCol("state", "State", (r) => str(r, "state")),
        numCol("outstanding", "Outstanding", (r) => num(r, "outstandingSen")),
        enumCol("status", "Status", (r) => str(r, "status"), ["ACTIVE", "INACTIVE"]),
      ],
      defaultSort: { key: "name", dir: "asc" },
      subTabs: [{ key: "all", label: "Customers", match: () => true }],
    },
  ],
};

export const suppliersConfig: ModuleConfig = {
  slug: "suppliers",
  title: "Suppliers",
  detailPath: () => null,
  sources: [
    {
      url: "/api/suppliers",
      select: selectData,
      toVM: (r): RowVM => ({
        id: str(r, "id", "code"),
        code: str(r, "code") || "—",
        title: str(r, "name") || "—",
        subLine: [str(r, "phone"), str(r, "state")].filter(Boolean).join(" · ") || undefined,
        meta1: { label: "Contact", value: str(r, "contactPerson") || "—" },
        status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
      }),
      columns: [
        textCol("code", "Reference", (r) => str(r, "code")),
        textCol("name", "Customer", (r) => str(r, "name")),
        textCol("state", "State", (r) => str(r, "state")),
        enumCol("status", "Status", (r) => str(r, "status"), ["ACTIVE", "INACTIVE"]),
      ],
      defaultSort: { key: "name", dir: "asc" },
      subTabs: [{ key: "all", label: "Suppliers", match: () => true }],
    },
  ],
};

export const receivablesConfig: ModuleConfig = {
  slug: "receivables",
  title: "Receivables",
  detailPath: () => null,
  sources: [
    {
      // AR aging: /api/accounting/aging → { data: { ar: [...], ap: [...] } }.
      url: "/api/accounting/aging",
      select: selectNested("data", "ar"),
      toVM: (r): RowVM => ({
        id: str(r, "customerId", "customerName"),
        code: str(r, "debtorCode", "customerCode") || "AR",
        title: str(r, "customerName") || "—",
        subLine: undefined,
        meta1: { label: "Outstanding", value: money(num(r, "total", "totalSen")) },
      }),
      columns: [
        textCol("customer", "Customer", (r) => str(r, "customerName")),
        numCol("total", "Outstanding", (r) => num(r, "total", "totalSen")),
      ],
      defaultSort: { key: "total", dir: "desc" },
      subTabs: [{ key: "ar", label: "Receivables", match: () => true }],
    },
  ],
};

export const productsConfig: ModuleConfig = {
  slug: "products",
  title: "Products",
  detailPath: () => null,
  sources: [
    {
      url: "/api/products",
      select: selectData,
      toVM: (r): RowVM => ({
        id: str(r, "id", "code"),
        code: str(r, "code") || "—",
        title: str(r, "name") || "—",
        subLine: [str(r, "category"), str(r, "sizeLabel")].filter(Boolean).join(" · ") || undefined,
        meta1: { label: "Amount", value: money(num(r, "basePriceSen", "price1Sen")) },
      }),
      columns: [
        textCol("code", "Reference", (r) => str(r, "code")),
        textCol("name", "Customer", (r) => str(r, "name")),
        enumCol("category", "State", (r) => str(r, "category"), ["BEDFRAME", "SOFA", "ACCESSORY"]),
        numCol("amount", "Amount", (r) => num(r, "basePriceSen", "price1Sen")),
      ],
      defaultSort: { key: "name", dir: "asc" },
      subTabs: [{ key: "all", label: "Products", match: () => true }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry — slug → config, consumed by MobileLayout's route wiring.
// ---------------------------------------------------------------------------
export const MODULE_CONFIGS: ModuleConfig[] = [
  salesConfig,
  deliveryConfig,
  invoicesConfig,
  procurementConfig,
  productionConfig,
  planningConfig,
  warehouseConfig,
  inventoryConfig,
  employeesConfig,
  payslipsConfig,
  announcementsConfig,
  mailConfig,
  customersConfig,
  suppliersConfig,
  receivablesConfig,
  productsConfig,
];
