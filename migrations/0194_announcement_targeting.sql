-- 0194_announcement_targeting.sql
--
-- Adds audience targeting to announcements so a notice can go to everyone
-- (default) or be scoped to specific departments and/or specific workers.
--
-- NOTE: Hookka deploys do NOT replay migration files — this file is INERT on
-- prod. The columns reach prod ONLY via the runtime self-apply in
-- src/api/routes/announcements.ts (ensureAnnouncementsTable, awaited at the top
-- of every handler before the first read/write). This file is the schema
-- source-of-truth / fresh-DB bootstrap; the runtime ALTERs are what actually
-- land the columns. Keep the migrations-postgres/0194 twin in sync.
--
-- (The `attachments` column already shipped in 0193 — NOT re-added here.)

-- Audience targeting (ALL | DEPTS | WORKERS | MIXED; default ALL = everyone).
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'ALL';
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_dept_codes TEXT;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_worker_ids TEXT;
