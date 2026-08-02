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
import { getOrgId } from "../lib/tenant";

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
// 60-second edge cache for Analytics Engine queries. The System Health page
// fires ~14 of these per open, each scanning millions of metric rows (~1–2s).
// AE aggregate stats don't need to be real-time, so caching the result for a
// minute turns every repeat open (any admin, same colo, within 60s) from
// seconds into instant. Keyed by a hash of the exact SQL so different queries /
// ranges never collide. The cold (first) load still runs live.
const AE_CACHE_TTL_SECONDS = 60;

async function aeCacheKey(accountId: string, sql: string): Promise<Request> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(sql),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Synthetic, never-fetched URL — only used as a Cache API key.
  return new Request(`https://ae-cache.hookka.internal/${accountId}/${hex}`);
}

async function runAeSql(
  accountId: string,
  token: string,
  sql: string,
): Promise<AeResp> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  let key: Request | null = null;
  if (cache) {
    try {
      key = await aeCacheKey(accountId, sql);
      const hit = await cache.match(key);
      if (hit) return (await hit.json()) as AeResp;
    } catch {
      // Any cache-read error → fall through to a live query.
    }
  }

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
  const data = (await res.json()) as AeResp;

  if (cache && key) {
    try {
      await cache.put(
        key,
        new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${AE_CACHE_TTL_SECONDS}`,
          },
        }),
      );
    } catch {
      // Caching is best-effort; a put failure must never fail the request.
    }
  }
  return data;
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

  // Cache-hit ratio — emitCounter('cache.hit') and ('cache.miss') fire
  // from src/api/lib/snapshot.ts withSnapshot when the wrapper has its
  // `c` context plumbed through. As of 2026-05-27 sales-orders list +
  // stats are wired; remaining snapshot callers will join over time
  // (each just needs `c` passed as the 6th arg).
  //
  // ratio = hits / (hits + misses). Returns 0 when there's no data
  // (binding cold-start, no traffic yet, or counters not wired).
  let cacheHitRatio = 0;
  try {
    const sqlCache = `
      SELECT blob1 AS kind, count() AS n
      FROM ${DATASET}
      WHERE (blob1 = 'cache.hit' OR blob1 = 'cache.miss')
        AND timestamp > NOW() - ${WINDOW}
      GROUP BY kind
    `;
    const cacheResp = await runAeSql(accountId, token, sqlCache);
    let hits = 0;
    let misses = 0;
    for (const r of cacheResp.data ?? []) {
      const row = r as Record<string, unknown>;
      const n = Number(row.n) || 0;
      if (row.kind === "cache.hit") hits = n;
      else if (row.kind === "cache.miss") misses = n;
    }
    const total = hits + misses;
    if (total > 0) cacheHitRatio = Math.round((hits / total) * 100) / 100;
  } catch {
    /* leave at 0 — non-fatal */
  }

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
  // Run the actual production queries (percentile source + sparkline) so we
  // see which one fails. Each gets full status + first chunk of body.
  //
  // 2026-06-02: the `pct` probe used to run `quantile(0.50)(double1)` +
  // `countIf(...)`, which Cloudflare AE SQL rejects with 422
  // "unknown function call: QUANTILE". That made the diag falsely report
  // the percentile path as broken even though the real /kpis route works
  // fine — it pulls raw `double1` and computes percentiles in JS (see the
  // sqlPct comment in liveKpis). The probe now mirrors that supported
  // approach: SELECT the raw double1 rows the percentile math runs over.
  // Percentiles + longTaskCount are then derived in JS by /kpis, never in
  // SQL — there is no QUANTILE call to fail.
  // 2026-08-01: probes must mirror the REAL /kpis SQL exactly. The previous
  // probes were simplified cousins (pct had LIMIT 1, spark aliased AS hour)
  // and all passed while the real path — same shape, no LIMIT, AS bucket —
  // fell back to mock on prod. A diagnostic that tests a friendlier query
  // than production runs is worse than none: it certifies the wrong thing.
  // pct_full is the exact percentile source (no LIMIT — the row volume is
  // part of what can fail); spark_bucket is the exact sparkline SQL.
  const queries: Record<string, string> = {
    smoke: "SELECT count() AS n FROM hookka_erp_metrics WHERE timestamp > NOW() - INTERVAL '1' DAY",
    pct_full: `SELECT double1 FROM hookka_erp_metrics WHERE blob1 = 'req' AND timestamp > NOW() - INTERVAL '1' DAY`,
    spark_bucket: `SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS bucket, count() AS n FROM hookka_erp_metrics WHERE blob1 = 'req' AND timestamp > NOW() - INTERVAL '1' DAY GROUP BY bucket ORDER BY bucket ASC`,
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
  return c.json({
    success: true,
    diag,
    liveCalls,
    notes: {
      pct: "Percentiles (p50/p75/p95) + longTaskCount are computed JS-side from raw double1 rows — Cloudflare AE SQL has no QUANTILE function. The 'pct' probe above only checks that the raw double1 read works; a 200 there means the real /kpis percentile path is healthy.",
    },
  });
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
    // back to mock so the dashboard still loads. Logged AND carried on
    // the response as _mockReason: we cannot `wrangler tail` this Pages
    // project from the dev machine (different Cloudflare account), and
    // 2026-08-01 proved the cost of a silent fallback — prod ran mock
    // data indefinitely while the diag probes (which use SIMPLER SQL
    // than the real path) all passed. The reason string is an AE API
    // error message; it never contains the token.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[admin-health] AE SQL failed, falling back to mock:", reason);
    return c.json({ success: true, data: { ...mockKpis(), _mockReason: reason } });
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
    // Pull route + status + the most-recent occurrence. We bucket 4xx / 5xx
    // in JS so we don't need CASE WHEN (AE SQL CASE syntax is finicky).
    // MAX(timestamp) lets the dashboard tell "errored 23h ago (probably
    // already fixed)" apart from "errored 2 min ago (live)" — the recency
    // signal that stops a stale burst inside the rolling window from looking
    // like an active outage.
    const sql = `
      SELECT blob2 AS route, blob3 AS status, count() AS n, MAX(timestamp) AS lastTs
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
      {
        route: string;
        fourXX: number;
        fiveXX: number;
        total: number;
        lastSeen: string; // most recent error of ANY status (ISO)
        last5xxAt: string; // most recent 5xx specifically (ISO; "" if none)
      }
    >();
    for (const r of resp.data ?? []) {
      const row = r as Record<string, unknown>;
      const route = String(row.route ?? "");
      const status = String(row.status ?? "");
      const n = Number(row.n) || 0;
      const lastTs = String(row.lastTs ?? "");
      if (!route) continue;
      if (!byRoute.has(route))
        byRoute.set(route, {
          route,
          fourXX: 0,
          fiveXX: 0,
          total: 0,
          lastSeen: "",
          last5xxAt: "",
        });
      const bucket = byRoute.get(route)!;
      if (status.startsWith("5")) {
        bucket.fiveXX += n;
        if (lastTs > bucket.last5xxAt) bucket.last5xxAt = lastTs;
      } else if (status.startsWith("4")) bucket.fourXX += n;
      bucket.total += n;
      if (lastTs > bucket.lastSeen) bucket.lastSeen = lastTs;
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
// Status code breakdown — instead of bucketing all 4xx + 5xx together,
// surface each specific code (401 = token expired, 403 = RBAC, 404 =
// FE bug fetching wrong URL, 422 = validation reject, 429 = rate limit,
// 500 = server bug, etc). Each code maps to a different root cause.
app.get("/status-breakdown", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT blob3 AS status, count() AS n
      FROM hookka_erp_metrics
      WHERE blob1 = 'req'
        AND timestamp > NOW() - ${WINDOW}
        AND (blob3 LIKE '4%' OR blob3 LIKE '5%')
      GROUP BY status
      ORDER BY n DESC
    `;
    const resp = await runAeSql(accountId, token, sql);
    return (resp.data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        status: String(row.status ?? ""),
        count: Number(row.n) || 0,
      };
    });
  });
  return c.json({ success: true, data: data ?? [] });
});

// Error messages — for every 5xx + 4xx, what was the actual error
// text? This is the highest-ROI root-cause signal. Without it the
// operator sees "8 5xx errors on /api/sales-orders" and has no idea
// whether it's a null deref bug, a DB connection failure, or a
// validation bug. With it, they see the top error strings + a
// representative trace ID per error so they can `wrangler tail
// | grep <trace>` for the full stack.
app.get("/error-messages", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT blob2 AS route,
             blob3 AS status,
             blob6 AS errMsg,
             blob4 AS trace,
             count() AS n
      FROM hookka_erp_metrics
      WHERE blob1 = 'req'
        AND timestamp > NOW() - ${WINDOW}
        AND blob3 LIKE '5%'
      GROUP BY route, status, errMsg, trace
      ORDER BY n DESC
      LIMIT 50
    `;
    const resp = await runAeSql(accountId, token, sql);
    // Group by (route, errMsg) and keep one representative trace per group.
    const grouped = new Map<
      string,
      { route: string; status: string; errMsg: string; n: number; trace: string }
    >();
    for (const r of resp.data ?? []) {
      const row = r as Record<string, unknown>;
      const route = String(row.route ?? "");
      const status = String(row.status ?? "");
      const errMsg = String(row.errMsg ?? "");
      const trace = String(row.trace ?? "");
      const n = Number(row.n) || 0;
      const key = `${route}|${errMsg}`;
      if (!grouped.has(key)) {
        grouped.set(key, { route, status, errMsg, n: 0, trace });
      }
      const g = grouped.get(key)!;
      g.n += n;
      if (!g.trace && trace) g.trace = trace;
    }
    return [...grouped.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 20);
  });
  return c.json({ success: true, data: data ?? [] });
});

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

// Deploy markers — list of recent deploy times so the FE can overlay
// vertical lines on the Daily Trend / Hourly Error charts. The
// operator sees "spike at 14:00 + a deploy 5min earlier = this deploy
// broke prod".
//
// Source: this worker bundle ships with a CF_DEPLOYMENT_ID env var that
// CF Pages injects per build. We can't read other deploys' IDs from
// inside the runtime — what we CAN do is record THIS deploy's
// timestamp once at cold-start and surface it. Across cold-starts you
// get a series of deploy timestamps in AE itself (via the same
// metrics pipeline — every deploy starts new workers which emit
// req events with their own deploy hash).
//
// For now we keep this simple: read the CF_DEPLOYMENT_ID + DEPLOY_AT
// env vars (set via wrangler in deploy.yml — operator can also
// hand-bump for backfill). FE renders one marker per row.
app.get("/deploys", async (c) => {
  const env = c.env as {
    CF_DEPLOYMENT_ID?: string;
    DEPLOY_AT?: string;
    DEPLOY_HISTORY?: string;
  };
  // Optional history blob — pipe-delimited "id1|iso1,id2|iso2,..." set
  // via wrangler if the operator wants a longer window.
  const deploys: Array<{ id: string; at: string }> = [];
  if (env.DEPLOY_HISTORY) {
    for (const pair of env.DEPLOY_HISTORY.split(",")) {
      const [id, at] = pair.split("|");
      if (id && at) deploys.push({ id: id.trim(), at: at.trim() });
    }
  }
  // Always include the current deploy (latest).
  if (env.CF_DEPLOYMENT_ID && env.DEPLOY_AT) {
    deploys.push({ id: env.CF_DEPLOYMENT_ID, at: env.DEPLOY_AT });
  }
  return c.json({ success: true, data: deploys });
});

// ---------------------------------------------------------------------------
// GitHub Actions health — surface CI / automation failures on the dashboard
// instead of emailing the owner on every failed run. We poll the GitHub REST
// API for the most recent workflow runs on this repo and hand the frontend a
// compact list it can highlight (failures in red). Pull-based by design:
// nothing to configure on the GitHub side, just a read-only token in
// Cloudflare.
//
// Auth: requires a fine-grained, READ-ONLY PAT in env.GITHUB_TOKEN
// (Actions: read on this repo). When unset we return {configured:false} so the
// panel renders a "not connected" hint rather than erroring.
//
// Repo: defaults to the known slug; override with env.GITHUB_REPO ("owner/repo").
//
// Failure isolation: any non-2xx / thrown error returns {configured:true,
// error} with an empty runs[] — the dashboard must never hang or crash on a
// GitHub hiccup. An 8s abort caps the wait.
/**
 * A workflow whose LATEST run failed, and how long it has been failing.
 *
 * The plain 20-run list cannot show this. Hookka runs Keep-DB-warm, the scan
 * sweep, mail sync and the agent heartbeat on tight schedules, so a once-a-day
 * job's failure is pushed out of the window within MINUTES. That is how the
 * daily Postgres backup failed 20 times in a row — every run in its visible
 * history — without anyone noticing that there were no backups at all.
 */
type FailingWorkflow = {
  name: string;
  consecutive: number;
  since: string;
  url: string;
};

type GithubRunOut = {
  id: number;
  name: string;
  title: string;
  branch: string;
  event: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | timed_out | ...
  url: string;
  at: string;
};
app.get("/github-runs", async (c) => {
  const env = c.env as { GITHUB_TOKEN?: string; GITHUB_REPO?: string };
  const repo = (env.GITHUB_REPO || "weisiang329-eng/hookka-erp-testing").trim();
  if (!env.GITHUB_TOKEN) {
    return c.json({
      success: true,
      data: { configured: false, repo, runs: [] as GithubRunOut[] },
    });
  }
  // Cache the GitHub result (best-effort, 45s) so repeated dashboard opens don't
  // each pay the GitHub round-trip — and the 8s abort (which let a slow GitHub
  // hang into a platform 504) drops to 2.5s. Owner perf audit 2026-07-31.
  const ghCache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const ghCacheKey = new Request(`https://ghruns.cache.local/${encodeURIComponent(repo)}`);
  if (ghCache) {
    try {
      const hit = await ghCache.match(ghCacheKey);
      if (hit) return c.json((await hit.json()) as unknown as Record<string, unknown>);
    } catch {
      // cache read failure → fall through to a live fetch
    }
  }
  try {
    const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=20`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "hookka-erp-health",
      },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return c.json({
        success: true,
        data: {
          configured: true,
          repo,
          error: `GitHub API ${res.status}`,
          runs: [] as GithubRunOut[],
        },
      });
    }
    const body = (await res.json()) as {
      workflow_runs?: Array<{
        id: number;
        name?: string;
        display_title?: string;
        head_branch?: string;
        event?: string;
        status?: string;
        conclusion?: string | null;
        html_url?: string;
        created_at?: string;
        updated_at?: string;
        run_started_at?: string;
      }>;
    };
    const runs: GithubRunOut[] = (body.workflow_runs || []).map((r) => ({
      id: r.id,
      name: r.name || "(workflow)",
      title: r.display_title || "",
      branch: r.head_branch || "",
      event: r.event || "",
      status: r.status || "",
      conclusion: r.conclusion ?? null,
      url: r.html_url || "",
      at: r.run_started_at || r.created_at || r.updated_at || "",
    }));
    // Second, cheap call: recent FAILURES only, so a daily job's failure cannot
    // be crowded out by a 5-minute cron's successes. Reduced to the latest
    // failure per workflow, with a consecutive count so "failing for weeks"
    // reads differently from "failed once this morning".
    let failing: FailingWorkflow[] = [];
    try {
      const fRes = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs?status=failure&per_page=50`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "hookka-erp-health",
          },
          signal: AbortSignal.timeout(2500),
        },
      );
      if (fRes.ok) {
        const fBody = (await fRes.json()) as {
          workflow_runs?: Array<{
            name?: string;
            html_url?: string;
            created_at?: string;
            run_started_at?: string;
          }>;
        };
        const byName = new Map<string, FailingWorkflow>();
        for (const r of fBody.workflow_runs ?? []) {
          const name = r.name || "(workflow)";
          const at = r.run_started_at || r.created_at || "";
          const hit = byName.get(name);
          if (hit) {
            hit.consecutive += 1;
            // The list is newest-first, so each later row is an OLDER failure.
            if (at && (!hit.since || at < hit.since)) hit.since = at;
          } else {
            byName.set(name, {
              name,
              consecutive: 1,
              since: at,
              url: r.html_url || "",
            });
          }
        }
        // A workflow that has since gone green must not be reported as failing.
        const latestByName = new Map<string, string>();
        for (const r of runs) {
          if (!latestByName.has(r.name)) latestByName.set(r.name, r.conclusion ?? "");
        }
        failing = [...byName.values()]
          .filter((w) => (latestByName.get(w.name) ?? "failure") === "failure")
          .sort((a, b) => b.consecutive - a.consecutive);
      }
    } catch {
      // Best-effort — the main run list must still render if this call fails.
    }

    const payload = { success: true, data: { configured: true, repo, runs, failing } };
    if (ghCache) {
      try {
        await ghCache.put(
          ghCacheKey,
          new Response(JSON.stringify(payload), {
            headers: { "Content-Type": "application/json", "Cache-Control": "max-age=45" },
          }),
        );
      } catch {
        // caching is best-effort; a put failure must never fail the request
      }
    }
    return c.json(payload);
  } catch (e) {
    return c.json({
      success: true,
      data: {
        configured: true,
        repo,
        error: String((e as Error)?.message || e),
        runs: [] as GithubRunOut[],
      },
    });
  }
});

