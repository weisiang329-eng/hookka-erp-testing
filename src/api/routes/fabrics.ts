// ---------------------------------------------------------------------------
// D1-backed fabrics route.
//
// Mirrors src/api/routes/fabrics.ts — a read-only endpoint that returns the
// full fabric master list. Row columns in `fabrics` already match FabricItem.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type FabricRow = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  priceSen: number;
  sohMeters: number;
  reorderLevel: number;
};

function rowToFabric(r: FabricRow) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category ?? "",
    priceSen: r.priceSen,
    sohMeters: r.sohMeters,
    reorderLevel: r.reorderLevel,
  };
}

// GET /api/fabrics — list all fabrics
app.get("/", async (c) => {
  const res = await c.var.DB.prepare(
    "SELECT * FROM fabrics ORDER BY code",
  ).all<FabricRow>();
  const data = (res.results ?? []).map(rowToFabric);
  return c.json({ success: true, data });
});

type FabricBody = {
  code?: string;
  name?: string;
  category?: string;
  priceSen?: number;
  sohMeters?: number;
  reorderLevel?: number;
};

function genId(): string {
  return `fab-${crypto.randomUUID().slice(0, 8)}`;
}

// POST /api/fabrics — create a new fabric master row.
//
// NOTE: In the LIVE cascade model, the canonical way to add a fabric is via
// POST /api/raw-materials with itemGroup in ('B.M-FABR','S.M-FABR','S-FABRIC').
// This endpoint exists for direct edits from the Fabric Master tab, but does
// NOT mirror back into raw_materials (that would be a loop). Use sparingly.
app.post("/", async (c) => {
  const denied = await requirePermission(c, "fabrics", "create");
  if (denied) return denied;
  let body: FabricBody;
  try {
    body = (await c.req.json()) as FabricBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const code = (body.code ?? "").trim();
  const name = (body.name ?? "").trim() || code;
  if (!code) return c.json({ success: false, error: "code is required" }, 400);

  const existing = await c.var.DB.prepare(
    "SELECT id FROM fabrics WHERE code = ? LIMIT 1",
  )
    .bind(code)
    .first<{ id: string }>();
  if (existing) {
    return c.json(
      { success: false, error: `Fabric ${code} already exists` },
      400,
    );
  }

  const id = genId();
  await c.var.DB.prepare(
    `INSERT INTO fabrics (id, code, name, category, priceSen, sohMeters, reorderLevel)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      code,
      name,
      body.category ?? null,
      Number(body.priceSen) || 0,
      Number(body.sohMeters) || 0,
      Number(body.reorderLevel) || 0,
    )
    .run();
  const created = await c.var.DB.prepare("SELECT * FROM fabrics WHERE id = ?")
    .bind(id)
    .first<FabricRow>();
  if (!created) {
    return c.json({ success: false, error: "Failed to create fabric" }, 500);
  }
  return c.json({ success: true, data: rowToFabric(created) }, 201);
});

// PUT /api/fabrics/:id — partial update (name/category/priceSen/sohMeters/reorderLevel).
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "fabrics", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT * FROM fabrics WHERE id = ?")
    .bind(id)
    .first<FabricRow>();
  if (!existing) {
    return c.json({ success: false, error: "Fabric not found" }, 404);
  }
  let body: FabricBody;
  try {
    body = (await c.req.json()) as FabricBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const merged = {
    name: body.name ?? existing.name,
    category: body.category !== undefined ? body.category : existing.category,
    priceSen:
      body.priceSen !== undefined ? Number(body.priceSen) : existing.priceSen,
    sohMeters:
      body.sohMeters !== undefined ? Number(body.sohMeters) : existing.sohMeters,
    reorderLevel:
      body.reorderLevel !== undefined
        ? Number(body.reorderLevel)
        : existing.reorderLevel,
  };
  await c.var.DB.prepare(
    `UPDATE fabrics SET name = ?, category = ?, priceSen = ?, sohMeters = ?, reorderLevel = ?
       WHERE id = ?`,
  )
    .bind(
      merged.name,
      merged.category,
      merged.priceSen,
      merged.sohMeters,
      merged.reorderLevel,
      id,
    )
    .run();
  const updated = await c.var.DB.prepare("SELECT * FROM fabrics WHERE id = ?")
    .bind(id)
    .first<FabricRow>();
  if (!updated) {
    return c.json({ success: false, error: "Failed to reload fabric" }, 500);
  }
  return c.json({ success: true, data: rowToFabric(updated) });
});

// DELETE /api/fabrics/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "fabrics", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT * FROM fabrics WHERE id = ?")
    .bind(id)
    .first<FabricRow>();
  if (!existing) {
    return c.json({ success: false, error: "Fabric not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM fabrics WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: rowToFabric(existing) });
});

export default app;
