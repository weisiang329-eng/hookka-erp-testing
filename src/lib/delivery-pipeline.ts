// Single source of truth for the Delivery page's Planning / Pending Delivery
// classification. The dashboard's "Pending Delivery" card and the Delivery
// page MUST show the same number, so both import these predicates instead of
// each re-deriving the gate (the dashboard previously replicated it off the
// raw job_cards table and drifted to RM 25,218 vs the page's RM 50,793).

import { parseRepairScope } from "./repair-scope";
import { aggregateRacksFromPackingCards } from "./rack-format";

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
  // Service-order Repair Scope snapshot (0160, JSON string or null).
  // A CUSTOM scope can exclude UPHOLSTERY entirely — the readiness
  // fallback below keys on this field, never on card absence alone.
  repairScope?: string | null;
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

// Repair-Scope fallback predicate (0160): TRUE only when the PO carries a
// stamped non-FULL scope that EXCLUDES UPHOLSTERY (only a CUSTOM scope can —
// every owner preset includes it). Keyed on the scope, never on UPH-card
// absence alone, so a normal full PO whose UPH cards merely haven't been
// created yet can NOT slip through the gates below.
function repairScopeExcludesUph(po: PipelinePO): boolean {
  const scope = parseRepairScope(po.repairScope ?? null);
  return scope !== null && !scope.depts.includes("UPHOLSTERY");
}

