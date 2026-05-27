// ---------------------------------------------------------------------------
// admin-health.ts — Phase 6 / P6.4 KPI endpoint for /admin/health.
//
// Surface:
//   GET /api/admin/health/kpis  →  {
//     p50, p75, p95,           // dur_ms percentiles, last 24h
//     longTaskCount,           // count(req where dur_ms >= 200) last 24h
//     cacheHitRatio,           // placeholder until cache-hit instrumentation lands
//     sparkline: number[24],   // hourly request counts (oldest -> newest)
//     _mock: boolean,          // true when AE binding or token missing
//     _source: "mock" | "ae",  // for the frontend banner
//   }
//
// Live data path (when env vars are wired):
//   - Cloudflare Pages env vars CF_ACCOUNT_ID and AE_QUERY_TOKEN.
//   - We POST a SQL string to
//     https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/analytics_engine/sql
//     with `Authorization: Bearer {AE_QUERY_TOKEN}` and parse the JSON
//     {meta, data, rows, rows_before_limit_at_least}.
//
// Mock fallback: any of (binding missing, env vars unset, fetch throws,
// SQL returns non-2xx) reverts to mockKpis() so the dashboard always
// renders. The frontend reads `_source` to decide whether to show the
// "No live data yet" yellow banner.
//
// Migration path when AE SQL access is wired:
//   1. Enable Analytics Engine on the Cloudflare account
//      (dash.cloudflare.com → Analytics & Logs → Analytics Engine).
//   2. Uncomment the [[analytics_engine_datasets]] block in wrangler.toml.
//   3. Set Pages env vars CF_ACCOUNT_ID + AE_QUERY_TOKEN
//      (token needs "Account / Account Analytics / Read" permission).
//   4. Redeploy. From the next request, `_source = "ae"` and the banner
//      auto-hides.
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

// Deterministic mock — same shape as a live response. Seeded by the
// current UTC hour so two hits within the same hour return the same
// numbers (avoids a flickering chart when AE is not yet wired). Used
// as fallback for any AE error path so the dashboard always renders.
function mockKpis(): Kpis {
  const seed = Math.floor(Date.now() / (60 * 60 * 1000));
  let s = (seed * 9301 + 49297) % 233280;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
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
    p50,
    p75,
    p95,
    longTaskCount,
    cacheHitRatio,
    sparkline,
    _mock: true,
    _source: "mock",
  };
}

// Cloudflare Analytics Engine SQL API response shape.
//   - `meta` describes each column.
//   - `data` is an array of row OBJECTS keyed by alias.
//   - `rows` is the row count.
type AeRow = Record<string, number | string | null>;
type AeResp = {
  meta: Array<{ name: string; type: string }>;
  data: AeRow[];
  rows: number;
};

// Posts one SQL statement to the Cloudflare AE SQL endpoint and returns
// the parsed body. Throws on non-2xx / network errors so the caller can
// fall through to the mock cleanly.
async function runAeSql(
  accountId: string,
  token: string,
  sql: string,
): Promise<AeResp> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body: sql,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AE SQL ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as AeResp;
}

