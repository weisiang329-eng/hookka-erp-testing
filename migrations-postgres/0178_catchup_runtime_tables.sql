-- ============================================================================
-- 0178 — Catch-up migration for runtime-only tables.
--
-- These tables were previously created ONLY at runtime via
-- `CREATE TABLE IF NOT EXISTS` in route/lib code (a "self-applying schema"
-- pattern), so a fresh DB rebuild from migrations-postgres/ alone would NOT
-- have them. This file captures the exact DDL VERBATIM from the source so a
-- clean rebuild (db:reset:supabase) stands the tables up too.
--
-- All statements are idempotent (IF NOT EXISTS), so applying this is a harmless
-- no-op on prod / any DB where the route already created the table at runtime
-- (same belt-and-braces pattern as 0167 / 0170 / 0171). The runtime DDL is
-- intentionally LEFT IN PLACE as belt-and-suspenders.
--
-- Source files (DDL copied as-is — these statements already run against
-- Postgres at runtime, so the types are correct):
--   • src/api/routes/mail-center.ts        — email_* + mail_user_scope
--   • src/api/routes/production-folders.ts — production_folders, folder_job_cards
--   • src/api/lib/ocr-distill.ts           — supplier_scan_samples
--   • src/api/routes/production-orders.ts  — wip_cascade_log
--
-- ⚠ ADAPTER RULE (mail tables): every *_at column here is written by the app
-- via new Date().toISOString() (an ISO string), so it MUST stay TEXT — never
-- timestamptz — or the SupabaseAdapter will not round-trip it. The folders /
-- wip_cascade_log tables instead use TIMESTAMPTZ DEFAULT now() because those
-- timestamps are DB-generated, matching their runtime DDL.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Mail Center (src/api/routes/mail-center.ts ensureMailSchema)
-- email_labels is also created by 0171; repeated here (idempotent) so the full
-- mail schema lives in one catch-up file.
-- ----------------------------------------------------------------------------

-- Our outward-facing addresses / aliases (support@, sales@, lim@ ...).
CREATE TABLE IF NOT EXISTS email_addresses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'hookka',
  address TEXT NOT NULL,
  label TEXT,
  assigned_user_id TEXT,
  assigned_user_name TEXT,
  assigned_dept TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  created_by TEXT
);
-- Records the person's job title alongside assigned_dept (owner 2026-06-17).
ALTER TABLE email_addresses ADD COLUMN IF NOT EXISTS assigned_position TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_addresses_org_addr
  ON email_addresses (org_id, address);

-- Mailbox access grants (the "mailbox matrix" — owner 2026-06-17).
CREATE TABLE IF NOT EXISTS email_address_access (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'hookka',
  address_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT,
  created_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_access_addr_user
  ON email_address_access (org_id, address_id, user_id);
CREATE INDEX IF NOT EXISTS ix_email_access_user
  ON email_address_access (org_id, user_id);

-- Hierarchical mail-visibility level per user (owner 2026-06-17).
CREATE TABLE IF NOT EXISTS mail_user_scope (
  org_id TEXT NOT NULL DEFAULT 'hookka',
  user_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'personal',
  created_at TEXT,
  PRIMARY KEY (org_id, user_id)
);

-- One conversation with an external party, grouped by RFC threading.
CREATE TABLE IF NOT EXISTS email_threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'hookka',
  mailbox_address TEXT,
  subject TEXT,
  counterparty_email TEXT,
  counterparty_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to_user_id TEXT,
  assigned_to_name TEXT,
  last_message_at TEXT,
  last_direction TEXT,
  last_snippet TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);
-- Email-client affordances (star / labels / trash). trashed_at is a soft-delete
-- timestamp; like every timestamp here it MUST stay TEXT (never timestamptz).
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS labels TEXT;
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS trashed_at TEXT;
CREATE INDEX IF NOT EXISTS ix_email_threads_org_box
  ON email_threads (org_id, mailbox_address, last_message_at);

-- Individual messages (both directions).
CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'hookka',
  thread_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_id TEXT,
  in_reply_to TEXT,
  reference_ids TEXT,
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT,
  cc_addresses TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  sent_at TEXT,
  received_at TEXT,
  sent_by_user_id TEXT,
  sent_by_name TEXT,
  provider_message_id TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_email_messages_thread
  ON email_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS ix_email_messages_msgid
  ON email_messages (message_id);

