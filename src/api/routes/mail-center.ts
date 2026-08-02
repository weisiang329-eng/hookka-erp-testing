// ---------------------------------------------------------------------------
// Mail Center — in-ERP shared inbox for hookka.com email.
//
// Architecture (see the owner's decision 2026-06-16):
//   inbound : Cloudflare Email Routing → standalone email Worker → POST
//             /api/mail-center/inbound (secret-guarded, machine-to-machine,
//             registered BEFORE authMiddleware in worker.ts). That handler
//             calls ingestInboundEmail() below.
//   outbound: replies reuse the existing Brevo/Resend sender (lib/email.ts).
//             Added in P2.
//   storage : three tables created lazily here (no migration file yet) so
//             prod works the moment this route deploys.
//
// Deliberate isolation (owner is bug-averse): ALL SQL here is snake_case, so
// it passes through the camelCase→snake translator (supabase-compat) UNCHANGED
// and needs ZERO edits to the shared column-rename-map.json. Nothing this
// module does can affect any existing table.
//
// Tenancy: every row carries org_id (default 'hookka', matching migration
// 0049). Authenticated reads scope by getOrgId(c); the userless inbound path
// defaults to DEFAULT_ORG_ID.
// ---------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import type { Env } from "../worker";
import { requireSuperAdmin } from "../lib/rbac";
import { getOrgId, DEFAULT_ORG_ID } from "../lib/tenant";
import { sendMail } from "../lib/email";
import { validateMailAttachments } from "../lib/mail-attachments";
import {
  DEFAULT_BUCKET,
  putFile,
  signedDownloadUrl,
} from "../lib/supabase-storage";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Lazy schema. Module-level promise = one flight per isolate; per-statement
// try/catch so a benign "already exists" never poisons the cached promise.
// Same pattern as routes/three-pl-state-rates.ts.
// ---------------------------------------------------------------------------
let pendingSchema = false;
export async function ensureMailSchema(db: D1Database): Promise<void> {
  if (pendingSchema) return;

  const stmts = [
    // Our outward-facing addresses / aliases (support@, sales@, lim@ ...).
    // catch-all routing means mail to ANY of these already arrives; a row
    // here is the in-ERP record that maps an address to a person/dept.
    `CREATE TABLE IF NOT EXISTS email_addresses (
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
     )`,
    // Lazy idempotent add — the per-statement try/catch above swallows the
    // "duplicate column" error on isolates where this already ran, so it is
    // safe whether or not the column exists. Records the person's job title
    // alongside assigned_dept (owner 2026-06-17).
    `ALTER TABLE email_addresses ADD COLUMN IF NOT EXISTS assigned_position TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_addresses_org_addr
       ON email_addresses (org_id, address)`,
    // Mailbox access grants (the "mailbox matrix" — owner 2026-06-17). A user
    // always has their own assigned alias; these rows ADDITIONALLY grant
    // access to shared mailboxes (support@/hr@/finance@) so several people
    // can work one inbox. Managed from the User Management matrix.
    `CREATE TABLE IF NOT EXISTS email_address_access (
       id TEXT PRIMARY KEY,
       org_id TEXT NOT NULL DEFAULT 'hookka',
       address_id TEXT NOT NULL,
       user_id TEXT NOT NULL,
       created_at TEXT,
       created_by TEXT
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_access_addr_user
       ON email_address_access (org_id, address_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS ix_email_access_user
       ON email_address_access (org_id, user_id)`,
    // Hierarchical mail-visibility level per user (owner 2026-06-17). One row
    // per user setting how WIDE their inbox is: 'personal' (own assigned +
    // granted mailboxes — the default), 'department' (also every mailbox in
    // their dept), or 'company' (every active mailbox in the org). Absent row
    // ⇒ 'personal'. Managed by SUPER_ADMIN; folded into getMailScope below.
    `CREATE TABLE IF NOT EXISTS mail_user_scope (
       org_id TEXT NOT NULL DEFAULT 'hookka',
       user_id TEXT NOT NULL,
       level TEXT NOT NULL DEFAULT 'personal',
       created_at TEXT,
       PRIMARY KEY (org_id, user_id)
     )`,
    // One conversation with an external party, grouped by RFC threading.
    `CREATE TABLE IF NOT EXISTS email_threads (
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
     )`,
    // Email-client affordances that the frontend used to keep only in
    // localStorage (star / labels / trash). Lazy idempotent adds — the
    // per-statement try/catch swallows "duplicate column" on isolates where
    // this already ran. trashed_at is a soft-delete timestamp; like every
    // timestamp written here via new Date().toISOString() it MUST stay TEXT
    // (never timestamptz) so the SupabaseAdapter round-trips it unchanged.
    `ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS starred INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS labels TEXT`,
    `ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS trashed_at TEXT`,
    `CREATE INDEX IF NOT EXISTS ix_email_threads_org_box
       ON email_threads (org_id, mailbox_address, last_message_at)`,
    // Individual messages (both directions).
    `CREATE TABLE IF NOT EXISTS email_messages (
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
     )`,
    `CREATE INDEX IF NOT EXISTS ix_email_messages_thread
       ON email_messages (thread_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS ix_email_messages_msgid
       ON email_messages (message_id)`,
    // Inbound attachments (owner 2026-06-18 — "e-invoices/photos must show").
    // One row per file on an inbound email. The bytes live in Supabase Storage
    // (bucket hookka-files, same as file_assets) under storage_path; this row
    // is the index the detail view reads to render a download chip + thumbnail.
    // size_bytes is the byte count; content_id is the MIME Content-ID (for a
    // future v2 that inlines cid: images inside the HTML body). created_at is
    // written via new Date().toISOString() so it MUST stay TEXT (never
    // timestamptz) for the SupabaseAdapter to round-trip it unchanged — same
    // rule as every timestamp column above.
    `CREATE TABLE IF NOT EXISTS email_attachments (
       id TEXT PRIMARY KEY,
       org_id TEXT NOT NULL DEFAULT 'hookka',
       message_id TEXT NOT NULL,
       filename TEXT,
       content_type TEXT,
       size_bytes INTEGER,
       storage_path TEXT,
       content_id TEXT,
       created_at TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS ix_email_attachments_msg
       ON email_attachments (message_id)`,
    // Label registry (owner 2026-06-17 — "labels with colours like Gmail").
    // Thread labels themselves stay as a JSON name array on email_threads
    // (above); THIS table is the canonical name→colour catalogue so the
    // sidebar can render a coloured dot per label and offer a managed list.
    // Joined to thread labels by lower(name); a thread label with no catalogue
    // row just renders in the neutral brand tone. created_at is written via
    // new Date().toISOString() so it MUST stay TEXT (never timestamptz) for
    // the SupabaseAdapter to round-trip it unchanged — same rule as the
    // timestamp columns above.
    `CREATE TABLE IF NOT EXISTS email_labels (
       id TEXT PRIMARY KEY,
       org_id TEXT NOT NULL DEFAULT 'hookka',
       name TEXT NOT NULL,
       color TEXT,
       created_at TEXT,
       created_by TEXT
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_labels_org_name
       ON email_labels (org_id, name)`,
  ];
  for (const stmt of stmts) {
    try {
      await db.prepare(stmt).run();
    } catch (e) {
      console.error("[mail-center] schema init failed:", e);
    }
  }
  pendingSchema = true;
}

// ---------------------------------------------------------------------------
// Inbound ingestion — called by the worker.ts pre-auth handler.
// ---------------------------------------------------------------------------
// One inbound attachment as it arrives on the /inbound payload. The sync layer
// (mail-sync/sync.mjs + mail-inbound-worker) base64-encodes the raw bytes so the
// JSON POST stays credential-free; the ERP owns storage (uploads to Supabase
// Storage here). Oversized files are dropped at the sync layer (see the size
// caps there) so contentBase64 is always sane to decode in the Worker.
export interface InboundAttachmentPayload {
  filename?: string;
  contentType?: string;
  contentId?: string;
  contentBase64?: string;
}

export interface InboundEmailPayload {
  from?: string;
  fromName?: string;
  to?: string[] | string;
  cc?: string[] | string;
  subject?: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[] | string;
  date?: string;
  attachments?: InboundAttachmentPayload[];
}

export type IngestResult =
  | { ok: true; threadId: string; messageId: string; deduped?: boolean }
  | { ok: false; error: string };

function toArray(v: string[] | string | undefined | null): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  // RFC headers separate addresses with commas; References uses whitespace.
  return String(v)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeIso(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const t = Date.parse(input);
  if (Number.isNaN(t)) return fallback;
  return new Date(t).toISOString();
}

// Minimal env shape needed to upload attachment bytes to Supabase Storage.
// Kept optional end-to-end so an ingest with no storage credentials (e.g. an
// older deploy, or a unit test) still stores the message — attachments are just
// skipped, never fatal.
type StorageEnv = {
  SUPABASE_PROJECT_REF?: string;
  SUPABASE_SERVICE_KEY?: string;
};

