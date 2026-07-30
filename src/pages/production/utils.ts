// Shared helpers extracted from production/index.tsx.
import type { Cell, CellState, ProductionOrder } from "./types";

export const DEPARTMENTS = [
  { name: "Fab Cut",    code: "FAB_CUT" },
  { name: "Fab Sew",    code: "FAB_SEW" },
  { name: "Foam Cut",   code: "FOAM_CUTTING" },
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
  // Malaysia-local date (UTC+8, no DST). `new Date().toISOString()` is UTC, so
  // before 08:00 MYT it returns YESTERDAY — which mis-classified cells as
  // "pending" instead of "overdue", and made different users (different
  // timezones / device clocks) see different overdue sets for the same data.
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
    // Malaysia-local "today" (see todayISO) so overdue is consistent for all
    // users regardless of their browser timezone / clock.
    const today = todayISO();
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

// Whole-PO overdue predicate. Two modes (dept = null vs string):
//
//   Overview mode (dept = null): "will we ship on time?". A PO is overdue
//   when its SO "Our Expected DD" (hookkaExpectedDD — the date the operator
//   reads in the Overview cell) has passed AND the PO's UPHOLSTERY JC isn't
//   done (COMPLETED / TRANSFERRED). UPH is the ship-readiness gate — once UPH
//   is done the PO is effectively ready. POs without any UPH JC (legacy /
//   non-upholstered items) are skipped so the count never accuses something
//   that has no UPH stage. A PO with no hookkaExpectedDD (empty, or CO-origin
//   which never gets one) can't be late against a date it doesn't have, so it
//   is never overdue here (2026-06-10 — was keyed off targetEndDate).
//
//   Per-dept mode (dept = "FAB_CUT" | "FAB_SEW" | …): "is this dept
//   missing its own deadline?". A PO is overdue at this dept when one of
//   its JCs for that dept has dueDate < today AND isn't done. POs with
//   no JC for that dept are skipped (the cell is empty in the matrix; we
//   don't accuse a dept of being late on work it doesn't own).
//
// Returns false for COMPLETED / CANCELLED POs in both modes so the count
// never includes already-shipped or killed orders.
export function isOverduePO(
  po: ProductionOrder,
  today: string,
  dept: string | null = null,
): boolean {
  if (po.status === "COMPLETED" || po.status === "CANCELLED") return false;

  if (dept === null) {
    // Overview rule: SO "Our Expected DD" passed AND UPHOLSTERY not done.
    if (!po.hookkaExpectedDD || po.hookkaExpectedDD >= today) return false;
    const uph = (po.jobCards ?? []).filter((j) => j.departmentCode === "UPHOLSTERY");
    if (uph.length === 0) return false;
    return uph.some((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED");
  }

  // Per-dept rule: that dept's JC dueDate passed AND not done.
  const deptJcs = (po.jobCards ?? []).filter((j) => j.departmentCode === dept);
  if (deptJcs.length === 0) return false;
  return deptJcs.some(
    (j) =>
      !!j.dueDate &&
      j.dueDate < today &&
      j.status !== "COMPLETED" &&
      j.status !== "TRANSFERRED",
  );
}

// Earliest overdue date associated with this PO, scoped to the same
// rule as isOverduePO. Used to sort the per-SO overdue breakdown list
// "earliest first" so the operator can prioritize. Returns "" if the PO
// is not overdue under the given rule.
//
//   Overview (dept = null): if hookkaExpectedDD < today AND UPH is open,
//   return hookkaExpectedDD (the SO "Our Expected DD" is the anchor the
//   operator reads — UPH dueDate isn't what slipped against the promise).
//   Returns "" otherwise (incl. empty / CO-origin DD — 2026-06-10).
//
//   Per-dept (dept = string): earliest dueDate across that dept's open
//   JCs that have already passed today. Returns "" if no such JC.
export function earliestOverdueDateOnPO(
  po: ProductionOrder,
  today: string,
  dept: string | null = null,
): string {
  if (po.status === "COMPLETED" || po.status === "CANCELLED") return "";

  if (dept === null) {
    if (!po.hookkaExpectedDD || po.hookkaExpectedDD >= today) return "";
    const uph = (po.jobCards ?? []).filter((j) => j.departmentCode === "UPHOLSTERY");
    if (uph.length === 0) return "";
    const stillOpen = uph.some(
      (j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED",
    );
    return stillOpen ? po.hookkaExpectedDD : "";
  }

  let earliest = "";
  for (const jc of po.jobCards ?? []) {
    if (jc.departmentCode !== dept) continue;
    if (!jc.dueDate) continue;
    if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") continue;
    if (jc.dueDate < today) {
      if (!earliest || jc.dueDate < earliest) earliest = jc.dueDate;
    }
  }
  return earliest;
}
