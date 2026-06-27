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
} from "./helpers";

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

export const salesConfig: ModuleConfig = {
  slug: "sales",
  title: "Sales Orders",
  detailPath: (vm) => `/m/sales/${encodeURIComponent(vm.id)}`,
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

export const deliveryConfig: ModuleConfig = {
  slug: "delivery",
  title: "Delivery",
  detailPath: (vm) => `/m/delivery/${encodeURIComponent(vm.id)}`,
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

export const invoicesConfig: ModuleConfig = {
  slug: "invoices",
  title: "Invoices",
  detailPath: (vm) => `/m/invoices/${encodeURIComponent(vm.id)}`,
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

export const procurementConfig: ModuleConfig = {
  slug: "procurement",
  title: "Procurement",
  detailPath: (vm) => `/m/procurement/${encodeURIComponent(vm.id)}`,
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

export const productionConfig: ModuleConfig = {
  slug: "production",
  title: "Production Orders",
  detailPath: (vm) => `/m/production/${encodeURIComponent(vm.id)}`,
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

export const warehouseConfig: ModuleConfig = {
  slug: "warehouse",
  title: "Warehouse",
  detailPath: (vm) => `/m/warehouse/${encodeURIComponent(vm.id)}`,
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
  detailPath: () => null, // L2 employee detail arrives in Phase 3.
  sources: [directorySource, attendanceSource, leaveSource, payrollSource],
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

export const announcementsConfig: ModuleConfig = {
  slug: "announcements",
  title: "Announcements",
  detailPath: (vm) => `/m/announcements/${encodeURIComponent(vm.id)}`,
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

export const mailConfig: ModuleConfig = {
  slug: "mail-center",
  title: "Mail Center",
  detailPath: (vm) => `/m/mail-center/${encodeURIComponent(vm.id)}`,
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
  announcementsConfig,
  mailConfig,
  customersConfig,
  suppliersConfig,
  receivablesConfig,
  productsConfig,
];
