// ---------------------------------------------------------------------------
// customer-crm.ts — CRM layer on the Customers module (owner 2026-07-30, built
// for outbound sales). Two things a normal CRM needs so any new hire can pick a
// customer up:
//   · CONTACTS  — multiple named people per company (name, title/position,
//                 phone, email, role), not just the one contact the customers
//                 table holds today.
//   · ACTIVITIES — a follow-up TIMELINE: every call / meeting / quote / note,
//                 who we spoke to, what was discussed, the outcome, and the
//                 NEXT follow-up date.
//
// Tables are runtime self-applied (CREATE TABLE IF NOT EXISTS — migration files
// are inert on deploy, see CLAUDE.md). New columns are snake_case; the client
// reads dual-keyed. Tenant-scoped via org_id (getOrgId). Every route is RBAC
// gated on the `customers` resource.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { sendMail } from "../lib/email";
import { runSelfApply, memoizeSelfApply } from "../lib/self-apply";

const app = new Hono<Env>();

function actingUserId(c: Context<Env>): string | null {
  return (
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null
  );
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// A PROMISE memo, not a boolean. The boolean was only set after every statement
// had run, so N concurrent first-requests each executed the whole DDL block;
// and it had no rejection path at all. memoizeSelfApply collapses the
// concurrent callers into one round AND drops the memo when that round fails,
// so the next request retries instead of inheriting a permanently-broken
// isolate (tests/self-apply-retry.test.mjs — its sweep is what caught this
// file).
let tablesPending: Promise<void> | null = null;
function ensureTables(db: D1Database): Promise<void> {
  return memoizeSelfApply(
    () => tablesPending,
    (p) => {
      tablesPending = p;
    },
    () => createCrmTables(db),
  );
}

async function createCrmTables(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS customer_contacts (
         id TEXT PRIMARY KEY,
         customer_id TEXT NOT NULL,
         name TEXT,
         title TEXT,
         phone TEXT,
         email TEXT,
         role TEXT,
         is_primary INTEGER DEFAULT 0,
         notes TEXT,
         org_id TEXT,
         created_at TEXT,
         updated_at TEXT
       )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS customer_activities (
         id TEXT PRIMARY KEY,
         customer_id TEXT NOT NULL,
         activity_type TEXT,
         summary TEXT,
         detail TEXT,
         contact_id TEXT,
         contact_name TEXT,
         next_follow_up TEXT,
         follow_up_topic TEXT,
         outcome TEXT,
         occurred_at TEXT,
         created_by TEXT,
         org_id TEXT,
         created_at TEXT
       )`,
    )
    .run();
  // CREATE TABLE IF NOT EXISTS is a no-op on the production table, which was
  // created before these two columns existed — so the ALTERs are the ONLY path
  // they take to prod (CLAUDE.md: migrations are inert on deploy). Via
  // runSelfApply so a real failure is logged with its statement and thrown,
  // instead of swallowed and remembered as done.
  await runSelfApply(db as unknown as Parameters<typeof runSelfApply>[0], "customer-crm", [
    // WHEN it happened, as opposed to when it was typed in. A call logged the
    // next morning was being filed under the wrong day.
    "ALTER TABLE customer_activities ADD COLUMN IF NOT EXISTS occurred_at TEXT",
    // WHAT to raise next time. A reminder that only carries a date tells you
    // nothing when it fires.
    "ALTER TABLE customer_activities ADD COLUMN IF NOT EXISTS follow_up_topic TEXT",
  ]);
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS customer_onboarding (
         customer_id TEXT PRIMARY KEY,
         tin_number TEXT,
         einvoice_id TEXT,
         consent_received INTEGER DEFAULT 0,
         consent_date TEXT,
         docs_requested_at TEXT,
         notes TEXT,
         org_id TEXT,
         updated_at TEXT
       )`,
    )
    .run();
  // Wishlist — styles / models a customer has shown interest in (outbound
  // sales: "what to pitch next"). product_id is optional so a free-text style
  // the shop hasn't turned into a SKU yet can still be captured.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS customer_wishlist (
         id TEXT PRIMARY KEY,
         customer_id TEXT NOT NULL,
         product_id TEXT,
         product_code TEXT,
         product_name TEXT,
         interest TEXT,
         note TEXT,
         created_by TEXT,
         org_id TEXT,
         created_at TEXT
       )`,
    )
    .run();
}

type ContactRow = {
  id: string;
  customer_id: string;
  name: string | null;
  title: string | null;
  phone: string | null;
  email: string | null;
  role: string | null;
  is_primary: number | null;
  notes: string | null;
  created_at: string | null;
};

type ActivityRow = {
  id: string;
  customer_id: string;
  activity_type: string | null;
  summary: string | null;
  detail: string | null;
  contact_id: string | null;
  contact_name: string | null;
  next_follow_up: string | null;
  follow_up_topic: string | null;
  outcome: string | null;
  occurred_at: string | null;
  created_by: string | null;
  created_at: string | null;
};

// ── Contacts ────────────────────────────────────────────────────────────────

// GET /api/customer-crm/contacts?customerId=cust-3
app.get("/contacts", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const customerId = c.req.query("customerId");
  if (!customerId) return c.json({ success: false, error: "customerId required" }, 400);
  const res = await c.var.DB.prepare(
    `SELECT * FROM customer_contacts WHERE customer_id = ? AND org_id = ?
      ORDER BY is_primary DESC, name ASC`,
  )
    .bind(customerId, getOrgId(c))
    .all<ContactRow>();
  return c.json({ success: true, data: res.results ?? [] });
});

// POST /api/customer-crm/contacts
app.post("/contacts", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const customerId = String(b.customerId ?? b.customer_id ?? "");
  if (!customerId) return c.json({ success: false, error: "customerId required" }, 400);
  const id = genId("cc");
  const now = new Date().toISOString();
  await c.var.DB.prepare(
    `INSERT INTO customer_contacts
       (id, customer_id, name, title, phone, email, role, is_primary, notes, org_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      customerId,
      (b.name as string) ?? null,
      (b.title as string) ?? null,
      (b.phone as string) ?? null,
      (b.email as string) ?? null,
      (b.role as string) ?? null,
      b.isPrimary || b.is_primary ? 1 : 0,
      (b.notes as string) ?? null,
      getOrgId(c),
      now,
      now,
    )
    .run();
  return c.json({ success: true, data: { id } });
});

