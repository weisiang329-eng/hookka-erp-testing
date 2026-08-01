// ---------------------------------------------------------------------------
// D1-backed suppliers route.
//
// Mirrors src/api/routes/suppliers.ts. The in-memory Supplier type nests a
// `materials: SupplierMaterial[]` array. In D1 that lives in the child
// `supplier_materials` table; we JOIN it on read and replace-on-write on
// POST/PUT so the API shape is unchanged.
//
// NOTE: This is DISTINCT from the `supplier_material_bindings` table that
// backs /api/supplier-materials (a different concept — per-SKU price bindings
// with validity windows). The `materials` array here is the catalogue of what
// a supplier sells (priority A/B/C), not the price binding.
//
// AutoCount alignment (migration 0023):
//   - Creditor fields exposed in camelCase: controlAccount, creditorType,
//     registrationNo, taxEntityTin, addressLine1..4, postalCode, area,
//     website, attention, agent, businessNature, currency, statementType,
//     agingOn, creditTerm, isActive, isGroupCompany, outstandingSen,
//     secondDescription, phone2, mobile, fax.
//   - Existing fields (contactPerson, phone, email, address, state,
//     paymentTerms, status, rating) are preserved for backward compat.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  propagateSupplierName,
  backfillSupplierNames,
} from "../lib/party-name-propagate";

const app = new Hono<Env>();

type SupplierRow = {
  id: string;
  code: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  paymentTerms: string | null;
  status: string;
  rating: number;
  // Letterhead override (migration 0142). Null on pre-migration rows; the
  // route normalises to "HOOKKA" for display + writes "HOOKKA" by default
  // so existing POs print with the same letterhead they always did.
  purchaseOrgCode: string | null;
  // AutoCount fields (migration 0023)
  controlAccount: string | null;
  creditorType: string | null;
  registrationNo: string | null;
  taxEntityTin: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  addressLine4: string | null;
  postalCode: string | null;
  area: string | null;
  website: string | null;
  attention: string | null;
  agent: string | null;
  businessNature: string | null;
  currency: string;
  statementType: string;
  agingOn: string;
  creditTerm: string;
  isActive: number;
  isGroupCompany: number;
  outstandingSen: number;
  secondDescription: string | null;
  phone2: string | null;
  mobile: string | null;
  fax: string | null;
  // Multi-Company Phase 3 — dual-identity link. '' / null = normal external
  // supplier (default). A group org code marks this supplier as one of our group
  // companies (pairs with customers.group_org_code). Dual-keyed on read.
  groupOrgCode?: string | null;
  group_org_code?: string | null;
};

type SupplierMaterialRow = {
  id: number;
  supplierId: string;
  materialCategory: string;
  supplierSKU: string;
  unitPriceSen: number;
  leadTimeDays: number;
  minOrderQty: number;
  priority: "A" | "B" | "C" | null;
};

type SupplierMaterialApi = {
  materialCategory: string;
  supplierSKU: string;
  unitPriceSen: number;
  leadTimeDays: number;
  minOrderQty: number;
  priority: "A" | "B" | "C";
};

function materialRowToApi(r: SupplierMaterialRow): SupplierMaterialApi {
  return {
    materialCategory: r.materialCategory,
    supplierSKU: r.supplierSKU,
    unitPriceSen: r.unitPriceSen,
    leadTimeDays: r.leadTimeDays,
    minOrderQty: r.minOrderQty,
    priority: r.priority ?? "C",
  };
}

