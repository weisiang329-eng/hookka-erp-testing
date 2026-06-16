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
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId, DEFAULT_ORG_ID } from "../lib/tenant";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Lazy schema. Module-level promise = one flight per isolate; per-statement
// try/catch so a benign "already exists" never poisons the cached promise.
// Same pattern as routes/three-pl-state-rates.ts.
// ---------------------------------------------------------------------------
let pendingSchema: Promise<void> | null = null;
export function ensureMailSchema(db: D1Database): Promise<void> {
  if (pendingSchema) return pendingSchema;
  pendingSchema = (async () => {
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
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_email_addresses_org_addr
         ON email_addresses (org_id, address)`,
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
    ];
    for (const stmt of stmts) {
      try {
        await db.prepare(stmt).run();
      } catch (e) {
        console.error("[mail-center] schema init failed:", e);
      }
    }
  })();
  return pendingSchema;
}

// ---------------------------------------------------------------------------
// Inbound ingestion — called by the worker.ts pre-auth handler.
// ---------------------------------------------------------------------------
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

export async function ingestInboundEmail(
  db: D1Database,
  payload: InboundEmailPayload,
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
  // Message-ID.
  if (payload.messageId) {
    const dup = await db
      .prepare(
        `SELECT id, thread_id FROM email_messages WHERE org_id = ? AND message_id = ? LIMIT 1`,
      )
      .bind(orgId, payload.messageId)
      .first<{ id: string; thread_id: string }>();
    if (dup?.id) {
      return { ok: true, threadId: dup.thread_id, messageId: dup.id, deduped: true };
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
      .first<{ thread_id: string }>();
    if (ref?.thread_id) threadId = ref.thread_id;
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
  created_at: string | null;
};

function rowToThread(r: ThreadRow) {
  return {
    id: r.id,
    mailboxAddress: r.mailbox_address ?? "",
    subject: r.subject ?? "(no subject)",
    counterpartyEmail: r.counterparty_email ?? "",
    counterpartyName: r.counterparty_name ?? "",
    status: r.status,
    assignedToUserId: r.assigned_to_user_id ?? undefined,
    assignedToName: r.assigned_to_name ?? undefined,
    lastMessageAt: r.last_message_at ?? "",
    lastDirection: r.last_direction ?? "inbound",
    lastSnippet: r.last_snippet ?? "",
    messageCount: Number(r.message_count ?? 0),
    unread: Number(r.unread ?? 0) === 1,
    createdAt: r.created_at ?? "",
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
    threadId: r.thread_id,
    direction: r.direction,
    messageId: r.message_id ?? undefined,
    inReplyTo: r.in_reply_to ?? undefined,
    fromAddress: r.from_address ?? "",
    fromName: r.from_name ?? "",
    toAddresses: parseJsonArray(r.to_addresses),
    ccAddresses: parseJsonArray(r.cc_addresses),
    subject: r.subject ?? "",
    textBody: r.text_body ?? "",
    htmlBody: r.html_body ?? "",
    sentAt: r.sent_at ?? "",
    receivedAt: r.received_at ?? "",
    sentByUserId: r.sent_by_user_id ?? undefined,
    sentByName: r.sent_by_name ?? undefined,
    createdAt: r.created_at ?? "",
  };
}

type AddressRow = {
  id: string;
  address: string;
  label: string | null;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  assigned_dept: string | null;
  active: number | boolean | null;
  created_at: string | null;
};

function rowToAddress(r: AddressRow) {
  return {
    id: r.id,
    address: r.address,
    label: r.label ?? "",
    assignedUserId: r.assigned_user_id ?? undefined,
    assignedUserName: r.assigned_user_name ?? undefined,
    assignedDept: r.assigned_dept ?? undefined,
    active: Number(r.active ?? 0) === 1,
    createdAt: r.created_at ?? "",
  };
}

// ---------------------------------------------------------------------------
// Authenticated read endpoints (mounted at /api/mail-center, AFTER auth).
// ---------------------------------------------------------------------------

// GET /api/mail-center/threads?mailbox=&status=&q=
app.get("/threads", async (c) => {
  const denied = await requirePermission(c, "mail-center", "read");
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);

  const mailbox = c.req.query("mailbox");
  const status = c.req.query("status");
  const q = c.req.query("q");

  const where: string[] = ["org_id = ?"];
  const binds: (string | number)[] = [orgId];
  if (mailbox) {
    where.push("mailbox_address = ?");
    binds.push(mailbox);
  }
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  if (q) {
    where.push(
      "(LOWER(subject) LIKE ? OR LOWER(counterparty_email) LIKE ? OR LOWER(last_snippet) LIKE ?)",
    );
    const like = `%${q.toLowerCase()}%`;
    binds.push(like, like, like);
  }

  const sql =
    `SELECT * FROM email_threads WHERE ${where.join(" AND ")}` +
    " ORDER BY last_message_at DESC NULLS LAST LIMIT 300";
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<ThreadRow>();
  return c.json((res.results ?? []).map(rowToThread));
});

// GET /api/mail-center/threads/:id — thread + its messages (marks read).
app.get("/threads/:id", async (c) => {
  const denied = await requirePermission(c, "mail-center", "read");
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");

  const thread = await c.var.DB.prepare(
    `SELECT * FROM email_threads WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "Thread not found" }, 404);

  const msgs = await c.var.DB.prepare(
    `SELECT * FROM email_messages WHERE org_id = ? AND thread_id = ? ORDER BY created_at ASC`,
  )
    .bind(orgId, id)
    .all<MessageRow>();

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
    messages: (msgs.results ?? []).map(rowToMessage),
  });
});

// GET /api/mail-center/addresses — our @hookka.com addresses / aliases.
app.get("/addresses", async (c) => {
  const denied = await requirePermission(c, "mail-center", "read");
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    `SELECT * FROM email_addresses WHERE org_id = ? ORDER BY address ASC`,
  )
    .bind(orgId)
    .all<AddressRow>();
  return c.json((res.results ?? []).map(rowToAddress));
});

export default app;
