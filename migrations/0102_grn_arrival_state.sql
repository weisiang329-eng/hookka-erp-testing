-- ---------------------------------------------------------------------------
-- 0102 — GRN arrival pipeline columns (SQLite mirror)
-- Mirrors migrations-postgres/0180_grn_arrival_state.sql for local dev /
-- SQLite test environment. Runtime self-apply in grn.ts handles prod.
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
