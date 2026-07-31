// ---------------------------------------------------------------------------
// component-boms.ts — reusable kit sub-BOMs (owner 2026-07-31). A mechanism /
// leg SKU is bound to the screws (or any components) it always needs, ONCE, and
// every product BOM referencing that SKU auto-explodes the children at
// consumption time (see component-bom.ts + po-cost-cascade.ts).
//
// RBAC-gated on `bom` (this is BOM engineering data); tenant-scoped by org_id.
// Table self-applied at runtime.
//
//   GET    /api/component-boms                 → every kit (grouped by parent)
//   GET    /api/component-boms/:parentCode     → one kit's child lines
//   PUT    /api/component-boms/:parentCode     → replace a kit's child lines
//   DELETE /api/component-boms/:parentCode     → remove a kit entirely
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  ensureComponentBomTable,
  listKits,
  loadKit,
  saveKit,
  type KitChild,
} from "../lib/component-bom";

const app = new Hono<Env>();

// GET /api/component-boms — every parent SKU that has a kit, with its children.
app.get("/", async (c) => {
  const denied = await requirePermission(c, "bom", "read");
  if (denied) return denied;
  const kits = await listKits(c.var.DB, getOrgId(c));
  return c.json({ success: true, data: kits });
});

// GET /api/component-boms/:parentCode — one kit's children (empty if none).
app.get("/:parentCode", async (c) => {
  const denied = await requirePermission(c, "bom", "read");
  if (denied) return denied;
  const parentCode = c.req.param("parentCode");
  const kit = await loadKit(c.var.DB, getOrgId(c), parentCode);
  return c.json({
    success: true,
    data: kit ?? { parentCode, parentName: "", children: [] },
  });
});

// PUT /api/component-boms/:parentCode — replace the whole kit for this parent.
// Body: { parentName?, children: [{ childCode, childName?, qtyPer, wastePct? }] }
app.put("/:parentCode", async (c) => {
  const denied = await requirePermission(c, "bom", "update");
  if (denied) return denied;
  const parentCode = c.req.param("parentCode");
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const rawChildren = Array.isArray(b.children) ? (b.children as Record<string, unknown>[]) : [];
  const children: KitChild[] = rawChildren.map((r) => ({
    childCode: String(r.childCode ?? r.child_code ?? ""),
    childName: String(r.childName ?? r.child_name ?? ""),
    qtyPer: Number(r.qtyPer ?? r.qty_per ?? 0),
    wastePct: Number(r.wastePct ?? r.waste_pct ?? 0),
  }));
  const result = await saveKit(
    c.var.DB,
    getOrgId(c),
    parentCode,
    String(b.parentName ?? b.parent_name ?? ""),
    children,
  );
  if (!result.ok) return c.json({ success: false, error: result.error }, 400);
  return c.json({ success: true, data: { parentCode, count: result.count } });
});

// DELETE /api/component-boms/:parentCode — drop the kit (save with no children).
app.delete("/:parentCode", async (c) => {
  const denied = await requirePermission(c, "bom", "update");
  if (denied) return denied;
  await ensureComponentBomTable(c.var.DB);
  const parentCode = c.req.param("parentCode");
  await c.var.DB
    .prepare("DELETE FROM component_bom_lines WHERE parent_code = ? AND (org_id = ? OR org_id IS NULL)")
    .bind(parentCode, getOrgId(c))
    .run();
  return c.json({ success: true });
});

export default app;
