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
    RESEND_FROM_EMAIL: string;    // e.g. "Hookka Manufacturing ERP <onboarding@resend.dev>"
    ANTHROPIC_API_KEY?: string;   // Claude API key — set via `wrangler secret put ANTHROPIC_API_KEY`. Used by routes/scan-po.ts.
    // Per-user daily cap on AI Assistant questions (routes/assistant.ts).
    // String so it can be set as a plain wrangler [var]; parsed to int with
    // a default of 10 in src/api/lib/assistant-daily-quota.ts. Applies to
    // every user including SUPER_ADMIN. Set to "0" to disable the cap.
    ASSISTANT_DAILY_LIMIT?: string;
    // Temporary kill-switch for the Hookka AI assistant (routes/assistant.ts).
    // When exactly "false", POST /api/assistant/chat returns a normal 200 SSE
    // reply with a "turned off" message before any model call. Unset or any
    // other value leaves behavior unchanged. Set "true" or remove to re-enable.
    ASSISTANT_ENABLED?: string;
    // Supabase (Phase 2+). Transaction-mode pooler on port 6543.
    // Local dev uses DATABASE_URL directly from .dev.vars.
    // Production / preview use the HYPERDRIVE binding below (required to
    // avoid Workers subrequest limits; see wrangler.toml).
    DATABASE_URL?: string;
    SUPABASE_URL?: string;
    SUPABASE_SERVICE_KEY?: string;
    HYPERDRIVE: Hyperdrive;
    // Staging Hyperdrive — bound on every deploy alongside prod. Worker
    // routes to it when c.env.ENVIRONMENT === 'preview'. See
    // wrangler.toml comment for why this is necessary.
    HYPERDRIVE_STAGING?: Hyperdrive;
    // Shared secret expected on /api/internal/* routes that are meant to
    // be invoked by cron / ops tooling only (not public traffic).
    CRON_SECRET?: string;
    // Shared secret expected on POST /api/mail-center/inbound — the standalone
    // Cloudflare Email Worker presents it as the x-mail-secret header so the
    // userless inbound-mail ingestion can bypass authMiddleware safely. Set
    // via `wrangler secret put MAIL_INBOUND_SECRET` (>= 16 chars).
    MAIL_INBOUND_SECRET?: string;
    // Per-request hot cache — auth sessions + hot lookup tables (Phase 2.6/4).
    SESSION_CACHE: KVNamespace;
    // Supabase Storage credentials — replaces the legacy FILES (R2) binding.
    // SUPABASE_PROJECT_REF is the project slug (public, set in wrangler.toml
    // [vars]); SUPABASE_SERVICE_KEY is the service_role key (set via
    // `wrangler secret put SUPABASE_SERVICE_KEY`). Both optional during
    // rollout — src/api/lib/supabase-storage.ts throws
    // SupabaseStorageNotConfiguredError when missing, and the file-asset
    // routes (src/api/routes/files.ts) map that to 503.
    SUPABASE_PROJECT_REF?: string;
    // Cloudflare Queues binding for async PO emission cascade (Phase C #3).
    // Optional — falls back to synchronous inline call when absent.
    PO_EMISSION_QUEUE?: Queue;
    // OAuth client credentials (Phase B.3 / C #6).  Set via `wrangler secret put`.
    OAUTH_GOOGLE_CLIENT_ID?: string;
    OAUTH_GOOGLE_CLIENT_SECRET?: string;
    OAUTH_GOOGLE_REDIRECT_URI?: string;
    OAUTH_GOOGLE_HOSTED_DOMAIN?: string;
    JWT_SECRET?: string;
    // Optional: Sentry / GlitchTip DSN for worker-side error reporting.
    // Set via `wrangler secret put SENTRY_DSN`. When unset, app.onError
    // logs to wrangler-tail only (no third-party hop).
    SENTRY_DSN?: string;
    // Google Sheets bidirectional sync (see docs/SHEETS-SYNC.md). All three
    // are optional — when any is missing the sheets-sync helpers silently
    // no-op and the webhook + backfill routes return 503.
    GOOGLE_SHEETS_SA_KEY?: string;     // Full service-account JSON (stringified)
    SHEETS_SYNC_SECRET?: string;       // HMAC secret shared with Apps Script
    SHEETS_SPREADSHEET_ID?: string;    // Target spreadsheet id
    // Daily reports — efficiency / schedule / overdue. Optional override:
    // comma-separated list of email addresses that receive the cron-pushed
    // reports. When unset, the worker falls back to every active SUPER_ADMIN's
    // email (matched on the role NAME via users.role / roles.name — NOT on
    // users.roleId, which is a FK holding 'role_super_admin'; that mismatch was
    // BUG-2026-07-17-003 and silently sent the morning brief to nobody). See
    // resolveRecipients in src/api/routes/reports.ts.
    DAILY_REPORT_RECIPIENTS?: string;
    // GitHub Actions health — surfaces CI / automation failures on
    // /admin/health instead of emailing the owner on every failure.
    // GITHUB_TOKEN: a fine-grained, READ-ONLY PAT (Actions: read-only on this
    // repo) set via `wrangler secret put GITHUB_TOKEN`. When unset, the
    // dashboard panel shows a "not connected" note and nothing is fetched.
    // GITHUB_REPO: optional "owner/repo" override (var, public); defaults to
    // the known slug in admin-health.ts. See routes/admin-health.ts
    // GET /github-runs.
    GITHUB_TOKEN?: string;
    GITHUB_REPO?: string;
    // Web Push (Worker Portal notifications). VAPID keypair for signing the
    // push requests + encrypting payloads (see src/api/lib/web-push.ts).
    // VAPID_PUBLIC_KEY is a public value (also baked into the client as a
    // fallback); VAPID_PRIVATE_KEY is a secret (`wrangler secret put`).
    // VAPID_SUBJECT is the mailto:/https: contact RFC 8292 requires.
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    VAPID_SUBJECT?: string;
    // Shared secret the clock-reminder cron presents as x-push-secret on
    // POST /api/push/clock-reminder (server→server, not CSRF). Set via
    // `wrangler secret put PUSH_CRON_SECRET` (>= 16 chars).
    PUSH_CRON_SECRET?: string;
    // Background scan-queue worker (2026-06-29). The processBatch() helper
    // in routes/scan-queue.ts re-uploads stashed file bytes to the existing
    // /api/scan-po/extract / /api/scan-supplier/extract endpoints WITHOUT a
    // user session (the operator may have closed their tab). It presents
    // this shared secret as the x-scan-worker header; auth-middleware
    // bypasses the dashboard gate on a constant-time match. Set via
    // `wrangler secret put SCAN_WORKER_TOKEN` (>= 16 chars). When unset,
    // the queue worker cannot drive extractions — uploads still queue but
    // every row will land in 'failed' with a clear error message.
    SCAN_WORKER_TOKEN?: string;
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
//
// 2026-05-27 — Custom-domain transition (erp.hookka.com.my). The
// allowlist now accepts a comma-separated list so we can serve BOTH
// the new prod domain AND the old hookka-erp-testing.pages.dev URL
// during the cutover window. Example wrangler.toml value:
//
//   API_CORS_ORIGIN = "https://erp.hookka.com.my,https://hookka-erp-testing.pages.dev"
//
// Trailing whitespace tolerated. Trailing slashes stripped. Empty
// entries dropped. Once the cutover is verified live and the old
// domain has had its grace period, simplify back to a single value.
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const raw: string[] = (c.env.API_CORS_ORIGIN || "http://localhost:3000")
        .split(",")
        .map((s: string) => s.trim().replace(/\/+$/, ""))
        .filter((s: string) => s.length > 0);
      const incoming = (origin ?? "").replace(/\/+$/, "");
      // Accept any configured origin and the wrangler-dev default.
      if (raw.includes(incoming) || incoming === "http://localhost:8787") {
        return origin;
      }
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
//
// Also applies HTTP security headers — defence in depth in case a future
// XSS sink slips in. Today the SPA has no `dangerouslySetInnerHTML`, no
// JSX text rendering of unsanitised HTML, and the auth flow uses Bearer
// tokens (so CSRF isn't applicable yet) — but headers are cheap and
// catch regressions.
app.use("/api/*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  c.res.headers.set("Pragma", "no-cache");
  c.res.headers.set("Expires", "0");

  // Don't sniff MIME — protects /api/files/:id/stream and any future
  // attachment-serving endpoint from polyglot files.
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  // Block embedding in iframes — clickjacking protection.
  c.res.headers.set("X-Frame-Options", "DENY");
  // HSTS — force HTTPS for one year. Cloudflare already enforces this
  // at the edge, but an explicit header survives proxy chains.
  c.res.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  // Don't leak full URLs (which carry record IDs) when the user clicks
  // a link to an external site.
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Disable powerful APIs by default. Camera (QR scan + punch photo) and
  // geolocation (punch soft-geofence) are kept on `self` — WITHOUT geolocation=(self)
  // the browser blocks navigator.geolocation and every punch records NO GPS, so the
  // off-site geofence can never fire. The rest stay off.
  c.res.headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=(self), payment=(), usb=()",
  );
});

