// ---------------------------------------------------------------------------
// D1-backed fabric-tracking route.
//
// Mirrors src/api/routes/fabric-tracking.ts response shape. Reads/writes the
// fabric_trackings table directly; row columns already match the FabricTracking
// TS type 1:1 (see schema L169-186).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type FabricTrackingRow = {
  id: string;
  fabricCode: string;
  fabricDescription: string | null;
  fabricCategory: "B.M-FABR" | "S-FABR" | "S.M-FABR" | "LINING" | "WEBBING" | null;
  priceTier: "PRICE_1" | "PRICE_2" | null;
  price: number;
  soh: number;
  poOutstanding: number;
  lastMonthUsage: number;
  oneWeekUsage: number;
  twoWeeksUsage: number;
  oneMonthUsage: number;
  shortage: number;
  reorderPoint: number;
  supplier: string | null;
  leadTimeDays: number;
};

function rowToTracking(r: FabricTrackingRow) {
  return {
    id: r.id,
    fabricCode: r.fabricCode,
    fabricDescription: r.fabricDescription ?? "",
    fabricCategory: r.fabricCategory ?? "B.M-FABR",
    priceTier: r.priceTier ?? "PRICE_1",
    price: r.price,
    soh: r.soh,
    poOutstanding: r.poOutstanding,
    lastMonthUsage: r.lastMonthUsage,
    oneWeekUsage: r.oneWeekUsage,
    twoWeeksUsage: r.twoWeeksUsage,
    oneMonthUsage: r.oneMonthUsage,
    shortage: r.shortage,
    reorderPoint: r.reorderPoint,
    supplier: r.supplier ?? "",
    leadTimeDays: r.leadTimeDays,
  };
}

// GET /api/fabric-tracking?category=B.M-FABR&shortageOnly=true
app.get("/", async (c) => {
  const category = c.req.query("category");
  const shortageOnly = c.req.query("shortageOnly") === "true";

  const where: string[] = [];
  const binds: unknown[] = [];
  if (category) {
    where.push("fabricCategory = ?");
    binds.push(category);
  }
  if (shortageOnly) {
    where.push("shortage < 0");
  }
  const sql =
    where.length > 0
      ? `SELECT * FROM fabric_trackings WHERE ${where.join(" AND ")} ORDER BY fabricCode`
      : "SELECT * FROM fabric_trackings ORDER BY fabricCode";
  const res = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<FabricTrackingRow>();
  const data = (res.results ?? []).map(rowToTracking);
  return c.json({ success: true, data });
});

// PUT /api/fabric-tracking/:id — partial update (priceTier, price, soh,
// reorderPoint). Mirrors the in-memory "only these four fields" behavior.
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT * FROM fabric_trackings WHERE id = ?",
  )
    .bind(id)
    .first<FabricTrackingRow>();
  if (!existing) {
    return c.json(
      { success: false, error: "Fabric tracking entry not found" },
      404,
    );
  }

  try {
    const body = await c.req.json();

    let priceTier: "PRICE_1" | "PRICE_2" | null = existing.priceTier;
    if (body.priceTier !== undefined) {
      if (body.priceTier === "PRICE_1" || body.priceTier === "PRICE_2") {
        priceTier = body.priceTier;
      }
    }
    const price = body.price !== undefined ? Number(body.price) : existing.price;
    const soh = body.soh !== undefined ? Number(body.soh) : existing.soh;
    const reorderPoint =
      body.reorderPoint !== undefined
        ? Number(body.reorderPoint)
        : existing.reorderPoint;

    await c.env.DB.prepare(
      `UPDATE fabric_trackings SET priceTier = ?, price = ?, soh = ?, reorderPoint = ?
       WHERE id = ?`,
    )
      .bind(priceTier, price, soh, reorderPoint, id)
      .run();

    const updated = await c.env.DB.prepare(
      "SELECT * FROM fabric_trackings WHERE id = ?",
    )
      .bind(id)
      .first<FabricTrackingRow>();
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload fabric tracking" },
        500,
      );
    }
    return c.json({ success: true, data: rowToTracking(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
