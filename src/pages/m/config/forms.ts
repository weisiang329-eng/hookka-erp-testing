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
    // dc13 v17 variant fields — map to columns on sales_order_items.
    gapInches: n(it.gapInches) || undefined,
    legHeightInches: n(it.legHeightInches) || undefined,
    legPriceSen: n(it.legPriceSen),
    divanHeightInches: n(it.divanHeightInches) || undefined,
    divanPriceSen: n(it.divanPriceSen),
    discountSen: n(it.discountSen),
    notes: s(it.notes),
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

// dc13 v17 variant fields per category — CHANGELOG B.9 "SO 行项目按品类
// 出不同变体字段". The simpler-typed fields land here flat; the complex
// Sofa Specials (multi-select from kv_config('variants-config')) stays on
// desktop /sales/create — mobile can't replicate that picker without
// re-implementing the variants-config dropdowns. Each field maps to an
// existing column on sales_order_items so the backend stores them on POST
// without any schema change.
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
    // Variant fields shared by Sofa + Bedframe — map to existing columns.
    { name: "gapInches", label: "Mattress Gap (in)", kind: "number" as const },
    { name: "legHeightInches", label: "Leg Height (in)", kind: "number" as const },
    { name: "legPriceSen", label: "Leg Surcharge", kind: "money" as const },
    { name: "divanHeightInches", label: "Divan/Base Height (in)", kind: "number" as const },
    { name: "divanPriceSen", label: "Divan Surcharge", kind: "money" as const },
    { name: "discountSen", label: "Line Discount", kind: "money" as const },
    { name: "notes", label: "Line Notes (color / D1 / seat depth / other)", kind: "text" as const },
  ],
};

/**
 * Optional prefill the OCR scan flow (ScanPOSheet → /api/scan-po/extract)
 * hands in. Subset of FormValues — every field is optional and merges over
 * the empty-draft defaults below. Items are mapped onto the SO line shape.
 */
export type SOCreatePrefill = {
  customerId?: string;
  customerPOId?: string;
  customerSOId?: string;
  reference?: string;
  customerDeliveryDate?: string;
  hookkaExpectedDD?: string;
  notes?: string;
  items?: Array<{
    productCode?: string;
    productName?: string;
    itemCategory?: string;
    sizeLabel?: string;
    fabricCode?: string;
    quantity?: number;
    basePriceSen?: number;
    unitPriceSen?: number;
  }>;
  // OCR accuracy wiring (owner audit 2026-07-11): when the form was prefilled
  // from a scan, carry the sample id + the RAW extraction so the submit can
  // report the FINAL imported values back to /api/scan-po/samples/:id/confirm
  // — same semantics as the desktop scan modal (clean pass = success, edits =
  // fail reasons). Without this, mobile scans never reached the OCR accuracy
  // dashboard at all.
  scanSampleId?: string;
  scanRaw?: Record<string, unknown>;
};

