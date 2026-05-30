// ---------------------------------------------------------------------------
// Hookka AI assistant — read-only tool definitions + executors.
//
// Every tool the Anthropic model can call lives here. Strict invariants:
//
//   1. READ ONLY. No INSERT / UPDATE / DELETE — period. The assistant route
//      gates on SUPER_ADMIN already, but defense-in-depth: we never even
//      EXPOSE a write tool. If the model invents one (or a future tool
//      maintainer adds one), it 404s on the dispatcher.
//
//   2. EVERY list query is hard-capped to 100 rows regardless of the
//      caller-supplied `limit`. Payload size + Anthropic-context cost.
//
//   3. EVERY query is org-scoped via getOrgId(c). The assistant only ever
//      sees the active tenant's data — same boundary as the rest of the UI.
//
//   4. Tools return a plain object the route serialises to JSON for the
//      tool_result block. No streaming, no nested fetches, no side effects.
//
// Schema-notes mirror the rest of the routes: SupabaseAdapter rewrites
// camelCase SQL identifiers to snake_case on the way in; postgres.js
// returns camelCase keys on the way out (per transform.column.from).
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";
import type { AnthropicTool } from "./anthropic-client";
import { getOrgId } from "./tenant";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_LIMIT = 100;

function clampLimit(raw: unknown, fallback = 25): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

