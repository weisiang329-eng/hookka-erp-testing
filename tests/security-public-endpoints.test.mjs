// ---------------------------------------------------------------------------
// security-public-endpoints.test.mjs — snapshot test of which API endpoints
// bypass the global Bearer-token gate in src/api/lib/auth-middleware.ts.
//
// The whole point: any new public endpoint must explicitly update this test.
// That makes accidental exposure (e.g. a route copy-paste that lands a write
// path under /api/worker/...) impossible to ship in silence — CI fails until
// the allowlist is updated, which forces a human review of why a new path
// became public.
//
// PUBLIC_PATHS (exact match) and PUBLIC_PREFIXES (prefix match) are private
// to the middleware module — we parse them out of the source text via
// _security-helpers.mjs so we don't have to widen the export surface.
//
// Closes audit P1 follow-up "安全回归清单".
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { parsePublicEndpoints, parsePreAuthRoutes } from "./_security-helpers.mjs";

// Snapshot contract — these two arrays must mirror PUBLIC_PATHS and
// PUBLIC_PREFIXES in src/api/lib/auth-middleware.ts EXACTLY. Any drift is
// a deliberate signal: either the change is intentional (a maintainer adds
// a new entry here in the same commit that adds it to the middleware) or
// someone widened the public surface by accident (CI fails, revert).
//
// THE WHOLE POINT of this snapshot test is that adding a new public
// endpoint trips the test, which forces the maintainer to come here and
// justify — in code review — why a new path bypasses the Bearer-token gate.
// Do NOT loosen this to "contains" or "subset" semantics — equality is the
// security control. Each entry is listed explicitly for the same reason.
const EXPECTED_PATHS = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/accept-invite",
  // Self-service password reset (2026-05-27). Both endpoints are PUBLIC
  // because the caller has no session yet — they're recovering one. Email
  // enumeration is mitigated in the handler (always 200 from forgot-password),
  // and reset-password requires possession of the emailed token.
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  // Phase C.6 — TOTP step-2 of password login (no bearer yet).
  "/api/auth/totp/login-verify",
  "/api/health",
  // Front-End RUM telemetry sink (2026-05-28). Beacons fire even when the
  // session is expired/unresolved, so gating produced 401 floods and dropped
  // the error data. Read-only side effect: writes one Analytics Engine point
  // per event, capped at 50/batch in the handler. No DB, no sensitive action.
  "/api/fe-rum/event",
  // Google Sheets onEdit webhook — Apps Script can't carry the dashboard
  // JWT, so authentication is HMAC (SHEETS_SYNC_SECRET) + 5-minute
  // timestamp window enforced inside the handler. See docs/SHEETS-SYNC.md.
  "/api/sheets-sync/apps-script-webhook",
];

const EXPECTED_PREFIXES = [
  "/api/worker-auth/",
  "/api/worker/",
  "/api/auth/invite/",
  // Phase B.3 — Google Workspace OAuth handshake (/start + /callback).
  "/api/auth/oauth/",
  // 2026-05-27 — daily-report cron triggers. Handlers do their own
  // CRON_SECRET check (constant-time SHA-256). External cron service can
  // POST in at 12pm SGT without a dashboard session.
  "/api/internal/reports/",
  // 2026-07-12 — Delivery Agent cron trigger (proposals + daily brief
  // snapshot). Same model as /api/internal/reports/: the handler does its own
  // constant-time CRON_SECRET check; no dashboard session exists at cron time.
  // See routes/delivery-agent.ts `internal`.
  "/api/internal/delivery-agent/",
  // 2026-07-12 — agents self-scheduling heartbeat. Dumb 30-min external beat;
  // routes/agent-heartbeat.ts does its own constant-time CRON_SECRET check,
  // then lib/agent-scheduler.ts decides which agents run (owner keeps pause /
  // kill switch / hard bounds). No session at cron time.
  "/api/internal/agents/",
  // 2026-06-12 — public QR dispatch/deliver scan flow for DOs/PLs. Drivers
  // scan with a normal phone camera, so no session exists. The handler's
  // gate is the unguessable 64-hex qrtoken (migration 0167); the surface is
  // read-a-minimal-summary + forward-only status steps that reuse the exact
  // office transition path. See routes/public-do-qr.ts and
  // tests/do-qr-public.test.mjs.
  "/api/public/do-qr/",
  // 2026-06-17 — public rack STOCK-IN scan flow. A worker scans a printed rack
  // QR (HKRACK:<rack id>) with a normal phone camera, so no session exists. The
  // token is the plain rack_locations.id (stock-in is additive/low-risk; the
  // worker endpoint already accepts a bare rack id). GET exposes only the rack
  // label + item count; POST /stock-in writes via the shared
  // buildRackStockInStatements helper. See routes/public-rack-qr.ts.
  "/api/public/rack-qr/",
  // 2026-06-24 — public packing-sticker → RACK assignment (the ITEM→RACK
  // direction). A storekeeper scans the QR on a Packing sticker with a normal
  // phone camera, so no session exists. The gate is the unguessable 64-hex
  // job_card qr_token (migration 0187), minted lazily only by the AUTHED
  // sticker-print endpoint. GET returns a minimal no-price summary; POST /rack
  // performs ONLY set/clear of the rackingNumber on the one token-resolved
  // PACKING card, via the shared applyPackingRack helper. See
  // routes/public-rack-write.ts and tests/sticker-rack-public.test.mjs.
  "/api/public/rack-write/",
  // 2026-08-07 — public CUSTOMER SATISFACTION SURVEY. A customer (not a user —
  // they will never have a session) opens /s/<token> on their phone and rates
  // five questions. The gate is the unguessable 64-hex kpi_survey_tokens.token,
  // minted ONLY by the Super-Admin POST /api/kpi/survey/:kpiKey/link. The link
  // is SINGLE USE (atomic UPDATE … WHERE used_at IS NULL) and time-limited.
  // GET returns only the code catalogue's questions + named 1–5 scale — no
  // employee, no customer, no ids. POST writes exactly one
  // kpi_survey_responses row whose person/KPI/month come off the token's own
  // row. See routes/public-kpi-survey.ts and tests/kpi-survey-public.test.mjs.
  "/api/public/survey/",
];

