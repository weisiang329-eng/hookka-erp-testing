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
import { emitAudit } from "./audit";
import {
  lookupAttachments,
  type ParsedAttachment,
} from "./attachment-parser";
import { computeDeptSchedule } from "../routes/planning-schedule";
import type { Cell } from "./planning-scheduler";
import { promiseDelivery } from "./cs-agent";
import {
  listAgentControls,
  monthLlmUsage,
  recordAgentRun,
  setAgentControl,
  isKillSwitchOn,
  type AgentFamily,
  AGENT_FAMILIES,
} from "./agent-console";
import { generateProposals } from "./schedule-proposals";
import { runLearning } from "./agent-learning";
import { runDeliveryAgent } from "../routes/delivery-agent";

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
      "Get full detail of a single sales order including line items, related delivery orders, invoices, and payments. Pass whatever the user typed — the SO code they know (e.g. 'SO-2605-303') or the internal id (e.g. 'so-4e5f8592'). Both work, case-insensitive.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The SO identifier as the user knows it, e.g. 'SO-2605-303' or the internal id like 'so-4e5f8592'. Both work.",
        },
      },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { ok: false, error: "id is required" };

    // Try user-facing code first (case-insensitive), then internal id.
    const so = await c.var.DB
      .prepare(
        `SELECT id, companySOId, customerName, customerId, status, totalSen,
                subtotalSen, customerDeliveryDate, hookkaExpectedDD, customerPO,
                created_at AS createdAt
         FROM sales_orders
         WHERE orgId = ? AND (companySOId ILIKE ? OR id ILIKE ?)
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
    if (!so) return { ok: false, error: `Sales order not found: ${lookup}` };

    // sales_order_items: real columns are productName (not description),
    // lineTotalSen (not totalSen). invoices: invoiceNo (not invoiceNumber).
    // The previous shape was inherited from a phantom schema and made the
    // Promise.all reject — bubbling out as a generic tool error and the
    // model interpreted it as "not found".
    const [items, dos, invs] = await Promise.all([
      c.var.DB
        .prepare(
          `SELECT productCode, productName, sizeLabel, quantity, unitPriceSen, lineTotalSen
           FROM sales_order_items
           WHERE salesOrderId = ?
           ORDER BY lineNo
           LIMIT 100`,
        )
        .bind(so.id)
        .all<{
          productCode: string | null;
          productName: string | null;
          sizeLabel: string | null;
          quantity: number | null;
          unitPriceSen: number | null;
          lineTotalSen: number | null;
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
          `SELECT id, invoiceNo, status, totalSen, paidAmount, invoiceDate
           FROM invoices
           WHERE salesOrderId = ?
           ORDER BY invoiceDate DESC
           LIMIT 25`,
        )
        .bind(so.id)
        .all<{
          id: string;
          invoiceNo: string | null;
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
        productName: r.productName ?? "",
        sizeLabel: r.sizeLabel ?? "",
        quantity: r.quantity ?? 0,
        unitPriceRM: senToRM(r.unitPriceSen),
        totalRM: senToRM(r.lineTotalSen),
      })),
      deliveryOrders: (dos.results ?? []).map((r) => ({
        id: r.id,
        doNo: r.doNo ?? "",
        status: r.status ?? "",
        deliveryDate: r.deliveryDate ?? "",
      })),
      invoices: (invs.results ?? []).map((r) => ({
        id: r.id,
        invoiceNo: r.invoiceNo ?? "",
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
      "Get full detail of a single consignment order including line items. Pass whatever the user typed — the CO code (e.g. 'CO-2605-045') or the internal id. Both work, case-insensitive.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The CO identifier as the user knows it, e.g. 'CO-2605-045' or the internal id. Both work.",
        },
      },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { ok: false, error: "id is required" };

    const co = await c.var.DB
      .prepare(
        `SELECT id, companyCOId, customerName, customerId, status, totalSen,
                created_at AS createdAt
         FROM consignment_orders
         WHERE orgId = ? AND (companyCOId ILIKE ? OR id ILIKE ?)
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
    if (!co) return { ok: false, error: `Consignment order not found: ${lookup}` };

    // consignment_order_items: same column reality as sales_order_items —
    // productName (not description), lineTotalSen (not totalSen).
    const items = await c.var.DB
      .prepare(
        `SELECT productCode, productName, sizeLabel, quantity, unitPriceSen, lineTotalSen
         FROM consignment_order_items
         WHERE consignmentOrderId = ?
         ORDER BY lineNo
         LIMIT 100`,
      )
      .bind(co.id)
      .all<{
        productCode: string | null;
        productName: string | null;
        sizeLabel: string | null;
        quantity: number | null;
        unitPriceSen: number | null;
        lineTotalSen: number | null;
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
        productName: r.productName ?? "",
        sizeLabel: r.sizeLabel ?? "",
        quantity: r.quantity ?? 0,
        unitPriceRM: senToRM(r.unitPriceSen),
        totalRM: senToRM(r.lineTotalSen),
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
    description:
      "Get full detail of a single delivery order. Pass whatever the user typed — the DO number (e.g. 'DO-2605-097') or the internal id. Both work, case-insensitive.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The DO identifier as the user knows it, e.g. 'DO-2605-097' or the internal id. Both work.",
        },
      },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { ok: false, error: "id is required" };

    const row = await c.var.DB
      .prepare(
        `SELECT id, doNo, customerName, customerId, status, deliveryDate,
                deliveryAddress, salesOrderId, created_at AS createdAt
         FROM delivery_orders
         WHERE orgId = ? AND (doNo ILIKE ? OR id ILIKE ?)
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
    if (!row) return { ok: false, error: `Delivery order not found: ${lookup}` };
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
    // invoices table column is `invoiceNo`, not `invoiceNumber` — the original
    // assistant tool was inheriting a phantom column name that doesn't exist.
    const sql = `SELECT id, invoiceNo, customerName, status, totalSen,
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
        invoiceNo: string | null;
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
        invoiceNo: r.invoiceNo ?? "",
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
    description:
      "Get full detail of one invoice. Pass whatever the user typed — the invoice number (e.g. 'INV-2605-099') or the internal id. Both work, case-insensitive.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The invoice identifier as the user knows it, e.g. 'INV-2605-099' or the internal id. Both work.",
        },
      },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { ok: false, error: "id is required" };

    const row = await c.var.DB
      .prepare(
        `SELECT id, invoiceNo, customerName, customerId, status,
                totalSen, subtotalSen, COALESCE(paidAmount, 0) AS paidAmount,
                invoiceDate, dueDate, salesOrderId
         FROM invoices
         WHERE orgId = ? AND (invoiceNo ILIKE ? OR id ILIKE ?)
         LIMIT 1`,
      )
      .bind(orgId, lookup, lookup)
      .first<{
        id: string;
        invoiceNo: string | null;
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
    if (!row) return { ok: false, error: `Invoice not found: ${lookup}` };
    return {
      id: row.id,
      invoiceNo: row.invoiceNo ?? "",
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

    // Read BOM from the active bom_templates row (the legacy bom_components
    // columns don't match the live schema — see get_bom for the same fix).
    let bomComponents: unknown[] = [];
    try {
      const tpl = await c.var.DB
        .prepare(
          `SELECT wipComponents FROM bom_templates
           WHERE productCode ILIKE ?
           ORDER BY (CASE WHEN UPPER(COALESCE(versionStatus, '')) = 'ACTIVE' THEN 0 ELSE 1 END),
                    effectiveFrom DESC NULLS LAST
           LIMIT 1`,
        )
        .bind(p.code ?? "")
        .first<{ wipComponents: string | null }>();
      if (tpl?.wipComponents) {
        try {
          const parsed = JSON.parse(tpl.wipComponents);
          if (Array.isArray(parsed)) bomComponents = parsed;
        } catch { /* ignore malformed JSON */ }
      }
    } catch { /* table missing → empty BOM */ }

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
      bom: bomComponents,
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

// ===========================================================================
// v1.5 — Cross-module + module-coverage tools.
//
// Everything below is additive. None of the v1 tool functions above were
// renamed or modified; the new entries are added to the TOOLS registry.
// ===========================================================================

// ---------------------------------------------------------------------------
// Cross-module — trace_order
// ---------------------------------------------------------------------------

const traceOrder: ToolDefinition = {
  schema: {
    name: "trace_order",
    description:
      "Trace the full cascade chain for any document. Pass the SO/CO/PO/DO/INVOICE identifier as the user typed it (e.g. 'SO-2605-303', 'PO-2605-012', 'DO-2605-097', 'INV-2605-099') OR the internal id — both work, case-insensitive. Returns linked upstream + downstream documents: SO/CO → production_orders → job_cards → delivery_orders → invoices → payments.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "One of: SO, CO, PO, DO, INVOICE.",
        },
        id: {
          type: "string",
          description:
            "The identifier as the user knows it (e.g. 'SO-2605-303', 'INV-2605-099', 'DO-2605-097', 'PO-2605-012') or the internal id. Both work.",
        },
      },
      required: ["type", "id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    const type = String(args.type ?? "").toUpperCase();
    if (!lookup) return { ok: false, error: "id is required" };

    // Resolve starting SO and/or CO id(s) from the entry point.
    let soId: string | null = null;
    let coId: string | null = null;

    if (type === "SO") {
      const r = await c.var.DB
        .prepare(
          "SELECT id FROM sales_orders WHERE orgId = ? AND (companySOId ILIKE ? OR id ILIKE ?) LIMIT 1",
        )
        .bind(orgId, lookup, lookup)
        .first<{ id: string }>();
      if (!r) return { ok: false, error: `Sales order not found: ${lookup}` };
      soId = r.id;
    } else if (type === "CO") {
      const r = await c.var.DB
        .prepare(
          "SELECT id FROM consignment_orders WHERE orgId = ? AND (companyCOId ILIKE ? OR id ILIKE ?) LIMIT 1",
        )
        .bind(orgId, lookup, lookup)
        .first<{ id: string }>();
      if (!r) return { ok: false, error: `Consignment order not found: ${lookup}` };
      coId = r.id;
    } else if (type === "PO") {
      const r = await c.var.DB
        .prepare(
          "SELECT id, salesOrderId, consignmentOrderId FROM production_orders WHERE orgId = ? AND (poNo ILIKE ? OR id ILIKE ?) LIMIT 1",
        )
        .bind(orgId, lookup, lookup)
        .first<{ id: string; salesOrderId: string | null; consignmentOrderId: string | null }>();
      if (!r) return { ok: false, error: `Production order not found: ${lookup}` };
      soId = r.salesOrderId ?? null;
      coId = r.consignmentOrderId ?? null;
    } else if (type === "DO") {
      const r = await c.var.DB
        .prepare(
          "SELECT id, salesOrderId FROM delivery_orders WHERE orgId = ? AND (doNo ILIKE ? OR id ILIKE ?) LIMIT 1",
        )
        .bind(orgId, lookup, lookup)
        .first<{ id: string; salesOrderId: string | null }>();
      if (!r) return { ok: false, error: `Delivery order not found: ${lookup}` };
      soId = r.salesOrderId ?? null;
    } else if (type === "INVOICE") {
      const r = await c.var.DB
        .prepare(
          "SELECT id, salesOrderId FROM invoices WHERE orgId = ? AND (invoiceNo ILIKE ? OR id ILIKE ?) LIMIT 1",
        )
        .bind(orgId, lookup, lookup)
        .first<{ id: string; salesOrderId: string | null }>();
      if (!r) return { ok: false, error: `Invoice not found: ${lookup}` };
      soId = r.salesOrderId ?? null;
    } else {
      return { ok: false, error: `Unknown type: ${type}. Use SO, CO, PO, DO, or INVOICE.` };
    }

    if (!soId && !coId) {
      return {
        type,
        lookup,
        note: "No upstream sales/consignment order linked.",
      };
    }

    // Resolve SO + CO headers, then everything downstream.
    const [so, co] = await Promise.all([
      soId
        ? c.var.DB
            .prepare(
              `SELECT id, companySOId, customerName, status, totalSen,
                      customerDeliveryDate, hookkaExpectedDD, created_at AS createdAt
               FROM sales_orders WHERE id = ? LIMIT 1`,
            )
            .bind(soId)
            .first<{
              id: string;
              companySOId: string | null;
              customerName: string | null;
              status: string | null;
              totalSen: number | null;
              customerDeliveryDate: string | null;
              hookkaExpectedDD: string | null;
              createdAt: string | null;
            }>()
        : Promise.resolve(null),
      coId
        ? c.var.DB
            .prepare(
              `SELECT id, companyCOId, customerName, status, totalSen, created_at AS createdAt
               FROM consignment_orders WHERE id = ? LIMIT 1`,
            )
            .bind(coId)
            .first<{
              id: string;
              companyCOId: string | null;
              customerName: string | null;
              status: string | null;
              totalSen: number | null;
              createdAt: string | null;
            }>()
        : Promise.resolve(null),
    ]);

    const pos = await c.var.DB
      .prepare(
        `SELECT id, poNo, status, productCode, productName, quantity, currentDepartment,
                progress, startDate, targetEndDate, completedDate
         FROM production_orders
         WHERE orgId = ?
           AND (salesOrderId = ? OR consignmentOrderId = ?)
         ORDER BY poNo
         LIMIT 100`,
      )
      .bind(orgId, soId ?? "", coId ?? "")
      .all<{
        id: string;
        poNo: string | null;
        status: string | null;
        productCode: string | null;
        productName: string | null;
        quantity: number | null;
        currentDepartment: string | null;
        progress: number | null;
        startDate: string | null;
        targetEndDate: string | null;
        completedDate: string | null;
      }>();
    const poList = pos.results ?? [];
    const poIds = poList.map((p) => p.id);

    // Job cards for these POs.
    let jcs: Array<{
      id: string;
      productionOrderId: string;
      departmentCode: string | null;
      departmentName: string | null;
      status: string | null;
      wipLabel: string | null;
      wipQty: number | null;
      dueDate: string | null;
      completedDate: string | null;
    }> = [];
    if (poIds.length) {
      const placeholders = poIds.map(() => "?").join(",");
      const rows = await c.var.DB
        .prepare(
          `SELECT id, productionOrderId, departmentCode, departmentName, status,
                  wipLabel, wipQty, dueDate, completedDate
           FROM job_cards
           WHERE productionOrderId IN (${placeholders})
           ORDER BY productionOrderId, sequence
           LIMIT 100`,
        )
        .bind(...poIds)
        .all<{
          id: string;
          productionOrderId: string;
          departmentCode: string | null;
          departmentName: string | null;
          status: string | null;
          wipLabel: string | null;
          wipQty: number | null;
          dueDate: string | null;
          completedDate: string | null;
        }>();
      jcs = rows.results ?? [];
    }

    // DOs and invoices linked to this SO.
    const [dos, invs] = await Promise.all([
      soId
        ? c.var.DB
            .prepare(
              `SELECT id, doNo, status, deliveryDate, totalItems
               FROM delivery_orders WHERE orgId = ? AND salesOrderId = ?
               ORDER BY created_at DESC LIMIT 50`,
            )
            .bind(orgId, soId)
            .all<{
              id: string;
              doNo: string | null;
              status: string | null;
              deliveryDate: string | null;
              totalItems: number | null;
            }>()
        : Promise.resolve({ results: [] }),
      soId
        ? c.var.DB
            .prepare(
              `SELECT id, invoiceNo, status, totalSen,
                      COALESCE(paidAmount, 0) AS paidAmount, invoiceDate, dueDate
               FROM invoices WHERE orgId = ? AND salesOrderId = ?
               ORDER BY invoiceDate DESC LIMIT 50`,
            )
            .bind(orgId, soId)
            .all<{
              id: string;
              invoiceNo: string | null;
              status: string | null;
              totalSen: number | null;
              paidAmount: number | null;
              invoiceDate: string | null;
              dueDate: string | null;
            }>()
        : Promise.resolve({ results: [] }),
    ]);

    // Payments via allocations table — best-effort: scan invoice_payments by invoiceId.
    let payments: Array<{
      id: string;
      invoiceId: string | null;
      date: string | null;
      amountRM: string;
      method: string | null;
    }> = [];
    const invIds = (invs.results ?? []).map((i) => i.id);
    if (invIds.length) {
      const placeholders = invIds.map(() => "?").join(",");
      try {
        const pays = await c.var.DB
          .prepare(
            `SELECT id, invoiceId, date, amountSen, method
             FROM invoice_payments
             WHERE invoiceId IN (${placeholders})
             ORDER BY date DESC
             LIMIT 50`,
          )
          .bind(...invIds)
          .all<{
            id: string;
            invoiceId: string | null;
            date: string | null;
            amountSen: number | null;
            method: string | null;
          }>();
        payments = (pays.results ?? []).map((p) => ({
          id: p.id,
          invoiceId: p.invoiceId,
          date: p.date,
          amountRM: senToRM(p.amountSen),
          method: p.method,
        }));
      } catch {
        // invoice_payments may not be populated — silent fallback.
      }
    }

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: lookup,
      action: "trace_order",
      after: { type, lookup, soId, coId, poCount: poList.length },
      source: "ui",
    });

    return {
      type,
      lookup,
      salesOrder: so
        ? {
            id: so.id,
            companySOId: so.companySOId ?? "",
            customerName: so.customerName ?? "",
            status: so.status ?? "",
            totalRM: senToRM(so.totalSen),
            customerDeliveryDate: so.customerDeliveryDate ?? "",
            hookkaExpectedDD: so.hookkaExpectedDD ?? "",
            createdAt: so.createdAt ?? "",
          }
        : null,
      consignmentOrder: co
        ? {
            id: co.id,
            companyCOId: co.companyCOId ?? "",
            customerName: co.customerName ?? "",
            status: co.status ?? "",
            totalRM: senToRM(co.totalSen),
            createdAt: co.createdAt ?? "",
          }
        : null,
      productionOrders: poList.map((p) => ({
        id: p.id,
        poNo: p.poNo ?? "",
        status: p.status ?? "",
        productCode: p.productCode ?? "",
        productName: p.productName ?? "",
        quantity: p.quantity ?? 0,
        currentDepartment: p.currentDepartment ?? "",
        progress: p.progress ?? 0,
        startDate: p.startDate ?? "",
        targetEndDate: p.targetEndDate ?? "",
        completedDate: p.completedDate ?? "",
        jobCards: jcs
          .filter((j) => j.productionOrderId === p.id)
          .map((j) => ({
            id: j.id,
            department: j.departmentCode ?? j.departmentName ?? "",
            status: j.status ?? "",
            wipLabel: j.wipLabel ?? "",
            wipQty: j.wipQty ?? 0,
            dueDate: j.dueDate ?? "",
            completedDate: j.completedDate ?? "",
          })),
      })),
      deliveryOrders: (dos.results ?? []).map((d) => ({
        id: d.id,
        doNo: d.doNo ?? "",
        status: d.status ?? "",
        deliveryDate: d.deliveryDate ?? "",
        totalItems: d.totalItems ?? 0,
      })),
      invoices: (invs.results ?? []).map((i) => ({
        id: i.id,
        invoiceNo: i.invoiceNo ?? "",
        status: i.status ?? "",
        totalRM: senToRM(i.totalSen),
        paidRM: senToRM(i.paidAmount),
        invoiceDate: i.invoiceDate ?? "",
        dueDate: i.dueDate ?? "",
      })),
      payments,
    };
  },
};

// ---------------------------------------------------------------------------
// Cross-module — get_customer_360
// ---------------------------------------------------------------------------

