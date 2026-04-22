// ---------------------------------------------------------------------------
// D1-backed delivery-orders route.
//
// Mirrors the old src/api/routes/delivery-orders.ts response shape so the SPA
// frontend doesn't need any changes. `items` is returned as a nested array
// joined from delivery_order_items. JSON columns (`fgUnitIds`,
// `proofOfDelivery`) are parsed on read and stringified on write.
//
// Phase-3 scope: basic DO CRUD against the delivery_orders +
// delivery_order_items tables. Legacy behaviours around production-order
// lookups, FG-layer FIFO consumption, COGS ledger postings, lorry/3PL
// auto-pricing, and SO status cascades are DEFERRED to later phases —
// see the `// TODO(phase-4)` markers below. fg_units is empty at seed time,
// so those flows can't be exercised yet.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

// Status transitions allowed by the mock-data impl. Preserved here so the
// frontend sees identical error messages.
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["LOADED"],
  LOADED: ["DRAFT", "IN_TRANSIT", "DELIVERED"],
  IN_TRANSIT: ["DELIVERED"],
  DELIVERED: ["INVOICED"],
};

type DeliveryOrderRow = {
  id: string;
  doNo: string;
  salesOrderId: string | null;
  companySO: string | null;
  companySOId: string | null;
  customerId: string;
  customerPOId: string | null;
  customerName: string;
  customerState: string | null;
  hubId: string | null;
  hubName: string | null;
  deliveryAddress: string | null;
  contactPerson: string | null;
  contactPhone: string | null;
  deliveryDate: string | null;
  hookkaExpectedDD: string | null;
  driverId: string | null;
  driverName: string | null;
  vehicleNo: string | null;
  totalM3: number;
  totalItems: number;
  status: string;
  overdue: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  remarks: string | null;
  dropPoints: number | null;
  deliveryCostSen: number | null;
  lorryId: string | null;
  lorryName: string | null;
  doQrCode: string | null;
  fgUnitIds: string | null;
  signedAt: string | null;
  signedByWorkerId: string | null;
  signedByWorkerName: string | null;
  proofOfDelivery: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type DeliveryOrderItemRow = {
  id: string;
  deliveryOrderId: string;
  productionOrderId: string | null;
  poNo: string | null;
  productCode: string | null;
  productName: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  itemM3: number;
  rackingNumber: string | null;
  packingStatus: string | null;
  salesOrderNo: string | null;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToItem(row: DeliveryOrderItemRow) {
  return {
    id: row.id,
    productionOrderId: row.productionOrderId ?? "",
    poNo: row.poNo ?? "",
    productCode: row.productCode ?? "",
    productName: row.productName ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricCode: row.fabricCode ?? "",
    quantity: row.quantity,
    itemM3: row.itemM3,
    rackingNumber: row.rackingNumber ?? "",
    packingStatus: row.packingStatus ?? "PENDING",
    salesOrderNo: row.salesOrderNo ?? "",
  };
}

function rowToOrder(row: DeliveryOrderRow, items: DeliveryOrderItemRow[] = []) {
  const pod = parseJson<Record<string, unknown> | null>(row.proofOfDelivery, null);
  const fgUnitIds = parseJson<string[]>(row.fgUnitIds, []);
  const base: Record<string, unknown> = {
    id: row.id,
    doNo: row.doNo,
    salesOrderId: row.salesOrderId ?? "",
    companySO: row.companySO ?? "",
    companySOId: row.companySOId ?? "",
    customerId: row.customerId,
    customerPOId: row.customerPOId ?? "",
    customerName: row.customerName,
    customerState: row.customerState ?? "",
    deliveryAddress: row.deliveryAddress ?? "",
    contactPerson: row.contactPerson ?? "",
    contactPhone: row.contactPhone ?? "",
    hubId: row.hubId,
    hubName: row.hubName ?? "",
    dropPoints: row.dropPoints ?? undefined,
    deliveryCostSen: row.deliveryCostSen ?? undefined,
    lorryId: row.lorryId,
    lorryName: row.lorryName ?? "",
    deliveryDate: row.deliveryDate ?? "",
    hookkaExpectedDD: row.hookkaExpectedDD ?? "",
    driverId: row.driverId,
    driverName: row.driverName ?? "",
    vehicleNo: row.vehicleNo ?? "",
    items: items
      .filter((i) => i.deliveryOrderId === row.id)
      .map(rowToItem),
    totalM3: row.totalM3,
    totalItems: row.totalItems,
    status: row.status,
    overdue: row.overdue ?? "PENDING",
    dispatchedAt: row.dispatchedAt,
    deliveredAt: row.deliveredAt,
    remarks: row.remarks ?? "",
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
    doQrCode: row.doQrCode ?? undefined,
    fgUnitIds: fgUnitIds.length ? fgUnitIds : undefined,
    signedAt: row.signedAt,
    signedByWorkerId: row.signedByWorkerId,
    signedByWorkerName: row.signedByWorkerName ?? undefined,
  };
  if (pod) base.proofOfDelivery = pod;
  return base;
}

function genDoId(): string {
  return `do-${crypto.randomUUID().slice(0, 8)}`;
}

function genDoItemId(): string {
  return `doi-${crypto.randomUUID().slice(0, 8)}`;
}

function genNextDoNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `DO-${yymm}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
}

function genStatusChangeId(): string {
  return `sc-${crypto.randomUUID().slice(0, 8)}`;
}

function genInvoiceId(): string {
  return `inv-${crypto.randomUUID().slice(0, 8)}`;
}

function genInvoiceItemId(): string {
  return `invi-${crypto.randomUUID().slice(0, 8)}`;
}

function genNextInvoiceNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `INV-${yymm}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
}

async function fetchOrderWithItems(db: D1Database, id: string) {
  const [order, itemsRes] = await Promise.all([
    db
      .prepare("SELECT * FROM delivery_orders WHERE id = ?")
      .bind(id)
      .first<DeliveryOrderRow>(),
    db
      .prepare("SELECT * FROM delivery_order_items WHERE deliveryOrderId = ?")
      .bind(id)
      .all<DeliveryOrderItemRow>(),
  ]);
  if (!order) return null;
  return rowToOrder(order, itemsRes.results ?? []);
}

// GET /api/delivery-orders — list all, nested items
app.get("/", async (c) => {
  const [orders, items] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM delivery_orders ORDER BY created_at DESC",
    ).all<DeliveryOrderRow>(),
    c.env.DB.prepare(
      "SELECT * FROM delivery_order_items",
    ).all<DeliveryOrderItemRow>(),
  ]);

  const data = (orders.results ?? []).map((o) =>
    rowToOrder(o, items.results ?? []),
  );
  return c.json({ success: true, data, total: data.length });
});

