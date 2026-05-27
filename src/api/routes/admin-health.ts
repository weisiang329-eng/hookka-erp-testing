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
async function liveKpis(
  accountId: string,
  token: string,
): Promise<Kpis> {
  const DATASET = "hookka_erp_metrics";
  // 24-hour window. AE SQL supports INTERVAL strings.
  const WINDOW = "INTERVAL '1' DAY";

  // (1) Latency percentiles + long-task count, all from one scan over
  // `blob1 = 'req'` rows.
  const sqlPct = `
    SELECT
      quantile(0.50)(double1) AS p50,
      quantile(0.75)(double1) AS p75,
      quantile(0.95)(double1) AS p95,
      countIf(double1 >= 200)  AS longTaskCount
    FROM ${DATASET}
    WHERE blob1 = 'req' AND timestamp > NOW() - ${WINDOW}
  `;

  // (2) Hourly request counts for the 24-bucket sparkline.
  const sqlSpark = `
    SELECT
      toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
      count()                                          AS n
    FROM ${DATASET}
    WHERE blob1 = 'req' AND timestamp > NOW() - ${WINDOW}
    GROUP BY hour
    ORDER BY hour ASC
  `;

  const [pctResp, sparkResp] = await Promise.all([
    runAeSql(accountId, token, sqlPct),
    runAeSql(accountId, token, sqlSpark),
  ]);

  const pctRow = pctResp.data?.[0] ?? {};
  const p50 = Math.round(Number(pctRow.p50) || 0);
  const p75 = Math.round(Number(pctRow.p75) || 0);
  const p95 = Math.round(Number(pctRow.p95) || 0);
  const longTaskCount = Math.round(Number(pctRow.longTaskCount) || 0);

  // Build a 24-element sparkline keyed by hour-of-day. Missing hours
  // (e.g. brand-new dataset with < 24h of writes) read as zero. We
  // align oldest→newest so the chart reads left-to-right naturally.
  const sparkline: number[] = new Array(24).fill(0);
  const now = Date.now();
  for (const row of sparkResp.data ?? []) {
    const hourStr = String(row.hour ?? "");
    const ts = Date.parse(hourStr);
    if (Number.isNaN(ts)) continue;
    // Hours-ago, clipped to [0,23].
    const hoursAgo = Math.floor((now - ts) / 3600_000);
    if (hoursAgo < 0 || hoursAgo > 23) continue;
    const idx = 23 - hoursAgo;
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
    const data = await liveKpis(env.CF_ACCOUNT_ID, env.AE_QUERY_TOKEN);
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

export default app;
