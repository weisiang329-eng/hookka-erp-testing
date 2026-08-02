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
import { useEffect, useMemo, useState } from "react";
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
import {
  parseBugHistory,
  topCategories,
  type BugEntry,
} from "@/lib/bug-history-parser";

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
  lastSeen?: string; // ISO — most recent error of any status on this route
  last5xxAt?: string; // ISO — most recent 5xx specifically ("" if none)
};
type HourlyErrors = { fourXX: number[]; fiveXX: number[] };
type DailyTrend = { p50: number[]; p95: number[]; errors: number[] };

// Analytics Engine returns timestamps as "YYYY-MM-DD HH:MM:SS" in UTC with no
// zone marker. new Date() would misread that as LOCAL time (off by the
// browser's offset). Normalize to ISO-UTC before parsing so "how long ago" is
// accurate — that accuracy is the whole point of the recency signal.
function parseAeTs(s?: string): number {
  if (!s) return NaN;
  let v = s.trim();
  if (!v.includes("T")) v = v.replace(" ", "T");
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(v)) v += "Z";
  return new Date(v).getTime();
}
// Relative "time ago" + a `recent` flag (within the last hour). `recent` is
// the signal that tells a LIVE problem apart from a stale one still sitting
// inside the rolling window — so an error that last fired 23h ago reads
// "23h ago" (probably already fixed) instead of looking like an active outage.
function timeAgo(iso?: string): { label: string; recent: boolean } {
  const t = parseAeTs(iso);
  if (!Number.isFinite(t)) return { label: "—", recent: false };
  const diffMs = Date.now() - t;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return { label: "just now", recent: true };
  if (min < 60) return { label: `${min}m ago`, recent: true };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { label: `${hr}h ago`, recent: false };
  return { label: `${Math.floor(hr / 24)}d ago`, recent: false };
}

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
type StatusBreakdownRow = { status: string; count: number };
type ErrorMessageRow = {
  route: string;
  status: string;
  errMsg: string;
  n: number;
  trace: string;
};
// Slow SQL row — one entry per (route, op, sqlSnippet) tuple with the
// captures rolled up. The operator reads this to answer "which exact
// query is the bottleneck" — the route panel only tells you which
// endpoint, this tells you which statement INSIDE that endpoint.
type SlowSqlRow = {
  route: string;
  op: string;
  sqlSnippet: string;
  hits: number;
  avgDur: number;
  p95: number;
  rowsRead: number;
};
// Phase-4 FE RUM payloads. Errors aggregate top-N by message + stack;
// perf aggregates per (route, metric) tuple with P50/P95.
type FeErrorRow = {
  route: string;
  msg: string;
  stack: string;
  n: number;
};
type FePerfRow = {
  route: string;
  metric: string;
  hits: number;
  p50: number;
  p95: number;
};
// 2026-06-29 additions — per-API timing + page-stuck heartbeat. These
// fill the diagnostic gap where a slow/hung endpoint silently spinners
// the page and no error / longtask / paint event surfaces.
type FeApiRow = {
  endpoint: string;
  method: string;
  status: string; // "0" = aborted/timeout
  hits: number;
  p50: number;
  p95: number;
  max: number;
  sampleRoute: string;
  sampleUserId: string;
};
type FeStuckRow = {
  route: string;
  userId: string;
  n: number;
  maxMs: number;
};
// Plain-language description per perf metric so the operator knows
// what each number means.
const FE_METRIC_HINT: Record<string, string> = {
  longtask: "UI froze (main thread blocked >=50ms)",
  lcp: "Largest paint — felt-load time",
  fcp: "First paint — initial pixels",
  ttfb: "Server response time",
  nav: "Full page load",
};
// Phase-7 audit feed — one row per business mutation (SO confirmed,
// JC status changed, user role updated, etc.). The dashboard reads
// the audit_events table directly so it shows the same data as the
// per-record AuditHistoryPanel, just org-wide.
type AuditFeedRow = {
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
type AuditFeedSummary = {
  byAction: Array<{ action: string; n: number }>;
  byResource: Array<{ resource: string; n: number }>;
};

// Security panel — surfaces auth-family rows from audit_events so the
// operator can spot brute-force / abuse patterns without leaving the
// dashboard. Same column-set as AuditFeedRow plus ipAddress. Bucket
// shapes mirror the /security-events endpoint exactly.
type SecurityEventRow = {
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
type SecurityEventsResponse = {
  success: boolean;
  data: {
    recentEvents: SecurityEventRow[];
    failedLoginsByActor: Array<{ actor: string; n: number }>;
    failedLoginsByIp: Array<{ ip: string; n: number }>;
    passwordResetsByEmail: Array<{ userId: string; n: number }>;
    summary: {
      totalLogins: number;
      totalFailures: number;
      totalResets: number;
      totalRoleChanges: number;
    };
  };
};

// Plain-language hint per status code so the operator knows WHY each
// code matters, not just the number. Sourced from the dashboard
// comments in admin-health.ts.
const STATUS_HINT: Record<string, string> = {
  "400": "Validation rejected (bad input)",
  "401": "Auth token missing/expired",
  "403": "Permission denied (RBAC)",
  "404": "URL not found — possibly FE bug",
  "409": "Conflict / version stale",
  "422": "Validation reject (schema)",
  "429": "Rate limit hit",
  "500": "Internal server error (code bug)",
  "502": "Upstream gateway down",
  "503": "Service unavailable",
  "504": "Gateway timeout (DB slow)",
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

// Section divider — visually groups related panels so the dashboard
// reads as ordered sections rather than a wall of cards. Each section
// has a single-word "what is this for" prefix and a one-line explainer
// so a SUPER_ADMIN can scan top-to-bottom and know what each block is
// answering.
// One GitHub Actions workflow run, as flattened by GET /github-runs.
type GithubRun = {
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
/** A workflow whose LATEST run failed — see GET /github-runs. */
type FailingWorkflow = {
  name: string;
  consecutive: number;
  since: string;
  url: string;
};

type GithubRunsData = {
  configured: boolean;
  repo: string;
  error?: string;
  runs: GithubRun[];
  /**
   * Computed server-side from a failures-only query, so a once-a-day job cannot
   * be crowded out of the 20-run window by a 5-minute cron. This is what makes
   * "the backup has failed 20 times in a row" visible at all.
   */
  failing?: FailingWorkflow[];
};

function SectionHeader({
  title,
  hint,
}: {
  title: string;
  hint: string;
}) {
  return (
    <div className="pt-2 pb-1 border-b border-[#E2DDD8]">
      <h2 className="text-[15px] font-semibold text-[#1F1D1B]">{title}</h2>
      <p className="text-[11px] text-[#8B8580] mt-0.5">{hint}</p>
    </div>
  );
}

// Health status banner. Computed from KPIs + counters; tells the
// operator at a glance "is the system OK right now". Three tones:
//   🟢 Healthy — nothing red, P95 < 500, no 5xx, FE errors low
//   🟡 Investigate — some 4xx OR P95 500-1500ms OR moderate FE errors
//   🔴 Critical — 5xx > 10 OR P95 > 2000ms OR many concurrent issues
type HealthTone = "green" | "amber" | "red" | "loading";
function HealthStatusCard({
  tone,
  label,
  detail,
}: {
  tone: HealthTone;
  label: string;
  detail: string;
}) {
  const toneClasses: Record<HealthTone, string> = {
    green: "border-[#B7D3A4] bg-[#F0F6EB] text-[#2F5C20]",
    amber: "border-[#E6C490] bg-[#FBF1DC] text-[#7A5410]",
    red: "border-[#E8AFA4] bg-[#FBE9E5] text-[#7E251A]",
    loading: "border-[#E2DDD8] bg-[#FAF8F5] text-[#5A5550]",
  };
  const icon = tone === "green" ? "🟢" : tone === "amber" ? "🟡" : tone === "red" ? "🔴" : "⏳";
  return (
    <div className={`rounded-md border p-3 flex items-center gap-3 ${toneClasses[tone]}`}>
      <span className="text-lg">{icon}</span>
      <div className="flex-1">
        <div className="text-sm font-semibold">{label}</div>
        {detail && <div className="text-[11px] mt-0.5 opacity-90">{detail}</div>}
      </div>
    </div>
  );
}

export default function AdminHealthPage() {
  // Active time range. Defaulting to 24h matches the historical
  // "Last 24 hours" copy + is the cheapest scan over AE.
  const [range, setRange] = useState<Range>("24h");
  const rangeQS = `?range=${range}`;
  // Dismiss state for the live-data cold-load hint (Item 4). Local to the
  // session — re-shows on a fresh page open, which is intentional since
  // the cold-load wait happens on every fresh open.
  const [coldHintDismissed, setColdHintDismissed] = useState(false);
  // Client-side filter for the Module open times panel (Item 2). Lets the
  // operator find ANY route (e.g. "employees") even when it isn't in the
  // top rows by P95.
  const [moduleFilter, setModuleFilter] = useState("");

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
  const { data: statusBreakdownResp } = useCachedJson<{
    success: boolean;
    data: StatusBreakdownRow[];
  }>(`/api/admin/health/status-breakdown${rangeQS}`, 60);
  const { data: errorMessagesResp } = useCachedJson<{
    success: boolean;
    data: ErrorMessageRow[];
  }>(`/api/admin/health/error-messages${rangeQS}`, 60);
  const { data: slowSqlResp } = useCachedJson<{
    success: boolean;
    data: SlowSqlRow[];
  }>(`/api/admin/health/slow-sql${rangeQS}`, 60);
  const { data: feErrorsResp } = useCachedJson<{
    success: boolean;
    data: FeErrorRow[];
  }>(`/api/admin/health/fe-errors${rangeQS}`, 60);
  const { data: fePerfResp } = useCachedJson<{
    success: boolean;
    data: FePerfRow[];
  }>(`/api/admin/health/fe-perf${rangeQS}`, 60);
  const { data: feApiResp } = useCachedJson<{
    success: boolean;
    data: FeApiRow[];
  }>(`/api/admin/health/fe-api${rangeQS}`, 60);
  const { data: feStuckResp } = useCachedJson<{
    success: boolean;
    data: FeStuckRow[];
  }>(`/api/admin/health/fe-stuck${rangeQS}`, 60);
  const { data: auditFeedResp } = useCachedJson<{
    success: boolean;
    data: AuditFeedRow[];
    summary: AuditFeedSummary;
  }>(`/api/admin/health/audit-feed${rangeQS}&limit=100`, 60);
  // Security panel — auth-family audit_events filtered + bucketed
  // server-side. 60s cache matches the rest of the dashboard. If the
  // endpoint throws, useCachedJson returns null and the panel just
  // renders its empty state — never crashes the page.
  const { data: securityEventsResp } = useCachedJson<SecurityEventsResponse>(
    `/api/admin/health/security-events${rangeQS}`,
    60,
  );
  // GitHub Actions / automation health. No range param — always the latest
  // ~20 runs. Polled on a 60s cache like the rest of the dashboard. When the
  // GITHUB_TOKEN secret is unset the payload is {configured:false} and the
  // panel shows a connect hint instead of data.
  const { data: githubRunsResp } = useCachedJson<{
    success: boolean;
    data: GithubRunsData;
  }>(`/api/admin/health/github-runs`, 60);

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
  // useMemo on the ?? [] fallbacks so the empty-array literal doesn't
  // change identity every render — the healthStatus / moduleOpenTimes
  // memos below depend on these arrays and would otherwise re-compute
  // on every parent render. Keeps the perf-monitoring page from being
  // a memory churn source itself.
  const statusBreakdown = useMemo(() => statusBreakdownResp?.data ?? [], [statusBreakdownResp]);
  const errorMessages = useMemo(() => errorMessagesResp?.data ?? [], [errorMessagesResp]);
  const slowSql = useMemo(() => slowSqlResp?.data ?? [], [slowSqlResp]);
  const feErrors = useMemo(() => feErrorsResp?.data ?? [], [feErrorsResp]);
  const fePerf = useMemo(() => fePerfResp?.data ?? [], [fePerfResp]);
  const feApi = useMemo(() => feApiResp?.data ?? [], [feApiResp]);
  const feStuck = useMemo(() => feStuckResp?.data ?? [], [feStuckResp]);
  // Front-End perf rows re-ordered for display (Item 3). The backend
  // already groups longtask first, but within longtask we re-sort by hit
  // count desc so the MOST FREQUENTLY frozen pages lead — "how often did
  // this page freeze" matters more than "how long the worst freeze was".
  // Non-longtask metrics keep the backend's metric-then-p95 order.
  const fePerfDisplay = useMemo(() => {
    const longtask = fePerf
      .filter((r) => r.metric === "longtask")
      .slice()
      .sort((a, b) => b.hits - a.hits || b.p95 - a.p95);
    const rest = fePerf.filter((r) => r.metric !== "longtask");
    return [...longtask, ...rest];
  }, [fePerf]);
  const auditFeed = auditFeedResp?.data ?? [];
  const auditSummary = auditFeedResp?.summary ?? { byAction: [], byResource: [] };
  // Security feed defaults — all empty arrays so the panel renders its
  // "no events" placeholder when the endpoint is fresh / unreachable.
  const securityData = securityEventsResp?.data ?? {
    recentEvents: [],
    failedLoginsByActor: [],
    failedLoginsByIp: [],
    passwordResetsByEmail: [],
    summary: { totalLogins: 0, totalFailures: 0, totalResets: 0, totalRoleChanges: 0 },
  };
  // GitHub Actions automation health. A run is "failed" when it finished
  // (status completed) with a non-success conclusion (failure/timed_out/
  // startup_failure). Cancelled runs don't count as failures. We count only
  // the latest run per workflow so a long-since-fixed failure doesn't keep
  // the panel red forever.
  const github = githubRunsResp?.data;
  const githubRuns = useMemo(() => github?.runs ?? [], [github]);
  const githubFailingWorkflows = useMemo(() => {
    const latestByWorkflow = new Map<string, GithubRun>();
    for (const r of githubRuns) {
      if (!latestByWorkflow.has(r.name)) latestByWorkflow.set(r.name, r);
    }
    const failConclusions = new Set(["failure", "timed_out", "startup_failure"]);
    return [...latestByWorkflow.values()].filter(
      (r) => r.status === "completed" && failConclusions.has(r.conclusion ?? ""),
    );
  }, [githubRuns]);

  // Past Fixes — lazy-load docs/BUG-HISTORY.md via Vite's ?raw import.
  // The markdown is ~250KB so we don't bloat the main chunk; the dynamic
  // import keeps it out of the bundle until SUPER_ADMIN actually opens
  // /admin/health. parseBugHistory drops the prose body (Symptom / Root
  // cause / Fix) and keeps only the headline + category + status, which
  // is all the dashboard panel needs.
  const [bugHistory, setBugHistory] = useState<BugEntry[]>([]);
  const [bugHistoryLoading, setBugHistoryLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    import("../../../docs/BUG-HISTORY.md?raw")
      .then((mod) => {
        if (!alive) return;
        setBugHistory(parseBugHistory(mod.default));
        setBugHistoryLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setBugHistoryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  // Top categories — derived deterministically from the parsed entries.
  // useMemo so re-renders don't recompute when only KPI data changed.
  const bugCategories = useMemo(
    () => topCategories(bugHistory, 8),
    [bugHistory],
  );
  // Recent entries — newest 20 (file is newest-first already, so just slice).
  const recentFixes = useMemo(() => bugHistory.slice(0, 20), [bugHistory]);

  // Module open times — filters fePerf for the `nav` metric (which
  // covers BOTH initial page load AND SPA route changes since the
  // patched history.pushState emits the same metric). Sorted by P95
  // descending so the slowest modules to open surface first. This is
  // the panel that directly answers "when I click into DO / SO /
  // Production etc, how long does it take" — exactly what Wei Siang
  // asked for.
  // Full nav list, sorted slowest-first. The panel shows the top 30 by
  // default (raised from 15). When the operator types a filter, we match
  // against this FULL list so a slow page that isn't in the top 30 (e.g.
  // /employees) is still findable — the whole point of Item 2.
  const moduleNavSorted = useMemo(
    () => fePerf.filter((p) => p.metric === "nav").sort((a, b) => b.p95 - a.p95),
    [fePerf],
  );
  const moduleOpenTimes = useMemo(() => {
    const q = moduleFilter.trim().toLowerCase();
    if (q) {
      // Filtered: search the entire nav set, no top-N cap, so any route
      // matching the query shows even if it's far down the P95 list.
      return moduleNavSorted.filter((p) => p.route.toLowerCase().includes(q));
    }
    return moduleNavSorted.slice(0, 30);
  }, [moduleNavSorted, moduleFilter]);

  // Auto-computed health summary — single colored banner so the
  // operator's first-glance answer is "is the system OK right now".
  // Three thresholds based on rough Hookka-scale operator expectations
  // (~40-500 req/24h, P95 typically 100-500ms when healthy).
  const healthStatus = useMemo<{
    tone: HealthTone;
    label: string;
    detail: string;
  }>(() => {
    if (!kpis) return { tone: "loading", label: "Loading…", detail: "" };
    const issues: string[] = [];
    if (kpis.p95 >= 1500) issues.push(`P95 latency ${kpis.p95}ms`);
    if (kpis.longTaskCount > 500) issues.push(`${kpis.longTaskCount} long tasks`);
    const fiveXX = statusBreakdown
      .filter((s) => s.status.startsWith("5"))
      .reduce((a, b) => a + b.count, 0);
    if (fiveXX > 0) issues.push(`${fiveXX} server errors`);
    const feErrCount = feErrors.reduce((a, b) => a + b.n, 0);
    if (feErrCount > 10) issues.push(`${feErrCount} FE errors`);
    if (issues.length === 0) {
      return {
        tone: "green",
        label: "All systems normal",
        detail: `P50 ${kpis.p50}ms · P95 ${kpis.p95}ms · Cache ${Math.round(kpis.cacheHitRatio * 100)}% · No 5xx`,
      };
    }
    // Critical thresholds — any of these alone is enough to escalate.
    const critical =
      kpis.p95 >= 2000 ||
      fiveXX > 10 ||
      feErrCount > 50 ||
      issues.length >= 3;
    return {
      tone: critical ? "red" : "amber",
      label: critical ? "Critical — investigate now" : "Investigate",
      detail: issues.join(" · "),
    };
  }, [kpis, statusBreakdown, feErrors]);

  return (
    <div className="p-6 space-y-5">
      {/* Sticky header. Range toggle + title always visible while
          scrolling — without this you had to scroll back up to switch
          ranges every time. negative-margin trick stretches the bar
          edge-to-edge inside the p-6 wrapper. */}
      <div className="sticky top-0 z-20 -mx-6 px-6 py-3 bg-[#FAF8F5]/95 backdrop-blur border-b border-[#E2DDD8] flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-[#1F1D1B]">System Health</h1>
          <p className="text-[11px] text-[#8B8580] mt-0.5">
            {RANGE_LABEL[range]} · Cloudflare AE + Postgres
          </p>
        </div>
        {/* Range toggle. All panels share this state. */}
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

      {/* Auto-computed health status — single colored banner that
          summarises P95, server errors, FE errors, and long tasks into
          one tone (green / amber / red). First thing the operator sees
          after page load. */}
      <HealthStatusCard
        tone={healthStatus.tone}
        label={healthStatus.label}
        detail={healthStatus.detail}
      />

      {kpis?._mock && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>No live data yet.</strong> The Analytics Engine binding is
          either missing or the SQL token isn't wired. The numbers below are
          deterministic mocks so the dashboard can be reviewed end-to-end.
          See <code>docs/OBSERVABILITY.md</code> for the remaining setup.
        </div>
      )}

      {/* Cold-load hint — only when live (_source === "ae"). The page
          fires ~14 analytics queries on open, each a 1-2s AE scan, and
          the browser caps parallel requests at ~6, so the first open
          feels slow. This note tells the operator that wait is expected,
          not a bug, and that repeat opens within a minute are served
          from the 60s edge cache. Dismissible so it doesn't nag. */}
      {kpis?._source === "ae" && !coldHintDismissed && (
        <div className="rounded-md border border-[#D9E3EC] bg-[#F2F6FA] p-3 text-sm text-[#33526B] flex items-start gap-3">
          <div className="flex-1">
            <strong>Live data.</strong> First load runs ~14 analytics queries
            and can take a few seconds. Repeat opens within a minute are
            cached and return instantly.
          </div>
          <button
            type="button"
            onClick={() => setColdHintDismissed(true)}
            className="shrink-0 text-[11px] text-[#5A7894] hover:text-[#33526B] underline"
          >
            Dismiss
          </button>
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
          {/* ────────── RIGHT NOW ────────── */}
          <SectionHeader
            title="Right Now"
            hint="Headline numbers for the chosen window. P95 = the slowest 5% of requests; long tasks = requests >=200ms; cache hit ratio = snapshot reads served from cache."
          />
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

          {/* ────────── SPEED ────────── */}
          <SectionHeader
            title="Speed — where it's slow"
            hint="Click into a module slow? → check Module Open Times. API slow? → check Top Endpoints + Slow SQL. UI freezing? → check Front-End perf."
          />

          {/* Module open times (SPA nav + initial loads). Filters
              fePerf for metric=nav and sorts by P95. This is the
              "when I open Sales / Production / Payroll how long does
              it take" panel — directly answers the most-asked
              operator question. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Module open times ({RANGE_LABEL[range].toLowerCase()}) — click-to-stable-frame per route
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Filter input (Item 2). Type a route fragment (e.g.
                  "employees") to surface its row even when it isn't in
                  the top 30 by P95. Empty = default top-30 view. */}
              <div className="mb-2 flex items-center gap-2">
                <input
                  type="text"
                  value={moduleFilter}
                  onChange={(e) => setModuleFilter(e.target.value)}
                  placeholder="Filter routes (e.g. employees)…"
                  className="w-full max-w-xs rounded-md border border-[#E2DDD8] bg-white px-2 py-1 text-xs text-[#1F1D1B] placeholder:text-[#B5AFA9] focus:outline-none focus:ring-1 focus:ring-[#C9C2BB]"
                />
                {moduleFilter.trim() && (
                  <button
                    type="button"
                    onClick={() => setModuleFilter("")}
                    className="text-[11px] text-[#8B8580] underline hover:text-[#5A5550]"
                  >
                    Clear
                  </button>
                )}
                <span className="text-[10px] text-[#8B8580] whitespace-nowrap">
                  {moduleFilter.trim()
                    ? `${moduleOpenTimes.length} match${moduleOpenTimes.length === 1 ? "" : "es"}`
                    : `top ${moduleOpenTimes.length} of ${moduleNavSorted.length}`}
                </span>
              </div>
              {moduleOpenTimes.length === 0 ? (
                <p className="text-xs text-[#8B8580]">
                  {moduleFilter.trim()
                    ? "No route matches that filter in this window."
                    : "No nav timing yet — RUM auto-records every initial page load + SPA route change. Give it a few visits after deploy."}
                </p>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                      <th className="py-1.5 font-medium">Route (module)</th>
                      <th className="py-1.5 font-medium text-right">Opens</th>
                      <th className="py-1.5 font-medium text-right">P50</th>
                      <th className="py-1.5 font-medium text-right">P95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {moduleOpenTimes.map((r, i) => (
                      <tr key={i} className="border-b border-[#F5F2EE]">
                        <td className="py-1.5 font-mono text-[11px] text-[#1F1D1B] truncate max-w-[280px]" title={r.route}>{r.route || '/'}</td>
                        <td className="py-1.5 text-right text-[#5A5550]">{r.hits}</td>
                        <td className="py-1.5 text-right text-[#5A5550]">{r.p50}ms</td>
                        <td className={`py-1.5 text-right font-semibold ${r.p95 >= 2500 ? 'text-[#9A3A2D]' : r.p95 >= 1000 ? 'text-[#9C6F1E]' : 'text-[#4F7C3A]'}`}>{r.p95}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
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
                  <div className="overflow-x-auto">
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
                  </div>
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
                  <>
                    <p className="text-[11px] text-[#8B8580] mb-2">
                      <span className="text-[#9A3A2D] font-medium">Live</span> = errored within the last hour (worth acting on now).
                      An old "Last seen" (hours/days ago) usually means it was already fixed — just still inside the window.
                    </p>
                    <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                          <th className="py-1.5 font-medium">Endpoint</th>
                          <th className="py-1.5 font-medium text-right">4xx</th>
                          <th className="py-1.5 font-medium text-right">5xx</th>
                          <th className="py-1.5 font-medium text-right">Total</th>
                          <th className="py-1.5 font-medium text-right">Last seen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {errorsBy.map((r) => {
                          // For the recency badge, prefer the most recent 5xx
                          // (the bugs we own); fall back to any error.
                          const seen = timeAgo(r.last5xxAt || r.lastSeen);
                          const liveServerErr = r.fiveXX > 0 && timeAgo(r.last5xxAt).recent;
                          return (
                            <tr key={r.route} className="border-b border-[#F5F2EE]">
                              <td className="py-1.5 font-mono text-[11px] text-[#1F1D1B] truncate max-w-[200px]" title={r.route}>{r.route}</td>
                              <td className="py-1.5 text-right text-[#9C6F1E]">{r.fourXX || ''}</td>
                              <td className={`py-1.5 text-right ${liveServerErr ? 'text-[#9A3A2D] font-semibold' : r.fiveXX > 0 ? 'text-[#9C6F1E]' : 'text-[#8B8580]'}`}>{r.fiveXX || ''}</td>
                              <td className="py-1.5 text-right text-[#5A5550]">{r.total}</td>
                              <td className={`py-1.5 text-right whitespace-nowrap ${seen.recent ? 'text-[#9A3A2D] font-semibold' : 'text-[#8B8580]'}`}>
                                {seen.recent ? `⚠ ${seen.label}` : seen.label}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ────────── ERRORS ────────── */}
          <SectionHeader
            title="Errors — what's failing"
            hint="Status codes tell you the family of problem; error messages tell you the exact cause. Front-End errors are what users see in the browser."
          />

          {/* Status code breakdown + recent error messages.
              Highest-ROI root-cause panels — they answer "WHY" rather
              than just "WHERE". Status code hints translate raw codes
              into plain-language explanations so the operator doesn't
              need to memorise HTTP semantics. */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                  Status code breakdown ({RANGE_LABEL[range].toLowerCase()})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {statusBreakdown.length === 0 ? (
                  <p className="text-xs text-[#4F7C3A]">No 4xx / 5xx in this window. Healthy.</p>
                ) : (
                  <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                        <th className="py-1.5 font-medium">Code</th>
                        <th className="py-1.5 font-medium">Meaning</th>
                        <th className="py-1.5 font-medium text-right">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statusBreakdown.map((r) => (
                        <tr key={r.status} className="border-b border-[#F5F2EE]">
                          <td className={`py-1.5 font-mono font-semibold ${r.status.startsWith('5') ? 'text-[#9A3A2D]' : 'text-[#9C6F1E]'}`}>{r.status}</td>
                          <td className="py-1.5 text-[#5A5550]">{STATUS_HINT[r.status] ?? '—'}</td>
                          <td className="py-1.5 text-right text-[#5A5550]">{r.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                  5xx error messages (top 20, {RANGE_LABEL[range].toLowerCase()})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {errorMessages.length === 0 ? (
                  <p className="text-xs text-[#4F7C3A]">No 5xx with captured error text. (Newly-deployed; older 5xx don't have error text stored.)</p>
                ) : (
                  <div className="overflow-y-auto max-h-72 -mx-2 px-2">
                    {errorMessages.map((r, i) => (
                      <div key={i} className="py-1.5 border-b border-[#F5F2EE] last:border-b-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[11px] text-[#1F1D1B] truncate" title={r.route}>{r.route}</span>
                          <span className="text-[10px] text-[#8B8580] shrink-0">×{r.n} · {r.status}</span>
                        </div>
                        <div className="text-[11px] text-[#9A3A2D] mt-0.5 font-mono break-all">{r.errMsg || '(no message)'}</div>
                        {r.trace && (
                          <div className="text-[10px] text-[#8B8580] mt-0.5 font-mono truncate" title={r.trace}>
                            trace: {r.trace.slice(3, 19)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
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

          {/* Slow SQL — the missing piece between "endpoint X is slow"
              and "fix it". This panel surfaces which specific SQL
              statement (within that endpoint) is the bottleneck.
              Captured by emitSlowSql() in the D1 instrumentation wrapper
              for any query >= 500ms. Aggregated by (route, op, snippet)
              so repeated slow queries collapse to one row. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Slow SQL queries ({RANGE_LABEL[range].toLowerCase()}) — captures &gt;=500ms
              </CardTitle>
            </CardHeader>
            <CardContent>
              {slowSql.length === 0 ? (
                <p className="text-xs text-[#4F7C3A]">
                  No slow queries in this window. Healthy — every DB statement returned within 500ms.
                </p>
              ) : (
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-white">
                      <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                        <th className="py-1.5 font-medium">Endpoint</th>
                        <th className="py-1.5 font-medium">Op</th>
                        <th className="py-1.5 font-medium">SQL</th>
                        <th className="py-1.5 font-medium text-right">Hits</th>
                        <th className="py-1.5 font-medium text-right">Avg</th>
                        <th className="py-1.5 font-medium text-right">P95</th>
                        <th className="py-1.5 font-medium text-right" title="Total rows read across all hits">Rows</th>
                      </tr>
                    </thead>
                    <tbody>
                      {slowSql.map((r, i) => (
                        <tr key={i} className="border-b border-[#F5F2EE] align-top">
                          <td className="py-1.5 font-mono text-[11px] text-[#1F1D1B] truncate max-w-[180px]" title={r.route}>{r.route || '—'}</td>
                          <td className="py-1.5 text-[#5A5550]">{r.op}</td>
                          <td className="py-1.5 font-mono text-[10px] text-[#5A5550] max-w-[420px]" title={r.sqlSnippet}>
                            <span className="block truncate">{r.sqlSnippet || '(no snippet)'}</span>
                          </td>
                          <td className="py-1.5 text-right text-[#5A5550]">{r.hits}</td>
                          <td className="py-1.5 text-right text-[#5A5550]">{r.avgDur}ms</td>
                          <td className={`py-1.5 text-right font-semibold ${r.p95 >= 2000 ? 'text-[#9A3A2D]' : r.p95 >= 1000 ? 'text-[#9C6F1E]' : 'text-[#5A5550]'}`}>{r.p95}ms</td>
                          <td className="py-1.5 text-right text-[#8B8580]">{r.rowsRead || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Front-End RUM panels. Captures the half of "where it
              cracks" that the backend never sees:
                • FE errors: unhandled JS errors + promise rejections
                  in the user's browser. The dashboard now sees what
                  the user sees, not just what the server logged.
                • FE perf: longtask (main-thread freezes), LCP/FCP
                  (felt page-load time), TTFB (server response from
                  the browser's perspective — includes network).
              Captured by src/lib/fe-rum.ts in every browser tab and
              posted to /api/fe-rum/event for AE ingestion. */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                  Front-End errors ({RANGE_LABEL[range].toLowerCase()}) — top 20 unhandled JS / promise rejections
                </CardTitle>
              </CardHeader>
              <CardContent>
                {feErrors.length === 0 ? (
                  <p className="text-xs text-[#4F7C3A]">
                    No FE errors in this window. Healthy — or RUM hasn't started collecting yet (give it 5 min after deploy).
                  </p>
                ) : (
                  <div className="overflow-y-auto max-h-72 -mx-2 px-2">
                    {feErrors.map((r, i) => (
                      <div key={i} className="py-1.5 border-b border-[#F5F2EE] last:border-b-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[11px] text-[#1F1D1B] truncate" title={r.route}>{r.route || '(unknown route)'}</span>
                          <span className="text-[10px] text-[#8B8580] shrink-0">×{r.n}</span>
                        </div>
                        <div className="text-[11px] text-[#9A3A2D] mt-0.5 font-mono break-all">{r.msg || '(no message)'}</div>
                        {r.stack && (
                          <div className="text-[10px] text-[#8B8580] mt-0.5 font-mono truncate" title={r.stack}>
                            {r.stack.slice(0, 100)}{r.stack.length > 100 ? '...' : ''}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                  Front-End perf ({RANGE_LABEL[range].toLowerCase()}) — longtask / LCP / FCP / TTFB / nav
                </CardTitle>
              </CardHeader>
              <CardContent>
                {fePerf.length === 0 ? (
                  <p className="text-xs text-[#8B8580]">
                    No FE perf samples yet. RUM auto-collects on every page load — give it 5 min after deploy.
                  </p>
                ) : (
                  <div className="overflow-y-auto max-h-72 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-white">
                        <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                          <th className="py-1.5 font-medium">Metric</th>
                          <th className="py-1.5 font-medium">Route</th>
                          <th className="py-1.5 font-medium text-right">Hits</th>
                          <th
                            className="py-1.5 font-medium text-right"
                            title="How often this page froze the UI (longtask samples). Higher = froze more often."
                          >
                            Freezes
                          </th>
                          <th className="py-1.5 font-medium text-right">P50</th>
                          <th className="py-1.5 font-medium text-right">P95</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fePerfDisplay.map((r, i) => (
                          <tr key={i} className="border-b border-[#F5F2EE] align-top">
                            <td className="py-1.5 text-[#5A5550]" title={FE_METRIC_HINT[r.metric] ?? ''}>
                              <div className="font-mono text-[11px] text-[#1F1D1B]">{r.metric}</div>
                              <div className="text-[10px] text-[#8B8580]">{FE_METRIC_HINT[r.metric] ?? '—'}</div>
                            </td>
                            <td className="py-1.5 font-mono text-[11px] text-[#1F1D1B] truncate max-w-[180px]" title={r.route}>{r.route}</td>
                            <td className="py-1.5 text-right text-[#5A5550]">{r.hits}</td>
                            {/* Freezes column (Item 3): for longtask rows
                                the hit count IS the freeze count. Other
                                metrics aren't freezes, so show a dash. */}
                            <td className="py-1.5 text-right">
                              {r.metric === "longtask" ? (
                                <span className={`font-semibold ${r.hits >= 100 ? "text-[#9A3A2D]" : r.hits >= 25 ? "text-[#9C6F1E]" : "text-[#5A5550]"}`}>
                                  {r.hits}
                                </span>
                              ) : (
                                <span className="text-[#B5AFA9]">—</span>
                              )}
                            </td>
                            <td className="py-1.5 text-right text-[#5A5550]">{r.p50}ms</td>
                            <td className={`py-1.5 text-right font-semibold ${r.p95 >= 2500 ? 'text-[#9A3A2D]' : r.p95 >= 1000 ? 'text-[#9C6F1E]' : 'text-[#4F7C3A]'}`}>{r.p95}ms</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 2026-06-29 — Slow / failed API calls panel. Fills the gap
              that fe-perf can't: a request that hangs forever shows up here.
              Client only emits when duration > 3s OR status != 2xx so this
              table is already filtered to actionable rows. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Slow / failed API calls ({RANGE_LABEL[range].toLowerCase()}) — duration {'>'} 3s or non-2xx
              </CardTitle>
            </CardHeader>
            <CardContent>
              {feApi.length === 0 ? (
                <p className="text-xs text-[#8B8580]">
                  No slow or failed API calls in this window. (Client emits only when {'>'} 3s or status != 2xx; status "0" = aborted / timeout / network.)
                </p>
              ) : (
                <div className="overflow-y-auto max-h-72 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-white">
                      <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                        <th className="py-1.5 font-medium">Status</th>
                        <th className="py-1.5 font-medium">Endpoint</th>
                        <th className="py-1.5 font-medium">Sample user</th>
                        <th className="py-1.5 font-medium text-right">Hits</th>
                        <th className="py-1.5 font-medium text-right">P50</th>
                        <th className="py-1.5 font-medium text-right">P95</th>
                        <th className="py-1.5 font-medium text-right">Max</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feApi.map((r, i) => {
                        const fail = r.status === "0" || r.status.startsWith("5") || r.status.startsWith("4");
                        const aborted = r.status === "0";
                        return (
                          <tr key={i} className="border-b border-[#F5F2EE] align-top">
                            <td className="py-1.5">
                              <span className={`font-mono text-[11px] font-semibold ${aborted ? "text-[#9A3A2D]" : fail ? "text-[#9C6F1E]" : "text-[#5A5550]"}`}>
                                {aborted ? "ABRT" : r.status}
                              </span>
                              <div className="text-[10px] text-[#8B8580]">{r.method}</div>
                            </td>
                            <td className="py-1.5 font-mono text-[11px] text-[#1F1D1B] truncate max-w-[280px]" title={`${r.endpoint} (route: ${r.sampleRoute})`}>{r.endpoint}</td>
                            <td className="py-1.5 font-mono text-[10px] text-[#5A5550] truncate max-w-[120px]" title={r.sampleUserId}>{r.sampleUserId || "(anon)"}</td>
                            <td className="py-1.5 text-right text-[#5A5550]">{r.hits}</td>
                            <td className="py-1.5 text-right text-[#5A5550]">{r.p50}ms</td>
                            <td className={`py-1.5 text-right font-semibold ${r.p95 >= 10000 ? "text-[#9A3A2D]" : r.p95 >= 5000 ? "text-[#9C6F1E]" : "text-[#5A5550]"}`}>{r.p95}ms</td>
                            <td className={`py-1.5 text-right font-semibold ${r.max >= 15000 ? "text-[#9A3A2D]" : "text-[#5A5550]"}`}>{r.max}ms</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 2026-06-29 — Page-stuck heartbeat. A row here = "user X
              landed on route Y and 15s later no /api/* had returned 2xx".
              This is the signal that catches the silent Dashboard-blank
              owner reported (no JS error, no longtask, no LCP — just
              spinner forever). Each row is per (route, user); n = how
              many times that user got stuck on that page. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Stuck pages ({RANGE_LABEL[range].toLowerCase()}) — shell rendered, no data within 15s
              </CardTitle>
            </CardHeader>
            <CardContent>
              {feStuck.length === 0 ? (
                <p className="text-xs text-[#8B8580]">
                  No stuck-page heartbeats in this window. A row appears when a user's route loads but no /api/* call returns within 15s.
                </p>
              ) : (
                <div className="overflow-y-auto max-h-72 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-white">
                      <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                        <th className="py-1.5 font-medium">Route</th>
                        <th className="py-1.5 font-medium">User</th>
                        <th className="py-1.5 font-medium text-right">Times stuck</th>
                        <th className="py-1.5 font-medium text-right">Worst wait</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feStuck.map((r, i) => (
                        <tr key={i} className="border-b border-[#F5F2EE]">
                          <td className="py-1.5 font-mono text-[11px] text-[#1F1D1B]">{r.route}</td>
                          <td className="py-1.5 font-mono text-[10px] text-[#5A5550] truncate max-w-[120px]">{r.userId}</td>
                          <td className={`py-1.5 text-right font-semibold ${r.n >= 5 ? "text-[#9A3A2D]" : r.n >= 2 ? "text-[#9C6F1E]" : "text-[#5A5550]"}`}>{r.n}</td>
                          <td className="py-1.5 text-right text-[#5A5550]">{(r.maxMs / 1000).toFixed(1)}s</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ────────── ACTIVITY ────────── */}
          <SectionHeader
            title="Activity — who did what"
            hint="Every business mutation (confirm / create / update / delete) plus the slowest individual requests with their trace IDs for wrangler-tail drill-down."
          />

          {/* Phase-7 audit feed. Surfaces every business mutation
              (SO confirmed, JC status updated, user role changed,
              etc.) so the operator can see at a glance "WHO did WHAT
              WHEN" without leaving the dashboard. Data comes from
              the audit_events table in Postgres — same source the
              per-record AuditHistoryPanel uses, just org-wide. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Audit feed ({RANGE_LABEL[range].toLowerCase()}) — recent business mutations
              </CardTitle>
            </CardHeader>
            <CardContent>
              {auditFeed.length === 0 ? (
                <p className="text-xs text-[#8B8580]">
                  No audit events in this window. (Audit capture runs on the top mutation paths — see audit.ts.)
                </p>
              ) : (
                <>
                  {/* Summary chips — top actions + top resources over the
                      window. Useful for "what changed lately at a glance". */}
                  <div className="flex flex-wrap gap-3 mb-3 text-[11px]">
                    {auditSummary.byAction.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[#8B8580] font-medium">Top actions:</span>
                        {auditSummary.byAction.map((s) => (
                          <span key={s.action} className="px-1.5 py-0.5 rounded bg-[#F5F2EE] text-[#5A5550] font-mono">
                            {s.action} ×{s.n}
                          </span>
                        ))}
                      </div>
                    )}
                    {auditSummary.byResource.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[#8B8580] font-medium">Top resources:</span>
                        {auditSummary.byResource.map((s) => (
                          <span key={s.resource} className="px-1.5 py-0.5 rounded bg-[#F5F2EE] text-[#5A5550] font-mono">
                            {s.resource} ×{s.n}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-white">
                        <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                          <th className="py-1.5 font-medium">When</th>
                          <th className="py-1.5 font-medium">Who</th>
                          <th className="py-1.5 font-medium">Action</th>
                          <th className="py-1.5 font-medium">Resource</th>
                          <th className="py-1.5 font-medium">ID</th>
                          <th className="py-1.5 font-medium">Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditFeed.map((r) => (
                          <tr key={r.id} className="border-b border-[#F5F2EE]">
                            <td className="py-1.5 text-[#5A5550] whitespace-nowrap">{r.ts.slice(5, 16).replace('T', ' ')}</td>
                            <td className="py-1.5 text-[#1F1D1B]">
                              <div>{r.actorUserName || '—'}</div>
                              {r.actorRole && <div className="text-[10px] text-[#8B8580]">{r.actorRole}</div>}
                            </td>
                            <td className="py-1.5 font-mono text-[11px] text-[#1F1D1B]">{r.action}</td>
                            <td className="py-1.5 font-mono text-[11px] text-[#5A5550]">{r.resource}</td>
                            <td className="py-1.5 font-mono text-[10px] text-[#8B8580] truncate max-w-[160px]" title={r.resourceId}>{r.resourceId}</td>
                            <td className="py-1.5 text-[#8B8580]">{r.source}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* ────────── SECURITY ────────── */}
          <SectionHeader
            title="Security — auth & access patterns"
            hint="Logins, failed logins, password resets, role changes. If one IP or one user has many failures, that's a sign of brute-force or account takeover attempt."
          />

          {/* Summary chips — the headline numbers at the top of the
              security block so the operator doesn't have to read three
              cards to get the gist. totalFailures is the headline; a
              zero here usually means the system is quiet. */}
          <div className="flex flex-wrap gap-3 text-[11px]">
            <span className="px-2 py-1 rounded bg-[#F5F2EE] text-[#5A5550]">
              Successful logins <span className="font-semibold text-[#1F1D1B]">{securityData.summary.totalLogins}</span>
            </span>
            <span className={`px-2 py-1 rounded ${securityData.summary.totalFailures > 0 ? 'bg-[#FBE9E5] text-[#7E251A]' : 'bg-[#F5F2EE] text-[#5A5550]'}`}>
              Failed logins <span className="font-semibold">{securityData.summary.totalFailures}</span>
            </span>
            <span className={`px-2 py-1 rounded ${securityData.summary.totalResets > 3 ? 'bg-[#FBF1DC] text-[#7A5410]' : 'bg-[#F5F2EE] text-[#5A5550]'}`}>
              Password resets <span className="font-semibold">{securityData.summary.totalResets}</span>
            </span>
            <span className="px-2 py-1 rounded bg-[#F5F2EE] text-[#5A5550]">
              Role changes <span className="font-semibold text-[#1F1D1B]">{securityData.summary.totalRoleChanges}</span>
            </span>
          </div>

          {/* Three sub-cards in a 2-col grid; the recent-events card
              spans both columns at the bottom because the table is
              wider than a single-column slot. */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Failed logins card — top 10 by IP + top 10 by actor. The
                IP table is the brute-force signal (one IP slamming many
                accounts); the actor table is the account-takeover
                signal (many IPs trying one specific account). A row
                with >=5 failures renders red. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                  Failed logins ({RANGE_LABEL[range].toLowerCase()})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-[11px] text-[#8B8580] mb-3">
                  If one IP or one user has many failures, that's a sign of brute-force.
                </p>
                {securityData.failedLoginsByIp.length === 0 && securityData.failedLoginsByActor.length === 0 ? (
                  <p className="text-xs text-[#4F7C3A]">No failed logins in this window. Healthy.</p>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <div className="text-[11px] font-medium text-[#5A5550] mb-1">By IP address</div>
                      {securityData.failedLoginsByIp.length === 0 ? (
                        <p className="text-[11px] text-[#8B8580]">—</p>
                      ) : (
                        <div className="space-y-1">
                          {securityData.failedLoginsByIp.map((r) => {
                            const alert = r.n >= 5;
                            return (
                              <div key={r.ip} className="flex items-center gap-2 text-xs">
                                <span className={`font-mono truncate flex-1 ${alert ? 'text-[#9A3A2D] font-semibold' : 'text-[#1F1D1B]'}`} title={r.ip}>
                                  {r.ip}
                                </span>
                                <span className={`w-8 text-right ${alert ? 'text-[#9A3A2D] font-semibold' : 'text-[#5A5550]'}`}>{r.n}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-[#5A5550] mb-1">By user</div>
                      {securityData.failedLoginsByActor.length === 0 ? (
                        <p className="text-[11px] text-[#8B8580]">—</p>
                      ) : (
                        <div className="space-y-1">
                          {securityData.failedLoginsByActor.map((r) => {
                            const alert = r.n >= 5;
                            return (
                              <div key={r.actor} className="flex items-center gap-2 text-xs">
                                <span className={`truncate flex-1 ${alert ? 'text-[#9A3A2D] font-semibold' : 'text-[#1F1D1B]'}`} title={r.actor}>
                                  {r.actor}
                                </span>
                                <span className={`w-8 text-right ${alert ? 'text-[#9A3A2D] font-semibold' : 'text-[#5A5550]'}`}>{r.n}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Password resets card — top 10 by user. Numbers > 3 in
                amber, > 10 in red. Amber = unusual; red = abuse. The
                "userId" key is what audit_events stores for the target
                account on a reset request (per emitAudit in auth.ts). */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                  Password resets ({RANGE_LABEL[range].toLowerCase()})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-[11px] text-[#8B8580] mb-3">
                  Many resets against one account can mean someone is poking the forgot-password flow.
                </p>
                {securityData.passwordResetsByEmail.length === 0 ? (
                  <p className="text-xs text-[#4F7C3A]">No password reset requests in this window.</p>
                ) : (
                  <div className="space-y-1">
                    {securityData.passwordResetsByEmail.map((r) => {
                      const tone =
                        r.n > 10
                          ? "text-[#9A3A2D] font-semibold"
                          : r.n > 3
                            ? "text-[#9C6F1E] font-semibold"
                            : "text-[#1F1D1B]";
                      return (
                        <div key={r.userId} className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-[11px] truncate flex-1 text-[#5A5550]" title={r.userId}>
                            {r.userId}
                          </span>
                          <span className={`w-8 text-right ${tone}`}>{r.n}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Recent security events — scrollable list of the last 50
              auth-family audit_events. Same row pattern as the Audit
              Feed card (When / Who / Action / Resource / Source)
              plus IP address so the operator can correlate a suspicious
              action with the IP of origin. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Recent security events ({RANGE_LABEL[range].toLowerCase()}) — last 50
              </CardTitle>
            </CardHeader>
            <CardContent>
              {securityData.recentEvents.length === 0 ? (
                <p className="text-xs text-[#8B8580]">
                  No security events in this window. (Logins, password changes, role changes all land here.)
                </p>
              ) : (
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-white">
                      <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                        <th className="py-1.5 font-medium">When</th>
                        <th className="py-1.5 font-medium">Who</th>
                        <th className="py-1.5 font-medium">Action</th>
                        <th className="py-1.5 font-medium">Resource</th>
                        <th className="py-1.5 font-medium">IP</th>
                        <th className="py-1.5 font-medium">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {securityData.recentEvents.map((r) => {
                        const isFail = r.action === "login.fail" || r.action === "login-failed";
                        return (
                          <tr key={r.id} className="border-b border-[#F5F2EE]">
                            <td className="py-1.5 text-[#5A5550] whitespace-nowrap">{r.ts.slice(5, 16).replace('T', ' ')}</td>
                            <td className="py-1.5 text-[#1F1D1B]">
                              <div>{r.actorUserName || r.actorUserId || '—'}</div>
                              {r.actorRole && <div className="text-[10px] text-[#8B8580]">{r.actorRole}</div>}
                            </td>
                            <td className={`py-1.5 font-mono text-[11px] ${isFail ? 'text-[#9A3A2D] font-semibold' : 'text-[#1F1D1B]'}`}>{r.action}</td>
                            <td className="py-1.5 font-mono text-[11px] text-[#5A5550]">{r.resource}</td>
                            <td className="py-1.5 font-mono text-[10px] text-[#8B8580] truncate max-w-[140px]" title={r.ipAddress ?? ''}>{r.ipAddress || '—'}</td>
                            <td className="py-1.5 text-[#8B8580]">{r.source}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ────────── AUTOMATION (CI) ────────── */}
          <SectionHeader
            title="Automation — GitHub Actions"
            hint="Build, deploy, and baseline workflows. Failures show up here instead of emailing you on every run. Latest ~20 runs, refreshed every 60s."
          />

          {/* A workflow that has failed MANY times running is a different
              problem from one that failed this morning, and the 20-run list
              cannot show it: the noisy 5-minute crons push a daily job's
              failure out of the window within minutes. That is exactly how the
              daily Postgres backup failed 20 times — every run in its visible
              history — while the panel looked fine. */}
          {(github?.failing?.length ?? 0) > 0 && (
            <div className="mb-3 rounded-md border border-[#E8AFA4] bg-[#FBE9E5] p-3 text-[12px] text-[#7E251A]">
              <div className="mb-1 font-semibold">
                {github!.failing!.length} workflow
                {github!.failing!.length === 1 ? "" : "s"} currently failing
              </div>
              <ul className="space-y-0.5">
                {github!.failing!.map((w) => (
                  <li key={w.name}>
                    <a
                      href={w.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline"
                    >
                      {w.name}
                    </a>
                    {" — "}
                    {w.consecutive} consecutive failure
                    {w.consecutive === 1 ? "" : "s"}
                    {w.since ? `, oldest seen ${w.since.slice(0, 10)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                Recent automation runs
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!github ? (
                <p className="text-xs text-[#8B8580] animate-pulse">Loading automation status…</p>
              ) : !github.configured ? (
                <div className="rounded-md border border-[#E6C490] bg-[#FBF1DC] text-[#7A5410] p-3 text-[12px] leading-relaxed">
                  <div className="font-semibold mb-1">Not connected yet</div>
                  Add a read-only GitHub token to show CI failures here. In Cloudflare
                  Pages → Settings → Environment variables, add a secret named{" "}
                  <span className="font-mono">GITHUB_TOKEN</span> (a fine-grained token
                  with <span className="font-mono">Actions: read-only</span> on{" "}
                  <span className="font-mono">{github.repo}</span>), then redeploy.
                </div>
              ) : github.error ? (
                <div className="rounded-md border border-[#E8AFA4] bg-[#FBE9E5] text-[#7E251A] p-3 text-[12px]">
                  Couldn’t reach GitHub: <span className="font-mono">{github.error}</span>.
                  Check the <span className="font-mono">GITHUB_TOKEN</span> secret has{" "}
                  <span className="font-mono">Actions: read</span> on{" "}
                  <span className="font-mono">{github.repo}</span>.
                </div>
              ) : githubRuns.length === 0 ? (
                <p className="text-xs text-[#8B8580]">No workflow runs found for {github.repo}.</p>
              ) : (
                <>
                  {githubFailingWorkflows.length > 0 ? (
                    <div className="rounded-md border border-[#E8AFA4] bg-[#FBE9E5] text-[#7E251A] p-2.5 text-[12px] font-semibold mb-3">
                      ⚠ {githubFailingWorkflows.length} automation
                      {githubFailingWorkflows.length > 1 ? "s are" : " is"} currently failing:{" "}
                      {githubFailingWorkflows.map((r) => r.name).join(", ")}
                    </div>
                  ) : (
                    <div className="rounded-md border border-[#B7D3A4] bg-[#F0F6EB] text-[#2F5C20] p-2.5 text-[12px] font-semibold mb-3">
                      ✓ All automations passing on their latest run
                    </div>
                  )}
                  <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-white">
                        <tr className="text-left text-[#8B8580] border-b border-[#E2DDD8]">
                          <th className="py-1.5 font-medium">Workflow</th>
                          <th className="py-1.5 font-medium">Branch</th>
                          <th className="py-1.5 font-medium">Result</th>
                          <th className="py-1.5 font-medium">When</th>
                          <th className="py-1.5 font-medium">Link</th>
                        </tr>
                      </thead>
                      <tbody>
                        {githubRuns.map((r) => {
                          const running = r.status !== "completed";
                          const failed =
                            r.status === "completed" &&
                            ["failure", "timed_out", "startup_failure"].includes(
                              r.conclusion ?? "",
                            );
                          const cancelled = r.conclusion === "cancelled";
                          const icon = running ? "⏳" : failed ? "✗" : cancelled ? "⊘" : "✓";
                          const resultClass = failed
                            ? "text-[#9A3A2D] font-semibold"
                            : running
                              ? "text-[#9C6F1E]"
                              : cancelled
                                ? "text-[#8B8580]"
                                : "text-[#4F7C3A]";
                          const resultLabel = running
                            ? r.status.replace("_", " ")
                            : (r.conclusion ?? "—").replace("_", " ");
                          return (
                            <tr key={r.id} className="border-b border-[#F5F2EE]">
                              <td className="py-1.5 text-[#1F1D1B] truncate max-w-[200px]" title={r.title || r.name}>
                                {r.name}
                              </td>
                              <td className="py-1.5 font-mono text-[11px] text-[#5A5550] truncate max-w-[120px]" title={r.branch}>
                                {r.branch || "—"}
                              </td>
                              <td className={`py-1.5 ${resultClass}`}>
                                {icon} {resultLabel}
                              </td>
                              <td className="py-1.5 text-[#5A5550] whitespace-nowrap">
                                {r.at ? r.at.slice(0, 16).replace("T", " ") : "—"}
                              </td>
                              <td className="py-1.5">
                                {r.url ? (
                                  <a
                                    className="underline text-[#8B7A52] hover:text-[#1F1D1B]"
                                    href={r.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    View
                                  </a>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* ────────── HISTORY ────────── */}
          <SectionHeader
            title="History — what we've fixed"
            hint="docs/BUG-HISTORY.md surfaced live. Modules with high bug counts are pattern signals — fix the structure, not the next instance."
          />

          {/* Past Fixes — surfaces docs/BUG-HISTORY.md on the dashboard
              so the operator sees pattern alongside current issues.
              Two sub-panels:
                1. Top modules with bug counts — "sales-orders 23
                   fixes" is the signal to rewrite that module, not
                   keep patching.
                2. Recent 20 fixes list — quick scan of "what did we
                   fix lately" + jump to the full entry via GitHub
                   anchor link.
              Lazy-loaded so the markdown payload only hits
              /admin/health sessions, not the main bundle. */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                  Past fixes — top modules by bug count
                </CardTitle>
              </CardHeader>
              <CardContent>
                {bugHistoryLoading ? (
                  <p className="text-xs text-[#8B8580] animate-pulse">Loading bug history...</p>
                ) : bugCategories.length === 0 ? (
                  <p className="text-xs text-[#8B8580]">No bug history entries found.</p>
                ) : (
                  <>
                    <p className="text-[11px] text-[#8B8580] mb-2">
                      High count = pattern. Modules with 10+ entries should be considered for a rewrite, not another patch.
                    </p>
                    <div className="space-y-1">
                      {bugCategories.map((c) => {
                        const max = bugCategories[0]?.n || 1;
                        const pct = (c.n / max) * 100;
                        const isHotSpot = c.n >= 10;
                        return (
                          <div key={c.category} className="flex items-center gap-2 text-xs">
                            <span className={`font-mono truncate w-32 shrink-0 ${isHotSpot ? 'text-[#9A3A2D] font-semibold' : 'text-[#1F1D1B]'}`} title={c.category}>{c.category}</span>
                            <div className="flex-1 bg-[#F5F2EE] rounded-sm h-4 overflow-hidden">
                              <div
                                className={`h-full ${isHotSpot ? 'bg-[#9A3A2D]' : c.n >= 5 ? 'bg-[#9C6F1E]' : 'bg-[#8B7A52]'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className={`w-10 text-right ${isHotSpot ? 'text-[#9A3A2D] font-semibold' : 'text-[#5A5550]'}`}>{c.n}</span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-[#8B8580] mt-3">
                      Total entries: {bugHistory.length}. Source: <a className="underline" href="https://github.com/weisiang329-eng/hookka-erp-testing/blob/main/docs/BUG-HISTORY.md" target="_blank" rel="noopener noreferrer">docs/BUG-HISTORY.md</a>
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-[#1F1D1B]">
                  Recent fixes (newest 20)
                </CardTitle>
              </CardHeader>
              <CardContent>
                {bugHistoryLoading ? (
                  <p className="text-xs text-[#8B8580] animate-pulse">Loading...</p>
                ) : recentFixes.length === 0 ? (
                  <p className="text-xs text-[#8B8580]">No bug history entries found.</p>
                ) : (
                  <div className="overflow-y-auto max-h-80 -mx-2 px-2">
                    {recentFixes.map((b) => (
                      <a
                        key={b.id}
                        href={`https://github.com/weisiang329-eng/hookka-erp-testing/blob/main/docs/BUG-HISTORY.md#${b.id.toLowerCase()}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block py-1.5 border-b border-[#F5F2EE] last:border-b-0 hover:bg-[#FAF8F5] -mx-2 px-2"
                      >
                        <div className="flex items-baseline gap-1.5 text-[11px]">
                          <span>{b.statusIcon}</span>
                          <span className="font-mono text-[#1F1D1B]">{b.id}</span>
                          {b.statusDate && <span className="text-[#8B8580]">{b.statusDate}</span>}
                          <span className="ml-auto px-1 rounded bg-[#F5F2EE] text-[10px] text-[#5A5550] shrink-0">{b.category}</span>
                        </div>
                        <div className="text-[11px] text-[#1F1D1B] mt-0.5 line-clamp-2">{b.title}</div>
                      </a>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

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
