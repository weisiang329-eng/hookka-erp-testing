-- ============================================================================
-- Phase B.3 / C.6 — Federated OAuth identities (Google Workspace today;
-- Microsoft 365 tomorrow). One users row can have multiple federated logins
-- (one per provider) plus a password — they are all routed through this
-- table.
--
-- Why a separate table (vs columns on users):
--   * A user might link to several providers (Google + Microsoft) over time.
--   * The unique key is (provider, providerSubject) — Google's `sub` claim is
--     the only stable per-account identifier (email can change).
--   * `rawProfile` archives the raw id_token claims for forensic / future
--     enrichment (admin can attribute a sign-in to a Google sub even if
--     the email later changes).
-- ============================================================================

CREATE TABLE IF NOT EXISTS oauth_identities (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  provider TEXT NOT NULL,            -- 'google' (later 'microsoft')
  providerSubject TEXT NOT NULL,     -- Google id_token `sub` — stable per Google account
  email TEXT NOT NULL,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  hostedDomain TEXT,                 -- 'hookka.com' for Workspace; null for gmail.com
  rawProfile TEXT,                   -- JSON of id_token claims for forensics
  linkedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastSeenAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, providerSubject)
);

CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_identities(userId);
CREATE INDEX IF NOT EXISTS idx_oauth_email ON oauth_identities(email);
