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
    // Compare on the DATE PORTION only. The old `<= '<to> 23:59:59'` bound
    // silently dropped every row on the `to` day when createdAt is stored as
    // ISO with a 'T' separator ('T' 0x54 > ' ' 0x20 lexically) — the last day
    // of any selected month never counted (owner audit 2026-07-11).
    if (to) { parts.push(`substr(${col}::text, 1, 10) <= ?`); binds.push(to); }
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
  let supRows: { supplierHint: string | null; rawJson: string | null; correctedJson: string | null; docType: string | null }[] = [];
  try {
    const supRes = await db
      .prepare(
        `SELECT supplierHint, rawJson, correctedJson, docType
           FROM supplier_scan_samples WHERE ${supWhere.sql}`,
      )
      .bind(...supWhere.binds)
      .all<{ supplierHint: string | null; rawJson: string | null; correctedJson: string | null; docType: string | null }>();
    supRows = supRes.results ?? [];
  } catch {
    // Table is created at runtime by the supplier-scan flow; absent until the
    // first supplier scan on this environment. Treat as no data.
    supRows = [];
  }

  const supOverall = emptyBucket("Supplier");
  const supBySupplier = new Map<string, Bucket>();
  // Owner 2026-08-01: 「每个种类的 accurate rate 是多少%？PI / SO / GR」. The
  // sample row already carries the engine's docType (INVOICE / DELIVERY_NOTE /
  // OTHER) — no new column needed. INVOICE is what becomes a Purchase Invoice,
  // DELIVERY_NOTE what becomes a GRN, so that field IS the PI-vs-GR split.
  const supByDocType = new Map<string, Bucket>();
  // supplier||docType, for drilling into one supplier's PI vs GR accuracy.
  const supBySupplierDoc = new Map<string, Bucket>();
  const DOC_LABEL: Record<string, string> = {
    INVOICE: "Purchase Invoice",
    DELIVERY_NOTE: "Goods Received (DO/GRN)",
  };
  for (const row of supRows) {
    const raw = parse(row.rawJson);
    const corr = parse(row.correctedJson);
    if (!corr) continue;
    const supplier = (row.supplierHint || "Unknown").trim() || "Unknown";
    const dt = (row.docType || "").trim().toUpperCase();
    const docLabel = DOC_LABEL[dt] ?? "Other / unclassified";
    const d = diffSupplierSample(raw, corr);
    addToBucket(supOverall, d);
    if (!supBySupplier.has(supplier)) supBySupplier.set(supplier, emptyBucket(supplier));
    addToBucket(supBySupplier.get(supplier)!, d);
    if (!supByDocType.has(docLabel)) supByDocType.set(docLabel, emptyBucket(docLabel));
    addToBucket(supByDocType.get(docLabel)!, d);
    const sdKey = `${supplier}||${docLabel}`;
    if (!supBySupplierDoc.has(sdKey)) supBySupplierDoc.set(sdKey, emptyBucket(docLabel));
    addToBucket(supBySupplierDoc.get(sdKey)!, d);
  }
  const suppliers = [...supBySupplier.values()]
    .sort((a, b) => b.total - a.total)
    .map((b) => {
      const children = [...supBySupplierDoc.entries()]
        .filter(([k]) => k.startsWith(`${b.key}||`))
        .map(([, cb]) => bucketOut(cb))
        .sort((a, x) => x.total - a.total);
      return bucketOut(b, children);
    });
  const supplierDocTypes = [...supByDocType.values()]
    .sort((a, b) => b.total - a.total)
    .map((b) => bucketOut(b));

  // ---- Scan duration (owner 2026-08-01: 「要有平均 scan 一张 PO/PI/GR 的时间」)
  //
  // MEASURED, NOT ASSUMED (staging 2026-08-01): the first cut reported
  // enqueue → done, on the reasoning that queue wait is time the operator sits
  // through. Live numbers made it useless — Customer PO averaged 22 MINUTES and
  // supplier docs 24 HOURS, with a p90 of 3.9 days. A queue row only advances
  // while a worker is draining it, so that span is dominated by idle time when
  // nobody had the modal open, not by scanning.
  //
  // So: started_at → completed_at, the actual processing cost, which is what
  // 「平均 scan 一张 PO/PI/GR 的时间」 means. Rows with no started_at (legacy,
  // or cache hits that never ran) are excluded rather than counted as zero.
  //
  // `kind` separates customer POs from supplier docs. Supplier PI-vs-GR needs
  // the sample's docType, reachable now that sample_id is stored on the row —
  // rows scanned before that column exists simply fall into the untyped
  // bucket rather than being dropped.
  //
  // 'cached' rows are excluded on purpose: a cache hit completes in
  // milliseconds and would drag the average away from the real scan cost.
  type TimingRow = { bucket: string | null; n: number; avgSec: number | null; p90Sec: number | null };
  let timingRows: TimingRow[] = [];
  try {
    // The column is created by scan-queue's lazy ensure, which only runs once a
    // scan endpoint is hit. Depending on that ordering made this block silently
    // return nothing on a fresh isolate (observed on staging). Ensure it here
    // too — idempotent, and cheap next to the aggregate below.
    await db
      .prepare("ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS sample_id TEXT")
      .run()
      .catch(() => undefined);
    const parts: string[] = [
      "q.status = 'done'",
      "q.completed_at IS NOT NULL",
      "q.started_at IS NOT NULL",
    ];
    const binds: string[] = [];
    if (from) { parts.push("substr(q.created_at::text, 1, 10) >= ?"); binds.push(from); }
    if (to) { parts.push("substr(q.created_at::text, 1, 10) <= ?"); binds.push(to); }
    const res = await db
      .prepare(
        `SELECT CASE
                  WHEN q.kind = 'po' THEN 'Customer PO'
                  WHEN s.docType = 'INVOICE' THEN 'Purchase Invoice'
                  WHEN s.docType = 'DELIVERY_NOTE' THEN 'Goods Received (DO/GRN)'
                  ELSE 'Supplier doc (unclassified)'
                END AS bucket,
                COUNT(*)::int AS n,
                ROUND(AVG(EXTRACT(EPOCH FROM (q.completed_at::timestamptz - q.started_at::timestamptz)))::numeric, 1)::float8 AS "avgSec",
                ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (
                  ORDER BY EXTRACT(EPOCH FROM (q.completed_at::timestamptz - q.started_at::timestamptz))
                )::numeric, 1)::float8 AS "p90Sec"
           FROM scan_queue q
           LEFT JOIN supplier_scan_samples s ON s.id = q.sample_id
          WHERE ${parts.join(" AND ")}
          GROUP BY 1
          ORDER BY n DESC`,
      )
      .bind(...binds)
      .all<TimingRow>();
    timingRows = res.results ?? [];
  } catch {
    // scan_queue / sample_id may not exist yet on a fresh environment.
    timingRows = [];
  }
  const timing = {
    buckets: timingRows.map((r) => ({
      key: r.bucket ?? "Unknown",
      scans: r.n,
      avgSec: r.avgSec,
      p90Sec: r.p90Sec,
    })),
    totalScans: timingRows.reduce((s, r) => s + (r.n ?? 0), 0),
  };

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
      supplier: { ...bucketOut(supOverall), suppliers, docTypes: supplierDocTypes },
      timing,
      from: from ?? null,
      to: to ?? null,
    },
  });
});

export default app;
