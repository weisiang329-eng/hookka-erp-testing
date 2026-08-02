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
import { requirePermission } from "../lib/rbac";

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

function rowToConfig(row: InterCompanyConfigRow) {
  return {
    hookkaToOhanaRate: row.hookkaToOhanaRate,
    autoCreateMirrorDocs: row.autoCreateMirrorDocs === 1,
  };
}

// Postgres raises 42703 "column ... does not exist" when migration 0142
// hasn't been applied. We catch it and fall back to the legacy column set
// so the GET keeps responding (and the rest of the dashboard keeps loading).
function isMissingNewColumn(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /column .*(business_type|is_default|display_order|msic_code|letterhead_url).* does not exist/i.test(
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

const SELECT_NEW = `SELECT ${SELECT_COLS_NEW} FROM organisations ORDER BY display_order, code`;
const SELECT_LEGACY = `SELECT ${SELECT_COLS_LEGACY} FROM organisations ORDER BY code`;
const SELECT_ONE_NEW = `SELECT ${SELECT_COLS_NEW} FROM organisations WHERE id = ?`;

async function loadOrganisations(
  db: D1Database,
): Promise<ReturnType<typeof rowToOrg>[]> {
  try {
    const res = await db.prepare(SELECT_NEW).all<OrganisationRow>();
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
app.get("/", async (c) => {
  let organisations: ReturnType<typeof rowToOrg>[];
  let cfg: InterCompanyConfigRow | null = null;
  try {
    [organisations, cfg] = await Promise.all([
      loadOrganisations(c.var.DB),
      c.var.DB
        .prepare("SELECT * FROM inter_company_config WHERE id = 1")
        .first<InterCompanyConfigRow>(),
    ]);
  } catch {
    organisations = FALLBACK_ORGS;
    cfg = null;
  }
  return c.json({
    organisations,
    activeOrgId: cfg?.activeOrgId ?? organisations[0]?.id ?? null,
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
  try {
    const dup = await c.var.DB.prepare(
      "SELECT id FROM organisations WHERE code = ?",
    )
      .bind(code)
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
        "hookka",
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
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const existing = await c.var.DB
    .prepare("SELECT * FROM organisations WHERE id = ?")
    .bind(id)
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
         WHERE id = ?`,
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
    .bind(id)
    .first<OrganisationRow>();
  return c.json({ organisation: updated ? rowToOrg(updated) : null });
});

// DELETE /api/organisations/:id — soft-delete (is_active = 0).
// Refuses to delete the row flagged as the default organisation.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "organisations", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB
    .prepare("SELECT * FROM organisations WHERE id = ?")
    .bind(id)
    .first<OrganisationRow>();
  if (!existing) return c.json({ error: "Organisation not found" }, 404);
  if (existing.isDefault === true || existing.isDefault === 1) {
    return c.json(
      { error: "Cannot delete the default organisation" },
      400,
    );
  }
  await c.var.DB
    .prepare("UPDATE organisations SET is_active = 0 WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// PUT /api/organisations — legacy switcher / single-row updater. Kept so
// the existing sidebar org-switcher (PUT { orgId }) and the Settings page's
// "Save Configuration" (PUT { interCompanyConfig: ... }) keep working.
app.put("/", async (c) => {
  const denied = await requirePermission(c, "organisations", "update");
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));

  if (body.orgId) {
    const org = await c.var.DB
      .prepare("SELECT * FROM organisations WHERE id = ?")
      .bind(body.orgId)
      .first<OrganisationRow>();
    if (!org) return c.json({ error: "Organisation not found" }, 404);
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
      .prepare("SELECT * FROM organisations WHERE id = ?")
      .bind(patch.id)
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
         WHERE id = ?`,
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
      )
      .run();

    const updated = await c.var.DB
      .prepare("SELECT * FROM organisations WHERE id = ?")
      .bind(patch.id)
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
