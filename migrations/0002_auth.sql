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
  passwordHash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'SUPER_ADMIN',
  isActive INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  lastLoginAt TEXT,
  displayName TEXT
);

CREATE INDEX users_email_idx ON users(email);

-- --- User sessions ----------------------------------------------------------
-- Opaque bearer tokens issued on /api/auth/login. 30-day default lifetime
-- (enforced by the route, not by the schema). Sessions are invalidated by
-- /api/auth/logout, by the admin user-delete flow, and by password resets.
CREATE TABLE user_sessions (
  token TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX user_sessions_userId_idx ON user_sessions(userId);
CREATE INDEX user_sessions_expiresAt_idx ON user_sessions(expiresAt);
