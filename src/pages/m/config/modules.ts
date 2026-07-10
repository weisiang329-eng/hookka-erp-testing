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
import { logHoursSpec, hubFormSpec, addAffectedProductSpec } from "./forms";
import {
  type DetailConfig,
  type FlowStep,
  type RelatedDocVM,
  type KvSection,
  type SubDocList,
} from "./types";
import {
  read,
  str,
  num,
  dateOnly,
  money,
  shortDate,
  summariseItems,
  resolveStatus,
  STATUS_MAPS,
  PAYMENT_STATUS_MAP,
  SERVICE_CASE_STATUS_MAP,
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
    // Procurement (PO / GRN / Purchase Invoice) items store the name in
    // `materialName` + `material_code`, not productName — include them or the
    // line shows "—".
    title:
      str(
        it,
        "productName",
        "materialName",
        "description",
        "itemDescription",
        "productCode",
        "material_code",
      ) || "—",
    subLine:
      str(it, "productCode", "materialCode", "material_code", "itemCode", "sku") ||
      undefined,
    meta1: { label: "Qty", value: qty },
    meta2: { label: "Amount", value: money(line) },
  };
}

/**
 * Customization chips from a sales/delivery/invoice line — mirrors the desktop
 * "Customization" column (src/pages/sales/detail.tsx): Gap N" / Divan N" /
 * Leg N" / special order (underscores → spaces) + free-text custom specials.
 * Tones match the desktop chip colours (gap=info, divan=plum, leg=warning,
 * special=danger).
 */
function customizationChips(it: RawRow): LineItemVM["chips"] {
  const chips: NonNullable<LineItemVM["chips"]> = [];
  const gap = num(it, "gapInches");
  const divan = num(it, "divanHeightInches");
  const leg = num(it, "legHeightInches");
  if (gap > 0) chips.push({ text: `Gap ${gap}"`, tone: "info" });
  if (divan > 0) chips.push({ text: `Divan ${divan}"`, tone: "plum" });
  if (leg > 0) chips.push({ text: `Leg ${leg}"`, tone: "warning" });
  const special = str(it, "specialOrder");
  if (special) chips.push({ text: special.replace(/_/g, " "), tone: "danger" });
  // Free-text custom specials (parsed array of { description }). See SO 0074.
  const cs = it.customSpecials;
  if (Array.isArray(cs)) {
    for (const e of cs as RawRow[]) {
      const desc = str(e, "description");
      if (desc) chips.push({ text: desc, tone: "neutral" });
    }
  }
  return chips.length ? chips : undefined;
}

/**
 * Rich line item for SO/DO/Invoice/PI — adds the variant data the desktop
 * tables show in their own columns (Category / Size / Fabric + Unit price),
 * customization chips, and the line Total as the bold trailing figure. Falls
 * back gracefully when a doc type doesn't carry a given field.
 */
