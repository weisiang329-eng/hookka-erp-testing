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
  // own. Walk same-companySOId / same-baseModel / same-fabric siblings
  // and surface the anchor's FC so the Overview cell isn't blank.
  if (deptCode === "FAB_CUT" && cards.length === 0 && allOrders) {
    const mySoId = order.companySOId || order.salesOrderId || "";
    if (mySoId) {
      const isSofa = order.itemCategory === "SOFA";
      const myBase = (order.productCode || "").split("-")[0];
      const myFabric = order.fabricCode || "";
      for (const sib of allOrders) {
        if (sib.id === order.id) continue;
        if ((sib.companySOId || sib.salesOrderId || "") !== mySoId) continue;
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
    return { state: "empty", totalCards: 0, doneCards: 0, earliestDue: "", latestCompleted: "" };
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
  return { state, totalCards: cards.length, doneCards: done, earliestDue, latestCompleted };
}
