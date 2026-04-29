-- ---------------------------------------------------------------------------
-- 0081_email_outbox.sql — Sprint 4 email reliability layer.
--
-- Why: every Resend call site today is a fire-and-forget POST inside the
-- request handler. A 500 from Resend during the 3-second response budget
-- silently drops the email and the operator only finds out via the customer
-- complaining. The outbox decouples the WRITE from the SEND:
--
--   request -> INSERT into outbox_emails (PENDING)
--           -> respond 200 to the user
--   cron    -> SELECT pending rows, POST to Resend, mark SENT/RETRYING/FAILED
--
-- Failure semantics: 3 retries with exponential backoff, then FAILED. The
-- partial index on (status, created_at) WHERE status IN ('PENDING','RETRYING')
-- keeps the cron's "next batch" lookup O(log n) even after the table grows.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS outbox_emails (
  id              TEXT PRIMARY KEY,
  to_address      TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body_html       TEXT,
  body_text       TEXT,
  -- payload_json is for future template-driven sends; the current callers
  -- bake the rendered HTML/text into body_html / body_text directly. Kept
  -- nullable so the cron processor doesn't need a render step.
  payload_json    TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','SENT','FAILED','RETRYING')),
  attempts        INT  NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  org_id          TEXT NOT NULL DEFAULT 'hookka'
);

-- Hot-path index for the cron drain query. WHERE clause keeps the index
-- tiny (only PENDING/RETRYING rows live in it; sent rows fall out
-- automatically) so daily housekeeping isn't required.
CREATE INDEX IF NOT EXISTS idx_outbox_emails_pending
  ON outbox_emails(status, created_at)
  WHERE status IN ('PENDING','RETRYING');

-- Org-scoped lookup (matches the rest of the multi-tenant rollout).
CREATE INDEX IF NOT EXISTS idx_outbox_emails_org_id
  ON outbox_emails(org_id);
