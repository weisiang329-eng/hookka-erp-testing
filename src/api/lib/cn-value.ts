// ---------------------------------------------------------------------------
// cn-value.ts — "value of goods" derivation for Consignment Notes, the CN
// twin of do-value.ts.
//
// consignment_notes has a totalValue column, but it is the legacy header
// figure and is unreliable: CN items are routinely created with
// unitPrice = 0 because the real pricing lives on the CONSIGNMENT ORDER
// line (consignment_order_items.unitPriceSen, migration 0064). The
// convert-to-invoice route already resolves CN line prices the same way
// (consignment-notes.ts: SELECT productCode, unitPriceSen FROM
// consignment_order_items WHERE consignmentOrderId = ? then match by
// productCode). This module factors that resolution into a bulk, per-CN
// value map so the CN list row can carry a `valueSen` exactly like the DO
// list row does (delivery-orders.ts → loadDoValueMap).
//
// CO resolution per item (a CN MAY span multiple COs — items can come from
// different production orders, each tied to its own CO):
//   1. item.productionOrderId → production_orders.consignmentOrderId  (the
//      item's OWN CO — correct even when the CN header points at a
//      different / no CO, and the only correct source for a multi-CO CN).
//   2. CN header consignment_notes.consignmentOrderId                  (fallback
//      when the item has no PO link, e.g. a manually-added line).
// Then price = consignment_order_items[(coId, productCode)].unitPriceSen.
// Fallback 0 when no CO price is found (mirrors do-value's last-resort 0).
//
// NOTE on schema: consignment_items has NO per-item CO-number column — the
// only per-item link to a CO is via productionOrderId (migration 0066). So
// the multi-CO resolution goes through production_orders, NOT a string CO
// number on the item. Verified against migrations/0064 + 0066.
// ---------------------------------------------------------------------------

export type CoLinePriceIndex = {
  // `${consignmentOrderId}|${productCode}` → unitPriceSen
  byCoCode: Map<string, number>;
  // productionOrderId → consignmentOrderId (the item's own CO)
  poToCo: Map<string, string>;
};

// Whole-org CO price index (2 bulk reads, no N+1). consignment_order_items
// has no orgId column, so it is scoped via its parent consignment_orders.
export async function loadCoLinePriceIndex(
  db: D1Database,
  orgId: string,
): Promise<CoLinePriceIndex> {
  const [coiRes, poRes] = await Promise.all([
    db
      .prepare(
        `SELECT coi.consignmentOrderId AS consignmentOrderId,
                coi.productCode        AS productCode,
                coi.unitPriceSen       AS unitPriceSen
           FROM consignment_order_items coi
           JOIN consignment_orders co ON co.id = coi.consignmentOrderId
          WHERE co.orgId = ?`,
      )
      .bind(orgId)
      .all<{
        consignmentOrderId: string | null;
        productCode: string | null;
        unitPriceSen: number | null;
      }>(),
    db
      .prepare(
        "SELECT id, consignmentOrderId FROM production_orders WHERE orgId = ? AND consignmentOrderId IS NOT NULL",
      )
      .bind(orgId)
      .all<{ id: string; consignmentOrderId: string | null }>(),
  ]);

  const byCoCode = new Map<string, number>();
  for (const r of coiRes.results ?? []) {
    const co = r.consignmentOrderId ?? "";
    const code = r.productCode ?? "";
    if (!co || !code) continue;
    const key = `${co}|${code}`;
    // First price wins — a CO line is unique per (CO, productCode) in
    // practice; the guard keeps the map deterministic if duplicates exist.
    if (!byCoCode.has(key)) byCoCode.set(key, Number(r.unitPriceSen) || 0);
  }

  const poToCo = new Map<string, string>();
  for (const p of poRes.results ?? []) {
    if (p.consignmentOrderId) poToCo.set(p.id, p.consignmentOrderId);
  }

  return { byCoCode, poToCo };
}

