-- ============================================================================
-- Migration 0066 - Consignment Notes dispatch + linkage columns
--
-- BACKGROUND:
--   The Consignment Note table (migration 0001 line 1320) was originally
--   designed as a simple "items sent to a branch" record with no transport
--   metadata. The CN page redesign 2026-04-28 (commit 4c7866e) brought it
--   to parity with the Delivery Order page UI - which surfaces:
--     - Dispatch Date / Delivery Date (timestamps the note moves through
--       the lifecycle states ACTIVE -> PARTIALLY_SOLD -> ...)
--     - 3PL Provider / Driver / Vehicle (carrier metadata)
--     - PO -> CN linkage (so "Production Complete - Ready for CN" can dedup
--       per-PO instead of per-customer)
--   The UI fields rendered "-" because the columns didn't exist. This
--   migration adds them.
--
-- WHY ADD INSTEAD OF ALTER:
--   Every legacy CN keeps working - new columns are nullable. Existing
--   reads / writes that ignore these columns are unaffected.
--
-- LINKED CHANGES:
--   Frontend src/pages/consignment/note.tsx already references these
--   fields (typed via the API response shape). The route file
--   src/api/routes/consignment-notes.ts will be patched in a follow-up
--   to read/write them.
-- ============================================================================

-- Carrier metadata. Mirrors delivery_orders columns of the same name
-- (driver_id stores PROVIDER company id per the legacy convention; the
-- driver PERSON's name + phone get denormalized into driver_name +
-- driver_phone exactly like DO does).
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS driver_id TEXT;
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS driver_name TEXT;
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS driver_contact_person TEXT;
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS driver_phone TEXT;
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS vehicle_id TEXT;
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS vehicle_no TEXT;
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS vehicle_type TEXT;

-- Lifecycle timestamps. Mirrors delivery_orders.dispatched_at /
-- delivered_at - written when the supervisor flips the CN to the
-- corresponding status.
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS dispatched_at TEXT;
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS delivered_at TEXT;
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS acknowledged_at TEXT;

-- CO + PO linkage. consignment_order_id ties the CN back to the source
-- CO (1 CN can ship multiple line-items from 1 CO). hub_id pinpoints
-- WHICH branch of the customer the goods went to (a single customer
-- often has multiple delivery hubs in different states).
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS consignment_order_id TEXT
  REFERENCES consignment_orders(id) ON DELETE SET NULL;
ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS hub_id TEXT
  REFERENCES delivery_hubs(id) ON DELETE SET NULL;

-- Per-line PO link. consignment_items already exists (migration 0001
-- line 1334). The Production-Complete-Ready-for-CN dedup needs to know
-- which production_orders are already on a CN; that read is the same
-- shape as DO uses (delivery_order_items.production_order_id).
ALTER TABLE consignment_items ADD COLUMN IF NOT EXISTS production_order_id TEXT
  REFERENCES production_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_consignment_notes_co_id ON consignment_notes(consignment_order_id);
CREATE INDEX IF NOT EXISTS idx_consignment_notes_hub_id ON consignment_notes(hub_id);
CREATE INDEX IF NOT EXISTS idx_consignment_notes_status ON consignment_notes(status);
CREATE INDEX IF NOT EXISTS idx_consignment_items_po_id ON consignment_items(production_order_id);
