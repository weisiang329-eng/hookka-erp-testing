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
  // Piece-level counts (NOT JC-level) — sofa JCs commonly carry
  // wipQty=N pieces, so a 2-of-3-pieces-done JC needs to show 2/3 in
  // the cell, not 0/1. piecesDone/piecesTotal are emitted by the
  // minimal /api/production-orders payload; legacy responses without
  // them fall back to (status === COMPLETED ? wipQty : 0) / wipQty.
  //
  // Priority: JC.status wins over piecesDone count. The API emits
  // `piecesDone ?? 0`, so the value is ALWAYS a number (never null) —
  // a COMPLETED JC that was finished without per-piece scanning shows
  // piecesDone=0. If we trusted piecesDone first, those cells would
  // render "0/1 overdue red" forever even though work is done. Status
  // first → piecesDone fallback fixes this and matches user expectation
  // ("if it's COMPLETED, show ✓").
  let done = 0;
  let totalPieces = 0;
  let allFullyDone = true;
  for (const c of cards) {
    const isJcDone =
      c.status === "COMPLETED" || c.status === "TRANSFERRED";
    const total = Math.max(1, c.piecesTotal ?? c.wipQty ?? 1);
    const cardDone = isJcDone
      ? total
      : Math.min(total, c.piecesDone ?? 0);
    done += cardDone;
    totalPieces += total;
    if (cardDone < total) allFullyDone = false;
  }
  const earliestDue =
    cards.map((c) => c.dueDate).filter(Boolean).sort()[0] || "";
  const latestCompleted =
    cards.map((c) => c.completedDate || "").filter(Boolean).sort().slice(-1)[0] || "";

  let state: CellState;
  if (allFullyDone) state = "done";
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
    // totalCards now means TOTAL PIECES (sum of wipQty across JCs in the
    // cell). doneCards = pieces actually completed. CellBox renders
    // doneCards/totalCards verbatim, so this gives operators piece-level
    // progress like "2/3" instead of the old JC-level "0/1".
    totalCards: totalPieces,
    doneCards: done,
    earliestDue,
    latestCompleted,
    isOffLeadtime,
  };
}
