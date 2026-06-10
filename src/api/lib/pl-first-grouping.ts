// ---------------------------------------------------------------------------
// Packing-List-first auto-split — pure grouping + credit-projection helpers.
//
// The "Create Packing List" flow on the Delivery page lets the operator
// multi-select ready production orders across customers/hubs; the backend
// then splits the selection into one DRAFT delivery order per
// (customerId, hubId) pair — the enforced one-DO-per-customer-per-hub rule —
// and wraps every new DO into ONE packing list.
//
// These two functions are deliberately pure (no DB, no Hono) so the grouping
// and the all-or-nothing credit pre-validation can be unit-tested directly
// (tests/pl-first-autosplit.test.mjs). The route handler in
// src/api/routes/delivery-orders.ts (POST /packing-list-first) feeds them
// rows it loaded itself.
// ---------------------------------------------------------------------------

export type PlFirstPo = {
  poId: string;
  customerId: string;
  /** The parent SO's hubId; "" when the SO has no hub configured. */
  hubId: string;
};

export type PlFirstGroup = {
  customerId: string;
  hubId: string;
  poIds: string[];
};

/**
 * Partition production orders into delivery-order groups keyed by
 * (customerId, hubId). Deterministic: groups appear in first-seen order of
 * the input rows, and each group's poIds preserve the input order. A blank
 * hubId ("") is its own key — POs whose SO has no hub never share a DO with
 * a hub-assigned PO, so the printed DO always carries one unambiguous
 * Deliver-To address.
 */
export function groupPosByCustomerHub(pos: PlFirstPo[]): PlFirstGroup[] {
  const byKey = new Map<string, PlFirstGroup>();
  const ordered: PlFirstGroup[] = [];
  for (const po of pos) {
    // A \u0000 separator can't appear in either id, so the compound key is unambiguous.
    const key = `${po.customerId}\u0000${po.hubId}`;
    let group = byKey.get(key);
    if (!group) {
      group = { customerId: po.customerId, hubId: po.hubId, poIds: [] };
      byKey.set(key, group);
      ordered.push(group);
    }
    group.poIds.push(po.poId);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Credit pre-validation across ALL of a customer's groups.
//
// The per-DO credit gate in POST /api/delivery-orders checks
//   outstanding + thisDoTotal <= creditLimit
// for ONE DO at a time. Creating several DOs for the same customer in one
// packing-list-first request would pass that per-DO gate N times even when
// the COMBINED total blows the limit (outstandingSen only moves at invoice
// time, not at DO create). So the new flow pre-validates the SUM of every
// group's projected total per customer BEFORE creating anything — if any
// customer fails, the whole request is rejected and nothing is created.
//
// Per-group totals mirror the existing gate's price resolution exactly:
// DO line quantity x the SO line unit price for the matching productCode,
// where the price map is built first-price-wins over the group's parent SOs'
// sales_order_items (unknown productCode prices as 0, same as the gate).
// ---------------------------------------------------------------------------

export type CreditProjectionGroup = {
  customerId: string;
  /** Distinct parent-SO ids of the group's POs (non-empty ids only). */
  soIds: string[];
  /** One entry per DO line the group will produce. */
  items: Array<{ productCode: string; quantity: number }>;
};

export type CreditProjectionCustomer = {
  id: string;
  creditLimitSen: number;
  outstandingSen: number;
};

export type CreditFailure = {
  customerId: string;
  limitSen: number;
  outstandingSen: number;
  /** Combined projected total across every group of this customer. */
  doTotalSen: number;
  projectedSen: number;
};

export function projectCreditFailure(
  groups: CreditProjectionGroup[],
  priceRows: Array<{
    salesOrderId: string;
    productCode: string | null;
    unitPriceSen: number;
  }>,
  customers: CreditProjectionCustomer[],
): CreditFailure | null {
  const customerById = new Map(customers.map((c) => [c.id, c]));

  // Combined projected DO total per customer, accumulated group by group.
  const totalByCustomer = new Map<string, number>();
  const customerOrder: string[] = []; // first-seen order → deterministic failure pick
  for (const g of groups) {
    const soIdSet = new Set(g.soIds);
    // First price wins per productCode, scanning priceRows in their given
    // order restricted to this group's SOs — mirrors the per-DO gate, which
    // builds its map from a query over exactly that SO set.
    const priceByCode = new Map<string, number>();
    for (const r of priceRows) {
      if (!soIdSet.has(r.salesOrderId)) continue;
      if (r.productCode && !priceByCode.has(r.productCode)) {
        priceByCode.set(r.productCode, r.unitPriceSen);
      }
    }
    let groupTotalSen = 0;
    for (const it of g.items) {
      const unit = priceByCode.get(it.productCode) ?? 0;
      groupTotalSen += unit * it.quantity;
    }
    if (!totalByCustomer.has(g.customerId)) customerOrder.push(g.customerId);
    totalByCustomer.set(
      g.customerId,
      (totalByCustomer.get(g.customerId) ?? 0) + groupTotalSen,
    );
  }

  for (const customerId of customerOrder) {
    const cust = customerById.get(customerId);
    if (!cust) continue; // existence is validated separately by the route
    // creditLimitSen <= 0 = no limit configured — unchecked, same as the
    // per-DO gate.
    if (cust.creditLimitSen <= 0) continue;
    const doTotalSen = totalByCustomer.get(customerId) ?? 0;
    const projectedSen = cust.outstandingSen + doTotalSen;
    if (projectedSen > cust.creditLimitSen) {
      return {
        customerId,
        limitSen: cust.creditLimitSen,
        outstandingSen: cust.outstandingSen,
        doTotalSen,
        projectedSen,
      };
    }
  }
  return null;
}