// Security headers on non-/api/* routes too (the SPA HTML shell + static
// assets). Pages serves these directly when the request path doesn't match
// a Function route; we still want headers.
app.use("*", async (c, next) => {
  await next();
  if (!c.req.path.startsWith("/api/")) {
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    c.res.headers.set(
      "Permissions-Policy",
      "camera=(self), microphone=(), geolocation=(self), payment=(), usb=()",
    );
    // CSP report-only for now — flips to enforcing once we've seen a
    // week of reports with no false positives. Allowlist:
    //   - self for scripts + styles + connections (Vite output)
    //   - 'unsafe-inline' for styles only (Tailwind's class-based runtime
    //     injects style tags; we'd need nonces to drop this)
    //   - data: URIs for images (PDF previews, QR codes)
    //   - blob: for QR canvas + dynamic chart rendering
    c.res.headers.set(
      "Content-Security-Policy-Report-Only",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "font-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    );
  }
});

// DB injection — wraps the Hyperdrive-pooled Supabase client in a D1-compatible
// adapter and exposes it as `c.var.DB`.  Routes use this instead of raw D1.
// Per-env Hyperdrive routing (Option C, 2026-05-01).
//
// Cloudflare Pages locks BOTH `[[hyperdrive]]` and plaintext `[vars]`
// to wrangler.toml top-level once it's involved — confirmed
// 2026-05-02 by dashboard tooltips ("Bindings managed through
// wrangler.toml" + "Only Secrets can be managed via the Dashboard").
// `[env.preview.vars]` overrides are also silently ignored: a deploy
// of commit 2d60ab2 still returned env="production" from /api/health.
//
// So neither dashboard nor [env.preview.*] can flip ENVIRONMENT per
// deploy. The only reliable runtime signal is the request hostname —
// production is `hookka-erp-testing.pages.dev` exactly; preview deploys
// are `<commit-hash>.hookka-erp-testing.pages.dev` or
// `<branch-alias>.hookka-erp-testing.pages.dev`. Detect from there.
function isPreviewHostname(requestUrl: string): boolean {
  try {
    const host = new URL(requestUrl).hostname.toLowerCase();
    if (host === "hookka-erp-testing.pages.dev") return false; // prod
    if (host.endsWith(".hookka-erp-testing.pages.dev")) return true; // preview
    return false; // custom domain → treat as prod
  } catch {
    return false;
  }
}

function pickDbUrl(env: Env["Bindings"], requestUrl: string): string | undefined {
  if (isPreviewHostname(requestUrl) && env.HYPERDRIVE_STAGING?.connectionString) {
    return env.HYPERDRIVE_STAGING.connectionString;
  }
  return env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
}

// Must run before authMiddleware (which itself hits the DB to verify tokens).
// The adapter is further wrapped in instrumentD1 so every prepare/all/first/
// run/batch emits a [slow-query] line when it exceeds SLOW_QUERY_MS.
app.use("/api/*", async (c, next) => {
  const { SupabaseAdapter } = await import("./lib/supabase-compat");
  const { getSql } = await import("./lib/db-pg");
  const { instrumentD1 } = await import("./lib/observability");
  // Prefer Hyperdrive binding (production / preview on Cloudflare).  Fall
  // back to DATABASE_URL env var only for local dev without Hyperdrive.
  const url = pickDbUrl(c.env, c.req.url);
  if (!url) throw new Error("No database connection string available (HYPERDRIVE or DATABASE_URL)");
  const adapter = new SupabaseAdapter(getSql(url)) as unknown as D1Database;
  const timer = c.get("dbTimer"); // set by timingMiddleware
  c.set("DB", instrumentD1(adapter, new URL(c.req.url).pathname, timer, c.env));
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
    isPreview: isPreviewHostname(c.req.url),
    host: new URL(c.req.url).hostname,
    ts: Date.now(),
  }),
);

