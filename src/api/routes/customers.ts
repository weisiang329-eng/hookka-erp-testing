// ---------------------------------------------------------------------------
// D1-backed customers route.
//
// Mirrors the old src/api/routes/customers.ts shape so the SPA frontend
// doesn't need any changes. `deliveryHubs` is returned as a nested array
// joined from the delivery_hubs table (matches the in-memory Customer type).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import {
  denyForeignCustomerWrite,
  canAssignSalesperson,
  forcedSalespersonOnCreate,
} from "../lib/customer-scope";
import type { Context } from "hono";
import type { Env } from "../worker";
import { checkCustomerDeleteLocked, lockedResponse } from "../lib/lock-helpers";
import { requirePermission } from "../lib/rbac";
import { ensureCustomerStageColumns } from "../lib/customer-stage";
import { getOrgId } from "../lib/tenant";
import {
  propagateCustomerName,
  backfillCustomerNames,
} from "../lib/party-name-propagate";
import { parseDebtorCode } from "../../lib/debtor";
import { resolveCompanyCode } from "../../lib/company-dimension";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Multi-Company Phase 4 — per-customer default company.
//
// `customers.default_company_code` (snake_case, runtime self-applied) holds an
// OPTIONAL default company for NEW sales orders from this customer. Empty '' =
// no mapping → the SO create form falls back to HOOKKA exactly as before. This
// column NEVER moves existing orders; it only pre-fills the company selector.
// Runtime-ensured (migration files are inert on deploy — see CLAUDE.md). Idempotent.
// ---------------------------------------------------------------------------
let customerCompanyColEnsured = false;
async function ensureCustomerCompanyColumn(db: D1Database): Promise<void> {
  if (customerCompanyColEnsured) return;
  try {
    await db
      .prepare(
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS default_company_code TEXT NOT NULL DEFAULT ''",
      )
      .run();
    customerCompanyColEnsured = true;
  } catch (err) {
    // Best-effort — a legacy engine without IF NOT EXISTS (or a concurrent
    // add) shouldn't break the whole route; the read side dual-keys + defaults.
    console.warn(
      "[customers] ensureCustomerCompanyColumn:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Normalise a per-customer default company off a request body. Unlike
// `resolveCompanyCode` (which defaults blank → HOOKKA), an empty / missing
// value here means "NO mapping" and is stored as '' so the SO form falls back
// to HOOKKA on its own — a customer with no default is NOT force-pinned to
// HOOKKA. A provided value is canonicalised to an UPPERCASE org code.
function normalizeDefaultCompany(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  return resolveCompanyCode(trimmed);
}

// Debtor-code gate shared by POST + PUT. Returns the canonical (trimmed)
// code on success, or an error string. Enforces: valid format (shared
// `parseDebtorCode`), the derived control account exists & is a debtor
// control (SDC), and the code is unique within the org (`selfId` excludes
// the row being edited). Mirrors the frontend Save check so the operator
// sees the same reject inline instead of a delayed 422.
async function validateDebtorCode(
  c: Context<Env>,
  codeRaw: unknown,
  selfId: string | null,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const code = String(codeRaw ?? "").trim();
  const parsed = parseDebtorCode(code);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const ctrl = await c.var.DB.prepare(
    "SELECT code FROM chart_of_accounts WHERE code = ? AND specialAccountType = 'SDC'",
  )
    .bind(parsed.controlCode)
    .first<{ code: string }>();
  if (!ctrl) {
    return {
      ok: false,
      error: `No debtor control account ${parsed.controlCode} (SDC) in the Chart of Accounts — create it there first.`,
    };
  }
  const dup = await c.var.DB.prepare(
    "SELECT id FROM customers WHERE code = ? AND orgId = ? AND id <> ? LIMIT 1",
  )
    .bind(code, getOrgId(c), selfId ?? "")
    .first<{ id: string }>();
  if (dup) {
    return { ok: false, error: `Customer code ${code} already exists.` };
  }
  return { ok: true, code };
}

type CustomerRow = {
  id: string;
  code: string;
  name: string;
  ssmNo: string | null;
  companyAddress: string | null;
  creditTerms: string | null;
  creditLimitSen: number;
  outstandingSen: number;
  isActive: number;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  // Multi-Company Phase 4 — optional default company for NEW SOs. '' = none.
  default_company_code?: string | null;
  // Multi-Company Phase 3 — dual-identity link (mirror of suppliers.group_org_code).
  // '' / null = a normal external customer (default). A group org code (e.g.
  // "HOUZS") marks this customer as one of our group companies. Dual-keyed read.
  groupOrgCode?: string | null;
  group_org_code?: string | null;
  // OEM product marking JSON ({bedframe,sofa,accessory} → NONE/TAG/LABEL).
  // Dual-keyed: the Supabase driver camelCases every column on read, so a row
  // read back carries `oemMarking`, NOT `oem_marking` (writes still use the
  // snake_case column name). Reading only the snake_case key returned undefined
  // in prod → parsed to all-NONE → the marking "reverted" after every refresh.
  oemMarking?: string | null;
  oem_marking?: string | null;
  // POTENTIAL | CONFIRMED (owner 2026-08-01). Dual-keyed read — the Supabase
  // driver returns these as customerStage / salespersonUserId.
  customerStage?: string | null;
  customer_stage?: string | null;
  salespersonUserId?: string | null;
  salesperson_user_id?: string | null;
};

// Multi-Company Phase 3 — dual-identity column on the customer side. snake_case,
// default '' so nothing changes for a normal external customer. Runtime
// self-apply (deploy does NOT replay migration files). Paired with
// suppliers.group_org_code (ensured in purchase-orders.ts). See
// src/lib/intercompany-mirror.ts.
let custGroupColPromise = false;
async function ensureCustomerGroupColumn(db: D1Database): Promise<void> {
  if (custGroupColPromise) return;

  try {
    await db
      .prepare(
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS group_org_code TEXT NOT NULL DEFAULT ''",
      )
      .run();
    // BUG-CLASS C9: memoise only after the DDL lands (see ensureCustomerOemColumn).
    custGroupColPromise = true;
  } catch {
    // best-effort — column may already exist. Leave the flag false to retry.
  }
}

/** Read-side coalesce for the dual-identity code. '' = external customer. */
function readCustomerGroupOrgCode(row: CustomerRow): string {
  const v = row.groupOrgCode ?? row.group_org_code ?? "";
  return typeof v === "string" && v.trim() ? v.trim().toUpperCase() : "";
}

/** Normalise an incoming group_org_code value (body → stored). '' = external. */
function normaliseGroupOrgCode(raw: unknown): string {
  return typeof raw === "string" && raw.trim() ? raw.trim().toUpperCase() : "";
}

// OEM product marking — per finished-goods category, what to attach for this
// customer: a company TAG, a LABEL, or nothing. Surfaced on the Fab Cut / Fab
// Sew production stickers so the line knows. Stored as a small JSON blob in a
// runtime-added TEXT column (deploy does NOT replay migration files). snake_case.
type OemMark = "NONE" | "TAG" | "LABEL";
type OemMarking = { bedframe: OemMark; sofa: OemMark; accessory: OemMark };
const EMPTY_OEM_MARKING: OemMarking = {
  bedframe: "NONE",
  sofa: "NONE",
  accessory: "NONE",
};
function normOemMark(v: unknown): OemMark {
  return v === "TAG" || v === "LABEL" ? v : "NONE";
}
function parseOemMarking(raw: string | null | undefined): OemMarking {
  try {
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return {
      bedframe: normOemMark(o.bedframe),
      sofa: normOemMark(o.sofa),
      accessory: normOemMark(o.accessory),
    };
  } catch {
    return { ...EMPTY_OEM_MARKING };
  }
}
/** Normalise an incoming oemMarking body value → JSON string for storage. */
function serialiseOemMarking(raw: unknown): string {
  const o = (raw ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    bedframe: normOemMark(o.bedframe),
    sofa: normOemMark(o.sofa),
    accessory: normOemMark(o.accessory),
  });
}

let custOemColPromise = false;
async function ensureCustomerOemColumn(db: D1Database): Promise<void> {
  if (custOemColPromise) return;

  try {
    await db
      .prepare(
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS oem_marking TEXT NOT NULL DEFAULT '{}'",
      )
      .run();
    // BUG-CLASS C9: only memoise AFTER the DDL lands. Setting the flag past the
    // catch remembers a transient ALTER failure as done — the column stays
    // missing and every later oem_marking write in this isolate 500s (the whole
    // customer PUT fails, so OEM + phone + name silently don't save).
    custOemColPromise = true;
  } catch {
    // best-effort — column may already exist. Leave the flag false so a failed
    // round retries on the next call instead of poisoning the isolate.
  }
}

// ---------------------------------------------------------------------------
// customer_stage + salesperson_user_id (owner 2026-08-01).
//
// A customer entered from the Sales Pipeline is a POTENTIAL account: real
// enough to assign SKUs, maintenance config and sofa combos against, and to
// quote from — but NOT billable. It becomes CONFIRMED through the Confirm gate
// (creditor code, terms, credit limit), which is the only place credit is set.
//
// Existing rows default to CONFIRMED: every live customer is a real account.
// Migrations are inert on deploy, so this MUST be a runtime self-apply awaited
// before the first read/write. See CLAUDE.md.
// ---------------------------------------------------------------------------
export const CUSTOMER_STAGES = ["POTENTIAL", "CONFIRMED"] as const;
export type CustomerStage = (typeof CUSTOMER_STAGES)[number];

// Rows come back from Supabase with the driver's snake_case → camelCase
// transform applied (db-pg.ts), so read DUAL-KEYED. A snake-only read here
// would silently return undefined and quietly mark every customer CONFIRMED —
// the same class of bug that killed Component Kits on 2026-08-01.
export function readCustomerStage(row: Record<string, unknown>): CustomerStage {
  const raw = String(row.customerStage ?? row.customer_stage ?? "").toUpperCase();
  return raw === "POTENTIAL" ? "POTENTIAL" : "CONFIRMED";
}
function readSalespersonUserId(row: Record<string, unknown>): string {
  return String(row.salespersonUserId ?? row.salesperson_user_id ?? "" ).trim();
}

type HubRow = {
  id: string;
  customerId: string;
  code: string;
  shortName: string;
  state: string | null;
  address: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  isDefault: number;
};

function rowToCustomer(row: CustomerRow, hubs: HubRow[] = []) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    ssmNo: row.ssmNo ?? "",
    companyAddress: row.companyAddress ?? "",
    creditTerms: row.creditTerms ?? "NET30",
    creditLimitSen: row.creditLimitSen,
    outstandingSen: row.outstandingSen,
    isActive: Boolean(row.isActive),
    contactName: row.contactName ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
    // Multi-Company Phase 4 — surfaced so the SO create form can pre-fill the
    // company selector. Empty string when unmapped (→ HOOKKA fallback).
    defaultCompanyCode: (row.default_company_code ?? "").trim().toUpperCase(),
    groupOrgCode: readCustomerGroupOrgCode(row),
    oemMarking: parseOemMarking(row.oemMarking ?? row.oem_marking),
    // POTENTIAL = created from the Sales Pipeline, not yet billable.
    customerStage: readCustomerStage(row as unknown as Record<string, unknown>),
    salespersonUserId: readSalespersonUserId(row as unknown as Record<string, unknown>),
    deliveryHubs: hubs
      .filter((h) => h.customerId === row.id)
      .map((h) => ({
        id: h.id,
        code: h.code,
        shortName: h.shortName,
        state: h.state ?? "",
        address: h.address ?? "",
        contactName: h.contactName ?? "",
        phone: h.phone ?? "",
        email: h.email ?? "",
        isDefault: Boolean(h.isDefault),
      })),
  };
}

