// ---------------------------------------------------------------------------
// Hono app for Cloudflare Workers runtime.
//
// This file mirrors src/api/index.ts but:
//   - does NOT call serve() from @hono/node-server (Workers don't need it)
//   - types `Env` bindings so routes can access `c.env.DB` (D1 client)
//   - exports the Hono `app` as default so Pages Functions can call
//     `app.fetch(request, env, ctx)`
//
// Routes are being progressively migrated from src/api/routes/*.ts (which
// still use the in-memory mock-data arrays) to Workers-compatible versions
// that query D1. Until migration is complete, both files coexist.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { cors } from "hono/cors";

export type Env = {
  Bindings: {
    DB: D1Database;
    ENVIRONMENT: string;
    API_CORS_ORIGIN: string;
  };
};

const app = new Hono<Env>();

// CORS — allow the Pages origin + local Vite dev server. Override via
// wrangler.toml [vars] API_CORS_ORIGIN for preview/prod.
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.API_CORS_ORIGIN || "http://localhost:3000";
      // Accept the configured origin and the wrangler-dev default.
      if (origin === allowed || origin === "http://localhost:8787") return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// Health check — used by Pages build step and uptime monitors.
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    runtime: "cloudflare-workers",
    env: c.env.ENVIRONMENT,
    ts: Date.now(),
  }),
);

// ---------------------------------------------------------------------------
// Route registrations — add each migrated route here.
// ---------------------------------------------------------------------------
import customers from "./routes-d1/customers";
import bom from "./routes-d1/bom";
import products from "./routes-d1/products";
import productConfigs from "./routes-d1/product-configs";
import workers from "./routes-d1/workers";
import workerAuth from "./routes-d1/worker-auth";
import departments from "./routes-d1/departments";
import customerHubs from "./routes-d1/customer-hubs";
import organisations from "./routes-d1/organisations";
import salesOrders from "./routes-d1/sales-orders";
import purchaseOrders from "./routes-d1/purchase-orders";
import creditNotes from "./routes-d1/credit-notes";
import debitNotes from "./routes-d1/debit-notes";
import eInvoices from "./routes-d1/e-invoices";
import threeWayMatch from "./routes-d1/three-way-match";
import deliveryOrders from "./routes-d1/delivery-orders";
import invoices from "./routes-d1/invoices";
import payments from "./routes-d1/payments";

app.route("/api/customers", customers);
app.route("/api/bom", bom);
app.route("/api/products", products);
app.route("/api/product-configs", productConfigs);
app.route("/api/workers", workers);
app.route("/api/worker-auth", workerAuth);
app.route("/api/departments", departments);
app.route("/api/customer-hubs", customerHubs);
app.route("/api/organisations", organisations);
app.route("/api/sales-orders", salesOrders);
app.route("/api/purchase-orders", purchaseOrders);
app.route("/api/credit-notes", creditNotes);
app.route("/api/debit-notes", debitNotes);
app.route("/api/e-invoices", eInvoices);
app.route("/api/three-way-match", threeWayMatch);
app.route("/api/delivery-orders", deliveryOrders);
app.route("/api/invoices", invoices);
app.route("/api/payments", payments);

// 501 for any /api path we haven't migrated yet.
app.all("/api/*", (c) =>
  c.json(
    {
      success: false,
      error: "Not migrated to D1 yet",
      path: c.req.path,
    },
    501,
  ),
);

export default app;
