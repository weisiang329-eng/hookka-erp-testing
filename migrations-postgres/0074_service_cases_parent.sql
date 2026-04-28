-- ============================================================================
-- Migration 0074 — Service Cases as parent of Service Orders
--
-- Per design 2026-04-28 (operator restructure): a Service Case is the
-- top-level customer-facing service log entry — every customer issue,
-- complaint, or service interaction starts here. A Service Case can
-- spawn ZERO OR MORE Service Orders, each representing a specific
-- resolution action (REPRODUCE / STOCK_SWAP / REPAIR).
--
--   Service Case (parent — all customer service interactions, big and small)
--     ├─ Service Order #1 (e.g. REPRODUCE — first attempt)
--     ├─ Service Order #2 (e.g. REPAIR — follow-up after the first didn't fix it)
--     └─ … or zero orders for record-only cases (missing parts shipout, etc.)
--
-- WHY this is parent-child instead of the previous sibling-table design
-- (kind='RECORD' vs kind='RESOLUTION' on a single table):
--   • Same case may need multiple service orders over its lifetime
--     (first replacement also defective → second rework; or repair fails
--     → swap from stock).
--   • Case-level metadata (issue description, photos, root cause,
--     prevention) belongs to the case, not duplicated on each order.
--   • Reports want to count "cases opened" vs "cases that needed an
--     order" — easier with the relational structure.
--
-- DESTRUCTIVE OPERATIONS in this migration (safe because service_orders
-- is empty as of 2026-04-28; verified before running):
--   • DROP COLUMN service_orders.kind  (RECORD-kind moved to case-only)
--   • DROP COLUMN service_orders.issue_description / issue_photos
--   • DROP COLUMN service_orders.root_cause_* / prevention_*
--   These now live on service_cases. Service Order is purely the
--   resolution action's row going forward.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. service_cases — parent table
-- ----------------------------------------------------------------------------
CREATE TABLE service_cases (
  id TEXT PRIMARY KEY,
  -- CASE-YYMM-NNN. Same monthly-segment scheme as service_order_no so the
  -- two grow in lockstep visually.
  case_no TEXT NOT NULL,
  -- Source order (or EXTERNAL for old/paper orders not in the ERP)
  source_type TEXT NOT NULL CHECK (source_type IN ('SO','CO','EXTERNAL')),
  source_id TEXT,                     -- nullable for EXTERNAL
  source_no TEXT,
  -- Customer (denormalised for EXTERNAL where the operator types it)
  customer_id TEXT,
  customer_name TEXT NOT NULL,
  customer_state TEXT,
  -- Issue + photos (moved off service_orders)
  issue_description TEXT,
  issue_photos TEXT,                  -- JSON array of base64 data URIs
  -- Root cause + prevention loop (moved off service_orders)
  root_cause_category TEXT CHECK (root_cause_category IN (
    'PRODUCTION','DESIGN','MATERIAL','PROCESS','CUSTOMER','TRANSPORT','OTHER'
  )),
  root_cause_notes TEXT,
  prevention_action TEXT,
  prevention_status TEXT
    CHECK (prevention_status IN ('PENDING','IN_PROGRESS','DONE','NOT_NEEDED'))
    DEFAULT 'PENDING',
  prevention_owner TEXT,
  -- Lifecycle: simpler than the order's (no production/reservation states).
  --   OPEN         — case logged, may or may not have orders attached
  --   IN_PROGRESS  — at least one attached service order is in resolution
  --   CLOSED       — done (operator marks closed manually, even if orders are
  --                  still open; cases and orders close on independent timelines)
  --   CANCELLED    — logged in error / customer withdrew
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','CLOSED','CANCELLED')),
  external_ref TEXT,                  -- free text — paper SO #, etc., for EXTERNAL
  created_by TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  notes TEXT
);
CREATE INDEX idx_service_cases_status ON service_cases(status);
CREATE INDEX idx_service_cases_customer ON service_cases(customer_id);
CREATE INDEX idx_service_cases_created_at ON service_cases(created_at);