function genId(): string {
  return `cust-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/customers — list all customers + their hubs (org-scoped)
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  await ensureCustomerCompanyColumn(c.var.DB);
  await ensureCustomerStageColumns(c.var.DB);
  // Optional index-backed search (global Ctrl+K palette, ?search=). Partial
  // match on name/code; fires ONLY when present, so the Customers list page
  // (no search param) returns the full list exactly as before.
  const q = (c.req.query("search") || c.req.query("q") || "").trim();
  const custWhere = q
    ? "WHERE orgId = ? AND (name ILIKE ? OR COALESCE(code,'') ILIKE ?) ORDER BY code LIMIT 20"
    : "WHERE orgId = ? ORDER BY code";
  const custBinds = q ? [orgId, `%${q}%`, `%${q}%`] : [orgId];
  const [customers, hubs] = await Promise.all([
    c.var.DB.prepare(`SELECT * FROM customers ${custWhere}`)
      .bind(...custBinds)
      .all<CustomerRow>(),
    c.var.DB.prepare("SELECT * FROM delivery_hubs WHERE orgId = ?")
      .bind(orgId)
      .all<HubRow>(),
  ]);
  // Bucket hubs by customerId ONCE (was O(customers×hubs): rowToCustomer
  // re-filtered the whole hubs array per customer). Byte-identical output —
  // rowToCustomer still filters, now over the pre-scoped bucket (passthrough).
  const hubsByCustomer = new Map<string, HubRow[]>();
  for (const h of hubs.results ?? []) {
    const arr = hubsByCustomer.get(h.customerId);
    if (arr) arr.push(h);
    else hubsByCustomer.set(h.customerId, [h]);
  }
  const data = (customers.results ?? []).map((r) =>
    rowToCustomer(r, hubsByCustomer.get(r.id) ?? []),
  );
  return c.json({ success: true, data });
});

// POST /api/customers — create
app.post("/", async (c) => {
  const denied = await requirePermission(c, "customers", "create");
  if (denied) return denied;
  await ensureCustomerCompanyColumn(c.var.DB);
  await ensureCustomerStageColumns(c.var.DB);
  try {
    const body = await c.req.json();
    const { code, name } = body;
    // POTENTIAL accounts are born in the Sales Pipeline, where the salesperson
    // has a company name and a contact but no creditor code yet — demanding one
    // there would just breed junk codes. The code becomes mandatory at the
    // Confirm gate (PUT below), which is also where credit terms/limit are set.
    // A POTENTIAL customer is barred from every money document, so an account
    // without a code can never reach the ledger.
    const stage: CustomerStage =
      String(body.customerStage ?? body.customer_stage ?? "").toUpperCase() === "POTENTIAL"
        ? "POTENTIAL"
        : "CONFIRMED";
    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }
    if (stage === "CONFIRMED" && !code) {
      return c.json(
        { success: false, error: "code and name are required" },
        400,
      );
    }
    let debtorCode = "";
    if (code) {
      const dv = await validateDebtorCode(c, body.code, null);
      if (!dv.ok) return c.json({ success: false, error: dv.error }, 400);
      debtorCode = dv.code;
    }
    await ensureCustomerGroupColumn(c.var.DB);
    await ensureCustomerOemColumn(c.var.DB);
    const id = genId();
    const isActive = body.isActive === false ? 0 : 1;
    const groupOrgCode = normaliseGroupOrgCode(body.groupOrgCode);

    // Tier D D5 fix 2026-05-21 — back-door write removed.
    // outstandingSen is a derived A/R balance owned by the invoice +
    // payment + CN/DN ledger. The customers create form has no input
    // cell for it; accepting `body.outstandingSen` here let admin
    // scripts (and any caller hand-crafting a POST) seed an arbitrary
    // opening balance that has no supporting invoice row, so the next
    // payment posting would either over- or under-decrement against
    // ghost A/R. Force to 0 at creation; the value will move only
    // through the invoice / payment / CN / DN routes' atomic SQL.
    await c.var.DB.prepare(
      // orgId is stamped explicitly rather than left to the column DEFAULT.
      // GET / (above) reads `WHERE orgId = ?` off getOrgId(c), so a customer
      // created by a user in any org other than the DEFAULT would save, 201,
      // and then be invisible to the very list that created it. Identical on
      // prod today — DEFAULT_ORG_ID and the migration-0049 column DEFAULT are
      // both 'hookka' — so this is byte-identical now and correct later.
      // Same reasoning, and the same wording, as the delivery_hubs stamp below.
      `INSERT INTO customers (id, code, name, ssmNo, companyAddress, creditTerms,
         creditLimitSen, outstandingSen, isActive, contactName, phone, email,
         default_company_code, group_org_code, oem_marking,
         customer_stage, salesperson_user_id, orgId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        debtorCode,
        body.name,
        body.ssmNo ?? "",
        body.companyAddress ?? "",
        body.creditTerms ?? "NET30",
        body.creditLimitSen ?? 0,
        0,
        isActive,
        body.contactName ?? "",
        body.phone ?? "",
        body.email ?? "",
        // Multi-Company Phase 4 — optional default company ('' = none).
        normalizeDefaultCompany(body.defaultCompanyCode),
        groupOrgCode,
        serialiseOemMarking(body.oemMarking),
        stage,
        // A scoped role owns what it creates. Otherwise a salesperson raises a
        // Potential in the pipeline and the read filter hides it the moment it
        // is saved — they would watch their own work vanish.
        forcedSalespersonOnCreate(c) ??
          (String(body.salespersonUserId ?? body.salesperson_user_id ?? "").trim() || null),
        getOrgId(c),
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM customers WHERE id = ?",
    )
      .bind(id)
      .first<CustomerRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create customer" },
        500,
      );
    }
    return c.json({ success: true, data: rowToCustomer(created, []) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/customers/:id — single customer + hubs
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  await ensureCustomerCompanyColumn(c.var.DB);
  const [cust, hubsRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM customers WHERE id = ?")
      .bind(id)
      .first<CustomerRow>(),
    c.var.DB.prepare("SELECT * FROM delivery_hubs WHERE customerId = ?")
      .bind(id)
      .all<HubRow>(),
  ]);
  if (!cust) {
    return c.json({ success: false, error: "Customer not found" }, 404);
  }
  return c.json({ success: true, data: rowToCustomer(cust, hubsRes.results ?? []) });
});