export function newSalesOrderSpec(prefill?: SOCreatePrefill): FormSpec {
  // Map OCR-extracted item shape onto the SO line shape FormSheet expects.
  // Empty array if no prefill items — Quick Action create flow stays unchanged.
  const items = (prefill?.items ?? []).map((it) => ({
    productId: "",
    productCode: s(it.productCode),
    productName: s(it.productName),
    itemCategory: s(it.itemCategory) || "BEDFRAME",
    sizeLabel: s(it.sizeLabel),
    fabricCode: s(it.fabricCode),
    quantity: n(it.quantity) || 1,
    basePriceSen: n(it.basePriceSen) || n(it.unitPriceSen),
  }));
  return {
    title: prefill ? "New Sales Order · from scan" : "New Sales Order",
    submitLabel: "Create (Draft)",
    note:
      "Creates a Draft Sales Order. Confirm it (which runs the BOM + PO cascade) from the desktop app.",
    fields: SO_FIELDS,
    lineItems: SO_LINE,
    initial: {
      customerId: s(prefill?.customerId),
      customerPOId: s(prefill?.customerPOId),
      customerSOId: s(prefill?.customerSOId),
      reference: s(prefill?.reference),
      companySODate: todayISO(),
      customerDeliveryDate: s(prefill?.customerDeliveryDate),
      hookkaExpectedDD: s(prefill?.hookkaExpectedDD),
      notes: s(prefill?.notes),
      items,
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
      // OCR accuracy: report the FINAL imported values against the raw scan.
      // Overlay the comparable fields onto the raw extraction so the diff in
      // ocr-accuracy-core compares like-for-like (same shape the desktop
      // stores). Best-effort — a failure here must never block the SO.
      if (prefill?.scanSampleId && prefill.scanRaw) {
        const corrected = {
          ...prefill.scanRaw,
          customerPO: s(v.customerPOId),
          customerSO: s(v.customerSOId),
          deliveryDate: s(v.customerDeliveryDate),
          items: arr(v.items).map((it) => {
            const r = it as Record<string, unknown>;
            return {
              productCode: s(r.productCode),
              productName: s(r.productName),
              itemCategory: s(r.itemCategory),
              sizeLabel: s(r.sizeLabel),
              fabricCode: s(r.fabricCode),
              quantity: n(r.quantity),
              basePriceSen: n(r.basePriceSen),
            };
          }),
        };
        fetch(`/api/scan-po/samples/${encodeURIComponent(prefill.scanSampleId)}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ correctedJson: corrected, gold: false }),
        }).catch(() => {});
      }
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
    { name: "materialCode", label: "Internal Code", kind: "text" as const, required: true },
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
      // dc13 N.1: "To 不用手打要可选". Source from customers + suppliers
      // emails (both contact lists are already in localStorage cache).
      {
        name: "to",
        label: "To",
        kind: "select" as const,
        required: true,
        full: true,
        placeholder: "Select contact…",
        optionsUrl: "/api/customers",
        optionsSelect: (resp: unknown): unknown[] => {
          if (Array.isArray(resp)) return resp;
          const o = (resp ?? {}) as { data?: unknown };
          return Array.isArray(o.data) ? (o.data as unknown[]) : [];
        },
        optionsMap: (r: unknown): SelectOption => {
          const o = (r ?? {}) as Record<string, unknown>;
          const email = s(o.email);
          const name = s(o.name);
          return {
            value: email || name,
            label: email ? `${name} · ${email}` : name,
          };
        },
      },
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
// CUSTOMER — create + edit. Wires to /api/customers POST + PUT (the same
// endpoints the desktop customers/index.tsx uses). The PUT also handles the
// delivery_hubs sync via the customer's deliveryHubs array.
// ===========================================================================
const TERMS_OPTS: SelectOption[] = [
  { value: "COD", label: "COD" },
  { value: "NET30", label: "30 days" },
  { value: "NET45", label: "45 days" },
  { value: "NET60", label: "60 days" },
  { value: "NET90", label: "90 days" },
];

export function newCustomerSpec(): FormSpec {
  return {
    title: "New Customer",
    submitLabel: "Create",
    fields: [
      { name: "code", label: "Customer Code", kind: "text" as const, required: true, full: true, placeholder: "e.g. 300-NEW" },
      { name: "name", label: "Company Name", kind: "text" as const, required: true, full: true },
      { name: "contactName", label: "Contact", kind: "text" as const, full: true },
      { name: "phone", label: "Phone", kind: "text" as const, full: true },
      { name: "email", label: "Email", kind: "text" as const, full: true },
      { name: "ssmNo", label: "SSM No (BIC reg.)", kind: "text" as const, full: true },
      { name: "creditTerms", label: "Credit Terms", kind: "select" as const, options: TERMS_OPTS, full: true },
      { name: "creditLimitSen", label: "Credit Limit (RM)", kind: "money" as const, full: true },
      { name: "companyAddress", label: "Billing Address", kind: "textarea" as const, full: true },
    ],
    initial: {
      code: "",
      name: "",
      contactName: "",
      phone: "",
      email: "",
      ssmNo: "",
      creditTerms: "NET30",
      creditLimitSen: 0,
      companyAddress: "",
    },
    submit: async (v) => {
      const body = {
        code: s(v.code).trim(),
        name: s(v.name).trim(),
        contactName: s(v.contactName),
        phone: s(v.phone),
        email: s(v.email),
        ssmNo: s(v.ssmNo),
        creditTerms: s(v.creditTerms) || "NET30",
        creditLimitSen: n(v.creditLimitSen),
        companyAddress: s(v.companyAddress),
        isActive: true,
      };
      const res = await mutateJson("/api/customers", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/customers");
      const id = newIdOf(res.body);
      return {
        ok: true,
        navigateTo: id ? `/m/customers/${encodeURIComponent(id)}` : undefined,
      };
    },
  };
}

export function editCustomerSpec(doc: Record<string, unknown>, id: string): FormSpec {
  return {
    title: "Edit Customer",
    submitLabel: "Save",
    fields: [
      { name: "code", label: "Customer Code", kind: "text" as const, required: true, full: true },
      { name: "name", label: "Company Name", kind: "text" as const, required: true, full: true },
      { name: "contactName", label: "Contact", kind: "text" as const, full: true },
      { name: "phone", label: "Phone", kind: "text" as const, full: true },
      { name: "email", label: "Email", kind: "text" as const, full: true },
      { name: "ssmNo", label: "SSM No (BIC reg.)", kind: "text" as const, full: true },
      { name: "creditTerms", label: "Credit Terms", kind: "select" as const, options: TERMS_OPTS, full: true },
      { name: "creditLimitSen", label: "Credit Limit (RM)", kind: "money" as const, full: true },
      { name: "companyAddress", label: "Billing Address", kind: "textarea" as const, full: true },
    ],
    initial: {
      code: s(doc.code),
      name: s(doc.name),
      contactName: s(doc.contactName),
      phone: s(doc.phone),
      email: s(doc.email),
      ssmNo: s(doc.ssmNo),
      creditTerms: s(doc.creditTerms) || "NET30",
      creditLimitSen: n(doc.creditLimitSen),
      companyAddress: s(doc.companyAddress),
    },
    submit: async (v) => {
      // Preserve the existing deliveryHubs array — the PUT route uses
      // it to sync (delete missing + upsert present). Sending no
      // deliveryHubs key means hubs are left alone.
      const body = {
        code: s(v.code).trim(),
        name: s(v.name).trim(),
        contactName: s(v.contactName),
        phone: s(v.phone),
        email: s(v.email),
        ssmNo: s(v.ssmNo),
        creditTerms: s(v.creditTerms) || "NET30",
        creditLimitSen: n(v.creditLimitSen),
        companyAddress: s(v.companyAddress),
        isActive: doc.isActive !== false,
        deliveryHubs: arr(doc.deliveryHubs),
      };
      const res = await mutateJson(`/api/customers/${encodeURIComponent(id)}`, "PUT", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/customers/${encodeURIComponent(id)}`);
      refreshList("/api/customers");
      return { ok: true };
    },
  };
}

/**
 * Add Hub form — PUTs the customer with deliveryHubs = [...existing, newHub].
 * The /api/customers PUT route handles the delivery_hubs UPSERT atomically.
 * Requires the customer doc (for the existing hub array).
 */
/**
 * Add OR Edit a delivery hub on a customer. When `existingHub` is supplied,
 * the form prefills + the submit REPLACES that hub in deliveryHubs[]; when
 * null, appends a new hub. Same PUT /api/customers/:id endpoint both ways.
 */
export function hubFormSpec(
  customer: Record<string, unknown>,
  customerId: string,
  existingHub: Record<string, unknown> | null = null,
): FormSpec {
  const isEdit = existingHub != null;
  return {
    title: isEdit ? "Edit Hub" : "Add Hub",
    submitLabel: isEdit ? "Save" : "Add",
    fields: [
      { name: "code", label: "Hub Code", kind: "text" as const, required: true, full: true, placeholder: "e.g. KL-01" },
      { name: "shortName", label: "Short Name", kind: "text" as const, required: true, full: true },
      { name: "state", label: "State", kind: "text" as const, full: true },
      { name: "contactName", label: "Contact", kind: "text" as const, full: true },
      { name: "phone", label: "Phone", kind: "text" as const, full: true },
      { name: "address", label: "Address", kind: "textarea" as const, full: true },
    ],
    initial: {
      code: s(existingHub?.code),
      shortName: s(existingHub?.shortName),
      state: s(existingHub?.state),
      contactName: s(existingHub?.contactName),
      phone: s(existingHub?.phone),
      address: s(existingHub?.address),
    },
    submit: async (v) => {
      const existing = arr(customer.deliveryHubs);
      const hub = {
        id: isEdit ? s(existingHub!.id) : uuid(),
        code: s(v.code).trim(),
        shortName: s(v.shortName).trim(),
        state: s(v.state),
        contactName: s(v.contactName),
        phone: s(v.phone),
        address: s(v.address),
      };
      const merged = isEdit
        ? existing.map((h) => (s(h.id) === hub.id ? hub : h))
        : [...existing, hub];
      const body = {
        code: s(customer.code),
        name: s(customer.name),
        contactName: s(customer.contactName),
        phone: s(customer.phone),
        email: s(customer.email),
        ssmNo: s(customer.ssmNo),
        creditTerms: s(customer.creditTerms) || "NET30",
        creditLimitSen: n(customer.creditLimitSen),
        companyAddress: s(customer.companyAddress),
        isActive: customer.isActive !== false,
        deliveryHubs: merged,
      };
      const res = await mutateJson(`/api/customers/${encodeURIComponent(customerId)}`, "PUT", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/customers/${encodeURIComponent(customerId)}`);
      refreshList("/api/customers");
      return { ok: true };
    },
  };
}

/** Back-compat alias for the original add-only spec. */
export const addHubSpec = (customer: Record<string, unknown>, customerId: string) =>
  hubFormSpec(customer, customerId, null);

/**
 * Delete a hub via PUT customer with the hub filtered out of deliveryHubs.
 * Returns a Promise that resolves true on success. Same /api/customers/:id PUT.
 */
export async function deleteHub(
  customer: Record<string, unknown>,
  customerId: string,
  hubId: string,
): Promise<{ ok: boolean; error?: string }> {
  const existing = arr(customer.deliveryHubs);
  const merged = existing.filter((h) => s(h.id) !== hubId);
  const body = {
    code: s(customer.code),
    name: s(customer.name),
    contactName: s(customer.contactName),
    phone: s(customer.phone),
    email: s(customer.email),
    ssmNo: s(customer.ssmNo),
    creditTerms: s(customer.creditTerms) || "NET30",
    creditLimitSen: n(customer.creditLimitSen),
    companyAddress: s(customer.companyAddress),
    isActive: customer.isActive !== false,
    deliveryHubs: merged,
  };
  const res = await mutateJson(`/api/customers/${encodeURIComponent(customerId)}`, "PUT", body);
  if (!res.ok) return { ok: false, error: res.error };
  refreshOne(`/api/customers/${encodeURIComponent(customerId)}`);
  refreshList("/api/customers");
  return { ok: true };
}

// ===========================================================================
// SUPPLIER — create + edit. Wires to /api/suppliers POST + PUT.
// ===========================================================================
const PURCHASE_COMPANY_OPTS: SelectOption[] = [
  { value: "HOOKKA_INDUSTRIES", label: "Hookka Industries Sdn Bhd" },
  { value: "HOOKKA_FURNITURE", label: "Hookka Furniture Sdn Bhd" },
];

export function newSupplierSpec(): FormSpec {
  return {
    title: "New Supplier",
    submitLabel: "Create",
    fields: [
      { name: "code", label: "Supplier Code", kind: "text" as const, required: true, full: true, placeholder: "e.g. 400-NEW" },
      { name: "name", label: "Supplier Name", kind: "text" as const, required: true, full: true },
      { name: "contactPerson", label: "Contact Person", kind: "text" as const, full: true },
      { name: "phone", label: "Phone", kind: "text" as const, full: true },
      { name: "email", label: "Email", kind: "text" as const, full: true },
      { name: "state", label: "State", kind: "text" as const, full: true },
      { name: "purchaseCompany", label: "Purchase Company", kind: "select" as const, options: PURCHASE_COMPANY_OPTS, full: true },
      { name: "paymentTerms", label: "Payment Terms", kind: "select" as const, options: TERMS_OPTS, full: true },
      { name: "address", label: "Address", kind: "textarea" as const, full: true },
    ],
    initial: {
      code: "",
      name: "",
      contactPerson: "",
      phone: "",
      email: "",
      state: "",
      purchaseCompany: "HOOKKA_INDUSTRIES",
      paymentTerms: "NET30",
      address: "",
    },
    submit: async (v) => {
      const body = {
        code: s(v.code).trim(),
        name: s(v.name).trim(),
        contactPerson: s(v.contactPerson),
        phone: s(v.phone),
        email: s(v.email),
        state: s(v.state),
        purchaseCompany: s(v.purchaseCompany),
        paymentTerms: s(v.paymentTerms),
        address: s(v.address),
        isActive: true,
      };
      const res = await mutateJson("/api/suppliers", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/suppliers");
      const id = newIdOf(res.body);
      return {
        ok: true,
        navigateTo: id ? `/m/suppliers/${encodeURIComponent(id)}` : undefined,
      };
    },
  };
}

export function editSupplierSpec(doc: Record<string, unknown>, id: string): FormSpec {
  return {
    title: "Edit Supplier",
    submitLabel: "Save",
    fields: [
      { name: "code", label: "Supplier Code", kind: "text" as const, required: true, full: true },
      { name: "name", label: "Supplier Name", kind: "text" as const, required: true, full: true },
      { name: "contactPerson", label: "Contact Person", kind: "text" as const, full: true },
      { name: "phone", label: "Phone", kind: "text" as const, full: true },
      { name: "email", label: "Email", kind: "text" as const, full: true },
      { name: "state", label: "State", kind: "text" as const, full: true },
      { name: "purchaseCompany", label: "Purchase Company", kind: "select" as const, options: PURCHASE_COMPANY_OPTS, full: true },
      { name: "paymentTerms", label: "Payment Terms", kind: "select" as const, options: TERMS_OPTS, full: true },
      { name: "address", label: "Address", kind: "textarea" as const, full: true },
    ],
    initial: {
      code: s(doc.code),
      name: s(doc.name),
      contactPerson: s(doc.contactPerson),
      phone: s(doc.phone),
      email: s(doc.email),
      state: s(doc.state),
      purchaseCompany: s(doc.purchaseCompany) || "HOOKKA_INDUSTRIES",
      paymentTerms: s(doc.paymentTerms) || "NET30",
      address: s(doc.address),
    },
    submit: async (v) => {
      const body = {
        code: s(v.code).trim(),
        name: s(v.name).trim(),
        contactPerson: s(v.contactPerson),
        phone: s(v.phone),
        email: s(v.email),
        state: s(v.state),
        purchaseCompany: s(v.purchaseCompany),
        paymentTerms: s(v.paymentTerms),
        address: s(v.address),
        isActive: doc.isActive !== false,
      };
      const res = await mutateJson(`/api/suppliers/${encodeURIComponent(id)}`, "PUT", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/suppliers/${encodeURIComponent(id)}`);
      refreshList("/api/suppliers");
      return { ok: true };
    },
  };
}

// ===========================================================================
// RECORD PAYMENT — Invoice. Desktop and mobile both use POST /api/payments.
// That one path owns the receipt, allocation, GL, idempotency, audit, and
// paid/status cascade as one atomic contract.
// ===========================================================================
const PAYMENT_METHOD_OPTS: SelectOption[] = [
  { value: "BANK_TRANSFER", label: "Bank Transfer" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "CASH", label: "Cash" },
  { value: "CREDIT_CARD", label: "Credit Card" },
];

export function recordPaymentSpec(doc: Record<string, unknown>, id: string): FormSpec {
  const totalSen = n(doc.totalSen);
  const paidSen = n(doc.paidAmount);
  const balanceSen = Math.max(0, totalSen - paidSen);
  return {
    title: "Record Payment",
    submitLabel: "Save Payment",
    fields: [
      { name: "amount", label: "Amount (RM)", kind: "money" as const, required: true, full: true },
      { name: "paymentMethod", label: "Method", kind: "select" as const, options: PAYMENT_METHOD_OPTS, full: true },
      { name: "paymentDate", label: "Payment Date", kind: "date" as const, full: true },
      { name: "paymentReference", label: "Reference", kind: "text" as const, full: true },
    ],
    // Default to the full outstanding balance — the common case is "paid in full".
    initial: {
      amount: balanceSen,
      paymentMethod: "BANK_TRANSFER",
      paymentDate: "",
      paymentReference: "",
    },
    submit: async (v) => {
      const amountSen = n(v.amount);
      if (amountSen <= 0) return { ok: false, error: "Enter a payment amount." };
      const customerId = s(doc.customerId);
      if (!customerId) {
        return { ok: false, error: "This invoice has no customer id." };
      }
      const body = {
        customerId,
        amount: amountSen,
        method: s(v.paymentMethod) || "BANK_TRANSFER",
        date: s(v.paymentDate) || todayISO(),
        reference: s(v.paymentReference),
        allocations: [{ invoiceId: id, amount: amountSen }],
      };
      const res = await mutateJson("/api/payments", "POST", body, {
        "Idempotency-Key": uuid(),
      });
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/invoices/${encodeURIComponent(id)}`);
      refreshList("/api/invoices");
      refreshList("/api/payments");
      return { ok: true };
    },
  };
}

// ===========================================================================
// STOCK ADJUSTMENT (Raw Material, REMOVE-ONLY) — POST /api/stock-adjustments
// { type:"RM", itemId, qtyDelta (negative), unitCostSen:0, reason, notes }.
// Only negative deltas are exposed on mobile: the backend values a stock-OUT by
// FIFO on the existing cost layers, so no unit cost is needed (the mobile RM API
// doesn't return one). Positive "found" adjustments — which WOULD need a cost to
// value the new stock — stay on desktop. Matches inventory/adjustments.tsx.
// ===========================================================================
const ADJUST_REASON_OPTS: SelectOption[] = [
  { value: "COUNT_CORRECTION", label: "Count correction (reduce)" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "WRITE_OFF", label: "Write-off" },
];

export function stockAdjustmentSpec(doc: Record<string, unknown>, id: string): FormSpec {
  const balance = n(doc.balanceQty);
  const uom = s(doc.baseUOM);
  return {
    title: "Reduce Stock",
    submitLabel: "Confirm Adjustment",
    fields: [
      { name: "reason", label: "Reason", kind: "select" as const, options: ADJUST_REASON_OPTS, required: true, full: true },
      {
        name: "qty",
        label: `Quantity to remove${uom ? ` (${uom})` : ""}${balance > 0 ? ` — in stock: ${balance}` : ""}`,
        kind: "number" as const,
        required: true,
        full: true,
      },
      { name: "notes", label: "Notes", kind: "textarea" as const, full: true },
    ],
    initial: { reason: "COUNT_CORRECTION", qty: 0, notes: "" },
    submit: async (v) => {
      const qty = n(v.qty);
      if (qty <= 0) return { ok: false, error: "Enter a quantity to remove." };
      if (balance > 0 && qty > balance) {
        return { ok: false, error: `Only ${balance} in stock — can't remove ${qty}.` };
      }
      const body = {
        type: "RM",
        itemId: id,
        qtyDelta: -qty, // remove-only
        unitCostSen: 0, // stock-OUT is FIFO-valued; cost not needed
        reason: s(v.reason) || "COUNT_CORRECTION",
        notes: s(v.notes) || null,
      };
      const res = await mutateJson("/api/stock-adjustments", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/raw-materials/${encodeURIComponent(id)}`);
      refreshList("/api/raw-materials");
      refreshList("/api/stock-adjustments");
      return { ok: true };
    },
  };
}

// ===========================================================================
// 3PL PROVIDER — edit. Wires to PUT /api/drivers/:id (drivers.ts). Design's
// "Edit provider" pencil. No cascade — a driver/provider is standalone master
// data. Rates are integer sen (money kind); status ∈ ACTIVE/INACTIVE/ON_LEAVE.
// ===========================================================================
const THREE_PL_STATUS_OPTS: SelectOption[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "ON_LEAVE", label: "On Leave" },
];

export function editThreePlSpec(doc: Record<string, unknown>, id: string): FormSpec {
  return {
    title: "Edit 3PL Provider",
    submitLabel: "Save",
    fields: [
      { name: "name", label: "Provider Name", kind: "text" as const, required: true, full: true },
      { name: "contactPerson", label: "Account Contact", kind: "text" as const, full: true },
      { name: "phone", label: "Phone", kind: "text" as const, full: true },
      { name: "vehicleNo", label: "Vehicle No", kind: "text" as const, full: true },
      { name: "vehicleType", label: "Vehicle Type", kind: "text" as const, full: true },
      { name: "capacityM3", label: "Capacity (m³)", kind: "number" as const, full: true },
      { name: "ratePerTripSen", label: "Rate / Trip (RM)", kind: "money" as const, full: true },
      { name: "ratePerExtraDropSen", label: "Extra Drop (RM)", kind: "money" as const, full: true },
      { name: "status", label: "Status", kind: "select" as const, options: THREE_PL_STATUS_OPTS, full: true },
      { name: "remarks", label: "Remarks", kind: "textarea" as const, full: true },
    ],
    initial: {
      name: s(doc.name),
      contactPerson: s(doc.contactPerson),
      phone: s(doc.phone),
      vehicleNo: s(doc.vehicleNo),
      vehicleType: s(doc.vehicleType),
      capacityM3: n(doc.capacityM3),
      ratePerTripSen: n(doc.ratePerTripSen),
      ratePerExtraDropSen: n(doc.ratePerExtraDropSen),
      status: s(doc.status) || "ACTIVE",
      remarks: s(doc.remarks),
    },
    submit: async (v) => {
      const body = {
        name: s(v.name).trim(),
        contactPerson: s(v.contactPerson),
        phone: s(v.phone),
        vehicleNo: s(v.vehicleNo),
        vehicleType: s(v.vehicleType),
        capacityM3: n(v.capacityM3),
        ratePerTripSen: n(v.ratePerTripSen),
        ratePerExtraDropSen: n(v.ratePerExtraDropSen),
        status: s(v.status) || "ACTIVE",
        remarks: s(v.remarks),
      };
      const res = await mutateJson(`/api/drivers/${encodeURIComponent(id)}`, "PUT", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/drivers/${encodeURIComponent(id)}`);
      refreshList("/api/drivers");
      return { ok: true };
    },
  };
}

