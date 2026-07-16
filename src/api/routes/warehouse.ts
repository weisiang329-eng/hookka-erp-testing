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
import { requirePermission } from "../lib/rbac";

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
  // Joined from production_orders on the grid query (GET /) so each item can
  // show the customer PO + a reliable customer name (rack_items.customerName is
  // often blank). Optional: the single-rack queries don't join, and itemRowToApi
  // degrades gracefully when they're absent.
  customerPOId?: string | null;
  poCustomerName?: string | null;
  // Joined from production_orders.salesOrderNo — our own SO number (companySOId,
  // e.g. "SO-2607-062"). Lets the warehouse be searched by Company SOID (owner
  // 2026-07-11); rack_items itself never stored it.
  salesOrderNo?: string | null;
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
  // Joined from production_orders via productionOrderId (LEFT JOIN). Lets the
  // UI show which document a movement belongs to — the production order number
  // and the sales order it traces back to — instead of only the reason string.
  poNo?: string | null;
  salesOrderNo?: string | null;
};

type RackItemApi = {
  productionOrderId?: string;
  productCode: string;
  productName?: string;
  sizeLabel?: string;
  customerName?: string;
  customerPOId?: string;
  companySOId?: string;
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
    // rack_items.customerName is often blank (stock-in doesn't capture it); fall
    // back to the production order's snapshot name so the grid always shows it.
    customerName: r.customerName || r.poCustomerName || "",
    customerPOId: r.customerPOId ?? "",
    companySOId: r.salesOrderNo ?? "",
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

// Matches a document token embedded in a free-text reason string, e.g.
// "DO-2606-034 dispatched" → "DO-2606-034". DO-dispatch stock-OUT rows store
// the DO number ONLY in `reason` (no productionOrderId), so the production_orders
// JOIN can't recover it — this regex does. Covers the doc prefixes the warehouse
// flow emits: DO/DR/GRN/GR/PI/CN/SO/PO, with or without a dash, then digits and
// further -digit groups.
const DOC_TOKEN_RE = /\b(?:DO|DR|GRN|GR|PI|CN|SO|PO)-?\d[\d-]*\b/i;

function rowToMovement(r: StockMovementRow) {
  // Document reference for the row. stock_movements has no ref_type/ref_id
  // columns — the only stored linkage is productionOrderId (resolved here to
  // the PO number + its sales order number via the LEFT JOIN) plus the free
  // reason text. We surface what's actually stored: poNo / salesOrderNo for a
  // clickable-grade reference, and leave `reason` as the human note.
  const poNo = r.poNo ?? "";
  const salesOrderNo = r.salesOrderNo ?? "";
  // DO-dispatch (and other) OUT rows carry the real document only in `reason`.
  // Pull it out so the UI can show the actual DO/DR/GRN number instead of the
  // PO/SO behind the JOIN (or "—" when there's no productionOrderId at all).
  const reasonDoc = (r.reason ?? "").match(DOC_TOKEN_RE)?.[0] ?? "";
  // Single best label for compact display: reason-extracted doc first (the
  // dispatched DO), then PO no, then SO no.
  const docRef = reasonDoc || poNo || salesOrderNo || "";
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
    poNo,
    salesOrderNo,
    docRef,
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
    // LEFT JOIN production_orders so each rack item carries the customer PO + a
    // reliable customer name (rack_items.customerName is often blank). Same join
    // pattern as the /movements query; po.customerPOId / po.customerName are
    // snapshot columns on production_orders.
    c.var.DB
      .prepare(
        // po.customerPOId is a rename-map column so its alias survives; alias the
        // PO customer name to snake_case so toCamel recovers it as poCustomerName
        // (an unquoted camelCase alias folds to lowercase and is lost — the
        // column-rename-map folded-lowercase trap).
        `SELECT ri.*, po.customerPOId AS customerPOId, po.customerName AS po_customer_name,
                po.salesOrderNo AS salesOrderNo
           FROM rack_items ri
           LEFT JOIN production_orders po ON po.id = ri.productionOrderId`,
      )
      .all<RackItemRow>(),
  ]);
  // Bucket rack_items by rackLocationId once (O(items)) so each rack does an
  // O(1) lookup instead of re-scanning the whole items list — the list handler
  // was O(racks × items) (~1219 racks). rowToRack still filters internally, so
  // passing the already-scoped bucket is a no-op there (byte-identical output).
  const itemsByRack = new Map<string, RackItemRow[]>();
  for (const it of items.results ?? []) {
    if (!it.rackLocationId) continue;
    const arr = itemsByRack.get(it.rackLocationId);
    if (arr) arr.push(it);
    else itemsByRack.set(it.rackLocationId, [it]);
  }
  const data = (locs.results ?? []).map((l) =>
    rowToRack(l, itemsByRack.get(l.id) ?? []),
  );
  const total = data.length;
  const occupied = data.filter((l) => l.status === "OCCUPIED").length;
  const empty = data.filter((l) => l.status === "EMPTY").length;
  const reserved = data.filter((l) => l.status === "RESERVED").length;
  const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;
  // NOTE: `grouped` (a per-rack-name duplicate of `data`) was dropped — no
  // consumer reads it (verified across desktop warehouse.tsx + /m WarehouseScreen
  // + whole src). It doubled this ~2.9MB payload for nothing.
  return c.json({
    success: true,
    data,
    summary: { total, occupied, empty, reserved, occupancyRate },
  });
});