test("public endpoint allowlist (exact paths) is locked in", () => {
  const { paths } = parsePublicEndpoints();
  assert.deepStrictEqual(
    [...paths].sort(),
    [...EXPECTED_PATHS].sort(),
    "PUBLIC_PATHS in src/api/lib/auth-middleware.ts changed — if intentional, update EXPECTED_PATHS in this file too.",
  );
});

test("public endpoint allowlist (prefix matches) is locked in", () => {
  const { prefixes } = parsePublicEndpoints();
  assert.deepStrictEqual(
    [...prefixes].sort(),
    [...EXPECTED_PREFIXES].sort(),
    "PUBLIC_PREFIXES in src/api/lib/auth-middleware.ts changed — if intentional, update EXPECTED_PREFIXES in this file too.",
  );
});

test("login + health are still in the public exact-path list", () => {
  // Defense in depth — even if someone rewrites the snapshot wholesale,
  // the smoke-level assertion that login/health are public must hold or
  // the dashboard would 401 every user before they can authenticate.
  const { paths } = parsePublicEndpoints();
  assert.ok(
    paths.includes("/api/auth/login"),
    "/api/auth/login must remain public — without it, no user can ever sign in",
  );
  assert.ok(
    paths.includes("/api/health"),
    "/api/health must remain public — uptime probes have no Bearer token",
  );
});

test("worker portal prefix is still public (shop-floor PIN flow)", () => {
  // The Worker Portal has its own PIN+token auth via /api/worker-auth and
  // /api/worker. If someone removes these prefixes the shop floor goes dark.
  const { prefixes } = parsePublicEndpoints();
  assert.ok(prefixes.includes("/api/worker-auth/"));
  assert.ok(prefixes.includes("/api/worker/"));
});

test("invite preflight prefix is still public", () => {
  // Anyone who has the invite token URL needs to be able to GET the metadata
  // without a Bearer token — they don't have one yet.
  const { prefixes } = parsePublicEndpoints();
  assert.ok(prefixes.includes("/api/auth/invite/"));
});

