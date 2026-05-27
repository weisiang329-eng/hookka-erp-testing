-- ---------------------------------------------------------------------------
-- 0084_password_reset_tokens.sql — self-service forgot-password tokens.
--
-- Created 2026-05-27 after Wei Siang got locked out as the only SUPER_ADMIN.
-- The login form previously said "ask a super admin to reset" but there was
-- no other super admin, so the only recovery path was SQL UPDATE on the
-- users table by hand. This migration adds the table that backs a proper
-- self-service flow:
--
--   1. User clicks "Forgot password" → POST /api/auth/forgot-password
--      with their email.
--   2. Server generates a 64-char random token, INSERTs a row here with
--      expiresAt = NOW() + 1 hour.
--   3. Server emails the user a link: APP_URL/reset-password?token=<token>
--      (Resend, hand-rolled fetch in src/api/lib/email.ts).
--   4. User clicks the link → POST /api/auth/reset-password with token +
--      new password.
--   5. Server verifies token unused + not expired, hashes new password,
--      UPDATEs users.passwordHash, marks row used (usedAt = NOW()).
--
-- Security details:
--   - Tokens are crypto.randomUUID() doubled (~32 bytes of entropy).
--   - Single-use: usedAt flips on successful reset, second attempt 410s.
--   - 1-hour expiry. Configurable in the route handler.
--   - Rate-limited by email (1 reset request per 5 min) — enforced in
--     route handler, not in this table.
--   - Email enumeration mitigated by always responding 200 from
--     /forgot-password regardless of whether the email exists.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  -- The opaque token itself, doubles as primary key. We never expose
  -- this in SELECTs other than the verify-and-use path.
  token TEXT PRIMARY KEY,
  -- Email (snapshot) — matches users.email at issue time. Stored
  -- separately so an attacker who somehow gets a token can't look up
  -- the email; we always match against users.email at reset time.
  email TEXT NOT NULL,
  -- ISO 8601 timestamp; we compare via Date.parse() not Postgres NOW()
  -- so the same logic works regardless of TIMESTAMP vs TEXT cols.
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Null until consumed. Set on successful reset.
  usedAt TEXT,
  -- IP + UA snapshot for forensics (the audit_events row created on
  -- successful reset includes these too, but having them on the token
  -- row lets us spot-check abuse without a join).
  requestIp TEXT,
  requestUa TEXT
);

-- "Was this email already requested recently?" — rate-limit check.
-- Ordered DESC so the rate-limit query is `WHERE email = ? ORDER BY
-- createdAt DESC LIMIT 1`.
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email
  ON password_reset_tokens(email, createdAt DESC);

-- Expiry sweep / cleanup (nightly cron, future).
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
  ON password_reset_tokens(expiresAt);
