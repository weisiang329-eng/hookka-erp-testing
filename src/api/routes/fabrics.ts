// ---------------------------------------------------------------------------
// D1-backed fabrics route.
//
// Mirrors src/api/routes/fabrics.ts — a read-only endpoint that returns the
// full fabric master list. Row columns in `fabrics` already match FabricItem.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { requirePermission } from "../lib/rbac";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";

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
  const denied = await requirePermission(c, "fabrics", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    "SELECT * FROM fabrics WHERE orgId = ? ORDER BY code",
  )
    .bind(orgId)
    .all<FabricRow>();
  const data = (res.results ?? []).map(rowToFabric);
  return c.json({ success: true, data });
});

// 2026-05-09: POST / PUT / DELETE on /api/fabrics are deprecated.
//
// The canonical write path is POST /api/raw-materials with itemGroup IN
// ('B.M-FABR','S.M-FABR','S-FABRIC'); the cascade in _fabric-cascade.ts
// auto-mirrors into both `fabrics` and `fabric_trackings`. Direct writes
// here bypass that cascade and create the kind of orphan rows we just
// finished cleaning up. Returning 410 Gone surfaces the issue loudly to
// any caller still hitting these endpoints (frontend should not).
//
// GET / is kept (read-only mirror) for now in case any reader still
// depends on the legacy shape.
const DEPRECATED = {
  success: false,
  error:
    "Deprecated: write fabrics via POST /api/raw-materials (cascade mirrors to fabrics + fabric_trackings).",
};

app.post("/", (c) => c.json(DEPRECATED, 410));
app.put("/:id", (c) => c.json(DEPRECATED, 410));
app.delete("/:id", (c) => c.json(DEPRECATED, 410));

export default app;
