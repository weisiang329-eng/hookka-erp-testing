// ===========================================================================
// Form specs (Phase 4) — the EXACT desktop create/edit payloads, declared.
//
// Each builder returns a FormSpec the generic <FormSheet> renders + submits.
// Every payload mirrors the desktop create/edit page byte-for-byte so the same
// backend validations + cascades fire (verified against the route handlers +
// the desktop create pages — see per-form notes):
//
//   • Sales Order   POST /api/sales-orders        (sales/create.tsx:1842)
//   • Purchase Order POST /api/purchase-orders     (procurement/create.tsx:393)
//   • Delivery Order POST /api/delivery-orders     (delivery/index.tsx:2301)  *
//   • Invoice        POST /api/invoices            (invoices/index.tsx:151)   *
//   • Announcement   POST /api/announcements       (announcements.tsx:571)
//   • Mail compose   POST /api/mail-center/compose (mail-center/compose.tsx)
//
//   * DO + Invoice are DERIVED documents on the desktop (a DO is built from
//     ready production orders; an Invoice from a DELIVERED DO). They have no
//     free-form "customer + items + amount" create payload — sending one would
//     400. So the mobile create mirrors the real desktop flow: DO is created
//     from a production-order id (+ optional dispatch fields); Invoice is
//     generated from a delivered DO id. See the notes on those builders.
//
// Money is integer SEN everywhere (RM × 100 via roundSen — handled by the
// MoneyField control; these builders just read the sen value from state).
//
// ADDITIVE: imported only by files under src/pages/m/. No backend changes.
// ===========================================================================
import { type FormSpec, type FormValues, type SelectOption } from "./form-types";
import { mutateJson, refreshList, refreshOne, newIdOf } from "./mutate";

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function s(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}
function uuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `m-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

// Option mappers for fetched selects.
const customerOpt = (r: unknown): SelectOption => {
  const o = (r ?? {}) as Record<string, unknown>;
  return { value: s(o.id), label: s(o.name) || s(o.code) || s(o.id) };
};
const supplierOpt = (r: unknown): SelectOption => {
  const o = (r ?? {}) as Record<string, unknown>;
  return { value: s(o.id), label: s(o.name) || s(o.code) || s(o.id) };
};
const supplierNameById = new Map<string, string>(); // hydrated lazily, see PO submit

// ===========================================================================
// SALES ORDER — create + edit. True form. POST persists DRAFT (mobile-safe:
// we do NOT chain /confirm, which runs the BOM/PO cascade — desktop is the
// place to confirm). Mirrors sales/create.tsx:1842.
// ===========================================================================
const CATEGORY_OPTS: SelectOption[] = [
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "SOFA", label: "Sofa" },
  { value: "ACCESSORY", label: "Accessory" },
];

function soItemsForServer(items: Record<string, unknown>[]): unknown[] {
  return items.map((it) => ({
    productId: s(it.productId),
    productCode: s(it.productCode),
    productName: s(it.productName) || s(it.productCode),
    itemCategory: s(it.itemCategory) || "BEDFRAME",
    sizeLabel: s(it.sizeLabel),
    fabricCode: s(it.fabricCode), // empty allowed
    quantity: n(it.quantity) || 1,
    basePriceSen: n(it.basePriceSen), // 0 lets the server resolve catalog price
  }));
}

function blankSOItem(): Record<string, unknown> {
  return {
    productId: "",
    productCode: "",
    productName: "",
    itemCategory: "BEDFRAME",
    sizeLabel: "",
    fabricCode: "",
    quantity: 1,
    basePriceSen: 0,
  };
}

const SO_FIELDS = [
  {
    name: "customerId",
    label: "Customer",
    kind: "select" as const,
    required: true,
    full: true,
    placeholder: "Select customer…",
    optionsUrl: "/api/customers",
    optionsMap: customerOpt,
  },
  { name: "customerPOId", label: "Customer PO", kind: "text" as const },
  { name: "customerSOId", label: "Customer SO", kind: "text" as const },
  { name: "companySODate", label: "Order Date", kind: "date" as const },
  { name: "customerDeliveryDate", label: "Customer Delivery", kind: "date" as const },
  { name: "hookkaExpectedDD", label: "Expected DD", kind: "date" as const },
  { name: "reference", label: "Reference", kind: "text" as const, full: true },
  { name: "notes", label: "Notes", kind: "textarea" as const, full: true },
];

const SO_LINE = {
  name: "items",
  label: "Line items",
  qtyKey: "quantity",
  priceKey: "basePriceSen",
  blank: blankSOItem,
  fields: [
    { name: "productCode", label: "Product Code", kind: "text" as const, required: true },
    { name: "productName", label: "Product Name", kind: "text" as const },
    { name: "itemCategory", label: "Category", kind: "select" as const, options: CATEGORY_OPTS },
    { name: "sizeLabel", label: "Size", kind: "text" as const },
    { name: "fabricCode", label: "Fabric Code", kind: "text" as const },
    { name: "quantity", label: "Qty", kind: "number" as const, required: true },
    { name: "basePriceSen", label: "Unit Price", kind: "money" as const },
  ],
};

export function newSalesOrderSpec(): FormSpec {
  return {
    title: "New Sales Order",
    submitLabel: "Create (Draft)",
    note:
      "Creates a Draft Sales Order. Confirm it (which runs the BOM + PO cascade) from the desktop app.",
    fields: SO_FIELDS,
    lineItems: SO_LINE,
    initial: {
      customerId: "",
      customerPOId: "",
      customerSOId: "",
      reference: "",
      companySODate: todayISO(),
      customerDeliveryDate: "",
      hookkaExpectedDD: "",
      notes: "",
      items: [],
    },
    submit: async (v) => {
      const body = {
        customerId: s(v.customerId),
        customerPOId: s(v.customerPOId),
        customerSOId: s(v.customerSOId),
        reference: s(v.reference),
        companySODate: s(v.companySODate) || todayISO(),
        customerDeliveryDate: s(v.customerDeliveryDate),
        hookkaExpectedDD: s(v.hookkaExpectedDD),
        notes: s(v.notes),
        items: soItemsForServer(arr(v.items)),
        status: "DRAFT",
        isServiceOrder: false,
      };
      const res = await mutateJson("/api/sales-orders", "POST", body, {
        "Idempotency-Key": uuid(),
      });
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/sales-orders", "/api/production-orders");
      const id = newIdOf(res.body);
      return { ok: true, navigateTo: id ? `/m/sales/${encodeURIComponent(id)}` : undefined };
    },
  };
}

/** Edit form — prefilled from the fetched SO doc. PUT merges header + items. */
export function editSalesOrderSpec(doc: Record<string, unknown>, id: string): FormSpec {
  const items = arr(doc.items).map((it) => ({
    productId: s(it.productId),
    productCode: s(it.productCode),
    productName: s(it.productName),
    itemCategory: s(it.itemCategory) || "BEDFRAME",
    sizeLabel: s(it.sizeLabel),
    fabricCode: s(it.fabricCode),
    quantity: n(it.quantity) || 1,
    basePriceSen: n(it.basePriceSen) || n(it.unitPriceSen),
  }));
  return {
    title: "Edit Sales Order",
    submitLabel: "Save",
    fields: SO_FIELDS,
    lineItems: SO_LINE,
    initial: {
      customerId: s(doc.customerId),
      customerPOId: s(doc.customerPOId) || s(doc.customerPO),
      customerSOId: s(doc.customerSOId) || s(doc.customerSO),
      reference: s(doc.reference),
      companySODate: s(doc.companySODate).slice(0, 10) || todayISO(),
      customerDeliveryDate: s(doc.customerDeliveryDate).slice(0, 10),
      hookkaExpectedDD: s(doc.hookkaExpectedDD).slice(0, 10),
      notes: s(doc.notes),
      items,
    },
    submit: async (v) => {
      const body = {
        customerId: s(v.customerId),
        customerPOId: s(v.customerPOId),
        customerSOId: s(v.customerSOId),
        reference: s(v.reference),
        companySODate: s(v.companySODate),
        customerDeliveryDate: s(v.customerDeliveryDate),
        hookkaExpectedDD: s(v.hookkaExpectedDD),
        notes: s(v.notes),
        items: soItemsForServer(arr(v.items)),
      };
      const res = await mutateJson(`/api/sales-orders/${encodeURIComponent(id)}`, "PUT", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/sales-orders/${encodeURIComponent(id)}`);
      refreshList("/api/sales-orders");
      return { ok: true };
    },
  };
}