// Heartbeat — used to monitor the Hyperdrive → Supabase path stays healthy.
// Reveals only Postgres `NOW()` and a table count — no business data.  Kept
// public so uptime monitors and the CI smoke run without an auth dance.
app.get("/api/pg-ping", async (c) => {
  try {
    const { getSql } = await import("./lib/db-pg");
    const url = pickDbUrl(c.env, c.req.url);
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

// PR 2 (2026-05-20) — /api/internal/refresh-mvs deleted along with the
// 9901/9902 Materialized Views it served. The dashboard now reads from
// the application-managed dashboard_snapshot table (PR 1). The Layer 3
// equivalent of this endpoint is /api/internal/rebuild-dashboard-snapshot
// (in PR 1), also CRON_SECRET-gated, called nightly at 02:00 SGT.

// PR 1 (2026-05-20) — Dashboard snapshot Layer 3 reconciliation.
//
// Nightly cron at 02:00 SGT (.github/workflows/rebuild-dashboard-snapshot.yml)
// hits this endpoint to force-invalidate the dashboard_snapshot for every
// tenant. The next read of /api/dashboard/overview re-computes against
// fresh data and writes the new row. This is belt-and-braces protection
// vs any silent drift that escaped Layer 1 (write-through) and Layer 2
// (read-time MAX(updated_at) check) — e.g. an admin script that UPDATEs
// a source table without bumping its updated_at column.
//
// Same CRON_SECRET pattern as /api/internal/refresh-mvs.
app.post("/api/internal/rebuild-dashboard-snapshot", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error(
      "[rebuild-dashboard-snapshot] CRON_SECRET unset or too short — refusing",
    );
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  const t0 = Date.now();
  try {
    // Wipe every tenant's dashboard_snapshot row. Next /api/dashboard/
    // overview read for each tenant re-computes and writes a fresh
    // row via the cache-aside path in routes/dashboard-overview.ts.
    // DELETE then COUNT gives us an observable "tenants invalidated"
    // figure for the cron logs.
    const beforeRes = await c.var.DB.prepare(
      "SELECT COUNT(*) AS n FROM dashboard_snapshot",
    ).first<{ n: number }>();
    await c.var.DB.prepare("DELETE FROM dashboard_snapshot").run();
    return c.json({
      ok: true,
      tenantsInvalidated: beforeRes?.n ?? 0,
      elapsedMs: Date.now() - t0,
      note: "Snapshots invalidated; next /api/dashboard/overview read re-computes per tenant.",
    });
  } catch (e) {
    console.error("[rebuild-dashboard-snapshot] error:", e);
    return c.json({ ok: false, error: "rebuild failed" }, 500);
  }
});

// Pre-warm the heavy list snapshots so the Delivery + Production pages never hit
// the empty-snapshot cold recompute (~25s) after a deploy busts the caches. Same
// CRON_SECRET pattern as the internal endpoints above; .github/workflows/
// warm-lists.yml hits it every few minutes. Warming stores BYTE-IDENTICAL
// payloads (same compute, same snapshot keys) — only the timing of the recompute
// moves off the request path, no figure changes (owner red line: input/output
// figures must stay exact).
app.post("/api/internal/warm-lists", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[warm-lists] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  const t0 = Date.now();
  const { DEFAULT_ORG_ID } = await import("./lib/tenant");
  const out: Record<string, unknown> = {};
  // 1. Delivery page's PO list — the 20MB / ~25s cold-recompute one.
  try {
    const { warmPoListDeliveryVariant } = await import(
      "./routes/production-orders"
    );
    const r = await warmPoListDeliveryVariant(c, DEFAULT_ORG_ID);
    out.poList = { ok: true, rows: r.rows };
  } catch (e) {
    console.error("[warm-lists] poList failed:", e);
    out.poList = { ok: false };
  }
  // 1b. Planning page's PO list variant (excludeCompleted=true) — a DIFFERENT
  // snapshot key, previously unwarmed → cold ~10MB/~8s block on first load.
  try {
    const { warmPoListPlanningVariant } = await import(
      "./routes/production-orders"
    );
    const r = await warmPoListPlanningVariant(c, DEFAULT_ORG_ID);
    out.poListPlanning = { ok: true, rows: r.rows };
  } catch (e) {
    console.error("[warm-lists] poListPlanning failed:", e);
    out.poListPlanning = { ok: false };
  }
  // 2. Delivery-orders list value map (keeps the DO list warm post-deploy too).
  try {
    const { loadDoValueMapCached } = await import("./lib/do-value");
    const m = await loadDoValueMapCached(c.var.DB, DEFAULT_ORG_ID, c);
    out.doValueMap = { ok: true, entries: m.size };
  } catch (e) {
    console.error("[warm-lists] doValueMap failed:", e);
    out.doValueMap = { ok: false };
  }
  // 3. Daily Report (compliance) — the ~6s cold-recompute one. Warm today's key
  // so the first open of the day never blocks.
  try {
    const { warmComplianceReport, warmBriefReport } = await import(
      "./routes/reports"
    );
    out.compliance = await warmComplianceReport(c, DEFAULT_ORG_ID);
    out.brief = await warmBriefReport(c, DEFAULT_ORG_ID);
  } catch (e) {
    console.error("[warm-lists] reports failed:", e);
    out.compliance = { ok: false };
    out.brief = { ok: false };
  }
  return c.json({ ok: true, elapsedMs: Date.now() - t0, ...out });
});

// Sprint 4 — email outbox drain cron entry. Same CRON_SECRET pattern as
// /api/internal/refresh-mvs above. The cron workflow at
// .github/workflows/process-email-outbox.yml hits this every 5 min; the
// handler reads pending rows from outbox_emails, calls Resend for each,
// and marks status. 3 retries with exponential backoff before FAILED.
// Runtime logic lives in src/api/lib/email-outbox.ts (processOutbox).
app.post("/api/internal/process-email-outbox", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[process-email-outbox] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  try {
    const { processOutbox } = await import("./lib/email-outbox");
    const result = await processOutbox(
      c.var.DB,
      // 2026-05-27 — include BREVO_API_KEY so processOutbox' sendMail()
      // picks Brevo as the preferred provider (Hookka cutover from Resend).
      c.env as unknown as {
        RESEND_API_KEY?: string;
        BREVO_API_KEY?: string;
        RESEND_FROM_EMAIL?: string;
      },
    );
    return c.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[process-email-outbox] error:", e);
    // Surface the real reason in the (CRON_SECRET-gated) response so the cron
    // log shows WHY a drain failed instead of a blank "drain failed". This is
    // how a future strand gets diagnosed in seconds. 2026-06-24.
    return c.json({ ok: false, error: `drain failed: ${msg}` }, 500);
  }
});

// P2 follow-up — audit_dlq replay sweeper. Sprint 2 added the audit_dlq
// table + writer in production-orders.ts (job_card_events batch failures
// land there), but rows accumulated forever with no replay path. This
// endpoint drains pending rows by replaying them against the original
// write target — same CRON_SECRET pattern as the workflows above. The
// cron at .github/workflows/replay-audit-dlq.yml hits this every 30
// minutes; see src/api/lib/audit-replay.ts for the dispatch logic.
app.post("/api/internal/replay-audit-dlq", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[replay-audit-dlq] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  const t0 = Date.now();
  try {
    const { replayAuditDlq } = await import("./lib/audit-replay");
    // Optional ?limit=N override; default 100 keeps a single Workers
    // invocation well under any reasonable subrequest budget.
    const url = new URL(c.req.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 100;
    const result = await replayAuditDlq(c.var.DB, safeLimit);
    return c.json({ ok: true, elapsedMs: Date.now() - t0, ...result });
  } catch (e) {
    console.error("[replay-audit-dlq] error:", e);
    return c.json({ ok: false, error: "replay failed" }, 500);
  }
});

