-- 0153_worker_salary_history.sql
-- Effective-dated salary history for workers, mirroring product_prices (0066):
-- a worker's salary on any date = the newest row whose effective_from <= that
-- date; future-dated rows are allowed and stay inactive until their date passes
-- (so a raise can be scheduled in advance). workers.basic_salary_sen stays as
-- the CURRENT snapshot (= the latest effective row) and as the fallback when a
-- worker somehow has no history row yet.
--
-- Payroll prorates a mid-month raise BY DAY: the period is split at each
-- effective_from inside the month and each segment is costed at its own salary,
-- then summed (see payslips.ts + labor-engine.ts). Months with no change are
-- one segment = unchanged behaviour.
--
--   worker_id        -- FK to workers; cascade-delete with the worker.
--   basic_salary_sen -- the salary (in sen) effective from effective_from.
--   effective_from   -- YYYY-MM-DD, inclusive, the first day this salary applies.
--   note             -- optional reason ("annual raise", "promotion", ...).
--
-- One row per (worker_id, effective_from). Idempotent (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS worker_salary_history (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  basic_salary_sen INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (NOW()),
  created_by TEXT,
  UNIQUE (worker_id, effective_from),
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wsh_worker ON worker_salary_history(worker_id);
CREATE INDEX IF NOT EXISTS idx_wsh_effective ON worker_salary_history(effective_from);

-- Backfill: every existing worker gets one initial history row = their current
-- salary, effective from their join date (or a far-past date if unknown), so the
-- as-of resolver always finds a row. Skips workers that already have any history,
-- so a re-run is a no-op.
INSERT INTO worker_salary_history (id, worker_id, basic_salary_sen, effective_from, note)
SELECT
  'wsh-init-' || w.id,
  w.id,
  w.basic_salary_sen,
  COALESCE(NULLIF(w.join_date, ''), '2000-01-01'),
  'Initial — backfilled from current salary'
FROM workers w
WHERE NOT EXISTS (
  SELECT 1 FROM worker_salary_history h WHERE h.worker_id = w.id
);
