// ---------------------------------------------------------------------------
// Customer-quotation envelope endpoint.
//
// One-shot fetch that drives the date-aware "Export Quotation PDF" flow on
// the customers page. The frontend picks an `asOf` date (today, past, or
// future), and this endpoint returns one combined snapshot of:
//
//   - customer            (basic identity + contact)
//   - products            (per customer_products row, resolved via
//                          resolveCustomerPriceAsOf so the master fallback +
//                          history overlays both honor `asOf`)
//   - sofaCombos          (newest sofa_combo_rules row per (baseModel,
//                          componentSizes, fabricTier, customerId) where
//                          effectiveFrom <= asOf; customer-scoped wins over
//                          company-wide for the same shape)
//   - maintenanceConfig   (master + customer override resolved via
//                          maintenance-config's resolveMaintenanceConfigAsOf)
//
// Designed so the PDF generator can stay a pure mapper from envelope to
// pages — no extra round trips.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { requirePermission } from "../lib/rbac";
import type { Env } from "../worker";
import { resolveCustomerPricesAsOfBatch } from "./customer-products";
import { resolveMaintenanceConfigAsOf } from "./maintenance-config";

const app = new Hono<Env>();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type CustomerRow = {
  id: string;
  code: string;
  name: string;
  companyAddress: string | null;
  phone: string | null;
  email: string | null;
};

type DeliveryHubRow = {
  customerId: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  isDefault: number;
};

type CpRow = {
  id: string;
  productId: string;
  productCode: string;
  productName: string;
  productCategory: string;
  sizeCode: string | null;
  sizeLabel: string | null;
};