// Slow SQL captures — the missing piece that translates "this endpoint
// is slow" into "this specific SQL statement is slow". Backed by
// emitSlowSql() in src/api/lib/observability.ts, which fires from the
// D1 wrapper for any query taking >= SLOW_QUERY_MS (500ms).
//
// AE schema for slow_sql events (per emitSlowSql):
//   blob1 = "slow_sql"   (event-kind discriminator)
//   blob2 = route        (e.g. /api/sales-orders)
//   blob3 = op           (all | first | run | batch | raw)
//   blob4 = sqlSnippet   (first 200 chars of the SQL with whitespace collapsed)
//   double1 = dur_ms
//   double2 = rowsRead   (may be 0 if not reported by D1 driver)
//
// Aggregates by (route, op, sqlSnippet) so repeated slow queries collapse
// into one row with hit count + avg/p95 duration. Operator scans this
// list to know exactly which SQL statement is the bottleneck, then jumps
// into the source file to add an index / refactor the query / wrap in a
// snapshot. Sorted by P95 desc so the worst offenders surface first.
app.get("/slow-sql", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT blob2 AS route,
             blob3 AS op,
             blob4 AS sqlSnippet,
             double1 AS dur,
             double2 AS rowsRead
      FROM hookka_erp_metrics
      WHERE blob1 = 'slow_sql'
        AND timestamp > NOW() - ${WINDOW}
      LIMIT 5000
    `;
    const resp = await runAeSql(accountId, token, sql);
    // Group in JS so we can compute P95 + avg per (route, op, snippet).
    // AE doesn't support quantile() so this is the same pattern used by
    // every other percentile-returning endpoint above.
    type Bucket = {
      route: string;
      op: string;
      sqlSnippet: string;
      samples: number[];
      rowsRead: number;
    };
    const grouped = new Map<string, Bucket>();
    for (const r of resp.data ?? []) {
      const row = r as Record<string, unknown>;
      const route = String(row.route ?? "");
      const op = String(row.op ?? "");
      const snippet = String(row.sqlSnippet ?? "");
      const dur = Number(row.dur);
      const rows = Number(row.rowsRead) || 0;
      const key = `${route}|${op}|${snippet}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          route,
          op,
          sqlSnippet: snippet,
          samples: [],
          rowsRead: 0,
        });
      }
      const g = grouped.get(key)!;
      if (Number.isFinite(dur)) g.samples.push(dur);
      g.rowsRead += rows;
    }
    const out = [...grouped.values()].map((g) => {
      const sorted = [...g.samples].sort((a, b) => a - b);
      const pick = (p: number): number =>
        sorted.length === 0
          ? 0
          : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      const avg =
        g.samples.length === 0
          ? 0
          : g.samples.reduce((s, v) => s + v, 0) / g.samples.length;
      return {
        route: g.route,
        op: g.op,
        sqlSnippet: g.sqlSnippet,
        hits: g.samples.length,
        avgDur: Math.round(avg),
        p95: Math.round(pick(0.95)),
        rowsRead: g.rowsRead,
      };
    });
    out.sort((a, b) => b.p95 - a.p95 || b.hits - a.hits);
    return out.slice(0, 30);
  });
  return c.json({ success: true, data: data ?? [] });
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

