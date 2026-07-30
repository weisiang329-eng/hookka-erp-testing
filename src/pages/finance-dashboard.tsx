// ---------------------------------------------------------------------------
// Financial Dashboard (owner 2026-07-29) — the stock-app style read of the
// company's own numbers: four cards, each a tabbed bar chart with a line
// overlay, monthly or CALENDAR-quarterly.
//
//   Income statement — actual bars + the owner's Forecast P&L as a dashed
//                      line (future months show forecast only), plus MoM %.
//   Cash flow        — operating / investing / financing / free cash flow.
//   Balance sheet    — total assets & liabilities bars + debt-to-asset line.
//   Ratios           — gross & net margin, current & quick, ROE, ROA.
//
// Everything comes from GET /api/accounting/dashboard, which computes each
// figure with the SAME engines the reports use, so a card can never disagree
// with its report. Partial buckets (the running month / a half quarter) are
// marked so a stub is never read as a trend.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { BarChart3 } from "lucide-react";

type Slice = { sales: number; cogs: number; gross: number; otherIncome: number; expenses: number; net: number };
type Row = {
  key: string;
  label: string;
  partial: boolean;
  actual: Slice | null;
  forecast: Slice | null;
  cashFlow: { operating: number; investing: number; financing: number; net: number; freeCashFlow: number };
  balanceSheet: { assets: number; liabilities: number; equity: number; currentAssets: number; currentLiabilities: number; inventory: number } | null;
  ratios: {
    grossMarginPct: number | null; netMarginPct: number | null;
    currentRatio: number | null; quickRatio: number | null;
    debtToAssetPct: number | null; roePct: number | null; roaPct: number | null;
  };
};

const rm = (sen: number | null | undefined) =>
  sen === null || sen === undefined ? "-" : (sen / 100).toLocaleString("en-MY", { maximumFractionDigits: 0 });
