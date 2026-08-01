// ---------------------------------------------------------------------------
// D1-backed historical-sales route.
//
// Unlike the mock (which was an empty array waiting to be seeded), this
// derives historical sales from real invoices on the fly. Data source:
//
//   invoices          — invoiceDate, customerId, customerName, status
//   invoice_items     — productCode, productName, quantity, totalSen
//   products          — productId resolution by code
//
// We aggregate by (product × period × customer) where period = YYYY-MM.
// Cancelled invoices are excluded; everything else counts as "sold".
//
// 2026-08-01 — productName / customerName are wrapped in MAX() rather than
// added to GROUP BY. Under D1 (SQLite) a bare non-aggregated column was legal
// and returned an arbitrary row's value; Postgres rejects it outright:
//   column "ii.product_name" must appear in the GROUP BY clause
//   or be used in an aggregate function
// so this endpoint has 500'd for every caller since the Postgres cutover.
// MAX() reproduces the old "pick one" behaviour and, unlike widening the
// GROUP BY, cannot split one product/customer into several rows when the
// stored display name differs between invoices — which would silently change
// the numbers the forecast page reads.
// Response shape matches the original (raw array, not envelope-wrapped).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type SalesAggRow = {
  period: string;
  productCode: string | null;
  productName: string | null;
  customerId: string | null;
  customerName: string | null;
  quantity: number;
  revenue: number;
};

type ProductLookupRow = {
  id: string;
  code: string;
  name: string;
};

// GET /api/historical-sales?productId=xxx&from=2025-05&to=2026-04
app.get("/", async (c) => {
  // Historical sales are derived from invoices — sales data, gate with the
  // same sales-orders-read permission as sales-orders.ts.
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;

  const productId = c.req.query("productId");
  const from = c.req.query("from"); // "YYYY-MM"
  const to = c.req.query("to"); // "YYYY-MM"

  // Resolve productId → productCode (aggregation joins on code since
  // invoice_items stores productCode only, not productId).
  let filterCode: string | null = null;
  if (productId) {
    const prod = await c.var.DB.prepare(
      "SELECT id, code, name FROM products WHERE id = ?",
    )
      .bind(productId)
      .first<ProductLookupRow>();
    if (!prod) return c.json([]);
    filterCode = prod.code;
  }

  const where: string[] = [
    "i.status != 'CANCELLED'",
    "i.invoiceDate IS NOT NULL",
    "i.invoiceDate != ''",
  ];
  const binds: string[] = [];
  if (filterCode) {
    where.push("ii.productCode = ?");
    binds.push(filterCode);
  }
  if (from) {
    where.push("substr(i.invoiceDate, 1, 7) >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("substr(i.invoiceDate, 1, 7) <= ?");
    binds.push(to);
  }

  const sql = `
    SELECT substr(i.invoiceDate, 1, 7) AS period,
           ii.productCode              AS "productCode",
           MAX(ii.productName)         AS "productName",
           i.customerId                AS "customerId",
           MAX(i.customerName)         AS "customerName",
           SUM(ii.quantity)            AS quantity,
           SUM(ii.totalSen)            AS revenue
      FROM invoices i
      JOIN invoice_items ii ON ii.invoiceId = i.id
     WHERE ${where.join(" AND ")}
     GROUP BY period, ii.productCode, i.customerId
     ORDER BY period DESC, ii.productCode
  `;
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<SalesAggRow>();

  // Map productCode back to productId via a single products lookup.
  const productsRes = await c.var.DB.prepare(
    "SELECT id, code, name FROM products",
  ).all<ProductLookupRow>();
  const byCode = new Map<string, ProductLookupRow>();
  for (const p of productsRes.results ?? []) byCode.set(p.code, p);

  const data = (res.results ?? []).map((r) => {
    const prod = r.productCode ? byCode.get(r.productCode) : undefined;
    return {
      productId: prod?.id ?? "",
      productCode: r.productCode ?? "",
      productName: prod?.name ?? r.productName ?? "",
      period: r.period,
      quantity: Math.round(r.quantity || 0),
      revenue: Math.round(r.revenue || 0), // sen
      customerId: r.customerId ?? "",
      customerName: r.customerName ?? "",
    };
  });

  // Secondary productId filter — if a product has no invoices in the joined
  // rows, we still want to return an empty array rather than drop the param.
  const filtered = productId
    ? data.filter((d) => d.productId === productId)
    : data;

  return c.json(filtered);
});

export default app;
