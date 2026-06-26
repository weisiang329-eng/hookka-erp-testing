-- ---------------------------------------------------------------------------
-- 0192_announcement_attachments.sql — media on announcements (image/video/PDF).
--
-- The office can attach tutorial images/videos and SOP PDFs to a notice so the
-- worker portal renders them inline (image/video) or as a download link (PDF).
-- Files themselves live in the existing /api/files store (R2/Supabase); this
-- column only holds a lightweight JSON manifest of what's attached:
--   [ { "fileId": "...", "name": "...", "mime": "image/png" }, ... ]
-- so the worker GET can render each one without a second round-trip.
--
-- snake_case column (`attachments`) — no column-rename-map entry needed.
--
-- NOTE: migration files are INERT on deploy (Hookka does not replay
-- migrations-postgres/*.sql). This file is the record + the SQLite test mirror;
-- the load-bearing copy is the runtime `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
-- in src/api/routes/announcements.ts (ensureAnnouncementsTable), awaited at the
-- TOP of every handler before the first read/write.
-- ---------------------------------------------------------------------------

ALTER TABLE announcements ADD COLUMN IF NOT EXISTS attachments TEXT;
