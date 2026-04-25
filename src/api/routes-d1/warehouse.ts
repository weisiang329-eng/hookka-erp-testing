// ---------------------------------------------------------------------------
// D1-backed warehouse route.
//
// Mirrors src/api/routes/warehouse.ts. Rack locations are stored as one row in
// rack_locations + optional multi-item child rows in rack_items. The in-memory
// version keeps `items` as a nested array on the parent; we reconstruct that
// shape from rack_items on every read. The denormalized scalar columns on
// rack_locations (productionOrderId, productCode, productName, sizeLabel,
// customerName, stockedInDate, notes) are legacy single-item fields; when
// rack_items rows exist they take precedence.
//
// Rack status is recomputed on read/write via computeRackStatus() to mirror
// the in-memory route. Stock movements live in stock_movements.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type RackLocationRow = {
  id: string;
  rack: string;
  position: string | null;
  status: "OCCUPIED" | "EMPTY" | "RESERVED";
  reserved: number | null;
  productionOrderId: string | null;
  productCode: string | null;
  productName: string | null;
  sizeLabel: string | null;
  customerName: string | null;
  stockedInDate: string | null;
  notes: string | null;
};

type RackItemRow = {
  id: number;
  rackLocationId: string;
  productionOrderId: string | null;
  productCode: string | null;
  productName: string | null;
  sizeLabel: string | null;
  customerName: string | null;
  qty: number | null;
  stockedInDate: string | null;
  notes: string | null;
};

type StockMovementRow = {
  id: string;
  type: "STOCK_IN" | "STOCK_OUT" | "TRANSFER";
  rackLocationId: string | null;
  rackLabel: string | null;
  productionOrderId: string | null;
  productCode: string | null;
  productName: string | null;
  quantity: number;
  reason: string | null;
  performedBy: string | null;
  createdAt: string;
};

type RackItemApi = {
  productionOrderId?: string;
  productCode: string;
  productName?: string;
  sizeLabel?: string;
  customerName?: string;
  qty?: number;
  stockedInDate?: string;
  notes?: string;
};

function computeRackStatus(
  items: RackItemApi[] | undefined,
  reserved: boolean | undefined,
): "OCCUPIED" | "EMPTY" | "RESERVED" {
  if (items && items.length > 0) return "OCCUPIED";
  if (reserved) return "RESERVED";
  return "EMPTY";
}

function itemRowToApi(r: RackItemRow): RackItemApi {
  return {
    productionOrderId: r.productionOrderId ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? undefined,
    sizeLabel: r.sizeLabel ?? "",
    customerName: r.customerName ?? "",
    qty: r.qty ?? 1,
    stockedInDate: r.stockedInDate ?? "",
    notes: r.notes ?? "",
  };
}

