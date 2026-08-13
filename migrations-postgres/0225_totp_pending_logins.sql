-- 0225 — totp_pending_logins
--
-- The proof that step 1 of a two-step login actually happened.
-- BUG-2026-08-13-101: `POST /api/auth/totp/login-verify` took { userId, code }
-- and issued a full session without ever checking a password, so for a user
-- enrolled in 2FA a user id — which is not a secret — plus one TOTP code or one
-- recovery code was a complete credential. `/api/auth/login` now mints a
-- short-lived, single-use pending token when the PASSWORD verifies, and
-- `/login-verify` refuses without it.
--
-- Deliberately NOT the sessions table: a row here must never be mistakable for
-- a session by the auth middleware, which resolves bearer/cookie tokens against
-- `user_sessions`.
--
-- No org_id: this is an authentication artefact keyed to one user id, not a
-- tenant-scoped business record, and it is looked up by token hash only.
--
-- NOTE: this file is a RECORD, not the mechanism. Deploys do not replay
-- migrations-postgres/*.sql. The statement that actually creates this table in
-- production is the identical CREATE inside `ensureTotpPendingTable`
-- (src/api/lib/totp-pending.ts), awaited before the first read or write.
CREATE TABLE IF NOT EXISTS totp_pending_logins (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT,
  expires_at TEXT
);
