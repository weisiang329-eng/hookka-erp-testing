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
import { useMemo } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Activity,
  AlertTriangle,
  Clock,
  Gauge,
  TrendingUp,
} from "lucide-react";

// Shape returned by GET /api/admin/health/kpis. Keep this in sync with
// src/api/routes-d1/admin-health.ts.
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

export default function AdminHealthPage() {
  const { data, loading, error } = useCachedJson<KpiPayload>(
    "/api/admin/health/kpis",
    60,
  );

  const kpis = data?.data;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[#1F1D1B]">System Health</h1>
        <p className="text-sm text-[#5A5550] mt-1">
          Aggregate request timing + error counters from Cloudflare Analytics Engine. Last 24 hours.
        </p>
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
                Hourly request volume (last 24h)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Sparkline data={kpis.sparkline} />
              <div className="mt-1 flex justify-between text-[11px] text-[#8B8580]">
                <span>24h ago</span>
                <span>now</span>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