// Assemble a RackLocation API object. If there are child rack_items rows they
// win; otherwise fall back to the denormalized scalar columns (legacy single-
// item record seeded into rack_locations directly).
function rowToRack(row: RackLocationRow, items: RackItemRow[]) {
  const children = items.filter((i) => i.rackLocationId === row.id);
  let apiItems: RackItemApi[] | undefined;
  if (children.length > 0) {
    apiItems = children.map(itemRowToApi);
  } else if (row.productCode) {
    apiItems = [
      {
        productionOrderId: row.productionOrderId ?? "",
        productCode: row.productCode,
        productName: row.productName ?? undefined,
        sizeLabel: row.sizeLabel ?? "",
        customerName: row.customerName ?? "",
        qty: 1,
        stockedInDate: row.stockedInDate ?? "",
        notes: row.notes ?? "",
      },
    ];
  }
  const reserved = row.reserved === 1;
  return {
    id: row.id,
    rack: row.rack,
    position: row.position ?? "",
    status: computeRackStatus(apiItems, reserved),
    ...(apiItems !== undefined ? { items: apiItems } : {}),
    ...(row.reserved !== null ? { reserved } : {}),
    ...(row.productionOrderId ? { productionOrderId: row.productionOrderId } : {}),
    ...(row.productCode ? { productCode: row.productCode } : {}),
    ...(row.productName ? { productName: row.productName } : {}),
    ...(row.sizeLabel ? { sizeLabel: row.sizeLabel } : {}),
    ...(row.customerName ? { customerName: row.customerName } : {}),
    ...(row.stockedInDate ? { stockedInDate: row.stockedInDate } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
  };
}

function genMovementId(): string {
  return `sm-${crypto.randomUUID().slice(0, 8)}`;
}

function rowToMovement(r: StockMovementRow) {
  return {
    id: r.id,
    type: r.type,
    rackLocationId: r.rackLocationId ?? "",
    rackLabel: r.rackLabel ?? "",
    productionOrderId: r.productionOrderId ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    quantity: r.quantity,
    reason: r.reason ?? "",
    performedBy: r.performedBy ?? "",
    createdAt: r.createdAt,
  };
}

// Replace all rack_items rows for a given rack location with the supplied set
// as a single atomic batch (DELETE + re-INSERT). Recomputes + persists status.
async function replaceRackItems(
  db: D1Database,
  rackLocationId: string,
  items: RackItemApi[],
  reserved: number | null,
) {
  const status = computeRackStatus(items, reserved === 1);
  const statements: D1PreparedStatement[] = [
    db
      .prepare("DELETE FROM rack_items WHERE rackLocationId = ?")
      .bind(rackLocationId),
  ];
  for (const it of items) {
    statements.push(
      db
        .prepare(
          `INSERT INTO rack_items (rackLocationId, productionOrderId,
             productCode, productName, sizeLabel, customerName, qty,
             stockedInDate, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          rackLocationId,
          it.productionOrderId ?? "",
          it.productCode,
          it.productName ?? "",
          it.sizeLabel ?? "",
          it.customerName ?? "",
          it.qty ?? 1,
          it.stockedInDate ?? new Date().toISOString().split("T")[0],
          it.notes ?? "",
        ),
    );
  }
  statements.push(
    db
      .prepare("UPDATE rack_locations SET status = ? WHERE id = ?")
      .bind(status, rackLocationId),
  );
  await db.batch(statements);
  return status;
}

// GET /api/warehouse — list all rack locations + summary + grouped-by-rack
app.get("/", async (c) => {
  const [locs, items] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM rack_locations ORDER BY rack").all<RackLocationRow>(),
    c.var.DB.prepare("SELECT * FROM rack_items").all<RackItemRow>(),
  ]);
  const data = (locs.results ?? []).map((l) => rowToRack(l, items.results ?? []));
  const grouped: Record<string, typeof data> = {};
  for (const loc of data) grouped[loc.rack] = [loc];
  const total = data.length;
  const occupied = data.filter((l) => l.status === "OCCUPIED").length;
  const empty = data.filter((l) => l.status === "EMPTY").length;
  const reserved = data.filter((l) => l.status === "RESERVED").length;
  const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;
  return c.json({
    success: true,
    data,
    grouped,
    summary: { total, occupied, empty, reserved, occupancyRate },
  });
});

// POST /api/warehouse — append one item to a rack location's items list
app.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as {
      rackLocationId: string;
      productionOrderId?: string;
      productCode: string;
      productName?: string;
      sizeLabel?: string;
      customerName?: string;
      notes?: string;
      qty?: number;
    };
    const { rackLocationId } = body;
    const row = await c.var.DB.prepare(
      "SELECT * FROM rack_locations WHERE id = ?",
    )
      .bind(rackLocationId)
      .first<RackLocationRow>();
    if (!row) {
      return c.json({ success: false, error: "Rack location not found" }, 404);
    }
    const existingItems = await c.var.DB.prepare(
      "SELECT * FROM rack_items WHERE rackLocationId = ?",
    )
      .bind(rackLocationId)
      .all<RackItemRow>();
    const current: RackItemApi[] = (existingItems.results ?? []).map(itemRowToApi);
    // If no rack_items rows exist yet but the denormalized scalar columns hold
    // a legacy item, carry it forward so we don't lose the seed data.
    if (current.length === 0 && row.productCode) {
      current.push({
        productionOrderId: row.productionOrderId ?? "",
        productCode: row.productCode,
        productName: row.productName ?? undefined,
        sizeLabel: row.sizeLabel ?? "",
        customerName: row.customerName ?? "",
        qty: 1,
        stockedInDate: row.stockedInDate ?? "",
        notes: row.notes ?? "",
      });
    }
    current.push({
      productionOrderId: body.productionOrderId ?? "",
      productCode: body.productCode,
      productName: body.productName,
      sizeLabel: body.sizeLabel ?? "",
      customerName: body.customerName ?? "",
      qty: body.qty ?? 1,
      stockedInDate: new Date().toISOString().split("T")[0],
      notes: body.notes ?? "",
    });
    await replaceRackItems(c.var.DB, rackLocationId, current, row.reserved);

    const [updatedRow, updatedItems] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM rack_locations WHERE id = ?")
        .bind(rackLocationId)
        .first<RackLocationRow>(),
      c.var.DB.prepare("SELECT * FROM rack_items WHERE rackLocationId = ?")
        .bind(rackLocationId)
        .all<RackItemRow>(),
    ]);
    if (!updatedRow) {
      return c.json({ success: false, error: "Rack location not found" }, 404);
    }
    return c.json({
      success: true,
      data: rowToRack(updatedRow, updatedItems.results ?? []),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/warehouse/movements — filter by type/from/to and return sorted DESC
app.get("/movements", async (c) => {
  const type = c.req.query("type");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const where: string[] = [];
  const binds: unknown[] = [];
  if (type) {
    where.push("type = ?");
    binds.push(type);
  }
  if (from) {
    where.push("created_at >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("created_at <= ?");
    binds.push(to + "T23:59:59Z");
  }
  const sql =
    where.length > 0
      ? `SELECT * FROM stock_movements WHERE ${where.join(" AND ")} ORDER BY created_at DESC`
      : "SELECT * FROM stock_movements ORDER BY created_at DESC";
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<StockMovementRow>();
  const data = (res.results ?? []).map(rowToMovement);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/warehouse/movements — append a stock movement record
app.post("/movements", async (c) => {
  try {
    const body = await c.req.json();
    const {
      type,
      rackLocationId,
      rackLabel,
      productionOrderId,
      productCode,
      productName,
      quantity,
      reason,
      performedBy,
    } = body;
    if (!type || !rackLocationId || !productCode || !productName) {
      return c.json({ success: false, error: "Missing required fields" }, 400);
    }
    const movementId = genMovementId();
    const createdAt = new Date().toISOString();
    await c.var.DB.prepare(
      `INSERT INTO stock_movements (id, type, rackLocationId, rackLabel,
         productionOrderId, productCode, productName, quantity, reason,
         performedBy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        movementId,
        type,
        rackLocationId,
        rackLabel || rackLocationId,
        productionOrderId || "",
        productCode,
        productName,
        quantity || 1,
        reason || "",
        performedBy || "System",
        createdAt,
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM stock_movements WHERE id = ?",
    )
      .bind(movementId)
      .first<StockMovementRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create stock movement" },
        500,
      );
    }
    return c.json({ success: true, data: rowToMovement(created) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/warehouse/:id — single rack location + items
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [row, items] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM rack_locations WHERE id = ?")
      .bind(id)
      .first<RackLocationRow>(),
    c.var.DB.prepare("SELECT * FROM rack_items WHERE rackLocationId = ?")
      .bind(id)
      .all<RackItemRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "Rack location not found" }, 404);
  }
  return c.json({ success: true, data: rowToRack(row, items.results ?? []) });
});

