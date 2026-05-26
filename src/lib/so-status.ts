// ---------------------------------------------------------------------------
// so-status.ts — single source of truth for SO/CO status buckets.
//
// 2026-05-26 system-wide filter audit (Wei Siang: "last month outstanding 也
// 明显有问题") found "Outstanding", "Pending Delivery", and "Completed" each
// defined with DIFFERENT status sets in Sales vs Consignment vs Delivery
// pages. Same operator concept; different math; numbers desynced under any
// filter combination. Audit list:
//
//   • Sales `OUTSTANDING_STATUSES`   = {CONFIRMED, IN_PRODUCTION,
//                                       READY_TO_SHIP, ON_HOLD}
//   • CO     in-page literal         = {CONFIRMED, IN_PRODUCTION,
//                                       READY_TO_SHIP, SHIPPED}   ← different!
//   • Sales  `completedCount`        = sum [CLOSED]              ← always 0
//   • CO     `completedCount`        = sum [DELIVERED, INVOICED, CLOSED]
//
// Centralising here so a future enum drift fails at the import site, not at
// the operator's eyes. Pairs with `feedback_validation_frontend_backend_
// unified.md` (any rule must fail the same way in 2+ places).
//
// Single rule for the buckets (post 2026-05-26):
//
//   STATUS              | bucket
//   --------------------+--------------------------------
//   DRAFT               | Draft           (tab only)
//   CONFIRMED           | Outstanding     (factory work pending)
//   IN_PRODUCTION       | Outstanding
//   READY_TO_SHIP       | Outstanding
//   ON_HOLD             | Outstanding
//   SHIPPED             | Pending Delivery (in transit)
//   DELIVERED           | Completed       (goods at customer)
//   INVOICED            | Completed
//   CLOSED              | Completed
//   CANCELLED           | (none — excluded from every bucket)
//
// Note: READY_TO_SHIP is INTENTIONALLY in Outstanding, not Pending Delivery.
// Wei Siang 2026-05-16: "Outstanding = goods NOT yet out the door". Once a
// DO dispatches the SO/CO it cascades to SHIPPED — only THEN is it "out
// the door" and counts as Pending Delivery.
//
// The previous Sales page double-counted READY_TO_SHIP in both Outstanding
// AND Pending Delivery, and the CO page used a different OUTSTANDING set
// AND a different Completed set. Both fixed by routing through here.
// ---------------------------------------------------------------------------

/** Orders still being made in the factory — work not yet dispatched. */
export const OUTSTANDING_STATUSES: ReadonlySet<string> = new Set([
  "CONFIRMED",
  "IN_PRODUCTION",
  "READY_TO_SHIP",
  "ON_HOLD",
]);

/**
 * Goods that have left the factory but not yet reached the customer.
 * Exactly one status — SHIPPED. READY_TO_SHIP stays in Outstanding because
 * the goods are still on Hookka's floor.
 */
export const PENDING_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  "SHIPPED",
]);

/**
 * Order cycle done — goods at customer. DELIVERED + INVOICED + CLOSED.
 *
 * Sales had this = {CLOSED} only until 2026-05-26 — the operator's screen
 * showed "Completed: 0" for filters that contained dozens of DELIVERED /
 * INVOICED orders, which trained Wei Siang to ignore the card entirely.
 * Aligned with CO and the operator's actual definition: once goods are
 * with the customer, the order is "done" for KPI purposes.
 */
export const COMPLETED_STATUSES: ReadonlySet<string> = new Set([
  "DELIVERED",
  "INVOICED",
  "CLOSED",
]);

/**
 * Synthetic "Confirmed (all)" group — everything that isn't DRAFT, ON_HOLD
 * paused, or CANCELLED. Matches Wei Siang's "CS" reading: "every order I've
 * actually sold". Mirrors the backend `CS_STATUSES` set in
 * routes/sales-orders.ts.
 *
 * The literal CONFIRMED status is a brief checkpoint between DRAFT and
 * IN_PRODUCTION — treating it alone meant a 444-order book reported RM 287
 * of revenue while all the real money sat in IN_PRODUCTION / READY_TO_SHIP.
 */
export const CONFIRMED_STATUSES: ReadonlySet<string> = new Set([
  "CONFIRMED",
  "IN_PRODUCTION",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "INVOICED",
  "CLOSED",
]);

/**
 * Test helpers — predicate form of the sets above. Use these in code
 * instead of `OUTSTANDING_STATUSES.has(s)` so the call site reads
 * naturally and the import stays narrow.
 */
export const isOutstanding = (s: string): boolean =>
  OUTSTANDING_STATUSES.has(s);
export const isPendingDelivery = (s: string): boolean =>
  PENDING_DELIVERY_STATUSES.has(s);
export const isCompleted = (s: string): boolean => COMPLETED_STATUSES.has(s);
export const isConfirmedGroup = (s: string): boolean =>
  CONFIRMED_STATUSES.has(s);

/**
 * Count statuses in a status->count map. Convenience for KPI cards that
 * fetch a /stats `byStatus` object.
 */
export function sumByStatuses(
  byStatus: Record<string, number>,
  statuses: Iterable<string>,
): number {
  let n = 0;
  for (const s of statuses) {
    n += byStatus[s] ?? 0;
  }
  return n;
}
