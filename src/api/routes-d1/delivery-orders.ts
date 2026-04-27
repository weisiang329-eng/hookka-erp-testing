// ---------------------------------------------------------------------------
// D1-backed delivery-orders route.
//
// Mirrors the old src/api/routes/delivery-orders.ts response shape so the SPA
// frontend doesn't need any changes. `items` is returned as a nested array
// joined from delivery_order_items. JSON columns (`fgUnitIds`,
// `proofOfDelivery`) are parsed on read and stringified on write.
//
// Phase coverage: full CRUD (phase 3) + the phase-4 stocking cascade —
// fg_units stamping on LOADED, FIFO COGS + SO status cascade + auto-
// invoice on DELIVERED, and the LOADED → DRAFT reversal that unstamps
// fg_units when the operator reopens the DO. The header used to flag
// these as deferred but the work landed; only the comment was stale.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { consumeFGBatchesForDO } from "../lib/do-cost-cascade";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";

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
  driverContactPerson: string | null;
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
  createdAt: string | null;
  updatedAt: string | null;
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

// Returns itemM3 from the live products table when available, falling
// back to the stored row value (legacy DOs created before 2026-04-27
// were persisted with itemM3=0 — see BUG-2026-04-27).
function pickItemM3(
  row: DeliveryOrderItemRow,
  productM3Map?: Map<string, number>,
): number {
  if (productM3Map && row.productCode) {
    const v = productM3Map.get(row.productCode);
    if (v && v > 0) return v;
  }
  return row.itemM3;
}

function rowToItem(
  row: DeliveryOrderItemRow,
  productM3Map?: Map<string, number>,
) {
  return {
    id: row.id,
    productionOrderId: row.productionOrderId ?? "",
    poNo: row.poNo ?? "",
    productCode: row.productCode ?? "",
    productName: row.productName ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricCode: row.fabricCode ?? "",
    quantity: row.quantity,
    itemM3: pickItemM3(row, productM3Map),
    rackingNumber: row.rackingNumber ?? "",
    packingStatus: row.packingStatus ?? "PENDING",
    salesOrderNo: row.salesOrderNo ?? "",
  };
}

// Loads { productCode → unitM3 } for the given codes. Used by every DO
// read path so legacy items (itemM3=0) get backfilled on the fly.
async function loadProductM3Map(
  db: D1Database,
  productCodes: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const codes = Array.from(
    new Set(productCodes.filter((c): c is string => !!c)),
  );
  if (codes.length === 0) return new Map();
  const ph = codes.map(() => "?").join(",");
  const res = await db
    .prepare(`SELECT code, unitM3 FROM products WHERE code IN (${ph})`)
    .bind(...codes)
    .all<{ code: string; unitM3: number }>();
  const map = new Map<string, number>();
  for (const r of res.results ?? []) {
    map.set(r.code, Number(r.unitM3) || 0);
  }
  return map;
}

