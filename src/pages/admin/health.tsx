// ---------------------------------------------------------------------------
// /admin/health — Phase 6 / P6.4 KPI dashboard.
//
// SUPER_ADMIN-only. Five KPI cards (p50, p75, p95, longTaskCount,
// cacheHitRatio) plus a 24h hourly request-volume sparkline. Data comes
// from GET /api/admin/health/kpis, which currently returns a
// deterministic mock (`_mock: true`) until Cloudflare Analytics Engine
// SQL access is wired — see docs/OBSERVABILITY.md.
//
// The route registration in src/dashboard-routes.tsx wraps this in
// <RequireRole role="SUPER_ADMIN"> so non-admins redirect to /dashboard
// before the data fetch even starts. The endpoint enforces the same
// role check server-side (defense-in-depth).
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Activity,
  AlertTriangle,
  Clock,
  Gauge,
  TrendingUp,
} from "lucide-react";

// Time-range selector — passed to every /api/admin/health/* endpoint
// as ?range=. AE retention is 92 days so 30d is the practical max for
// daily monitoring; 7d / 24h are the more common slices.
type Range = "24h" | "7d" | "30d" | "90d";
const RANGE_LABEL: Record<Range, string> = {
  "24h": "Last 24h",
  "7d": "Last 7d",
  "30d": "Last 30d",
  "90d": "Last 90d",
};

// Shape returned by GET /api/admin/health/kpis. Keep this in sync with
// src/api/routes/admin-health.ts.
type KpiPayload = {
  success: boolean;
  data: {
    p50: number;
    p75: number;
    p95: number;
    longTaskCount: number;
    cacheHitRatio: number;
    sparkline: number[];
    _mock: boolean;
    _source: "mock" | "ae";
  };
};

