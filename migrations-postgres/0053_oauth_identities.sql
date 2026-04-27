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
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,            -- 'google' (later 'microsoft')
  provider_subject TEXT NOT NULL,     -- Google id_token `sub` — stable per Google account
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  hosted_domain TEXT,                 -- 'hookka.com' for Workspace; null for gmail.com
  raw_profile TEXT,                   -- JSON of id_token claims for forensics
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_email ON oauth_identities(email);