// ===========================================================================
// PURCHASE ORDER — create + edit. True form. Mirrors procurement/create.tsx.
// Required: supplierId + supplierName + items[{materialCode, quantity,
// unitPriceSen}]. NO payment-terms field exists on the PO body (only `notes`).
// ===========================================================================
function poItemsForServer(items: Record<string, unknown>[]): unknown[] {
  return items.map((it) => ({
    materialCategory: s(it.materialCategory),
    materialCode: s(it.materialCode),
    materialName: s(it.materialName),
    supplierSKU: s(it.supplierSKU),
    quantity: n(it.quantity),
    unitPriceSen: n(it.unitPriceSen),
    unit: s(it.unit) || "pcs",
  }));
}

function blankPOItem(): Record<string, unknown> {
  return {
    materialCategory: "",
    materialCode: "",
    materialName: "",
    supplierSKU: "",
    quantity: 1,
    unitPriceSen: 0,
    unit: "pcs",
  };
}

const PO_FIELDS = [
  {
    name: "supplierId",
    label: "Supplier",
    kind: "select" as const,
    required: true,
    full: true,
    placeholder: "Select supplier…",
    optionsUrl: "/api/suppliers",
    optionsMap: supplierOpt,
  },
  { name: "orderDate", label: "Order Date", kind: "date" as const },
  { name: "expectedDate", label: "ETA", kind: "date" as const },
  // NOTE: there is no "Payment Terms" field on the PO body (backend + desktop
  // never send one); only free-text Notes exists. Surfaced as Notes, not a
  // guessed payment-terms payload that the backend would ignore.
  { name: "notes", label: "Notes", kind: "textarea" as const, full: true },
];