// Read live KPIs from Analytics Engine. Three SQL hits in parallel —
// percentiles + slow-count, hourly counts for the sparkline, and a
// (TBD) cache-hit ratio. Any throw short-circuits to mock at the
// caller via `try { … } catch`.
//
// Dataset name comes from wrangler.toml [[analytics_engine_datasets]]
// `dataset = "hookka_erp_metrics"`. If you rename it there, update
// here too — there's no binding-name-to-dataset-name lookup at runtime.
// Range selector — operator picks 24h / 7d / 30d, every Phase 2
// endpoint accepts ?range=24h|7d|30d.
//   - WINDOW    → the AE SQL INTERVAL fragment.
//   - BUCKETS   → how many time buckets the sparkline / hourly chart
//                  splits the window into (24 for 24h, 7 for 7d, 30 for 30d).
//   - BUCKET_SQL → the AE SQL toStartOfInterval argument for that bucket.
//   - MS_PER_BUCKET → JS-side ms per bucket for `hoursAgo` math.
type Range = "24h" | "7d" | "30d" | "90d";
function parseRange(raw: string | undefined): Range {
  if (raw === "7d" || raw === "30d" || raw === "90d") return raw;
  return "24h";
}
function rangeWindow(range: Range): {
  WINDOW: string;
  BUCKETS: number;
  BUCKET_SQL: string;
  MS_PER_BUCKET: number;
} {
  if (range === "90d") {
    // Cloudflare Analytics Engine free-tier retention is 92 days, so 90
    // is the practical max. Bucket size = 1 DAY so the chart stays
    // readable; 90 bars is the upper end of what fits without horizontal
    // scroll.
    return {
      WINDOW: "INTERVAL '90' DAY",
      BUCKETS: 90,
      BUCKET_SQL: "INTERVAL '1' DAY",
      MS_PER_BUCKET: 86_400_000,
    };
  }
  if (range === "30d") {
    return {
      WINDOW: "INTERVAL '30' DAY",
      BUCKETS: 30,
      BUCKET_SQL: "INTERVAL '1' DAY",
      MS_PER_BUCKET: 86_400_000,
    };
  }
  if (range === "7d") {
    return {
      WINDOW: "INTERVAL '7' DAY",
      BUCKETS: 7,
      BUCKET_SQL: "INTERVAL '1' DAY",
      MS_PER_BUCKET: 86_400_000,
    };
  }
  return {
    WINDOW: "INTERVAL '1' DAY",
    BUCKETS: 24,
    BUCKET_SQL: "INTERVAL '1' HOUR",
    MS_PER_BUCKET: 3_600_000,
  };
}

