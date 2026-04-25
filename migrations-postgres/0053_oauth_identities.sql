-- ============================================================================
-- Phase B.3 / C.6 — Federated OAuth identities (Postgres mirror of D1
-- migrations/0053_oauth_identities.sql).
--
-- Schema parity notes:
--   * D1 is the legacy/rollback path; Supabase-via-Hyperdrive is the live
--     source of truth. Column names follow snake_case here, camelCase there
--     — the D1Compat adapter handles the mapping at query time
--     (see src/api/lib/column-rename-map.json).
--   * Booleans are real BOOLEAN here (vs INTEGER 0/1 in D1).
--   * Timestamps are TIMESTAMPTZ default now() (vs TEXT ISO 8601 in D1).
-- ============================================================================

CREATE TABLE IF NOT EXISTS oauth_identities (
  id              TEXT        PRIMARY KEY,
  user_id         TEXT        NOT NULL,
  provider        TEXT        NOT NULL,
  provider_subject TEXT       NOT NULL,
  email           TEXT        NOT NULL,
  email_verified  BOOLEAN     NOT NULL DEFAULT FALSE,
  hosted_domain   TEXT,
  raw_profile     TEXT,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oauth_identities_provider_subject_uq
    UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_oauth_user
  ON oauth_identities(user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_email
  ON oauth_identities(email);
