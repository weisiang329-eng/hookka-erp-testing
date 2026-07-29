import type { Env } from "../worker";

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
    // The auto-generated name for the inline CHECK in 0057_purchase_invoices.sql
    // is <table>_<column>_check. Dropping it relaxes the status enum so
    // PARTIAL_PAID is accepted.
    "ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_status_check",
    // BUG-2026-07-29-001: the LIVE prod constraint is named
    // purchase_invoices_status_chk (runtime CREATE TABLE naming), so the drop
    // above was a silent no-op via IF EXISTS — PARTIAL_PAID writes failed on
    // EVERY partial supplier payment since go-live (owner reported 2026-07-15;
    // caught red-handed by the restate error trap on PV-2607-006). Drop the
    // real name too, then re-add a permissive NAMED constraint — v2 is outside
    // this drop list so repeat calls stay no-ops (the ADD errors "already
    // exists" into the catch below).
    "ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_status_chk",
    "ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_status_chk_v2 CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','CONFIRMED','PARTIAL_PAID','PAID','CANCELLED'))",
  ]) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* table missing / no DDL perms — the readers below fall back gracefully */
    }
  }
}
