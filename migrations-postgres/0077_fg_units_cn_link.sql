-- ============================================================================
-- Migration 0077 - Add cnId column + index to fg_units so the Consignment
-- Note dispatch flow can stamp finished-goods units the same way DO does.
--
-- BACKGROUND:
--   Until now, flipping a CN ACTIVE → PARTIALLY_SOLD ("Mark Dispatched")
--   only updated consignment_notes.status + dispatchedAt — fg_units stayed
--   PENDING with no doId/cnId pointer, no STOCK_OUT row was written, and
--   wip_items.stockQty kept the residual UPH ledger entry. Net effect: the
--   goods physically left the warehouse via the CN, but the Inventory page's
--   Available count never dropped. DO has the inverse cascade
--   (delivery-orders.ts forward block ~lines 1346-1469, reverse block
--   ~1471-1577); this migration is the schema-side prerequisite for
--   cloning that cascade onto the CN code path.
--
-- WHY A SEPARATE COLUMN (not reusing doId):
--   A unit's source path (DO vs CN) determines the lifecycle semantics —
--   DO's LOADED → DELIVERED → fg_units.deliveredAt is "sold to end customer";
--   CN's equivalent is "consigned to branch, possibly returns" with
--   different downstream cascades (per-line consignment_items.soldDate
--   instead of header-level deliveredAt). Overloading doId would silently
--   fan out wrong joins on every report that filters fg_units by source
--   document, so the two pointers stay disjoint. A unit can hold AT MOST
--   ONE of {doId, cnId} at a time — the cascade WHERE clauses enforce
--   that with `(doId IS NULL OR doId='') AND (cnId IS NULL OR cnId='')`.
--
-- IDEMPOTENCY:
--   ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS — re-running this
--   migration on a database that already has the column is a no-op.
--
-- DEPLOYMENT:
--   Apply MANUALLY via the Supabase SQL Editor. The CI step that
--   auto-applied D1 migrations was retired 2026-04-27 (see MEMORY.md note
--   about D1 retirement / Hyperdrive cutover). Until this is applied, the
--   forward-cascade UPDATE in updateConsignmentNoteById will throw
--   "column cnId does not exist" — apply BEFORE deploying the matching
--   backend change, or revert the CN dispatch path until you do.
-- ============================================================================

ALTER TABLE fg_units
  ADD COLUMN IF NOT EXISTS cnId TEXT;

-- Index supports the reverse cascade's `SELECT DISTINCT poId WHERE cnId = ?`
-- and the forward cascade's idempotency guard `(cnId IS NULL OR cnId='')`.
CREATE INDEX IF NOT EXISTS idx_fg_units_cn_id
  ON fg_units(cnId);
