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
import { ensureCustomerStageColumns } from "../lib/customer-stage";
import { planImport, makeBatchLabel, type RawLeadRow } from "../../lib/lead-import";

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
  // Provisional catalog assignments on a lead (owner 2026-07-30): products the
  // lead is being quoted, with an optional target price. Kept in its OWN table
  // (never customer_products — that joins into pricing/quotations) so an
  // unconfirmed lead can't leak into the pricing engine; on convert these are
  // copied into customer_products for the real customer.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS lead_products (
         id TEXT PRIMARY KEY,
         lead_id TEXT NOT NULL,
         product_id TEXT,
         product_code TEXT,
         product_name TEXT,
         price_sen INTEGER,
         org_id TEXT,
         created_at TEXT
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

// GET /api/sales-leads — one page of the pipeline.
//
// This used to be `SELECT *` with no LIMIT: the entire table, every call. That
// was survivable while the table held a handful of hand-typed leads. It is not
// survivable next to a bought list — the Penang file alone adds 939 rows, and
// the response would carry all of them on every page load.
//
// So there is a LIMIT now, and `total` comes back beside the rows. Two notes on
// the shape, because both were deliberate:
//   * `data` is still the plain array the existing board already reads, so
//     nothing breaks. The new counts ride alongside it.
//   * the cap applies even when the caller asks for no limit. A caller that
//     forgets to paginate should get a slow-but-alive page and a `total` that
//     tells it the truth, not a silent half-list — which is why `total` is not
//     optional.
//
// Filters are the ones a salesperson actually works by: which list this came
// from, which industry, where it is up to, and free-text over name and phone.
app.get("/", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  await ensureImportColumns(c.var.DB);

  const orgId = getOrgId(c);
  const stage = c.req.query("stage");
  const industry = c.req.query("industry");
  const batch = c.req.query("batch");
  const q = (c.req.query("q") ?? "").trim();

  const MAX = 500;
  const DEFAULT = 200;
  const askedLimit = Number(c.req.query("limit"));
  const limit = Math.min(
    Number.isFinite(askedLimit) && askedLimit > 0 ? askedLimit : DEFAULT,
    MAX,
  );
  const askedOffset = Number(c.req.query("offset"));
  const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0;

  const where: string[] = ["org_id = ?"];
  const args: unknown[] = [orgId];
  if (stage) {
    where.push("stage = ?");
    args.push(normStage(stage));
  }
  if (industry) {
    where.push("industry = ?");
    args.push(industry);
  }
  if (batch) {
    where.push("import_batch = ?");
    args.push(batch);
  }
  if (q) {
    // Phone is matched on digits so "0102486699" finds "+60 10-248 6699" —
    // a salesperson pastes the number the way the customer said it.
    const digits = q.replace(/\D+/g, "");
    where.push(
      digits
        ? "(company ILIKE ? OR name ILIKE ? OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE ?)"
        : "(company ILIKE ? OR name ILIKE ?)",
    );
    args.push(`%${q}%`, `%${q}%`);
    if (digits) args.push(`%${digits}%`);
  }
  const clause = where.join(" AND ");

  const totalRow = await c.var.DB.prepare(
    `SELECT COUNT(*) AS n FROM sales_leads WHERE ${clause}`,
  )
    .bind(...args)
    .first<{ n: number }>();

  const res = await c.var.DB.prepare(
    `SELECT * FROM sales_leads WHERE ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...args, limit, offset)
    .all<LeadRow>();

  return c.json({
    success: true,
    data: res.results ?? [],
    total: Number(totalRow?.n ?? 0),
    limit,
    offset,
  });
});

// GET /api/sales-leads/industries — the industry facet, with counts, for the
// tabs across the top of the list. Derived from the data rather than a fixed
// enum, so a new bought list in a new trade appears on its own.
app.get("/industries", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  await ensureImportColumns(c.var.DB);
  const res = await c.var.DB.prepare(
    `SELECT COALESCE(industry, '(none)') AS industry,
            COUNT(*) AS total,
            SUM(CASE WHEN stage <> 'NEW' THEN 1 ELSE 0 END) AS contacted,
            SUM(CASE WHEN last_reply_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
       FROM sales_leads WHERE org_id = ?
      GROUP BY 1 ORDER BY total DESC`,
  )
    .bind(getOrgId(c))
    .all();
  return c.json({ success: true, data: res.results ?? [] });
});

// `sales_leads.customer_id` — the POTENTIAL customer created alongside the lead.
// Distinct from the legacy `won_customer_id` (set only at conversion): reads
// should prefer customer_id and fall back, so leads that converted before
// 2026-08-01 still resolve. Runtime self-apply — migrations are inert on deploy.
let leadCustomerColPromise = false;
async function ensureLeadCustomerColumn(db: D1Database): Promise<void> {
  if (leadCustomerColPromise) return;

  try {
    await db
      .prepare("ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS customer_id TEXT")
      .run();
  } catch {
    // best-effort — column may already exist
  }
  leadCustomerColPromise = true;
}

// Mints the POTENTIAL customer that backs a lead. Deliberately writes the same
// columns customers.ts POST does, minus everything that only the Confirm gate
// can decide: no creditor code, terms default, zero credit limit, zero A/R.
async function createPotentialCustomerForLead(
  db: D1Database,
  orgId: string,
  f: { name: string; contactName: string; phone: string; email: string },
): Promise<string | null> {
  if (!f.name) return null;
  const id = `cust-${crypto.randomUUID().slice(0, 8)}`;
  // orgId is passed in rather than defaulted. This INSERT used to omit the
  // column entirely, so every lead-minted customer silently took the SQL
  // default `'hookka'` (migration 0049:32) no matter who created it — a lead
  // raised in OHANA / HOUZS / HKMFG produced a HOOKKA customer. Every other
  // statement in this file is scoped `org_id = getOrgId(c)`; this one was the
  // exception only because the helper took `db` and never had the context.
  await db
    .prepare(
      `INSERT INTO customers (id, code, name, ssmNo, companyAddress, creditTerms,
         creditLimitSen, outstandingSen, isActive, contactName, phone, email,
         customer_stage, orgId)
       VALUES (?, '', ?, '', '', 'NET30', 0, 0, 1, ?, ?, ?, 'POTENTIAL', ?)`,
    )
    .bind(id, f.name, f.contactName, f.phone, f.email, orgId)
    .run();
  return id;
}

// POST /api/sales-leads — creates the lead AND its POTENTIAL customer account.
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

  // A lead IS a potential customer (owner 2026-08-01). Creating the customer
  // row here — not at conversion — is what lets the salesperson assign SKUs, set
  // a sofa combo and export a quotation before anything is agreed, which is the
  // whole point of the change ("要不然我不习惯").
  //
  // The account is born POTENTIAL, which means: no creditor code required, and
  // the sales-order guard refuses it outright. It becomes billable only through
  // the Confirm gate, where the code / terms / credit limit are set.
  //
  // Best-effort ON PURPOSE: if this fails, the LEAD must still exist. Losing the
  // salesperson's typed-in lead because a customer insert hiccuped would be a
  // far worse outcome than a lead without its account yet — and Confirm can
  // create the account later either way.
  let customerId: string | null = null;
  try {
    await ensureLeadCustomerColumn(c.var.DB);
    await ensureCustomerStageColumns(c.var.DB);
    customerId = await createPotentialCustomerForLead(c.var.DB, getOrgId(c), {
      name: String(b.company ?? "").trim() || String(b.name ?? "").trim(),
      contactName: String(b.name ?? "").trim(),
      phone: String(b.phone ?? "").trim(),
      email: String(b.email ?? "").trim(),
    });
    if (customerId) {
      await c.var.DB.prepare(
        "UPDATE sales_leads SET customer_id = ? WHERE id = ? AND org_id = ?",
      )
        .bind(customerId, id, getOrgId(c))
        .run();
    }
  } catch (e) {
    console.warn("[sales-leads] potential-customer create failed for lead", id, e);
  }

  return c.json({ success: true, data: { id, customerId } });
});

// ---------------------------------------------------------------------------
// Columns a bought contact list needs. Runtime self-apply — a migration file
// alone is inert on deploy in this repo.
//
//   industry / location / website  the scraped list carries these and a
//                                  salesperson sorts by them
//   import_batch                   which list this row came from. The single
//                                  most important one: bought lists vary in
//                                  quality, and this is what makes "that batch
//                                  was rubbish, remove all of it" one action
//                                  instead of an unpickable mess months later
//   contact_role                   "purchasing", "owner" — learned on the call
//   original_company               the untouched scraped title, when the stored
//                                  name was shortened from it
//   also_listed_as                 other names that shared this phone
//   last_contacted_at / last_reply_at  drives the follow-up view
// ---------------------------------------------------------------------------
let importColsEnsured = false;
async function ensureImportColumns(db: D1Database): Promise<void> {
  if (importColsEnsured) return;
  for (const col of [
    "industry TEXT",
    "location TEXT",
    "website TEXT",
    "import_batch TEXT",
    "contact_role TEXT",
    "original_company TEXT",
    "also_listed_as TEXT",
    "last_contacted_at TEXT",
    "last_reply_at TEXT",
  ]) {
    await db.prepare(`ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS ${col}`).run();
  }
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS ix_sales_leads_batch ON sales_leads (org_id, import_batch)",
    )
    .run();
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS ix_sales_leads_industry ON sales_leads (org_id, industry)",
    )
    .run();
  importColsEnsured = true;
}

// POST /api/sales-leads/import — bring in a bought contact list.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO.
//
// 1. It does not create a customer per lead. POST / does, and that is the
//    owner's own 2026-08-01 ruling ("要不然我不习惯") — a salesperson typing in
//    one lead is about to quote it, so the account has to exist. A bought list
//    is the opposite case: 1,029 scraped names nobody has spoken to. Minting an
//    account for each would put them in the same table the quotations, invoices
//    and statements read from, next to the 7 real customers, and unpicking that
//    afterwards is far harder than never doing it. A lead gets its account when
//    someone actually talks to them.
//
// 2. It does not write anything on `dryRun`. The planner returns what WOULD
//    happen — how many duplicates, how many unreachable — and the operator
//    confirms. On a 1,029-row file you want to see "90 duplicates" before.
app.post("/import", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  await ensureImportColumns(c.var.DB);

  const b = (await c.req.json().catch(() => ({}))) as {
    rows?: RawLeadRow[];
    batchName?: string;
    source?: string;
    dryRun?: boolean;
  };
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (rows.length === 0) return c.json({ success: false, error: "rows required" }, 400);
  if (rows.length > 5000) {
    return c.json({ success: false, error: "too many rows in one import (max 5000)" }, 400);
  }

  const orgId = getOrgId(c);

  // Dedupe against what is already here, not just within the file — the second
  // import of an overlapping list is where duplicates really come from.
  const existing = await c.var.DB.prepare(
    "SELECT phone FROM sales_leads WHERE org_id = ? AND phone IS NOT NULL",
  )
    .bind(orgId)
    .all<{ phone: string }>();
  const { normalizePhone } = await import("../../lib/lead-import");
  const existingKeys = (existing.results ?? [])
    .map((r) => normalizePhone(r.phone))
    .filter(Boolean);

  const plan = planImport(rows, existingKeys);

  if (b.dryRun) {
    return c.json({
      success: true,
      data: {
        dryRun: true,
        summary: plan.summary,
        // A sample, not the lot — the point is to let a person eyeball what the
        // rules did, and 90 identical-looking skip rows teach nothing.
        sampleSkipped: plan.skipped.slice(0, 25),
        sampleInsert: plan.insert.slice(0, 10),
      },
    });
  }

  const batch = makeBatchLabel(b.batchName ?? "import", new Date().toISOString());
  const now = new Date().toISOString();
  const by = actingUserId(c);
  const source = String(b.source ?? "").trim() || "IMPORT";

  // Chunked so one oversized statement cannot blow the parameter limit, and so
  // a partial failure leaves a coherent prefix rather than nothing.
  const CHUNK = 50;
  let inserted = 0;
  for (let i = 0; i < plan.insert.length; i += CHUNK) {
    const slice = plan.insert.slice(i, i + CHUNK);
    await c.var.DB.batch(
      slice.map((r) =>
        c.var.DB.prepare(
          `INSERT INTO sales_leads
             (id, name, company, phone, email, source, stage, est_value_sen, notes,
              assigned_to, org_id, created_by, created_at, updated_at,
              industry, location, website, import_batch, original_company, also_listed_as)
           VALUES (?, ?, ?, ?, ?, ?, 'NEW', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          genId(),
          r.contactName ?? null,
          r.company ?? null,
          r.phone ?? null,
          r.email ?? null,
          source,
          r.notes ?? null,
          null, // unassigned — a bought list is not anyone's yet
          orgId,
          by,
          now,
          now,
          r.industry ?? null,
          r.location ?? null,
          r.website ?? null,
          batch,
          r.originalCompany ?? null,
          r.alsoListedAs?.length ? r.alsoListedAs.join(" | ") : null,
        ),
      ),
    );
    inserted += slice.length;
  }

  return c.json({
    success: true,
    data: { batch, inserted, summary: plan.summary },
  });
});

