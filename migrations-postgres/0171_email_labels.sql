-- ============================================================================
-- 0171 — Mail Center label catalogue (owner 2026-06-17: "labels with colours
-- like Gmail").
--
-- The Mail Center keeps each thread's labels as a JSON array of NAMES on
-- email_threads.labels (a TEXT column added at runtime by
-- src/api/routes/mail-center.ts ensureMailSchema). This table is the canonical
-- name → colour catalogue so the sidebar can render a coloured dot per label
-- and offer a managed list (create / rename / recolour / delete). Joined to the
-- per-thread label names by lower(name); a thread label with no row here just
-- renders in the neutral brand tone.
--
-- ⚠ ADAPTER RULE: created_at is written by the app via new Date().toISOString()
-- (an ISO string), so it MUST stay TEXT — never timestamptz — or the
-- SupabaseAdapter will not round-trip it. Same rule the rest of the mail-center
-- timestamp columns (email_threads.trashed_at, *.created_at, …) follow.
--
-- ⚠ Also self-applied at runtime (ensureMailSchema in
-- src/api/routes/mail-center.ts) with the identical DDL, so applying this with
-- the migration tool is a harmless no-op on databases where the route already
-- created it (same belt-and-braces pattern as 0167 / 0170).
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_labels (
  id         text PRIMARY KEY,
  org_id     text NOT NULL DEFAULT 'hookka',
  name       text NOT NULL,
  color      text,
  created_at text,
  created_by text
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_email_labels_org_name
  ON email_labels (org_id, name);
