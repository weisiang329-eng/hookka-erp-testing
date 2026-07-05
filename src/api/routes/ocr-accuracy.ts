// ---------------------------------------------------------------------------
// GET /api/ocr-accuracy?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// OCR accuracy dashboard (owner 2026-07-04). SUCCESS = the operator changed
// nothing between OCR's extraction and the imported document; any change =
// FAIL, and the changed field is the reason. Computed from the scan-sample
// tables (rawExtracted vs correctedJson) — only rows the operator actually
// imported (correctedJson IS NOT NULL) count.
//
//   Sales Orders   → po_scan_samples,      grouped by customer × Hookka
//                    catalog category (productCode → products.category).
//   Supplier docs  → supplier_scan_samples, grouped by supplier.
//
// All diff logic lives in ../lib/ocr-accuracy-core (pure, unit-tested).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import {
  diffSalesOrderSample,
  diffSupplierSample,
  salesOrderLineDiffs,
  emptyBucket,
  addToBucket,
  rateOf,
  topFails,
  type Bucket,
} from "../lib/ocr-accuracy-core";

const app = new Hono<Env>();

function parse(json: string | null | undefined): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

type BucketOut = {
  key: string;
  total: number;
  success: number;
  rate: number | null;
  topFails: string[];
  children?: BucketOut[];
};

function bucketOut(b: Bucket, children?: BucketOut[]): BucketOut {
  return {
    key: b.key,
    total: b.total,
    success: b.success,
    rate: rateOf(b),
    topFails: topFails(b.failFields),
    ...(children && children.length ? { children } : {}),
  };
}

app.get("/", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const from = c.req.query("from");
  const to = c.req.query("to");

  const dateWhere = (col: string): { sql: string; binds: string[] } => {
    const parts: string[] = ["correctedJson IS NOT NULL"];
    const binds: string[] = [];
    if (from) { parts.push(`${col} >= ?`); binds.push(from); }
    if (to) { parts.push(`${col} <= ?`); binds.push(`${to} 23:59:59`); }
    return { sql: parts.join(" AND "), binds };
  };

  // ---- Sales Orders --------------------------------------------------------
  // Catalog map: productCode (upper) → Hookka category. products.category is
  // our own classification (SOFA / BEDFRAME / ACCESSORY).
  const prodRes = await db
    .prepare("SELECT code, category FROM products")
    .all<{ code: string; category: string | null }>();
  const catByCode = new Map<string, string>();
  for (const p of prodRes.results ?? []) {
    if (p.code) catByCode.set(String(p.code).trim().toUpperCase(), (p.category || "Other").toUpperCase());
  }

  const soWhere = dateWhere("createdAt");
  const soRes = await db
    .prepare(
      `SELECT customerHint, rawExtracted, correctedJson
         FROM po_scan_samples WHERE ${soWhere.sql}`,
    )
    .bind(...soWhere.binds)
    .all<{ customerHint: string | null; rawExtracted: string | null; correctedJson: string | null }>();

  const soOverall = emptyBucket("Sales Orders");
  const soByCustomer = new Map<string, Bucket>();
  // customer||category → line-level bucket for the drill-down.
  const soByCustCat = new Map<string, Bucket>();

  for (const row of soRes.results ?? []) {
    const raw = parse(row.rawExtracted);
    const corr = parse(row.correctedJson);
    if (!corr) continue;
    const customer = (row.customerHint || "Unknown").trim() || "Unknown";

    // Document-level (overall + by customer).
    const dDoc = diffSalesOrderSample(raw, corr);
    addToBucket(soOverall, dDoc);
    if (!soByCustomer.has(customer)) soByCustomer.set(customer, emptyBucket(customer));
    addToBucket(soByCustomer.get(customer)!, dDoc);

    // Line-level (customer × category).
    for (const ln of salesOrderLineDiffs(raw, corr)) {
      const cat = catByCode.get(ln.productCode.toUpperCase()) || "OTHER";
      const key = `${customer}||${cat}`;
      if (!soByCustCat.has(key)) soByCustCat.set(key, emptyBucket(cat));
      addToBucket(soByCustCat.get(key)!, { changed: ln.changed, fields: ln.fields });
    }
  }

  const soCustomers: BucketOut[] = [...soByCustomer.values()]
    .sort((a, b) => b.total - a.total)
    .map((b) => {
      const children = [...soByCustCat.entries()]
        .filter(([k]) => k.startsWith(`${b.key}||`))
        .map(([, cb]) => bucketOut(cb))
        .sort((a, x) => x.total - a.total);
      return bucketOut(b, children);
    });

  // ---- Supplier docs (PO / PI / GRN) --------------------------------------
  const supWhere = dateWhere("createdAt");
  let supRows: { supplierHint: string | null; rawJson: string | null; correctedJson: string | null }[] = [];
  try {
    const supRes = await db
      .prepare(
        `SELECT supplierHint, rawJson, correctedJson
           FROM supplier_scan_samples WHERE ${supWhere.sql}`,
      )
      .bind(...supWhere.binds)
      .all<{ supplierHint: string | null; rawJson: string | null; correctedJson: string | null }>();
    supRows = supRes.results ?? [];
  } catch {
    // Table is created at runtime by the supplier-scan flow; absent until the
    // first supplier scan on this environment. Treat as no data.
    supRows = [];
  }

  const supOverall = emptyBucket("Supplier");
  const supBySupplier = new Map<string, Bucket>();
  for (const row of supRows) {
    const raw = parse(row.rawJson);
    const corr = parse(row.correctedJson);
    if (!corr) continue;
    const supplier = (row.supplierHint || "Unknown").trim() || "Unknown";
    const d = diffSupplierSample(raw, corr);
    addToBucket(supOverall, d);
    if (!supBySupplier.has(supplier)) supBySupplier.set(supplier, emptyBucket(supplier));
    addToBucket(supBySupplier.get(supplier)!, d);
  }
  const suppliers = [...supBySupplier.values()]
    .sort((a, b) => b.total - a.total)
    .map((b) => bucketOut(b));

  const grandTotal = soOverall.total + supOverall.total;
  const grandSuccess = soOverall.success + supOverall.success;

  return c.json({
    success: true,
    data: {
      overall: {
        total: grandTotal,
        success: grandSuccess,
        rate: grandTotal === 0 ? null : Math.round((grandSuccess / grandTotal) * 1000) / 10,
      },
      salesOrders: { ...bucketOut(soOverall), customers: soCustomers },
      supplier: { ...bucketOut(supOverall), suppliers },
      from: from ?? null,
      to: to ?? null,
    },
  });
});

export default app;
