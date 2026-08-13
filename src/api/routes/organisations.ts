// ---------------------------------------------------------------------------
// Organisations route — multi-org registry.
//
// Existing behaviour (READ): GET returns
//   { organisations, activeOrgId, interCompanyConfig }
// with no `success` wrapper. The Settings → Organisations page and the
// sidebar org switcher consume this shape directly — DO NOT change it.
//
// New behaviour (CRUD): POST / PATCH / DELETE allow the operator to manage
// sister companies (HOUZS, etc) from the same Settings page. Letterhead
// override is purely cosmetic — the actual buyer/AP entity is always HOOKKA
// (see src/lib/generate-purchase-order-pdf.ts).
//
// Graceful fallback: if the new columns from migration 0142 haven't been
// applied yet, GET falls back to the legacy column set (and to a hardcoded
// HOOKKA + OHANA list if even the base table is missing) so the page keeps
// working between deploy and migration apply.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { runSelfApply } from "../lib/self-apply";
import type { Env } from "../worker";
import { hasPermission, requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

type OrganisationRow = {
  id: string;
  code: string;
  name: string;
  regNo: string | null;
  tin: string | null;
  msic: string | null;
  msicCode: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  businessType: string | null;
  letterheadUrl: string | null;
  transferPricingPct: number;
  isActive: number;
  isDefault: boolean | number | null;
  displayOrder: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type InterCompanyConfigRow = {
  id: number;
  hookkaToOhanaRate: number;
  autoCreateMirrorDocs: number;
  activeOrgId: string | null;
};

function rowToOrg(row: OrganisationRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    regNo: row.regNo ?? "",
    tin: row.tin ?? "",
    // Expose msic for the legacy field and msicCode for the new UI; keep
    // both populated so the existing Settings page (msic) keeps rendering
    // and the new CRUD form (msicCode) works.
    msic: row.msicCode ?? row.msic ?? "",
    msicCode: row.msicCode ?? row.msic ?? "",
    address: row.address ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
    businessType: row.businessType ?? "",
    letterheadUrl: row.letterheadUrl ?? "",
    transferPricingPct: row.transferPricingPct,
    isActive: row.isActive === 1,
    isDefault: row.isDefault === true || row.isDefault === 1,
    displayOrder: row.displayOrder ?? 0,
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

// The SWITCHER's view of an organisation (BUG-2026-08-13-100).
//
// Every authenticated user needs this list — the sidebar company switcher
// renders for all staff — but the full row is a company IDENTITY record: TIN,
// registration number, registered address, phone and email for all four
// companies. That is not switcher data, and it was going to every logged-in
// user of every role.
//
// This projection is what the non-privileged consumers actually read, verified
// against the real call sites rather than guessed:
//   • sidebar.tsx:427            → id, code, name (+ top-level activeOrgId)
//   • sales/create.tsx:238       → code, name, isActive
//   • sales/index.tsx:331        → code, name, isActive
//   • customers.tsx:3411         → code, name, isActive
// `displayOrder` rides along because it is the list's own sort key and carries
// nothing about the company.
//
// The sensitive keys are OMITTED, not blanked. That distinction is the whole
// point: C16 ("a field the projection drops and a consumer still reads") is
// exactly how `letterheadForPurchaseOrg` would have started printing
// "Reg.  | TIN " on purchase documents. An absent key lets that resolver fall
// back to its hardcoded letterhead; an empty string would not.
function minimalOf(org: ReturnType<typeof rowToOrg>) {
  return {
    id: org.id,
    code: org.code,
    name: org.name,
    isActive: org.isActive,
    displayOrder: org.displayOrder,
  };
}

function rowToConfig(row: InterCompanyConfigRow) {
  return {
    hookkaToOhanaRate: row.hookkaToOhanaRate,
    autoCreateMirrorDocs: row.autoCreateMirrorDocs === 1,
  };
}

// Postgres raises 42703 "column ... does not exist" when migration 0142
// hasn't been applied. We catch it and fall back to the legacy column set
// so the GET keeps responding (and the rest of the dashboard keeps loading).
// `org_id` is in the list for the same reason as the rest: the tenant predicate
// added 2026-08-13 is written against a column that reaches prod through
// `ensureOrganisationRegistry`, and an environment that has not run it yet must
// degrade to the LEGACY (unscoped) read — not to FALLBACK_ORGS, which would
// silently replace the real registry with two hardcoded companies.
// (Production does have the column: `tests/db-schema.json`, regenerated from
// prod, lists `org_id` on `organisations`.)
function isMissingNewColumn(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /column .*(business_type|is_default|display_order|msic_code|letterhead_url|org_id).* does not exist/i.test(
    msg,
  );
}

function isMissingTable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /relation .*organisations.* does not exist|no such table.*organisations/i.test(
    msg,
  );
}

// Hardcoded HOOKKA + OHANA — used only when the organisations table itself
// doesn't exist on a brand-new environment. Keeps the page rendering during
// the very first deploy.
const FALLBACK_ORGS = [
  {
    id: "org-hookka",
    code: "HOOKKA",
    name: "HOOKKA INDUSTRIES SDN BHD",
    regNo: "202501060540 (1661946-X)",
    tin: "C60515534080",
    msic: "31009",
    msicCode: "31009",
    address:
      "2775F, Jalan Industri 12, Kampung Baru Sungai Buloh, 47000 Sungai Buloh, Selangor",
    phone: "+6011-6133 3173",
    email: "finance@hookka.com",
    businessType: "Production & Manufacturing",
    letterheadUrl: "",
    transferPricingPct: 0,
    isActive: true,
    isDefault: true,
    displayOrder: 0,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "org-ohana",
    code: "OHANA",
    name: "OHANA MARKETING SDN BHD",
    regNo: "202501058806 (1660212-M)",
    tin: "C60508048080",
    msic: "47591",
    msicCode: "47591",
    address:
      "The Nest Residence, A-28-07 Jalan A Off, Jalan Puchong, 58200 Kuala Lumpur",
    phone: "+6010-233 1323",
    email: "ohanastudio99@gmail.com",
    businessType: "B2B Trading & Distribution",
    letterheadUrl: "",
    transferPricingPct: 0,
    isActive: true,
    isDefault: false,
    displayOrder: 1,
    createdAt: "",
    updatedAt: "",
  },
];

const SELECT_COLS_NEW =
  "id, code, name, reg_no, tin, msic, msic_code, address, phone, email, business_type, letterhead_url, transfer_pricing_pct, is_active, is_default, display_order, created_at, updated_at";
const SELECT_COLS_LEGACY =
  "id, code, name, reg_no, tin, msic, address, phone, email, transfer_pricing_pct, is_active";

const SELECT_NEW = `SELECT ${SELECT_COLS_NEW} FROM organisations WHERE org_id = ? ORDER BY display_order, code`;
const SELECT_LEGACY = `SELECT ${SELECT_COLS_LEGACY} FROM organisations ORDER BY code`;
const SELECT_ONE_NEW = `SELECT ${SELECT_COLS_NEW} FROM organisations WHERE id = ? AND org_id = ?`;

async function loadOrganisations(
  db: D1Database,
  orgId: string,
): Promise<ReturnType<typeof rowToOrg>[]> {
  try {
    const res = await db.prepare(SELECT_NEW).bind(orgId).all<OrganisationRow>();
    return (res.results ?? []).map(rowToOrg);
  } catch (e) {
    if (isMissingNewColumn(e)) {
      const res = await db.prepare(SELECT_LEGACY).all<OrganisationRow>();
      return (res.results ?? []).map(rowToOrg);
    }
    if (isMissingTable(e)) {
      return FALLBACK_ORGS;
    }
    throw e;
  }
}

// Runtime self-apply of migration 0142 (organisations registry). Migrations do
// NOT auto-apply on deploy, so on a prod where 0142 was never pasted the table
// still carries the legacy CHECK (code IN ('HOOKKA','OHANA')) and lacks the new
// columns — any attempt to create a sister company would 500. This mirrors the
// ensureScanPoColumns / ensureDistillColumns pattern: idempotent, best-effort,
// runs once per isolate before the first write. Only adds columns + drops the
// over-restrictive CHECK — never removes data.
let orgRegistryPromise: Promise<void> | null = null;
function ensureOrganisationRegistry(db: D1Database): Promise<void> {
  if (orgRegistryPromise) return orgRegistryPromise;
  orgRegistryPromise = (async () => {
    const stmts = [
      // Postgres names an inline column CHECK `<table>_<column>_check`.
      "ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_code_check",
      "ALTER TABLE organisations ADD COLUMN IF NOT EXISTS org_id text NOT NULL DEFAULT 'hookka'",
      "ALTER TABLE organisations ADD COLUMN IF NOT EXISTS msic_code text NOT NULL DEFAULT ''",
      "ALTER TABLE organisations ADD COLUMN IF NOT EXISTS business_type text NOT NULL DEFAULT ''",
      "ALTER TABLE organisations ADD COLUMN IF NOT EXISTS letterhead_url text NOT NULL DEFAULT ''",
      "ALTER TABLE organisations ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false",
      "ALTER TABLE organisations ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0",
      "ALTER TABLE organisations ADD COLUMN IF NOT EXISTS created_at text",
      "ALTER TABLE organisations ADD COLUMN IF NOT EXISTS updated_at text",
      "CREATE UNIQUE INDEX IF NOT EXISTS organisations_code_per_org_uniq ON organisations (org_id, code)",
      "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS purchase_org_code text NOT NULL DEFAULT 'HOOKKA'",
    ];
    await runSelfApply(db, "organisations", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    orgRegistryPromise = null;
    throw err;
  });
  return orgRegistryPromise;
}

// GET /api/organisations — list + active org + inter-company config.
//
// Deliberately NOT gated as a whole (BUG-2026-08-13-100). The sidebar company
// switcher calls this on every page load for every authenticated user, and the
// four companies are one owner's group whose staff work across all of them —
// a fix that empties the switcher for ordinary staff would be worse than the
// exposure it closes. So the ENDPOINT stays open to any signed-in caller and
// the RECORD is what narrows: `organisations:read` gets the registry row,
// everyone else gets the switcher projection.
//
// `purchase-orders:read` is the SECOND key, and it is not a widening: the PO /
// GRN / PI letterhead — legal name, registration number, TIN, registered
// address — is resolved IN THE BROWSER from this endpoint
// (`letterheadForPurchaseOrg`, generate-purchase-order-pdf.ts). Anyone who may
// read a purchase document already prints these fields; withholding them here
// would not protect anything, it would print a blank Reg. No. and TIN on a
// tax-relevant document.
//
// Gating on the DOCUMENT resource rather than granting QA `organisations:read`
// is deliberate. `nav-permissions.ts` maps /settings/organisations to
// `organisations`, and `hiddenNavPrefixes` unhides a link on `:read` — so the
// grant would also have put the registry ADMIN page in QA's menu, a page whose
// every button is `organisations:update` and would 403. `tests/role-policy.mjs`
// caught exactly that.
//
// Net effect: SUPER_ADMIN / ADMIN (rbac wildcard), OFFICE, QA, and the
// DB-defined roles riding rbac's `*:read` fail-safe keep the full registry.
// SALES, HR and R&D get the projection — and none of their screens read
// anything outside it (verified against every call site).
app.get("/", async (c) => {
  const full =
    (await hasPermission(c, "organisations", "read")) ||
    (await hasPermission(c, "purchase-orders", "read"));
  let organisations: ReturnType<typeof rowToOrg>[];
  let cfg: InterCompanyConfigRow | null = null;
  try {
    [organisations, cfg] = await Promise.all([
      loadOrganisations(c.var.DB, getOrgId(c)),
      c.var.DB
        .prepare("SELECT * FROM inter_company_config WHERE id = 1")
        .first<InterCompanyConfigRow>(),
    ]);
  } catch {
    organisations = FALLBACK_ORGS;
    cfg = null;
  }
  const activeOrgId = cfg?.activeOrgId ?? organisations[0]?.id ?? null;
  if (!full) {
    // `interCompanyConfig` is withheld with the rest: `hookkaToOhanaRate` is
    // the inter-company transfer price. Its only reader is the Settings →
    // Organisations page (`settings/organisations.tsx:104`), which guards on
    // the key being present and keeps its own default when it is absent.
    return c.json({
      organisations: organisations.map(minimalOf),
      activeOrgId,
      // A consumer must be able to tell "reduced" from "blank" without
      // inferring it from empty strings — see the C16 note on minimalOf.
      restricted: true,
    });
  }
  return c.json({
    organisations,
    activeOrgId,
    interCompanyConfig: cfg
      ? rowToConfig(cfg)
      : { hookkaToOhanaRate: 0.65, autoCreateMirrorDocs: true },
  });
});

// POST /api/organisations — create a new sister organisation.
// Body: { code, name, regNo?, tin?, msicCode?, phone?, email?, address?,
//         businessType?, isDefault?, letterheadUrl? }
app.post("/", async (c) => {
  const denied = await requirePermission(c, "organisations", "update");
  if (denied) return denied;
  await ensureOrganisationRegistry(c.var.DB);
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const name =
    typeof body.name === "string"
      ? body.name.trim()
      : typeof body.legalName === "string"
        ? body.legalName.trim()
        : "";
  if (!code || !name) {
    return c.json({ error: "code and name are required" }, 400);
  }
  // Uniqueness check (per tenant). Postgres unique index would catch it too
  // but a friendly 409 is nicer than the raw constraint error.
  //
  // The predicate said "per tenant" and was not: it matched `code` across the
  // WHOLE table, so tenant B could not create HOOKKA because tenant A had one,
  // and the 409 leaked that a code exists in a book the caller cannot see. It
  // now matches the `(org_id, code)` unique index it is standing in front of.
  const orgId = getOrgId(c);
  try {
    const dup = await c.var.DB.prepare(
      "SELECT id FROM organisations WHERE code = ? AND org_id = ?",
    )
      .bind(code, orgId)
      .first<{ id: string }>();
    if (dup) return c.json({ error: "Organisation code already exists" }, 409);
  } catch {
    // table missing — table-create path below will surface the real error
  }

  const id = `org-${code.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const msicCode =
    typeof body.msicCode === "string"
      ? body.msicCode
      : typeof body.msic === "string"
        ? body.msic
        : "";

  try {
    await c.var.DB
      .prepare(
        `INSERT INTO organisations
           (id, org_id, code, name, reg_no, tin, msic, msic_code, address, phone, email,
            business_type, letterhead_url, transfer_pricing_pct, is_active,
            is_default, display_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        // Was the literal "hookka" — a second tenant's new company would have
        // been stamped into the first tenant's book (C12, write-side stamping).
        orgId,
        code,
        name,
        typeof body.regNo === "string" ? body.regNo : "",
        typeof body.tin === "string" ? body.tin : "",
        msicCode,
        msicCode,
        typeof body.address === "string" ? body.address : "",
        typeof body.phone === "string" ? body.phone : "",
        typeof body.email === "string" ? body.email : "",
        typeof body.businessType === "string" ? body.businessType : "",
        typeof body.letterheadUrl === "string" ? body.letterheadUrl : "",
        0,
        1,
        body.isDefault === true ? true : false,
        typeof body.displayOrder === "number" ? body.displayOrder : 99,
        now,
        now,
      )
      .run();
  } catch (e) {
    return c.json(
      {
        error: "Failed to create organisation",
        detail: e instanceof Error ? e.message : String(e),
      },
      500,
    );
  }
  return c.json({ id, code, name }, 201);
});

// PATCH /api/organisations/:id — update a single organisation row.
app.patch("/:id", async (c) => {
  const denied = await requirePermission(c, "organisations", "update");
  if (denied) return denied;
  // The tenant predicate below is written against `org_id`; run the registry
  // self-apply first so the column exists rather than 500-ing the save on an
  // environment that never ran migration 0142 (CLAUDE.md — migrations are
  // inert on deploy).
  await ensureOrganisationRegistry(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const existing = await c.var.DB
    .prepare("SELECT * FROM organisations WHERE id = ? AND org_id = ?")
    .bind(id, orgId)
    .first<OrganisationRow>();
  if (!existing) return c.json({ error: "Organisation not found" }, 404);

  const merged = {
    code:
      typeof body.code === "string" ? body.code.trim().toUpperCase() : existing.code,
    name:
      typeof body.name === "string"
        ? body.name.trim()
        : typeof body.legalName === "string"
          ? (body.legalName as string).trim()
          : existing.name,
    regNo: typeof body.regNo === "string" ? body.regNo : existing.regNo ?? "",
    tin: typeof body.tin === "string" ? body.tin : existing.tin ?? "",
    msicCode:
      typeof body.msicCode === "string"
        ? body.msicCode
        : typeof body.msic === "string"
          ? (body.msic as string)
          : existing.msicCode ?? existing.msic ?? "",
    address:
      typeof body.address === "string" ? body.address : existing.address ?? "",
    phone: typeof body.phone === "string" ? body.phone : existing.phone ?? "",
    email: typeof body.email === "string" ? body.email : existing.email ?? "",
    businessType:
      typeof body.businessType === "string"
        ? body.businessType
        : existing.businessType ?? "",
    letterheadUrl:
      typeof body.letterheadUrl === "string"
        ? body.letterheadUrl
        : existing.letterheadUrl ?? "",
    isDefault:
      body.isDefault === undefined
        ? existing.isDefault === true || existing.isDefault === 1
        : body.isDefault === true,
    displayOrder:
      typeof body.displayOrder === "number"
        ? body.displayOrder
        : existing.displayOrder ?? 0,
  };

  const now = new Date().toISOString();
  try {
    await c.var.DB
      .prepare(
        `UPDATE organisations SET
           code = ?, name = ?, reg_no = ?, tin = ?, msic = ?, msic_code = ?,
           address = ?, phone = ?, email = ?, business_type = ?,
           letterhead_url = ?, is_default = ?, display_order = ?, updated_at = ?
         WHERE id = ? AND org_id = ?`,
      )
      .bind(
        merged.code,
        merged.name,
        merged.regNo,
        merged.tin,
        merged.msicCode,
        merged.msicCode,
        merged.address,
        merged.phone,
        merged.email,
        merged.businessType,
        merged.letterheadUrl,
        merged.isDefault,
        merged.displayOrder,
        now,
        id,
        orgId,
      )
      .run();
  } catch (e) {
    return c.json(
      {
        error: "Failed to update organisation",
        detail: e instanceof Error ? e.message : String(e),
      },
      500,
    );
  }
  const updated = await c.var.DB
    .prepare(SELECT_ONE_NEW)
    .bind(id, orgId)
    .first<OrganisationRow>();
  return c.json({ organisation: updated ? rowToOrg(updated) : null });
});

// DELETE /api/organisations/:id — soft-delete (is_active = 0).
// Refuses to delete the row flagged as the default organisation.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "organisations", "update");
  if (denied) return denied;
  await ensureOrganisationRegistry(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  const existing = await c.var.DB
    .prepare("SELECT * FROM organisations WHERE id = ? AND org_id = ?")
    .bind(id, orgId)
    .first<OrganisationRow>();
  if (!existing) return c.json({ error: "Organisation not found" }, 404);
  if (existing.isDefault === true || existing.isDefault === 1) {
    return c.json(
      { error: "Cannot delete the default organisation" },
      400,
    );
  }
  await c.var.DB
    .prepare("UPDATE organisations SET is_active = 0 WHERE id = ? AND org_id = ?")
    .bind(id, orgId)
    .run();
  return c.json({ ok: true });
});

// PUT /api/organisations — legacy switcher / single-row updater. Kept so
// the existing sidebar org-switcher (PUT { orgId }) and the Settings page's
// "Save Configuration" (PUT { interCompanyConfig: ... }) keep working.
app.put("/", async (c) => {
  const denied = await requirePermission(c, "organisations", "update");
  if (denied) return denied;
  await ensureOrganisationRegistry(c.var.DB);
  const tenantId = getOrgId(c);
  const body = await c.req.json().catch(() => ({}));

  if (body.orgId) {
    const org = await c.var.DB
      .prepare("SELECT * FROM organisations WHERE id = ? AND org_id = ?")
      .bind(body.orgId, tenantId)
      .first<OrganisationRow>();
    if (!org) return c.json({ error: "Organisation not found" }, 404);
    // ⚠️ KNOWN, DELIBERATELY NOT CHANGED (2026-08-13): `inter_company_config`
    // is a SINGLETON row (`id = 1`), so "which company is active" is GLOBAL
    // state — one user switching company flips it for every other user, in
    // every tenant. Making it per-user (or per-session) is a product decision
    // about how the switcher is meant to behave, not a defect to be fixed
    // inside a security pass. Raised to the owner; left exactly as it was.
    await c.var.DB
      .prepare("UPDATE inter_company_config SET active_org_id = ? WHERE id = 1")
      .bind(body.orgId)
      .run();
    return c.json({ activeOrgId: body.orgId, organisation: rowToOrg(org) });
  }

  if (body.organisation) {
    const patch = body.organisation;
    if (!patch.id) return c.json({ error: "organisation.id required" }, 400);
    const existing = await c.var.DB
      .prepare("SELECT * FROM organisations WHERE id = ? AND org_id = ?")
      .bind(patch.id, tenantId)
      .first<OrganisationRow>();
    if (!existing) return c.json({ error: "Organisation not found" }, 404);

    const merged = {
      code: patch.code ?? existing.code,
      name: patch.name ?? existing.name,
      regNo: patch.regNo ?? existing.regNo ?? "",
      tin: patch.tin ?? existing.tin ?? "",
      msic: patch.msic ?? existing.msic ?? "",
      address: patch.address ?? existing.address ?? "",
      phone: patch.phone ?? existing.phone ?? "",
      email: patch.email ?? existing.email ?? "",
      transferPricingPct:
        patch.transferPricingPct ?? existing.transferPricingPct,
      isActive:
        patch.isActive === undefined
          ? existing.isActive
          : patch.isActive
            ? 1
            : 0,
    };

    await c.var.DB
      .prepare(
        `UPDATE organisations SET
           code = ?, name = ?, reg_no = ?, tin = ?, msic = ?,
           address = ?, phone = ?, email = ?,
           transfer_pricing_pct = ?, is_active = ?
         WHERE id = ? AND org_id = ?`,
      )
      .bind(
        merged.code,
        merged.name,
        merged.regNo,
        merged.tin,
        merged.msic,
        merged.address,
        merged.phone,
        merged.email,
        merged.transferPricingPct,
        merged.isActive,
        patch.id,
        tenantId,
      )
      .run();

    const updated = await c.var.DB
      .prepare("SELECT * FROM organisations WHERE id = ? AND org_id = ?")
      .bind(patch.id, tenantId)
      .first<OrganisationRow>();
    return c.json({ organisation: updated ? rowToOrg(updated) : null });
  }

  if (body.interCompanyConfig) {
    const existing = await c.var.DB
      .prepare("SELECT * FROM inter_company_config WHERE id = 1")
      .first<InterCompanyConfigRow>();
    if (!existing) {
      return c.json({ error: "interCompanyConfig missing" }, 500);
    }
    const patch = body.interCompanyConfig;
    const merged = {
      hookkaToOhanaRate:
        patch.hookkaToOhanaRate ?? existing.hookkaToOhanaRate,
      autoCreateMirrorDocs:
        patch.autoCreateMirrorDocs === undefined
          ? existing.autoCreateMirrorDocs
          : patch.autoCreateMirrorDocs
            ? 1
            : 0,
    };
    await c.var.DB
      .prepare(
        `UPDATE inter_company_config
           SET hookka_to_ohana_rate = ?, auto_create_mirror_docs = ?
         WHERE id = 1`,
      )
      .bind(merged.hookkaToOhanaRate, merged.autoCreateMirrorDocs)
      .run();

    return c.json({
      interCompanyConfig: {
        hookkaToOhanaRate: merged.hookkaToOhanaRate,
        autoCreateMirrorDocs: merged.autoCreateMirrorDocs === 1,
      },
    });
  }

  return c.json({ error: "Invalid request body" }, 400);
});

export default app;
