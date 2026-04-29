-- ============================================================================
-- Migration 0092 — R&D Projects: dedicated material issuance table
--
-- Until now, every "issuance" of raw material to an R&D project was appended
-- to the rd_projects.material_issuances JSON column. That worked for the
-- single-issuance MVP but doesn't scale: a project iterating prototypes can
-- legitimately issue material 30+ times over its lifecycle, and the JSON
-- approach makes per-issuance audit (by date, by person, by material) a
-- linear scan in application code.
--
-- This migration introduces rd_material_issuances — one row per issuance —
-- with the same shape as the JSON entry plus a back-pointer to the
-- stock_movements row written by the issuance handler. Existing data in
-- rd_projects.material_issuances stays untouched; the API reads BOTH sources
-- and merges them so backward compatibility is preserved.
--
-- Field notes:
--   * qty is NUMERIC(12,4) so fractional issuances (e.g. 0.5m of fabric) round
--     correctly. CHECK (qty > 0) keeps any UI bug from writing a negative.
--   * unit_cost_sen is the WAC snapshot at issue time (resolved server-side
--     from rm_batches). Default 0 keeps the column NOT NULL while leaving
--     room for future bulk inserts that want to fill it later.
--   * issued_at is a DATE (not timestamp) so the UI's "issued on" filter
--     matches the user's mental model of issuance days.
--   * stock_movement_id pins the audit trail: deleting an issuance must
--     also reverse the linked stock_movements entry.
--   * org_id matches the multi-tenant pattern from migration 0087.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rd_material_issuances (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES rd_projects(id) ON DELETE CASCADE,
  raw_material_id    TEXT NOT NULL,
  material_code      TEXT,
  material_name      TEXT,
  qty                NUMERIC(12,4) NOT NULL CHECK (qty > 0),
  unit               TEXT NOT NULL,
  unit_cost_sen      INTEGER NOT NULL DEFAULT 0,
  total_cost_sen     INTEGER NOT NULL DEFAULT 0,
  issued_at          DATE NOT NULL,
  issued_by          TEXT,
  notes              TEXT,
  stock_movement_id  TEXT,
  org_id             TEXT NOT NULL DEFAULT 'hookka',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rd_material_issuances_project
  ON rd_material_issuances(project_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_rd_material_issuances_raw_material
  ON rd_material_issuances(raw_material_id);
CREATE INDEX IF NOT EXISTS idx_rd_material_issuances_org
  ON rd_material_issuances(org_id);
