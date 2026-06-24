-- ---------------------------------------------------------------------------
-- 0188_announcement_acks.sql — per-worker read-receipts for announcements
-- (built 2026-06-24). The device-local "Got it" became a real server-recorded
-- acknowledgement: ONE row the moment a worker taps "Got it" on the phone
-- popup. The popup gate is now SERVER-driven off this table (the worker GET
-- returns this worker's acked ids), the office reads it back as a read-receipt
-- (acked vs the ACTIVE roster), and "Remind" stamps announcements.reminded_at
-- so the popup re-pops for the un-acked (there is NO push — re-pop is the only
-- channel).
--
-- snake_case throughout (prefer snake_case columns — no column-rename-map entry
-- needed). The route reads acked_at / worker_id dual-keyed because the PG
-- driver folds snake→camel on read.
--
-- NOTE: migration files are INERT on deploy (Hookka does not replay
-- migrations-postgres/*.sql). This file is the record + the SQLite test mirror;
-- the load-bearing copy is the runtime CREATE TABLE / CREATE INDEX / ALTER in
-- src/api/routes/announcements.ts (ensureAnnouncementsTable), awaited at the
-- TOP of every ack handler before the first read/write.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS announcement_acks (
  announcement_id TEXT NOT NULL,
  worker_id       TEXT NOT NULL,
  acked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, worker_id)
);

-- The worker GET fetches "this worker's acked ids" by worker_id; the office
-- read-receipt / remind join keys off announcement_id (already the PK's leading
-- column). Index the worker_id side for the per-worker subquery.
CREATE INDEX IF NOT EXISTS idx_announcement_acks_worker
  ON announcement_acks (worker_id);

-- Reminder marker: when the office taps "Remind", we stamp reminded_at on the
-- announcement; the worker popup gate treats a notice reminded AFTER a worker's
-- ack as un-acked again (re-pop). One stamp, no per-worker fan-out.
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