// Decode standard base64 into raw bytes. Tolerant of base64url and stray
// whitespace/newlines (postal-mime hands clean base64, but the JSON transport
// may wrap it). Returns null on anything that doesn't decode so a single bad
// attachment never aborts the whole email.
function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const clean = b64.replace(/[\r\n\s]+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Sanitise a filename for use inside a storage object key: strip any path
// segments (no traversal), keep a readable ASCII-ish basename, and bound the
// length. Empty/garbage names fall back to a generic "file".
function safeFilename(name: string | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() || "";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned || "file";
}

// Persist the attachments for one freshly-stored (or backfilled) message:
// upload each file's bytes to Supabase Storage and INSERT an email_attachments
// row. Best-effort per attachment — a single failed upload/insert is logged and
// skipped so the rest of the email is unaffected. No-op when storage creds are
// absent or there are no attachments. storagePath scheme: mail/{messageId}/{n}-{safeFilename}.
async function storeAttachments(
  db: D1Database,
  env: StorageEnv | undefined,
  orgId: string,
  msgRowId: string,
  attachments: InboundAttachmentPayload[] | undefined,
): Promise<void> {
  if (!attachments || attachments.length === 0) return;
  if (!env?.SUPABASE_PROJECT_REF || !env?.SUPABASE_SERVICE_KEY) {
    console.warn(
      "[mail-center] attachments present but Supabase Storage not configured — skipping",
    );
    return;
  }
  const now = new Date().toISOString();
  let idx = 0;
  for (const att of attachments) {
    idx++;
    const bytes = base64ToBytes(att.contentBase64 ?? "");
    if (!bytes || bytes.length === 0) {
      console.warn(
        `[mail-center] attachment ${idx} on ${msgRowId} had no decodable content — skipping`,
      );
      continue;
    }
    const fname = safeFilename(att.filename);
    const contentType = (att.contentType || "application/octet-stream").slice(0, 200);
    // Prefix each file with its index so two same-named files on one email don't
    // collide on the same storage key.
    const storagePath = `mail/${msgRowId}/${idx}-${fname}`;
    try {
      await putFile(env, DEFAULT_BUCKET, storagePath, bytes, contentType);
      await db
        .prepare(
          `INSERT INTO email_attachments
             (id, org_id, message_id, filename, content_type, size_bytes,
              storage_path, content_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          orgId,
          msgRowId,
          att.filename ?? fname,
          contentType,
          bytes.length,
          storagePath,
          att.contentId ?? null,
          now,
        )
        .run();
    } catch (e) {
      console.error(
        `[mail-center] failed to store attachment ${idx} on ${msgRowId}:`,
        e,
      );
    }
  }
}

export async function ingestInboundEmail(
  db: D1Database,
  payload: InboundEmailPayload,
  // Optional storage env. When present (and the message carries attachments)
  // the bytes are uploaded to Supabase Storage and indexed in email_attachments.
  // Absent ⇒ attachments are silently skipped — the message itself still stores.
  env?: StorageEnv,
): Promise<IngestResult> {
  await ensureMailSchema(db);

  const orgId = DEFAULT_ORG_ID;
  const from = (payload.from || "").trim();
  if (!from) return { ok: false, error: "missing from address" };

  const to = toArray(payload.to);
  const cc = toArray(payload.cc);
  const recipients = [...to, ...cc];

  // Which of OUR addresses did this hit? Prefer an explicit email_addresses
  // match, else the first @hookka.com recipient, else just the first to:.
  let mailbox = "";
  for (const r of recipients) {
    const hit = await db
      .prepare(
        `SELECT address FROM email_addresses WHERE org_id = ? AND lower(address) = lower(?) LIMIT 1`,
      )
      .bind(orgId, r)
      .first<{ address: string }>();
    if (hit?.address) {
      mailbox = hit.address;
      break;
    }
  }
  if (!mailbox) {
    mailbox = recipients.find((r) => /@hookka\.com$/i.test(r)) || recipients[0] || "";
  }

  const now = new Date().toISOString();
  const sentAt = safeIso(payload.date, now);
  const subject = (payload.subject || "(no subject)").slice(0, 500);
  const snippet = (payload.text || stripHtml(payload.html || "") || "")
    .trim()
    .slice(0, 240);

  // Idempotency — the email worker may retry. Skip if we already stored this
  // Message-ID. BUT: if the existing message has NO attachments yet and this
  // (re)delivery carries some, backfill them onto the already-ingested message.
  // This is what lets a re-run of the sync (with the new attachments-capable
  // payload) add attachments to emails that were first ingested before this
  // feature existed — see the "re-backfill" note in the PR description.
  if (payload.messageId) {
    const dup = await db
      .prepare(
        `SELECT id, thread_id FROM email_messages WHERE org_id = ? AND message_id = ? LIMIT 1`,
      )
      .bind(orgId, payload.messageId)
      // The pg driver camelCases result columns (db-pg.ts transform.column.from),
      // so thread_id arrives as threadId. Dual-read so dedupe returns the real
      // threadId instead of undefined on a retry.
      .first<{ id: string; threadId?: string; thread_id?: string }>();
    if (dup?.id) {
      // Backfill attachments onto an existing message that has none yet.
      if (payload.attachments && payload.attachments.length > 0) {
        const existing = await db
          .prepare(
            `SELECT COUNT(*) AS n FROM email_attachments WHERE org_id = ? AND message_id = ?`,
          )
          .bind(orgId, dup.id)
          // Aggregate alias `n` round-trips unchanged, but a COUNT(*) without an
          // alias can come back as different keys across engines; read defensively.
          .first<{ n?: number | string; count?: number | string }>();
        const have = Number(existing?.n ?? existing?.count ?? 0);
        if (have === 0) {
          await storeAttachments(
            db,
            env,
            orgId,
            dup.id,
            payload.attachments,
          );
        }
      }
      return {
        ok: true,
        threadId: dup.threadId ?? dup.thread_id ?? "",
        messageId: dup.id,
        deduped: true,
      };
    }
  }

  // Thread resolution: follow In-Reply-To / References back to an existing
  // message's thread. Otherwise start a new thread.
  let threadId = "";
  const refs = [payload.inReplyTo, ...toArray(payload.references)].filter(
    Boolean,
  ) as string[];
  if (refs.length) {
    const placeholders = refs.map(() => "?").join(", ");
    const ref = await db
      .prepare(
        `SELECT thread_id FROM email_messages WHERE org_id = ? AND message_id IN (${placeholders}) LIMIT 1`,
      )
      .bind(orgId, ...refs)
      // Result columns come back camelCase (db-pg.ts transform.column.from), so
      // thread_id → threadId. Reading the snake key returned undefined → every
      // reply started a NEW thread instead of joining the referenced one.
      .first<{ threadId?: string; thread_id?: string }>();
    const refThreadId = ref?.threadId ?? ref?.thread_id;
    if (refThreadId) threadId = refThreadId;
  }

  if (!threadId) {
    threadId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO email_threads
           (id, org_id, mailbox_address, subject, counterparty_email,
            counterparty_name, status, last_message_at, last_direction,
            last_snippet, message_count, unread, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 'inbound', ?, 1, 1, ?)`,
      )
      .bind(
        threadId,
        orgId,
        mailbox,
        subject,
        from,
        payload.fromName ?? null,
        sentAt,
        snippet,
        now,
      )
      .run();
  } else {
    // Re-open a closed thread when a new inbound message lands.
    await db
      .prepare(
        `UPDATE email_threads
            SET last_message_at = ?, last_direction = 'inbound',
                last_snippet = ?, message_count = message_count + 1,
                unread = 1,
                status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
          WHERE id = ?`,
      )
      .bind(sentAt, snippet, threadId)
      .run();
  }

  const msgId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO email_messages
         (id, org_id, thread_id, direction, message_id, in_reply_to,
          reference_ids, from_address, from_name, to_addresses, cc_addresses,
          subject, text_body, html_body, sent_at, received_at, created_at)
       VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      msgId,
      orgId,
      threadId,
      payload.messageId ?? null,
      payload.inReplyTo ?? null,
      toArray(payload.references).join(" ") || null,
      from,
      payload.fromName ?? null,
      JSON.stringify(to),
      cc.length ? JSON.stringify(cc) : null,
      subject,
      payload.text ?? null,
      payload.html ?? null,
      sentAt,
      now,
      now,
    )
    .run();

  // Upload + index any attachments for this newly-stored message. Best-effort:
  // a storage failure is logged inside and never fails the ingest (the message
  // is already persisted).
  await storeAttachments(db, env, orgId, msgId, payload.attachments);

  return { ok: true, threadId, messageId: msgId };
}

// ---------------------------------------------------------------------------
// Row → API shape mappers (snake_case DB → camelCase API).
// ---------------------------------------------------------------------------
type ThreadRow = {
  id: string;
  mailbox_address: string | null;
  subject: string | null;
  counterparty_email: string | null;
  counterparty_name: string | null;
  status: string;
  assigned_to_user_id: string | null;
  assigned_to_name: string | null;
  last_message_at: string | null;
  last_direction: string | null;
  last_snippet: string | null;
  message_count: number | string | null;
  unread: number | boolean | null;
  starred: number | boolean | null;
  labels: string | null;
  trashed_at: string | null;
  created_at: string | null;
  // The pg driver camelCases EVERY result column (db-pg.ts transform.column.from
  // — rename-map lookup, else postgres.toCamel), so every multi-word snake read
  // below arrives camelCased and the snake key is undefined. Dual-read like
  // rowToAddress: camelCase first, snake kept as a fallback in case a column
  // isn't in the rename map. Same root cause as the View-level / alias bug
  // (owner 2026-06-17). Mail receive is not live yet, but this keeps the inbox
  // correct when it is — without these, the Sent folder is永远空 (has_outbound)
  // and Trash is inert (trashed_at).
  mailboxAddress?: string | null;
  counterpartyEmail?: string | null;
  counterpartyName?: string | null;
  assignedToUserId?: string | null;
  assignedToName?: string | null;
  lastMessageAt?: string | null;
  lastDirection?: string | null;
  lastSnippet?: string | null;
  messageCount?: number | string | null;
  trashedAt?: string | null;
  createdAt?: string | null;
  // Computed (not a column): EXISTS roll-up of any outbound message, so the
  // frontend's Sent folder is accurate instead of relying on last_direction.
  // The SQL alias `has_outbound` isn't in the rename map, so postgres.toCamel
  // turns it into `hasOutbound` — dual-read both.
  has_outbound?: number | boolean | null;
  hasOutbound?: number | boolean | null;
};

function rowToThread(r: ThreadRow) {
  return {
    id: r.id,
    mailboxAddress: r.mailboxAddress ?? r.mailbox_address ?? "",
    subject: r.subject ?? "(no subject)",
    counterpartyEmail: r.counterpartyEmail ?? r.counterparty_email ?? "",
    counterpartyName: r.counterpartyName ?? r.counterparty_name ?? "",
    status: r.status,
    assignedToUserId: r.assignedToUserId ?? r.assigned_to_user_id ?? undefined,
    assignedToName: r.assignedToName ?? r.assigned_to_name ?? undefined,
    lastMessageAt: r.lastMessageAt ?? r.last_message_at ?? "",
    lastDirection: r.lastDirection ?? r.last_direction ?? "inbound",
    lastSnippet: r.lastSnippet ?? r.last_snippet ?? "",
    messageCount: Number(r.messageCount ?? r.message_count ?? 0),
    unread: Number(r.unread ?? 0) === 1,
    starred: Number(r.starred ?? 0) === 1,
    labels: parseJsonArray(r.labels),
    trashedAt: r.trashedAt ?? r.trashed_at ?? null,
    hasOutbound: Number(r.hasOutbound ?? r.has_outbound ?? 0) === 1,
    createdAt: r.createdAt ?? r.created_at ?? "",
  };
}

type MessageRow = {
  id: string;
  thread_id: string;
  direction: string;
  message_id: string | null;
  in_reply_to: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  sent_at: string | null;
  received_at: string | null;
  sent_by_user_id: string | null;
  sent_by_name: string | null;
  created_at: string | null;
  // The pg driver camelCases EVERY result column (db-pg.ts transform.column.from),
  // so the snake reads above arrive camelCased and the snake key is undefined.
  // Without dual-reads the detail view shows EMPTY messages. Dual-read like
  // rowToAddress: camelCase first, snake kept as a fallback.
  threadId?: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  fromAddress?: string | null;
  fromName?: string | null;
  toAddresses?: string | null;
  ccAddresses?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  sentByUserId?: string | null;
  sentByName?: string | null;
  createdAt?: string | null;
};

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowToMessage(r: MessageRow) {
  return {
    id: r.id,
    threadId: r.threadId ?? r.thread_id,
    direction: r.direction,
    messageId: r.messageId ?? r.message_id ?? undefined,
    inReplyTo: r.inReplyTo ?? r.in_reply_to ?? undefined,
    fromAddress: r.fromAddress ?? r.from_address ?? "",
    fromName: r.fromName ?? r.from_name ?? "",
    toAddresses: parseJsonArray(r.toAddresses ?? r.to_addresses),
    ccAddresses: parseJsonArray(r.ccAddresses ?? r.cc_addresses),
    subject: r.subject ?? "",
    textBody: r.textBody ?? r.text_body ?? "",
    htmlBody: r.htmlBody ?? r.html_body ?? "",
    sentAt: r.sentAt ?? r.sent_at ?? "",
    receivedAt: r.receivedAt ?? r.received_at ?? "",
    sentByUserId: r.sentByUserId ?? r.sent_by_user_id ?? undefined,
    sentByName: r.sentByName ?? r.sent_by_name ?? undefined,
    createdAt: r.createdAt ?? r.created_at ?? "",
  };
}

// Attachment row → API shape. The pg driver hands every column back camelCased
// (db-pg.ts transform.column.from), so content_type→contentType,
// size_bytes→sizeBytes, storage_path→storagePath, content_id→contentId. Dual-read
// the snake key as a fallback (same class of bug as rowToAddress) so an
// attachment never renders with empty metadata. `url` is NOT a column — it's a
// short-lived signed Storage URL stamped in by the /threads/:id handler.
type AttachmentRow = {
  id: string;
  filename: string | null;
  contentType?: string | null;
  content_type?: string | null;
  sizeBytes?: number | string | null;
  size_bytes?: number | string | null;
  storagePath?: string | null;
  storage_path?: string | null;
  contentId?: string | null;
  content_id?: string | null;
  messageId?: string | null;
  message_id?: string | null;
};

// Attachment row → API shape served on each message. `url` is the short-lived
// signed Storage URL (or null when signing failed). Dual-read every snake key.
function attachmentToApi(r: AttachmentRow, url: string | null) {
  return {
    id: r.id,
    filename: r.filename ?? "file",
    contentType: r.contentType ?? r.content_type ?? "application/octet-stream",
    sizeBytes: Number(r.sizeBytes ?? r.size_bytes ?? 0),
    contentId: r.contentId ?? r.content_id ?? undefined,
    url,
  };
}

// The pg driver (db-pg.ts transform.column.from) hands result columns back in
// camelCase, so `assigned_user_id` arrives as `assignedUserId`. Reading the
// snake_case key returned undefined → GET /addresses dropped EVERY alias's
// owner/dept/position → the User Mgmt grid couldn't show a claimed alias and the
// shared-mailbox column filter never excluded personal aliases (owner "Claiming
// existing 没有反应", 2026-06-17 — same class of bug as /scope-levels). Read
// camelCase, with the snake key kept as a fallback in case a column isn't in the
// rename map.
type AddressRow = {
  id: string;
  address: string;
  label: string | null;
  assignedUserId?: string | null;
  assigned_user_id?: string | null;
  assignedUserName?: string | null;
  assigned_user_name?: string | null;
  assignedDept?: string | null;
  assigned_dept?: string | null;
  assignedPosition?: string | null;
  assigned_position?: string | null;
  active: number | boolean | null;
  createdAt?: string | null;
  created_at?: string | null;
};

function rowToAddress(r: AddressRow) {
  return {
    id: r.id,
    address: r.address,
    label: r.label ?? "",
    assignedUserId: r.assignedUserId ?? r.assigned_user_id ?? undefined,
    assignedUserName: r.assignedUserName ?? r.assigned_user_name ?? undefined,
    assignedDept: r.assignedDept ?? r.assigned_dept ?? undefined,
    assignedPosition: r.assignedPosition ?? r.assigned_position ?? undefined,
    active: Number(r.active ?? 0) === 1,
    createdAt: r.createdAt ?? r.created_at ?? "",
  };
}

// Label catalogue row → API shape. Like every other read here the pg driver
// hands generic columns back camelCased (created_at→createdAt), so dual-read
// the snake key as a fallback (same class of bug as rowToAddress).
type LabelRow = {
  id: string;
  name: string;
  color: string | null;
  createdAt?: string | null;
  created_at?: string | null;
};

function rowToLabel(r: LabelRow) {
  return {
    id: r.id,
    name: r.name,
    color: r.color ?? "",
    createdAt: r.createdAt ?? r.created_at ?? "",
  };
}

// ---------------------------------------------------------------------------
// Hierarchical mailbox visibility (owner 2026-06-17). SUPER_ADMIN always sees
// every thread/address in the org. Every other authenticated user has a
// VISIBILITY LEVEL stored in mail_user_scope (default 'personal'):
//   • 'personal'   — own assigned alias(es) + any shared mailbox granted via
//                    email_address_access. (The original behaviour.)
//   • 'department' — the personal set PLUS every active mailbox whose
//                    assigned_dept matches the caller's own dept. If the caller
//                    has no dept on file, this falls back to 'personal'.
//   • 'company'    — every active mailbox in the org.
// Inherently scoped to the caller, so it needs no mail-center:* RBAC grant
// (which was never seeded). The returned `level` lets callers/the UI reflect
// the effective scope; isAdmin/userId/addresses are unchanged for callers.
// ---------------------------------------------------------------------------
const MAIL_SCOPE_LEVELS = ["personal", "department", "company"] as const;
type MailScopeLevel = (typeof MAIL_SCOPE_LEVELS)[number];

async function getMailScope(
  c: Context<Env>,
  orgId: string,
): Promise<{
  isAdmin: boolean;
  userId: string;
  addresses: string[];
  level: string;
}> {
  const get = (c as unknown as { get: (k: string) => string | undefined }).get;
  const role = get("userRole")?.toUpperCase();
  const userId = get("userId") ?? "";
  if (role === "SUPER_ADMIN")
    return { isAdmin: true, userId, addresses: [], level: "company" };
  if (!userId)
    return { isAdmin: false, userId: "", addresses: [], level: "personal" };

  // Effective visibility level for this user (default 'personal' when no row).
  const levelRow = await c.var.DB.prepare(
    `SELECT level FROM mail_user_scope WHERE org_id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(orgId, userId)
    .first<{ level: string | null }>();
  let level: MailScopeLevel = (MAIL_SCOPE_LEVELS as readonly string[]).includes(
    levelRow?.level ?? "",
  )
    ? (levelRow!.level as MailScopeLevel)
    : "personal";

  // 'company' — every active mailbox in the org.
  if (level === "company") {
    const all = await c.var.DB.prepare(
      `SELECT address FROM email_addresses WHERE org_id = ? AND active = 1`,
    )
      .bind(orgId)
      .all<{ address: string }>();
    return {
      isAdmin: false,
      userId,
      addresses: dedupeLower((all.results ?? []).map((r) => r.address)),
      level,
    };
  }

  // The 'personal' base set: own assigned alias(es) PLUS any shared mailbox
  // granted via the mailbox-access matrix (email_address_access).
  const own = await c.var.DB.prepare(
    `SELECT address FROM email_addresses
       WHERE org_id = ? AND active = 1 AND (
         assigned_user_id = ?
         OR id IN (SELECT address_id FROM email_address_access
                     WHERE org_id = ? AND user_id = ?)
       )`,
  )
    .bind(orgId, userId, orgId, userId)
    .all<{ address: string }>();
  const addresses = (own.results ?? []).map((r) => r.address);

  // 'department' — additionally every active mailbox in the caller's own dept.
  // The caller's dept is read from their own assigned address row; no dept on
  // file ⇒ fall back to the personal set.
  if (level === "department") {
    const deptRow = await c.var.DB.prepare(
      `SELECT assigned_dept FROM email_addresses
         WHERE org_id = ? AND assigned_user_id = ?
           AND assigned_dept IS NOT NULL AND assigned_dept <> '' LIMIT 1`,
    )
      .bind(orgId, userId)
      // The pg driver camelCases result columns (db-pg.ts transform.column.from),
      // so assigned_dept arrives as assignedDept. Reading the snake key returned
      // undefined → the 'department' visibility level silently degraded to
      // 'personal' (owner 2026-06-17, same class as /scope-levels). Dual-read.
      .first<{ assignedDept?: string | null; assigned_dept?: string | null }>();
    const dept = (deptRow?.assignedDept ?? deptRow?.assigned_dept ?? "").trim();
    if (dept) {
      const deptRows = await c.var.DB.prepare(
        `SELECT address FROM email_addresses
           WHERE org_id = ? AND active = 1 AND assigned_dept = ?`,
      )
        .bind(orgId, dept)
        .all<{ address: string }>();
      addresses.push(...(deptRows.results ?? []).map((r) => r.address));
    } else {
      // No dept ⇒ effective level is personal.
      level = "personal";
    }
  }

  return {
    isAdmin: false,
    userId,
    addresses: dedupeLower(addresses),
    level,
  };
}

// Lowercase + de-duplicate an address list (order-preserving).
function dedupeLower(addrs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    const lc = (a ?? "").toLowerCase();
    if (!lc || seen.has(lc)) continue;
    seen.add(lc);
    out.push(lc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authenticated read endpoints (mounted at /api/mail-center, AFTER auth).
// Per-user scoped via getMailScope — every logged-in user reads THEIR OWN
// mailbox; SUPER_ADMIN reads all. (No requireSuperAdmin gate on reads/reply.)
// ---------------------------------------------------------------------------

// GET /api/mail-center/threads?mailbox=&status=&q=
app.get("/threads", async (c) => {
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const scope = await getMailScope(c, orgId);
  // A non-admin with no assigned address has no mailbox → sees nothing.
  if (!scope.isAdmin && scope.addresses.length === 0) return c.json([]);

  const mailbox = c.req.query("mailbox");
  const status = c.req.query("status");
  const q = c.req.query("q");
  const starredOnly = c.req.query("starred") === "1";

  const where: string[] = ["org_id = ?"];
  const binds: (string | number)[] = [orgId];
  // Per-user scope: non-admins only see threads on their own address(es).
  if (!scope.isAdmin) {
    const ph = scope.addresses.map(() => "?").join(", ");
    where.push(`LOWER(mailbox_address) IN (${ph})`);
    binds.push(...scope.addresses);
  }
  if (mailbox) {
    where.push("mailbox_address = ?");
    binds.push(mailbox);
  }
  // Trash is its own folder: status=trashed returns ONLY soft-deleted rows;
  // every other view (open/closed/all/inbox) EXCLUDES them.
  if (status === "trashed") {
    where.push("trashed_at IS NOT NULL");
  } else {
    where.push("trashed_at IS NULL");
    if (status) {
      where.push("status = ?");
      binds.push(status);
    }
  }
  if (starredOnly) {
    where.push("starred = 1");
  }
  if (q) {
    where.push(
      "(LOWER(subject) LIKE ? OR LOWER(counterparty_email) LIKE ? OR LOWER(last_snippet) LIKE ?)",
    );
    const like = `%${q.toLowerCase()}%`;
    binds.push(like, like, like);
  }

  // has_outbound: accurate Sent flag — does this thread have ANY outbound
  // message? Computed per row so the frontend's Sent folder is correct
  // instead of relying on the last_direction proxy.
  const sql =
    `SELECT t.*,
       EXISTS (
         SELECT 1 FROM email_messages m
          WHERE m.thread_id = t.id AND m.direction = 'outbound'
       ) AS has_outbound
       FROM email_threads t WHERE ${where.join(" AND ")}` +
    " ORDER BY t.last_message_at DESC NULLS LAST LIMIT 300";
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<ThreadRow>();
  return c.json((res.results ?? []).map(rowToThread));
});

// GET /api/mail-center/threads/:id — thread + its messages (marks read).
app.get("/threads/:id", async (c) => {
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  const scope = await getMailScope(c, orgId);

  const thread = await c.var.DB.prepare(
    `SELECT * FROM email_threads WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  // Per-user scope: a non-admin can only open a thread on their own address.
  // Dual-read mailbox_address — the pg driver hands it back as mailboxAddress,
  // so the snake key is undefined and a non-admin owner was wrongly 404'd.
  if (
    !scope.isAdmin &&
    !scope.addresses.includes(
      (thread.mailboxAddress ?? thread.mailbox_address ?? "").toLowerCase(),
    )
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const msgs = await c.var.DB.prepare(
    `SELECT * FROM email_messages WHERE org_id = ? AND thread_id = ? ORDER BY created_at ASC`,
  )
    .bind(orgId, id)
    .all<MessageRow>();
  const mappedMsgs = (msgs.results ?? []).map(rowToMessage);

  // Attachments — load every attachment for THIS thread's messages, then stamp
  // a short-lived SIGNED Storage URL onto each and group them under their
  // message. The service key never reaches the client; only the time-boxed
  // signed URL does (mirrors files.ts download). A signing failure on one file
  // just drops its url (the chip still shows but can't open) rather than failing
  // the whole read.
  const attByMsg = new Map<string, ReturnType<typeof attachmentToApi>[]>();
  try {
    const msgIds = mappedMsgs.map((m) => m.id);
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => "?").join(", ");
      const attRows = await c.var.DB.prepare(
        `SELECT * FROM email_attachments
           WHERE org_id = ? AND message_id IN (${ph})
           ORDER BY created_at ASC`,
      )
        .bind(orgId, ...msgIds)
        .all<AttachmentRow>();
      for (const r of attRows.results ?? []) {
        const storagePath = r.storagePath ?? r.storage_path ?? "";
        const msgKey = r.messageId ?? r.message_id ?? "";
        if (!storagePath || !msgKey) continue;
        // 10-minute TTL — long enough to click through to a download/preview,
        // short enough that a leaked URL is harmless (same rationale as files.ts).
        const url = await signedDownloadUrl(
          c.env,
          DEFAULT_BUCKET,
          storagePath,
          600,
        );
        const item = attachmentToApi(r, url);
        const list = attByMsg.get(msgKey) ?? [];
        list.push(item);
        attByMsg.set(msgKey, list);
      }
    }
  } catch (e) {
    // Attachments are an enhancement — never let a storage/signing blip 500 the
    // whole thread read. Messages render without their chips in that case.
    console.error("[mail-center] loading attachments failed:", e);
  }

  // Clear the unread flag on open.
  try {
    await c.var.DB.prepare(`UPDATE email_threads SET unread = 0 WHERE id = ?`)
      .bind(id)
      .run();
  } catch {
    /* read view must not fail if the mark-read write blips */
  }

  return c.json({
    thread: rowToThread(thread),
    messages: mappedMsgs.map((m) => ({
      ...m,
      attachments: attByMsg.get(m.id) ?? [],
    })),
  });
});