// YYYY-MM-DD only — anything else returns null (the SQL falls back to no-filter).
function ymdOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function senToRM(sen: number | null | undefined): string {
  const n = typeof sen === "number" ? sen : Number(sen ?? 0);
  return (n / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ---------------------------------------------------------------------------
// Tool type
// ---------------------------------------------------------------------------

export type ToolDefinition = {
  schema: AnthropicTool;
  execute: (
    c: Context<Env>,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------

const listSalesOrders: ToolDefinition = {
  schema: {
    name: "list_sales_orders",
    description:
      "List sales orders, most recent first. Filter by status, customer name (partial match), or date range (createdAt). Returns up to 100 rows.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description:
            "Status filter, e.g. DRAFT, CONFIRMED, IN_PRODUCTION, READY, DELIVERED, INVOICED, CANCELLED.",
        },
        customer: {
          type: "string",
          description: "Partial match on customer name (case-insensitive).",
        },
        dateFrom: {
          type: "string",
          description: "Inclusive lower bound on createdAt (YYYY-MM-DD).",
        },
        dateTo: {
          type: "string",
          description: "Inclusive upper bound on createdAt (YYYY-MM-DD).",
        },
        limit: {
          type: "number",
          description: "Max rows (1-100, default 25).",
        },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];

    const status = strOrNull(args.status);
    if (status) {
      wheres.push("UPPER(status) = ?");
      params.push(status.toUpperCase());
    }
    const customer = strOrNull(args.customer);
    if (customer) {
      wheres.push("LOWER(customerName) LIKE ?");
      params.push(`%${customer.toLowerCase()}%`);
    }
    const dateFrom = ymdOrNull(args.dateFrom);
    if (dateFrom) {
      wheres.push("created_at >= ?");
      params.push(dateFrom);
    }
    const dateTo = ymdOrNull(args.dateTo);
    if (dateTo) {
      wheres.push("created_at <= ?");
      params.push(`${dateTo} 23:59:59`);
    }

    const limit = clampLimit(args.limit, 25);
    const sql = `SELECT id, companySOId, customerName, status, totalSen, customerDeliveryDate, created_at AS createdAt
                 FROM sales_orders
                 WHERE ${wheres.join(" AND ")}
                 ORDER BY created_at DESC
                 LIMIT ${limit}`;
    const rows = await c.var.DB
      .prepare(sql)
      .bind(...params)
      .all<{
        id: string;
        companySOId: string | null;
        customerName: string | null;
        status: string | null;
        totalSen: number | null;
        customerDeliveryDate: string | null;
        createdAt: string | null;
      }>();

    const data = (rows.results ?? []).map((r) => ({
      id: r.id,
      companySOId: r.companySOId ?? "",
      customerName: r.customerName ?? "",
      status: r.status ?? "",
      totalRM: senToRM(r.totalSen),
      customerDeliveryDate: r.customerDeliveryDate ?? "",
      createdAt: r.createdAt ?? "",
    }));
    return { count: data.length, results: data };
  },
};

const getSalesOrder: ToolDefinition = {
  schema: {
    name: "get_sales_order",
    description:
      "Get full detail of a single sales order including line items, related delivery orders, invoices, and payments. Look up by SO id (e.g. 'so-xxxxxxxx') or by companySOId (e.g. 'SO-2605-253').",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Either the internal SO id or the companySOId code.",
        },
      },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { error: "id is required" };

    const so = await c.var.DB
      .prepare(
        `SELECT id, companySOId, customerName, customerId, status, totalSen,
                subtotalSen, customerDeliveryDate, hookkaExpectedDD, customerPO,
                created_at AS createdAt
         FROM sales_orders
         WHERE orgId = ? AND (id = ? OR companySOId = ?)
         LIMIT 1`,
      )
      .bind(orgId, lookup, lookup)
      .first<{
        id: string;
        companySOId: string | null;
        customerName: string | null;
        customerId: string | null;
        status: string | null;
        totalSen: number | null;
        subtotalSen: number | null;
        customerDeliveryDate: string | null;
        hookkaExpectedDD: string | null;
        customerPO: string | null;
        createdAt: string | null;
      }>();
    if (!so) return { error: `Sales order not found: ${lookup}` };

    const [items, dos, invs] = await Promise.all([
      c.var.DB
        .prepare(
          `SELECT productCode, description, quantity, unitPriceSen, totalSen
           FROM sales_order_items
           WHERE salesOrderId = ?
           ORDER BY id
           LIMIT 100`,
        )
        .bind(so.id)
        .all<{
          productCode: string | null;
          description: string | null;
          quantity: number | null;
          unitPriceSen: number | null;
          totalSen: number | null;
        }>(),
      c.var.DB
        .prepare(
          `SELECT id, doNo, status, deliveryDate
           FROM delivery_orders
           WHERE salesOrderId = ?
           ORDER BY created_at DESC
           LIMIT 25`,
        )
        .bind(so.id)
        .all<{
          id: string;
          doNo: string | null;
          status: string | null;
          deliveryDate: string | null;
        }>(),
      c.var.DB
        .prepare(
          `SELECT id, invoiceNumber, status, totalSen, paidAmount, invoiceDate
           FROM invoices
           WHERE salesOrderId = ?
           ORDER BY invoiceDate DESC
           LIMIT 25`,
        )
        .bind(so.id)
        .all<{
          id: string;
          invoiceNumber: string | null;
          status: string | null;
          totalSen: number | null;
          paidAmount: number | null;
          invoiceDate: string | null;
        }>(),
    ]);

    return {
      id: so.id,
      companySOId: so.companySOId ?? "",
      customerName: so.customerName ?? "",
      customerId: so.customerId ?? "",
      status: so.status ?? "",
      totalRM: senToRM(so.totalSen),
      subtotalRM: senToRM(so.subtotalSen),
      customerPO: so.customerPO ?? "",
      customerDeliveryDate: so.customerDeliveryDate ?? "",
      hookkaExpectedDD: so.hookkaExpectedDD ?? "",
      createdAt: so.createdAt ?? "",
      items: (items.results ?? []).map((r) => ({
        productCode: r.productCode ?? "",
        description: r.description ?? "",
        quantity: r.quantity ?? 0,
        unitPriceRM: senToRM(r.unitPriceSen),
        totalRM: senToRM(r.totalSen),
      })),
      deliveryOrders: (dos.results ?? []).map((r) => ({
        id: r.id,
        doNo: r.doNo ?? "",
        status: r.status ?? "",
        deliveryDate: r.deliveryDate ?? "",
      })),
      invoices: (invs.results ?? []).map((r) => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber ?? "",
        status: r.status ?? "",
        totalRM: senToRM(r.totalSen),
        paidRM: senToRM(r.paidAmount),
        invoiceDate: r.invoiceDate ?? "",
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Consignment orders (the "CO" / customer-orders the spec referred to)
// ---------------------------------------------------------------------------

const listConsignmentOrders: ToolDefinition = {
  schema: {
    name: "list_consignment_orders",
    description:
      "List consignment orders (CO — stock placed on loan with a customer), most recent first. Filter by status or customer.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Status filter, e.g. DRAFT, ACTIVE, RETURNED, CLOSED." },
        customer: { type: "string", description: "Partial match on customer name." },
        limit: { type: "number", description: "Max rows (1-100, default 25)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];

    const status = strOrNull(args.status);
    if (status) {
      wheres.push("UPPER(status) = ?");
      params.push(status.toUpperCase());
    }
    const customer = strOrNull(args.customer);
    if (customer) {
      wheres.push("LOWER(customerName) LIKE ?");
      params.push(`%${customer.toLowerCase()}%`);
    }

    const limit = clampLimit(args.limit, 25);
    const sql = `SELECT id, companyCOId, customerName, status, totalSen, created_at AS createdAt
                 FROM consignment_orders
                 WHERE ${wheres.join(" AND ")}
                 ORDER BY created_at DESC
                 LIMIT ${limit}`;
    const rows = await c.var.DB
      .prepare(sql)
      .bind(...params)
      .all<{
        id: string;
        companyCOId: string | null;
        customerName: string | null;
        status: string | null;
        totalSen: number | null;
        createdAt: string | null;
      }>();
    const data = (rows.results ?? []).map((r) => ({
      id: r.id,
      companyCOId: r.companyCOId ?? "",
      customerName: r.customerName ?? "",
      status: r.status ?? "",
      totalRM: senToRM(r.totalSen),
      createdAt: r.createdAt ?? "",
    }));
    return { count: data.length, results: data };
  },
};

const getConsignmentOrder: ToolDefinition = {
  schema: {
    name: "get_consignment_order",
    description:
      "Get full detail of a single consignment order including line items. Look up by id or companyCOId.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Internal CO id or companyCOId." },
      },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { error: "id is required" };

    const co = await c.var.DB
      .prepare(
        `SELECT id, companyCOId, customerName, customerId, status, totalSen,
                created_at AS createdAt
         FROM consignment_orders
         WHERE orgId = ? AND (id = ? OR companyCOId = ?)
         LIMIT 1`,
      )
      .bind(orgId, lookup, lookup)
      .first<{
        id: string;
        companyCOId: string | null;
        customerName: string | null;
        customerId: string | null;
        status: string | null;
        totalSen: number | null;
        createdAt: string | null;
      }>();
    if (!co) return { error: `Consignment order not found: ${lookup}` };

    const items = await c.var.DB
      .prepare(
        `SELECT productCode, description, quantity, unitPriceSen, totalSen
         FROM consignment_order_items
         WHERE consignmentOrderId = ?
         ORDER BY id
         LIMIT 100`,
      )
      .bind(co.id)
      .all<{
        productCode: string | null;
        description: string | null;
        quantity: number | null;
        unitPriceSen: number | null;
        totalSen: number | null;
      }>();

    return {
      id: co.id,
      companyCOId: co.companyCOId ?? "",
      customerName: co.customerName ?? "",
      customerId: co.customerId ?? "",
      status: co.status ?? "",
      totalRM: senToRM(co.totalSen),
      createdAt: co.createdAt ?? "",
      items: (items.results ?? []).map((r) => ({
        productCode: r.productCode ?? "",
        description: r.description ?? "",
        quantity: r.quantity ?? 0,
        unitPriceRM: senToRM(r.unitPriceSen),
        totalRM: senToRM(r.totalSen),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Delivery orders
// ---------------------------------------------------------------------------

const listDeliveryOrders: ToolDefinition = {
  schema: {
    name: "list_delivery_orders",
    description: "List delivery orders, most recent first. Filter by status or date range.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Status filter, e.g. DRAFT, LOADED, IN_TRANSIT, DELIVERED, INVOICED." },
        dateFrom: { type: "string", description: "Inclusive lower bound on deliveryDate (YYYY-MM-DD)." },
        dateTo: { type: "string", description: "Inclusive upper bound on deliveryDate (YYYY-MM-DD)." },
        limit: { type: "number", description: "Max rows (1-100, default 25)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];

    const status = strOrNull(args.status);
    if (status) {
      wheres.push("UPPER(status) = ?");
      params.push(status.toUpperCase());
    }
    const dateFrom = ymdOrNull(args.dateFrom);
    if (dateFrom) {
      wheres.push("deliveryDate >= ?");
      params.push(dateFrom);
    }
    const dateTo = ymdOrNull(args.dateTo);
    if (dateTo) {
      wheres.push("deliveryDate <= ?");
      params.push(dateTo);
    }

    const limit = clampLimit(args.limit, 25);
    const sql = `SELECT id, doNo, customerName, status, deliveryDate, created_at AS createdAt
                 FROM delivery_orders
                 WHERE ${wheres.join(" AND ")}
                 ORDER BY created_at DESC
                 LIMIT ${limit}`;
    const rows = await c.var.DB
      .prepare(sql)
      .bind(...params)
      .all<{
        id: string;
        doNo: string | null;
        customerName: string | null;
        status: string | null;
        deliveryDate: string | null;
        createdAt: string | null;
      }>();
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id,
        doNo: r.doNo ?? "",
        customerName: r.customerName ?? "",
        status: r.status ?? "",
        deliveryDate: r.deliveryDate ?? "",
        createdAt: r.createdAt ?? "",
      })),
    };
  },
};

const getDeliveryOrder: ToolDefinition = {
  schema: {
    name: "get_delivery_order",
    description: "Get full detail of a single delivery order. Look up by id or doNo (e.g. 'DO-2605-12').",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Internal id or doNo." },
      },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { error: "id is required" };

    const row = await c.var.DB
      .prepare(
        `SELECT id, doNo, customerName, customerId, status, deliveryDate,
                deliveryAddress, salesOrderId, created_at AS createdAt
         FROM delivery_orders
         WHERE orgId = ? AND (id = ? OR doNo = ?)
         LIMIT 1`,
      )
      .bind(orgId, lookup, lookup)
      .first<{
        id: string;
        doNo: string | null;
        customerName: string | null;
        customerId: string | null;
        status: string | null;
        deliveryDate: string | null;
        deliveryAddress: string | null;
        salesOrderId: string | null;
        createdAt: string | null;
      }>();
    if (!row) return { error: `Delivery order not found: ${lookup}` };
    return {
      id: row.id,
      doNo: row.doNo ?? "",
      customerName: row.customerName ?? "",
      customerId: row.customerId ?? "",
      status: row.status ?? "",
      deliveryDate: row.deliveryDate ?? "",
      deliveryAddress: row.deliveryAddress ?? "",
      salesOrderId: row.salesOrderId ?? "",
      createdAt: row.createdAt ?? "",
    };
  },
};

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

const listInvoices: ToolDefinition = {
  schema: {
    name: "list_invoices",
    description: "List invoices, most recent first. Filter by status (DRAFT, ISSUED, PAID, OVERDUE, VOID) or customer.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Status filter." },
        customer: { type: "string", description: "Partial match on customer name." },
        limit: { type: "number", description: "Max rows (1-100, default 25)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];

    const status = strOrNull(args.status);
    if (status) {
      wheres.push("UPPER(status) = ?");
      params.push(status.toUpperCase());
    }
    const customer = strOrNull(args.customer);
    if (customer) {
      wheres.push("LOWER(customerName) LIKE ?");
      params.push(`%${customer.toLowerCase()}%`);
    }

    const limit = clampLimit(args.limit, 25);
    const sql = `SELECT id, invoiceNumber, customerName, status, totalSen,
                        COALESCE(paidAmount, 0) AS paidAmount, invoiceDate, dueDate
                 FROM invoices
                 WHERE ${wheres.join(" AND ")}
                 ORDER BY invoiceDate DESC
                 LIMIT ${limit}`;
    const rows = await c.var.DB
      .prepare(sql)
      .bind(...params)
      .all<{
        id: string;
        invoiceNumber: string | null;
        customerName: string | null;
        status: string | null;
        totalSen: number | null;
        paidAmount: number | null;
        invoiceDate: string | null;
        dueDate: string | null;
      }>();
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber ?? "",
        customerName: r.customerName ?? "",
        status: r.status ?? "",
        totalRM: senToRM(r.totalSen),
        paidRM: senToRM(r.paidAmount),
        invoiceDate: r.invoiceDate ?? "",
        dueDate: r.dueDate ?? "",
      })),
    };
  },
};