// ===========================================================================
// R&D PROJECT — create. Wires to /api/rd-projects POST (rd-projects.ts:383).
// Required: name + productCategory. Optional: projectType, currentStage,
// targetLaunchDate, totalBudget.
// ===========================================================================
const RD_CATEGORY_OPTS: SelectOption[] = [
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "SOFA", label: "Sofa" },
  { value: "ACCESSORY", label: "Accessory" },
];
const RD_STAGE_OPTS: SelectOption[] = [
  { value: "CONCEPT", label: "Concept" },
  { value: "DESIGN", label: "Design" },
  { value: "PROTOTYPE", label: "Prototype" },
  { value: "TESTING", label: "Testing" },
  { value: "APPROVED", label: "Approved" },
  { value: "PRODUCTION_READY", label: "Production Ready" },
];

export function newRdProjectSpec(): FormSpec {
  return {
    title: "New R&D Project",
    submitLabel: "Create",
    fields: [
      { name: "name", label: "Project Name", kind: "text" as const, required: true, full: true },
      { name: "productCategory", label: "Category", kind: "select" as const, options: RD_CATEGORY_OPTS, required: true, full: true },
      { name: "currentStage", label: "Current Stage", kind: "select" as const, options: RD_STAGE_OPTS, full: true },
      { name: "targetLaunchDate", label: "Target Launch Date", kind: "date" as const, full: true },
      { name: "totalBudget", label: "Total Budget (RM)", kind: "money" as const, full: true },
      { name: "description", label: "Description", kind: "textarea" as const, full: true },
    ],
    initial: {
      name: "",
      productCategory: "BEDFRAME",
      currentStage: "CONCEPT",
      targetLaunchDate: "",
      totalBudget: 0,
      description: "",
    },
    submit: async (v) => {
      const body = {
        name: s(v.name).trim(),
        productCategory: s(v.productCategory),
        description: s(v.description),
        currentStage: s(v.currentStage) || "CONCEPT",
        targetLaunchDate: s(v.targetLaunchDate),
        totalBudget: n(v.totalBudget),
      };
      const res = await mutateJson("/api/rd-projects", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/rd-projects");
      const id = newIdOf(res.body);
      return {
        ok: true,
        navigateTo: id ? `/m/rd/${encodeURIComponent(id)}` : undefined,
      };
    },
  };
}

// ===========================================================================
// USER MANAGEMENT — invite. Wires to /api/users/invite POST (users.ts:625).
// SUPER_ADMIN-only on the backend; FE just opens the form. Body: { email,
// displayName, role }. Backend generates 72h link.
// ===========================================================================
const USER_ROLE_OPTS: SelectOption[] = [
  { value: "SUPER_ADMIN", label: "Super Admin" },
  { value: "ADMIN", label: "Admin" },
  { value: "MANAGER", label: "Manager" },
  { value: "STAFF", label: "Staff" },
  { value: "READ_ONLY", label: "Read Only" },
];

export function inviteUserSpec(): FormSpec {
  return {
    title: "Invite User",
    submitLabel: "Send Invite",
    fields: [
      { name: "email", label: "Email", kind: "text" as const, required: true, full: true, placeholder: "name@hookka.com" },
      { name: "displayName", label: "Display Name", kind: "text" as const, required: true, full: true },
      { name: "role", label: "Role", kind: "select" as const, options: USER_ROLE_OPTS, required: true, full: true },
    ],
    initial: { email: "", displayName: "", role: "STAFF" },
    validate: (v) => {
      const e = s(v.email).trim();
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        return "Enter a valid email address.";
      }
      return null;
    },
    submit: async (v) => {
      const body = {
        email: s(v.email).trim(),
        displayName: s(v.displayName).trim(),
        role: s(v.role) || "STAFF",
      };
      const res = await mutateJson("/api/users/invite", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/users");
      return { ok: true };
    },
  };
}

// ===========================================================================
// EMPLOYEE MASTER — edit worker fields. CHANGELOG K.7. PUT /api/workers/:id.
// Backend accepts all the fields below. Salary changes trigger a backend
// salary-history append automatically (no separate request needed at this
// layer — the desktop's verifiedSave handles read-back; mobile defers).
// ===========================================================================
const POSITION_OPTS: SelectOption[] = [
  { value: "Operator", label: "Operator" },
  { value: "Operator Leader", label: "Operator Leader" },
  { value: "Supervisor", label: "Supervisor" },
  { value: "Manager", label: "Manager" },
  { value: "Driver", label: "Driver" },
  { value: "Admin", label: "Admin" },
];
const WORKER_STATUS_OPTS: SelectOption[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "RESIGNED", label: "Resigned" },
];

