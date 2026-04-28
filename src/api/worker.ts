// ---------------------------------------------------------------------------
// Hono app for Cloudflare Pages Functions — the hookka-erp backend.
//
// Data layer:
//   Browser → Pages Functions (this app) → SupabaseAdapter (c.var.DB)
//     → postgres.js → Hyperdrive (CF pool) → Supabase Postgres (Singapore)
//
// Note: TypeScript types still reference `D1Database` because route code
// uses the SQLite-flavoured prepare/bind/all interface. SupabaseAdapter
// implements that interface over Postgres. There is no real D1 binding —
// it was retired 2026-04-27 (commit 7059259); see docs/d1-retirement-plan.md.
//
// Key bindings (wrangler.toml):
//   HYPERDRIVE       — production/preview Postgres pool to Supabase
//   SESSION_CACHE    — KV cache for auth sessions + hot lookup tables
//
// Per-request lifecycle:
//   1. CORS       — allow Pages origin + local Vite dev
//   2. timingMdw  — emits [req] / [slow-req] log lines for wrangler tail
//   3. dbInject   — constructs a SupabaseAdapter over Hyperdrive and
//                   stashes it on c.var.DB. Every authenticated route
//                   below this line transacts via c.var.DB.
//   4. authMdw    — Bearer-token gate with KV session cache (see
//                   lib/auth-middleware.ts); public endpoints registered
//                   BEFORE this line bypass auth by virtue of order.
//   5. Route handlers — imported from routes/* (Supabase-backed).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { cors } from "hono/cors";