// ---------------------------------------------------------------------------
// Auto-sent system emails (outbox_emails) — the durable customer-notification
// outbox that the DO-dispatch / Invoice / CN / PO / invite flows enqueue and
// the cron drains (lib/email-outbox.ts). The owner needs visibility into these:
// they go out from noreply@ so there is no human "Sent" copy to look at — Wei
// Siang 2026-06-24 "因為是 noreply 所以看到不到". Read-only; org-scoped; visible to
// any Mail Center user (SUPER_ADMIN, or a user with a mailbox in scope).
//
// outbox_emails columns are snake_case and NOT in column-rename-map.json, so we
// alias them to camelCase right here — the SAME pattern the drain uses
// (processOutbox in lib/email-outbox.ts) — rather than relying on the generic
// snake→camel result transform.
// ---------------------------------------------------------------------------
type OutboxReadRow = {
  id: string;
  toAddress: string | null;
  subject: string | null;
  status: string | null;
  attempts: number | string | null;
  lastError: string | null;
  lastAttemptAt?: string | null;
  sentAt: string | null;
  createdAt: string | null;
  attachmentsJson: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
};

// attachments_json → filenames ONLY. The base64 blobs never ship to the client
// (the list/detail are about visibility, not re-download). Bad/legacy JSON
// degrades to [] — never throw on a read path.
function outboxAttachmentNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((a) => String((a as { filename?: string })?.filename || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const OUTBOX_STATUSES = ["PENDING", "RETRYING", "SENDING", "SENT", "FAILED"];

// GET /api/mail-center/outbox?status=&q=&limit=&offset= — the org's auto-sent
// log (newest first). Returns metadata + a snippet + attachment NAMES; the full
// body comes from GET /outbox/:id. Also returns a status roll-up over the WHOLE
// org log so the panel header can flag failures.
app.get("/outbox", async (c) => {
  const orgId = getOrgId(c);
  const scope = await getMailScope(c, orgId);
  const empty = { rows: [], counts: { sent: 0, failed: 0, pending: 0 }, hasMore: false };
  if (!scope.isAdmin && scope.addresses.length === 0) return c.json(empty);
  c.header("Cache-Control", "no-store");

  const status = (c.req.query("status") || "").trim().toUpperCase();
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") || "60", 10) || 60, 1),
    200,
  );
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);

  try {
    const where: string[] = ["org_id = ?"];
    const binds: (string | number)[] = [orgId];
    if (status && OUTBOX_STATUSES.includes(status)) {
      where.push("status = ?");
      binds.push(status);
    }
    if (q) {
      where.push("(LOWER(to_address) LIKE ? OR LOWER(subject) LIKE ?)");
      const like = `%${q}%`;
      binds.push(like, like);
    }
    const whereSql = where.join(" AND ");

    const res = await c.var.DB.prepare(
      `SELECT id,
              to_address       AS "toAddress",
              subject,
              status,
              attempts,
              last_error       AS "lastError",
              sent_at          AS "sentAt",
              created_at       AS "createdAt",
              attachments_json AS "attachmentsJson",
              body_text        AS "bodyText",
              body_html        AS "bodyHtml"
         FROM outbox_emails
        WHERE ${whereSql}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<OutboxReadRow>();

    const rows = (res.results ?? []).map((r) => ({
      id: r.id,
      toAddress: r.toAddress ?? "",
      subject: r.subject ?? "(no subject)",
      status: (r.status ?? "PENDING").toUpperCase(),
      attempts: Number(r.attempts ?? 0),
      lastError: r.lastError ?? null,
      sentAt: r.sentAt ?? null,
      createdAt: r.createdAt ?? "",
      snippet: (
        (r.bodyText && r.bodyText.trim()) ||
        (r.bodyHtml ? stripHtml(r.bodyHtml) : "")
      ).slice(0, 200),
      attachmentNames: outboxAttachmentNames(r.attachmentsJson),
    }));

    // Status roll-up over the WHOLE org log (not just this page) so the header
    // can show sent / failed / pending totals and surface any failures.
    const counts = { sent: 0, failed: 0, pending: 0 };
    const countRes = await c.var.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM outbox_emails WHERE org_id = ? GROUP BY status`,
    )
      .bind(orgId)
      .all<{ status: string; n: number | string }>();
    for (const row of countRes.results ?? []) {
      const s = String(row.status || "").toUpperCase();
      const n = Number(row.n ?? 0);
      if (s === "SENT") counts.sent += n;
      else if (s === "FAILED") counts.failed += n;
      else counts.pending += n; // PENDING / RETRYING / SENDING
    }

    return c.json({ rows, counts, hasMore: rows.length === limit });
  } catch (e) {
    // outbox_emails may be absent on a very old deploy — degrade to empty
    // rather than 500 the Mail Center.
    console.error("[mail-center] outbox read failed:", e);
    return c.json(empty);
  }
});

