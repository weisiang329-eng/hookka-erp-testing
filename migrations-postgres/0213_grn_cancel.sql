-- 0213 — a goods receipt can be CANCELLED.
--
-- A POSTED GRN had no way to die: un-post 409'd, delete 409'd, and the UI
-- exposed neither — so a receipt keyed against the wrong purchase order
-- consumed that PO line's receivedQty permanently. POST /api/grn/:id/cancel
-- reverses the posted stock (raw_materials.balanceQty + the receipt's
-- rm_batches lots) and restores purchase_order_items.receivedQty, then parks
-- the document at CANCELLED.
--
-- NOTE: this file is a RECORD ONLY. Migrations do not auto-apply on deploy in
-- this repo — the load-bearing copy is ensureGrnCancelSchema() in
-- src/api/routes/grn.ts, awaited at the top of the cancel handler. Keep the two
-- in step.

ALTER TABLE grns ADD COLUMN IF NOT EXISTS cancelled_at TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;

-- The status CHECK has to accept CANCELLED. Drop every name Postgres may have
-- generated (inline CHECK → <table>_<column>_check; runtime CREATE TABLE →
-- <table>_status_chk), then re-add one permissive named constraint — the same
-- drop-then-re-add shape as PI_STATUS_CHECK_SQL, which exists because two
-- modules once fought over this exact pattern on purchase_invoices.
ALTER TABLE grns DROP CONSTRAINT IF EXISTS grns_status_check;
ALTER TABLE grns DROP CONSTRAINT IF EXISTS grns_status_chk;
ALTER TABLE grns DROP CONSTRAINT IF EXISTS grns_status_chk_v2;
ALTER TABLE grns ADD CONSTRAINT grns_status_chk_v2
  CHECK (status IN ('DRAFT','CONFIRMED','POSTED','CANCELLED'));