const getInvoice: ToolDefinition = {
  schema: {
    name: "get_invoice",
    description: "Get full detail of one invoice. Look up by id or invoiceNumber.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Internal id or invoiceNumber." },
      },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { error: "id is required" };

    const row = await c.var.DB
      .prepare(
        `SELECT id, invoiceNumber, customerName, customerId, status,
                totalSen, subtotalSen, COALESCE(paidAmount, 0) AS paidAmount,
                invoiceDate, dueDate, salesOrderId
         FROM invoices
         WHERE orgId = ? AND (id = ? OR invoiceNumber = ?)
         LIMIT 1`,
      )
      .bind(orgId, lookup, lookup)
      .first<{
        id: string;
        invoiceNumber: string | null;
        customerName: string | null;
        customerId: string | null;
        status: string | null;
        totalSen: number | null;
        subtotalSen: number | null;
        paidAmount: number | null;
        invoiceDate: string | null;
        dueDate: string | null;
        salesOrderId: string | null;
      }>();
    if (!row) return { error: `Invoice not found: ${lookup}` };
    return {
      id: row.id,
      invoiceNumber: row.invoiceNumber ?? "",
      customerName: row.customerName ?? "",
      customerId: row.customerId ?? "",
      status: row.status ?? "",
      totalRM: senToRM(row.totalSen),
      subtotalRM: senToRM(row.subtotalSen),
      paidRM: senToRM(row.paidAmount),
      outstandingRM: senToRM((row.totalSen ?? 0) - (row.paidAmount ?? 0)),
      invoiceDate: row.invoiceDate ?? "",
      dueDate: row.dueDate ?? "",
      salesOrderId: row.salesOrderId ?? "",
    };
  },
};

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const listPayments: ToolDefinition = {
  schema: {
    name: "list_payments",
    description: "List payment receipts, most recent first. Filter by customer or date range.",
    input_schema: {
      type: "object",
      properties: {
        customer: { type: "string", description: "Partial match on customer name." },
        dateFrom: { type: "string", description: "Inclusive lower bound on date (YYYY-MM-DD)." },
        dateTo: { type: "string", description: "Inclusive upper bound on date (YYYY-MM-DD)." },
        limit: { type: "number", description: "Max rows (1-100, default 25)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];

    const customer = strOrNull(args.customer);
    if (customer) {
      wheres.push("LOWER(customerName) LIKE ?");
      params.push(`%${customer.toLowerCase()}%`);
    }
    const dateFrom = ymdOrNull(args.dateFrom);
    if (dateFrom) {
      wheres.push("date >= ?");
      params.push(dateFrom);
    }
    const dateTo = ymdOrNull(args.dateTo);
    if (dateTo) {
      wheres.push("date <= ?");
      params.push(dateTo);
    }

    const limit = clampLimit(args.limit, 25);
    const sql = `SELECT id, receiptNumber, customerName, date, amount, method, status
                 FROM payment_records
                 WHERE ${wheres.join(" AND ")}
                 ORDER BY date DESC, id DESC
                 LIMIT ${limit}`;
    const rows = await c.var.DB
      .prepare(sql)
      .bind(...params)
      .all<{
        id: string;
        receiptNumber: string | null;
        customerName: string | null;
        date: string | null;
        amount: number | null;
        method: string | null;
        status: string | null;
      }>();
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id,
        receiptNumber: r.receiptNumber ?? "",
        customerName: r.customerName ?? "",
        date: r.date ?? "",
        amountRM: senToRM(r.amount),
        method: r.method ?? "",
        status: r.status ?? "",
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const listProducts: ToolDefinition = {
  schema: {
    name: "list_products",
    description: "List products in the catalog. Filter by category (e.g. SOFA, BEDFRAME) or partial code/name match.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Product category." },
        search: { type: "string", description: "Partial match on code or name." },
        limit: { type: "number", description: "Max rows (1-100, default 50)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];

    const category = strOrNull(args.category);
    if (category) {
      wheres.push("UPPER(category) = ?");
      params.push(category.toUpperCase());
    }
    const search = strOrNull(args.search);
    if (search) {
      wheres.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
      const like = `%${search.toLowerCase()}%`;
      params.push(like, like);
    }

    const limit = clampLimit(args.limit, 50);
    const sql = `SELECT id, code, name, category, sizeLabel, basePriceSen, status
                 FROM products
                 WHERE ${wheres.join(" AND ")}
                 ORDER BY code
                 LIMIT ${limit}`;
    const rows = await c.var.DB
      .prepare(sql)
      .bind(...params)
      .all<{
        id: string;
        code: string | null;
        name: string | null;
        category: string | null;
        sizeLabel: string | null;
        basePriceSen: number | null;
        status: string | null;
      }>();
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id,
        code: r.code ?? "",
        name: r.name ?? "",
        category: r.category ?? "",
        sizeLabel: r.sizeLabel ?? "",
        basePriceRM: senToRM(r.basePriceSen),
        status: r.status ?? "",
      })),
    };
  },
};

const getProduct: ToolDefinition = {
  schema: {
    name: "get_product",
    description: "Get full product detail including BOM components. Look up by code.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Product code, e.g. 'BO315-02'." },
      },
      required: ["code"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const code = strOrNull(args.code);
    if (!code) return { error: "code is required" };

    const p = await c.var.DB
      .prepare(
        `SELECT id, code, name, category, sizeLabel, description, basePriceSen,
                costPriceSen, fabricUsage, productionTimeMinutes, status
         FROM products
         WHERE orgId = ? AND code = ?
         LIMIT 1`,
      )
      .bind(orgId, code)
      .first<{
        id: string;
        code: string | null;
        name: string | null;
        category: string | null;
        sizeLabel: string | null;
        description: string | null;
        basePriceSen: number | null;
        costPriceSen: number | null;
        fabricUsage: number | null;
        productionTimeMinutes: number | null;
        status: string | null;
      }>();
    if (!p) return { error: `Product not found: ${code}` };

    const bom = await c.var.DB
      .prepare(
        `SELECT materialCode, materialName, quantity, unit
         FROM bom_components
         WHERE productId = ?
         ORDER BY id
         LIMIT 100`,
      )
      .bind(p.id)
      .all<{
        materialCode: string | null;
        materialName: string | null;
        quantity: number | null;
        unit: string | null;
      }>();

    return {
      id: p.id,
      code: p.code ?? "",
      name: p.name ?? "",
      category: p.category ?? "",
      sizeLabel: p.sizeLabel ?? "",
      description: p.description ?? "",
      basePriceRM: senToRM(p.basePriceSen),
      costPriceRM: senToRM(p.costPriceSen),
      fabricUsage: p.fabricUsage ?? 0,
      productionTimeMinutes: p.productionTimeMinutes ?? 0,
      status: p.status ?? "",
      bom: (bom.results ?? []).map((r) => ({
        materialCode: r.materialCode ?? "",
        materialName: r.materialName ?? "",
        quantity: r.quantity ?? 0,
        unit: r.unit ?? "",
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const listCustomers: ToolDefinition = {
  schema: {
    name: "list_customers",
    description: "List customers. Filter by partial name/code search.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Partial match on code or name." },
        limit: { type: "number", description: "Max rows (1-100, default 50)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];

    const search = strOrNull(args.search);
    if (search) {
      wheres.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
      const like = `%${search.toLowerCase()}%`;
      params.push(like, like);
    }

    const limit = clampLimit(args.limit, 50);
    const sql = `SELECT id, code, name, creditTerms, creditLimitSen,
                        COALESCE(outstandingSen, 0) AS outstandingSen, isActive
                 FROM customers
                 WHERE ${wheres.join(" AND ")}
                 ORDER BY code
                 LIMIT ${limit}`;
    const rows = await c.var.DB
      .prepare(sql)
      .bind(...params)
      .all<{
        id: string;
        code: string | null;
        name: string | null;
        creditTerms: string | null;
        creditLimitSen: number | null;
        outstandingSen: number | null;
        isActive: number | boolean | null;
      }>();
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id,
        code: r.code ?? "",
        name: r.name ?? "",
        creditTerms: r.creditTerms ?? "",
        creditLimitRM: senToRM(r.creditLimitSen),
        outstandingRM: senToRM(r.outstandingSen),
        isActive: Boolean(r.isActive),
      })),
    };
  },
};

const getCustomer: ToolDefinition = {
  schema: {
    name: "get_customer",
    description: "Get customer detail plus the 10 most recent sales orders.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Internal id or customer code." },
      },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { error: "id is required" };

    const cust = await c.var.DB
      .prepare(
        `SELECT id, code, name, ssmNo, companyAddress, creditTerms,
                creditLimitSen, COALESCE(outstandingSen, 0) AS outstandingSen,
                contactName, phone, email, isActive
         FROM customers
         WHERE orgId = ? AND (id = ? OR code = ?)
         LIMIT 1`,
      )
      .bind(orgId, lookup, lookup)
      .first<{
        id: string;
        code: string | null;
        name: string | null;
        ssmNo: string | null;
        companyAddress: string | null;
        creditTerms: string | null;
        creditLimitSen: number | null;
        outstandingSen: number | null;
        contactName: string | null;
        phone: string | null;
        email: string | null;
        isActive: number | boolean | null;
      }>();
    if (!cust) return { error: `Customer not found: ${lookup}` };

    const recentSOs = await c.var.DB
      .prepare(
        `SELECT id, companySOId, status, totalSen, created_at AS createdAt
         FROM sales_orders
         WHERE customerId = ?
         ORDER BY created_at DESC
         LIMIT 10`,
      )
      .bind(cust.id)
      .all<{
        id: string;
        companySOId: string | null;
        status: string | null;
        totalSen: number | null;
        createdAt: string | null;
      }>();

    return {
      id: cust.id,
      code: cust.code ?? "",
      name: cust.name ?? "",
      ssmNo: cust.ssmNo ?? "",
      companyAddress: cust.companyAddress ?? "",
      creditTerms: cust.creditTerms ?? "",
      creditLimitRM: senToRM(cust.creditLimitSen),
      outstandingRM: senToRM(cust.outstandingSen),
      contactName: cust.contactName ?? "",
      phone: cust.phone ?? "",
      email: cust.email ?? "",
      isActive: Boolean(cust.isActive),
      recentOrders: (recentSOs.results ?? []).map((r) => ({
        id: r.id,
        companySOId: r.companySOId ?? "",
        status: r.status ?? "",
        totalRM: senToRM(r.totalSen),
        createdAt: r.createdAt ?? "",
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

const listSuppliers: ToolDefinition = {
  schema: {
    name: "list_suppliers",
    description: "List suppliers. Filter by partial name/code search.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Partial match on code or name." },
        limit: { type: "number", description: "Max rows (1-100, default 50)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];

    const search = strOrNull(args.search);
    if (search) {
      wheres.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
      const like = `%${search.toLowerCase()}%`;
      params.push(like, like);
    }

    const limit = clampLimit(args.limit, 50);
    const sql = `SELECT id, code, name, contactName, phone, email, isActive
                 FROM suppliers
                 WHERE ${wheres.join(" AND ")}
                 ORDER BY code
                 LIMIT ${limit}`;
    const rows = await c.var.DB
      .prepare(sql)
      .bind(...params)
      .all<{
        id: string;
        code: string | null;
        name: string | null;
        contactName: string | null;
        phone: string | null;
        email: string | null;
        isActive: number | boolean | null;
      }>();
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id,
        code: r.code ?? "",
        name: r.name ?? "",
        contactName: r.contactName ?? "",
        phone: r.phone ?? "",
        email: r.email ?? "",
        isActive: Boolean(r.isActive),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Daily report — process / SOP exceptions ("what needs attention today")
// ---------------------------------------------------------------------------

const getDailyReport: ToolDefinition = {
  schema: {
    name: "get_daily_report",
    description:
      "Get summary numbers from the daily report (efficiency, schedule, or overdue). For full HTML, the operator opens /daily-report in the ERP.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today (SGT)." },
        type: {
          type: "string",
          description: "One of: compliance, efficiency, overdue, schedule.",
        },
      },
      required: ["type"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const reportType = String(args.type ?? "").toLowerCase();
    const date = ymdOrNull(args.date) ?? new Date().toISOString().slice(0, 10);

    if (reportType === "overdue") {
      const overdueInvs = await c.var.DB
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(totalSen - COALESCE(paidAmount,0)), 0) AS totalSen
           FROM invoices
           WHERE orgId = ? AND UPPER(status) IN ('ISSUED','OVERDUE')
             AND dueDate IS NOT NULL AND dueDate < ?`,
        )
        .bind(orgId, date)
        .first<{ n: number; totalSen: number }>();
      const overdueSOs = await c.var.DB
        .prepare(
          `SELECT COUNT(*) AS n
           FROM sales_orders
           WHERE orgId = ? AND customerDeliveryDate IS NOT NULL
             AND customerDeliveryDate < ?
             AND UPPER(status) NOT IN ('DELIVERED','INVOICED','CANCELLED')`,
        )
        .bind(orgId, date)
        .first<{ n: number }>();
      return {
        date,
        type: reportType,
        overdueInvoices: overdueInvs?.n ?? 0,
        overdueInvoiceTotalRM: senToRM(overdueInvs?.totalSen ?? 0),
        overdueSalesOrders: overdueSOs?.n ?? 0,
      };
    }

    if (reportType === "schedule") {
      const due = await c.var.DB
        .prepare(
          `SELECT id, companySOId, customerName, status, customerDeliveryDate
           FROM sales_orders
           WHERE orgId = ? AND customerDeliveryDate = ?
           ORDER BY companySOId
           LIMIT 100`,
        )
        .bind(orgId, date)
        .all<{
          id: string;
          companySOId: string | null;
          customerName: string | null;
          status: string | null;
          customerDeliveryDate: string | null;
        }>();
      return {
        date,
        type: reportType,
        salesOrdersDue: (due.results ?? []).map((r) => ({
          id: r.id,
          companySOId: r.companySOId ?? "",
          customerName: r.customerName ?? "",
          status: r.status ?? "",
          deliveryDate: r.customerDeliveryDate ?? "",
        })),
      };
    }

    if (reportType === "efficiency" || reportType === "compliance") {
      // Detailed efficiency / compliance reports are computed by their
      // dedicated lib helpers (lib/efficiency-report.ts, lib/compliance-report.ts)
      // and rendered as HTML email bodies. From the chat, we just point
      // the operator at the dashboard page rather than re-running the
      // heavy aggregation here.
      return {
        date,
        type: reportType,
        note: `Open /daily-report?type=${reportType}&date=${date} in the ERP for the full breakdown.`,
      };
    }

    return {
      error: `Unknown report type: ${reportType}. Use one of: compliance, efficiency, overdue, schedule.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------

const getDashboardStats: ToolDefinition = {
  schema: {
    name: "get_dashboard_stats",
    description:
      "Get headline counts and revenue totals for the current org. Optional date range filters SOs/COs/DOs by createdAt and invoice revenue by invoiceDate.",
    input_schema: {
      type: "object",
      properties: {
        dateFrom: { type: "string", description: "Inclusive lower bound (YYYY-MM-DD)." },
        dateTo: { type: "string", description: "Inclusive upper bound (YYYY-MM-DD)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const dateFrom = ymdOrNull(args.dateFrom);
    const dateTo = ymdOrNull(args.dateTo);

    const dateClause = (col: string) => {
      const parts: string[] = [];
      const params: unknown[] = [];
      if (dateFrom) {
        parts.push(`${col} >= ?`);
        params.push(dateFrom);
      }
      if (dateTo) {
        parts.push(`${col} <= ?`);
        params.push(`${dateTo} 23:59:59`);
      }
      return {
        clause: parts.length ? ` AND ${parts.join(" AND ")}` : "",
        params,
      };
    };

    const soDate = dateClause("created_at");
    const coDate = dateClause("created_at");
    const doDate = dateClause("created_at");
    const invDate = dateClause("invoiceDate");

    const [soCount, coCount, doCount, revenue] = await Promise.all([
      c.var.DB
        .prepare(
          `SELECT COUNT(*) AS n FROM sales_orders WHERE orgId = ?${soDate.clause}`,
        )
        .bind(orgId, ...soDate.params)
        .first<{ n: number }>(),
      c.var.DB
        .prepare(
          `SELECT COUNT(*) AS n FROM consignment_orders WHERE orgId = ?${coDate.clause}`,
        )
        .bind(orgId, ...coDate.params)
        .first<{ n: number }>(),
      c.var.DB
        .prepare(
          `SELECT COUNT(*) AS n FROM delivery_orders WHERE orgId = ?${doDate.clause}`,
        )
        .bind(orgId, ...doDate.params)
        .first<{ n: number }>(),
      c.var.DB
        .prepare(
          `SELECT COALESCE(SUM(totalSen), 0) AS totalSen,
                  COALESCE(SUM(COALESCE(paidAmount,0)), 0) AS paidSen
           FROM invoices
           WHERE orgId = ? AND UPPER(status) <> 'VOID'${invDate.clause}`,
        )
        .bind(orgId, ...invDate.params)
        .first<{ totalSen: number; paidSen: number }>(),
    ]);

    return {
      dateFrom: dateFrom ?? "(all time)",
      dateTo: dateTo ?? "(all time)",
      salesOrderCount: soCount?.n ?? 0,
      consignmentOrderCount: coCount?.n ?? 0,
      deliveryOrderCount: doCount?.n ?? 0,
      invoicedRM: senToRM(revenue?.totalSen ?? 0),
      collectedRM: senToRM(revenue?.paidSen ?? 0),
      outstandingRM: senToRM((revenue?.totalSen ?? 0) - (revenue?.paidSen ?? 0)),
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOLS: ToolDefinition[] = [
  listSalesOrders,
  getSalesOrder,
  listConsignmentOrders,
  getConsignmentOrder,
  listDeliveryOrders,
  getDeliveryOrder,
  listInvoices,
  getInvoice,
  listPayments,
  listProducts,
  getProduct,
  listCustomers,
  getCustomer,
  listSuppliers,
  getDailyReport,
  getDashboardStats,
];

const TOOL_BY_NAME = new Map<string, ToolDefinition>(
  TOOLS.map((t) => [t.schema.name, t]),
);

export function getToolSchemas(): AnthropicTool[] {
  return TOOLS.map((t) => t.schema);
}

export async function runTool(
  c: Context<Env>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  try {
    const result = await tool.execute(c, args);
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/**
 * Filter args for the audit log — strips obviously large fields so we don't
 * write multi-KB rows. The model's args are already small (filter strings,
 * dates, ids) so this is mostly defensive.
 */
export function filterArgsForAudit(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    if (typeof v === "string") {
      out[k] = v.length > 200 ? v.slice(0, 200) + "..." : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      // Skip arrays / nested objects.
      out[k] = "[omitted]";
    }
  }
  return out;
}
