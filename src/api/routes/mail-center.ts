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
// Per-user mailbox visibility (owner 2026-06-17: "每个 account 在 ERP 里有他自己
// 的 mailbox"). SUPER_ADMIN sees every thread/address in the org; every other
// authenticated user sees ONLY the threads/addresses on the @hookka.com
// address(es) assigned to them in email_addresses. Inherently scoped to the
// caller, so it needs no mail-center:* RBAC grant (which was never seeded).
// ---------------------------------------------------------------------------
async function getMailScope(
  c: Context<Env>,
  orgId: string,
): Promise<{ isAdmin: boolean; userId: string; addresses: string[] }> {
  const get = (c as unknown as { get: (k: string) => string | undefined }).get;
  const role = get("userRole")?.toUpperCase();
  const userId = get("userId") ?? "";
  if (role === "SUPER_ADMIN") return { isAdmin: true, userId, addresses: [] };
  if (!userId) return { isAdmin: false, userId: "", addresses: [] };
  const res = await c.var.DB.prepare(
    `SELECT address FROM email_addresses WHERE org_id = ? AND assigned_user_id = ? AND active = 1`,
  )
    .bind(orgId, userId)
    .all<{ address: string }>();
  return {
    isAdmin: false,
    userId,
    addresses: (res.results ?? []).map((r) => r.address.toLowerCase()),
  };
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
  if (
    !scope.isAdmin &&
    !scope.addresses.includes((thread.mailbox_address ?? "").toLowerCase())
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

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
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const scope = await getMailScope(c, orgId);
  // SUPER_ADMIN sees every address; a regular user sees only the ones assigned
  // to them (their own mailbox).
  const res = scope.isAdmin
    ? await c.var.DB.prepare(
        `SELECT * FROM email_addresses WHERE org_id = ? ORDER BY address ASC`,
      )
        .bind(orgId)
        .all<AddressRow>()
    : await c.var.DB.prepare(
        `SELECT * FROM email_addresses WHERE org_id = ? AND assigned_user_id = ? ORDER BY address ASC`,
      )
        .bind(orgId, scope.userId)
        .all<AddressRow>();
  return c.json((res.results ?? []).map(rowToAddress));
});

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
    fromName: "测试客户 Test Customer",
    to: [mailbox],
    subject: "测试:可以做一张 5 尺床架吗?",
    text: "你好,我想订一张 5 尺床架,请问价格和交期?\n\n(这是一封测试邮件,可以删除。)\n\nThanks,\nTest Customer",
    messageId: `test-${crypto.randomUUID()}@example.com`,
    date: new Date().toISOString(),
  });
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
          assigned_dept, active, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        id,
        orgId,
        address,
        body.label?.trim() || null,
        body.assignedUserId ?? null,
        body.assignedUserName ?? null,
        body.assignedDept ?? null,
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

  type ReplyBody = { text?: string; html?: string };
  const body: ReplyBody = await c.req
    .json<ReplyBody>()
    .catch(() => ({} as ReplyBody));

  const text = (body.text ?? "").trim();
  const html = body.html?.trim() || "";
  if (!text && !html) {
    return c.json({ error: "reply body is empty" }, 400);
  }

  const thread = await c.var.DB.prepare(
    `SELECT * FROM email_threads WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  // Per-user scope: only the mailbox owner (or an admin) can reply.
  if (
    !scope.isAdmin &&
    !scope.addresses.includes((thread.mailbox_address ?? "").toLowerCase())
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const to = (thread.counterparty_email ?? "").trim();
  if (!to) {
    return c.json({ error: "thread has no counterparty email to reply to" }, 400);
  }

  const mailbox = (thread.mailbox_address ?? "").trim();
  const from = mailbox || DEFAULT_REPLY_FROM;
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
      from,
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

// PATCH /api/mail-center/threads/:id — assign / resolve / reopen a thread.
app.patch("/threads/:id", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureMailSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");

  type PatchBody = {
    status?: "open" | "closed";
    assignedToUserId?: string | null;
    assignedToName?: string | null;
  };
  const body: PatchBody = await c.req
    .json<PatchBody>()
    .catch(() => ({} as PatchBody));

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
  if (sets.length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  const res = await c.var.DB.prepare(
    `UPDATE email_threads SET ${sets.join(", ")} WHERE org_id = ? AND id = ?`,
  )
    .bind(...binds, orgId, id)
    .run();
  if (!res.meta?.changes) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const row = await c.var.DB.prepare(
    `SELECT * FROM email_threads WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, id)
    .first<ThreadRow>();
  return c.json(row ? rowToThread(row) : { id });
});

export default app;
