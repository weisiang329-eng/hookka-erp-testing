-- ============================================================================
-- HOOKKA ERP — Cloudflare D1 (SQLite) auth schema
--
-- Adds the login / session tables used by the new portal and the
-- `authMiddleware` in src/api/lib/auth-middleware.ts.
--
-- Conventions match 0001_init.sql:
--   * Dates/timestamps → TEXT (ISO 8601).
--   * Booleans         → INTEGER (0 / 1).
--   * Password hash    → PBKDF2-SHA256, 100000 iters, 32-byte key,
--                        stored as "pbkdf2-sha256$100000$<hex-salt>$<hex-hash>"
--                        (single TEXT column, no separate salt).
-- ============================================================================

-- --- Users ------------------------------------------------------------------
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'SUPER_ADMIN',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  display_name TEXT
);

CREATE INDEX users_email_idx ON users(email);

-- --- User sessions ----------------------------------------------------------
-- Opaque bearer tokens issued on /api/auth/login. 30-day default lifetime
-- (enforced by the route, not by the schema). Sessions are invalidated by
-- /api/auth/logout, by the admin user-delete flow, and by password resets.
CREATE TABLE user_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX user_sessions_user_id_idx ON user_sessions(user_id);
CREATE INDEX user_sessions_expires_at_idx ON user_sessions(expires_at);
