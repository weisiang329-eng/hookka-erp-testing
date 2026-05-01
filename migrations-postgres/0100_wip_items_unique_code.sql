-- ============================================================================
-- Migration 0100 — Eliminate wip_items dupe-code race at the DB level.
--
-- Background
-- ----------
-- `applyWipInventoryChange` in src/api/routes/production-orders.ts performs
-- four SELECT-then-INSERT upserts on wip_items, keyed by `code`. Under
-- concurrent PATCH /api/production-orders/:id/job-cards/:jcId requests for
-- the same wipKey (e.g. duplicate form submits, two operators racing the same
-- JC, queue-driven re-applications) the SELECT can return "no row" on both
-- sides simultaneously, and both INSERTs succeed — producing two rows with
-- identical `code`. By 2026-04-30 the live DB had accumulated 329 dup-code
-- groups. They were merged via /api/import/dedupe-wip-items (838 rows /
-- 838 distinct codes after).
--
-- Permanent fix has two parts:
--   1. THIS MIGRATION — UNIQUE(org_id, code). Race INSERTs are physically
--      rejected by Postgres so a dupe can no longer land.
--   2. Code change — the four SELECT-then-INSERT sites are rewritten to
--      `INSERT … ON CONFLICT (org_id, code) DO UPDATE SET …` so the upsert
--      is atomic. With the UNIQUE constraint in place, ON CONFLICT has a
--      definite arbiter to fire on.
--
-- Scope
-- -----
-- `wip_items.org_id` was added in 0087 with NOT NULL DEFAULT 'hookka'. Today
-- we are single-tenant in practice, but using the composite (org_id, code)
-- keeps the constraint forward-compatible — same code can recur across
-- tenants without colliding.
--
-- Pre-flight
-- ----------
-- The dedupe endpoint (/api/import/dedupe-wip-items) was run live on
-- 2026-04-30 and reported 0 dup-groups remaining. The CREATE UNIQUE INDEX
-- below will fail loudly if any dupes are still present — that is the
-- desired behaviour (don't silently accept a corrupt state).
--
-- Indexes touched
--   * DROP idx_wip_items_code (non-unique, from 0037) — superseded by the
--     new UNIQUE composite, which Postgres can also use for `WHERE code = ?`
--     lookups (org_id has a default in every query plan we issue today).
--   * CREATE UNIQUE INDEX ux_wip_items_org_code ON wip_items (org_id, code).
-- ============================================================================

DROP INDEX IF EXISTS idx_wip_items_code;

CREATE UNIQUE INDEX IF NOT EXISTS ux_wip_items_org_code
  ON wip_items (org_id, code);
