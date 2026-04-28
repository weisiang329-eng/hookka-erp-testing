-- ============================================================================
-- Migration 0073 — Service Orders: external source + root-cause + photos
--
-- Three operator-driven additions per design 2026-04-28:
--
-- 1) EXTERNAL source — old / paper orders that pre-date the ERP can now have
--    a Service Order opened against them. source_id is dropped to nullable
--    and source_type CHECK is extended to allow 'EXTERNAL'. When sourceType
--    is EXTERNAL the operator types a customer name + product description by
--    hand instead of picking from existing SO/CO data.
--
-- 2) Root-cause + prevention loop — the operator categorises WHERE the
--    defect originated (Production / Design / Material / Process / Customer
--    / Transport / Other) and writes a prevention action with an owner +
--    status, so we close the loop before the next batch goes out.
--
-- 3) Photos: the existing issue_photos TEXT (JSON array) field already
--    handles photo URLs. Frontend now resizes + stores as base64 data URIs
--    (small-shop-friendly, no R2 setup needed). No schema change needed for
--    this; mentioned here for the migration's narrative.
-- ============================================================================

-- 1. Source flexibility -------------------------------------------------------
ALTER TABLE service_orders ALTER COLUMN source_id DROP NOT NULL;

-- Drop the existing CHECK on source_type (Postgres auto-named it; find by
-- column reference and drop, then re-add with EXTERNAL allowed).
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT con.conname
    INTO c_name
    FROM pg_constraint con
    JOIN pg_attribute   att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
   WHERE con.conrelid = 'service_orders'::regclass
     AND con.contype = 'c'
     AND att.attname = 'source_type'
   LIMIT 1;
  IF c_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE service_orders DROP CONSTRAINT ' || quote_ident(c_name);
  END IF;
END $$;

ALTER TABLE service_orders
  ADD CONSTRAINT service_orders_source_type_check
  CHECK (source_type IN ('SO','CO','EXTERNAL'));

-- 2. kind: RECORD vs RESOLUTION ----------------------------------------------
-- Per design 2026-04-28: not every customer-facing service issue needs a
-- rework / swap / repair flow. "Sent the customer one fewer leg, mailed it
-- separately" is a record-only service. "Defective sofa, need to remake"
-- is a resolution.
--
--   'RESOLUTION' — current Service Order behaviour (mode = REPRODUCE /
--                  STOCK_SWAP / REPAIR drives side effects).
--   'RECORD'     — log-only. mode is enforced to NULL; status flows
--                  OPEN → CLOSED (no IN_PRODUCTION / RESERVED / etc.).
--                  Used for missing-accessories shipouts, complaint logs,
--                  refund records, anything that's "做个记录而已".
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'RESOLUTION'
  CHECK (kind IN ('RESOLUTION','RECORD'));

-- 3. Root-cause + prevention loop --------------------------------------------
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS root_cause_category TEXT
  CHECK (root_cause_category IN (
    'PRODUCTION',  -- workmanship / line error
    'DESIGN',      -- design / R&D needs to fix the spec
    'MATERIAL',    -- supplier / raw material defect
    'PROCESS',     -- SOP gap / missing step
    'CUSTOMER',    -- customer misuse, not our fault
    'TRANSPORT',   -- damaged in transit (3PL issue)
    'OTHER'
  ));
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS root_cause_notes      TEXT;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS prevention_action     TEXT;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS prevention_status     TEXT
  CHECK (prevention_status IN ('PENDING','IN_PROGRESS','DONE','NOT_NEEDED'))
  DEFAULT 'PENDING';
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS prevention_owner      TEXT;

CREATE INDEX IF NOT EXISTS idx_service_orders_root_cause
  ON service_orders(root_cause_category)
  WHERE root_cause_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_orders_prevention_status
  ON service_orders(prevention_status)
  WHERE prevention_status IN ('PENDING','IN_PROGRESS');
