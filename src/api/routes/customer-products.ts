// ---------------------------------------------------------------------------
// D1-backed customer_products route.
//
// Per-customer SKU master with optional price overrides. When an override
// column (basePriceSen, price1Sen, seatHeightPrices) is NULL, the customer
// inherits the global product price; otherwise the override wins.
//
// Endpoints:
//   GET    /?customerId=<id>                 list a customer's assigned SKUs
//   GET    /by-product/:productId            list customers assigned to a SKU
//   POST   /                                 assign a SKU to a customer
//   PUT    /:id                              update overrides (partial)
//   DELETE /:id                              remove an assignment
//   POST   /bulk-assign                      assign many SKUs to one customer
//
//   GET /price-for/:productId/:customerId    resolve effective price
//
// A sibling price-resolution endpoint is also mounted on the products
// router (see products.ts) at:
//   GET /api/products/:productId/price-for-customer/:customerId
// so Sales Create can hit a stable URL.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { resolveProductPriceAsOf } from "./products";

const app = new Hono<Env>();

type CustomerProductRow = {
  id: string;
  customerId: string;
  productId: string;
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string | null;
};

// Row shape used by JOIN queries against products / customers.
type JoinedByCustomerRow = CustomerProductRow & {
  productCode: string;
  productName: string;
  productCategory: string;
  productBasePriceSen: number | null;
  productPrice1Sen: number | null;
  productSeatHeightPrices: string | null;
};

