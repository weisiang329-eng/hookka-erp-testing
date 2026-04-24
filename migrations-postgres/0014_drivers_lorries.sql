-- ============================================================================
-- HOOKKA ERP — Drivers (3PL providers) and Lorries
--
-- drivers/threePLProviders: external third-party logistics companies the
--   dispatch module assigns deliveries to. Rates stored in sen.
-- lorries: internal fleet vehicles. driverName / driverContact are currently
--   plain strings (no FK) because the app treats lorries as assignable slots
--   that can name any driver (not restricted to the 3PL providers table).
-- ============================================================================

CREATE TABLE IF NOT EXISTS drivers (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  phone                TEXT NOT NULL DEFAULT '',
  contact_person        TEXT NOT NULL DEFAULT '',
  vehicle_no            TEXT NOT NULL DEFAULT '',
  vehicle_type          TEXT NOT NULL DEFAULT '',
  capacity_m3           DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate_per_trip_sen       INTEGER NOT NULL DEFAULT 30000,
  rate_per_extra_drop_sen  INTEGER NOT NULL DEFAULT 5000,
  status               TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | INACTIVE | ON_LEAVE
  remarks              TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at           TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_name   ON drivers(name);

CREATE TABLE IF NOT EXISTS lorries (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,                       -- "Lorry 1", etc.
  plate_number   TEXT NOT NULL DEFAULT '',
  capacity      DOUBLE PRECISION NOT NULL DEFAULT 0,             -- M3
  driver_name    TEXT NOT NULL DEFAULT '',
  driver_contact TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'AVAILABLE',    -- AVAILABLE | IN_USE | MAINTENANCE
  created_at    TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at    TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX IF NOT EXISTS idx_lorries_status ON lorries(status);

-- Seed the three 3PL providers that the mock-data exposed so existing SPA
-- pages don't render an empty dropdown on first load. Using INSERT OR IGNORE
-- so re-running the migration is a no-op.
INSERT INTO drivers (id, name, phone, contact_person, vehicle_no, vehicle_type, capacity_m3, rate_per_trip_sen, rate_per_extra_drop_sen, status, remarks, created_at, updated_at)
VALUES
  ('3pl-1', 'Express Logistics Sdn Bhd', '03-12345678', 'Mr Lee',   'BDR 1234', '3-ton', 18, 30000, 5000, 'ACTIVE', '', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
  ('3pl-2', 'FastTrack Delivery',        '03-87654321', 'Mr Tan',   'JHR 5678', '5-ton', 30, 45000, 8000, 'ACTIVE', '', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
  ('3pl-3', 'KL Transport Services',     '03-55556666', 'Mr Ahmad', 'WKL 9012', '1-ton',  8, 15000, 3000, 'ACTIVE', '', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z') ON CONFLICT DO NOTHING;