async function liveKpis(
  accountId: string,
  token: string,
  range: Range = "24h",
): Promise<Kpis> {
  const DATASET = "hookka_erp_metrics";
  const { WINDOW, BUCKETS, BUCKET_SQL, MS_PER_BUCKET } = rangeWindow(range);

  // 2026-05-27 hotfix: Cloudflare Analytics Engine SQL does NOT support
  // ClickHouse's `quantile(0.5)(...)` parameterised aggregation syntax
  // (returns "Input was invalid: unknown function call: QUANTILE").
  // Workaround: pull raw `double1` values for the window and compute
  // percentiles in JS. At Hookka's traffic (~40-500 req/24h) the
  // payload is tiny; at higher scale we'd switch to a sample +
  // sort-based approximate percentile, but 24h * 10k = 240k still
  // streams fine through AE SQL.
  //
  // We also compute longTaskCount in JS over the same array (no need
  // for the unsupported countIf either).
  const sqlPct = `
    SELECT double1
    FROM ${DATASET}
    WHERE blob1 = 'req' AND timestamp > NOW() - ${WINDOW}
  `;

  // Request-count sparkline. Bucket width = 1 hour for 24h range,
  // 1 day for 7d / 30d ranges (so the bar count stays readable).
  const sqlSpark = `
    SELECT
      toStartOfInterval(timestamp, ${BUCKET_SQL}) AS bucket,
      count()                                     AS n
    FROM ${DATASET}
    WHERE blob1 = 'req' AND timestamp > NOW() - ${WINDOW}
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  const [pctResp, sparkResp] = await Promise.all([
    runAeSql(accountId, token, sqlPct),
    runAeSql(accountId, token, sqlSpark),
  ]);

  // JS-side percentile + long-task counts. Pull all double1 values,
  // sort, and pick by index. Math.floor(N * p) is the standard "nearest
  // rank" definition — close enough for dashboards.
  const samples: number[] = [];
  for (const row of pctResp.data ?? []) {
    const v = Number((row as Record<string, unknown>).double1);
    if (Number.isFinite(v)) samples.push(v);
  }
  samples.sort((a, b) => a - b);
  const pick = (p: number): number => {
    if (samples.length === 0) return 0;
    const idx = Math.min(
      samples.length - 1,
      Math.floor(samples.length * p),
    );
    return samples[idx];
  };
  const p50 = Math.round(pick(0.5));
  const p75 = Math.round(pick(0.75));
  const p95 = Math.round(pick(0.95));
  const longTaskCount = samples.filter((v) => v >= 200).length;

  // Build a BUCKETS-element sparkline. Missing buckets (e.g. brand-new
  // dataset with < BUCKETS units of writes) read as zero. Oldest→newest
  // so the chart reads left-to-right naturally. Same shape regardless
  // of range — FE just renders BUCKETS bars without caring whether
  // each is 1 hour or 1 day.
  const sparkline: number[] = new Array(BUCKETS).fill(0);
  const now = Date.now();
  for (const row of sparkResp.data ?? []) {
    const bucketStr = String(
      (row as Record<string, unknown>).bucket ??
        (row as Record<string, unknown>).hour ??
        "",
    );
    const ts = Date.parse(bucketStr);
    if (Number.isNaN(ts)) continue;
    const bucketsAgo = Math.floor((now - ts) / MS_PER_BUCKET);
    if (bucketsAgo < 0 || bucketsAgo > BUCKETS - 1) continue;
    const idx = BUCKETS - 1 - bucketsAgo;
    sparkline[idx] = Math.round(Number(row.n) || 0);
  }

  // Cache-hit ratio: not yet instrumented. Once we start emitting a
  // `cache.hit` / `cache.miss` counter (via emitCounter), this becomes
  //   hits / (hits + misses)
  // For now, return 0 to signal "no data" rather than carry a
  // misleading mock number into the live response. The frontend can
  // grey it out — it's a small change to ui.
  const cacheHitRatio = 0;

  return {
    p50,
    p75,
    p95,
    longTaskCount,
    cacheHitRatio,
    sparkline,
    _mock: false,
    _source: "ae",
  };
}

// Temporary diagnostic — surfaces WHICH env var / binding is missing so
// the operator can fix the right one. Returns true/false (never the
// values themselves — tokens never appear in the response). Remove
// after live data flows.
app.get("/kpis-diag", async (c) => {
  const env = c.env as unknown as {
    ERP_METRICS?: unknown;
    CF_ACCOUNT_ID?: string;
    AE_QUERY_TOKEN?: string;
  };
  const diag = {
    ERP_METRICS_bound: !!env.ERP_METRICS,
    CF_ACCOUNT_ID_set: !!env.CF_ACCOUNT_ID,
    CF_ACCOUNT_ID_len: (env.CF_ACCOUNT_ID || "").length,
    CF_ACCOUNT_ID_prefix: (env.CF_ACCOUNT_ID || "").slice(0, 6),
    AE_QUERY_TOKEN_set: !!env.AE_QUERY_TOKEN,
    AE_QUERY_TOKEN_len: (env.AE_QUERY_TOKEN || "").length,
    AE_QUERY_TOKEN_prefix: (env.AE_QUERY_TOKEN || "").slice(0, 4),
  };
  // Run BOTH actual production queries (percentile + sparkline) so we
  // see which one fails. Each gets full status + first chunk of body.
  const queries: Record<string, string> = {
    smoke: "SELECT count() AS n FROM hookka_erp_metrics WHERE timestamp > NOW() - INTERVAL '1' DAY",
    pct: `SELECT quantile(0.50)(double1) AS p50, quantile(0.75)(double1) AS p75, quantile(0.95)(double1) AS p95, countIf(double1 >= 200) AS longTaskCount FROM hookka_erp_metrics WHERE blob1 = 'req' AND timestamp > NOW() - INTERVAL '1' DAY`,
    spark: `SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, count() AS n FROM hookka_erp_metrics WHERE blob1 = 'req' AND timestamp > NOW() - INTERVAL '1' DAY GROUP BY hour ORDER BY hour ASC`,
  };
  const liveCalls: Record<string, unknown> = {};
  if (env.CF_ACCOUNT_ID && env.AE_QUERY_TOKEN) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
    for (const [name, sql] of Object.entries(queries)) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.AE_QUERY_TOKEN}`,
            "Content-Type": "text/plain",
          },
          body: sql,
        });
        const body = await res.text();
        liveCalls[name] = {
          status: res.status,
          ok: res.ok,
          body_snippet: body.slice(0, 400),
        };
      } catch (e) {
        liveCalls[name] = {
          thrown: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }
  return c.json({ success: true, diag, liveCalls });
});

