-- 0195_push_subscriptions.sql (Supabase / Postgres mirror)
--
-- Web Push subscriptions for the Worker Portal (one row per browser/device a
-- worker opts in on). Backs the /api/push/* endpoints (subscribe / unsubscribe
-- / clock-reminder) and the announcement -> push fan-out.
--
-- NOTE: Hookka deploys do NOT replay migration files — this file is INERT on
-- prod. The table reaches prod ONLY via the runtime self-apply in
-- src/api/routes/push.ts (ensurePushTable, awaited at the top of every write
-- handler before the first read/write). This file is the schema
-- source-of-truth / fresh-DB bootstrap; the runtime CREATE TABLE is what
-- actually lands it. Keep the migrations/0195 twin in sync.
--
--   endpoint   : the push-service URL (UNIQUE — one row per device endpoint).
--   p256dh     : base64url UA public key (the subscription's ECDH point).
--   auth       : base64url 16-byte auth secret.
--   worker_id  : workers.id of the opted-in worker (for targeted sends).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,
  worker_id   TEXT NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_worker
  ON push_subscriptions (worker_id);