// GET /api/mail-center/outbox/:id — one auto-sent email incl. the full body
// (HTML + text) for the reading pane. Attachment NAMES only (no base64 blobs).
app.get("/outbox/:id", async (c) => {
  const orgId = getOrgId(c);
  const scope = await getMailScope(c, orgId);
  if (!scope.isAdmin && scope.addresses.length === 0) {
    return c.json({ error: "not found" }, 404);
  }
  const id = c.req.param("id");
  try {
    const r = await c.var.DB.prepare(
      `SELECT id,
              to_address       AS "toAddress",
              subject,
              status,
              attempts,
              last_error       AS "lastError",
              last_attempt_at  AS "lastAttemptAt",
              sent_at          AS "sentAt",
              created_at       AS "createdAt",
              attachments_json AS "attachmentsJson",
              body_text        AS "bodyText",
              body_html        AS "bodyHtml"
         FROM outbox_emails
        WHERE org_id = ? AND id = ? LIMIT 1`,
    )
      .bind(orgId, id)
      .first<OutboxReadRow>();
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({
      id: r.id,
      toAddress: r.toAddress ?? "",
      subject: r.subject ?? "(no subject)",
      status: (r.status ?? "PENDING").toUpperCase(),
      attempts: Number(r.attempts ?? 0),
      lastError: r.lastError ?? null,
      lastAttemptAt: r.lastAttemptAt ?? null,
      sentAt: r.sentAt ?? null,
      createdAt: r.createdAt ?? "",
      bodyText: r.bodyText ?? "",
      bodyHtml: r.bodyHtml ?? "",
      attachmentNames: outboxAttachmentNames(r.attachmentsJson),
    });
  } catch (e) {
    console.error("[mail-center] outbox detail read failed:", e);
    return c.json({ error: "not found" }, 404);
  }
});

