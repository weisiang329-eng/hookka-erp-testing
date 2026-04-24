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

const app = new Hono<Env>();

type CustomerProductRow = {
  id: string;
  customerId: string;
  productId: string;
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
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
  created_at: string;
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

  const today = todayIso();

  const res = await c.env.DB.prepare(
    `SELECT cp.*,
            p.code     AS productCode,
            p.name     AS productName,
            p.category AS productCategory,
            p.basePriceSen      AS productBasePriceSen,
            p.price1Sen         AS productPrice1Sen,
            p.seatHeightPrices  AS productSeatHeightPrices
       FROM customer_products cp
       INNER JOIN products p ON p.id = cp.productId
       WHERE cp.customerId = ?
       ORDER BY p.code`,
  )
    .bind(customerId)
    .all<JoinedByCustomerRow>();

  const cpRows = res.results ?? [];
  const cpIds = cpRows.map((r) => r.id);

  // Batch-load history once so the list stays one round-trip per customer.
  let activeHistoryByCp = new Map<string, CustomerProductPriceRow>();
  let pendingCpIds = new Set<string>();
  if (cpIds.length > 0) {
    const placeholders = cpIds.map(() => "?").join(",");
    const histRes = await c.env.DB.prepare(
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

  const data = cpRows.map((r) => {
    const hist = activeHistoryByCp.get(r.id);
    // History row wins over legacy cp overrides when present.
    const baseOverride = hist ? hist.basePriceSen : r.basePriceSen;
    const price1Override = hist ? hist.price1Sen : r.price1Sen;
    const seatOverride = hist ? hist.seatHeightPrices : r.seatHeightPrices;
    const prices = resolvePrices(
      baseOverride,
      price1Override,
      seatOverride,
      r.productBasePriceSen,
      r.productPrice1Sen,
      r.productSeatHeightPrices,
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
    };
  });

  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// GET /api/customer-products/by-product/:productId
// ---------------------------------------------------------------------------
app.get("/by-product/:productId", async (c) => {
  const productId = c.req.param("productId");
  const res = await c.env.DB.prepare(
    `SELECT cp.*,
            cu.name AS customerName,
            p.basePriceSen      AS productBasePriceSen,
            p.price1Sen         AS productPrice1Sen,
            p.seatHeightPrices  AS productSeatHeightPrices
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

    await c.env.DB.prepare(
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
    const row = await c.env.DB.prepare(
      `SELECT cp.*,
              p.code     AS productCode,
              p.name     AS productName,
              p.category AS productCategory,
              p.basePriceSen      AS productBasePriceSen,
              p.price1Sen         AS productPrice1Sen,
              p.seatHeightPrices  AS productSeatHeightPrices
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
  const res = await c.env.DB.prepare(
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
    created_at: r.created_at,
  }));
  return c.json({ success: true, data });
});

// POST /:customerProductId/prices — append a new history row
app.post("/:customerProductId/prices", async (c) => {
  const cpId = c.req.param("customerProductId");
  try {
    const parent = await c.env.DB.prepare(
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

    const id = genPriceRowId();
    const seatJson =
      body.seatHeightPrices === undefined || body.seatHeightPrices === null
        ? null
        : JSON.stringify(body.seatHeightPrices);

    await c.env.DB.prepare(
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

    const row = await c.env.DB.prepare(
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
          created_at: row.created_at,
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
  const id = c.req.param("priceRowId");
  const existing = await c.env.DB.prepare(
    "SELECT id, customerProductId FROM customer_product_prices WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; customerProductId: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Price row not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM customer_product_prices WHERE id = ?")
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
  const id = c.req.param("id");
  try {
    const existing = await c.env.DB.prepare(
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

    await c.env.DB.prepare(
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

    const row = await c.env.DB.prepare(
      `SELECT cp.*,
              p.code     AS productCode,
              p.name     AS productName,
              p.category AS productCategory,
              p.basePriceSen      AS productBasePriceSen,
              p.price1Sen         AS productPrice1Sen,
              p.seatHeightPrices  AS productSeatHeightPrices
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
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT * FROM customer_products WHERE id = ?",
  )
    .bind(id)
    .first<CustomerProductRow>();
  if (!existing) {
    return c.json({ success: false, error: "Assignment not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM customer_products WHERE id = ?")
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
    const existingRes = await c.env.DB.prepare(
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
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO customer_products
             (id, customerId, productId)
           VALUES (?, ?, ?)`,
        ).bind(genId(), customerId, pid),
      );
      await c.env.DB.batch(statements);
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
// GET /api/customer-products/price-for/:productId/:customerId
//
// Same resolver logic as the products-side endpoint; exposed here too so
// callers that already have the customer-products router mounted don't need
// a separate base URL.
// ---------------------------------------------------------------------------
type PriceResolutionRow = {
  productBasePriceSen: number | null;
  productPrice1Sen: number | null;
  productSeatHeightPrices: string | null;
  cpId: string | null;
  cpBasePriceSen: number | null;
  cpPrice1Sen: number | null;
  cpSeatHeightPrices: string | null;
};

async function resolveCustomerPriceAsOf(
  db: D1Database,
  productId: string,
  customerId: string,
  isoDate: string,
) {
  // Step 1: product + assignment row (legacy overrides kept as fallback).
  const row = await db
    .prepare(
      `SELECT p.basePriceSen     AS productBasePriceSen,
              p.price1Sen        AS productPrice1Sen,
              p.seatHeightPrices AS productSeatHeightPrices,
              cp.id              AS cpId,
              cp.basePriceSen    AS cpBasePriceSen,
              cp.price1Sen       AS cpPrice1Sen,
              cp.seatHeightPrices AS cpSeatHeightPrices
         FROM products p
         LEFT JOIN customer_products cp
           ON cp.productId = p.id AND cp.customerId = ?
         WHERE p.id = ?`,
    )
    .bind(customerId, productId)
    .first<PriceResolutionRow>();

  if (!row) return null;

  // Step 2: newest history row where effectiveFrom <= isoDate wins over the
  // legacy customer_products columns. Falls back gracefully when no history.
  let histBase: number | null = null;
  let histPrice1: number | null = null;
  let histSeat: string | null = null;
  let hasHistory = false;
  if (row.cpId) {
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

  const baseOverride = hasHistory ? histBase : row.cpBasePriceSen;
  const price1Override = hasHistory ? histPrice1 : row.cpPrice1Sen;
  const seatOverride = hasHistory ? histSeat : row.cpSeatHeightPrices;

  const prices = resolvePrices(
    baseOverride,
    price1Override,
    seatOverride,
    row.productBasePriceSen,
    row.productPrice1Sen,
    row.productSeatHeightPrices,
  );

  return {
    productId,
    customerId,
    hasCustomerOverride: row.cpId !== null,
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

app.get("/price-for/:productId/:customerId", async (c) => {
  const productId = c.req.param("productId");
  const customerId = c.req.param("customerId");
  const data = await resolveCustomerPrice(c.env.DB, productId, customerId);
  if (!data) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  return c.json({ success: true, data });
});

export default app;
export { resolveCustomerPrice, resolveCustomerPriceAsOf };