const PO_LINE = {
  name: "items",
  label: "Line items",
  qtyKey: "quantity",
  priceKey: "unitPriceSen",
  blank: blankPOItem,
  fields: [
    { name: "materialCode", label: "Material Code", kind: "text" as const, required: true },
    { name: "materialName", label: "Material Name", kind: "text" as const },
    { name: "unit", label: "Unit", kind: "text" as const, placeholder: "pcs" },
    { name: "quantity", label: "Qty", kind: "number" as const, required: true },
    { name: "unitPriceSen", label: "Unit Price", kind: "money" as const },
  ],
};

// We need supplierName (denormalised, required by the backend). Hydrate the
// supplier name → id map from the /api/suppliers cache so the submit can fill
// it from the chosen supplierId. (Reads the same cached list the select uses.)
async function resolveSupplierName(id: string): Promise<string> {
  if (supplierNameById.has(id)) return supplierNameById.get(id) || "";
  try {
    const res = await fetch("/api/suppliers");
    const j = (await res.json()) as { data?: Record<string, unknown>[] };
    for (const row of j.data ?? []) {
      supplierNameById.set(s(row.id), s(row.name));
    }
  } catch {
    /* fall through — submit will validate */
  }
  return supplierNameById.get(id) || "";
}

export function newPurchaseOrderSpec(): FormSpec {
  return {
    title: "New Purchase Order",
    submitLabel: "Create",
    fields: PO_FIELDS,
    lineItems: PO_LINE,
    initial: {
      supplierId: "",
      orderDate: todayISO(),
      expectedDate: "",
      notes: "",
      items: [],
    },
    validate: (v) =>
      arr(v.items).length === 0 ? "Add at least one line item." : null,
    submit: async (v) => {
      const supplierId = s(v.supplierId);
      const supplierName = await resolveSupplierName(supplierId);
      if (!supplierName) {
        return {
          ok: false,
          error: "Could not resolve the supplier — pick it again from the list.",
        };
      }
      const body = {
        supplierId,
        supplierName,
        status: "CONFIRMED", // matches procurement/create.tsx (desktop)
        orderDate: s(v.orderDate) || todayISO(),
        expectedDate: s(v.expectedDate),
        notes: s(v.notes),
        items: poItemsForServer(arr(v.items)),
      };
      const res = await mutateJson("/api/purchase-orders", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/purchase-orders");
      const id = newIdOf(res.body);
      return {
        ok: true,
        navigateTo: id ? `/m/procurement/${encodeURIComponent(id)}` : undefined,
      };
    },
  };
}

/** Edit form for a PO — prefilled. PUT merges header + replaces items. */
export function editPurchaseOrderSpec(doc: Record<string, unknown>, id: string): FormSpec {
  const items = arr(doc.items).map((it) => ({
    materialCategory: s(it.materialCategory),
    materialCode: s(it.materialCode),
    materialName: s(it.materialName),
    supplierSKU: s(it.supplierSKU),
    quantity: n(it.quantity),
    unitPriceSen: n(it.unitPriceSen),
    unit: s(it.unit) || "pcs",
  }));
  return {
    title: "Edit Purchase Order",
    submitLabel: "Save",
    fields: PO_FIELDS,
    lineItems: PO_LINE,
    initial: {
      supplierId: s(doc.supplierId),
      orderDate: s(doc.orderDate).slice(0, 10) || todayISO(),
      expectedDate: s(doc.expectedDate).slice(0, 10),
      notes: s(doc.notes),
      items,
    },
    submit: async (v) => {
      const supplierId = s(v.supplierId);
      const supplierName =
        (await resolveSupplierName(supplierId)) || s(doc.supplierName);
      const body = {
        supplierId,
        supplierName,
        orderDate: s(v.orderDate),
        expectedDate: s(v.expectedDate),
        notes: s(v.notes),
        items: poItemsForServer(arr(v.items)),
      };
      const res = await mutateJson(`/api/purchase-orders/${encodeURIComponent(id)}`, "PUT", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/purchase-orders/${encodeURIComponent(id)}`);
      refreshList("/api/purchase-orders");
      return { ok: true };
    },
  };
}

// ===========================================================================
// DELIVERY ORDER — create. A DO is DERIVED from ready production orders on the
// desktop (delivery/index.tsx:2301 → { productionOrderIds, providerId,
// vehicleId, driverId, deliveryAddress, dropPoints, remarks, deliveryDate }).
// There is no free-form "customer + items" payload — the backend resolves the
// customer + line items from the POs. So the mobile form collects the ready
// production order(s) + the optional dispatch overlay, exactly like desktop.
// ===========================================================================
const DO_FIELDS = [
  {
    name: "productionOrderId",
    label: "Production Order (ready to ship)",
    kind: "select" as const,
    required: true,
    full: true,
    placeholder: "Select a completed production order…",
    optionsUrl: "/api/production-orders",
    optionsMap: (r: unknown): SelectOption => {
      const o = (r ?? {}) as Record<string, unknown>;
      const code = s(o.poNo) || s(o.id);
      const cust = s(o.customerName);
      return {
        value: s(o.id),
        label: cust ? `${code} — ${cust}` : code,
      };
    },
  },
  {
    name: "providerId",
    label: "3PL Provider",
    kind: "select" as const,
    placeholder: "Optional…",
    optionsUrl: "/api/drivers",
    optionsMap: (r: unknown): SelectOption => {
      const o = (r ?? {}) as Record<string, unknown>;
      return { value: s(o.id), label: s(o.name) || s(o.vehicleNo) || s(o.id) };
    },
  },
  { name: "deliveryDate", label: "Dispatch Date", kind: "date" as const },
  { name: "deliveryAddress", label: "Delivery Address", kind: "textarea" as const, full: true },
  { name: "remarks", label: "Remarks", kind: "text" as const, full: true },
];

export function newDeliveryOrderSpec(): FormSpec {
  return {
    title: "New Delivery Order",
    submitLabel: "Create (Draft)",
    note:
      "A Delivery Order is built from a completed production order — the customer, SO ref and items are filled in automatically. Pick the order to ship, then optionally set the 3PL provider, dispatch date and address.",
    fields: DO_FIELDS,
    initial: {
      productionOrderId: "",
      providerId: "",
      deliveryDate: "",
      deliveryAddress: "",
      remarks: "",
    },
    submit: async (v) => {
      const poId = s(v.productionOrderId);
      const body = {
        productionOrderIds: [poId],
        providerId: s(v.providerId) || null,
        deliveryDate: s(v.deliveryDate) || "",
        deliveryAddress: s(v.deliveryAddress),
        remarks: s(v.remarks),
        dropPoints: 1,
      };
      const res = await mutateJson("/api/delivery-orders", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/delivery-orders", "/api/production-orders");
      const id = newIdOf(res.body);
      return {
        ok: true,
        navigateTo: id ? `/m/delivery/${encodeURIComponent(id)}` : undefined,
      };
    },
  };
}

// ===========================================================================
// INVOICE — create. An Invoice is GENERATED from a DELIVERED Delivery Order on
// the desktop (invoices/index.tsx:151 → { deliveryOrderId }). The customer,
// line items, amount, tax and due date are all derived server-side; there is
// no free-form invoice create payload (sending customer/lines/amount would
// 400). So the mobile form picks a delivered DO and posts { deliveryOrderId }.
// ===========================================================================
const INVOICE_FIELDS = [
  {
    name: "deliveryOrderId",
    label: "Delivery Order (delivered)",
    kind: "select" as const,
    required: true,
    full: true,
    placeholder: "Select a delivered DO…",
    optionsUrl: "/api/delivery-orders",
    // Only DELIVERED DOs can be invoiced — filter the list to those.
    optionsSelect: (resp: unknown): unknown[] => {
      const rows =
        resp && typeof resp === "object" && Array.isArray((resp as { data?: unknown }).data)
          ? ((resp as { data: Record<string, unknown>[] }).data)
          : [];
      return rows.filter((r) => s(r.status).toUpperCase() === "DELIVERED");
    },
    optionsMap: (r: unknown): SelectOption => {
      const o = (r ?? {}) as Record<string, unknown>;
      const code = s(o.doNo) || s(o.id);
      const cust = s(o.customerName);
      return { value: s(o.id), label: cust ? `${code} — ${cust}` : code };
    },
  },
  { name: "notes", label: "Notes", kind: "textarea" as const, full: true },
];

export function newInvoiceSpec(): FormSpec {
  return {
    title: "New Invoice",
    submitLabel: "Generate",
    note:
      "An Invoice is generated from a delivered Delivery Order — the customer, lines, Amount and due date are filled in automatically. Pick the delivered DO to bill.",
    fields: INVOICE_FIELDS,
    initial: { deliveryOrderId: "", notes: "" },
    submit: async (v) => {
      const body: Record<string, unknown> = { deliveryOrderId: s(v.deliveryOrderId) };
      const notes = s(v.notes);
      if (notes) body.notes = notes;
      const res = await mutateJson("/api/invoices", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/invoices", "/api/delivery-orders");
      const id = newIdOf(res.body);
      return {
        ok: true,
        navigateTo: id ? `/m/invoices/${encodeURIComponent(id)}` : undefined,
      };
    },
  };
}

/** Edit an invoice — DRAFT line replacement (matches PUT { items } branch). */
export function editInvoiceSpec(doc: Record<string, unknown>, id: string): FormSpec {
  const items = arr(doc.items).map((it) => ({
    productCode: s(it.productCode),
    productName: s(it.productName),
    sizeLabel: s(it.sizeLabel),
    fabricCode: s(it.fabricCode),
    quantity: n(it.quantity),
    unitPriceSen: n(it.unitPriceSen),
    discountSen: n(it.discountSen),
  }));
  return {
    title: "Edit Invoice",
    submitLabel: "Save",
    note:
      "Line edits apply to Draft invoices only. A posted invoice's amounts are adjusted from the desktop (per-line price edit reverses + re-posts the ledger).",
    fields: [
      { name: "notes", label: "Notes", kind: "textarea" as const, full: true },
    ],
    lineItems: {
      name: "items",
      label: "Line items",
      qtyKey: "quantity",
      priceKey: "unitPriceSen",
      blank: () => ({
        productCode: "",
        productName: "",
        sizeLabel: "",
        fabricCode: "",
        quantity: 1,
        unitPriceSen: 0,
        discountSen: 0,
      }),
      fields: [
        { name: "productCode", label: "Product Code", kind: "text" as const, required: true },
        { name: "productName", label: "Product Name", kind: "text" as const },
        { name: "quantity", label: "Qty", kind: "number" as const, required: true },
        { name: "unitPriceSen", label: "Unit Price", kind: "money" as const },
        { name: "discountSen", label: "Discount", kind: "money" as const },
      ],
    },
    initial: { notes: s(doc.notes), items },
    submit: async (v) => {
      const body = {
        notes: s(v.notes),
        items: arr(v.items).map((it) => ({
          productCode: s(it.productCode),
          productName: s(it.productName) || s(it.productCode),
          sizeLabel: s(it.sizeLabel),
          fabricCode: s(it.fabricCode),
          quantity: n(it.quantity),
          unitPriceSen: n(it.unitPriceSen),
          discountSen: n(it.discountSen),
        })),
      };
      const res = await mutateJson(`/api/invoices/${encodeURIComponent(id)}`, "PUT", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/invoices/${encodeURIComponent(id)}`);
      refreshList("/api/invoices");
      return { ok: true };
    },
  };
}

// ===========================================================================
// ANNOUNCEMENT — create. POST /api/announcements (announcements.tsx:571).
// Body: { title (required), body, category, targetDeptCodes? }. target_type is
// derived server-side. "Audience" maps to category (the real enum the desktop
// uses): GENERAL / WARNING / SOP / LEARNING.
// ===========================================================================
const AUDIENCE_OPTS: SelectOption[] = [
  { value: "GENERAL", label: "General" },
  { value: "WARNING", label: "Warning" },
  { value: "SOP", label: "SOP" },
  { value: "LEARNING", label: "Learning" },
];

export function newAnnouncementSpec(): FormSpec {
  return {
    title: "New Announcement",
    submitLabel: "Post",
    fields: [
      { name: "title", label: "Title", kind: "text" as const, required: true, full: true },
      {
        name: "category",
        label: "Audience",
        kind: "select" as const,
        options: AUDIENCE_OPTS,
        full: true,
      },
      { name: "body", label: "Message", kind: "textarea" as const, full: true },
      { name: "expiresAt", label: "Expires (optional)", kind: "date" as const, full: true },
    ],
    initial: { title: "", category: "GENERAL", body: "", expiresAt: "" },
    submit: async (v) => {
      const body: Record<string, unknown> = {
        title: s(v.title),
        body: s(v.body),
        category: s(v.category) || "GENERAL",
      };
      const exp = s(v.expiresAt);
      if (exp) body.expiresAt = exp;
      const res = await mutateJson("/api/announcements", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/announcements");
      const id = newIdOf(res.body);
      return {
        ok: true,
        navigateTo: id ? `/m/announcements/${encodeURIComponent(id)}` : undefined,
      };
    },
  };
}

// ===========================================================================
// MAIL — compose. POST /api/mail-center/compose (mail-center/compose.tsx:307).
// Body: { fromAddress (required), to (required, valid email), subject
// (required), text (required) }. fromAddress must be an @hookka.com mailbox the
// user can send from — fetched from /api/mail-center/addresses.
// ===========================================================================
export function newMailSpec(): FormSpec {
  return {
    title: "Compose Mail",
    submitLabel: "Send",
    fields: [
      {
        name: "fromAddress",
        label: "From",
        kind: "select" as const,
        required: true,
        full: true,
        placeholder: "Select mailbox…",
        optionsUrl: "/api/mail-center/addresses",
        optionsSelect: (resp: unknown): unknown[] => {
          if (Array.isArray(resp)) return resp;
          const o = (resp ?? {}) as { data?: unknown; addresses?: unknown };
          if (Array.isArray(o.data)) return o.data;
          if (Array.isArray(o.addresses)) return o.addresses;
          return [];
        },
        optionsMap: (r: unknown): SelectOption => {
          if (typeof r === "string") return { value: r, label: r };
          const o = (r ?? {}) as Record<string, unknown>;
          const addr = s(o.address) || s(o.email) || s(o.value);
          return { value: addr, label: s(o.name) ? `${s(o.name)} <${addr}>` : addr };
        },
      },
      { name: "to", label: "To", kind: "text" as const, required: true, full: true, placeholder: "name@example.com" },
      { name: "subject", label: "Subject", kind: "text" as const, required: true, full: true },
      { name: "text", label: "Message", kind: "textarea" as const, required: true, full: true },
    ],
    initial: { fromAddress: "", to: "", subject: "", text: "" },
    validate: (v) => {
      const to = s(v.to).trim();
      if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return "Enter a valid recipient email address.";
      }
      return null;
    },
    submit: async (v) => {
      const body = {
        fromAddress: s(v.fromAddress),
        to: s(v.to).trim(),
        subject: s(v.subject),
        text: s(v.text),
      };
      const res = await mutateJson("/api/mail-center/compose", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/mail-center/threads");
      const id = newIdOf(res.body);
      return {
        ok: true,
        navigateTo: id ? `/m/mail-center/${encodeURIComponent(id)}` : undefined,
      };
    },
  };
}

// ===========================================================================
// Create-form resolver — slug → its "New …" FormSpec, or null when the module
// has no in-scope mobile create form. Drives the "+" affordance on the L1 list
// header (ModuleListScreen).
// ===========================================================================
export function createSpecFor(slug: string): FormSpec | null {
  switch (slug) {
    case "sales":
      return newSalesOrderSpec();
    case "delivery":
      return newDeliveryOrderSpec();
    case "procurement":
      return newPurchaseOrderSpec();
    case "invoices":
      return newInvoiceSpec();
    case "announcements":
      return newAnnouncementSpec();
    case "mail-center":
      return newMailSpec();
    default:
      return null;
  }
}

// ===========================================================================
// Edit-form resolver — slug (+ resolved doc) → the right edit FormSpec, or null
// when the doc type has no in-scope mobile edit form. Consumed by the L2
// DocumentDetailScreen's Edit button.
// ===========================================================================
export function editSpecFor(
  slug: string,
  doc: Record<string, unknown>,
  id: string,
): FormSpec | null {
  switch (slug) {
    case "sales":
      return editSalesOrderSpec(doc, id);
    case "invoices":
      // Only the main Invoices rows have a per-id endpoint; the edit PUT's line
      // replacement is DRAFT-only (backend rejects non-DRAFT — surfaced inline).
      return editInvoiceSpec(doc, id);
    case "procurement":
      // Procurement shares one slug across PO/GRN/PI. Only Purchase Orders have
      // a mobile edit form here; GRN/PI editing stays on desktop.
      if (id.startsWith("po-")) return editPurchaseOrderSpec(doc, id);
      return null;
    default:
      // DO edit (status transitions / dispatch overlay), production, etc. are
      // not free-form edits — left to desktop / the CTA action. // TODO: add a
      // DO dispatch-overlay edit form if owner wants it on mobile.
      return null;
  }
}

// Re-export for the consumers (form values type used by callers).
export type { FormValues };