// GET /api/mail-center/outbox/:id/attachments/:idx/download — stream ONE
// stored attachment back as a binary download. The base64 blob lives in
// outbox_emails.attachments_json (see EnqueueEmailArgs.attachments). Owner
// asked for proof of what was actually sent — the existing detail endpoint
// returns names only; this endpoint returns the actual bytes. Scope follows
// the same admin/own-mailbox gate as the rest of the outbox views.
app.get("/outbox/:id/attachments/:idx/download", async (c) => {
  const orgId = getOrgId(c);
  const scope = await getMailScope(c, orgId);
  if (!scope.isAdmin && scope.addresses.length === 0) {
    return c.json({ error: "not found" }, 404);
  }
  const id = c.req.param("id");
  const idx = Number.parseInt(c.req.param("idx") ?? "", 10);
  if (!Number.isFinite(idx) || idx < 0) {
    return c.json({ error: "invalid idx" }, 400);
  }
  try {
    const r = await c.var.DB.prepare(
      `SELECT attachments_json AS "attachmentsJson"
         FROM outbox_emails
        WHERE org_id = ? AND id = ? LIMIT 1`,
    )
      .bind(orgId, id)
      .first<{ attachmentsJson: string | null }>();
    if (!r?.attachmentsJson) return c.json({ error: "not found" }, 404);
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.attachmentsJson);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    if (!Array.isArray(parsed) || idx >= parsed.length) {
      return c.json({ error: "not found" }, 404);
    }
    const att = parsed[idx] as {
      filename?: string;
      contentBase64?: string;
    };
    const filename = String(att?.filename || "attachment").replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    const b64 = String(att?.contentBase64 || "");
    if (!b64) return c.json({ error: "not found" }, 404);
    // Decode base64 to bytes. atob is built-in in Workers; chunk to stay
    // within the arg limit of String.fromCharCode for big PDFs.
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = filename.toLowerCase().split(".").pop();
    const mime =
      ext === "pdf"
        ? "application/pdf"
        : ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : "application/octet-stream";
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("[mail-center] outbox attachment download failed:", e);
    return c.json({ error: "not found" }, 404);
  }
});

// GET /api/mail-center/addresses — our @hookka.com addresses / aliases.
// The mailbox list MUST match the thread scope at every visibility level, so a
// non-admin gets exactly the rows whose lower(address) is in scope.addresses
// (own+granted for 'personal', +dept for 'department', all for 'company').
app.get("/addresses", async (c) => {
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  // no-store — the User Management matrix refetches this right after creating
  // or linking an alias; a cached copy would hide the just-made change.
  c.header("Cache-Control", "no-store");
  const scope = await getMailScope(c, orgId);
  if (scope.isAdmin) {
    const res = await c.var.DB.prepare(
      `SELECT * FROM email_addresses WHERE org_id = ? ORDER BY address ASC`,
    )
      .bind(orgId)
      .all<AddressRow>();
    return c.json((res.results ?? []).map(rowToAddress));
  }
  // A non-admin with an empty scope sees no mailboxes.
  if (scope.addresses.length === 0) return c.json([]);
  const ph = scope.addresses.map(() => "?").join(", ");
  const res = await c.var.DB.prepare(
    `SELECT * FROM email_addresses
       WHERE org_id = ? AND LOWER(address) IN (${ph})
       ORDER BY address ASC`,
  )
    .bind(orgId, ...scope.addresses)
    .all<AddressRow>();
  return c.json((res.results ?? []).map(rowToAddress));
});

// ---------------------------------------------------------------------------
// Label catalogue (owner 2026-06-17 — "labels with colours like Gmail"). The
// PER-THREAD label set stays a JSON name array on email_threads; THIS catalogue
// only adds a canonical name→colour mapping so the sidebar shows a coloured dot
// and offers a managed list. Reads are open to any authenticated mailbox user
// (the sidebar needs colours); create/edit/delete require a mailbox in scope —
// the SAME gate as labelling a thread — NOT requireSuperAdmin, since labels are
// an everyday triage affordance for whoever works a mailbox.
// ---------------------------------------------------------------------------

// A small curated palette (hex) the picker offers. Stored verbatim; an unknown
// value coming back from the DB is tolerated by the UI, but writes are clamped
// to this set so colours stay legible against the warm-neutral surfaces.
const LABEL_COLORS = [
  "#6B5C32", // brand brown (default)
  "#B45309", // amber-700
  "#15803D", // green-700
  "#0E7490", // cyan-700
  "#1D4ED8", // blue-700
  "#6D28D9", // violet-700
  "#BE185D", // pink-700
  "#B91C1C", // red-700
  "#475569", // slate-600
] as const;
const DEFAULT_LABEL_COLOR = LABEL_COLORS[0];

function normalizeColor(input: string | undefined | null): string {
  const v = (input ?? "").trim();
  if (!v) return DEFAULT_LABEL_COLOR;
  const up = v.toUpperCase();
  const hit = (LABEL_COLORS as readonly string[]).find(
    (c2) => c2.toUpperCase() === up,
  );
  return hit ?? DEFAULT_LABEL_COLOR;
}

// Whether the caller may manage the label catalogue: SUPER_ADMIN, or any user
// with at least one mailbox in scope (same bar as labelling a thread).
async function canManageLabels(
  c: Context<Env>,
  orgId: string,
): Promise<boolean> {
  const scope = await getMailScope(c, orgId);
  return scope.isAdmin || scope.addresses.length > 0;
}

// GET /api/mail-center/labels — the catalogue (name + colour), for the sidebar
// dots and the label menu. Open to any authenticated user in the org.
app.get("/labels", async (c) => {
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  c.header("Cache-Control", "no-store");
  const res = await c.var.DB.prepare(
    `SELECT * FROM email_labels WHERE org_id = ? ORDER BY name ASC`,
  )
    .bind(orgId)
    .all<LabelRow>();
  return c.json((res.results ?? []).map(rowToLabel));
});

