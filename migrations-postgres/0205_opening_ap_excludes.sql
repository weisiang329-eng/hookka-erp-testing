-- Mid-year opening: pre-opening PIs count as opening BY DEFAULT (owner rule
-- 2026-07-02 — existing rows are never edited); this table lists the
-- exceptions (wrong/phantom entries that must stay hidden behind the floor).
-- RECORD ONLY — the table is runtime self-applied by ensureOpeningApExcludes
-- in src/api/routes/accounting.ts; no manual run needed.
CREATE TABLE IF NOT EXISTS opening_ap_excludes (
  pi_id      TEXT PRIMARY KEY,
  org_id     TEXT,
  created_at TEXT
);
