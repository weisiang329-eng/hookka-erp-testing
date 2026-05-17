// ===========================================================================
// Dashboard B — an experimental premium "command-center" view.
//
// Parallel to /dashboard. Same data (/api/dashboard/overview + sales stats),
// presented as a dark, elevated fintech/observability-style board: bento
// grid, gradient area chart, SVG radial gauges, ranked tracks, scoped
// typography + texture. Self-contained & disposable — delete this folder,
// its route, and the sidebar entry to remove it. No shared code touched.
// ===========================================================================
import { useMemo, useState } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ---------- types (subset of /api/dashboard/overview) ----------
type JobsBreakdown = {
  bedframeUnits: number;
  sofaSets: number;
};
type Overview = {
  salesThisMonthSen?: number;
  deliveredThisMonthSen?: number;
  production?: {
    dailyCapacityMin: number;
    backlogMin: number;
    backlogDays: number;
    activeJobs: JobsBreakdown;
    completedYesterday: JobsBreakdown;
    completedLast7: { date: string; bedframeUnits: number; sofaSets: number }[];
    backlogByDept: {
      dept: string;
      sofaMin: number;
      bedframeMin: number;
      totalMin: number;
      dailyCapMin: number;
      backlogDays: number;
    }[];
  };
  purchasing?: {
    openPOCount: number;
    spendThisMonthSen: number;
    outstandingPOValueSen: number;
    topSuppliers: { name: string; spendSen: number }[];
  };
  fabricCostPerMeterSen?: {
    total: number;
    exclBedframeSofa: number;
    bedframe: number;
    sofa: number;
  };
  aovCompany?: {
    bedframeAvgSen: number;
    bedframeUnits: number;
    sofaAvgSen: number;
    sofaSets: number;
    totalSen: number;
  };
  aovByCustomer?: {
    customerName: string;
    bedframeAvgSen: number;
    bedframeUnits: number;
    sofaAvgSen: number;
    sofaSets: number;
    totalSen: number;
  }[];
  topSellers?: {
    BEDFRAME: { productCode: string; qtySold: number; valueSen: number }[];
    SOFA: { model: string; setsSold: number; valueSen: number }[];
  };
  monthlyRevenue?: {
    month: string;
    salesOrderSen: number;
    invoiceSen: number;
    productionSen: number;
  }[];
  employee?: { activeHeadcount: number; byDept: { dept: string; count: number }[] };
};
type SoStats = {
  csRevenueSen?: number;
  deliveredItemsSen?: number;
  outstandingItemsSen?: number;
  total?: number;
};