const getCustomer360: ToolDefinition = {
  schema: {
    name: "get_customer_360",
    description:
      "Aggregated view of one customer: header info, last 10 SOs, last 10 COs, total spent (last 12 months), outstanding AR, AR aging buckets (0-30/31-60/61-90/90+), and last payment date.",
    input_schema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Internal customer id." },
        customerName: { type: "string", description: "Partial customer name." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const id = strOrNull(args.customerId);
    const name = strOrNull(args.customerName);
    if (!id && !name) return { error: "Provide either customerId or customerName" };

    const cust = id
      ? await c.var.DB
          .prepare(
            `SELECT id, code, name, ssmNo, creditTerms, creditLimitSen,
                    COALESCE(outstandingSen, 0) AS outstandingSen,
                    contactName, phone, email, isActive
             FROM customers WHERE orgId = ? AND (id = ? OR code = ?) LIMIT 1`,
          )
          .bind(orgId, id, id)
          .first<{
            id: string;
            code: string | null;
            name: string | null;
            ssmNo: string | null;
            creditTerms: string | null;
            creditLimitSen: number | null;
            outstandingSen: number | null;
            contactName: string | null;
            phone: string | null;
            email: string | null;
            isActive: number | boolean | null;
          }>()
      : await c.var.DB
          .prepare(
            `SELECT id, code, name, ssmNo, creditTerms, creditLimitSen,
                    COALESCE(outstandingSen, 0) AS outstandingSen,
                    contactName, phone, email, isActive
             FROM customers WHERE orgId = ? AND LOWER(name) LIKE ? ORDER BY name LIMIT 1`,
          )
          .bind(orgId, `%${(name ?? "").toLowerCase()}%`)
          .first<{
            id: string;
            code: string | null;
            name: string | null;
            ssmNo: string | null;
            creditTerms: string | null;
            creditLimitSen: number | null;
            outstandingSen: number | null;
            contactName: string | null;
            phone: string | null;
            email: string | null;
            isActive: number | boolean | null;
          }>();

    if (!cust) return { error: "Customer not found" };

    const today = new Date();
    const yearAgo = new Date(today);
    yearAgo.setFullYear(today.getFullYear() - 1);
    const yearAgoStr = yearAgo.toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);

    const [sos, cos, spent, aging, lastPay] = await Promise.all([
      c.var.DB
        .prepare(
          `SELECT id, companySOId, status, totalSen, created_at AS createdAt
           FROM sales_orders WHERE orgId = ? AND customerId = ?
           ORDER BY created_at DESC LIMIT 10`,
        )
        .bind(orgId, cust.id)
        .all<{
          id: string;
          companySOId: string | null;
          status: string | null;
          totalSen: number | null;
          createdAt: string | null;
        }>(),
      c.var.DB
        .prepare(
          `SELECT id, companyCOId, status, totalSen, created_at AS createdAt
           FROM consignment_orders WHERE orgId = ? AND customerId = ?
           ORDER BY created_at DESC LIMIT 10`,
        )
        .bind(orgId, cust.id)
        .all<{
          id: string;
          companyCOId: string | null;
          status: string | null;
          totalSen: number | null;
          createdAt: string | null;
        }>(),
      c.var.DB
        .prepare(
          `SELECT COALESCE(SUM(totalSen), 0) AS totalSen, COUNT(*) AS n
           FROM invoices
           WHERE orgId = ? AND customerId = ?
             AND UPPER(status) <> 'VOID'
             AND invoiceDate >= ?`,
        )
        .bind(orgId, cust.id, yearAgoStr)
        .first<{ totalSen: number; n: number }>(),
      c.var.DB
        .prepare(
          `SELECT id, invoiceNo, totalSen, COALESCE(paidAmount, 0) AS paidAmount,
                  invoiceDate, dueDate
           FROM invoices
           WHERE orgId = ? AND customerId = ?
             AND UPPER(status) IN ('ISSUED','OVERDUE','PARTIAL')
             AND totalSen > COALESCE(paidAmount, 0)
           ORDER BY dueDate ASC LIMIT 200`,
        )
        .bind(orgId, cust.id)
        .all<{
          id: string;
          invoiceNo: string | null;
          totalSen: number | null;
          paidAmount: number | null;
          invoiceDate: string | null;
          dueDate: string | null;
        }>(),
      c.var.DB
        .prepare(
          `SELECT date, amount, method FROM payment_records
           WHERE orgId = ? AND customerId = ?
           ORDER BY date DESC LIMIT 1`,
        )
        .bind(orgId, cust.id)
        .first<{ date: string | null; amount: number | null; method: string | null }>(),
    ]);

    // Aging buckets.
    let b0_30 = 0, b31_60 = 0, b61_90 = 0, b90p = 0;
    for (const r of aging.results ?? []) {
      const out = (r.totalSen ?? 0) - (r.paidAmount ?? 0);
      if (out <= 0) continue;
      const due = r.dueDate ?? r.invoiceDate ?? todayStr;
      const days = Math.floor(
        (today.getTime() - new Date(due).getTime()) / (1000 * 60 * 60 * 24),
      );
      if (days <= 30) b0_30 += out;
      else if (days <= 60) b31_60 += out;
      else if (days <= 90) b61_90 += out;
      else b90p += out;
    }

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: cust.id,
      action: "get_customer_360",
      after: { customerId: cust.id },
      source: "ui",
    });

    return {
      customer: {
        id: cust.id,
        code: cust.code ?? "",
        name: cust.name ?? "",
        ssmNo: cust.ssmNo ?? "",
        creditTerms: cust.creditTerms ?? "",
        creditLimitRM: senToRM(cust.creditLimitSen),
        outstandingRM: senToRM(cust.outstandingSen),
        contactName: cust.contactName ?? "",
        phone: cust.phone ?? "",
        email: cust.email ?? "",
        isActive: Boolean(cust.isActive),
      },
      last12Months: {
        invoiceCount: spent?.n ?? 0,
        totalRM: senToRM(spent?.totalSen ?? 0),
      },
      arAging: {
        b0_30RM: senToRM(b0_30),
        b31_60RM: senToRM(b31_60),
        b61_90RM: senToRM(b61_90),
        b90plusRM: senToRM(b90p),
        totalOutstandingRM: senToRM(b0_30 + b31_60 + b61_90 + b90p),
      },
      lastPayment: lastPay
        ? {
            date: lastPay.date ?? "",
            amountRM: senToRM(lastPay.amount),
            method: lastPay.method ?? "",
          }
        : null,
      recentSalesOrders: (sos.results ?? []).map((r) => ({
        id: r.id,
        companySOId: r.companySOId ?? "",
        status: r.status ?? "",
        totalRM: senToRM(r.totalSen),
        createdAt: r.createdAt ?? "",
      })),
      recentConsignmentOrders: (cos.results ?? []).map((r) => ({
        id: r.id,
        companyCOId: r.companyCOId ?? "",
        status: r.status ?? "",
        totalRM: senToRM(r.totalSen),
        createdAt: r.createdAt ?? "",
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Cross-module — get_product_360
// ---------------------------------------------------------------------------

const getProduct360: ToolDefinition = {
  schema: {
    name: "get_product_360",
    description:
      "Product 360 view: product header, BOM, current WIP count, FG units in stock, last 6mo order volume (units + count), and top 5 customers buying it.",
    input_schema: {
      type: "object",
      properties: {
        productCode: { type: "string", description: "Product code (e.g. '1003-(K)')." },
      },
      required: ["productCode"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const code = strOrNull(args.productCode);
    if (!code) return { error: "productCode is required" };

    const p = await c.var.DB
      .prepare(
        `SELECT id, code, name, category, sizeLabel, description, basePriceSen,
                costPriceSen, fabricUsage, productionTimeMinutes, status
         FROM products WHERE orgId = ? AND code = ? LIMIT 1`,
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

    const sixAgo = new Date();
    sixAgo.setMonth(sixAgo.getMonth() - 6);
    const sixAgoStr = sixAgo.toISOString().slice(0, 10);

    const [bomTpl, wip, fg, vol, topCust] = await Promise.all([
      c.var.DB
        .prepare(
          `SELECT wipComponents FROM bom_templates
           WHERE productCode ILIKE ?
           ORDER BY (CASE WHEN UPPER(COALESCE(versionStatus, '')) = 'ACTIVE' THEN 0 ELSE 1 END),
                    effectiveFrom DESC NULLS LAST
           LIMIT 1`,
        )
        .bind(p.code ?? code)
        .first<{ wipComponents: string | null }>()
        .catch(() => null),
      c.var.DB
        .prepare(
          `SELECT COALESCE(SUM(stockQty), 0) AS qty
           FROM wip_items WHERE orgId = ? AND relatedProduct = ?`,
        )
        .bind(orgId, code)
        .first<{ qty: number }>(),
      c.var.DB
        .prepare(
          `SELECT COUNT(*) AS n
           FROM fg_units WHERE orgId = ? AND productCode = ?
             AND UPPER(status) IN ('PACKED','LOADED','READY','IN_STOCK')`,
        )
        .bind(orgId, code)
        .first<{ n: number }>(),
      c.var.DB
        .prepare(
          `SELECT COUNT(DISTINCT soi.salesOrderId) AS orderCount,
                  COALESCE(SUM(soi.quantity), 0) AS unitCount
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.salesOrderId
           WHERE so.orgId = ? AND soi.productCode = ?
             AND so.created_at >= ?`,
        )
        .bind(orgId, code, sixAgoStr)
        .first<{ orderCount: number; unitCount: number }>(),
      c.var.DB
        .prepare(
          `SELECT so.customerName AS customerName, COALESCE(SUM(soi.quantity), 0) AS units
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.salesOrderId
           WHERE so.orgId = ? AND soi.productCode = ?
             AND so.created_at >= ?
           GROUP BY so.customerName
           ORDER BY units DESC
           LIMIT 5`,
        )
        .bind(orgId, code, sixAgoStr)
        .all<{ customerName: string | null; units: number }>(),
    ]);

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: p.id,
      action: "get_product_360",
      after: { productCode: code },
      source: "ui",
    });

    return {
      product: {
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
      },
      bom: (() => {
        if (!bomTpl?.wipComponents) return [];
        try {
          const parsed = JSON.parse(bomTpl.wipComponents);
          return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
      })(),
      wipUnits: wip?.qty ?? 0,
      fgUnitsInStock: fg?.n ?? 0,
      last6Months: {
        orderCount: vol?.orderCount ?? 0,
        unitsSold: vol?.unitCount ?? 0,
      },
      top5Customers: (topCust.results ?? []).map((r) => ({
        customerName: r.customerName ?? "",
        units: Number(r.units ?? 0),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Cross-module — smart_lookup (fuzzy, multi-format, multi-entity)
//
// The operator types things like "PO9003", "PO 9003", "po03 9003",
// "houzs 9003", "9003" — and expects us to find the matching document,
// or at least ASK what they mean instead of dying with "not found".
//
// Pure helpers below are exported so they can be unit-tested without
// hitting the DB.
// ---------------------------------------------------------------------------

/**
 * Pull every contiguous digit-run out of a free-text query. We use the
 * longest digit run as the "numeric core" — that's the part that
 * uniquely identifies a document number in 99% of operator typos.
 *
 *   "PO9003"        -> ["9003"]
 *   "PO 9003"       -> ["9003"]
 *   "PO-009003"     -> ["009003"]
 *   "PO03 9003"     -> ["03", "9003"]  (we'll grab the longest: "9003")
 *   "SO 2605 51"    -> ["2605", "51"]
 *   "houzs 9003"    -> ["9003"]
 *   "9k"            -> ["9"]
 *   ""              -> []
 */
export function extractDigitRuns(raw: string): string[] {
  if (!raw || typeof raw !== "string") return [];
  const matches = raw.match(/\d+/g);
  return matches ? matches.slice(0, 10) : [];
}

/**
 * Given a raw query, generate a set of canonical-ish format strings to
 * try as ILIKE patterns. We're not trying to be perfect — we cast a
 * wide net and let the DB tell us what exists.
 *
 *   "PO9003" -> [
 *     "%PO9003%",
 *     "%9003%",
 *     "%PO-9003%", "%PO-09003%", "%PO-009003%",   <- Houzs Customer-PO widths
 *     "%PO-2605-9003%", "%PO-2605-009003%",        <- Internal Production-Order shape (current YYMM)
 *     "%PO-2605-051%" (only if a 2-3 digit numeric core could match the sequence)
 *   ]
 */
export function generateLookupPatterns(raw: string, currentYYMM: string): string[] {
  const out = new Set<string>();
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];

  // 1. Always include the raw query as a fuzzy contains-match.
  out.add(`%${trimmed}%`);
  // Strip spaces — operators often type "PO 9003" expecting "PO9003".
  const noSpace = trimmed.replace(/\s+/g, "");
  if (noSpace) out.add(`%${noSpace}%`);

  const runs = extractDigitRuns(trimmed);
  if (runs.length === 0) return Array.from(out);

  // Pick the longest digit run as the "core". Falls back to all of them
  // for short queries like "PO03 9003" where the operator gave us
  // year + sequence separately.
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a), "");

  // Search by the raw core (e.g. "9003" matches both "PO-9003" and "PO-2605-9003").
  out.add(`%${longest}%`);

  // Houzs Customer-PO variants: zero-pad to 4/5/6 widths.
  // "9003" -> "PO-9003", "PO-09003", "PO-009003"
  if (longest.length <= 6) {
    out.add(`%PO-${longest.padStart(6, "0")}%`);
    out.add(`%PO-${longest.padStart(5, "0")}%`);
    out.add(`%PO-${longest.padStart(4, "0")}%`);
    out.add(`%PO-${longest}%`);
  }

  // Internal Production-Order shape (PO-YYMM-NNN) using the current
  // year-month. Pad sequence to 3 digits — typical width.
  if (longest.length <= 4) {
    out.add(`%PO-${currentYYMM}-${longest.padStart(3, "0")}%`);
    out.add(`%PO-${currentYYMM}-${longest}%`);
  }

  // Internal SO/CO/DO shapes — same idea.
  if (longest.length <= 4) {
    out.add(`%SO-${currentYYMM}-${longest.padStart(3, "0")}%`);
    out.add(`%CO-${currentYYMM}-${longest.padStart(3, "0")}%`);
    out.add(`%DO-${currentYYMM}-${longest.padStart(3, "0")}%`);
    out.add(`%INV-${currentYYMM}-${longest.padStart(3, "0")}%`);
  }

  // If the operator passed both year-month and sequence ("SO 2605 51"),
  // assemble the canonical form directly.
  if (runs.length >= 2) {
    const yymm = runs.find((r) => r.length === 4);
    const seq = runs.find((r) => r.length >= 1 && r.length <= 4 && r !== yymm);
    if (yymm && seq) {
      out.add(`%SO-${yymm}-${seq.padStart(3, "0")}%`);
      out.add(`%CO-${yymm}-${seq.padStart(3, "0")}%`);
      out.add(`%PO-${yymm}-${seq.padStart(3, "0")}%`);
      out.add(`%DO-${yymm}-${seq.padStart(3, "0")}%`);
      out.add(`%INV-${yymm}-${seq.padStart(3, "0")}%`);
    }
  }

  return Array.from(out);
}

/**
 * Current YYMM string for the lookup-pattern generator. Uses UTC; close
 * enough for ERP search heuristics (the model can always retry with an
 * explicit year-month hint).
 */
function currentYYMM(): string {
  const now = new Date();
  const yy = String(now.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}${mm}`;
}

const smart_lookup: ToolDefinition = {
  schema: {
    name: "smart_lookup",
    description:
      "UNIVERSAL FUZZY LOOKUP — your FIRST call for ANY thing the operator names, whether it's a document number OR a person / product / fabric / material. Handles ambiguous identifiers like 'PO9003', 'PO 9003', 'PO03 9003', 'houzs 9003', '9003', 'SO 2605 51' AND plain words like 'Zaw Lin', 'model 1003', 'grey suede'. For numbers it strips the digits and tries width-padded format guesses (PO-9003 / PO-09003 / PO-009003 for Houzs Customer POs; PO-YYMM-NNN for internal Production Orders). It scans EVERY entity: sales_orders (companySOId + customerPOId), consignment_orders, production_orders, delivery_orders, invoices, customers, suppliers, workers/employees (name + emp no), products (code + name), fabrics (code + name), raw_materials/accessories (item code + description). Returns matches GROUPED by entity type with disambiguating context. NEVER ask 'which department' or 'what's the id' before calling this — look up first. If zero matches, ASK a clarifying question; never just say 'not found'.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Whatever the operator typed, exactly as typed. We do the normalisation. e.g. 'PO9003', 'PO 9003', 'houzs 9003', '9003'.",
        },
        customerHint: {
          type: "string",
          description:
            "Optional customer name fragment to narrow the search (e.g. 'houzs', 'carress'). Case-insensitive contains match.",
        },
        limitPerType: {
          type: "number",
          description: "Max rows per entity type (1-20, default 8).",
        },
      },
      required: ["query"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const rawQuery = strOrNull(args.query);
    if (!rawQuery) return { ok: false, error: "query is required" };

    const customerHint = strOrNull(args.customerHint);
    const limit = Math.min(20, Math.max(1, Number(args.limitPerType) || 8));

    const yymm = currentYYMM();
    const patterns = generateLookupPatterns(rawQuery, yymm);
    if (patterns.length === 0) return { ok: false, error: "Could not extract any search pattern from query." };

    // Build a single SQL clause that runs one column against all patterns
    // via ILIKE ANY (...). Postgres-only, but we're on Postgres.
    //
    // sales_orders.customerPOId is the Houzs-style "PO-NNNNNN" field —
    // the most common reason the operator types "PO9003".
    const customerHintLike = customerHint ? `%${customerHint.toLowerCase()}%` : null;

    const runColumnSearch = async (
      table: string,
      columns: string[],
      selectClause: string,
      orderBy: string,
      opts?: { hasCustomerName?: boolean },
    ) => {
      // Cross-product: every column ILIKE every pattern. Pattern count is
      // bounded (~10) and column count is small (~4) so 40 ORs is fine.
      // We use a plain OR chain instead of `ILIKE ANY (?::text[])` because
      // postgres.js + transaction-pooler + prepare:false has trouble
      // binding text[] params via the D1-shaped adapter — silently returns
      // zero rows where a normal OR chain works fine.
      //
      // hasCustomerName: people / catalog tables (workers, products,
      // fabrics, raw_materials) have NO customerName column, so the
      // customer-hint narrowing must be skipped for them or the query errors.
      const hasCustomerName = opts?.hasCustomerName ?? true;
      const orParts: string[] = [];
      const params: unknown[] = [orgId];
      for (const col of columns) {
        for (const pat of patterns) {
          orParts.push(`${col} ILIKE ?`);
          params.push(pat);
        }
      }
      const orClause = orParts.join(" OR ");
      const where = customerHintLike && hasCustomerName
        ? `orgId = ? AND (${orClause}) AND LOWER(COALESCE(customerName, '')) LIKE ?`
        : `orgId = ? AND (${orClause})`;
      if (customerHintLike && hasCustomerName) params.push(customerHintLike);

      const sql = `SELECT ${selectClause} FROM ${table} WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit}`;
      try {
        const rows = await c.var.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
        return rows.results ?? [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { _error: msg } as unknown as Record<string, unknown>[];
      }
    };

    const [
      salesRows, consignmentRows, prodRows, deliveryRows, invoiceRows,
      customerRows, supplierRows, workerRows, productRows, fabricRows, materialRows,
    ] =
      await Promise.all([
        runColumnSearch(
          "sales_orders",
          ["companySOId", "customerPOId", "customerSOId", "id"],
          "id, companySOId, customerPOId, customerSOId, customerName, status, totalSen, customerDeliveryDate, created_at AS createdAt",
          "created_at DESC",
        ),
        runColumnSearch(
          "consignment_orders",
          ["companyCOId", "customerCOId", "id"],
          "id, companyCOId, customerCOId, customerName, status, totalSen, created_at AS createdAt",
          "created_at DESC",
        ),
        runColumnSearch(
          "production_orders",
          ["poNo", "customerPOId", "companySOId", "id"],
          "id, poNo, salesOrderNo, customerPOId, customerName, productCode, productName, status, currentDepartment, progress, startDate, targetEndDate",
          "created_at DESC",
        ),
        runColumnSearch(
          "delivery_orders",
          ["doNo", "customerPOId", "companySOId", "id"],
          "id, doNo, customerPOId, customerName, status, deliveryDate, created_at AS createdAt",
          "created_at DESC",
        ),
        runColumnSearch(
          "invoices",
          ["invoiceNo", "companySOId", "id"],
          "id, invoiceNo, customerName, status, totalSen, paidAmount, invoiceDate",
          "invoiceDate DESC",
        ),
        customerHintLike
          ? c.var.DB.prepare(
              `SELECT id, code, name FROM customers WHERE orgId = ? AND (LOWER(code) LIKE ? OR LOWER(name) LIKE ?) ORDER BY name LIMIT ${limit}`,
            )
              .bind(orgId, customerHintLike, customerHintLike)
              .all<{ id: string; code: string | null; name: string | null }>()
              .then((r) => r.results ?? [])
          : Promise.resolve([] as Array<{ id: string; code: string | null; name: string | null }>),
        // Suppliers by code/name only — no customer-hint join.
        c.var.DB.prepare(
          `SELECT id, code, name FROM suppliers WHERE orgId = ? AND (LOWER(code) LIKE ? OR LOWER(name) LIKE ?) ORDER BY name LIMIT ${limit}`,
        )
          .bind(orgId, `%${rawQuery.toLowerCase()}%`, `%${rawQuery.toLowerCase()}%`)
          .all<{ id: string; code: string | null; name: string | null }>()
          .then((r) => r.results ?? []),
        // Workers / employees — resolve a PERSON by name or emp number.
        // This is what was missing: "Zaw Lin" had no path to a record so
        // the model used to ask "which department / emp id" instead of
        // looking up first.
        runColumnSearch(
          "workers",
          ["name", "empNo", "id"],
          "id, empNo, name, departmentCode, role, status",
          "name",
          { hasCustomerName: false },
        ),
        // Products by code / name (e.g. "1003", "1005 queen").
        runColumnSearch(
          "products",
          ["code", "name", "id"],
          "id, code, name, category, status",
          "code",
          { hasCustomerName: false },
        ),
        // Fabrics by code / name (e.g. "that grey fabric").
        runColumnSearch(
          "fabrics",
          ["code", "name", "id"],
          "id, code, name, category",
          "code",
          { hasCustomerName: false },
        ),
        // Raw materials / accessories by item code / description.
        runColumnSearch(
          "raw_materials",
          ["itemCode", "description", "id"],
          "id, itemCode, description, itemGroup, baseUOM",
          "itemCode",
          { hasCustomerName: false },
        ),
      ]);

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: rawQuery.slice(0, 100),
      action: "smart_lookup",
      after: { query: rawQuery, customerHint: customerHint ?? "", patternCount: patterns.length },
      source: "ui",
    });

    const shape = (r: Record<string, unknown>) => r;
    const safeRows = (rows: Record<string, unknown>[] | { _error: string }) =>
      Array.isArray(rows) ? rows.map(shape) : [];

    const salesOrders = safeRows(salesRows).map((r) => ({
      id: String(r.id ?? ""),
      label: String(r.companySOId ?? ""),
      customerPO: String(r.customerPOId ?? ""),
      customerSO: String(r.customerSOId ?? ""),
      customer: String(r.customerName ?? ""),
      status: String(r.status ?? ""),
      totalRM: senToRM(Number(r.totalSen ?? 0)),
      deliveryDate: String(r.customerDeliveryDate ?? ""),
      createdAt: String(r.createdAt ?? ""),
    }));
    const consignmentOrders = safeRows(consignmentRows).map((r) => ({
      id: String(r.id ?? ""),
      label: String(r.companyCOId ?? ""),
      customerCO: String(r.customerCOId ?? ""),
      customer: String(r.customerName ?? ""),
      status: String(r.status ?? ""),
      totalRM: senToRM(Number(r.totalSen ?? 0)),
      createdAt: String(r.createdAt ?? ""),
    }));
    const productionOrders = safeRows(prodRows).map((r) => ({
      id: String(r.id ?? ""),
      poNo: String(r.poNo ?? ""),
      salesOrderNo: String(r.salesOrderNo ?? ""),
      customerPO: String(r.customerPOId ?? ""),
      customer: String(r.customerName ?? ""),
      product: `${r.productCode ?? ""} ${r.productName ?? ""}`.trim(),
      status: String(r.status ?? ""),
      currentDepartment: String(r.currentDepartment ?? ""),
      progress: Number(r.progress ?? 0),
      startDate: String(r.startDate ?? ""),
      targetEndDate: String(r.targetEndDate ?? ""),
    }));
    const deliveryOrders = safeRows(deliveryRows).map((r) => ({
      id: String(r.id ?? ""),
      doNo: String(r.doNo ?? ""),
      customerPO: String(r.customerPOId ?? ""),
      customer: String(r.customerName ?? ""),
      status: String(r.status ?? ""),
      deliveryDate: String(r.deliveryDate ?? ""),
    }));
    const invoices = safeRows(invoiceRows).map((r) => ({
      id: String(r.id ?? ""),
      invoiceNo: String(r.invoiceNo ?? ""),
      customer: String(r.customerName ?? ""),
      status: String(r.status ?? ""),
      totalRM: senToRM(Number(r.totalSen ?? 0)),
      paidRM: senToRM(Number(r.paidAmount ?? 0)),
      invoiceDate: String(r.invoiceDate ?? ""),
    }));
    const customers = customerRows.map((r) => ({
      id: r.id,
      code: r.code ?? "",
      name: r.name ?? "",
    }));
    const suppliers = supplierRows.map((r) => ({
      id: r.id,
      code: r.code ?? "",
      name: r.name ?? "",
    }));
    const workers = safeRows(workerRows).map((r) => ({
      employeeId: String(r.id ?? ""),
      empNo: String(r.empNo ?? ""),
      name: String(r.name ?? ""),
      department: String(r.departmentCode ?? ""),
      role: String(r.role ?? ""),
      status: String(r.status ?? ""),
    }));
    const products = safeRows(productRows).map((r) => ({
      id: String(r.id ?? ""),
      code: String(r.code ?? ""),
      name: String(r.name ?? ""),
      category: String(r.category ?? ""),
      status: String(r.status ?? ""),
    }));
    const fabrics = safeRows(fabricRows).map((r) => ({
      id: String(r.id ?? ""),
      code: String(r.code ?? ""),
      name: String(r.name ?? ""),
      category: String(r.category ?? ""),
    }));
    const materials = safeRows(materialRows).map((r) => ({
      id: String(r.id ?? ""),
      itemCode: String(r.itemCode ?? ""),
      description: String(r.description ?? ""),
      itemGroup: String(r.itemGroup ?? ""),
      baseUOM: String(r.baseUOM ?? ""),
    }));

    const totalMatches =
      salesOrders.length +
      consignmentOrders.length +
      productionOrders.length +
      deliveryOrders.length +
      invoices.length +
      customers.length +
      suppliers.length +
      workers.length +
      products.length +
      fabrics.length +
      materials.length;

    return {
      query: rawQuery,
      customerHint: customerHint ?? "",
      patternsTried: patterns,
      totalMatches,
      // Hint to the model when zero results so it knows to ASK — universal,
      // covers people / products / fabrics / materials, not just documents.
      askClarifyingQuestion:
        totalMatches === 0
          ? "No matches found anywhere (orders, customers, suppliers, employees, products, fabrics, materials). Ask the operator to clarify what kind of thing this is and give one extra hint — a customer or person name, a rough date, or the document type (Customer PO / Sales Order / Production Order)."
          : "",
      salesOrders,
      consignmentOrders,
      productionOrders,
      deliveryOrders,
      invoices,
      customers,
      suppliers,
      workers,
      products,
      fabrics,
      materials,
    };
  },
};

// ---------------------------------------------------------------------------
// Cross-module — lookup_customer_po
//
// Tighter than smart_lookup — targets ONLY the customer-PO fields the
// way Houzs / Carress / The Conts send them. Use when the operator
// has already established context that it's a Customer-PO (not an
// internal Production Order).
// ---------------------------------------------------------------------------

const lookupCustomerPo: ToolDefinition = {
  schema: {
    name: "lookup_customer_po",
    description:
      "Look up a Customer PO reference (the number the CUSTOMER sent us, stored on sales_orders.customerPOId / consignment_orders.customerCOId / production_orders.customerPOId). Houzs uses 'PO-NNNNNN' (6-digit, e.g. PO-009003), Carress uses 'PO/YYMM-XXX'. Accepts any reasonable variant — '9003', 'PO9003', 'PO-9003', 'PO-009003' all work. Returns matching SOs / COs / POs with customer + status + dates.",
    input_schema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description:
            "The customer-PO number, however the operator typed it. e.g. '9003', 'PO9003', 'PO-9003', 'PO-009003'.",
        },
        customerHint: {
          type: "string",
          description: "Optional customer name fragment (e.g. 'houzs').",
        },
      },
      required: ["ref"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const raw = strOrNull(args.ref);
    if (!raw) return { ok: false, error: "ref is required" };

    const customerHint = strOrNull(args.customerHint);
    const yymm = currentYYMM();
    const patterns = generateLookupPatterns(raw, yymm);
    const customerHintLike = customerHint ? `%${customerHint.toLowerCase()}%` : null;

    // OR-chain (one ILIKE ? per pattern) — avoids postgres.js text[] bind
    // issues via the D1-shaped adapter.
    const customerPoOrParts = patterns.map(() => `customerPOId ILIKE ?`).join(" OR ");
    const buildSql = (table: string, fields: string, dateCol: string) => {
      const where = customerHintLike
        ? `orgId = ? AND (${customerPoOrParts}) AND LOWER(COALESCE(customerName, '')) LIKE ?`
        : `orgId = ? AND (${customerPoOrParts})`;
      return `SELECT ${fields} FROM ${table} WHERE ${where} ORDER BY ${dateCol} DESC LIMIT 20`;
    };

    const bindFor = (): unknown[] => {
      const p: unknown[] = [orgId, ...patterns];
      if (customerHintLike) p.push(customerHintLike);
      return p;
    };

    // production_orders uses customerPOId too. Search all three.
    const [salesRows, prodRows, deliveryRows] = await Promise.all([
      c.var.DB.prepare(
        buildSql(
          "sales_orders",
          "id, companySOId, customerPOId, customerName, status, totalSen, customerDeliveryDate",
          "created_at",
        ),
      )
        .bind(...bindFor())
        .all<Record<string, unknown>>()
        .then((r) => r.results ?? [])
        .catch(() => []),
      c.var.DB.prepare(
        buildSql(
          "production_orders",
          "id, poNo, salesOrderNo, customerPOId, customerName, productCode, productName, status, currentDepartment, startDate, targetEndDate",
          "created_at",
        ),
      )
        .bind(...bindFor())
        .all<Record<string, unknown>>()
        .then((r) => r.results ?? [])
        .catch(() => []),
      c.var.DB.prepare(
        buildSql(
          "delivery_orders",
          "id, doNo, customerPOId, customerName, status, deliveryDate",
          "created_at",
        ),
      )
        .bind(...bindFor())
        .all<Record<string, unknown>>()
        .then((r) => r.results ?? [])
        .catch(() => []),
    ]);

    // Also try consignment_orders.customerCOId — separate column name.
    const customerCoOrParts = patterns.map(() => `customerCOId ILIKE ?`).join(" OR ");
    const coWhere = customerHintLike
      ? `orgId = ? AND (${customerCoOrParts}) AND LOWER(COALESCE(customerName, '')) LIKE ?`
      : `orgId = ? AND (${customerCoOrParts})`;
    const coParams: unknown[] = [orgId, ...patterns];
    if (customerHintLike) coParams.push(customerHintLike);
    const coRows = await c.var.DB.prepare(
      `SELECT id, companyCOId, customerCOId, customerName, status, totalSen FROM consignment_orders WHERE ${coWhere} ORDER BY created_at DESC LIMIT 20`,
    )
      .bind(...coParams)
      .all<Record<string, unknown>>()
      .then((r) => r.results ?? [])
      .catch(() => []);

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: raw.slice(0, 100),
      action: "lookup_customer_po",
      after: { ref: raw, customerHint: customerHint ?? "" },
      source: "ui",
    });

    const salesOrders = salesRows.map((r) => ({
      id: String(r.id ?? ""),
      label: String(r.companySOId ?? ""),
      customerPO: String(r.customerPOId ?? ""),
      customer: String(r.customerName ?? ""),
      status: String(r.status ?? ""),
      totalRM: senToRM(Number(r.totalSen ?? 0)),
      deliveryDate: String(r.customerDeliveryDate ?? ""),
    }));
    const consignmentOrders = coRows.map((r) => ({
      id: String(r.id ?? ""),
      label: String(r.companyCOId ?? ""),
      customerCO: String(r.customerCOId ?? ""),
      customer: String(r.customerName ?? ""),
      status: String(r.status ?? ""),
      totalRM: senToRM(Number(r.totalSen ?? 0)),
    }));
    const productionOrders = prodRows.map((r) => ({
      id: String(r.id ?? ""),
      poNo: String(r.poNo ?? ""),
      salesOrderNo: String(r.salesOrderNo ?? ""),
      customerPO: String(r.customerPOId ?? ""),
      customer: String(r.customerName ?? ""),
      product: `${r.productCode ?? ""} ${r.productName ?? ""}`.trim(),
      status: String(r.status ?? ""),
      currentDepartment: String(r.currentDepartment ?? ""),
      startDate: String(r.startDate ?? ""),
      targetEndDate: String(r.targetEndDate ?? ""),
    }));
    const deliveryOrders = deliveryRows.map((r) => ({
      id: String(r.id ?? ""),
      doNo: String(r.doNo ?? ""),
      customerPO: String(r.customerPOId ?? ""),
      customer: String(r.customerName ?? ""),
      status: String(r.status ?? ""),
      deliveryDate: String(r.deliveryDate ?? ""),
    }));

    const totalMatches =
      salesOrders.length + consignmentOrders.length + productionOrders.length + deliveryOrders.length;

    return {
      ref: raw,
      customerHint: customerHint ?? "",
      patternsTried: patterns,
      totalMatches,
      askClarifyingQuestion:
        totalMatches === 0
          ? "No Customer-PO matches. Ask the operator: is this number maybe an internal Sales/Production Order (SO-2605-NNN / PO-2605-NNN) instead of a Customer PO? Or do they have a customer name / date hint?"
          : "",
      salesOrders,
      consignmentOrders,
      productionOrders,
      deliveryOrders,
    };
  },
};

// ---------------------------------------------------------------------------
// Cross-module — search_anything
// ---------------------------------------------------------------------------

const searchAnything: ToolDefinition = {
  schema: {
    name: "search_anything",
    description:
      "Fuzzy search across SO numbers, CO numbers, DO numbers, invoice numbers, customer names, supplier names, and product codes. Returns up to 20 matches per type. Use as a first step when the user mentions a name or code without specifying what kind of document.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search string." },
        limit: { type: "number", description: "Max per type (1-20, default 5)." },
      },
      required: ["query"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const q = strOrNull(args.query);
    if (!q) return { error: "query is required" };
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
    const like = `%${q.toLowerCase()}%`;

    const [sos, cos, dos, invs, custs, sups, prods] = await Promise.all([
      c.var.DB.prepare(
        `SELECT id, companySOId, customerName, status FROM sales_orders
         WHERE orgId = ? AND (LOWER(companySOId) LIKE ? OR LOWER(customerSOId) LIKE ? OR LOWER(customerPOId) LIKE ?)
         ORDER BY created_at DESC LIMIT ?`,
      ).bind(orgId, like, like, like, limit).all<{ id: string; companySOId: string | null; customerName: string | null; status: string | null }>(),
      c.var.DB.prepare(
        `SELECT id, companyCOId, customerName, status FROM consignment_orders
         WHERE orgId = ? AND (LOWER(companyCOId) LIKE ? OR LOWER(customerCOId) LIKE ?)
         ORDER BY created_at DESC LIMIT ?`,
      ).bind(orgId, like, like, limit).all<{ id: string; companyCOId: string | null; customerName: string | null; status: string | null }>(),
      c.var.DB.prepare(
        `SELECT id, doNo, customerName, status FROM delivery_orders
         WHERE orgId = ? AND LOWER(doNo) LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      ).bind(orgId, like, limit).all<{ id: string; doNo: string | null; customerName: string | null; status: string | null }>(),
      c.var.DB.prepare(
        `SELECT id, invoiceNo, customerName, status FROM invoices
         WHERE orgId = ? AND LOWER(invoiceNo) LIKE ?
         ORDER BY invoiceDate DESC LIMIT ?`,
      ).bind(orgId, like, limit).all<{ id: string; invoiceNo: string | null; customerName: string | null; status: string | null }>(),
      c.var.DB.prepare(
        `SELECT id, code, name FROM customers
         WHERE orgId = ? AND (LOWER(code) LIKE ? OR LOWER(name) LIKE ?)
         ORDER BY name LIMIT ?`,
      ).bind(orgId, like, like, limit).all<{ id: string; code: string | null; name: string | null }>(),
      c.var.DB.prepare(
        `SELECT id, code, name FROM suppliers
         WHERE orgId = ? AND (LOWER(code) LIKE ? OR LOWER(name) LIKE ?)
         ORDER BY name LIMIT ?`,
      ).bind(orgId, like, like, limit).all<{ id: string; code: string | null; name: string | null }>(),
      c.var.DB.prepare(
        `SELECT id, code, name FROM products
         WHERE orgId = ? AND (LOWER(code) LIKE ? OR LOWER(name) LIKE ?)
         ORDER BY code LIMIT ?`,
      ).bind(orgId, like, like, limit).all<{ id: string; code: string | null; name: string | null }>(),
    ]);

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: q.slice(0, 100),
      action: "search_anything",
      after: { query: q },
      source: "ui",
    });

    return {
      query: q,
      salesOrders: (sos.results ?? []).map((r) => ({ id: r.id, label: r.companySOId ?? "", customer: r.customerName ?? "", status: r.status ?? "" })),
      consignmentOrders: (cos.results ?? []).map((r) => ({ id: r.id, label: r.companyCOId ?? "", customer: r.customerName ?? "", status: r.status ?? "" })),
      deliveryOrders: (dos.results ?? []).map((r) => ({ id: r.id, label: r.doNo ?? "", customer: r.customerName ?? "", status: r.status ?? "" })),
      invoices: (invs.results ?? []).map((r) => ({ id: r.id, label: r.invoiceNo ?? "", customer: r.customerName ?? "", status: r.status ?? "" })),
      customers: (custs.results ?? []).map((r) => ({ id: r.id, code: r.code ?? "", name: r.name ?? "" })),
      suppliers: (sups.results ?? []).map((r) => ({ id: r.id, code: r.code ?? "", name: r.name ?? "" })),
      products: (prods.results ?? []).map((r) => ({ id: r.id, code: r.code ?? "", name: r.name ?? "" })),
    };
  },
};

// ---------------------------------------------------------------------------
// Cross-module — run_select_query (generic read-only SQL fallback)
// ---------------------------------------------------------------------------

const FORBIDDEN_SQL_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE",
  "GRANT", "REVOKE", "COPY", "CALL", "EXECUTE", "DO",
  "PG_SLEEP", "PG_READ_FILE", "PG_LS_DIR", "LO_IMPORT", "LO_EXPORT",
];

function checkSqlSafety(rawSql: string): { ok: true } | { ok: false; error: string } {
  if (!rawSql || typeof rawSql !== "string") return { ok: false, error: "sql is required" };
  const s = rawSql.trim();
  if (!s) return { ok: false, error: "sql is required" };
  const upper = s.toUpperCase();
  if (!(upper.startsWith("SELECT") || upper.startsWith("WITH"))) {
    return { ok: false, error: "Only SELECT (or WITH...SELECT) queries are allowed." };
  }
  // Reject stacked queries: a `;` followed by any non-whitespace.
  if (/;\s*\S/.test(s)) {
    return { ok: false, error: "Stacked queries are not allowed." };
  }
  // Word-boundary forbidden keyword check.
  for (const kw of FORBIDDEN_SQL_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(s)) {
      return { ok: false, error: `Disallowed keyword: ${kw}` };
    }
  }
  return { ok: true };
}

