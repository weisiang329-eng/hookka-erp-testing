-- ============================================================================
-- HOOKKA ERP — Attendance records
--
-- One row per (employeeId, date). Clock-in/out are HH:MM strings; the worked
-- minutes + efficiency are computed at clock-out. `deptBreakdown` stores the
-- per-department minutes as a JSON array (serialised at write, parsed at read).
-- ============================================================================

DROP TABLE IF EXISTS attendance_records CASCADE;
DROP INDEX IF EXISTS idx_attendance_employee_id;

CREATE TABLE attendance_records (
  id                    TEXT PRIMARY KEY,
  employee_id            TEXT NOT NULL,
  employee_name          TEXT NOT NULL DEFAULT '',
  department_code        TEXT NOT NULL DEFAULT '',
  department_name        TEXT NOT NULL DEFAULT '',
  date                  TEXT NOT NULL,                     -- YYYY-MM-DD
  clock_in               TEXT,                              -- HH:MM
  clock_out              TEXT,                              -- HH:MM
  status                TEXT NOT NULL DEFAULT 'PRESENT',   -- PRESENT | ABSENT | LATE | LEAVE | HOLIDAY
  working_minutes        INTEGER NOT NULL DEFAULT 0,
  production_time_minutes INTEGER NOT NULL DEFAULT 0,
  efficiency_pct         INTEGER NOT NULL DEFAULT 0,
  overtime_minutes       INTEGER NOT NULL DEFAULT 0,
  dept_breakdown         TEXT NOT NULL DEFAULT '[]',        -- JSON
  notes                 TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at            TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  UNIQUE (employee_id, date)
);

CREATE INDEX idx_attendance_date       ON attendance_records(date);
CREATE INDEX idx_attendance_employee_id ON attendance_records(employee_id);
CREATE INDEX idx_attendance_status     ON attendance_records(status);