// DELETE /api/sales-leads/import/:batch — remove one imported list, whole.
//
// The reason the batch label exists. Refuses once any lead in the batch has
// been worked, because deleting those would erase somebody's phone calls: the
// operator sees the count and decides, rather than the system silently keeping
// or silently destroying them.
app.delete("/import/:batch", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  await ensureImportColumns(c.var.DB);
  const batch = c.req.param("batch");
  const orgId = getOrgId(c);
  const force = c.req.query("force") === "true";

  const worked = await c.var.DB.prepare(
    `SELECT COUNT(*) AS n FROM sales_leads
      WHERE org_id = ? AND import_batch = ? AND (stage <> 'NEW' OR last_contacted_at IS NOT NULL)`,
  )
    .bind(orgId, batch)
    .first<{ n: number }>();
  const workedCount = Number(worked?.n ?? 0);

  if (workedCount > 0 && !force) {
    return c.json(
      {
        success: false,
        error: `${workedCount} lead(s) in this batch have already been contacted. Re-send with ?force=true to delete them too.`,
        workedCount,
      },
      409,
    );
  }

  const res = await c.var.DB.prepare(
    "DELETE FROM sales_leads WHERE org_id = ? AND import_batch = ?",
  )
    .bind(orgId, batch)
    .run();
  return c.json({ success: true, data: { batch, deleted: res.meta?.changes ?? null } });
});