// Nightly PI→GL backfill (owner rule 2026-07-01). New CONFIRMED PIs are already
// posted to the GL at creation/confirmation (purchase-invoices.ts, since
// BUG-2026-06-23-007), so this is a safety net for whatever slips through
// (a bulk import, a future edge case) — the owner-facing "Post to GL" button
// on the Purchase Invoices page does the same thing on demand; this just runs
// it automatically so nobody has to remember to click it. Same CRON_SECRET
// pattern as the internal endpoints above; delegates to backfillPiGlPostings
// (purchase-invoices.ts) so the button and the cron can never drift apart —
// idempotent (ledgerHasSource-gated), never double-posts. The cron workflow at
// .github/workflows/nightly-pi-gl-backfill.yml hits this once nightly.
app.post("/api/internal/nightly-pi-gl-backfill", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[nightly-pi-gl-backfill] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  try {
    const result = await backfillPiGlPostings(c.var.DB, "hookka", {});
    if (result.failed > 0) {
      console.error("[nightly-pi-gl-backfill] some PIs failed to post:", result.failures);
    }
    // GL self-heal sweeps (owner rule 2026-07-23 「以后不要有这个原因」):
    // cancelled invoices whose reversal never landed (BUG-2026-07-23-002)
    // and other-party bills whose creation GL never landed
    // (BUG-2026-07-23-003). Both idempotent; best-effort so a sweep error
    // never kills the PI backfill result.
    let cancelSweep: unknown = null;
    let opbSweep: unknown = null;
    try {
      const { sweepCancelledInvoiceReversals } = await import("./routes/invoices");
      cancelSweep = await sweepCancelledInvoiceReversals(c.var.DB, true);
    } catch (e) {
      console.error("[nightly-gl-selfheal] cancel-reversal sweep failed:", e);
      cancelSweep = { error: String(e) };
    }
    try {
      const { sweepOtherPartyBillGl } = await import("./routes/accounting");
      opbSweep = await sweepOtherPartyBillGl(c.var.DB, "hookka", true);
    } catch (e) {
      console.error("[nightly-gl-selfheal] other-party-bill sweep failed:", e);
      opbSweep = { error: String(e) };
    }
    return c.json({ ok: true, ...result, cancelSweep, opbSweep });
  } catch (e) {
    console.error("[nightly-pi-gl-backfill] error:", e);
    return c.json({ ok: false, error: "backfill failed" }, 500);
  }
});

// Nightly AR/AP running-counter rebuild (owner rule 2026-07-06 「让他不会漂」).
// Resets customers.outstandingSen / suppliers.outstandingSen to their
// document-derived truth every night so the cascade-maintained tallies can
// never silently drift again. Same CRON_SECRET pattern as the endpoints
// above; delegates to rebuildAr/ApCounterSen (accounting.ts) — the same
// functions the Debtor tab's Recalculate button uses, so the two paths can
// never diverge. .github/workflows/nightly-counter-rebuild.yml hits this.
app.post("/api/internal/nightly-counter-rebuild", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[nightly-counter-rebuild] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  try {
    const ar = await rebuildArCounterSen(c.var.DB);
    const ap = await rebuildApCounterSen(c.var.DB);
    return c.json({ ok: true, ar, ap });
  } catch (e) {
    console.error("[nightly-counter-rebuild] error:", e);
    return c.json({ ok: false, error: "rebuild failed" }, 500);
  }
});

// Weekly OCR rule-distill cron entry. Same CRON_SECRET pattern as the
// internal endpoints above. The cron workflow at
// .github/workflows/distill-ocr-rules.yml hits this every Sunday night; the
// handler loops customers, calls distillCustomerRules per customer, and
// re-generates each customer's customers.ocrPromptRules block from their
// gold-marked scan samples (po_scan_samples WHERE isGold = 1). Customers
// with fewer than 2 gold samples are skipped cheaply — no Anthropic call —
// so iterating every customer is fine; only eligible ones cost an API call.
// Per-customer errors are caught so one failure cannot abort the run.
// Runtime logic lives in src/api/lib/ocr-distill.ts (distillAllCustomerRules).
app.post("/api/internal/distill-ocr-rules", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[distill-ocr-rules] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  const t0 = Date.now();
  try {
    const { distillAllCustomerRules, distillAllSupplierRules } = await import(
      "./lib/ocr-distill"
    );
    // Optional ?limit=N override; default 200 keeps a single Workers
    // invocation well under any reasonable subrequest budget.
    const url = new URL(c.req.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 200;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 200;
    // Customers (customer PO OCR) AND suppliers (GRN / Purchase Invoice OCR) —
    // both learn per-entity from their gold pools on the same weekly sweep.
    const result = await distillAllCustomerRules(c.var.DB, c.env, safeLimit);
    const supplierResult = await distillAllSupplierRules(
      c.var.DB,
      c.env,
      safeLimit,
    );
    return c.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      ...result,
      suppliers: supplierResult,
    });
  } catch (e) {
    console.error("[distill-ocr-rules] error:", e);
    return c.json({ ok: false, error: "distill failed" }, 500);
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

// Phase 1 — QC pending-inspections cron entry. CRON_SECRET-gated, idempotent
// per (template_id, scheduled_slot_at). MUST be registered BEFORE
// authMiddleware so the GitHub Actions runner can hit it without a user
// session — the same pattern as /api/internal/refresh-mvs above. Runtime
// logic lives in routes/qc-pending.ts; this handler is just the public
// entry point that bypasses auth.
app.post("/api/qc-pending/trigger", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[qc-pending/trigger] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  try {
    const { generatePendingForSlot, currentSlotIso } = await import(
      "./routes/qc-pending"
    );
    const body = c.req.header("content-length")
      ? await c.req.json().catch(() => ({}))
      : {};
    const slotIso =
      body && typeof body === "object" && "slot" in body && typeof (body as Record<string, unknown>).slot === "string"
        ? ((body as Record<string, unknown>).slot as string)
        : currentSlotIso();
    const result = await generatePendingForSlot(c.var.DB, slotIso);
    return c.json({ ok: true, slotIso, ...result });
  } catch (err) {
    console.error("[qc-pending/trigger] error:", err);
    return c.json({ ok: false, error: "trigger failed" }, 500);
  }
});

// Background scan-queue sweep — re-queues any 'processing' row older than
// 5 minutes (worker died mid-batch or Workers killed the isolate before the
// batch drained). CRON_SECRET-gated; registered BEFORE authMiddleware so an
// external cron (cron-job.org / GitHub Action every minute) can hit it
// without a session. Runtime logic in routes/scan-queue.ts.
app.post("/api/internal/scan-queue-sweep", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[scan-queue-sweep] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  try {
    const result = await sweepStuckScans(c.var.DB, c.env, c.executionCtx);
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error("[scan-queue-sweep] error:", err);
    return c.json({ ok: false, error: "sweep failed" }, 500);
  }
});