// POST /api/mail-center/labels {name,color} — create a catalogue label. Name is
// unique per org (case-insensitive via the lowercased unique index); a repeat
// returns the existing row as a 200 so the picker is idempotent.
app.post("/labels", async (c) => {
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  if (!(await canManageLabels(c, orgId))) {
    return c.json({ error: "no mailbox in scope" }, 403);
  }
  const body = await c.req
    .json<{ name?: string; color?: string }>()
    .catch(() => ({}) as { name?: string; color?: string });
  const name = (body.name ?? "").trim().slice(0, 60);
  if (!name) return c.json({ error: "name is required" }, 400);
  const color = normalizeColor(body.color);

  // Pre-check (case-insensitive) so a repeat returns the existing row instead
  // of a 409 — the picker calls this freely when assigning a label by name.
  const existing = await c.var.DB.prepare(
    `SELECT * FROM email_labels WHERE org_id = ? AND lower(name) = lower(?) LIMIT 1`,
  )
    .bind(orgId, name)
    .first<LabelRow>();
  if (existing) return c.json(rowToLabel(existing));

  const id = crypto.randomUUID();
  const userId =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ??
    null;
  try {
    await c.var.DB.prepare(
      `INSERT INTO email_labels (id, org_id, name, color, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, orgId, name, color, new Date().toISOString(), userId)
      .run();
  } catch {
    // Unique (org_id, name) collision under a race — return whatever's there.
    const row = await c.var.DB.prepare(
      `SELECT * FROM email_labels WHERE org_id = ? AND lower(name) = lower(?) LIMIT 1`,
    )
      .bind(orgId, name)
      .first<LabelRow>();
    return c.json(row ? rowToLabel(row) : { id, name, color });
  }
  const row = await c.var.DB.prepare(
    `SELECT * FROM email_labels WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<LabelRow>();
  return c.json(row ? rowToLabel(row) : { id, name, color }, 201);
});

// PATCH /api/mail-center/labels/:id {name?,color?} — rename / recolour. A
// rename cascades to every thread carrying the OLD name so the per-thread JSON
// label arrays stay in sync with the catalogue.
app.patch("/labels/:id", async (c) => {
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  if (!(await canManageLabels(c, orgId))) {
    return c.json({ error: "no mailbox in scope" }, 403);
  }
  const id = c.req.param("id");
  const body = await c.req
    .json<{ name?: string; color?: string }>()
    .catch(() => ({}) as { name?: string; color?: string });

  const current = await c.var.DB.prepare(
    `SELECT * FROM email_labels WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<LabelRow>();
  if (!current) return c.json({ error: "label not found" }, 404);

  const sets: string[] = [];
  const binds: (string | null)[] = [];
  let renameFrom = "";
  let renameTo = "";
  if (body.name !== undefined) {
    const name = body.name.trim().slice(0, 60);
    if (!name) return c.json({ error: "name cannot be empty" }, 400);
    if (name.toLowerCase() !== current.name.toLowerCase()) {
      // Block a rename onto an existing label name (would merge ambiguously).
      const clash = await c.var.DB.prepare(
        `SELECT id FROM email_labels WHERE org_id = ? AND lower(name) = lower(?) AND id <> ? LIMIT 1`,
      )
        .bind(orgId, name, id)
        .first<{ id: string }>();
      if (clash) return c.json({ error: "a label with that name exists" }, 409);
      renameFrom = current.name;
      renameTo = name;
    }
    sets.push("name = ?");
    binds.push(name);
  }
  if (body.color !== undefined) {
    sets.push("color = ?");
    binds.push(normalizeColor(body.color));
  }
  if (sets.length === 0) return c.json({ error: "no fields to update" }, 400);

  await c.var.DB.prepare(
    `UPDATE email_labels SET ${sets.join(", ")} WHERE org_id = ? AND id = ?`,
  )
    .bind(...binds, orgId, id)
    .run();

  // Cascade the rename into the per-thread JSON label arrays. These are stored
  // as a JSON string of names; rewrite each affected thread's array in JS (the
  // set is small) so a renamed label keeps filtering + showing correctly.
  if (renameFrom && renameTo) {
    await renameThreadLabel(c, orgId, renameFrom, renameTo);
  }

  const row = await c.var.DB.prepare(
    `SELECT * FROM email_labels WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<LabelRow>();
  return c.json(row ? rowToLabel(row) : { id });
});

// DELETE /api/mail-center/labels/:id — remove a catalogue label and strip it
// from every thread that carried it (keeps the sidebar list and thread chips
// consistent — a deleted label shouldn't linger on threads).
app.delete("/labels/:id", async (c) => {
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  if (!(await canManageLabels(c, orgId))) {
    return c.json({ error: "no mailbox in scope" }, 403);
  }
  const id = c.req.param("id");
  const current = await c.var.DB.prepare(
    `SELECT * FROM email_labels WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<LabelRow>();
  if (!current) return c.json({ error: "label not found" }, 404);

  await c.var.DB.prepare(`DELETE FROM email_labels WHERE org_id = ? AND id = ?`)
    .bind(orgId, id)
    .run();
  // Strip the name from any thread carrying it (rename to "" = remove).
  await renameThreadLabel(c, orgId, current.name, "");
  return c.json({ ok: true });
});

// Rewrite one label name across every thread's JSON label array. renameTo=""
// REMOVES the label (delete path); otherwise it's renamed in place, de-duped
// case-insensitively. Scans only threads whose labels JSON mentions the old
// name (LIKE pre-filter), then rewrites each in JS — the per-thread arrays are
// tiny and the affected set is small, so this stays cheap.
async function renameThreadLabel(
  c: Context<Env>,
  orgId: string,
  from: string,
  to: string,
): Promise<void> {
  const like = `%${from}%`;
  const rows = await c.var.DB.prepare(
    `SELECT id, labels FROM email_threads
       WHERE org_id = ? AND labels IS NOT NULL AND labels LIKE ?`,
  )
    .bind(orgId, like)
    .all<{ id: string; labels: string | null }>();
  for (const r of rows.results ?? []) {
    const arr = parseJsonArray(r.labels);
    if (!arr.some((l) => l.toLowerCase() === from.toLowerCase())) continue;
    const next: string[] = [];
    for (const l of arr) {
      if (l.toLowerCase() === from.toLowerCase()) {
        if (to && !next.some((n) => n.toLowerCase() === to.toLowerCase())) {
          next.push(to);
        }
      } else if (!next.some((n) => n.toLowerCase() === l.toLowerCase())) {
        next.push(l);
      }
    }
    await c.var.DB.prepare(
      `UPDATE email_threads SET labels = ? WHERE org_id = ? AND id = ?`,
    )
      .bind(JSON.stringify(next), orgId, r.id)
      .run();
  }
}

// POST /api/mail-center/test-inject — admin-only: seed ONE sample inbound email
// so the owner can verify the inbox + reply UI BEFORE switching MX (zero infra,
// no secret needed — it calls ingestInboundEmail directly). The thread is a
// normal one and can be deleted later.
app.post("/test-inject", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  // Land it on a real configured address if one exists, else support@.
  const addr = await c.var.DB.prepare(
    `SELECT address FROM email_addresses WHERE org_id = ? AND active = 1 ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(orgId)
    .first<{ address: string }>();
  const mailbox = addr?.address || "support@hookka.com";
  const result = await ingestInboundEmail(c.var.DB, {
    from: "customer@example.com",
    fromName: "Test Customer",
    to: [mailbox],
    subject: "Test: can you make a 5ft bed frame?",
    text: "Hi, I'd like to order a 5ft bed frame. Could you let me know the price and lead time?\n\n(This is a test email — feel free to delete it.)\n\nThanks,\nTest Customer",
    messageId: `test-${crypto.randomUUID()}@example.com`,
    date: new Date().toISOString(),
  }, c.env);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Address admin endpoints — creating / managing someone's @hookka.com alias
// is an ACCOUNT-level action, so these are fenced with requireSuperAdmin (the
// same hard gate that protects user-account management in routes/users.ts),
// independent of any mail-center:* permission grant.
//
// NOTE: this creates an in-ERP ADDRESS RECORD for hookka.com mail received via
// Cloudflare Email Routing — it is NOT a Google/Gmail account. No Google API
// is touched here.
// ---------------------------------------------------------------------------

// Conservative single-@ email shape check. Intentionally not RFC-5322-complete
// — we only need to reject obvious garbage; the domain suffix is enforced
// separately below.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/mail-center/addresses — create an @hookka.com alias for a user.
app.post("/addresses", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);

  type CreateBody = {
    address?: string;
    label?: string;
    assignedUserId?: string;
    assignedUserName?: string;
    assignedDept?: string;
    assignedPosition?: string;
  };
  const body: CreateBody = await c.req
    .json<CreateBody>()
    .catch(() => ({} as CreateBody));

  const address = (body.address ?? "").trim().toLowerCase();
  if (!address || !EMAIL_RE.test(address)) {
    return c.json({ error: "invalid email address" }, 400);
  }
  if (!address.endsWith("@hookka.com")) {
    return c.json({ error: "address must end with @hookka.com" }, 400);
  }

  const userId =
    (c as unknown as { get: (k: string) => string | undefined }).get(
      "userId",
    ) ?? null;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await c.var.DB.prepare(
      `INSERT INTO email_addresses
         (id, org_id, address, label, assigned_user_id, assigned_user_name,
          assigned_dept, assigned_position, active, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        id,
        orgId,
        address,
        body.label?.trim() || null,
        body.assignedUserId ?? null,
        body.assignedUserName ?? null,
        body.assignedDept ?? null,
        body.assignedPosition?.trim() || null,
        now,
        userId,
      )
      .run();
  } catch (e) {
    // The (org_id, address) unique index collides when this alias already
    // exists. SQLite/D1 surfaces "UNIQUE constraint failed"; treat any insert
    // failure on an existing address as a 409 after confirming it's there.
    const existing = await c.var.DB.prepare(
      `SELECT * FROM email_addresses WHERE org_id = ? AND lower(address) = ? LIMIT 1`,
    )
      .bind(orgId, address)
      .first<AddressRow>();
    if (existing) {
      return c.json({ error: "address already exists" }, 409);
    }
    console.error("[mail-center] address insert failed:", e);
    return c.json({ error: "failed to create address" }, 500);
  }

  const row = await c.var.DB.prepare(
    `SELECT * FROM email_addresses WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<AddressRow>();
  return c.json(row ? rowToAddress(row) : { id, address }, 201);
});

// PATCH /api/mail-center/addresses/:id — toggle active / relabel / reassign.
app.patch("/addresses/:id", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");

  type PatchBody = {
    label?: string;
    assignedUserId?: string | null;
    assignedUserName?: string | null;
    assignedDept?: string | null;
    assignedPosition?: string | null;
    active?: boolean;
  };
  const body: PatchBody = await c.req
    .json<PatchBody>()
    .catch(() => ({} as PatchBody));

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.label !== undefined) {
    sets.push("label = ?");
    binds.push(body.label?.trim() || null);
  }
  if (body.assignedUserId !== undefined) {
    sets.push("assigned_user_id = ?");
    binds.push(body.assignedUserId ?? null);
  }
  if (body.assignedUserName !== undefined) {
    sets.push("assigned_user_name = ?");
    binds.push(body.assignedUserName ?? null);
  }
  if (body.assignedDept !== undefined) {
    sets.push("assigned_dept = ?");
    binds.push(body.assignedDept?.trim() || null);
  }
  if (body.assignedPosition !== undefined) {
    sets.push("assigned_position = ?");
    binds.push(body.assignedPosition?.trim() || null);
  }
  if (body.active !== undefined) {
    sets.push("active = ?");
    binds.push(body.active ? 1 : 0);
  }
  if (sets.length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  const res = await c.var.DB.prepare(
    `UPDATE email_addresses SET ${sets.join(", ")} WHERE org_id = ? AND id = ?`,
  )
    .bind(...binds, orgId, id)
    .run();
  if (!res.meta?.changes) {
    return c.json({ error: "address not found" }, 404);
  }

  const row = await c.var.DB.prepare(
    `SELECT * FROM email_addresses WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<AddressRow>();
  return c.json(row ? rowToAddress(row) : { id });
});

// ---------------------------------------------------------------------------
// Mailbox access matrix (owner 2026-06-17). A user always has their own
// assigned alias; these grants ADDITIONALLY let them open a SHARED mailbox
// (support@/hr@/finance@). SUPER_ADMIN-only; the matrix UI lives in User
// Management. getMailScope + GET /addresses already fold these grants in.
// ---------------------------------------------------------------------------

// GET /api/mail-center/access — every (addressId,userId) grant in the org, for
// rendering the matrix checkboxes.
app.get("/access", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    `SELECT address_id, user_id FROM email_address_access WHERE org_id = ?`,
  )
    .bind(orgId)
    // Result columns come back camelCase (db-pg.ts transform.column.from), so
    // address_id→addressId, user_id→userId. Reading snake_case returned
    // undefined and silently dropped the grants (same class of bug as
    // /scope-levels — owner 2026-06-17).
    .all<{ addressId: string; userId: string }>();
  // no-store — the matrix refetches this immediately after a grant POST/DELETE.
  c.header("Cache-Control", "no-store");
  return c.json(
    (res.results ?? []).map((r) => ({
      addressId: r.addressId,
      userId: r.userId,
    })),
  );
});

// POST /api/mail-center/access {addressId,userId} — grant a user access to a
// mailbox. Idempotent: the unique index makes a repeat a harmless no-op.
app.post("/access", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const body = await c.req
    .json<{ addressId?: string; userId?: string }>()
    .catch(() => ({}) as { addressId?: string; userId?: string });
  const addressId = (body.addressId ?? "").trim();
  const userId = (body.userId ?? "").trim();
  if (!addressId || !userId) {
    return c.json({ error: "addressId and userId are required" }, 400);
  }
  const grantedBy =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ??
    null;
  try {
    await c.var.DB.prepare(
      `INSERT INTO email_address_access
         (id, org_id, address_id, user_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        orgId,
        addressId,
        userId,
        new Date().toISOString(),
        grantedBy,
      )
      .run();
  } catch {
    // Unique (org_id,address_id,user_id) collision → the grant already exists.
  }
  return c.json({ ok: true, addressId, userId }, 201);
});

// DELETE /api/mail-center/access {addressId,userId} — revoke a grant.
app.delete("/access", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const body = await c.req
    .json<{ addressId?: string; userId?: string }>()
    .catch(() => ({}) as { addressId?: string; userId?: string });
  const addressId = (body.addressId ?? c.req.query("addressId") ?? "").trim();
  const userId = (body.userId ?? c.req.query("userId") ?? "").trim();
  if (!addressId || !userId) {
    return c.json({ error: "addressId and userId are required" }, 400);
  }
  await c.var.DB.prepare(
    `DELETE FROM email_address_access
       WHERE org_id = ? AND address_id = ? AND user_id = ?`,
  )
    .bind(orgId, addressId, userId)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Hierarchical mail-visibility levels (owner 2026-06-17). SUPER_ADMIN sets a
// per-user level in mail_user_scope: 'personal' | 'department' | 'company'.
// A user with no row is treated as 'personal' (the frontend assumes that for
// any userId absent from GET /scope-levels). getMailScope reads this to widen
// the inbox. SUPER_ADMIN-only, same hard gate as the address/access admin.
// ---------------------------------------------------------------------------

// GET /api/mail-center/scope-levels — every per-user level row in the org, for
// rendering the visibility-level selector. Users absent here = 'personal'.
app.get("/scope-levels", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    `SELECT user_id, level FROM mail_user_scope WHERE org_id = ?`,
  )
    .bind(orgId)
    // THE View-level bug: the postgres client transforms result columns BACK to
    // camelCase (db-pg.ts transform.column.from, inverse of the rename map), so
    // a `user_id` column comes back as `userId`. Reading `r.user_id` returned
    // undefined → the response dropped userId → the matrix couldn't map a level
    // to its user → every row fell back to Personal even though the level WAS
    // saved (owner "save 了还是跳回 personal", 2026-06-17). Read camelCase.
    .all<{ userId: string; level: string }>();
  // no-store so no HTTP-layer cache serves the pre-write list after a PUT.
  c.header("Cache-Control", "no-store");
  return c.json(
    (res.results ?? []).map((r) => ({
      userId: r.userId,
      level: r.level,
    })),
  );
});

// PUT /api/mail-center/scope-level {userId,level} — upsert a user's visibility
// level. level must be one of the three allowed values. Idempotent upsert keyed
// on (org_id, user_id).
app.put("/scope-level", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const body = await c.req
    .json<{ userId?: string; level?: string }>()
    .catch(() => ({}) as { userId?: string; level?: string });
  const userId = (body.userId ?? "").trim();
  const level = (body.level ?? "").trim().toLowerCase();
  if (!userId) {
    return c.json({ error: "userId is required" }, 400);
  }
  if (!(MAIL_SCOPE_LEVELS as readonly string[]).includes(level)) {
    return c.json(
      { error: "level must be 'personal', 'department', or 'company'" },
      400,
    );
  }
  await c.var.DB.prepare(
    `INSERT INTO mail_user_scope (org_id, user_id, level, created_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(org_id, user_id) DO UPDATE SET level = excluded.level`,
  )
    .bind(orgId, userId, level, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// P2 — reply + assign/resolve (mounted at /api/mail-center, AFTER auth).
// ---------------------------------------------------------------------------

// userId / userName are stamped on the context by auth-middleware via the
// get()/set() escape hatch (not enumerated in worker.ts's Variables map), so
// read them the same way requireSuperAdmin / POST /addresses already do.
function getUserId(c: { get: (k: string) => string | undefined }): string | null {
  const id = c.get("userId");
  return typeof id === "string" && id.length > 0 ? id : null;
}

// Resolve a sender display name for the outbound message row. Mirrors
// presence.ts's getDisplayName: prefer users.displayName, else email, else
// fall back to the raw userId so the row is never blank.
async function senderName(db: D1Database, userId: string | null): Promise<string> {
  if (!userId) return "";
  try {
    const row = await db
      .prepare("SELECT displayName, email FROM users WHERE id = ? LIMIT 1")
      .bind(userId)
      .first<{ displayName: string | null; email: string | null }>();
    return row?.displayName?.trim() || row?.email || userId;
  } catch {
    // A name lookup must never block a send that already succeeded.
    return userId;
  }
}

// Minimal HTML escape for wrapping a plain-text reply into an HTML body when
// the caller didn't supply their own html. Same intent as lib/email.ts's
// escapeHtml — kept local so this module stays self-contained.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Default From when a thread has no mailbox_address on file (e.g. an older
// thread, or one where the original recipient wasn't an @hookka.com address).
const DEFAULT_REPLY_FROM = "Hookka <support@hookka.com>";

// POST /api/mail-center/threads/:id/reply — send an outbound reply via the
// shared sender (Brevo when BREVO_API_KEY is set — hookka.com is verified
// there, so replies SEND today without any MX change), then record it.
//
// NOTE: sendMail does not yet support custom In-Reply-To / References headers,
// so this reply is NOT RFC-threaded on the recipient's side for v1. The local
// thread is still updated correctly; cross-client threading headers are a
// follow-up once the sender helper grows a headers option.
app.post("/threads/:id/reply", async (c) => {
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  const scope = await getMailScope(c, orgId);

  type ReplyBody = {
    text?: string;
    html?: string;
    // Optional From override — the address the operator picked in the reply
    // box. Absent ⇒ reply from the thread's mailbox (the original behaviour).
    fromAddress?: string;
    // Inline outbound attachments (images + PDF), base64 (no data: prefix).
    // Transient — not persisted to /api/files; just forwarded to sendMail.
    attachments?: Array<{ filename: string; contentBase64: string }>;
  };
  const body: ReplyBody = await c.req
    .json<ReplyBody>()
    .catch(() => ({} as ReplyBody));

  const text = (body.text ?? "").trim();
  const html = body.html?.trim() || "";
  if (!text && !html) {
    return c.json({ error: "reply body is empty" }, 400);
  }

  const attachments = body.attachments ?? [];
  // This route, like /compose, sends SYNCHRONOUSLY via sendMail and BYPASSES
  // the outbox, so the outbox's MAX_ATTACHMENT_TOTAL_BYTES guard does NOT
  // protect it — own the cap here (same 5 MB decoded / 10-file / images+PDF
  // rule the frontend mirrors). Interactive path → reject clearly.
  const attachCheck = validateMailAttachments(attachments);
  if (!attachCheck.ok) {
    return c.json({ error: attachCheck.error || "Invalid attachments." }, 400);
  }

  const thread = await c.var.DB.prepare(
    `SELECT * FROM email_threads WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  // Per-user scope: only the mailbox owner (or an admin) can reply. Dual-read —
  // the pg driver camelCases result columns, so the snake keys are undefined.
  // Without this the owner was 404'd and the reply recipient (counterparty_email)
  // read empty → "thread has no counterparty email to reply to".
  if (
    !scope.isAdmin &&
    !scope.addresses.includes(
      (thread.mailboxAddress ?? thread.mailbox_address ?? "").toLowerCase(),
    )
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const to = (thread.counterpartyEmail ?? thread.counterparty_email ?? "").trim();
  if (!to) {
    return c.json({ error: "thread has no counterparty email to reply to" }, 400);
  }

  const mailbox = (thread.mailboxAddress ?? thread.mailbox_address ?? "").trim();

  // Resolve the From: the operator may pick a mailbox in the reply box (default
  // is their own — see the FE). An explicit fromAddress is honoured only when
  // the caller is allowed to send from it: SUPER_ADMIN may send from any, a
  // non-admin only from a mailbox in their scope (same gate as /compose). An
  // absent / unauthorised override falls back to the thread's mailbox, which the
  // caller already passed the ownership check on above — so the reply never
  // silently goes out from an address the user can't use.
  const requestedFrom = (body.fromAddress ?? "").trim();
  let fromAddress = mailbox;
  if (
    requestedFrom &&
    (scope.isAdmin || scope.addresses.includes(requestedFrom.toLowerCase()))
  ) {
    fromAddress = requestedFrom;
  }

  // The send-from header: "<label> <addr>" when the address record carries a
  // label (mirrors /compose), else the bare address; DEFAULT_REPLY_FROM only
  // when the thread truly has no mailbox on file. A label lookup failure must
  // never block the send.
  let from = fromAddress || DEFAULT_REPLY_FROM;
  if (fromAddress) {
    try {
      const addrRow = await c.var.DB.prepare(
        `SELECT label FROM email_addresses
           WHERE org_id = ? AND address = ? LIMIT 1`,
      )
        .bind(orgId, fromAddress)
        .first<{ label: string | null }>();
      const label = addrRow?.label?.trim();
      if (label) from = `${label} <${fromAddress}>`;
    } catch {
      // Keep the bare address — a display-name lookup isn't worth failing over.
    }
  }

  const baseSubject = thread.subject ?? "(no subject)";
  const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;

  // When the caller supplied only plain text, wrap it in a minimal HTML body
  // so the email has both parts (Brevo derives textContent from html anyway,
  // but a real text/plain part keeps the reply readable everywhere).
  const htmlBody =
    html || `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`;

  const result = await sendMail(c.env, from, {
    to,
    subject,
    text: text || undefined,
    html: htmlBody,
    // Forward the validated attachments (already capped at 5 MB / 10 files /
    // images+PDF above). Omitted when empty so the payload is byte-identical to
    // the pre-attachment behaviour. Not persisted — transient outbound only.
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  if (!result.ok) {
    return c.json({ error: result.error || "failed to send reply" }, 502);
  }

  const userId = getUserId(
    c as unknown as { get: (k: string) => string | undefined },
  );
  const fromName = await senderName(c.var.DB, userId);

  const now = new Date().toISOString();
  const snippet = (text || stripHtml(htmlBody)).slice(0, 240);
  const messageId = crypto.randomUUID();
  await c.var.DB.prepare(
    `INSERT INTO email_messages
       (id, org_id, thread_id, direction, from_address, from_name,
        to_addresses, subject, text_body, html_body, sent_at, received_at,
        sent_by_user_id, sent_by_name, provider_message_id, created_at)
     VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      messageId,
      orgId,
      id,
      // Store the BARE chosen address (not the "label <addr>" header form) so
      // the message row's from_address stays a plain address — matches /compose
      // and how the thread's mailbox is recorded.
      fromAddress || DEFAULT_REPLY_FROM,
      fromName || null,
      JSON.stringify([to]),
      subject,
      text || null,
      htmlBody,
      now,
      now,
      userId,
      fromName || null,
      result.id ?? null,
      now,
    )
    .run();

  await c.var.DB.prepare(
    `UPDATE email_threads
        SET last_message_at = ?, last_direction = 'outbound',
            last_snippet = ?, message_count = message_count + 1, unread = 0
      WHERE org_id = ? AND id = ?`,
  )
    .bind(now, snippet, orgId, id)
    .run();

  return c.json({ ok: true, messageId });
});

// POST /api/mail-center/compose — start a NEW outbound conversation (the reply
// path requires an existing thread; this one creates the thread + first
// message from scratch). Sends via the shared sender (Brevo when configured —
// hookka.com is verified there, so this SENDS today without any MX change),
// then records a fresh thread + outbound message. Mirrors the reply handler's
// send → record structure.
//
// Per-user scope: a non-admin may only send FROM an @hookka.com address that
// is assigned/granted to them (getMailScope). SUPER_ADMIN may send from any.
app.post("/compose", async (c) => {
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const scope = await getMailScope(c, orgId);

  type ComposeBody = {
    fromAddress?: string;
    to?: string;
    subject?: string;
    text?: string;
    // Inline outbound attachments (images + PDF), base64 (no data: prefix).
    // Transient — not persisted to /api/files; just forwarded to sendMail.
    attachments?: Array<{ filename: string; contentBase64: string }>;
  };
  const body: ComposeBody = await c.req
    .json<ComposeBody>()
    .catch(() => ({} as ComposeBody));

  const fromAddress = (body.fromAddress ?? "").trim();
  const to = (body.to ?? "").trim();
  const subject = (body.subject ?? "").trim();
  const text = (body.text ?? "").trim();
  const attachments = body.attachments ?? [];

  if (!fromAddress) {
    return c.json({ error: "fromAddress is required" }, 400);
  }
  if (!EMAIL_RE.test(to)) {
    return c.json({ error: "a valid recipient (to) is required" }, 400);
  }
  if (!subject) {
    return c.json({ error: "subject is required" }, 400);
  }
  if (!text) {
    return c.json({ error: "message body is required" }, 400);
  }

  // This route sends SYNCHRONOUSLY via sendMail and BYPASSES the outbox, so the
  // outbox's MAX_ATTACHMENT_TOTAL_BYTES guard does NOT protect it — own the cap
  // here (same 5 MB decoded / 10-file / images+PDF rule the frontend mirrors).
  // Interactive path → reject clearly, never silently drop the attachment.
  const attachCheck = validateMailAttachments(attachments);
  if (!attachCheck.ok) {
    return c.json({ error: attachCheck.error || "Invalid attachments." }, 400);
  }

  // Authorize the From: non-admins may only send from a mailbox they own or
  // have been granted. addresses are already lowercased in getMailScope.
  if (!scope.isAdmin && !scope.addresses.includes(fromAddress.toLowerCase())) {
    return c.json({ error: "not allowed to send from " + fromAddress }, 403);
  }

  // Resolve the display name for the From — "<label> <addr>" when the address
  // record carries a label, else the bare address. Lookup failure must not
  // block the send, so fall back to the bare address.
  let from = fromAddress;
  try {
    const addrRow = await c.var.DB.prepare(
      `SELECT label FROM email_addresses
         WHERE org_id = ? AND address = ? LIMIT 1`,
    )
      .bind(orgId, fromAddress)
      .first<{ label: string | null }>();
    const label = addrRow?.label?.trim();
    if (label) from = `${label} <${fromAddress}>`;
  } catch {
    // Keep the bare address — a display-name lookup is not worth failing over.
  }

  // Wrap the plain-text body in a minimal HTML part so the email carries both
  // (same approach as the reply handler).
  const htmlBody = `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`;

  const result = await sendMail(c.env, from, {
    to,
    subject,
    text,
    html: htmlBody,
    // Forward the validated attachments (already capped at 5 MB / 10 files /
    // images+PDF above). Omitted when empty so the payload is byte-identical to
    // the pre-attachment behaviour. Not persisted — transient outbound only.
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  if (!result.ok) {
    // Surface the REAL provider error instead of a blank "send failed" — the
    // owner needs to see WHY (e.g. "No email provider configured" when staging
    // has no BREVO_API_KEY, or a Brevo "sender not authenticated" after the
    // domain moved to Hostinger). Same transparency as the reply path.
    return c.json({ error: result.error || "send failed" }, 502);
  }

  const userId = getUserId(
    c as unknown as { get: (k: string) => string | undefined },
  );
  const fromName = await senderName(c.var.DB, userId);

  const now = new Date().toISOString();
  const snippet = text.slice(0, 200);
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();

  // NEW thread row — outbound-initiated, so last_direction='outbound',
  // message_count=1, unread=0 (we sent it; nothing for us to read).
  await c.var.DB.prepare(
    `INSERT INTO email_threads
       (id, org_id, mailbox_address, subject, counterparty_email,
        counterparty_name, status, last_message_at, last_direction,
        last_snippet, message_count, unread, created_at)
     VALUES (?, ?, ?, ?, ?, '', 'open', ?, 'outbound', ?, 1, 0, ?)`,
  )
    .bind(threadId, orgId, fromAddress, subject, to, now, snippet, now)
    .run();

  // First message row — the outbound email we just sent.
  await c.var.DB.prepare(
    `INSERT INTO email_messages
       (id, org_id, thread_id, direction, from_address, from_name,
        to_addresses, cc_addresses, subject, text_body, html_body, sent_at,
        sent_by_user_id, sent_by_name, provider_message_id, created_at)
     VALUES (?, ?, ?, 'outbound', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      messageId,
      orgId,
      threadId,
      fromAddress,
      fromName || null,
      JSON.stringify([to]),
      subject,
      text,
      htmlBody,
      now,
      userId,
      fromName || null,
      result.id ?? null,
      now,
    )
    .run();

  return c.json({ ok: true, threadId, messageId }, 201);
});

// PATCH /api/mail-center/threads/:id — mutate a thread: assign / resolve /
// reopen, plus the email-client affordances star / labels / mark-unread /
// trash (previously localStorage-only). Gate matches the READS (getMailScope
// ownership), NOT requireSuperAdmin: a mailbox OWNER may mutate THEIR OWN
// threads (star/label/archive/trash their own mail); SUPER_ADMIN keeps all.
// The UPDATE is built dynamically from whichever fields the body carries.
app.patch("/threads/:id", async (c) => {
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  const scope = await getMailScope(c, orgId);

  type PatchBody = {
    status?: "open" | "closed";
    assignedToUserId?: string | null;
    assignedToName?: string | null;
    starred?: boolean;
    labels?: string[];
    unread?: boolean;
    trashed?: boolean;
  };
  const body: PatchBody = await c.req
    .json<PatchBody>()
    .catch(() => ({} as PatchBody));

  // Ownership gate — load the thread first, then allow only when the caller is
  // SUPER_ADMIN or the thread's mailbox is in their scope. Mirrors the reply
  // handler: a non-owner gets 404 so thread existence isn't disclosed.
  const owned = await c.var.DB.prepare(
    `SELECT mailbox_address FROM email_threads WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    // Result columns come back camelCase (db-pg.ts transform.column.from), so
    // mailbox_address → mailboxAddress. Reading the snake key returned undefined
    // → a non-admin mailbox OWNER was wrongly 404'd on star/label/trash of their
    // own thread. Dual-read.
    .first<{ mailboxAddress?: string | null; mailbox_address?: string | null }>();
  if (!owned) return c.json({ error: "Thread not found" }, 404);
  if (
    !scope.isAdmin &&
    !scope.addresses.includes(
      (owned.mailboxAddress ?? owned.mailbox_address ?? "").toLowerCase(),
    )
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.status !== undefined) {
    if (body.status !== "open" && body.status !== "closed") {
      return c.json({ error: "status must be 'open' or 'closed'" }, 400);
    }
    sets.push("status = ?");
    binds.push(body.status);
  }
  if (body.assignedToUserId !== undefined) {
    sets.push("assigned_to_user_id = ?");
    binds.push(body.assignedToUserId ?? null);
  }
  if (body.assignedToName !== undefined) {
    sets.push("assigned_to_name = ?");
    binds.push(body.assignedToName ?? null);
  }
  if (body.starred !== undefined) {
    sets.push("starred = ?");
    binds.push(body.starred ? 1 : 0);
  }
  if (body.labels !== undefined) {
    // Normalise to a clean string[] before storing as a JSON array string.
    const clean = Array.isArray(body.labels)
      ? body.labels.map((l) => String(l).trim()).filter(Boolean)
      : [];
    sets.push("labels = ?");
    binds.push(JSON.stringify(clean));
  }
  if (body.unread !== undefined) {
    // Fixes "mark unread": GET /threads/:id clears unread on open, and this is
    // the only path that can SET it back to 1.
    sets.push("unread = ?");
    binds.push(body.unread ? 1 : 0);
  }
  if (body.trashed !== undefined) {
    // Soft delete: set trashed_at=now to move to Trash, clear to null to
    // restore. TEXT column (ISO string), never timestamptz.
    sets.push("trashed_at = ?");
    binds.push(body.trashed ? new Date().toISOString() : null);
  }
  if (sets.length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  // Existence + ownership were already verified above, so we don't gate on
  // meta.changes here — an idempotent write (e.g. clearing an already-clear
  // trashed_at) reports 0 changes on some engines and must NOT 404.
  await c.var.DB.prepare(
    `UPDATE email_threads SET ${sets.join(", ")} WHERE org_id = ? AND id = ?`,
  )
    .bind(...binds, orgId, id)
    .run();

  const row = await c.var.DB.prepare(
    `SELECT * FROM email_threads WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<ThreadRow>();
  return c.json(row ? rowToThread(row) : { id });
});

export default app;