// POST /api/warehouse — append one item to a rack location's items list
app.post("/", async (c) => {
  const denied = await requirePermission(c, "warehouse", "create");
  if (denied) return denied;
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

    // Stamp the rack onto the piece's job card too (same per-piece signature the
    // public scan uses: productionOrderId + WIP label) so a MANUAL stock-in also
    // flows to the Packing sheet + DO — "无论任何渠道" (owner 2026-06-17). Safe
    // no-op when the item is a raw-material add (no PO) or its name isn't a WIP
    // label; updated_at bumps the production snapshot cache so the sheet re-reads.
    if (body.productionOrderId && (body.productName ?? "").trim()) {
      try {
        await c.var.DB.prepare(
          `UPDATE job_cards SET rackingNumber = ?, updated_at = NOW()
             WHERE productionOrderId = ? AND wipLabel = ?`,
        )
          .bind(row.rack, body.productionOrderId, (body.productName ?? "").trim())
          .run();
      } catch (e) {
        console.error("[warehouse stock-in] rack stamp failed:", e);
      }
    }

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

// POST /api/warehouse/racks — create a NEW (empty) rack location.
// The rack's id IS its QR token (see routes/public-rack-qr.ts), so a created
// rack is immediately QR-printable ("Download all rack QRs" / per-rack QR) and
// usable by EVERY warehouse API (GET /warehouse lists it, stock-in adds items,
// movements + public scan resolve it by id) — no extra step, no separate token.
app.post("/racks", async (c) => {
  const denied = await requirePermission(c, "warehouse", "create");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as {
      rack?: string;
      position?: string;
      reserved?: boolean;
    };
    const rack = (body.rack ?? "").trim();
    if (!rack) {
      return c.json(
        { success: false, error: "Rack number / name is required" },
        400,
      );
    }
    const position = (body.position ?? "").trim() || null;
    // Keep labels unique — the same rack (+ position) can't be created twice.
    const dupe = await c.var.DB.prepare(
      "SELECT id FROM rack_locations WHERE rack = ? AND IFNULL(position, '') = IFNULL(?, '')",
    )
      .bind(rack, position)
      .first();
    if (dupe) {
      return c.json(
        {
          success: false,
          error: `Rack "${rack}${position ? " · " + position : ""}" already exists`,
        },
        409,
      );
    }
    const id = crypto.randomUUID();
    const status = body.reserved ? "RESERVED" : "EMPTY";
    await c.var.DB.prepare(
      "INSERT INTO rack_locations (id, rack, position, status, reserved) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, rack, position, status, body.reserved ? 1 : null)
      .run();
    const created = await c.var.DB.prepare(
      "SELECT * FROM rack_locations WHERE id = ?",
    )
      .bind(id)
      .first<RackLocationRow>();
    return c.json(
      {
        success: true,
        data: created
          ? rowToRack(created, [])
          : { id, rack, position, status },
      },
      201,
    );
  } catch (err) {
    console.error("[POST /api/warehouse/racks] failed:", err);
    return c.json({ success: false, error: "Failed to create rack" }, 500);
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
    where.push("sm.type = ?");
    binds.push(type);
  }
  if (from) {
    where.push("sm.created_at >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("sm.created_at <= ?");
    binds.push(to + "T23:59:59Z");
  }
  // LEFT JOIN production_orders so each movement can show the document it
  // belongs to (PO number + the sales order it traces back to). The join key
  // is the only stored doc linkage on stock_movements: productionOrderId.
  const base =
    `SELECT sm.*, po.poNo AS poNo, po.salesOrderNo AS salesOrderNo
       FROM stock_movements sm
       LEFT JOIN production_orders po ON po.id = sm.productionOrderId`;
  // Cap the result set — the table is append-only and unbounded; without a
  // LIMIT every call full-scans + sorts the entire history. 500 newest rows is
  // plenty for the history view (the UI windows/filters from there).
  const sql =
    where.length > 0
      ? `${base} WHERE ${where.join(" AND ")} ORDER BY sm.created_at DESC LIMIT 500`
      : `${base} ORDER BY sm.created_at DESC LIMIT 500`;
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<StockMovementRow>();
  const data = (res.results ?? []).map(rowToMovement);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/warehouse/movements — append a stock movement record
app.post("/movements", async (c) => {
  const denied = await requirePermission(c, "warehouse", "create");
  if (denied) return denied;
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
        // Store NULL (not "") when there's no PO link, so the production_orders
        // JOIN is honest: a missing link reads as "no document" rather than
        // matching an empty-string id and looking like "not found".
        productionOrderId || null,
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

// GET /api/warehouse/:id/details — one rack's contents + its move history.
// Powers the rack detail popup: `contents` is the rack's current rack_items
// (with the legacy single-item fallback so seeded racks aren't blank), and
// `movements` is that rack's stock_movements newest-first (capped at 50),
// each carrying the resolved document reference (PO no / SO no) via the same
// production_orders LEFT JOIN used by /movements.
app.get("/:id/details", async (c) => {
  const id = c.req.param("id");
  const [row, items, moves] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM rack_locations WHERE id = ?")
      .bind(id)
      .first<RackLocationRow>(),
    // Same customer JOIN as GET / so the detail popup's contents show the
    // customer name + customer PO (rack_items.customerName is often blank, and
    // customerPOId isn't a rack_items column at all). po_customer_name aliased
    // snake_case so toCamel recovers it (a camelCase alias folds + is lost).
    c.var.DB.prepare(
      `SELECT ri.*, po.customerPOId AS customerPOId, po.customerName AS po_customer_name
         FROM rack_items ri
         LEFT JOIN production_orders po ON po.id = ri.productionOrderId
        WHERE ri.rackLocationId = ?`,
    )
      .bind(id)
      .all<RackItemRow>(),
    c.var.DB.prepare(
      `SELECT sm.*, po.poNo AS poNo, po.salesOrderNo AS salesOrderNo
         FROM stock_movements sm
         LEFT JOIN production_orders po ON po.id = sm.productionOrderId
        WHERE sm.rackLocationId = ?
        ORDER BY sm.created_at DESC
        LIMIT 50`,
    )
      .bind(id)
      .all<StockMovementRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "Rack location not found" }, 404);
  }
  // Reuse rowToRack so contents include the legacy denormalized single item
  // when no rack_items rows exist (mirrors the list/detail endpoints).
  const rack = rowToRack(row, items.results ?? []);
  return c.json({
    success: true,
    data: {
      rack,
      contents: rack.items ?? [],
      movements: (moves.results ?? []).map(rowToMovement),
    },
  });
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
  const denied = await requirePermission(c, "warehouse", "update");
  if (denied) return denied;
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
  const denied = await requirePermission(c, "warehouse", "delete");
  if (denied) return denied;
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
  // Per-piece rows (the rack model) all carry an EMPTY productCode — their
  // identity is the description (productName) + SO tag (notes "SO <no>"). So a
  // single-piece stock-out targets them by that signature. Passing neither
  // productCode NOR itemName means "clear the whole rack".
  const itemName = c.req.query("itemName");
  const itemNotes = c.req.query("itemNotes");
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
  const removedItems: RackItemApi[] = [];
  if (productCode) {
    // Legacy single-code racks — remove the one matching item.
    const idx = remaining.findIndex((it) => it.productCode === productCode);
    if (idx !== -1) removedItems.push(...remaining.splice(idx, 1));
  } else if (itemName !== undefined) {
    // Per-piece — remove the first item matching the description + SO signature.
    // Two pieces identical in both are interchangeable, so removing either is
    // correct. No match → remove nothing (never wipe the rack on a miss).
    const idx = remaining.findIndex(
      (it) =>
        (it.productName ?? "") === itemName &&
        (it.notes ?? "") === (itemNotes ?? ""),
    );
    if (idx !== -1) removedItems.push(...remaining.splice(idx, 1));
  } else if (productCode === undefined) {
    // No item target at all → explicit "clear the whole rack".
    removedItems.push(...remaining);
    remaining = [];
  }
  // Else: productCode was passed but EMPTY with no itemName — an ambiguous
  // single-item target with no usable key. Remove nothing rather than nuking
  // every piece in the rack (the old behaviour, which lost whole racks).
  await replaceRackItems(c.var.DB, id, remaining, existing.reserved);

  // A piece leaving the rack (delivered / manually removed) must STOP showing
  // this rack on the Packing sheet + DO. Clear its job-card Rack # — but only
  // cards still pointing at THIS rack (don't wipe one already re-racked
  // elsewhere). Same per-piece signature the scan/manual stock-in set it with.
  for (const it of removedItems) {
    const wip = (it.productName ?? "").trim();
    if (!it.productionOrderId || !wip) continue;
    try {
      await c.var.DB.prepare(
        `UPDATE job_cards SET rackingNumber = '', updated_at = NOW()
           WHERE productionOrderId = ? AND wipLabel = ? AND rackingNumber = ?`,
      )
        .bind(it.productionOrderId, wip, existing.rack)
        .run();
    } catch (e) {
      console.error("[warehouse stock-out] rack clear failed:", e);
    }
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
    previousData,
  });
});

export default app;
