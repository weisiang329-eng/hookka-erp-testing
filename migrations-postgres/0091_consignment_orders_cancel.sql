-- ============================================================================
-- Migration 0091 — Consignment Orders soft-cancel columns.
--
-- Backs the new POST /api/consignment-orders/:id/cancel endpoint.  The
-- existing DELETE /:id refuses anything that isn't DRAFT (orphaning
-- production_orders / consignment_notes / inventory writes), so the
-- correct semantic for a non-DRAFT order the operator no longer wants is
-- a soft cancel: row stays in the table (audit trail intact), status
-- flips to CANCELLED, and downstream actions (production / delivery /
-- invoicing) are blocked by the existing status checks.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) so re-runs are safe.
-- ============================================================================

ALTER TABLE consignment_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE consignment_orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
