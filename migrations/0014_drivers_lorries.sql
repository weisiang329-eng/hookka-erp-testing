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
  contactPerson        TEXT NOT NULL DEFAULT '',
  vehicleNo            TEXT NOT NULL DEFAULT '',
  vehicleType          TEXT NOT NULL DEFAULT '',
  capacityM3           REAL NOT NULL DEFAULT 0,
  ratePerTripSen       INTEGER NOT NULL DEFAULT 30000,
  ratePerExtraDropSen  INTEGER NOT NULL DEFAULT 5000,
  status               TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | INACTIVE | ON_LEAVE
  remarks              TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_name   ON drivers(name);

CREATE TABLE IF NOT EXISTS lorries (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,                       -- "Lorry 1", etc.
  plateNumber   TEXT NOT NULL DEFAULT '',
  capacity      REAL NOT NULL DEFAULT 0,             -- M3
  driverName    TEXT NOT NULL DEFAULT '',
  driverContact TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'AVAILABLE',    -- AVAILABLE | IN_USE | MAINTENANCE
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_lorries_status ON lorries(status);

-- Seed the three 3PL providers that the mock-data exposed so existing SPA
-- pages don't render an empty dropdown on first load. Using INSERT OR IGNORE
-- so re-running the migration is a no-op.
INSERT OR IGNORE INTO drivers (id, name, phone, contactPerson, vehicleNo, vehicleType, capacityM3, ratePerTripSen, ratePerExtraDropSen, status, remarks, created_at, updated_at)
VALUES
  ('3pl-1', 'Express Logistics Sdn Bhd', '03-12345678', 'Mr Lee',   'BDR 1234', '3-ton', 18, 30000, 5000, 'ACTIVE', '', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
  ('3pl-2', 'FastTrack Delivery',        '03-87654321', 'Mr Tan',   'JHR 5678', '5-ton', 30, 45000, 8000, 'ACTIVE', '', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
  ('3pl-3', 'KL Transport Services',     '03-55556666', 'Mr Ahmad', 'WKL 9012', '1-ton',  8, 15000, 3000, 'ACTIVE', '', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
