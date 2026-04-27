-- ============================================================================
-- Migration 0061 — split 3PL providers into Company + Vehicles + Drivers
--
-- NAMING NOTE: the legacy 3PL company table is called `drivers` (a
-- misnomer from migration 0014 — see that file's comment). It holds
-- COMPANIES (Express Logistics, FastTrack, etc.), not individuals. The
-- new tables introduced here add real per-vehicle and per-person rows.
-- We keep the legacy `drivers` table name for now (renaming it cascades
-- through every read-path in the codebase + RBAC seed); a follow-up can
-- rename to `three_pl_providers` once the dust settles.
--
-- Before: each row in `drivers` held ONE company + ONE vehicle + one
-- contact, which forced operators to create duplicate company rows
-- whenever a real provider ran multiple lorries (and rates could only
-- sit at the company level even though a 3-ton truck and a 5-ton truck
-- quote different prices).
--
-- After:
--   drivers              = company only (name, contact, phone, status)
--                          [vehicle/rate columns deprecated, kept for
--                          backwards compat — read-paths now go through
--                          the new tables]
--   three_pl_vehicles    = many lorries per provider (plate + type + cap +
--                          rates per vehicle — pricing follows the truck)
--   three_pl_drivers     = many drivers per provider (independent of
--                          vehicles; DO picks driver and vehicle separately)
--
-- delivery_orders gains vehicleId, vehicleType, driverPhone columns to
-- denormalize the picked vehicle + driver. Existing driverContactPerson
-- column stays as-is — it now holds the PROVIDER's contact (Mr Lee from
-- the dispatcher), distinct from the actual driver's name/phone which
-- lands in driverName + driverPhone.
--
-- Backfill: every existing provider with a non-empty vehicleNo gets one
-- vehicles row carrying the same plate/type/capacity/rates so historical
-- rates and assignments survive.
-- ============================================================================

CREATE TABLE three_pl_vehicles (
  id TEXT PRIMARY KEY,
  providerId TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  plateNo TEXT NOT NULL,
  vehicleType TEXT,
  capacityM3 REAL NOT NULL DEFAULT 0,
  ratePerTripSen INTEGER NOT NULL DEFAULT 0,
  ratePerExtraDropSen INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('ACTIVE','INACTIVE')) NOT NULL DEFAULT 'ACTIVE',
  remarks TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX idx_three_pl_vehicles_provider ON three_pl_vehicles(providerId);

CREATE TABLE three_pl_drivers (
  id TEXT PRIMARY KEY,
  providerId TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  status TEXT CHECK (status IN ('ACTIVE','INACTIVE')) NOT NULL DEFAULT 'ACTIVE',
  remarks TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX idx_three_pl_drivers_provider ON three_pl_drivers(providerId);

-- Backfill: one vehicle row per existing provider (drivers row) that
-- has a plate. Rate / capacity / type carry across so historical pricing
-- is intact. id uses a deterministic prefix so re-running this script
-- (idempotent NOT EXISTS check below) doesn't create dupes.
INSERT INTO three_pl_vehicles
  (id, providerId, plateNo, vehicleType, capacityM3, ratePerTripSen, ratePerExtraDropSen, status, created_at, updated_at)
SELECT
  'tpv-bf-' || id,
  id,
  vehicleNo,
  vehicleType,
  capacityM3,
  ratePerTripSen,
  ratePerExtraDropSen,
  'ACTIVE',
  COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM drivers
WHERE vehicleNo IS NOT NULL
  AND vehicleNo != ''
  AND NOT EXISTS (SELECT 1 FROM three_pl_vehicles WHERE id = 'tpv-bf-' || drivers.id);

-- delivery_orders: add vehicle + driver-person fields. Defaults are
-- empty strings so existing rows read cleanly; new DOs populate via the
-- POST/PUT handler's lookup chain.
ALTER TABLE delivery_orders ADD COLUMN vehicleId TEXT NOT NULL DEFAULT '';
ALTER TABLE delivery_orders ADD COLUMN vehicleType TEXT NOT NULL DEFAULT '';
ALTER TABLE delivery_orders ADD COLUMN driverPhone TEXT NOT NULL DEFAULT '';