app.get("/kpis", async (c) => {
  const env = c.env as unknown as {
    ERP_METRICS?: unknown;
    CF_ACCOUNT_ID?: string;
    AE_QUERY_TOKEN?: string;
  };

  // Two pre-flight gates. Either failing → mock fallback.
  //   • ERP_METRICS binding present (means wrangler.toml has the AE
  //     dataset uncommented).
  //   • CF_ACCOUNT_ID + AE_QUERY_TOKEN set as Pages env vars.
  // We check the binding too so that "binding wired but token missing"
  // still falls back cleanly instead of crashing.
  if (!env.ERP_METRICS || !env.CF_ACCOUNT_ID || !env.AE_QUERY_TOKEN) {
    return c.json({ success: true, data: mockKpis() });
  }

  try {
    const range = parseRange(c.req.query("range"));
    const data = await liveKpis(env.CF_ACCOUNT_ID, env.AE_QUERY_TOKEN, range);
    return c.json({ success: true, data });
  } catch (err) {
    // Any error path — bad token, AE temporarily down, SQL syntax we
    // somehow broke, dataset just created with no rows yet — falls
    // back to mock so the dashboard still loads. Logged so we can see
    // why in `wrangler tail`.
    console.warn(
      "[admin-health] AE SQL failed, falling back to mock:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ success: true, data: mockKpis() });
  }
});

// ---------------------------------------------------------------------------
// Phase 2 — per-endpoint drill-down views. These let the operator answer
// "which endpoint is slow / erroring" not just "is the system slow".
//
// All five queries below scan the same `req` rows in
// hookka_erp_metrics. Schema reminder (per OBSERVABILITY.md):
//   blob1 = "req"   (event-kind discriminator)
//   blob2 = route   (e.g. /api/sales-orders)
//   blob3 = HTTP status as string
//   blob4 = traceparent
//   double1 = total dur_ms
//   double2 = db_dur_ms
//   double3 = db op count
//
// Endpoint helper: shared env-read + fallback. Returns null when the
// AE config is missing or any query throws — caller decides whether
// to return an empty list or surface an error to the FE.
// ---------------------------------------------------------------------------
async function withAe<T>(
  c: { env: unknown },
  fn: (accountId: string, token: string) => Promise<T>,
): Promise<T | null> {
  const env = c.env as {
    ERP_METRICS?: unknown;
    CF_ACCOUNT_ID?: string;
    AE_QUERY_TOKEN?: string;
  };
  if (!env.ERP_METRICS || !env.CF_ACCOUNT_ID || !env.AE_QUERY_TOKEN) {
    return null;
  }
  try {
    return await fn(env.CF_ACCOUNT_ID, env.AE_QUERY_TOKEN);
  } catch (err) {
    console.warn(
      "[admin-health phase2] AE query failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// View 1 — Top N slowest endpoints (24h). Pulls raw rows per route
// then computes P50/P95 in JS for each (same reason as the main
// /kpis route: AE SQL doesn't support quantile()). Limits the per-route
// fetch to top-traffic routes so we don't pull half the dataset for
// rare endpoints.
app.get("/by-endpoint", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    // First pass: count hits per route to rank traffic.
    const sqlHits = `
      SELECT blob2 AS route, count() AS n
      FROM hookka_erp_metrics
      WHERE blob1 = 'req' AND timestamp > NOW() - ${WINDOW}
      GROUP BY route
      ORDER BY n DESC
      LIMIT 20
    `;
    const hitsResp = await runAeSql(accountId, token, sqlHits);
    const routes = (hitsResp.data ?? [])
      .map((r) => ({
        route: String((r as Record<string, unknown>).route ?? ""),
        hits: Number((r as Record<string, unknown>).n) || 0,
      }))
      .filter((r) => r.route);
    if (routes.length === 0) return [];

    // Second pass: one query pulling double1 + double2 per row, all
    // routes. We group in JS so we don't issue N queries.
    const routeFilter = routes
      .map((r) => `'${r.route.replace(/'/g, "''")}'`)
      .join(",");
    const sqlSamples = `
      SELECT blob2 AS route, double1 AS dur, double2 AS dbDur
      FROM hookka_erp_metrics
      WHERE blob1 = 'req'
        AND timestamp > NOW() - ${WINDOW}
        AND blob2 IN (${routeFilter})
    `;
    const samplesResp = await runAeSql(accountId, token, sqlSamples);
    const perRoute = new Map<
      string,
      { dur: number[]; dbDur: number[] }
    >();
    for (const r of samplesResp.data ?? []) {
      const row = r as Record<string, unknown>;
      const route = String(row.route ?? "");
      if (!perRoute.has(route)) perRoute.set(route, { dur: [], dbDur: [] });
      const bucket = perRoute.get(route)!;
      const d = Number(row.dur);
      const db = Number(row.dbDur);
      if (Number.isFinite(d)) bucket.dur.push(d);
      if (Number.isFinite(db)) bucket.dbDur.push(db);
    }
    const pickPct = (arr: number[], p: number): number => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    };
    const avg = (arr: number[]): number =>
      arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
    // Merge hits + percentiles. Sort by P95 desc so the slowest
    // endpoints surface first.
    const merged = routes.map((r) => {
      const samples = perRoute.get(r.route) ?? { dur: [], dbDur: [] };
      const p50 = Math.round(pickPct(samples.dur, 0.5));
      const p95 = Math.round(pickPct(samples.dur, 0.95));
      const avgDur = Math.round(avg(samples.dur));
      const avgDb = Math.round(avg(samples.dbDur));
      const dbPct =
        avgDur > 0 ? Math.round((avgDb / avgDur) * 100) : 0;
      return {
        route: r.route,
        hits: r.hits,
        p50,
        p95,
        avgDur,
        avgDb,
        dbPct,
      };
    });
    merged.sort((a, b) => b.p95 - a.p95);
    return merged.slice(0, 10);
  });
  return c.json({ success: true, data: data ?? [] });
});