function richItemVM(it: RawRow, i: number): LineItemVM {
  const qty = num(it, "quantity", "qty", "receivedQty", "orderedQty");
  const unit = num(it, "unitPriceSen", "priceSen", "unitCostSen");
  const line = num(it, "lineTotalSen", "amountSen", "totalSen") || unit * qty;

  const specs: NonNullable<LineItemVM["specs"]> = [];
  const category = str(it, "itemCategory", "category");
  if (category) specs.push({ label: "Category", value: category });
  const size = str(it, "sizeLabel", "sizeCode", "size");
  if (size) specs.push({ label: "Size", value: size });
  const fabric = str(it, "fabricCode", "fabric");
  if (fabric) specs.push({ label: "Fabric", value: fabric });
  // Per-line customer identifiers — only DO items carry these (the detail
  // endpoint joins each line's own sales order), so they surface on a
  // consolidated DO's line items and stay absent on SO / invoice / PI lines
  // (owner 2026-07-11: every line must show whose Cust PO / SO it is).
  const lineSO = str(it, "salesOrderNo");
  if (lineSO) specs.push({ label: "SO", value: lineSO });
  const lineCustPO = str(it, "customerPOId", "customerPO");
  if (lineCustPO) specs.push({ label: "Cust PO", value: lineCustPO });
  const lineCustSO = str(it, "customerSO", "customerSOId");
  if (lineCustSO) specs.push({ label: "Cust SO", value: lineCustSO });
  if (unit > 0) specs.push({ label: "Unit Price", value: money(unit) });

  return {
    id: str(it, "id", "lineNo") || String(i),
    title:
      str(it, "productName", "description", "itemDescription", "productCode") ||
      "—",
    subLine: str(it, "productCode", "itemCode", "sku") || undefined,
    specs: specs.length ? specs : undefined,
    chips: customizationChips(it),
    meta1: { label: "Qty", value: qty },
    meta2: { label: "Total", value: money(line) },
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

/** Rich variant of itemsOf — variant fields + customization chips. */
function richItemsOf(doc: RawRow, ...keys: string[]): LineItemVM[] {
  for (const k of keys) {
    const arr = doc[k];
    if (Array.isArray(arr)) return (arr as RawRow[]).map(richItemVM);
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
  // dc13 card shape (Hookka ERP Mobile.dc.html line ~1714):
  //   code · customer · items summary · [Cust PO · Cust SO · Hub · Exp DD]
  toVM: (r): RowVM => ({
    id: str(r, "id", "companySOId", "companySO"),
    code: str(r, "companySO", "companySOId") || "—",
    title: str(r, "customerName") || "—",
    items: summariseItems(r),
    metas: [
      { label: "Cust PO", value: str(r, "customerPO", "customerPOId") || "—" },
      { label: "Cust SO", value: str(r, "customerSO", "customerSOId") || "—" },
      { label: "Hub", value: str(r, "hubName", "hubShortName") || "—" },
      { label: "Exp DD", value: shortDate(dateOnly(r, "hookkaExpectedDD")) || "—" },
    ],
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
  // Header field card — every customer/order field the SO GET payload exposes
  // (owner 2026-06-28: "顾客的很多资料都没有接进来"). The SO record carries no
  // contact/address/payment-terms columns, so those are intentionally NOT shown
  // (the API doesn't return them — we don't fabricate fields).
  fields: [
    fld("Customer", (d) => str(d, "customerName")),
    fld("State", (d) => str(d, "customerState")),
    fld("Customer SO", (d) => str(d, "customerSO", "customerSOId")),
    fld("Customer PO", (d) => str(d, "customerPO", "customerPOId")),
    fld("Customer PO Date", (d) => dateOnly(d, "customerPODate")),
    fld("Order Date", (d) => dateOnly(d, "companySODate")),
    fld("Expected DD", (d) => dateOnly(d, "hookkaExpectedDD")),
    fld("Customer Delivery", (d) => dateOnly(d, "customerDeliveryDate")),
    fld("Delivery Hub", (d) => str(d, "hubName")),
    fld("Reference", (d) => str(d, "reference")),
    fld("Items", (d) =>
      String(Array.isArray(d.items) ? (d.items as unknown[]).length : 0)),
    fld("Amount", (d) => money(num(d, "totalSen"))),
    fld("Notes", (d) => str(d, "notes"), true),
  ],
  lineItems: (d) => richItemsOf(d, "items"),
  // Summary card (design source: Total Qty / Line Items / Subtotal). Derived
  // from the SO's own items + total — no extra fetch.
  kvSections: (d) => {
    const items = Array.isArray(d.items) ? (d.items as RawRow[]) : [];
    if (items.length === 0) return [];
    const totalQty = items.reduce((s, it) => s + num(it, "quantity", "qty"), 0);
    return [
      {
        title: "Summary",
        rows: [
          { label: "Total Qty", value: String(totalQty) },
          { label: "Line Items", value: String(items.length) },
          { label: "Subtotal", value: money(num(d, "totalSen")) },
        ],
      },
    ];
  },
  // Linked Production Orders (design source: a card per PO with status + qty +
  // dept + delivery). Real data — the SO GET returns linkedPOs.
  subDocLists: (d, resp) => {
    const r = (resp ?? {}) as Record<string, unknown>;
    const pos = asArr(r.linkedPOs);
    if (pos.length === 0) return [];
    return [
      {
        title: "Linked Production Orders",
        rows: pos.map((p) => {
          const dept = str(p, "currentDepartment");
          const qty = num(p, "quantity");
          const doNo = str(p, "deliveryDoNo");
          return {
            id: str(p, "id") || str(p, "poNo"),
            title: str(p, "productName", "productCode") || "—",
            subLine:
              [
                qty ? `Qty ${qty}` : "",
                dept,
                doNo ? `DO ${doNo}` : "Not on a DO",
              ]
                .filter(Boolean)
                .join(" · ") || undefined,
            trailing: str(p, "poNo") || undefined,
            status: resolveStatus(str(p, "status"), STATUS_MAPS.production),
            icon: "package" as const,
            href: undefined, // production-order mobile detail route TBD
          };
        }),
      },
    ];
  },
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
  // dc12 design v12: doc detail has file attachments. Resource type "SO"
  // matches the desktop convention (so files uploaded from mobile show up on
  // the desktop attachment list, and vice versa).
  attachmentsResource: (id) => ({ type: "SO", id }),
  auditResource: () => "sales-orders",
  lineAttachmentsResource: (_parent, lineId) => ({ type: "SO_LINE", id: lineId }),
  // dc13 v13 sync (owner 2026-06-29): "Copy SO" — matches the desktop's
  // existing clone flow (src/pages/sales/detail.tsx → "Copy" button which
  // writes localStorage.so-clone-data + navigates to /sales/create?clone=1).
  // Mobile re-uses that pipeline: fetch the SO doc fresh, write the exact
  // payload shape desktop reads, then deep-link to desktop /sales/create.
  // The user lands on the desktop create form fully prefilled — owner can
  // tweak + save there. No new backend needed.
  extraActions: (_d, id) => [
    {
      label: "Copy SO",
      icon: "copy",
      primary: true,
      onClick: async (navigate) => {
        try {
          const res = await fetch(
            `/api/sales-orders/${encodeURIComponent(id)}`,
          );
          const j = (await res.json().catch(() => null)) as
            | { success?: boolean; data?: Record<string, unknown> }
            | null;
          if (!res.ok || !j?.success || !j.data) {
            window.alert("Could not load SO to copy.");
            return;
          }
          // Match desktop's so-clone-data shape: the entire SO record,
          // including header + items, becomes the prefill payload. Desktop
          // /sales/create on mount reads this and hydrates the form.
          window.localStorage.setItem(
            "so-clone-data",
            JSON.stringify(j.data),
          );
          navigate("/sales/create?clone=1");
        } catch {
          window.alert("Copy failed — please try again.");
        }
      },
    },
  ],
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
  // Part of the delivery cross-source search group (DO side of an order's life).
  crossSearch: true,
  // v17 card shape (line ~1744): code · customer · "hub · vehicle/driver" · [Dispatch · SO]
  toVM: (r): RowVM => {
    const hub = str(r, "hubName", "hubShortName");
    const veh = str(r, "vehicleNo", "driverName", "providerName");
    return {
      id: str(r, "id", "doNo"),
      code: str(r, "doNo") || "—",
      title: str(r, "customerName") || "—",
      items: [hub, veh].filter(Boolean).join(" · ") || undefined,
      metas: [
        { label: "Dispatch", value: shortDate(dateOnly(r, "dispatchDate", "deliveryDate")) || "—" },
        { label: "SO", value: str(r, "companySO", "companySOId") || "—" },
      ],
      status: resolveStatus(str(r, "status"), STATUS_MAPS.delivery),
    };
  },
  columns: [
    textCol("doNo", "Customer Delivery", (r) => str(r, "doNo")),
    textCol("companySO", "Company SO", (r) => str(r, "companySO", "companySOId")),
    // customerPO + reference kept searchable (owner 2026-07-04: "PO 也 search
    // 不到" — the DO tabs lacked these columns, so a PO/reference query missed).
    textCol("customerPO", "Customer PO", (r) => str(r, "customerPO", "customerPOId")),
    textCol("customerSO", "Customer SO", (r) => str(r, "customerSO", "customerSOId")),
    textCol("reference", "Reference", (r) => str(r, "reference")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    textCol("state", "State", (r) => str(r, "customerState")),
    dateCol("deliveryDate", "Expected DD", (r) => dateOnly(r, "deliveryDate", "hookkaExpectedDD")),
    numCol("items", "Items", (r) => num(r, "totalItems")),
    numCol("amount", "Amount", (r) => num(r, "valueSen")),
    enumCol("status", "Status", (r) => str(r, "status"), DO_STATUSES),
  ],
  defaultSort: { key: "deliveryDate", dir: "desc" },
  // Design 2026-07: a DO only exists from Pending Dispatch onward, so the DO
  // source only feeds Dispatch / Dispatched / Delivered. Planning + Pending
  // Delivery are SALES ORDERS (no DO yet) — see pendingSosSource below.
  subTabs: [
    { key: "dispatch", label: "Pending Dispatch", match: (r) => ["DRAFT", "LOADED"].includes(str(r, "status")) },
    { key: "dispatched", label: "Dispatched", match: (r) => ["DISPATCHED", "IN_TRANSIT"].includes(str(r, "status")) },
    { key: "delivered", label: "Delivered", match: (r) => ["DELIVERED", "SIGNED", "INVOICED"].includes(str(r, "status")) },
  ],
};

// Planning + Pending Delivery = confirmed/ready Sales Orders that have NO DO
// yet (design 2026-07 / INDEX rule 7: "never show a DO in Planning / Pending").
// Backed by GET /api/delivery-orders/pending-sos. Rows are SALES ORDERS, so a
// tap opens the SO detail (see deliveryConfig.detailPath).
const pendingSosSource: DataSource = {
  url: "/api/delivery-orders/pending-sos",
  select: selectData,
  // Part of the delivery cross-source search group (Sales-Order side — an order
  // still in Planning / Pending Delivery, before any DO exists).
  crossSearch: true,
  // Owner 2026-07-04: a Planning/Pending card must show all five identifiers
  // he reconciles against — our SO number (the big code), customer name, and
  // Customer PO / Reference / Customer SO as metas (DocCard flows 4 metas
  // 3-across + 1). Exp DD rides along as the 4th meta.
  // Owner 2026-07-11: the card code must show the REAL SO id he reconciles
  // against (SO-2607-090), not the "Sales Order 090" label. Reference rides on
  // the same line (SO-2607-090 · ZNT5377) so he can tell orders apart at a
  // glance; Cust PO / Cust SO / Exp DD / Amount fill the footer metas.
  toVM: (r): RowVM => {
    const soid = str(r, "companySOId", "companySO") || "—";
    const ref = str(r, "reference");
    return {
      id: str(r, "id", "companySO", "companySOId"),
      code: ref ? `${soid} · ${ref}` : soid,
      title: str(r, "customerName") || "—",
      items: str(r, "hubName") ? `Ship to · ${str(r, "hubName")}` : undefined,
      metas: [
        { label: "Cust PO", value: str(r, "customerPO", "customerPOId") || "—" },
        { label: "Cust SO", value: str(r, "customerSO", "customerSOId") || "—" },
        { label: "Exp DD", value: shortDate(dateOnly(r, "hookkaExpectedDD")) || "—" },
        { label: "Amount", value: money(num(r, "totalSen")) },
      ],
      status: resolveStatus(str(r, "status"), STATUS_MAPS.so),
    };
  },
  columns: [
    textCol("companySO", "Company SO", (r) => str(r, "companySO", "companySOId")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    textCol("customerPO", "Customer PO", (r) => str(r, "customerPO", "customerPOId")),
    textCol("customerSO", "Customer SO", (r) => str(r, "customerSO", "customerSOId")),
    textCol("reference", "Reference", (r) => str(r, "reference")),
    dateCol("expectedDD", "Expected DD", (r) => dateOnly(r, "hookkaExpectedDD")),
    enumCol("status", "Status", (r) => str(r, "status"), SO_STATUSES),
  ],
  defaultSort: { key: "expectedDD", dir: "asc" },
  subTabs: [
    { key: "planning", label: "Planning", match: (r) => str(r, "planTab") === "planning" },
    { key: "pending", label: "Pending Delivery", match: (r) => str(r, "planTab") === "pending" },
  ],
};

// Packing List source — v17 delivery sub-tab "packing". /api/packing-lists
// returns packing-list rows with revenueSen + totalM3 + doCount + stops
// (computed at the list endpoint). Card per v17 line ~1751:
//   PL-... · "Packing List · KL" · "N DOs · N stops · N units" · [M³ · Revenue]
const packingListsSource: DataSource = {
  url: "/api/packing-lists",
  select: selectData,
  toVM: (r): RowVM => {
    const doCount = num(r, "doCount");
    const stops = num(r, "stopCount", "stops");
    const units = num(r, "totalUnits");
    return {
      id: str(r, "id", "packingNo"),
      code: str(r, "packingNo") || "—",
      title: `Packing List · ${str(r, "hubState", "state") || "—"}`,
      items: `${doCount} DO${doCount === 1 ? "" : "s"} · ${stops} stop${stops === 1 ? "" : "s"} · ${units} unit${units === 1 ? "" : "s"}`,
      metas: [
        { label: "M³", value: num(r, "totalM3") > 0 ? num(r, "totalM3").toFixed(2) : "—" },
        { label: "Revenue", value: money(num(r, "revenueSen")) },
      ],
      status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
    };
  },
  columns: [
    textCol("packingNo", "Reference", (r) => str(r, "packingNo")),
    numCol("doCount", "Items", (r) => num(r, "doCount")),
    numCol("revenue", "Amount", (r) => num(r, "revenueSen")),
  ],
  defaultSort: { key: "packingNo", dir: "desc" },
  subTabs: [{ key: "packing", label: "Packing List", match: () => true }],
};

const threePlSource: DataSource = {
  url: "/api/drivers",
  select: selectData,
  // v17 (line ~1885): code · provider · "on-demand · N vehicles" · [Coverage · Fleet · On-time]
  toVM: (r): RowVM => {
    const fleet = num(r, "fleetSize", "vehicleCount") || 1;
    return {
      id: str(r, "id"),
      code: str(r, "vehicleNo") || str(r, "id"),
      title: str(r, "name") || "—",
      items: [str(r, "vehicleType", "serviceType"), `${fleet} vehicle${fleet === 1 ? "" : "s"}`].filter(Boolean).join(" · ") || undefined,
      metas: [
        { label: "Coverage", value: str(r, "coverage", "region", "state") || "—" },
        { label: "Fleet", value: String(fleet) },
        { label: "On-time", value: num(r, "onTimePct") > 0 ? `${num(r, "onTimePct")}%` : "—" },
      ],
      status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
    };
  },
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
    // A DO can consolidate several sales orders — the backend joins them into
    // salesOrderNos ("SO-x, SO-y") and aggregates the customer identifiers so a
    // consolidated DO no longer shows a blank header (owner 2026-07-11).
    fld("Sales Order", (d) => str(d, "salesOrderNos", "companySO", "companySOId")),
    fld("Customer", (d) => str(d, "customerName")),
    fld("Customer PO", (d) => str(d, "customerPOId", "customerPO")),
    fld("Customer SO", (d) => str(d, "customerSO", "customerSOId")),
    fld("State", (d) => str(d, "hubState", "customerState")),
    fld("Expected DD", (d) => dateOnly(d, "deliveryDate", "hookkaExpectedDD")),
    fld("Driver", (d) => str(d, "driverName")),
    fld("Vehicle", (d) => str(d, "vehicleNo", "vehicleType")),
    fld("Contact", (d) => str(d, "contactPerson")),
    fld("Phone", (d) => str(d, "contactPhone")),
    fld("Items", (d) => String(num(d, "totalItems"))),
    fld("Reference", (d) => str(d, "reference")),
    fld("Delivery Address", (d) => str(d, "deliveryAddress"), true),
  ],
  // DO items carry Size + Fabric (and customization where present) — show them.
  lineItems: (d) => richItemsOf(d, "items"),
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
    // Customer cross-link (design DO detail links the Customer). DO GET returns customerId.
    const custId = str(d, "customerId");
    if (custId) {
      out.push({
        id: custId,
        group: "Customer",
        code: str(d, "customerName") || "Customer",
        href: `/m/customers/${encodeURIComponent(custId)}`,
      });
    }
    return out;
  },
  // "Mark Delivered" opens the POD capture sheet (signature + photos) and, on
  // confirm, PUTs proofOfDelivery + status DELIVERED — the desktop flow. Hidden
  // once the DO is delivered/invoiced.
  primaryCta: (d) => {
    const s = str(d, "status");
    return s === "DELIVERED" || s === "INVOICED" ? undefined : "Mark Delivered";
  },
  attachmentsResource: (id) => ({ type: "DO", id }),
  auditResource: () => "delivery-orders",
  lineAttachmentsResource: (_parent, lineId) => ({ type: "DO_LINE", id: lineId }),
};

export const deliveryConfig: ModuleConfig = {
  slug: "delivery",
  title: "Delivery",
  // DO rows → DO detail; Planning/Pending rows are Sales Orders → SO detail;
  // packing-list + 3PL rows (no doNo, no companySO) have no document detail.
  detailPath: (vm, row) =>
    str(row, "doNo")
      ? `/m/delivery/${encodeURIComponent(vm.id)}`
      : str(row, "companySO", "companySOId")
        ? `/m/sales/${encodeURIComponent(str(row, "id", "companySO", "companySOId"))}`
        : null,
  detail: deliveryDetail,
  sources: [pendingSosSource, deliveryOrdersSource, packingListsSource, threePlSource],
  // One search finds an order whether it's still a Sales Order (Planning /
  // Pending Delivery) or already a Delivery Order (owner 2026-07-11). Merges
  // matches from the two crossSearch sources above.
  crossSourceSearch: true,
};

// ---------------------------------------------------------------------------
// INVOICES — six sources.
// Invoices / Payments / Supplier Pay / Credit Notes / Debit Notes / e-Invoice.
// ---------------------------------------------------------------------------
const invoicesSource: DataSource = {
  url: "/api/invoices",
  select: selectData,
  // dc13 card shape (line ~1739):
  //   code · customer · SO/DO ref · [Due · Balance/Amount]
  toVM: (r): RowVM => ({
    id: str(r, "id", "invoiceNo"),
    code: str(r, "invoiceNo") || "—",
    title: str(r, "customerName") || "—",
    items: str(r, "companySO", "companySOId", "doNo") || undefined,
    metas: [
      { label: "Due", value: shortDate(dateOnly(r, "dueDate")) || "—" },
      {
        label: num(r, "paidAmount") > 0 && num(r, "paidAmount") < num(r, "totalSen") ? "Balance" : "Amount",
        value: money(num(r, "totalSen") - num(r, "paidAmount") || num(r, "totalSen")),
      },
    ],
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
    fld("Paid", (d) => money(num(d, "paidAmount"))),
    fld("Outstanding", (d) => money(num(d, "totalSen") - num(d, "paidAmount"))),
    fld("Customer PO", (d) => str(d, "customerPOId")),
  ],
  // Invoice items carry the full variant set (Category/Size/Fabric + leg/divan/
  // gap/special) — show them like the desktop invoice line table.
  lineItems: (d) => richItemsOf(d, "items"),
  // Payments — real invoice_payments[] from GET /api/invoices/:id (rowToPayment:
  // date · amountSen · method · reference). Design invoice detail = a transactional
  // Total/Paid/Balance doc; the Paid field above + this list give the payment record.
  subDocLists: (d) => {
    const pays = asArr(d.payments);
    if (pays.length === 0) return [];
    return [
      {
        title: `Payments · ${pays.length}`,
        rows: pays.map((p, i) => ({
          id: str(p, "id") || `pay-${i}`,
          title: money(num(p, "amountSen")),
          subLine: [dateOnly(p, "date"), str(p, "method"), str(p, "reference")]
            .filter(Boolean)
            .join(" · ") || undefined,
          icon: "file-text" as const,
        })),
      },
    ];
  },
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
    const custId = str(d, "customerId");
    if (custId) {
      out.push({
        id: custId,
        group: "Customer",
        code: str(d, "customerName") || "Customer",
        href: `/m/customers/${encodeURIComponent(custId)}`,
      });
    }
    return out;
  },
  primaryCta: (d) => (str(d, "status") === "PAID" ? "Status" : "Record Payment"),
  attachmentsResource: (id) => ({ type: "INVOICE", id }),
  auditResource: () => "invoices",
  lineAttachmentsResource: (_parent, lineId) => ({ type: "INVOICE_LINE", id: lineId }),
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
  // dc13 (line ~1753): code · supplier · items summary · [ETA · Amount]
  toVM: (r): RowVM => ({
    id: str(r, "id", "poNo"),
    code: str(r, "poNo") || "—",
    title: str(r, "supplierName") || "—",
    items: summariseItems(r),
    metas: [
      { label: "ETA", value: shortDate(dateOnly(r, "expectedDate")) || "—" },
      { label: "Amount", value: money(num(r, "totalSen")) },
    ],
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
  // dc13 (line ~1756): code · supplier · "PO-... · full/partial" · [Date · Lines]
  toVM: (r): RowVM => {
    const items = Array.isArray(r.items) ? (r.items as RawRow[]) : [];
    const matched = items.filter((i) => num(i, "receivedQty") > 0).length;
    const total = items.length;
    const sub = str(r, "poRef", "poNo");
    return {
      id: str(r, "id", "grnNo"),
      code: str(r, "grnNo") || "—",
      title: str(r, "supplierName") || "—",
      items: sub ? `${sub} · ${matched === total ? "full" : "partial"}` : undefined,
      metas: [
        { label: "Date", value: shortDate(dateOnly(r, "receivedDate", "createdAt")) || "—" },
        { label: "Lines", value: total === matched ? `${total}` : `${matched}/${total}` },
      ],
      status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
    };
  },
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
  // dc13 (line ~1758): code · supplier · "GRN-... · matched" · [Due · Amount]
  toVM: (r): RowVM => {
    const grn = str(r, "grnRef", "grnNo");
    const status = str(r, "status").toUpperCase();
    const sub = grn
      ? `${grn} · ${status === "MISMATCH" ? "mismatch" : "matched"}`
      : str(r, "poRef", "poNo") || undefined;
    return {
      id: str(r, "id", "piNo"),
      code: str(r, "piNo") || "—",
      title: str(r, "supplier", "supplierName") || "—",
      items: sub,
      metas: [
        { label: "Due", value: shortDate(dateOnly(r, "dueDate")) || "—" },
        { label: "Amount", value: money(num(r, "amountSen", "totalSen")) },
      ],
      status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
    };
  },
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
  // Supplier cross-link (design procurement detail links the Supplier). PO GET
  // returns supplierId. (The design's Goods-Receipt link is NOT backable — the
  // PO GET attaches no receipts array — so it is intentionally omitted.)
  relatedDocs: (d) => {
    const supId = str(d, "supplierId");
    if (!supId) return [];
    return [
      {
        id: supId,
        group: "Supplier",
        code: str(d, "supplierName") || "Supplier",
        href: `/m/suppliers/${encodeURIComponent(supId)}`,
      },
    ];
  },
  // Convert document (owner 2026-06-28 design v10): PO → Goods Receipt / PO →
  // Purchase Invoice. Both deep-link to the existing desktop convert pages
  // (?poId=<id>), which prefill from the PO — the real, working conversion
  // flows. (A native mobile GRN/PI capture form is a larger build; until then
  // these route to the proven desktop forms rather than fabricating a result.)
  // TODO(api): a one-shot POST /api/grn?fromPoId / purchase-invoices fromPoId
  // would let us build the conversion fully in-app without leaving /m.
  extraActions: (_d, id) => [
    {
      label: "Convert to GRN",
      to: `/procurement/grn/create?poId=${encodeURIComponent(id)}`,
      icon: "package-check",
    },
    {
      label: "Convert to Invoice",
      to: `/procurement/pi/create?poId=${encodeURIComponent(id)}`,
      icon: "receipt",
      primary: true,
    },
  ],
  // Receivable POs (Confirmed / Submitted / Partial) → "Receive (GRN)" opens the
  // mobile goods-receipt sheet; else Submit (Draft) / Status. Matches the desktop
  // GRN-eligible statuses (procurement/grn.tsx).
  primaryCta: (d) => {
    const s = str(d, "status");
    if (["CONFIRMED", "SUBMITTED", "PARTIAL_RECEIVED"].includes(s)) return "Receive (GRN)";
    return s === "DRAFT" ? "Submit" : "Status";
  },
  attachmentsResource: (id) => ({ type: "PO", id }),
  auditResource: () => "purchase-orders",
  lineAttachmentsResource: (_parent, lineId) => ({ type: "PO_LINE", id: lineId }),
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
  attachmentsResource: (id) => ({ type: "GRN", id }),
  auditResource: () => "grn",
  lineAttachmentsResource: (_parent, lineId) => ({ type: "GRN_LINE", id: lineId }),
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
  attachmentsResource: (id) => ({ type: "PI", id }),
  auditResource: () => "purchase-invoices",
  lineAttachmentsResource: (_parent, lineId) => ({ type: "PI_LINE", id: lineId }),
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
  // fields=minimal drops the heavy piece_pics tree + ~20 unused PO fields
  // (halves the payload to the phone); include=jobCards keeps the per-dept
  // job cards the dept sub-tabs filter on (hasDept). Same rows + same fields
  // this config reads — purely a smaller payload. Mirrors dept.tsx / the
  // bespoke ProductionScreen, which already fetch this way.
  url: "/api/production-orders?fields=minimal&include=jobCards",
  select: selectData,
  // dc13 (line ~1765): code · product · "customer · SO-..." · [Our SO · Cust PO · Cust SO · Ref]
  toVM: (r): RowVM => {
    const cust = str(r, "customerName");
    const ourSO = str(r, "companySO", "companySOId");
    return {
      id: str(r, "id", "poNo"),
      code: str(r, "poNo") || "—",
      title: str(r, "productName", "productCode") || "—",
      items: cust || ourSO ? `${cust}${cust && ourSO ? " · " : ""}${ourSO}` : undefined,
      metas: [
        { label: "Our SO", value: ourSO || "—" },
        { label: "Cust PO", value: str(r, "customerPO", "customerPOId") || "—" },
        { label: "Cust SO", value: str(r, "customerSO", "customerSOId") || "—" },
        { label: "Ref", value: str(r, "reference", "currentDepartment") || "—" },
      ],
      status: resolveStatus(str(r, "status"), STATUS_MAPS.production),
    };
  },
  columns: [
    textCol("poNo", "Reference", (r) => str(r, "poNo")),
    textCol("product", "Customer", (r) => str(r, "productName", "productCode")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    // Owner 2026-07-05 ("9159 search 不到"): the PO metas (Our SO / Cust PO /
    // Cust SO / Ref) were DISPLAYED but not in the searchable columns, so a
    // customer PO/SO or Company SOID query missed. Add them so the operator can
    // find "what stage is this product at" by any of its reference numbers.
    textCol("companySO", "Our SO", (r) => str(r, "companySO", "companySOId")),
    textCol("customerPO", "Cust PO", (r) => str(r, "customerPO", "customerPOId")),
    textCol("customerSO", "Cust SO", (r) => str(r, "customerSO", "customerSOId")),
    textCol("reference", "Ref", (r) => str(r, "reference")),
    numCol("qty", "Qty", (r) => num(r, "quantity")),
    dateCol("targetEndDate", "Expected DD", (r) => dateOnly(r, "targetEndDate")),
    enumCol("status", "Status", (r) => str(r, "status"), PROD_STATUSES),
  ],
  defaultSort: { key: "targetEndDate", dir: "asc" },
  subTabs: [
    // dc13 production tabs (line ~1765): Overview / Fab Cut / Fab Sew /
    // Foam / Wood Cut / Framing / Webbing / Upholstery / Packing
    { key: "all", label: "Overview", match: () => true },
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
  attachmentsResource: (id) => ({ type: "PRODUCTION_ORDER", id }),
  auditResource: () => "production-orders",
  lineAttachmentsResource: (_parent, lineId) => ({ type: "JOB_CARD", id: lineId }),
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
// PLANNING — v17 (line ~1795) has 4 distinct sub-tabs, each with its own
// data source + card metas:
//   cap    (Capacity Overview)  — per-dept worker count, backlog, utilization
//   load   (Capacity Loading)   — per-dept past avg hours, plan%
//   lead   (Lead Times)         — material shortages (Net + Lead time)
//   master (Master Tracker)     — per-SO progress (DD + Stage)
// Each maps to an existing endpoint — no new backend.

// cap + load share the same /api/department-performance source; sub-tab
// label changes + meta labels swap. Capacity = Backlog/Used, Loading =
// Workers/Plan.
const planningCapacitySource: DataSource = {
  url: (() => {
    const w = thisMonthWindow();
    return `/api/department-performance?from=${w.from}&to=${w.to}`;
  })(),
  select: (resp) => {
    if (!resp || typeof resp !== "object") return [];
    const o = resp as { data?: { departments?: unknown }; departments?: unknown };
    const list = (o.data?.departments ?? o.departments) as unknown;
    return Array.isArray(list) ? (list as RawRow[]) : [];
  },
  toVM: (r): RowVM => {
    const workers = num(r, "workerCount", "headcount") || 0;
    const hours = num(r, "totalHours", "hours") || 0;
    const used = num(r, "utilisationPct", "efficiencyPct") || 0;
    return {
      id: str(r, "departmentCode") || str(r, "code") || "—",
      code: str(r, "departmentName") || str(r, "departmentCode") || "—",
      title: str(r, "departmentName", "name") || str(r, "departmentCode") || "—",
      items: `${workers} worker${workers === 1 ? "" : "s"} · ${hours.toFixed(1)}h`,
      metas: [
        { label: "Backlog", value: num(r, "backlogDays") > 0 ? `${num(r, "backlogDays").toFixed(1)} d` : "—" },
        { label: "Used", value: used > 0 ? `${used.toFixed(0)}%` : "—" },
      ],
      status: resolveStatus("Occupied", PAYMENT_STATUS_MAP),
    };
  },
  columns: [
    textCol("dept", "Reference", (r) => str(r, "departmentCode")),
    numCol("workers", "Qty", (r) => num(r, "workerCount")),
    numCol("used", "Amount", (r) => num(r, "utilisationPct", "efficiencyPct")),
  ],
  defaultSort: { key: "used", dir: "desc" },
  subTabs: [{ key: "cap", label: "Capacity Overview", match: () => true }],
};

const planningLoadSource: DataSource = {
  url: (() => {
    const w = thisMonthWindow();
    return `/api/department-performance?from=${w.from}&to=${w.to}`;
  })(),
  select: (resp) => {
    if (!resp || typeof resp !== "object") return [];
    const o = resp as { data?: { departments?: unknown }; departments?: unknown };
    const list = (o.data?.departments ?? o.departments) as unknown;
    return Array.isArray(list) ? (list as RawRow[]) : [];
  },
  toVM: (r): RowVM => {
    const workers = num(r, "workerCount", "headcount") || 0;
    const hours = num(r, "totalHours", "hours") || 0;
    const plan = num(r, "plannedPct", "planUtilPct") || 0;
    return {
      id: `load-${str(r, "departmentCode") || str(r, "code")}`,
      code: `LOAD-${str(r, "departmentCode", "code") || "—"}`,
      title: str(r, "departmentName", "name") || str(r, "departmentCode") || "—",
      items: `Past avg ${hours.toFixed(1)}h`,
      metas: [
        { label: "Workers", value: String(workers) },
        { label: "Plan", value: plan > 0 ? `${plan.toFixed(0)}%` : "0%" },
      ],
      status: resolveStatus("Active", PAYMENT_STATUS_MAP),
    };
  },
  columns: [
    textCol("dept", "Reference", (r) => str(r, "departmentCode")),
    numCol("workers", "Qty", (r) => num(r, "workerCount")),
    numCol("hours", "Amount", (r) => num(r, "totalHours")),
  ],
  defaultSort: { key: "hours", dir: "desc" },
  subTabs: [{ key: "load", label: "Capacity Loading", match: () => true }],
};

// Lead Times — material shortages from /api/raw-materials. Items with
// balance < min stock or Low/Critical status surface as "shortage" rows.
const planningLeadSource: DataSource = {
  url: "/api/raw-materials",
  select: selectData,
  toVM: (r): RowVM => {
    const onHand = num(r, "balanceQty");
    const minStock = num(r, "minStock");
    const net = onHand - minStock;
    return {
      id: `lead-${str(r, "id", "itemCode")}`,
      code: `LT-${str(r, "itemCode", "code") || "—"}`,
      title: str(r, "description", "itemCode") || "—",
      items: `Required ${minStock} · on-hand ${onHand} ${str(r, "baseUOM") || ""}`.trim(),
      metas: [
        { label: "Net", value: `${net > 0 ? "+" : ""}${net} ${str(r, "baseUOM") || ""}`.trim() },
        { label: "Lead", value: num(r, "leadTimeDays") > 0 ? `${num(r, "leadTimeDays")} d` : "—" },
      ],
      status: resolveStatus(net < 0 ? "Shortage" : "Covered", PAYMENT_STATUS_MAP),
    };
  },
  columns: [
    textCol("code", "Reference", (r) => str(r, "itemCode")),
    textCol("desc", "Customer", (r) => str(r, "description")),
    numCol("net", "Qty", (r) => num(r, "balanceQty") - num(r, "minStock")),
  ],
  defaultSort: { key: "net", dir: "asc" },
  subTabs: [{ key: "lead", label: "Lead Times", match: (r) => num(r, "balanceQty") < num(r, "minStock") }],
};

// Master Tracker — per-SO row showing stage progress (which dept is
// currently working on it + DD). /api/production-orders carries this.
const planningMasterSource: DataSource = {
  url: "/api/production-orders",
  select: selectData,
  toVM: (r): RowVM => {
    const dept = str(r, "currentDepartment");
    const product = str(r, "productName", "productCode");
    const items = [product, dept].filter(Boolean).join(" · ");
    return {
      id: str(r, "id", "poNo"),
      code: str(r, "companySO", "companySOId", "poNo") || "—",
      title: str(r, "customerName") || "—",
      items: items || undefined,
      metas: [
        { label: "DD", value: shortDate(dateOnly(r, "targetEndDate")) || "—" },
        { label: "Stage", value: dept ? dept : "—" },
      ],
      status: resolveStatus(str(r, "status"), STATUS_MAPS.production),
    };
  },
  columns: [
    textCol("companySO", "Reference", (r) => str(r, "companySO", "companySOId")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    dateCol("targetEndDate", "Expected DD", (r) => dateOnly(r, "targetEndDate")),
    enumCol("status", "Status", (r) => str(r, "status"), PROD_STATUSES),
  ],
  defaultSort: { key: "targetEndDate", dir: "asc" },
  subTabs: [{ key: "master", label: "Master Tracker", match: () => true }],
};

export const planningConfig: ModuleConfig = {
  slug: "planning",
  title: "Planning",
  detailPath: (vm) => `/m/production/${encodeURIComponent(vm.id)}`,
  // v17 (line ~1795): Capacity / Loading / Lead Times / Master Tracker
  sources: [
    planningCapacitySource,
    planningLoadSource,
    planningLeadSource,
    planningMasterSource,
  ],
};

// ---------------------------------------------------------------------------
// WAREHOUSE — Rack Overview / Stock In-Out / Movement.
// /api/warehouse returns rack locations. Stock In-Out + Movement have no
// dedicated list endpoints (form / per-rack detail driven) → reuse warehouse
// rows as the closest live data. TODO: wire a movements list endpoint if one
// is added.
// ---------------------------------------------------------------------------
// Rack overview — v17 (line ~1815): code · "item name" · customer · [Items · Zone]
function warehouseSource(key: string, label: string): DataSource {
  return {
    url: "/api/warehouse",
    select: selectData,
    toVM: (r): RowVM => {
      const firstItem = Array.isArray(r.items) && (r.items as unknown[]).length
        ? (r.items as RawRow[])[0]
        : null;
      const itemName = firstItem ? str(firstItem, "productName", "productCode") : "";
      const customer = firstItem ? str(firstItem, "customerName") : "";
      return {
        id: str(r, "id"),
        code: [str(r, "rack"), str(r, "position")].filter(Boolean).join("-") || str(r, "id"),
        title: itemName || "Empty",
        items: customer || (itemName ? "" : "No items stocked") || undefined,
        metas: [
          { label: "Items", value: Array.isArray(r.items) ? (r.items as unknown[]).length : 0 },
          { label: "Zone", value: str(r, "zone", "area") || "—" },
        ],
        status: resolveStatus(str(r, "status"), {
          EMPTY: PAYMENT_STATUS_MAP.ACTIVE,
          OCCUPIED: PAYMENT_STATUS_MAP.SUBMITTED,
          RESERVED: PAYMENT_STATUS_MAP.PARTIAL,
        }),
      };
    },
    columns: [
      textCol("rack", "Reference", (r) => [str(r, "rack"), str(r, "position")].filter(Boolean).join("-")),
      textCol("zone", "State", (r) => str(r, "zone", "area")),
      numCol("items", "Items", (r) => (Array.isArray(r.items) ? (r.items as unknown[]).length : 0)),
      enumCol("status", "Status", (r) => str(r, "status"), ["EMPTY", "OCCUPIED", "RESERVED"]),
      // Owner 2026-07-05: find which rack a product sits on by the customer
      // PO/SO, our Company SOID, product code or customer name of ANY item on
      // the rack. Concatenate every item's identifiers into one searchable
      // column (str() no-ops on absent fields, so it degrades gracefully).
      textCol("contents", "Contents", (r) => {
        const items = Array.isArray(r.items) ? (r.items as RawRow[]) : [];
        return items
          .map((it) =>
            [
              str(it, "customerPOId", "customerPO"),
              str(it, "customerSO", "customerSOId"),
              str(it, "companySOId", "companySO"),
              str(it, "productCode"),
              str(it, "productName"),
              str(it, "customerName"),
            ]
              .filter(Boolean)
              .join(" "),
          )
          .join(" ");
      }),
    ],
    defaultSort: { key: "rack", dir: "asc" },
    subTabs: [{ key, label, match: () => true }],
  };
}

// Stock In/Out source (v17 line ~1819) — backed by /api/warehouse/movements
// (stock_movements rowToMovement shape). Cards:
//   IO-... · product · "IN/OUT · docRef · performedBy" · [Qty · When]
const stockInOutSource: DataSource = {
  url: "/api/warehouse/movements",
  select: selectData,
  toVM: (r): RowVM => {
    // type = STOCK_IN | STOCK_OUT | TRANSFER. Map STOCK_IN/OUT → IO sub-tab.
    const type = str(r, "type").toUpperCase();
    const dir = type === "STOCK_IN" ? "IN" : type === "STOCK_OUT" ? "OUT" : "";
    return {
      id: str(r, "id"),
      code: `IO-${str(r, "id").slice(0, 8)}`,
      title: str(r, "productName", "productCode") || "—",
      items: [dir, str(r, "docRef", "poNo", "salesOrderNo"), str(r, "performedBy")].filter(Boolean).join(" · ") || undefined,
      metas: [
        { label: "Qty", value: num(r, "quantity") },
        { label: "When", value: shortDate(dateOnly(r, "createdAt")) || "—" },
      ],
      status: resolveStatus(dir || "Active", PAYMENT_STATUS_MAP),
    };
  },
  columns: [
    textCol("product", "Customer", (r) => str(r, "productName", "productCode")),
    enumCol("type", "State", (r) => str(r, "type"), ["STOCK_IN", "STOCK_OUT", "TRANSFER"]),
    numCol("qty", "Qty", (r) => num(r, "quantity")),
    dateCol("when", "Order Date", (r) => dateOnly(r, "createdAt")),
  ],
  defaultSort: { key: "when", dir: "desc" },
  subTabs: [
    { key: "io", label: "Stock In/Out", match: (r) => ["STOCK_IN", "STOCK_OUT"].includes(str(r, "type").toUpperCase()) },
  ],
};

// Movement source (v17 line ~1821) — TRANSFER rows (rack-to-rack moves).
// Same endpoint, different type filter. Cards: MV-... · product · "rack · who" · [Qty · When]
const stockMovementSource: DataSource = {
  url: "/api/warehouse/movements",
  select: selectData,
  toVM: (r): RowVM => {
    const rack = str(r, "rackLabel", "rackLocationId");
    const who = str(r, "performedBy");
    return {
      id: str(r, "id"),
      code: `MV-${str(r, "id").slice(0, 8)}`,
      title: str(r, "productName", "productCode") || "—",
      items: [rack, who, str(r, "reason")].filter(Boolean).join(" · ") || undefined,
      metas: [
        { label: "Qty", value: num(r, "quantity") },
        { label: "When", value: shortDate(dateOnly(r, "createdAt")) || "—" },
      ],
      status: resolveStatus("Active", PAYMENT_STATUS_MAP),
    };
  },
  columns: [
    textCol("product", "Customer", (r) => str(r, "productName", "productCode")),
    textCol("rack", "Reference", (r) => str(r, "rackLabel")),
    numCol("qty", "Qty", (r) => num(r, "quantity")),
  ],
  defaultSort: { key: "rack", dir: "desc" },
  subTabs: [
    { key: "move", label: "Movement", match: (r) => str(r, "type").toUpperCase() === "TRANSFER" },
  ],
};

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
  // v17 (line ~1813): Rack Overview / Stock In-Out / Movement (each its own source)
  sources: [
    warehouseSource("rack", "Rack Overview"),
    stockInOutSource,
    stockMovementSource,
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

// Raw Material detail — single GET /api/raw-materials/:id + an extraFetches
// slot for the new GET /api/raw-materials/:id/used-in reverse-lookup (dc12
// design v12 L4: tap a material → see which products' BOMs use it).
const rawMaterialDetail: DetailConfig = {
  url: (id) => `/api/raw-materials/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "itemCode") || "—",
  title: (d) => str(d, "description") || str(d, "itemCode") || "—",
  fields: [
    fld("Item Code", (d) => str(d, "itemCode")),
    fld("Item Group", (d) => str(d, "itemGroup")),
    fld("Base UOM", (d) => str(d, "baseUOM")),
    fld("Balance Qty", (d) => {
      const q = num(d, "balanceQty");
      const u = str(d, "baseUOM");
      return `${q} ${u}`.trim();
    }),
    fld("Min Stock", (d) => {
      const m = num(d, "minStock");
      return m > 0 ? String(m) : "—";
    }),
    fld("Description", (d) => str(d, "description"), true),
  ],
  extraFetches: {
    a: {
      key: "usedIn",
      url: (id) => `/api/raw-materials/${encodeURIComponent(id)}/used-in`,
    },
    // Price Comparison (dc13 v13 sync, owner 2026-06-29) — per-material
    // supplier-price lookup. Hits /api/supplier-materials?materialCode=X
    // which we just extended to JOIN suppliers so each row carries
    // supplierName + supplierCode in the response. Backend ORDER BY
    // unitPrice ASC means the cheapest supplier comes first.
    b: {
      key: "supplierPrices",
      url: (id) =>
        `/api/supplier-materials?materialCode=${encodeURIComponent(id)}`,
    },
  },
  subDocLists: (_d, _resp, extras) => {
    const lists = [];

    const used = extras?.usedIn as
      | { data?: { products?: { productCode: string; productName: string; category?: string }[] } }
      | undefined;
    const products = used?.data?.products ?? [];
    if (products.length > 0) {
      lists.push({
        title: `Used in · ${products.length} product${products.length === 1 ? "" : "s"}`,
        rows: products.slice(0, 100).map((p) => ({
          id: p.productCode,
          title: p.productName || p.productCode,
          subLine: [p.productCode, p.category].filter(Boolean).join(" · ") || undefined,
          icon: "package" as const,
        })),
      });
    }

    const prices = extras?.supplierPrices as
      | {
          data?: {
            id: string;
            supplierId: string;
            supplierName?: string;
            supplierCode?: string;
            supplierSku?: string;
            unitPrice?: number;
            currency?: string;
            leadTimeDays?: number;
            moq?: number;
            isMainSupplier?: boolean;
          }[];
        }
      | undefined;
    const priceRows = prices?.data ?? [];
    if (priceRows.length > 0) {
      lists.push({
        title: `Suppliers · prices · ${priceRows.length}`,
        rows: priceRows.slice(0, 50).map((p) => {
          const cur = p.currency || "MYR";
          const price = typeof p.unitPrice === "number" ? p.unitPrice : 0;
          const priceLabel = `${cur === "MYR" ? "RM" : cur} ${price.toFixed(2)}`;
          const sub = [
            p.supplierSku ? `SKU ${p.supplierSku}` : "",
            p.leadTimeDays ? `LT ${p.leadTimeDays}d` : "",
            p.moq && p.moq > 0 ? `MOQ ${p.moq}` : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return {
            id: p.id,
            title: `${p.isMainSupplier ? "★ " : ""}${p.supplierName || p.supplierCode || p.supplierId}`,
            subLine: sub || undefined,
            trailing: priceLabel,
            icon: "package" as const,
          };
        }),
      });
    }

    return lists;
  },
  // Remove-only stock adjustment (damage / write-off / count-down). Opens the
  // adjustment form via runCta (inventory slug). Positive "found" stays desktop.
  primaryCta: () => "Reduce Stock",
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
  // Raw Material rows have a real per-id endpoint (+ /used-in reverse
  // lookup), so they navigate. FG / WIP / Fabrics / Stock Value / Adjustments
  // are different shapes — keep non-tappable until they get their own detail
  // configs. Sniff by id prefix: raw_materials.genId → "rm-…".
  detailPath: (vm) =>
    /^rm-/.test(vm.id)
      ? `/m/inventory/${encodeURIComponent(vm.id)}`
      : null,
  detail: rawMaterialDetail,
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
/** Current month window [1st .. month end] in YYYY-MM-DD — used by the
 * working-hour-entries + attendance summary sources. */
function thisMonthWindow(): { from: string; to: string } {
  const now = new Date();
  const yr = now.getFullYear();
  const mo = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const from = `${yr}-${pad(mo + 1)}-01`;
  const lastDay = new Date(yr, mo + 1, 0).getDate();
  const to = `${yr}-${pad(mo + 1)}-${pad(lastDay)}`;
  return { from, to };
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
  subTabs: [{ key: "directory", label: "Employee Master", match: () => true }],
};

const attendanceSource: DataSource = {
  url: `/api/attendance?date=${todayISO()}`,
  select: selectData,
  // CHANGELOG #19 — read-only attendance with GPS indicator + selfie flag.
  // Real fields per attendance.ts response: clockInLat/Lng, hasClockInPhoto,
  // workingMinutes, efficiencyPct. Read-only on mobile (just view data).
  toVM: (r): RowVM => {
    const gps = num(r, "clockInLat") !== 0 || num(r, "clockInLng") !== 0;
    const photo = read(r, "hasClockInPhoto") === true;
    const dept = str(r, "departmentName", "departmentCode");
    const flags = [gps ? "📍 GPS" : "", photo ? "📸 Photo" : ""].filter(Boolean).join(" · ");
    const workingMins = num(r, "workingMinutes");
    return {
      id: str(r, "id"),
      code: str(r, "date") || todayISO(),
      title: str(r, "employeeName") || "—",
      items: [dept, flags].filter(Boolean).join(" · ") || undefined,
      metas: [
        { label: "In", value: str(r, "clockIn") || "—" },
        { label: "Out", value: str(r, "clockOut") || "—" },
        { label: "Hours", value: workingMins > 0 ? `${(workingMins / 60).toFixed(1)}h` : "—" },
      ],
      status: resolveStatus(str(r, "status"), STATUS_MAPS.attendance),
    };
  },
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

// Working Hours sub-tab — per-worker monthly totals from the working-hour-
// entries summary endpoint (the same one Home's Worker Efficiency uses).
// Each row = one worker for the current month, total hours + days with
// entries.
const workingHoursSource: DataSource = {
  url: (() => {
    const w = thisMonthWindow();
    return `/api/working-hour-entries/summary?from=${w.from}&to=${w.to}`;
  })(),
  // /summary returns { data: [{workerId, totalHours, byDept, daysWithEntries}] }
  select: selectData,
  toVM: (r): RowVM => {
    const hrs = num(r, "totalHours");
    const days = num(r, "daysWithEntries");
    return {
      id: str(r, "workerId"),
      code: `${days}d`,
      title: str(r, "workerName") || str(r, "workerId") || "—",
      subLine: str(r, "workerEmpNo") || undefined,
      meta1: { label: "Hours", value: `${hrs.toFixed(1)}h` },
      meta2: { label: "Days", value: days },
    };
  },
  columns: [
    textCol("name", "Customer", (r) => str(r, "workerName")),
    textCol("empNo", "Reference", (r) => str(r, "workerEmpNo")),
    numCol("hours", "Qty", (r) => num(r, "totalHours")),
    numCol("days", "Items", (r) => num(r, "daysWithEntries")),
  ],
  defaultSort: { key: "hours", dir: "desc" },
  subTabs: [{ key: "hours", label: "Working Hours", match: () => true }],
};

// Dept Labor sub-tab — per-(dept × category) hours for the current month
// from /api/working-hour-entries/dept-category-summary. Each row = one
// department/category bucket.
const deptLaborSource: DataSource = {
  url: (() => {
    const w = thisMonthWindow();
    return `/api/working-hour-entries/dept-category-summary?from=${w.from}&to=${w.to}`;
  })(),
  // Response wraps the rows under `buckets` (the route shape):
  // { success, buckets: [{departmentCode, category, hours}] }.
  select: (resp) => {
    if (!resp || typeof resp !== "object") return [];
    const o = resp as { buckets?: unknown; data?: { buckets?: unknown } };
    const buckets = (o.buckets ?? o.data?.buckets) as unknown;
    return Array.isArray(buckets) ? (buckets as RawRow[]) : [];
  },
  toVM: (r): RowVM => {
    const hrs = num(r, "hours");
    const dept = str(r, "departmentCode") || "—";
    const cat = str(r, "category");
    return {
      id: `${dept}-${cat || "all"}`,
      code: dept,
      title: cat || dept,
      subLine: cat ? dept : undefined,
      meta1: { label: "Hours", value: `${hrs.toFixed(1)}h` },
    };
  },
  columns: [
    textCol("dept", "Reference", (r) => str(r, "departmentCode")),
    textCol("category", "State", (r) => str(r, "category")),
    numCol("hours", "Qty", (r) => num(r, "hours")),
  ],
  defaultSort: { key: "hours", dir: "desc" },
  subTabs: [{ key: "deptlabor", label: "Dept Labor", match: () => true }],
};

// Employee Performance sub-tab (dc13 v13 sync, owner 2026-06-29 — backed
// by existing /api/working-hour-entries/summary, same endpoint the
// "Working Hours" tab uses but presented as a per-worker performance
// view: total hours + day-count + ratio. Sorted by hours desc.
const empPerfSource: DataSource = {
  url: (() => {
    const w = thisMonthWindow();
    return `/api/working-hour-entries/summary?from=${w.from}&to=${w.to}`;
  })(),
  select: selectData,
  toVM: (r): RowVM => {
    const hours = num(r, "totalHours");
    const days = num(r, "daysWithEntries");
    const perDay = days > 0 ? hours / days : 0;
    return {
      id: str(r, "workerId") || str(r, "id"),
      code: str(r, "workerId") || "—",
      title: str(r, "name", "workerName") || str(r, "workerId") || "—",
      subLine: `${days} day${days === 1 ? "" : "s"} logged`,
      meta1: { label: "Hours", value: `${hours.toFixed(1)}h` },
      meta2: { label: "Per Day", value: `${perDay.toFixed(1)}h` },
    };
  },
  columns: [
    textCol("workerId", "Reference", (r) => str(r, "workerId")),
    numCol("hours", "Qty", (r) => num(r, "totalHours")),
    numCol("days", "Amount", (r) => num(r, "daysWithEntries")),
  ],
  defaultSort: { key: "hours", dir: "desc" },
  subTabs: [{ key: "emp-perf", label: "Emp Perf", match: () => true }],
};

// Labor vs Revenue sub-tab (CHANGELOG #7 K.5) — production revenue
// recognized at UPHOLSTERY completion, per completed PO. Backend
// /api/working-hour-entries/production-revenue returns
// { SOFA, BEDFRAME, ACCESSORY, totalSen, rows[], byDeptCategory }.
const laborRevenueSource: DataSource = {
  url: (() => {
    const w = thisMonthWindow();
    return `/api/working-hour-entries/production-revenue?from=${w.from}&to=${w.to}`;
  })(),
  select: (resp) => {
    if (!resp || typeof resp !== "object") return [];
    const o = resp as { data?: { rows?: unknown[] } };
    return Array.isArray(o.data?.rows) ? (o.data.rows as RawRow[]) : [];
  },
  toVM: (r): RowVM => ({
    id: `${str(r, "date")}-${str(r, "productCode")}-${str(r, "soNo")}`,
    code: str(r, "soNo") || "—",
    title: str(r, "customerName") || "—",
    items: [str(r, "productName") || str(r, "productCode"), `×${num(r, "qty")}`].filter(Boolean).join(" "),
    metas: [
      { label: "Category", value: str(r, "category") || "—" },
      { label: "Revenue", value: money(num(r, "totalPriceSen")) },
      { label: "When", value: shortDate(dateOnly(r, "date")) || "—" },
    ],
    status: resolveStatus(str(r, "category"), {
      SOFA: PAYMENT_STATUS_MAP.SUBMITTED,
      BEDFRAME: PAYMENT_STATUS_MAP.PARTIAL,
      ACCESSORY: PAYMENT_STATUS_MAP.ACTIVE,
    }),
  }),
  columns: [
    textCol("soNo", "Reference", (r) => str(r, "soNo")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    textCol("category", "State", (r) => str(r, "category")),
    numCol("revenue", "Amount", (r) => num(r, "totalPriceSen")),
    dateCol("date", "Order Date", (r) => dateOnly(r, "date")),
  ],
  defaultSort: { key: "date", dir: "desc" },
  subTabs: [
    { key: "labrev", label: "Labor Cost", match: () => true },
    { key: "labrev-sofa", label: "Sofa", match: (r) => str(r, "category") === "SOFA" },
    { key: "labrev-bed", label: "Bedframe", match: (r) => str(r, "category") === "BEDFRAME" },
    { key: "labrev-acc", label: "Accessory", match: (r) => str(r, "category") === "ACCESSORY" },
  ],
};

// Efficiency — the design's `eff` tab (Worker Efficiency = production mins ÷
// clocked hours). Real data via GET /api/reports/efficiency.json → EfficiencyData
// (efficiency-report.ts): data.workers[] each { name, departmentName,
// efficiencyPct, jobsCompleted, productionMinutes }. Sorted by efficiency desc.
const efficiencySource: DataSource = {
  url: "/api/reports/efficiency.json",
  select: (resp) => {
    const w = (resp as { data?: { workers?: unknown[] } } | null)?.data?.workers;
    return Array.isArray(w) ? (w as RawRow[]) : [];
  },
  toVM: (r): RowVM => {
    const eff = num(r, "efficiencyPct");
    const prod = num(r, "productionMinutes");
    return {
      id: str(r, "workerId", "empNo") || str(r, "name"),
      code: str(r, "empNo") || str(r, "departmentName") || "—",
      title: str(r, "name") || "—",
      items: str(r, "departmentName") || undefined,
      metas: [
        { label: "Efficiency", value: eff > 0 ? `${eff}%` : "—" },
        { label: "Jobs", value: String(num(r, "jobsCompleted")) },
        { label: "Prod", value: prod > 0 ? `${(prod / 60).toFixed(1)}h` : "—" },
      ],
      // Colour by efficiency band (green ≥100 · amber ≥60 · red <60), matching the
      // report's own thresholds; no real "status" string on the row.
      status: resolveStatus(
        eff >= 100 ? "GREEN" : eff >= 60 ? "AMBER" : "RED",
        {
          GREEN: PAYMENT_STATUS_MAP.ACTIVE,
          AMBER: PAYMENT_STATUS_MAP.PARTIAL,
          RED: PAYMENT_STATUS_MAP.CANCELLED,
        },
      ),
    };
  },
  columns: [
    textCol("name", "Customer", (r) => str(r, "name")),
    textCol("dept", "State", (r) => str(r, "departmentName")),
    numCol("efficiency", "Amount", (r) => num(r, "efficiencyPct")),
  ],
  defaultSort: { key: "efficiency", dir: "desc" },
  subTabs: [{ key: "efficiency", label: "Efficiency", match: () => true }],
};

// Department Performance sub-tab — /api/department-performance returns
// per-department utilization + output aggregates for the date range.
// dc13 v13 sync.
const deptPerfSource: DataSource = {
  url: (() => {
    const w = thisMonthWindow();
    return `/api/department-performance?from=${w.from}&to=${w.to}`;
  })(),
  // Response shape: { success, data: { departments: [{ departmentCode,
  // departmentName, totalHours, efficiency%, ... }] } } — peel the
  // departments array.
  select: (resp) => {
    if (!resp || typeof resp !== "object") return [];
    const o = resp as {
      data?: { departments?: unknown };
      departments?: unknown;
    };
    const list = (o.data?.departments ?? o.departments) as unknown;
    return Array.isArray(list) ? (list as RawRow[]) : [];
  },
  toVM: (r): RowVM => {
    const eff = num(r, "efficiencyPct", "efficiency");
    const hrs = num(r, "totalHours", "hours");
    return {
      id: str(r, "departmentCode") || str(r, "code") || "—",
      code: str(r, "departmentCode") || "—",
      title: str(r, "departmentName", "name") || str(r, "departmentCode") || "—",
      subLine: `${hrs.toFixed(0)}h logged`,
      meta1: {
        label: "Efficiency",
        value: eff > 0 ? `${eff.toFixed(0)}%` : "—",
      },
      meta2: { label: "Hours", value: `${hrs.toFixed(1)}h` },
    };
  },
  columns: [
    textCol("dept", "Reference", (r) => str(r, "departmentCode")),
    textCol("name", "Customer", (r) => str(r, "departmentName")),
    numCol("eff", "Qty", (r) => num(r, "efficiencyPct", "efficiency")),
    numCol("hrs", "Amount", (r) => num(r, "totalHours", "hours")),
  ],
  defaultSort: { key: "eff", dir: "desc" },
  subTabs: [{ key: "dept-perf", label: "Dept Perf", match: () => true }],
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

// Employee (worker) detail — single-GET /api/workers/:id → { data: worker }.
// dc12 design also wants an Attendance month bar + Payslips list, but those
// require multi-fetch infra not in DetailConfig yet (TODO: round 5+ extends
// the screen with extraFetches → currentMonth attendance + recent payslips).
// For now: HR-info fields only, which is the worker record we DO have. Same
// pattern as customerDetail — `detailPath` was returning null on directory
// rows (tap = dead); now they open with worker fields + status pill.
const employeeDetail: DetailConfig = {
  url: (id) => `/api/workers/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "empNo") || "—",
  title: (d) => str(d, "name") || "—",
  status: (d) => resolveStatus(str(d, "status"), PAYMENT_STATUS_MAP),
  fields: [
    fld("Employee No", (d) => str(d, "empNo")),
    fld("Department", (d) =>
      Array.isArray(d.departmentCodes) && (d.departmentCodes as unknown[]).length > 0
        ? (d.departmentCodes as string[]).join(", ")
        : str(d, "departmentCode"),
    ),
    fld("Position", (d) => str(d, "position")),
    fld("Phone", (d) => str(d, "phone")),
    fld("Nationality", (d) => str(d, "nationality")),
    fld("IC No", (d) => str(d, "icNumber")),
    fld("Passport No", (d) => str(d, "passportNumber")),
    fld("Join Date", (d) => dateOnly(d, "joinDate")),
    fld("Basic Salary", (d) => money(num(d, "basicSalarySen"))),
    fld("Efficiency Allowance", (d) => money(num(d, "efficiencyAllowanceSen"))),
    fld("OT Multiplier", (d) => {
      const ot = num(d, "otMultiplier");
      return ot > 0 ? `${ot}×` : "—";
    }),
    fld("Working Hours / Day", (d) => {
      const h = num(d, "workingHoursPerDay");
      return h > 0 ? `${h}h` : "—";
    }),
    fld("Working Days / Month", (d) => {
      const w = num(d, "workingDaysPerMonth");
      return w > 0 ? String(w) : "—";
    }),
    // Statutory flags rolled into one line — owner can see at a glance which
    // of EPF/SOCSO/EIS/PCB apply. Dual-keyed but typically all true.
    fld("Statutory", (d) => {
      const on = [
        d.epfEnabled === false ? null : "EPF",
        d.socsoEnabled === false ? null : "SOCSO",
        d.eisEnabled === false ? null : "EIS",
        d.pcbEnabled === false ? null : "PCB",
      ].filter(Boolean);
      return on.length > 0 ? on.join(" · ") : "—";
    }),
  ],
  // dc12 employee detail composites attendance + payslips into the same
  // screen via DocumentDetailScreen's extraFetches infra. Each slot is a
  // (id) => url builder; results land in subDocLists' `extras` arg.
  extraFetches: {
    a: {
      key: "attendance",
      url: (id) => {
        const now = new Date();
        const yr = now.getFullYear();
        const mo = now.getMonth(); // 0–11
        const pad = (n: number) => String(n).padStart(2, "0");
        const from = `${yr}-${pad(mo + 1)}-01`;
        const lastDay = new Date(yr, mo + 1, 0).getDate();
        const to = `${yr}-${pad(mo + 1)}-${pad(lastDay)}`;
        return `/api/attendance?employeeId=${encodeURIComponent(id)}&from=${from}&to=${to}`;
      },
    },
    b: {
      key: "payslips",
      url: (id) => `/api/payslips?employeeId=${encodeURIComponent(id)}`,
    },
  },
  // dc12: under the HR field grid we render two sub-doc lists — Attendance ·
  // <month> (one row per day with status + clock-in/out times) and Payslips
  // (recent stored payslips, tap → /m/payslips/:id).
  subDocLists: (_d, _resp, extras) => {
    const out: SubDocList[] = [];
    const att = (extras?.attendance as { success?: boolean; data?: RawRow[] } | undefined)?.data ?? [];
    const pay = (extras?.payslips as { success?: boolean; data?: RawRow[] } | undefined)?.data ?? [];
    if (att.length > 0) {
      const recent = att.slice(0, 10);
      out.push({
        title: `Attendance · ${monthTitle()}`,
        rows: recent.map((a) => {
          const status = str(a, "status") || "—";
          const inOut = `${str(a, "clockIn") || "—"} / ${str(a, "clockOut") || "—"}`;
          return {
            id: str(a, "id") || dateOnly(a, "date"),
            title: dateOnly(a, "date") || "—",
            subLine: `${status} · ${inOut}`,
            icon: "file-text" as const,
          };
        }),
      });
    }
    if (pay.length > 0) {
      const recent = pay.slice(0, 12);
      out.push({
        title: "Payslips",
        rows: recent.map((p) => {
          const period = str(p, "period") || "—";
          const net = num(p, "netPay", "netPaySen");
          const pid = str(p, "id");
          return {
            id: pid || period,
            title: period,
            subLine: `Net ${money(net)}`,
            trailing: str(p, "status") || undefined,
            icon: "file-text" as const,
            href: pid ? `/m/payslips/${encodeURIComponent(pid)}` : undefined,
          };
        }),
      });
    }
    return out;
  },
  // CHANGELOG K.7 + K.1: Edit + admin actions + Log Hours. Office
  // portal has NO Clock In/Out — workers punch on /worker portal;
  // office user logs hours after the fact (matches desktop's
  // employees.tsx Working Hours tab — also Log Hours only).
  extraActions: (_d, id) => [
    {
      label: "Log Hours",
      icon: "file-text",
      formSpec: () => logHoursSpec(id),
      primary: true,
    },
    {
      label: "Set Scan PIN",
      icon: "package-check",
      onClick: async () => {
        if (!window.confirm("Generate a new scan PIN for this worker?")) return;
        try {
          const r = await fetch(`/api/workers/${encodeURIComponent(id)}/set-pin`, { method: "POST" });
          const j = (await r.json().catch(() => null)) as { success?: boolean; data?: { pin?: string }; error?: string } | null;
          if (r.ok && j?.success && j.data?.pin) {
            window.alert(`New PIN: ${j.data.pin}\n\nShown once — save it now.`);
          } else {
            window.alert(j?.error || "Failed to set PIN.");
          }
        } catch {
          window.alert("Network error.");
        }
      },
    },
  ],
};

/** Current-month title used by the Attendance sub-doc list header. */
function monthTitle(): string {
  const now = new Date();
  return now.toLocaleString("en-US", { month: "long", year: "numeric" });
}

export const employeesConfig: ModuleConfig = {
  slug: "employees",
  title: "Employees",
  // Two detail routes off this one module: Directory rows (worker id =
  // /^wkr-/ or any non-PS id) → employee detail. Payroll rows (PS-…) →
  // payslip detail. Attendance / Leave rows have no per-id office endpoint
  // for the design's composite — stay non-tappable.
  detailPath: (vm) => {
    if (/^PS-/.test(vm.id)) return `/m/payslips/${encodeURIComponent(vm.id)}`;
    // Directory rows are the only sub-tab whose vm.id is a real worker id
    // (workers.ts genId → "worker-XXXXXXXX"). Attendance / Leave / Payroll
    // rows have date/leave/PS-shaped ids that aren't valid /api/workers/:id
    // targets, so a prefix sniff gates the route safely.
    if (/^worker-/.test(vm.id)) return `/m/employees/${encodeURIComponent(vm.id)}`;
    return null;
  },
  detail: employeeDetail,
  // Design tab-bar (owner 2026-07-03 "完全照 design"): no Leave tab; Directory =
  // "Employee Master", Labor vs Revenue = "Labor Cost". Efficiency (design's `eff`
  // tab) now backed by GET /api/reports/efficiency.json (efficiencySource).
  // Tab order matches the .dc.html employees tab-bar exactly (owner: .dc.html为准):
  // Working Hours · Attendance · Labor Cost · Efficiency · Dept Labor ·
  // Employee Perf · Dept Perf · Payroll · Employee Master.
  sources: [
    workingHoursSource,
    attendanceSource,
    laborRevenueSource,
    efficiencySource,
    deptLaborSource,
    empPerfSource,
    deptPerfSource,
    payrollSource,
    directorySource,
  ],
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
  // dc13 (line ~1900): code · title · body preview · [Posted · By]
  toVM: (r): RowVM => {
    const body = str(r, "body", "description", "content");
    return {
      id: str(r, "id"),
      code: str(r, "category") || "Notice",
      title: str(r, "title") || "—",
      items: body ? (body.length > 80 ? body.slice(0, 79) + "…" : body) : undefined,
      metas: [
        { label: "Posted", value: shortDate(dateOnly(r, "createdAt")) || "—" },
        { label: "By", value: str(r, "createdBy", "createdByName") || "—" },
      ],
    };
  },
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
  // dc12: announcement detail shows a "Read X of Y" tracker + the workers
  // who acknowledged + who haven't. Backend already has GET /api/announcements/:id/acks
  // (the desktop admin uses it) — we just fetch it as the detail's extraFetches
  // slot and render two sub-doc lists below the body.
  extraFetches: {
    a: {
      key: "acks",
      url: (id) => `/api/announcements/${encodeURIComponent(id)}/acks`,
    },
  },
  subDocLists: (_d, _resp, extras) => {
    const ackResp = extras?.acks as
      | {
          success?: boolean;
          data?: {
            total?: number;
            ackedCount?: number;
            acked?: { id: string; name: string; empNo: string; ackedAt?: string | null }[];
            pending?: { id: string; name: string; empNo: string }[];
          };
        }
      | undefined;
    const ackData = ackResp?.data;
    if (!ackData) return [];
    const out: SubDocList[] = [];
    const total = Number(ackData.total ?? 0);
    const ackedCount = Number(ackData.ackedCount ?? 0);
    const acked = ackData.acked ?? [];
    const pending = ackData.pending ?? [];
    if (acked.length > 0) {
      out.push({
        title: `Acknowledged · ${ackedCount} / ${total}`,
        rows: acked.slice(0, 20).map((w) => ({
          id: w.id,
          title: w.name || w.empNo || w.id,
          subLine:
            [w.empNo, w.ackedAt ? new Date(w.ackedAt).toLocaleString() : ""]
              .filter(Boolean)
              .join(" · ") || undefined,
          icon: "file-text" as const,
        })),
      });
    }
    if (pending.length > 0) {
      out.push({
        title: `Not yet · ${pending.length}`,
        rows: pending.slice(0, 50).map((w) => ({
          id: w.id,
          title: w.name || w.empNo || w.id,
          subLine: w.empNo || undefined,
          icon: "file-text" as const,
        })),
      });
    }
    return out;
  },
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
  // dc13 (line ~1906): code · counterparty · subject · [From/To · Date]
  toVM: (r): RowVM => ({
    id: str(r, "id"),
    code: read(r, "unread") === true ? "Unread" : "Read",
    title: str(r, "counterpartyName", "counterpartyEmail") || "—",
    items: str(r, "subject") || undefined,
    metas: [
      { label: "From", value: str(r, "counterpartyEmail") || "—" },
      { label: "Date", value: shortDate(dateOnly(r, "lastMessageAt")) || "—" },
    ],
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
// Customer detail — single-GET /api/customers/:id → { data: customer +
// deliveryHubs[] }. Per dc12 design, the detail surfaces the customer's
// header fields + the Delivery Hubs list (each hub = short-name + state +
// contact + phone, code as the right-aligned trailing meta). Add-Hub +
// Exports buttons from the design are deferred — they need an edit form +
// statement-PDF endpoints respectively (TODO: wire when those land).
const customerDetail: DetailConfig = {
  url: (id) => `/api/customers/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "code") || "—",
  title: (d) => str(d, "name") || "—",
  status: (d) =>
    read(d, "isActive") === true
      ? resolveStatus("ACTIVE", PAYMENT_STATUS_MAP)
      : resolveStatus("INACTIVE", PAYMENT_STATUS_MAP),
  fields: [
    fld("Code", (d) => str(d, "code")),
    fld("Contact", (d) => str(d, "contactName")),
    fld("Phone", (d) => str(d, "phone")),
    fld("Email", (d) => str(d, "email")),
    fld("SSM No", (d) => str(d, "ssmNo")),
    fld("Credit Terms", (d) => str(d, "creditTerms")),
    fld("Credit Limit", (d) => money(num(d, "creditLimitSen"))),
    fld("Outstanding", (d) => money(num(d, "outstandingSen"))),
    fld("Address", (d) => str(d, "companyAddress"), true),
  ],
  // Recent Orders (View History) — sub-fetch SOs for THIS customer to show
  // recent history below the hubs. CHANGELOG: "导出: Quotation PDF /
  // Catalogue PDF / View History". /api/sales-orders list is in localStorage
  // cache (preloaded) so this is fast.
  extraFetches: {
    a: { key: "soList", url: () => "/api/sales-orders" },
    b: { key: "invList", url: () => "/api/invoices" },
  },
  // Delivery Hubs + Recent Orders + Invoices. The design source's "Delivery
  // Hubs · N" sub-list plus a "Recent Orders · N" + "Invoices · N" reverse
  // lookup. Customer detail is read-only on mobile so these are display only.
  subDocLists: (d, _resp, extras, openForm) => {
    const cid = str(d, "id");
    const cname = str(d, "name");
    const lists: SubDocList[] = [];

    const hubs = asArr(d.deliveryHubs);
    if (hubs.length > 0) {
      const customerId = str(d, "id");
      lists.push({
        title: `Delivery Hubs · ${hubs.length}`,
        rows: hubs.map((h) => {
          const parts = [
            str(h, "state"),
            str(h, "contactName"),
            str(h, "phone"),
          ].filter(Boolean);
          return {
            id: str(h, "id"),
            title: str(h, "shortName") || str(h, "code") || "Hub",
            subLine: parts.length > 0 ? parts.join(" · ") : undefined,
            trailing: str(h, "code") || undefined,
            icon: "package" as const,
            // CHANGELOG #2 — tap a hub row to open the Edit form. Mirrors
            // desktop /customers per-hub inline editor. openForm comes from
            // DocumentDetailScreen via the subDocLists callback's 4th arg.
            onClick: openForm
              ? () => openForm(hubFormSpec(d, customerId, h))
              : undefined,
          };
        }),
      });
    }

    const soResp = extras?.soList as { data?: RawRow[] } | undefined;
    const sos = (soResp?.data ?? []).filter((s) =>
      str(s, "customerId") === cid || str(s, "customerName") === cname,
    );
    if (sos.length > 0) {
      lists.push({
        title: `Recent Orders · ${sos.length}`,
        rows: sos.slice(0, 20).map((s) => ({
          id: str(s, "id", "companySO"),
          title: str(s, "companySO", "companySOId") || "—",
          subLine: [shortDate(dateOnly(s, "companySODate")), str(s, "status")].filter(Boolean).join(" · ") || undefined,
          trailing: money(num(s, "totalSen")),
          href: `/m/sales/${encodeURIComponent(str(s, "id", "companySO"))}`,
          icon: "file-text" as const,
        })),
      });
    }

    const invResp = extras?.invList as { data?: RawRow[] } | undefined;
    const invs = (invResp?.data ?? []).filter((i) =>
      str(i, "customerId") === cid || str(i, "customerName") === cname,
    );
    if (invs.length > 0) {
      lists.push({
        title: `Invoices · ${invs.length}`,
        rows: invs.slice(0, 20).map((i) => ({
          id: str(i, "id", "invoiceNo"),
          title: str(i, "invoiceNo") || "—",
          subLine: [shortDate(dateOnly(i, "dueDate")), str(i, "status")].filter(Boolean).join(" · ") || undefined,
          trailing: money(num(i, "totalSen")),
          href: `/m/invoices/${encodeURIComponent(str(i, "id", "invoiceNo"))}`,
          icon: "file-text" as const,
        })),
      });
    }

    return lists;
  },
  // Edit button now wires editCustomerSpec (forms.ts → /api/customers/:id PUT).
  // Owner 2026-06-30 — mobile customer edit is now built.
  extraActions: (_d, id) => [
    {
      label: "Edit Hubs",
      // Deep-link to desktop /customers where the full hub CRUD lives
      // (add/edit/delete with state + contact + phone + address). Mobile
      // Add Hub form (addHubSpec) covers add-only; full editor on desktop.
      to: `/customers?autoOpenCustomerId=${encodeURIComponent(id)}`,
      icon: "package-check",
    },
    {
      label: "Quotation PDF",
      to: `/customers?autoOpenCustomerId=${encodeURIComponent(id)}`,
      icon: "file-text",
    },
    {
      label: "Export Catalogue",
      to: `/products?autoCustomerCatalogueId=${encodeURIComponent(id)}`,
      icon: "file-text",
      primary: true,
    },
  ],
};

export const customersConfig: ModuleConfig = {
  slug: "customers",
  title: "Customers",
  detailPath: (vm) => `/m/customers/${encodeURIComponent(vm.id)}`,
  detail: customerDetail,
  sources: [
    {
      url: "/api/customers",
      select: selectData,
      // dc13 (line ~1847): code · customer · "contact · N hubs" · [Terms · Credit · AR]
      toVM: (r): RowVM => {
        const hubs = Array.isArray(r.deliveryHubs) ? (r.deliveryHubs as unknown[]).length : 0;
        const contact = str(r, "contactName", "picName", "phone");
        return {
          id: str(r, "id", "code"),
          code: str(r, "code", "debtorCode") || "—",
          title: str(r, "name") || "—",
          items: [contact, hubs > 0 ? `${hubs} hub${hubs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || undefined,
          metas: [
            { label: "Terms", value: str(r, "creditTerms") || "—" },
            { label: "Credit", value: money(num(r, "creditLimitSen")) },
            { label: "AR", value: money(num(r, "outstandingSen")) },
          ],
          // Customers carry `isActive` (boolean), NOT a `status` string — deriving
          // it (the old `str(r,"status")` always resolved to "—").
          status: resolveStatus(
            r.isActive === true ? "ACTIVE" : "INACTIVE",
            PAYMENT_STATUS_MAP,
          ),
        };
      },
      columns: [
        textCol("code", "Reference", (r) => str(r, "code", "debtorCode")),
        textCol("name", "Customer", (r) => str(r, "name")),
        textCol("state", "State", (r) => str(r, "state")),
        numCol("outstanding", "Outstanding", (r) => num(r, "outstandingSen")),
        enumCol("status", "Status", (r) => str(r, "status"), ["ACTIVE", "INACTIVE"]),
      ],
      defaultSort: { key: "name", dir: "asc" },
      subTabs: [
        { key: "all", label: "All", match: () => true },
        { key: "active", label: "Active", match: (r) => r.isActive === true },
        { key: "inactive", label: "Inactive", match: (r) => r.isActive !== true },
      ],
    },
  ],
};

// Supplier detail — single-GET /api/suppliers/:id → { data: supplier + materials[] }.
// dc13: detail mirrors customer detail (fields grid + materials sub-doc).
const supplierDetail: DetailConfig = {
  url: (id) => `/api/suppliers/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "code") || "—",
  title: (d) => str(d, "name") || "—",
  status: (d) =>
    read(d, "isActive") === true
      ? resolveStatus("ACTIVE", PAYMENT_STATUS_MAP)
      : resolveStatus("INACTIVE", PAYMENT_STATUS_MAP),
  fields: [
    fld("Code", (d) => str(d, "code")),
    fld("Contact", (d) => str(d, "contactPerson")),
    fld("Phone", (d) => str(d, "phone")),
    fld("Email", (d) => str(d, "email")),
    fld("State", (d) => str(d, "state")),
    fld("Currency", (d) => str(d, "currency")),
    fld("Payment Terms", (d) => str(d, "paymentTerms")),
    fld("Tax ID", (d) => str(d, "taxId")),
    fld("Bank Account", (d) => str(d, "bankAccount")),
    fld("Address", (d) => str(d, "address"), true),
  ],
  // Last Purchase Orders + Scorecard (v17/CHANGELOG D.2 supplier detail).
  // The PO list is preloaded so this is fast; scorecard fetched per-supplier.
  extraFetches: {
    a: { key: "poList", url: () => "/api/purchase-orders" },
    b: { key: "scorecard", url: (id) => `/api/supplier-scorecards/${encodeURIComponent(id)}` },
  },
  subDocLists: (d, _resp, extras) => {
    const sid = str(d, "id");
    const sname = str(d, "name");
    const lists: SubDocList[] = [];

    // Scorecard — single-row "metrics" sub-list (overall · on-time · quality · lead).
    const sc = (extras?.scorecard as { data?: { onTimeRate?: number; qualityRate?: number; leadTimeAccuracy?: number; overallRating?: number; lastUpdated?: string } } | undefined)?.data;
    if (sc) {
      const fmt = (v: number | undefined) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");
      lists.push({
        title: `Scorecard`,
        rows: [
          { id: "overall", title: "Overall Rating", trailing: fmt(sc.overallRating), icon: "file-text" as const },
          { id: "ontime", title: "On-Time Rate", trailing: fmt(sc.onTimeRate), icon: "file-text" as const },
          { id: "quality", title: "Quality Rate", trailing: fmt(sc.qualityRate), icon: "file-text" as const },
          { id: "lead", title: "Lead Time Accuracy", trailing: fmt(sc.leadTimeAccuracy), icon: "file-text" as const },
        ],
      });
    }

    const mats = asArr(d.materials);
    if (mats.length > 0) {
      // CHANGELOG D.3: full price SKU table with header — supplier code +
      // material name + supplier SKU + price + lead. dc13 desktop's
      // /suppliers/:id "Pricing & SKUs" tab uses the same columns.
      lists.push({
        title: `Price · SKU table · ${mats.length}`,
        rows: mats.slice(0, 80).map((m) => {
          // /api/suppliers/:id materials[] shape (suppliers.ts materialRowToApi):
          // materialCategory · supplierSKU · unitPriceSen · leadTimeDays · minOrderQty.
          // Old readers (materialName/itemCode/supplierSku/moq/lastPriceSen) matched
          // none of these → every row rendered blank. Dual-keyed for back-compat.
          const sku = str(m, "supplierSKU", "supplierSku");
          const cat = str(m, "materialCategory") || str(m, "materialName", "itemCode", "materialCode");
          const lead = num(m, "leadTimeDays");
          const moq = num(m, "minOrderQty", "moq");
          const price = num(m, "unitPriceSen", "lastPriceSen", "unitPrice");
          const prio = str(m, "priority");
          return {
            id: str(m, "id") || sku || cat,
            title: cat || "Material",
            subLine: [
              sku ? `SKU ${sku}` : "",
              lead > 0 ? `LT ${lead}d` : "",
              moq > 0 ? `MOQ ${moq}` : "",
              prio ? `Priority ${prio}` : "",
            ].filter(Boolean).join(" · ") || undefined,
            trailing: price > 0 ? money(price) : undefined,
            icon: "package" as const,
          };
        }),
      });
    }

    const poResp = extras?.poList as { data?: RawRow[] } | undefined;
    const pos = (poResp?.data ?? []).filter((p) =>
      str(p, "supplierId") === sid || str(p, "supplierName") === sname,
    );
    if (pos.length > 0) {
      lists.push({
        title: `Last Purchase Orders · ${pos.length}`,
        rows: pos.slice(0, 20).map((p) => ({
          id: str(p, "id", "poNo"),
          title: str(p, "poNo") || "—",
          subLine: [shortDate(dateOnly(p, "orderDate")), str(p, "status")].filter(Boolean).join(" · ") || undefined,
          trailing: money(num(p, "totalSen")),
          href: `/m/procurement/${encodeURIComponent(str(p, "id", "poNo"))}`,
          icon: "package" as const,
        })),
      });
    }

    return lists;
  },
  // Edit button now wires editSupplierSpec (forms.ts → /api/suppliers/:id PUT).
  // Owner 2026-06-30.
};

export const suppliersConfig: ModuleConfig = {
  slug: "suppliers",
  title: "Suppliers",
  detailPath: (vm) =>
    /^sup-/.test(vm.id) ? `/m/suppliers/${encodeURIComponent(vm.id)}` : null,
  detail: supplierDetail,
  sources: [
    {
      url: "/api/suppliers",
      select: selectData,
      // dc13 (line ~1856): code · supplier · "contact · category" · [Terms · Lead · MTD]
      toVM: (r): RowVM => ({
        id: str(r, "id", "code"),
        code: str(r, "code") || "—",
        title: str(r, "name") || "—",
        items: [str(r, "contactPerson", "contactName"), str(r, "category", "itemGroup")].filter(Boolean).join(" · ") || undefined,
        metas: [
          { label: "Terms", value: str(r, "paymentTerms") || "—" },
          { label: "Lead", value: num(r, "leadTimeDays") > 0 ? `${num(r, "leadTimeDays")} d` : "—" },
          { label: "MTD", value: money(num(r, "mtdSpendSen")) },
        ],
        status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
      }),
      columns: [
        textCol("code", "Reference", (r) => str(r, "code")),
        textCol("name", "Customer", (r) => str(r, "name")),
        textCol("state", "State", (r) => str(r, "state")),
        enumCol("status", "Status", (r) => str(r, "status"), ["ACTIVE", "INACTIVE"]),
      ],
      defaultSort: { key: "name", dir: "asc" },
      subTabs: [
        { key: "all", label: "All", match: () => true },
        { key: "active", label: "Active", match: (r) => str(r, "status").toUpperCase() !== "INACTIVE" },
        { key: "inactive", label: "Inactive", match: (r) => str(r, "status").toUpperCase() === "INACTIVE" },
      ],
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

// Product detail — single-GET /api/products/:id → { data: product + children }.
// dc13: product detail shows SKU header + price + production time + dept
// breakdown.
const productDetail: DetailConfig = {
  url: (id) => `/api/products/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "code") || "—",
  title: (d) => str(d, "name") || "—",
  fields: [
    fld("Code", (d) => str(d, "code")),
    fld("Category", (d) => str(d, "category")),
    fld("Size", (d) => str(d, "sizeLabel") || str(d, "sizeCode")),
    fld("Base Price", (d) => money(num(d, "basePriceSen", "price1Sen"))),
    fld("Production Time", (d) => {
      const m = num(d, "productionTimeMinutes");
      return m > 0 ? `${m} min (${Math.round(m / 60)}h)` : "—";
    }),
    fld("Description", (d) => str(d, "description"), true),
  ],
  subDocLists: (d) => {
    const lists: SubDocList[] = [];
    // BOM — real bom_components[] from GET /api/products/:id (products.ts:145):
    // materialCategory · materialName · qtyPerUnit · unit · wastePct.
    const bom = asArr(d.bomComponents);
    if (bom.length > 0) {
      lists.push({
        title: `BOM · ${bom.length}`,
        rows: bom.map((b, i) => {
          const qty = num(b, "qtyPerUnit");
          const unit = str(b, "unit");
          const waste = num(b, "wastePct");
          return {
            id: str(b, "id") || `bom-${i}`,
            title: str(b, "materialName") || str(b, "materialCategory") || "Component",
            subLine: [str(b, "materialCategory"), waste > 0 ? `+${waste}% waste` : ""]
              .filter(Boolean)
              .join(" · ") || undefined,
            trailing: qty > 0 ? `${qty}${unit ? ` ${unit}` : ""}` : undefined,
            icon: "package" as const,
          };
        }),
      });
    }
    const dwts = asArr(d.deptWorkingTimes);
    if (dwts.length > 0) {
      lists.push({
        title: `Dept Working Times · ${dwts.length}`,
        rows: dwts.map((w) => ({
          id: str(w, "id") || str(w, "departmentCode"),
          title: str(w, "departmentCode") || "Department",
          subLine: str(w, "category") || undefined,
          trailing: `${num(w, "minutes")} min`,
          icon: "file-text" as const,
        })),
      });
    }
    return lists;
  },
  // CHANGELOG F.1: product detail with photo upload. The existing /api/files
  // mechanism (resourceType="PRODUCT") handles cover photos + supporting
  // docs uniformly. The Files section + upload button appear automatically
  // when attachmentsResource is set.
  attachmentsResource: (id) => ({ type: "PRODUCT", id }),
  auditResource: () => "products",
};

export const productsConfig: ModuleConfig = {
  slug: "products",
  title: "Products",
  detailPath: (vm) =>
    /^prod-/.test(vm.id) ? `/m/products/${encodeURIComponent(vm.id)}` : null,
  detail: productDetail,
  sources: [
    {
      url: "/api/products",
      select: selectData,
      // dc13 (line ~1873): code · product · "Sofa · N variants" · [Price · Lead]
      toVM: (r): RowVM => {
        const cat = str(r, "category");
        const size = str(r, "sizeLabel");
        return {
          id: str(r, "id", "code"),
          code: str(r, "code") || "—",
          title: str(r, "name") || "—",
          items: [cat, size].filter(Boolean).join(" · ") || undefined,
          metas: [
            { label: "Price", value: money(num(r, "basePriceSen", "price1Sen")) },
            { label: "Lead", value: num(r, "leadTimeDays") > 0 ? `${num(r, "leadTimeDays")} d` : "—" },
          ],
        };
      },
      columns: [
        textCol("code", "Reference", (r) => str(r, "code")),
        textCol("name", "Customer", (r) => str(r, "name")),
        enumCol("category", "State", (r) => str(r, "category"), ["BEDFRAME", "SOFA", "ACCESSORY"]),
        numCol("amount", "Amount", (r) => num(r, "basePriceSen", "price1Sen")),
      ],
      defaultSort: { key: "name", dir: "asc" },
      subTabs: [
        { key: "all", label: "All", match: () => true },
        { key: "sofa", label: "Sofa", match: (r) => str(r, "category") === "SOFA" },
        { key: "bedframe", label: "Bedframe", match: (r) => str(r, "category") === "BEDFRAME" },
        { key: "accessory", label: "Accessory", match: (r) => str(r, "category") === "ACCESSORY" },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// SERVICE CASES — owner 2026-06-28 design v10 "Service & Support" module.
// One source (/api/service-cases). Sub-tabs filter by the case status enum
// (OPEN / IN_PROGRESS / CLOSED / CANCELLED). The L2 detail renders the design's
// "Case lifecycle" timeline (via the generic flow indicator) plus real
// affected-products / root-cause / prevention blocks and the linked service
// orders. All wired to the existing service-cases API — no new backend.
// ---------------------------------------------------------------------------
const SERVICE_CASE_STATUSES = ["OPEN", "IN_PROGRESS", "CLOSED", "CANCELLED"];

const serviceCasesSource: DataSource = {
  url: "/api/service-cases",
  select: selectData,
  // dc13 (line ~1914): code · customer · "SO-... · CATEGORY" · [Stage · Order]
  toVM: (r): RowVM => {
    const orders = Array.isArray(r.orders) ? (r.orders as RawRow[]) : [];
    const firstOrder = orders[0];
    return {
      id: str(r, "id"),
      code: str(r, "caseNo") || "—",
      title: str(r, "customerName") || "—",
      items: [str(r, "sourceNo") || str(r, "sourceType"), str(r, "rootCauseCategory")].filter(Boolean).join(" · ") || undefined,
      metas: [
        { label: "Stage", value: str(r, "status") || "—" },
        { label: "Order", value: firstOrder ? str(firstOrder, "serviceOrderNo") || "—" : "—" },
      ],
      status: resolveStatus(str(r, "status"), SERVICE_CASE_STATUS_MAP),
    };
  },
  columns: [
    textCol("caseNo", "Reference", (r) => str(r, "caseNo")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    textCol("source", "State", (r) => str(r, "sourceNo", "sourceType")),
    textCol("category", "Reference", (r) => str(r, "rootCauseCategory")),
    dateCol("createdAt", "Order Date", (r) => dateOnly(r, "createdAt")),
    enumCol("status", "Status", (r) => str(r, "status"), SERVICE_CASE_STATUSES),
  ],
  defaultSort: { key: "createdAt", dir: "desc" },
  subTabs: [
    { key: "all", label: "All", match: () => true },
    { key: "open", label: "Open", match: (r) => str(r, "status") === "OPEN" },
    {
      key: "progress",
      label: "In Progress",
      match: (r) => str(r, "status") === "IN_PROGRESS",
    },
    { key: "closed", label: "Closed", match: (r) => str(r, "status") === "CLOSED" },
    {
      key: "cancelled",
      label: "Cancelled",
      match: (r) => str(r, "status") === "CANCELLED",
    },
  ],
};

const serviceCaseDetail: DetailConfig = {
  url: (id) => `/api/service-cases/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "caseNo") || "—",
  title: (d) => str(d, "customerName") || "—",
  status: (d) => resolveStatus(str(d, "status"), SERVICE_CASE_STATUS_MAP),
  // Case lifecycle — CHANGELOG/v17 specifies 8-stage pipeline:
  //   Opened → Investigating → Service Order → Repair in progress →
  //   Repair done → Delivery arranged → Delivered → Closed
  // Backend status enum stays coarse (OPEN / IN_PROGRESS / CLOSED / CANCELLED).
  // We surface the 8 visual stages and light them up based on a richer set of
  // signals the case record carries (has linked service order, repair started,
  // dispatched, etc) — falls back to status when the signal is absent.
  flow: {
    steps: [
      { key: "OPENED", label: "Opened" },
      { key: "INVESTIGATING", label: "Investigating" },
      { key: "SERVICE_ORDER", label: "Service Order" },
      { key: "REPAIR_IN_PROGRESS", label: "Repair in progress" },
      { key: "REPAIR_DONE", label: "Repair done" },
      { key: "DELIVERY_ARRANGED", label: "Delivery arranged" },
      { key: "DELIVERED", label: "Delivered" },
      { key: "CLOSED", label: "Closed" },
    ],
    current: (d) => {
      // Derive the most-advanced reached stage from the case record + its
      // linked orders. Status CLOSED → final step; otherwise inspect orders
      // for repair / delivery signals.
      const status = str(d, "status");
      if (status === "CLOSED") return "CLOSED";
      if (status === "CANCELLED") return "OPENED";
      const orders = Array.isArray(d.orders) ? (d.orders as RawRow[]) : [];
      if (orders.length === 0) {
        // No service order yet — case is in Opened or Investigating
        return status === "IN_PROGRESS" ? "INVESTIGATING" : "OPENED";
      }
      // Look at the most-recent order's status to figure out the stage
      const latest = orders[orders.length - 1];
      const orderStatus = str(latest, "status").toUpperCase();
      if (orderStatus === "DELIVERED" || orderStatus === "SIGNED") return "DELIVERED";
      if (orderStatus === "DISPATCHED" || orderStatus === "LOADED") return "DELIVERY_ARRANGED";
      if (orderStatus === "COMPLETED" || orderStatus === "DONE") return "REPAIR_DONE";
      if (orderStatus === "IN_PROGRESS" || orderStatus === "REPAIR") return "REPAIR_IN_PROGRESS";
      return "SERVICE_ORDER";
    },
  },
  fields: [
    fld("Case No", (d) => str(d, "caseNo")),
    fld("Customer", (d) => str(d, "customerName")),
    fld("State", (d) => str(d, "customerState")),
    fld("Source", (d) => str(d, "sourceNo", "sourceType")),
    fld("Category", (d) => str(d, "rootCauseCategory")),
    fld("Responsible", (d) => str(d, "responsibleUnit")),
    fld("Prevention", (d) => str(d, "preventionStatus")),
    fld("Order Date", (d) => dateOnly(d, "createdAt")),
    fld("Issue", (d) => str(d, "issueDescription"), true),
  ],
  // Affected products / Root cause(s) / Prevention — rendered as KV blocks
  // (the design's "case blocks"). Only real, populated values are shown.
  kvSections: (d) => {
    const sections: KvSection[] = [];

    const affected = asArr(d.affectedProducts);
    if (affected.length > 0) {
      sections.push({
        title: "Affected products",
        rows: affected.map((p) => ({
          label: str(p, "productCode", "code", "name") || "Product",
          value: str(p, "description", "productName") || `×${num(p, "quantity", "qty") || 1}`,
        })),
      });
    }

    const rootCauses = asArr(d.rootCauses);
    if (rootCauses.length > 0) {
      sections.push({
        title: "Root cause",
        rows: rootCauses
          .map((rc) => ({
            label: str(rc, "category") || "Cause",
            value: str(rc, "details") || "—",
          }))
          .filter((r) => r.value !== ""),
      });
    } else if (str(d, "rootCauseNotes")) {
      sections.push({
        title: "Root cause",
        rows: [
          {
            label: str(d, "rootCauseCategory") || "Cause",
            value: str(d, "rootCauseNotes"),
          },
        ],
      });
    }

    if (str(d, "preventionAction")) {
      sections.push({
        title: "Prevention",
        rows: [
          { label: "Action", value: str(d, "preventionAction") },
          ...(str(d, "preventionOwner")
            ? [{ label: "Owner", value: str(d, "preventionOwner") }]
            : []),
          { label: "Status", value: str(d, "preventionStatus") || "PENDING" },
        ],
      });
    }
    return sections.filter((s) => s.rows.length > 0);
  },
  // Action Taken log + Issue Photos as sub-doc lists (CHANGELOG G.3-G.7).
  // The case payload already carries both via rowToApi (service-cases.ts:357).
  subDocLists: (d) => {
    const lists: SubDocList[] = [];

    const log = asArr(d.actionLog);
    if (log.length > 0) {
      lists.push({
        title: `Action Taken · ${log.length}`,
        rows: log.slice(0, 50).map((a, i) => ({
          id: str(a, "id") || String(i),
          title: str(a, "description", "action") || "Action",
          subLine: [str(a, "createdByName", "by"), shortDate(dateOnly(a, "date", "createdAt"))].filter(Boolean).join(" · ") || undefined,
          icon: "file-text" as const,
        })),
      });
    }

    const photos = asArr(d.issuePhotos);
    // issuePhotos may also come as string[]; handle both
    const photoRows = photos.length > 0
      ? photos.map((p, i) => ({
          id: typeof p === "string" ? p : str(p, "id") || String(i),
          title: typeof p === "string" ? `Photo ${i + 1}` : (str(p, "filename") || `Photo ${i + 1}`),
          icon: "package" as const,
        }))
      : [];
    if (photoRows.length > 0) {
      lists.push({
        title: `Photos · ${photoRows.length}`,
        rows: photoRows,
      });
    }

    return lists;
  },
  // Linked service orders (SV / service_orders rows). isSv steers to the SV
  // sales-order detail; native service_orders have no mobile detail yet.
  relatedDocs: (d) => {
    const out: RelatedDocVM[] = [];
    for (const o of asArr(d.orders)) {
      const isSv = read(o, "isSv") === true;
      const oid = str(o, "id");
      out.push({
        id: oid || str(o, "serviceOrderNo"),
        group: "Service Orders",
        code: str(o, "serviceOrderNo") || "—",
        subLine: str(o, "mode") || undefined,
        status: resolveStatus(str(o, "status"), PAYMENT_STATUS_MAP),
        // SV orders are sales_orders rows → reachable on the mobile SO detail.
        href: isSv && oid ? `/m/sales/${encodeURIComponent(oid)}` : undefined,
      });
    }
    // Source SO cross-link (when the case originated from a real SO).
    const srcId = str(d, "sourceId");
    const srcNo = str(d, "sourceNo");
    if (str(d, "sourceType") === "SO" && (srcId || srcNo)) {
      out.push({
        id: srcId || srcNo,
        group: "Source Sales Order",
        code: srcNo || "—",
        href: srcId ? `/m/sales/${encodeURIComponent(srcId)}` : undefined,
      });
    }
    return out;
  },
  primaryCta: (d) => {
    const s = str(d, "status");
    if (s === "OPEN") return "Start Work";
    if (s === "IN_PROGRESS") return "Close Case";
    return "Status";
  },
  // CHANGELOG #12 + G.2: Add Affected Product inline + Spawn Service Order
  // (matches desktop "Spawn SO" button on service-cases/detail.tsx which
  // creates a new SV order pre-filled from this case + its affectedProducts).
  // PUT /api/service-cases/:id appends to affectedProducts[].
  extraActions: (d, id) => [
    {
      label: "Add Part",
      icon: "package-check",
      formSpec: () => addAffectedProductSpec(d, id),
      primary: true,
    },
    {
      label: "Spawn SO",
      icon: "receipt",
      // Desktop service-cases creates a SV-prefixed sales-order seeded from
      // the case (caseid → /api/sales-orders POST). Mobile deep-links to the
      // existing /sales/create route with ?fromCase=<id> — desktop SO create
      // recognises that and prefills from the case payload.
      to: `/sales/create?fromCase=${encodeURIComponent(id)}`,
    },
  ],
  // CHANGELOG G.5: Issue Photos upload section. Backend /api/files accepts
  // arbitrary resourceType (already in use for SO/DO/etc) — adding the
  // resource binding surfaces the standard Files section on serviceCaseDetail
  // automatically (DocumentDetailScreen handles the rest).
  attachmentsResource: (id) => ({ type: "SERVICE_CASE", id }),
};

export const serviceCasesConfig: ModuleConfig = {
  slug: "servicecases",
  title: "Service Cases",
  detailPath: (vm) => `/m/servicecases/${encodeURIComponent(vm.id)}`,
  detail: serviceCaseDetail,
  sources: [serviceCasesSource],
};

// ---------------------------------------------------------------------------
// USER MANAGEMENT — owner 2026-06-28 design v12 "System" group. Read-only
// list of system users (publicUser shape from /api/users). Mutations
// (create / reset-password / role change) stay on the desktop /settings/users
// page — they're SUPER_ADMIN-only and the mobile detail-edit form isn't
// built. Tapping a row stays non-tappable for the same reason.
// ---------------------------------------------------------------------------
// User detail — enables tap-to-open for the per-row admin actions
// (Reset password / Deactivate / Resend invite / Revoke). Reuses the
// existing /api/users/:id GET (users.ts) — fields are read from the row.
const userDetail: DetailConfig = {
  url: (id) => `/api/users/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "role") || "USER",
  title: (d) => str(d, "displayName") || str(d, "email") || "—",
  status: (d) => resolveStatus(
    read(d, "isActive") === true ? "ACTIVE" : "INACTIVE",
    PAYMENT_STATUS_MAP,
  ),
  fields: [
    fld("Email", (d) => str(d, "email")),
    fld("Role", (d) => str(d, "role")),
    fld("Department", (d) => str(d, "department")),
    fld("Position", (d) => str(d, "position")),
    fld("Phone", (d) => str(d, "phone")),
    fld("Last Login", (d) => dateOnly(d, "lastLoginAt")),
    fld("Created", (d) => dateOnly(d, "createdAt")),
  ],
  // CHANGELOG L: per-row admin actions. Backend already supports each
  // (users.ts:480 reset-password, :417 DELETE, /invites/:token/resend, etc).
  extraActions: (_d, id) => [
    {
      label: "Reset Password",
      icon: "package-check",
      onClick: async () => {
        if (!window.confirm("Send password reset email to this user?")) return;
        try {
          const r = await fetch(`/api/users/${encodeURIComponent(id)}/reset-password`, { method: "POST" });
          if (r.ok) window.alert("Reset password email sent.");
          else window.alert("Failed to send reset password email.");
        } catch {
          window.alert("Network error.");
        }
      },
    },
    {
      label: "Deactivate",
      icon: "copy",
      onClick: async () => {
        if (!window.confirm("Deactivate this user? They will lose access.")) return;
        try {
          const r = await fetch(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
          if (r.ok) window.alert("User deactivated.");
          else window.alert("Failed to deactivate user.");
        } catch {
          window.alert("Network error.");
        }
      },
    },
  ],
  hideActionBar: true,
};

// Pending-invite detail — invites have no single-GET, so (like announcementsDetail)
// we fetch the invites LIST and find the row by token. Route id is "invite-<token>".
// Actions map to real endpoints: POST /invites/:token/resend, DELETE /invites/:token.
const inviteTokenOf = (id: string) => (id ?? "").replace(/^invite-/, "");
const inviteDetail: DetailConfig = {
  url: () => "/api/users/invites",
  selectDoc: (resp, id) => {
    const token = inviteTokenOf(id);
    const rows = (resp as { data?: RawRow[] } | null | undefined)?.data;
    return (Array.isArray(rows) ? rows : []).find((r) => str(r, "token") === token) ?? {};
  },
  code: (d) => str(d, "role") || "USER",
  title: (d) => str(d, "displayName") || str(d, "email") || "—",
  status: () => resolveStatus("PENDING", PAYMENT_STATUS_MAP),
  fields: [
    fld("Email", (d) => str(d, "email")),
    fld("Role", (d) => str(d, "role")),
    fld("Invited By", (d) => str(d, "inviterName")),
    fld("Expires", (d) => dateOnly(d, "expiresAt")),
  ],
  extraActions: (_d, id) => {
    const token = inviteTokenOf(id);
    return [
      {
        label: "Resend Invite",
        icon: "package-check",
        onClick: async () => {
          if (!window.confirm("Resend this invitation email?")) return;
          try {
            const r = await fetch(`/api/users/invites/${encodeURIComponent(token)}/resend`, { method: "POST" });
            window.alert(r.ok ? "Invitation resent." : "Failed to resend invitation.");
          } catch {
            window.alert("Network error.");
          }
        },
      },
      {
        label: "Revoke Invite",
        icon: "copy",
        onClick: async () => {
          if (!window.confirm("Revoke this invitation? The invite link will stop working.")) return;
          try {
            const r = await fetch(`/api/users/invites/${encodeURIComponent(token)}`, { method: "DELETE" });
            window.alert(r.ok ? "Invitation revoked." : "Failed to revoke invitation.");
          } catch {
            window.alert("Network error.");
          }
        },
      },
    ];
  },
  hideActionBar: true,
};

/** Dispatch the usermgmt detail by route id — "invite-…" → pending invite. */
function pickUserDetail(id: string): DetailConfig {
  return id.startsWith("invite-") ? inviteDetail : userDetail;
}
const userDetailDispatcher: DetailConfig = {
  url: (id) => pickUserDetail(id).url(id),
  selectDoc: (resp, id) => pickUserDetail(id).selectDoc(resp, id),
  resolve: (_doc, id) => pickUserDetail(id),
  code: (d) => str(d, "role") || "USER",
  title: (d) => str(d, "displayName") || str(d, "email") || "—",
  fields: [],
};

export const usermgmtConfig: ModuleConfig = {
  slug: "usermgmt",
  title: "User Management",
  // Members → /m/usermgmt/<userId> (user detail). Pending-invite rows carry a
  // `token` (no user record) → /m/usermgmt/invite-<token> (invite detail with
  // Resend / Revoke). The dispatcher picks the right sub-config by id prefix.
  detailPath: (vm, row) =>
    read(row, "token")
      ? `/m/usermgmt/invite-${encodeURIComponent(str(row, "token"))}`
      : `/m/usermgmt/${encodeURIComponent(vm.id)}`,
  detail: userDetailDispatcher,
  sources: [
    {
      url: "/api/users",
      select: selectData,
      // dc13 (line ~1880): code · name · email · [Role · Last seen]
      toVM: (r): RowVM => ({
        id: str(r, "id"),
        code: str(r, "role") || "USER",
        title: str(r, "displayName") || str(r, "email") || "—",
        items: str(r, "email") || undefined,
        metas: [
          { label: "Role", value: str(r, "role") || "—" },
          { label: "Last seen", value: shortDate(dateOnly(r, "lastLoginAt", "createdAt")) || "—" },
        ],
        status: resolveStatus(
          read(r, "isActive") === true ? "ACTIVE" : "INACTIVE",
          PAYMENT_STATUS_MAP,
        ),
      }),
      columns: [
        textCol("displayName", "Customer", (r) => str(r, "displayName")),
        textCol("email", "Reference", (r) => str(r, "email")),
        textCol("role", "State", (r) => str(r, "role")),
        textCol("department", "Reference", (r) => str(r, "department")),
        dateCol("lastLoginAt", "Order Date", (r) =>
          dateOnly(r, "lastLoginAt", "createdAt"),
        ),
        enumCol(
          "status",
          "Status",
          (r) => (read(r, "isActive") === true ? "ACTIVE" : "INACTIVE"),
          ["ACTIVE", "INACTIVE"],
        ),
      ],
      defaultSort: { key: "displayName", dir: "asc" },
      subTabs: [{ key: "members", label: "Members", match: () => true }],
    },
    // Pending Invites — un-accepted, un-expired invitations (separate table via
    // GET /api/users/invites). Rows are non-navigable (no user record yet).
    {
      url: "/api/users/invites",
      select: selectData,
      toVM: (r): RowVM => ({
        id: str(r, "token"),
        code: str(r, "role") || "USER",
        title: str(r, "displayName") || str(r, "email") || "—",
        items: str(r, "email") || undefined,
        metas: [
          { label: "Invited by", value: str(r, "inviterName") || "—" },
          { label: "Expires", value: shortDate(dateOnly(r, "expiresAt")) || "—" },
        ],
        status: resolveStatus("PENDING", PAYMENT_STATUS_MAP),
      }),
      columns: [
        textCol("email", "Reference", (r) => str(r, "email")),
        textCol("displayName", "Customer", (r) => str(r, "displayName")),
        textCol("role", "State", (r) => str(r, "role")),
      ],
      defaultSort: { key: "email", dir: "asc" },
      subTabs: [{ key: "pending", label: "Pending Invites", match: () => true }],
    },
  ],
};

// ---------------------------------------------------------------------------
// 3PL PROVIDERS — standalone module (CHANGELOG E). Reuses the threePlSource
// (delivery sub-tab) as its list, adds a detail config with State Rate Card +
// Drivers + Vehicles sub-doc lists, plus the existing /m/delivery sub-tab.
// Backend: /api/drivers (providers) + /api/three-pl-state-rates?providerId=X +
// /api/three-pl-vehicles?providerId=X (+ /api/three-pl-drivers per CHANGELOG).
// ---------------------------------------------------------------------------
const threePlDetail: DetailConfig = {
  url: (id) => `/api/drivers/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "vehicleNo") || str(d, "code") || str(d, "id") || "—",
  title: (d) => str(d, "name") || "—",
  status: (d) => resolveStatus(str(d, "status"), PAYMENT_STATUS_MAP),
  // /api/drivers/:id (rowToDriver) returns name/contactPerson/phone/vehicleNo/
  // vehicleType/capacityM3/ratePerTripSen/ratePerExtraDropSen/status/remarks —
  // NO email, coverage, serviceType or notes. Old grid showed those → all "—".
  fields: [
    fld("Provider", (d) => str(d, "name")),
    fld("Contact", (d) => str(d, "contactPerson")),
    fld("Phone", (d) => str(d, "phone")),
    fld("Vehicle No", (d) => str(d, "vehicleNo")),
    fld("Vehicle Type", (d) => str(d, "vehicleType")),
    fld("Capacity (m³)", (d) => {
      const c = num(d, "capacityM3");
      return c > 0 ? String(c) : "—";
    }),
    fld("Rate / Trip", (d) => money(num(d, "ratePerTripSen"))),
    fld("Extra Drop", (d) => money(num(d, "ratePerExtraDropSen"))),
    fld("Remarks", (d) => str(d, "remarks", "notes"), true),
  ],
  extraFetches: {
    a: {
      key: "rateCard",
      url: (id) => `/api/three-pl-state-rates?providerId=${encodeURIComponent(id)}`,
    },
    b: {
      key: "fleet",
      url: (id) => `/api/three-pl-vehicles?providerId=${encodeURIComponent(id)}`,
    },
  },
  subDocLists: (_d, _resp, extras) => {
    const lists: SubDocList[] = [];

    const rates = extras?.rateCard as
      | { data?: { id: string; state: string; stateLabel?: string; ratePerTripSen: number; ratePerExtraDropSen?: number; remarks?: string }[] }
      | undefined;
    const rateRows = rates?.data ?? [];
    if (rateRows.length > 0) {
      lists.push({
        title: `State Rate Card · ${rateRows.length}`,
        rows: rateRows.map((r) => ({
          id: r.id,
          title: r.stateLabel || r.state || "—",
          subLine: r.remarks || undefined,
          trailing: `${money(r.ratePerTripSen)}/trip`,
          icon: "package" as const,
        })),
      });
    }

    const fleet = extras?.fleet as
      | { data?: { id: string; vehicleNo: string; vehicleType?: string; capacityM3?: number; status?: string }[] }
      | undefined;
    const fleetRows = fleet?.data ?? [];
    if (fleetRows.length > 0) {
      lists.push({
        title: `Fleet · ${fleetRows.length}`,
        rows: fleetRows.map((v) => ({
          id: v.id,
          title: v.vehicleNo,
          subLine: [v.vehicleType, v.status].filter(Boolean).join(" · ") || undefined,
          trailing: v.capacityM3 ? `${v.capacityM3} m³` : undefined,
          icon: "package" as const,
        })),
      });
    }

    return lists;
  },
  attachmentsResource: (id) => ({ type: "THREE_PL_PROVIDER", id }),
};

// Standalone Logistics module shows All / Active / Inactive filter tabs (design
// `logistics` tab-bar). Delivery's own "3PL Providers" tab keeps threePlSource's
// single-tab shape — so we clone the source here rather than mutate the shared one.
const threePlListSource: DataSource = {
  ...threePlSource,
  subTabs: [
    { key: "all", label: "All", match: () => true },
    { key: "active", label: "Active", match: (r) => str(r, "status").toUpperCase() !== "INACTIVE" },
    { key: "inactive", label: "Inactive", match: (r) => str(r, "status").toUpperCase() === "INACTIVE" },
  ],
};

export const logisticsConfig: ModuleConfig = {
  slug: "logistics",
  title: "3PL Providers",
  detailPath: (vm) => `/m/logistics/${encodeURIComponent(vm.id)}`,
  detail: threePlDetail,
  sources: [threePlListSource],
};

// ---------------------------------------------------------------------------
// SERVICE ORDERS — CHANGELOG: separate module (NOT just a sub-tab under
// Service Cases). List columns: Company SO / Customer SO / Customer PO /
// Customer / State / Reference / date / Items / Qty / Total. Wires to
// existing /api/service-orders backend (no new endpoint needed).
// ---------------------------------------------------------------------------
const SV_STATUSES = ["DRAFT", "IN_PROGRESS", "COMPLETED", "CLOSED", "CANCELLED"];
const serviceOrdersSource: DataSource = {
  url: "/api/service-orders",
  select: selectData,
  toVM: (r): RowVM => {
    const lines = Array.isArray(r.lines) ? (r.lines as RawRow[]) : [];
    const items = lines.length;
    const qty = lines.reduce((s, l) => s + num(l, "qty"), 0);
    return {
      id: str(r, "id", "serviceOrderNo"),
      code: str(r, "serviceOrderNo") || "—",
      title: str(r, "customerName") || "—",
      items: [str(r, "sourceNo"), str(r, "sourceType")].filter(Boolean).join(" · ") || undefined,
      metas: [
        { label: "Items", value: String(items) },
        { label: "Qty", value: String(qty) },
        { label: "When", value: shortDate(dateOnly(r, "createdAt")) || "—" },
      ],
      status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
    };
  },
  columns: [
    textCol("serviceOrderNo", "Reference", (r) => str(r, "serviceOrderNo")),
    textCol("customer", "Customer", (r) => str(r, "customerName")),
    textCol("source", "State", (r) => str(r, "sourceNo", "sourceType")),
    dateCol("createdAt", "Order Date", (r) => dateOnly(r, "createdAt")),
    enumCol("status", "Status", (r) => str(r, "status"), SV_STATUSES),
  ],
  defaultSort: { key: "createdAt", dir: "desc" },
  subTabs: [
    { key: "all", label: "All", match: () => true },
    { key: "draft", label: "Draft", match: (r) => str(r, "status") === "DRAFT" },
    { key: "progress", label: "In Progress", match: (r) => str(r, "status") === "IN_PROGRESS" },
    { key: "done", label: "Completed", match: (r) => ["COMPLETED", "CLOSED"].includes(str(r, "status")) },
  ],
};

const serviceOrderDetail: DetailConfig = {
  url: (id) => `/api/service-orders/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "serviceOrderNo") || "—",
  title: (d) => str(d, "customerName") || "—",
  status: (d) => resolveStatus(str(d, "status"), PAYMENT_STATUS_MAP),
  flow: {
    steps: flowSteps(["DRAFT", "IN_PROGRESS", "COMPLETED", "CLOSED"]),
    current: (d) => str(d, "status"),
  },
  fields: [
    fld("Service Order", (d) => str(d, "serviceOrderNo")),
    fld("Customer", (d) => str(d, "customerName")),
    fld("Source", (d) => `${str(d, "sourceType") || "—"} · ${str(d, "sourceNo") || "—"}`),
    fld("Mode", (d) => str(d, "mode")),
    fld("Created By", (d) => str(d, "createdByName", "createdBy")),
    fld("Order Date", (d) => dateOnly(d, "createdAt")),
    fld("Closed", (d) => dateOnly(d, "closedAt")),
    fld("Notes", (d) => str(d, "notes"), true),
  ],
  lineItems: (d) => {
    const lines = Array.isArray(d.lines) ? (d.lines as RawRow[]) : [];
    return lines.map((l, i) => ({
      id: str(l, "id") || String(i),
      title: str(l, "productName", "productCode") || "Item",
      subLine: str(l, "issueSummary") || str(l, "productCode") || undefined,
      meta1: { label: "Qty", value: num(l, "qty") },
    }));
  },
  relatedDocs: (d) => {
    const out: RelatedDocVM[] = [];
    const caseId = str(d, "caseId");
    if (caseId) {
      out.push({
        id: caseId,
        group: "Service Case",
        code: caseId,
        href: `/m/servicecases/${encodeURIComponent(caseId)}`,
      });
    }
    const sourceType = str(d, "sourceType");
    const sourceId = str(d, "sourceId");
    if (sourceType === "SO" && sourceId) {
      out.push({
        id: sourceId,
        group: "Sales Order",
        code: str(d, "sourceNo") || sourceId,
        href: `/m/sales/${encodeURIComponent(sourceId)}`,
      });
    }
    return out;
  },
  attachmentsResource: (id) => ({ type: "SERVICE_ORDER", id }),
  auditResource: () => "service-orders",
  lineAttachmentsResource: (_parent, lineId) => ({ type: "SERVICE_ORDER_LINE", id: lineId }),
};

export const serviceOrdersConfig: ModuleConfig = {
  slug: "serviceorders",
  title: "Service Orders",
  detailPath: (vm) => `/m/serviceorders/${encodeURIComponent(vm.id)}`,
  detail: serviceOrderDetail,
  sources: [serviceOrdersSource],
};

// ---------------------------------------------------------------------------
// R&D PROJECTS — dc13 design v13 added an R&D module to mobile. Wires to
// the existing /api/rd-projects backend (route GET / + GET /:id). Read-only
// mobile (mutations stay on the desktop /rd page).
// ---------------------------------------------------------------------------
const RD_STATUSES = ["DRAFT", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"];
const rdSource: DataSource = {
  url: "/api/rd-projects",
  select: selectData,
  toVM: (r): RowVM => ({
    id: str(r, "id"),
    code: str(r, "code") || "—",
    title: str(r, "name") || "—",
    items: [str(r, "projectType"), str(r, "leadName") || str(r, "leadId")].filter(Boolean).join(" · ") || undefined,
    metas: [
      { label: "Stage", value: str(r, "status") || "—" },
      { label: "Budget", value: money(num(r, "budgetSen")) },
      { label: "Launch", value: shortDate(dateOnly(r, "targetCompleteAt")) || "—" },
    ],
    status: resolveStatus(str(r, "status"), PAYMENT_STATUS_MAP),
  }),
  columns: [
    textCol("code", "Reference", (r) => str(r, "code")),
    textCol("name", "Customer", (r) => str(r, "name")),
    textCol("projectType", "State", (r) => str(r, "projectType")),
    numCol("budget", "Amount", (r) => num(r, "budgetSen")),
    dateCol("createdAt", "Order Date", (r) => dateOnly(r, "createdAt")),
    enumCol("status", "Status", (r) => str(r, "status"), RD_STATUSES),
  ],
  defaultSort: { key: "createdAt", dir: "desc" },
  // v17 (line ~1907): [All, Drafts, Projects, Pipeline, Completed]
  subTabs: [
    { key: "all", label: "All", match: () => true },
    { key: "draft", label: "Drafts", match: (r) => str(r, "status") === "DRAFT" },
    { key: "active", label: "Projects", match: (r) => ["ACTIVE", "PROTOTYPING", "COSTING", "DESIGN"].includes(str(r, "status")) },
    { key: "pipeline", label: "Pipeline", match: (r) => ["PIPELINE", "ON_HOLD", "CONCEPT", "AT_RISK"].includes(str(r, "status")) },
    { key: "done", label: "Completed", match: (r) => ["COMPLETED", "LAUNCHED"].includes(str(r, "status")) },
  ],
};

const rdDetail: DetailConfig = {
  url: (id) => `/api/rd-projects/${encodeURIComponent(id)}`,
  selectDoc: selectDocData,
  code: (d) => str(d, "code") || "—",
  title: (d) => str(d, "name") || "—",
  status: (d) => resolveStatus(str(d, "status"), PAYMENT_STATUS_MAP),
  // CHANGELOG I.2 Stage Timeline — the 6-stage R&D lifecycle matches the
  // milestone array the backend writes at create time (rd-projects.ts:405).
  flow: {
    steps: flowSteps(["CONCEPT", "DESIGN", "PROTOTYPE", "TESTING", "APPROVED", "PRODUCTION_READY"]),
    current: (d) => str(d, "currentStage", "status"),
  },
  fields: [
    fld("Code", (d) => str(d, "code")),
    fld("Category", (d) => str(d, "productCategory")),
    fld("Project Type", (d) => str(d, "projectType")),
    fld("Current Stage", (d) => str(d, "currentStage")),
    fld("Target Launch", (d) => dateOnly(d, "targetLaunchDate")),
    fld("Total Budget", (d) => money(num(d, "totalBudget"))),
    fld("Actual Cost", (d) => money(num(d, "actualCost"))),
    fld("Labour Cost (logged)", (d) => {
      const lc = d.labourCost as { totalSen?: number } | undefined;
      return money(num(lc ?? {}, "totalSen") || num(d, "manualLabourCostSen"));
    }),
    fld("Target Sell Price", (d) => money(num(d, "targetSellingPriceSen"))),
    fld("Target Material Cost", (d) => money(num(d, "targetMaterialCostSen"))),
    // CHANGELOG I.2: Clone Source block
    fld("Clone Source", (d) => str(d, "sourceProductName")),
    fld("Source Brand", (d) => str(d, "sourceBrand")),
    fld("Source Price", (d) => money(num(d, "sourcePriceSen"))),
    fld("Started", (d) => dateOnly(d, "createdDate", "startedAt")),
    fld("Description", (d) => str(d, "description"), true),
  ],
  extraFetches: {
    a: {
      key: "issuances",
      url: (id) => `/api/rd-projects/${encodeURIComponent(id)}/issuances`,
    },
  },
  // CHANGELOG I.2 sub-sections: Milestones · Prototypes (per-dept) ·
  // Material Issuance · Labour Logs. Each rendered as a sub-doc list.
  subDocLists: (d, _resp, extras) => {
    const lists: SubDocList[] = [];

    const milestones = asArr(d.milestones);
    if (milestones.length > 0) {
      lists.push({
        title: `Milestones · ${milestones.length}`,
        rows: milestones.slice(0, 20).map((m, i) => {
          const stage = str(m, "stage");
          const done = !!str(m, "actualDate");
          return {
            id: stage || String(i),
            title: stage || "Milestone",
            subLine: done ? `Done ${shortDate(dateOnly(m, "actualDate"))}` : `Target ${shortDate(dateOnly(m, "targetDate"))}`,
            trailing: done ? "✓" : undefined,
            icon: "file-text" as const,
          };
        }),
      });
    }

    const protos = asArr(d.prototypes);
    if (protos.length > 0) {
      lists.push({
        title: `Prototypes · ${protos.length}`,
        rows: protos.slice(0, 30).map((p) => ({
          id: str(p, "id"),
          title: str(p, "prototypeType") || `v${str(p, "version") || "1"}`,
          subLine: [str(p, "description"), shortDate(dateOnly(p, "createdDate"))].filter(Boolean).join(" · ") || undefined,
          trailing: num(p, "labourHours") > 0 ? `${num(p, "labourHours").toFixed(1)}h` : undefined,
          icon: "package" as const,
        })),
      });
    }

    const issuancesResp = extras?.issuances as
      | { data?: { id: string; materialCode?: string; materialName?: string; qty?: number; cost?: number; issuedAt?: string }[] }
      | undefined;
    const issuances = issuancesResp?.data ?? [];
    if (issuances.length > 0) {
      lists.push({
        title: `Material Issuance · ${issuances.length}`,
        rows: issuances.slice(0, 30).map((m) => ({
          id: m.id,
          title: m.materialName || m.materialCode || "Material",
          subLine: [m.materialCode, shortDate(m.issuedAt || "")].filter(Boolean).join(" · ") || undefined,
          trailing: `${m.qty || 0} · ${money((m.cost || 0))}`,
          icon: "package" as const,
        })),
      });
    }

    const labourLogs = asArr(d.labourLogs);
    if (labourLogs.length > 0) {
      lists.push({
        title: `Labour Hours · ${labourLogs.length}`,
        rows: labourLogs.slice(0, 30).map((l, i) => ({
          id: str(l, "id") || String(i),
          title: str(l, "workerName", "worker") || "Worker",
          subLine: [str(l, "stage"), shortDate(dateOnly(l, "date", "loggedAt"))].filter(Boolean).join(" · ") || undefined,
          trailing: `${num(l, "hours").toFixed(1)}h`,
          icon: "file-text" as const,
        })),
      });
    }

    return lists;
  },
  attachmentsResource: (id) => ({ type: "RD_PROJECT", id }),
  hideActionBar: true,
};

export const rdConfig: ModuleConfig = {
  slug: "rd",
  title: "R&D Projects",
  detailPath: (vm) => `/m/rd/${encodeURIComponent(vm.id)}`,
  detail: rdDetail,
  sources: [rdSource],
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
  serviceCasesConfig,
  serviceOrdersConfig,
  usermgmtConfig,
  rdConfig,
  logisticsConfig,
];
