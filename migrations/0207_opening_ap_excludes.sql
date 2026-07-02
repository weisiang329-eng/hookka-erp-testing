-- sqlite mirror of migrations-postgres/0205_opening_ap_excludes.sql (feeds the
-- rename-map scanner). Runtime self-applied — record only.
CREATE TABLE IF NOT EXISTS opening_ap_excludes (
  pi_id      TEXT PRIMARY KEY,
  org_id     TEXT,
  created_at TEXT
);
