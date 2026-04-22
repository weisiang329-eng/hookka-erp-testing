// ---------------------------------------------------------------------------
// D1-backed fabrics route.
//
// Mirrors src/api/routes/fabrics.ts — a read-only endpoint that returns the
// full fabric master list. Row columns in `fabrics` already match FabricItem.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

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
  const res = await c.env.DB.prepare(
    "SELECT * FROM fabrics ORDER BY code",
  ).all<FabricRow>();
  const data = (res.results ?? []).map(rowToFabric);
  return c.json({ success: true, data });
});

export default app;