// Backup retention prune — deletes Storage objects under backups/supabase/
// older than 90 days. The prune logic lived in cron/daily-backup.ts waiting
// on a Workers Cron Trigger that was never provisioned, so it never ran and
// dumps accumulated unbounded (2026-07-03 IT-hygiene audit). backup.yml now
// POSTs this right after each daily upload. Same CRON_SECRET pattern as the
// sweep above; registered BEFORE authMiddleware.
app.post("/api/internal/backup-prune", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[backup-prune] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  try {
    const { pruneOldBackups } = await import("./cron/daily-backup");
    await pruneOldBackups(c.env);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[backup-prune] error:", err);
    return c.json({ ok: false, error: "prune failed" }, 500);
  }
});

// Midnight auto-clockout cron entry. CRON_SECRET-gated, registered BEFORE
// authMiddleware so the GitHub Actions runner can hit it without a worker
// session — the same pattern as /api/qc-pending/trigger above. Closes every
// prior-day forgotten punch (clocked in, never out) at shift end as a NORMAL
// shift, flagged in Attendance — even for workers who are absent the next day
// (the per-clock-in self-heal in routes/worker.ts can't reach those). Idempotent
// via the `clockOut IS NULL` guard. Workflow: .github/workflows/auto-clockout.yml
// (~00:30 MYT). Runtime logic is autoCloseStalePunches in routes/worker.ts.
app.post("/api/internal/auto-clockout", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[auto-clockout] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  try {
    const { autoCloseStalePunches } = await import("./routes/worker");
    const result = await autoCloseStalePunches(c.var.DB);
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error("[auto-clockout] error:", err);
    return c.json({ ok: false, error: "trigger failed" }, 500);
  }
});

// Inbound email ingestion — the standalone Cloudflare Email Worker
// (hookka-email-worker) parses each received message and POSTs it here.
// Registered BEFORE authMiddleware (machine-to-machine, no user session) and
// guarded by MAIL_INBOUND_SECRET via the x-mail-secret header — the same
// constant-time pattern as the cron triggers above. Idempotent (dedup by
// Message-ID inside ingestInboundEmail) so the email worker can safely retry.
app.post("/api/mail-center/inbound", async (c) => {
  const expected = c.env.MAIL_INBOUND_SECRET;
  if (!expected || expected.length < 16) {
    console.error(
      "[mail-inbound] MAIL_INBOUND_SECRET unset or too short — refusing",
    );
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-mail-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  try {
    const { ingestInboundEmail } = await import("./routes/mail-center");
    const payload = await c.req.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return c.json({ ok: false, error: "invalid payload" }, 400);
    }
    const result = await ingestInboundEmail(
      c.var.DB,
      payload as Parameters<typeof ingestInboundEmail>[1],
      // Pass storage env so inbound attachments are uploaded to Supabase Storage
      // and indexed in email_attachments (skipped when creds are absent).
      c.env,
    );
    return c.json(result, result.ok ? 200 : 400);
  } catch (err) {
    console.error("[mail-inbound] error:", err);
    return c.json({ ok: false, error: "ingest failed" }, 500);
  }
});

// Web Push — Worker Portal notifications (additive). Registered BEFORE
// authMiddleware because each handler does its OWN auth: /subscribe +
// /unsubscribe gate on X-Worker-Token, /clock-reminder on the x-push-secret
// shared secret, /vapid-public-key is intentionally public. Same posture as
// the /api/internal/* cron triggers and /api/mail-center/inbound above.
// Mounted here (not in the auth-gated block below) so the worker token — not a
// dashboard session — is the credential. See src/api/routes/push.ts.
app.route("/api/push", push);

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

// NOTE: the global app.onError handler (including the OrgIdRequiredError → 401
// mapping that used to live here) is registered ONCE near the end of this file.
// Hono only honours the LAST onError registration, so a duplicate here would be
// dead code — keep the single merged handler below the route registrations.

// General API rate limit. Defense-in-depth on top of the per-login limiter:
// even a valid Bearer token (or a stolen session) can't hammer the API.
// Default ceiling is 300 req/min, 5000 req/hr per user — at least 10x above
// any realistic single-operator burst, so normal use never trips a 429. Per-
// endpoint overrides live in lib/api-rate-limit-config.ts. Wired AFTER
// authMiddleware + tenantMiddleware so userId is available; falls back to
// client IP for unauthenticated endpoints. KV failures fall through and
// allow the request (we never lock real users out on a KV blip).
app.use("/api/*", apiRateLimit({ exempt: ["/api/health", "/api/pg-ping"] }));

// ---------------------------------------------------------------------------
// Auth-gated routes (registered AFTER authMiddleware)
// ---------------------------------------------------------------------------

// PR 2 (2026-05-20) — /api/dashboard/summary deleted. Read from the 5
// dashboard MVs (mv_so_summary, mv_po_pipeline, mv_jc_by_dept). Agent A
// audit confirmed zero frontend callers anywhere in src/pages or
// src/components — orphan endpoint, refreshing nightly for nobody.
// Dashboard data now comes from /api/dashboard/overview (cache-aside
// via dashboard_snapshot table, PR 1).

// ---------------------------------------------------------------------------
// Route registrations — add each migrated route here.
// ---------------------------------------------------------------------------
import customers from "./routes/customers";
import bom from "./routes/bom";
import products from "./routes/products";
import productConfigs from "./routes/product-configs";
import workers from "./routes/workers";
import workerAuth from "./routes/worker-auth";
import workerPortal from "./routes/worker";
import departments from "./routes/departments";
import customerHubs from "./routes/customer-hubs";
import customerProducts from "./routes/customer-products";
import customerMaintenance from "./routes/customer-maintenance";
import customerQuotation from "./routes/customer-quotation";
import customerCrm from "./routes/customer-crm";
import salesLeads from "./routes/sales-leads";
import sofaCombos from "./routes/sofa-combos";
import organisations from "./routes/organisations";
import salesOrders from "./routes/sales-orders";
import purchaseOrders from "./routes/purchase-orders";
import purchaseInvoices, { backfillPiGlPostings } from "./routes/purchase-invoices";
import creditNotes from "./routes/credit-notes";
import debitNotes from "./routes/debit-notes";
import eInvoices from "./routes/e-invoices";
import threeWayMatch from "./routes/three-way-match";
import deliveryOrders from "./routes/delivery-orders";
import deliveryReturns from "./routes/delivery-returns";
import packingLists from "./routes/packing-lists";
// Public QR dispatch/deliver flow (no login — the unguessable qrtoken IS the
// credential; auth bypass via PUBLIC_PREFIXES in lib/auth-middleware.ts).
// Transitions reuse applyDeliveryOrderUpdate, the exact office PUT path.
import publicDoQr from "./routes/public-do-qr";
// Public rack STOCK-IN scan flow (no login — the token is the plain rack id;
// auth bypass via PUBLIC_PREFIXES "/api/public/rack-qr/" in lib/auth-middleware.ts).
// Writes via the SAME buildRackStockInStatements helper the worker route uses.
import publicRackQr from "./routes/public-rack-qr";
// Public packing-sticker → RACK assignment (no login — the unguessable 64-hex
// job_card qr_token IS the credential; auth bypass via PUBLIC_PREFIXES
// "/api/public/rack-write/"). The ONLY write is set/clear the rack on the one
// token-resolved PACKING card, via the SAME applyPackingRack helper the worker
// /packing-rack path uses. See routes/public-rack-write.ts.
import publicRackWrite from "./routes/public-rack-write";
import cncTemplates from "./routes/cnc-templates";
import invoices from "./routes/invoices";
import payments from "./routes/payments";
import supplierPayments from "./routes/supplier-payments";
// Phase 4 — production / inventory / supplier
import productionOrders from "./routes/production-orders";
import productionFolders from "./routes/production-folders";
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
import maintenanceConfig from "./routes/maintenance-config";
// Phase 5 — admin maintenance endpoints (archive/run, etc.)
import admin from "./routes/admin";
// Phase 6 / P6.4 — health KPI endpoint feeding /admin/health.
import adminHealth from "./routes/admin-health";
// Phase 6 Phase-4 — Front-End RUM event sink. Logged-in users POST
// batched JS errors + Core Web Vitals here; worker forwards to AE.
import feRum from "./routes/fe-rum";
// Phase 6 — job_card_events audit log read endpoint.
import jobCards from "./routes/job-cards";
// Universal audit_events read endpoint — feeds AuditHistoryPanel on every
// detail page so the operator can see "who changed what and when" per record.
import auditEvents from "./routes/audit-events";
import dashboardOverview from "./routes/dashboard-overview";
// Phase C #4 quick-win — MDM duplicate-detection review queue.
import mdm from "./routes/mdm";
// Phase B.4 — file_assets storage (Supabase Storage-backed; was R2 before
// the storage-supabase-migration). Returns 503 until SUPABASE_PROJECT_REF
// + SUPABASE_SERVICE_KEY are configured; see docs/DR-RUNBOOK.md.
import files from "./routes/files";
// Web Push — Worker Portal notifications. Mounted at /api/push BEFORE the auth
// gate (each handler self-auths via worker token / push-cron secret).
import push from "./routes/push";
import { authMiddleware } from "./lib/auth-middleware";
import { tenantMiddleware } from "./lib/tenant";
import { timingMiddleware } from "./lib/observability";
import { reportWorkerError } from "./lib/monitoring";
import { apiRateLimit } from "./lib/api-rate-limit";

