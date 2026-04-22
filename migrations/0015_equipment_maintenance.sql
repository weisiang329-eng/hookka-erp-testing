-- ============================================================================
-- HOOKKA ERP — Equipment & Maintenance Logs
--
-- Tracks factory equipment (sewing machines, cutting tables, compressors, etc)
-- plus a time-series of maintenance events per asset. Money stored in sen.
-- maintenance_logs.equipmentId is a soft FK; we intentionally avoid ON DELETE
-- CASCADE so deleting an equipment row doesn't wipe historical maintenance
-- cost ledger rows — those must be archived by the app layer before delete.
-- ============================================================================

CREATE TABLE IF NOT EXISTS equipment (
  id                   TEXT PRIMARY KEY,
  code                 TEXT NOT NULL DEFAULT '',
  name                 TEXT NOT NULL,
  department           TEXT NOT NULL DEFAULT '',
  type                 TEXT NOT NULL DEFAULT 'OTHER',      -- SEWING_MACHINE | CUTTING_TABLE | STAPLE_GUN | COMPRESSOR | SAW | DRILL | OTHER
  status               TEXT NOT NULL DEFAULT 'OPERATIONAL', -- OPERATIONAL | MAINTENANCE | REPAIR | DECOMMISSIONED
  lastMaintenanceDate  TEXT NOT NULL DEFAULT '',
  nextMaintenanceDate  TEXT NOT NULL DEFAULT '',
  maintenanceCycleDays INTEGER NOT NULL DEFAULT 30,
  purchaseDate         TEXT NOT NULL DEFAULT '',
  notes                TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_equipment_status     ON equipment(status);
CREATE INDEX IF NOT EXISTS idx_equipment_department ON equipment(department);
CREATE INDEX IF NOT EXISTS idx_equipment_nextMaint  ON equipment(nextMaintenanceDate);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id             TEXT PRIMARY KEY,
  equipmentId    TEXT NOT NULL,
  equipmentName  TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'PREVENTIVE',   -- PREVENTIVE | CORRECTIVE | EMERGENCY
  description    TEXT NOT NULL DEFAULT '',
  performedBy    TEXT NOT NULL DEFAULT '',
  date           TEXT NOT NULL,                        -- YYYY-MM-DD
  costSen        INTEGER NOT NULL DEFAULT 0,
  downtimeHours  REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_maint_equipmentId ON maintenance_logs(equipmentId);
CREATE INDEX IF NOT EXISTS idx_maint_date        ON maintenance_logs(date);