// PUT /api/warehouse/:id — replace items list and/or reserved flag
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM rack_locations WHERE id = ?",
  )
    .bind(id)
    .first<RackLocationRow>();
  if (!existing) {
    return c.json({ success: false, error: "Rack location not found" }, 404);
  }
  try {
    const body = (await c.req.json()) as {
      items?: RackItemApi[];
      reserved?: boolean;
    };
    let nextReserved = existing.reserved;
    if (body.reserved !== undefined) {
      nextReserved = body.reserved ? 1 : 0;
      await c.var.DB.prepare(
        "UPDATE rack_locations SET reserved = ? WHERE id = ?",
      )
        .bind(nextReserved, id)
        .run();
    }

    let nextItems: RackItemApi[] | undefined;
    if (Array.isArray(body.items)) {
      nextItems = body.items;
      await replaceRackItems(c.var.DB, id, nextItems, nextReserved);
    } else {
      // Still recompute status from current items + new reserved
      const itemsRes = await c.var.DB.prepare(
        "SELECT * FROM rack_items WHERE rackLocationId = ?",
      )
        .bind(id)
        .all<RackItemRow>();
      const current = (itemsRes.results ?? []).map(itemRowToApi);
      const status = computeRackStatus(current, nextReserved === 1);
      await c.var.DB.prepare(
        "UPDATE rack_locations SET status = ? WHERE id = ?",
      )
        .bind(status, id)
        .run();
    }

    const [updatedRow, updatedItems] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM rack_locations WHERE id = ?")
        .bind(id)
        .first<RackLocationRow>(),
      c.var.DB.prepare("SELECT * FROM rack_items WHERE rackLocationId = ?")
        .bind(id)
        .all<RackItemRow>(),
    ]);
    if (!updatedRow) {
      return c.json({ success: false, error: "Rack location not found" }, 404);
    }
    return c.json({
      success: true,
      data: rowToRack(updatedRow, updatedItems.results ?? []),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/warehouse/:id — remove all items OR just one by ?productCode=...
// Returns both the updated location and the previous state for undo/UI diff.
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM rack_locations WHERE id = ?",
  )
    .bind(id)
    .first<RackLocationRow>();
  if (!existing) {
    return c.json({ success: false, error: "Rack location not found" }, 404);
  }
  const productCode = c.req.query("productCode");
  const itemsRes = await c.var.DB.prepare(
    "SELECT * FROM rack_items WHERE rackLocationId = ?",
  )
    .bind(id)
    .all<RackItemRow>();
  const previousData = rowToRack(existing, itemsRes.results ?? []);

  let remaining: RackItemApi[] = (itemsRes.results ?? []).map(itemRowToApi);
  // Include legacy single-item so removal by productCode works on seeded data.
  if (remaining.length === 0 && existing.productCode) {
    remaining = [
      {
        productionOrderId: existing.productionOrderId ?? "",
        productCode: existing.productCode,
        productName: existing.productName ?? undefined,
        sizeLabel: existing.sizeLabel ?? "",
        customerName: existing.customerName ?? "",
        qty: 1,
        stockedInDate: existing.stockedInDate ?? "",
        notes: existing.notes ?? "",
      },
    ];
  }
  if (productCode) {
    const idx = remaining.findIndex((it) => it.productCode === productCode);
    if (idx !== -1) remaining.splice(idx, 1);
  } else {
    remaining = [];
  }
  await replaceRackItems(c.var.DB, id, remaining, existing.reserved);

  const [updatedRow, updatedItems] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM rack_locations WHERE id = ?")
      .bind(id)
      .first<RackLocationRow>(),
    c.var.DB.prepare("SELECT * FROM rack_items WHERE rackLocationId = ?")
      .bind(id)
      .all<RackItemRow>(),
  ]);
  if (!updatedRow) {
    return c.json({ success: false, error: "Rack location not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToRack(updatedRow, updatedItems.results ?? []),
    previousData,
  });
});

export default app;
