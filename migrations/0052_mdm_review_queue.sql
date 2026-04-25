-- ---------------------------------------------------------------------------
-- 0052_mdm_review_queue.sql — Phase C #4 quick-win.
--
-- Master Data Management (MDM) duplicate-detection review queue. Per
-- docs/ROADMAP-PHASE-C.md §4 quick-win: ship the DETECTION half only — a
-- nightly job (eventually) flags suspected duplicates here, ops triage them
-- through the existing customer/supplier UIs and mark this row resolved.
--
-- Why now: duplicate customers cause double-shipped DOs (DO-3217 incident,
-- Q1 2026) at ~3-5 dups/quarter × $200 reverse-logistics each. Detection
-- alone catches the bleeding while the full merge transaction is built.
-- See roadmap §4 for the full scope (auto-merge, FK repointing, etc.).
--
-- Status workflow:
--   PENDING    → just detected, ops haven't seen it yet
--   REVIEWING  → ops opened the candidate pair (optional intermediate state)
--   MERGED     → ops merged in the existing UI; this row is just the audit flag
--   DISMISSED  → false positive, ops marked it as "keep separate"
--
-- Score range: 0-100. 100 = SSM/registration match (deterministic). 80 =
-- phone + name fuzzy (high but not certain). The score-based threshold for
-- auto-merge (>95) is not used here — every row goes to ops for now.
--
-- The UNIQUE (resourceType, primaryId, candidateId) constraint dedupes
-- naturally: re-running detection on the same pair just hits the conflict
-- and skips. The detector orders the two ids consistently (lex-smaller =
-- primaryId) so (A,B) and (B,A) collapse to one row.
--
-- D1 conventions (matches 0001_init.sql / 0046_audit_events.sql / 0049):
--   * camelCase column names — d1-compat rewrites to snake_case for Postgres.
--   * IF NOT EXISTS on every CREATE so the migration is re-runnable.
--   * orgId default 'hookka' so existing single-tenant deploys are zero-impact.
--
-- Apply:
--   npx wrangler d1 execute hookka-erp-db --remote --file migrations/0052_mdm_review_queue.sql
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mdm_review_queue (
  id TEXT PRIMARY KEY,
  resourceType TEXT NOT NULL,        -- 'customers', 'suppliers', 'products'
  -- The two ids that look like duplicates of each other.
  primaryId TEXT NOT NULL,
  candidateId TEXT NOT NULL,
  -- Confidence score 0-100; higher = more likely duplicate.
  score INTEGER NOT NULL,
  -- Specific signals that triggered the match (JSON array of strings):
  -- ['ssm_match', 'phone_match', 'name_fuzzy_0.94']
  signals TEXT NOT NULL DEFAULT '[]',
  -- Status workflow: PENDING (just detected) → REVIEWING (ops opened it) →
  -- MERGED (ops merged via the existing UI) | DISMISSED (false positive).
  status TEXT NOT NULL DEFAULT 'PENDING',
  detectedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolvedAt TEXT,
  resolvedBy TEXT,
  notes TEXT NOT NULL DEFAULT '',
  orgId TEXT NOT NULL DEFAULT 'hookka',
  UNIQUE (resourceType, primaryId, candidateId)
);

-- "Show me the open queue, newest first" — the operator inbox query.
CREATE INDEX IF NOT EXISTS idx_mdm_status ON mdm_review_queue(status, detectedAt DESC);
-- "How many open dups for customers vs suppliers" — health-tile query.
CREATE INDEX IF NOT EXISTS idx_mdm_resource ON mdm_review_queue(resourceType, status);