const rm2 = (sen: number | null | undefined) =>
  sen === null || sen === undefined ? "-" : (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const GOLD = "#6B5C32";
const RUST = "#9A3A2D";
const TEAL = "#3E6570";

function ChartTip(props: {
  active?: boolean;
  label?: string | number;
  payload?: { name?: string; value?: number | string; color?: string; dataKey?: string }[];
  money?: boolean;
}) {
  if (!props.active || !props.payload?.length) return null;
  return (
    <div className="rounded-lg border border-[#E2DDD8] bg-white px-3 py-2 shadow-md text-xs">
      <div className="font-semibold text-[#5A5550] mb-1">{props.label}</div>
      {props.payload.map((p) => (
        <div key={String(p.dataKey)} className="flex justify-between gap-4 tabular-nums">
          <span style={{ color: p.color }}>{p.name}</span>
          <span>
            {typeof p.value === "number"
              ? props.money !== false && !/%|Ratio/i.test(String(p.name))
                ? rm2(p.value as number)
                : `${(p.value as number).toFixed(2)}${/%/.test(String(p.name)) ? "%" : ""}`
              : String(p.value ?? "-")}
          </span>
        </div>
      ))}
    </div>
  );
}

// One card = tab strip + chart + the figures table underneath (the stock-app
// layout the owner asked for).
function ChartCard({
  title,
  tabs,
  active,
  onTab,
  data,
  bars,
  line,
  footer,
}: {
  title: string;
  tabs: { key: string; label: string }[];
  active: string;
  onTab: (k: string) => void;
  data: Record<string, number | string | null>[];
  bars: { key: string; name: string; color: string }[];
  line?: { key: string; name: string; color: string; dashed?: boolean; axis?: "left" | "right" };
  footer: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-[#1F1D1B] mr-2">{title}</h3>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => onTab(t.key)}
              className={`rounded-md border px-2.5 py-1 text-xs cursor-pointer ${
                active === t.key
                  ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                  : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#F0ECE9" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fontSize: 11, fill: "#6B7280" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => rm(v)}
              />
              {line?.axis === "right" && (
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: RUST }} axisLine={false} tickLine={false} />
              )}
              <Tooltip content={<ChartTip />} />
              {bars.map((b) => (
                <Bar key={b.key} dataKey={b.key} name={b.name} fill={b.color} radius={[3, 3, 0, 0]} maxBarSize={38} />
              ))}
              {line && (
                <Line
                  type="monotone"
                  dataKey={line.key}
                  name={line.name}
                  stroke={line.color}
                  strokeWidth={2}
                  strokeDasharray={line.dashed ? "5 4" : undefined}
                  dot={{ r: 3 }}
                  yAxisId={line.axis === "right" ? "right" : undefined}
                  connectNulls
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="overflow-x-auto">{footer}</div>
      </CardContent>
    </Card>
  );
}

export default function FinanceDashboardPage() {
  const [granularity, setGranularity] = useState<"month" | "quarter">("month");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [plTab, setPlTab] = useState<"sales" | "gross" | "net">("sales");
  const [cfTab, setCfTab] = useState<"operating" | "investing" | "financing" | "freeCashFlow">("operating");
  const [ratioTab, setRatioTab] = useState<
    "grossMarginPct" | "netMarginPct" | "currentRatio" | "quickRatio" | "roePct" | "roaPct"
  >("grossMarginPct");

  // The loading state is cleared by the toggle handler (a user action), not
  // here — setting state synchronously inside an effect cascades renders.
  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/dashboard?granularity=${granularity}&periods=${granularity === "quarter" ? 8 : 12}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { rows: Row[] } }>)
      .then((j) => { if (!stale && j?.success && j.data) setRows(j.data.rows); })
      .catch(() => { if (!stale) setRows([]); });
    return () => { stale = true; };
  }, [granularity]);

  const plData = useMemo(
    () =>
      (rows ?? []).map((r, i, arr) => {
        const prev = i > 0 ? arr[i - 1].actual : null;
        const cur = r.actual;
        const pick = (s: Slice | null) => (s ? (plTab === "sales" ? s.sales : plTab === "gross" ? s.gross : s.net) : null);
        const a = pick(cur);
        const p = pick(prev);
        return {
          label: r.label + (r.partial ? " *" : ""),
          actual: a,
          forecast: pick(r.forecast),
          mom: a !== null && p !== null && p !== 0 ? Math.round(((a - p) / Math.abs(p)) * 10000) / 100 : null,
        };
      }),
    [rows, plTab],
  );

  const cfData = useMemo(
    () => (rows ?? []).map((r) => ({ label: r.label + (r.partial ? " *" : ""), value: r.cashFlow?.[cfTab] ?? null, net: r.cashFlow?.net ?? null })),
    [rows, cfTab],
  );

  const bsData = useMemo(
    () =>
      (rows ?? [])
        .filter((r) => r.balanceSheet)
        .map((r) => ({
          label: r.label + (r.partial ? " *" : ""),
          assets: r.balanceSheet!.assets,
          liabilities: r.balanceSheet!.liabilities,
          debtPct: r.ratios.debtToAssetPct,
        })),
    [rows],
  );

  const ratioIsMoney = false;
  const ratioData = useMemo(
    () => (rows ?? []).map((r) => ({ label: r.label + (r.partial ? " *" : ""), value: r.ratios[ratioTab] })),
    [rows, ratioTab],
  );

  const th = "px-2 py-1 text-right text-[11px] text-[#6B7280] whitespace-nowrap";
  const td = "px-2 py-1 text-right tabular-nums text-[12px] whitespace-nowrap";

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-[#1F1D1B] flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-[#6B5C32]" /> Financial Dashboard
        </h2>
        <span className="text-xs text-[#9CA3AF]">* = period still running / not a full quarter</span>
        <div className="ml-auto flex items-center gap-2">
          {(["month", "quarter"] as const).map((g) => (
            <button
              key={g}
              onClick={() => { if (g !== granularity) { setRows(null); setGranularity(g); } }}
              className={`rounded-md border px-3 py-1.5 text-sm cursor-pointer ${
                granularity === g
                  ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                  : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"
              }`}
            >
              {g === "month" ? "Monthly" : "Quarterly"}
            </button>
          ))}
        </div>
      </div>

      {rows === null ? (
        <Card><CardContent className="py-16 text-center text-[#6B7280] text-sm">Loading…</CardContent></Card>
      ) : rows.length === 0 ? (
        <Card><CardContent className="py-16 text-center text-[#6B7280] text-sm">No data yet.</CardContent></Card>
      ) : (
        <>
          <ChartCard
            title="Income Statement"
            tabs={[
              { key: "sales", label: "Revenue" },
              { key: "gross", label: "Gross Profit" },
              { key: "net", label: "Net Profit" },
            ]}
            active={plTab}
            onTab={(k) => setPlTab(k as typeof plTab)}
            data={plData}
            bars={[{ key: "actual", name: "Actual", color: GOLD }]}
            line={{ key: "forecast", name: "Forecast", color: RUST, dashed: true }}
            footer={
              <table className="w-full">
                <tbody>
                  <tr><td className={`${td} text-left font-medium`}>Actual</td>{plData.map((d) => <td key={d.label} className={td}>{rm(d.actual as number)}</td>)}</tr>
                  <tr><td className={`${td} text-left font-medium text-[#9A3A2D]`}>Forecast</td>{plData.map((d) => <td key={d.label} className={`${td} text-[#9A3A2D]`}>{rm(d.forecast as number)}</td>)}</tr>
                  <tr><td className={`${td} text-left font-medium`}>vs last period</td>{plData.map((d) => <td key={d.label} className={`${td} ${(d.mom ?? 0) < 0 ? "text-[#9A3A2D]" : "text-[#27500A]"}`}>{d.mom === null ? "-" : `${d.mom > 0 ? "+" : ""}${d.mom.toFixed(1)}%`}</td>)}</tr>
                  <tr><td className={th} /> {plData.map((d) => <td key={d.label} className={th}>{d.label}</td>)}</tr>
                </tbody>
              </table>
            }
          />

          <ChartCard
            title="Cash Flow"
            tabs={[
              { key: "operating", label: "Operating" },
              { key: "investing", label: "Investing" },
              { key: "financing", label: "Financing" },
              { key: "freeCashFlow", label: "Free Cash Flow" },
            ]}
            active={cfTab}
            onTab={(k) => setCfTab(k as typeof cfTab)}
            data={cfData}
            bars={[{ key: "value", name: "Amount", color: TEAL }]}
            line={{ key: "net", name: "Net change", color: RUST }}
            footer={
              <table className="w-full">
                <tbody>
                  <tr><td className={`${td} text-left font-medium`}>Amount</td>{cfData.map((d) => <td key={d.label} className={`${td} ${(d.value as number) < 0 ? "text-[#9A3A2D]" : ""}`}>{rm(d.value as number)}</td>)}</tr>
                  <tr><td className={`${td} text-left font-medium`}>Net change</td>{cfData.map((d) => <td key={d.label} className={`${td} ${(d.net as number) < 0 ? "text-[#9A3A2D]" : ""}`}>{rm(d.net as number)}</td>)}</tr>
                  <tr><td className={th} />{cfData.map((d) => <td key={d.label} className={th}>{d.label}</td>)}</tr>
                </tbody>
              </table>
            }
          />

          <ChartCard
            title="Balance Sheet"
            tabs={[]}
            active=""
            onTab={() => {}}
            data={bsData}
            bars={[
              { key: "assets", name: "Total assets", color: GOLD },
              { key: "liabilities", name: "Total liabilities", color: "#C9B98A" },
            ]}
            line={{ key: "debtPct", name: "Debt to assets %", color: RUST, axis: "right" }}
            footer={
              bsData.length === 0 ? (
                <p className="text-xs text-[#9CA3AF]">Balances start at the opening date — nothing before it.</p>
              ) : (
                <table className="w-full">
                  <tbody>
                    <tr><td className={`${td} text-left font-medium`}>Total assets</td>{bsData.map((d) => <td key={d.label} className={td}>{rm(d.assets)}</td>)}</tr>
                    <tr><td className={`${td} text-left font-medium`}>Total liabilities</td>{bsData.map((d) => <td key={d.label} className={td}>{rm(d.liabilities)}</td>)}</tr>
                    <tr><td className={`${td} text-left font-medium text-[#9A3A2D]`}>Debt to assets</td>{bsData.map((d) => <td key={d.label} className={`${td} text-[#9A3A2D]`}>{d.debtPct === null ? "-" : `${d.debtPct.toFixed(2)}%`}</td>)}</tr>
                    <tr><td className={th} />{bsData.map((d) => <td key={d.label} className={th}>{d.label}</td>)}</tr>
                  </tbody>
                </table>
              )
            }
          />

          <ChartCard
            title="Financial Ratios"
            tabs={[
              { key: "grossMarginPct", label: "Gross margin" },
              { key: "netMarginPct", label: "Net margin" },
              { key: "currentRatio", label: "Current ratio" },
              { key: "quickRatio", label: "Quick ratio" },
              { key: "roePct", label: "ROE" },
              { key: "roaPct", label: "ROA" },
            ]}
            active={ratioTab}
            onTab={(k) => setRatioTab(k as typeof ratioTab)}
            data={ratioData}
            bars={[{ key: "value", name: /Pct$/.test(ratioTab) ? "%" : "Ratio", color: TEAL }]}
            footer={
              <table className="w-full">
                <tbody>
                  <tr>
                    <td className={`${td} text-left font-medium`}>{/Pct$/.test(ratioTab) ? "Percent" : "Ratio"}</td>
                    {ratioData.map((d) => (
                      <td key={d.label} className={`${td} ${(d.value ?? 0) < 0 ? "text-[#9A3A2D]" : ""}`}>
                        {d.value === null ? "-" : `${(d.value as number).toFixed(2)}${/Pct$/.test(ratioTab) ? "%" : ""}`}
                      </td>
                    ))}
                  </tr>
                  <tr><td className={th} />{ratioData.map((d) => <td key={d.label} className={th}>{d.label}</td>)}</tr>
                </tbody>
              </table>
            }
          />
          {ratioIsMoney && null}
        </>
      )}
    </div>
  );
}
