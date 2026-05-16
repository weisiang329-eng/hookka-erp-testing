// Single source of truth for the Delivery page's Planning / Pending Delivery
// classification. The dashboard's "Pending Delivery" card and the Delivery
// page MUST show the same number, so both import these predicates instead of
// each re-deriving the gate (the dashboard previously replicated it off the
// raw job_cards table and drifted to RM 25,218 vs the page's RM 50,793).

export type PipelineJobCard = {
  departmentCode: string;
  status: string;
  completedDate?: string | null;
  wipType?: string;
};

export type PipelinePO = {
  id: string;
  status: string;
  consignmentOrderId?: string;
  itemCategory?: string;
  specialOrder?: string;
  jobCards?: PipelineJobCard[];
};

// Mirrors api/routes/fg-units.ts isHeadboardOnlySpecial — one rule shared
// across the codebase so the planning/ready filters stay in sync with the
// backend cascade.
export function isHbOnlySpecial(specialOrder: string | null | undefined): boolean {
  if (!specialOrder) return false;
  return specialOrder.toLowerCase().includes("headboard only");
}

// Drop DIVAN UPH JCs when the PO is a BEDFRAME + Headboard Only — matches
// filterJcsForCompletionGate in the backend production-orders route. Legacy
// HB-only POs carry stranded DIVAN job cards that will never complete;
// ignoring them lets the row qualify for Pending Delivery the moment the HB
// pieces are packed.
export function pickRelevantUphCards(po: PipelinePO): PipelineJobCard[] {
  const uph = (po.jobCards || []).filter(
    (j) => j.departmentCode === "UPHOLSTERY",
  );
  const isBf = (po.itemCategory || "").toUpperCase() === "BEDFRAME";
  if (!isBf || !isHbOnlySpecial(po.specialOrder)) return uph;
  return uph.filter((j) => (j.wipType || "").toUpperCase() !== "DIVAN");
}

// Planning: PO still in production — has upholstery cards and at least one
// is not yet done. Excludes CANCELLED/COMPLETED and CO-sourced POs.
export function poInPlanning(po: PipelinePO): boolean {
  if (po.status === "COMPLETED" || po.status === "CANCELLED") return false;
  if (po.consignmentOrderId) return false;
  const uphCards = pickRelevantUphCards(po);
  if (uphCards.length === 0) return false;
  return uphCards.some((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED");
}

// Pending Delivery: production complete (all upholstery cards done), not
// CANCELLED, not CO-sourced, and not already on a non-cancelled DO.
export function poReadyForDelivery(po: PipelinePO, linkedPOIds: Set<string>): boolean {
  if (po.status === "CANCELLED") return false;
  if (po.consignmentOrderId) return false;
  if (linkedPOIds.has(po.id)) return false;
  const uphCards = pickRelevantUphCards(po);
  if (uphCards.length === 0) return false;
  return uphCards.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
}

// Set of PO IDs already carried on a non-cancelled, non-virtual DO. Built
// from the delivery_order_items array (DO stores only one representative
// salesOrderId, so SO-level matching misses siblings — BUG-2026-04-27).
export function buildLinkedPOIds(
  deliveryOrders: { id: string; status: string; items?: { productionOrderId?: string | null }[] }[],
): Set<string> {
  const linked = new Set<string>();
  for (const d of deliveryOrders) {
    if (d.status === "CANCELLED" || d.id.startsWith("virt-")) continue;
    for (const it of d.items || []) {
      if (it.productionOrderId) linked.add(it.productionOrderId);
    }
  }
  return linked;
}