-- Inbound attachments (owner 2026-06-18 — "e-invoices/photos must show").
CREATE TABLE IF NOT EXISTS email_attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'hookka',
  message_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  storage_path TEXT,
  content_id TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_email_attachments_msg
  ON email_attachments (message_id);

-- Label registry (owner 2026-06-17 — "labels with colours like Gmail").
-- Also created by 0171_email_labels.sql; idempotent repeat for completeness.
CREATE TABLE IF NOT EXISTS email_labels (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'hookka',
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT,
  created_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_labels_org_name
  ON email_labels (org_id, name);

-- ----------------------------------------------------------------------------
-- Production Folders (src/api/routes/production-folders.ts)
-- org_id is TEXT (not UUID) to match the multi-tenant skeleton from migration
-- 0049 — Hookka tables uniformly use TEXT 'hookka' as the tenant scope. The
-- ALTER below idempotently flips any existing-with-UUID table to TEXT.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE production_folders
  ALTER COLUMN org_id TYPE TEXT USING org_id::text;
CREATE TABLE IF NOT EXISTS folder_job_cards (
  folder_id   UUID NOT NULL REFERENCES production_folders(id) ON DELETE CASCADE,
  job_card_id TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (folder_id, job_card_id)
);
CREATE INDEX IF NOT EXISTS idx_production_folders_org_created
  ON production_folders (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_folder_job_cards_jc
  ON folder_job_cards (job_card_id);

-- ----------------------------------------------------------------------------
-- Supplier scan samples (src/api/lib/ocr-distill.ts)
--
-- Spelled to match PRODUCTION, which is MIXED — corrected 2026-08-02.
--
-- The old header claimed "camelCase identifiers are intentional … written via
-- the D1Compat adapter using the column names the route code uses directly."
-- That was half true and therefore wrong. The adapter's translateSql rewrites
-- an identifier only when it is a KEY in column-rename-map.json; everything
-- else passes through unquoted and Postgres folds it to lower case. So the
-- runtime CREATE in ocr-distill.ts produced:
--
--   orgId        -> org_id          (mapped)
--   supplierId   -> supplier_id     (mapped)
--   correctedJson-> corrected_json  (mapped)
--   isGold       -> is_gold         (mapped)
--   createdBy    -> created_by      (mapped)
--   createdAt    -> created_at      (mapped)
--   supplierHint -> supplierhint    (FOLDED — not in the map)
--   docIdentifier-> docidentifier   (FOLDED)
--   docType      -> doctype         (FOLDED)
--   rawJson      -> rawjson         (FOLDED)
--
-- Not a live bug — CREATE TABLE IF NOT EXISTS no-ops against the table the
-- runtime already made. But any tool that applies this FILE to a fresh database
-- without going through the adapter (a restore, a new environment, the
-- schema-in-sync check) built a table the application cannot read. Houzs-ERP
-- #1480's exact lesson: the repo's declaration and production disagreed, and
-- the disagreement only surfaced when someone deleted a member.
--
-- 0154 / 0156 / 0159 / 0163 already carry the same "folded-lowercase to match
-- reality" correction; this one was missed.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_scan_samples (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  supplier_id TEXT,
  supplierhint TEXT,
  docidentifier TEXT,
  doctype TEXT,
  corrected_json TEXT,
  rawjson TEXT,
  is_gold INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT
);

-- ----------------------------------------------------------------------------
-- WIP cascade idempotency log (src/api/routes/production-orders.ts)
-- org_id is TEXT to match migration 0049's tenant scope; the ALTER flips any
-- existing-with-UUID table to TEXT in place (idempotent — no-op when TEXT).
-- The unique indexes are PARTIAL because Postgres treats NULL from_status as
-- distinct: one index for the common (from, to) pair, one for the initial
-- (NULL from_status) emission.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wip_cascade_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      TEXT NOT NULL,
  job_card_id TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  source      TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE wip_cascade_log
  ALTER COLUMN org_id TYPE TEXT USING org_id::text;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wip_cascade_log_transition
  ON wip_cascade_log (org_id, job_card_id, from_status, to_status)
  WHERE from_status IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wip_cascade_log_initial
  ON wip_cascade_log (org_id, job_card_id, to_status)
  WHERE from_status IS NULL;
CREATE INDEX IF NOT EXISTS idx_wip_cascade_log_jc
  ON wip_cascade_log (org_id, job_card_id, applied_at DESC);
