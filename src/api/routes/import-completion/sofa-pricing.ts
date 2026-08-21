import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { getOrgId } from "../../lib/tenant";
import { PRICE_BASELINE_DATE, type BaselineCandidate, MODEL_MAP_HOUZS, priceFor, HEIGHTS_TO_FILL, SOFA_TARGET_BASES, type SoiRow, type SoRow } from "./_shared";

const app = new Hono<Env>();


app.post("/derive-historical-price-baselines", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // --- 1. Customer-product baselines ---------------------------------------
  // For each customer_products row that has history, the earliest existing
  // history.effectiveFrom marks where pre-existing data ends. Anything
  // before that date is a gap we may be able to fill from SO snapshots.
  const cpRowsRes = await db
    .prepare(
      `SELECT cp.id           AS "cpId",
              cp.productId    AS productId,
              cp.customerId   AS customerId,
              cp.basePriceSen AS "cpLegacyBase",
              p.code          AS productCode,
              p.category      AS category,
              MIN(cph.effectiveFrom) AS "earliestHistory"
         FROM customer_products cp
         JOIN products p ON p.id = cp.productId
         LEFT JOIN customer_product_prices cph
                ON cph.customerProductId = cp.id
        GROUP BY cp.id, cp.productId, cp.customerId, cp.basePriceSen, p.code, p.category`,
    )
    .all<{
      cpId: string;
      productId: string;
      customerId: string;
      cpLegacyBase: number | null;
      productCode: string;
      category: string;
      earliestHistory: string | null;
    }>();
  const cpRows = cpRowsRes.results ?? [];

  const candidates: BaselineCandidate[] = [];
  const skipped: Array<{ scope: string; key: string; reason: string }> = [];

  for (const cp of cpRows) {
    if (cp.category === "SOFA") {
      skipped.push({
        scope: "customer",
        key: `${cp.productCode}|${cp.customerId}`,
        reason: "SOFA matrix not auto-derived",
      });
      continue;
    }
    // Cutoff: anything strictly before the earliest existing history row.
    // If no history exists yet, treat cutoff as infinity (any SO qualifies).
    const cutoff = cp.earliestHistory ?? "9999-12-31";

    // Find OLDEST SO line for this (productCode, customerId) below cutoff.
    const oldestLine = await db
      .prepare(
        `SELECT soi.id           AS "lineId",
                soi.basePriceSen AS basePriceSen,
                so.companySODate AS "soDate"
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.salesOrderId
          WHERE soi.productCode = ?
            AND so.customerId   = ?
            AND so.companySODate IS NOT NULL
            AND so.companySODate != ''
            AND so.companySODate < ?
            AND soi.basePriceSen > 0
          ORDER BY so.companySODate ASC, soi.id ASC
          LIMIT 1`,
      )
      .bind(cp.productCode, cp.customerId, cutoff)
      .first<{ lineId: string; basePriceSen: number; soDate: string }>();

    // Fallback chain when no historical SO line exists for this
    // (productCode, customerId): use the cp.basePriceSen legacy column
    // value. This preserves a sensible 2020-01-01 row even for cps that
    // were assignment-only or seeded via "Copy from Master" without any
    // SO history under that customer. Without this fallback the customer-
    // side history dialog stays empty for all such cps.
    let baselinePriceSen: number | null = oldestLine?.basePriceSen ?? null;
    let sourceLineId = oldestLine?.lineId ?? "(legacy cp.basePriceSen)";
    let sourceDate = oldestLine?.soDate ?? "(legacy)";
    if (
      baselinePriceSen == null &&
      typeof cp.cpLegacyBase === "number" &&
      cp.cpLegacyBase > 0
    ) {
      baselinePriceSen = cp.cpLegacyBase;
      sourceLineId = "(legacy cp.basePriceSen)";
      sourceDate = "(legacy)";
    }
    if (baselinePriceSen == null) {
      skipped.push({
        scope: "customer",
        key: `${cp.productCode}|${cp.customerId}`,
        reason: cp.earliestHistory
          ? `no SO line predates ${cutoff} and no legacy basePriceSen`
          : "no historical SO line and no legacy basePriceSen",
      });
      continue;
    }

    candidates.push({
      scope: "customer",
      cpId: cp.cpId,
      productId: cp.productId,
      productCode: cp.productCode,
      customerId: cp.customerId,
      baselineDate: PRICE_BASELINE_DATE,
      basePriceSen: baselinePriceSen,
      sourceSoLineId: sourceLineId,
      sourceSoCompanySODate: sourceDate,
    });
  }

  // --- 2. Master-product baselines ----------------------------------------
  // For each product (BF/ACC), if its earliest existing master history is
  // after some SO line's date, derive a master baseline from the oldest SO
  // line for that productCode (any customer).
  const prodRowsRes = await db
    .prepare(
      `SELECT p.id          AS productId,
              p.code        AS productCode,
              p.category    AS category,
              p.basePriceSen AS "legacyBase",
              MIN(pp.effectiveFrom) AS "earliestHistory"
         FROM products p
         LEFT JOIN product_prices pp ON pp.productId = p.id
        WHERE p.category IN ('BEDFRAME','ACCESSORY')
        GROUP BY p.id, p.code, p.category, p.basePriceSen`,
    )
    .all<{
      productId: string;
      productCode: string;
      category: string;
      legacyBase: number | null;
      earliestHistory: string | null;
    }>();
  const prodRows = prodRowsRes.results ?? [];

  for (const p of prodRows) {
    const cutoff = p.earliestHistory ?? "9999-12-31";
    const oldestLine = await db
      .prepare(
        `SELECT soi.id           AS "lineId",
                soi.basePriceSen AS basePriceSen,
                so.companySODate AS "soDate"
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.salesOrderId
          WHERE soi.productCode = ?
            AND so.companySODate IS NOT NULL
            AND so.companySODate != ''
            AND so.companySODate < ?
            AND soi.basePriceSen > 0
          ORDER BY so.companySODate ASC, soi.id ASC
          LIMIT 1`,
      )
      .bind(p.productCode, cutoff)
      .first<{ lineId: string; basePriceSen: number; soDate: string }>();

    // Same fallback chain as customer scope: SO line first, legacy
    // products.basePriceSen second.
    let basePriceSen: number | null = oldestLine?.basePriceSen ?? null;
    let sourceLineId = oldestLine?.lineId ?? "(legacy products.basePriceSen)";
    let sourceDate = oldestLine?.soDate ?? "(legacy)";
    if (
      basePriceSen == null &&
      typeof p.legacyBase === "number" &&
      p.legacyBase > 0
    ) {
      basePriceSen = p.legacyBase;
      sourceLineId = "(legacy products.basePriceSen)";
      sourceDate = "(legacy)";
    }
    if (basePriceSen == null) continue;

    candidates.push({
      scope: "master",
      cpId: null,
      productId: p.productId,
      productCode: p.productCode,
      customerId: null,
      baselineDate: PRICE_BASELINE_DATE,
      basePriceSen,
      sourceSoLineId: sourceLineId,
      sourceSoCompanySODate: sourceDate,
    });
  }

  const sample = candidates.slice(0, 15);
  const byScope = candidates.reduce<Record<string, number>>((acc, c) => {
    acc[c.scope] = (acc[c.scope] ?? 0) + 1;
    return acc;
  }, {});

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      planned: candidates.length,
      byScope,
      skipped: skipped.slice(0, 30),
      skippedTotal: skipped.length,
      sample,
    });
  }

  let inserted = 0;
  const errors: Array<{ key: string; message: string }> = [];

  for (const cand of candidates) {
    try {
      if (cand.scope === "customer" && cand.cpId) {
        // Re-check (idempotency): another concurrent request might have
        // inserted between the candidate scan and this loop.
        const exists = await db
          .prepare(
            "SELECT id FROM customer_product_prices WHERE customerProductId = ? AND effectiveFrom = ? LIMIT 1",
          )
          .bind(cand.cpId, cand.baselineDate)
          .first<{ id: string }>();
        if (exists) continue;
        await db
          .prepare(
            `INSERT INTO customer_product_prices
               (id, customerProductId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`,
          )
          .bind(
            `cph-${crypto.randomUUID().slice(0, 8)}`,
            cand.cpId,
            cand.basePriceSen,
            cand.baselineDate,
            `Auto-baseline derived from SO line ${cand.sourceSoLineId} (${cand.sourceSoCompanySODate})`,
          )
          .run();
        inserted++;
      } else if (cand.scope === "master") {
        const exists = await db
          .prepare(
            "SELECT id FROM product_prices WHERE productId = ? AND effectiveFrom = ? LIMIT 1",
          )
          .bind(cand.productId, cand.baselineDate)
          .first<{ id: string }>();
        if (exists) continue;
        await db
          .prepare(
            `INSERT INTO product_prices
               (id, productId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`,
          )
          .bind(
            `pp-${crypto.randomUUID().slice(0, 8)}`,
            cand.productId,
            cand.basePriceSen,
            cand.baselineDate,
            `Auto-baseline derived from SO line ${cand.sourceSoLineId} (${cand.sourceSoCompanySODate})`,
          )
          .run();
        inserted++;
      }
    } catch (err) {
      errors.push({
        key: `${cand.scope}:${cand.productCode}|${cand.customerId ?? "*"}`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    planned: candidates.length,
    inserted,
    errors,
    byScope,
    skipped: skipped.slice(0, 30),
    skippedTotal: skipped.length,
    sample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/queen-price-correction-rm5?dryRun=true|false
//
// One-shot price correction for Queen Size BEDFRAMEs. Wei Siang flagged that
// the 4/26 surcharge across all Queen SKUs was applied at +RM30 instead of
// the intended +RM25 — every Queen master + customer override row needs to
// drop by RM5 (500 sen). NOT idempotent: each run subtracts another 500.
// dryRun=true returns the row counts without writing.
//
// Scope:
//   1. product_prices rows where productId is Queen BEDFRAME AND effective_from
//      = '2026-04-26' AND base_price_sen IS NOT NULL  → -500 sen each.
//   2. customer_product_prices rows that are the CURRENTLY-ACTIVE row for any
//      (customer, Queen product) pair — pick the newest row per cp where
//      effective_from <= today AND base_price_sen IS NOT NULL → -500 sen.
//
// Customers whose active cp row has base_price_sen = NULL inherit from
// master; the master edit propagates automatically — no cp edit needed.
//
// Migration-temp. Delete this endpoint once the correction is live + verified.
// ---------------------------------------------------------------------------
app.post("/queen-price-correction-rm5", async (c) => {
  const denied = await requirePermission(c, "products", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const today = new Date().toISOString().slice(0, 10);

  // 1. Queen-class BEDFRAME product ids. The "Queen" cohort isn't just
  // sizeCode='Q' — three other sizeCodes are functionally Queen too
  // (variants on 152CM / 153CM width that the catalog tracks separately):
  //   Q       → 5FT canonical Queen        (32 SKUs)
  //   152X200 → 152CMX200CM                ( 3 SKUs)
  //   153X200 → 153CMX200CM                ( 1 SKU)
  //   153     → 153CMX210CM (e.g. DIVAN)   ( 1 SKU)
  // → 37 total. Wei Siang flagged 2026-05-05 that all four buckets had
  // the same +RM30 surcharge applied 4/26 and need the same -RM5 fix.
  const queenRes = await db
    .prepare(
      `SELECT id, code FROM products
        WHERE category = 'BEDFRAME'
          AND sizeCode IN ('Q', '152X200', '153X200', '153')`,
    )
    .all<{ id: string; code: string }>();
  const queen = queenRes.results ?? [];
  if (queen.length === 0) {
    return c.json(
      { success: false, error: "No Queen BEDFRAME products found" },
      404,
    );
  }
  const queenIds = queen.map((p) => p.id);
  const placeholders = queenIds.map(() => "?").join(",");

  // 2. Master product_prices rows at 4/26 with concrete prices.
  const masterRowsRes = await db
    .prepare(
      `SELECT id, productId, basePriceSen, effectiveFrom
         FROM product_prices
        WHERE productId IN (${placeholders})
          AND effectiveFrom = '2026-04-26'
          AND basePriceSen IS NOT NULL`,
    )
    .bind(...queenIds)
    .all<{
      id: string;
      productId: string;
      basePriceSen: number;
      effectiveFrom: string;
    }>();
  const masterRows = (masterRowsRes.results ?? []).filter(
    (r) => typeof r.basePriceSen === "number",
  );

  // 3. All customer_product Queen assignments.
  const cpRes = await db
    .prepare(
      `SELECT id, customerId, productId
         FROM customer_products
        WHERE productId IN (${placeholders})`,
    )
    .bind(...queenIds)
    .all<{ id: string; customerId: string; productId: string }>();
  const cps = cpRes.results ?? [];

  // 4. For each cp, fetch the currently-active price row with concrete price.
  //    Sequential awaits (not Promise.all) to keep memory + connection usage
  //    bounded; ~88 rows is well within the request budget.
  const cpRowsToUpdate: Array<{
    rowId: string;
    cpId: string;
    customerId: string;
    productId: string;
    oldBaseSen: number;
    newBaseSen: number;
    effectiveFrom: string;
  }> = [];
  for (const cp of cps) {
    const active = await db
      .prepare(
        `SELECT id, basePriceSen, effectiveFrom
           FROM customer_product_prices
          WHERE customerProductId = ?
            AND effectiveFrom <= ?
            AND basePriceSen IS NOT NULL
          ORDER BY effectiveFrom DESC
          LIMIT 1`,
      )
      .bind(cp.id, today)
      .first<{ id: string; basePriceSen: number; effectiveFrom: string }>();
    if (active && typeof active.basePriceSen === "number") {
      cpRowsToUpdate.push({
        rowId: active.id,
        cpId: cp.id,
        customerId: cp.customerId,
        productId: cp.productId,
        oldBaseSen: active.basePriceSen,
        newBaseSen: active.basePriceSen - 500,
        effectiveFrom: active.effectiveFrom,
      });
    }
  }

  // Date histogram for the customer side — confirms the (4/26 + 4/01)
  // distribution the planner expected before going live.
  const cpDateBuckets: Record<string, number> = {};
  for (const r of cpRowsToUpdate) {
    cpDateBuckets[r.effectiveFrom] = (cpDateBuckets[r.effectiveFrom] ?? 0) + 1;
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      queenProductCount: queen.length,
      masterRowsToUpdate: masterRows.length,
      customerRowsToUpdate: cpRowsToUpdate.length,
      customerRowsByEffectiveFrom: cpDateBuckets,
      sampleMaster: masterRows.slice(0, 3).map((r) => ({
        rowId: r.id,
        productId: r.productId,
        oldRM: r.basePriceSen / 100,
        newRM: (r.basePriceSen - 500) / 100,
      })),
      sampleCustomer: cpRowsToUpdate.slice(0, 5).map((r) => ({
        rowId: r.rowId,
        customerId: r.customerId,
        productId: r.productId,
        effectiveFrom: r.effectiveFrom,
        oldRM: r.oldBaseSen / 100,
        newRM: r.newBaseSen / 100,
      })),
    });
  }

  // 5. Apply. Batched to keep round-trip count down.
  const masterStmts = masterRows.map((r) =>
    db
      .prepare(`UPDATE product_prices SET basePriceSen = ? WHERE id = ?`)
      .bind(r.basePriceSen - 500, r.id),
  );
  const custStmts = cpRowsToUpdate.map((r) =>
    db
      .prepare(`UPDATE customer_product_prices SET basePriceSen = ? WHERE id = ?`)
      .bind(r.newBaseSen, r.rowId),
  );
  let masterUpdated = 0;
  for (let i = 0; i < masterStmts.length; i += 50) {
    await db.batch(masterStmts.slice(i, i + 50));
    masterUpdated += Math.min(50, masterStmts.length - i);
  }
  let custUpdated = 0;
  for (let i = 0; i < custStmts.length; i += 50) {
    await db.batch(custStmts.slice(i, i + 50));
    custUpdated += Math.min(50, custStmts.length - i);
  }

  return c.json({
    success: true,
    dryRun: false,
    masterUpdated,
    customerUpdated: custUpdated,
    customerRowsByEffectiveFrom: cpDateBuckets,
  });
});

app.post("/apply-houzs-sofa-pricesheet", async (c) => {
  const denied = await requirePermission(c, "products", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const scope = (c.req.query("scope") || "both").toLowerCase(); // master | houzs | both
  const effectiveFrom = "2026-04-01";

  const targetBases = Object.keys(MODEL_MAP_HOUZS);
  const placeholders = targetBases.map(() => "?").join(",");
  const prodRes = await db
    .prepare(
      `SELECT id, code, baseModel, sizeCode, basePriceSen, seatHeightPrices
         FROM products
        WHERE category = 'SOFA' AND baseModel IN (${placeholders})`,
    )
    .bind(...targetBases)
    .all<{
      id: string; code: string; baseModel: string; sizeCode: string;
      basePriceSen: number | null; seatHeightPrices: string | null;
    }>();
  const prods = prodRes.results ?? [];

  // Compute new seatHeightPrices array per product. For each height, push two
  // entries (PRICE_2 BC + PRICE_3 A). Drop the height entirely when priceFor
  // returns null (per "missing → blank" rule). basePriceSen = smallest-height
  // PRICE_2 value, or null when nothing fills.
  type PerProductPlan = {
    id: string;
    code: string;
    baseModel: string;
    sizeCode: string;
    skipped: boolean;
    skipReason?: string;
    newBasePriceSen: number | null;
    newSeatHeightPrices: Array<{ height: string; priceSen: number; tier: "PRICE_2" | "PRICE_3" }>;
    cellsFilled: number;
    cellsBlank: number;
  };
  const plans: PerProductPlan[] = [];
  for (const p of prods) {
    if (p.sizeCode.startsWith("CSL")) {
      plans.push({ id: p.id, code: p.code, baseModel: p.baseModel, sizeCode: p.sizeCode,
        skipped: true, skipReason: "CSL — no sheet source",
        newBasePriceSen: p.basePriceSen, newSeatHeightPrices: [], cellsFilled: 0, cellsBlank: 0 });
      continue;
    }
    const newSeats: Array<{ height: string; priceSen: number; tier: "PRICE_2" | "PRICE_3" }> = [];
    let cellsFilled = 0, cellsBlank = 0;
    let smallestBC: number | null = null;
    for (const h of HEIGHTS_TO_FILL) {
      const cell = priceFor(p.baseModel, p.sizeCode, h);
      if (!cell) { cellsBlank++; continue; }
      cellsFilled++;
      newSeats.push({ height: String(h), priceSen: cell[0] * 100, tier: "PRICE_2" });
      newSeats.push({ height: String(h), priceSen: cell[1] * 100, tier: "PRICE_3" });
      if (smallestBC === null) smallestBC = cell[0] * 100;
    }
    plans.push({ id: p.id, code: p.code, baseModel: p.baseModel, sizeCode: p.sizeCode,
      skipped: false, newBasePriceSen: smallestBC, newSeatHeightPrices: newSeats,
      cellsFilled, cellsBlank });
  }

  const summary = {
    productsTotal: prods.length,
    productsSkipped: plans.filter(p => p.skipped).length,
    productsToWrite: plans.filter(p => !p.skipped).length,
    productsFullyBlank: plans.filter(p => !p.skipped && p.cellsFilled === 0).map(p => p.code),
    cellsFilled: plans.reduce((s, p) => s + p.cellsFilled, 0),
    cellsBlank: plans.reduce((s, p) => s + p.cellsBlank, 0),
  };

  if (dryRun) {
    return c.json({
      success: true, dryRun: true, scope, effectiveFrom,
      summary,
      sample: plans.filter(p => !p.skipped).slice(0, 3).map(p => ({
        code: p.code,
        newBasePriceRM: p.newBasePriceSen ? p.newBasePriceSen / 100 : null,
        newSeatHeightPrices: p.newSeatHeightPrices.map(s => ({
          h: s.height, t: s.tier, RM: s.priceSen / 100,
        })),
      })),
    });
  }

  // Live execute. For each product:
  //   - if scope includes master: upsert product_prices @ 4/01
  //   - if scope includes houzs:  upsert customer_product_prices @ 4/01
  //     (lookup customer_products row by (customerId='cust-1', productId))
  let masterRowsWritten = 0, houzsRowsWritten = 0, houzsSkipped = 0;
  for (const plan of plans) {
    if (plan.skipped) continue;
    const seatJson = JSON.stringify(plan.newSeatHeightPrices);

    if (scope === "master" || scope === "both") {
      const existing = await db
        .prepare(
          `SELECT id FROM product_prices
            WHERE productId = ? AND effectiveFrom = ?`,
        )
        .bind(plan.id, effectiveFrom)
        .first<{ id: string }>();
      if (existing) {
        await db
          .prepare(
            `UPDATE product_prices
                SET basePriceSen = ?, seatHeightPrices = ?
              WHERE id = ?`,
          )
          .bind(plan.newBasePriceSen, seatJson, existing.id)
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO product_prices
               (id, productId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
          )
          .bind(
            `pp-${crypto.randomUUID().slice(0, 12)}`,
            plan.id, plan.newBasePriceSen, seatJson, effectiveFrom,
            "Houzs price-sheet apply (Wei Siang 2026-05-05)",
          )
          .run();
      }
      masterRowsWritten++;
    }

    if (scope === "houzs" || scope === "both") {
      const cp = await db
        .prepare(
          `SELECT id FROM customer_products
            WHERE customerId = 'cust-1' AND productId = ?`,
        )
        .bind(plan.id)
        .first<{ id: string }>();
      if (!cp) { houzsSkipped++; continue; }
      const existing = await db
        .prepare(
          `SELECT id FROM customer_product_prices
            WHERE customerProductId = ? AND effectiveFrom = ?`,
        )
        .bind(cp.id, effectiveFrom)
        .first<{ id: string }>();
      if (existing) {
        await db
          .prepare(
            `UPDATE customer_product_prices
                SET basePriceSen = ?, seatHeightPrices = ?
              WHERE id = ?`,
          )
          .bind(plan.newBasePriceSen, seatJson, existing.id)
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO customer_product_prices
               (id, customerProductId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
          )
          .bind(
            `cpp-${crypto.randomUUID().slice(0, 12)}`,
            cp.id, plan.newBasePriceSen, seatJson, effectiveFrom,
            "Houzs price-sheet apply (Wei Siang 2026-05-05)",
          )
          .run();
      }
      // Also keep the cp row's legacy basePriceSen mirror in sync — readers
      // that ignore history fall back to it. Same value as the smallest-height
      // PRICE_2.
      await db
        .prepare(
          `UPDATE customer_products
              SET basePriceSen = ?, seatHeightPrices = ?
            WHERE id = ?`,
        )
        .bind(plan.newBasePriceSen, seatJson, cp.id)
        .run();
      houzsRowsWritten++;
    }
  }
  // Mirror smallest-height PRICE_2 onto the products table itself for legacy
  // readers (cost ledger derives from it via `products.basePriceSen` when
  // history isn't queried).
  if (scope === "master" || scope === "both") {
    for (const plan of plans) {
      if (plan.skipped) continue;
      await db
        .prepare(
          `UPDATE products
              SET basePriceSen = ?, seatHeightPrices = ?
            WHERE id = ?`,
        )
        .bind(plan.newBasePriceSen, JSON.stringify(plan.newSeatHeightPrices), plan.id)
        .run();
    }
  }

  return c.json({
    success: true, dryRun: false, scope, effectiveFrom,
    summary, masterRowsWritten, houzsRowsWritten, houzsSkipped,
  });
});

app.post("/recompute-so-sofa-prices", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const statusFilter = (c.req.query("statuses") || "").trim()
    ? c.req.query("statuses")!.split(",").map(s => s.trim()).filter(Boolean)
    : ["IN_PRODUCTION", "READY_TO_SHIP", "CONFIRMED", "DRAFT"];
  const today = new Date().toISOString().slice(0, 10);

  // 1. Fabric → tier map. Table is `fabric_trackings` (plural) per
  //    routes/fabric-tracking.ts. Split tiers (sofa vs bedframe) live in
  //    sofaPriceTier / bedframePriceTier; legacy priceTier is the fallback.
  const ftRes = await db
    .prepare(
      `SELECT fabricCode, sofaPriceTier, bedframePriceTier, priceTier
         FROM fabric_trackings`,
    )
    .all<{
      fabricCode: string;
      sofaPriceTier: string | null;
      bedframePriceTier: string | null;
      priceTier: string | null;
    }>();
  const fabricSofaTierMap = new Map<string, string>();
  const fabricBedframeTierMap = new Map<string, string>();
  for (const r of (ftRes.results ?? [])) {
    fabricSofaTierMap.set(
      r.fabricCode,
      r.sofaPriceTier ?? r.priceTier ?? "PRICE_2",
    );
    fabricBedframeTierMap.set(
      r.fabricCode,
      r.bedframePriceTier ?? r.priceTier ?? "PRICE_2",
    );
  }

  // 2. Pull SOs in scope + their items (single broad fetch).
  const soPlaceholders = statusFilter.map(() => "?").join(",");
  const soRes = await db
    .prepare(
      `SELECT id, companySOId, customerId, customerName, status,
              companySODate, created_at AS createdAt
         FROM sales_orders
        WHERE status IN (${soPlaceholders})`,
    )
    .bind(...statusFilter)
    .all<SoRow>();
  const sos = soRes.results ?? [];
  if (sos.length === 0) {
    return c.json({ success: true, dryRun, scope: statusFilter, soCount: 0 });
  }
  const soIds = sos.map(s => s.id);
  const soById = new Map(sos.map(s => [s.id, s] as const));

  // 3. All SOFA + BEDFRAME + ACCESSORY line items for those SOs. SOFA uses
  //    the seatHeightPrices matrix keyed on (height, tier); BEDFRAME and
  //    ACCESSORY use the SKU-level basePriceSen directly (no matrix).
  const itemsRes = await db
    .prepare(
      `SELECT id, salesOrderId, productId, productCode, itemCategory, sizeCode,
              fabricCode, quantity, gapInches, divanHeightInches, divanPriceSen,
              legHeightInches, legPriceSen, specialOrder, specialOrderPriceSen,
              basePriceSen, unitPriceSen, lineTotalSen
         FROM sales_order_items
        WHERE itemCategory IN ('SOFA','BEDFRAME','ACCESSORY')
          AND salesOrderId IN (${soIds.map(() => "?").join(",")})`,
    )
    .bind(...soIds)
    .all<SoiRow>();
  const items = (itemsRes.results ?? []).filter((it) => {
    if (!it.productCode) return false;
    if (it.itemCategory === "SOFA") {
      return SOFA_TARGET_BASES.some((b) => it.productCode!.startsWith(b + "-"));
    }
    // BEDFRAME + ACCESSORY — accept all (no whitelist).
    return it.itemCategory === "BEDFRAME" || it.itemCategory === "ACCESSORY";
  });

  // 4. Pre-load customer_product_prices history for every (customerId,
  //    productId) combo touched by these items. Map → array of history rows.
  const cpKeys = Array.from(new Set(items.map((it) => {
    const so = soById.get(it.salesOrderId);
    if (!so?.customerId || !it.productId) return null;
    return `${so.customerId}|${it.productId}`;
  }).filter((k): k is string => k !== null)));
  const cpHistMap = new Map<string, Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>>();
  for (const k of cpKeys) {
    const [customerId, productId] = k.split("|");
    const cpRes = await db
      .prepare(
        `SELECT cpp.basePriceSen, cpp.seatHeightPrices, cpp.effectiveFrom
           FROM customer_products cp
           JOIN customer_product_prices cpp ON cpp.customerProductId = cp.id
          WHERE cp.customerId = ? AND cp.productId = ?
          ORDER BY cpp.effectiveFrom DESC`,
      )
      .bind(customerId, productId)
      .all<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>();
    cpHistMap.set(k, cpRes.results ?? []);
  }

  // 5. Pre-load master product_prices for products without customer overrides.
  const productIds = Array.from(new Set(items.map(it => it.productId).filter((p): p is string => !!p)));
  const masterHistMap = new Map<string, Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>>();
  for (const pid of productIds) {
    const mhRes = await db
      .prepare(
        `SELECT basePriceSen, seatHeightPrices, effectiveFrom
           FROM product_prices
          WHERE productId = ?
          ORDER BY effectiveFrom DESC`,
      )
      .bind(pid)
      .all<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>();
    masterHistMap.set(pid, mhRes.results ?? []);
  }

  type SeatHeightEntry = { height: string; priceSen: number; tier?: string };
  function pickActive(
    rows: Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>,
    asOf: string,
  ): { basePriceSen: number; entries: SeatHeightEntry[] } | null {
    const usable = rows
      .filter((r) => r.effectiveFrom <= asOf && r.basePriceSen != null)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    const r = usable[0];
    if (!r) return null;
    let entries: SeatHeightEntry[] = [];
    try {
      entries = (JSON.parse(r.seatHeightPrices ?? "[]") || []) as SeatHeightEntry[];
    } catch { /* ignore */ }
    return { basePriceSen: r.basePriceSen!, entries };
  }
  function lookupSeatHeight(
    entries: SeatHeightEntry[], height: string, tier: string,
  ): number | null {
    // Exact (height, tier) match
    let m = entries.find(e => e.height === height && e.tier === tier);
    if (m) return m.priceSen;
    // Same height, tier missing → treat as PRICE_2 default
    if (tier === "PRICE_2") {
      m = entries.find(e => e.height === height && !e.tier);
      if (m) return m.priceSen;
    }
    // No height match
    return null;
  }

  type ChangePlan = {
    soId: string;
    companySOId: string | null;
    customerName: string | null;
    status: string | null;
    itemId: string;
    productCode: string | null;
    sizeCode: string | null;
    fabricCode: string | null;
    fabricTier: string | null;
    quantity: number;
    oldBaseRM: number;
    newBaseRM: number | null;
    oldUnitRM: number;
    newUnitRM: number | null;
    oldLineRM: number;
    newLineRM: number | null;
    skipReason?: string;
  };
  const plans: ChangePlan[] = [];
  for (const it of items) {
    const so = soById.get(it.salesOrderId)!;
    // Sofa + Accessory share sofaPriceTier; Bedframe uses bedframePriceTier.
    const tier = it.fabricCode
      ? (it.itemCategory === "BEDFRAME"
          ? fabricBedframeTierMap.get(it.fabricCode)
          : fabricSofaTierMap.get(it.fabricCode)) || "PRICE_2"
      : "PRICE_2";
    const asOf = (so.companySODate || so.createdAt || today).slice(0, 10);
    const cpKey = so.customerId && it.productId ? `${so.customerId}|${it.productId}` : null;
    const cpHist = cpKey ? cpHistMap.get(cpKey) ?? [] : [];
    const masterHist = it.productId ? masterHistMap.get(it.productId) ?? [] : [];
    const cpActive = cpHist.length ? pickActive(cpHist, asOf) : null;
    const masterActive = pickActive(masterHist, asOf);
    const active = cpActive ?? masterActive;
    const plan: ChangePlan = {
      soId: it.salesOrderId,
      companySOId: so.companySOId,
      customerName: so.customerName,
      status: so.status,
      itemId: it.id,
      productCode: it.productCode,
      sizeCode: it.sizeCode,
      fabricCode: it.fabricCode,
      fabricTier: tier,
      quantity: it.quantity,
      oldBaseRM: it.basePriceSen / 100,
      newBaseRM: null,
      oldUnitRM: it.unitPriceSen / 100,
      newUnitRM: null,
      oldLineRM: it.lineTotalSen / 100,
      newLineRM: null,
    };
    if (!active) { plan.skipReason = "no active price row (cust + master both missing)"; plans.push(plan); continue; }
    let priceSen: number | null = null;
    if (it.itemCategory === "SOFA") {
      // Sofa uses the per-(seatHeight, tier) matrix.
      if (!it.sizeCode) { plan.skipReason = "missing sizeCode (seat height)"; plans.push(plan); continue; }
      priceSen = lookupSeatHeight(active.entries, it.sizeCode, tier);
      if (priceSen == null) { plan.skipReason = `no seat-height entry for ${it.sizeCode}/${tier}`; plans.push(plan); continue; }
    } else {
      // BEDFRAME / ACCESSORY — basePriceSen is per-SKU; product code already
      // encodes the size (e.g. "1003-(Q)"). No tier lookup needed.
      priceSen = active.basePriceSen;
    }
    const newUnit = priceSen + it.legPriceSen + it.divanPriceSen + it.specialOrderPriceSen;
    const newLine = newUnit * it.quantity;
    plan.newBaseRM = priceSen / 100;
    plan.newUnitRM = newUnit / 100;
    plan.newLineRM = newLine / 100;
    plans.push(plan);
  }

  // 6. Combo pass — mirrors src/pages/sales/create.tsx:1103-1267. Sofa lines
  //    on the same SO that share baseModel + fabric tier + seat height and
  //    whose component sizes match a sofa_combo_rule's componentSizes get
  //    re-distributed so the GROUP SUM == comboTotal (rule price for that
  //    seatHeight). Without this pass, recompute restores full-retail
  //    per-piece prices and silently strips the combo discount.
  //
  // ⚠️ DRIFT WARNING — canonical engine is applySofaCombos
  //    (src/api/lib/sofa-combo.ts), pinned by
  //    tests/sofa-combo-drift-guard.test.mjs. This inline copy re-implements the
  //    same maths and now ALSO loops so multiple identical sets in one order
  //    each get the combo (2026-07-23, matching applySofaCombos). It is still a
  //    SEPARATE copy — keep it in sync with any change to applySofaCombos (or
  //    refactor this manual repricer to call it directly).
  //
  // 🛑 DELIBERATE DIVERGENCE 2026-08-07 — do NOT "sync" this one.
  //    applySofaCombos now rounds every UNIT price UP to a whole ringgit
  //    (owner pricing policy; see distributeComboUnitPrices in
  //    src/api/lib/sofa-combo.ts). This endpoint REPRICES ORDERS THAT ALREADY
  //    EXIST — /recompute-so-sofa-prices and the /recompute-co-sofa-prices twin
  //    below — so adopting the round-up here would move money on documents that
  //    have already been issued to customers, always in our favour. That is a
  //    dispute, not a fix. The policy applies to what is computed FROM NOW ON;
  //    this repricer stays on the old floor/round/residual maths on purpose.
  //    If the owner ever asks for historical orders to be re-rounded, that is a
  //    separate, explicitly-confirmed data migration — not a code sync.
  type ComboRule = {
    baseModel: string;
    componentSizes: unknown; // string[] | string[][]
    fabricTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | "ANY";
    pricesByHeight: Record<string, number>;
    customerId: string | null;
    effectiveFrom: string;
  };
  const comboRes = await db
    .prepare(
      `SELECT baseModel, componentSizes, fabricTier, pricesByHeight,
              customerId, effectiveFrom
         FROM sofa_combo_rules
        WHERE effectiveFrom <= ?`,
    )
    .bind(today)
    .all<{
      baseModel: string; componentSizes: string;
      fabricTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | "ANY";
      pricesByHeight: string; customerId: string | null; effectiveFrom: string;
    }>();
  const comboRules: ComboRule[] = (comboRes.results ?? []).map((r) => ({
    baseModel: r.baseModel, fabricTier: r.fabricTier,
    customerId: r.customerId, effectiveFrom: r.effectiveFrom,
    componentSizes: (() => { try { return JSON.parse(r.componentSizes); } catch { return []; } })(),
    pricesByHeight: (() => { try { return JSON.parse(r.pricesByHeight); } catch { return {}; } })(),
  }));
  // Greedy subset matcher — mirrors findComboSubset in create.tsx.
  // Returns the subset of the input plans whose compartment variants fill
  // the rule's pieces (one plan per rule slot, greedy first-match), or
  // null when the rule can't be fully satisfied. Extras outside the
  // returned subset stay at full master price (no discount bleed).
  function findComboSubset(
    groups: unknown,
    items: Array<{ variant: string; plan: ChangePlan }>,
  ): ChangePlan[] | null {
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const isGrouped = Array.isArray(groups[0]);
    const remaining = items.slice();
    const matched: ChangePlan[] = [];
    if (!isGrouped) {
      for (const ruleSize of (groups as string[])) {
        const idx = remaining.findIndex((it) => it.variant === ruleSize);
        if (idx === -1) return null;
        matched.push(remaining[idx].plan);
        remaining.splice(idx, 1);
      }
      return matched;
    }
    for (const groupOpts of (groups as string[][])) {
      const idx = remaining.findIndex((it) => groupOpts.includes(it.variant));
      if (idx === -1) return null;
      matched.push(remaining[idx].plan);
      remaining.splice(idx, 1);
    }
    return matched;
  }
  // Index plans by SO for grouping. Sofa-only.
  const plansBySo = new Map<string, ChangePlan[]>();
  for (const p of plans) {
    if (p.skipReason || p.newLineRM == null) continue;
    const arr = plansBySo.get(p.soId) ?? [];
    arr.push(p);
    plansBySo.set(p.soId, arr);
  }
  let comboMatches = 0;
  for (const [soId, soPlans] of plansBySo) {
    const so = soById.get(soId)!;
    const sofaPlans = soPlans.filter((p) => {
      const it = items.find(i => i.id === p.itemId);
      return it?.itemCategory === "SOFA";
    });
    if (sofaPlans.length < 2) continue;
    // Group by baseModel.
    const byBase = new Map<string, ChangePlan[]>();
    for (const p of sofaPlans) {
      const baseModel = (p.productCode || "").split("-")[0];
      const arr = byBase.get(baseModel) ?? [];
      arr.push(p);
      byBase.set(baseModel, arr);
    }
    for (const [baseModel, group] of byBase) {
      if (group.length < 2) continue;
      // Uniform tier + seatHeight required.
      const tiers = new Set(group.map((g) => g.fabricTier));
      if (tiers.size > 1) continue;
      const heights = new Set(group.map((g) => g.sizeCode));
      if (heights.size > 1) continue;
      const seatHeight = [...heights][0]!;
      const groupTier = [...tiers][0]!;
      // Compartment variants — strip the productCode prefix to get the
      // (1A(LHF), 2NA, etc.) token used by combo rule matching. Pair
      // each variant with its plan so findComboSubset can return the
      // matched plans directly.
      const priorityOf = (r: ComboRule): number => {
        const isCustomer = r.customerId === so.customerId && so.customerId;
        const tierMatch = r.fabricTier === groupTier;
        if (isCustomer && tierMatch) return 4;
        if (isCustomer && r.fabricTier === "ANY") return 3;
        if (!r.customerId && tierMatch) return 2;
        if (!r.customerId && r.fabricTier === "ANY") return 1;
        return 0;
      };
      // A group can hold MULTIPLE complete sets (a customer ordering two
      // identical combos). Re-match on the REMAINING pieces until none is left
      // so EVERY set gets the discount — matches the canonical applySofaCombos
      // (which loops). Before this the recompute only combo'd the first set and
      // left the 2nd+ at full retail (the over-charge PR #95 fixed live).
      let remaining = group.map((g) => {
        const code = g.productCode || "";
        const dash = code.indexOf("-");
        return { variant: dash >= 0 ? code.slice(dash + 1) : "", plan: g };
      }).filter((x) => x.variant);
      for (let guard = remaining.length; guard > 0 && remaining.length >= 2; guard--) {
        const candidates = comboRules
          .filter((r) =>
            r.baseModel === baseModel
              && (r.effectiveFrom <= (so.companySODate || so.createdAt || today)),
          )
          .map((r) => ({ r, subset: findComboSubset(r.componentSizes, remaining) }))
          .filter((x): x is { r: ComboRule; subset: ChangePlan[] } => x.subset !== null);
        if (candidates.length === 0) break;
        const best = candidates
          .map(({ r, subset }) => ({ r, subset, p: priorityOf(r) }))
          .filter((x) => x.p > 0)
          .sort((a, b) =>
            b.p - a.p || (a.r.effectiveFrom < b.r.effectiveFrom ? 1 : -1),
          )[0];
        if (!best) break;
        // Consume this set from `remaining` regardless of discount so a
        // following identical set can still be matched.
        const consumedIds = new Set(best.subset.map((p) => p.itemId));
        remaining = remaining.filter((x) => !consumedIds.has(x.plan.itemId));
        const comboTotalRM = (best.r.pricesByHeight[seatHeight] ?? 0) / 100;
        if (comboTotalRM <= 0) continue;
        // Subset sum only — extras (non-subset plans) keep full master price.
        const subsetSumRM = best.subset.reduce((s, p) => s + (p.newLineRM ?? 0), 0);
        if (subsetSumRM <= comboTotalRM) continue; // already at/below combo total
        const ratio = comboTotalRM / subsetSumRM;
        // Distribute proportionally across the SUBSET only.
        let runningGroupSumSen = 0;
        const adjusted: ChangePlan[] = [];
        for (const p of best.subset) {
          const it = items.find(i => i.id === p.itemId)!;
          const oldLineSen = (p.newLineRM ?? 0) * 100;
          const adjustedLineSen = Math.floor(oldLineSen * ratio);
          const surchargesPerUnit =
            it.divanPriceSen + it.legPriceSen + it.specialOrderPriceSen;
          const adjustedUnitSen = Math.max(
            0, Math.round(adjustedLineSen / Math.max(1, it.quantity)),
          );
          const newBaseSen = Math.max(0, adjustedUnitSen - surchargesPerUnit);
          const newUnitSen = newBaseSen + surchargesPerUnit;
          const newLineSen = newUnitSen * it.quantity;
          p.newBaseRM = newBaseSen / 100;
          p.newUnitRM = newUnitSen / 100;
          p.newLineRM = newLineSen / 100;
          runningGroupSumSen += newLineSen;
          adjusted.push(p);
        }
        // Rounding residual → push into highest-base line in the subset.
        const residualSen = (comboTotalRM * 100) - runningGroupSumSen;
        if (residualSen !== 0 && adjusted.length > 0) {
          const target = adjusted.slice().sort(
            (a, b) => (b.newBaseRM ?? 0) - (a.newBaseRM ?? 0),
          )[0];
          const it = items.find(i => i.id === target.itemId)!;
          const surchargesPerUnit =
            it.divanPriceSen + it.legPriceSen + it.specialOrderPriceSen;
          const cur = (target.newBaseRM ?? 0) * 100;
          const adj = cur + Math.round(residualSen / Math.max(1, it.quantity));
          const newBase = Math.max(0, adj);
          const newUnit = newBase + surchargesPerUnit;
          const newLine = newUnit * it.quantity;
          target.newBaseRM = newBase / 100;
          target.newUnitRM = newUnit / 100;
          target.newLineRM = newLine / 100;
        }
        comboMatches++;
      }
    }
  }

  // Summary stats
  const willChange = plans.filter(p => p.newLineRM != null && p.newLineRM !== p.oldLineRM);
  const noChange = plans.filter(p => p.newLineRM != null && p.newLineRM === p.oldLineRM);
  const skipped = plans.filter(p => p.skipReason);
  const sumDiff = willChange.reduce((s, p) => s + ((p.newLineRM ?? 0) - p.oldLineRM), 0);
  const summary = {
    soCount: sos.length,
    sofaItemsConsidered: items.length,
    willChange: willChange.length,
    noChange: noChange.length,
    skipped: skipped.length,
    skipReasons: skipped.reduce<Record<string, number>>((acc, p) => {
      acc[p.skipReason!] = (acc[p.skipReason!] || 0) + 1; return acc;
    }, {}),
    comboMatchedGroups: comboMatches,
    sumLineDiffRM: Math.round(sumDiff * 100) / 100,
  };

  if (dryRun) {
    return c.json({
      success: true, dryRun: true, scope: statusFilter, summary,
      sampleChanges: willChange.slice(0, 10).map(p => ({
        so: p.companySOId, cust: p.customerName, status: p.status,
        product: p.productCode, sz: p.sizeCode, fab: p.fabricCode, tier: p.fabricTier,
        oldBase: p.oldBaseRM, newBase: p.newBaseRM,
        oldLine: p.oldLineRM, newLine: p.newLineRM,
        diff: Math.round(((p.newLineRM ?? 0) - p.oldLineRM) * 100) / 100,
        qty: p.quantity,
      })),
      sampleSkipped: skipped.slice(0, 5).map(p => ({
        so: p.companySOId, product: p.productCode, sz: p.sizeCode, fab: p.fabricCode, reason: p.skipReason,
      })),
    });
  }

  // Live execute. Update items first; then recompute each affected SO total.
  let itemsUpdated = 0;
  const dirtySoIds = new Set<string>();
  for (let i = 0; i < willChange.length; i += 50) {
    const batch = willChange.slice(i, i + 50);
    const stmts: ReturnType<D1Database["prepare"]>[] = [];
    for (const p of batch) {
      stmts.push(
        db.prepare(
          `UPDATE sales_order_items
              SET basePriceSen = ?, unitPriceSen = ?, lineTotalSen = ?
            WHERE id = ?`,
        ).bind(
          Math.round((p.newBaseRM ?? 0) * 100),
          Math.round((p.newUnitRM ?? 0) * 100),
          Math.round((p.newLineRM ?? 0) * 100),
          p.itemId,
        ),
      );
      dirtySoIds.add(p.soId);
    }
    if (stmts.length > 0) await db.batch(stmts);
    itemsUpdated += batch.length;
  }

  // Recompute SO subtotal/total: sum sales_order_items.line_total_sen.
  let sosUpdated = 0;
  for (const soId of dirtySoIds) {
    const sumRes = await db
      .prepare(
        `SELECT COALESCE(SUM(lineTotalSen), 0) AS sub
           FROM sales_order_items WHERE salesOrderId = ?`,
      )
      .bind(soId)
      .first<{ sub: number }>();
    const sub = sumRes?.sub ?? 0;
    // SO has subtotal_sen / grand_total_sen — keep tax/discount untouched,
    // just refresh subtotal + grand. (Tax/discount columns are not on every
    // SO; do a defensive UPDATE that only sets subtotal_sen and let an
    // existing grand_total_sen stay if the column doesn't exist via the
    // adapter quirks. We'll set grand_total_sen = subtotal_sen since the
    // current SOs in this dataset don't carry separate tax.)
    await db
      .prepare(
        `UPDATE sales_orders
            SET subtotalSen = ?, totalSen = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(sub, sub, new Date().toISOString(), soId)
      .run();
    sosUpdated++;
  }

  return c.json({
    success: true, dryRun: false, scope: statusFilter, summary,
    itemsUpdated, sosUpdated,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/recompute-co-sofa-prices?dryRun=true|false&statuses=...
//
// CO twin of /recompute-so-sofa-prices — same logic, different tables.
// Rebuilds basePriceSen / unitPriceSen / lineTotalSen on every CO line item
// in active consignment_orders, with the same per-line price resolution
// (customer override → master fallback at companyCODate, fabric tier from
// fabric_trackings.sofaPriceTier or bedframePriceTier) and the same sofa-
// combo subset matching pass (extras keep master price, no discount bleed).
//
// CO create flow doesn't currently bake combo discount, so this is also
// the first time CO line items get combo redistribution.
// ---------------------------------------------------------------------------
app.post("/recompute-co-sofa-prices", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const statusFilter = (c.req.query("statuses") || "").trim()
    ? c.req.query("statuses")!.split(",").map(s => s.trim()).filter(Boolean)
    : ["IN_PRODUCTION", "READY_TO_SHIP", "CONFIRMED", "DRAFT"];
  const today = new Date().toISOString().slice(0, 10);

  // Fabric → tier maps (same as SO version).
  const ftRes = await db
    .prepare(
      `SELECT fabricCode, sofaPriceTier, bedframePriceTier, priceTier
         FROM fabric_trackings`,
    )
    .all<{ fabricCode: string; sofaPriceTier: string | null; bedframePriceTier: string | null; priceTier: string | null }>();
  const fabricSofaTierMap = new Map<string, string>();
  const fabricBedframeTierMap = new Map<string, string>();
  for (const r of (ftRes.results ?? [])) {
    fabricSofaTierMap.set(r.fabricCode, r.sofaPriceTier ?? r.priceTier ?? "PRICE_2");
    fabricBedframeTierMap.set(r.fabricCode, r.bedframePriceTier ?? r.priceTier ?? "PRICE_2");
  }

  // Pull COs in scope.
  const coPlaceholders = statusFilter.map(() => "?").join(",");
  const coRes = await db
    .prepare(
      `SELECT id, companyCOId, customerId, customerName, status,
              companyCODate, created_at AS createdAt
         FROM consignment_orders
        WHERE status IN (${coPlaceholders})`,
    )
    .bind(...statusFilter)
    .all<{ id: string; companyCOId: string | null; customerId: string | null; customerName: string | null; status: string | null; companyCODate: string | null; createdAt: string | null }>();
  const cos = coRes.results ?? [];
  if (cos.length === 0) {
    return c.json({ success: true, dryRun, scope: statusFilter, coCount: 0 });
  }
  const coIds = cos.map(s => s.id);
  const coById = new Map(cos.map(s => [s.id, s] as const));

  type CoiRow = SoiRow & { consignmentOrderId: string };
  const itemsRes = await db
    .prepare(
      `SELECT id, consignmentOrderId AS salesOrderId, productId, productCode, itemCategory, sizeCode,
              fabricCode, quantity, gapInches, divanHeightInches, divanPriceSen,
              legHeightInches, legPriceSen, specialOrder, specialOrderPriceSen,
              basePriceSen, unitPriceSen, lineTotalSen
         FROM consignment_order_items
        WHERE itemCategory IN ('SOFA','BEDFRAME','ACCESSORY')
          AND consignmentOrderId IN (${coIds.map(() => "?").join(",")})`,
    )
    .bind(...coIds)
    .all<CoiRow>();
  const items = (itemsRes.results ?? []).filter((it) => {
    if (!it.productCode) return false;
    if (it.itemCategory === "SOFA") {
      return SOFA_TARGET_BASES.some((b) => it.productCode!.startsWith(b + "-"));
    }
    return it.itemCategory === "BEDFRAME" || it.itemCategory === "ACCESSORY";
  });

  // Pre-load customer + master price history (mirrors SO version).
  const cpKeys = Array.from(new Set(items.map((it) => {
    const co = coById.get(it.salesOrderId);
    if (!co?.customerId || !it.productId) return null;
    return `${co.customerId}|${it.productId}`;
  }).filter((k): k is string => k !== null)));
  const cpHistMap = new Map<string, Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>>();
  for (const k of cpKeys) {
    const [customerId, productId] = k.split("|");
    const cpRes = await db
      .prepare(
        `SELECT cpp.basePriceSen, cpp.seatHeightPrices, cpp.effectiveFrom
           FROM customer_products cp
           JOIN customer_product_prices cpp ON cpp.customerProductId = cp.id
          WHERE cp.customerId = ? AND cp.productId = ?
          ORDER BY cpp.effectiveFrom DESC`,
      )
      .bind(customerId, productId)
      .all<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>();
    cpHistMap.set(k, cpRes.results ?? []);
  }
  const productIds = Array.from(new Set(items.map(it => it.productId).filter((p): p is string => !!p)));
  const masterHistMap = new Map<string, Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>>();
  for (const pid of productIds) {
    const mhRes = await db
      .prepare(
        `SELECT basePriceSen, seatHeightPrices, effectiveFrom
           FROM product_prices
          WHERE productId = ?
          ORDER BY effectiveFrom DESC`,
      )
      .bind(pid)
      .all<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>();
    masterHistMap.set(pid, mhRes.results ?? []);
  }

  type SeatHeightEntry = { height: string; priceSen: number; tier?: string };
  function pickActive(rows: Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>, asOf: string) {
    const usable = rows.filter((r) => r.effectiveFrom <= asOf && r.basePriceSen != null).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    const r = usable[0];
    if (!r) return null;
    let entries: SeatHeightEntry[] = [];
    try { entries = (JSON.parse(r.seatHeightPrices ?? "[]") || []) as SeatHeightEntry[]; } catch { /* ignore */ }
    return { basePriceSen: r.basePriceSen!, entries };
  }
  function lookupSeatHeight(entries: SeatHeightEntry[], height: string, tier: string): number | null {
    let m = entries.find(e => e.height === height && e.tier === tier);
    if (m) return m.priceSen;
    if (tier === "PRICE_2") {
      m = entries.find(e => e.height === height && !e.tier);
      if (m) return m.priceSen;
    }
    return null;
  }

  type ChangePlan2 = {
    coId: string; companyCOId: string | null; customerName: string | null; status: string | null;
    itemId: string; productCode: string | null; sizeCode: string | null;
    fabricCode: string | null; fabricTier: string | null; quantity: number;
    oldBaseRM: number; newBaseRM: number | null;
    oldUnitRM: number; newUnitRM: number | null;
    oldLineRM: number; newLineRM: number | null;
    skipReason?: string;
  };
  const plans: ChangePlan2[] = [];
  for (const it of items) {
    const co = coById.get(it.salesOrderId)!;
    const tier = it.fabricCode
      ? (it.itemCategory === "BEDFRAME"
          ? fabricBedframeTierMap.get(it.fabricCode)
          : fabricSofaTierMap.get(it.fabricCode)) || "PRICE_2"
      : "PRICE_2";
    const asOf = (co.companyCODate || co.createdAt || today).slice(0, 10);
    const cpKey = co.customerId && it.productId ? `${co.customerId}|${it.productId}` : null;
    const cpHist = cpKey ? cpHistMap.get(cpKey) ?? [] : [];
    const masterHist = it.productId ? masterHistMap.get(it.productId) ?? [] : [];
    const cpActive = cpHist.length ? pickActive(cpHist, asOf) : null;
    const masterActive = pickActive(masterHist, asOf);
    const active = cpActive ?? masterActive;
    const plan: ChangePlan2 = {
      coId: it.salesOrderId, companyCOId: co.companyCOId, customerName: co.customerName, status: co.status,
      itemId: it.id, productCode: it.productCode, sizeCode: it.sizeCode,
      fabricCode: it.fabricCode, fabricTier: tier, quantity: it.quantity,
      oldBaseRM: it.basePriceSen / 100, newBaseRM: null,
      oldUnitRM: it.unitPriceSen / 100, newUnitRM: null,
      oldLineRM: it.lineTotalSen / 100, newLineRM: null,
    };
    if (!active) { plan.skipReason = "no active price row"; plans.push(plan); continue; }
    let priceSen: number | null = null;
    if (it.itemCategory === "SOFA") {
      if (!it.sizeCode) { plan.skipReason = "missing sizeCode"; plans.push(plan); continue; }
      priceSen = lookupSeatHeight(active.entries, it.sizeCode, tier);
      if (priceSen == null) { plan.skipReason = `no seat-height entry for ${it.sizeCode}/${tier}`; plans.push(plan); continue; }
    } else {
      priceSen = active.basePriceSen;
    }
    const newUnit = priceSen + it.legPriceSen + it.divanPriceSen + it.specialOrderPriceSen;
    const newLine = newUnit * it.quantity;
    plan.newBaseRM = priceSen / 100;
    plan.newUnitRM = newUnit / 100;
    plan.newLineRM = newLine / 100;
    plans.push(plan);
  }

  // Sofa combo subset pass (mirrors SO version).
  type ComboRule = { baseModel: string; componentSizes: unknown; fabricTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | "ANY"; pricesByHeight: Record<string, number>; customerId: string | null; effectiveFrom: string };
  const comboRes = await db
    .prepare(
      `SELECT baseModel, componentSizes, fabricTier, pricesByHeight, customerId, effectiveFrom
         FROM sofa_combo_rules
        WHERE effectiveFrom <= ?`,
    )
    .bind(today)
    .all<{ baseModel: string; componentSizes: string; fabricTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | "ANY"; pricesByHeight: string; customerId: string | null; effectiveFrom: string }>();
  const comboRules: ComboRule[] = (comboRes.results ?? []).map((r) => ({
    baseModel: r.baseModel, fabricTier: r.fabricTier, customerId: r.customerId, effectiveFrom: r.effectiveFrom,
    componentSizes: (() => { try { return JSON.parse(r.componentSizes); } catch { return []; } })(),
    pricesByHeight: (() => { try { return JSON.parse(r.pricesByHeight); } catch { return {}; } })(),
  }));
  function findComboSubsetCo(groups: unknown, items2: Array<{ variant: string; plan: ChangePlan2 }>): ChangePlan2[] | null {
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const isGrouped = Array.isArray(groups[0]);
    const remaining = items2.slice();
    const matched: ChangePlan2[] = [];
    if (!isGrouped) {
      for (const ruleSize of (groups as string[])) {
        const idx = remaining.findIndex((it) => it.variant === ruleSize);
        if (idx === -1) return null;
        matched.push(remaining[idx].plan); remaining.splice(idx, 1);
      }
      return matched;
    }
    for (const groupOpts of (groups as string[][])) {
      const idx = remaining.findIndex((it) => groupOpts.includes(it.variant));
      if (idx === -1) return null;
      matched.push(remaining[idx].plan); remaining.splice(idx, 1);
    }
    return matched;
  }

  const plansByCo = new Map<string, ChangePlan2[]>();
  for (const p of plans) {
    if (p.skipReason || p.newLineRM == null) continue;
    const arr = plansByCo.get(p.coId) ?? [];
    arr.push(p); plansByCo.set(p.coId, arr);
  }
  let comboMatches = 0;
  for (const [coId, coPlans] of plansByCo) {
    const co = coById.get(coId)!;
    const sofaPlans = coPlans.filter((p) => {
      const it = items.find(i => i.id === p.itemId);
      return it?.itemCategory === "SOFA";
    });
    if (sofaPlans.length < 2) continue;
    const byBase = new Map<string, ChangePlan2[]>();
    for (const p of sofaPlans) {
      const baseModel = (p.productCode || "").split("-")[0];
      const arr = byBase.get(baseModel) ?? [];
      arr.push(p); byBase.set(baseModel, arr);
    }
    for (const [baseModel, group] of byBase) {
      if (group.length < 2) continue;
      const tiers = new Set(group.map((g) => g.fabricTier));
      if (tiers.size > 1) continue;
      const heights = new Set(group.map((g) => g.sizeCode));
      if (heights.size > 1) continue;
      const seatHeight = [...heights][0]!;
      const groupTier = [...tiers][0]!;
      const priorityOf = (r: ComboRule): number => {
        const isCustomer = r.customerId === co.customerId && co.customerId;
        const tierMatch = r.fabricTier === groupTier;
        if (isCustomer && tierMatch) return 4;
        if (isCustomer && r.fabricTier === "ANY") return 3;
        if (!r.customerId && tierMatch) return 2;
        if (!r.customerId && r.fabricTier === "ANY") return 1;
        return 0;
      };
      // Multi-set: re-match on the REMAINING pieces so every complete set in the
      // group gets the combo (matches applySofaCombos; was only combo'ing the
      // first set — over-charging the 2nd+, the bug PR #95 fixed live).
      let remaining = group.map((g) => {
        const code = g.productCode || "";
        const dash = code.indexOf("-");
        return { variant: dash >= 0 ? code.slice(dash + 1) : "", plan: g };
      }).filter((x) => x.variant);
      for (let guard = remaining.length; guard > 0 && remaining.length >= 2; guard--) {
        const candidates = comboRules
          .filter((r) => r.baseModel === baseModel && r.effectiveFrom <= (co.companyCODate || co.createdAt || today))
          .map((r) => ({ r, subset: findComboSubsetCo(r.componentSizes, remaining) }))
          .filter((x): x is { r: ComboRule; subset: ChangePlan2[] } => x.subset !== null);
        if (candidates.length === 0) break;
        const best = candidates
          .map(({ r, subset }) => ({ r, subset, p: priorityOf(r) }))
          .filter((x) => x.p > 0)
          .sort((a, b) => b.p - a.p || (a.r.effectiveFrom < b.r.effectiveFrom ? 1 : -1))[0];
        if (!best) break;
        const consumedIds = new Set(best.subset.map((p) => p.itemId));
        remaining = remaining.filter((x) => !consumedIds.has(x.plan.itemId));
        const comboTotalRM = (best.r.pricesByHeight[seatHeight] ?? 0) / 100;
        if (comboTotalRM <= 0) continue;
        const subsetSumRM = best.subset.reduce((s, p) => s + (p.newLineRM ?? 0), 0);
        if (subsetSumRM <= comboTotalRM) continue;
        const ratio = comboTotalRM / subsetSumRM;
        let runningGroupSumSen = 0;
        const adjusted: ChangePlan2[] = [];
        for (const p of best.subset) {
          const it = items.find(i => i.id === p.itemId)!;
          const oldLineSen = (p.newLineRM ?? 0) * 100;
          const adjustedLineSen = Math.floor(oldLineSen * ratio);
          const surchargesPerUnit = it.divanPriceSen + it.legPriceSen + it.specialOrderPriceSen;
          const adjustedUnitSen = Math.max(0, Math.round(adjustedLineSen / Math.max(1, it.quantity)));
          const newBaseSen = Math.max(0, adjustedUnitSen - surchargesPerUnit);
          const newUnitSen = newBaseSen + surchargesPerUnit;
          const newLineSen = newUnitSen * it.quantity;
          p.newBaseRM = newBaseSen / 100; p.newUnitRM = newUnitSen / 100; p.newLineRM = newLineSen / 100;
          runningGroupSumSen += newLineSen; adjusted.push(p);
        }
        const residualSen = (comboTotalRM * 100) - runningGroupSumSen;
        if (residualSen !== 0 && adjusted.length > 0) {
          const target = adjusted.slice().sort((a, b) => (b.newBaseRM ?? 0) - (a.newBaseRM ?? 0))[0];
          const it = items.find(i => i.id === target.itemId)!;
          const surchargesPerUnit = it.divanPriceSen + it.legPriceSen + it.specialOrderPriceSen;
          const cur = (target.newBaseRM ?? 0) * 100;
          const adj = cur + Math.round(residualSen / Math.max(1, it.quantity));
          const newBase = Math.max(0, adj);
          const newUnit = newBase + surchargesPerUnit;
          const newLine = newUnit * it.quantity;
          target.newBaseRM = newBase / 100; target.newUnitRM = newUnit / 100; target.newLineRM = newLine / 100;
        }
        comboMatches++;
      }
    }
  }

  const willChange = plans.filter(p => p.newLineRM != null && p.newLineRM !== p.oldLineRM);
  const noChange = plans.filter(p => p.newLineRM != null && p.newLineRM === p.oldLineRM);
  const skipped = plans.filter(p => p.skipReason);
  const sumDiff = willChange.reduce((s, p) => s + ((p.newLineRM ?? 0) - p.oldLineRM), 0);
  const summary = {
    coCount: cos.length, itemsConsidered: items.length, willChange: willChange.length,
    noChange: noChange.length, skipped: skipped.length,
    skipReasons: skipped.reduce<Record<string, number>>((acc, p) => { acc[p.skipReason!] = (acc[p.skipReason!] || 0) + 1; return acc; }, {}),
    comboMatchedGroups: comboMatches,
    sumLineDiffRM: Math.round(sumDiff * 100) / 100,
  };

  if (dryRun) {
    return c.json({
      success: true, dryRun: true, scope: statusFilter, summary,
      sampleChanges: willChange.slice(0, 20).map(p => ({
        co: p.companyCOId, cust: p.customerName, status: p.status,
        product: p.productCode, sz: p.sizeCode, fab: p.fabricCode, tier: p.fabricTier,
        oldBase: p.oldBaseRM, newBase: p.newBaseRM,
        oldLine: p.oldLineRM, newLine: p.newLineRM,
        diff: Math.round(((p.newLineRM ?? 0) - p.oldLineRM) * 100) / 100,
        qty: p.quantity,
      })),
    });
  }

  let itemsUpdated = 0;
  const dirtyCoIds = new Set<string>();
  for (let i = 0; i < willChange.length; i += 50) {
    const batch = willChange.slice(i, i + 50);
    const stmts: ReturnType<D1Database["prepare"]>[] = [];
    for (const p of batch) {
      stmts.push(
        db.prepare(`UPDATE consignment_order_items SET basePriceSen = ?, unitPriceSen = ?, lineTotalSen = ? WHERE id = ?`)
          .bind(Math.round((p.newBaseRM ?? 0) * 100), Math.round((p.newUnitRM ?? 0) * 100), Math.round((p.newLineRM ?? 0) * 100), p.itemId),
      );
      dirtyCoIds.add(p.coId);
    }
    if (stmts.length > 0) await db.batch(stmts);
    itemsUpdated += batch.length;
  }
  let cosUpdated = 0;
  for (const coId of dirtyCoIds) {
    const sumRes = await db
      .prepare(`SELECT COALESCE(SUM(lineTotalSen), 0) AS sub FROM consignment_order_items WHERE consignmentOrderId = ?`)
      .bind(coId).first<{ sub: number }>();
    const sub = sumRes?.sub ?? 0;
    await db.prepare(`UPDATE consignment_orders SET subtotalSen = ?, totalSen = ?, updated_at = ? WHERE id = ?`)
      .bind(sub, sub, new Date().toISOString(), coId).run();
    cosUpdated++;
  }
  return c.json({ success: true, dryRun: false, scope: statusFilter, summary, itemsUpdated, cosUpdated });
});

// ---------------------------------------------------------------------------
// POST /api/import/resync-co-totals — CO twin of resync-so-totals.
// ---------------------------------------------------------------------------
app.post("/resync-co-totals", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const cosRes = await db.prepare(
    `SELECT id, subtotalSen, totalSen FROM consignment_orders
      WHERE status IN ('IN_PRODUCTION','READY_TO_SHIP','CONFIRMED','DRAFT')`,
  ).all<{ id: string; subtotalSen: number; totalSen: number }>();
  const cos = cosRes.results ?? [];
  let outOfSync = 0, updated = 0;
  const samples: Array<{ coId: string; oldSub: number; newSub: number; diff: number }> = [];
  const now = new Date().toISOString();
  for (const co of cos) {
    const sumRes = await db.prepare(
      `SELECT COALESCE(SUM(lineTotalSen), 0) AS sub FROM consignment_order_items WHERE consignmentOrderId = ?`,
    ).bind(co.id).first<{ sub: number }>();
    const newSub = sumRes?.sub ?? 0;
    if (newSub === co.subtotalSen && newSub === co.totalSen) continue;
    outOfSync++;
    if (samples.length < 10) samples.push({ coId: co.id, oldSub: co.subtotalSen, newSub, diff: newSub - co.subtotalSen });
    if (!dryRun) {
      await db.prepare(`UPDATE consignment_orders SET subtotalSen = ?, totalSen = ?, updated_at = ? WHERE id = ?`)
        .bind(newSub, newSub, now, co.id).run();
      updated++;
    }
  }
  return c.json({ success: true, dryRun, coCount: cos.length, outOfSync, updated, samples });
});

// ---------------------------------------------------------------------------
// POST /api/import/resync-so-totals
//
// Single-purpose resync: walk every active SO, set subtotal_sen + total_sen
// = SUM(sales_order_items.line_total_sen) for that SO. Idempotent.
//
// Needed because the first live run of recompute-so-sofa-prices crashed
// mid-execution on a wrong column name (grand_total vs total) — the line-
// item UPDATEs landed but the SO total UPDATEs didn't, leaving 41-of-60
// sampled SOs with stale subtotals.
// ---------------------------------------------------------------------------
app.post("/resync-so-totals", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  const sosRes = await db
    .prepare(
      `SELECT id, subtotalSen, totalSen
         FROM sales_orders
        WHERE status IN ('IN_PRODUCTION','READY_TO_SHIP','CONFIRMED','DRAFT')`,
    )
    .all<{ id: string; subtotalSen: number; totalSen: number }>();
  const sos = sosRes.results ?? [];

  let outOfSync = 0;
  let updated = 0;
  const samples: Array<{ soId: string; oldSub: number; newSub: number; diff: number }> = [];
  const now = new Date().toISOString();

  for (const so of sos) {
    const sumRes = await db
      .prepare(
        `SELECT COALESCE(SUM(lineTotalSen), 0) AS sub
           FROM sales_order_items WHERE salesOrderId = ?`,
      )
      .bind(so.id)
      .first<{ sub: number }>();
    const newSub = sumRes?.sub ?? 0;
    if (newSub === so.subtotalSen && newSub === so.totalSen) continue;
    outOfSync++;
    if (samples.length < 10) {
      samples.push({ soId: so.id, oldSub: so.subtotalSen, newSub, diff: newSub - so.subtotalSen });
    }
    if (!dryRun) {
      await db
        .prepare(
          `UPDATE sales_orders
              SET subtotalSen = ?, totalSen = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(newSub, newSub, now, so.id)
        .run();
      updated++;
    }
  }

  return c.json({
    success: true, dryRun,
    soCount: sos.length, outOfSync, updated, samples,
  });
});

// (Removed 2026-05-09) POST /api/import/backfill-sofa-sizelabel-quote
//   added inch quotes to bare-numeric SOFA sizeLabel rows ('30' → '30"').
//   Reversed direction in DUP-001: the kv_config.sofaSizes dropdown source
//   is bare numerics, so the bare-numeric form IS canonical and the quoted
//   form was the dirty side. The 518-row backfill in commit af372e8
//   stripped quotes from the legacy quoted rows; running this endpoint
//   again would re-introduce the same drift. Deleted.

// One-shot migration (2026-05): SOFA items with non-standard sizeLabel
// (e.g. "12", "44", '24" x 37"', "24 X 24") get the size moved into the
// specialOrder field and sizeLabel cleared. Lets us drop those values
// from kv_config.sofaSizes without orphaning the source SOs. Standard
// seat heights (24"/26"/28"/30"/32"/35") are untouched.
app.post("/migrate-nonstandard-sofa-sizes", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);

  const STANDARD_SIZES = new Set([
    '24"', '26"', '28"', '30"', '32"', '35"',
    "24", "26", "28", "30", "32", "35",
  ]);

  const targets = await db
    .prepare(
      `SELECT soi.id, soi.salesOrderId, soi.lineNo, soi.productCode,
              soi.sizeLabel, soi.sizeCode, soi.specialOrder
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
        WHERE so.orgId = ?
          AND soi.itemCategory = 'SOFA'
          AND soi.sizeLabel IS NOT NULL
          AND soi.sizeLabel <> ''`,
    )
    .bind(orgId)
    .all<{
      id: string;
      salesOrderId: string;
      lineNo: number;
      productCode: string | null;
      sizeLabel: string | null;
      sizeCode: string | null;
      specialOrder: string | null;
    }>();

  const migrated: Array<{
    soId: string;
    line: number;
    code: string | null;
    oldSize: string;
    newSpecialOrder: string;
  }> = [];

  for (const r of targets.results ?? []) {
    const sl = (r.sizeLabel ?? "").trim();
    if (!sl) continue;
    if (STANDARD_SIZES.has(sl)) continue;

    // Build the spec token. Prefer the more descriptive sizeLabel form
    // ("24" x 37"") over the bare sizeCode.
    const token = `Custom Size ${sl}`;
    const existing = (r.specialOrder ?? "").trim();
    const tokens = existing
      ? existing.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    if (!tokens.some((t) => t.toLowerCase() === token.toLowerCase())) {
      tokens.push(token);
    }
    const newSpecialOrder = tokens.join(", ");

    await db
      .prepare(
        `UPDATE sales_order_items
            SET sizeLabel = '', sizeCode = '', specialOrder = ?
          WHERE id = ?`,
      )
      .bind(newSpecialOrder, r.id)
      .run();

    // Cascade to production_orders snapshot (delivery_order_items +
    // invoice_items don't carry specialOrder so skip those).
    await db
      .prepare(
        `UPDATE production_orders
            SET sizeLabel = '', sizeCode = ''
          WHERE salesOrderId = ? AND lineNo = ?`,
      )
      .bind(r.salesOrderId, r.lineNo)
      .run()
      .catch(() => null);

    migrated.push({
      soId: r.salesOrderId,
      line: r.lineNo,
      code: r.productCode,
      oldSize: sl,
      newSpecialOrder,
    });
  }

  return c.json({
    success: true,
    scanned: targets.results?.length ?? 0,
    migrated: migrated.length,
    items: migrated,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-sofa-leg-heights
//
// Wei Siang's standard config (2026-05-09):
//   - Models 5535 / 5536 → 1" legs by default
//   - All other sofa models → 6" legs by default
//
// Historical SOs were created without legHeightInches consistently set.
// This one-shot scans sales_order_items + production_orders for SOFA
// rows where legHeightInches is NULL or 0 and applies the rule.
//
// Body: { dryRun?: boolean }     — defaults true
// Response: { scanned, updates: [{soNo, lineNo, productCode, from, to}] }
//
// Per project_migration_in_progress: one-shot, will be removed
// post-migration.
// ---------------------------------------------------------------------------
app.post("/backfill-sofa-leg-heights", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;

  let body: { dryRun?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // empty body OK
  }
  const dryRun = body.dryRun !== false;
  const db = c.var.DB;

  // Default leg height by productCode prefix.
  const defaultLeg = (productCode: string | null): number => {
    if (!productCode) return 6;
    const p = productCode.trim().toUpperCase();
    if (p.startsWith("5535") || p.startsWith("5536")) return 1;
    return 6;
  };

  type ItemRow = {
    id: string;
    salesOrderId: string;
    companySOId: string | null;
    lineNo: number | null;
    lineSuffix: string | null;
    productCode: string | null;
    legHeightInches: number | null;
  };

  // sales_order_items first. sales_orders has companySOId (no salesOrderNo).
  const soItemsRes = await db
    .prepare(
      `SELECT soi.id, soi.salesOrderId,
              so.companySOId AS companySOId,
              soi.lineNo, soi.lineSuffix, soi.productCode, soi.legHeightInches
         FROM sales_order_items AS soi
         LEFT JOIN sales_orders AS so ON so.id = soi.salesOrderId
         WHERE soi.itemCategory = 'SOFA'
           AND (soi.legHeightInches IS NULL OR soi.legHeightInches = 0)`,
    )
    .all<ItemRow>();
  const soItems = soItemsRes.results ?? [];

  // production_orders — separate scan so PO-only-data also gets updated
  // (some POs were generated before the SO line was finalised, etc.).
  type PoRow = {
    id: string;
    poNo: string;
    salesOrderId: string | null;
    salesOrderNo: string | null;
    companySOId: string | null;
    lineNo: number | null;
    productCode: string | null;
    legHeightInches: number | null;
  };
  const posRes = await db
    .prepare(
      `SELECT po.id, po.poNo, po.salesOrderId, po.salesOrderNo, po.companySOId,
              po.lineNo, po.productCode, po.legHeightInches
         FROM production_orders AS po
         WHERE po.itemCategory = 'SOFA'
           AND (po.legHeightInches IS NULL OR po.legHeightInches = 0)`,
    )
    .all<PoRow>();
  const pos = posRes.results ?? [];

  type Update = {
    table: "sales_order_items" | "production_orders";
    rowId: string;
    soNo: string | null;
    lineNo: number | null;
    productCode: string | null;
    from: number | null;
    to: number;
  };
  const updates: Update[] = [];

  for (const r of soItems) {
    updates.push({
      table: "sales_order_items",
      rowId: r.id,
      soNo: r.companySOId,
      lineNo: r.lineNo,
      productCode: r.productCode,
      from: r.legHeightInches,
      to: defaultLeg(r.productCode),
    });
  }
  for (const r of pos) {
    updates.push({
      table: "production_orders",
      rowId: r.id,
      soNo: r.companySOId || r.salesOrderNo,
      lineNo: r.lineNo,
      productCode: r.productCode,
      from: r.legHeightInches,
      to: defaultLeg(r.productCode),
    });
  }

  // Distribution summary by suggested value.
  const dist: Record<string, number> = {};
  for (const u of updates) {
    const k = `${u.table}|${u.to}"`;
    dist[k] = (dist[k] || 0) + 1;
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      scanned: { soItems: soItems.length, pos: pos.length },
      updateCount: updates.length,
      distribution: dist,
      sampleUpdates: updates.slice(0, 30),
    });
  }

  // Live: apply updates in batches.
  const statements = updates.map((u) =>
    db
      .prepare(
        `UPDATE ${u.table} SET legHeightInches = ? WHERE id = ?`,
      )
      .bind(u.to, u.rowId),
  );
  if (statements.length > 0) {
    // d1 batch can take 50-100 statements at a time depending on engine —
    // chunk to be safe.
    const chunkSize = 50;
    for (let i = 0; i < statements.length; i += chunkSize) {
      await db.batch(statements.slice(i, i + chunkSize));
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    scanned: { soItems: soItems.length, pos: pos.length },
    updated: updates.length,
    distribution: dist,
    sampleUpdates: updates.slice(0, 30),
  });
});

export default app;
