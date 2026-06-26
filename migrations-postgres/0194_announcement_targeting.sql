-- 0194_announcement_targeting.sql (Supabase / Postgres mirror)
--
-- Adds audience targeting to announcements so a notice can go to everyone
-- (default) or be scoped to specific departments and/or specific workers.
--
-- NOTE: Hookka deploys do NOT replay migration files — this file is INERT on
-- prod. The columns reach prod ONLY via the runtime self-apply in
-- src/api/routes/announcements.ts (ensureAnnouncementsTable, awaited at the top
-- of every handler before the first read/write). This file is the schema
-- source-of-truth / fresh-DB bootstrap; the runtime ALTERs are what actually
-- land the columns. Keep the two in sync.
--
-- (The `attachments` column already shipped in 0193 — NOT re-added here.)

-- Audience targeting.
--   target_type       : ALL | DEPTS | WORKERS | MIXED  (default ALL = everyone)
--   target_dept_codes : JSON array of department codes  (e.g. '["PACKING","FOAM"]')
--   target_worker_ids : JSON array of workers.id values
-- The worker GET shows a notice iff target_type='ALL' OR the worker's dept is in
-- target_dept_codes OR the worker's id is in target_worker_ids. Existing rows
-- default to ALL, so the change is fully back-compatible.
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'ALL';
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_dept_codes TEXT;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_worker_ids TEXT;