export function editEmployeeSpec(doc: Record<string, unknown>, id: string): FormSpec {
  return {
    title: "Edit Employee",
    submitLabel: "Save",
    fields: [
      { name: "name", label: "Name", kind: "text" as const, required: true, full: true },
      { name: "empNo", label: "Employee No", kind: "text" as const, full: true },
      { name: "position", label: "Position", kind: "select" as const, options: POSITION_OPTS, full: true },
      { name: "phone", label: "Phone", kind: "text" as const, full: true },
      { name: "basicSalarySen", label: "Basic Salary (RM)", kind: "money" as const, full: true },
      { name: "workingHoursPerDay", label: "Working Hours / Day", kind: "number" as const },
      { name: "workingDaysPerMonth", label: "Working Days / Month", kind: "number" as const },
      { name: "otMultiplier", label: "OT Multiplier", kind: "number" as const },
      { name: "efficiencyAllowanceSen", label: "Efficiency Allowance (RM)", kind: "money" as const, full: true },
      { name: "status", label: "Status", kind: "select" as const, options: WORKER_STATUS_OPTS, full: true },
      { name: "resignedAt", label: "Resigned Date (if RESIGNED)", kind: "date" as const, full: true },
    ],
    initial: {
      name: s(doc.name),
      empNo: s(doc.empNo),
      position: s(doc.position) || "Operator",
      phone: s(doc.phone),
      basicSalarySen: n(doc.basicSalarySen),
      workingHoursPerDay: n(doc.workingHoursPerDay) || 9,
      workingDaysPerMonth: n(doc.workingDaysPerMonth) || 26,
      otMultiplier: n(doc.otMultiplier) || 1.5,
      efficiencyAllowanceSen: n(doc.efficiencyAllowanceSen),
      status: s(doc.status) || "ACTIVE",
      resignedAt: s(doc.resignedAt),
    },
    validate: (v) => {
      if (s(v.status) === "RESIGNED" && !s(v.resignedAt)) {
        return "Resigned date is required when status is RESIGNED.";
      }
      return null;
    },
    submit: async (v) => {
      const body = {
        empNo: s(v.empNo),
        name: s(v.name).trim(),
        position: s(v.position),
        phone: s(v.phone),
        basicSalarySen: n(v.basicSalarySen),
        workingHoursPerDay: n(v.workingHoursPerDay) || 9,
        workingDaysPerMonth: n(v.workingDaysPerMonth) || 26,
        otMultiplier: n(v.otMultiplier) || 1.5,
        efficiencyAllowanceSen: n(v.efficiencyAllowanceSen),
        status: s(v.status) || "ACTIVE",
        resignedAt: s(v.resignedAt) || null,
        // Preserve existing arrays/flags the backend expects in PUT.
        departmentCodes: arr(doc.departmentCodes),
        categories: arr(doc.categories),
        epfEnabled: doc.epfEnabled !== false,
        socsoEnabled: doc.socsoEnabled !== false,
        eisEnabled: doc.eisEnabled !== false,
        pcbEnabled: doc.pcbEnabled !== false,
      };
      const res = await mutateJson(`/api/workers/${encodeURIComponent(id)}`, "PUT", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/workers/${encodeURIComponent(id)}`);
      refreshList("/api/workers");
      return { ok: true };
    },
  };
}

// ===========================================================================
// SERVICE ORDER — "Copy from Sales / Consignment Order" dialog (CHANGELOG H.2).
// Operator types the source SO/CO number → next step pre-fills the new SV
// from that source (mirrors desktop service-orders create modal). Sends
// POST /api/service-orders { sourceType, sourceNo, customerId? } — backend
// resolves source + copies lines (price reset to 0 per CHANGELOG).
// ===========================================================================
const SV_SOURCE_OPTS: SelectOption[] = [
  { value: "SO", label: "Sales Order" },
  { value: "CO", label: "Consignment Order" },
];

export function newServiceOrderSpec(): FormSpec {
  return {
    title: "New Service Order",
    submitLabel: "Create",
    fields: [
      { name: "sourceType", label: "Source Type", kind: "select" as const, options: SV_SOURCE_OPTS, required: true, full: true },
      { name: "sourceNo", label: "Source SO / PO / Reference", kind: "text" as const, required: true, full: true, placeholder: "e.g. SO-2606-014" },
      { name: "mode", label: "Mode", kind: "select" as const, full: true, options: [
        { value: "REPAIR", label: "Repair" },
        { value: "REPLACEMENT", label: "Replacement" },
        { value: "STOCK_SWAP", label: "Stock Swap" },
        { value: "INSPECTION", label: "Inspection" },
      ]},
      { name: "notes", label: "Notes", kind: "textarea" as const, full: true },
    ],
    initial: { sourceType: "SO", sourceNo: "", mode: "REPAIR", notes: "" },
    submit: async (v) => {
      const body = {
        sourceType: s(v.sourceType),
        sourceNo: s(v.sourceNo).trim(),
        mode: s(v.mode) || "REPAIR",
        notes: s(v.notes),
      };
      const res = await mutateJson("/api/service-orders", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/service-orders");
      const id = newIdOf(res.body);
      return {
        ok: true,
        navigateTo: id ? `/m/serviceorders/${encodeURIComponent(id)}` : undefined,
      };
    },
  };
}

// ===========================================================================
// SERVICE CASE — Add Affected Product. CHANGELOG #12 / G.3. Mirrors desktop
// service-cases/detail.tsx inline editor. PUT /api/service-cases/:id with
// affectedProducts: [...existing, {productId, code, name, qty, components}].
// ===========================================================================
export function addAffectedProductSpec(
  serviceCase: Record<string, unknown>,
  caseId: string,
): FormSpec {
  return {
    title: "Add Affected Product",
    submitLabel: "Add",
    fields: [
      { name: "code", label: "Product Code", kind: "text" as const, required: true, full: true, placeholder: "e.g. ASP-3S" },
      { name: "name", label: "Product Name", kind: "text" as const, full: true },
      { name: "qty", label: "Qty Affected", kind: "number" as const, required: true, full: true },
      { name: "componentsCsv", label: "Damaged Parts (comma-separated)", kind: "text" as const, full: true, placeholder: "e.g. cushion, leg, fabric" },
    ],
    initial: { code: "", name: "", qty: 1, componentsCsv: "" },
    submit: async (v) => {
      const existing = arr(serviceCase.affectedProducts);
      const parts = s(v.componentsCsv)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((label) => ({ key: label.toUpperCase().replace(/\s+/g, "_"), label, qty: 1 }));
      const newProduct = {
        productId: s(v.code),
        code: s(v.code),
        name: s(v.name) || s(v.code),
        qty: n(v.qty) || 1,
        components: parts.length > 0 ? parts : undefined,
      };
      // Backend PUT expects the FULL case body. Pass existing fields through
      // unchanged + the new affectedProducts array.
      const body: Record<string, unknown> = {};
      // Spread case top-level keys we want to preserve unchanged
      for (const k of [
        "customerId", "customerName", "customerState", "sourceType", "sourceId",
        "sourceNo", "issueDescription", "rootCauseCategory", "rootCauseNotes",
        "preventionAction", "preventionStatus", "preventionOwner", "responsibleUnit",
        "actionLog", "issuePhotos", "rootCauses", "status",
      ]) {
        if (serviceCase[k] !== undefined) body[k] = serviceCase[k];
      }
      body.affectedProducts = [...existing, newProduct];
      const res = await mutateJson(`/api/service-cases/${encodeURIComponent(caseId)}`, "PUT", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshOne(`/api/service-cases/${encodeURIComponent(caseId)}`);
      refreshList("/api/service-cases");
      return { ok: true };
    },
  };
}

// ===========================================================================
// WORKING HOURS — log a per-day entry for a worker. CHANGELOG K.1 "可编辑
// 行". Backend POST /api/working-hour-entries auto-creates the attendance
// row if needed (working-hour-entries.ts:898). Mobile keeps it simple:
// pick department + category + hours + optional notes.
// ===========================================================================
const WH_DEPT_OPTS: SelectOption[] = [
  { value: "FAB_CUT", label: "Fab Cut" },
  { value: "FAB_SEW", label: "Fab Sew" },
  { value: "FOAM", label: "Foam" },
  { value: "WOOD_CUT", label: "Wood Cut" },
  { value: "FRAMING", label: "Framing" },
  { value: "WEBBING", label: "Webbing" },
  { value: "UPHOLSTERY", label: "Upholstery" },
  { value: "PACKING", label: "Packing" },
  { value: "WAREHOUSING", label: "Warehousing" },
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "R_AND_D", label: "R&D" },
];
const WH_CATEGORY_OPTS: SelectOption[] = [
  { value: "", label: "—" },
  { value: "SOFA", label: "Sofa" },
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "ACCESSORY", label: "Accessory" },
];

export function logHoursSpec(workerId: string): FormSpec {
  return {
    title: "Log Working Hours",
    submitLabel: "Save Entry",
    fields: [
      { name: "date", label: "Date", kind: "date" as const, required: true, full: true },
      { name: "departmentCode", label: "Department", kind: "select" as const, options: WH_DEPT_OPTS, required: true, full: true },
      { name: "category", label: "Category", kind: "select" as const, options: WH_CATEGORY_OPTS, full: true },
      { name: "hours", label: "Hours", kind: "number" as const, required: true, full: true },
      { name: "notes", label: "Notes", kind: "textarea" as const, full: true },
    ],
    initial: {
      date: todayISO(),
      departmentCode: "UPHOLSTERY",
      category: "",
      hours: 0,
      notes: "",
    },
    submit: async (v) => {
      const body = {
        workerId,
        date: s(v.date),
        departmentCode: s(v.departmentCode),
        category: s(v.category) || null,
        hours: n(v.hours),
        notes: s(v.notes),
      };
      const res = await mutateJson("/api/working-hour-entries", "POST", body);
      if (!res.ok) return { ok: false, error: res.error };
      refreshList("/api/working-hour-entries");
      // Refresh the month summary used by /m/employees Working Hours tab
      try {
        const w = (() => {
          const now = new Date();
          const yyyy = now.getFullYear();
          const mm = String(now.getMonth() + 1).padStart(2, "0");
          const dd = String(now.getDate()).padStart(2, "0");
          return { from: `${yyyy}-${mm}-01`, to: `${yyyy}-${mm}-${dd}` };
        })();
        refreshOne(`/api/working-hour-entries/summary?from=${w.from}&to=${w.to}`);
      } catch {
        // ignore
      }
      return { ok: true };
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
    case "mail":
    case "mail-center":
      return newMailSpec();
    case "customers":
      return newCustomerSpec();
    case "suppliers":
      return newSupplierSpec();
    case "rd":
      return newRdProjectSpec();
    case "usermgmt":
      return inviteUserSpec();
    case "serviceorders":
      return newServiceOrderSpec();
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
    case "customers":
      return editCustomerSpec(doc, id);
    case "suppliers":
      return editSupplierSpec(doc, id);
    case "employees":
      return editEmployeeSpec(doc, id);
    case "logistics":
      // Design "Edit provider" — 3PL master data, PUT /api/drivers/:id (no cascade).
      return editThreePlSpec(doc, id);
    default:
      // DO edit (status transitions / dispatch overlay), production, etc. are
      // not free-form edits — left to desktop / the CTA action. // TODO: add a
      // DO dispatch-overlay edit form if owner wants it on mobile.
      return null;
  }
}

// Re-export for the consumers (form values type used by callers).
export type { FormValues };