// Resolve one CN item's unit price (in sen). headerCoId is the parent CN's
// consignment_notes.consignmentOrderId, used as a fallback when the item
// carries no production-order link.
export function priceForCnItem(
  idx: CoLinePriceIndex,
  productionOrderId: string | null | undefined,
  headerCoId: string | null | undefined,
  productCode: string | null | undefined,
): number {
  const code = productCode ?? "";
  if (!code) return 0;
  // Item's OWN CO first (correct for multi-CO CNs), header CO as fallback.
  const itemCo = productionOrderId
    ? idx.poToCo.get(productionOrderId)
    : undefined;
  const coId = itemCo || headerCoId || "";
  if (coId) {
    const price = idx.byCoCode.get(`${coId}|${code}`);
    if (price != null) return price;
  }
  return 0;
}

// Per-CN exact value (Σ item.quantity × its CO-line unitPriceSen).
export async function loadCnValueMap(
  db: D1Database,
  orgId: string,
): Promise<Map<string, number>> {
  const [idx, itemsRes, notesRes] = await Promise.all([
    loadCoLinePriceIndex(db, orgId),
    db
      .prepare(
        "SELECT consignmentNoteId, productionOrderId, productCode, quantity FROM consignment_items WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{
        consignmentNoteId: string;
        productionOrderId: string | null;
        productCode: string | null;
        quantity: number | null;
      }>(),
    db
      .prepare(
        "SELECT id, consignmentOrderId FROM consignment_notes WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{ id: string; consignmentOrderId: string | null }>(),
  ]);

  const cnHeaderCo = new Map<string, string>();
  for (const n of notesRes.results ?? []) {
    cnHeaderCo.set(n.id, n.consignmentOrderId ?? "");
  }

  const m = new Map<string, number>();
  for (const it of itemsRes.results ?? []) {
    const price = priceForCnItem(
      idx,
      it.productionOrderId,
      cnHeaderCo.get(it.consignmentNoteId) ?? "",
      it.productCode,
    );
    const add = price * (it.quantity || 0);
    m.set(
      it.consignmentNoteId,
      (m.get(it.consignmentNoteId) ?? 0) + add,
    );
  }
  return m;
}

// Per-CN parent-CO customer references (the consignment-side equivalent of
// DO's customerPOId / customerRef). Resolved from the CN header's
// consignmentOrderId → consignment_orders. customerPOId mirrors the DO row
// field name but is populated from the CO's customerCOId. Empty string when
// the CN has no parent CO or the CO row is gone.
export type CnCustomerRef = {
  customerPOId: string;
  customerCO: string;
  reference: string;
};

export async function loadCnCustomerRefMap(
  db: D1Database,
  orgId: string,
): Promise<Map<string, CnCustomerRef>> {
  const [notesRes, cosRes] = await Promise.all([
    db
      .prepare(
        "SELECT id, consignmentOrderId FROM consignment_notes WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{ id: string; consignmentOrderId: string | null }>(),
    db
      .prepare(
        "SELECT id, customerCO, customerCOId, reference FROM consignment_orders WHERE orgId = ?",
      )
      .bind(orgId)
      .all<{
        id: string;
        customerCO: string | null;
        customerCOId: string | null;
        reference: string | null;
      }>(),
  ]);

  const coById = new Map<
    string,
    { customerCO: string; customerCOId: string; reference: string }
  >();
  for (const co of cosRes.results ?? []) {
    coById.set(co.id, {
      customerCO: co.customerCO ?? "",
      customerCOId: co.customerCOId ?? "",
      reference: co.reference ?? "",
    });
  }

  const m = new Map<string, CnCustomerRef>();
  for (const n of notesRes.results ?? []) {
    const co = n.consignmentOrderId
      ? coById.get(n.consignmentOrderId)
      : undefined;
    m.set(n.id, {
      customerPOId: co?.customerCOId ?? "",
      customerCO: co?.customerCO ?? "",
      reference: co?.reference ?? "",
    });
  }
  return m;
}