function rowToOrder(
  row: DeliveryOrderRow,
  items: DeliveryOrderItemRow[] = [],
  productM3Map?: Map<string, number>,
) {
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
    driverContactPerson: row.driverContactPerson ?? "",
    vehicleNo: row.vehicleNo ?? "",
    items: items
      .filter((i) => i.deliveryOrderId === row.id)
      .map((it) => rowToItem(it, productM3Map)),
    // Recompute totalM3 on read using live product unitM3 — legacy DOs
    // were persisted with itemM3=0 / totalM3=0 before BUG-2026-04-27 fix.
    totalM3: productM3Map
      ? Math.round(
          items
            .filter((i) => i.deliveryOrderId === row.id)
            .reduce((s, it) => s + pickItemM3(it, productM3Map) * it.quantity, 0) *
            100,
        ) / 100
      : row.totalM3,
    totalItems: row.totalItems,
    status: row.status,
    overdue: row.overdue ?? "PENDING",
    dispatchedAt: row.dispatchedAt,
    deliveredAt: row.deliveredAt,
    remarks: row.remarks ?? "",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
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

// Async sequential DO number — DO-YYMM-NNN, NNN = max-existing-suffix-in-YYMM + 1.
// Was random `DO-YYMM-XXXX` hash before 2026-04-27 (user request: numbering
// rule in Settings says DO-YYMM-NNN sequential). Mirrors the SO generator
// in src/api/routes-d1/sales-orders.ts generateCompanySOId.
async function genNextDoNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `DO-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT doNo FROM delivery_orders WHERE doNo LIKE ? ORDER BY doNo DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ doNo: string }>();
  if (!res) return `${prefix}001`;
  const seq = parseInt(res.doNo.replace(prefix, ""), 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
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
  const items = itemsRes.results ?? [];
  const m3Map = await loadProductM3Map(db, items.map((i) => i.productCode));
  return rowToOrder(order, items, m3Map);
}

// GET /api/delivery-orders — list all, nested items
//
// Opt-in pagination via ?page=N&limit=M. When either is supplied, SQL
// LIMIT/OFFSET is applied and delivery_order_items is scoped to the
// page's DO IDs. Default limit=50, cap=500. Omitting both params returns
// the full list (backward compatible).
//
// ?includeArchive=true — phase-5 historical toggle. delivery_orders has
// no archive table (phase 5 only archives production + sales), so this
// flag is currently a no-op here — accepted for API symmetry with the
// other three list endpoints but never changes the result set. Left as
// a param so callers can pass the same query string uniformly.
app.get("/", async (c) => {
  // RBAC gate — listing DOs requires delivery-orders:read.
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;

  const db = c.var.DB;
  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;

  if (!paginate) {
    const [orders, items] = await Promise.all([
      db
        .prepare("SELECT * FROM delivery_orders ORDER BY created_at DESC")
        .all<DeliveryOrderRow>(),
      db
        .prepare("SELECT * FROM delivery_order_items")
        .all<DeliveryOrderItemRow>(),
    ]);
    const itemRows = items.results ?? [];
    const m3Map = await loadProductM3Map(db, itemRows.map((i) => i.productCode));
    const data = (orders.results ?? []).map((o) =>
      rowToOrder(o, itemRows, m3Map),
    );
    return c.json({ success: true, data, total: data.length });
  }

  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const offset = (page - 1) * limit;

  const [countRes, pageRes] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM delivery_orders").first<{ n: number }>(),
    db
      .prepare(
        "SELECT * FROM delivery_orders ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
      .bind(limit, offset)
      .all<DeliveryOrderRow>(),
  ]);
  const total = countRes?.n ?? 0;
  const orderRows = pageRes.results ?? [];

  let items: DeliveryOrderItemRow[] = [];
  if (orderRows.length > 0) {
    const ids = orderRows.map((o) => o.id);
    const placeholders = ids.map(() => "?").join(",");
    const itemsRes = await db
      .prepare(
        `SELECT * FROM delivery_order_items WHERE deliveryOrderId IN (${placeholders})`,
      )
      .bind(...ids)
      .all<DeliveryOrderItemRow>();
    items = itemsRes.results ?? [];
  }
  const m3Map = await loadProductM3Map(db, items.map((i) => i.productCode));
  const data = orderRows.map((o) => rowToOrder(o, items, m3Map));
  return c.json({ success: true, data, page, limit, total });
});

// ---------------------------------------------------------------------------
// GET /api/delivery-orders/stats — whole-dataset status bucket counts.
//
// Returns { byStatus: Record<string, number>, total }. Used by the delivery
// list page summary cards + tab badges so counts reflect the full table
// rather than only the current paginated page. Registered BEFORE /:id
// (Hono route ordering: static routes before wildcards).
// ---------------------------------------------------------------------------
app.get("/stats", async (c) => {
  // RBAC gate — stats are aggregate reads of the same data, gated identically.
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;

  const res = await c.var.DB
    .prepare("SELECT status, COUNT(*) AS n FROM delivery_orders GROUP BY status")
    .all<{ status: string; n: number }>();
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of res.results ?? []) {
    byStatus[row.status] = row.n;
    total += row.n;
  }
  return c.json({ success: true, byStatus, total });
});

// POST /api/delivery-orders — create
app.post("/", async (c) => {
  // RBAC gate — only roles with delivery-orders:create may insert a new DO.
  const denied = await requirePermission(c, "delivery-orders", "create");
  if (denied) return denied;

  try {
    const body = await c.req.json();

    // Resolve salesOrderId + seed items from productionOrderIds when the
    // caller came from Pending Delivery (bulk Create DO). All POs must belong
    // to the same SO — otherwise we reject so the user can split the DO.
    type PoRow = {
      id: string;
      poNo: string | null;
      salesOrderId: string | null;
      companySOId: string | null;
      productCode: string | null;
      productName: string | null;
      sizeLabel: string | null;
      fabricCode: string | null;
      quantity: number | null;
      rackingNumber: string | null;
      customerName: string | null;
      customerState: string | null;
    };
    const productionOrderIds: string[] = Array.isArray(body.productionOrderIds)
      ? (body.productionOrderIds as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : [];
    let poRowsForItems: PoRow[] = [];
    let resolvedSalesOrderId: string | undefined = body.salesOrderId ?? undefined;
    if (productionOrderIds.length > 0) {
      const placeholders = productionOrderIds.map(() => "?").join(",");
      const poRes = await c.var.DB.prepare(
        `SELECT id, poNo, salesOrderId, companySOId, productCode, productName,
                sizeLabel, fabricCode, quantity, rackingNumber,
                customerName, customerState
           FROM production_orders WHERE id IN (${placeholders})`,
      )
        .bind(...productionOrderIds)
        .all<PoRow>();
      poRowsForItems = poRes.results ?? [];
      if (poRowsForItems.length === 0) {
        return c.json(
          { success: false, error: "No matching production orders" },
          400,
        );
      }
      // No customer/state/SO restriction (2026-04-27 user request) —
      // operators can mix any POs onto one DO regardless of destination.
      // The page UI groups by customer for readability but doesn't enforce
      // grouping; that's the operator's call (one DO might genuinely cover
      // multiple drops on a single truck trip).
      const soIds = new Set(poRowsForItems.map((r) => r.salesOrderId ?? ""));
      soIds.delete("");
      // Pick a representative salesOrderId for the legacy single-SO
      // cascade fields (sales_orders.hookkaDeliveryOrder etc.). When the
      // DO genuinely spans multiple SOs, leave salesOrderId NULL — the
      // DELIVERED cascade walks fg_units → poId to find every SO and
      // updates each (added below).
      if (!resolvedSalesOrderId && soIds.size === 1) {
        resolvedSalesOrderId = [...soIds][0];
      }
    }

    const salesOrderId: string | undefined = resolvedSalesOrderId;

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
      salesOrderRow = await c.var.DB.prepare(
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

    // customerId fallback chain (relaxed 2026-04-27 for multi-SO DOs):
    //   1. body.customerId (explicit)
    //   2. salesOrderRow.customerId (single-SO path)
    //   3. lookup by name from the first PO row's customerName when the
    //      DO spans multiple SOs (so multi-customer DOs still have a
    //      representative customer for legacy contact / cascade fields).
    let customerId: string | undefined =
      body.customerId ?? salesOrderRow?.customerId;
    if (!customerId && poRowsForItems.length > 0) {
      const firstName = poRowsForItems[0].customerName;
      if (firstName) {
        const cr = await c.var.DB.prepare(
          `SELECT id FROM customers WHERE name = ? LIMIT 1`,
        )
          .bind(firstName)
          .first<{ id: string }>();
        if (cr?.id) customerId = cr.id;
      }
    }
    if (!customerId) {
      return c.json(
        { success: false, error: "customerId or salesOrderId is required" },
        400,
      );
    }
    const customerRow = await c.var.DB.prepare(
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
      defaultHub = await c.var.DB.prepare(
        "SELECT id, shortName, address FROM delivery_hubs WHERE id = ?",
      )
        .bind(hubTarget)
        .first();
    } else {
      defaultHub = await c.var.DB.prepare(
        "SELECT id, shortName, address FROM delivery_hubs WHERE customerId = ? ORDER BY isDefault DESC LIMIT 1",
      )
        .bind(customerId)
        .first();
    }

    const itemsInput: Array<Record<string, unknown>> = Array.isArray(body.items)
      ? body.items
      : [];
    const itemsFromInput = itemsInput.map((item) => ({
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
    // Look up unitM3 from the products table for every PO's productCode
    // so DO line items have accurate volumes — was hardcoded 0 before
    // (BUG-2026-04-27: DO detail showed Total M³ = 0.00 even when the
    // upstream Pending Delivery grid reported real per-PO Unit M³).
    const productM3Map = new Map<string, number>();
    if (poRowsForItems.length > 0) {
      const codes = Array.from(
        new Set(
          poRowsForItems
            .map((p) => p.productCode)
            .filter((c): c is string => !!c),
        ),
      );
      if (codes.length > 0) {
        const ph = codes.map(() => "?").join(",");
        const m3Res = await c.var.DB.prepare(
          `SELECT code, unitM3 FROM products WHERE code IN (${ph})`,
        )
          .bind(...codes)
          .all<{ code: string; unitM3: number }>();
        for (const r of m3Res.results ?? []) {
          productM3Map.set(r.code, Number(r.unitM3) || 0);
        }
      }
    }
    // Fallback: if caller didn't pass items but gave productionOrderIds, seed
    // line items from the POs we already loaded.
    const items =
      itemsFromInput.length > 0
        ? itemsFromInput
        : poRowsForItems.map((po) => ({
            id: genDoItemId(),
            productionOrderId: po.id,
            salesOrderNo: po.companySOId ?? "",
            poNo: po.poNo ?? "",
            productCode: po.productCode ?? "",
            productName: po.productName ?? "",
            sizeLabel: po.sizeLabel ?? "",
            fabricCode: po.fabricCode ?? "",
            quantity: Number(po.quantity) || 0,
            itemM3: productM3Map.get(po.productCode ?? "") ?? 0,
            rackingNumber: po.rackingNumber ?? "",
            packingStatus: "PENDING" as const,
          }));

    const totalM3 =
      Math.round(items.reduce((s, i) => s + i.itemM3 * i.quantity, 0) * 100) /
      100;
    const totalItems = items.reduce((s, i) => s + i.quantity, 0);
    const now = new Date().toISOString();
    const id = genDoId();
    const doNo: string = body.doNo || (await genNextDoNo(c.var.DB));

    // Provider lookup: when the client passes only driverId, denormalize
    // name + vehicleNo + contactPerson onto the DO row. Mirrors the PUT
    // handler so create/edit behave the same — front-end no longer has to
    // ship redundant fields, and old DOs keep their historical 3PL contact
    // even if the provider record is later deleted / renamed.
    let resolvedDriverName = (body.driverName as string | undefined) ?? "";
    let resolvedVehicleNo = (body.vehicleNo as string | undefined) ?? "";
    let resolvedDriverContact =
      (body.driverContactPerson as string | undefined) ?? "";
    if (body.driverId) {
      const provider = await c.var.DB.prepare(
        "SELECT name, vehicleNo, contactPerson FROM three_pl_providers WHERE id = ?",
      )
        .bind(body.driverId)
        .first<{
          name: string;
          vehicleNo: string | null;
          contactPerson: string | null;
        }>();
      if (provider) {
        resolvedDriverName = provider.name;
        if (provider.vehicleNo) resolvedVehicleNo = provider.vehicleNo;
        resolvedDriverContact = provider.contactPerson ?? "";
      }
    }

    const statements = [
      c.var.DB.prepare(
        `INSERT INTO delivery_orders (
           id, doNo, salesOrderId, companySO, companySOId, customerId,
           customerPOId, customerName, customerState, hubId, hubName,
           deliveryAddress, contactPerson, contactPhone, deliveryDate,
           hookkaExpectedDD, driverId, driverName, driverContactPerson,
           vehicleNo, totalM3,
           totalItems, status, overdue, dispatchedAt, deliveredAt, remarks,
           dropPoints, deliveryCostSen, lorryId, lorryName, doQrCode,
           fgUnitIds, signedAt, signedByWorkerId, signedByWorkerName,
           proofOfDelivery, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        resolvedDriverName,
        resolvedDriverContact,
        resolvedVehicleNo,
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
        c.var.DB.prepare(
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
        c.var.DB.prepare(
          "UPDATE sales_orders SET hookkaDeliveryOrder = ?, updated_at = ? WHERE id = ?",
        ).bind(doNo, now, salesOrderRow.id),
      );
    }

    // Phase-4 (revised 2026-04-27): DRAFT DOs no longer lock fg_units —
    // they show up under "Reserved" on the Inventory page (still our
    // stock, just earmarked). The actual STOCK_OUT + fg_units LOADED
    // stamping moves to the DRAFT → LOADED transition in PUT below, so
    // the inventory deduction tracks the dispatch boundary (which is
    // also the invoice boundary). See the PUT handler "Phase-4 stamp on
    // dispatch" block.

    await c.var.DB.batch(statements);

    const created = await fetchOrderWithItems(c.var.DB, id);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create delivery order" },
        500,
      );
    }

    // Audit emit (P3.4) — DO create. Mirrors the sales-orders pattern.
    await emitAudit(c, {
      resource: "delivery-orders",
      resourceId: id,
      action: "create",
      after: { status: "DRAFT", doNo, salesOrderId: salesOrderRow?.id ?? null },
    });

    return c.json({ success: true, data: created }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/delivery-orders/:id — single
app.get("/:id", async (c) => {
  // RBAC gate — single-record reads also require delivery-orders:read.
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;

  const order = await fetchOrderWithItems(c.var.DB, c.req.param("id"));
  if (!order) {
    return c.json({ success: false, error: "Delivery order not found" }, 404);
  }
  return c.json({ success: true, data: order });
});

// PUT /api/delivery-orders/:id — update (supports status transitions, PoD,
// driver/lorry changes, and full item replacement).
app.put("/:id", async (c) => {
  // RBAC gate — every mutation path on the DO row goes through PUT, including
  // status transitions (load / dispatch / deliver / invoice), driver swaps,
  // and POD writes. Single delivery-orders:update gate covers all of them.
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
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
        // FIFO FG_DELIVERED COGS is emitted inside the cascadedToDelivered
        // block below so it rides the same atomic batch as the UPDATE.
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
      driverContactPerson:
        body.driverContactPerson === undefined
          ? existing.driverContactPerson
          : body.driverContactPerson,
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
      const lorry = await c.var.DB.prepare(
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

    // --- driver → 3PL lookup: auto-fill vehicle + contact + recompute cost ---
    if (body.driverId !== undefined && body.driverId) {
      const provider = await c.var.DB.prepare(
        "SELECT id, name, vehicleNo, contactPerson, ratePerTripSen, ratePerExtraDropSen FROM three_pl_providers WHERE id = ?",
      )
        .bind(body.driverId)
        .first<{
          id: string;
          name: string;
          vehicleNo: string | null;
          contactPerson: string | null;
          ratePerTripSen: number;
          ratePerExtraDropSen: number;
        }>();
      if (provider) {
        merged.driverName = provider.name;
        if (provider.vehicleNo) merged.vehicleNo = provider.vehicleNo;
        merged.driverContactPerson = provider.contactPerson ?? "";
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
      c.var.DB.prepare(
        `UPDATE delivery_orders SET
           deliveryDate = ?, driverId = ?, driverName = ?,
           driverContactPerson = ?, vehicleNo = ?,
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
        merged.driverContactPerson,
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
        c.var.DB.prepare(
          "DELETE FROM delivery_order_items WHERE deliveryOrderId = ?",
        ).bind(id),
      );
      for (const item of newItems) {
        statements.push(
          c.var.DB.prepare(
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
    // Phase-4 stamp on dispatch (DRAFT → LOADED, added 2026-04-27):
    // This is the inventory boundary — until now the PO is "Reserved"
    // (still our stock, no invoice yet); flipping to LOADED is the
    // moment we mark fg_units LOADED and write a STOCK_OUT so the
    // Inventory page's Available count drops. Mirrors the old POST-time
    // logic, just deferred to the dispatch event.
    // -------------------------------------------------------------------
    const stampedOnDispatch =
      existing.status === "DRAFT" && nextStatus === "LOADED";
    if (stampedOnDispatch) {
      // Source POs come from the items array — either freshly-replaced
      // (newItems) or the existing delivery_order_items rows.
      const itemPoIds = newItems
        ? newItems.map((i) => i.productionOrderId).filter(Boolean)
        : (
            await c.var.DB.prepare(
              `SELECT productionOrderId FROM delivery_order_items
                 WHERE deliveryOrderId = ?`,
            )
              .bind(id)
              .all<{ productionOrderId: string | null }>()
          ).results?.map((r) => r.productionOrderId).filter(
            (s): s is string => !!s,
          ) ?? [];
      if (itemPoIds.length > 0) {
        const ph = itemPoIds.map(() => "?").join(",");
        const poRows =
          (
            await c.var.DB.prepare(
              `SELECT id, productCode, productName, quantity, rackingNumber
                 FROM production_orders WHERE id IN (${ph})`,
            )
              .bind(...itemPoIds)
              .all<{
                id: string;
                productCode: string | null;
                productName: string | null;
                quantity: number | null;
                rackingNumber: string | null;
              }>()
          ).results ?? [];
        for (const po of poRows) {
          statements.push(
            c.var.DB.prepare(
              `UPDATE fg_units
                  SET doId = ?, status = 'LOADED', loadedAt = ?
                WHERE poId = ? AND (doId IS NULL OR doId = '')`,
            ).bind(id, now, po.id),
            c.var.DB.prepare(
              `INSERT INTO stock_movements (
                 id, type, rackLocationId, rackLabel, productionOrderId,
                 productCode, productName, quantity, reason, performedBy,
                 created_at
               ) VALUES (?, 'STOCK_OUT', ?, ?, ?, ?, ?, ?, ?, 'System', ?)`,
            ).bind(
              `mov-${crypto.randomUUID().slice(0, 8)}`,
              null,
              po.rackingNumber ?? "",
              po.id,
              po.productCode ?? "",
              po.productName ?? "",
              Number(po.quantity) || 0,
              `DO ${existing.doNo} dispatched`,
              now,
            ),
          );
        }
      }
    }

    // -------------------------------------------------------------------
    // Reversal on LOADED → DRAFT transition (phase-4 finish, 2026-04-26):
    // unstamp fg_units that were marked LOADED + tied to this DO when the
    // operator reopens the DO for editing. Without this, units stay
    // wedged in 'LOADED' state with an obsolete doId pointer and the
    // warehouse view double-counts them. Audit rows in stock_movements
    // are intentionally NOT deleted — those are immutable history; we
    // append a STOCK_IN counter-movement instead so the racking ledger
    // shows the round-trip.
    // -------------------------------------------------------------------
    const revertedToDraft =
      existing.status === "LOADED" && nextStatus === "DRAFT";
    if (revertedToDraft) {
      const stampedPosRes = await c.var.DB.prepare(
        `SELECT DISTINCT poId FROM fg_units WHERE doId = ?`,
      )
        .bind(id)
        .all<{ poId: string }>();
      const stampedPoIds = (stampedPosRes.results ?? [])
        .map((r) => r.poId)
        .filter(Boolean);
      statements.push(
        c.var.DB.prepare(
          `UPDATE fg_units
              SET doId = NULL, status = 'PENDING', loadedAt = NULL
            WHERE doId = ?`,
        ).bind(id),
      );
      for (const poId of stampedPoIds) {
        const po = await c.var.DB.prepare(
          `SELECT id, productCode, productName, quantity, rackingNumber
             FROM production_orders WHERE id = ?`,
        )
          .bind(poId)
          .first<{
            id: string;
            productCode: string | null;
            productName: string | null;
            quantity: number | null;
            rackingNumber: string | null;
          }>();
        if (!po) continue;
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO stock_movements (
               id, type, rackLocationId, rackLabel, productionOrderId,
               productCode, productName, quantity, reason, performedBy,
               created_at
             ) VALUES (?, 'STOCK_IN', ?, ?, ?, ?, ?, ?, ?, 'System', ?)`,
          ).bind(
            `mov-${crypto.randomUUID().slice(0, 8)}`,
            null,
            po.rackingNumber ?? "",
            po.id,
            po.productCode ?? "",
            po.productName ?? "",
            Number(po.quantity) || 0,
            `DO ${existing.doNo} reverted to DRAFT`,
            now,
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
        c.var.DB.prepare(
          `UPDATE fg_units SET status = 'DELIVERED', deliveredAt = ? WHERE doId = ?`,
        ).bind(nextDeliveredAt ?? now, id),
      );

      // FIFO FG_DELIVERED COGS — consume fg_batches across layers and emit
      // one cost_ledger entry per slice. Idempotent inside the helper. Uses
      // the in-memory newItems if the caller replaced items, otherwise the
      // current DB rows.
      const itemsForCogs = newItems
        ? newItems.map((i) => ({
            id: i.id,
            productCode: i.productCode,
            productName: i.productName,
            quantity: i.quantity,
          }))
        : (
            await c.var.DB.prepare(
              `SELECT id, productCode, productName, quantity
                 FROM delivery_order_items WHERE deliveryOrderId = ?`,
            )
              .bind(id)
              .all<{
                id: string;
                productCode: string | null;
                productName: string | null;
                quantity: number;
              }>()
          ).results ?? [];
      const cogs = await consumeFGBatchesForDO(
        c.var.DB,
        id,
        existing.doNo,
        itemsForCogs,
        nextDeliveredAt ?? now,
      );
      if (!cogs.skipped && cogs.statements.length > 0) {
        statements.push(...cogs.statements);
      }

      // SO status cascade — only if this DO is linked to a SO.
      if (existing.salesOrderId) {
        const soRow = await c.var.DB.prepare(
          "SELECT id, status, totalSen FROM sales_orders WHERE id = ?",
        )
          .bind(existing.salesOrderId)
          .first<{ id: string; status: string; totalSen: number }>();

        if (soRow && soRow.status !== "DELIVERED") {
          statements.push(
            c.var.DB.prepare(
              "UPDATE sales_orders SET status = 'DELIVERED', updated_at = ? WHERE id = ?",
            ).bind(now, soRow.id),
            c.var.DB.prepare(
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
        const existingInvoice = await c.var.DB.prepare(
          "SELECT id FROM invoices WHERE deliveryOrderId = ? LIMIT 1",
        )
          .bind(id)
          .first<{ id: string }>();

        if (!existingInvoice) {
          // Build invoice line items from DO items joined with SO unit prices
          // (same pattern used by the invoices POST route). Fall back to the
          // SO items themselves if the DO has no lines.
          const [doItemsRes, soItemsRes] = await Promise.all([
            c.var.DB.prepare(
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
            c.var.DB.prepare(
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
            c.var.DB.prepare(
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
              c.var.DB.prepare(
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

    await c.var.DB.batch(statements);

    const updated = await fetchOrderWithItems(c.var.DB, id);

    // Audit emit (P3.4) — status transitions on a DO are forensic events
    // (e.g. "who marked DO-XXX delivered"). The SO cascade already writes
    // so_status_changes for the upstream SO; this gives the DO itself a
    // first-class trail. Snapshot before/after status only — full row
    // snapshots can balloon the audit table once POD blobs land.
    if (existing.status !== nextStatus) {
      await emitAudit(c, {
        resource: "delivery-orders",
        resourceId: id,
        action: "update",
        before: { status: existing.status },
        after: { status: nextStatus },
      });
    }

    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/delivery-orders/:id — only DRAFT rows are deletable.
app.delete("/:id", async (c) => {
  // RBAC gate — DO deletion is destructive, gated by delivery-orders:delete.
  const denied = await requirePermission(c, "delivery-orders", "delete");
  if (denied) return denied;

  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT id, status FROM delivery_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Delivery order not found" }, 404);
  }
  if (existing.status !== "DRAFT") {
    return c.json(
      {
        success: false,
        error: `Only DRAFT delivery orders can be deleted (current: ${existing.status})`,
      },
      400,
    );
  }
  await c.var.DB.batch([
    c.var.DB.prepare(
      "DELETE FROM delivery_order_items WHERE deliveryOrderId = ?",
    ).bind(id),
    c.var.DB.prepare("DELETE FROM delivery_orders WHERE id = ?").bind(id),
  ]);

  // Audit emit (P3.4) — DO deletion. before-snapshot captures the status so
  // we know what was destroyed.
  await emitAudit(c, {
    resource: "delivery-orders",
    resourceId: id,
    action: "delete",
    before: { status: existing.status },
  });

  return c.json({ success: true });
});

export default app;
