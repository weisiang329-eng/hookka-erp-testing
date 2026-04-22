// ---------------------------------------------------------------------------
// D1-backed supplier-scorecards route.
//
// Mirrors src/api/routes/supplier-scorecards.ts — read-only GET with optional
// ?supplierId=... Returns a single scorecard when filtered, a list otherwise.
//
// NOTE: the original in-memory route returns `{ error }` (no `success: false`)
// on the supplierId-not-found case. Preserving that exact shape.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type ScorecardRow = {
  supplierId: string;
  onTimeRate: number;
  qualityRate: number;
  leadTimeAccuracy: number;
  avgPriceTrend: number;
  overallRating: number;
  lastUpdated: string | null;
};

function rowToScorecard(r: ScorecardRow) {
  return {
    supplierId: r.supplierId,
    onTimeRate: r.onTimeRate,
    qualityRate: r.qualityRate,
    leadTimeAccuracy: r.leadTimeAccuracy,
    avgPriceTrend: r.avgPriceTrend,
    overallRating: r.overallRating,
    lastUpdated: r.lastUpdated ?? "",
  };
}

// GET /api/supplier-scorecards?supplierId=...
app.get("/", async (c) => {
  const supplierId = c.req.query("supplierId");
  if (supplierId) {
    const row = await c.env.DB.prepare(
      "SELECT * FROM supplier_scorecards WHERE supplierId = ?",
    )
      .bind(supplierId)
      .first<ScorecardRow>();
    if (!row) {
      return c.json({ error: "Scorecard not found" }, 404);
    }
    return c.json({ success: true, data: rowToScorecard(row) });
  }
  const res = await c.env.DB.prepare(
    "SELECT * FROM supplier_scorecards ORDER BY supplierId",
  ).all<ScorecardRow>();
  const data = (res.results ?? []).map(rowToScorecard);
  return c.json({ success: true, data });
});

export default app;
