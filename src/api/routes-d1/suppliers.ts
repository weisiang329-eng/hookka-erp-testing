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

// GET /api/suppliers — list all suppliers + their materials
app.get("/", async (c) => {
  const [suppliers, materials] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM suppliers ORDER BY code").all<SupplierRow>(),
    c.env.DB.prepare("SELECT * FROM supplier_materials").all<SupplierMaterialRow>(),
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
      c.env.DB.prepare(
        `INSERT INTO suppliers (id, code, name, contactPerson, phone, email,
           address, state, paymentTerms, status, rating)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ),
    ];
    for (const m of materials) {
      statements.push(
        c.env.DB.prepare(
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
    await c.env.DB.batch(statements);

    const [created, matsRes] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
        .bind(id)
        .first<SupplierRow>(),
      c.env.DB.prepare("SELECT * FROM supplier_materials WHERE supplierId = ?")
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
    c.env.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
      .bind(id)
      .first<SupplierRow>(),
    c.env.DB.prepare("SELECT * FROM supplier_materials WHERE supplierId = ?")
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
  const existing = await c.env.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
    .bind(id)
    .first<SupplierRow>();
  if (!existing) {
    return c.json({ success: false, error: "Supplier not found" }, 404);
  }
  try {
    const body = await c.req.json();
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
    };

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `UPDATE suppliers SET code = ?, name = ?, contactPerson = ?, phone = ?,
           email = ?, address = ?, state = ?, paymentTerms = ?, status = ?,
           rating = ?
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
        id,
      ),
    ];

    if (body.materials !== undefined) {
      const materials = sanitizeMaterials(body.materials);
      statements.push(
        c.env.DB.prepare(
          "DELETE FROM supplier_materials WHERE supplierId = ?",
        ).bind(id),
      );
      for (const m of materials) {
        statements.push(
          c.env.DB.prepare(
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

    await c.env.DB.batch(statements);

    const [updated, matsRes] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
        .bind(id)
        .first<SupplierRow>(),
      c.env.DB.prepare("SELECT * FROM supplier_materials WHERE supplierId = ?")
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
    c.env.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
      .bind(id)
      .first<SupplierRow>(),
    c.env.DB.prepare("SELECT * FROM supplier_materials WHERE supplierId = ?")
      .bind(id)
      .all<SupplierMaterialRow>(),
  ]);
  if (!existing) {
    return c.json({ success: false, error: "Supplier not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM suppliers WHERE id = ?").bind(id).run();
  return c.json({
    success: true,
    data: rowToSupplier(existing, matsRes.results ?? []),
  });
});

export default app;