type SofaComboRow = {
  id: string;
  baseModel: string;
  componentSizes: string;
  fabricTier: string;
  pricesByHeight: string;
  customerId: string | null;
  customerName: string | null;
  effectiveFrom: string;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// GET /api/customer-quotation?customerId=<id>&asOf=YYYY-MM-DD
app.get("/", async (c) => {
  const denied = await requirePermission(c, "quotations", "read");
  if (denied) return denied;
  const customerId = (c.req.query("customerId") ?? "").trim();
  if (!customerId) {
    return c.json(
      { success: false, error: "customerId query param is required" },
      400,
    );
  }
  const asOfRaw = (c.req.query("asOf") ?? "").trim();
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : todayIso();

  const cust = await c.var.DB.prepare(
    `SELECT id, code, name, companyAddress, phone, email
       FROM customers WHERE id = ?`,
  )
    .bind(customerId)
    .first<CustomerRow>();
  if (!cust) {
    return c.json({ success: false, error: "Customer not found" }, 404);
  }

  // Default delivery hub address/phone/email override the customer columns
  // for "where to deliver" — same precedence the existing PDF used.
  const hub = await c.var.DB.prepare(
    `SELECT customerId, address, phone, email, isDefault
       FROM delivery_hubs
      WHERE customerId = ?
      ORDER BY isDefault DESC, code ASC
      LIMIT 1`,
  )
    .bind(customerId)
    .first<DeliveryHubRow>();

  const customerOut = {
    id: cust.id,
    code: cust.code,
    name: cust.name,
    address: hub?.address ?? cust.companyAddress ?? null,
    phone: hub?.phone ?? cust.phone ?? null,
    email: hub?.email ?? cust.email ?? null,
  };

  // ---------------------------------------------------------------
  // Products — iterate cp rows and resolve each price as of asOf.
  // ---------------------------------------------------------------
  const cpRes = await c.var.DB.prepare(
    `SELECT cp.id           AS "id",
            cp.productId    AS "productId",
            p.code          AS "productCode",
            p.name          AS "productName",
            p.category      AS "productCategory",
            p.sizeCode      AS "sizeCode",
            p.sizeLabel     AS "sizeLabel"
       FROM customer_products cp
       INNER JOIN products p ON p.id = cp.productId
      WHERE cp.customerId = ?
      ORDER BY p.category, p.code`,
  )
    .bind(customerId)
    .all<CpRow>();

  const cpRows = cpRes.results ?? [];
  const productsOut: Array<{
    productId: string;
    code: string;
    name: string;
    category: string;
    sizeCode: string | null;
    sizeLabel: string | null;
    basePriceSen: number | null;
    price1Sen: number | null;
    seatHeightPrices: Array<{ height: string; priceSen: number; tier?: string }>;
  }> = [];
  // resolveCustomerPriceAsOf does ~5 sequential DB reads PER product, so a
  // 375-SKU customer (The Conts) serialised ~1875 round-trips and the request
  // aborted at 30s — "Export Quotation PDF" never produced a file (owner
  // 2026-07-29). Resolve the whole set in 4 bulk queries instead: same price
  // math (shared resolvePrices), same output, just fan-in.
  const priceMap = await resolveCustomerPricesAsOfBatch(
    c.var.DB,
    cpRows.map((r) => r.productId),
    customerId,
    asOf,
  );
  for (const r of cpRows) {
    const resolved = priceMap.get(r.productId);
    productsOut.push({
      productId: r.productId,
      code: r.productCode,
      name: r.productName,
      category: r.productCategory,
      sizeCode: r.sizeCode,
      sizeLabel: r.sizeLabel,
      basePriceSen: resolved?.basePriceSen ?? null,
      price1Sen: resolved?.price1Sen ?? null,
      seatHeightPrices: resolved?.seatHeightPrices ?? [],
    });
  }

  // ---------------------------------------------------------------
  // Sofa combos — both customer-scoped and company-wide, then de-dup
  // per (baseModel, componentSizes, fabricTier) with customer-scoped
  // taking precedence over company-wide for the same shape.
  // ---------------------------------------------------------------
  const comboRes = await c.var.DB.prepare(
    `SELECT scr.id, scr.baseModel, scr.componentSizes, scr.fabricTier,
            scr.pricesByHeight, scr.customerId, scr.effectiveFrom,
            cu.name AS "customerName"
       FROM sofa_combo_rules scr
       LEFT JOIN customers cu ON cu.id = scr.customerId
      WHERE (scr.customerId = ? OR scr.customerId IS NULL)
        AND scr.effectiveFrom <= ?
      ORDER BY scr.baseModel, scr.componentSizes, scr.fabricTier,
               scr.effectiveFrom DESC, scr.created_at DESC`,
  )
    .bind(customerId, asOf)
    .all<SofaComboRow>();
  const comboRows = comboRes.results ?? [];

  // First pass: pick newest per (baseModel|componentSizes|fabricTier|scope)
  // separately so customer-scope and company-wide both have a candidate.
  const newestByScopedKey = new Map<string, SofaComboRow>();
  for (const r of comboRows) {
    const scope = r.customerId ? "C" : "M";
    const k = `${scope}|${r.baseModel}|${r.componentSizes}|${r.fabricTier}`;
    if (!newestByScopedKey.has(k)) newestByScopedKey.set(k, r);
  }
  // Second pass: collapse customer-vs-master for the same shape — customer
  // wins. Key is shape only.
  const finalByShape = new Map<string, SofaComboRow>();
  for (const r of newestByScopedKey.values()) {
    const shapeKey = `${r.baseModel}|${r.componentSizes}|${r.fabricTier}`;
    const existing = finalByShape.get(shapeKey);
    if (!existing) {
      finalByShape.set(shapeKey, r);
    } else if (existing.customerId === null && r.customerId !== null) {
      finalByShape.set(shapeKey, r);
    }
  }

  const sofaCombosOut = Array.from(finalByShape.values())
    .map((r) => ({
      id: r.id,
      baseModel: r.baseModel,
      componentSizes: parseJson<string[][]>(r.componentSizes, []),
      fabricTier: r.fabricTier,
      pricesByHeight: parseJson<Record<string, number>>(r.pricesByHeight, {}),
      effectiveFrom: r.effectiveFrom,
      customerName: r.customerId ? r.customerName : null,
    }))
    .sort((a, b) => {
      if (a.baseModel !== b.baseModel) return a.baseModel.localeCompare(b.baseModel);
      return a.fabricTier.localeCompare(b.fabricTier);
    });

  // ---------------------------------------------------------------
  // Maintenance config — master + customer override blob, both resolved
  // as of the same asOf. PDF picks the customer override when present,
  // master otherwise.
  // ---------------------------------------------------------------
  const masterMc = await resolveMaintenanceConfigAsOf(c.var.DB, "master", asOf);
  const custMc = await resolveMaintenanceConfigAsOf(
    c.var.DB,
    `customer:${customerId}`,
    asOf,
  );

  return c.json({
    success: true,
    data: {
      customer: customerOut,
      asOf,
      products: productsOut,
      sofaCombos: sofaCombosOut,
      maintenanceConfig: {
        master: masterMc.config,
        masterEffectiveFrom: masterMc.effectiveFrom,
        customer: custMc.config,
        customerEffectiveFrom: custMc.effectiveFrom,
      },
    },
  });
});

export default app;
