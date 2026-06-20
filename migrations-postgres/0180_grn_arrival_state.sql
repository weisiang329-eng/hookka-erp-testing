-- ---------------------------------------------------------------------------
-- 0180 — GRN arrival pipeline columns
-- Adds an independent arrival_state track alongside the existing grn.status
-- (DRAFT/CONFIRMED/POSTED — untouched). Also adds shipment metadata and
-- landed-cost fields.
--
-- NOTE: This file is for the record / manual migration only.
-- Production schema is applied at runtime via ensureGrnMigrations() in
-- src/api/routes/grn.ts (ADD COLUMN IF NOT EXISTS — idempotent).
-- ---------------------------------------------------------------------------

ALTER TABLE grns ADD COLUMN IF NOT EXISTS arrival_state TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS shipping_method TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS carrier_name TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS container_number TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS expected_arrival TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS shipped_date TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS actual_arrival TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS customs_status TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS customs_clearance_date TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS shipping_cost_sen INTEGER DEFAULT 0;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS customs_duty_sen INTEGER DEFAULT 0;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS exchange_rate REAL;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS landed_cost_sen INTEGER DEFAULT 0;