type JoinedByProductRow = CustomerProductRow & {
  customerName: string;
  productBasePriceSen: number | null;
  productPrice1Sen: number | null;
  productSeatHeightPrices: string | null;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function genId(): string {
  return `cp-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

function genPriceRowId(): string {
  return `cpp-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type SeatHeightPrice = { height: string; priceSen: number };

type CustomerProductPriceRow = {
  id: string;
  customerProductId: string;
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: string | null;
  effectiveFrom: string;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
};

// Resolve coalesced price fields given the override row + the product's globals.
function resolvePrices(
  overrideBase: number | null,
  overridePrice1: number | null,
  overrideSeat: string | null,
  productBase: number | null,
  productPrice1: number | null,
  productSeat: string | null,
) {
  const basePriceSen = overrideBase !== null ? overrideBase : productBase;
  const price1Sen = overridePrice1 !== null ? overridePrice1 : productPrice1;
  const seatRaw = overrideSeat !== null ? overrideSeat : productSeat;
  const seatHeightPrices = parseJson<SeatHeightPrice[]>(seatRaw, []);
  return { basePriceSen, price1Sen, seatHeightPrices };
}

// ---------------------------------------------------------------------------
// GET /api/customer-products?customerId=<id>
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const customerId = c.req.query("customerId");
  if (!customerId) {
    return c.json(
      { success: false, error: "customerId query param is required" },
      400,
    );
  }
  // asOf — let the customer-products grid display prices effective on a
  // chosen date (default today). Plumbed in 2026-05-09 so the Customers
  // page "Effective" date input also drives the on-screen grid, not just
  // the Export Quotation PDF (Wei Siang: "我的 date 是放 10/5 没有显示出来东西").
  const asOfRaw = (c.req.query("asOf") ?? "").trim();
  const today = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : todayIso();

  const res = await c.var.DB.prepare(
    `SELECT cp.*,
            p.code     AS "productCode",
            p.name     AS "productName",
            p.category AS "productCategory",
            p.basePriceSen      AS "productBasePriceSen",
            p.price1Sen         AS "productPrice1Sen",
            p.seatHeightPrices  AS "productSeatHeightPrices"
       FROM customer_products cp
       INNER JOIN products p ON p.id = cp.productId
       WHERE cp.customerId = ?
       ORDER BY p.code`,
  )
    .bind(customerId)
    .all<JoinedByCustomerRow>();

  const cpRows = res.results ?? [];
  const cpIds = cpRows.map((r) => r.id);
  const productIds = Array.from(new Set(cpRows.map((r) => r.productId)));

  // Batch-load history once so the list stays one round-trip per customer.
  const activeHistoryByCp = new Map<string, CustomerProductPriceRow>();
  const pendingCpIds = new Set<string>();
  if (cpIds.length > 0) {
    const placeholders = cpIds.map(() => "?").join(",");
    const histRes = await c.var.DB.prepare(
      `SELECT * FROM customer_product_prices
        WHERE customerProductId IN (${placeholders})
        ORDER BY effectiveFrom DESC, created_at DESC`,
    )
      .bind(...cpIds)
      .all<CustomerProductPriceRow>();
    for (const h of histRes.results ?? []) {
      if (h.effectiveFrom > today) {
        pendingCpIds.add(h.customerProductId);
        continue;
      }
      if (!activeHistoryByCp.has(h.customerProductId)) {
        activeHistoryByCp.set(h.customerProductId, h);
      }
    }
  }

  // Batch-load master price overlays for the unique products in the result.
  // Mirrors the pattern in products.ts:loadPriceOverlays — first active row
  // per productId wins (DESC sort), and we surface a flag for the earliest
  // pending master change so the UI can warn that this customer's inherited
  // price will move on a known date.
  const masterActiveByProduct = new Map<
    string,
    {
      basePriceSen: number | null;
      price1Sen: number | null;
      seatHeightPricesRaw: string | null;
    }
  >();
  const masterPendingByProduct = new Map<string, string>();
  if (productIds.length > 0) {
    const placeholders = productIds.map(() => "?").join(",");
    const ppRes = await c.var.DB.prepare(
      `SELECT productId, basePriceSen, price1Sen, seatHeightPrices,
              effectiveFrom, created_at
         FROM product_prices
        WHERE productId IN (${placeholders})
        ORDER BY productId, effectiveFrom DESC, created_at DESC`,
    )
      .bind(...productIds)
      .all<{
        productId: string;
        basePriceSen: number | null;
        price1Sen: number | null;
        seatHeightPrices: string | null;
        effectiveFrom: string;
      }>();
    for (const r of ppRes.results ?? []) {
      if (r.effectiveFrom > today) {
        const cur = masterPendingByProduct.get(r.productId);
        if (!cur || r.effectiveFrom < cur) {
          masterPendingByProduct.set(r.productId, r.effectiveFrom);
        }
      } else if (!masterActiveByProduct.has(r.productId)) {
        masterActiveByProduct.set(r.productId, {
          basePriceSen: r.basePriceSen,
          price1Sen: r.price1Sen,
          seatHeightPricesRaw: r.seatHeightPrices,
        });
      }
    }
  }

  const data = cpRows.map((r) => {
    const hist = activeHistoryByCp.get(r.id);
    // History row wins over legacy cp overrides when present.
    const baseOverride = hist ? hist.basePriceSen : r.basePriceSen;
    const price1Override = hist ? hist.price1Sen : r.price1Sen;
    const seatOverride = hist ? hist.seatHeightPrices : r.seatHeightPrices;
    // Master baseline: prefer effective-dated master row, fall back to the
    // raw products table column. Resolver semantics unchanged.
    const masterActive = masterActiveByProduct.get(r.productId);
    const masterBase =
      masterActive && masterActive.basePriceSen !== null
        ? masterActive.basePriceSen
        : r.productBasePriceSen;
    const masterP1 =
      masterActive && masterActive.price1Sen !== null
        ? masterActive.price1Sen
        : r.productPrice1Sen;
    const masterSeat =
      masterActive && masterActive.seatHeightPricesRaw !== null
        ? masterActive.seatHeightPricesRaw
        : r.productSeatHeightPrices;
    const prices = resolvePrices(
      baseOverride,
      price1Override,
      seatOverride,
      masterBase,
      masterP1,
      masterSeat,
    );
    return {
      id: r.id,
      customerId: r.customerId,
      productId: r.productId,
      productCode: r.productCode,
      productName: r.productName,
      category: r.productCategory,
      basePriceSen: prices.basePriceSen,
      price1Sen: prices.price1Sen,
      seatHeightPrices: prices.seatHeightPrices,
      notes: r.notes ?? "",
      hasPendingPriceChange: pendingCpIds.has(r.id),
      // Master-side pending change can also affect this customer when no
      // customer override exists (snapshot mode normally sets one, but
      // legacy/inherit rows still flow through here).
      masterPendingEffectiveFrom:
        masterPendingByProduct.get(r.productId) ?? null,
    };
  });

  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// GET /api/customer-products/by-product/:productId
// ---------------------------------------------------------------------------
app.get("/by-product/:productId", async (c) => {
  const productId = c.req.param("productId");
  const res = await c.var.DB.prepare(
    `SELECT cp.*,
            cu.name AS "customerName",
            p.basePriceSen      AS "productBasePriceSen",
            p.price1Sen         AS "productPrice1Sen",
            p.seatHeightPrices  AS "productSeatHeightPrices"
       FROM customer_products cp
       INNER JOIN customers cu ON cu.id = cp.customerId
       INNER JOIN products p   ON p.id  = cp.productId
       WHERE cp.productId = ?
       ORDER BY cu.name`,
  )
    .bind(productId)
    .all<JoinedByProductRow>();

  const data = (res.results ?? []).map((r) => {
    const prices = resolvePrices(
      r.basePriceSen,
      r.price1Sen,
      r.seatHeightPrices,
      r.productBasePriceSen,
      r.productPrice1Sen,
      r.productSeatHeightPrices,
    );
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: r.customerName,
      basePriceSen: prices.basePriceSen,
      price1Sen: prices.price1Sen,
      seatHeightPrices: prices.seatHeightPrices,
      notes: r.notes ?? "",
    };
  });

  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// POST /api/customer-products — assign (idempotent on UNIQUE(customerId, productId))
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "customer-products", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { customerId, productId } = body;
    if (!customerId || !productId) {
      return c.json(
        { success: false, error: "customerId and productId are required" },
        400,
      );
    }

    const id = genId();
    const seatJson =
      body.seatHeightPrices === undefined || body.seatHeightPrices === null
        ? null
        : JSON.stringify(body.seatHeightPrices);

    await c.var.DB.prepare(
      `INSERT OR IGNORE INTO customer_products
         (id, customerId, productId, basePriceSen, price1Sen, seatHeightPrices, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        customerId,
        productId,
        body.basePriceSen ?? null,
        body.price1Sen ?? null,
        seatJson,
        body.notes ?? null,
      )
      .run();

    // Fetch the current row (either the one we just inserted, or the pre-existing one)
    const row = await c.var.DB.prepare(
      `SELECT cp.*,
              p.code     AS "productCode",
              p.name     AS "productName",
              p.category AS "productCategory",
              p.basePriceSen      AS "productBasePriceSen",
              p.price1Sen         AS "productPrice1Sen",
              p.seatHeightPrices  AS "productSeatHeightPrices"
         FROM customer_products cp
         INNER JOIN products p ON p.id = cp.productId
         WHERE cp.customerId = ? AND cp.productId = ?`,
    )
      .bind(customerId, productId)
      .first<JoinedByCustomerRow>();

    if (!row) {
      return c.json(
        { success: false, error: "Failed to create assignment" },
        500,
      );
    }

    const prices = resolvePrices(
      row.basePriceSen,
      row.price1Sen,
      row.seatHeightPrices,
      row.productBasePriceSen,
      row.productPrice1Sen,
      row.productSeatHeightPrices,
    );

    return c.json(
      {
        success: true,
        data: {
          id: row.id,
          customerId: row.customerId,
          productId: row.productId,
          productCode: row.productCode,
          productName: row.productName,
          category: row.productCategory,
          basePriceSen: prices.basePriceSen,
          price1Sen: prices.price1Sen,
          seatHeightPrices: prices.seatHeightPrices,
          notes: row.notes ?? "",
        },
      },
      row.id === id ? 201 : 200,
    );
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// Price history endpoints — registered BEFORE /:id routes so the static
// prefixes aren't swallowed by the single-segment wildcard.
// ---------------------------------------------------------------------------

// GET /:customerProductId/price-history
app.get("/:customerProductId/price-history", async (c) => {
  const cpId = c.req.param("customerProductId");
  const res = await c.var.DB.prepare(
    `SELECT * FROM customer_product_prices
      WHERE customerProductId = ?
      ORDER BY effectiveFrom DESC, created_at DESC`,
  )
    .bind(cpId)
    .all<CustomerProductPriceRow>();
  const data = (res.results ?? []).map((r) => ({
    id: r.id,
    basePriceSen: r.basePriceSen,
    price1Sen: r.price1Sen,
    seatHeightPrices: parseJson<SeatHeightPrice[]>(r.seatHeightPrices, []),
    effectiveFrom: r.effectiveFrom,
    notes: r.notes ?? "",
    createdAt: r.createdAt,
  }));
  return c.json({ success: true, data });
});

// POST /:customerProductId/prices — append a new history row
app.post("/:customerProductId/prices", async (c) => {
  const denied = await requirePermission(c, "customer-products", "create");
  if (denied) return denied;
  const cpId = c.req.param("customerProductId");
  try {
    const parent = await c.var.DB.prepare(
      "SELECT id FROM customer_products WHERE id = ?",
    )
      .bind(cpId)
      .first<{ id: string }>();
    if (!parent) {
      return c.json(
        { success: false, error: "customer_products row not found" },
        404,
      );
    }

    const body = await c.req.json();
    const effectiveFrom = String(body.effectiveFrom ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      return c.json(
        {
          success: false,
          error: "effectiveFrom (YYYY-MM-DD) is required",
        },
        400,
      );
    }

    // Auto-baseline: when scheduling the FIRST customer_product_prices row
    // for a cp + the new effective_from is in the future, capture today's
    // resolved customer price (snapshot or master fallback) as a row dated
    // today. Mirrors the master-side product_prices auto-baseline so that
    // when a future-dated price kicks in, the previously-charged price is
    // still preserved in history (Wei Siang: "old price needs to be
    // recorded too, otherwise we'll forget").
    const today = todayIso();
    if (effectiveFrom > today) {
      const existingHistory = await c.var.DB.prepare(
        "SELECT id FROM customer_product_prices WHERE customerProductId = ? LIMIT 1",
      )
        .bind(cpId)
        .first<{ id: string }>();
      if (!existingHistory) {
        // Read the cp + master to compute today's effective price using
        // the same coalesce chain the resolver uses.
        const cpRow = await c.var.DB.prepare(
          `SELECT cp.basePriceSen   AS "cpBase",
                  cp.price1Sen      AS "cpPrice1",
                  cp.seatHeightPrices AS "cpSeat",
                  cp.productId      AS "productId"
             FROM customer_products cp
             WHERE cp.id = ?`,
        )
          .bind(cpId)
          .first<{
            cpBase: number | null;
            cpPrice1: number | null;
            cpSeat: string | null;
            productId: string;
          }>();
        if (cpRow) {
          const master = await resolveProductPriceAsOf(
            c.var.DB,
            cpRow.productId,
            today,
          );
          const baseSnap = cpRow.cpBase ?? master?.basePriceSen ?? null;
          const p1Snap = cpRow.cpPrice1 ?? master?.price1Sen ?? null;
          const seatSnap =
            cpRow.cpSeat ??
            (master && master.seatHeightPrices.length > 0
              ? JSON.stringify(master.seatHeightPrices)
              : null);
          await c.var.DB.prepare(
            `INSERT INTO customer_product_prices
               (id, customerProductId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              genPriceRowId(),
              cpId,
              baseSnap,
              p1Snap,
              seatSnap,
              today,
              "Auto-baseline (captured before scheduled change)",
              body.createdBy ?? null,
            )
            .run();
        }
      }
    }

    const id = genPriceRowId();
    const seatJson =
      body.seatHeightPrices === undefined || body.seatHeightPrices === null
        ? null
        : JSON.stringify(body.seatHeightPrices);

    await c.var.DB.prepare(
      `INSERT INTO customer_product_prices
         (id, customerProductId, basePriceSen, price1Sen, seatHeightPrices,
          effectiveFrom, notes, createdBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        cpId,
        body.basePriceSen ?? null,
        body.price1Sen ?? null,
        seatJson,
        effectiveFrom,
        body.notes ?? null,
        body.createdBy ?? null,
      )
      .run();

    const row = await c.var.DB.prepare(
      "SELECT * FROM customer_product_prices WHERE id = ?",
    )
      .bind(id)
      .first<CustomerProductPriceRow>();
    if (!row) {
      return c.json(
        { success: false, error: "Failed to create price history row" },
        500,
      );
    }

    return c.json(
      {
        success: true,
        data: {
          id: row.id,
          customerProductId: row.customerProductId,
          basePriceSen: row.basePriceSen,
          price1Sen: row.price1Sen,
          seatHeightPrices: parseJson<SeatHeightPrice[]>(
            row.seatHeightPrices,
            [],
          ),
          effectiveFrom: row.effectiveFrom,
          notes: row.notes ?? "",
          createdAt: row.createdAt,
        },
      },
      201,
    );
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /price-row/:priceRowId
app.delete("/price-row/:priceRowId", async (c) => {
  const denied = await requirePermission(c, "customer-products", "delete");
  if (denied) return denied;
  const id = c.req.param("priceRowId");
  const existing = await c.var.DB.prepare(
    "SELECT id, customerProductId FROM customer_product_prices WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; customerProductId: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Price row not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM customer_product_prices WHERE id = ?")
    .bind(id)
    .run();
  return c.json({
    success: true,
    data: { id: existing.id, customerProductId: existing.customerProductId },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/customer-products/:id — partial update of overrides
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "customer-products", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM customer_products WHERE id = ?",
    )
      .bind(id)
      .first<CustomerProductRow>();
    if (!existing) {
      return c.json({ success: false, error: "Assignment not found" }, 404);
    }
    const body = await c.req.json();

    const merged = {
      basePriceSen:
        body.basePriceSen === undefined
          ? existing.basePriceSen
          : body.basePriceSen,
      price1Sen:
        body.price1Sen === undefined ? existing.price1Sen : body.price1Sen,
      seatHeightPrices:
        body.seatHeightPrices === undefined
          ? existing.seatHeightPrices
          : body.seatHeightPrices === null
            ? null
            : JSON.stringify(body.seatHeightPrices),
      notes: body.notes === undefined ? existing.notes : body.notes,
    };

    await c.var.DB.prepare(
      `UPDATE customer_products
         SET basePriceSen = ?,
             price1Sen = ?,
             seatHeightPrices = ?,
             notes = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?`,
    )
      .bind(
        merged.basePriceSen,
        merged.price1Sen,
        merged.seatHeightPrices,
        merged.notes,
        id,
      )
      .run();

    const row = await c.var.DB.prepare(
      `SELECT cp.*,
              p.code     AS "productCode",
              p.name     AS "productName",
              p.category AS "productCategory",
              p.basePriceSen      AS "productBasePriceSen",
              p.price1Sen         AS "productPrice1Sen",
              p.seatHeightPrices  AS "productSeatHeightPrices"
         FROM customer_products cp
         INNER JOIN products p ON p.id = cp.productId
         WHERE cp.id = ?`,
    )
      .bind(id)
      .first<JoinedByCustomerRow>();

    if (!row) {
      return c.json({ success: false, error: "Assignment not found" }, 404);
    }

    const prices = resolvePrices(
      row.basePriceSen,
      row.price1Sen,
      row.seatHeightPrices,
      row.productBasePriceSen,
      row.productPrice1Sen,
      row.productSeatHeightPrices,
    );

    return c.json({
      success: true,
      data: {
        id: row.id,
        customerId: row.customerId,
        productId: row.productId,
        productCode: row.productCode,
        productName: row.productName,
        category: row.productCategory,
        basePriceSen: prices.basePriceSen,
        price1Sen: prices.price1Sen,
        seatHeightPrices: prices.seatHeightPrices,
        notes: row.notes ?? "",
      },
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/customer-products/:id
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "customer-products", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM customer_products WHERE id = ?",
  )
    .bind(id)
    .first<CustomerProductRow>();
  if (!existing) {
    return c.json({ success: false, error: "Assignment not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM customer_products WHERE id = ?")
    .bind(id)
    .run();
  return c.json({
    success: true,
    data: {
      id: existing.id,
      customerId: existing.customerId,
      productId: existing.productId,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/customer-products/bulk-assign
//   body: { customerId, productIds: string[] }
// ---------------------------------------------------------------------------
app.post("/bulk-assign", async (c) => {
  const denied = await requirePermission(c, "customer-products", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { customerId, productIds } = body as {
      customerId?: string;
      productIds?: string[];
    };
    if (!customerId || !Array.isArray(productIds)) {
      return c.json(
        {
          success: false,
          error: "customerId and productIds[] are required",
        },
        400,
      );
    }

    if (productIds.length === 0) {
      return c.json({
        success: true,
        data: { assigned: 0, skippedDuplicates: 0 },
      });
    }

    // Figure out which pairs already exist so we can report duplicate count
    // accurately (D1 doesn't surface per-statement rowcount in batch results).
    const placeholders = productIds.map(() => "?").join(",");
    const existingRes = await c.var.DB.prepare(
      `SELECT productId FROM customer_products
        WHERE customerId = ?
          AND productId IN (${placeholders})`,
    )
      .bind(customerId, ...productIds)
      .all<{ productId: string }>();
    const existingSet = new Set(
      (existingRes.results ?? []).map((r) => r.productId),
    );
    const toInsert = productIds.filter((pid) => !existingSet.has(pid));

    if (toInsert.length > 0) {
      const statements = toInsert.map((pid) =>
        c.var.DB.prepare(
          `INSERT OR IGNORE INTO customer_products
             (id, customerId, productId)
           VALUES (?, ?, ?)`,
        ).bind(genId(), customerId, pid),
      );
      await c.var.DB.batch(statements);
    }

    return c.json({
      success: true,
      data: {
        assigned: toInsert.length,
        skippedDuplicates: existingSet.size,
      },
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer-products/copy-from-master
//   body: { customerId, productIds?: string[], effectiveFrom?: string }
//
// Two-phase sync:
//   1. Assignment — ensure every master product (or every productId in
//      `productIds`) has a customer_products row for this customer.
//      Idempotent: existing assignments are kept.
//   2. History mirror — for every cp row of this customer, copy EVERY
//      master product_prices row into customer_product_prices using the
//      same effectiveFrom date, so the customer's history dialog
//      reflects the full master timeline (2020-01-01 baseline + every
//      scheduled change).
//      Idempotent: skips rows that already exist (matching cpId +
//      effectiveFrom + basePriceSen). The frontend "Copy from Master
//      Listing" button always runs this path so re-clicking it on a
//      customer with no new SKUs still backfills missing historical
//      rows — fixing the previous behaviour where customers ended up
//      with a single "Snapshot from Master" row instead of the full
//      master history.
//
// Result: the customer's price list MIRRORS the master's full history.
// Subsequent customer-side scheduled changes still take effect via
// customer_product_prices INSERT — the mirror runs only for rows that
// don't already exist on the customer side.
// ---------------------------------------------------------------------------
app.post("/copy-from-master", async (c) => {
  const denied = await requirePermission(c, "customer-products", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const customerId = String(body.customerId ?? "").trim();
    const effectiveFrom = String(body.effectiveFrom ?? todayIso()).trim();
    if (!customerId) {
      return c.json(
        { success: false, error: "customerId is required" },
        400,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      return c.json(
        { success: false, error: "effectiveFrom must be YYYY-MM-DD" },
        400,
      );
    }

    // Resolve the candidate set. When productIds is missing we consider
    // every product (assigned + unassigned) so the history-mirror step
    // can backfill rows for cps that already exist.
    let productIds: string[];
    if (Array.isArray(body.productIds) && body.productIds.length > 0) {
      productIds = body.productIds.map(String);
    } else {
      const allRes = await c.var.DB.prepare(
        "SELECT id FROM products",
      ).all<{ id: string }>();
      productIds = (allRes.results ?? []).map((r) => r.id);
    }

    if (productIds.length === 0) {
      return c.json({
        success: true,
        data: { assigned: 0, historyRowsAdded: 0 },
      });
    }

    // Step 1: ensure assignment rows exist for every productId.
    const placeholders = productIds.map(() => "?").join(",");
    const existingRes = await c.var.DB.prepare(
      `SELECT id, productId FROM customer_products
        WHERE customerId = ?
          AND productId IN (${placeholders})`,
    )
      .bind(customerId, ...productIds)
      .all<{ id: string; productId: string }>();
    const cpIdByProduct = new Map<string, string>();
    for (const r of existingRes.results ?? []) {
      cpIdByProduct.set(r.productId, r.id);
    }
    const toInsert = productIds.filter((pid) => !cpIdByProduct.has(pid));
    if (toInsert.length > 0) {
      const insertStatements = toInsert.map((pid) => {
        const newCpId = genId();
        cpIdByProduct.set(pid, newCpId);
        return c.var.DB.prepare(
          `INSERT OR IGNORE INTO customer_products
             (id, customerId, productId)
           VALUES (?, ?, ?)`,
        ).bind(newCpId, customerId, pid);
      });
      await c.var.DB.batch(insertStatements);
      // Some INSERTs may have hit the OR IGNORE branch (race vs concurrent
      // assigns). Re-read the cp ids for everything in toInsert so the
      // mirror loop below uses the persisted ids, not the locally
      // generated ones that never landed.
      const reread = await c.var.DB.prepare(
        `SELECT id, productId FROM customer_products
          WHERE customerId = ?
            AND productId IN (${toInsert.map(() => "?").join(",")})`,
      )
        .bind(customerId, ...toInsert)
        .all<{ id: string; productId: string }>();
      for (const r of reread.results ?? []) {
        cpIdByProduct.set(r.productId, r.id);
      }
    }

    // Step 2: mirror EVERY master product_prices row into
    // customer_product_prices for every cp. Idempotent — skip rows that
    // already exist with the same effectiveFrom + basePriceSen.
    let historyRowsAdded = 0;
    const mirrorStmts: D1PreparedStatement[] = [];
    for (const pid of productIds) {
      const cpId = cpIdByProduct.get(pid);
      if (!cpId) continue;
      // Pull ALL master history rows for this product.
      const masterRowsRes = await c.var.DB.prepare(
        `SELECT basePriceSen, price1Sen, seatHeightPrices, effectiveFrom, notes
           FROM product_prices
          WHERE productId = ?`,
      )
        .bind(pid)
        .all<{
          basePriceSen: number | null;
          price1Sen: number | null;
          seatHeightPrices: string | null;
          effectiveFrom: string;
          notes: string | null;
        }>();
      const masterRows = masterRowsRes.results ?? [];
      if (masterRows.length === 0) continue;

      // Pull existing cp rows so we can dedup.
      const existingCpRowsRes = await c.var.DB.prepare(
        `SELECT effectiveFrom, basePriceSen
           FROM customer_product_prices
          WHERE customerProductId = ?`,
      )
        .bind(cpId)
        .all<{ effectiveFrom: string; basePriceSen: number | null }>();
      const existingKeys = new Set(
        (existingCpRowsRes.results ?? []).map(
          (r) => `${r.effectiveFrom}|${r.basePriceSen ?? "null"}`,
        ),
      );

      for (const mr of masterRows) {
        const key = `${mr.effectiveFrom}|${mr.basePriceSen ?? "null"}`;
        if (existingKeys.has(key)) continue;
        mirrorStmts.push(
          c.var.DB.prepare(
            `INSERT INTO customer_product_prices
               (id, customerProductId, basePriceSen, price1Sen,
                seatHeightPrices, effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            genPriceRowId(),
            cpId,
            mr.basePriceSen,
            mr.price1Sen,
            mr.seatHeightPrices,
            mr.effectiveFrom,
            mr.notes
              ? `Mirrored from Master: ${mr.notes}`
              : `Mirrored from Master ${mr.effectiveFrom}`,
            null,
          ),
        );
        existingKeys.add(key);
        historyRowsAdded += 1;
      }
    }
    // Batch in chunks of 50 to stay under the D1 statement-per-batch cap.
    for (let i = 0; i < mirrorStmts.length; i += 50) {
      await c.var.DB.batch(mirrorStmts.slice(i, i + 50));
    }

    return c.json({
      success: true,
      data: {
        assigned: toInsert.length,
        historyRowsAdded,
        skippedDuplicates: existingRes.results?.length ?? 0,
      },
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// GET /api/customer-products/price-for/:productId/:customerId
//
// Same resolver logic as the products-side endpoint; exposed here too so
// callers that already have the customer-products router mounted don't need
// a separate base URL.
// ---------------------------------------------------------------------------
async function resolveCustomerPriceAsOf(
  db: D1Database,
  productId: string,
  customerId: string,
  isoDate: string,
) {
  // Step 1: customer assignment + legacy overrides. The product's master
  // baseline is no longer pulled from the products table directly — we
  // resolve it through resolveProductPriceAsOf so that effective-dated
  // master price changes (migration 0066) are honored on the fallback
  // path. Snapshot copy (Phase 2) usually populates concrete customer
  // overrides anyway, but inheritance still happens for legacy rows
  // and direct API users.
  const row = await db
    .prepare(
      `SELECT cp.id              AS "cpId",
              cp.basePriceSen    AS "cpBasePriceSen",
              cp.price1Sen       AS "cpPrice1Sen",
              cp.seatHeightPrices AS "cpSeatHeightPrices"
         FROM customer_products cp
         WHERE cp.productId = ? AND cp.customerId = ?`,
    )
    .bind(productId, customerId)
    .first<{
      cpId: string | null;
      cpBasePriceSen: number | null;
      cpPrice1Sen: number | null;
      cpSeatHeightPrices: string | null;
    }>();

  // Master baseline — drives the inheritance fallback. Returns null only
  // when the product itself doesn't exist, which is what the caller
  // signals back as a 404.
  const master = await resolveProductPriceAsOf(db, productId, isoDate);
  if (!master) return null;

  // Step 2: newest customer_product_prices row where effectiveFrom <= isoDate
  // wins over the legacy customer_products columns. Falls back gracefully
  // when no history.
  let histBase: number | null = null;
  let histPrice1: number | null = null;
  let histSeat: string | null = null;
  let hasHistory = false;
  if (row?.cpId) {
    const hist = await db
      .prepare(
        `SELECT basePriceSen, price1Sen, seatHeightPrices
           FROM customer_product_prices
          WHERE customerProductId = ?
            AND effectiveFrom <= ?
          ORDER BY effectiveFrom DESC, created_at DESC
          LIMIT 1`,
      )
      .bind(row.cpId, isoDate)
      .first<{
        basePriceSen: number | null;
        price1Sen: number | null;
        seatHeightPrices: string | null;
      }>();
    if (hist) {
      hasHistory = true;
      histBase = hist.basePriceSen;
      histPrice1 = hist.price1Sen;
      histSeat = hist.seatHeightPrices;
    }
  }

  const baseOverride = hasHistory ? histBase : (row?.cpBasePriceSen ?? null);
  const price1Override = hasHistory ? histPrice1 : (row?.cpPrice1Sen ?? null);
  const seatOverride = hasHistory ? histSeat : (row?.cpSeatHeightPrices ?? null);

  // Master baseline is already resolved (numbers + parsed seat tiers);
  // re-stringify the seat tiers so resolvePrices sees the same TEXT shape
  // it was built for. Cheap, keeps the helper signature stable.
  const masterSeatRaw =
    master.seatHeightPrices.length > 0
      ? JSON.stringify(master.seatHeightPrices)
      : null;

  const prices = resolvePrices(
    baseOverride,
    price1Override,
    seatOverride,
    master.basePriceSen,
    master.price1Sen,
    masterSeatRaw,
  );

  return {
    productId,
    customerId,
    hasCustomerOverride: row?.cpId != null,
    basePriceSen: prices.basePriceSen,
    price1Sen: prices.price1Sen,
    seatHeightPrices: prices.seatHeightPrices,
  };
}

// Back-compat wrapper: today's effective price.
async function resolveCustomerPrice(
  db: D1Database,
  productId: string,
  customerId: string,
) {
  return resolveCustomerPriceAsOf(db, productId, customerId, todayIso());
}

// Batched form of resolveCustomerPriceAsOf for a whole product set (the
// quotation / catalogue export). resolveCustomerPriceAsOf runs ~5 sequential
// DB reads PER product, so a 375-SKU customer serialised ~1875 round-trips and
// the request aborted at 30s (owner 2026-07-29 — "The Conts" quotation would
// not download). This resolves the entire set in 4 bulk queries. Semantics MUST
// match resolveCustomerPriceAsOf exactly — the only change is fan-in, not the
// price math (resolvePrices is the single shared coalescer). Postgres param
// limit (65535) comfortably covers real customer catalogues.
export async function resolveCustomerPricesAsOfBatch(
  db: D1Database,
  productIds: string[],
  customerId: string,
  isoDate: string,
): Promise<
  Map<
    string,
    {
      basePriceSen: number | null;
      price1Sen: number | null;
      seatHeightPrices: SeatHeightPrice[];
      hasCustomerOverride: boolean;
    }
  >
> {
  const out = new Map<
    string,
    {
      basePriceSen: number | null;
      price1Sen: number | null;
      seatHeightPrices: SeatHeightPrice[];
      hasCustomerOverride: boolean;
    }
  >();
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");

  // Q1 — product master baseline (the final fallback in resolveProductPriceAsOf).
  const prodRes = await db
    .prepare(
      `SELECT id, basePriceSen, price1Sen, seatHeightPrices FROM products WHERE id IN (${ph})`,
    )
    .bind(...ids)
    .all<{ id: string; basePriceSen: number | null; price1Sen: number | null; seatHeightPrices: string | null }>();
  const prodById = new Map((prodRes.results ?? []).map((r) => [r.id, r]));

  // Q2 — newest master effective-dated price per product (effectiveFrom <= asOf).
  // ORDER matches resolveProductPriceAsOf; first row seen per productId wins.
  const mpRes = await db
    .prepare(
      `SELECT productId, basePriceSen, price1Sen, seatHeightPrices
         FROM product_prices
        WHERE productId IN (${ph}) AND effectiveFrom <= ?
        ORDER BY productId, effectiveFrom DESC, created_at DESC`,
    )
    .bind(...ids, isoDate)
    .all<{ productId: string; basePriceSen: number | null; price1Sen: number | null; seatHeightPrices: string | null }>();
  const masterHistById = new Map<string, { basePriceSen: number | null; price1Sen: number | null; seatHeightPrices: string | null }>();
  for (const r of mpRes.results ?? []) if (!masterHistById.has(r.productId)) masterHistById.set(r.productId, r);

  // Q3 — customer override row (customer_products) + its id, per product.
  const cpRes = await db
    .prepare(
      `SELECT id AS "cpId", productId AS "productId",
              basePriceSen AS "cpBasePriceSen", price1Sen AS "cpPrice1Sen",
              seatHeightPrices AS "cpSeatHeightPrices"
         FROM customer_products
        WHERE customerId = ? AND productId IN (${ph})`,
    )
    .bind(customerId, ...ids)
    .all<{ cpId: string; productId: string; cpBasePriceSen: number | null; cpPrice1Sen: number | null; cpSeatHeightPrices: string | null }>();
  const cpByProduct = new Map((cpRes.results ?? []).map((r) => [r.productId, r]));

  // Q4 — newest customer_product_prices history per customer_product (effectiveFrom <= asOf).
  const cpIds = Array.from(cpByProduct.values()).map((c) => c.cpId).filter(Boolean);
  const cppNewestByCp = new Map<string, { basePriceSen: number | null; price1Sen: number | null; seatHeightPrices: string | null }>();
  if (cpIds.length > 0) {
    const cph = cpIds.map(() => "?").join(",");
    const cppRes = await db
      .prepare(
        `SELECT customerProductId, basePriceSen, price1Sen, seatHeightPrices
           FROM customer_product_prices
          WHERE customerProductId IN (${cph}) AND effectiveFrom <= ?
          ORDER BY customerProductId, effectiveFrom DESC, created_at DESC`,
      )
      .bind(...cpIds, isoDate)
      .all<{ customerProductId: string; basePriceSen: number | null; price1Sen: number | null; seatHeightPrices: string | null }>();
    for (const r of cppRes.results ?? []) if (!cppNewestByCp.has(r.customerProductId)) cppNewestByCp.set(r.customerProductId, r);
  }

  // Resolve each product in-memory — mirrors resolveCustomerPriceAsOf step-for-step.
  for (const pid of ids) {
    const prod = prodById.get(pid);
    if (!prod) continue; // product missing → per-product version returns null (skipped)

    const mHist = masterHistById.get(pid);
    const masterBase = mHist?.basePriceSen ?? prod.basePriceSen;
    const masterP1 = mHist?.price1Sen ?? prod.price1Sen;
    const masterSeatRaw = mHist?.seatHeightPrices ?? prod.seatHeightPrices;

    const cp = cpByProduct.get(pid);
    const cpHist = cp?.cpId ? cppNewestByCp.get(cp.cpId) : undefined;
    const hasHistory = !!cpHist;
    const baseOverride = hasHistory ? (cpHist as { basePriceSen: number | null }).basePriceSen : (cp?.cpBasePriceSen ?? null);
    const price1Override = hasHistory ? (cpHist as { price1Sen: number | null }).price1Sen : (cp?.cpPrice1Sen ?? null);
    const seatOverride = hasHistory ? (cpHist as { seatHeightPrices: string | null }).seatHeightPrices : (cp?.cpSeatHeightPrices ?? null);

    const prices = resolvePrices(baseOverride, price1Override, seatOverride, masterBase, masterP1, masterSeatRaw);
    out.set(pid, { ...prices, hasCustomerOverride: cp?.cpId != null });
  }
  return out;
}

app.get("/price-for/:productId/:customerId", async (c) => {
  const productId = c.req.param("productId");
  const customerId = c.req.param("customerId");
  const data = await resolveCustomerPrice(c.var.DB, productId, customerId);
  if (!data) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  return c.json({ success: true, data });
});

export default app;
export { resolveCustomerPrice, resolveCustomerPriceAsOf };