// View 2 — Error rate by endpoint (24h). 4xx + 5xx counts per route
// so the operator sees which endpoint is throwing.
app.get("/errors-by-endpoint", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    // Pull route + status. We bucket 4xx / 5xx in JS so we don't need
    // CASE WHEN (AE SQL CASE syntax is finicky).
    const sql = `
      SELECT blob2 AS route, blob3 AS status, count() AS n
      FROM hookka_erp_metrics
      WHERE blob1 = 'req'
        AND timestamp > NOW() - ${WINDOW}
        AND (blob3 LIKE '4%' OR blob3 LIKE '5%')
      GROUP BY route, status
      ORDER BY n DESC
      LIMIT 200
    `;
    const resp = await runAeSql(accountId, token, sql);
    const byRoute = new Map<
      string,
      { route: string; fourXX: number; fiveXX: number; total: number }
    >();
    for (const r of resp.data ?? []) {
      const row = r as Record<string, unknown>;
      const route = String(row.route ?? "");
      const status = String(row.status ?? "");
      const n = Number(row.n) || 0;
      if (!route) continue;
      if (!byRoute.has(route))
        byRoute.set(route, {
          route,
          fourXX: 0,
          fiveXX: 0,
          total: 0,
        });
      const bucket = byRoute.get(route)!;
      if (status.startsWith("5")) bucket.fiveXX += n;
      else if (status.startsWith("4")) bucket.fourXX += n;
      bucket.total += n;
    }
    return [...byRoute.values()]
      .sort((a, b) => b.fiveXX - a.fiveXX || b.fourXX - a.fourXX)
      .slice(0, 15);
  });
  return c.json({ success: true, data: data ?? [] });
});

// View 3 (combined into View 1's `dbPct` field above — no separate
// endpoint needed). Operator sees "DB time as % of total" in the
// Top Slowest table.

