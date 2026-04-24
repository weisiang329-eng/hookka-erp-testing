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
  last_maintenance_date  TEXT NOT NULL DEFAULT '',
  next_maintenance_date  TEXT NOT NULL DEFAULT '',
  maintenance_cycle_days INTEGER NOT NULL DEFAULT 30,
  purchase_date         TEXT NOT NULL DEFAULT '',
  notes                TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at           TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX IF NOT EXISTS idx_equipment_status     ON equipment(status);
CREATE INDEX IF NOT EXISTS idx_equipment_department ON equipment(department);
CREATE INDEX IF NOT EXISTS idx_equipment_next_maint  ON equipment(next_maintenance_date);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id             TEXT PRIMARY KEY,
  equipment_id    TEXT NOT NULL,
  equipment_name  TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'PREVENTIVE',   -- PREVENTIVE | CORRECTIVE | EMERGENCY
  description    TEXT NOT NULL DEFAULT '',
  performed_by    TEXT NOT NULL DEFAULT '',
  date           TEXT NOT NULL,                        -- YYYY-MM-DD
  cost_sen        INTEGER NOT NULL DEFAULT 0,
  downtime_hours  DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX IF NOT EXISTS idx_maint_equipment_id ON maintenance_logs(equipment_id);
CREATE INDEX IF NOT EXISTS idx_maint_date        ON maintenance_logs(date);
