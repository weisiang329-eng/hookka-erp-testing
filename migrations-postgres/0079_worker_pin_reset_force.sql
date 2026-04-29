-- ============================================================================
-- Migration 0079 — Worker PIN: 4 → 6 digits, force-reset for existing rows.
--
-- Sprint 2 (pre-launch auth hardening). Background:
--   * The worker portal originally accepted 4-digit PINs (10^4 search space —
--     trivial to brute against a stolen empNo).
--   * Sprint 2 widens this to 6 digits and adds a per-worker force-reset flag.
--
-- This migration:
--   1. Adds worker_pins.must_reset BOOLEAN DEFAULT TRUE.
--   2. Sets must_reset = TRUE for every existing row, so day-1 every worker
--      whose 4-digit PIN is still in the table is forced through the reset
--      flow before they can sign in again.
--   3. Re-runnable. If must_reset already exists, the ALTER is a no-op.
--      The UPDATE is idempotent (re-setting TRUE on TRUE is harmless).
--
-- Application code (src/api/routes/worker-auth.ts):
--   * /login returns { success:false, error:"PIN_RESET_REQUIRED",
--                      needsReset:true } when must_reset=1.
--   * /reset-pin clears must_reset to 0 on a successful reset, so the next
--     /login call is unblocked.
--   * First-time PIN setup writes must_reset=0.
-- ============================================================================

ALTER TABLE worker_pins
  ADD COLUMN IF NOT EXISTS must_reset BOOLEAN DEFAULT TRUE NOT NULL;

-- Force every existing 4-digit PIN to be reset before next login.
-- Safe to re-run — UPDATE is idempotent.
UPDATE worker_pins SET must_reset = TRUE;