// Phase-5 imports — historically these were in-memory stubs, but every
// route below has since been migrated to real D1 / Supabase persistence
// (verified 2026-04-26). The import block name is kept for git-history
// continuity; the routes themselves are fully durable.
import accounting, { rebuildArCounterSen, rebuildApCounterSen } from "./routes/accounting";
import attendance from "./routes/attendance";
import workingHourEntries from "./routes/working-hour-entries";
import payrollHourDeductions from "./routes/payroll-hour-deductions";
import cashFlow from "./routes/cash-flow";
import consignments from "./routes/consignments";
import consignmentNotes from "./routes/consignment-notes";
import cnPackingLists from "./routes/cn-packing-lists";
import consignmentOrders from "./routes/consignment-orders";
import stockAdjustments from "./routes/stock-adjustments";
import drivers from "./routes/drivers";
import threePlVehicles from "./routes/three-pl-vehicles";
import threePlDrivers from "./routes/three-pl-drivers";
import threePlStateRates from "./routes/three-pl-state-rates";
import equipment from "./routes/equipment";
import forecasts from "./routes/forecasts";
import ocrAccuracy from "./routes/ocr-accuracy";
import historicalSales from "./routes/historical-sales";
import leaves from "./routes/leaves";
import lorries from "./routes/lorries";
import maintenanceLogs from "./routes/maintenance-logs";
import mrp from "./routes/mrp";
import notifications from "./routes/notifications";
import payroll from "./routes/payroll";
import payRules from "./routes/pay-rules";
import payslips from "./routes/payslips";
import productionLeadtimes from "./routes/production-leadtimes";
import jobcardSync from "./routes/jobcard-sync";
import promiseDate from "./routes/promise-date";
// Customer Service Agent (orchestrator): /api/cs-agent/promise = reasoned
// promise date, materials → production → delivery (chain engine +
// procurement readiness, read-only).
import csAgent from "./routes/cs-agent";
import qcInspections from "./routes/qc-inspections";
import qcTemplates from "./routes/qc-templates";
import qcPending from "./routes/qc-pending";
import rdProjects from "./routes/rd-projects";
import rdTeamMembers from "./routes/rd-team-members";
import scheduling from "./routes/scheduling";
import planningSchedule from "./routes/planning-schedule";
import scheduleProposals from "./routes/schedule-proposals";
import deliveryAgent, { internal as deliveryAgentInternal } from "./routes/delivery-agent";
import agentHeartbeat from "./routes/agent-heartbeat";
import scanPo from "./routes/scan-po";
import scanSupplier from "./routes/scan-supplier";
import scanFinance from "./routes/scan-finance";
import scanQueue, { sweepStuckScans } from "./routes/scan-queue";
// One-shot historical job_card completion importer (Wei Siang's GS migration).
// Server-only super-admin tool gated by production-orders:update; see
// routes/import-completion.ts for the per-row resolution + cascade logic.
import importCompletion from "./routes/import-completion";
import serviceOrders from "./routes/service-orders";
import serviceCases from "./routes/service-cases";
// Google Sheets bidirectional sync. Webhook (Sheets -> ERP) + backfill
// (ERP -> Sheets). Returns 503 silently when GOOGLE_SHEETS_SA_KEY /
// SHEETS_SPREADSHEET_ID / SHEETS_SYNC_SECRET are missing — see
// docs/SHEETS-SYNC.md for the GCP provisioning checklist.
import sheetsSync from "./routes/sheets-sync";
// Department Performance KPI feed for the /employees Department Performance
// tab. Admin-scoped (workers:read) — distinct from /api/department-labor
// and from /api/worker/team-stats (worker-token, leader-only).
import departmentPerformance from "./routes/department-performance";
// WIP catalog — per-(wipLabel × dept × category) average production time
// aggregator. Powers the /production/wip-times reference page where
// dept supervisors / planners pick a dept (or SOFA/BEDFRAME category) and
// see how long each WIP typically takes.
import wipTimes from "./routes/wip-times";
import mailCenter from "./routes/mail-center";
// Org-wide DataGrid column presets (Save as Org Default / print preset). Shared
// across browsers/users via the backend; personal layout stays in localStorage.
import datagridLayouts from "./routes/datagrid-layouts";
import { announcementsAdmin, announcementsWorker } from "./routes/announcements";

