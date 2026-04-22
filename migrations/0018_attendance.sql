-- ============================================================================
-- HOOKKA ERP — Attendance records
--
-- One row per (employeeId, date). Clock-in/out are HH:MM strings; the worked
-- minutes + efficiency are computed at clock-out. `deptBreakdown` stores the
-- per-department minutes as a JSON array (serialised at write, parsed at read).
-- ============================================================================

DROP TABLE IF EXISTS attendance_records;
DROP INDEX IF EXISTS idx_attendance_employeeId;

CREATE TABLE attendance_records (
  id                    TEXT PRIMARY KEY,
  employeeId            TEXT NOT NULL,
  employeeName          TEXT NOT NULL DEFAULT '',
  departmentCode        TEXT NOT NULL DEFAULT '',
  departmentName        TEXT NOT NULL DEFAULT '',
  date                  TEXT NOT NULL,                     -- YYYY-MM-DD
  clockIn               TEXT,                              -- HH:MM
  clockOut              TEXT,                              -- HH:MM
  status                TEXT NOT NULL DEFAULT 'PRESENT',   -- PRESENT | ABSENT | LATE | LEAVE | HOLIDAY
  workingMinutes        INTEGER NOT NULL DEFAULT 0,
  productionTimeMinutes INTEGER NOT NULL DEFAULT 0,
  efficiencyPct         INTEGER NOT NULL DEFAULT 0,
  overtimeMinutes       INTEGER NOT NULL DEFAULT 0,
  deptBreakdown         TEXT NOT NULL DEFAULT '[]',        -- JSON
  notes                 TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (employeeId, date)
);

CREATE INDEX idx_attendance_date       ON attendance_records(date);
CREATE INDEX idx_attendance_employeeId ON attendance_records(employeeId);
CREATE INDEX idx_attendance_status     ON attendance_records(status);