// PUT /api/customer-crm/contacts/:id
app.put("/contacts/:id", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  await c.var.DB.prepare(
    `UPDATE customer_contacts
        SET name = ?, title = ?, phone = ?, email = ?, role = ?, is_primary = ?, notes = ?, updated_at = ?
      WHERE id = ? AND org_id = ?`,
  )
    .bind(
      (b.name as string) ?? null,
      (b.title as string) ?? null,
      (b.phone as string) ?? null,
      (b.email as string) ?? null,
      (b.role as string) ?? null,
      b.isPrimary || b.is_primary ? 1 : 0,
      (b.notes as string) ?? null,
      new Date().toISOString(),
      id,
      getOrgId(c),
    )
    .run();
  return c.json({ success: true, data: { id } });
});

// DELETE /api/customer-crm/contacts/:id
app.delete("/contacts/:id", async (c) => {
  const denied = await requirePermission(c, "customers", "delete");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const id = c.req.param("id");
  await c.var.DB.prepare("DELETE FROM customer_contacts WHERE id = ? AND org_id = ?")
    .bind(id, getOrgId(c))
    .run();
  return c.json({ success: true });
});

// ── Activities / follow-up timeline ──────────────────────────────────────────

// GET /api/customer-crm/activities?customerId=cust-3
app.get("/activities", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const customerId = c.req.query("customerId");
  if (!customerId) return c.json({ success: false, error: "customerId required" }, 400);
  const res = await c.var.DB.prepare(
    // Newest CALL first, not newest TYPED first — logging yesterday's call this
    // morning must not jump it above a call actually made today. COALESCE keeps
    // every row written before occurred_at existed in its old position.
    `SELECT * FROM customer_activities WHERE customer_id = ? AND org_id = ?
      ORDER BY COALESCE(occurred_at, substr(created_at, 1, 10)) DESC, created_at DESC`,
  )
    .bind(customerId, getOrgId(c))
    .all<ActivityRow>();
  return c.json({ success: true, data: res.results ?? [] });
});

