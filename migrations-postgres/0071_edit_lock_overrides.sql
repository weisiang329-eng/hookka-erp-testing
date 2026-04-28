-- ============================================================================
-- Migration 0071 - Admin override audit + token store for the Rule-3
-- production_window edit lock on Sales Orders + Consignment Orders.
--
-- BACKGROUND:
--   /api/sales-orders/:id/edit-eligibility (and the parallel CO endpoint)
--   enforces three rules to lock editing once a SO/CO has crossed into
--   active production:
--     Rule 1: status NOT IN (DRAFT, CONFIRMED, IN_PRODUCTION) → hard lock.
--     Rule 2: any job_card under the order's POs has a completedDate
--             stamped → hard lock (real production output is committed,
--             editing items would orphan finished WIP).
--     Rule 3: MIN(job_cards.dueDate) <= today + 2 days → "production_window"
--             lock — the first scheduled production step is within 2 days,
--             so editing now risks material orders / cutting plans drifting
--             out of sync with the live job cards.
--
--   Per user 2026-04-28: SUPER_ADMIN / ADMIN should be able to OVERRIDE
--   Rule 3 with a written reason. Rule 1 + Rule 2 stay hard locks because
--   they protect against committed production output that already exists,
--   whereas Rule 3 is a *soft* schedule-drift guard (no output yet) and the
--   admin is accepting the schedule risk by overriding.
--
-- WHY A SEPARATE TABLE (not an `OVERRIDE:<uuid>` notes prefix in
-- so_status_changes):
--   1. CO has no status_changes table yet (see TODO at
--      src/api/routes/consignment-orders.ts:411). A new table cleanly
--      handles both SO and CO via the `order_type` discriminator.
--   2. Token lookup on PUT must be O(1) by primary key. Scanning notes
--      with LIKE 'OVERRIDE:%' would be unindexed and string-fragile.
--   3. used_at + expires_at are first-class columns we want to index +
--      query on (e.g. "show me unused overrides expiring in next 5 min"
--      for ops dashboards). Burying them in a JSON-ish notes blob loses
--      that affordance.
--
-- LIFECYCLE:
--   - POST /api/{sales-orders|consignment-orders}/:id/override-edit-lock
--     INSERTs a row with `expires_at = now + 60 min`, returns the UUID.
--   - The FE forwards the UUID on the next PUT body as `overrideToken`.
--   - PUT looks up the row, verifies (order_id matches, expires_at > now,
--     used_at IS NULL), stamps used_at = now atomically, and skips the
--     production_window pre-flight check (Rule 3 only).
--   - Rule 1 + Rule 2 are STILL re-checked — the override does not waive
--     status-machine validity or the dept_completed safety guard.
--
-- IDEMPOTENCY:
--   CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS — re-running
--   the migration is a no-op.
--
-- DEPLOYMENT:
--   Apply manually via Supabase SQL Editor. The CI step that auto-applied
--   D1 migrations was retired 2026-04-27 (see MEMORY.md note about D1
--   retirement / Hyperdrive cutover).
-- ============================================================================

CREATE TABLE IF NOT EXISTS edit_lock_overrides (
  id              TEXT PRIMARY KEY,
  order_type      TEXT NOT NULL CHECK (order_type IN ('SO','CO')),
  order_id        TEXT NOT NULL,
  -- Reason text supplied by the admin. Persisted so audit queries can
  -- explain WHY the override was granted, not just that it happened.
  reason          TEXT NOT NULL,
  -- Actor snapshot — copy displayName at write time so the journal still
  -- renders if the user is later deleted (mirrors audit_events behaviour).
  actor_user_id   TEXT,
  actor_user_name TEXT,
  actor_role      TEXT,
  -- ISO 8601 UTC timestamps. created_at = INSERT time, expires_at = +60min,
  -- used_at = the PUT that consumed the token (NULL until used).
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used_at         TEXT
);

-- Lookup path: PUT handler joins on (id) — primary key already covers it.
-- This index is the audit / ops lookup: "all overrides for this order".
CREATE INDEX IF NOT EXISTS idx_edit_lock_overrides_order
  ON edit_lock_overrides(order_type, order_id);

-- Used so a future janitor cron can prune expired-and-unused tokens
-- without a full table scan.
CREATE INDEX IF NOT EXISTS idx_edit_lock_overrides_expires_at
  ON edit_lock_overrides(expires_at);
