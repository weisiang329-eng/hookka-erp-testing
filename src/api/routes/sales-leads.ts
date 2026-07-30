// ---------------------------------------------------------------------------
// sales-leads.ts — the pre-sale PIPELINE (owner 2026-07-30). Leads are NOT yet
// real debtor accounts (customers require a valid debtor code), so they live in
// their own lightweight table and move through stages until WON (→ converted to
// a customer) or LOST (with a reason). Drives the pipeline board.
//
// Table runtime self-applied (migrations inert on deploy). snake_case columns,
// tenant-scoped by org_id, every route RBAC-gated on `customers`.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

// The funnel. WON / LOST are terminal.
export const LEAD_STAGES = ["NEW", "CONTACTED", "QUOTED", "NEGOTIATING", "WON", "LOST"] as const;
type LeadStage = (typeof LEAD_STAGES)[number];

function actingUserId(c: Context<Env>): string | null {
  return (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
}
function genId(): string {
  return `lead-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

let tableEnsured = false;
async function ensureTable(db: D1Database): Promise<void> {
  if (tableEnsured) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS sales_leads (
         id TEXT PRIMARY KEY,
         name TEXT,
         company TEXT,
         phone TEXT,
         email TEXT,
         source TEXT,
         stage TEXT DEFAULT 'NEW',
         est_value_sen INTEGER DEFAULT 0,
         notes TEXT,
         assigned_to TEXT,
         next_follow_up TEXT,
         lost_reason TEXT,
         won_customer_id TEXT,
         org_id TEXT,
         created_by TEXT,
         created_at TEXT,
         updated_at TEXT
       )`,
    )
    .run();
  tableEnsured = true;
}

type LeadRow = {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  stage: string | null;
  est_value_sen: number | null;
  notes: string | null;
  assigned_to: string | null;
  next_follow_up: string | null;
  lost_reason: string | null;
  won_customer_id: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function normStage(s: unknown): LeadStage {
  const up = String(s ?? "").toUpperCase();
  return (LEAD_STAGES as readonly string[]).includes(up) ? (up as LeadStage) : "NEW";
}

// GET /api/sales-leads  — the whole board (optionally ?stage=NEW)
app.get("/", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  const stage = c.req.query("stage");
  const base = `SELECT * FROM sales_leads WHERE org_id = ?`;
  const stmt = stage
    ? c.var.DB.prepare(`${base} AND stage = ? ORDER BY updated_at DESC`).bind(getOrgId(c), normStage(stage))
    : c.var.DB.prepare(`${base} ORDER BY updated_at DESC`).bind(getOrgId(c));
  const res = await stmt.all<LeadRow>();
  return c.json({ success: true, data: res.results ?? [] });
});

// POST /api/sales-leads
app.post("/", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!String(b.name ?? "").trim() && !String(b.company ?? "").trim()) {
    return c.json({ success: false, error: "name or company required" }, 400);
  }
  const id = genId();
  const now = new Date().toISOString();
  await c.var.DB.prepare(
    `INSERT INTO sales_leads
       (id, name, company, phone, email, source, stage, est_value_sen, notes,
        assigned_to, next_follow_up, org_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      (b.name as string) ?? null,
      (b.company as string) ?? null,
      (b.phone as string) ?? null,
      (b.email as string) ?? null,
      (b.source as string) ?? null,
      normStage(b.stage),
      Number(b.estValueSen ?? b.est_value_sen ?? 0) || 0,
      (b.notes as string) ?? null,
      (b.assignedTo as string) ?? actingUserId(c),
      (b.nextFollowUp as string) ?? (b.next_follow_up as string) ?? null,
      getOrgId(c),
      actingUserId(c),
      now,
      now,
    )
    .run();
  return c.json({ success: true, data: { id } });
});

// PUT /api/sales-leads/:id  — edit fields
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  await c.var.DB.prepare(
    `UPDATE sales_leads
        SET name = ?, company = ?, phone = ?, email = ?, source = ?,
            est_value_sen = ?, notes = ?, next_follow_up = ?, updated_at = ?
      WHERE id = ? AND org_id = ?`,
  )
    .bind(
      (b.name as string) ?? null,
      (b.company as string) ?? null,
      (b.phone as string) ?? null,
      (b.email as string) ?? null,
      (b.source as string) ?? null,
      Number(b.estValueSen ?? b.est_value_sen ?? 0) || 0,
      (b.notes as string) ?? null,
      (b.nextFollowUp as string) ?? (b.next_follow_up as string) ?? null,
      new Date().toISOString(),
      id,
      getOrgId(c),
    )
    .run();
  return c.json({ success: true, data: { id } });
});

// PUT /api/sales-leads/:id/stage  — move through the funnel (LOST needs a reason)
app.put("/:id/stage", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const stage = normStage(b.stage);
  await c.var.DB.prepare(
    `UPDATE sales_leads SET stage = ?, lost_reason = ?, won_customer_id = ?, updated_at = ?
      WHERE id = ? AND org_id = ?`,
  )
    .bind(
      stage,
      stage === "LOST" ? ((b.lostReason as string) ?? (b.lost_reason as string) ?? null) : null,
      stage === "WON" ? ((b.wonCustomerId as string) ?? (b.won_customer_id as string) ?? null) : null,
      new Date().toISOString(),
      id,
      getOrgId(c),
    )
    .run();
  return c.json({ success: true, data: { id, stage } });
});

// POST /api/sales-leads/:id/convert — link a lead to a freshly-created customer
// and MOVE its CRM record over. The customer itself is created via the canonical
// POST /api/customers first (client passes the resulting customerId here); this
// endpoint only re-points the lead's entity-keyed CRM side-tables (contacts,
// activities, wishlist, onboarding) from the lead id to the new customer id and
// stamps the lead WON. Keeps all customer-creation logic (debtor-code
// validation, id format, company columns) in exactly one place.
const CRM_ENTITY_TABLES = [
  "customer_contacts",
  "customer_activities",
  "customer_wishlist",
  "customer_onboarding",
] as const;

app.post("/:id/convert", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  const leadId = c.req.param("id");
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const customerId = String(b.customerId ?? b.customer_id ?? "").trim();
  if (!customerId) return c.json({ success: false, error: "customerId required" }, 400);
  const org = getOrgId(c);
  // Re-point every entity-keyed CRM side-table from lead id → customer id. Table
  // names come from a fixed allowlist (never user input), so interpolating them
  // is injection-safe. A missing table (lead never opened that panel) just
  // throws and is ignored — there is nothing to move in that case.
  const now = new Date().toISOString();
  for (const table of CRM_ENTITY_TABLES) {
    try {
      await c.var.DB.prepare(
        `UPDATE ${table} SET customer_id = ? WHERE customer_id = ? AND org_id = ?`,
      )
        .bind(customerId, leadId, org)
        .run();
    } catch {
      // table absent or nothing to move — safe to skip
    }
  }
  await c.var.DB.prepare(
    `UPDATE sales_leads SET stage = 'WON', won_customer_id = ?, updated_at = ?
      WHERE id = ? AND org_id = ?`,
  )
    .bind(customerId, now, leadId, org)
    .run();
  return c.json({ success: true, data: { leadId, customerId } });
});

// DELETE /api/sales-leads/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "customers", "delete");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  await c.var.DB.prepare("DELETE FROM sales_leads WHERE id = ? AND org_id = ?")
    .bind(c.req.param("id"), getOrgId(c))
    .run();
  return c.json({ success: true });
});

export default app;