app.route("/api/customers", customers);
app.route("/api/mail-center", mailCenter);
app.route("/api/datagrid-layouts", datagridLayouts);
app.route("/api/bom", bom);
app.route("/api/products", products);
app.route("/api/product-configs", productConfigs);
app.route("/api/workers", workers);
app.route("/api/worker-auth", workerAuth);
// In-app announcements. The ADMIN surface is a normal auth-gated route; the
// WORKER read endpoint lives under /api/worker/announcements (worker-token
// authed — the /api/worker/ prefix bypasses the dashboard auth gate). The
// worker mount MUST come BEFORE /api/worker below so the more-specific prefix
// wins matching (same reasoning as the /api/worker-auth ordering note).
app.route("/api/announcements", announcementsAdmin);
app.route("/api/worker/announcements", announcementsWorker);
// Worker portal (mobile /worker pages). MUST mount AFTER /api/worker-auth so
// the more-specific prefix wins matching — `/api/worker-auth/login` would
// otherwise be a prefix-match for `/api/worker` if order flipped.
app.route("/api/worker", workerPortal);
app.route("/api/departments", departments);
app.route("/api/customer-hubs", customerHubs);
app.route("/api/customer-products", customerProducts);
app.route("/api/customer-maintenance", customerMaintenance);
app.route("/api/customer-quotation", customerQuotation);
app.route("/api/customer-crm", customerCrm);
app.route("/api/sales-leads", salesLeads);
app.route("/api/sofa-combos", sofaCombos);
app.route("/api/organisations", organisations);
app.route("/api/sales-orders", salesOrders);
app.route("/api/purchase-orders", purchaseOrders);
app.route("/api/purchase-invoices", purchaseInvoices);
app.route("/api/credit-notes", creditNotes);
app.route("/api/debit-notes", debitNotes);
app.route("/api/e-invoices", eInvoices);
app.route("/api/three-way-match", threeWayMatch);
app.route("/api/delivery-orders", deliveryOrders);
app.route("/api/delivery-returns", deliveryReturns);
app.route("/api/packing-lists", packingLists);
// Public QR scan flow for DOs/PLs. Registered like any other subapp — the
// auth bypass happens in authMiddleware (PUBLIC_PREFIXES "/api/public/do-qr/"),
// so the request still flows through tenant + rate-limit middleware (the
// limiter keys by client IP when there is no session).
app.route("/api/public/do-qr", publicDoQr);
// Public rack STOCK-IN scan flow. Like the public DO QR mount above, the auth
// bypass happens in authMiddleware (PUBLIC_PREFIXES "/api/public/rack-qr/"), so
// the request still flows through tenant + rate-limit middleware (the limiter
// keys by client IP when there is no session).
app.route("/api/public/rack-qr", publicRackQr);
// Public packing-sticker → RACK assignment. Mounted AFTER /api/public/rack-qr
// so the more-specific "/api/public/rack-write" prefix is unambiguous. Auth
// bypass via PUBLIC_PREFIXES "/api/public/rack-write/"; rate-limit override is
// the tightened public ceiling (30/min, 300/hr) in api-rate-limit-config.ts.
app.route("/api/public/rack-write", publicRackWrite);
app.route("/api/cnc-templates", cncTemplates);
app.route("/api/invoices", invoices);
app.route("/api/payments", payments);
app.route("/api/supplier-payments", supplierPayments);
// Phase 4
app.route("/api/production-orders", productionOrders);
// Phase 5 — Production Folders: archive paper-schedule snapshots for later
// retrieval. Mounted AFTER /api/production-orders so route prefix matching
// is unambiguous (different prefixes anyway, but staying explicit).
app.route("/api/production-folders", productionFolders);
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
// Compat redirect — older browser tabs / external bookmarks hit
// /api/supplier-material-bindings (the legacy plural name). The route
// was renamed to /api/supplier-materials but stale references kept
// 404-ing. 308 preserves the HTTP method on POST/PUT/DELETE so write
// calls don't silently downgrade to GET.
app.all("/api/supplier-material-bindings", (c) =>
  c.redirect("/api/supplier-materials", 308),
);
app.all("/api/supplier-material-bindings/*", (c) => {
  const suffix = c.req.path.replace("/api/supplier-material-bindings", "");
  return c.redirect(`/api/supplier-materials${suffix}`, 308);
});
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
app.route("/api/maintenance-config", maintenanceConfig);
// Phase 5 — admin maintenance (archive/run). Behind the normal auth gate.
// MUST mount /api/admin/health BEFORE /api/admin so the more-specific
// subapp wins route matching (Hono picks the first registered subapp
// whose prefix matches; the less-specific /api/admin would otherwise
// 404 the /health/* paths).
app.route("/api/admin/health", adminHealth);
app.route("/api/admin", admin);
// Phase-4 FE RUM. Logged-in users POST batched events; data flows to AE
// and surfaces on /admin/health via the fe-* endpoints in admin-health.ts.
app.route("/api/fe-rum", feRum);
// Phase 6 — job_card_events read surface. Only /:id/events for now;
// future PATCH/DELETE audit screens can mount here.
app.route("/api/job-cards", jobCards);
app.route("/api/audit-events", auditEvents);
// PR 2 (2026-05-20) — /api/dashboard/revenue route removed along with
// its mv_revenue_by_month_by_org source. Monthly revenue is computed
// inline by /api/dashboard/overview (per the 2026-05-16 rebuild in
// BUG-2026-05-16-013) and served via the new dashboard_snapshot cache.
app.route("/api/dashboard/overview", dashboardOverview);
// Phase C #4 quick-win — MDM duplicate-detection review queue. Routes
// scoped by orgId via getOrgId(c); detection-pass endpoint is admin-only
// in spirit (gated by the existing auth middleware until role-aware
// rbac lands; see roadmap §1).
app.route("/api/mdm", mdm);
// Phase B.4 — file_assets API. Mounted under /api/files. Returns 503 when
// Supabase Storage credentials are missing; see docs/DR-RUNBOOK.md.
app.route("/api/files", files);
// Google Sheets bidirectional sync (Apps Script webhook + admin backfill).
// Mounted before the /api/* catch-all so the webhook works on a fresh
// deploy even if the rest of the API is locked down. Auth on the webhook
// is HMAC-only (Apps Script can't carry a dashboard JWT) — see
// docs/SHEETS-SYNC.md for the trust boundary.
app.route("/api/sheets-sync", sheetsSync);