// ---------------------------------------------------------------------------
// POST /api/customers/_backfill-snapshot-names — one-shot (owner 2026-08-01).
//
// Realigns every id-keyed customer_name snapshot (14 tables) to the customers
// master, fixing renames made before propagation shipped. Idempotent — a second
// run reports 0 rows. The 7 id-less tables (e_invoices, fg_units,
// production_orders, qc_inspections, rack_items, rack_locations,
// schedule_entries) have nothing to join on and are returned as
// `notBackfillable`; the rename hook keeps them current from now on.
// Optional body { customerId } scopes it to one customer.
// ---------------------------------------------------------------------------
app.post("/_backfill-snapshot-names", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  let customerId: string | null = null;
  try {
    const body = (await c.req.json()) as { customerId?: unknown };
    if (typeof body?.customerId === "string" && body.customerId.trim()) {
      customerId = body.customerId.trim();
    }
  } catch {
    /* no body = every customer */
  }
  const r = await backfillCustomerNames(
    c.var.DB as unknown as Parameters<typeof backfillCustomerNames>[0],
    customerId,
  );
  console.info(
    `[backfill-snapshot-names customers] scope=${customerId ?? "ALL"} rows=${r.totalRows}`,
  );
  return c.json({ success: true, data: r });
});

// PUT /api/customers/:id — update
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "customers", "update");
  if (denied) return denied;
  await ensureCustomerCompanyColumn(c.var.DB);
  await ensureCustomerStageColumns(c.var.DB);
  const id = c.req.param("id");
  try {
    await ensureCustomerGroupColumn(c.var.DB);
    await ensureCustomerOemColumn(c.var.DB);
    const existing = await c.var.DB.prepare(
      "SELECT * FROM customers WHERE id = ?",
    )
      .bind(id)
      .first<CustomerRow>();
    // A scoped role may only edit its OWN customers. The response filter hides
    // other people's on the way out; it cannot stop a PUT on the way in.
    const foreign = await denyForeignCustomerWrite(c, id);
    if (foreign) return foreign;
    if (!existing) {
      return c.json({ success: false, error: "Customer not found" }, 404);
    }
    const body = await c.req.json();

    // Only re-validate the debtor code when it's actually changing — don't
    // block edits to other fields on a customer whose code predates this
    // rule.
    if (
      body.code !== undefined &&
      String(body.code).trim() !== existing.code
    ) {
      const dv = await validateDebtorCode(c, body.code, id);
      if (!dv.ok) return c.json({ success: false, error: dv.error }, 400);
    }

    // Tier D D5 fix 2026-05-21 — back-door write removed.
    // outstandingSen is derived from the invoice + payment + CN/DN
    // ledger. The customer edit dialog has no input cell for it, so any
    // value arriving in `body.outstandingSen` came from a hand-crafted
    // PUT or stale admin script. Pinning to existing prevents a one-off
    // PUT from silently overwriting the ledger-derived balance with
    // whatever the caller felt like. The four legitimate writers
    // (invoices.ts AR add, payments.ts decrement on POST + GREATEST
    // rollback on BOUNCED, credit-notes.ts decrement, debit-notes.ts
    // increment) all use atomic `outstandingSen = outstandingSen +/- ?`
    // SQL and never touch this PUT route.
    // Confirm gate (owner 2026-08-01). Promoting POTENTIAL → CONFIRMED is the
    // moment the account becomes billable, so the creditor code stops being
    // optional right here. Demotion back to POTENTIAL is refused: the account
    // may already carry invoices, and silently making it unusable on new
    // documents would be a far worse surprise than a 400.
    const prevStage = readCustomerStage(existing as unknown as Record<string, unknown>);
    const askedStage = String(
      body.customerStage ?? body.customer_stage ?? "",
    ).toUpperCase();
    const nextStage: CustomerStage =
      askedStage === "CONFIRMED" ? "CONFIRMED" : askedStage === "POTENTIAL" ? "POTENTIAL" : prevStage;
    if (prevStage === "CONFIRMED" && nextStage === "POTENTIAL") {
      return c.json(
        { success: false, error: "a confirmed customer cannot be moved back to potential" },
        400,
      );
    }
    const mergedCode =
      body.code !== undefined ? String(body.code).trim() : existing.code;
    if (nextStage === "CONFIRMED" && !mergedCode) {
      return c.json(
        { success: false, error: "a creditor code is required to confirm this customer" },
        400,
      );
    }

    const merged = {
      code: mergedCode,
      name: body.name ?? existing.name,
      ssmNo: body.ssmNo ?? existing.ssmNo ?? "",
      companyAddress: body.companyAddress ?? existing.companyAddress ?? "",
      creditTerms: body.creditTerms ?? existing.creditTerms ?? "NET30",
      creditLimitSen: body.creditLimitSen ?? existing.creditLimitSen,
      outstandingSen: existing.outstandingSen,
      isActive:
        body.isActive === undefined
          ? existing.isActive
          : body.isActive
            ? 1
            : 0,
      contactName: body.contactName ?? existing.contactName ?? "",
      phone: body.phone ?? existing.phone ?? "",
      email: body.email ?? existing.email ?? "",
      // Multi-Company Phase 4 — only changes when the caller explicitly sends
      // defaultCompanyCode; a header-only edit preserves the existing mapping.
      // An explicit '' clears the mapping (→ HOOKKA fallback on new SOs).
      default_company_code:
        body.defaultCompanyCode !== undefined
          ? normalizeDefaultCompany(body.defaultCompanyCode)
          : (existing.default_company_code ?? ""),
      // Multi-Company Phase 3 — dual-identity. Only changes when the body sends
      // it; otherwise the existing flag is preserved (additive, opt-in).
      groupOrgCode:
        body.groupOrgCode === undefined
          ? readCustomerGroupOrgCode(existing)
          : normaliseGroupOrgCode(body.groupOrgCode),
      // OEM marking — only changes when the body sends oemMarking; otherwise
      // the existing setting is preserved.
      oem_marking:
        body.oemMarking === undefined
          ? (existing.oemMarking ?? existing.oem_marking ?? "{}")
          : serialiseOemMarking(body.oemMarking),
      // Confirm gate: POTENTIAL → CONFIRMED. Only moves when the body sends it.
      customer_stage: nextStage,
      // Reassigning the salesperson is how an account would be handed away —
      // or quietly taken. A scoped role keeps whatever is already there; only
      // roles that see the whole book may change it.
      salesperson_user_id:
        !canAssignSalesperson(c) ||
        (body.salespersonUserId === undefined && body.salesperson_user_id === undefined)
          ? (readSalespersonUserId(existing as unknown as Record<string, unknown>) || null)
          : String(body.salespersonUserId ?? body.salesperson_user_id ?? "").trim() || null,
    };

    await c.var.DB.prepare(
      `UPDATE customers SET
         code = ?, name = ?, ssmNo = ?, companyAddress = ?, creditTerms = ?,
         creditLimitSen = ?, outstandingSen = ?, isActive = ?,
         contactName = ?, phone = ?, email = ?, default_company_code = ?, group_org_code = ?,
         oem_marking = ?, customer_stage = ?, salesperson_user_id = ?
       WHERE id = ?`,
    )
      .bind(
        merged.code,
        merged.name,
        merged.ssmNo,
        merged.companyAddress,
        merged.creditTerms,
        merged.creditLimitSen,
        merged.outstandingSen,
        merged.isActive,
        merged.contactName,
        merged.phone,
        merged.email,
        merged.default_company_code,
        merged.groupOrgCode,
        merged.oem_marking,
        merged.customer_stage,
        merged.salesperson_user_id,
        id,
      )
      .run();

    // ---- Sync delivery_hubs ----
    // Frontend sends the FULL hub array on every customer save (the customers
    // page mutates `customer.deliveryHubs` locally, then PUTs the whole
    // record). Diff strategy:
    //   - DELETE rows whose id isn't in the incoming array (preserves FK
    //     refs from sales_orders.hubId / delivery_orders.hubId /
    //     consignment_orders.hubId — those FKs are ON DELETE SET NULL,
    //     so dropping a hub orphans those refs).
    //   - UPSERT each incoming hub on its id (so existing hubs keep
    //     their id and SO/DO/CO refs stay valid).
    // This is the missing half of the save path — pre-fix the PUT only
    // updated the customers row, so hubs added in the UI evaporated on
    // page reload.
    if (Array.isArray(body.deliveryHubs)) {
      type IncomingHub = {
        id?: string;
        code?: string;
        shortName?: string;
        state?: string;
        address?: string;
        contactName?: string;
        phone?: string;
        email?: string;
        isDefault?: boolean;
      };
      const incoming = (body.deliveryHubs as IncomingHub[]).filter(
        (h) => typeof h?.id === "string" && h.id.length > 0,
      );

      // Deletions are EXPLICIT-ONLY (BUG-2026-07-27-002). The old diff
      // strategy deleted every hub missing from the incoming array — so a
      // save from any stale tab / cached page silently wiped hubs added
      // elsewhere (the owner's newly created hub kept vanishing). The FE
      // now names deletions in body.deletedHubIds; hubs are otherwise only
      // UPSERTed, never dropped. FK refs stay ON DELETE SET NULL.
      const deletedHubIds = Array.isArray(
        (body as { deletedHubIds?: unknown }).deletedHubIds,
      )
        ? ((body as { deletedHubIds?: unknown[] }).deletedHubIds ?? []).filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          )
        : [];
      for (const delId of deletedHubIds) {
        await c.var.DB.prepare(
          "DELETE FROM delivery_hubs WHERE id = ? AND customerId = ?",
        )
          .bind(delId, id)
          .run();
      }

      // New hubs inherit the customer's org so org-scoped readers (scan-PO
      // catalog, customers list join) can see them instead of relying on
      // the column DEFAULT.
      const custOrgId =
        (existing as { orgId?: string | null; org_id?: string | null }).orgId ??
        (existing as { orgId?: string | null; org_id?: string | null }).org_id ??
        "hookka";

      for (const h of incoming) {
        if (deletedHubIds.includes(h.id as string)) continue;
        await c.var.DB.prepare(
          `INSERT INTO delivery_hubs
             (id, customerId, code, shortName, state, address, contactName, phone, email, isDefault, orgId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             code = excluded.code,
             shortName = excluded.shortName,
             state = excluded.state,
             address = excluded.address,
             contactName = excluded.contactName,
             phone = excluded.phone,
             email = excluded.email,
             isDefault = excluded.isDefault`,
        )
          .bind(
            h.id ?? "",
            id,
            h.code ?? "",
            h.shortName ?? "",
            h.state ?? null,
            h.address ?? null,
            h.contactName ?? null,
            h.phone ?? null,
            h.email ?? null,
            h.isDefault ? 1 : 0,
            custOrgId,
          )
          .run();
      }
    }

    // A rename must reach the 21 tables that snapshotted customer_name at
    // create time — their read paths don't join customers, so without this the
    // correction is invisible on every existing SO / DO / invoice / production
    // order / schedule row / rack label (owner 2026-08-01). 14 are keyed by
    // customer_id; the other 7 carry no id and are matched on the old name.
    // Owner ruling: propagate to financial documents too.
    if (merged.name !== existing.name) {
      const prop = await propagateCustomerName(
        c.var.DB as unknown as Parameters<typeof propagateCustomerName>[0],
        id,
        existing.name,
        merged.name,
      );
      console.info(
        `[PUT /api/customers/${id}] renamed "${prop.oldName}" → "${prop.newName}": ${prop.totalRows} row(s) across ${prop.tables.filter((t) => t.updated !== null).length} table(s)`,
      );
    }

    const hubsRes = await c.var.DB.prepare(
      "SELECT * FROM delivery_hubs WHERE customerId = ?",
    )
      .bind(id)
      .all<HubRow>();
    return c.json({
      success: true,
      data: rowToCustomer({ ...existing, ...merged, id }, hubsRes.results ?? []),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/customers/:id — cascades via FK to delivery_hubs.
// Cascade-lock guard: blocks the delete if the customer is referenced by
// any non-cancelled SO/CO/DO/CN/Invoice. Returns 409 with a hint listing
// the blocking documents so the operator can clean those up first.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "customers", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM customers WHERE id = ?",
  )
    .bind(id)
    .first<CustomerRow>();
  if (!existing) {
    return c.json({ success: false, error: "Customer not found" }, 404);
  }
  const lockMsg = await checkCustomerDeleteLocked(c.var.DB, id);
  if (lockMsg) {
    return c.json(lockedResponse(lockMsg), 409);
  }
  await c.var.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: rowToCustomer(existing, []) });
});

export default app;