// ---------------------------------------------------------------------------
// Phase 7 — Audit feed. Surfaces recent audit_events rows on the
// /admin/health dashboard so the operator can answer "WHO did WHAT
// WHEN" without leaving the page.
//
// Different from /api/audit-events (per-resource feed for AuditHistoryPanel
// on detail pages). This endpoint is org-wide, time-windowed, and filters
// by action+resource so the dashboard can show "20 invoice-voids in the
// last 24h" or "5 user-role-changes this week".
//
// Reads from Postgres (audit_events table is the source of truth for
// mutations), NOT Analytics Engine. AE captures performance + errors;
// audit_events captures business actions. Distinct concerns.
//
// Required query: range=24h|7d|30d|90d (same window selector as the AE
// panels). Optional: resource=X, action=Y (any subset; AND-combined).
// ---------------------------------------------------------------------------
app.get("/audit-feed", async (c) => {
  const range = parseRange(c.req.query("range"));
  // Map the range token to a SQL interval string. Postgres syntax —
  // audit_events lives in Supabase, not AE. INTERVAL '24 hours' /
  // '7 days' / '30 days' / '90 days'.
  const pgInterval =
    range === "90d"
      ? "90 days"
      : range === "30d"
        ? "30 days"
        : range === "7d"
          ? "7 days"
          : "24 hours";

  // Optional filters. We accept literal strings and bind-parameter
  // them rather than interpolating to keep SQL-injection off the table.
  const resourceFilter = (c.req.query("resource") ?? "").trim();
  const actionFilter = (c.req.query("action") ?? "").trim();
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100));

  let orgId: string;
  try {
    orgId = getOrgId(c);
  } catch {
    // Should never fire — admin-health is behind authMiddleware which
    // populates orgId. Be defensive anyway.
    return c.json({ success: true, data: [], summary: { byAction: [], byResource: [] } });
  }

  const params: unknown[] = [orgId];
  let sql = `
    SELECT id, actorUserId, actorUserName, actorRole,
           resource, resourceId, action, source, ts
      FROM audit_events
     WHERE orgId = ?
       AND ts > NOW() - INTERVAL '${pgInterval}'
  `;
  if (resourceFilter) {
    sql += " AND resource = ?";
    params.push(resourceFilter);
  }
  if (actionFilter) {
    sql += " AND action = ?";
    params.push(actionFilter);
  }
  sql += " ORDER BY ts DESC LIMIT ?";
  params.push(limit);

  type Row = {
    id: string;
    actorUserId: string | null;
    actorUserName: string | null;
    actorRole: string | null;
    resource: string;
    resourceId: string;
    action: string;
    source: string;
    ts: string;
  };
  let rows: Row[] = [];
  try {
    const res = await c.var.DB
      .prepare(sql)
      .bind(...params)
      .all<Row>();
    rows = res.results ?? [];
  } catch (err) {
    console.warn("[admin-health] audit-feed query failed:", err);
    return c.json({ success: true, data: [], summary: { byAction: [], byResource: [] } });
  }

  // Also compute per-action + per-resource summaries over the same
  // window. Useful for the panel header ("123 events; top: update SO,
  // create JC, delete worker").
  const byAction = new Map<string, number>();
  const byResource = new Map<string, number>();
  for (const r of rows) {
    byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
    byResource.set(r.resource, (byResource.get(r.resource) ?? 0) + 1);
  }
  const summary = {
    byAction: [...byAction.entries()]
      .map(([action, n]) => ({ action, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8),
    byResource: [...byResource.entries()]
      .map(([resource, n]) => ({ resource, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8),
  };

  return c.json({ success: true, data: rows, summary });
});

// ---------------------------------------------------------------------------
// Security events feed — surfaces auth-related rows from audit_events on
// the /admin/health dashboard. Different from /audit-feed (which is
// org-wide business mutations); this view zooms in on actions an attacker
// would touch: logins, login failures, password changes, password resets,
// role changes, user create/delete.
//
// Why a separate endpoint rather than ?action=login on /audit-feed:
//   • multiple actions/resources are in-scope (OR-combined) so a single
//     ?action= can't express the filter set
//   • we want server-side aggregates (failed logins per actor / IP, reset
//     spikes per email) — the audit-feed only returns rows + simple counts
//   • the panel needs both the recent events AND the aggregates in one
//     fetch so the dashboard stays at one network call per panel
//
// In-scope action set:
//   resource='auth'    → login, login.fail, logout, password-change,
//                        password-reset-request, password-reset-complete
//   resource='users'   → role-change, user-create, user-delete
//
// 2026-05-27: the audit-emitting code in auth.ts uses 'login.fail' (dotted)
// for failed logins; the security-hardening spec calls it 'login-failed'.
// We accept BOTH so the endpoint keeps working if either spelling lands.
//
// Best-effort failure model: any DB throw returns an empty result, never
// 500. The security panel should NEVER cause the dashboard to crash —
// that itself is a security-blindness risk.
// ---------------------------------------------------------------------------
app.get("/security-events", async (c) => {
  const range = parseRange(c.req.query("range"));
  const pgInterval =
    range === "90d"
      ? "90 days"
      : range === "30d"
        ? "30 days"
        : range === "7d"
          ? "7 days"
          : "24 hours";

  // Org-scope guard. Should always populate from authMiddleware but be
  // defensive — the security panel is the last thing we want to silently
  // cross orgs.
  let orgId: string;
  try {
    orgId = getOrgId(c);
  } catch {
    return c.json({
      success: true,
      data: {
        recentEvents: [],
        failedLoginsByActor: [],
        failedLoginsByIp: [],
        passwordResetsByEmail: [],
        summary: {
          totalLogins: 0,
          totalFailures: 0,
          totalResets: 0,
          totalRoleChanges: 0,
        },
      },
    });
  }

  // Inline filter list — kept literal (no bind params) because every
  // value is a static string we own. resource='auth' covers the
  // login/logout/password family; resource='users' covers the
  // membership lifecycle.
  const inScope = `(
    resource = 'auth'
    OR action IN (
      'login', 'login.fail', 'login-failed',
      'password-change', 'password-reset-request',
      'password-reset-complete', 'logout',
      'role-change', 'user-create', 'user-delete'
    )
  )`;

  type Row = {
    id: string;
    actorUserId: string | null;
    actorUserName: string | null;
    actorRole: string | null;
    resource: string;
    resourceId: string;
    action: string;
    source: string;
    ipAddress: string | null;
    ts: string;
  };

  // Single fetch of recent rows in the window, then bucket in JS for the
  // aggregates. The window is bounded (24h..90d) and security volume is
  // low, so one query + JS grouping is cheaper than 4 grouped queries.
  let rows: Row[] = [];
  try {
    const sql = `
      SELECT id, actorUserId, actorUserName, actorRole,
             resource, resourceId, action, source, ipAddress, ts
        FROM audit_events
       WHERE orgId = ?
         AND ts > NOW() - INTERVAL '${pgInterval}'
         AND ${inScope}
       ORDER BY ts DESC
       LIMIT 2000
    `;
    const res = await c.var.DB
      .prepare(sql)
      .bind(orgId)
      .all<Row>();
    rows = res.results ?? [];
  } catch (err) {
    console.warn("[admin-health] security-events query failed:", err);
    return c.json({
      success: true,
      data: {
        recentEvents: [],
        failedLoginsByActor: [],
        failedLoginsByIp: [],
        passwordResetsByEmail: [],
        summary: {
          totalLogins: 0,
          totalFailures: 0,
          totalResets: 0,
          totalRoleChanges: 0,
        },
      },
    });
  }

  // Bucket aggregates in JS. Failed-login pivots are the highest-signal
  // panels — they answer "is one IP hammering us" and "is one account
  // being targeted". Reset-by-email surfaces password-reset abuse
  // (mass forgot-password against a single user).
  const isFailedLogin = (a: string): boolean =>
    a === "login.fail" || a === "login-failed";
  const isReset = (a: string): boolean =>
    a === "password-reset-request";

  const failedByActor = new Map<string, number>();
  const failedByIp = new Map<string, number>();
  const resetsByEmail = new Map<string, number>();
  let totalLogins = 0;
  let totalFailures = 0;
  let totalResets = 0;
  let totalRoleChanges = 0;
  for (const r of rows) {
    if (r.action === "login") totalLogins++;
    else if (isFailedLogin(r.action)) {
      totalFailures++;
      const actor = r.actorUserName || r.actorUserId || r.resourceId || "(unknown)";
      failedByActor.set(actor, (failedByActor.get(actor) ?? 0) + 1);
      const ip = r.ipAddress || "(no ip)";
      failedByIp.set(ip, (failedByIp.get(ip) ?? 0) + 1);
    } else if (isReset(r.action)) {
      totalResets++;
      // resourceId on password-reset-request is the userId of the
      // target account (per auth.ts emitAudit call). We surface this
      // as "by email" even though it's the userId — the panel maps it
      // to a name via the row's actorUserName/resourceId when rendering.
      const key = r.resourceId || "(unknown)";
      resetsByEmail.set(key, (resetsByEmail.get(key) ?? 0) + 1);
    } else if (r.action === "role-change") {
      totalRoleChanges++;
    }
  }

  // Sort + top-10 cap. Each shape stays distinct so the frontend types
  // stay tight (no untyped k/v objects).
  const sortDesc = (a: { n: number }, b: { n: number }): number => b.n - a.n;
  const failedLoginsByActor = [...failedByActor.entries()]
    .map(([actor, n]) => ({ actor, n }))
    .sort(sortDesc)
    .slice(0, 10);
  const failedLoginsByIp = [...failedByIp.entries()]
    .map(([ip, n]) => ({ ip, n }))
    .sort(sortDesc)
    .slice(0, 10);
  const passwordResetsByEmail = [...resetsByEmail.entries()]
    .map(([userId, n]) => ({ userId, n }))
    .sort(sortDesc)
    .slice(0, 10);

  return c.json({
    success: true,
    data: {
      // Trim to last 50 newest-first for the recent-events table. The
      // 2000 fetch limit is for aggregate accuracy; the table doesn't
      // need that many rows.
      recentEvents: rows.slice(0, 50),
      failedLoginsByActor,
      failedLoginsByIp,
      passwordResetsByEmail,
      summary: {
        totalLogins,
        totalFailures,
        totalResets,
        totalRoleChanges,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — Front-End RUM read endpoints. The /api/fe-rum/event sink
// (src/api/routes/fe-rum.ts) collects events from the browser; these
// endpoints surface them on the /admin/health dashboard.
//
// AE schema (per fe-rum.ts):
//   Errors: blob1="fe_error", blob2=route, blob3=msg, blob4=stack, blob5=userId
//   Perf:   blob1="fe_perf",  blob2=route, blob3=metric, double1=value_ms
//
// Why two separate endpoints rather than one combined: errors aggregate
// by (route, msg) → top-N table; perf aggregates by (route, metric) →
// P50/P95 per metric. Different rendering, different queries.
// ---------------------------------------------------------------------------

// Top FE error messages — aggregate by (route, msg). Operator sees
// "TypeError: Cannot read 'x' of undefined" with hit count + a
// representative stack head so they can pinpoint the bug.
app.get("/fe-errors", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT blob2 AS route,
             blob3 AS msg,
             blob4 AS stack,
             count() AS n
      FROM hookka_erp_metrics
      WHERE blob1 = 'fe_error'
        AND timestamp > NOW() - ${WINDOW}
      GROUP BY route, msg, stack
      ORDER BY n DESC
      LIMIT 50
    `;
    const resp = await runAeSql(accountId, token, sql);
    // Collapse rows with same (route, msg) but different stack into a
    // single entry (keep first stack as representative). Without this
    // collapse, the same bug logged from two minified bundles would
    // show twice.
    const grouped = new Map<
      string,
      { route: string; msg: string; stack: string; n: number }
    >();
    for (const r of resp.data ?? []) {
      const row = r as Record<string, unknown>;
      const route = String(row.route ?? "");
      const msg = String(row.msg ?? "");
      const stack = String(row.stack ?? "");
      const n = Number(row.n) || 0;
      const key = `${route}|${msg}`;
      if (!grouped.has(key)) {
        grouped.set(key, { route, msg, stack, n: 0 });
      }
      const g = grouped.get(key)!;
      g.n += n;
      if (!g.stack && stack) g.stack = stack;
    }
    return [...grouped.values()].sort((a, b) => b.n - a.n).slice(0, 20);
  });
  return c.json({ success: true, data: data ?? [] });
});

// FE perf metrics — P50 / P95 per (route, metric). Operator sees
// "longtask P95 = 480ms on /production/orders" → the production page
// freezes the UI for nearly half a second. Same workaround as backend
// percentiles: pull raw values, compute in JS.
app.get("/fe-perf", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT blob2 AS route,
             blob3 AS metric,
             double1 AS value
      FROM hookka_erp_metrics
      WHERE blob1 = 'fe_perf'
        AND timestamp > NOW() - ${WINDOW}
      LIMIT 50000
    `;
    const resp = await runAeSql(accountId, token, sql);
    type Bucket = { route: string; metric: string; samples: number[] };
    const grouped = new Map<string, Bucket>();
    for (const r of resp.data ?? []) {
      const row = r as Record<string, unknown>;
      const route = String(row.route ?? "");
      const metric = String(row.metric ?? "");
      const v = Number(row.value);
      const key = `${route}|${metric}`;
      if (!grouped.has(key)) grouped.set(key, { route, metric, samples: [] });
      if (Number.isFinite(v)) grouped.get(key)!.samples.push(v);
    }
    const out = [...grouped.values()].map((g) => {
      const sorted = [...g.samples].sort((a, b) => a - b);
      const pick = (p: number): number =>
        sorted.length === 0
          ? 0
          : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      return {
        route: g.route,
        metric: g.metric,
        hits: g.samples.length,
        p50: Math.round(pick(0.5)),
        p95: Math.round(pick(0.95)),
      };
    });
    // Sort: longtask first (most actionable), then by P95 desc within
    // each metric. Operator scans top to bottom; bad longtasks lead.
    const metricOrder: Record<string, number> = {
      longtask: 0,
      lcp: 1,
      fcp: 2,
      ttfb: 3,
      nav: 4,
    };
    out.sort((a, b) => {
      const m = (metricOrder[a.metric] ?? 99) - (metricOrder[b.metric] ?? 99);
      if (m !== 0) return m;
      return b.p95 - a.p95;
    });
    return out.slice(0, 30);
  });
  return c.json({ success: true, data: data ?? [] });
});

// ---------------------------------------------------------------------------
// Slow / failed API call list (2026-06-29). Surfaces the gap previous
// fe-perf couldn't cover: a /api/* request that never completes silently
// (no JS error, no longtask, no LCP — just a spinner forever). The client
// only emits these for calls > 3s OR with status != 2xx, so the table is
// already filtered down to actionable rows.
//
// AE schema:
//   blob1="fe_api", blob2=route, blob3=endpoint, blob4=method, blob5=userId,
//   blob6=status (string; "0" = aborted/timeout), double1=duration_ms
// ---------------------------------------------------------------------------
app.get("/fe-api", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT blob2 AS route,
             blob3 AS endpoint,
             blob4 AS method,
             blob6 AS status,
             blob5 AS userId,
             double1 AS value
      FROM hookka_erp_metrics
      WHERE blob1 = 'fe_api'
        AND timestamp > NOW() - ${WINDOW}
      LIMIT 50000
    `;
    const resp = await runAeSql(accountId, token, sql);
    type Bucket = {
      endpoint: string;
      method: string;
      status: string;
      samples: number[];
      lastRoute: string;
      lastUserId: string;
    };
    const grouped = new Map<string, Bucket>();
    for (const r of resp.data ?? []) {
      const row = r as Record<string, unknown>;
      const endpoint = String(row.endpoint ?? "");
      const method = String(row.method ?? "GET");
      const status = String(row.status ?? "0");
      const route = String(row.route ?? "");
      const userId = String(row.userId ?? "");
      const v = Number(row.value);
      const key = `${endpoint}|${method}|${status}`;
      if (!grouped.has(key))
        grouped.set(key, {
          endpoint,
          method,
          status,
          samples: [],
          lastRoute: route,
          lastUserId: userId,
        });
      const g = grouped.get(key)!;
      if (Number.isFinite(v)) g.samples.push(v);
      if (route) g.lastRoute = route;
      if (userId) g.lastUserId = userId;
    }
    const out = [...grouped.values()].map((g) => {
      const sorted = [...g.samples].sort((a, b) => a - b);
      const pick = (p: number): number =>
        sorted.length === 0
          ? 0
          : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      return {
        endpoint: g.endpoint,
        method: g.method,
        status: g.status,
        hits: g.samples.length,
        p50: Math.round(pick(0.5)),
        p95: Math.round(pick(0.95)),
        max: Math.round(Math.max(0, ...g.samples)),
        sampleRoute: g.lastRoute,
        sampleUserId: g.lastUserId,
      };
    });
    // Sort: failures first (status=0 or 5xx), then by P95 desc — operator
    // scans top-to-bottom for "what's the worst right now".
    out.sort((a, b) => {
      const aFail =
        a.status === "0" || a.status.startsWith("5") ? 0 : 1;
      const bFail =
        b.status === "0" || b.status.startsWith("5") ? 0 : 1;
      if (aFail !== bFail) return aFail - bFail;
      return b.p95 - a.p95;
    });
    return out.slice(0, 50);
  });
  return c.json({ success: true, data: data ?? [] });
});

// ---------------------------------------------------------------------------
// Page-stuck list (2026-06-29). Each row = "user X on route Y was stuck
// > 15s with no /api/* call returning 2xx". Captures the case where the
// app shell rendered (sidebar visible, user blob loaded) but data never
// arrived. AE schema:
//   blob1="fe_stuck", blob2=route, blob5=userId, double1=ms_elapsed
// ---------------------------------------------------------------------------
app.get("/fe-stuck", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT blob2 AS route,
             blob5 AS userId,
             count() AS n,
             max(double1) AS maxMs
      FROM hookka_erp_metrics
      WHERE blob1 = 'fe_stuck'
        AND timestamp > NOW() - ${WINDOW}
      GROUP BY route, userId
      ORDER BY n DESC
      LIMIT 100
    `;
    const resp = await runAeSql(accountId, token, sql);
    return (resp.data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        route: String(row.route ?? ""),
        userId: String(row.userId ?? "(anon)"),
        n: Number(row.n) || 0,
        maxMs: Math.round(Number(row.maxMs) || 0),
      };
    });
  });
  return c.json({ success: true, data: data ?? [] });
});