// ---------- helpers ----------
const rm = (sen: number | undefined) => formatCurrency(sen ?? 0);
const rmK = (sen: number | undefined) => {
  const v = (sen ?? 0) / 100;
  if (Math.abs(v) >= 1_000_000) return `RM ${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `RM ${(v / 1_000).toFixed(1)}k`;
  return `RM ${v.toFixed(0)}`;
};
const hrs = (min: number | undefined) =>
  `${Math.round((min ?? 0) / 60).toLocaleString()}h`;

// Tiny SVG sparkline (bespoke, not a chart-lib default).
function Spark({ data, stroke }: { data: number[]; stroke: string }) {
  if (!data.length) return null;
  const w = 96;
  const h = 30;
  const max = Math.max(1, ...data);
  const min = Math.min(0, ...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / Math.max(1, data.length - 1)) * w;
    const y = h - ((v - min) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={w} height={h} className="db-spark" aria-hidden>
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={pts[pts.length - 1].split(",")[0]}
        cy={pts[pts.length - 1].split(",")[1]}
        r="2.4"
        fill={stroke}
      />
    </svg>
  );
}

// Radial gauge — SVG arc, 0..1 fill.
function Gauge({
  value,
  label,
  caption,
  tone = "gold",
}: {
  value: number;
  label: string;
  caption: string;
  tone?: "gold" | "green" | "red";
}) {
  const pct = Math.max(0, Math.min(1, value));
  const r = 52;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75; // 270° dial
  const col =
    tone === "green"
      ? "var(--db-green)"
      : tone === "red"
        ? "var(--db-red)"
        : "var(--db-gold)";
  return (
    <div className="db-gauge">
      <svg width="148" height="148" viewBox="0 0 148 148">
        <circle
          cx="74"
          cy="74"
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="9"
          strokeDasharray={`${arc} ${c}`}
          strokeLinecap="round"
          transform="rotate(135 74 74)"
        />
        <circle
          cx="74"
          cy="74"
          r={r}
          fill="none"
          stroke={col}
          strokeWidth="9"
          strokeDasharray={`${arc * pct} ${c}`}
          strokeLinecap="round"
          transform="rotate(135 74 74)"
          style={{ filter: `drop-shadow(0 0 6px ${col})` }}
        />
      </svg>
      <div className="db-gauge-c">
        <span className="db-gauge-v">{label}</span>
        <span className="db-gauge-cap">{caption}</span>
      </div>
    </div>
  );
}

type RevTipProps = {
  active?: boolean;
  label?: string | number;
  payload?: { name?: string; value?: number | string; color?: string }[];
};
function RevTooltip({ active, payload, label }: RevTipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="db-tip">
      <div className="db-tip-h">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="db-tip-row">
          <span style={{ color: p.color }}>● {p.name}</span>
          <span>{rmK(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- page ----------
export default function DashboardBPage() {
  const [period, setPeriod] = useState("all");
  const { data: ovRaw, loading: ovL } = useCachedJson<Overview>(
    `/api/dashboard/overview?period=${period}`,
  );
  const { data: soRaw, loading: soL } =
    useCachedJson<SoStats>("/api/sales-orders/stats");
  const ov = ovRaw ?? {};
  const so = soRaw ?? {};
  const prod = ov.production;
  const loading = ovL || soL;

  const rev = useMemo(() => ov.monthlyRevenue ?? [], [ov.monthlyRevenue]);
  const revChart = useMemo(
    () =>
      rev.map((r) => ({
        m: r.month.slice(2),
        SO: Math.round(r.salesOrderSen / 100),
        Invoice: Math.round(r.invoiceSen / 100),
        Production: Math.round(r.productionSen / 100),
      })),
    [rev],
  );
  const soSpark = useMemo(() => rev.map((r) => r.salesOrderSen), [rev]);
  const prodSpark = useMemo(() => rev.map((r) => r.productionSen), [rev]);

  // Pipeline funnel (item-level reconciled figures from sales stats).
  const delivered = so.deliveredItemsSen ?? 0;
  const outstanding = so.outstandingItemsSen ?? 0;
  const confirmed = so.csRevenueSen ?? delivered + outstanding;
  const pipeMax = Math.max(1, confirmed, delivered, outstanding);

  // Capacity utilisation = how hard the backlog presses one day's capacity.
  const dailyCap = prod?.dailyCapacityMin ?? 0;
  const backlogDays = prod?.backlogDays ?? 0;
  const utilisation = Math.min(1, backlogDays / 14); // 14d queue = "full"

  const topBed = ov.topSellers?.BEDFRAME ?? [];
  const topSofa = ov.topSellers?.SOFA ?? [];
  const aov = (ov.aovByCustomer ?? []).slice(0, 6);
  const aovMax = Math.max(1, ...aov.map((a) => a.totalSen));

  if (loading) {
    return (
      <div className="db-root db-loading">
        <div className="db-orbit" />
        <p>Synthesising telemetry…</p>
        <style>{DB_CSS}</style>
      </div>
    );
  }

  const fc = ov.fabricCostPerMeterSen;
  const monthsAvail = (
    (ovRaw as { salesMonths?: string[] } | null)?.salesMonths ?? []
  ) as string[];

  return (
    <div className="db-root">
      <style>{DB_CSS}</style>

      {/* ── Masthead ─────────────────────────────────────────── */}
      <header className="db-mast db-rise" style={{ animationDelay: "0ms" }}>
        <div>
          <div className="db-eyebrow">HOOKKA · OPERATIONS INTELLIGENCE</div>
          <h1 className="db-title">Command Center</h1>
        </div>
        <div className="db-mast-right">
          <select
            className="db-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            <option value="all">All-time</option>
            {monthsAvail.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <div className="db-live">
            <span className="db-dot" /> LIVE
          </div>
        </div>
      </header>

      {/* ── KPI rail ─────────────────────────────────────────── */}
      <section className="db-rail">
        {[
          {
            k: "This-Month Sales",
            v: rmK(ov.salesThisMonthSen),
            sub: "confirmed SO · current month",
            spark: soSpark,
            tone: "var(--db-gold)",
            d: 40,
          },
          {
            k: "This-Month Delivered",
            v: rmK(ov.deliveredThisMonthSen),
            sub: "item-level shipped value",
            spark: prodSpark,
            tone: "var(--db-blue)",
            d: 90,
          },
          {
            k: "Outstanding",
            v: rmK(outstanding),
            sub: "confirmed · not yet delivered",
            spark: [],
            tone: "var(--db-amber)",
            d: 140,
          },
          {
            k: "Active Jobs",
            v: `${(prod?.activeJobs?.bedframeUnits ?? 0).toLocaleString()} / ${(prod?.activeJobs?.sofaSets ?? 0).toLocaleString()}`,
            sub: "bedframe units · sofa sets",
            spark: [],
            tone: "var(--db-green)",
            d: 190,
          },
          {
            k: "Backlog",
            v: `${backlogDays.toLocaleString()}d`,
            sub: `${hrs(prod?.backlogMin)} queued`,
            spark: [],
            tone: "var(--db-red)",
            d: 240,
          },
        ].map((t) => (
          <article
            key={t.k}
            className="db-kpi db-rise"
            style={{ animationDelay: `${t.d}ms` }}
          >
            <div className="db-kpi-top">
              <span className="db-kpi-k">{t.k}</span>
              {t.spark.length > 1 && (
                <Spark data={t.spark} stroke={t.tone} />
              )}
            </div>
            <div
              className="db-kpi-v"
              style={{ ["--g" as string]: t.tone }}
            >
              {t.v}
            </div>
            <div className="db-kpi-sub">{t.sub}</div>
            <span className="db-kpi-bar" style={{ background: t.tone }} />
          </article>
        ))}
      </section>

      {/* ── Bento grid ───────────────────────────────────────── */}
      <section className="db-bento">
        {/* Revenue hero */}
        <div
          className="db-card db-rise db-col-7 db-row-2"
          style={{ animationDelay: "300ms" }}
        >
          <div className="db-card-h">
            <div>
              <h3>Revenue Telemetry</h3>
              <p>Sales Orders · Invoices · Production — last 12 mo</p>
            </div>
            <div className="db-legend">
              <span style={{ color: "var(--db-gold)" }}>● SO</span>
              <span style={{ color: "var(--db-blue)" }}>● Invoice</span>
              <span style={{ color: "var(--db-green)" }}>● Production</span>
            </div>
          </div>
          <div className="db-chart">
            {revChart.length === 0 ? (
              <div className="db-empty">No revenue series.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={revChart}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient id="gSO" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#D8B25A" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#D8B25A" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gPr" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#4ADE80" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#4ADE80" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="m"
                    tick={{ fill: "#7C8186", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                    tick={{ fill: "#7C8186", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={38}
                  />
                  <Tooltip
                    content={<RevTooltip />}
                    cursor={{ stroke: "rgba(255,255,255,0.12)" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="SO"
                    stroke="#D8B25A"
                    strokeWidth={2}
                    fill="url(#gSO)"
                    isAnimationActive={false}
                    dot={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="Production"
                    stroke="#4ADE80"
                    strokeWidth={2}
                    fill="url(#gPr)"
                    isAnimationActive={false}
                    dot={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="Invoice"
                    stroke="#5EB0EF"
                    strokeWidth={2}
                    fill="none"
                    strokeDasharray="4 3"
                    isAnimationActive={false}
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Capacity gauge */}
        <div
          className="db-card db-rise db-col-5 db-center"
          style={{ animationDelay: "350ms" }}
        >
          <div className="db-card-h">
            <div>
              <h3>Plant Load</h3>
              <p>backlog pressure vs daily capacity</p>
            </div>
          </div>
          <Gauge
            value={utilisation}
            label={`${backlogDays.toLocaleString()}d`}
            caption="queue"
            tone={
              backlogDays > 12 ? "red" : backlogDays > 7 ? "gold" : "green"
            }
          />
          <div className="db-gauge-foot">
            <div>
              <span className="db-mini-k">Daily capacity</span>
              <span className="db-mini-v">{hrs(dailyCap)}</span>
            </div>
            <div>
              <span className="db-mini-k">Completed (yest.)</span>
              <span className="db-mini-v">
                {(prod?.completedYesterday?.bedframeUnits ?? 0) +
                  (prod?.completedYesterday?.sofaSets ?? 0)}
              </span>
            </div>
          </div>
        </div>

        {/* Pipeline funnel */}
        <div
          className="db-card db-rise db-col-5"
          style={{ animationDelay: "400ms" }}
        >
          <div className="db-card-h">
            <div>
              <h3>Order Pipeline</h3>
              <p>confirmed → outstanding → delivered</p>
            </div>
          </div>
          <div className="db-funnel">
            {[
              { k: "Confirmed", v: confirmed, c: "var(--db-gold)" },
              { k: "Outstanding", v: outstanding, c: "var(--db-amber)" },
              { k: "Delivered", v: delivered, c: "var(--db-green)" },
            ].map((s) => (
              <div key={s.k} className="db-frow">
                <span className="db-fk">{s.k}</span>
                <div className="db-ftrack">
                  <div
                    className="db-ffill"
                    style={{
                      width: `${Math.max(3, (s.v / pipeMax) * 100)}%`,
                      background: s.c,
                    }}
                  />
                </div>
                <span className="db-fv">{rmK(s.v)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Top sellers — bedframe */}
        <div
          className="db-card db-rise db-col-7"
          style={{ animationDelay: "450ms" }}
        >
          <div className="db-card-h">
            <div>
              <h3>Top Sellers</h3>
              <p>bedframe by units · sofa by sets</p>
            </div>
          </div>
          <div className="db-split">
            <div>
              <div className="db-split-k">BEDFRAME</div>
              {topBed.slice(0, 5).map((p) => {
                const mx = Math.max(1, ...topBed.map((x) => x.qtySold));
                return (
                  <div key={p.productCode} className="db-lrow">
                    <span className="db-lcode">{p.productCode}</span>
                    <div className="db-ltrack">
                      <div
                        className="db-lfill"
                        style={{
                          width: `${(p.qtySold / mx) * 100}%`,
                          background: "var(--db-gold)",
                        }}
                      />
                    </div>
                    <span className="db-lqty">×{p.qtySold}</span>
                  </div>
                );
              })}
            </div>
            <div>
              <div className="db-split-k">SOFA</div>
              {topSofa.slice(0, 5).map((p) => {
                const mx = Math.max(1, ...topSofa.map((x) => x.setsSold));
                return (
                  <div key={p.model} className="db-lrow">
                    <span className="db-lcode">{p.model}</span>
                    <div className="db-ltrack">
                      <div
                        className="db-lfill"
                        style={{
                          width: `${(p.setsSold / mx) * 100}%`,
                          background: "var(--db-blue)",
                        }}
                      />
                    </div>
                    <span className="db-lqty">×{p.setsSold}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* AOV leaderboard */}
        <div
          className="db-card db-rise db-col-7"
          style={{ animationDelay: "500ms" }}
        >
          <div className="db-card-h">
            <div>
              <h3>Customer Value</h3>
              <p>total value · bedframe &amp; sofa AOV</p>
            </div>
            {ov.aovCompany && (
              <div className="db-legend">
                <span>BF {rm(ov.aovCompany.bedframeAvgSen)}/u</span>
                <span>SF {rm(ov.aovCompany.sofaAvgSen)}/set</span>
              </div>
            )}
          </div>
          <div className="db-aov">
            {aov.map((a, i) => (
              <div key={a.customerName} className="db-arow">
                <span className="db-arank">{String(i + 1).padStart(2, "0")}</span>
                <span className="db-aname">{a.customerName}</span>
                <div className="db-atrack">
                  <div
                    className="db-afill"
                    style={{ width: `${(a.totalSen / aovMax) * 100}%` }}
                  />
                </div>
                <span className="db-aval">{rmK(a.totalSen)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Fabric cost */}
        <div
          className="db-card db-rise db-col-5"
          style={{ animationDelay: "550ms" }}
        >
          <div className="db-card-h">
            <div>
              <h3>Fabric Economics</h3>
              <p>weighted cost / meter</p>
            </div>
          </div>
          <div className="db-fab">
            {[
              { k: "Bedframe", v: fc?.bedframe, c: "var(--db-gold)" },
              { k: "Sofa", v: fc?.sofa, c: "var(--db-blue)" },
              { k: "Overall", v: fc?.total, c: "var(--db-green)" },
            ].map((f) => (
              <div key={f.k} className="db-fabcell">
                <span className="db-fabk">{f.k}</span>
                <span className="db-fabv" style={{ color: f.c }}>
                  {rm(f.v)}
                </span>
                <span className="db-fabu">/ meter</span>
              </div>
            ))}
          </div>
        </div>

        {/* Backlog by department */}
        <div
          className="db-card db-rise db-col-12"
          style={{ animationDelay: "600ms" }}
        >
          <div className="db-card-h">
            <div>
              <h3>Department Backlog</h3>
              <p>active work vs daily capacity — bottleneck first</p>
            </div>
          </div>
          <div className="db-dept">
            {(prod?.backlogByDept ?? []).map((d) => {
              const mx = Math.max(
                1,
                ...(prod?.backlogByDept ?? []).map((x) => x.totalMin),
              );
              const sofaPct = (d.sofaMin / mx) * 100;
              const bfPct = (d.bedframeMin / mx) * 100;
              return (
                <div key={d.dept} className="db-drow">
                  <span className="db-dname">{d.dept}</span>
                  <div className="db-dtrack">
                    <div
                      className="db-dseg"
                      style={{
                        width: `${sofaPct}%`,
                        background: "var(--db-blue)",
                      }}
                    />
                    <div
                      className="db-dseg"
                      style={{
                        width: `${bfPct}%`,
                        background: "var(--db-gold)",
                      }}
                    />
                  </div>
                  <span className="db-ddays">
                    {d.backlogDays.toLocaleString()}d
                  </span>
                </div>
              );
            })}
          </div>
          <div className="db-legend db-dept-legend">
            <span style={{ color: "var(--db-blue)" }}>● Sofa</span>
            <span style={{ color: "var(--db-gold)" }}>● Bedframe</span>
          </div>
        </div>
      </section>

      <footer className="db-foot">
        Dashboard B · experimental view · data parity with /dashboard
      </footer>
    </div>
  );
}

// ---------- scoped styles (everything under .db-root) ----------
const DB_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
.db-root{
  --db-bg:#090B0C; --db-panel:#111417; --db-panel2:#161A1E;
  --db-line:rgba(255,255,255,0.07); --db-text:#EAE8E3; --db-dim:#878C90;
  --db-gold:#D8B25A; --db-amber:#E8964A; --db-green:#56D98A;
  --db-red:#F2706B; --db-blue:#63ABEE;
  position:relative; min-height:100vh; margin:-1.5rem; padding:2rem 2.25rem 3rem;
  background:
    radial-gradient(900px 500px at 78% -8%, rgba(216,178,90,0.10), transparent 60%),
    radial-gradient(800px 600px at 0% 100%, rgba(99,171,238,0.07), transparent 55%),
    var(--db-bg);
  color:var(--db-text);
  font-family:'Hanken Grotesk',ui-sans-serif,system-ui,sans-serif;
  overflow:hidden;
}
.db-root::before{
  content:""; position:absolute; inset:0; pointer-events:none; opacity:.5;
  background-image:linear-gradient(rgba(255,255,255,0.025) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,0.025) 1px,transparent 1px);
  background-size:46px 46px;
  -webkit-mask-image:radial-gradient(circle at 50% 30%,#000 0%,transparent 75%);
  mask-image:radial-gradient(circle at 50% 30%,#000 0%,transparent 75%);
}
.db-root>*{position:relative;z-index:1}
.db-root *{box-sizing:border-box}

@keyframes dbRise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.db-rise{opacity:0;animation:dbRise .6s cubic-bezier(.2,.7,.2,1) forwards}
@keyframes dbOrbit{to{transform:rotate(360deg)}}
@keyframes dbPulse{0%,100%{opacity:1}50%{opacity:.35}}

.db-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;font-family:'IBM Plex Mono',monospace;color:var(--db-dim);letter-spacing:.08em;font-size:.8rem}
.db-orbit{width:46px;height:46px;border-radius:50%;border:2px solid rgba(255,255,255,0.08);border-top-color:var(--db-gold);animation:dbOrbit 1s linear infinite}

.db-mast{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:1.75rem}
.db-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:.66rem;letter-spacing:.32em;color:var(--db-gold);margin-bottom:.5rem}
.db-title{font-size:2.1rem;font-weight:800;letter-spacing:-.02em;line-height:1;margin:0;
  background:linear-gradient(180deg,#fff,#B9BDC0);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.db-mast-right{display:flex;align-items:center;gap:1rem}
.db-period{background:var(--db-panel);border:1px solid var(--db-line);color:var(--db-text);
  font-family:'IBM Plex Mono',monospace;font-size:.74rem;padding:.45rem .7rem;border-radius:9px;outline:none}
.db-live{display:flex;align-items:center;gap:.45rem;font-family:'IBM Plex Mono',monospace;
  font-size:.66rem;letter-spacing:.2em;color:var(--db-green)}
.db-dot{width:7px;height:7px;border-radius:50%;background:var(--db-green);
  box-shadow:0 0 8px var(--db-green);animation:dbPulse 1.8s ease-in-out infinite}

.db-rail{display:grid;grid-template-columns:repeat(5,1fr);gap:1rem;margin-bottom:1rem}
@media(max-width:1100px){.db-rail{grid-template-columns:repeat(2,1fr)}}
.db-kpi{position:relative;background:linear-gradient(180deg,var(--db-panel2),var(--db-panel));
  border:1px solid var(--db-line);border-radius:16px;padding:1.05rem 1.15rem 1.2rem;overflow:hidden;
  transition:transform .25s,border-color .25s}
.db-kpi:hover{transform:translateY(-3px);border-color:rgba(216,178,90,0.35)}
.db-kpi-top{display:flex;justify-content:space-between;align-items:flex-start;min-height:30px}
.db-kpi-k{font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:var(--db-dim)}
.db-spark{opacity:.9}
.db-kpi-v{font-family:'IBM Plex Mono',monospace;font-size:1.7rem;font-weight:600;margin:.55rem 0 .2rem;
  letter-spacing:-.01em;color:var(--db-text);text-shadow:0 0 18px color-mix(in srgb,var(--g) 35%,transparent)}
.db-kpi-sub{font-size:.7rem;color:var(--db-dim)}
.db-kpi-bar{position:absolute;left:0;bottom:0;height:2px;width:100%;opacity:.55}

.db-bento{display:grid;grid-template-columns:repeat(12,1fr);grid-auto-rows:minmax(132px,auto);gap:1rem}
@media(max-width:1100px){.db-bento{grid-template-columns:repeat(6,1fr)}}
.db-card{background:linear-gradient(180deg,var(--db-panel2),var(--db-panel));
  border:1px solid var(--db-line);border-radius:18px;padding:1.15rem 1.25rem;
  display:flex;flex-direction:column;transition:border-color .25s}
.db-card:hover{border-color:rgba(255,255,255,0.13)}
.db-col-12{grid-column:span 12}.db-col-7{grid-column:span 7}.db-col-5{grid-column:span 5}
.db-row-2{grid-row:span 2}
@media(max-width:1100px){.db-col-12,.db-col-7,.db-col-5{grid-column:span 6}}
.db-center{align-items:center}
.db-card-h{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;width:100%}
.db-card-h h3{font-size:.92rem;font-weight:700;margin:0;letter-spacing:-.01em}
.db-card-h p{font-size:.7rem;color:var(--db-dim);margin:.25rem 0 0}
.db-legend{display:flex;gap:.85rem;font-family:'IBM Plex Mono',monospace;font-size:.66rem;color:var(--db-dim)}
.db-chart{height:280px;width:100%}
.db-empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--db-dim);font-size:.8rem}

.db-tip{background:rgba(12,15,17,0.96);border:1px solid var(--db-line);border-radius:10px;
  padding:.6rem .75rem;font-size:.72rem;backdrop-filter:blur(6px)}
.db-tip-h{font-family:'IBM Plex Mono',monospace;color:var(--db-dim);margin-bottom:.4rem}
.db-tip-row{display:flex;justify-content:space-between;gap:1.4rem;padding:.1rem 0}
.db-tip-row span:last-child{font-family:'IBM Plex Mono',monospace}

.db-gauge{position:relative;display:flex;align-items:center;justify-content:center;margin:.4rem 0}
.db-gauge-c{position:absolute;display:flex;flex-direction:column;align-items:center}
.db-gauge-v{font-family:'IBM Plex Mono',monospace;font-size:1.7rem;font-weight:600}
.db-gauge-cap{font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;color:var(--db-dim)}
.db-gauge-foot{display:flex;gap:2.2rem;margin-top:.5rem}
.db-gauge-foot>div{display:flex;flex-direction:column;align-items:center}
.db-mini-k{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:var(--db-dim)}
.db-mini-v{font-family:'IBM Plex Mono',monospace;font-size:1.05rem;font-weight:600;margin-top:.2rem}

.db-funnel{display:flex;flex-direction:column;gap:.85rem;flex:1;justify-content:center}
.db-frow{display:flex;align-items:center;gap:.8rem}
.db-fk{width:84px;font-size:.74rem;color:var(--db-dim)}
.db-ftrack{flex:1;height:12px;background:rgba(255,255,255,0.05);border-radius:6px;overflow:hidden}
.db-ffill{height:100%;border-radius:6px;transition:width .8s cubic-bezier(.2,.7,.2,1)}
.db-fv{width:84px;text-align:right;font-family:'IBM Plex Mono',monospace;font-size:.78rem}

.db-split{display:grid;grid-template-columns:1fr 1fr;gap:1.6rem;flex:1}
.db-split-k{font-family:'IBM Plex Mono',monospace;font-size:.64rem;letter-spacing:.16em;color:var(--db-dim);margin-bottom:.6rem}
.db-lrow{display:flex;align-items:center;gap:.6rem;padding:.22rem 0}
.db-lcode{width:96px;font-size:.74rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.db-ltrack{flex:1;height:7px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden}
.db-lfill{height:100%;border-radius:4px}
.db-lqty{width:48px;text-align:right;font-family:'IBM Plex Mono',monospace;font-size:.72rem;color:var(--db-dim)}

.db-aov{display:flex;flex-direction:column;gap:.5rem;flex:1;justify-content:center}
.db-arow{display:flex;align-items:center;gap:.7rem}
.db-arank{font-family:'IBM Plex Mono',monospace;font-size:.7rem;color:var(--db-gold);width:22px}
.db-aname{width:120px;font-size:.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.db-atrack{flex:1;height:8px;background:rgba(255,255,255,0.05);border-radius:5px;overflow:hidden}
.db-afill{height:100%;border-radius:5px;background:linear-gradient(90deg,#9A7A2E,var(--db-gold))}
.db-aval{width:78px;text-align:right;font-family:'IBM Plex Mono',monospace;font-size:.76rem}

.db-fab{display:flex;gap:.8rem;flex:1;align-items:center}
.db-fabcell{flex:1;background:rgba(255,255,255,0.025);border:1px solid var(--db-line);
  border-radius:13px;padding:.95rem .7rem;display:flex;flex-direction:column;align-items:center;gap:.25rem}
.db-fabk{font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;color:var(--db-dim)}
.db-fabv{font-family:'IBM Plex Mono',monospace;font-size:1.32rem;font-weight:600}
.db-fabu{font-size:.62rem;color:var(--db-dim)}

.db-dept{display:flex;flex-direction:column;gap:.5rem}
.db-drow{display:flex;align-items:center;gap:.8rem}
.db-dname{width:120px;font-size:.76rem;color:var(--db-text)}
.db-dtrack{flex:1;height:9px;display:flex;background:rgba(255,255,255,0.04);border-radius:5px;overflow:hidden}
.db-dseg{height:100%}
.db-ddays{width:48px;text-align:right;font-family:'IBM Plex Mono',monospace;font-size:.74rem;color:var(--db-red)}
.db-dept-legend{margin-top:.8rem;justify-content:flex-end}

.db-foot{margin-top:2rem;text-align:center;font-family:'IBM Plex Mono',monospace;
  font-size:.64rem;letter-spacing:.18em;color:rgba(255,255,255,0.22)}
`;
