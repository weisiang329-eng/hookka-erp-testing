// ---------------------------------------------------------------------------
// Pages Functions entry — catch-all route for /api/*
//
// Cloudflare Pages serves the Vite SPA from /dist and forwards any request
// matching /api/* to this file. We hand the request off to the Hono app.
// ---------------------------------------------------------------------------
import app from "../../src/api/worker";

// Bindings type — D1 + env vars exposed to the Worker at runtime.
// Extend this as we add KV, R2, secrets, etc.
export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  API_CORS_ORIGIN: string;
  // Wired by wrangler.toml [vars]; consumed by the sentryPagesPlugin in
  // functions/_middleware.ts. Optional so local `wrangler pages dev`
  // without the var set still type-checks.
  SENTRY_DSN?: string;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  return app.fetch(ctx.request, ctx.env, ctx);
};