export default app;

// ---------------------------------------------------------------------------
// GET /db-indexes — what indexes the LIVE Postgres actually has, and which of
// the ones our hot queries need are missing.
//
// WHY THIS EXISTS
// `migrations/*.sql` is NOT evidence. This project's migrations do not
// auto-apply (see CLAUDE.md), and the D1 → Supabase cutover in 2026-04 moved
// the runtime to a different engine entirely — so a `CREATE INDEX` sitting in
// 0001_init.sql proves only that SQLite once had it.
//
// The slow-SQL feed says this matters: over 7 days /api/production-orders read
// 77,594 rows at p95 23.8s, /api/delivery-orders/ready-planning 17,707 rows at
// 24.6s and /api/sales-orders 15,298 rows at 33.0s — all of them
// `WHERE <fk> IN (...)` hydration queries, exactly the shape an index decides.
//
// Read-only: it queries pg_indexes / pg_class and writes nothing. The table
// list is a fixed allow-list, so no caller-supplied identifier reaches SQL.
// ---------------------------------------------------------------------------

// The tables our slowest endpoints hydrate from, and the columns they filter
// or join on. Derived from the slow-SQL snippets, not from guesswork.
/**
 * camelCase -> snake_case, matching the column translation the D1-compat shim
 * applies. Already-snake_case input passes through unchanged, so it is safe to
 * run over both sides of the comparison.
 */
