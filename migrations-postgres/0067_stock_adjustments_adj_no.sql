-- ============================================================================
-- Migration 0067 — stock_adjustments.adj_no
--
-- Adds a human-readable ADJ-YYMM-NNN number to stock_adjustments. Previously
-- only the opaque internal id (`adj-<8hex>`) existed. Brings the table in
-- line with every other doc-style entity in the system (CO, CN, DN, INV,
-- REC, etc.) which all carry a XX-YYMM-NNN sequential identifier.
--
-- Existing rows keep adj_no NULL — they predate this column. The API
-- generator (nextAdjNo in src/api/routes/stock-adjustments.ts) starts at
-- 001 inside the (year, month) bucket and pulls max-existing-suffix+1
-- to stay monotonic.
--
-- Apply manually via Supabase SQL Editor — schema migrations are NOT
-- auto-applied per project memory (D1 retired 2026-04-27).
-- ============================================================================

ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS adj_no TEXT;
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_adj_no ON stock_adjustments(adj_no);
