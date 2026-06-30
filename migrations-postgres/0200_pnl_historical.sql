-- ============================================================================
-- HOOKKA ERP — pnl_historical (Task 3.1: historical P&L injection).
-- Stores owner-provided P&L window JSON for months before the accounting
-- opening date (currently 2026-05-22). The system has no transactions before
-- then, so those months would otherwise render all-zero.
--
-- line ∈ {'all','sofa','bedframe'} — one row per org_id × ym × line.
-- window_json holds the full PnlWindow object (JSON).
--
-- NOTE: This table is runtime-self-applied by ensurePnlHistorical in
-- src/api/routes/accounting.ts (CREATE TABLE IF NOT EXISTS awaited at the
-- top of every handler that reads it). This migration file is an inert
-- double-track record for audit / CI. Runtime does NOT run it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pnl_historical (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL DEFAULT 'hookka',
  ym          TEXT NOT NULL,
  line        TEXT NOT NULL,
  window_json TEXT NOT NULL,
  updated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pnl_hist_key ON pnl_historical (org_id, ym, line);