function rowToSupplier(
  row: SupplierRow,
  materials: SupplierMaterialRow[] = [],
) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contactPerson: row.contactPerson ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
    address: row.address ?? "",
    state: row.state ?? "",
    paymentTerms: row.paymentTerms ?? "NET30",
    status: row.status ?? "ACTIVE",
    rating: row.rating ?? 3,
    // AutoCount fields
    controlAccount: row.controlAccount ?? "",
    creditorType: row.creditorType ?? "",
    registrationNo: row.registrationNo ?? "",
    taxEntityTin: row.taxEntityTin ?? "",
    addressLine1: row.addressLine1 ?? "",
    addressLine2: row.addressLine2 ?? "",
    addressLine3: row.addressLine3 ?? "",
    addressLine4: row.addressLine4 ?? "",
    postalCode: row.postalCode ?? "",
    area: row.area ?? "",
    website: row.website ?? "",
    attention: row.attention ?? "",
    agent: row.agent ?? "",
    businessNature: row.businessNature ?? "",
    currency: row.currency ?? "MYR",
    statementType: row.statementType ?? "OPEN_ITEM",
    agingOn: row.agingOn ?? "INVOICE_DATE",
    creditTerm: row.creditTerm ?? "C.O.D.",
    isActive: row.isActive !== 0,
    isGroupCompany: row.isGroupCompany === 1,
    groupOrgCode:
      (row.groupOrgCode ?? row.group_org_code ?? "").toString().trim().toUpperCase() ||
      "",
    outstandingSen: row.outstandingSen ?? 0,
    secondDescription: row.secondDescription ?? "",
    phone2: row.phone2 ?? "",
    mobile: row.mobile ?? "",
    fax: row.fax ?? "",
    purchaseOrgCode: row.purchaseOrgCode ?? "HOOKKA",
    materials: materials
      .filter((m) => m.supplierId === row.id)
      .map(materialRowToApi),
  };
}

function genId(): string {
  return `sup-${crypto.randomUUID().slice(0, 8)}`;
}

function sanitizeMaterials(input: unknown): SupplierMaterialApi[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw: unknown) => {
      if (!raw || typeof raw !== "object") return null;
      const m = raw as Record<string, unknown>;
      return {
        materialCategory: typeof m.materialCategory === "string" ? m.materialCategory : "",
        supplierSKU: typeof m.supplierSKU === "string" ? m.supplierSKU : "",
        unitPriceSen: Number(m.unitPriceSen) || 0,
        leadTimeDays: Number(m.leadTimeDays) || 0,
        minOrderQty: Number(m.minOrderQty) || 0,
        priority:
          m.priority === "A" || m.priority === "B" || m.priority === "C"
            ? m.priority
            : "C",
      } as SupplierMaterialApi;
    })
    .filter((m): m is SupplierMaterialApi => m !== null);
}

// Normalise enum inputs so migrations/defaults remain valid.
function normaliseStatementType(v: unknown): string {
  if (v === "OPEN_ITEM" || v === "BALANCE_FORWARD" || v === "NO_STATEMENT") {
    return v;
  }
  return "OPEN_ITEM";
}

function normaliseAgingOn(v: unknown): string {
  if (v === "INVOICE_DATE" || v === "DUE_DATE") return v;
  return "INVOICE_DATE";
}

function boolToInt(v: unknown, fallback: 0 | 1): 0 | 1 {
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  return fallback;
}

// Postgres raises 42703 "column ... does not exist" when migration 0142
// (purchase_org_code) hasn't been applied yet. We catch on the INSERT /
// UPDATE path and retry without the new column so the route keeps working
// between deploy and migration apply.
function isMissingPurchaseOrgCol(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  // Tolerate both the snake_case column name (purchase_org_code) and the
  // folded camelCase form (purchaseorgcode) so the legacy-shape retry fires
  // regardless of how Postgres reports the missing identifier.
  return /column .*purchase_?org_?code.* does not exist/i.test(msg);
}

// Normalise purchaseOrgCode input. Empty / missing -> 'HOOKKA' default so
// existing POs print with the existing default letterhead.
function normalisePurchaseOrgCode(v: unknown): string {
  if (typeof v === "string" && v.trim().length > 0) {
    return v.trim().toUpperCase();
  }
  return "HOOKKA";
}

// Multi-Company Phase 3 — best-effort write of the dual-identity link on a
// supplier. Kept OUT of the main INSERT/UPDATE shape (which has its own
// legacy-column fallback dance) so it can't destabilise supplier saves. Only
// fires when the body actually carries `groupOrgCode`; ensures the column, then
// UPDATEs the one row. Any failure is swallowed — additive + non-blocking.
async function writeSupplierGroupOrgCode(
  db: D1Database,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!("groupOrgCode" in body)) return;
  const code =
    typeof body.groupOrgCode === "string" && body.groupOrgCode.trim()
      ? body.groupOrgCode.trim().toUpperCase()
      : "";
  try {
    await db
      .prepare(
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS group_org_code TEXT NOT NULL DEFAULT ''",
      )
      .run();
  } catch {
    /* column may already exist */
  }
  try {
    await db
      .prepare("UPDATE suppliers SET group_org_code = ? WHERE id = ?")
      .bind(code, id)
      .run();
  } catch {
    /* best-effort — never fail the supplier save on this */
  }
}