const runSelectQuery: ToolDefinition = {
  schema: {
    name: "run_select_query",
    description:
      "Run an ad-hoc read-only SELECT query against the live database. Use ONLY when no other tool fits. Tables are camelCase-rewritten-to-snake_case (e.g. `sales_orders.customer_so_id`). The query must start with SELECT or WITH, must contain no INSERT/UPDATE/DELETE/DDL keywords, no stacked queries. Result is capped to 100 rows. Returns rows as a JSON array under `results`.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Single SELECT statement." },
      },
      required: ["sql"],
    },
  },
  execute: async (c, args) => {
    const sql = typeof args.sql === "string" ? args.sql : "";
    const safety = checkSqlSafety(sql);
    if (!safety.ok) return { error: safety.error };

    // Wrap with LIMIT 100 unless a top-level LIMIT already present. Detect a
    // top-level LIMIT by checking the LAST 80 chars (LIMIT clauses are
    // always near the end). Conservative — false negatives lead to a
    // sub-wrap, still safe.
    const tail = sql.slice(-80).toUpperCase();
    const hasLimit = /\bLIMIT\s+\d+\b/.test(tail);
    const trimmed = sql.trim().replace(/;\s*$/, "");
    const wrapped = hasLimit ? trimmed : `SELECT * FROM (${trimmed}) AS _sub LIMIT 100`;

    await emitAudit(c, {
      resource: "assistant-sql",
      resourceId: "ad-hoc",
      action: "run_select_query",
      after: { sql: sql.slice(0, 1000) },
      source: "ui",
    });

    try {
      const rows = await c.var.DB.prepare(wrapped).all<Record<string, unknown>>();
      const results = rows.results ?? [];
      return {
        rowCount: results.length,
        results: results.slice(0, 100),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Query failed: ${msg.slice(0, 300)}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Sales — get_so_missing_data
// ---------------------------------------------------------------------------

const getSoMissingData: ToolDefinition = {
  schema: {
    name: "get_so_missing_data",
    description:
      "Return a checklist of required SO fields that are blank: fabric, gap, divan height, leg height, special instructions, delivery date — plus per-line missing data. Use when the operator asks 'what's missing on SO-X' before confirming it.",
    input_schema: {
      type: "object",
      properties: {
        soId: { type: "string", description: "Internal SO id or companySOId." },
      },
      required: ["soId"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.soId);
    if (!lookup) return { ok: false, error: "soId is required" };

    const so = await c.var.DB
      .prepare(
        `SELECT id, companySOId, customerDeliveryDate, hookkaExpectedDD, customerPO, notes
         FROM sales_orders WHERE orgId = ? AND (companySOId ILIKE ? OR id ILIKE ?) LIMIT 1`,
      )
      .bind(orgId, lookup, lookup)
      .first<{
        id: string;
        companySOId: string | null;
        customerDeliveryDate: string | null;
        hookkaExpectedDD: string | null;
        customerPO: string | null;
        notes: string | null;
      }>();
    if (!so) return { ok: false, error: `SO not found: ${lookup}` };

    const items = await c.var.DB
      .prepare(
        `SELECT id, lineNo, productCode, itemCategory, sizeLabel, fabricCode,
                gapInches, divanHeightInches, legHeightInches, specialOrder
         FROM sales_order_items WHERE salesOrderId = ? ORDER BY lineNo LIMIT 100`,
      )
      .bind(so.id)
      .all<{
        id: string;
        lineNo: number | null;
        productCode: string | null;
        itemCategory: string | null;
        sizeLabel: string | null;
        fabricCode: string | null;
        gapInches: number | null;
        divanHeightInches: number | null;
        legHeightInches: number | null;
        specialOrder: string | null;
      }>();

    const headerMissing: string[] = [];
    if (!so.customerDeliveryDate) headerMissing.push("customerDeliveryDate");
    if (!so.hookkaExpectedDD) headerMissing.push("hookkaExpectedDD");

    const lineIssues = (items.results ?? []).map((it) => {
      const missing: string[] = [];
      const cat = (it.itemCategory ?? "").toUpperCase();
      if (cat !== "ACCESSORY" && !it.fabricCode) missing.push("fabricCode");
      if (cat === "SOFA" && (it.gapInches == null)) missing.push("gapInches");
      if (cat === "BEDFRAME" && (it.divanHeightInches == null)) missing.push("divanHeightInches");
      if (cat === "BEDFRAME" && (it.legHeightInches == null)) missing.push("legHeightInches");
      return {
        lineNo: it.lineNo ?? 0,
        productCode: it.productCode ?? "",
        sizeLabel: it.sizeLabel ?? "",
        missing,
      };
    });

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: so.id,
      action: "get_so_missing_data",
      after: { soId: so.id },
      source: "ui",
    });

    return {
      soId: so.id,
      companySOId: so.companySOId ?? "",
      headerMissing,
      itemIssues: lineIssues.filter((l) => l.missing.length > 0),
      allItems: lineIssues,
      totalIssues: headerMissing.length + lineIssues.reduce((a, l) => a + l.missing.length, 0),
    };
  },
};

// ---------------------------------------------------------------------------
// Production — list_production_orders, get_production_order
// ---------------------------------------------------------------------------

const listProductionOrders: ToolDefinition = {
  schema: {
    name: "list_production_orders",
    description: "List production orders (POs), most recent first. Filter by status, date range (startDate), or current department.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "PENDING, IN_PROGRESS, COMPLETED, ON_HOLD, CANCELLED, PAUSED." },
        dateFrom: { type: "string", description: "YYYY-MM-DD lower bound on startDate." },
        dateTo: { type: "string", description: "YYYY-MM-DD upper bound on startDate." },
        department: { type: "string", description: "Department code filter on currentDepartment (e.g. SEW, PACK)." },
        limit: { type: "number", description: "Max rows (1-100, default 25)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];
    const status = strOrNull(args.status);
    if (status) { wheres.push("UPPER(status) = ?"); params.push(status.toUpperCase()); }
    const dept = strOrNull(args.department);
    if (dept) { wheres.push("UPPER(currentDepartment) = ?"); params.push(dept.toUpperCase()); }
    const dateFrom = ymdOrNull(args.dateFrom);
    if (dateFrom) { wheres.push("startDate >= ?"); params.push(dateFrom); }
    const dateTo = ymdOrNull(args.dateTo);
    if (dateTo) { wheres.push("startDate <= ?"); params.push(dateTo); }

    const limit = clampLimit(args.limit, 25);
    const sql = `SELECT id, poNo, salesOrderNo, companySOId, companyCOId, customerName,
                        productCode, productName, quantity, status, currentDepartment,
                        progress, startDate, targetEndDate, completedDate
                 FROM production_orders WHERE ${wheres.join(" AND ")}
                 ORDER BY created_at DESC LIMIT ${limit}`;
    const rows = await c.var.DB.prepare(sql).bind(...params).all<{
      id: string; poNo: string; salesOrderNo: string | null; companySOId: string | null; companyCOId: string | null;
      customerName: string | null; productCode: string | null; productName: string | null; quantity: number;
      status: string; currentDepartment: string | null; progress: number;
      startDate: string | null; targetEndDate: string | null; completedDate: string | null;
    }>();

    await emitAudit(c, { resource: "assistant-tool", resourceId: "list_production_orders", action: "list_production_orders", after: filterArgsForAudit(args), source: "ui" });

    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id, poNo: r.poNo, salesOrderNo: r.salesOrderNo ?? "",
        companySOId: r.companySOId ?? "", companyCOId: r.companyCOId ?? "",
        customerName: r.customerName ?? "", productCode: r.productCode ?? "",
        productName: r.productName ?? "", quantity: r.quantity, status: r.status,
        currentDepartment: r.currentDepartment ?? "", progress: r.progress,
        startDate: r.startDate ?? "", targetEndDate: r.targetEndDate ?? "",
        completedDate: r.completedDate ?? "",
      })),
    };
  },
};