/**
 * The name of an index that serves `table(columns...)`, or null.
 *
 * Two things this must get right, both learned the hard way:
 *  - Postgres holds these columns in SNAKE_CASE (the D1-compat shim translates
 *    on the way in), so an expectation written as `salesOrderId` has to be
 *    compared against `sales_order_id`. Skipping that is how the first version
 *    of this endpoint reported 12 of 14 indexes "missing" on a database that
 *    had every one of them.
 *  - Postgres can use a composite index for a PREFIX of its columns, so
 *    `(org_id, posted_at)` also serves a plain `(orgId)` need. Requiring an
 *    exact match would invent missing indexes that are already covered.
 */
export function indexSatisfying(
  indexes: readonly { tablename: string; indexname: string; indexdef: string }[],
  table: string,
  columns: readonly string[],
): string | null {
  const norm = (s: string) => snakeCase(s.replace(/"/g, "").trim());
  // An indexdef column carries its sort direction, null placement and opclass
  // ("posted_at DESC", "name varchar_pattern_ops", "x NULLS LAST"). None of
  // that changes which column it is, and leaving it attached made
  // (org_id, posted_at DESC) fail to match an (orgId, postedAt) expectation —
  // inventing a missing index that has existed all along.
  const normIndexCol = (s: string) =>
    norm(
      s
        .replace(/\s+(asc|desc)\b/gi, "")
        .replace(/\s+nulls\s+(first|last)\b/gi, "")
        .trim()
        .split(/\s+/)[0] ?? "",
    );
  const want = columns.map(norm).join(",");
  for (const idx of indexes) {
    if (norm(idx.tablename) !== norm(table)) continue;
    const m = idx.indexdef.match(/\(([^)]*)\)\s*$/);
    if (!m) continue;
    const cols = m[1].split(",").map(normIndexCol);
    if (cols.slice(0, columns.length).join(",") === want) return idx.indexname;
  }
  return null;
}

export function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

const INDEX_EXPECTATIONS: { table: string; columns: string[]; why: string }[] = [
  { table: "sales_orders", columns: ["orgId"], why: "list queries scope by org" },
  { table: "sales_order_items", columns: ["salesOrderId"], why: "SELECT * FROM sales_order_items WHERE salesOrderId IN (...) — 15,298 rows at p95 33.0s" },
  { table: "production_orders", columns: ["salesOrderId"], why: "PO → SO hydration" },
  { table: "production_orders", columns: ["status"], why: "dept boards filter by status" },
  { table: "production_orders", columns: ["currentDepartment"], why: "dept boards filter by department" },
  { table: "job_cards", columns: ["productionOrderId"], why: "job cards hydrate per PO" },
  { table: "job_cards", columns: ["departmentCode"], why: "dept board scope" },
  { table: "job_cards", columns: ["status"], why: "dept board scope" },
  { table: "delivery_orders", columns: ["salesOrderId"], why: "DO → SO hydration (ready-planning, 17,707 rows at p95 24.6s)" },
  { table: "delivery_order_items", columns: ["deliveryOrderId"], why: "DO line hydration" },
  { table: "invoices", columns: ["customerId"], why: "debtor aging + statements" },
  { table: "ledger_journal_entries", columns: ["orgId", "postedAt"], why: "GL / trial balance scan order" },
  { table: "ledger_journal_entries", columns: ["accountCode", "postedAt"], why: "single-account ledger inquiry" },
  { table: "ledger_journal_entries", columns: ["sourceType", "sourceId"], why: "every leg → source document lookup" },
];

app.get("/db-indexes", async (c) => {
  const tables = [...new Set(INDEX_EXPECTATIONS.map((e) => e.table))];
  const placeholders = tables.map(() => "?").join(",");

  let indexRows: { tablename: string; indexname: string; indexdef: string }[] = [];
  try {
    const res = await c.var.DB.prepare(
      `SELECT tablename, indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN (${placeholders})`,
    )
      .bind(...tables)
      .all<{ tablename: string; indexname: string; indexdef: string }>();
    indexRows = res.results ?? [];
  } catch (err) {
    // Not Postgres (or no permission) → say so rather than reporting "0 indexes",
    // which would read as "everything is missing".
    return c.json({
      success: false,
      error: `index introspection unavailable: ${err instanceof Error ? err.message : "unknown"}`,
    });
  }

  // Approximate row counts from the planner's statistics — free, and precise
  // enough to rank which missing index hurts most. A negative reltuples means
  // the table has never been analysed.
  const counts = new Map<string, number>();
  try {
    const res = await c.var.DB.prepare(
      `SELECT relname, reltuples FROM pg_class WHERE relname IN (${placeholders})`,
    )
      .bind(...tables)
      .all<{ relname: string; reltuples: number }>();
    for (const r of res.results ?? []) counts.set(r.relname, Math.max(0, Math.round(Number(r.reltuples) || 0)));
  } catch {
    /* stats unavailable → counts stay empty, the report still works */
  }

  // An expectation is satisfied when SOME index leads with the expected
  // columns in order. Postgres can use a composite index for a prefix of its
  // columns, so `(orgId, postedAt)` also covers a plain `(orgId)` need.
  const satisfied = (table: string, columns: string[]): string | null =>
    indexSatisfying(indexRows, table, columns);

  const checks = INDEX_EXPECTATIONS.map((e) => {
    const by = satisfied(e.table, e.columns);
    return {
      table: e.table,
      columns: e.columns,
      why: e.why,
      present: by !== null,
      servedBy: by,
      approxRows: counts.get(e.table) ?? null,
    };
  });
  const missing = checks.filter((x) => !x.present);

  return c.json({
    success: true,
    data: {
      // Sorted so the biggest table with a missing index is the first thing read.
      missing: missing.sort((a, b) => (b.approxRows ?? 0) - (a.approxRows ?? 0)),
      missingCount: missing.length,
      checked: checks.length,
      indexesFound: indexRows.length,
      byTable: tables.map((t) => ({
        table: t,
        approxRows: counts.get(t) ?? null,
        indexes: indexRows
          .filter((r) => snakeCase(r.tablename) === snakeCase(t))
          .map((r) => r.indexname),
      })),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /db-connect — is the database slow, or is GETTING to it slow?
//
// The index audit (/db-indexes) reports missing=0/14: every index the hot
// queries need is present, and the largest table is 32k rows. Yet slow SQL
// shows p95 20-33s, and one sampled call read NINE rows in 38,880ms. No query
// plan explains that.
//
// db-pg.ts creates a fresh postgres.js client per request — it must, because a
// socket opened in one Workers request cannot be used from another — and the
// socket connects lazily. So the request's FIRST query pays connection
// acquisition on top of its own execution, and every later query on that
// request reuses the socket. timingMiddleware now records that first query's
// duration as double4 of the `req` event.
//
// This endpoint compares it against total DB time per request. If the first
// query dominates, the problem is upstream of SQL — Hyperdrive/Supavisor pool
// exhaustion or queueing — and no amount of query tuning will move it.
// ---------------------------------------------------------------------------
app.get("/db-connect", async (c) => {
  const { WINDOW } = rangeWindow(parseRange(c.req.query("range")));
  const data = await withAe(c, async (accountId, token) => {
    const sql = `
      SELECT blob2 AS route,
             double2 AS dbTotal,
             double3 AS dbCount,
             double4 AS firstMs
      FROM hookka_erp_metrics
      WHERE blob1 = 'req'
        AND timestamp > NOW() - ${WINDOW}
        AND double3 > 0
      LIMIT 10000
    `;
    const resp = await runAeSql(accountId, token, sql);
    type Bucket = { route: string; first: number[]; rest: number[]; n: number };
    const grouped = new Map<string, Bucket>();
    const allFirst: number[] = [];
    const allRest: number[] = [];
    for (const r of resp.data ?? []) {
      const row = r as Record<string, unknown>;
      const route = String(row.route ?? "");
      const total = Number(row.dbTotal) || 0;
      const count = Number(row.dbCount) || 0;
      const first = Number(row.firstMs) || 0;
      // Requests that ran a single query tell us nothing about the split —
      // their first query IS all of their DB time.
      if (count < 2) continue;
      // Mean of the non-first queries on the same request, so the comparison
      // is like-for-like: same request, same connection, same moment.
      const rest = Math.max(0, (total - first) / (count - 1));
      const b = grouped.get(route) ?? { route, first: [], rest: [], n: 0 };
      b.first.push(first);
      b.rest.push(rest);
      b.n += 1;
      grouped.set(route, b);
      allFirst.push(first);
      allRest.push(rest);
    }
    const pct = (arr: number[], p: number): number => {
      if (arr.length === 0) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
    };
    const routes = [...grouped.values()]
      .filter((b) => b.n >= 5)
      .map((b) => ({
        route: b.route,
        samples: b.n,
        firstP50: pct(b.first, 50),
        firstP95: pct(b.first, 95),
        restP50: pct(b.rest, 50),
        restP95: pct(b.rest, 95),
        // How many times the first query costs what a later one does. This is
        // the number to read: >5 means connection acquisition, not SQL.
        ratioP50: pct(b.rest, 50) > 0 ? Math.round((pct(b.first, 50) / pct(b.rest, 50)) * 10) / 10 : null,
      }))
      .sort((a, b) => (b.ratioP50 ?? 0) - (a.ratioP50 ?? 0));
    return {
      overall: {
        samples: allFirst.length,
        firstP50: pct(allFirst, 50),
        firstP95: pct(allFirst, 95),
        firstMax: allFirst.length ? Math.max(...allFirst) : 0,
        restP50: pct(allRest, 50),
        restP95: pct(allRest, 95),
        ratioP50: pct(allRest, 50) > 0 ? Math.round((pct(allFirst, 50) / pct(allRest, 50)) * 10) / 10 : null,
      },
      routes: routes.slice(0, 25),
    };
  });
  return c.json({ success: true, data });
});
