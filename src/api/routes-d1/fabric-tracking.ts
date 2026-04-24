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
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<FabricTrackingRow>();
  const data = (res.results ?? []).map(rowToTracking);
  return c.json({ success: true, data });
});

type FabricTrackingBody = {
  fabricCode?: string;
  fabricDescription?: string | null;
  fabricCategory?: FabricTrackingRow["fabricCategory"];
  priceTier?: "PRICE_1" | "PRICE_2";
  price?: number;
  soh?: number;
  poOutstanding?: number;
  lastMonthUsage?: number;
  oneWeekUsage?: number;
  twoWeeksUsage?: number;
  oneMonthUsage?: number;
  shortage?: number;
  reorderPoint?: number;
  supplier?: string | null;
  leadTimeDays?: number;
};

function genTrackingId(): string {
  return `ft-${crypto.randomUUID().slice(0, 8)}`;
}

// POST /api/fabric-tracking — create a new tracking row. In the LIVE cascade
// model the canonical way to create is via POST /api/raw-materials, but this
// endpoint covers direct edits from the Fabric Tracking tab.
app.post("/", async (c) => {
  let body: FabricTrackingBody;
  try {
    body = (await c.req.json()) as FabricTrackingBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const fabricCode = (body.fabricCode ?? "").trim();
  if (!fabricCode) {
    return c.json({ success: false, error: "fabricCode is required" }, 400);
  }
  const existing = await c.var.DB.prepare(
    "SELECT id FROM fabric_trackings WHERE fabricCode = ? LIMIT 1",
  )
    .bind(fabricCode)
    .first<{ id: string }>();
  if (existing) {
    return c.json(
      {
        success: false,
        error: `Fabric tracking for ${fabricCode} already exists`,
      },
      400,
    );
  }
  const fabricCategory = body.fabricCategory ?? "B.M-FABR";
  const priceTier = body.priceTier ?? "PRICE_2";
  const id = genTrackingId();
  await c.var.DB.prepare(
    `INSERT INTO fabric_trackings
       (id, fabricCode, fabricDescription, fabricCategory, priceTier,
        price, soh, poOutstanding, lastMonthUsage, oneWeekUsage,
        twoWeeksUsage, oneMonthUsage, shortage, reorderPoint, supplier, leadTimeDays)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      fabricCode,
      body.fabricDescription ?? null,
      fabricCategory,
      priceTier,
      Number(body.price) || 0,
      Number(body.soh) || 0,
      Number(body.poOutstanding) || 0,
      Number(body.lastMonthUsage) || 0,
      Number(body.oneWeekUsage) || 0,
      Number(body.twoWeeksUsage) || 0,
      Number(body.oneMonthUsage) || 0,
      Number(body.shortage) || 0,
      Number(body.reorderPoint) || 0,
      body.supplier ?? null,
      Number(body.leadTimeDays) || 0,
    )
    .run();
  const created = await c.var.DB.prepare(
    "SELECT * FROM fabric_trackings WHERE id = ?",
  )
    .bind(id)
    .first<FabricTrackingRow>();
  if (!created) {
    return c.json(
      { success: false, error: "Failed to create fabric tracking" },
      500,
    );
  }
  return c.json({ success: true, data: rowToTracking(created) }, 201);
});

// DELETE /api/fabric-tracking/:id
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
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
  await c.var.DB.prepare("DELETE FROM fabric_trackings WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true, data: rowToTracking(existing) });
});

// PUT /api/fabric-tracking/:id — partial update (priceTier, price, soh,
// reorderPoint). Mirrors the in-memory "only these four fields" behavior.
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
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

    await c.var.DB.prepare(
      `UPDATE fabric_trackings SET priceTier = ?, price = ?, soh = ?, reorderPoint = ?
       WHERE id = ?`,
    )
      .bind(priceTier, price, soh, reorderPoint, id)
      .run();

    const updated = await c.var.DB.prepare(
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
