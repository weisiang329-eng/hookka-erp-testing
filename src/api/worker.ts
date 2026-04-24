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
    APP_URL: string;              // e.g. "http://localhost:8788" or "https://hookka-erp-testing.pages.dev"
    RESEND_API_KEY?: string;      // Optional — set via wrangler secret for prod, .dev.vars for local
    RESEND_FROM_EMAIL: string;    // e.g. "Hookka ERP <onboarding@resend.dev>"
    ANTHROPIC_API_KEY?: string;   // Claude API key — set via `wrangler secret put ANTHROPIC_API_KEY`. Used by routes-d1/scan-po.ts.
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

// Global auth gate for /api/* — skips PUBLIC_PATHS (login/logout/health) and
// PUBLIC_PREFIXES (worker-auth, worker, fg-units) handled inside the middleware.
app.use("/api/*", authMiddleware);

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
import customerProducts from "./routes-d1/customer-products";
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
// Phase 4 — production / inventory / supplier
import productionOrders from "./routes-d1/production-orders";
import inventory from "./routes-d1/inventory";
import rawMaterials from "./routes-d1/raw-materials";
import rmBatches from "./routes-d1/rm-batches";
import grn from "./routes-d1/grn";
import costLedger from "./routes-d1/cost-ledger";
import fgUnits from "./routes-d1/fg-units";
import fabricTracking from "./routes-d1/fabric-tracking";
import fabrics from "./routes-d1/fabrics";
import warehouse from "./routes-d1/warehouse";
import stockAccounts from "./routes-d1/stock-accounts";
import stockValue from "./routes-d1/stock-value";
import goodsInTransit from "./routes-d1/goods-in-transit";
import suppliers from "./routes-d1/suppliers";
import supplierMaterials from "./routes-d1/supplier-materials";
import supplierScorecards from "./routes-d1/supplier-scorecards";
import priceHistory from "./routes-d1/price-history";
// Auth — login portal + admin user CRUD
import auth from "./routes-d1/auth";
import users from "./routes-d1/users";
import presence from "./routes-d1/presence";
import bomMasterTemplates from "./routes-d1/bom-master-templates";
import kvConfig from "./routes-d1/kv-config";
import { authMiddleware } from "./lib/auth-middleware";

// Phase 5 — mock-backed routes mounted until each is migrated to D1.
// Pure Hono handlers + in-memory data from src/lib/mock-data.ts, fully
// Workers-runtime compatible. Returning real shapes (not stubs) keeps
// the UI pages from crashing on .filter/.map over envelope objects.
import accounting from "./routes-d1/accounting";
import attendance from "./routes-d1/attendance";
import cashFlow from "./routes-d1/cash-flow";
import consignments from "./routes-d1/consignments";
import consignmentNotes from "./routes-d1/consignment-notes";
import drivers from "./routes-d1/drivers";
import equipment from "./routes-d1/equipment";
import forecasts from "./routes-d1/forecasts";
import historicalSales from "./routes-d1/historical-sales";
import leaves from "./routes-d1/leaves";
import lorries from "./routes-d1/lorries";
import maintenanceLogs from "./routes-d1/maintenance-logs";
import mrp from "./routes-d1/mrp";
import notifications from "./routes-d1/notifications";
import payroll from "./routes-d1/payroll";
import payslips from "./routes-d1/payslips";
import productionLeadtimes from "./routes-d1/production-leadtimes";
import jobcardSync from "./routes-d1/jobcard-sync";
import promiseDate from "./routes-d1/promise-date";
import qcInspections from "./routes-d1/qc-inspections";
import rdProjects from "./routes-d1/rd-projects";
import scheduling from "./routes-d1/scheduling";
import scanPo from "./routes-d1/scan-po";

app.route("/api/customers", customers);
app.route("/api/bom", bom);
app.route("/api/products", products);
app.route("/api/product-configs", productConfigs);
app.route("/api/workers", workers);
app.route("/api/worker-auth", workerAuth);
app.route("/api/departments", departments);
app.route("/api/customer-hubs", customerHubs);
app.route("/api/customer-products", customerProducts);
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
// Phase 4
app.route("/api/production-orders", productionOrders);
app.route("/api/inventory", inventory);
app.route("/api/raw-materials", rawMaterials);
app.route("/api/rm-batches", rmBatches);
app.route("/api/grn", grn);
app.route("/api/cost-ledger", costLedger);
app.route("/api/fg-units", fgUnits);
app.route("/api/fabric-tracking", fabricTracking);
app.route("/api/fabrics", fabrics);
app.route("/api/warehouse", warehouse);
app.route("/api/stock-accounts", stockAccounts);
app.route("/api/stock-value", stockValue);
app.route("/api/goods-in-transit", goodsInTransit);
app.route("/api/suppliers", suppliers);
app.route("/api/supplier-materials", supplierMaterials);
app.route("/api/supplier-scorecards", supplierScorecards);
app.route("/api/price-history", priceHistory);
// Auth
app.route("/api/auth", auth);
app.route("/api/users", users);
app.route("/api/presence", presence);
app.route("/api/bom-master-templates", bomMasterTemplates);
app.route("/api/kv-config", kvConfig);

// Phase 5 — mock-backed. Same shapes as before; data lives in
// src/lib/mock-data.ts. Writes here are in-memory only (reset on deploy)
// so writes need real D1 persistence once the module is actively used.
app.route("/api/accounting", accounting);
app.route("/api/attendance", attendance);
app.route("/api/cash-flow", cashFlow);
app.route("/api/consignments", consignments);
app.route("/api/consignment-notes", consignmentNotes);
app.route("/api/drivers", drivers);
app.route("/api/equipment", equipment);
app.route("/api/forecasts", forecasts);
app.route("/api/historical-sales", historicalSales);
app.route("/api/leaves", leaves);
app.route("/api/lorries", lorries);
app.route("/api/maintenance-logs", maintenanceLogs);
app.route("/api/mrp", mrp);
app.route("/api/notifications", notifications);
app.route("/api/payroll", payroll);
app.route("/api/payslips", payslips);
// productionLeadtimes handles GET / PUT / POST /recalc-all. Mounted at
// both the legacy hyphen path (external consumers may have cached it) and
// the canonical slash path that the Planning page uses, so frontend and
// backend URLs finally agree.
app.route("/api/production-leadtimes", productionLeadtimes);
app.route("/api/production/leadtimes", productionLeadtimes);
// Reconcile each PO's job_cards set with its CURRENT BOM (inserts missing
// (wipKey, deptCode) pairs without touching existing JC dueDate/status).
// Fixes the "BOM edited after POs existed" class of bug — see
// migrations/0027, 0029 (sofa UPH/PKG backfill).
app.route("/api/production/sync-jobcards-from-bom", jobcardSync);
app.route("/api/promise-date", promiseDate);
app.route("/api/qc-inspections", qcInspections);
app.route("/api/rd-projects", rdProjects);
app.route("/api/scheduling", scheduling);
app.route("/api/scan-po", scanPo);

// Unmigrated /api/* paths — return a shape the frontend can consume without
// crashing. GET pretends to be an empty list so pages calling `.forEach` /
// `.filter` / `.map` on the response don't blow up; other methods return a
// plainly-unsupported error.
app.all("/api/*", (c) => {
  if (c.req.method === "GET") {
    return c.json({ success: true, data: [], total: 0, _stub: true, path: c.req.path });
  }
  return c.json(
    { success: false, error: "Not migrated to D1 yet", path: c.req.path },
    501,
  );
});

export default app;
