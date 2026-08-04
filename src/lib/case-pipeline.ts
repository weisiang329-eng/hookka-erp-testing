// ---------------------------------------------------------------------------
// case-pipeline.ts — the one true Service Case pipeline derivation.
//
// A Service Case moves through 8 stages (Opened → … → Closed). The stage is
// NOT a stored column — it is COMPUTED from the case status + its spawned
// Service Orders + their delivery orders + their production job cards. The
// owner treats this computed stage as the case's real "status" (the raw
// OPEN / IN_PROGRESS / CLOSED status is just an operator flag).
//
// This module is the single source of that derivation so the list page and
// the detail-page stepper never drift. It is PURE — no DB, no fetch, no
// Date.now() (callers pass `now` in) — so it is unit-testable in isolation.
//
// Status sets (from the authoritative route enums):
// • SV orders are sales_orders rows (src/api/routes/sales-orders.ts):
//   READY_TO_SHIP and beyond = production finished (repair done);
//   SHIPPED and beyond = delivery arranged; DELIVERED/INVOICED/CLOSED =
//   delivered. Their DOs (delivery_orders DRAFT→LOADED→IN_TRANSIT→
//   DELIVERED→INVOICED) refine that: any DO = arranged (the Pending
//   Dispatch stage on the Delivery page), DO DELIVERED/INVOICED = delivered.
// • Repair in progress (owner rule 2026-06-12): the moment ANY department's
//   job card on the SV order's production orders carries a completedDate.
//   Legacy service_orders: status IN_PRODUCTION/RESERVED/IN_REPAIR.
// • Legacy service_orders (src/api/routes/service-orders.ts lifecycle
//   OPEN→IN_PRODUCTION/RESERVED/IN_REPAIR→READY_TO_SHIP→DELIVERED→CLOSED):
//   READY_TO_SHIP+ = repair done, DELIVERED/CLOSED = delivered (they have
//   no delivery_orders rows).
// Later steps imply earlier ones along the fulfilment chain (delivered ⇒
// arranged ⇒ repair done ⇒ in progress), and Investigating lights up once
// the case left OPEN or any later step completed.
// ---------------------------------------------------------------------------

export const CASE_PIPELINE_STEPS = [
  "Opened",
  "Investigating",
  "Service Order",
  "Repair in progress",
  "Repair done",
  "Delivery arranged",
  "Delivered",
  "Closed",
] as const;

export type CasePipelineStep = (typeof CASE_PIPELINE_STEPS)[number];

// Status sets — kept here (not in detail.tsx) so the list + detail share one
// definition. Values match the route enums referenced in the header.
const SV_REPAIR_DONE_STATUSES = new Set([
  "READY_TO_SHIP", "SHIPPED", "DELIVERED", "INVOICED", "CLOSED",
]);
const SV_DISPATCHED_STATUSES = new Set(["SHIPPED", "DELIVERED", "INVOICED", "CLOSED"]);
const SV_DELIVERED_STATUSES = new Set(["DELIVERED", "INVOICED", "CLOSED"]);
const LEGACY_IN_PROGRESS_STATUSES = new Set(["IN_PRODUCTION", "RESERVED", "IN_REPAIR"]);
const LEGACY_REPAIR_DONE_STATUSES = new Set(["READY_TO_SHIP", "DELIVERED", "CLOSED"]);
const LEGACY_DELIVERED_STATUSES = new Set(["DELIVERED", "CLOSED"]);
const DO_DELIVERED_STATUSES = new Set(["DELIVERED", "INVOICED"]);

export type CasePipelineInput = {
  caseStatus: string;
  createdAt: string;
  investigatingAt?: string | null;
  closedAt?: string | null;
  // The case's spawned orders (legacy service_orders + SV sales_orders).
  // isSv steers which order table the row came from. status drives the
  // status-set checks; createdAt is the "Service Order" stage timestamp.
  orders: Array<{ isSv?: boolean; status: string; createdAt?: string | null }>;
  // Delivery orders whose salesOrderId is one of svOrderIds (the caller
  // pre-filters; the helper filters again defensively).
  dos: Array<{
    salesOrderId?: string | null;
    status?: string;
    createdAt?: string | null;
    dispatchedAt?: string | null;
    deliveredAt?: string | null;
  }>;
  // Production orders whose salesOrderId is one of svOrderIds, each with its
  // job cards (only completedDate is read).
  pos: Array<{
    salesOrderId?: string | null;
    jobCards?: Array<{ completedDate?: string | null }>;
  }>;
  // Ids of the SV (sales_orders) orders on this case — used to filter dos/pos.
  svOrderIds: string[];
};

export type CasePipelineResult = {
  // Index of the last completed step (0..7).
  index: number;
  // CASE_PIPELINE_STEPS[index].
  label: CasePipelineStep;
  // Per-step completion, length === CASE_PIPELINE_STEPS.length. doneFlags[0]
  // ("Opened") is always true for a real case.
  doneFlags: boolean[];
  // The timestamp the case ENTERED its current stage. Never null for a real
  // case — falls back along the chain to createdAt.
  enteredAt: string | null;
  // True when the case was CANCELLED. The stage is derived from the case's
  // service orders and their delivery orders, so a cancelled case whose SV
  // order had already been delivered kept reporting "Delivered" — the cancel
  // was invisible everywhere except the detail-page badge (owner 2026-08-04:
  // "在外面也看不到这个地方已经变 cancel 了"). Callers must render this
  // instead of `label`, not alongside it.
  cancelled: boolean;
};

// Smallest non-empty ISO string in a list (lexicographic order is
// chronological for ISO-8601). Ignores null / undefined / "".
function earliest(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (best === null || v < best) best = v;
  }
  return best;
}