// GET /api/sales-leads/batches — what has been imported, for the filter menu.
app.get("/batches", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  await ensureImportColumns(c.var.DB);
  const res = await c.var.DB.prepare(
    `SELECT import_batch AS batch, COUNT(*) AS total,
            SUM(CASE WHEN stage <> 'NEW' THEN 1 ELSE 0 END) AS worked
       FROM sales_leads
      WHERE org_id = ? AND import_batch IS NOT NULL
      GROUP BY import_batch ORDER BY import_batch DESC`,
  )
    .bind(getOrgId(c))
    .all();
  return c.json({ success: true, data: res.results ?? [] });
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
  // Copy the lead's PROVISIONAL catalog into the real customer_products (the
  // "merged into customer on convert" step). Only rows linked to a real product
  // (free-text styles can't map to a SKU) — price_sen becomes the base price.
  // INSERT OR IGNORE keeps it idempotent against the UNIQUE(customerId,productId).
  try {
    const lps = await c.var.DB.prepare(
      "SELECT product_id AS productId, price_sen AS priceSen FROM lead_products WHERE lead_id = ? AND org_id = ? AND product_id IS NOT NULL AND product_id <> ''",
    )
      .bind(leadId, org)
      .all<{ productId: string; priceSen: number | null }>();
    for (const lp of lps.results ?? []) {
      await c.var.DB.prepare(
        `INSERT OR IGNORE INTO customer_products
           (id, customerId, productId, basePriceSen, price1Sen, seatHeightPrices, notes)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      )
        .bind(
          `cp-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
          customerId,
          lp.productId,
          lp.priceSen ?? null,
          "From lead catalog",
        )
        .run();
    }
  } catch {
    // customer_products absent / nothing to copy — safe to skip
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

// ── Lead catalog (provisional product assignments) ──────────────────────────
// Products a lead is being quoted + an optional target price. Provisional only
// (its own table); merged into customer_products on convert.

// GET /api/sales-leads/lead-products?leadId=lead-xxx
app.get("/lead-products", async (c) => {
  const denied = await requirePermission(c, "customers", "read");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  const leadId = c.req.query("leadId");
  if (!leadId) return c.json({ success: false, error: "leadId required" }, 400);
  const res = await c.var.DB.prepare(
    "SELECT * FROM lead_products WHERE lead_id = ? AND org_id = ? ORDER BY created_at DESC",
  )
    .bind(leadId, getOrgId(c))
    .all<Record<string, unknown>>();
  return c.json({ success: true, data: res.results ?? [] });
});

// POST /api/sales-leads/lead-products
app.post("/lead-products", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const leadId = String(b.leadId ?? b.lead_id ?? "");
  if (!leadId) return c.json({ success: false, error: "leadId required" }, 400);
  const productName = String(b.productName ?? b.product_name ?? "").trim();
  const productCode = String(b.productCode ?? b.product_code ?? "").trim();
  if (!productName && !productCode) {
    return c.json({ success: false, error: "a product is required" }, 400);
  }
  const priceRm = b.priceRm ?? b.price_rm;
  const priceSen =
    b.priceSen != null ? Math.round(Number(b.priceSen))
      : priceRm != null && priceRm !== "" ? Math.round(Number(priceRm) * 100)
      : null;
  const id = `lp-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await c.var.DB.prepare(
    `INSERT INTO lead_products
       (id, lead_id, product_id, product_code, product_name, price_sen, org_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      leadId,
      (b.productId as string) ?? (b.product_id as string) ?? null,
      productCode || null,
      productName || null,
      priceSen,
      getOrgId(c),
      new Date().toISOString(),
    )
    .run();
  return c.json({ success: true, data: { id } });
});

// DELETE /api/sales-leads/lead-products/:id
app.delete("/lead-products/:id", async (c) => {
  const denied = await requirePermission(c, "customers", "delete");
  if (denied) return denied;
  await ensureTable(c.var.DB);
  await c.var.DB.prepare("DELETE FROM lead_products WHERE id = ? AND org_id = ?")
    .bind(c.req.param("id"), getOrgId(c))
    .run();
  return c.json({ success: true });
});

export default app;
