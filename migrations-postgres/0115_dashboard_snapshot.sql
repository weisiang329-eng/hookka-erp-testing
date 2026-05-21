-- ---------------------------------------------------------------------------
-- 0115_dashboard_snapshot.sql — Application-managed dashboard snapshot.
--
-- Replaces the 9901/9902 Postgres-MV approach (cron-refreshed every 15 min
-- but consumed by zero frontends). The new model is write-through:
-- mutation routes (SO/DO/Invoice/JC/Payment create) maintain this row in
-- the same transaction as the data change, so the snapshot is always
-- as-fresh-as-the-write. Reads are O(1) — one row fetch, then JSON parse.
--
-- Three layers of drift defence (see docs/AUDIT-BACKLOG-2026-05-20.md
-- decision D2):
--   1. Write-through: the mutation that creates/updates a tracked source
--      row also updates dashboard_snapshot.data and bumps built_from. If
--      the mutation rolls back, so does the snapshot bump.
--   2. Version check on read: GET /api/dashboard/overview compares
--      built_from against MAX(updated_at) across the tracked source
--      tables. If anything is newer than built_from, the read triggers
--      an immediate rebuild before returning.
--   3. Nightly reconciliation: a scheduled job (Cloudflare GitHub
--      Actions cron at 02:00 SGT) does a full rebuild + compares the
--      old data vs the new and logs any drift for follow-up.
--
-- Columns:
--   org_id        — primary key. Multi-tenant scoping is per migration
--                   0049 — every snapshot is org-scoped.
--   data          — JSONB blob of the full dashboard payload. Schema
--                   mirrors the shape the read route currently
--                   constructs in dashboard-overview.ts.
--   built_from    — the cross-table MAX(updated_at) at build time. Layer 2
--                   compares this against a fresh MAX(updated_at) on
--                   every read to detect any source-side write that
--                   landed without bumping the snapshot (defence in
--                   depth — should never trigger if write-through is
--                   correct).
--   built_at      — wall-clock build time, for observability only.
--   refresh_count — monotonic counter, also observability only. A sudden
--                   uptick suggests a hot mutation loop bumping the
--                   snapshot more than expected.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dashboard_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- No additional indexes needed — org_id is the PK and reads are always
-- single-row lookups. built_from is read in the same row, no separate
-- query against it.

COMMENT ON TABLE dashboard_snapshot IS
  'Write-through snapshot of GET /api/dashboard/overview. Maintained in the same transaction as source-table writes. See migrations-postgres/0115_dashboard_snapshot.sql header for the full architecture.';

COMMENT ON COLUMN dashboard_snapshot.built_from IS
  'Cross-table MAX(updated_at) at build time. Layer 2 drift check compares against fresh MAX on every read.';
