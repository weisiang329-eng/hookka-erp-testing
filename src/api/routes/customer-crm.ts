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

const app = new Hono<Env>();

function actingUserId(c: Context<Env>): string | null {
  return (
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null
  );
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

let tablesEnsured = false;
async function ensureTables(db: D1Database): Promise<void> {
  if (tablesEnsured) return;
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
         outcome TEXT,
         created_by TEXT,
         org_id TEXT,
         created_at TEXT
       )`,
    )
    .run();
  tablesEnsured = true;
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
  outcome: string | null;
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
    `SELECT * FROM customer_activities WHERE customer_id = ? AND org_id = ?
      ORDER BY created_at DESC`,
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
        next_follow_up, outcome, created_by, org_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      (b.outcome as string) ?? null,
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

export default app;