// Planning: PO still in production — has upholstery cards and at least one
// is not yet done. Excludes CANCELLED/COMPLETED and CO-sourced POs.
// Scoped PO without UPHOLSTERY in scope: fall back to "any existing job
// card not yet done" (its UPH cards were never built, by design).
export function poInPlanning(po: PipelinePO): boolean {
  if (po.status === "COMPLETED" || po.status === "CANCELLED") return false;
  if (po.consignmentOrderId) return false;
  const uphCards = pickRelevantUphCards(po);
  if (uphCards.length === 0) {
    if (!repairScopeExcludesUph(po)) return false;
    const jcs = po.jobCards || [];
    if (jcs.length === 0) return false;
    return jcs.some((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED");
  }
  return uphCards.some((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED");
}

// Pending Delivery: production complete (all upholstery cards done), not
// CANCELLED, not CO-sourced, and not already on a non-cancelled DO.
// Scoped PO without UPHOLSTERY in scope: ready when EVERY existing job card
// is COMPLETED/TRANSFERRED (zero cards never qualifies).
export function poReadyForDelivery(po: PipelinePO, linkedPOIds: Set<string>): boolean {
  if (po.status === "CANCELLED") return false;
  // A held PO is paused work — it belongs in Outstanding, not Pending Delivery,
  // even if its upholstery cards happened to complete before it was put on hold.
  if (po.status === "ON_HOLD") return false;
  if (po.consignmentOrderId) return false;
  if (linkedPOIds.has(po.id)) return false;
  const uphCards = pickRelevantUphCards(po);
  if (uphCards.length === 0) {
    const jcs = po.jobCards || [];
    if (jcs.length === 0) return false;
    const allDone = jcs.every(
      (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
    );
    // Products whose production route has NO upholstery step — ACCESSORY
    // pillows / cushions finish via FAB_CUT -> FAB_SEW -> PACKING and never
    // get an UPHOLSTERY job card. Without this branch they were COMPLETED yet
    // permanently stuck out of Pending Delivery (BUG-2026-06-20-001: 16 sofa-
    // pillow POs across 7 SOs un-shippable). The backend only flips a PO to
    // COMPLETED once every RELEVANT dept is done, so a sofa still mid-
    // production stays IN_PRODUCTION (its uncompleted upholstery cards keep it
    // out) — trusting the COMPLETED status here can't let a half-made sofa slip
    // through.
    if (po.status === "COMPLETED") return allDone;
    // Scoped repair that excludes upholstery (0160): ready when all cards done.
    if (repairScopeExcludesUph(po)) return allDone;
    return false;
  }
  return uphCards.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
}

// Consignment mirror (CO-origin). The Consignment page classifies CO-origin
// POs exactly like Delivery does for SO-origin POs — same upholstery gate + the
// accessory/scoped no-UPHOLSTERY fallback. It had inlined the OLD, pre-accessory
// -fix predicate, so a COMPLETED pillow (ACCESSORY: FAB_CUT -> FAB_SEW ->
// PACKING, no UPHOLSTERY card) never reached the CN ready list — confirmed on
// prod: CO-2606-003-01 "LONG PILLOW", COMPLETED yet absent (BUG-2026-07-01-003,
// the CO twin of the DO-side BUG-2026-06-20-001). This reuses the IDENTICAL
// fallback poReadyForDelivery got. Kept as an explicit mirror (not a refactor of
// the live SO-origin predicate) so the delivery path is untouched; differs only
// by requiring a consignmentOrderId. Sofa behaviour is byte-identical to the old
// inline CN filter — only the no-UPHOLSTERY branch is new.
export function poReadyForConsignment(po: PipelinePO, linkedPOIds: Set<string>): boolean {
  if (po.status === "CANCELLED") return false;
  // Parity with poReadyForDelivery: a held PO is paused work — it belongs in
  // Outstanding, not the CN ready list, even if its cards happened to complete
  // before the hold. The inline CN filter this replaced lacked the guard, so a
  // held CO-PO could surface as ready-to-consign (DO side has excluded ON_HOLD
  // since the Pending-Delivery fix; CN had drifted).
  if (po.status === "ON_HOLD") return false;
  if (!po.consignmentOrderId) return false;
  if (linkedPOIds.has(po.id)) return false;
  const uphCards = pickRelevantUphCards(po);
  if (uphCards.length === 0) {
    const jcs = po.jobCards || [];
    if (jcs.length === 0) return false;
    const allDone = jcs.every(
      (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
    );
    if (po.status === "COMPLETED") return allDone;
    if (repairScopeExcludesUph(po)) return allDone;
    return false;
  }
  return uphCards.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
}

// Consignment "Planning" mirror of poInPlanning (CO-origin). The CN page's
// Planning tab had hand-inlined the raw `departmentCode === "UPHOLSTERY"`
// filter + `uphCards.length === 0 -> drop`, so it (a) missed pickRelevantUphCards'
// HB-only DIVAN drop and (b) diverged from the shared predicate — the same
// copy-drift class that hid completed pillows from the ready list. This is the
// exact poInPlanning body with the origin guard inverted (requires a CO link).
// Common sofa/bedframe behaviour is unchanged.
export function poInPlanningConsignment(po: PipelinePO): boolean {
  if (po.status === "COMPLETED" || po.status === "CANCELLED") return false;
  if (!po.consignmentOrderId) return false; // SO-origin POs go to the Delivery page
  const uphCards = pickRelevantUphCards(po);
  if (uphCards.length === 0) {
    if (!repairScopeExcludesUph(po)) return false;
    const jcs = po.jobCards || [];
    if (jcs.length === 0) return false;
    return jcs.some((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED");
  }
  return uphCards.some((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED");
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

// ---------------------------------------------------------------------------
// Shared Ready / Planning row builder (2026-07-13). Extracted VERBATIM from the
// Delivery page (src/pages/delivery/index.tsx mapPO + sibling tally) so the
// server can compute the SAME rows and stop shipping the ~1.2MB
// /api/production-orders?fields=minimal&include=jobCards to the client just to
// derive them. Both the FE and the /api/delivery-orders/ready-planning endpoint
// call this ONE function → the Ready/Planning lists are byte-identical by
// construction (same inputs, same code). See docs/PERF-DURABLE-ARCHITECTURE.md.
// ---------------------------------------------------------------------------
export type ReadyPlanningJobCard = PipelineJobCard & {
  wipLabel?: string;
  rackingNumber?: string;
};

export type ReadyPlanningPO = PipelinePO & {
  poNo: string;
  salesOrderId?: string;
  salesOrderNo?: string;
  companySOId?: string;
  customerPOId?: string;
  customerReference?: string;
  customerSO?: string;
  customerId?: string;
  customerName?: string;
  customerState?: string;
  productCode?: string;
  productName?: string;
  sizeLabel?: string;
  fabricCode?: string;
  quantity?: number;
  completedDate?: string | null;
  currentDepartment?: string;
  progress?: number;
  targetEndDate?: string;
  jobCards?: ReadyPlanningJobCard[];
};

export type ReadyPORow = {
  id: string;
  poNo: string;
  salesOrderId: string;
  salesOrderNo: string;
  customerPOId: string;
  customerReference: string;
  customerSO: string;
  customerId: string;
  customerName: string;
  customerState: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  repairScope: string | null;
  valueSen: number;
  unitM3: number;
  completedDate: string | null;
  uphCompletedDate: string | null;
  packingCompletedDate: string | null;
  rackingNumber: string;
  hookkaExpectedDD: string;
  currentDepartment: string;
  progress: number;
  setTotalSiblings: number;
  setReadySiblings: number;
  setComplete: boolean;
};

export type ReadyPlanningInputs = {
  allPOs: ReadyPlanningPO[];
  linkedPOIds: Set<string>;
  soMap: Map<
    string,
    { hookkaExpectedDD: string; companySOId: string; customerId: string }
  >;
  soRefMap: Map<
    string,
    { customerSO: string; reference: string; customerPO: string }
  >;
  poValMap: Map<string, number>;
  soPriceByProduct: Map<string, Map<string, number>>;
  productM3Map: Map<string, number>;
};

export function buildReadyPlanning(inputs: ReadyPlanningInputs): {
  ready: ReadyPORow[];
  planning: ReadyPORow[];
} {
  const {
    allPOs,
    linkedPOIds,
    soMap,
    soRefMap,
    poValMap,
    soPriceByProduct,
    productM3Map,
  } = inputs;

  const allUphDone = (po: ReadyPlanningPO): boolean => {
    const uph = pickRelevantUphCards(po);
    if (uph.length === 0) return false;
    return uph.every(
      (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
    );
  };
  const siblingsBySo = new Map<string, { total: number; ready: number }>();
  for (const po of allPOs) {
    if (po.status === "CANCELLED") continue;
    if (po.consignmentOrderId) continue;
    if (linkedPOIds.has(po.id)) continue;
    const uphCards = pickRelevantUphCards(po);
    if (uphCards.length === 0) continue;
    const soId = po.salesOrderId || "";
    if (!siblingsBySo.has(soId)) siblingsBySo.set(soId, { total: 0, ready: 0 });
    const slot = siblingsBySo.get(soId)!;
    slot.total += 1;
    if (allUphDone(po)) slot.ready += 1;
  }

  const mapPO = (po: ReadyPlanningPO): ReadyPORow => {
    const soInfo = soMap.get(po.salesOrderId || "");
    const isSofa = (po.itemCategory || "").toUpperCase() === "SOFA";
    const sib = isSofa
      ? siblingsBySo.get(po.salesOrderId || "") ?? { total: 1, ready: 1 }
      : { total: 1, ready: 1 };
    const hbOnlyPacking =
      (po.itemCategory || "").toUpperCase() === "BEDFRAME" &&
      isHbOnlySpecial(po.specialOrder);
    const packingCards = (po.jobCards ?? []).filter(
      (j) =>
        j.departmentCode === "PACKING" &&
        (!hbOnlyPacking || (j.wipType || "").toUpperCase() !== "DIVAN"),
    );
    return {
      id: po.id,
      poNo: po.poNo,
      salesOrderId: po.salesOrderId || "",
      salesOrderNo:
        po.companySOId || soInfo?.companySOId || po.salesOrderNo || "",
      customerPOId: po.customerPOId || "",
      customerReference: po.customerReference || "",
      customerSO:
        po.customerSO || soRefMap.get(po.salesOrderId || "")?.customerSO || "",
      customerId: po.customerId || soInfo?.customerId || "",
      customerName: po.customerName || "",
      customerState: po.customerState || "",
      productCode: po.productCode || "",
      productName: po.productName || "",
      itemCategory: po.itemCategory || "",
      sizeLabel: po.sizeLabel || "",
      fabricCode: po.fabricCode || "",
      quantity: po.quantity || 0,
      repairScope: po.repairScope ?? null,
      valueSen:
        poValMap.get(po.id) ??
        (soPriceByProduct.get(po.salesOrderId || "")?.get(po.productCode || "") ??
          0) * (po.quantity || 0),
      unitM3: productM3Map.get(po.productCode || "") ?? 0,
      completedDate: po.completedDate || null,
      uphCompletedDate: (() => {
        const uphCards = pickRelevantUphCards(po);
        if (uphCards.length === 0) return null;
        const dates = uphCards
          .map((j) => j.completedDate)
          .filter((d): d is string => !!d);
        return dates.length > 0 ? dates.sort().reverse()[0] : null;
      })(),
      packingCompletedDate: (() => {
        if (packingCards.length === 0) return null;
        const allDone = packingCards.every(
          (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
        );
        if (!allDone) return null;
        const dates = packingCards
          .map((j) => j.completedDate)
          .filter((d): d is string => !!d);
        return dates.length > 0 ? dates.sort().reverse()[0] : null;
      })(),
      rackingNumber: aggregateRacksFromPackingCards(packingCards),
      hookkaExpectedDD: soInfo?.hookkaExpectedDD || po.targetEndDate || "",
      currentDepartment: po.currentDepartment || "",
      progress: po.progress || 0,
      setTotalSiblings: sib.total,
      setReadySiblings: sib.ready,
      setComplete: sib.ready === sib.total,
    };
  };

  const planning = allPOs.filter(poInPlanning).map(mapPO);
  const ready = allPOs
    .filter((po) => poReadyForDelivery(po, linkedPOIds))
    .map(mapPO);
  return { ready, planning };
}
