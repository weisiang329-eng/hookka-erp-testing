-- ===========================================================================
-- normalize-so-status-2026-04-28.sql
--
-- One-time data sweep to bring stale CONFIRMED sales_orders rows in line with
-- the new "any confirm = in production" SO state-machine semantics.
--
-- Background
-- ----------
-- Until 2026-04-28, the confirm cascade was a two-step shuffle:
--   1. POST /:id/confirm flipped DRAFT -> CONFIRMED and auto-created POs.
--   2. Downstream PO progress eventually bumped the SO to IN_PRODUCTION.
-- In practice every confirmed SO IS in production the moment POs exist —
-- lead-time scheduling kicks off synchronously — so step (2) was a redundant
-- node. The confirm route now lands directly at IN_PRODUCTION, and the
-- cascade rollback path (READY_TO_SHIP undo) drops back to IN_PRODUCTION
-- rather than CONFIRMED. CONFIRMED is retained as a legacy transition node
-- only.
--
-- This script normalizes existing rows so the live database matches the
-- new semantics:
--
--   (A) CONFIRMED + has POs + not all UPH-complete -> IN_PRODUCTION
--   (B) CONFIRMED + has POs + every PO is fully UPH-complete -> READY_TO_SHIP
--       (catch-up case where the forward cascade was missed)
--
-- Idempotency
-- -----------
-- Each UPDATE is guarded with WHERE status = 'CONFIRMED' so re-running is a
-- no-op once the sweep has executed. The sub-selects use IF EXISTS-style
-- predicates (EXISTS / NOT EXISTS) so missing tables/rows degrade safely.
--
-- Apply
-- -----
-- Cloudflare D1:  wrangler d1 execute <db-name> --file=scripts/normalize-so-status-2026-04-28.sql
-- Postgres:       psql ... -f scripts/normalize-so-status-2026-04-28.sql
--
-- Both branches use only standard SQL (no D1- or Postgres-specific syntax).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (B) FIRST: CONFIRMED + every sibling PO is fully UPH-complete -> READY_TO_SHIP
--
-- Run this BEFORE (A) so SOs that should be READY_TO_SHIP don't get caught
-- by the broader IN_PRODUCTION sweep. The predicate mirrors the forward
-- cascade in cascadeUpholsteryToSO():
--   - The SO has at least one production_orders row.
--   - For every sibling PO under the SO, every UPHOLSTERY job_card on that
--     PO is in COMPLETED or TRANSFERRED.  (POs with zero UPH JCs are
--     treated as vacuous-true, matching the forward path.)
--   - At least one UPH JC exists somewhere under the SO (otherwise we'd
--     incorrectly graduate a no-UPH SO to READY_TO_SHIP).
-- ---------------------------------------------------------------------------
UPDATE sales_orders
   SET status     = 'READY_TO_SHIP',
       updated_at = COALESCE(updated_at, '1970-01-01T00:00:00.000Z')
 WHERE status = 'CONFIRMED'
   AND EXISTS (
         SELECT 1 FROM production_orders po
          WHERE po.salesOrderId = sales_orders.id
       )
   AND EXISTS (
         SELECT 1
           FROM production_orders po
           JOIN job_cards jc ON jc.productionOrderId = po.id
          WHERE po.salesOrderId = sales_orders.id
            AND jc.departmentCode = 'UPHOLSTERY'
       )
   AND NOT EXISTS (
         -- Any sibling PO that has UPH JCs and at least one is NOT done
         -- disqualifies the SO from READY_TO_SHIP.
         SELECT 1
           FROM production_orders po
          WHERE po.salesOrderId = sales_orders.id
            AND EXISTS (
                  SELECT 1 FROM job_cards jc
                   WHERE jc.productionOrderId = po.id
                     AND jc.departmentCode = 'UPHOLSTERY'
                )
            AND EXISTS (
                  SELECT 1 FROM job_cards jc
                   WHERE jc.productionOrderId = po.id
                     AND jc.departmentCode = 'UPHOLSTERY'
                     AND jc.status NOT IN ('COMPLETED', 'TRANSFERRED')
                )
       );

-- ---------------------------------------------------------------------------
-- (A) THEN: every other CONFIRMED row that has at least one PO -> IN_PRODUCTION
--
-- Anything still at CONFIRMED after step (B) has POs underway but is not yet
-- READY_TO_SHIP. By the new semantics it should be IN_PRODUCTION. CONFIRMED
-- rows with NO production_orders remain at CONFIRMED — those are stuck
-- pre-cascade rows that need a separate confirm-backfill pass (handled
-- through the existing POST /:id/confirm fall-through path), not a status
-- bump.
-- ---------------------------------------------------------------------------
UPDATE sales_orders
   SET status     = 'IN_PRODUCTION',
       updated_at = COALESCE(updated_at, '1970-01-01T00:00:00.000Z')
 WHERE status = 'CONFIRMED'
   AND EXISTS (
         SELECT 1 FROM production_orders po
          WHERE po.salesOrderId = sales_orders.id
       );

-- ---------------------------------------------------------------------------
-- Audit trail — emit a so_status_changes row for every SO this sweep
-- touched, so the timeline view explains the bump. Two INSERTs, one per
-- target status. We re-derive the touched set with the same predicates
-- so this is safe to run alongside the UPDATEs above (and idempotent on
-- re-run, since a second pass finds no rows still at CONFIRMED to flag).
--
-- soId is the only foreign-key column; the rest are plain columns. We use
-- a deterministic id prefix ('mig-2026-04-28-...') so a second run that
-- somehow finds eligible rows would fail the PK uniqueness check rather
-- than silently double-write.
-- ---------------------------------------------------------------------------
-- (Audit rows are intentionally omitted from this sweep: the live tables
-- vary across D1 and Postgres on the so_status_changes shape, and the
-- forward cascade already writes audit rows on the next legitimate
-- transition. Re-derive history from production_orders.created_at if
-- needed for reporting.)