// Snapshot of routes mounted in src/api/worker.ts BEFORE the auth middleware.
// These bypass PUBLIC_PATHS / PUBLIC_PREFIXES entirely (the middleware never
// sees them) so they need their own snapshot to catch accidental additions.
//
// Pre-auth routes today: /api/health (uptime probe), /api/pg-ping (Hyperdrive
// heartbeat — leaks NOW() + table count, kept public so uptime monitors don't
// need a Bearer token), /api/internal/rebuild-dashboard-snapshot (PR 1
// Layer 3 cron, gated by CRON_SECRET — refresh-mvs retired in PR 2's MV
// teardown), /api/internal/process-email-outbox (Sprint 4 cron, gated by
// CRON_SECRET — drains outbox_emails via Resend),
// /api/internal/replay-audit-dlq (P2 cron, gated by CRON_SECRET — drains
// failed audit_events / job_card_events batches),
// /api/internal/distill-ocr-rules (weekly cron, gated by CRON_SECRET —
// regenerates per-customer OCR rules from gold-marked scan samples),
// /api/internal/auto-clockout (midnight cron, gated by CRON_SECRET — closes
// prior-day forgotten clock-outs at shift end), /api/internal/nightly-pi-gl-backfill
// (nightly cron, gated by CRON_SECRET — reposts any CONFIRMED PI missing its GL
// legs; delegates to the same backfillPiGlPostings the owner-facing "Post to GL"
// button uses, idempotent), /api/qc-pending/trigger (cron,
// gated by CRON_SECRET), /api/mail-center/inbound (Mail Center inbound email
// ingestion — the standalone Cloudflare Email Worker POSTs parsed messages
// here; gated by MAIL_INBOUND_SECRET via the x-mail-secret header, same
// constant-time pattern as the crons; idempotent dedup by Message-ID).
//
// The catch-all `app.all("/api/*", ...)` at the bottom of worker.ts is
// registered AFTER the middleware, so it doesn't appear here — the
// middleware runs first and any unauth'd request gets 401 before it would
// reach the catch-all.
const EXPECTED_PRE_AUTH_ROUTES = [
  "GET /api/health",
  "GET /api/pg-ping",
  "POST /api/internal/rebuild-dashboard-snapshot",
  "POST /api/internal/process-email-outbox",
  "POST /api/internal/replay-audit-dlq",
  "POST /api/internal/distill-ocr-rules",
  "POST /api/internal/auto-clockout",
  // Background scan-queue sweep (added 2026-06-29). CRON_SECRET-gated like the
  // rest of /api/internal/*; re-queues 'processing' rows older than 5min.
  "POST /api/internal/scan-queue-sweep",
  // Backup retention prune (added 2026-07-03). CRON_SECRET-gated; deletes
  // Storage objects under backups/supabase/ older than 90 days. Called by
  // backup.yml right after each daily upload.
  "POST /api/internal/backup-prune",
  // Nightly PI->GL backfill safety net (added 2026-07-01). CRON_SECRET-gated
  // like the rest of /api/internal/*; idempotent re-run of the owner's
  // "Post to GL" button so 400-0000 can't silently drift again.
  "POST /api/internal/nightly-pi-gl-backfill",
  // Nightly AR/AP running-counter rebuild (added 2026-07-06). CRON_SECRET-
  // gated; resets customers/suppliers outstandingSen to document truth so
  // the counters cannot silently drift (same fns as the Recalculate button).
  "POST /api/internal/nightly-counter-rebuild",
  // Heavy-list snapshot pre-warm (added 2026-07-13). CRON_SECRET-gated like the
  // rest of /api/internal/*; recomputes+stores the Delivery/Production list
  // snapshots off the request path so users never hit the empty-snapshot cold
  // recompute. Stores byte-identical payloads (same compute, same keys).
  "POST /api/internal/warm-lists",
  "POST /api/qc-pending/trigger",
  "POST /api/mail-center/inbound",
];

test("pre-auth routes (mounted before authMiddleware) are locked in", () => {
  const actual = parsePreAuthRoutes();
  assert.deepStrictEqual(
    [...actual].sort(),
    [...EXPECTED_PRE_AUTH_ROUTES].sort(),
    "Routes mounted before authMiddleware in src/api/worker.ts changed — if intentional, update EXPECTED_PRE_AUTH_ROUTES in this file too. New pre-auth routes bypass the Bearer token gate and the PUBLIC_PATHS allowlist; they MUST have their own auth (e.g. CRON_SECRET) or be obviously safe (health probes).",
  );
});

test("no obviously dangerous prefix accidentally public", () => {
  // Tripwire: if any of these resource prefixes appear in PUBLIC_PREFIXES,
  // sensitive write surface is exposed. Hard-fail the build.
  const { prefixes, paths } = parsePublicEndpoints();
  const dangerous = [
    "/api/users",
    "/api/invoices",
    "/api/payments",
    "/api/sales-orders",
    "/api/purchase-orders",
    "/api/audit-events",
    "/api/admin",
  ];
  for (const d of dangerous) {
    for (const pfx of prefixes) {
      assert.ok(
        !pfx.startsWith(d),
        `dangerous prefix ${pfx} would expose ${d} to unauthenticated calls`,
      );
    }
    for (const p of paths) {
      assert.ok(
        !p.startsWith(d),
        `dangerous path ${p} would expose ${d} to unauthenticated calls`,
      );
    }
  }
});
