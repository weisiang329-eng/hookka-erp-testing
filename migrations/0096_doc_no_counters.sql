-- Mirror of migrations-postgres/0171 for the rename-map scanner.
CREATE TABLE IF NOT EXISTS doc_no_counters (
  prefix      TEXT NOT NULL,
  ym          TEXT NOT NULL,
  next_no     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (prefix, ym)
);
