-- ---------------------------------------------------------------------------
-- 0186_announcements.sql — In-app announcements (office → all workers).
--
-- The office posts short notices from the dashboard; every worker sees the
-- ACTIVE (is_active && not-expired) ones at the top of their phone home screen.
-- v1 has NO push and NO per-worker read table — the worker side tracks "seen"
-- ids in localStorage purely for the unread dot.
--
-- snake_case throughout (route SQL is camelCase → translated by
-- column-rename-map.json; snake_case columns need no map entry — prefer them).
--
-- NOTE: migration files are INERT on deploy (Hookka does not replay
-- migrations-postgres/*.sql). This file is the record + the SQLite test
-- mirror; the load-bearing copy is the runtime `CREATE TABLE IF NOT EXISTS`
-- in src/api/routes/announcements.ts (ensureAnnouncementsTable), awaited at the
-- TOP of every handler before the first read/write.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS announcements (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL DEFAULT 'hookka',
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at   TIMESTAMPTZ,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ
);

-- Worker home reads the newest ACTIVE ones for an org; this index keeps that
-- "is_active filter, newest first" scan cheap.
CREATE INDEX IF NOT EXISTS idx_announcements_org_active_created
  ON announcements (org_id, is_active, created_at DESC);

-- Auto-translation (added 2026-06-23). ONE JSON blob holds the four
-- worker-portal language versions: { en:{title,body}, ms:{…}, zh:{…}, my:{…} }.
-- Filled best-effort on POST/PATCH via Claude; null when translation is
-- unavailable (worker FE then shows the original posted text). A single JSONB
-- column (not per-lang columns) keeps the schema stable if a 5th language is
-- ever added. INERT here — the load-bearing copy is the runtime
-- `ALTER TABLE … ADD COLUMN IF NOT EXISTS translations JSONB` in
-- ensureAnnouncementsTable (src/api/routes/announcements.ts).
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS translations JSONB;