// GET /api/suppliers — list all suppliers + their materials
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const [suppliers, materials] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM suppliers WHERE orgId = ? ORDER BY code")
      .bind(orgId)
      .all<SupplierRow>(),
    c.var.DB.prepare("SELECT * FROM supplier_materials WHERE orgId = ?")
      .bind(orgId)
      .all<SupplierMaterialRow>(),
  ]);
  // Bucket materials by supplierId ONCE (was O(suppliers×materials):
  // rowToSupplier re-filtered the whole materials array per supplier).
  // Byte-identical — rowToSupplier still filters, now over the scoped bucket.
  const matsBySupplier = new Map<string, SupplierMaterialRow[]>();
  for (const m of materials.results ?? []) {
    const arr = matsBySupplier.get(m.supplierId);
    if (arr) arr.push(m);
    else matsBySupplier.set(m.supplierId, [m]);
  }
  const data = (suppliers.results ?? []).map((s) =>
    rowToSupplier(s, matsBySupplier.get(s.id) ?? []),
  );
  return c.json({ success: true, data });
});

// POST /api/suppliers — create supplier + child materials atomically
app.post("/", async (c) => {
  const denied = await requirePermission(c, "suppliers", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { code, name } = body;
    if (!code || !name) {
      return c.json(
        { success: false, error: "code and name are required" },
        400,
      );
    }
    const id = genId();
    const materials = sanitizeMaterials(body.materials);
    const purchaseOrgCode = normalisePurchaseOrgCode(body.purchaseOrgCode);

    // INSERT with the new purchase_org_code column. If the migration hasn't
    // been applied yet, retry without it (legacy shape) so the route works
    // between deploy and migration apply.
    function buildInsert(withPurchaseOrg: boolean): D1PreparedStatement {
      const cols = `id, code, name, contactPerson, phone, email,
           address, state, paymentTerms, status, rating,
           controlAccount, creditorType, registrationNo, taxEntityTin,
           addressLine1, addressLine2, addressLine3, addressLine4,
           postalCode, area, website, attention, agent, businessNature,
           currency, statementType, agingOn, creditTerm,
           isActive, isGroupCompany, outstandingSen,
           secondDescription, phone2, mobile, fax${withPurchaseOrg ? ", purchaseOrgCode" : ""}`;
      const placeholders = withPurchaseOrg
        ? "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?"
        : "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
      const binds = [
        id,
        body.code,
        body.name,
        body.contactPerson ?? "",
        body.phone ?? "",
        body.email ?? "",
        body.address ?? "",
        body.state ?? "",
        body.paymentTerms ?? "NET30",
        body.status ?? "ACTIVE",
        Number(body.rating) || 3,
        body.controlAccount ?? null,
        body.creditorType ?? null,
        body.registrationNo ?? null,
        body.taxEntityTin ?? null,
        body.addressLine1 ?? null,
        body.addressLine2 ?? null,
        body.addressLine3 ?? null,
        body.addressLine4 ?? null,
        body.postalCode ?? null,
        body.area ?? null,
        body.website ?? null,
        body.attention ?? null,
        body.agent ?? null,
        body.businessNature ?? null,
        typeof body.currency === "string" && body.currency ? body.currency : "MYR",
        normaliseStatementType(body.statementType),
        normaliseAgingOn(body.agingOn),
        typeof body.creditTerm === "string" && body.creditTerm ? body.creditTerm : "C.O.D.",
        boolToInt(body.isActive, 1),
        boolToInt(body.isGroupCompany, 0),
        Number.isFinite(Number(body.outstandingSen)) ? Math.round(Number(body.outstandingSen)) : 0,
        body.secondDescription ?? null,
        body.phone2 ?? null,
        body.mobile ?? null,
        body.fax ?? null,
      ];
      if (withPurchaseOrg) binds.push(purchaseOrgCode);
      return c.var.DB.prepare(
        `INSERT INTO suppliers (${cols}) VALUES (${placeholders})`,
      ).bind(...binds);
    }

    const matStmts: D1PreparedStatement[] = [];
    for (const m of materials) {
      matStmts.push(
        c.var.DB.prepare(
          `INSERT INTO supplier_materials (supplierId, materialCategory,
             supplierSKU, unitPriceSen, leadTimeDays, minOrderQty, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          m.materialCategory,
          m.supplierSKU,
          m.unitPriceSen,
          m.leadTimeDays,
          m.minOrderQty,
          m.priority,
        ),
      );
    }
    try {
      await c.var.DB.batch([buildInsert(true), ...matStmts]);
    } catch (e) {
      if (isMissingPurchaseOrgCol(e)) {
        await c.var.DB.batch([buildInsert(false), ...matStmts]);
      } else {
        throw e;
      }
    }

    // Phase 3 dual-identity link (best-effort, non-blocking).
    await writeSupplierGroupOrgCode(c.var.DB, id, body);

    const [created, matsRes] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
        .bind(id)
        .first<SupplierRow>(),
      c.var.DB.prepare("SELECT * FROM supplier_materials WHERE supplierId = ?")
        .bind(id)
        .all<SupplierMaterialRow>(),
    ]);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create supplier" },
        500,
      );
    }
    return c.json(
      { success: true, data: rowToSupplier(created, matsRes.results ?? []) },
      201,
    );
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/suppliers/:id — single supplier + materials
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [supplier, matsRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
      .bind(id)
      .first<SupplierRow>(),
    c.var.DB.prepare("SELECT * FROM supplier_materials WHERE supplierId = ?")
      .bind(id)
      .all<SupplierMaterialRow>(),
  ]);
  if (!supplier) {
    return c.json({ success: false, error: "Supplier not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToSupplier(supplier, matsRes.results ?? []),
  });
});

// PUT /api/suppliers/:id — update supplier scalar fields, replace materials if
// body.materials is supplied. DELETE + re-INSERT as one batch for atomicity.
// ---------------------------------------------------------------------------
// POST /api/suppliers/_backfill-snapshot-names — one-shot (owner 2026-08-01).
//
// Renames made BEFORE propagation shipped left stale supplier_name snapshots
// on documents (400-A002 alone: 24 PIs + 13 POs still read "ADD WOORD"). This
// realigns every id-keyed snapshot table to the suppliers master. Idempotent —
// `IS DISTINCT FROM` means a second run reports 0 rows.
// Optional body { supplierId } limits it to one supplier for a dry first pass.
// ---------------------------------------------------------------------------
app.post("/_backfill-snapshot-names", async (c) => {
  const denied = await requirePermission(c, "suppliers", "update");
  if (denied) return denied;
  let supplierId: string | null = null;
  try {
    const body = (await c.req.json()) as { supplierId?: unknown };
    if (typeof body?.supplierId === "string" && body.supplierId.trim()) {
      supplierId = body.supplierId.trim();
    }
  } catch {
    /* no body = whole table */
  }
  const r = await backfillSupplierNames(
    c.var.DB as unknown as Parameters<typeof backfillSupplierNames>[0],
    supplierId,
  );
  console.info(
    `[backfill-snapshot-names suppliers] scope=${supplierId ?? "ALL"} rows=${r.totalRows}`,
  );
  return c.json({ success: true, data: r });
});

app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "suppliers", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
    .bind(id)
    .first<SupplierRow>();
  if (!existing) {
    return c.json({ success: false, error: "Supplier not found" }, 404);
  }
  try {
    const body = await c.req.json();
    const pick = <T>(fresh: T, current: T): T =>
      fresh === undefined ? current : fresh;

    const merged = {
      code: body.code ?? existing.code,
      name: body.name ?? existing.name,
      contactPerson: body.contactPerson ?? existing.contactPerson ?? "",
      phone: body.phone ?? existing.phone ?? "",
      email: body.email ?? existing.email ?? "",
      address: body.address ?? existing.address ?? "",
      state: body.state ?? existing.state ?? "",
      paymentTerms: body.paymentTerms ?? existing.paymentTerms ?? "NET30",
      status: body.status ?? existing.status,
      rating:
        body.rating !== undefined ? Number(body.rating) : existing.rating,
      controlAccount: pick(body.controlAccount, existing.controlAccount),
      creditorType: pick(body.creditorType, existing.creditorType),
      registrationNo: pick(body.registrationNo, existing.registrationNo),
      taxEntityTin: pick(body.taxEntityTin, existing.taxEntityTin),
      addressLine1: pick(body.addressLine1, existing.addressLine1),
      addressLine2: pick(body.addressLine2, existing.addressLine2),
      addressLine3: pick(body.addressLine3, existing.addressLine3),
      addressLine4: pick(body.addressLine4, existing.addressLine4),
      postalCode: pick(body.postalCode, existing.postalCode),
      area: pick(body.area, existing.area),
      website: pick(body.website, existing.website),
      attention: pick(body.attention, existing.attention),
      agent: pick(body.agent, existing.agent),
      businessNature: pick(body.businessNature, existing.businessNature),
      currency:
        typeof body.currency === "string" && body.currency
          ? body.currency
          : existing.currency,
      statementType:
        body.statementType !== undefined
          ? normaliseStatementType(body.statementType)
          : existing.statementType,
      agingOn:
        body.agingOn !== undefined
          ? normaliseAgingOn(body.agingOn)
          : existing.agingOn,
      creditTerm:
        typeof body.creditTerm === "string" && body.creditTerm
          ? body.creditTerm
          : existing.creditTerm,
      isActive:
        body.isActive !== undefined
          ? boolToInt(body.isActive, existing.isActive === 0 ? 0 : 1)
          : existing.isActive,
      isGroupCompany:
        body.isGroupCompany !== undefined
          ? boolToInt(body.isGroupCompany, existing.isGroupCompany === 1 ? 1 : 0)
          : existing.isGroupCompany,
      outstandingSen:
        body.outstandingSen !== undefined
          ? Number.isFinite(Number(body.outstandingSen))
            ? Math.round(Number(body.outstandingSen))
            : existing.outstandingSen
          : existing.outstandingSen,
      secondDescription: pick(body.secondDescription, existing.secondDescription),
      phone2: pick(body.phone2, existing.phone2),
      mobile: pick(body.mobile, existing.mobile),
      fax: pick(body.fax, existing.fax),
      purchaseOrgCode:
        body.purchaseOrgCode !== undefined
          ? normalisePurchaseOrgCode(body.purchaseOrgCode)
          : existing.purchaseOrgCode ?? "HOOKKA",
    };

    // UPDATE with the new purchase_org_code column. Retry without it on
    // pre-0142 schemas (column-does-not-exist) so the route stays alive
    // during the deploy → migration apply window.
    function buildUpdate(withPurchaseOrg: boolean): D1PreparedStatement {
      const tail = withPurchaseOrg
        ? ", purchaseOrgCode = ?"
        : "";
      const sql = `UPDATE suppliers SET code = ?, name = ?, contactPerson = ?, phone = ?,
           email = ?, address = ?, state = ?, paymentTerms = ?, status = ?,
           rating = ?,
           controlAccount = ?, creditorType = ?, registrationNo = ?,
           taxEntityTin = ?,
           addressLine1 = ?, addressLine2 = ?, addressLine3 = ?, addressLine4 = ?,
           postalCode = ?, area = ?, website = ?, attention = ?, agent = ?,
           businessNature = ?, currency = ?, statementType = ?, agingOn = ?,
           creditTerm = ?, isActive = ?, isGroupCompany = ?, outstandingSen = ?,
           secondDescription = ?, phone2 = ?, mobile = ?, fax = ?${tail}
         WHERE id = ?`;
      const binds: unknown[] = [
        merged.code,
        merged.name,
        merged.contactPerson,
        merged.phone,
        merged.email,
        merged.address,
        merged.state,
        merged.paymentTerms,
        merged.status,
        merged.rating,
        merged.controlAccount,
        merged.creditorType,
        merged.registrationNo,
        merged.taxEntityTin,
        merged.addressLine1,
        merged.addressLine2,
        merged.addressLine3,
        merged.addressLine4,
        merged.postalCode,
        merged.area,
        merged.website,
        merged.attention,
        merged.agent,
        merged.businessNature,
        merged.currency,
        merged.statementType,
        merged.agingOn,
        merged.creditTerm,
        merged.isActive,
        merged.isGroupCompany,
        merged.outstandingSen,
        merged.secondDescription,
        merged.phone2,
        merged.mobile,
        merged.fax,
      ];
      if (withPurchaseOrg) binds.push(merged.purchaseOrgCode);
      binds.push(id);
      return c.var.DB.prepare(sql).bind(...binds);
    }

    const statements: D1PreparedStatement[] = [buildUpdate(true)];

    if (body.materials !== undefined) {
      const materials = sanitizeMaterials(body.materials);
      statements.push(
        c.var.DB.prepare(
          "DELETE FROM supplier_materials WHERE supplierId = ?",
        ).bind(id),
      );
      for (const m of materials) {
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO supplier_materials (supplierId, materialCategory,
               supplierSKU, unitPriceSen, leadTimeDays, minOrderQty, priority)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            id,
            m.materialCategory,
            m.supplierSKU,
            m.unitPriceSen,
            m.leadTimeDays,
            m.minOrderQty,
            m.priority,
          ),
        );
      }
    }

    try {
      await c.var.DB.batch(statements);
    } catch (e) {
      if (isMissingPurchaseOrgCol(e)) {
        // Replace the first statement (the supplier UPDATE) with the
        // legacy shape and retry; material statements are untouched.
        const legacy = [buildUpdate(false), ...statements.slice(1)];
        await c.var.DB.batch(legacy);
      } else {
        throw e;
      }
    }

    // Phase 3 dual-identity link (best-effort, non-blocking).
    await writeSupplierGroupOrgCode(c.var.DB, id, body);

    // A rename must reach the 8 tables that snapshotted supplier_name at
    // create time — their read paths don't join suppliers, so without this the
    // correction is invisible on every existing PO / GRN / PI / payment
    // (owner 2026-08-01, after 400-A002's "ADD WOORD" typo stayed on 24 PIs
    // and 13 POs). Owner ruling: propagate to financial documents too.
    if (merged.name !== existing.name) {
      const prop = await propagateSupplierName(
        c.var.DB as unknown as Parameters<typeof propagateSupplierName>[0],
        id,
        existing.name,
        merged.name,
      );
      console.info(
        `[PUT /api/suppliers/${id}] renamed "${prop.oldName}" → "${prop.newName}": ${prop.totalRows} row(s) across ${prop.tables.filter((t) => t.updated !== null).length} table(s)`,
      );
    }

    const [updated, matsRes] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
        .bind(id)
        .first<SupplierRow>(),
      c.var.DB.prepare("SELECT * FROM supplier_materials WHERE supplierId = ?")
        .bind(id)
        .all<SupplierMaterialRow>(),
    ]);
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload supplier" },
        500,
      );
    }
    return c.json({
      success: true,
      data: rowToSupplier(updated, matsRes.results ?? []),
    });
  } catch (e) {
    // Surface the real reason instead of a blanket "Invalid request body"
    // (which masked the purchaseOrgCode column-name bug for so long).
    console.error(`[PUT /api/suppliers/${id}] failed:`, e);
    const msg = e instanceof Error && e.message ? e.message : "Invalid request body";
    return c.json({ success: false, error: msg }, 400);
  }
});

// DELETE /api/suppliers/:id — FK cascade removes supplier_materials too
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "suppliers", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const [existing, matsRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
      .bind(id)
      .first<SupplierRow>(),
    c.var.DB.prepare("SELECT * FROM supplier_materials WHERE supplierId = ?")
      .bind(id)
      .all<SupplierMaterialRow>(),
  ]);
  if (!existing) {
    return c.json({ success: false, error: "Supplier not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM suppliers WHERE id = ?").bind(id).run();
  return c.json({
    success: true,
    data: rowToSupplier(existing, matsRes.results ?? []),
  });
});

export default app;