// POST /api/customer-crm/activities
app.post("/activities", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const customerId = String(b.customerId ?? b.customer_id ?? "");
  if (!customerId) return c.json({ success: false, error: "customerId required" }, 400);
  const id = genId("ca");
  await c.var.DB.prepare(
    `INSERT INTO customer_activities
       (id, customer_id, activity_type, summary, detail, contact_id, contact_name,
        next_follow_up, follow_up_topic, outcome, occurred_at, created_by, org_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      customerId,
      (b.activityType as string) ?? (b.activity_type as string) ?? "NOTE",
      (b.summary as string) ?? null,
      (b.detail as string) ?? null,
      (b.contactId as string) ?? (b.contact_id as string) ?? null,
      (b.contactName as string) ?? (b.contact_name as string) ?? null,
      (b.nextFollowUp as string) ?? (b.next_follow_up as string) ?? null,
      (b.followUpTopic as string) ?? (b.follow_up_topic as string) ?? null,
      (b.outcome as string) ?? null,
      // Falls back to today rather than to null: an activity with no date at
      // all sorts to the bottom of the timeline forever.
      (b.occurredAt as string) ?? (b.occurred_at as string) ?? new Date().toISOString().slice(0, 10),
      actingUserId(c),
      getOrgId(c),
      new Date().toISOString(),
    )
    .run();
  return c.json({ success: true, data: { id } });
});

// DELETE /api/customer-crm/activities/:id
app.delete("/activities/:id", async (c) => {
  const denied = await requirePermission(c, "customers", "delete");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const id = c.req.param("id");
  await c.var.DB.prepare("DELETE FROM customer_activities WHERE id = ? AND org_id = ?")
    .bind(id, getOrgId(c))
    .run();
  return c.json({ success: true });
});

// GET /api/customer-crm/follow-ups?through=2026-08-05
// Upcoming + overdue follow-ups across all customers — drives a "who to contact"
// list. `through` (inclusive) defaults to today; overdue rows always included.
app.get("/follow-ups", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const through = c.req.query("through") ?? new Date().toISOString().slice(0, 10);
  const res = await c.var.DB.prepare(
    `SELECT a.*, cu.name AS customer_name
       FROM customer_activities a
       LEFT JOIN customers cu ON cu.id = a.customer_id
      WHERE a.org_id = ? AND a.next_follow_up IS NOT NULL AND a.next_follow_up <> ''
        AND a.next_follow_up <= ?
      ORDER BY a.next_follow_up ASC`,
  )
    .bind(getOrgId(c), through)
    .all<ActivityRow & { customer_name: string | null }>();
  return c.json({ success: true, data: res.results ?? [] });
});

// ── Onboarding / KYC ─────────────────────────────────────────────────────────
// Account-opening docs needed before extending credit: consent letter + TIN +
// e-Invoice id + SSM (SSM already lives on the customers row). Owner 2026-07-30.

// GET /api/customer-crm/onboarding?customerId=cust-3
app.get("/onboarding", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const customerId = c.req.query("customerId");
  if (!customerId) return c.json({ success: false, error: "customerId required" }, 400);
  const row = await c.var.DB.prepare(
    "SELECT * FROM customer_onboarding WHERE customer_id = ? AND org_id = ?",
  )
    .bind(customerId, getOrgId(c))
    .first();
  return c.json({ success: true, data: row ?? null });
});

// PUT /api/customer-crm/onboarding — upsert the customer's KYC block
app.put("/onboarding", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const customerId = String(b.customerId ?? b.customer_id ?? "");
  if (!customerId) return c.json({ success: false, error: "customerId required" }, 400);
  await c.var.DB.prepare(
    `INSERT INTO customer_onboarding
       (customer_id, tin_number, einvoice_id, consent_received, consent_date, docs_requested_at, notes, org_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET
       tin_number = excluded.tin_number,
       einvoice_id = excluded.einvoice_id,
       consent_received = excluded.consent_received,
       consent_date = excluded.consent_date,
       docs_requested_at = excluded.docs_requested_at,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
  )
    .bind(
      customerId,
      (b.tinNumber as string) ?? (b.tin_number as string) ?? null,
      (b.einvoiceId as string) ?? (b.einvoice_id as string) ?? null,
      b.consentReceived || b.consent_received ? 1 : 0,
      (b.consentDate as string) ?? (b.consent_date as string) ?? null,
      (b.docsRequestedAt as string) ?? (b.docs_requested_at as string) ?? null,
      (b.notes as string) ?? null,
      getOrgId(c),
      new Date().toISOString(),
    )
    .run();
  return c.json({ success: true, data: { customerId } });
});

