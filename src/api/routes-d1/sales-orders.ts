// ---------------------------------------------------------------------------
// D1-backed sales-orders route.
//
// Mirrors the old src/api/routes/sales-orders.ts response shape so the SPA
// frontend does not need any changes. `items` is returned as a nested array
// joined from the sales_order_items table. Status history comes from
// so_status_changes and price-override history from price_overrides.
//
// Schema-note: D1 stores timestamps in `created_at`/`updated_at` (snake_case)
// while the TS types expose `createdAt`/`updatedAt` (camelCase). The row->API
// mapper handles the rename. `so_status_changes.autoActions` is a JSON blob.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { calculateUnitPrice, calculateLineTotal } from "../../lib/pricing";

const app = new Hono<Env>();

type SalesOrderRow = {
  id: string;
  customerPO: string | null;
  customerPOId: string | null;
  customerPODate: string | null;
  customerSO: string | null;
  customerSOId: string | null;
  reference: string | null;
  customerId: string;
  customerName: string;
  customerState: string | null;
  hubId: string | null;
  hubName: string | null;
  companySO: string | null;
  companySOId: string | null;
  companySODate: string | null;
  customerDeliveryDate: string | null;
  hookkaExpectedDD: string | null;
  hookkaDeliveryOrder: string | null;
  subtotalSen: number;
  totalSen: number;
  status: string;
  overdue: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type SalesOrderItemRow = {
  id: string;
  salesOrderId: string;
  lineNo: number;
  lineSuffix: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricId: string | null;
  fabricCode: string | null;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrder: string | null;
  specialOrderPriceSen: number;
  basePriceSen: number;
  unitPriceSen: number;
  lineTotalSen: number;
  notes: string | null;
};

type SOStatusChangeRow = {
  id: string;
  soId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  changedBy: string | null;
  timestamp: string;
  notes: string | null;
  autoActions: string | null;
};

type PriceOverrideRow = {
  id: string;
  soId: string | null;
  soNumber: string | null;
  lineIndex: number;
  originalPrice: number;
  overridePrice: number;
  reason: string | null;
  approvedBy: string | null;
  timestamp: string;
};

function rowToItem(r: SalesOrderItemRow) {
  return {
    id: r.id,
    lineNo: r.lineNo,
    lineSuffix: r.lineSuffix ?? `-${String(r.lineNo).padStart(2, "0")}`,
    productId: r.productId ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    itemCategory: r.itemCategory ?? "BEDFRAME",
    sizeCode: r.sizeCode ?? "",
    sizeLabel: r.sizeLabel ?? "",
    fabricId: r.fabricId ?? "",
    fabricCode: r.fabricCode ?? "",
    quantity: r.quantity,
    gapInches: r.gapInches,
    divanHeightInches: r.divanHeightInches,
    divanPriceSen: r.divanPriceSen,
    legHeightInches: r.legHeightInches,
    legPriceSen: r.legPriceSen,
    specialOrder: r.specialOrder ?? "",
    specialOrderPriceSen: r.specialOrderPriceSen,
    basePriceSen: r.basePriceSen,
    unitPriceSen: r.unitPriceSen,
    lineTotalSen: r.lineTotalSen,
    notes: r.notes ?? "",
  };
}

function rowToSO(row: SalesOrderRow, items: SalesOrderItemRow[] = []) {
  return {
    id: row.id,
    customerPO: row.customerPO ?? "",
    customerPOId: row.customerPOId ?? "",
    customerPODate: row.customerPODate ?? "",
    customerSO: row.customerSO ?? "",
    customerSOId: row.customerSOId ?? "",
    reference: row.reference ?? "",
    customerId: row.customerId,
    customerName: row.customerName,
    customerState: row.customerState ?? "",
    hubId: row.hubId,
    hubName: row.hubName ?? "",
    companySO: row.companySO ?? "",
    companySOId: row.companySOId ?? "",
    companySODate: row.companySODate ?? "",
    customerDeliveryDate: row.customerDeliveryDate ?? "",
    hookkaExpectedDD: row.hookkaExpectedDD ?? "",
    hookkaDeliveryOrder: row.hookkaDeliveryOrder ?? "",
    items: items
      .filter((i) => i.salesOrderId === row.id)
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(rowToItem),
    subtotalSen: row.subtotalSen,
    totalSen: row.totalSen,
    status: row.status,
    overdue: row.overdue ?? "PENDING",
    notes: row.notes ?? "",
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

function parseAutoActions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToStatusChange(r: SOStatusChangeRow) {
  return {
    id: r.id,
    soId: r.soId ?? "",
    fromStatus: r.fromStatus ?? "",
    toStatus: r.toStatus ?? "",
    changedBy: r.changedBy ?? "",
    timestamp: r.timestamp,
    notes: r.notes ?? "",
    autoActions: parseAutoActions(r.autoActions),
  };
}

function rowToPriceOverride(r: PriceOverrideRow) {
  return {
    id: r.id,
    soId: r.soId ?? "",
    soNumber: r.soNumber ?? "",
    lineIndex: r.lineIndex,
    originalPrice: r.originalPrice,
    overridePrice: r.overridePrice,
    reason: r.reason ?? "",
    approvedBy: r.approvedBy ?? "",
    timestamp: r.timestamp,
  };
}

function genSoId(): string {
  return `so-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `soi-${crypto.randomUUID().slice(0, 8)}`;
}
function genStatusId(): string {
  return `sc-${crypto.randomUUID().slice(0, 8)}`;
}
function genOverrideId(): string {
  return `po-${crypto.randomUUID().slice(0, 8)}`;
}

// Generate next SO number by scanning existing companySOId values for the
// current YYMM prefix and incrementing the max sequence. Falls back to 001.
async function generateCompanySOId(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `SO-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT companySOId FROM sales_orders WHERE companySOId LIKE ? ORDER BY companySOId DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ companySOId: string }>();
  const seq = res?.companySOId
    ? Number(res.companySOId.split("-").pop()) + 1
    : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

async function fetchSOWithItems(
  db: D1Database,
  id: string,
): Promise<ReturnType<typeof rowToSO> | null> {
  const [so, itemsRes] = await Promise.all([
    db
      .prepare("SELECT * FROM sales_orders WHERE id = ?")
      .bind(id)
      .first<SalesOrderRow>(),
    db
      .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
      .bind(id)
      .all<SalesOrderItemRow>(),
  ]);
  if (!so) return null;
  return rowToSO(so, itemsRes.results ?? []);
}

// Valid status transitions — mirrors the in-memory route
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["IN_PRODUCTION", "ON_HOLD", "CANCELLED"],
  IN_PRODUCTION: ["READY_TO_SHIP", "ON_HOLD", "CANCELLED"],
  READY_TO_SHIP: ["SHIPPED", "ON_HOLD"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: ["INVOICED"],
  INVOICED: ["CLOSED"],
  ON_HOLD: ["CONFIRMED", "IN_PRODUCTION", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

// ---------------------------------------------------------------------------
// GET /api/sales-orders — list all SOs with nested items
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const [sos, items] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM sales_orders ORDER BY created_at DESC, id DESC",
    ).all<SalesOrderRow>(),
    c.env.DB.prepare("SELECT * FROM sales_order_items").all<SalesOrderItemRow>(),
  ]);
  const data = (sos.results ?? []).map((s) => rowToSO(s, items.results ?? []));
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/status-changes — full audit log
// (defined BEFORE /:id so the route matches first)
// ---------------------------------------------------------------------------
app.get("/status-changes", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT * FROM so_status_changes ORDER BY timestamp DESC",
  ).all<SOStatusChangeRow>();
  const data = (res.results ?? []).map(rowToStatusChange);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders — create a new SO + items atomically
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  try {
    const body = await c.req.json();

    // Validate customer
    const customer = await c.env.DB.prepare(
      "SELECT id, name FROM customers WHERE id = ?",
    )
      .bind(body.customerId)
      .first<{ id: string; name: string }>();
    if (!customer) {
      return c.json({ success: false, error: "Customer not found" }, 400);
    }

    // Resolve hub (optional)
    const hubIdField: string = body.hubId || body.deliveryHubId || "";
    let chosenHub: { id: string; state: string | null; shortName: string } | null = null;
    if (hubIdField) {
      chosenHub = await c.env.DB.prepare(
        "SELECT id, state, shortName FROM delivery_hubs WHERE id = ? AND customerId = ?",
      )
        .bind(hubIdField, customer.id)
        .first<{ id: string; state: string | null; shortName: string }>();
    }
    if (!chosenHub) {
      chosenHub = await c.env.DB.prepare(
        "SELECT id, state, shortName FROM delivery_hubs WHERE customerId = ? ORDER BY isDefault DESC LIMIT 1",
      )
        .bind(customer.id)
        .first<{ id: string; state: string | null; shortName: string }>();
    }

    const rawItems: Array<Record<string, unknown>> = Array.isArray(body.items)
      ? body.items
      : [];

    // Build items — resolve product basePrice fallback
    const items = await Promise.all(
      rawItems.map(async (item, idx) => {
        const productCode = String(item.productCode ?? "");
        let resolvedProduct: {
          id: string;
          name: string;
          category: string;
          sizeCode: string | null;
          sizeLabel: string | null;
          basePriceSen: number | null;
          seatHeightPrices: string | null;
        } | null = null;
        if (productCode) {
          resolvedProduct = await c.env.DB.prepare(
            "SELECT id, name, category, sizeCode, sizeLabel, basePriceSen, seatHeightPrices FROM products WHERE code = ? LIMIT 1",
          )
            .bind(productCode)
            .first();
          if (!resolvedProduct) {
            resolvedProduct = await c.env.DB.prepare(
              "SELECT id, name, category, sizeCode, sizeLabel, basePriceSen, seatHeightPrices FROM products WHERE LOWER(code) = LOWER(?) LIMIT 1",
            )
              .bind(productCode)
              .first();
          }
        }

        let basePriceSen = Number(item.basePriceSen) || 0;
        if (basePriceSen === 0 && resolvedProduct) {
          const seatHeight = String(item.seatHeight ?? "");
          if (resolvedProduct.seatHeightPrices && seatHeight) {
            try {
              const shpList = JSON.parse(resolvedProduct.seatHeightPrices) as Array<{
                height: string;
                priceSen: number;
              }>;
              const shp = shpList.find(
                (p) => p.height === seatHeight || p.height === `${seatHeight}"`,
              );
              basePriceSen = shp?.priceSen || resolvedProduct.basePriceSen || 0;
            } catch {
              basePriceSen = resolvedProduct.basePriceSen || 0;
            }
          } else {
            basePriceSen = resolvedProduct.basePriceSen || 0;
          }
        }

        const divanPriceSen = Number(item.divanPriceSen) || 0;
        const legPriceSen = Number(item.legPriceSen) || 0;
        const specialOrderPriceSen = Number(item.specialOrderPriceSen) || 0;
        const unitPriceSen = calculateUnitPrice({
          basePriceSen,
          divanPriceSen,
          legPriceSen,
          specialOrderPriceSen,
        });
        const quantity = Number(item.quantity) || 0;
        const lineTotalSen = calculateLineTotal(unitPriceSen, quantity);
        const lineNo = idx + 1;
        const lineSuffix = `-${String(lineNo).padStart(2, "0")}`;

        return {
          id: (item.id as string) || genItemId(),
          lineNo,
          lineSuffix,
          productId: (item.productId as string) || resolvedProduct?.id || "",
          productCode,
          productName:
            (item.productName as string) || resolvedProduct?.name || productCode,
          itemCategory:
            (item.itemCategory as string) ||
            resolvedProduct?.category ||
            "BEDFRAME",
          sizeCode:
            (item.sizeCode as string) || resolvedProduct?.sizeCode || "",
          sizeLabel:
            (item.sizeLabel as string) ||
            resolvedProduct?.sizeLabel ||
            (item.sizeCode as string) ||
            "",
          fabricId: (item.fabricId as string) || "",
          fabricCode: (item.fabricCode as string) || "",
          quantity,
          gapInches: item.gapInches ?? null,
          divanHeightInches: item.divanHeightInches ?? null,
          divanPriceSen,
          legHeightInches: item.legHeightInches ?? null,
          legPriceSen,
          specialOrder: (item.specialOrder as string) || "",
          specialOrderPriceSen,
          basePriceSen,
          unitPriceSen,
          lineTotalSen,
          notes: (item.notes as string) || "",
        };
      }),
    );

    const subtotalSen = items.reduce((sum, i) => sum + i.lineTotalSen, 0);
    const now = new Date().toISOString();
    const companySOId = await generateCompanySOId(c.env.DB);
    const soId = genSoId();
    const today = now.split("T")[0];

    const customerState =
      chosenHub?.state ??
      (typeof body.customerState === "string" ? body.customerState : "") ??
      "";

    const statements = [
      c.env.DB.prepare(
        `INSERT INTO sales_orders (id, customerPO, customerPOId, customerPODate,
           customerSO, customerSOId, reference, customerId, customerName,
           customerState, hubId, hubName, companySO, companySOId, companySODate,
           customerDeliveryDate, hookkaExpectedDD, hookkaDeliveryOrder,
           subtotalSen, totalSen, status, overdue, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        soId,
        body.customerPO ?? "",
        body.customerPOId ?? "",
        body.customerPODate ?? today,
        body.customerSO ?? "",
        body.customerSOId ?? "",
        body.reference ?? "",
        customer.id,
        customer.name,
        customerState,
        chosenHub?.id ?? null,
        chosenHub?.shortName ?? null,
        body.companySO ?? `Sales Order ${companySOId.split("-").pop()}`,
        companySOId,
        body.companySODate ?? today,
        body.customerDeliveryDate ?? "",
        body.hookkaExpectedDD ?? "",
        body.hookkaDeliveryOrder ?? "",
        subtotalSen,
        subtotalSen,
        "DRAFT",
        "PENDING",
        body.notes ?? "",
        now,
        now,
      ),
      ...items.map((item) =>
        c.env.DB.prepare(
          `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
             productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
             fabricId, fabricCode, quantity, gapInches, divanHeightInches,
             divanPriceSen, legHeightInches, legPriceSen, specialOrder,
             specialOrderPriceSen, basePriceSen, unitPriceSen, lineTotalSen, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          soId,
          item.lineNo,
          item.lineSuffix,
          item.productId,
          item.productCode,
          item.productName,
          item.itemCategory,
          item.sizeCode,
          item.sizeLabel,
          item.fabricId,
          item.fabricCode,
          item.quantity,
          item.gapInches,
          item.divanHeightInches,
          item.divanPriceSen,
          item.legHeightInches,
          item.legPriceSen,
          item.specialOrder,
          item.specialOrderPriceSen,
          item.basePriceSen,
          item.unitPriceSen,
          item.lineTotalSen,
          item.notes,
        ),
      ),
    ];

    await c.env.DB.batch(statements);

    const created = await fetchSOWithItems(c.env.DB, soId);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create sales order" },
        500,
      );
    }
    return c.json({ success: true, data: created }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders/:id/confirm
//
// Phase-3 scope: this just validates the transition, flips the status to
// CONFIRMED, and logs to so_status_changes. Auto-generation of production
// orders is deferred to Phase 4.
// TODO(phase-4): auto-create production_orders via buildProductionOrderForSOItem
// ---------------------------------------------------------------------------
app.post("/:id/confirm", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT * FROM sales_orders WHERE id = ?",
  )
    .bind(id)
    .first<SalesOrderRow>();
  if (!existing) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }

  // Only DRAFT / PENDING orders are confirmable
  if (existing.status !== "DRAFT" && existing.status !== "PENDING") {
    return c.json(
      {
        success: false,
        error: `Cannot confirm order with status ${existing.status}. Only DRAFT orders can be confirmed.`,
      },
      400,
    );
  }

  // Customer PO uniqueness (BR-SO-010)
  if (existing.customerPOId) {
    const dup = await c.env.DB.prepare(
      `SELECT id, companySOId FROM sales_orders
         WHERE id != ? AND customerPOId = ? AND customerId = ? AND status != 'CANCELLED'
         LIMIT 1`,
    )
      .bind(id, existing.customerPOId, existing.customerId)
      .first<{ id: string; companySOId: string | null }>();
    if (dup) {
      return c.json(
        {
          success: false,
          error: `Customer PO ${existing.customerPOId} already exists on ${dup.companySOId ?? dup.id}. Each customer PO must be unique.`,
        },
        400,
      );
    }
  }

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const now = new Date().toISOString();
  const fromStatus = existing.status;

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE sales_orders SET status = 'CONFIRMED', updated_at = ? WHERE id = ?",
    ).bind(now, id),
    c.env.DB.prepare(
      `INSERT INTO so_status_changes
         (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      genStatusId(),
      id,
      fromStatus,
      "CONFIRMED",
      (body.changedBy as string) || "Admin",
      now,
      (body.notes as string) || "Order confirmed",
      JSON.stringify([]),
    ),
  ]);

  const order = await fetchSOWithItems(c.env.DB, id);

  return c.json({
    success: true,
    data: order,
    productionOrders: [],
    bomFallbacks: [],
    bomWarnings: [],
    message:
      "Order confirmed. Production orders will be auto-generated in Phase 4.",
  });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/:id — SO + items + statusHistory + priceOverrides
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [so, itemsRes, statusRes, overridesRes] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM sales_orders WHERE id = ?")
      .bind(id)
      .first<SalesOrderRow>(),
    c.env.DB.prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
      .bind(id)
      .all<SalesOrderItemRow>(),
    c.env.DB.prepare(
      "SELECT * FROM so_status_changes WHERE soId = ? ORDER BY timestamp DESC",
    )
      .bind(id)
      .all<SOStatusChangeRow>(),
    c.env.DB.prepare("SELECT * FROM price_overrides WHERE soId = ?")
      .bind(id)
      .all<PriceOverrideRow>(),
  ]);
  if (!so) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToSO(so, itemsRes.results ?? []),
    linkedPOs: [], // Production orders — Phase 4
    statusHistory: (statusRes.results ?? []).map(rowToStatusChange),
    priceOverrides: (overridesRes.results ?? []).map(rowToPriceOverride),
  });
});

// ---------------------------------------------------------------------------
// PUT /api/sales-orders/:id — update SO, status transitions, replace items
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.env.DB.prepare(
      "SELECT * FROM sales_orders WHERE id = ?",
    )
      .bind(id)
      .first<SalesOrderRow>();
    if (!existing) {
      return c.json({ success: false, error: "Order not found" }, 404);
    }
    const body = await c.req.json();
    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [];
    let newStatus: string = existing.status;

    // --- Status change with validation ---
    if (body.status && body.status !== existing.status) {
      const requested = body.status as string;
      const validNext = VALID_TRANSITIONS[existing.status] || [];
      if (!validNext.includes(requested)) {
        return c.json(
          {
            success: false,
            error: `Invalid status transition: ${existing.status} -> ${requested}. Valid transitions: ${validNext.join(", ") || "none"}`,
          },
          400,
        );
      }
      newStatus = requested;

      statements.push(
        c.env.DB.prepare(
          `INSERT INTO so_status_changes
             (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          genStatusId(),
          id,
          existing.status,
          newStatus,
          (body.changedBy as string) || "Admin",
          now,
          (body.statusNotes as string) || `Status changed to ${newStatus}`,
          JSON.stringify([]),
        ),
      );
    }

    // --- Customer / hub resolution ---
    let customerId = existing.customerId;
    let customerName = existing.customerName;
    let customerState = existing.customerState ?? "";
    let hubId = existing.hubId;
    let hubName = existing.hubName ?? "";

    if (body.customerId) {
      const customer = await c.env.DB.prepare(
        "SELECT id, name FROM customers WHERE id = ?",
      )
        .bind(body.customerId)
        .first<{ id: string; name: string }>();
      if (customer) {
        customerId = customer.id;
        customerName = customer.name;
      }
    }

    if (body.hubId !== undefined) {
      if (body.hubId) {
        const hub = await c.env.DB.prepare(
          "SELECT id, state, shortName FROM delivery_hubs WHERE id = ? AND customerId = ?",
        )
          .bind(body.hubId, customerId)
          .first<{ id: string; state: string | null; shortName: string }>();
        if (hub) {
          hubId = hub.id;
          hubName = hub.shortName;
          customerState = hub.state ?? customerState;
        } else {
          hubId = null;
          hubName = "";
        }
      } else {
        hubId = null;
        hubName = "";
      }
    }

    // --- Merge scalar fields ---
    const merged = {
      customerPO: body.customerPO ?? existing.customerPO ?? "",
      customerPOId: body.customerPOId ?? existing.customerPOId ?? "",
      customerPODate: body.customerPODate ?? existing.customerPODate ?? "",
      customerSO: body.customerSO ?? existing.customerSO ?? "",
      customerSOId: body.customerSOId ?? existing.customerSOId ?? "",
      reference: body.reference ?? existing.reference ?? "",
      customerState,
      companySO: body.companySO ?? existing.companySO ?? "",
      companySODate: body.companySODate ?? existing.companySODate ?? "",
      customerDeliveryDate:
        body.customerDeliveryDate ?? existing.customerDeliveryDate ?? "",
      hookkaExpectedDD: body.hookkaExpectedDD ?? existing.hookkaExpectedDD ?? "",
      hookkaDeliveryOrder:
        body.hookkaDeliveryOrder ?? existing.hookkaDeliveryOrder ?? "",
      overdue: body.overdue ?? existing.overdue ?? "PENDING",
      notes: body.notes ?? existing.notes ?? "",
    };

    // --- Replace items (if provided) ---
    let subtotalSen = existing.subtotalSen;
    let totalSen = existing.totalSen;

    if (body.items) {
      const oldItemsRes = await c.env.DB.prepare(
        "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
      )
        .bind(id)
        .all<SalesOrderItemRow>();
      const oldItems = oldItemsRes.results ?? [];

      const rawItems: Array<Record<string, unknown>> = body.items;
      const newItems = rawItems.map((item, idx) => {
        const basePriceSen = Number(item.basePriceSen) || 0;
        const divanPriceSen = Number(item.divanPriceSen) || 0;
        const legPriceSen = Number(item.legPriceSen) || 0;
        const specialOrderPriceSen = Number(item.specialOrderPriceSen) || 0;
        const unitPriceSen = calculateUnitPrice({
          basePriceSen,
          divanPriceSen,
          legPriceSen,
          specialOrderPriceSen,
        });
        const quantity = Number(item.quantity) || 0;
        const lineTotalSen = calculateLineTotal(unitPriceSen, quantity);
        const lineNo = idx + 1;
        const lineSuffix = `-${String(lineNo).padStart(2, "0")}`;

        const oldItem = oldItems.find(
          (oi) =>
            oi.id === item.id ||
            (oi.productId === item.productId && oi.lineNo === lineNo),
        );

        const priceOverride =
          oldItem && oldItem.unitPriceSen !== unitPriceSen
            ? {
                id: genOverrideId(),
                originalPrice: oldItem.unitPriceSen,
                overridePrice: unitPriceSen,
                reason:
                  (item.priceOverrideReason as string) || "No reason provided",
                approvedBy: (body.changedBy as string) || "Admin",
              }
            : null;

        return {
          id: (item.id as string) || genItemId(),
          lineNo,
          lineSuffix,
          productId: (item.productId as string) || "",
          productCode: (item.productCode as string) || "",
          productName: (item.productName as string) || "",
          itemCategory: (item.itemCategory as string) || "BEDFRAME",
          sizeCode: (item.sizeCode as string) || "",
          sizeLabel: (item.sizeLabel as string) || "",
          fabricId: (item.fabricId as string) || "",
          fabricCode: (item.fabricCode as string) || "",
          quantity,
          gapInches: item.gapInches ?? null,
          divanHeightInches: item.divanHeightInches ?? null,
          divanPriceSen,
          legHeightInches: item.legHeightInches ?? null,
          legPriceSen,
          specialOrder: (item.specialOrder as string) || "",
          specialOrderPriceSen,
          basePriceSen,
          unitPriceSen,
          lineTotalSen,
          notes: (item.notes as string) || "",
          _priceOverride: priceOverride,
          _lineIndex: idx,
        };
      });

      subtotalSen = newItems.reduce((sum, i) => sum + i.lineTotalSen, 0);
      totalSen = subtotalSen;

      // Delete old, insert new
      statements.push(
        c.env.DB.prepare(
          "DELETE FROM sales_order_items WHERE salesOrderId = ?",
        ).bind(id),
      );
      for (const item of newItems) {
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
               productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
               fabricId, fabricCode, quantity, gapInches, divanHeightInches,
               divanPriceSen, legHeightInches, legPriceSen, specialOrder,
               specialOrderPriceSen, basePriceSen, unitPriceSen, lineTotalSen, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            item.id,
            id,
            item.lineNo,
            item.lineSuffix,
            item.productId,
            item.productCode,
            item.productName,
            item.itemCategory,
            item.sizeCode,
            item.sizeLabel,
            item.fabricId,
            item.fabricCode,
            item.quantity,
            item.gapInches,
            item.divanHeightInches,
            item.divanPriceSen,
            item.legHeightInches,
            item.legPriceSen,
            item.specialOrder,
            item.specialOrderPriceSen,
            item.basePriceSen,
            item.unitPriceSen,
            item.lineTotalSen,
            item.notes,
          ),
        );

        if (item._priceOverride) {
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO price_overrides
                 (id, soId, soNumber, lineIndex, originalPrice, overridePrice,
                  reason, approvedBy, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              item._priceOverride.id,
              id,
              existing.companySOId ?? "",
              item._lineIndex,
              item._priceOverride.originalPrice,
              item._priceOverride.overridePrice,
              item._priceOverride.reason,
              item._priceOverride.approvedBy,
              now,
            ),
          );
        }
      }
    }

    statements.push(
      c.env.DB.prepare(
        `UPDATE sales_orders SET
           customerPO = ?, customerPOId = ?, customerPODate = ?,
           customerSO = ?, customerSOId = ?, reference = ?,
           customerId = ?, customerName = ?, customerState = ?,
           hubId = ?, hubName = ?, companySO = ?, companySODate = ?,
           customerDeliveryDate = ?, hookkaExpectedDD = ?, hookkaDeliveryOrder = ?,
           subtotalSen = ?, totalSen = ?, status = ?, overdue = ?, notes = ?,
           updated_at = ?
         WHERE id = ?`,
      ).bind(
        merged.customerPO,
        merged.customerPOId,
        merged.customerPODate,
        merged.customerSO,
        merged.customerSOId,
        merged.reference,
        customerId,
        customerName,
        merged.customerState,
        hubId,
        hubName,
        merged.companySO,
        merged.companySODate,
        merged.customerDeliveryDate,
        merged.hookkaExpectedDD,
        merged.hookkaDeliveryOrder,
        subtotalSen,
        totalSen,
        newStatus,
        merged.overdue,
        merged.notes,
        now,
        id,
      ),
    );

    await c.env.DB.batch(statements);

    const updated = await fetchSOWithItems(c.env.DB, id);
    return c.json({ success: true, data: updated, linkedPOs: [] });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/sales-orders/:id — cascades to items via FK
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT id FROM sales_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM sales_orders WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

export default app;