// Below routes were previously in-memory mock-backed (data in
// src/lib/mock-data.ts); now all D1-persistent. Comment refreshed
// 2026-04-26 — the original "writes are in-memory, reset on deploy"
// claim was stale and actively misleading the next dev.
app.route("/api/accounting", accounting);
app.route("/api/attendance", attendance);
app.route("/api/working-hour-entries", workingHourEntries);
app.route("/api/payroll-hour-deductions", payrollHourDeductions);
app.route("/api/cash-flow", cashFlow);
app.route("/api/consignments", consignments);
app.route("/api/consignment-notes", consignmentNotes);
// CN truck-run packing lists — the consignment twin of /api/packing-lists.
app.route("/api/cn-packing-lists", cnPackingLists);
app.route("/api/consignment-orders", consignmentOrders);
app.route("/api/stock-adjustments", stockAdjustments);
app.route("/api/drivers", drivers);
app.route("/api/three-pl-vehicles", threePlVehicles);
app.route("/api/three-pl-drivers", threePlDrivers);
app.route("/api/three-pl-state-rates", threePlStateRates);
app.route("/api/equipment", equipment);
app.route("/api/forecasts", forecasts);
app.route("/api/ocr-accuracy", ocrAccuracy);
app.route("/api/historical-sales", historicalSales);
app.route("/api/leaves", leaves);
app.route("/api/lorries", lorries);
app.route("/api/maintenance-logs", maintenanceLogs);
app.route("/api/mrp", mrp);
app.route("/api/notifications", notifications);
app.route("/api/payroll", payroll);
app.route("/api/pay-rules", payRules);
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
// CS Agent orchestrator — GET /promise (SO or product what-if) + GET
// /procurement/readiness (Procurement Agent's data-prerequisite gate).
app.route("/api/cs-agent", csAgent);
// Phase 1 — QC module rebuild (2026-04-28). qc-templates manages checklist
// definitions; qc-pending owns the time-triggered slot lifecycle (PENDING →
// IN_PROGRESS → COMPLETED|SKIPPED) plus the cron entry + manual generate.
// MUST come before /api/qc-inspections so the more-specific subapps win
// route matching even though they share the qc- prefix.
app.route("/api/qc-templates", qcTemplates);
app.route("/api/qc-pending", qcPending);
app.route("/api/qc-inspections", qcInspections);
app.route("/api/rd-projects", rdProjects);
app.route("/api/rd-team-members", rdTeamMembers);
app.route("/api/scheduling", scheduling);
app.route("/api/planning", planningSchedule);
// Phase 2 due-date proposals share the /api/planning prefix (Hono composes
// multiple sub-routers on one path; the paths don't overlap).
app.route("/api/planning", scheduleProposals);
// Delivery Agent (TMS) — brief + LOAD_PLAN/INVOICE_GAP/POD_CHASE proposals.
// Proposal-only: approve never creates/dispatches DOs (see routes file).
// The /api/internal/delivery-agent/* trigger is public-path + CRON_SECRET-
// gated (PUBLIC_PREFIXES in auth-middleware), mirroring /api/internal/reports.
app.route("/api/delivery-agent", deliveryAgent);
app.route("/api/internal/delivery-agent", deliveryAgentInternal);
// Agents heartbeat — the dumb 30-min beat behind the agents' SELF-scheduling
// (lib/agent-scheduler.ts decides who runs; CRON_SECRET-gated like the other
// /api/internal/* crons; PUBLIC_PREFIXES entry in auth-middleware).
app.route("/api/internal/agents", agentHeartbeat);
app.route("/api/scan-po", scanPo);
app.route("/api/scan-supplier", scanSupplier);
app.route("/api/scan-finance", scanFinance);
// Background scan queue (async OCR). Upload returns a batchId IMMEDIATELY;
// processBatch() drives Claude calls under waitUntil() so the user can
// close the tab while a 100-file batch processes server-side. Same RBAC
// gate as /api/scan-po + /api/scan-supplier (purchase-orders:create).
app.route("/api/scan-queue", scanQueue);
// One-shot historical job_card completion importer. POST
// /api/import/job-card-completion drives backfill of pre-ERP orders from a
// Google Sheets export — see routes/import-completion.ts for body shape +
// cursor pagination.
app.route("/api/import", importCompletion);
// Phase 3 — Service Orders (换货服务): customer-reported defects on shipped
// SOs/COs. Three resolution modes (REPRODUCE / STOCK_SWAP / REPAIR); see
// routes/service-orders.ts for the full flow.
// Service Cases — parent of Service Orders (0074). Mounted BEFORE
// /api/service-orders so the more-specific path wins; both Hono and the
// SupabaseAdapter route by registration order so this matters.
app.route("/api/service-cases", serviceCases);
app.route("/api/service-orders", serviceOrders);
// Department Performance — admin KPI feed for /employees tab. Distinct path
// from /api/department-labor (no collision); see routes/department-performance.ts.
app.route("/api/department-performance", departmentPerformance);
app.route("/api/wip-times", wipTimes);

// Daily reports (efficiency / schedule / overdue). The /api/reports/* paths
// are session-gated like the rest of the dashboard. The /api/internal/reports/*
// trigger endpoints are public-path + CRON_SECRET-gated so an external cron
// service (cron-job.org / GitHub Action) can POST in at 12pm SGT etc.
import reports, { internal as reportsInternal } from "./routes/reports";
app.route("/api/reports", reports);
app.route("/api/internal/reports", reportsInternal);

// Hookka AI — embedded read-only assistant (SUPER_ADMIN-gated). Streams
// Anthropic SSE through to the browser; tool calls execute the read-only
// query helpers in src/api/lib/assistant-tools.ts. See routes/assistant.ts.
import assistant from "./routes/assistant";
import assistantHistory from "./routes/assistant-history";
// History sub-router first (more specific path) so /conversations/* resolves
// before the assistant router's own routes. Both share the /api/assistant base.
app.route("/api/assistant/conversations", assistantHistory);
app.route("/api/assistant", assistant);

// Agent Console (Production Agent Phase 3) — SUPER_ADMIN-only status +
// one-click controls (run-now / pause / kill-all / rollback / approval gate)
// for every agent. Mounted AFTER reports so ./routes/agent-console.ts can
// import dispatchReport from ./routes/reports without a cycle at runtime.
import agentConsole from "./routes/agent-console";
app.route("/api/agents", agentConsole);

// Catch-all error handler (Sprint 5). Hono's default behaviour is to surface
// a 500 with the error message — fine for dev, but in prod we want every
// uncaught route exception to land in Sentry (when configured) so we can
// triage without waiting for a user to file a ticket. The reporter is
// no-op when SENTRY_DSN is unset, so this is safe in OSS / self-host.
app.onError((err, c) => {
  // Sprint 4 — translate OrgIdRequiredError thrown by getOrgId / withOrgScope
  // into a 401 instead of a 500. Any tenant-scoped route handler that runs
  // without a resolved orgId on the context (auth bypassed somehow, or
  // tenantMiddleware crashed) fails closed. Checked first so it short-circuits
  // before the generic Sentry-reported 500 below.
  if (err && (err as { name?: string }).name === "OrgIdRequiredError") {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  const url = (() => {
    try {
      return new URL(c.req.url).pathname + new URL(c.req.url).search;
    } catch {
      return c.req.url;
    }
  })();
  // Fire-and-forget — we don't want the error path waiting on the
  // dynamic-import + HTTP round-trip to Sentry.
  void reportWorkerError(err, c.env.SENTRY_DSN, {
    method: c.req.method,
    url,
  });
  // Preserve Hono's default response shape so the frontend's existing
  // FetchJsonError handling keeps working.
  return c.json(
    {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    },
    500,
  );
});

// Unmounted /api/* paths — return a real 404 so callers see a loud failure
// instead of silently rendering an empty list (Sprint 1). The previous
// behaviour (200 + `{success:true, data:[], _stub:true}`) was a prod
// footgun: any new route the frontend referenced but the worker hadn't
// mounted would look like "no data" forever. Now an unmounted reference
// fails noisily.
app.all("/api/*", (c) => {
  return c.json(
    { success: false, error: "Not Found", path: c.req.path },
    404,
  );
});

export default app;
