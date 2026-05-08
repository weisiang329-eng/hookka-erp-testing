// Shared helpers extracted from production/index.tsx.
import type { Cell, CellState, ProductionOrder } from "./types";

export const DEPARTMENTS = [
  { name: "Fab Cut",    code: "FAB_CUT" },
  { name: "Fab Sew",    code: "FAB_SEW" },
  { name: "Foam",       code: "FOAM" },
  { name: "Wood Cut",   code: "WOOD_CUT" },
  { name: "Framing",    code: "FRAMING" },
  { name: "Webbing",    code: "WEBBING" },
  { name: "Upholstery", code: "UPHOLSTERY" },
  { name: "Packing",    code: "PACKING" },
] as const;

// Today as YYYY-MM-DD. Used for the page's default fltDueFrom/fltDueTo so
// the production grid (and the API call that backs it) only loads POs
// whose targetEndDate falls on today by default.
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function fmtShortDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mm = d.toLocaleString("en-US", { month: "short" });
  return `${d.getDate()} ${mm}`;
}

export function cellFor(
  order: ProductionOrder,
  deptCode: string,
  allOrders?: ProductionOrder[],
): Cell {
  let cards = order.jobCards.filter((j) => j.departmentCode === deptCode);
  // Option C — for FAB_CUT, the merged JC may live on the anchor PO of a
  // SOFA cross-PO group; this PO is a sibling and has zero FC JCs of its
  // own. Walk same-(SO|CO)/same-baseModel/same-fabric siblings and
  // surface the anchor's FC so the Overview cell isn't blank.
  // Consignment-Order POs use companyCOId / consignmentOrderId (not
  // companySOId / salesOrderId), so include both pairs in the order key
  // — without this, every sibling-of-anchor row in a CO group rendered
  // blank even though fabric was already cut.
  if (deptCode === "FAB_CUT" && cards.length === 0 && allOrders) {
    const myGroupId =
      order.companySOId ||
      order.salesOrderId ||
      order.companyCOId ||
      order.consignmentOrderId ||
      "";
    if (myGroupId) {
      const isSofa = order.itemCategory === "SOFA";
      const myBase = (order.productCode || "").split("-")[0];
      const myFabric = order.fabricCode || "";
      for (const sib of allOrders) {
        if (sib.id === order.id) continue;
        const sibGroupId =
          sib.companySOId ||
          sib.salesOrderId ||
          sib.companyCOId ||
          sib.consignmentOrderId ||
          "";
        if (sibGroupId !== myGroupId) continue;
        if (isSofa) {
          if ((sib.fabricCode || "") !== myFabric) continue;
          const sibBase = (sib.productCode || "").split("-")[0];
          if (sibBase !== myBase) continue;
        }
        const sibFc = sib.jobCards.filter((j) => j.departmentCode === "FAB_CUT");
        if (sibFc.length > 0) {
          cards = sibFc;
          break;
        }
      }
    }
  }
  if (cards.length === 0) {
    return {
      state: "empty",
      totalCards: 0,
      doneCards: 0,
      earliestDue: "",
      latestCompleted: "",
      isOffLeadtime: false,
    };
  }
  const done = cards.filter(
    (c) => c.status === "COMPLETED" || c.status === "TRANSFERRED",
  ).length;
  const earliestDue =
    cards.map((c) => c.dueDate).filter(Boolean).sort()[0] || "";
  const latestCompleted =
    cards.map((c) => c.completedDate || "").filter(Boolean).sort().slice(-1)[0] || "";

  let state: CellState;
  if (done === cards.length) state = "done";
  else {
    const today = new Date().toISOString().slice(0, 10);
    state = earliestDue && earliestDue < today ? "overdue" : "pending";
  }
  // Off-leadtime signal: any JC whose persisted dueDate doesn't match
  // the server-computed expectedDueDate (current leadtime plan).
  // Empty expectedDueDate = "no signal" (treat as on-plan). Done
  // suppresses the override — ✓ stays white per spec.
  const isOffLeadtime =
    state !== "done" &&
    cards.some(
      (c) =>
        !!c.expectedDueDate &&
        !!c.dueDate &&
        c.expectedDueDate !== c.dueDate,
    );
  return {
    state,
    totalCards: cards.length,
    doneCards: done,
    earliestDue,
    latestCompleted,
    isOffLeadtime,
  };
}

// Whole-PO overdue predicate. A PO is overdue when at least one of its
// non-PACKING job cards is overdue — i.e. the JC's dueDate < today AND
// the JC is not in a terminal "done" state (COMPLETED / TRANSFERRED).
// PACKING is excluded for parity with cellFor's treatment of the PACKING
// column as the customer-delivery anchor (matches what the operator sees
// painted red in the dept matrix). Returns false for COMPLETED / CANCELLED
// POs so the count never includes already-shipped or killed orders.
export function isOverduePO(po: ProductionOrder): boolean {
  if (po.status === "COMPLETED" || po.status === "CANCELLED") return false;
  const today = new Date().toISOString().slice(0, 10);
  for (const jc of po.jobCards ?? []) {
    if (jc.departmentCode === "PACKING") continue;
    if (!jc.dueDate) continue;
    if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") continue;
    if (jc.dueDate < today) return true;
  }
  return false;
}

// Earliest overdue JC dueDate across this PO (non-PACKING, not done).
// Used to sort the per-SO overdue breakdown list "earliest first" so the
// operator can prioritize. Returns "" if no JC is overdue.
export function earliestOverdueDateOnPO(po: ProductionOrder): string {
  const today = new Date().toISOString().slice(0, 10);
  let earliest = "";
  for (const jc of po.jobCards ?? []) {
    if (jc.departmentCode === "PACKING") continue;
    if (!jc.dueDate) continue;
    if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") continue;
    if (jc.dueDate < today) {
      if (!earliest || jc.dueDate < earliest) earliest = jc.dueDate;
    }
  }
  return earliest;
}