-- ----------------------------------------------------------------------------
-- 2. service_orders.case_id — FK back up to the parent case
-- ----------------------------------------------------------------------------
ALTER TABLE service_orders ADD COLUMN case_id TEXT;
CREATE INDEX idx_service_orders_case_id ON service_orders(case_id);

-- ----------------------------------------------------------------------------
-- 3. Backfill — for each existing service_orders row, create a parent case
--                and link them. RECORD-kind rows become case-only (no
--                service_orders row remains).
--
-- Verified 2026-04-28 that service_orders is empty in prod, so this loop
-- is a no-op there. Kept for local / dev databases that may have test data.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  new_case_id TEXT;
  case_seq INT := 0;
  yy_mm TEXT := to_char(NOW(), 'YYMM');
BEGIN
  FOR r IN SELECT * FROM service_orders ORDER BY created_at LOOP
    case_seq := case_seq + 1;
    new_case_id := 'svccase-' || substr(md5(random()::text), 1, 8);

    INSERT INTO service_cases (
      id, case_no, source_type, source_id, source_no,
      customer_id, customer_name, customer_state,
      issue_description, issue_photos,
      root_cause_category, root_cause_notes,
      prevention_action, prevention_status, prevention_owner,
      status, created_by, created_by_name, created_at, closed_at, notes
    ) VALUES (
      new_case_id,
      'CASE-' || yy_mm || '-' || lpad(case_seq::text, 3, '0'),
      r.source_type, r.source_id, r.source_no,
      r.customer_id, r.customer_name, NULL,
      r.issue_description, r.issue_photos,
      r.root_cause_category, r.root_cause_notes,
      r.prevention_action, COALESCE(r.prevention_status, 'PENDING'), r.prevention_owner,
      CASE
        WHEN r.status IN ('CLOSED','CANCELLED') THEN r.status
        WHEN r.status IN ('IN_PRODUCTION','RESERVED','IN_REPAIR','READY_TO_SHIP','DELIVERED') THEN 'IN_PROGRESS'
        ELSE 'OPEN'
      END,
      r.created_by, r.created_by_name, r.created_at, r.closed_at, r.notes
    );

    IF r.kind = 'RECORD' THEN
      -- RECORD-kind rows become case-only. Cascade delete the order +
      -- its lines / returns (kept simple — these were log-only anyway).
      DELETE FROM service_order_lines WHERE service_order_id = r.id;
      DELETE FROM service_order_returns WHERE service_order_id = r.id;
      DELETE FROM service_orders WHERE id = r.id;
    ELSE
      UPDATE service_orders SET case_id = new_case_id WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 4. case_id is required from now on. FK constraint with cascade.
-- ----------------------------------------------------------------------------
ALTER TABLE service_orders ALTER COLUMN case_id SET NOT NULL;
ALTER TABLE service_orders
  ADD CONSTRAINT service_orders_case_id_fkey
  FOREIGN KEY (case_id) REFERENCES service_cases(id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- 5. DROP COLUMN — these are now case-level fields, single source of truth.
-- ----------------------------------------------------------------------------
ALTER TABLE service_orders DROP COLUMN IF EXISTS kind;
ALTER TABLE service_orders DROP COLUMN IF EXISTS issue_description;
ALTER TABLE service_orders DROP COLUMN IF EXISTS issue_photos;
ALTER TABLE service_orders DROP COLUMN IF EXISTS root_cause_category;
ALTER TABLE service_orders DROP COLUMN IF EXISTS root_cause_notes;
ALTER TABLE service_orders DROP COLUMN IF EXISTS prevention_action;
ALTER TABLE service_orders DROP COLUMN IF EXISTS prevention_status;
ALTER TABLE service_orders DROP COLUMN IF EXISTS prevention_owner;

-- ----------------------------------------------------------------------------
-- 6. Indexes referencing the dropped columns — drop their entries too if any.
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_service_orders_root_cause;
DROP INDEX IF EXISTS idx_service_orders_prevention_status;
