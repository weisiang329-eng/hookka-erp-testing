// ---------------------------------------------------------------------------
// admin-health.ts — Phase 6 / P6.4 KPI endpoint for /admin/health.
//
// Surface:
//   GET /api/admin/health/kpis  →  {
//     p50, p75, p95,           // dur_ms percentiles, last 24h
//     longTaskCount,           // count(req where dur_ms >= 200) last 24h
//     cacheHitRatio,           // placeholder until cache-hit instrumentation lands
//     sparkline: number[24],   // hourly request counts (oldest -> newest)
//     _mock: boolean,          // true when no AE binding -> shape stays consistent
//     _source: "mock" | "ae",  // for the frontend banner
//   }
//
// Why mock-by-default: Cloudflare Pages Functions cannot invoke the
// Analytics Engine SQL endpoint from inside the runtime — that requires an
// account-scoped API token + a fetch to api.cloudflare.com/.../analytics_engine/sql.
// Until we wire that token (see comment block below), the route returns a
// deterministic mock so the dashboard can be built + reviewed end-to-end.
//
// Migration path when AE SQL access is wired:
//   1. wrangler secret put CF_ACCOUNT_ID + AE_QUERY_TOKEN
//   2. Drop the mock branch + replace with the SQL fetch helper.
//   3. Flip `_mock: false` and the frontend's "no data yet" notice
//      disappears automatically.
//
// SUPER_ADMIN gating: this subapp is mounted at /api/admin/health, behind
// the global authMiddleware. We additionally require role === SUPER_ADMIN
// here (defense-in-depth) since the metrics surface aggregates across
// every user's traffic.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

// Only SUPER_ADMIN can read aggregate metrics.
app.use("*", async (c, next) => {
  const role = (c as unknown as { get: (k: string) => unknown }).get(
    "userRole",
  ) as string | undefined;
  if (role !== "SUPER_ADMIN") {
    return c.json({ success: false, error: "forbidden" }, 403);
  }
  await next();
});

type Kpis = {
  p50: number;
  p75: number;
  p95: number;
  longTaskCount: number;
  cacheHitRatio: number;
  sparkline: number[];
  _mock: boolean;
  _source: "mock" | "ae";
};

// Deterministic mock — same shape as a future live response. We seed by
// the current UTC hour so two hits within the same hour return the same
// numbers (avoids a flickering chart while the real query is wired).
function mockKpis(): Kpis {
  const seed = Math.floor(Date.now() / (60 * 60 * 1000));
  // Tiny LCG so we don't add a dep just for deterministic randoms.
  let s = (seed * 9301 + 49297) % 233280;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  // Plausible values: most requests are sub-100ms, p95 sneaks up to ~400ms.
  const p50 = Math.round(40 + rand() * 30);
  const p75 = Math.round(p50 + 30 + rand() * 60);
  const p95 = Math.round(p75 + 80 + rand() * 200);
  const longTaskCount = Math.round(50 + rand() * 200);
  const cacheHitRatio = Math.round((0.55 + rand() * 0.4) * 100) / 100;
  const sparkline: number[] = [];
  for (let i = 0; i < 24; i++) {
    sparkline.push(Math.round(40 + rand() * 200));
  }
  return {
    p50, p75, p95,
    longTaskCount,
    cacheHitRatio,
    sparkline,
    _mock: true,
    _source: "mock",
  };
}

app.get("/kpis", async (c) => {
  // Future: when AE SQL access is wired, branch on whether the binding +
  // token are present and run the real query here. For now, always mock.
  // Reading the binding still tells us "is AE configured at all?" so we
  // can surface that in the response if useful — but writes are a separate
  // concern (see observability.ts).
  const ae = (c.env as unknown as { ERP_METRICS?: unknown }).ERP_METRICS;
  if (!ae) {
    // No binding at all → mock (frontend shows "no data yet" notice).
    return c.json({ success: true, data: mockKpis() });
  }
  // Binding exists but we don't have a SQL token yet — still mock, but we
  // can flip the source so admin sees we're closer to real data.
  return c.json({ success: true, data: mockKpis() });
});

export default app;
