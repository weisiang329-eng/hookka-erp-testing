-- ---------------------------------------------------------------------------
-- 0051_journal_entries.sql — Phase C #2 quick-win.
--
-- Immutable accounting ledger with SHA-256 hash chain (per
-- docs/ROADMAP-PHASE-C.md §2 quick-win). Each posted business event
-- (invoice post, payment, credit-note, debit-note) writes one row PER LEG
-- of the double-entry pair. Tampering with any field of any row breaks
-- every subsequent rowHash, so the chain is forensically verifiable.
--
-- Quick-win scope: collect the chain via DUAL-WRITE alongside existing
-- editable invoice/payment posting. Do NOT yet enforce immutability via a
-- trigger — that flips after 30 days of clean chain data lands (M3/W9 in
-- the roadmap).
--
-- Naming note: the legacy `journal_entries` table from 0010_accounting.sql
-- is a parent/child layout (entries + journal_lines) used by the manual JE
-- admin UI in routes-d1/accounting.ts. It serves a different purpose
-- (human-edited adjusting entries) and stays in place. The new immutable
-- ledger uses the distinct table name `ledger_journal_entries` to avoid
-- the name collision while still matching the roadmap's intent.
--
-- D1 conventions (per 0001_init.sql / 0046_audit_events.sql):
--   * camelCase column names — d1-compat maps to snake_case for Postgres.
--   * Money columns end in `Sen` and use INTEGER (sen, no decimals).
--   * IF NOT EXISTS on every CREATE so re-runs are safe.
--
-- Index strategy:
--   idx_lje_source       — "show ledger entries for invoice X" (forensic UI)
--   idx_lje_account      — "GL account 1100 history" (BI / accounting)
--   idx_lje_org          — "this tenant, latest first" (chain head lookup)
--   idx_lje_unreversed   — "still-active entries" (financial-position joins)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ledger_journal_entries (
  id TEXT PRIMARY KEY,
  posted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Source link: which business event produced this entry?
  source_type TEXT NOT NULL,        -- 'invoice', 'payment', 'credit_note', 'debit_note', 'manual'
  source_id TEXT NOT NULL,          -- the row PK in its source table
  -- The double-entry pair (one row per leg).
  leg_no INTEGER NOT NULL,          -- 1, 2, ... within the same entry
  account_code TEXT NOT NULL,       -- e.g. '1100' (AR), '4000' (Sales), '2400' (GST output)
  debit_sen INTEGER NOT NULL DEFAULT 0,
  credit_sen INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  -- Forensic chain: each entry's hash includes the previous entry's hash.
  -- Tampering with row N invalidates rows N+1 onward.
  prev_hash TEXT NOT NULL DEFAULT '',
  row_hash  TEXT NOT NULL,
  -- Actor + tenant
  actor_user_id TEXT,
  org_id TEXT NOT NULL DEFAULT 'hookka',
  -- Reversal: if this entry was reversed by a credit-note/voiding,
  -- store the reversing entry's id here. NULL if still active.
  reversed_by_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_lje_source     ON ledger_journal_entries(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_lje_account    ON ledger_journal_entries(account_code, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_lje_org        ON ledger_journal_entries(org_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_lje_unreversed ON ledger_journal_entries(reversed_by_id) WHERE reversed_by_id IS NULL;