// View 4 — Hourly error spike chart (24h). 4xx + 5xx counts per hour.
// Use this overlaid with deploy times to correlate "spike at 14:00"
// with "deploy at 13:55 = regression".
app.get("/errors-hourly", async (c) => {
  const { WINDOW, BUCKETS, BUCKET_SQL, MS_PER_BUCKET } = rangeWindow(
    parseRange(c.req.query("range")),
  );
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT
        toStartOfInterval(timestamp, ${BUCKET_SQL}) AS bucket,
        blob3                                        AS status,
        count()                                      AS n
      FROM hookka_erp_metrics
      WHERE blob1 = 'req'
        AND timestamp > NOW() - ${WINDOW}
        AND (blob3 LIKE '4%' OR blob3 LIKE '5%')
      GROUP BY bucket, status
      ORDER BY bucket ASC
    `;
    const resp = await runAeSql(accountId, token, sql);
    const fourXX = new Array(BUCKETS).fill(0) as number[];
    const fiveXX = new Array(BUCKETS).fill(0) as number[];
    const now = Date.now();
    for (const r of resp.data ?? []) {
      const row = r as Record<string, unknown>;
      const bucketStr = String(row.bucket ?? "");
      const status = String(row.status ?? "");
      const n = Number(row.n) || 0;
      const ts = Date.parse(bucketStr);
      if (Number.isNaN(ts)) continue;
      const bucketsAgo = Math.floor((now - ts) / MS_PER_BUCKET);
      if (bucketsAgo < 0 || bucketsAgo > BUCKETS - 1) continue;
      const idx = BUCKETS - 1 - bucketsAgo;
      if (status.startsWith("5")) fiveXX[idx] += n;
      else if (status.startsWith("4")) fourXX[idx] += n;
    }
    return { fourXX, fiveXX };
  });
  return c.json({
    success: true,
    data: data ?? {
      fourXX: new Array(BUCKETS).fill(0),
      fiveXX: new Array(BUCKETS).fill(0),
    },
  });
});

// View 5 — Long task details. Returns the top N slowest individual
// requests in the last 24h with route, status, duration, db time, and
// traceparent (so the operator can chase the slow ones in `wrangler
// tail` logs).
// Daily latency trend — one P50 + P95 point per day across the window.
// Lets the operator see "Sep 5 was slow + Sep 10 was very slow" at a
// glance instead of one aggregated number for the whole 90d.
//
// Workaround for AE SQL's no-quantile limitation: pull raw double1 + a
// per-day truncated timestamp, then compute percentiles per day in JS.
// Works for ~50K rows total comfortably. Beyond that we'd switch to a
// pre-aggregated table.
app.get("/daily-trend", async (c) => {
  const { WINDOW, BUCKETS, BUCKET_SQL, MS_PER_BUCKET } = rangeWindow(
    parseRange(c.req.query("range")),
  );
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT toStartOfInterval(timestamp, ${BUCKET_SQL}) AS bucket,
             double1                                      AS dur,
             blob3                                        AS status
      FROM hookka_erp_metrics
      WHERE blob1 = 'req' AND timestamp > NOW() - ${WINDOW}
    `;
    const resp = await runAeSql(accountId, token, sql);
    // Group by bucket → percentiles + 5xx count in JS.
    const buckets = new Map<
      string,
      { samples: number[]; fiveXX: number }
    >();
    for (const r of resp.data ?? []) {
      const row = r as Record<string, unknown>;
      const b = String(row.bucket ?? "");
      const v = Number(row.dur);
      const status = String(row.status ?? "");
      if (!b) continue;
      if (!buckets.has(b)) buckets.set(b, { samples: [], fiveXX: 0 });
      const bucket = buckets.get(b)!;
      if (Number.isFinite(v)) bucket.samples.push(v);
      if (status.startsWith("5")) bucket.fiveXX++;
    }
    // Materialize BUCKETS-length arrays aligned oldest→newest.
    const p50: number[] = new Array(BUCKETS).fill(0);
    const p95: number[] = new Array(BUCKETS).fill(0);
    const errors: number[] = new Array(BUCKETS).fill(0);
    const now = Date.now();
    for (const [bucketStr, b] of buckets) {
      const ts = Date.parse(bucketStr);
      if (Number.isNaN(ts)) continue;
      const ago = Math.floor((now - ts) / MS_PER_BUCKET);
      if (ago < 0 || ago > BUCKETS - 1) continue;
      const idx = BUCKETS - 1 - ago;
      const sorted = [...b.samples].sort((a, b2) => a - b2);
      const pick = (p: number): number =>
        sorted.length === 0
          ? 0
          : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      p50[idx] = Math.round(pick(0.5));
      p95[idx] = Math.round(pick(0.95));
      errors[idx] = b.fiveXX;
    }
    return { p50, p95, errors };
  });
  return c.json({
    success: true,
    data: data ?? {
      p50: new Array(BUCKETS).fill(0),
      p95: new Array(BUCKETS).fill(0),
      errors: new Array(BUCKETS).fill(0),
    },
  });
});

app.get("/long-tasks", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT blob2 AS route, blob3 AS status, blob4 AS trace,
             double1 AS dur, double2 AS dbDur, timestamp
      FROM hookka_erp_metrics
      WHERE blob1 = 'req'
        AND timestamp > NOW() - ${WINDOW}
        AND double1 >= 200
      ORDER BY double1 DESC
      LIMIT 50
    `;
    const resp = await runAeSql(accountId, token, sql);
    return (resp.data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        route: String(row.route ?? ""),
        status: String(row.status ?? ""),
        dur: Math.round(Number(row.dur) || 0),
        dbDur: Math.round(Number(row.dbDur) || 0),
        trace: String(row.trace ?? ""),
        timestamp: String(row.timestamp ?? ""),
      };
    });
  });
  return c.json({ success: true, data: data ?? [] });
});

export default app;
