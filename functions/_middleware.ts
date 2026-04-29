// ---------------------------------------------------------------------------
// Cloudflare Pages middleware — global Sentry error capture.
// ---------------------------------------------------------------------------
// Runs in front of every Pages Function (i.e. every request matching
// `functions/**/*.ts`). The static SPA assets are NOT routed through here —
// Cloudflare's edge serves those directly from /dist, no Worker invocation.
//
// What this catches:
//   * Uncaught exceptions thrown inside any Pages Function handler
//     (currently just `functions/api/[[route]].ts`, which delegates to the
//     Hono app at `src/api/worker.ts`).
//   * Hono `app.onError`-routed errors (via the bundled honoIntegration
//     enabled by default in @sentry/cloudflare).
//
// What this does NOT catch:
//   * Errors thrown during cron handlers (those run in a separate worker
//     entry). Wire those with `withSentry` directly when needed.
//   * Frontend (browser) errors — handled by `@sentry/react` in
//     `src/main.tsx`.
//
// DSN is sourced from the Cloudflare Pages secret `SENTRY_DSN`. If the
// secret is unset (e.g. in `wrangler pages dev` without a `.dev.vars` line),
// the SDK no-ops and requests pass through unchanged.
// ---------------------------------------------------------------------------
import * as Sentry from "@sentry/cloudflare";

interface PluginEnv {
  SENTRY_DSN?: string;
  ENVIRONMENT?: string;
}

export const onRequest = Sentry.sentryPagesPlugin<PluginEnv>((context) => ({
  dsn: context.env.SENTRY_DSN ?? "",
  environment: context.env.ENVIRONMENT ?? "production",
  // Lean default — error capture only. Tracing can be enabled per-route
  // later if we need to debug a slow endpoint.
  tracesSampleRate: 0,
  // Don't auto-attach IP / cookies / auth headers. Hookka is a multi-tenant
  // ERP and we don't want operator IPs in Sentry's US ingestion path.
  sendDefaultPii: false,
}));
