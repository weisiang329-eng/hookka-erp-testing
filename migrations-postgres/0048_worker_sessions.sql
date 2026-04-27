-- Persisted worker portal sessions. Replaces the in-memory tokenStore Map
-- in src/api/routes/worker-auth.ts that died on every Worker cold-start.
--
-- Schema notes:
--   token       primary key, opaque 32-char hex bearer token
--   workerId    FK to workers.id (no FK constraint — workers table lives in
--               postgres-via-Hyperdrive in prod; D1 here is a fallback shape)
--   createdAt   ISO-8601 UTC, defaulted to CURRENT_TIMESTAMP
--   expiresAt   ISO-8601 UTC, written by the route at issue time (now + 30d)
--   lastSeenAt  ISO-8601 UTC, bumped on every successful /me verify so we can
--               age out idle tokens without a separate touch endpoint
--
-- Indexes cover the two hot paths:
--   1. token verify  — PK on token (implicit) handles SELECT WHERE token = ?
--   2. revoke worker — idx_worker_sessions_workerId for DELETE on reset-pin
--   3. expiry sweep  — idx_worker_sessions_expiresAt for periodic cleanup
--
-- IF NOT EXISTS on every CREATE so this migration is safe to re-run against
-- an environment that has already been hand-patched.

CREATE TABLE IF NOT EXISTS worker_sessions (
  token TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_worker_sessions_worker_id
  ON worker_sessions(worker_id);

CREATE INDEX IF NOT EXISTS idx_worker_sessions_expires_at
  ON worker_sessions(expires_at);
