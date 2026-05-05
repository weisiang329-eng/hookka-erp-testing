-- ---------------------------------------------------------------------------
-- 0105_lead_times_history.sql
--
-- Append-only history tables for production_lead_times and hookka_dd_buffer.
-- Mirrors the shape of product_prices (migration 0066) and customer_product_prices
-- (0036): each row is a dated snapshot keyed to (category[, dept_code]).
-- The "current effective" value for any (cat, dept) is the newest history
-- row where effective_from <= today; falling back to the legacy baseline
-- table (production_lead_times / hookka_dd_buffer) when no history row
-- has been written yet for that (cat, dept).
--
-- Future-dated rows stay dormant until their effective_from passes — this
-- is what lets the user schedule a "FAB_SEW = 7 days from 2026-06-01" in
-- advance via /planning's history dialog.
--
-- Both tables follow the products price-history conventions exactly:
--   * `id TEXT PRIMARY KEY` (lt-XXXXXXXX / hd-XXXXXXXX UUID prefix)
--   * `effective_from TEXT` ISO date — past dates allowed for backfill
--   * `notes TEXT NULL` for free-form context (e.g. "Q3 staffing change")
--   * `created_at TEXT NOT NULL DEFAULT` UTC ISO
--   * `created_by TEXT NULL` for the actor (filled by the route layer)
--   * No uniqueness on (category, dept_code, effective_from) — same-day
--     re-saves append a fresh row, latest-by-created_at wins.
--
-- The legacy `production_lead_times` and `hookka_dd_buffer` tables are
-- intentionally untouched; they continue to act as the seeded baseline
-- and the /planning inline "Save Lead Times" button still writes there.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS production_lead_times_history (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL CHECK (category IN ('BEDFRAME','SOFA')),
  dept_code   TEXT NOT NULL,
  days        INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_plth_cat_dept ON production_lead_times_history(category, dept_code);
CREATE INDEX IF NOT EXISTS idx_plth_effective ON production_lead_times_history(effective_from);

CREATE TABLE IF NOT EXISTS hookka_dd_buffer_history (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL CHECK (category IN ('BEDFRAME','SOFA')),
  days        INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_hdbh_cat ON hookka_dd_buffer_history(category);
CREATE INDEX IF NOT EXISTS idx_hdbh_effective ON hookka_dd_buffer_history(effective_from);