export type Env = {
  Bindings: {
    // D1 binding removed 2026-04-27 (Phase 7). Every route uses c.var.DB
    // which is the SupabaseAdapter→Postgres adapter set up in middleware below.
    // The Bindings shape no longer exposes a raw D1Database — if a route
    // accidentally reaches for `c.env.DB`, TypeScript will catch it.
    ENVIRONMENT: string;
    API_CORS_ORIGIN: string;
    APP_URL: string;              // e.g. "http://localhost:8788" or "https://hookka-erp-testing.pages.dev"
    RESEND_API_KEY?: string;      // Optional — set via wrangler secret for prod, .dev.vars for local
    RESEND_FROM_EMAIL: string;    // e.g. "Hookka ERP <onboarding@resend.dev>"
    ANTHROPIC_API_KEY?: string;   // Claude API key — set via `wrangler secret put ANTHROPIC_API_KEY`. Used by routes/scan-po.ts.
    // Supabase (Phase 2+). Transaction-mode pooler on port 6543.
    // Local dev uses DATABASE_URL directly from .dev.vars.
    // Production / preview use the HYPERDRIVE binding below (required to
    // avoid Workers subrequest limits; see wrangler.toml).
    DATABASE_URL?: string;
    SUPABASE_URL?: string;
    SUPABASE_SERVICE_KEY?: string;
    HYPERDRIVE: Hyperdrive;
    // Shared secret expected on /api/internal/* routes that are meant to
    // be invoked by cron / ops tooling only (not public traffic).
    CRON_SECRET?: string;
    // Per-request hot cache — auth sessions + hot lookup tables (Phase 2.6/4).
    SESSION_CACHE: KVNamespace;
    // R2 bucket for invoice PDFs / BOM drawings / SO attachments (Phase B.4).
    // Optional during rollout — code paths gate on `if (env.FILES)`.
    FILES?: R2Bucket;
    // Cloudflare Queues binding for async PO emission cascade (Phase C #3).
    // Optional — falls back to synchronous inline call when absent.
    PO_EMISSION_QUEUE?: Queue;
    // OAuth client credentials (Phase B.3 / C #6).  Set via `wrangler secret put`.
    OAUTH_GOOGLE_CLIENT_ID?: string;
    OAUTH_GOOGLE_CLIENT_SECRET?: string;
    OAUTH_GOOGLE_REDIRECT_URI?: string;
    OAUTH_GOOGLE_HOSTED_DOMAIN?: string;
    JWT_SECRET?: string;
  };
  // Per-request variables.  DB is the Supabase-backed D1-compat adapter
  // installed by the middleware below; typed as D1Database so existing route
  // code keeps its D1 type surface without any `any` casts.  dbTimer is the
  // per-request DB-time aggregator created by timingMiddleware and consumed
  // by instrumentD1 (see lib/observability.ts).
  Variables: {
    DB: D1Database;
    dbTimer: import("./lib/observability").DbTimer;
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

// Request timing — emits `[req] ...` / `[slow-req] ...` lines to console so
// `wrangler tail` surfaces per-request duration. Registered before auth so
// even 401s are timed.
app.use("/api/*", timingMiddleware);

// No-cache headers on every API response. Cloudflare's edge / browser HTTP
// cache MUST NOT cache dynamic data — when the user resets D1 (or any backend
// data changes), the next API call has to hit Pages Functions, not a stale
// edge response. Without this, after a wrangler `--remote` UPDATE the user
// kept seeing pre-reset rows for minutes (Wei Siang Apr 26 2026).
app.use("/api/*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  c.res.headers.set("Pragma", "no-cache");
  c.res.headers.set("Expires", "0");
});

// DB injection — wraps the Hyperdrive-pooled Supabase client in a D1-compatible
// adapter and exposes it as `c.var.DB`.  Routes use this instead of raw D1.
// Must run before authMiddleware (which itself hits the DB to verify tokens).
// The adapter is further wrapped in instrumentD1 so every prepare/all/first/
// run/batch emits a [slow-query] line when it exceeds SLOW_QUERY_MS.
app.use("/api/*", async (c, next) => {
  const { SupabaseAdapter } = await import("./lib/supabase-compat");
  const { getSql } = await import("./lib/db-pg");
  const { instrumentD1 } = await import("./lib/observability");
  // Prefer Hyperdrive binding (production / preview on Cloudflare).  Fall
  // back to DATABASE_URL env var only for local dev without Hyperdrive.
  const url = c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL;
  if (!url) throw new Error("No database connection string available (HYPERDRIVE or DATABASE_URL)");
  const adapter = new SupabaseAdapter(getSql(url)) as unknown as D1Database;
  const timer = c.get("dbTimer"); // set by timingMiddleware
  c.set("DB", instrumentD1(adapter, new URL(c.req.url).pathname, timer));
  await next();
});

// ---------------------------------------------------------------------------
// Public routes (registered BEFORE authMiddleware)
// ---------------------------------------------------------------------------

// Health check — used by Pages build step and uptime monitors.
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    runtime: "cloudflare-workers",
    env: c.env.ENVIRONMENT,
    ts: Date.now(),
  }),
);

// Heartbeat — used to monitor the Hyperdrive → Supabase path stays healthy.
// Reveals only Postgres `NOW()` and a table count — no business data.  Kept
// public so uptime monitors and the CI smoke run without an auth dance.
app.get("/api/pg-ping", async (c) => {
  try {
    const { getSql } = await import("./lib/db-pg");
    const url = c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL;
    if (!url) throw new Error("No database connection string");
    const sql = getSql(url);
    const t0 = Date.now();
    const rows = (await sql`SELECT NOW() AS now, (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS table_count`) as unknown as { now: unknown; tableCount: number }[];
    const ms = Date.now() - t0;
    return c.json({
      ok: true,
      elapsedMs: ms,
      via: c.env.HYPERDRIVE ? "hyperdrive" : "direct",
      ...rows[0],
    });
  } catch (e) {
    // Do NOT echo driver error messages — they can leak schema / table names.
    console.error("[pg-ping] error:", e);
    return c.json({ ok: false, error: "health check failed" }, 500);
  }
});

