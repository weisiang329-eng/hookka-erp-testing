import type { Env } from "../worker";

/**
 * The ONE definition of which statuses a purchase invoice may hold.
 *
 * This lived in TWO places with two DIFFERENT lists, and they fought.
 * `purchase-invoices.ts` re-added `purchase_invoices_status_chk` WITHOUT
 * 'PARTIAL_PAID' (it predates partial payments); this module added `_chk_v2`
 * WITH it. The moment one supplier payment moved an invoice to PARTIAL_PAID,
 * the other module's ALTER could never succeed again — and `runSelfApply`
 * THROWS on a real failure while being awaited at the top of the PI create
 * handler. So every purchase invoice create failed from that point on, and
 * nothing said why: the error reached the global 500 handler, which strips the
 * message because it can leak schema names (owner 2026-08-04, on a scanned
 * ADD WOOD invoice: "还是不行啊，你不能根本解决一下吗？").
 *
 * One exported list, imported by both, so the two can no longer drift. Drop
 * then re-add, so whichever module boots first the end state is identical.
 */
export const PI_STATUS_CHECK_SQL: string[] = [
  // The auto-generated name for the inline CHECK in 0057 is
  // <table>_<column>_check; the LIVE prod one is <table>_status_chk (runtime
  // CREATE TABLE naming). Both must go, or a stale restrictive constraint
  // survives and rejects PARTIAL_PAID.
  "ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_status_check",
  "ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_status_chk",
  "ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_status_chk_v2",
  "ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_status_chk_v2 " +
    "CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','CONFIRMED','PARTIAL_PAID','PAID','CANCELLED'))",
];

// Runtime self-apply for the supplier partial-payment / supplier-discount schema.
//
// Two prod-schema facts that a migration FILE alone cannot guarantee (migrations
// do NOT auto-apply on deploy — see CLAUDE.md):
//   1. Migration 7 columns (purchase_invoices.paid_amount_sen +
//      supplier_payments.booked_sen/foreign_sen/pay_fx_rate) — added here.
//   2. purchase_invoices.status was created in 0057 as
//        CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PAID'))
//      with NO 'PARTIAL_PAID'. Partial supplier payments + supplier-discount
//      allocations write status='PARTIAL_PAID', which the original CHECK
//      REJECTS → the whole POST fails (constraint violation) on prod. We drop
//      the restrictive constraint so those writes succeed; migration 0189 /
//      Hookka迁移11 re-adds a permissive named constraint for full integrity.
//
// Idempotent — every statement is a cheap no-op once applied (ADD COLUMN IF NOT
// EXISTS / DROP CONSTRAINT IF EXISTS). Each is wrapped in try/catch so a missing
// table or a no-DDL-perms environment degrades gracefully: readers fall back to
// the legacy algorithm, writers surface the real constraint error (same as
// before). Call this before any code path that reads/writes those columns or
// sets status='PARTIAL_PAID'.
export async function ensurePartialPaymentColumns(
  db: Env["Variables"]["DB"],
): Promise<void> {
  for (const sql of [
    "ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS paid_amount_sen INTEGER DEFAULT 0",
    "ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS booked_sen INTEGER",
    "ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS foreign_sen INTEGER",
    "ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS pay_fx_rate DOUBLE PRECISION",
    // BUG-2026-07-29-001 / BUG-2026-08-04: the status CHECK. See
    // PI_STATUS_CHECK_SQL above — one list, shared, so it cannot drift again.
    ...PI_STATUS_CHECK_SQL,
  ]) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* table missing / no DDL perms — the readers below fall back gracefully */
    }
  }
}
