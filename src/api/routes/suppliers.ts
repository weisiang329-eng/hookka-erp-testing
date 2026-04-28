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
    outstandingSen: row.outstandingSen ?? 0,
    secondDescription: row.secondDescription ?? "",
    phone2: row.phone2 ?? "",
    mobile: row.mobile ?? "",
    fax: row.fax ?? "",
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

// GET /api/suppliers — list all suppliers + their materials
app.get("/", async (c) => {
  const [suppliers, materials] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM suppliers ORDER BY code").all<SupplierRow>(),
    c.var.DB.prepare("SELECT * FROM supplier_materials").all<SupplierMaterialRow>(),
  ]);
  const data = (suppliers.results ?? []).map((s) =>
    rowToSupplier(s, materials.results ?? []),
  );
  return c.json({ success: true, data });
});

// POST /api/suppliers — create supplier + child materials atomically
app.post("/", async (c) => {
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

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO suppliers (id, code, name, contactPerson, phone, email,
           address, state, paymentTerms, status, rating,
           controlAccount, creditorType, registrationNo, taxEntityTin,
           addressLine1, addressLine2, addressLine3, addressLine4,
           postalCode, area, website, attention, agent, businessNature,
           currency, statementType, agingOn, creditTerm,
           isActive, isGroupCompany, outstandingSen,
           secondDescription, phone2, mobile, fax)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
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
      ),
    ];
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
    await c.var.DB.batch(statements);

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
app.put("/:id", async (c) => {
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
    };

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `UPDATE suppliers SET code = ?, name = ?, contactPerson = ?, phone = ?,
           email = ?, address = ?, state = ?, paymentTerms = ?, status = ?,
           rating = ?,
           controlAccount = ?, creditorType = ?, registrationNo = ?,
           taxEntityTin = ?,
           addressLine1 = ?, addressLine2 = ?, addressLine3 = ?, addressLine4 = ?,
           postalCode = ?, area = ?, website = ?, attention = ?, agent = ?,
           businessNature = ?, currency = ?, statementType = ?, agingOn = ?,
           creditTerm = ?, isActive = ?, isGroupCompany = ?, outstandingSen = ?,
           secondDescription = ?, phone2 = ?, mobile = ?, fax = ?
         WHERE id = ?`,
      ).bind(
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
        id,
      ),
    ];

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

    await c.var.DB.batch(statements);

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
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/suppliers/:id — FK cascade removes supplier_materials too
app.delete("/:id", async (c) => {
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