// Tiny inline SVG sparkline. recharts is already a dependency, but the
// dataset is 24 datapoints — building a Recharts <LineChart> is overkill
// when 30 lines of SVG draw it cleaner and have no chunk-size impact.
function Sparkline({ data }: { data: number[] }) {
  const { points, viewBox } = useMemo(() => {
    if (!data.length) return { points: "", viewBox: "0 0 100 30" };
    const w = 240;
    const h = 60;
    const max = Math.max(...data, 1);
    const stepX = w / Math.max(1, data.length - 1);
    const pts = data
      .map((v, i) => {
        const x = i * stepX;
        const y = h - (v / max) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return { points: pts, viewBox: `0 0 ${w} ${h}` };
  }, [data]);
  return (
    <svg
      viewBox={viewBox}
      className="w-full h-16"
      preserveAspectRatio="none"
      aria-label="24h request volume sparkline"
    >
      <polyline
        fill="none"
        stroke="#6B5C32"
        strokeWidth={2}
        points={points}
      />
    </svg>
  );
}

function KpiCard({
  label,
  value,
  unit,
  icon: Icon,
  intent = "default",
}: {
  label: string;
  value: number | string;
  unit?: string;
  icon: typeof Activity;
  intent?: "default" | "warn";
}) {
  const accent =
    intent === "warn"
      ? "text-[#9C6F1E]"
      : "text-[#1F1D1B]";
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-[12px] font-medium uppercase tracking-wider text-[#5A5550]">
          {label}
        </CardTitle>
        <Icon className="h-4 w-4 text-[#8B7A52]" strokeWidth={1.75} />
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-semibold ${accent}`}>
          {value}
          {unit ? <span className="text-sm font-normal text-[#8B8580] ml-1">{unit}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

// Phase 2 — per-endpoint drill-down view payloads. Each shape mirrors
// the corresponding /api/admin/health/* endpoint.
type EndpointStats = {
  route: string;
  hits: number;
  p50: number;
  p95: number;
  avgDur: number;
  avgDb: number;
  dbPct: number;
};
type ErrorRow = {
  route: string;
  fourXX: number;
  fiveXX: number;
  total: number;
};
type HourlyErrors = { fourXX: number[]; fiveXX: number[] };
type DailyTrend = { p50: number[]; p95: number[]; errors: number[] };

// Multi-line latency trend — one P50 + P95 dot per bucket. Lets the
// operator scan "Sep 5 was slow + Sep 10 was VERY slow" without
// staring at a single aggregated number for the entire window.
function DailyTrendChart({ data }: { data: DailyTrend }) {
  const { p50, p95 } = data;
  const w = 480;
  const h = 100;
  const max = Math.max(1, ...p50, ...p95);
  const stepX = w / Math.max(1, p50.length - 1);
  const line = (arr: number[]): string =>
    arr
      .map((v, i) => `${(i * stepX).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
      .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-24"
      preserveAspectRatio="none"
      aria-label="Daily P50 + P95 latency trend"
    >
      {/* P50 line — lighter color, drawn under P95 */}
      <polyline fill="none" stroke="#8B7A52" strokeWidth={1.5} points={line(p50)} />
      {/* P95 line — darker / more prominent */}
      <polyline fill="none" stroke="#9A3A2D" strokeWidth={1.5} points={line(p95)} />
      {/* Inline legend at the top-right */}
      <text x={w - 75} y={12} fontSize="9" fill="#8B7A52">— P50</text>
      <text x={w - 35} y={12} fontSize="9" fill="#9A3A2D">— P95</text>
    </svg>
  );
}
type LongTaskRow = {
  route: string;
  status: string;
  dur: number;
  dbDur: number;
  trace: string;
  timestamp: string;
};

// Tiny stacked-bar chart for the hourly error overlay. 4xx grey, 5xx
// red. Same SVG primitive idea as the sparkline — no recharts overhead.
function HourlyErrorChart({ data }: { data: HourlyErrors }) {
  const { fourXX, fiveXX } = data;
  const w = 240;
  const h = 60;
  const max = Math.max(1, ...fourXX, ...fiveXX);
  const barW = w / 24;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-16"
      preserveAspectRatio="none"
      aria-label="24h error counts by hour"
    >
      {Array.from({ length: 24 }).map((_, i) => {
        const fiveH = (fiveXX[i] / max) * h;
        const fourH = (fourXX[i] / max) * h;
        const x = i * barW;
        return (
          <g key={i}>
            {fiveH > 0 && (
              <rect
                x={x + 1}
                y={h - fiveH}
                width={Math.max(0, barW - 2)}
                height={fiveH}
                fill="#9A3A2D"
              />
            )}
            {fourH > 0 && (
              <rect
                x={x + 1}
                y={h - fiveH - fourH}
                width={Math.max(0, barW - 2)}
                height={fourH}
                fill="#9C6F1E"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function AdminHealthPage() {
  // Active time range. Defaulting to 24h matches the historical
  // "Last 24 hours" copy + is the cheapest scan over AE.
  const [range, setRange] = useState<Range>("24h");
  const rangeQS = `?range=${range}`;

  const { data, loading, error } = useCachedJson<KpiPayload>(
    `/api/admin/health/kpis${rangeQS}`,
    60,
  );
  // Phase 2 — 4 parallel fetches. Refreshed every 60s (same as main KPIs).
  // Each query string carries the active range so all panels share the
  // same window.
  const { data: byEndpointResp } = useCachedJson<{
    success: boolean;
    data: EndpointStats[];
  }>(`/api/admin/health/by-endpoint${rangeQS}`, 60);
  const { data: errorsByResp } = useCachedJson<{
    success: boolean;
    data: ErrorRow[];
  }>(`/api/admin/health/errors-by-endpoint${rangeQS}`, 60);
  const { data: errorsHourlyResp } = useCachedJson<{
    success: boolean;
    data: HourlyErrors;
  }>(`/api/admin/health/errors-hourly${rangeQS}`, 60);
  const { data: longTasksResp } = useCachedJson<{
    success: boolean;
    data: LongTaskRow[];
  }>(`/api/admin/health/long-tasks${rangeQS}`, 60);
  const { data: dailyTrendResp } = useCachedJson<{
    success: boolean;
    data: DailyTrend;
  }>(`/api/admin/health/daily-trend${rangeQS}`, 60);

  const kpis = data?.data;
  const byEndpoint = byEndpointResp?.data ?? [];
  const errorsBy = errorsByResp?.data ?? [];
  const errorsHourly = errorsHourlyResp?.data ?? {
    fourXX: new Array(24).fill(0),
    fiveXX: new Array(24).fill(0),
  };
  const longTasks = longTasksResp?.data ?? [];
  const dailyTrend = dailyTrendResp?.data ?? {
    p50: new Array(24).fill(0),
    p95: new Array(24).fill(0),
    errors: new Array(24).fill(0),
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-[#1F1D1B]">System Health</h1>
          <p className="text-sm text-[#5A5550] mt-1">
            Aggregate request timing + error counters from Cloudflare Analytics Engine. {RANGE_LABEL[range]}.
          </p>
        </div>
        {/* Range toggle — 24h / 7d / 30d. AE retention is 92 days so 30d
            is comfortably within the window. All Phase 2 panels share
            this state. */}
        <div className="inline-flex rounded-md border border-[#E2DDD8] bg-white p-0.5">
          {(["24h", "7d", "30d", "90d"] as const).map((r) => (
            <Button
              key={r}
              variant={range === r ? "primary" : "ghost"}
              size="sm"
              onClick={() => setRange(r)}
              className="px-3 h-7 text-xs"
            >
              {r}
            </Button>
          ))}
        </div>
      </div>

      {kpis?._mock && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>No live data yet.</strong> The Analytics Engine binding is
          either missing or the SQL token isn't wired. The numbers below are
          deterministic mocks so the dashboard can be reviewed end-to-end.
          See <code>docs/OBSERVABILITY.md</code> for the remaining setup.
        </div>
      )}

      {loading && !kpis && (
        <div className="text-sm text-[#5A5550] animate-pulse">Loading KPIs...</div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          Failed to load KPIs: {error}
        </div>
      )}

      {kpis && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <KpiCard label="p50 latency" value={kpis.p50} unit="ms" icon={Clock} />
            <KpiCard label="p75 latency" value={kpis.p75} unit="ms" icon={Clock} />
            <KpiCard
              label="p95 latency"
              value={kpis.p95}
              unit="ms"
              icon={Gauge}
              intent={kpis.p95 >= 500 ? "warn" : "default"}
            />
            <KpiCard
              label="Long tasks (>=200ms)"
              value={kpis.longTaskCount}
              icon={AlertTriangle}
              intent={kpis.longTaskCount > 500 ? "warn" : "default"}
            />
            <KpiCard
              label="Cache hit ratio"
              value={`${Math.round(kpis.cacheHitRatio * 100)}%`}
              icon={TrendingUp}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Hourly request volume ({RANGE_LABEL[range].toLowerCase()})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Sparkline data={kpis.sparkline} />
              <div className="mt-1 flex justify-between text-[11px] text-[#8B8580]">
                <span>{range === "24h" ? "24h ago" : range === "7d" ? "7d ago" : range === "30d" ? "30d ago" : "90d ago"}</span>
                <span>now</span>
              </div>
            </CardContent>
          </Card>

          {/* Latency trend over the chosen window — one P50 + P95 dot
              per bucket. Operator scans for spikes ("Sep 5 was bad")
              rather than reading a single aggregated number. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Latency trend ({RANGE_LABEL[range].toLowerCase()}) — P50 + P95 per {range === "24h" ? "hour" : "day"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DailyTrendChart data={dailyTrend} />
              <div className="mt-1 flex justify-between text-[11px] text-[#8B8580]">
                <span>{range === "24h" ? "24h ago" : range === "7d" ? "7d ago" : range === "30d" ? "30d ago" : "90d ago"}</span>
                <span>now</span>
              </div>
            </CardContent>
          </Card>

          {/* Phase 2 — drill-down views. Operator uses these to answer
              "WHERE is the system slow / erroring" not just "is it slow". */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Top 10 slowest endpoints. P95 sorted; dbPct shows whether
                the slowness is DB-bound (=> tune DB / add cache) or
                code-bound (=> profile the worker logic). */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                  Top 10 slowest endpoints ({RANGE_LABEL[range].toLowerCase()})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {byEndpoint.length === 0 ? (
                  <p className="text-xs text-[#8B8580]">
                    No data yet — AE collects on every request, give it 30 min after first deploy.
                  </p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                        <th className="py-1.5 font-medium">Endpoint</th>
                        <th className="py-1.5 font-medium text-right">Hits</th>
                        <th className="py-1.5 font-medium text-right">P50</th>
                        <th className="py-1.5 font-medium text-right">P95</th>
                        <th className="py-1.5 font-medium text-right" title="% of total time that was DB query time">DB %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byEndpoint.map((r) => (
                        <tr key={r.route} className="border-b border-[#F5F2EE]">
                          <td className="py-1.5 font-mono text-[11px] text-[#1F1D1B] truncate max-w-[220px]" title={r.route}>{r.route}</td>
                          <td className="py-1.5 text-right text-[#5A5550]">{r.hits.toLocaleString()}</td>
                          <td className="py-1.5 text-right text-[#5A5550]">{r.p50}ms</td>
                          <td className={`py-1.5 text-right font-semibold ${r.p95 >= 500 ? 'text-[#9A3A2D]' : r.p95 >= 200 ? 'text-[#9C6F1E]' : 'text-[#4F7C3A]'}`}>
                            {r.p95}ms
                          </td>
                          <td className={`py-1.5 text-right ${r.dbPct >= 70 ? 'text-[#9A3A2D] font-semibold' : 'text-[#5A5550]'}`} title={r.dbPct >= 70 ? 'DB is the bottleneck — optimise the query / add cache' : undefined}>
                            {r.dbPct}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {/* Errors by endpoint. 5xx red because those are server bugs
                we own; 4xx amber because they're often expected (auth,
                validation rejects). */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                  Errors by endpoint ({RANGE_LABEL[range].toLowerCase()})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {errorsBy.length === 0 ? (
                  <p className="text-xs text-[#4F7C3A]">No 4xx / 5xx errors in the last 24h. Healthy.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                        <th className="py-1.5 font-medium">Endpoint</th>
                        <th className="py-1.5 font-medium text-right">4xx</th>
                        <th className="py-1.5 font-medium text-right">5xx</th>
                        <th className="py-1.5 font-medium text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {errorsBy.map((r) => (
                        <tr key={r.route} className="border-b border-[#F5F2EE]">
                          <td className="py-1.5 font-mono text-[11px] text-[#1F1D1B] truncate max-w-[220px]" title={r.route}>{r.route}</td>
                          <td className="py-1.5 text-right text-[#9C6F1E]">{r.fourXX || ''}</td>
                          <td className={`py-1.5 text-right ${r.fiveXX > 0 ? 'text-[#9A3A2D] font-semibold' : 'text-[#8B8580]'}`}>{r.fiveXX || ''}</td>
                          <td className="py-1.5 text-right text-[#5A5550]">{r.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Hourly error spike chart. Compare with deploy timeline ("a
              spike at 14:00 + a deploy at 13:55 = the smoking gun"). */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Hourly error rate ({RANGE_LABEL[range].toLowerCase()}) — amber = 4xx, red = 5xx
              </CardTitle>
            </CardHeader>
            <CardContent>
              <HourlyErrorChart data={errorsHourly} />
              <div className="mt-1 flex justify-between text-[11px] text-[#8B8580]">
                <span>{range === "24h" ? "24h ago" : range === "7d" ? "7d ago" : range === "30d" ? "30d ago" : "90d ago"}</span>
                <span>now</span>
              </div>
            </CardContent>
          </Card>

          {/* Top 50 long tasks. trace lets the operator chase the
              specific slow request in wrangler tail. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Long tasks (top 50 slowest requests, last 24h)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {longTasks.length === 0 ? (
                <p className="text-xs text-[#4F7C3A]">No requests took 200ms+ in the last 24h.</p>
              ) : (
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-white">
                      <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                        <th className="py-1.5 font-medium">Time</th>
                        <th className="py-1.5 font-medium">Endpoint</th>
                        <th className="py-1.5 font-medium text-right">Status</th>
                        <th className="py-1.5 font-medium text-right">Dur</th>
                        <th className="py-1.5 font-medium text-right">DB</th>
                        <th className="py-1.5 font-medium">Trace</th>
                      </tr>
                    </thead>
                    <tbody>
                      {longTasks.map((r, i) => (
                        <tr key={i} className="border-b border-[#F5F2EE]">
                          <td className="py-1.5 text-[#5A5550] whitespace-nowrap">{r.timestamp.slice(5, 16)}</td>
                          <td className="py-1.5 font-mono text-[11px] text-[#1F1D1B] truncate max-w-[220px]" title={r.route}>{r.route}</td>
                          <td className={`py-1.5 text-right ${r.status.startsWith('5') ? 'text-[#9A3A2D] font-semibold' : r.status.startsWith('4') ? 'text-[#9C6F1E]' : 'text-[#4F7C3A]'}`}>{r.status}</td>
                          <td className={`py-1.5 text-right font-semibold ${r.dur >= 1000 ? 'text-[#9A3A2D]' : 'text-[#9C6F1E]'}`}>{r.dur}ms</td>
                          <td className="py-1.5 text-right text-[#5A5550]">{r.dbDur}ms</td>
                          <td className="py-1.5 font-mono text-[10px] text-[#8B8580] truncate max-w-[150px]" title={r.trace}>{r.trace ? r.trace.slice(3, 19) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
