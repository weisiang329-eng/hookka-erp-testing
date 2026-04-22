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
// Route registrations will be added here as each route is migrated to D1.
// Example (once customers is migrated):
//   import customers from "./routes-d1/customers";
//   app.route("/api/customers", customers);
// ---------------------------------------------------------------------------

// 404 for any /api path we haven't migrated yet.
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