// Largest non-empty ISO string in a list.
function latest(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

export function computeCasePipeline(input: CasePipelineInput): CasePipelineResult {
  const svIds = new Set(input.svOrderIds);
  const svOrders = input.orders.filter((o) => o.isSv);
  const legacyOrders = input.orders.filter((o) => !o.isSv);
  const caseDos = input.dos.filter((d) => !!d.salesOrderId && svIds.has(d.salesOrderId));
  const casePos = input.pos.filter((p) => !!p.salesOrderId && svIds.has(p.salesOrderId));

  // Every completedDate across the case's production orders' job cards.
  const completedDates = casePos.flatMap((p) =>
    (p.jobCards ?? []).map((j) => j.completedDate).filter((d): d is string => !!d),
  );

  // ---- done flags (the exact fulfilment chain, identical to the old CasePipeline) ----
  const delivered =
    caseDos.some((d) => DO_DELIVERED_STATUSES.has(d.status ?? "")) ||
    svOrders.some((o) => SV_DELIVERED_STATUSES.has(o.status)) ||
    legacyOrders.some((o) => LEGACY_DELIVERED_STATUSES.has(o.status));
  const arranged =
    delivered ||
    caseDos.length > 0 ||
    svOrders.some((o) => SV_DISPATCHED_STATUSES.has(o.status));
  const repairDone =
    arranged ||
    svOrders.some((o) => SV_REPAIR_DONE_STATUSES.has(o.status)) ||
    legacyOrders.some((o) => LEGACY_REPAIR_DONE_STATUSES.has(o.status));
  // Owner rule: any department's job card with a completedDate = the repair
  // is physically moving through production.
  const inProgress =
    repairDone ||
    completedDates.length > 0 ||
    legacyOrders.some((o) => LEGACY_IN_PROGRESS_STATUSES.has(o.status));
  const hasOrder = input.orders.length > 0;
  const cancelled = input.caseStatus === "CANCELLED";
  // A cancelled case is CLOSED for pipeline purposes — it is not still moving
  // through the chain, whatever its service orders went on to do.
  const closed = input.caseStatus === "CLOSED" || cancelled;
  const investigating =
    input.caseStatus !== "OPEN" || hasOrder || repairDone || closed;

  const doneFlags = [
    true, investigating, hasOrder, inProgress, repairDone, arranged, delivered, closed,
  ];

  // index = the LAST done step (steps imply earlier ones, but be robust to a
  // gap by taking the highest true flag rather than the first false).
  let index = 0;
  for (let i = 0; i < doneFlags.length; i++) {
    if (doneFlags[i]) index = i;
  }
  const label = CASE_PIPELINE_STEPS[index];

  // ---- enteredAt: the timestamp the case entered its CURRENT stage ----
  // Each stage's native timestamp from the input data; null when the data
  // doesn't carry it. We then walk DOWN the chain to the nearest earlier
  // non-null timestamp so enteredAt is never null for a real case.
  const orderEnteredAt = earliest(input.orders.map((o) => o.createdAt));
  const inProgressEnteredAt = earliest(completedDates); // first dept to finish
  const repairDoneEnteredAt = latest(completedDates); // all depts finished
  const arrangedEnteredAt = earliest(
    caseDos.map((d) => d.createdAt ?? d.dispatchedAt),
  );
  const deliveredEnteredAt = latest(
    caseDos.map((d) => d.deliveredAt ?? d.dispatchedAt),
  );

  // Per-stage timestamp, indexed by step. null where the stage has no native
  // timestamp in the data (filled by the fallback walk below).
  const stageTs: Array<string | null> = [
    input.createdAt || null, // Opened
    input.investigatingAt ?? input.createdAt ?? null, // Investigating
    orderEnteredAt, // Service Order
    inProgressEnteredAt, // Repair in progress
    repairDoneEnteredAt, // Repair done
    arrangedEnteredAt, // Delivery arranged
    deliveredEnteredAt, // Delivered
    input.closedAt ?? null, // Closed
  ];

  // Fall back to the nearest earlier non-null timestamp, finally createdAt.
  let enteredAt = stageTs[index];
  for (let i = index - 1; enteredAt == null && i >= 0; i--) {
    enteredAt = stageTs[i];
  }
  if (enteredAt == null) enteredAt = input.createdAt || null;

  return { index, label, doneFlags, enteredAt, cancelled };
}

// Whole days a case has been open: floor((end - start) / 1 day). end =
// closedAt for closed/cancelled cases (frozen), otherwise `now`. Returns 0
// for an unparseable / future start.
export function caseDaysOpen(
  createdAt: string,
  closedAt: string | null,
  now: number,
): number {
  if (!createdAt) return 0;
  const start = new Date(createdAt).getTime();
  if (isNaN(start)) return 0;
  const endMs = closedAt ? new Date(closedAt).getTime() : now;
  const end = isNaN(endMs) ? now : endMs;
  const days = Math.floor((end - start) / 86400000);
  return days < 0 ? 0 : days;
}

// Whole days the case has spent in its CURRENT stage: floor((end - enteredAt)
// / 1 day). end = closedAt for closed/cancelled cases (frozen at close),
// otherwise `now`. Returns 0 for a null / unparseable / future enteredAt.
export function caseStageDays(
  enteredAt: string | null,
  closedAt: string | null,
  now: number,
): number {
  if (!enteredAt) return 0;
  const start = new Date(enteredAt).getTime();
  if (isNaN(start)) return 0;
  const endMs = closedAt ? new Date(closedAt).getTime() : now;
  const end = isNaN(endMs) ? now : endMs;
  const days = Math.floor((end - start) / 86400000);
  return days < 0 ? 0 : days;
}
