-- ---------------------------------------------------------------------------
-- 0046_audit_events.sql — phase 3 audit foundation. Single immutable journal
-- for all sensitive mutations.
--
-- Today audit logs are fragmented: `job_card_events` (0039) covers job-card
-- mutations and `scan_override_audit` covers worker overrides. The 12 most
-- sensitive mutations (SO confirm, PO create, GRN, invoice post, payment,
-- JC status, user role change, worker delete, payroll post, credit/debit
-- note, e-invoice submit, BOM template publish) write to NOTHING. This
-- migration introduces one unified audit table to fix that gap.
--
-- Forward-only: existing rows in domain tables are NOT backfilled — capture
-- starts from the deploy that wires audit.ts (tracked as P3.4) into the top
-- 12 mutations. job_card_events stays parallel for now; deprecation tracked
-- as a follow-up after audit_events is broadly adopted.
--
-- Snapshot fields (actorUserName, actorRole) are captured at action time
-- rather than FK-joined, so the journal survives a user being deleted or a
-- role being renamed. This is intentional: an audit trail that loses its
-- attribution when accounts are cleaned up is worthless for forensics.
--
-- State capture semantics for beforeJson / afterJson:
--   create  → before=null,    after=row JSON
--   update  → before=row JSON, after=row JSON
--   delete  → before=row JSON, after=null
--   action  → before=null,    after=null   (e.g. 'login', 'submit')
--
-- Index strategy:
--   idx_audit_events_resource — "show audit trail for SO X" (most common)
--   idx_audit_events_actor    — "what did user X touch on date Y" (forensic)
--   idx_audit_events_ts       — "last 24h" / monthly export / pruning
--   idx_audit_events_action   — "how many invoice voids this month" (analytics)
-- All four use ts DESC to match the forensic-query "newest first" pattern.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  -- Actor identity at action time. Snapshot fields, not FK-joined, so the
  -- log survives a user being deleted or a role being renamed.
  actor_user_id TEXT,                    -- nullable for system events
  actor_user_name TEXT,                  -- snapshot of users.displayName
  actor_role TEXT,                      -- snapshot of role name (legacy users.role
                                       -- or roles.name post-RBAC rollout)
  -- What was acted on.
  resource TEXT NOT NULL,              -- 'sales-orders', 'invoices', 'job-cards' etc.
                                       -- Match the values used by the upcoming
                                       -- requirePermission(resource, action) middleware.
  resource_id TEXT NOT NULL,            -- the row's PK in its own table
  action TEXT NOT NULL,                -- 'create', 'update', 'delete', 'confirm',
                                       -- 'post', 'void', 'approve', 'cancel', etc.
  -- State capture. Either may be null:
  --   create  → before=null, after=row JSON
  --   update  → before=row JSON, after=row JSON
  --   delete  → before=row JSON, after=null
  --   action  → before=null, after=null (actions like 'login' carry no row)
  before_json TEXT,
  after_json TEXT,
  -- Surface metadata.
  source TEXT NOT NULL DEFAULT 'ui',   -- 'ui' | 'api' | 'scan' | 'admin' | 'cron' | 'system'
  ip_address TEXT,                      -- if extractable from request headers
  user_agent TEXT,                      -- truncated UA string, ≤256 chars
  -- Time.
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Lookup by resource (the most common query: "show audit trail for SO X")
CREATE INDEX IF NOT EXISTS idx_audit_events_resource
  ON audit_events(resource, resource_id, ts DESC);

-- Lookup by actor (forensic queries: "what did user X touch on date Y")
CREATE INDEX IF NOT EXISTS idx_audit_events_actor
  ON audit_events(actor_user_id, ts DESC);

-- Time-range scans (e.g. last 24h, monthly export)
CREATE INDEX IF NOT EXISTS idx_audit_events_ts
  ON audit_events(ts DESC);

-- Action-type analytics (e.g. "how many invoice voids this month")
CREATE INDEX IF NOT EXISTS idx_audit_events_action
  ON audit_events(action, ts DESC);
