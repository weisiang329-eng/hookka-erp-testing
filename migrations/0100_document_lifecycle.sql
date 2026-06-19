-- Mirror of migrations-postgres/0177 for the rename-map convention.
ALTER TABLE ledger_journal_entries ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_lje_hidden ON ledger_journal_entries (orgId, hidden);

CREATE TABLE IF NOT EXISTS document_lifecycle (
  id           TEXT PRIMARY KEY,
  sourceType   TEXT NOT NULL,
  sourceId     TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','VOID','DELETED')),
  actionAt     TEXT,
  actorUserId  TEXT,
  orgId        TEXT NOT NULL DEFAULT 'hookka',
  createdAt    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doclifecycle_key ON document_lifecycle (orgId, sourceType, sourceId);
CREATE INDEX IF NOT EXISTS idx_doclifecycle_state ON document_lifecycle (orgId, state);
