// ---------------------------------------------------------------------------
// D1-backed organisations route.
//
// Mirrors the old src/api/routes/organisations.ts response shape exactly —
// note the GET returns { organisations, activeOrgId, interCompanyConfig }
// with NO { success } wrapper, because the frontend unmarshals this shape
// directly.
//
// `inter_company_config` is a singleton row (id = 1). `activeOrgId` is now
// stored there instead of in module-scope state.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
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
  address: string | null;
  phone: string | null;
  email: string | null;
  transferPricingPct: number;
  isActive: number;
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
    msic: row.msic ?? "",
    address: row.address ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
    transferPricingPct: row.transferPricingPct,
    isActive: row.isActive === 1,
  };
}

function rowToConfig(row: InterCompanyConfigRow) {
  return {
    hookkaToOhanaRate: row.hookkaToOhanaRate,
    autoCreateMirrorDocs: row.autoCreateMirrorDocs === 1,
  };
}

async function loadAll(db: D1Database) {
  const [orgsRes, cfg] = await Promise.all([
    db.prepare("SELECT * FROM organisations ORDER BY code").all<OrganisationRow>(),
    db
      .prepare("SELECT * FROM inter_company_config WHERE id = 1")
      .first<InterCompanyConfigRow>(),
  ]);
  return {
    organisations: (orgsRes.results ?? []).map(rowToOrg),
    activeOrgId: cfg?.activeOrgId ?? null,
    interCompanyConfig: cfg ? rowToConfig(cfg) : null,
  };
}

// GET /api/organisations
app.get("/", async (c) => {
  const payload = await loadAll(c.var.DB);
  return c.json(payload);
});

// PUT /api/organisations
// Three shapes:
//   { orgId }                   — switch the active organisation
//   { organisation: {id, ...} } — update a single organisation row
//   { interCompanyConfig: ... } — update the singleton config row
app.put("/", async (c) => {
  const denied = await requirePermission(c, "organisations", "update");
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));

  if (body.orgId) {
    const org = await c.var.DB.prepare(
      "SELECT * FROM organisations WHERE id = ?",
    )
      .bind(body.orgId)
      .first<OrganisationRow>();
    if (!org) return c.json({ error: "Organisation not found" }, 404);
    await c.var.DB.prepare(
      "UPDATE inter_company_config SET activeOrgId = ? WHERE id = 1",
    )
      .bind(body.orgId)
      .run();
    return c.json({ activeOrgId: body.orgId, organisation: rowToOrg(org) });
  }

  if (body.organisation) {
    const patch = body.organisation;
    if (!patch.id) return c.json({ error: "organisation.id required" }, 400);
    const existing = await c.var.DB.prepare(
      "SELECT * FROM organisations WHERE id = ?",
    )
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

    await c.var.DB.prepare(
      `UPDATE organisations SET
         code = ?, name = ?, regNo = ?, tin = ?, msic = ?,
         address = ?, phone = ?, email = ?,
         transferPricingPct = ?, isActive = ?
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

    const updated = await c.var.DB.prepare(
      "SELECT * FROM organisations WHERE id = ?",
    )
      .bind(patch.id)
      .first<OrganisationRow>();
    return c.json({ organisation: updated ? rowToOrg(updated) : null });
  }

  if (body.interCompanyConfig) {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM inter_company_config WHERE id = 1",
    ).first<InterCompanyConfigRow>();
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
    await c.var.DB.prepare(
      `UPDATE inter_company_config
         SET hookkaToOhanaRate = ?, autoCreateMirrorDocs = ?
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
