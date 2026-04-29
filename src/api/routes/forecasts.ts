// ---------------------------------------------------------------------------
// D1-backed forecasts route.
//
// Mirrors src/api/routes/forecasts.ts — GET returns a raw array (not wrapped)
// and POST returns the created row with 201. Stored in forecast_entries
// (created in migration 0013).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type ForecastRow = {
  id: string;
  productId: string;
  productName: string | null;
  productCode: string | null;
  period: string;
  forecastQty: number;
  actualQty: number | null;
  method: string;
  confidence: number;
  createdDate: string;
};

function rowToForecast(r: ForecastRow) {
  return {
    id: r.id,
    productId: r.productId,
    productName: r.productName ?? "",
    productCode: r.productCode ?? "",
    period: r.period,
    forecastQty: r.forecastQty,
    actualQty: r.actualQty,
    method: r.method,
    confidence: r.confidence,
    createdDate: r.createdDate,
  };
}

function genId(): string {
  return `forecast-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/forecasts?productId=xxx&period=2026-05
app.get("/", async (c) => {
  const productId = c.req.query("productId");
  const period = c.req.query("period");

  const where: string[] = [];
  const binds: string[] = [];
  if (productId) {
    where.push("productId = ?");
    binds.push(productId);
  }
  if (period) {
    where.push("period = ?");
    binds.push(period);
  }
  const sql =
    "SELECT * FROM forecast_entries" +
    (where.length > 0 ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY period DESC, productCode";
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<ForecastRow>();
  return c.json((res.results ?? []).map(rowToForecast));
});

// POST /api/forecasts
app.post("/", async (c) => {
  const denied = await requirePermission(c, "forecasts", "create");
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const productId = body.productId as string | undefined;
  const period = body.period as string | undefined;
  const forecastQty = body.forecastQty as number | undefined;
  const method = body.method as string | undefined;

  if (!productId || !period || forecastQty === undefined || !method) {
    return c.json(
      { error: "productId, period, forecastQty, and method are required" },
      400,
    );
  }
  if (method !== "SMA_3" && method !== "SMA_6" && method !== "WMA") {
    return c.json({ error: "method must be SMA_3, SMA_6 or WMA" }, 400);
  }

  const id = genId();
  const createdDate = new Date().toISOString().split("T")[0];
  const confidence =
    body.confidence === undefined ? 50 : Math.max(0, Math.min(100, Number(body.confidence)));

  await c.var.DB.prepare(
    `INSERT INTO forecast_entries
       (id, productId, productName, productCode, period, forecastQty, actualQty, method, confidence, createdDate)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      id,
      productId,
      (body.productName as string | undefined) ?? "",
      (body.productCode as string | undefined) ?? "",
      period,
      Math.round(Number(forecastQty)),
      method,
      confidence,
      createdDate,
    )
    .run();

  const created = await c.var.DB.prepare(
    "SELECT * FROM forecast_entries WHERE id = ?",
  )
    .bind(id)
    .first<ForecastRow>();
  if (!created) {
    return c.json({ error: "Failed to create forecast entry" }, 500);
  }
  return c.json(rowToForecast(created), 201);
});

export default app;
