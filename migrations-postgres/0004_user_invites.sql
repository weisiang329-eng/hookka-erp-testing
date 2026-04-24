-- ============================================================================
-- HOOKKA ERP — Cloudflare D1 (SQLite) invite portal schema
--
-- Backs the admin-only invite flow: /api/users/invite creates a row here,
-- Resend fires an email containing /invite/<token>, the recipient finishes
-- onboarding via /api/auth/accept-invite which flips `acceptedAt` and
-- provisions the corresponding users row.
--
-- Conventions match 0001_init.sql / 0002_auth.sql:
--   * Dates/timestamps → TEXT (ISO 8601).
--   * token            → crypto.randomUUID() (36 chars, URL-safe).
--   * email            → UNIQUE so repeat invites collide with /POST /invite.
-- ============================================================================

CREATE TABLE user_invites (
  token TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'SUPER_ADMIN',
  display_name TEXT,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  email_sent_at TEXT,
  email_resend_id TEXT,  -- Resend's message id for debugging
  FOREIGN KEY(invited_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX user_invites_email_idx ON user_invites(email);
CREATE INDEX user_invites_expires_at_idx ON user_invites(expires_at);