// POST /api/delivery-orders — create
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const salesOrderId: string | undefined =
      body.salesOrderId ?? undefined;

    // Validate customer (salesOrder link optional at this phase).
    let salesOrderRow: {
      id: string;
      customerId: string;
      customerName: string | null;
      customerState: string | null;
      customerPOId: string | null;
      companySO: string | null;
      companySOId: string | null;
      hubId: string | null;
      hookkaExpectedDD: string | null;
    } | null = null;
    if (salesOrderId) {
      salesOrderRow = await c.env.DB.prepare(
        `SELECT id, customerId, customerName, customerState, customerPOId,
                companySO, companySOId, hubId, hookkaExpectedDD
           FROM sales_orders WHERE id = ?`,
      )
        .bind(salesOrderId)
        .first();
      if (!salesOrderRow) {
        return c.json(
          { success: false, error: "Sales order not found" },
          400,
        );
      }
    }

    const customerId: string | undefined =
      body.customerId ?? salesOrderRow?.customerId;
    if (!customerId) {
      return c.json(
        { success: false, error: "customerId or salesOrderId is required" },
        400,
      );
    }
    const customerRow = await c.env.DB.prepare(
      `SELECT id, name, contactName, phone FROM customers WHERE id = ?`,
    )
      .bind(customerId)
      .first<{
        id: string;
        name: string;
        contactName: string | null;
        phone: string | null;
      }>();
    if (!customerRow) {
      return c.json({ success: false, error: "Customer not found" }, 400);
    }

    // Resolve the (optional) default delivery hub so address/contact default
    // the way the mock-data route used to.
    let defaultHub: {
      id: string;
      shortName: string | null;
      address: string | null;
    } | null = null;
    const hubTarget = body.hubId ?? salesOrderRow?.hubId ?? null;
    if (hubTarget) {
      defaultHub = await c.env.DB.prepare(
        "SELECT id, shortName, address FROM delivery_hubs WHERE id = ?",
      )
        .bind(hubTarget)
        .first();
    } else {
      defaultHub = await c.env.DB.prepare(
        "SELECT id, shortName, address FROM delivery_hubs WHERE customerId = ? ORDER BY isDefault DESC LIMIT 1",
      )
        .bind(customerId)
        .first();
    }

    const itemsInput: Array<Record<string, unknown>> = Array.isArray(body.items)
      ? body.items
      : [];
    const items = itemsInput.map((item) => ({
      id: (item.id as string) || genDoItemId(),
      productionOrderId: (item.productionOrderId as string) || "",
      salesOrderNo: (item.salesOrderNo as string) || "",
      poNo: (item.poNo as string) || "",
      productCode: (item.productCode as string) || "",
      productName: (item.productName as string) || "",
      sizeLabel: (item.sizeLabel as string) || "",
      fabricCode: (item.fabricCode as string) || "",
      quantity: Number(item.quantity) || 0,
      itemM3: Number(item.itemM3) || 0,
      rackingNumber: (item.rackingNumber as string) || "",
      packingStatus: (item.packingStatus as string) || "PENDING",
    }));

    const totalM3 =
      Math.round(items.reduce((s, i) => s + i.itemM3 * i.quantity, 0) * 100) /
      100;
    const totalItems = items.reduce((s, i) => s + i.quantity, 0);
    const now = new Date().toISOString();
    const id = genDoId();
    const doNo: string = body.doNo || genNextDoNo();

    const statements = [
      c.env.DB.prepare(
        `INSERT INTO delivery_orders (
           id, doNo, salesOrderId, companySO, companySOId, customerId,
           customerPOId, customerName, customerState, hubId, hubName,
           deliveryAddress, contactPerson, contactPhone, deliveryDate,
           hookkaExpectedDD, driverId, driverName, vehicleNo, totalM3,
           totalItems, status, overdue, dispatchedAt, deliveredAt, remarks,
           dropPoints, deliveryCostSen, lorryId, lorryName, doQrCode,
           fgUnitIds, signedAt, signedByWorkerId, signedByWorkerName,
           proofOfDelivery, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        doNo,
        salesOrderRow?.id ?? null,
        salesOrderRow?.companySO ?? body.companySO ?? null,
        salesOrderRow?.companySOId ?? body.companySOId ?? null,
        customerRow.id,
        salesOrderRow?.customerPOId ?? body.customerPOId ?? null,
        customerRow.name,
        salesOrderRow?.customerState ?? body.customerState ?? null,
        defaultHub?.id ?? null,
        defaultHub?.shortName ?? null,
        body.deliveryAddress ?? defaultHub?.address ?? "",
        body.contactPerson ?? customerRow.contactName ?? "",
        body.contactPhone ?? customerRow.phone ?? "",
        body.deliveryDate ?? "",
        salesOrderRow?.hookkaExpectedDD ?? "",
        body.driverId ?? null,
        body.driverName ?? "",
        body.vehicleNo ?? "",
        totalM3,
        totalItems,
        "DRAFT",
        "PENDING",
        null,
        null,
        body.remarks ?? "",
        Number(body.dropPoints) || 1,
        Number(body.deliveryCostSen) || 0,
        body.lorryId ?? null,
        body.lorryName ?? null,
        body.doQrCode ?? null,
        body.fgUnitIds ? JSON.stringify(body.fgUnitIds) : null,
        null,
        null,
        null,
        null,
        now,
        now,
      ),
      ...items.map((item) =>
        c.env.DB.prepare(
          `INSERT INTO delivery_order_items (
             id, deliveryOrderId, productionOrderId, poNo, productCode,
             productName, sizeLabel, fabricCode, quantity, itemM3,
             rackingNumber, packingStatus, salesOrderNo
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          id,
          item.productionOrderId,
          item.poNo,
          item.productCode,
          item.productName,
          item.sizeLabel,
          item.fabricCode,
          item.quantity,
          item.itemM3,
          item.rackingNumber,
          item.packingStatus,
          item.salesOrderNo,
        ),
      ),
    ];

    // Mirror the old impl: stamp the SO's hookkaDeliveryOrder so the SO view
    // knows a DO exists. We do this inside the batch so it rolls back together.
    if (salesOrderRow) {
      statements.push(
        c.env.DB.prepare(
          "UPDATE sales_orders SET hookkaDeliveryOrder = ?, updated_at = ? WHERE id = ?",
        ).bind(doNo, now, salesOrderRow.id),
      );
    }

    // TODO(phase-4): consume FG units + record stock_movement when DO is
    // created from production orders (body.productionOrderIds flow).

    await c.env.DB.batch(statements);

    const created = await fetchOrderWithItems(c.env.DB, id);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create delivery order" },
        500,
      );
    }
    return c.json({ success: true, data: created }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/delivery-orders/:id — single
app.get("/:id", async (c) => {
  const order = await fetchOrderWithItems(c.env.DB, c.req.param("id"));
  if (!order) {
    return c.json({ success: false, error: "Delivery order not found" }, 404);
  }
  return c.json({ success: true, data: order });
});

// PUT /api/delivery-orders/:id — update (supports status transitions, PoD,
// driver/lorry changes, and full item replacement).
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.env.DB.prepare(
      "SELECT * FROM delivery_orders WHERE id = ?",
    )
      .bind(id)
      .first<DeliveryOrderRow>();
    if (!existing) {
      return c.json(
        { success: false, error: "Delivery order not found" },
        404,
      );
    }

    const body = await c.req.json();
    const now = new Date().toISOString();

    // --- status transition validation (same rules as mock-data) ---
    let nextStatus: string = existing.status;
    let nextDispatchedAt: string | null = existing.dispatchedAt;
    let nextDeliveredAt: string | null = existing.deliveredAt;
    let nextOverdue: string | null = existing.overdue;

    if (body.status && body.status !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status];
      if (!allowed || !allowed.includes(body.status)) {
        return c.json(
          {
            success: false,
            error: `Invalid status transition: ${existing.status} → ${body.status}. Allowed transitions from ${existing.status}: ${allowed?.join(", ") || "none"}`,
          },
          400,
        );
      }
      nextStatus = body.status;
      if (nextStatus === "LOADED") nextDispatchedAt = now;
      if (nextStatus === "DRAFT") nextDispatchedAt = null;
      if (nextStatus === "IN_TRANSIT" && !nextDispatchedAt)
        nextDispatchedAt = now;
      if (nextStatus === "DELIVERED") {
        // prefer pod timestamp if provided, otherwise stamp now
        const podAt =
          body.proofOfDelivery?.deliveredAt ?? existing.deliveredAt ?? now;
        nextDeliveredAt = podAt;
        nextOverdue = "COMPLETED";
        // TODO(phase-4): FIFO-consume FG batches + emit COGS ledger entries.
      }
      if (nextStatus === "INVOICED") {
        nextOverdue = "INVOICED";
      }
    }

    // --- proof of delivery blob ---
    let nextProofOfDelivery: string | null = existing.proofOfDelivery;
    if (body.proofOfDelivery) {
      const pod = body.proofOfDelivery;
      nextProofOfDelivery = JSON.stringify({
        receiverName: pod.receiverName ?? "",
        receiverIC: pod.receiverIC ?? "",
        signatureDataUrl: pod.signatureDataUrl ?? "",
        photoDataUrls: Array.isArray(pod.photoDataUrls)
          ? pod.photoDataUrls.slice(0, 5)
          : [],
        remarks: pod.remarks ?? "",
        deliveredAt: pod.deliveredAt ?? now,
        capturedBy: pod.capturedBy ?? "",
      });
    }

    // --- simple field merges ---
    const merged = {
      deliveryDate:
        body.deliveryDate === undefined
          ? existing.deliveryDate
          : body.deliveryDate,
      driverId:
        body.driverId === undefined ? existing.driverId : body.driverId,
      driverName:
        body.driverName === undefined
          ? existing.driverName
          : body.driverName,
      vehicleNo:
        body.vehicleNo === undefined ? existing.vehicleNo : body.vehicleNo,
      deliveryAddress:
        body.deliveryAddress === undefined
          ? existing.deliveryAddress
          : body.deliveryAddress,
      contactPerson:
        body.contactPerson === undefined
          ? existing.contactPerson
          : body.contactPerson,
      contactPhone:
        body.contactPhone === undefined
          ? existing.contactPhone
          : body.contactPhone,
      remarks: body.remarks === undefined ? existing.remarks : body.remarks,
      dropPoints:
        body.dropPoints === undefined
          ? existing.dropPoints
          : Number(body.dropPoints) || 1,
      deliveryCostSen:
        body.deliveryCostSen === undefined
          ? existing.deliveryCostSen
          : Number(body.deliveryCostSen) || 0,
      lorryId: body.lorryId === undefined ? existing.lorryId : body.lorryId,
      lorryName:
        body.lorryName === undefined ? existing.lorryName : body.lorryName,
    };

    // --- lorry lookup: if a new lorryId is provided, pick up driver/plate ---
    if (body.lorryId !== undefined && body.lorryId) {
      const lorry = await c.env.DB.prepare(
        "SELECT id, name, plateNumber, driverName FROM lorries WHERE id = ?",
      )
        .bind(body.lorryId)
        .first<{
          id: string;
          name: string;
          plateNumber: string | null;
          driverName: string | null;
        }>();
      if (lorry) {
        merged.lorryId = lorry.id;
        merged.lorryName = lorry.name;
        merged.driverName = lorry.driverName ?? merged.driverName;
        merged.vehicleNo = lorry.plateNumber ?? merged.vehicleNo;
      }
    } else if (body.lorryId === null) {
      merged.lorryId = null;
      merged.lorryName = "";
    }

    // --- driver → 3PL lookup: auto-fill vehicle + recompute cost ---
    if (body.driverId !== undefined && body.driverId) {
      const provider = await c.env.DB.prepare(
        "SELECT id, name, vehicleNo, ratePerTripSen, ratePerExtraDropSen FROM three_pl_providers WHERE id = ?",
      )
        .bind(body.driverId)
        .first<{
          id: string;
          name: string;
          vehicleNo: string | null;
          ratePerTripSen: number;
          ratePerExtraDropSen: number;
        }>();
      if (provider) {
        merged.driverName = provider.name;
        if (provider.vehicleNo) merged.vehicleNo = provider.vehicleNo;
        const drops = merged.dropPoints ?? 1;
        merged.deliveryCostSen =
          provider.ratePerTripSen +
          Math.max(0, drops - 1) * provider.ratePerExtraDropSen;
      }
    }

    // --- totals recomputed only if items replaced ---
    let newItems:
      | Array<ReturnType<typeof itemFromBody>>
      | null = null;
    function itemFromBody(item: Record<string, unknown>) {
      return {
        id: (item.id as string) || genDoItemId(),
        productionOrderId: (item.productionOrderId as string) || "",
        salesOrderNo: (item.salesOrderNo as string) || "",
        poNo: (item.poNo as string) || "",
        productCode: (item.productCode as string) || "",
        productName: (item.productName as string) || "",
        sizeLabel: (item.sizeLabel as string) || "",
        fabricCode: (item.fabricCode as string) || "",
        quantity: Number(item.quantity) || 0,
        itemM3: Number(item.itemM3) || 0,
        rackingNumber: (item.rackingNumber as string) || "",
        packingStatus: (item.packingStatus as string) || "PACKED",
      };
    }
    let nextTotalM3 = existing.totalM3;
    let nextTotalItems = existing.totalItems;
    if (Array.isArray(body.items)) {
      newItems = (body.items as Array<Record<string, unknown>>).map(itemFromBody);
      nextTotalM3 =
        Math.round(
          newItems.reduce((s, i) => s + i.itemM3 * i.quantity, 0) * 100,
        ) / 100;
      nextTotalItems = newItems.reduce((s, i) => s + i.quantity, 0);
    }

    // --- batch the update + optional items replacement ---
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `UPDATE delivery_orders SET
           deliveryDate = ?, driverId = ?, driverName = ?, vehicleNo = ?,
           deliveryAddress = ?, contactPerson = ?, contactPhone = ?,
           remarks = ?, dropPoints = ?, deliveryCostSen = ?, lorryId = ?,
           lorryName = ?, status = ?, overdue = ?, dispatchedAt = ?,
           deliveredAt = ?, proofOfDelivery = ?, totalM3 = ?, totalItems = ?,
           updated_at = ?
         WHERE id = ?`,
      ).bind(
        merged.deliveryDate,
        merged.driverId,
        merged.driverName,
        merged.vehicleNo,
        merged.deliveryAddress,
        merged.contactPerson,
        merged.contactPhone,
        merged.remarks,
        merged.dropPoints,
        merged.deliveryCostSen,
        merged.lorryId,
        merged.lorryName,
        nextStatus,
        nextOverdue,
        nextDispatchedAt,
        nextDeliveredAt,
        nextProofOfDelivery,
        nextTotalM3,
        nextTotalItems,
        now,
        id,
      ),
    ];

    if (newItems !== null) {
      statements.push(
        c.env.DB.prepare(
          "DELETE FROM delivery_order_items WHERE deliveryOrderId = ?",
        ).bind(id),
      );
      for (const item of newItems) {
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO delivery_order_items (
               id, deliveryOrderId, productionOrderId, poNo, productCode,
               productName, sizeLabel, fabricCode, quantity, itemM3,
               rackingNumber, packingStatus, salesOrderNo
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            item.id,
            id,
            item.productionOrderId,
            item.poNo,
            item.productCode,
            item.productName,
            item.sizeLabel,
            item.fabricCode,
            item.quantity,
            item.itemM3,
            item.rackingNumber,
            item.packingStatus,
            item.salesOrderNo,
          ),
        );
      }
    }

    // -------------------------------------------------------------------
    // Cascades on DELIVERED transition (E1 + E2):
    //   * fg_units.status = 'DELIVERED' for every unit linked to this DO
    //   * sales_orders.status = 'DELIVERED' + so_status_changes audit row
    //   * Auto-create a DRAFT invoice linked to this DO (idempotent — skip
    //     if any invoice already references this deliveryOrderId).
    // Everything goes into the same batch so a partial failure rolls back.
    // -------------------------------------------------------------------
    const cascadedToDelivered =
      existing.status !== "DELIVERED" && nextStatus === "DELIVERED";
    if (cascadedToDelivered) {
      // fg_units sync: flip every unit whose doId matches.
      statements.push(
        c.env.DB.prepare(
          `UPDATE fg_units SET status = 'DELIVERED', deliveredAt = ? WHERE doId = ?`,
        ).bind(nextDeliveredAt ?? now, id),
      );

      // SO status cascade — only if this DO is linked to a SO.
      if (existing.salesOrderId) {
        const soRow = await c.env.DB.prepare(
          "SELECT id, status, totalSen FROM sales_orders WHERE id = ?",
        )
          .bind(existing.salesOrderId)
          .first<{ id: string; status: string; totalSen: number }>();

        if (soRow && soRow.status !== "DELIVERED") {
          statements.push(
            c.env.DB.prepare(
              "UPDATE sales_orders SET status = 'DELIVERED', updated_at = ? WHERE id = ?",
            ).bind(now, soRow.id),
            c.env.DB.prepare(
              `INSERT INTO so_status_changes
                 (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              genStatusChangeId(),
              soRow.id,
              soRow.status,
              "DELIVERED",
              "System",
              now,
              "DO delivered",
              JSON.stringify([`DO ${existing.doNo} marked DELIVERED`]),
            ),
          );
        }

        // Auto-create DRAFT invoice — idempotent check.
        const existingInvoice = await c.env.DB.prepare(
          "SELECT id FROM invoices WHERE deliveryOrderId = ? LIMIT 1",
        )
          .bind(id)
          .first<{ id: string }>();

        if (!existingInvoice) {
          // Build invoice line items from DO items joined with SO unit prices
          // (same pattern used by the invoices POST route). Fall back to the
          // SO items themselves if the DO has no lines.
          const [doItemsRes, soItemsRes] = await Promise.all([
            c.env.DB.prepare(
              `SELECT productCode, productName, sizeLabel, fabricCode, quantity
                 FROM delivery_order_items WHERE deliveryOrderId = ?`,
            )
              .bind(id)
              .all<{
                productCode: string | null;
                productName: string | null;
                sizeLabel: string | null;
                fabricCode: string | null;
                quantity: number;
              }>(),
            c.env.DB.prepare(
              `SELECT productCode, productName, sizeLabel, fabricCode, quantity, unitPriceSen, lineTotalSen
                 FROM sales_order_items WHERE salesOrderId = ?`,
            )
              .bind(existing.salesOrderId)
              .all<{
                productCode: string | null;
                productName: string | null;
                sizeLabel: string | null;
                fabricCode: string | null;
                quantity: number;
                unitPriceSen: number;
                lineTotalSen: number;
              }>(),
          ]);

          const priceByCode = new Map<string, number>();
          for (const si of soItemsRes.results ?? []) {
            if (si.productCode) priceByCode.set(si.productCode, si.unitPriceSen);
          }

          type InvItem = {
            id: string;
            productCode: string;
            productName: string;
            sizeLabel: string;
            fabricCode: string;
            quantity: number;
            unitPriceSen: number;
            totalSen: number;
          };

          let invItems: InvItem[] = (doItemsRes.results ?? []).map((di) => {
            const unitPriceSen = di.productCode
              ? priceByCode.get(di.productCode) ?? 0
              : 0;
            return {
              id: genInvoiceItemId(),
              productCode: di.productCode ?? "",
              productName: di.productName ?? "",
              sizeLabel: di.sizeLabel ?? "",
              fabricCode: di.fabricCode ?? "",
              quantity: di.quantity,
              unitPriceSen,
              totalSen: unitPriceSen * di.quantity,
            };
          });

          let computedTotal = invItems.reduce((s, i) => s + i.totalSen, 0);

          // Fall back to SO line items if DO had no lines OR all prices
          // resolved to 0 (DO items not aligned with SO productCodes).
          if (computedTotal === 0 && (soItemsRes.results ?? []).length > 0) {
            invItems = (soItemsRes.results ?? []).map((si) => ({
              id: genInvoiceItemId(),
              productCode: si.productCode ?? "",
              productName: si.productName ?? "",
              sizeLabel: si.sizeLabel ?? "",
              fabricCode: si.fabricCode ?? "",
              quantity: si.quantity,
              unitPriceSen: si.unitPriceSen,
              totalSen: si.lineTotalSen || si.unitPriceSen * si.quantity,
            }));
            computedTotal = invItems.reduce((s, i) => s + i.totalSen, 0);
          }

          // Final fallback — use SO total (e.g. if DO lines exist but all
          // priced at 0 and SO has no matching items).
          if (computedTotal === 0 && soRow?.totalSen) {
            computedTotal = soRow.totalSen;
          }

          const invId = genInvoiceId();
          const invoiceNo = genNextInvoiceNo();
          const invoiceDate = now.split("T")[0];
          const due = new Date();
          due.setDate(due.getDate() + 30);
          const dueDate = due.toISOString().split("T")[0];

          statements.push(
            c.env.DB.prepare(
              `INSERT INTO invoices (
                 id, invoiceNo, deliveryOrderId, doNo, salesOrderId, companySOId,
                 customerId, customerName, customerState, hubId, hubName,
                 subtotalSen, totalSen, status, invoiceDate, dueDate, paidAmount,
                 paymentDate, paymentMethod, notes, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              invId,
              invoiceNo,
              id,
              existing.doNo,
              existing.salesOrderId,
              existing.companySOId,
              existing.customerId,
              existing.customerName,
              existing.customerState,
              existing.hubId,
              existing.hubName,
              computedTotal,
              computedTotal,
              "DRAFT",
              invoiceDate,
              dueDate,
              0,
              null,
              "",
              "",
              now,
              now,
            ),
          );
          for (const item of invItems) {
            statements.push(
              c.env.DB.prepare(
                `INSERT INTO invoice_items (
                   id, invoiceId, productCode, productName, sizeLabel, fabricCode,
                   quantity, unitPriceSen, totalSen
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ).bind(
                item.id,
                invId,
                item.productCode,
                item.productName,
                item.sizeLabel,
                item.fabricCode,
                item.quantity,
                item.unitPriceSen,
                item.totalSen,
              ),
            );
          }
        }
      }
    }

    await c.env.DB.batch(statements);

    const updated = await fetchOrderWithItems(c.env.DB, id);
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