// ── Wishlist — RETIRED 2026-08-01 ─────────────────────────────────────────────
// Owner: "整个功能删掉，我们 assign SKU 就行了". The GET/POST/DELETE /wishlist routes
// and the WishlistPanel are gone. The `customer_wishlist` TABLE and its
// CREATE TABLE IF NOT EXISTS above are deliberately KEPT: the feature is
// withdrawn, the historical rows are not deleted. Nothing reads them now.

// ── One-click send (quote / catalog) ─────────────────────────────────────────
// The quotation PDF is generated in the browser (jsPDF); the client base64-
// encodes it and POSTs it here. We attach it to an email via the shared sender
// (Brevo/Resend) and log a QUOTE_SENT activity on the timeline so the follow-up
// history shows what went out. Sending outward is an explicit user action (a
// confirm dialog gates the button); this route only performs what the operator
// clicked. When no email provider is configured the send returns ok:false and
// the UI surfaces it — the activity is NOT logged in that case.

// POST /api/customer-crm/send-quote
app.post("/send-quote", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTables(c.var.DB);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const customerId = String(b.customerId ?? b.customer_id ?? "");
  const to = String(b.to ?? b.email ?? "").trim();
  const pdfBase64 = String(b.pdfBase64 ?? "").trim();
  const filename = String(b.filename ?? "Quotation.pdf").trim() || "Quotation.pdf";
  if (!customerId) return c.json({ success: false, error: "customerId required" }, 400);
  if (!to || !/.+@.+\..+/.test(to)) {
    return c.json({ success: false, error: "a valid recipient email is required" }, 400);
  }
  if (!pdfBase64) return c.json({ success: false, error: "pdfBase64 required" }, 400);
  // Guard against oversized payloads (Workers body + provider limits). ~5 MB of
  // raw PDF ≈ 6.8 MB base64 — cap a little above that.
  if (pdfBase64.length > 7_500_000) {
    return c.json({ success: false, error: "attachment too large (max ~5 MB)" }, 413);
  }

  const subject = String(b.subject ?? "").trim() || "Your quotation from Hookka";
  const note = String(b.note ?? "").trim();
  const html =
    `<p>Hi,</p><p>Please find your latest quotation attached.</p>` +
    (note ? `<p>${escapeHtmlLite(note)}</p>` : "") +
    `<p>Thank you.</p>`;

  const env = c.env as unknown as {
    RESEND_API_KEY?: string;
    BREVO_API_KEY?: string;
    RESEND_FROM_EMAIL?: string;
  };
  const from = env.RESEND_FROM_EMAIL || "Hookka Manufacturing <noreply@hookka.com>";
  const result = await sendMail(env, from, {
    to,
    subject,
    html,
    attachments: [{ filename, contentBase64: pdfBase64 }],
  });
  if (!result.ok) {
    return c.json(
      { success: false, error: result.error || "email send failed" },
      502,
    );
  }

  // Log a QUOTE_SENT activity so the follow-up timeline records the send.
  const actId = genId("ca");
  await c.var.DB.prepare(
    `INSERT INTO customer_activities
       (id, customer_id, activity_type, summary, detail, contact_id, contact_name,
        next_follow_up, outcome, created_by, org_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      actId,
      customerId,
      "QUOTE_SENT",
      `Emailed quotation to ${to}`,
      note || filename,
      null,
      null,
      null,
      "SENT",
      actingUserId(c),
      getOrgId(c),
      new Date().toISOString(),
    )
    .run();

  return c.json({ success: true, data: { id: result.id ?? null, activityId: actId } });
});

// Minimal HTML escaper for the note we inline into the email body (no external
// dep in this route). Covers the five characters that matter for injection.
function escapeHtmlLite(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default app;