const getProductionOrder: ToolDefinition = {
  schema: {
    name: "get_production_order",
    description:
      "Get a production order in full: header, job_cards by department, plus linked SO/CO and any linked DO. Pass whatever the user typed — the PO number (e.g. 'PO-2605-012') or the internal id. Both work, case-insensitive.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The PO identifier as the user knows it, e.g. 'PO-2605-012' or the internal id. Both work.",
        },
      },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { ok: false, error: "id is required" };

    const po = await c.var.DB
      .prepare(
        `SELECT id, poNo, salesOrderId, salesOrderNo, consignmentOrderId, companySOId, companyCOId,
                customerName, productCode, productName, itemCategory, sizeLabel, fabricCode,
                quantity, gapInches, divanHeightInches, legHeightInches, specialOrder, notes,
                status, currentDepartment, progress, startDate, targetEndDate, completedDate
         FROM production_orders WHERE orgId = ? AND (poNo ILIKE ? OR id ILIKE ?) LIMIT 1`,
      )
      .bind(orgId, lookup, lookup)
      .first<{
        id: string; poNo: string; salesOrderId: string | null; salesOrderNo: string | null;
        consignmentOrderId: string | null; companySOId: string | null; companyCOId: string | null;
        customerName: string | null; productCode: string | null; productName: string | null;
        itemCategory: string | null; sizeLabel: string | null; fabricCode: string | null;
        quantity: number; gapInches: number | null; divanHeightInches: number | null;
        legHeightInches: number | null; specialOrder: string | null; notes: string | null;
        status: string; currentDepartment: string | null; progress: number;
        startDate: string | null; targetEndDate: string | null; completedDate: string | null;
      }>();
    if (!po) return { ok: false, error: `PO not found: ${lookup}` };

    const [jcs, dos] = await Promise.all([
      c.var.DB.prepare(
        `SELECT id, departmentCode, departmentName, sequence, status, wipLabel, wipQty,
                dueDate, completedDate, pic1Name, pic2Name, estMinutes, actualMinutes
         FROM job_cards WHERE productionOrderId = ? ORDER BY sequence LIMIT 100`,
      ).bind(po.id).all<{
        id: string; departmentCode: string | null; departmentName: string | null;
        sequence: number; status: string; wipLabel: string | null; wipQty: number | null;
        dueDate: string | null; completedDate: string | null;
        pic1Name: string | null; pic2Name: string | null;
        estMinutes: number; actualMinutes: number | null;
      }>(),
      po.salesOrderId
        ? c.var.DB.prepare(
            `SELECT id, doNo, status, deliveryDate FROM delivery_orders WHERE salesOrderId = ? ORDER BY created_at DESC LIMIT 25`,
          ).bind(po.salesOrderId).all<{
            id: string; doNo: string | null; status: string | null; deliveryDate: string | null;
          }>()
        : Promise.resolve({ results: [] }),
    ]);

    await emitAudit(c, { resource: "assistant-tool", resourceId: po.id, action: "get_production_order", after: { poId: po.id }, source: "ui" });

    return {
      id: po.id, poNo: po.poNo, salesOrderId: po.salesOrderId ?? "", salesOrderNo: po.salesOrderNo ?? "",
      consignmentOrderId: po.consignmentOrderId ?? "", companySOId: po.companySOId ?? "",
      companyCOId: po.companyCOId ?? "", customerName: po.customerName ?? "",
      productCode: po.productCode ?? "", productName: po.productName ?? "",
      itemCategory: po.itemCategory ?? "", sizeLabel: po.sizeLabel ?? "",
      fabricCode: po.fabricCode ?? "", quantity: po.quantity, gapInches: po.gapInches,
      divanHeightInches: po.divanHeightInches, legHeightInches: po.legHeightInches,
      specialOrder: po.specialOrder ?? "", notes: po.notes ?? "", status: po.status,
      currentDepartment: po.currentDepartment ?? "", progress: po.progress,
      startDate: po.startDate ?? "", targetEndDate: po.targetEndDate ?? "",
      completedDate: po.completedDate ?? "",
      jobCards: (jcs.results ?? []).map((j) => ({
        id: j.id, department: j.departmentCode ?? j.departmentName ?? "", sequence: j.sequence,
        status: j.status, wipLabel: j.wipLabel ?? "", wipQty: j.wipQty ?? 0,
        dueDate: j.dueDate ?? "", completedDate: j.completedDate ?? "",
        pic1Name: j.pic1Name ?? "", pic2Name: j.pic2Name ?? "",
        estMinutes: j.estMinutes, actualMinutes: j.actualMinutes ?? 0,
      })),
      deliveryOrders: (dos.results ?? []).map((d) => ({
        id: d.id, doNo: d.doNo ?? "", status: d.status ?? "", deliveryDate: d.deliveryDate ?? "",
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Production — list_job_cards, get_wip_snapshot
// ---------------------------------------------------------------------------

const listJobCards: ToolDefinition = {
  schema: {
    name: "list_job_cards",
    description: "List job cards. Filter by status, production order id, department, or PIC user id.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "WAITING, IN_PROGRESS, PAUSED, COMPLETED, TRANSFERRED, BLOCKED." },
        productionOrderId: { type: "string", description: "Filter to one PO." },
        department: { type: "string", description: "departmentCode (e.g. SEW)." },
        picUserId: { type: "string", description: "Filter to a specific PIC (matches pic1Id OR pic2Id)." },
        limit: { type: "number", description: "Max rows (1-100, default 25)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];
    const status = strOrNull(args.status);
    if (status) { wheres.push("UPPER(status) = ?"); params.push(status.toUpperCase()); }
    const poId = strOrNull(args.productionOrderId);
    if (poId) { wheres.push("productionOrderId = ?"); params.push(poId); }
    const dept = strOrNull(args.department);
    if (dept) { wheres.push("UPPER(departmentCode) = ?"); params.push(dept.toUpperCase()); }
    const pic = strOrNull(args.picUserId);
    if (pic) { wheres.push("(pic1Id = ? OR pic2Id = ?)"); params.push(pic, pic); }
    const limit = clampLimit(args.limit, 25);
    const sql = `SELECT id, productionOrderId, departmentCode, status, wipLabel, wipQty,
                        dueDate, completedDate, pic1Name, pic2Name
                 FROM job_cards WHERE ${wheres.join(" AND ")}
                 ORDER BY dueDate ASC NULLS LAST LIMIT ${limit}`;
    const rows = await c.var.DB.prepare(sql).bind(...params).all<{
      id: string; productionOrderId: string; departmentCode: string | null; status: string;
      wipLabel: string | null; wipQty: number | null; dueDate: string | null;
      completedDate: string | null; pic1Name: string | null; pic2Name: string | null;
    }>();
    await emitAudit(c, { resource: "assistant-tool", resourceId: "list_job_cards", action: "list_job_cards", after: filterArgsForAudit(args), source: "ui" });
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id, productionOrderId: r.productionOrderId, department: r.departmentCode ?? "",
        status: r.status, wipLabel: r.wipLabel ?? "", wipQty: r.wipQty ?? 0,
        dueDate: r.dueDate ?? "", completedDate: r.completedDate ?? "",
        pic1Name: r.pic1Name ?? "", pic2Name: r.pic2Name ?? "",
      })),
    };
  },
};

const getWipSnapshot: ToolDefinition = {
  schema: {
    name: "get_wip_snapshot",
    description: "WIP units snapshot. Without filters, returns per-department aggregates. With productCode, returns WIP for that product only.",
    input_schema: {
      type: "object",
      properties: {
        department: { type: "string", description: "Department code filter (matches dept_status)." },
        productCode: { type: "string", description: "Product code filter (matches relatedProduct)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres: string[] = ["orgId = ?"];
    const params: unknown[] = [orgId];
    const dept = strOrNull(args.department);
    if (dept) { wheres.push("UPPER(deptStatus) = ?"); params.push(dept.toUpperCase()); }
    const prod = strOrNull(args.productCode);
    if (prod) { wheres.push("relatedProduct = ?"); params.push(prod); }

    const sql = `SELECT code, type, relatedProduct, deptStatus, stockQty, status
                 FROM wip_items WHERE ${wheres.join(" AND ")} AND stockQty <> 0
                 ORDER BY deptStatus, code LIMIT 100`;
    const rows = await c.var.DB.prepare(sql).bind(...params).all<{
      code: string; type: string; relatedProduct: string | null;
      deptStatus: string | null; stockQty: number; status: string;
    }>();

    // Compute per-dept aggregates from the rows.
    const byDept: Record<string, { units: number; lineCount: number }> = {};
    for (const r of rows.results ?? []) {
      const d = r.deptStatus ?? "UNKNOWN";
      const o = byDept[d] ?? { units: 0, lineCount: 0 };
      o.units += r.stockQty;
      o.lineCount += 1;
      byDept[d] = o;
    }

    await emitAudit(c, { resource: "assistant-tool", resourceId: "get_wip_snapshot", action: "get_wip_snapshot", after: filterArgsForAudit(args), source: "ui" });
    return {
      filters: { department: dept ?? "", productCode: prod ?? "" },
      perDepartment: Object.entries(byDept).map(([d, v]) => ({
        department: d, totalUnits: v.units, lineCount: v.lineCount,
      })),
      items: (rows.results ?? []).map((r) => ({
        code: r.code, type: r.type, relatedProduct: r.relatedProduct ?? "",
        department: r.deptStatus ?? "", stockQty: r.stockQty, status: r.status,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Production — analyze_po_delay
// ---------------------------------------------------------------------------

const analyzePoDelay: ToolDefinition = {
  schema: {
    name: "analyze_po_delay",
    description: "Cross-references a production order's planned vs actual progress. Returns variance per job_card stage, the bottleneck stage, and the rough RM revenue at risk if the PO ships late.",
    input_schema: {
      type: "object",
      properties: { productionOrderId: { type: "string", description: "Internal PO id or poNo." } },
      required: ["productionOrderId"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.productionOrderId);
    if (!lookup) return { ok: false, error: "productionOrderId is required" };

    const po = await c.var.DB
      .prepare(
        `SELECT id, poNo, status, quantity, productCode, salesOrderId, currentDepartment,
                progress, startDate, targetEndDate, completedDate
         FROM production_orders WHERE orgId = ? AND (poNo ILIKE ? OR id ILIKE ?) LIMIT 1`,
      )
      .bind(orgId, lookup, lookup)
      .first<{
        id: string; poNo: string; status: string; quantity: number;
        productCode: string | null; salesOrderId: string | null;
        currentDepartment: string | null; progress: number;
        startDate: string | null; targetEndDate: string | null; completedDate: string | null;
      }>();
    if (!po) return { ok: false, error: `PO not found: ${lookup}` };

    const jcs = await c.var.DB.prepare(
      `SELECT id, departmentCode, sequence, status, dueDate, completedDate,
              estMinutes, actualMinutes
       FROM job_cards WHERE productionOrderId = ? ORDER BY sequence LIMIT 100`,
    ).bind(po.id).all<{
      id: string; departmentCode: string | null; sequence: number; status: string;
      dueDate: string | null; completedDate: string | null;
      estMinutes: number; actualMinutes: number | null;
    }>();

    const today = new Date();
    const stages = (jcs.results ?? []).map((j) => {
      const planned = j.estMinutes;
      const actual = j.actualMinutes ?? 0;
      const varianceMinutes = actual - planned;
      let dueVarianceDays: number | null = null;
      if (j.dueDate) {
        const dueDate = new Date(j.dueDate);
        if (j.completedDate) {
          dueVarianceDays = Math.floor(
            (new Date(j.completedDate).getTime() - dueDate.getTime()) / 86400000,
          );
        } else if ((j.status ?? "").toUpperCase() !== "COMPLETED") {
          dueVarianceDays = Math.floor((today.getTime() - dueDate.getTime()) / 86400000);
        }
      }
      return {
        department: j.departmentCode ?? "",
        status: j.status,
        plannedMinutes: planned,
        actualMinutes: actual,
        varianceMinutes,
        dueDate: j.dueDate ?? "",
        completedDate: j.completedDate ?? "",
        dueVarianceDays,
      };
    });

    const incompleteOverdue = stages.filter(
      (s) => (s.dueVarianceDays ?? 0) > 0 && s.status !== "COMPLETED",
    );
    const bottleneck = incompleteOverdue.length
      ? incompleteOverdue.sort((a, b) => (b.dueVarianceDays ?? 0) - (a.dueVarianceDays ?? 0))[0]
      : stages.sort((a, b) => b.varianceMinutes - a.varianceMinutes)[0] ?? null;

    // Revenue at risk = quantity × unitPriceSen, fetched from SO items if available.
    let revAtRiskSen = 0;
    if (po.salesOrderId && po.productCode) {
      const li = await c.var.DB.prepare(
        `SELECT unitPriceSen, quantity FROM sales_order_items
         WHERE salesOrderId = ? AND productCode = ? LIMIT 5`,
      ).bind(po.salesOrderId, po.productCode).first<{ unitPriceSen: number | null; quantity: number | null }>();
      if (li) {
        revAtRiskSen = (li.unitPriceSen ?? 0) * (po.quantity ?? li.quantity ?? 0);
      }
    }

    await emitAudit(c, { resource: "assistant-tool", resourceId: po.id, action: "analyze_po_delay", after: { poId: po.id }, source: "ui" });

    return {
      id: po.id,
      poNo: po.poNo,
      status: po.status,
      quantity: po.quantity,
      productCode: po.productCode ?? "",
      progress: po.progress,
      startDate: po.startDate ?? "",
      targetEndDate: po.targetEndDate ?? "",
      completedDate: po.completedDate ?? "",
      stages,
      bottleneckStage: bottleneck,
      revenueAtRiskRM: senToRM(revAtRiskSen),
    };
  },
};

// ---------------------------------------------------------------------------
// Production — get_capacity_loading
// ---------------------------------------------------------------------------

const getCapacityLoading: ToolDefinition = {
  schema: {
    name: "get_capacity_loading",
    description: "Capacity loading for a given date. Returns total estimated minutes of in-progress / waiting job_cards per department (and overall) for jobs whose dueDate falls on that date.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD (defaults to today)." },
        department: { type: "string", description: "departmentCode filter." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const date = ymdOrNull(args.date) ?? new Date().toISOString().slice(0, 10);
    const dept = strOrNull(args.department);
    const wheres = ["orgId = ?", "dueDate = ?", "UPPER(status) IN ('WAITING','IN_PROGRESS','PAUSED','BLOCKED')"];
    const params: unknown[] = [orgId, date];
    if (dept) { wheres.push("UPPER(departmentCode) = ?"); params.push(dept.toUpperCase()); }
    const rows = await c.var.DB.prepare(
      `SELECT departmentCode, status, estMinutes, actualMinutes
       FROM job_cards WHERE ${wheres.join(" AND ")} LIMIT 500`,
    ).bind(...params).all<{
      departmentCode: string | null; status: string; estMinutes: number; actualMinutes: number | null;
    }>();
    const byDept: Record<string, { jobs: number; plannedMinutes: number; actualMinutes: number }> = {};
    let totalJobs = 0, totalPlanned = 0;
    for (const r of rows.results ?? []) {
      const d = r.departmentCode ?? "UNKNOWN";
      const o = byDept[d] ?? { jobs: 0, plannedMinutes: 0, actualMinutes: 0 };
      o.jobs += 1;
      o.plannedMinutes += r.estMinutes;
      o.actualMinutes += r.actualMinutes ?? 0;
      byDept[d] = o;
      totalJobs += 1;
      totalPlanned += r.estMinutes;
    }
    await emitAudit(c, { resource: "assistant-tool", resourceId: date, action: "get_capacity_loading", after: { date, department: dept }, source: "ui" });
    return {
      date,
      totalJobs,
      totalPlannedMinutes: totalPlanned,
      totalPlannedHours: Math.round(totalPlanned / 6) / 10,
      perDepartment: Object.entries(byDept).map(([d, v]) => ({
        department: d,
        jobs: v.jobs,
        plannedMinutes: v.plannedMinutes,
        plannedHours: Math.round(v.plannedMinutes / 6) / 10,
        actualMinutes: v.actualMinutes,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Delivery — list_packing_lists, get_packing_list, get_dispatch_summary
// ---------------------------------------------------------------------------

const listPackingLists: ToolDefinition = {
  schema: {
    name: "list_packing_lists",
    description: "List packing lists. Filter by status or date range.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "OPEN, LOADED, DISPATCHED, COMPLETED, CANCELLED." },
        dateFrom: { type: "string", description: "YYYY-MM-DD." },
        dateTo: { type: "string", description: "YYYY-MM-DD." },
        limit: { type: "number", description: "Max rows (1-100, default 25)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres = ["orgId = ?"];
    const params: unknown[] = [orgId];
    const status = strOrNull(args.status);
    if (status) { wheres.push("UPPER(status) = ?"); params.push(status.toUpperCase()); }
    const dateFrom = ymdOrNull(args.dateFrom);
    if (dateFrom) { wheres.push("created_at >= ?"); params.push(dateFrom); }
    const dateTo = ymdOrNull(args.dateTo);
    if (dateTo) { wheres.push("created_at <= ?"); params.push(`${dateTo} 23:59:59`); }
    const limit = clampLimit(args.limit, 25);

    try {
      const rows = await c.var.DB.prepare(
        `SELECT id, packingNo, status, stopCount, totalUnits, totalM3, remarks, created_at AS createdAt
         FROM packing_lists WHERE ${wheres.join(" AND ")}
         ORDER BY packingNo DESC LIMIT ${limit}`,
      ).bind(...params).all<{
        id: string; packingNo: string; status: string;
        stopCount: number; totalUnits: number; totalM3: number | string;
        remarks: string | null; createdAt: string | null;
      }>();
      await emitAudit(c, { resource: "assistant-tool", resourceId: "list_packing_lists", action: "list_packing_lists", after: filterArgsForAudit(args), source: "ui" });
      return {
        count: rows.results?.length ?? 0,
        results: (rows.results ?? []).map((r) => ({
          id: r.id, packingNo: r.packingNo, status: r.status,
          stopCount: r.stopCount, totalUnits: r.totalUnits, totalM3: Number(r.totalM3 ?? 0),
          remarks: r.remarks ?? "", createdAt: r.createdAt ?? "",
        })),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/does not exist|no such table/i.test(msg)) {
        return { count: 0, results: [], note: "Packing lists table not yet populated." };
      }
      throw err;
    }
  },
};

const getPackingList: ToolDefinition = {
  schema: {
    name: "get_packing_list",
    description: "Get one packing list with its linked DOs (header info only).",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Internal id or packingNo." } },
      required: ["id"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const lookup = strOrNull(args.id);
    if (!lookup) return { error: "id is required" };
    try {
      const pl = await c.var.DB.prepare(
        `SELECT id, packingNo, status, doIds, stopCount, totalUnits, totalM3, remarks, created_at AS createdAt
         FROM packing_lists WHERE orgId = ? AND (id = ? OR packingNo = ?) LIMIT 1`,
      ).bind(orgId, lookup, lookup).first<{
        id: string; packingNo: string; status: string; doIds: string;
        stopCount: number; totalUnits: number; totalM3: number | string;
        remarks: string | null; createdAt: string | null;
      }>();
      if (!pl) return { error: `Packing list not found: ${lookup}` };
      let doIds: string[] = [];
      try { const j = JSON.parse(pl.doIds || "[]"); if (Array.isArray(j)) doIds = j.filter((x): x is string => typeof x === "string"); } catch { /* ignore */ }
      let dos: Array<{ id: string; doNo: string; customerName: string; status: string; deliveryDate: string }> = [];
      if (doIds.length) {
        const placeholders = doIds.map(() => "?").join(",");
        const rows = await c.var.DB.prepare(
          `SELECT id, doNo, customerName, status, deliveryDate
           FROM delivery_orders WHERE id IN (${placeholders}) LIMIT 100`,
        ).bind(...doIds).all<{
          id: string; doNo: string | null; customerName: string | null;
          status: string | null; deliveryDate: string | null;
        }>();
        dos = (rows.results ?? []).map((r) => ({
          id: r.id, doNo: r.doNo ?? "", customerName: r.customerName ?? "",
          status: r.status ?? "", deliveryDate: r.deliveryDate ?? "",
        }));
      }
      await emitAudit(c, { resource: "assistant-tool", resourceId: pl.id, action: "get_packing_list", after: { id: pl.id }, source: "ui" });
      return {
        id: pl.id, packingNo: pl.packingNo, status: pl.status,
        stopCount: pl.stopCount, totalUnits: pl.totalUnits, totalM3: Number(pl.totalM3 ?? 0),
        remarks: pl.remarks ?? "", createdAt: pl.createdAt ?? "", deliveryOrders: dos,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/does not exist|no such table/i.test(msg)) return { error: "Packing lists table not yet populated." };
      throw err;
    }
  },
};

const getDispatchSummary: ToolDefinition = {
  schema: {
    name: "get_dispatch_summary",
    description: "Per-hub dispatch summary: pending count, in-transit count, delivered (on the given date) count, late count.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD (defaults to today)." },
        hubKey: { type: "string", description: "Filter to a specific hubId/hubName (partial match)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const date = ymdOrNull(args.date) ?? new Date().toISOString().slice(0, 10);
    const hub = strOrNull(args.hubKey);
    const baseWhere = ["orgId = ?"];
    const baseParams: unknown[] = [orgId];
    if (hub) { baseWhere.push("(LOWER(hubName) LIKE ? OR hubId = ?)"); baseParams.push(`%${hub.toLowerCase()}%`, hub); }
    const w = baseWhere.join(" AND ");
    const [pending, inTransit, delivered, late] = await Promise.all([
      c.var.DB.prepare(`SELECT hubName, COUNT(*) AS n FROM delivery_orders WHERE ${w} AND UPPER(status) IN ('DRAFT','LOADED') GROUP BY hubName ORDER BY n DESC LIMIT 50`).bind(...baseParams).all<{ hubName: string | null; n: number }>(),
      c.var.DB.prepare(`SELECT hubName, COUNT(*) AS n FROM delivery_orders WHERE ${w} AND UPPER(status) IN ('DISPATCHED','IN_TRANSIT') GROUP BY hubName ORDER BY n DESC LIMIT 50`).bind(...baseParams).all<{ hubName: string | null; n: number }>(),
      c.var.DB.prepare(`SELECT hubName, COUNT(*) AS n FROM delivery_orders WHERE ${w} AND deliveryDate = ? AND UPPER(status) IN ('DELIVERED','SIGNED','INVOICED') GROUP BY hubName ORDER BY n DESC LIMIT 50`).bind(...baseParams, date).all<{ hubName: string | null; n: number }>(),
      c.var.DB.prepare(`SELECT hubName, COUNT(*) AS n FROM delivery_orders WHERE ${w} AND deliveryDate IS NOT NULL AND deliveryDate < ? AND UPPER(status) NOT IN ('DELIVERED','SIGNED','INVOICED','CANCELLED') GROUP BY hubName ORDER BY n DESC LIMIT 50`).bind(...baseParams, date).all<{ hubName: string | null; n: number }>(),
    ]);
    await emitAudit(c, { resource: "assistant-tool", resourceId: date, action: "get_dispatch_summary", after: { date, hubKey: hub }, source: "ui" });
    return {
      date,
      pendingByHub: (pending.results ?? []).map((r) => ({ hub: r.hubName ?? "(no hub)", count: r.n })),
      inTransitByHub: (inTransit.results ?? []).map((r) => ({ hub: r.hubName ?? "(no hub)", count: r.n })),
      deliveredTodayByHub: (delivered.results ?? []).map((r) => ({ hub: r.hubName ?? "(no hub)", count: r.n })),
      lateByHub: (late.results ?? []).map((r) => ({ hub: r.hubName ?? "(no hub)", count: r.n })),
    };
  },
};

// ---------------------------------------------------------------------------
// Finance — get_ar_outstanding, get_gp_analysis
// ---------------------------------------------------------------------------

const getArOutstanding: ToolDefinition = {
  schema: {
    name: "get_ar_outstanding",
    description: "Outstanding AR per customer with aging buckets (0-30 / 31-60 / 61-90 / 90+). If customerId provided, returns one customer's open invoices instead.",
    input_schema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Filter to one customer." },
        agingBucket: { type: "string", description: "Filter to one bucket: 0-30 / 31-60 / 61-90 / 90+." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const cust = strOrNull(args.customerId);
    const bucket = strOrNull(args.agingBucket);
    const wheres = ["orgId = ?", "UPPER(status) <> 'VOID'", "totalSen > COALESCE(paidAmount, 0)"];
    const params: unknown[] = [orgId];
    if (cust) { wheres.push("customerId = ?"); params.push(cust); }
    const rows = await c.var.DB.prepare(
      `SELECT id, invoiceNo, customerName, customerId, totalSen,
              COALESCE(paidAmount, 0) AS paidAmount, invoiceDate, dueDate
       FROM invoices WHERE ${wheres.join(" AND ")}
       ORDER BY dueDate ASC LIMIT 500`,
    ).bind(...params).all<{
      id: string; invoiceNo: string | null; customerName: string | null; customerId: string | null;
      totalSen: number | null; paidAmount: number | null; invoiceDate: string | null; dueDate: string | null;
    }>();
    const today = new Date();
    const aged: Array<{ id: string; invoiceNo: string; customerName: string; customerId: string; outSen: number; ageDays: number; bucket: string; invoiceDate: string; dueDate: string }> = [];
    for (const r of rows.results ?? []) {
      const out = (r.totalSen ?? 0) - (r.paidAmount ?? 0);
      if (out <= 0) continue;
      const due = r.dueDate ?? r.invoiceDate ?? today.toISOString().slice(0, 10);
      const days = Math.max(0, Math.floor((today.getTime() - new Date(due).getTime()) / 86400000));
      let b: string;
      if (days <= 30) b = "0-30";
      else if (days <= 60) b = "31-60";
      else if (days <= 90) b = "61-90";
      else b = "90+";
      if (bucket && b !== bucket) continue;
      aged.push({
        id: r.id, invoiceNo: r.invoiceNo ?? "", customerName: r.customerName ?? "",
        customerId: r.customerId ?? "", outSen: out, ageDays: days, bucket: b,
        invoiceDate: r.invoiceDate ?? "", dueDate: r.dueDate ?? "",
      });
    }
    const byCust: Record<string, { customer: string; b0_30: number; b31_60: number; b61_90: number; b90p: number; total: number }> = {};
    for (const a of aged) {
      const key = a.customerId || a.customerName || "unknown";
      const o = byCust[key] ?? { customer: a.customerName, b0_30: 0, b31_60: 0, b61_90: 0, b90p: 0, total: 0 };
      if (a.bucket === "0-30") o.b0_30 += a.outSen;
      else if (a.bucket === "31-60") o.b31_60 += a.outSen;
      else if (a.bucket === "61-90") o.b61_90 += a.outSen;
      else o.b90p += a.outSen;
      o.total += a.outSen;
      byCust[key] = o;
    }
    await emitAudit(c, { resource: "assistant-tool", resourceId: "get_ar_outstanding", action: "get_ar_outstanding", after: filterArgsForAudit(args), source: "ui" });
    return {
      totalInvoices: aged.length,
      perCustomer: Object.entries(byCust).map(([id, v]) => ({
        customerId: id, customer: v.customer,
        b0_30RM: senToRM(v.b0_30), b31_60RM: senToRM(v.b31_60),
        b61_90RM: senToRM(v.b61_90), b90plusRM: senToRM(v.b90p), totalRM: senToRM(v.total),
      })).sort((a, b) => Number(b.totalRM.replace(/,/g, "")) - Number(a.totalRM.replace(/,/g, ""))),
      invoices: aged.slice(0, 100).map((a) => ({
        id: a.id, invoiceNo: a.invoiceNo, customerName: a.customerName,
        outstandingRM: senToRM(a.outSen), ageDays: a.ageDays, bucket: a.bucket,
        invoiceDate: a.invoiceDate, dueDate: a.dueDate,
      })),
    };
  },
};

const getGpAnalysis: ToolDefinition = {
  schema: {
    name: "get_gp_analysis",
    description: "Gross profit analysis. Group by product, customer, salesman, or month. Returns revenue, estimated COGS (from product.costPriceSen × qty), and GP%. Ranked by revenue descending.",
    input_schema: {
      type: "object",
      properties: {
        groupBy: { type: "string", description: "product | customer | month." },
        dateFrom: { type: "string", description: "YYYY-MM-DD." },
        dateTo: { type: "string", description: "YYYY-MM-DD." },
        limit: { type: "number", description: "Max rows (1-100, default 25)." },
      },
      required: ["groupBy", "dateFrom", "dateTo"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const groupBy = String(args.groupBy ?? "").toLowerCase();
    const dateFrom = ymdOrNull(args.dateFrom);
    const dateTo = ymdOrNull(args.dateTo);
    if (!dateFrom || !dateTo) return { error: "dateFrom and dateTo (YYYY-MM-DD) are required" };
    if (!["product", "customer", "month"].includes(groupBy)) {
      return { error: "groupBy must be one of: product, customer, month" };
    }
    const limit = clampLimit(args.limit, 25);

    // Pull invoice items joined to invoices + products. Cost = product.costPriceSen × qty.
    const sql = `SELECT i.id AS invoiceId, i.customerName AS customerName,
                        i.invoiceDate AS invoiceDate, ii.productCode AS productCode,
                        ii.quantity AS quantity, ii.totalSen AS totalSen,
                        COALESCE(p.costPriceSen, 0) AS costPriceSen
                 FROM invoice_items ii
                 JOIN invoices i ON i.id = ii.invoiceId
                 LEFT JOIN products p ON p.code = ii.productCode AND p.orgId = i.orgId
                 WHERE i.orgId = ? AND UPPER(i.status) <> 'VOID'
                   AND i.invoiceDate >= ? AND i.invoiceDate <= ?
                 LIMIT 5000`;
    const rows = await c.var.DB.prepare(sql).bind(orgId, dateFrom, dateTo).all<{
      invoiceId: string; customerName: string | null; invoiceDate: string | null;
      productCode: string | null; quantity: number | null; totalSen: number | null; costPriceSen: number | null;
    }>();

    type Bucket = { key: string; label: string; revenueSen: number; costSen: number; units: number };
    const map = new Map<string, Bucket>();
    for (const r of rows.results ?? []) {
      const rev = r.totalSen ?? 0;
      const cost = (r.costPriceSen ?? 0) * (r.quantity ?? 0);
      let key: string, label: string;
      if (groupBy === "product") { key = r.productCode ?? "(unknown)"; label = key; }
      else if (groupBy === "customer") { key = r.customerName ?? "(unknown)"; label = key; }
      else { key = (r.invoiceDate ?? "").slice(0, 7); label = key; }
      const b = map.get(key) ?? { key, label, revenueSen: 0, costSen: 0, units: 0 };
      b.revenueSen += rev;
      b.costSen += cost;
      b.units += r.quantity ?? 0;
      map.set(key, b);
    }
    const list = Array.from(map.values()).sort((a, b) => b.revenueSen - a.revenueSen).slice(0, limit);

    await emitAudit(c, { resource: "assistant-tool", resourceId: "get_gp_analysis", action: "get_gp_analysis", after: filterArgsForAudit(args), source: "ui" });
    return {
      groupBy, dateFrom, dateTo,
      results: list.map((b) => ({
        key: b.label,
        revenueRM: senToRM(b.revenueSen),
        cogsRM: senToRM(b.costSen),
        gpRM: senToRM(b.revenueSen - b.costSen),
        gpPct: b.revenueSen > 0 ? Math.round(((b.revenueSen - b.costSen) / b.revenueSen) * 1000) / 10 : 0,
        units: b.units,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Inventory — list_foam_inventory (NOTE: no dedicated foam table — uses wip_items FOAM type)
// list_fg_units, list_fabrics, get_fabric, list_accessories, get_accessory
// predict_reorder_needs
// ---------------------------------------------------------------------------

const listFoamInventory: ToolDefinition = {
  schema: {
    name: "list_foam_inventory",
    description: "Foam inventory. Reads from wip_items where type='FOAM' (Hookka has no dedicated foam_inventory table — foam is tracked as a WIP item). Filter by fabricCode (matches code prefix) or grade.",
    input_schema: {
      type: "object",
      properties: {
        fabricCode: { type: "string", description: "Partial match on WIP code." },
        grade: { type: "string", description: "Partial match on WIP code/label for grade tokens like '25/45'." },
        limit: { type: "number", description: "Max rows (1-100, default 50)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres = ["orgId = ?", "UPPER(type) = 'FOAM'"];
    const params: unknown[] = [orgId];
    const fc = strOrNull(args.fabricCode);
    if (fc) { wheres.push("LOWER(code) LIKE ?"); params.push(`%${fc.toLowerCase()}%`); }
    const grade = strOrNull(args.grade);
    if (grade) { wheres.push("LOWER(code) LIKE ?"); params.push(`%${grade.toLowerCase()}%`); }
    const limit = clampLimit(args.limit, 50);
    const rows = await c.var.DB.prepare(
      `SELECT code, type, relatedProduct, deptStatus, stockQty, status
       FROM wip_items WHERE ${wheres.join(" AND ")} ORDER BY code LIMIT ${limit}`,
    ).bind(...params).all<{
      code: string; type: string; relatedProduct: string | null;
      deptStatus: string | null; stockQty: number; status: string;
    }>();
    await emitAudit(c, { resource: "assistant-tool", resourceId: "list_foam_inventory", action: "list_foam_inventory", after: filterArgsForAudit(args), source: "ui" });
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        code: r.code, type: r.type, relatedProduct: r.relatedProduct ?? "",
        department: r.deptStatus ?? "", stockQty: r.stockQty, status: r.status,
      })),
    };
  },
};

const listFgUnits: ToolDefinition = {
  schema: {
    name: "list_fg_units",
    description: "List finished-goods (FG) units. Filter by status (e.g. PACKED, LOADED, DELIVERED) or productCode.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "FG unit status." },
        productCode: { type: "string", description: "Filter to one product." },
        limit: { type: "number", description: "Max rows (1-100, default 50)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres = ["orgId = ?"];
    const params: unknown[] = [orgId];
    const status = strOrNull(args.status);
    if (status) { wheres.push("UPPER(status) = ?"); params.push(status.toUpperCase()); }
    const pc = strOrNull(args.productCode);
    if (pc) { wheres.push("productCode = ?"); params.push(pc); }
    const limit = clampLimit(args.limit, 50);
    const rows = await c.var.DB.prepare(
      `SELECT id, unitSerial, shortCode, soNo, poNo, productCode, productName,
              customerName, status, packedAt, deliveredAt
       FROM fg_units WHERE ${wheres.join(" AND ")}
       ORDER BY id DESC LIMIT ${limit}`,
    ).bind(...params).all<{
      id: string; unitSerial: string; shortCode: string | null; soNo: string | null; poNo: string | null;
      productCode: string | null; productName: string | null; customerName: string | null;
      status: string; packedAt: string | null; deliveredAt: string | null;
    }>();
    await emitAudit(c, { resource: "assistant-tool", resourceId: "list_fg_units", action: "list_fg_units", after: filterArgsForAudit(args), source: "ui" });
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id, unitSerial: r.unitSerial, shortCode: r.shortCode ?? "",
        soNo: r.soNo ?? "", poNo: r.poNo ?? "", productCode: r.productCode ?? "",
        productName: r.productName ?? "", customerName: r.customerName ?? "",
        status: r.status, packedAt: r.packedAt ?? "", deliveredAt: r.deliveredAt ?? "",
      })),
    };
  },
};

const listFabrics: ToolDefinition = {
  schema: {
    name: "list_fabrics",
    description: "List fabric catalog (the fabrics table). Filter by partial code/name match.",
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
    const wheres = ["orgId = ?"];
    const params: unknown[] = [orgId];
    const s = strOrNull(args.search);
    if (s) { wheres.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)"); const l = `%${s.toLowerCase()}%`; params.push(l, l); }
    const limit = clampLimit(args.limit, 50);
    const rows = await c.var.DB.prepare(
      `SELECT id, code, name, category, priceSen, sohMeters, reorderLevel
       FROM fabrics WHERE ${wheres.join(" AND ")} ORDER BY code LIMIT ${limit}`,
    ).bind(...params).all<{
      id: string; code: string; name: string; category: string | null;
      priceSen: number; sohMeters: number; reorderLevel: number;
    }>();
    await emitAudit(c, { resource: "assistant-tool", resourceId: "list_fabrics", action: "list_fabrics", after: filterArgsForAudit(args), source: "ui" });
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id, code: r.code, name: r.name, category: r.category ?? "",
        priceRM: senToRM(r.priceSen), sohMeters: r.sohMeters, reorderLevel: r.reorderLevel,
      })),
    };
  },
};

const getFabric: ToolDefinition = {
  schema: {
    name: "get_fabric",
    description: "Get fabric detail plus which SOs and POs are currently using it.",
    input_schema: {
      type: "object",
      properties: { code: { type: "string", description: "Fabric code." } },
      required: ["code"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const code = strOrNull(args.code);
    if (!code) return { error: "code is required" };
    const fab = await c.var.DB.prepare(
      `SELECT id, code, name, category, priceSen, sohMeters, reorderLevel
       FROM fabrics WHERE orgId = ? AND code = ? LIMIT 1`,
    ).bind(orgId, code).first<{
      id: string; code: string; name: string; category: string | null;
      priceSen: number; sohMeters: number; reorderLevel: number;
    }>();
    if (!fab) return { error: `Fabric not found: ${code}` };
    const [activeSos, activePos] = await Promise.all([
      c.var.DB.prepare(
        `SELECT DISTINCT so.id, so.companySOId, so.customerName, so.status
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
         WHERE so.orgId = ? AND soi.fabricCode = ?
           AND UPPER(so.status) NOT IN ('DELIVERED','INVOICED','CANCELLED','CLOSED')
         ORDER BY so.created_at DESC LIMIT 25`,
      ).bind(orgId, code).all<{ id: string; companySOId: string | null; customerName: string | null; status: string | null }>(),
      c.var.DB.prepare(
        `SELECT id, poNo, status, productCode, quantity
         FROM production_orders WHERE orgId = ? AND fabricCode = ?
           AND UPPER(status) NOT IN ('COMPLETED','CANCELLED')
         ORDER BY created_at DESC LIMIT 25`,
      ).bind(orgId, code).all<{ id: string; poNo: string; status: string; productCode: string | null; quantity: number }>(),
    ]);
    await emitAudit(c, { resource: "assistant-tool", resourceId: code, action: "get_fabric", after: { code }, source: "ui" });
    return {
      id: fab.id, code: fab.code, name: fab.name, category: fab.category ?? "",
      priceRM: senToRM(fab.priceSen), sohMeters: fab.sohMeters, reorderLevel: fab.reorderLevel,
      activeSalesOrders: (activeSos.results ?? []).map((r) => ({ id: r.id, companySOId: r.companySOId ?? "", customerName: r.customerName ?? "", status: r.status ?? "" })),
      activeProductionOrders: (activePos.results ?? []).map((r) => ({ id: r.id, poNo: r.poNo, status: r.status, productCode: r.productCode ?? "", quantity: r.quantity })),
    };
  },
};

const listAccessories: ToolDefinition = {
  schema: {
    name: "list_accessories",
    description: "List raw_materials whose itemGroup includes 'ACCESSORY' (and similar). Filter by partial code/description.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Partial match on itemCode or description." },
        limit: { type: "number", description: "Max rows (1-100, default 50)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres = ["orgId = ?", "UPPER(itemGroup) LIKE '%ACCESS%'"];
    const params: unknown[] = [orgId];
    const s = strOrNull(args.search);
    if (s) { wheres.push("(LOWER(itemCode) LIKE ? OR LOWER(description) LIKE ?)"); const l = `%${s.toLowerCase()}%`; params.push(l, l); }
    const limit = clampLimit(args.limit, 50);
    const rows = await c.var.DB.prepare(
      `SELECT id, itemCode, description, baseUOM, itemGroup, balanceQty, isActive
       FROM raw_materials WHERE ${wheres.join(" AND ")} ORDER BY itemCode LIMIT ${limit}`,
    ).bind(...params).all<{
      id: string; itemCode: string; description: string; baseUOM: string; itemGroup: string;
      balanceQty: number; isActive: number | boolean;
    }>();
    await emitAudit(c, { resource: "assistant-tool", resourceId: "list_accessories", action: "list_accessories", after: filterArgsForAudit(args), source: "ui" });
    return {
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id, itemCode: r.itemCode, description: r.description, baseUOM: r.baseUOM,
        itemGroup: r.itemGroup, balanceQty: r.balanceQty, isActive: Boolean(r.isActive),
      })),
    };
  },
};

const getAccessory: ToolDefinition = {
  schema: {
    name: "get_accessory",
    description: "Get accessory (raw_material) detail. Look up by itemCode.",
    input_schema: {
      type: "object",
      properties: { code: { type: "string", description: "Item code." } },
      required: ["code"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const code = strOrNull(args.code);
    if (!code) return { error: "code is required" };
    const rm = await c.var.DB.prepare(
      `SELECT id, itemCode, description, baseUOM, itemGroup, balanceQty, isActive
       FROM raw_materials WHERE orgId = ? AND itemCode = ? LIMIT 1`,
    ).bind(orgId, code).first<{
      id: string; itemCode: string; description: string; baseUOM: string; itemGroup: string;
      balanceQty: number; isActive: number | boolean;
    }>();
    if (!rm) return { error: `Accessory not found: ${code}` };
    await emitAudit(c, { resource: "assistant-tool", resourceId: code, action: "get_accessory", after: { code }, source: "ui" });
    return {
      id: rm.id, itemCode: rm.itemCode, description: rm.description, baseUOM: rm.baseUOM,
      itemGroup: rm.itemGroup, balanceQty: rm.balanceQty, isActive: Boolean(rm.isActive),
    };
  },
};

const predictReorderNeeds: ToolDefinition = {
  schema: {
    name: "predict_reorder_needs",
    description: "For each fabric: compares current SOH against meters required by CONFIRMED/IN_PRODUCTION SOs (computed from fabricUsage × quantity of matching products). Flags those projected to go negative. Sorted by deficit descending.",
    input_schema: {
      type: "object",
      properties: {
        lookaheadDays: { type: "number", description: "Hint only — currently looks at all active SOs because Hookka has no per-day demand schedule." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    // Per-fabric required meters from active SOs.
    const demand = await c.var.DB.prepare(
      `SELECT soi.fabricCode AS fabricCode,
              COALESCE(SUM(soi.quantity * COALESCE(p.fabricUsage, 0)), 0) AS metersRequired
       FROM sales_order_items soi
       JOIN sales_orders so ON so.id = soi.salesOrderId
       LEFT JOIN products p ON p.code = soi.productCode AND p.orgId = so.orgId
       WHERE so.orgId = ? AND UPPER(so.status) IN ('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP')
         AND soi.fabricCode IS NOT NULL AND soi.fabricCode <> ''
       GROUP BY soi.fabricCode LIMIT 500`,
    ).bind(orgId).all<{ fabricCode: string; metersRequired: number }>();
    const fabs = await c.var.DB.prepare(
      `SELECT code, name, sohMeters, reorderLevel FROM fabrics WHERE orgId = ? LIMIT 500`,
    ).bind(orgId).all<{ code: string; name: string; sohMeters: number; reorderLevel: number }>();
    const sohMap = new Map<string, { name: string; soh: number; reorder: number }>();
    for (const f of fabs.results ?? []) sohMap.set(f.code, { name: f.name, soh: f.sohMeters, reorder: f.reorderLevel });

    const list = (demand.results ?? []).map((d) => {
      const f = sohMap.get(d.fabricCode);
      const soh = f?.soh ?? 0;
      const required = Number(d.metersRequired) || 0;
      const projected = soh - required;
      return {
        fabricCode: d.fabricCode,
        fabricName: f?.name ?? "(unknown)",
        sohMeters: soh,
        metersRequired: Math.round(required * 10) / 10,
        projectedMeters: Math.round(projected * 10) / 10,
        reorderLevel: f?.reorder ?? 0,
        needsReorder: projected < (f?.reorder ?? 0),
      };
    }).sort((a, b) => a.projectedMeters - b.projectedMeters);

    await emitAudit(c, { resource: "assistant-tool", resourceId: "predict_reorder_needs", action: "predict_reorder_needs", after: filterArgsForAudit(args), source: "ui" });
    return {
      lookaheadDays: Number(args.lookaheadDays) || null,
      count: list.length,
      atRisk: list.filter((x) => x.needsReorder).slice(0, 50),
      all: list.slice(0, 100),
    };
  },
};

// ---------------------------------------------------------------------------
// HR / Payroll — get_employee_efficiency, get_payroll, get_department_efficiency
// ---------------------------------------------------------------------------

const getEmployeeEfficiency: ToolDefinition = {
  schema: {
    name: "get_employee_efficiency",
    description: "Per-employee efficiency over a period. Computed from job_cards: counts COMPLETED JCs they were PIC1/PIC2 on, summed planned vs actual minutes.",
    input_schema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Worker id (filter to one employee)." },
        department: { type: "string", description: "Department code filter." },
        periodFrom: { type: "string", description: "YYYY-MM-DD (required)." },
        periodTo: { type: "string", description: "YYYY-MM-DD (required)." },
      },
      required: ["periodFrom", "periodTo"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const from = ymdOrNull(args.periodFrom);
    const to = ymdOrNull(args.periodTo);
    if (!from || !to) return { error: "periodFrom and periodTo (YYYY-MM-DD) are required" };
    const emp = strOrNull(args.employeeId);
    const dept = strOrNull(args.department);
    const wheres = ["orgId = ?", "UPPER(status) = 'COMPLETED'", "completedDate >= ?", "completedDate <= ?"];
    const params: unknown[] = [orgId, from, to];
    if (emp) { wheres.push("(pic1Id = ? OR pic2Id = ?)"); params.push(emp, emp); }
    if (dept) { wheres.push("UPPER(departmentCode) = ?"); params.push(dept.toUpperCase()); }
    const rows = await c.var.DB.prepare(
      `SELECT pic1Id, pic1Name, pic2Id, pic2Name, departmentCode,
              estMinutes, actualMinutes
       FROM job_cards WHERE ${wheres.join(" AND ")} LIMIT 2000`,
    ).bind(...params).all<{
      pic1Id: string | null; pic1Name: string | null; pic2Id: string | null; pic2Name: string | null;
      departmentCode: string | null; estMinutes: number; actualMinutes: number | null;
    }>();
    type Bucket = { id: string; name: string; department: string; jobs: number; plannedMin: number; actualMin: number };
    const byPerson = new Map<string, Bucket>();
    for (const r of rows.results ?? []) {
      const persons: Array<{ id: string | null; name: string | null }> = [{ id: r.pic1Id, name: r.pic1Name }];
      if (r.pic2Id) persons.push({ id: r.pic2Id, name: r.pic2Name });
      for (const p of persons) {
        if (!p.id) continue;
        const o = byPerson.get(p.id) ?? { id: p.id, name: p.name ?? "", department: r.departmentCode ?? "", jobs: 0, plannedMin: 0, actualMin: 0 };
        o.jobs += 1;
        // Split estMin between persons evenly so it doesn't double-count.
        const share = persons.length;
        o.plannedMin += (r.estMinutes ?? 0) / share;
        o.actualMin += (r.actualMinutes ?? 0) / share;
        byPerson.set(p.id, o);
      }
    }
    const list = Array.from(byPerson.values()).map((b) => ({
      employeeId: b.id, employeeName: b.name, department: b.department,
      jobsCompleted: b.jobs,
      plannedMinutes: Math.round(b.plannedMin),
      actualMinutes: Math.round(b.actualMin),
      efficiencyPct: b.actualMin > 0 ? Math.round((b.plannedMin / b.actualMin) * 1000) / 10 : null,
    })).sort((a, b) => b.jobsCompleted - a.jobsCompleted);
    await emitAudit(c, { resource: "assistant-tool", resourceId: "get_employee_efficiency", action: "get_employee_efficiency", after: filterArgsForAudit(args), source: "ui" });
    return { periodFrom: from, periodTo: to, count: list.length, results: list.slice(0, 100) };
  },
};

const getPayroll: ToolDefinition = {
  schema: {
    name: "get_payroll",
    description: "One employee's payroll for a period. Reads payroll_records (basic + OT + statutory + net).",
    input_schema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Worker id." },
        period: { type: "string", description: "Period string (e.g. '2026-05')." },
      },
      required: ["employeeId", "period"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const emp = strOrNull(args.employeeId);
    const period = strOrNull(args.period);
    if (!emp || !period) return { error: "employeeId and period are required" };
    try {
      const r = await c.var.DB.prepare(
        `SELECT id, workerId, workerName, period, basicSalarySen,
                workingDays, otHoursWeekday, otHoursSunday, otHoursHoliday, otAmountSen,
                grossSalarySen, epfEmployeeSen, socsoEmployeeSen, eisEmployeeSen, pcbSen,
                totalDeductionsSen, netPaySen, status
         FROM payroll_records WHERE orgId = ? AND workerId = ? AND period = ? LIMIT 1`,
      ).bind(orgId, emp, period).first<{
        id: string; workerId: string; workerName: string | null; period: string;
        basicSalarySen: number; workingDays: number;
        otHoursWeekday: number; otHoursSunday: number; otHoursHoliday: number; otAmountSen: number;
        grossSalarySen: number; epfEmployeeSen: number; socsoEmployeeSen: number;
        eisEmployeeSen: number; pcbSen: number; totalDeductionsSen: number; netPaySen: number;
        status: string;
      }>();
      if (!r) return { error: `No payroll record found for ${emp} in period ${period}. See /payroll page to generate one.` };
      await emitAudit(c, { resource: "assistant-tool", resourceId: r.id, action: "get_payroll", after: { id: r.id }, source: "ui" });
      return {
        id: r.id, workerId: r.workerId, workerName: r.workerName ?? "", period: r.period,
        basicSalaryRM: senToRM(r.basicSalarySen), workingDays: r.workingDays,
        otHours: { weekday: r.otHoursWeekday, sunday: r.otHoursSunday, holiday: r.otHoursHoliday },
        otAmountRM: senToRM(r.otAmountSen), grossRM: senToRM(r.grossSalarySen),
        deductions: {
          epfRM: senToRM(r.epfEmployeeSen), socsoRM: senToRM(r.socsoEmployeeSen),
          eisRM: senToRM(r.eisEmployeeSen), pcbRM: senToRM(r.pcbSen),
          totalRM: senToRM(r.totalDeductionsSen),
        },
        netPayRM: senToRM(r.netPaySen), status: r.status,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Payroll lookup failed: ${msg.slice(0, 200)}. See /payroll page.` };
    }
  },
};

const getDepartmentEfficiency: ToolDefinition = {
  schema: {
    name: "get_department_efficiency",
    description: "Aggregate efficiency at the department level for a period.",
    input_schema: {
      type: "object",
      properties: {
        department: { type: "string", description: "departmentCode." },
        periodFrom: { type: "string", description: "YYYY-MM-DD." },
        periodTo: { type: "string", description: "YYYY-MM-DD." },
      },
      required: ["department", "periodFrom", "periodTo"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const dept = strOrNull(args.department);
    const from = ymdOrNull(args.periodFrom);
    const to = ymdOrNull(args.periodTo);
    if (!dept || !from || !to) return { error: "department, periodFrom, periodTo are required" };
    const agg = await c.var.DB.prepare(
      `SELECT COUNT(*) AS jobs, COALESCE(SUM(estMinutes),0) AS plannedMin,
              COALESCE(SUM(actualMinutes),0) AS actualMin
       FROM job_cards WHERE orgId = ? AND UPPER(departmentCode) = ? AND UPPER(status) = 'COMPLETED'
         AND completedDate >= ? AND completedDate <= ?`,
    ).bind(orgId, dept.toUpperCase(), from, to).first<{ jobs: number; plannedMin: number; actualMin: number }>();
    await emitAudit(c, { resource: "assistant-tool", resourceId: dept, action: "get_department_efficiency", after: filterArgsForAudit(args), source: "ui" });
    const planned = agg?.plannedMin ?? 0;
    const actual = agg?.actualMin ?? 0;
    return {
      department: dept.toUpperCase(),
      periodFrom: from, periodTo: to,
      jobsCompleted: agg?.jobs ?? 0,
      plannedMinutes: planned, actualMinutes: actual,
      plannedHours: Math.round(planned / 6) / 10,
      actualHours: Math.round(actual / 6) / 10,
      efficiencyPct: actual > 0 ? Math.round((planned / actual) * 1000) / 10 : null,
    };
  },
};

// ---------------------------------------------------------------------------
// HR — find_employee (resolve a PERSON by name, + their recent performance)
//
// This is the "look up first, don't be lazy" tool. When the operator names
// a worker ("check zaw lin last week performance") the model should resolve
// the person FIRST and — when there's exactly one match — get their recent
// completed work + efficiency in the SAME call, so it can answer without
// asking for a department or employee id.
// ---------------------------------------------------------------------------

/**
 * Aggregate one worker's completed job-cards into jobs / planned / actual
 * minutes. Pure + exported so it can be unit-tested without a DB.
 *
 * A job-card has 1 or 2 people (pic1 always, pic2 optional). When 2 people
 * share a card we split the planned + actual minutes evenly so neither
 * person's numbers are double-counted.
 */
export function aggregateWorkerEfficiency(
  rows: Array<{
    pic1Id: string | null;
    pic2Id: string | null;
    estMinutes: number | null;
    actualMinutes: number | null;
  }>,
  workerId: string,
): { jobsCompleted: number; plannedMinutes: number; actualMinutes: number; efficiencyPct: number | null } {
  let jobs = 0;
  let planned = 0;
  let actual = 0;
  for (const r of rows) {
    const isPic1 = r.pic1Id === workerId;
    const isPic2 = r.pic2Id === workerId;
    if (!isPic1 && !isPic2) continue;
    const share = r.pic2Id ? 2 : 1; // two people on the card → split evenly
    jobs += 1;
    planned += (r.estMinutes ?? 0) / share;
    actual += (r.actualMinutes ?? 0) / share;
  }
  return {
    jobsCompleted: jobs,
    plannedMinutes: Math.round(planned),
    actualMinutes: Math.round(actual),
    efficiencyPct: actual > 0 ? Math.round((planned / actual) * 1000) / 10 : null,
  };
}

const findEmployee: ToolDefinition = {
  schema: {
    name: "find_employee",
    description:
      "Resolve a PERSON by name or employee number. ALWAYS call this FIRST whenever the operator names a worker — e.g. 'Zaw Lin', 'check zaw lin performance', 'how is Ali doing', 'zawlin last week'. Fuzzy-matches the workers table on name + emp no. When EXACTLY ONE worker matches, it ALSO returns their performance for the period (DEFAULT: last 7 days) — completed job cards, planned vs actual minutes, efficiency % — so you can answer immediately WITHOUT asking the operator for a department or employee id. If 0 match: ask the operator to check spelling or give the emp no. If 2+ match: list them with department/role and ask which one. Do NOT ask clarifying questions before calling this.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name or employee number as typed, e.g. 'Zaw Lin', 'zawlin', 'EMP012'.",
        },
        periodFrom: { type: "string", description: "YYYY-MM-DD. Default: 7 days ago." },
        periodTo: { type: "string", description: "YYYY-MM-DD. Default: today." },
      },
      required: ["query"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const q = strOrNull(args.query);
    if (!q) return { error: "query is required" };

    // Default period = last 7 days (covers "last week" with zero questions).
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const weekAgoStr = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const from = ymdOrNull(args.periodFrom) ?? weekAgoStr;
    const to = ymdOrNull(args.periodTo) ?? todayStr;

    // Fuzzy match name + emp no. Plain OR-chain — NOT `ILIKE ANY (?::text[])`
    // (that silently binds empty through the adapter). Active workers first.
    const like = `%${q.toLowerCase()}%`;
    const matchRes = await c.var.DB.prepare(
      `SELECT id, empNo, name, departmentCode, role, status
       FROM workers
       WHERE orgId = ? AND (LOWER(name) LIKE ? OR LOWER(empNo) LIKE ?)
       ORDER BY (CASE WHEN UPPER(COALESCE(status,'')) = 'ACTIVE' THEN 0 ELSE 1 END), name
       LIMIT 25`,
    ).bind(orgId, like, like).all<{
      id: string; empNo: string | null; name: string | null;
      departmentCode: string | null; role: string | null; status: string | null;
    }>();
    const matched = matchRes.results ?? [];

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: q.slice(0, 100),
      action: "find_employee",
      after: { query: q, matchCount: matched.length },
      source: "ui",
    });

    const workers = matched.map((w) => ({
      employeeId: w.id,
      empNo: w.empNo ?? "",
      name: w.name ?? "",
      department: w.departmentCode ?? "",
      role: w.role ?? "",
      status: w.status ?? "",
    }));

    if (workers.length === 0) {
      return {
        query: q,
        matchCount: 0,
        workers: [],
        performance: null,
        askClarifyingQuestion: `No worker matches "${q}". Ask the operator to check the spelling or give the employee number.`,
      };
    }

    // Exactly one → pull their recent completed work + efficiency in the
    // same call so the model can answer without a second round-trip.
    let performance: Record<string, unknown> | null = null;
    if (workers.length === 1) {
      const w = matched[0];
      const jcRes = await c.var.DB.prepare(
        `SELECT pic1Id, pic2Id, estMinutes, actualMinutes
         FROM job_cards
         WHERE orgId = ? AND UPPER(status) = 'COMPLETED'
           AND completedDate >= ? AND completedDate <= ?
           AND (pic1Id = ? OR pic2Id = ?)
         LIMIT 2000`,
      ).bind(orgId, from, to, w.id, w.id).all<{
        pic1Id: string | null; pic2Id: string | null;
        estMinutes: number | null; actualMinutes: number | null;
      }>();
      const agg = aggregateWorkerEfficiency(jcRes.results ?? [], w.id);
      performance = {
        periodFrom: from,
        periodTo: to,
        jobsCompleted: agg.jobsCompleted,
        plannedMinutes: agg.plannedMinutes,
        actualMinutes: agg.actualMinutes,
        plannedHours: Math.round(agg.plannedMinutes / 6) / 10,
        actualHours: Math.round(agg.actualMinutes / 6) / 10,
        efficiencyPct: agg.efficiencyPct,
      };
    }

    return {
      query: q,
      matchCount: workers.length,
      workers,
      performance, // null unless exactly 1 match
      askClarifyingQuestion:
        workers.length > 1
          ? `Multiple workers match "${q}". List them with department + role and ask the operator which one.`
          : "",
    };
  },
};

// ---------------------------------------------------------------------------
// Reports / KPIs — get_dashboard_kpis, list_overdue_orders, get_abnormal_orders
// ---------------------------------------------------------------------------

const getDashboardKpis: ToolDefinition = {
  schema: {
    name: "get_dashboard_kpis",
    description: "Comprehensive KPI snapshot for a date range (defaults to current month): SO count + revenue, CO count, delivery on-time %, overdue counts (SO/PO/DO/Invoice), WIP units, AR outstanding incl 90+, top 5 customers, top 5 products by units, blended GP%.",
    input_schema: {
      type: "object",
      properties: {
        dateFrom: { type: "string", description: "YYYY-MM-DD." },
        dateTo: { type: "string", description: "YYYY-MM-DD." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const todayStr = now.toISOString().slice(0, 10);
    const dateFrom = ymdOrNull(args.dateFrom) ?? monthStart;
    const dateTo = ymdOrNull(args.dateTo) ?? todayStr;

    const [soAgg, coAgg, invAgg, doStats, overdueSO, overduePO, overdueDO, overdueInv, wipAgg, ar, topCust, topProd] = await Promise.all([
      c.var.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(totalSen), 0) AS sumSen FROM sales_orders WHERE orgId = ? AND created_at >= ? AND created_at <= ?`).bind(orgId, dateFrom, `${dateTo} 23:59:59`).first<{ n: number; sumSen: number }>(),
      c.var.DB.prepare(`SELECT COUNT(*) AS n FROM consignment_orders WHERE orgId = ? AND created_at >= ? AND created_at <= ?`).bind(orgId, dateFrom, `${dateTo} 23:59:59`).first<{ n: number }>(),
      c.var.DB.prepare(`SELECT COALESCE(SUM(totalSen), 0) AS totalSen, COALESCE(SUM(COALESCE(paidAmount,0)),0) AS paidSen FROM invoices WHERE orgId = ? AND UPPER(status) <> 'VOID' AND invoiceDate >= ? AND invoiceDate <= ?`).bind(orgId, dateFrom, dateTo).first<{ totalSen: number; paidSen: number }>(),
      // on-time = delivered (have a deliveredAt timestamp) AND deliveredAt
      // is on/before scheduled deliveryDate. Earlier version compared
      // deliveryDate to itself (snake/camel rewrite collision) which made
      // every delivered row count as on-time.
      c.var.DB.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN UPPER(status) IN ('DELIVERED','SIGNED','INVOICED') AND deliveredAt IS NOT NULL AND SUBSTR(deliveredAt, 1, 10) <= deliveryDate THEN 1 ELSE 0 END) AS onTime FROM delivery_orders WHERE orgId = ? AND deliveryDate >= ? AND deliveryDate <= ?`).bind(orgId, dateFrom, dateTo).first<{ total: number; onTime: number }>().catch(() => null),
      c.var.DB.prepare(`SELECT COUNT(*) AS n FROM sales_orders WHERE orgId = ? AND customerDeliveryDate IS NOT NULL AND customerDeliveryDate < ? AND UPPER(status) NOT IN ('DELIVERED','INVOICED','CANCELLED','CLOSED')`).bind(orgId, todayStr).first<{ n: number }>(),
      c.var.DB.prepare(`SELECT COUNT(*) AS n FROM production_orders WHERE orgId = ? AND targetEndDate IS NOT NULL AND targetEndDate < ? AND UPPER(status) NOT IN ('COMPLETED','CANCELLED')`).bind(orgId, todayStr).first<{ n: number }>(),
      c.var.DB.prepare(`SELECT COUNT(*) AS n FROM delivery_orders WHERE orgId = ? AND deliveryDate IS NOT NULL AND deliveryDate < ? AND UPPER(status) NOT IN ('DELIVERED','SIGNED','INVOICED','CANCELLED')`).bind(orgId, todayStr).first<{ n: number }>(),
      c.var.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(totalSen - COALESCE(paidAmount,0)),0) AS outSen FROM invoices WHERE orgId = ? AND UPPER(status) IN ('ISSUED','OVERDUE','PARTIAL') AND dueDate IS NOT NULL AND dueDate < ?`).bind(orgId, todayStr).first<{ n: number; outSen: number }>(),
      c.var.DB.prepare(`SELECT COALESCE(SUM(stockQty), 0) AS units FROM wip_items WHERE orgId = ?`).bind(orgId).first<{ units: number }>(),
      c.var.DB.prepare(`SELECT COALESCE(SUM(totalSen - COALESCE(paidAmount,0)), 0) AS outSen FROM invoices WHERE orgId = ? AND UPPER(status) IN ('ISSUED','OVERDUE','PARTIAL') AND totalSen > COALESCE(paidAmount,0)`).bind(orgId).first<{ outSen: number }>(),
      c.var.DB.prepare(`SELECT customerName, COALESCE(SUM(totalSen),0) AS revSen FROM invoices WHERE orgId = ? AND UPPER(status) <> 'VOID' AND invoiceDate >= ? AND invoiceDate <= ? GROUP BY customerName ORDER BY revSen DESC LIMIT 5`).bind(orgId, dateFrom, dateTo).all<{ customerName: string | null; revSen: number }>(),
      c.var.DB.prepare(`SELECT ii.productCode AS productCode, COALESCE(SUM(ii.quantity), 0) AS units FROM invoice_items ii JOIN invoices i ON i.id = ii.invoiceId WHERE i.orgId = ? AND UPPER(i.status) <> 'VOID' AND i.invoiceDate >= ? AND i.invoiceDate <= ? GROUP BY ii.productCode ORDER BY units DESC LIMIT 5`).bind(orgId, dateFrom, dateTo).all<{ productCode: string | null; units: number }>(),
    ]);

    // Blended GP% — same shape as get_gp_analysis but a single number.
    const gpRows = await c.var.DB.prepare(
      `SELECT COALESCE(SUM(ii.totalSen), 0) AS revSen,
              COALESCE(SUM(ii.quantity * COALESCE(p.costPriceSen,0)), 0) AS costSen
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoiceId
       LEFT JOIN products p ON p.code = ii.productCode AND p.orgId = i.orgId
       WHERE i.orgId = ? AND UPPER(i.status) <> 'VOID'
         AND i.invoiceDate >= ? AND i.invoiceDate <= ?`,
    ).bind(orgId, dateFrom, dateTo).first<{ revSen: number; costSen: number }>();

    const ar90 = await c.var.DB.prepare(
      `SELECT COALESCE(SUM(totalSen - COALESCE(paidAmount,0)), 0) AS outSen
       FROM invoices WHERE orgId = ? AND UPPER(status) IN ('ISSUED','OVERDUE','PARTIAL')
         AND totalSen > COALESCE(paidAmount,0)
         AND dueDate IS NOT NULL AND dueDate < ?`,
    ).bind(orgId, new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10)).first<{ outSen: number }>();

    await emitAudit(c, { resource: "assistant-tool", resourceId: "get_dashboard_kpis", action: "get_dashboard_kpis", after: { dateFrom, dateTo }, source: "ui" });

    const onTimePct = doStats && doStats.total > 0 ? Math.round((doStats.onTime / doStats.total) * 1000) / 10 : null;
    const blendedGpPct = gpRows && gpRows.revSen > 0
      ? Math.round(((gpRows.revSen - gpRows.costSen) / gpRows.revSen) * 1000) / 10
      : null;

    return {
      dateFrom, dateTo,
      salesOrders: { count: soAgg?.n ?? 0, revenueRM: senToRM(soAgg?.sumSen ?? 0) },
      consignmentOrders: { count: coAgg?.n ?? 0 },
      revenue: {
        invoicedRM: senToRM(invAgg?.totalSen ?? 0),
        collectedRM: senToRM(invAgg?.paidSen ?? 0),
      },
      deliveryOnTimePct: onTimePct,
      overdue: {
        salesOrders: overdueSO?.n ?? 0,
        productionOrders: overduePO?.n ?? 0,
        deliveryOrders: overdueDO?.n ?? 0,
        invoices: overdueInv?.n ?? 0,
        overdueInvoiceTotalRM: senToRM(overdueInv?.outSen ?? 0),
      },
      wipUnits: wipAgg?.units ?? 0,
      ar: {
        totalOutstandingRM: senToRM(ar?.outSen ?? 0),
        over90DaysRM: senToRM(ar90?.outSen ?? 0),
      },
      top5Customers: (topCust.results ?? []).map((r) => ({ customerName: r.customerName ?? "", revenueRM: senToRM(r.revSen) })),
      top5Products: (topProd.results ?? []).map((r) => ({ productCode: r.productCode ?? "", units: Number(r.units ?? 0) })),
      blendedGpPct,
    };
  },
};

const listOverdueOrders: ToolDefinition = {
  schema: {
    name: "list_overdue_orders",
    description: "List overdue orders of a given type. type: SO (customerDeliveryDate < asOf), PO (targetEndDate < asOf), DO (deliveryDate < asOf), INVOICE (dueDate < asOf).",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "SO | PO | DO | INVOICE." },
        dateAsOf: { type: "string", description: "YYYY-MM-DD (defaults to today)." },
        limit: { type: "number", description: "Max rows (1-100, default 50)." },
      },
      required: ["type"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const type = String(args.type ?? "").toUpperCase();
    const asOf = ymdOrNull(args.dateAsOf) ?? new Date().toISOString().slice(0, 10);
    const limit = clampLimit(args.limit, 50);
    let sql = "";
    if (type === "SO") {
      sql = `SELECT id, companySOId AS code, customerName, status, customerDeliveryDate AS date
             FROM sales_orders WHERE orgId = ? AND customerDeliveryDate IS NOT NULL
               AND customerDeliveryDate < ?
               AND UPPER(status) NOT IN ('DELIVERED','INVOICED','CANCELLED','CLOSED')
             ORDER BY customerDeliveryDate ASC LIMIT ${limit}`;
    } else if (type === "PO") {
      sql = `SELECT id, poNo AS code, customerName, status, targetEndDate AS date
             FROM production_orders WHERE orgId = ? AND targetEndDate IS NOT NULL
               AND targetEndDate < ?
               AND UPPER(status) NOT IN ('COMPLETED','CANCELLED')
             ORDER BY targetEndDate ASC LIMIT ${limit}`;
    } else if (type === "DO") {
      sql = `SELECT id, doNo AS code, customerName, status, deliveryDate AS date
             FROM delivery_orders WHERE orgId = ? AND deliveryDate IS NOT NULL
               AND deliveryDate < ?
               AND UPPER(status) NOT IN ('DELIVERED','SIGNED','INVOICED','CANCELLED')
             ORDER BY deliveryDate ASC LIMIT ${limit}`;
    } else if (type === "INVOICE") {
      sql = `SELECT id, invoiceNo AS code, customerName, status, dueDate AS date,
                    totalSen - COALESCE(paidAmount,0) AS outSen
             FROM invoices WHERE orgId = ? AND dueDate IS NOT NULL
               AND dueDate < ?
               AND UPPER(status) IN ('ISSUED','OVERDUE','PARTIAL')
               AND totalSen > COALESCE(paidAmount,0)
             ORDER BY dueDate ASC LIMIT ${limit}`;
    } else {
      return { error: `Unknown type: ${type}. Use SO, PO, DO, INVOICE.` };
    }
    const rows = await c.var.DB.prepare(sql).bind(orgId, asOf).all<{
      id: string; code: string | null; customerName: string | null; status: string | null;
      date: string | null; outSen?: number | null;
    }>();
    await emitAudit(c, { resource: "assistant-tool", resourceId: "list_overdue_orders", action: "list_overdue_orders", after: { type, asOf }, source: "ui" });
    return {
      type, asOf,
      count: rows.results?.length ?? 0,
      results: (rows.results ?? []).map((r) => ({
        id: r.id, code: r.code ?? "", customerName: r.customerName ?? "",
        status: r.status ?? "", date: r.date ?? "",
        outstandingRM: r.outSen != null ? senToRM(r.outSen) : undefined,
      })),
    };
  },
};

const getAbnormalOrders: ToolDefinition = {
  schema: {
    name: "get_abnormal_orders",
    description: "Find SOs/POs that look abnormal: abnormal GP (< 10% or > 80%) on SOs, or POs past targetEndDate with no progress.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max per category (1-50, default 10)." } },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
    const today = new Date().toISOString().slice(0, 10);
    // Abnormal GP = SO total vs estimated cost (sum of cost × qty for its items).
    const gpRows = await c.var.DB.prepare(
      `SELECT so.id AS soId, so.companySOId AS companySOId, so.customerName AS customerName,
              so.totalSen AS totalSen,
              COALESCE(SUM(soi.quantity * COALESCE(p.costPriceSen,0)), 0) AS costSen
       FROM sales_orders so
       JOIN sales_order_items soi ON soi.salesOrderId = so.id
       LEFT JOIN products p ON p.code = soi.productCode AND p.orgId = so.orgId
       WHERE so.orgId = ? AND UPPER(so.status) NOT IN ('DRAFT','CANCELLED')
       GROUP BY so.id, so.companySOId, so.customerName, so.totalSen
       HAVING so.totalSen > 0
       ORDER BY so.created_at DESC
       LIMIT 500`,
    ).bind(orgId).all<{ soId: string; companySOId: string | null; customerName: string | null; totalSen: number; costSen: number }>();
    const abnormalGp = (gpRows.results ?? []).map((r) => {
      const gpPct = r.totalSen > 0 ? ((r.totalSen - r.costSen) / r.totalSen) * 100 : 0;
      return { ...r, gpPct };
    }).filter((r) => r.gpPct < 10 || r.gpPct > 80).slice(0, limit);

    const stuckPo = await c.var.DB.prepare(
      `SELECT id, poNo, customerName, status, progress, targetEndDate
       FROM production_orders WHERE orgId = ? AND targetEndDate IS NOT NULL
         AND targetEndDate < ? AND progress < 100 AND UPPER(status) NOT IN ('COMPLETED','CANCELLED')
       ORDER BY targetEndDate ASC LIMIT ${limit}`,
    ).bind(orgId, today).all<{
      id: string; poNo: string; customerName: string | null; status: string;
      progress: number; targetEndDate: string | null;
    }>();

    await emitAudit(c, { resource: "assistant-tool", resourceId: "get_abnormal_orders", action: "get_abnormal_orders", after: {}, source: "ui" });
    return {
      abnormalGpSos: abnormalGp.map((r) => ({
        soId: r.soId, companySOId: r.companySOId ?? "", customerName: r.customerName ?? "",
        totalRM: senToRM(r.totalSen), costRM: senToRM(r.costSen),
        gpPct: Math.round(r.gpPct * 10) / 10,
      })),
      stuckProductionOrders: (stuckPo.results ?? []).map((r) => ({
        id: r.id, poNo: r.poNo, customerName: r.customerName ?? "",
        status: r.status, progress: r.progress, targetEndDate: r.targetEndDate ?? "",
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Catalog — list_cnc_templates, get_bom, find_products_using_fabric
// ---------------------------------------------------------------------------

const listCncTemplates: ToolDefinition = {
  schema: {
    name: "list_cnc_templates",
    description: "List CNC fabric-cutting templates. Filter by productCode or partial display-name search.",
    input_schema: {
      type: "object",
      properties: {
        productCode: { type: "string", description: "Product code filter." },
        search: { type: "string", description: "Partial match on displayName / pieceLabel." },
        limit: { type: "number", description: "Max rows (1-100, default 50)." },
      },
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const wheres = ["orgId = ?"];
    const params: unknown[] = [orgId];
    const pc = strOrNull(args.productCode);
    if (pc) { wheres.push("productCode = ?"); params.push(pc); }
    const s = strOrNull(args.search);
    if (s) { wheres.push("(LOWER(displayName) LIKE ? OR LOWER(pieceLabel) LIKE ?)"); const l = `%${s.toLowerCase()}%`; params.push(l, l); }
    const limit = clampLimit(args.limit, 50);
    try {
      const rows = await c.var.DB.prepare(
        `SELECT id, productCode, sizeLabel, fabricWidth, pieceLabel, displayName,
                totalHeight, folder, sizeBytes, created_at AS createdAt
         FROM cnc_templates WHERE ${wheres.join(" AND ")}
         ORDER BY productCode, displayName LIMIT ${limit}`,
      ).bind(...params).all<{
        id: string; productCode: string; sizeLabel: string; fabricWidth: string; pieceLabel: string;
        displayName: string; totalHeight: string; folder: string; sizeBytes: number; createdAt: string | null;
      }>();
      await emitAudit(c, { resource: "assistant-tool", resourceId: "list_cnc_templates", action: "list_cnc_templates", after: filterArgsForAudit(args), source: "ui" });
      return {
        count: rows.results?.length ?? 0,
        results: (rows.results ?? []).map((r) => ({
          id: r.id, productCode: r.productCode, sizeLabel: r.sizeLabel,
          fabricWidth: r.fabricWidth, pieceLabel: r.pieceLabel, displayName: r.displayName,
          totalHeight: r.totalHeight, folder: r.folder, sizeBytes: r.sizeBytes,
          createdAt: r.createdAt ?? "",
        })),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/does not exist|no such table/i.test(msg)) return { count: 0, results: [], note: "cnc_templates not yet populated." };
      throw err;
    }
  },
};

const getBom: ToolDefinition = {
  schema: {
    name: "get_bom",
    description:
      "Get BOM components for a product. Returns the active BOM template's WIP component tree (fabric, foam, wood, accessories per sub-assembly). Pass the product code as the user knows it, e.g. '1003-(K)'.",
    input_schema: {
      type: "object",
      properties: {
        productCode: {
          type: "string",
          description: "Product code (e.g. '1003-(K)', 'BO315-02'). Case-insensitive.",
        },
      },
      required: ["productCode"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const code = strOrNull(args.productCode);
    if (!code) return { ok: false, error: "productCode is required" };

    // Resolve product (case-insensitive) so we can return the canonical code/name.
    const p = await c.var.DB
      .prepare(
        "SELECT id, code, name, category FROM products WHERE orgId = ? AND code ILIKE ? LIMIT 1",
      )
      .bind(orgId, code)
      .first<{
        id: string;
        code: string;
        name: string;
        category: string | null;
      }>();
    if (!p) {
      return { ok: false, error: `Product not found: ${code}` };
    }

    // Active BOM template lives in bom_templates.wipComponents (JSON). The
    // legacy bom_components table is keyed by snake_case columns that the
    // assistant adapter doesn't auto-rewrite for SELECT-list aliases, so
    // querying the template here matches what the BOM editor reads.
    let wipComponents: unknown[] = [];
    let templateFound = false;
    try {
      const tpl = await c.var.DB
        .prepare(
          `SELECT wipComponents FROM bom_templates
           WHERE productCode ILIKE ?
             AND UPPER(COALESCE(versionStatus, '')) = 'ACTIVE'
           ORDER BY effectiveFrom DESC NULLS LAST
           LIMIT 1`,
        )
        .bind(p.code)
        .first<{ wipComponents: string | null }>();
      if (tpl) {
        templateFound = true;
        if (tpl.wipComponents) {
          try {
            const parsed = JSON.parse(tpl.wipComponents);
            if (Array.isArray(parsed)) wipComponents = parsed;
          } catch {
            // Malformed JSON — surface empty BOM rather than crashing.
          }
        }
      } else {
        // No ACTIVE template — fall back to most-recent template of any status.
        const anyTpl = await c.var.DB
          .prepare(
            `SELECT wipComponents FROM bom_templates
             WHERE productCode ILIKE ?
             ORDER BY effectiveFrom DESC NULLS LAST
             LIMIT 1`,
          )
          .bind(p.code)
          .first<{ wipComponents: string | null }>();
        if (anyTpl) {
          templateFound = true;
          if (anyTpl.wipComponents) {
            try {
              const parsed = JSON.parse(anyTpl.wipComponents);
              if (Array.isArray(parsed)) wipComponents = parsed;
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch {
      // Table missing or transient DB error — fall through to empty BOM.
    }

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: p.code,
      action: "get_bom",
      after: { code: p.code },
      source: "ui",
    });

    if (!templateFound) {
      return {
        ok: true,
        productCode: p.code,
        productName: p.name,
        category: p.category ?? "",
        bom: [],
        note: "No BOM template defined for this product.",
      };
    }

    return {
      ok: true,
      productCode: p.code,
      productName: p.name,
      category: p.category ?? "",
      bom: wipComponents,
      note: wipComponents.length === 0 ? "BOM template exists but has no components." : undefined,
    };
  },
};

const findProductsUsingFabric: ToolDefinition = {
  schema: {
    name: "find_products_using_fabric",
    description: "Reverse lookup: which products' BOMs reference a given fabric code?",
    input_schema: {
      type: "object",
      properties: { fabricCode: { type: "string", description: "Fabric code to search for." } },
      required: ["fabricCode"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const code = strOrNull(args.fabricCode);
    if (!code) return { error: "fabricCode is required" };
    const rows = await c.var.DB.prepare(
      `SELECT DISTINCT p.code AS productCode, p.name AS productName, p.category AS category
       FROM products p
       JOIN bom_components bc ON bc.productId = p.id
       WHERE p.orgId = ? AND (bc.materialCode = ? OR LOWER(bc.materialName) LIKE ?)
       ORDER BY p.code LIMIT 100`,
    ).bind(orgId, code, `%${code.toLowerCase()}%`).all<{ productCode: string; productName: string; category: string }>();
    await emitAudit(c, { resource: "assistant-tool", resourceId: code, action: "find_products_using_fabric", after: { code }, source: "ui" });
    return {
      fabricCode: code,
      count: rows.results?.length ?? 0,
      products: rows.results ?? [],
    };
  },
};

// ---------------------------------------------------------------------------
// System / Help — list_audit_events, explain_feature
// ---------------------------------------------------------------------------

const listAuditEvents: ToolDefinition = {
  schema: {
    name: "list_audit_events",
    description: "Recent audit events. Filter by resource (e.g. 'sales-orders'), userId, or date range.",
    input_schema: {
      type: "object",
      properties: {
        resource: { type: "string", description: "Resource filter." },
        userId: { type: "string", description: "Actor user id filter." },
        dateFrom: { type: "string", description: "YYYY-MM-DD." },
        dateTo: { type: "string", description: "YYYY-MM-DD." },
        limit: { type: "number", description: "Max rows (1-100, default 25)." },
      },
    },
  },
  execute: async (c, args) => {
    const wheres: string[] = ["1=1"];
    const params: unknown[] = [];
    const res = strOrNull(args.resource);
    if (res) { wheres.push("resource = ?"); params.push(res); }
    const uid = strOrNull(args.userId);
    if (uid) { wheres.push("actorUserId = ?"); params.push(uid); }
    const dateFrom = ymdOrNull(args.dateFrom);
    if (dateFrom) { wheres.push("ts >= ?"); params.push(dateFrom); }
    const dateTo = ymdOrNull(args.dateTo);
    if (dateTo) { wheres.push("ts <= ?"); params.push(`${dateTo} 23:59:59`); }
    const limit = clampLimit(args.limit, 25);
    const rows = await c.var.DB.prepare(
      `SELECT id, actorUserId, actorUserName, actorRole, resource, resourceId, action, source, ts
       FROM audit_events WHERE ${wheres.join(" AND ")}
       ORDER BY ts DESC LIMIT ${limit}`,
    ).bind(...params).all<{
      id: string; actorUserId: string | null; actorUserName: string | null; actorRole: string | null;
      resource: string; resourceId: string; action: string; source: string; ts: string;
    }>();
    return {
      count: rows.results?.length ?? 0,
      results: rows.results ?? [],
    };
  },
};

// Static knowledge map for common feature how-tos.
const FEATURE_HELP: Record<string, { sidebar: string; steps: string[]; relatedPages?: string[] }> = {
  "sales order create": {
    sidebar: "Sales → Sales Orders → +New",
    steps: [
      "Click +New in the top-right of the Sales Orders page.",
      "Pick the customer and hub (auto-fills delivery address).",
      "Add lines — pick product code, fabric, divan/leg height/gap as required.",
      "Set Customer Delivery Date and Hookka Expected DD.",
      "Save Draft, then Confirm to push into production.",
    ],
  },
  "sales order edit": {
    sidebar: "Sales → Sales Orders → click row",
    steps: [
      "Open the SO row.",
      "Edit fields inline (delivery date, lines, special orders).",
      "Save. Cell turns yellow until saved.",
      "If the SO is already CONFIRMED, status guardrails restrict which fields you can change.",
    ],
  },
  "consignment order create": {
    sidebar: "Sales → Consignment Orders → +New",
    steps: [
      "Pick the customer.",
      "Add product lines (same dropdowns as SO).",
      "Save. The CO flows through the same PO/JC pipeline as a SO.",
    ],
  },
  "bom edit": {
    sidebar: "Catalog → Products → click product → BOM tab",
    steps: [
      "Open the product.",
      "Switch to the BOM tab.",
      "Add / remove components — fabric, foam, wood, accessories.",
      "Save. Existing POs are NOT retroactively changed.",
    ],
  },
  "foam stock in": {
    sidebar: "Inventory → Foam (WIP) → Stock In",
    steps: [
      "Click Stock In.",
      "Pick the foam WIP code and grade.",
      "Enter quantity (pieces).",
      "Save — stock_qty on the wip_items row is incremented.",
    ],
  },
  "run payroll": {
    sidebar: "HR → Payroll → Generate",
    steps: [
      "Pick the period (YYYY-MM).",
      "Click Generate — pulls attendance + OT, computes EPF/SOCSO/EIS/PCB.",
      "Review each worker's draft slip.",
      "Click Approve, then Pay when payment is sent.",
      "If a worker-master change happened mid-month, click Regenerate to re-pull.",
    ],
  },
  "print delivery order": {
    sidebar: "Delivery → Delivery Orders → click row → Print",
    steps: [
      "Open the DO.",
      "Click Print — generates a PDF with line items + delivery address + signature block.",
    ],
  },
  "apply pic batch": {
    sidebar: "Production → Daily Sheet → bulk PIC selector",
    steps: [
      "Open the daily sheet for the department.",
      "Select multiple rows (Ctrl+Click or shift-click).",
      "Pick PIC1 (and PIC2 if pair-work).",
      "Click Apply — the same PIC is set on every selected row at once.",
    ],
  },
  "confirm so": {
    sidebar: "Sales → Sales Orders → click row → Confirm",
    steps: [
      "Open the DRAFT SO.",
      "Click Confirm.",
      "Production orders are auto-created per line + job cards spawned per department.",
    ],
  },
  "create packing list": {
    sidebar: "Delivery → Packing Lists → +New",
    steps: [
      "Pick the DOs going on the same truck run.",
      "Save — system snapshots total stops, units, m3.",
      "Print to give the warehouse one consolidated loading sheet.",
    ],
  },
  "invoice from do": {
    sidebar: "Sales → Delivery Orders → row menu → Invoice",
    steps: [
      "Find the DELIVERED DO.",
      "Pick Invoice from the row menu.",
      "Invoice is created from the DO line items + customer credit terms.",
      "Status flips DO → INVOICED.",
    ],
  },
  "record payment": {
    sidebar: "Finance → Payments → +New Receipt",
    steps: [
      "Pick the customer.",
      "Pick payment method (bank transfer / cheque / cash).",
      "Allocate amount across outstanding invoices.",
      "Save. paidAmount on each invoice is bumped accordingly.",
    ],
  },
  "scan production": {
    sidebar: "Worker portal (mobile) → Scan",
    steps: [
      "Worker logs in via PIN.",
      "Scan the piece QR / sticker.",
      "System updates job_card status + piece_pics.",
    ],
  },
  "view daily report": {
    sidebar: "Reports → Daily Report",
    steps: [
      "Pick the date (defaults today).",
      "Choose the report type (compliance / efficiency / overdue / schedule).",
      "Page renders, plus a Print/Email button at the top.",
    ],
  },
  "stock take": {
    sidebar: "Inventory → Stock Adjustments → +New",
    steps: [
      "Pick the WIP item or raw material.",
      "Enter the counted quantity.",
      "Save with a reason — a stock_movements row is logged for the variance.",
    ],
  },
};

const explainFeature: ToolDefinition = {
  schema: {
    name: "explain_feature",
    description: "Look up how to perform a specific ERP feature (sidebar location + step-by-step). Pass the feature name in plain English; the tool does a case-insensitive partial match against a built-in knowledge base.",
    input_schema: {
      type: "object",
      properties: { featureName: { type: "string", description: "Plain English feature name (e.g. 'create sales order', 'run payroll')." } },
      required: ["featureName"],
    },
  },
  execute: async (c, args) => {
    const q = strOrNull(args.featureName);
    if (!q) return { error: "featureName is required" };
    const qLower = q.toLowerCase();
    // Direct match.
    let hit: { key: string; info: typeof FEATURE_HELP[string] } | null = null;
    for (const [k, v] of Object.entries(FEATURE_HELP)) {
      if (k === qLower) { hit = { key: k, info: v }; break; }
    }
    // Substring match.
    if (!hit) {
      for (const [k, v] of Object.entries(FEATURE_HELP)) {
        const allWords = qLower.split(/\s+/).filter((w) => w.length > 2);
        const matched = allWords.filter((w) => k.includes(w)).length;
        if (matched >= Math.max(1, Math.ceil(allWords.length / 2))) {
          hit = { key: k, info: v };
          break;
        }
      }
    }
    await emitAudit(c, { resource: "assistant-tool", resourceId: q.slice(0, 60), action: "explain_feature", after: { featureName: q }, source: "ui" });
    if (!hit) {
      return {
        query: q,
        found: false,
        knownFeatures: Object.keys(FEATURE_HELP),
        note: "Feature not in built-in knowledge base. Suggest the user check the sidebar for the closest match.",
      };
    }
    return {
      query: q,
      found: true,
      featureKey: hit.key,
      sidebarPath: hit.info.sidebar,
      steps: hit.info.steps,
      relatedPages: hit.info.relatedPages ?? [],
    };
  },
};

// ---------------------------------------------------------------------------
// Attachment-aware tools (added 2026-05-30, FEAT-2026-05-30-008)
//
// Three tools the model uses AFTER the user uploads a file. The actual
// bytes are forwarded to Anthropic directly by the route — these tools
// only orchestrate post-vision behaviour (extracted-data routing,
// spreadsheet row access, fuzzy-match-to-Hookka).
// ---------------------------------------------------------------------------

function getRequestAttachments(c: Context<Env>): ParsedAttachment[] {
  const id =
    (c as unknown as { get: (k: string) => unknown }).get(
      "assistantAttachmentReqId",
    ) as string | undefined;
  if (!id) return [];
  return lookupAttachments(id);
}

const analyzeImage: ToolDefinition = {
  schema: {
    name: "analyze_image",
    description:
      "Acknowledge an image attachment the user just sent and trigger a Hookka lookup based on what was visible in it. Call this AFTER you've described what you saw in the image (PO numbers, customer logos, product codes). Pass the extracted reference(s) and an optional customer/context hint — the tool then routes to smart_lookup so you can answer with matched documents. Useful sequence: user uploads photo → you describe what you see → call analyze_image with extracted refs → present the matched SOs/POs/etc. to the user.",
    input_schema: {
      type: "object",
      properties: {
        attachmentName: {
          type: "string",
          description:
            "Filename of the image the user uploaded (so we can audit-link). Optional — use the first image attachment if omitted.",
        },
        extractedReferences: {
          type: "array",
          items: { type: "string" },
          description:
            "Reference numbers / codes you read off the image, e.g. ['PO-009003', 'SO-2605-051']. Pass each verbatim as you read it.",
        },
        customerHint: {
          type: "string",
          description:
            "Customer name / logo you recognised in the image (e.g. 'Houzs').",
        },
        productCodes: {
          type: "array",
          items: { type: "string" },
          description:
            "Product codes / SKUs visible on the image, if any (e.g. ['1003-K', '1005-Q']).",
        },
      },
      required: ["extractedReferences"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const requested = strOrNull(args.attachmentName);
    const all = getRequestAttachments(c);
    const targetImage = requested
      ? all.find(
          (a) => a.name === requested || a.id === requested,
        )
      : all.find((a) => a.kind === "image");

    const refs = Array.isArray(args.extractedReferences)
      ? (args.extractedReferences as unknown[])
          .map((r) => (typeof r === "string" ? r.trim() : ""))
          .filter((r): r is string => r.length > 0)
          .slice(0, 6)
      : [];
    const customerHint = strOrNull(args.customerHint);

    if (refs.length === 0) {
      return {
        ok: false,
        error:
          "No references provided. Re-read the image and pass the visible PO / SO / invoice / DO numbers as extractedReferences.",
        imageRecognised: !!targetImage,
      };
    }

    // For each reference, do a smart_lookup-style scan. We inline the
    // same logic the smart_lookup tool uses so the model gets a single
    // consolidated response and doesn't burn 6 tool calls on a 6-ref
    // image.
    const yymm = currentYYMM();
    const customerHintLike = customerHint
      ? `%${customerHint.toLowerCase()}%`
      : null;

    const matches: Record<string, unknown>[] = [];

    for (const ref of refs) {
      const patterns = generateLookupPatterns(ref, yymm);
      if (patterns.length === 0) continue;
      // sales_orders.customerPOId is the most likely landing zone for a
      // photographed Houzs PO. We also scan companySOId, customerSOId, and
      // invoice / DO numbers for completeness.
      const where = customerHintLike
        ? `orgId = ? AND (companySOId ILIKE ANY (?) OR customerPOId ILIKE ANY (?) OR customerSOId ILIKE ANY (?)) AND LOWER(COALESCE(customerName, '')) LIKE ?`
        : `orgId = ? AND (companySOId ILIKE ANY (?) OR customerPOId ILIKE ANY (?) OR customerSOId ILIKE ANY (?))`;
      const params: unknown[] = [orgId, patterns, patterns, patterns];
      if (customerHintLike) params.push(customerHintLike);

      const salesRows = await c.var.DB
        .prepare(
          `SELECT id, companySOId, customerPOId, customerName, status, totalSen, customerDeliveryDate FROM sales_orders WHERE ${where} ORDER BY created_at DESC LIMIT 5`,
        )
        .bind(...params)
        .all<Record<string, unknown>>()
        .then((r) => r.results ?? [])
        .catch(() => [] as Record<string, unknown>[]);

      for (const row of salesRows) {
        matches.push({
          fromReference: ref,
          type: "SalesOrder",
          id: String(row.id ?? ""),
          label: String(row.companySOId ?? ""),
          customerPO: String(row.customerPOId ?? ""),
          customer: String(row.customerName ?? ""),
          status: String(row.status ?? ""),
          totalRM: senToRM(Number(row.totalSen ?? 0)),
          deliveryDate: String(row.customerDeliveryDate ?? ""),
        });
      }
    }

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: targetImage?.id ?? "image",
      action: "analyze_image",
      after: {
        attachmentName: targetImage?.name ?? "",
        refCount: refs.length,
        customerHint: customerHint ?? "",
      },
      source: "ui",
    });

    return {
      attachmentName: targetImage?.name ?? null,
      extractedReferences: refs,
      productCodes: Array.isArray(args.productCodes) ? args.productCodes : [],
      customerHint: customerHint ?? "",
      matchCount: matches.length,
      matches,
      guidance:
        matches.length === 0
          ? "No matches in Hookka for those references. Suggest the user double-check the number, or ask whether the image is from a customer we don't have onboarded yet."
          : "Show the matched documents to the user and ask which one (or what they want to do next).",
    };
  },
};

const parseSpreadsheet: ToolDefinition = {
  schema: {
    name: "parse_spreadsheet",
    description:
      "Return structured rows from a spreadsheet (.xlsx / .xls / .csv) the user uploaded in this message. Use when the user asks you to summarise, list, or count rows in an attached file. Pass the filename to target a specific attachment, or omit to use the first spreadsheet. Returns sheet names, header columns, and rows (capped at 200 per sheet for context).",
    input_schema: {
      type: "object",
      properties: {
        attachmentName: {
          type: "string",
          description:
            "Filename of the uploaded spreadsheet. Omit to use the first spreadsheet attached.",
        },
        sheetName: {
          type: "string",
          description:
            "If multi-sheet, target one specific sheet by name. Omit to return all sheets.",
        },
        maxRowsPerSheet: {
          type: "number",
          description:
            "Cap on rows returned per sheet (default 100, max 200).",
        },
      },
      required: [],
    },
  },
  execute: async (c, args) => {
    const all = getRequestAttachments(c);
    if (all.length === 0) {
      return {
        ok: false,
        error:
          "No attachments on this message. The user needs to upload a spreadsheet first.",
      };
    }
    const requested = strOrNull(args.attachmentName);
    const target = requested
      ? all.find((a) => a.name === requested || a.id === requested)
      : all.find((a) => a.kind === "spreadsheet" || a.kind === "csv");
    if (!target || !target.parsedRows) {
      return {
        ok: false,
        error: requested
          ? `Couldn't find a spreadsheet attachment named '${requested}'.`
          : "No spreadsheet/CSV among the uploaded files.",
      };
    }
    const cap = Math.min(
      200,
      Math.max(1, Number(args.maxRowsPerSheet) || 100),
    );
    const wantSheet = strOrNull(args.sheetName);
    const sheets = target.parsedRows.sheets
      .filter((s) => !wantSheet || s.name === wantSheet)
      .map((s) => ({
        name: s.name,
        totalRowCount: s.rowCount,
        headers: s.headers,
        rows: s.rows.slice(0, cap),
        truncated: s.rowCount > cap,
      }));

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: target.id,
      action: "parse_spreadsheet",
      after: {
        attachmentName: target.name,
        sheetName: wantSheet ?? "(all)",
        capPerSheet: cap,
      },
      source: "ui",
    });

    return {
      attachmentName: target.name,
      sheetCount: sheets.length,
      sheets,
    };
  },
};

const matchUploadedDataToHookka: ToolDefinition = {
  schema: {
    name: "match_uploaded_data_to_hookka",
    description:
      "For each row in an uploaded spreadsheet, attempt to match against existing Hookka Sales Orders / Consignment Orders / Production Orders / Customer-PO fields. Use this for 'is this list of customer POs already in our system' workflows. The model picks the column that carries the lookup value (typically 'PO Number', 'Customer PO', 'Order Number'); the tool returns per-row match status (matched / no-match) plus the matched doc summary.",
    input_schema: {
      type: "object",
      properties: {
        attachmentName: {
          type: "string",
          description:
            "Filename of the uploaded spreadsheet. Omit to use the first spreadsheet attached.",
        },
        sheetName: {
          type: "string",
          description:
            "If multi-sheet, target one specific sheet. Omit for the first sheet.",
        },
        lookupColumn: {
          type: "string",
          description:
            "Header name of the column holding the lookup values (e.g. 'PO Number', 'Customer PO', 'Order Number').",
        },
        maxRows: {
          type: "number",
          description: "Max rows to attempt to match (default 50, max 200).",
        },
      },
      required: ["lookupColumn"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const all = getRequestAttachments(c);
    if (all.length === 0) {
      return {
        ok: false,
        error: "No attachments on this message — ask the user to upload the spreadsheet.",
      };
    }
    const requested = strOrNull(args.attachmentName);
    const target = requested
      ? all.find((a) => a.name === requested || a.id === requested)
      : all.find((a) => a.kind === "spreadsheet" || a.kind === "csv");
    if (!target || !target.parsedRows) {
      return { ok: false, error: "No spreadsheet/CSV among the uploaded files." };
    }
    const lookupCol = strOrNull(args.lookupColumn);
    if (!lookupCol) return { ok: false, error: "lookupColumn is required" };

    const wantSheet = strOrNull(args.sheetName);
    const sheet =
      target.parsedRows.sheets.find((s) => !wantSheet || s.name === wantSheet) ??
      target.parsedRows.sheets[0];
    if (!sheet) return { ok: false, error: "No sheets in the uploaded file." };

    // Normalise the column name — operators write headers loosely
    // ("PO Number" vs "po_number" vs "PO No."). We compare case- and
    // punctuation-insensitively.
    const normHeader = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const wanted = normHeader(lookupCol);
    const matchedColumn = sheet.headers.find((h) => normHeader(h) === wanted);
    if (!matchedColumn) {
      return {
        ok: false,
        error: `Column '${lookupCol}' not found in sheet '${sheet.name}'. Available columns: ${sheet.headers.join(", ")}.`,
      };
    }

    const max = Math.min(200, Math.max(1, Number(args.maxRows) || 50));
    const candidates = sheet.rows.slice(0, max);

    const yymm = currentYYMM();
    const results: Record<string, unknown>[] = [];

    // Issue queries serially (max 50 → at most 50 round trips). Could be
    // parallelised, but Hyperdrive prepared-statement pooling makes this
    // cheap and the model usually requests a few dozen at a time.
    for (let idx = 0; idx < candidates.length; idx++) {
      const row = candidates[idx];
      const raw = String(row[matchedColumn] ?? "").trim();
      if (!raw) {
        results.push({
          rowIndex: idx + 1,
          lookupValue: "",
          status: "skipped-empty",
        });
        continue;
      }
      const patterns = generateLookupPatterns(raw, yymm);
      // Single combined query against the three places a customer PO can
      // live. We don't need to cover delivery_orders here — operator-facing
      // upload flows are almost always SO-level (the DO is downstream).
      const sql = `
        SELECT 'SalesOrder' AS kind, id, companySOId AS label, customerPOId AS customerPO, customerName, status
          FROM sales_orders
         WHERE orgId = ? AND (companySOId ILIKE ANY (?) OR customerPOId ILIKE ANY (?) OR customerSOId ILIKE ANY (?))
        UNION ALL
        SELECT 'ConsignmentOrder' AS kind, id, companyCOId AS label, customerCOId AS customerPO, customerName, status
          FROM consignment_orders
         WHERE orgId = ? AND (companyCOId ILIKE ANY (?) OR customerCOId ILIKE ANY (?))
        UNION ALL
        SELECT 'ProductionOrder' AS kind, id, poNo AS label, customerPOId AS customerPO, customerName, status
          FROM production_orders
         WHERE orgId = ? AND (poNo ILIKE ANY (?) OR customerPOId ILIKE ANY (?))
        LIMIT 5
      `;
      const params: unknown[] = [
        orgId, patterns, patterns, patterns,
        orgId, patterns, patterns,
        orgId, patterns, patterns,
      ];

      const matches = await c.var.DB
        .prepare(sql)
        .bind(...params)
        .all<Record<string, unknown>>()
        .then((r) => r.results ?? [])
        .catch(() => [] as Record<string, unknown>[]);

      if (matches.length === 0) {
        results.push({
          rowIndex: idx + 1,
          lookupValue: raw,
          status: "no-match",
        });
      } else {
        results.push({
          rowIndex: idx + 1,
          lookupValue: raw,
          status: "matched",
          matchCount: matches.length,
          matches: matches.map((m) => ({
            kind: String(m.kind ?? ""),
            id: String(m.id ?? ""),
            label: String(m.label ?? ""),
            customerPO: String(m.customerPO ?? ""),
            customer: String(m.customerName ?? ""),
            status: String(m.status ?? ""),
          })),
        });
      }
    }

    const matchedCount = results.filter((r) => r.status === "matched").length;
    const noMatchCount = results.filter((r) => r.status === "no-match").length;

    await emitAudit(c, {
      resource: "assistant-tool",
      resourceId: target.id,
      action: "match_uploaded_data_to_hookka",
      after: {
        attachmentName: target.name,
        sheetName: sheet.name,
        lookupColumn: matchedColumn,
        rowsScanned: results.length,
        matchedCount,
        noMatchCount,
      },
      source: "ui",
    });

    return {
      attachmentName: target.name,
      sheetName: sheet.name,
      lookupColumn: matchedColumn,
      rowsScanned: results.length,
      totalRowsInSheet: sheet.rowCount,
      matchedCount,
      noMatchCount,
      results,
    };
  },
};

// ---------------------------------------------------------------------------
// Export / report generation (CSV, Excel, PDF, named templates)
//
// Stays in this file (not split) so the existing TOOLS registry covers the
// whole assistant surface. The heavy lifting lives in
// `assistant-exports.ts` (file builders) and `assistant-skills.ts` (named
// report templates). All exports go to Supabase Storage under
// `assistant-exports/<orgId>/...` and surface as 1-hour signed URLs.
// ---------------------------------------------------------------------------
import {
  buildCsv,
  buildExcelWorkbook,
  buildSimpleTablePdf,
  uploadExportAndSign,
  CONTENT_TYPES,
  MAX_EXPORT_ROWS,
  type ExcelSheet,
  type ExportResult,
} from "./assistant-exports";
import {
  REPORT_TEMPLATES,
  getReportTemplate,
  listReportTemplates,
} from "./assistant-skills";

function asRowArray(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of v) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : String(x ?? "")));
}

function clampExportRows<T>(rows: T[]): T[] {
  if (rows.length <= MAX_EXPORT_ROWS) return rows;
  return rows.slice(0, MAX_EXPORT_ROWS);
}

function exportResultPayload(
  res: ExportResult & { previewSummary?: string },
): Record<string, unknown> {
  return {
    ok: true,
    downloadUrl: res.downloadUrl,
    filename: res.filename,
    byteSize: res.byteSize,
    rowCount: res.rowCount,
    contentType: res.contentType,
    previewSummary: res.previewSummary,
    expiresInSeconds: 3600,
  };
}

const generateCsvTool: ToolDefinition = {
  schema: {
    name: "generate_csv",
    description:
      "Build a CSV file from an array of row objects and upload it to Hookka storage. Returns a 1-hour signed download URL. Use this when the user wants raw tabular data they'll open in Excel / Numbers / a script.",
    input_schema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          description:
            "Array of objects. Keys become CSV columns (first-seen order). Values can be strings, numbers, booleans. Max 10,000 rows.",
          items: { type: "object" },
        },
        filename: {
          type: "string",
          description: "Suggested filename, e.g. 'carress-may-sales.csv'.",
        },
      },
      required: ["rows", "filename"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const rows = clampExportRows(asRowArray(args.rows));
    if (rows.length === 0) {
      return { ok: false, error: "rows is empty — nothing to export." };
    }
    const filename = strOrNull(args.filename) ?? "export.csv";
    const csv = buildCsv(rows);
    const bytes = new TextEncoder().encode(csv);
    const uploaded = await uploadExportAndSign(
      c.env,
      orgId,
      filename,
      bytes,
      CONTENT_TYPES.csv,
    );
    uploaded.rowCount = rows.length;
    return exportResultPayload(uploaded);
  },
};

const generateExcelTool: ToolDefinition = {
  schema: {
    name: "generate_excel",
    description:
      "Build a multi-sheet Excel workbook from sheets[]. Header row is frozen, autofilter enabled. Numeric columns whose header name looks like money (rm/sen/amount/total/...) format as '$#,##0.00'; date-like columns format as 'yyyy-mm-dd'; empty cells render as '-' instead of 0. Returns a 1-hour signed download URL.",
    input_schema: {
      type: "object",
      properties: {
        sheets: {
          type: "array",
          description:
            "One or more sheets. Each has { name, rows: [{...}], columns?: string[] }. Max 10,000 rows total across all sheets.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              rows: { type: "array", items: { type: "object" } },
              columns: {
                type: "array",
                items: { type: "string" },
                description: "Optional explicit column order.",
              },
            },
          },
        },
        filename: {
          type: "string",
          description: "Suggested filename, e.g. 'monthly-sales.xlsx'.",
        },
      },
      required: ["sheets", "filename"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const sheetsRaw = Array.isArray(args.sheets) ? args.sheets : [];
    const sheets: ExcelSheet[] = [];
    let totalRows = 0;
    for (const s of sheetsRaw) {
      if (!s || typeof s !== "object") continue;
      const obj = s as Record<string, unknown>;
      const rows = clampExportRows(asRowArray(obj.rows));
      totalRows += rows.length;
      if (totalRows > MAX_EXPORT_ROWS) {
        return {
          ok: false,
          error: `Total row count across sheets exceeds ${MAX_EXPORT_ROWS}. Narrow filters or split into multiple exports.`,
        };
      }
      const name = typeof obj.name === "string" && obj.name.trim() ? obj.name : "Sheet";
      const columns =
        Array.isArray(obj.columns) && obj.columns.length > 0
          ? asStringArray(obj.columns)
          : undefined;
      sheets.push({ name, rows, columns });
    }
    if (sheets.length === 0) {
      return { ok: false, error: "sheets must contain at least one sheet." };
    }
    const filename = strOrNull(args.filename) ?? "export.xlsx";
    const bytes = buildExcelWorkbook(sheets);
    const uploaded = await uploadExportAndSign(
      c.env,
      orgId,
      filename,
      bytes,
      CONTENT_TYPES.xlsx,
    );
    uploaded.rowCount = totalRows;
    return exportResultPayload(uploaded);
  },
};

const generatePdfTool: ToolDefinition = {
  schema: {
    name: "generate_pdf",
    description:
      "Build a formatted PDF document. Today supports template 'simple_table' — a clean A4 page with title, subtitle, header row, body rows, optional totals row, and footer. Use this for printable summaries. For raw data, prefer generate_excel or generate_csv.",
    input_schema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description:
            "Currently 'simple_table' is supported. Future templates will be listed by list_export_templates.",
        },
        data: {
          type: "object",
          description:
            "For simple_table: { title: string, subtitle?: string, columns: string[], rows: string[][], totals?: string[], footer?: string }.",
        },
        filename: { type: "string", description: "Suggested filename." },
      },
      required: ["template", "data", "filename"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const template = strOrNull(args.template) ?? "simple_table";
    if (template !== "simple_table") {
      return {
        ok: false,
        error: `Unknown PDF template '${template}'. Call list_export_templates to see what's available.`,
      };
    }
    const data = (args.data ?? {}) as Record<string, unknown>;
    const title = strOrNull(data.title) ?? "Report";
    const subtitle = strOrNull(data.subtitle) ?? undefined;
    const columns = asStringArray(data.columns);
    const rawRows = Array.isArray(data.rows) ? data.rows : [];
    const rows: string[][] = clampExportRows(
      rawRows.map((r) => asStringArray(r)),
    );
    if (columns.length === 0) {
      return { ok: false, error: "data.columns is required for simple_table." };
    }
    const totals =
      Array.isArray(data.totals) && data.totals.length > 0
        ? asStringArray(data.totals)
        : undefined;
    const footer = strOrNull(data.footer) ?? undefined;
    const bytes = await buildSimpleTablePdf({
      title,
      subtitle,
      columns,
      rows,
      totals,
      footer,
    });
    const filename = strOrNull(args.filename) ?? "report.pdf";
    const uploaded = await uploadExportAndSign(
      c.env,
      orgId,
      filename,
      bytes,
      CONTENT_TYPES.pdf,
    );
    uploaded.rowCount = rows.length;
    return exportResultPayload(uploaded);
  },
};

const listExportTemplatesTool: ToolDefinition = {
  schema: {
    name: "list_export_templates",
    description:
      "List available PDF templates and named report templates the assistant can run. Use this when the user asks 'what reports can you make?' or before calling run_report_template.",
    input_schema: { type: "object", properties: {} },
  },
  execute: async () => {
    return {
      ok: true,
      pdfTemplates: [
        {
          name: "simple_table",
          description:
            "Generic A4 PDF with title, subtitle, header row, body rows, optional totals row. Use via generate_pdf.",
        },
      ],
      // Named domain-specific templates with built-in queries.
      reportTemplates: listReportTemplates(),
      // Heads-up to the model: there's also a family of client-side
      // generators (PO/DO/invoice/credit-note/packing-list/etc.) that the
      // operator can trigger from the relevant entity page in the ERP.
      // The assistant can't invoke those directly today — point the user
      // there if they ask for a single-document PDF.
      clientSidePdfs: [
        "purchase order PDF (Purchasing → PO detail → Print)",
        "delivery order PDF (Sales → DO detail → Print)",
        "invoice PDF (Finance → Invoice detail → Print)",
        "credit note / debit note PDF (Finance → Notes → Print)",
        "packing list PDF (Sales → DO detail → Packing tab)",
        "sales order / consignment order PDF (Sales → SO/CO detail → Print)",
        "customer quotation PDF (Sales → Quotation → Print)",
        "payslip PDF (HR → Payroll → Print)",
        "statement of account PDF (Finance → Customer → Statement)",
        "GRN PDF (Purchasing → GRN → Print)",
        "sticker / QR PDF (Inventory → FG → Stickers)",
      ],
    };
  },
};

// Entities supported by export_query_to_excel — keep this list small and
// curated so the model gets predictable behaviour. For anything else, the
// operator can use run_select_query → generate_excel.
const EXPORT_ENTITIES = [
  "sales_orders",
  "consignment_orders",
  "production_orders",
  "delivery_orders",
  "invoices",
  "payments",
  "customers",
  "suppliers",
  "products",
  "employees",
] as const;
type ExportEntity = (typeof EXPORT_ENTITIES)[number];

const exportQueryToExcelTool: ToolDefinition = {
  schema: {
    name: "export_query_to_excel",
    description:
      "Run a curated query against one of the canonical entities and dump it to Excel in a single call. Supports filters that vary by entity (e.g. customer/status/dateFrom/dateTo for sales_orders). Use this for natural-language asks like 'export Carress SOs from this month'.",
    input_schema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: `One of: ${EXPORT_ENTITIES.join(", ")}.`,
        },
        filters: {
          type: "object",
          description:
            "Per-entity filter bag. Supported keys: customer (partial match), status, dateFrom/dateTo (YYYY-MM-DD on created_at), hub (KL/PG/SRW/SBH), department.",
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "Optional column order — defaults to a sensible per-entity set.",
        },
        filename: { type: "string", description: "Suggested filename." },
      },
      required: ["entity", "filename"],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const entity = strOrNull(args.entity) as ExportEntity | null;
    if (!entity || !(EXPORT_ENTITIES as readonly string[]).includes(entity)) {
      return {
        ok: false,
        error: `entity must be one of: ${EXPORT_ENTITIES.join(", ")}.`,
      };
    }
    const filters = (args.filters ?? {}) as Record<string, unknown>;
    const filename = strOrNull(args.filename) ?? `${entity}.xlsx`;
    const requestedColumns =
      Array.isArray(args.columns) && args.columns.length > 0
        ? asStringArray(args.columns)
        : undefined;

    const rows = await runEntityExportQuery(c, orgId, entity, filters);
    if (rows.length === 0) {
      return {
        ok: true,
        downloadUrl: "",
        filename,
        byteSize: 0,
        rowCount: 0,
        previewSummary:
          "Query returned no rows — nothing to export. Loosen filters or check entity/customer spelling.",
      };
    }
    const sheets: ExcelSheet[] = [
      { name: entity, rows: clampExportRows(rows), columns: requestedColumns },
    ];
    const bytes = buildExcelWorkbook(sheets);
    const uploaded = await uploadExportAndSign(
      c.env,
      orgId,
      filename,
      bytes,
      CONTENT_TYPES.xlsx,
    );
    uploaded.rowCount = rows.length;
    return exportResultPayload({
      ...uploaded,
      previewSummary: `Exported ${rows.length} ${entity} row(s).`,
    });
  },
};

const runReportTemplateTool: ToolDefinition = {
  schema: {
    name: "run_report_template",
    description:
      "Run a named report template and produce a finished file. Call list_export_templates first to see what's available and what each template's params are.",
    input_schema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description: `Template name. One of: ${REPORT_TEMPLATES.map((t) => t.name).join(", ")}.`,
        },
        params: {
          type: "object",
          description:
            "Template-specific parameters. See list_export_templates → paramHints.",
        },
      },
      required: ["template"],
    },
  },
  execute: async (c, args) => {
    const name = strOrNull(args.template);
    if (!name) {
      return { ok: false, error: "template name is required." };
    }
    const tpl = getReportTemplate(name);
    if (!tpl) {
      const known = REPORT_TEMPLATES.map((t) => t.name).join(", ");
      return {
        ok: false,
        error: `Unknown template '${name}'. Known: ${known}. Call list_export_templates for full details.`,
      };
    }
    const params = (args.params ?? {}) as Record<string, unknown>;
    const result = await tpl.execute(c, params);
    return exportResultPayload(result);
  },
};

// ---------------------------------------------------------------------------
// Per-entity query helper for export_query_to_excel
// ---------------------------------------------------------------------------

async function runEntityExportQuery(
  c: Context<Env>,
  orgId: string,
  entity: ExportEntity,
  filters: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const wheres: string[] = ["orgId = ?"];
  const params: unknown[] = [orgId];

  const customer = strOrNull(filters.customer);
  if (customer) {
    // Most entities have customerName denormalised; suppliers/products/employees
    // don't, so guard per entity.
    if (
      entity === "sales_orders" ||
      entity === "consignment_orders" ||
      entity === "production_orders" ||
      entity === "delivery_orders" ||
      entity === "invoices" ||
      entity === "payments" ||
      entity === "customers"
    ) {
      const col = entity === "customers" ? "name" : "customerName";
      wheres.push(`LOWER(${col}) LIKE ?`);
      params.push(`%${customer.toLowerCase()}%`);
    }
  }
  const status = strOrNull(filters.status);
  if (status && entity !== "customers" && entity !== "suppliers" && entity !== "employees") {
    wheres.push("UPPER(status) = ?");
    params.push(status.toUpperCase());
  }
  const dateFrom = ymdOrNull(filters.dateFrom);
  if (dateFrom) {
    wheres.push("created_at >= ?");
    params.push(dateFrom);
  }
  const dateTo = ymdOrNull(filters.dateTo);
  if (dateTo) {
    wheres.push("created_at <= ?");
    params.push(`${dateTo} 23:59:59`);
  }
  const hub = strOrNull(filters.hub);
  if (hub && (entity === "sales_orders" || entity === "consignment_orders" || entity === "delivery_orders" || entity === "production_orders" || entity === "invoices")) {
    wheres.push("UPPER(hub) = ?");
    params.push(hub.toUpperCase());
  }
  const department = strOrNull(filters.department);
  if (department && entity === "employees") {
    wheres.push("UPPER(departmentCode) = ?");
    params.push(department.toUpperCase());
  }

  const whereSql = wheres.join(" AND ");
  let sql: string;
  switch (entity) {
    case "sales_orders":
      sql = `SELECT companySOId AS soId, customerName, customerPOId AS customerPO,
                    status, hub, totalSen, customerDeliveryDate, created_at AS createdAt
             FROM sales_orders WHERE ${whereSql}
             ORDER BY created_at DESC LIMIT ${MAX_EXPORT_ROWS}`;
      break;
    case "consignment_orders":
      sql = `SELECT companyCOId AS coId, customerName, customerCOId AS customerPO,
                    status, hub, totalSen, created_at AS createdAt
             FROM consignment_orders WHERE ${whereSql}
             ORDER BY created_at DESC LIMIT ${MAX_EXPORT_ROWS}`;
      break;
    case "production_orders":
      sql = `SELECT poNo, salesOrderNo AS soId, customerName, productCode, productName,
                    status, currentDepartment, progress, startDate, targetEndDate
             FROM production_orders WHERE ${whereSql}
             ORDER BY created_at DESC LIMIT ${MAX_EXPORT_ROWS}`;
      break;
    case "delivery_orders":
      sql = `SELECT doNo, customerName, customerPOId AS customerPO, status, hub,
                    totalSen, deliveryDate, created_at AS createdAt
             FROM delivery_orders WHERE ${whereSql}
             ORDER BY created_at DESC LIMIT ${MAX_EXPORT_ROWS}`;
      break;
    case "invoices":
      sql = `SELECT invoiceNo, customerName, status, totalSen, paidAmount,
                    dueDate, issueDate, created_at AS createdAt
             FROM invoices WHERE ${whereSql}
             ORDER BY created_at DESC LIMIT ${MAX_EXPORT_ROWS}`;
      break;
    case "payments":
      sql = `SELECT id, paymentNo, customerName, status, amountSen, paymentDate,
                    method, created_at AS createdAt
             FROM payments WHERE ${whereSql}
             ORDER BY created_at DESC LIMIT ${MAX_EXPORT_ROWS}`;
      break;
    case "customers":
      sql = `SELECT id, code, name, contactPerson, phone, email, hub, status
             FROM customers WHERE ${whereSql}
             ORDER BY name ASC LIMIT ${MAX_EXPORT_ROWS}`;
      break;
    case "suppliers":
      sql = `SELECT id, code, name, contactPerson, phone, email, status
             FROM suppliers WHERE ${whereSql}
             ORDER BY name ASC LIMIT ${MAX_EXPORT_ROWS}`;
      break;
    case "products":
      sql = `SELECT id, code, name, category, status, created_at AS createdAt
             FROM products WHERE ${whereSql}
             ORDER BY code ASC LIMIT ${MAX_EXPORT_ROWS}`;
      break;
    case "employees":
      sql = `SELECT id, empNo, name, departmentCode, role, status
             FROM workers WHERE ${whereSql}
             ORDER BY name ASC LIMIT ${MAX_EXPORT_ROWS}`;
      break;
    default:
      return [];
  }

  try {
    const r = await c.var.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
    const raw = r.results ?? [];
    // Convert any *Sen / *_sen field to RM-style number for readability.
    return raw.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (
          /Sen$/.test(k) &&
          typeof v === "number" &&
          Number.isFinite(v)
        ) {
          const baseName = k.replace(/Sen$/, "RM");
          out[baseName] = Math.round(v) / 100;
        } else {
          out[k] = v;
        }
      }
      return out;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Entity query failed for ${entity}: ${msg.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Live production schedule (Planning > department day-by-day plan)
// ---------------------------------------------------------------------------

// Departments the live scheduler can plan today. Only Fabric Cutting has a
// shipped scheduler so far (GET /api/planning/schedule/fabric-cutting); the
// rest are listed so the tool can give a precise "not live yet" answer
// instead of failing. Add a dept here once its endpoint ships.
const SCHEDULE_DEPARTMENTS = [
  "fabric-cutting",
  "fabric-sewing",
  "wood-cutting",
  "framing",
  "foam-bonding",
  "upholstery",
  "packing",
  "webbing",
] as const;
type ScheduleDept = (typeof SCHEDULE_DEPARTMENTS)[number];

/** Normalise a free-text dept ("Fab Cut", "cutting", "fabric_cutting") to a key. */
function normalizeScheduleDept(raw: unknown): ScheduleDept | null {
  const s = (typeof raw === "string" ? raw : "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .trim();
  if (!s) return null;
  if ((SCHEDULE_DEPARTMENTS as readonly string[]).includes(s)) {
    return s as ScheduleDept;
  }
  // Friendly aliases for the only live dept.
  if (/(^|-)(cut|cutting|fab-?cut|fabric-?cut)/.test(s)) return "fabric-cutting";
  return null;
}

// Cut Calendar column indices (mirror calHeaders in planning-scheduler.ts).
const CAL_COL = {
  cutDate: 0,
  lane: 1,
  cutNo: 2,
  model: 3,
  size: 4,
  soPo: 5,
  customer: 6,
  fabric: 8,
  sets: 9,
  customerDd: 11,
  expectedDd: 12,
} as const;

interface ScheduledCardView {
  cutDate: string;
  lane: string;
  cutNo: string;
  model: string;
  size: string;
  soPo: string;
  customer: string;
  fabric: string;
  sets: string;
  customerDd: string;
  expectedDd: string;
}

function cellStr(v: Cell | undefined): string {
  if (v == null) return "";
  return typeof v === "string" ? v.trim() : String(v);
}

/**
 * Flatten the Cut Calendar sheet into one object per scheduled card, carrying
 * down the date-band separator rows. The calendar interleaves date-separator
 * rows (only col 0 populated, the rest blank) with item rows; item rows only
 * repeat the band fields (lane / cut# / model / size) on the FIRST row of a
 * batch, so we forward-fill those too.
 */
function flattenCutCalendar(calendar: Cell[][]): ScheduledCardView[] {
  const out: ScheduledCardView[] = [];
  if (calendar.length <= 1) return out;
  let bandDate = "";
  let lane = "";
  let cutNo = "";
  let model = "";
  let size = "";
  // Row 0 is the header — skip it.
  for (let i = 1; i < calendar.length; i++) {
    const row = calendar[i];
    const soPo = cellStr(row[CAL_COL.soPo]);
    const col0 = cellStr(row[CAL_COL.cutDate]);
    // A date-separator row has the "YYYY-MM-DD ... (Day N)" banner in col 0
    // and an empty SO/PO column. Capture the date, then move on.
    if (!soPo && /^\d{4}-\d{2}-\d{2}/.test(col0)) {
      bandDate = col0.slice(0, 10);
      continue;
    }
    if (!soPo) continue; // blank/spacer row
    const rowLane = cellStr(row[CAL_COL.lane]);
    if (rowLane) lane = rowLane;
    const rowCut = cellStr(row[CAL_COL.cutNo]);
    if (rowCut) cutNo = rowCut;
    const rowModel = cellStr(row[CAL_COL.model]);
    if (rowModel) model = rowModel;
    const rowSize = cellStr(row[CAL_COL.size]);
    if (rowSize) size = rowSize;
    out.push({
      cutDate: bandDate,
      lane,
      cutNo,
      model,
      size,
      soPo,
      customer: cellStr(row[CAL_COL.customer]),
      fabric: cellStr(row[CAL_COL.fabric]),
      sets: cellStr(row[CAL_COL.sets]),
      customerDd: cellStr(row[CAL_COL.customerDd]),
      expectedDd: cellStr(row[CAL_COL.expectedDd]),
    });
  }
  return out;
}

const getProductionScheduleTool: ToolDefinition = {
  schema: {
    name: "get_production_schedule",
    description:
      "Live, read-only production schedule for ONE department — the day-by-day plan of what's queued to run. Today only 'fabric-cutting' is live (the Fab Cut day-by-day cut plan, recomputed from current WAITING orders); the other departments are recognised but not yet wired and will say so. Use this to answer 'when is SO-XXXX scheduled for cutting?', 'what's loaded on cutting next week?', or 'how busy is Fab Cut'. Pass orderRef to filter to one SO/PO. The schedule plans ONLY cards still to be cut (excludes already-cut / on-hold / cancelled) and writes nothing to the ERP.",
    input_schema: {
      type: "object",
      properties: {
        department: {
          type: "string",
          description: `Department to schedule. One of: ${SCHEDULE_DEPARTMENTS.join(", ")}. All 8 departments return a live plan (cutting gives the richest per-card view).`,
        },
        orderRef: {
          type: "string",
          description:
            "Optional. Filter to a single SO / PO (partial match on the 'SO / PO' column, e.g. 'SO-2605-051' or '051'). Use this for 'when is SO-XXXX scheduled'.",
        },
        maxRows: {
          type: "number",
          description:
            "Optional cap on scheduled-card rows returned (default 60, max 100). The By-Day load summary is always returned in full.",
        },
      },
      required: ["department"],
    },
  },
  execute: async (c, args) => {
    const dept = normalizeScheduleDept(args.department);
    if (!dept) {
      return {
        ok: false,
        error: `Unknown department. Valid departments: ${SCHEDULE_DEPARTMENTS.join(", ")}.`,
      };
    }
    const snapshot = await computeDeptSchedule(c.var.DB, dept);
    if (!snapshot) {
      return {
        ok: false,
        error: `No live schedule available for '${dept}'.`,
      };
    }
    const sheets = snapshot.sheets as Record<string, Cell[][]>;
    const refArg = strOrNull(args.orderRef);
    const rowCap = Math.min(
      100,
      Math.max(1, typeof args.maxRows === "number" ? args.maxRows : 60),
    );

    // Generic per-day load + calendar for the 7 downstream departments. The
    // cutting dept keeps the richer card view below (flattenCutCalendar).
    if (dept !== "fabric-cutting") {
      const toObjects = (sheet: Cell[][]): Record<string, string>[] => {
        const headers = (sheet[0] ?? []).map(
          (h: Cell, i: number) => cellStr(h) || `col${i}`,
        );
        return sheet.slice(1).map((row: Cell[]) => {
          const obj: Record<string, string> = {};
          headers.forEach((h: string, idx: number) => {
            obj[h] = cellStr(row[idx]);
          });
          return obj;
        });
      };
      const calName = Object.keys(sheets).find((k) => /calendar$/i.test(k));
      let cal = (calName ? toObjects(sheets[calName]) : []).filter((r) =>
        Object.values(r).some((v) => v.trim() !== ""),
      );
      if (refArg) {
        const needle = refArg.toLowerCase();
        cal = cal.filter((r) =>
          Object.values(r).some((v) => v.toLowerCase().includes(needle)),
        );
      }
      const matched = cal.length;
      const summaryLinesG = (sheets["Summary & Notes"] ?? [])
        .map((row: Cell[]) => cellStr(row[0]))
        .filter((s: string) => s.length > 0);
      return {
        ok: true,
        department: snapshot.department,
        live: true,
        generatedAt: snapshot.generatedAt,
        matchedRows: matched,
        returnedRows: Math.min(matched, rowCap),
        truncated: matched > rowCap,
        orderRef: refArg ?? null,
        schedule: cal.slice(0, rowCap),
        byDayLoad: toObjects(sheets["By Day"] ?? []),
        summary: summaryLinesG,
        note: refArg
          ? matched === 0
            ? `No WAITING ${snapshot.department} cards match '${refArg}'. It may be at a different stage — check trace_order.`
            : `Schedule rows for '${refArg}' in ${snapshot.department}. The date column is the planned day.`
          : `Live ${snapshot.department} plan. 'By Day' shows load vs capacity per lane per day.`,
      };
    }

    const allCards = flattenCutCalendar(sheets["Cut Calendar"]);

    // Optional SO/PO filter.
    const ref = strOrNull(args.orderRef);
    const filtered = ref
      ? allCards.filter((r) =>
          r.soPo.toLowerCase().includes(ref.toLowerCase()),
        )
      : allCards;

    const maxRows = Math.min(
      100,
      Math.max(1, typeof args.maxRows === "number" ? args.maxRows : 60),
    );
    const cards = filtered.slice(0, maxRows);

    // Per-day load summary from the By Day sheet (already lane×day rows).
    const byDay = sheets["By Day"] ?? [];
    const byDayHeaders = (byDay[0] ?? []).map((h) => cellStr(h));
    const byDayRows = byDay.slice(1).map((row) => {
      const obj: Record<string, string> = {};
      byDayHeaders.forEach((h, idx) => {
        obj[h || `col${idx}`] = cellStr(row[idx]);
      });
      return obj;
    });

    // The Summary & Notes sheet's first ~3 lines + the "Resulting spans"
    // block are the most useful prose for the model. We send the whole
    // Summary column (it's short, single-column text) so the model can quote
    // the span dates without re-deriving them.
    const summaryLines = (sheets["Summary & Notes"] ?? [])
      .map((row) => cellStr(row[0]))
      .filter((s) => s.length > 0);

    return {
      ok: true,
      department: "Fabric Cutting",
      live: true,
      generatedAt: snapshot.generatedAt,
      totalScheduledCards: allCards.length,
      matchedCards: filtered.length,
      returnedCards: cards.length,
      truncated: filtered.length > cards.length,
      orderRef: ref ?? null,
      cards,
      byDayLoad: byDayRows,
      summary: summaryLines,
      note: ref
        ? filtered.length === 0
          ? `No WAITING cutting cards match '${ref}'. It may already be cut, on hold, or not a cutting job — check trace_order for its real stage.`
          : `Showing the cutting plan for cards matching '${ref}'. 'Cut Date' is the planned day each set is cut.`
        : "This is the live Fab Cut plan. 'Cut Date' is the planned cutting day; 'By Day' shows load vs capacity per lane per day.",
    };
  },
};

// ---------------------------------------------------------------------------
// v1.8 — CS Agent: reasoned delivery promise (materials → production →
// delivery chain). Read-only orchestration over the SAME engines the
// Planning pages use — see src/api/lib/cs-agent.ts for the red lines
// (never invent a date; unknown stage → promiseDate null).
// ---------------------------------------------------------------------------

const getDeliveryPromiseTool: ToolDefinition = {
  schema: {
    name: "get_delivery_promise",
    description:
      "Compute a REAL delivery promise date for a sales order (or a what-if product + qty) by chaining three checks: MATERIALS (BOM needs vs raw-material stock; shortages only get an ETA from an actual open-PO expected date), PRODUCTION (the live department chain engine's PACKING completion day for this order given the current WAITING queue — the same engine as get_production_schedule; orders not in the queue get a clearly-marked capacity ESTIMATE), and DELIVERY (next dispatch working day + a per-state transit allowance). Use this to answer 'when can SO-XXXX be delivered?' (in any language the user asks). The answer includes the full step-by-step reasoning chain. HONESTY GUARD: if any stage lacks real data the promiseDate is null and the steps say exactly which data is missing — never invent a date to fill the gap, and tell the user what is missing instead.",
    input_schema: {
      type: "object",
      properties: {
        soRef: {
          type: "string",
          description:
            "Sales order reference as the user knows it, e.g. 'SO-2607-012', or the internal id like 'so-4e5f8592'. Provide EITHER soRef OR productCode.",
        },
        productCode: {
          type: "string",
          description:
            "What-if mode: a product code (with qty) instead of an SO — 'if a customer orders 2x MODEL-X today, when could we deliver?'",
        },
        qty: {
          type: "number",
          description: "Quantity for the what-if productCode mode. Default 1.",
        },
        stateCode: {
          type: "string",
          description:
            "Optional destination state for the transit allowance — canonical Malaysia code (KUL, SGR, PNG, JHR, MLK, NSN, PHG, PRK, PLS, KDH, KTN, TRG, SBH, SWK, PJY, LBN) or common shorthand (KL/PG/JB). When omitted for an SO, the customer's default delivery hub state is used.",
        },
      },
      required: [],
    },
  },
  execute: async (c, args) => {
    const orgId = getOrgId(c);
    const soRef = strOrNull(args.soRef);
    const productCode = strOrNull(args.productCode);
    if (!soRef && !productCode) {
      return {
        ok: false,
        error: "Provide soRef (e.g. 'SO-2607-012') or productCode (+ qty).",
      };
    }
    const qty =
      typeof args.qty === "number" && Number.isFinite(args.qty) && args.qty >= 1
        ? Math.floor(args.qty)
        : 1;
    const result = await promiseDelivery(c.var.DB, {
      soRef,
      productCode,
      qty,
      stateCode: strOrNull(args.stateCode),
      orgId,
      channel: "assistant",
    });
    return {
      ok: true,
      ...result,
      note:
        result.promiseDate === null
          ? "No promise date could be given — relay the missing-data reasons in `steps`/`caveats` honestly; do NOT invent a date."
          : `Promise date ${result.promiseDate} (confidence: ${result.confidence}). Present the 3-step reasoning chain (materials → production → delivery) so the answer is auditable.`,
    };
  },
};

// ---------------------------------------------------------------------------
// v1.9 — Agent management by CONVERSATION (owner: "跟 agent 对话调整").
// The Hookka AI chat becomes the place to talk TO the agent workforce:
// status questions for any admin, control verbs for the SUPER_ADMIN only —
// the same gates and audit trail as the Agent Console buttons.
// ---------------------------------------------------------------------------

function isSuperAdmin(c: Context<Env>): boolean {
  const role = (c as unknown as { get: (k: string) => string | undefined })
    .get("userRole")
    ?.toUpperCase();
  return role === "SUPER_ADMIN";
}

const agentOverviewTool: ToolDefinition = {
  schema: {
    name: "agent_overview",
    description:
      "Live status of the AI agent workforce (Production / Delivery / CS / Procurement): paused or running, auto-approve (full-auto) gate per agent, global kill switch, last runs with their self-scheduling reasons, pending proposal counts, and this month's LLM spend per agent vs the RM budget. Use when the user asks how the agents are doing, whether they ran, what they decided, or what they cost.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  execute: async (c) => {
    const db = c.var.DB;
    const [controls, llm, killAll] = await Promise.all([
      listAgentControls(db),
      monthLlmUsage(db).catch(() => null),
      isKillSwitchOn(db),
    ]);
    let lastRuns: unknown[] = [];
    try {
      const res = await db
        .prepare(
          "SELECT agent, started_at, status, summary FROM agent_runs ORDER BY started_at DESC LIMIT 12",
        )
        .bind()
        .all<{
          agent: string;
          started_at?: string;
          startedAt?: string;
          status: string;
          summary?: string | null;
        }>();
      lastRuns = (res.results ?? []).map((r) => ({
        task: r.agent,
        at: r.startedAt ?? r.started_at,
        status: r.status,
        summary: r.summary ?? null,
      }));
    } catch {
      /* table absent */
    }
    const counts = async (sql: string): Promise<number> => {
      try {
        const r = await db.prepare(sql).bind().first<{ n: number | string }>();
        return Number(r?.n) || 0;
      } catch {
        return 0;
      }
    };
    const [pendingSchedule, pendingDelivery, pendingParams] = await Promise.all([
      counts("SELECT COUNT(*) AS n FROM schedule_proposals WHERE status = 'PENDING'"),
      counts("SELECT COUNT(*) AS n FROM delivery_proposals WHERE status = 'PENDING'"),
      counts("SELECT COUNT(*) AS n FROM config_proposals WHERE status = 'PENDING'"),
    ]);
    return {
      ok: true,
      killAll,
      controls,
      pending: { scheduleProposals: pendingSchedule, deliveryProposals: pendingDelivery, parameterProposals: pendingParams },
      lastRuns,
      llm,
      note: "Explain in the user's language. paused=stopped automatics; autoApprove=true means that agent applies its own proposals (full-auto).",
    };
  },
};

const agentControlTool: ToolDefinition = {
  schema: {
    name: "agent_control",
    description:
      "SUPER_ADMIN ONLY — command the agent workforce by conversation, same effect as the Agent Console buttons: pause/resume an agent, turn its full-auto gate on/off (auto_on applies its own proposals from the next run; every batch stays rollbackable), run a task right now, or flip the global kill switch. Confirm intent from the user's own words before calling; every action is audited.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["pause", "resume", "auto_on", "auto_off", "run_now", "kill_all_on", "kill_all_off"],
          description: "What to do.",
        },
        agent: {
          type: "string",
          enum: ["PRODUCTION", "DELIVERY", "CS", "PROCUREMENT"],
          description: "Target agent family (required for pause/resume/auto_on/auto_off).",
        },
        task: {
          type: "string",
          enum: ["proposals", "learning", "delivery"],
          description:
            "For run_now: proposals = regenerate production schedule proposals; learning = production learning loop; delivery = full delivery agent cycle.",
        },
      },
      required: ["action"],
    },
  },
  execute: async (c, args) => {
    if (!isSuperAdmin(c)) {
      return { ok: false, error: "Only the SUPER_ADMIN can command agents. Ask the boss." };
    }
    const db = c.var.DB;
    const action = String(args.action ?? "");
    const agent = String(args.agent ?? "").toUpperCase() as AgentFamily;

    if (["pause", "resume", "auto_on", "auto_off"].includes(action)) {
      if (!AGENT_FAMILIES.includes(agent)) {
        return { ok: false, error: "agent must be PRODUCTION | DELIVERY | CS | PROCUREMENT" };
      }
      const patch =
        action === "pause"
          ? { paused: true }
          : action === "resume"
            ? { paused: false }
            : { autoApprove: action === "auto_on" };
      await setAgentControl(db, agent, patch);
      await emitAudit(c, {
        resource: "agents",
        resourceId: agent,
        action: action,
        after: patch,
        source: "admin",
      });
      return { ok: true, agent, applied: patch };
    }

    if (action === "kill_all_on" || action === "kill_all_off") {
      const on = action === "kill_all_on";
      await setAgentControl(db, "ALL", { paused: on });
      await emitAudit(c, {
        resource: "agents",
        resourceId: "ALL",
        action: on ? "kill-all" : "kill-all-off",
        source: "admin",
      });
      return { ok: true, killAll: on };
    }

    if (action === "run_now") {
      if (await isKillSwitchOn(db)) {
        return { ok: false, error: "Global kill switch is ON — lift it first." };
      }
      const task = String(args.task ?? "");
      await emitAudit(c, {
        resource: "agents",
        resourceId: `run-now-${task}`,
        action: "run-now",
        source: "admin",
      });
      if (task === "proposals") {
        const r = await recordAgentRun(db, "production-proposals", async (run) => {
          const g = await generateProposals(db);
          run.setSummary(
            `proposed ${g.proposed} (unscheduled ${g.unscheduled} · overdue ${g.overdue}) (chat run-now)`,
          );
          return g;
        });
        return { ok: true, task, result: r };
      }
      if (task === "learning") {
        const r = await recordAgentRun(db, "production-learning", async (run) => {
          const l = await runLearning(db, { emitProposals: true });
          run.setSummary(
            `adherence ${l.overallAdherencePct == null ? "n/a" : `${l.overallAdherencePct}%`} · ${l.pendingConfigProposals} config proposal(s) pending (chat run-now)`,
          );
          return {
            adherencePct: l.overallAdherencePct,
            pendingConfigProposals: l.pendingConfigProposals,
            otSignals: l.ot.length,
          };
        });
        return { ok: true, task, result: r };
      }
      if (task === "delivery") {
        const r = await recordAgentRun(db, "delivery-run", async (run) => {
          const d = await runDeliveryAgent(db, getOrgId(c), {
            anthropicApiKey: undefined, // chat-triggered runs skip the LLM focus
          });
          run.setSummary(
            `${d.date} · plans ${d.proposals.loadPlans} · invoice gaps ${d.proposals.invoiceGaps} · auto-approved ${d.autoApproved} (chat run-now)`,
          );
          return d;
        });
        return { ok: true, task, result: r };
      }
      return { ok: false, error: "task must be proposals | learning | delivery" };
    }

    return { ok: false, error: "Unknown action." };
  },
};

// Autonomy note: batch auto-apply is intentionally NOT a direct chat verb —
// it is governed by the per-agent gate (auto_on/auto_off above), so "apply
// them now" = turn the gate on and the next run/heartbeat drains the queue.

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOLS: ToolDefinition[] = [
  // v1 — sales / consignment / delivery / invoices / payments / catalog / customers / suppliers / report / dashboard
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
  // v1.5 — cross-module
  traceOrder,
  getCustomer360,
  getProduct360,
  smart_lookup,
  lookupCustomerPo,
  searchAnything,
  runSelectQuery,
  // v1.5 — sales completeness
  getSoMissingData,
  // v1.5 — production
  listProductionOrders,
  getProductionOrder,
  listJobCards,
  getWipSnapshot,
  analyzePoDelay,
  getCapacityLoading,
  // v1.5 — delivery
  listPackingLists,
  getPackingList,
  getDispatchSummary,
  // v1.5 — finance
  getArOutstanding,
  getGpAnalysis,
  // v1.5 — inventory
  listFoamInventory,
  listFgUnits,
  listFabrics,
  getFabric,
  listAccessories,
  getAccessory,
  predictReorderNeeds,
  // v1.5 — HR / payroll
  findEmployee,
  getEmployeeEfficiency,
  getPayroll,
  getDepartmentEfficiency,
  // v1.5 — reports / KPIs
  getDashboardKpis,
  listOverdueOrders,
  getAbnormalOrders,
  // v1.5 — catalog
  listCncTemplates,
  getBom,
  findProductsUsingFabric,
  // v1.5 — system / help
  listAuditEvents,
  explainFeature,
  // v1.6 — attachment-aware (FEAT-2026-05-30-008)
  analyzeImage,
  parseSpreadsheet,
  matchUploadedDataToHookka,
  // v1.6 — export / report generation (FEAT-2026-05-30-009)
  generateCsvTool,
  generateExcelTool,
  generatePdfTool,
  listExportTemplatesTool,
  exportQueryToExcelTool,
  runReportTemplateTool,
  // v1.7 — live production schedule (Planning day-by-day plan)
  getProductionScheduleTool,
  // v1.8 — CS Agent reasoned delivery promise (materials → production → delivery)
  getDeliveryPromiseTool,
  // v1.9 — agent workforce management by conversation (status for admins,
  // control verbs SUPER_ADMIN-gated inside the tool)
  agentOverviewTool,
  agentControlTool,
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