// Phase 4 — refresh all dashboard materialized views.  Meant to be hit by
// a Cron Trigger (external cron service or a separate Worker with scheduled
// handler — Pages Functions doesn't support scheduled events directly).
// Gated by CRON_SECRET + constant-time compare.  Returns 503 (not 403)
// when the secret env var is missing on the server, so a misconfigured
// deploy fails closed instead of allowing anonymous calls.
app.post("/api/internal/refresh-mvs", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[refresh-mvs] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  const t0 = Date.now();
  try {
    await c.var.DB.prepare("SELECT refresh_dashboard_mvs()").run();
    const { invalidate } = await import("./lib/kv-cache");
    await invalidate(c, "dashboard:summary:v1");
    return c.json({ ok: true, elapsedMs: Date.now() - t0 });
  } catch (e) {
    console.error("[refresh-mvs] error:", e);
    return c.json({ ok: false, error: "refresh failed" }, 500);
  }
});

/**
 * Constant-time string equality.  Hashes both sides before comparing so the
 * comparison time depends only on the hash output length, never on the
 * secret contents.  Returns false on any length mismatch at the hash stage,
 * which is safe because the hash output is fixed-size.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// Global auth gate for /api/* — skips PUBLIC_PATHS (login/logout/health) and
// PUBLIC_PREFIXES (worker-auth, worker, fg-units) handled inside the middleware.
// MUST be registered BEFORE any route that touches business data.
app.use("/api/*", authMiddleware);

// Phase C #1 quick-win — resolves the authenticated user's orgId and stashes
// it on the Hono context. Routes consume via getOrgId(c) / withOrgScope(c, ...)
// from src/api/lib/tenant.ts. Runs AFTER authMiddleware so c.get('userId')
// is populated; bypasses public paths automatically (no userId → defaults
// to 'hookka').
app.use("/api/*", tenantMiddleware);

// ---------------------------------------------------------------------------
// Auth-gated routes (registered AFTER authMiddleware)
// ---------------------------------------------------------------------------

// Phase 4 — dashboard summary from materialized views.  Auth-gated: aggregate
// revenue + production volume are competitively sensitive.  30s KV cache.
app.get("/api/dashboard/summary", async (c) => {
  const { cached } = await import("./lib/kv-cache");
  try {
    const data = await cached(c, "dashboard:summary:v1", 30, async () => {
      // MV columns are snake_case (not in the rename map used by the D1-
      // compat adapter since they weren't in the SQLite source schema) —
      // reference them literally.  postgres.js's toCamel transform still
      // hands camelCase keys to the handler body.
      const [so, po, jc] = await Promise.all([
        c.var.DB.prepare("SELECT status, order_count, total_sen FROM mv_so_summary").all(),
        c.var.DB.prepare("SELECT status, po_count FROM mv_po_pipeline").all(),
        c.var.DB
          .prepare("SELECT department_code, status, jc_count FROM mv_jc_by_dept")
          .all(),
      ]);
      return {
        salesOrders: so.results ?? [],
        productionOrders: po.results ?? [],
        jobCards: jc.results ?? [],
      };
    });
    return c.json({ ok: true, ...data });
  } catch (e) {
    console.error("[dashboard/summary] error:", e);
    return c.json({ ok: false, error: "dashboard unavailable" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Route registrations — add each migrated route here.
// ---------------------------------------------------------------------------
import customers from "./routes/customers";
import bom from "./routes/bom";
import products from "./routes/products";
import productConfigs from "./routes/product-configs";
import workers from "./routes/workers";
import workerAuth from "./routes/worker-auth";
import departments from "./routes/departments";
import customerHubs from "./routes/customer-hubs";
import customerProducts from "./routes/customer-products";
import organisations from "./routes/organisations";
import salesOrders from "./routes/sales-orders";
import purchaseOrders from "./routes/purchase-orders";
import purchaseInvoices from "./routes/purchase-invoices";
import creditNotes from "./routes/credit-notes";
import debitNotes from "./routes/debit-notes";
import eInvoices from "./routes/e-invoices";
import threeWayMatch from "./routes/three-way-match";
import deliveryOrders from "./routes/delivery-orders";
import invoices from "./routes/invoices";
import payments from "./routes/payments";
// Phase 4 — production / inventory / supplier
import productionOrders from "./routes/production-orders";
import inventory from "./routes/inventory";
// Phase 4.5 — aggregated WIP endpoint (supersedes client-side
// deriveWIPFromPO + mergeSofaWIPSets in src/pages/inventory/index.tsx).
import inventoryWip from "./routes/inventory-wip";
import rawMaterials from "./routes/raw-materials";
import rmBatches from "./routes/rm-batches";
import grn from "./routes/grn";
import costLedger from "./routes/cost-ledger";
import fgUnits from "./routes/fg-units";
import fabricTracking from "./routes/fabric-tracking";
import fabrics from "./routes/fabrics";
import warehouse from "./routes/warehouse";
import stockAccounts from "./routes/stock-accounts";
import stockValue from "./routes/stock-value";
import goodsInTransit from "./routes/goods-in-transit";
import suppliers from "./routes/suppliers";
import supplierMaterials from "./routes/supplier-materials";
import supplierScorecards from "./routes/supplier-scorecards";
import priceHistory from "./routes/price-history";
// Auth — login portal + admin user CRUD
import auth from "./routes/auth";
// Phase B.3 — Google Workspace OAuth (federated SSO).
import authOauth from "./routes/auth-oauth";
// Phase C.6 — TOTP 2FA enrollment + verify.
import authTotp from "./routes/auth-totp";
import users from "./routes/users";
import presence from "./routes/presence";
import bomMasterTemplates from "./routes/bom-master-templates";
import kvConfig from "./routes/kv-config";
// Phase 5 — admin maintenance endpoints (archive/run, etc.)
import admin from "./routes/admin";
// Phase 6 / P6.4 — health KPI endpoint feeding /admin/health.
import adminHealth from "./routes/admin-health";
// Phase 6 — job_card_events audit log read endpoint.
import jobCards from "./routes/job-cards";
// Phase C #5 quick-win — homepage revenue chart from mv_revenue_by_month_by_org.
import dashboardRevenue from "./routes/dashboard-revenue";
// Phase C #4 quick-win — MDM duplicate-detection review queue.
import mdm from "./routes/mdm";
// Phase B.4 — file_assets storage (R2-backed). Returns 503 until the
// FILES R2 binding is wired up; see docs/R2-SETUP.md.
import files from "./routes/files";
import { authMiddleware } from "./lib/auth-middleware";
import { tenantMiddleware } from "./lib/tenant";
import { timingMiddleware } from "./lib/observability";

// Phase-5 imports — historically these were in-memory stubs, but every
// route below has since been migrated to real D1 / Supabase persistence
// (verified 2026-04-26). The import block name is kept for git-history
// continuity; the routes themselves are fully durable.
import accounting from "./routes/accounting";
import attendance from "./routes/attendance";
import workingHourEntries from "./routes/working-hour-entries";
import cashFlow from "./routes/cash-flow";
import consignments from "./routes/consignments";
import consignmentNotes from "./routes/consignment-notes";
import consignmentOrders from "./routes/consignment-orders";
import stockAdjustments from "./routes/stock-adjustments";
import drivers from "./routes/drivers";
import threePlVehicles from "./routes/three-pl-vehicles";
import threePlDrivers from "./routes/three-pl-drivers";
import equipment from "./routes/equipment";
import forecasts from "./routes/forecasts";
import historicalSales from "./routes/historical-sales";
import leaves from "./routes/leaves";
import lorries from "./routes/lorries";
import maintenanceLogs from "./routes/maintenance-logs";
import mrp from "./routes/mrp";
import notifications from "./routes/notifications";
import payroll from "./routes/payroll";
import payslips from "./routes/payslips";
import productionLeadtimes from "./routes/production-leadtimes";
import jobcardSync from "./routes/jobcard-sync";
import promiseDate from "./routes/promise-date";
import qcInspections from "./routes/qc-inspections";
import rdProjects from "./routes/rd-projects";
import scheduling from "./routes/scheduling";
import scanPo from "./routes/scan-po";

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
app.route("/api/purchase-invoices", purchaseInvoices);
app.route("/api/credit-notes", creditNotes);
app.route("/api/debit-notes", debitNotes);
app.route("/api/e-invoices", eInvoices);
app.route("/api/three-way-match", threeWayMatch);
app.route("/api/delivery-orders", deliveryOrders);
app.route("/api/invoices", invoices);
app.route("/api/payments", payments);
// Phase 4
app.route("/api/production-orders", productionOrders);
// Phase 4.5 — MUST come before /api/inventory so the more-specific path
// wins route matching (Hono picks the first mounted subapp that matches).
app.route("/api/inventory/wip", inventoryWip);
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
// MUST mount /api/auth/oauth and /api/auth/totp BEFORE /api/auth so the
// more-specific subapps win route matching (Hono picks the first registered
// subapp whose prefix matches). Otherwise the catch-all `auth` subapp would
// 404 the OAuth/TOTP paths.
app.route("/api/auth/oauth", authOauth);
app.route("/api/auth/totp", authTotp);
app.route("/api/auth", auth);
app.route("/api/users", users);
app.route("/api/presence", presence);
app.route("/api/bom-master-templates", bomMasterTemplates);
app.route("/api/kv-config", kvConfig);
// Phase 5 — admin maintenance (archive/run). Behind the normal auth gate.
// MUST mount /api/admin/health BEFORE /api/admin so the more-specific
// subapp wins route matching (Hono picks the first registered subapp
// whose prefix matches; the less-specific /api/admin would otherwise
// 404 the /health/* paths).
app.route("/api/admin/health", adminHealth);
app.route("/api/admin", admin);
// Phase 6 — job_card_events read surface. Only /:id/events for now;
// future PATCH/DELETE audit screens can mount here.
app.route("/api/job-cards", jobCards);
// Phase C #5 quick-win — revenue chart from mv_revenue_by_month_by_org.
// MUST be mounted BEFORE the catch-all /api/* stub at the bottom and
// AFTER authMiddleware so the orgId scope is in place.
app.route("/api/dashboard/revenue", dashboardRevenue);
// Phase C #4 quick-win — MDM duplicate-detection review queue. Routes
// scoped by orgId via getOrgId(c); detection-pass endpoint is admin-only
// in spirit (gated by the existing auth middleware until role-aware
// authz lands; see roadmap §1).
app.route("/api/mdm", mdm);
// Phase B.4 — file_assets API. Mounted under /api/files. Returns 503
// when env.FILES (R2 binding) is missing; see docs/R2-SETUP.md.
app.route("/api/files", files);

// Below routes were previously in-memory mock-backed (data in
// src/lib/mock-data.ts); now all D1-persistent. Comment refreshed
// 2026-04-26 — the original "writes are in-memory, reset on deploy"
// claim was stale and actively misleading the next dev.
app.route("/api/accounting", accounting);
app.route("/api/attendance", attendance);
app.route("/api/working-hour-entries", workingHourEntries);
app.route("/api/cash-flow", cashFlow);
app.route("/api/consignments", consignments);
app.route("/api/consignment-notes", consignmentNotes);
app.route("/api/consignment-orders", consignmentOrders);
app.route("/api/stock-adjustments", stockAdjustments);
app.route("/api/drivers", drivers);
app.route("/api/three-pl-vehicles", threePlVehicles);
app.route("/api/three-pl-drivers", threePlDrivers);
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
