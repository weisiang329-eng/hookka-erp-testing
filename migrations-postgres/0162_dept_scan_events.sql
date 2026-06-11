-- Department QR scan events (owner 2026-06-11): a worker scans a department's
-- QR when they START working there; punch-out closes the day and the punch
-- auto-fill splits the day's Working Hours across the scanned departments
-- (no scans = the worker's home department).
--
-- Column names are deliberately ALL-LOWERCASE: the d1-compat adapter passes
-- unknown camelCase identifiers through unquoted and Postgres folds them to
-- lowercase — lowercase-from-day-one means reads and writes can never
-- disagree. Also self-applied at runtime (ensureDeptScanEvents in
-- src/api/lib/punch-autofill.ts); this file keeps fresh databases complete.

CREATE TABLE IF NOT EXISTS dept_scan_events (
  id TEXT PRIMARY KEY,
  workerid TEXT NOT NULL,
  date TEXT NOT NULL,
  departmentcode TEXT NOT NULL,
  atmin INTEGER NOT NULL,
  createdat TEXT
);

CREATE INDEX IF NOT EXISTS idx_dept_scan_events_worker_date
  ON dept_scan_events (workerid, date);
