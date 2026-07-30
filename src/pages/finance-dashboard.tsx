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

type Slice = {
  sales: number; cogs: number; gross: number; otherIncome: number; expenses: number; net: number;
  materials: number; labour: number; overhead: number; stockMovement: number;
  staffCost: number; otherOpex: number;
};
// Income-card tabs (owner 2026-07-29: not just sales — break the cost side
// down). materials + labour + overhead + stock movement = COGS;
// staff cost + other opex = operating expenses.
const PL_TABS: { key: keyof Slice; label: string }[] = [
  { key: "sales", label: "Revenue" },
  { key: "cogs", label: "COGS" },
  { key: "materials", label: "Raw Material" },
  { key: "labour", label: "Production Salary" },
  { key: "overhead", label: "Factory Overhead" },
  { key: "stockMovement", label: "Stock Movement" },
  { key: "gross", label: "Gross Profit" },
  { key: "staffCost", label: "Staff Cost" },
  { key: "otherOpex", label: "Other Expenses" },
  { key: "net", label: "Net Profit" },
];
type CsCat = { name: string; line: "bedframe" | "sofa" | "shared"; spend: number; purchase: number; closing: number };
type Row = {
  key: string;
  label: string;
  partial: boolean;
  actual: Slice | null;
  forecast: Slice | null;
  costStructure?: { salesSplit: { bedframe: number; sofa: number }; categories: CsCat[] };
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
  const [plTab, setPlTab] = useState<keyof Slice>("sales");
  const [cfTab, setCfTab] = useState<"operating" | "investing" | "financing" | "freeCashFlow">("operating");
  const [ratioTab, setRatioTab] = useState<
    "grossMarginPct" | "netMarginPct" | "currentRatio" | "quickRatio" | "roePct" | "roaPct"
  >("grossMarginPct");
  // Cost-structure card controls: which measure, which product line, amount
  // or share of sales, and which single material the trend card focuses on.
  const [csMeasure, setCsMeasure] = useState<"spend" | "purchase" | "closing">("spend");
  const [csLine, setCsLine] = useState<"all" | "bedframe" | "sofa">("all");
  const [csMode, setCsMode] = useState<"amount" | "pct">("amount");
  const [csFocus, setCsFocus] = useState<string>("");

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
        const pick = (s: Slice | null) => (s ? s[plTab] : null);
        const a = pick(cur);
        const p = pick(prev);
        // Owner 2026-07-29: every line also reads as a % of that period's
        // revenue — the cost-structure view of the same figure.
        const sales = cur?.sales ?? null;
        const fcSales = r.forecast?.sales ?? null;
        const share = (v: number | null, base: number | null) =>
          v !== null && base !== null && base !== 0 ? Math.round((v / base) * 10000) / 100 : null;
        return {
          label: r.label + (r.partial ? " *" : ""),
          actual: a,
          forecast: pick(r.forecast),
          pctOfRevenue: share(a, sales),
          forecastPctOfRevenue: share(pick(r.forecast), fcSales),
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

  // ---- Cost structure (owner 2026-07-29) --------------------------------
  // Shared materials are apportioned to a line by that period's share of
  // sales — the same rule the Sofa/Bedframe P&L uses.
  const csCats = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) for (const cc of r.costStructure?.categories ?? []) set.add(cc.name);
    return [...set].sort();
  }, [rows]);
  const csAmount = (r: Row, cat: string): number => {
    const cc = (r.costStructure?.categories ?? []).find((x) => x.name === cat);
    if (!cc) return 0;
    const raw = cc[csMeasure];
    if (csLine === "all" || cc.line === csLine) return raw;
    if (cc.line === "shared") {
      const s = r.costStructure!.salesSplit;
      const tot = s.bedframe + s.sofa;
      if (tot <= 0) return 0;
      return Math.round(raw * ((csLine === "bedframe" ? s.bedframe : s.sofa) / tot));
    }
    return 0; // the other line's own material
  };
  const csLineSales = (r: Row): number => {
    const s = r.costStructure?.salesSplit;
    if (!s) return r.actual?.sales ?? 0;
    return csLine === "all" ? s.bedframe + s.sofa : csLine === "bedframe" ? s.bedframe : s.sofa;
  };
  const csData = useMemo(
    () =>
      (rows ?? []).map((r) => {
        const point: Record<string, number | string | null> = { label: r.label + (r.partial ? " *" : "") };
        const sales = csLineSales(r);
        for (const cat of csCats) {
          const amt = csAmount(r, cat);
          point[cat] = csMode === "amount" ? amt : sales > 0 ? Math.round((amt / sales) * 10000) / 100 : null;
        }
        return point;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, csCats, csLine, csMeasure, csMode],
  );
  const csTrend = useMemo(
    () =>
      (rows ?? []).map((r) => {
        const amt = csAmount(r, csFocus);
        const sales = csLineSales(r);
        return {
          label: r.label + (r.partial ? " *" : ""),
          amount: amt,
          pct: sales > 0 ? Math.round((amt / sales) * 10000) / 100 : null,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, csFocus, csLine, csMeasure],
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
            tabs={PL_TABS.map((t) => ({ key: String(t.key), label: t.label }))}
            active={String(plTab)}
            onTab={(k) => setPlTab(k as keyof Slice)}
            data={plData}
            bars={[{ key: "actual", name: "Actual", color: GOLD }]}
            line={{ key: "forecast", name: "Forecast", color: RUST, dashed: true }}
            footer={
              <table className="w-full">
                <tbody>
                  <tr><td className={`${td} text-left font-medium`}>Actual</td>{plData.map((d) => <td key={d.label} className={td}>{rm(d.actual as number)}</td>)}</tr>
                  <tr><td className={`${td} text-left font-medium text-[#6B5C32]`}>% of revenue</td>{plData.map((d) => <td key={d.label} className={`${td} text-[#6B5C32]`}>{d.pctOfRevenue === null ? "-" : `${d.pctOfRevenue.toFixed(2)}%`}</td>)}</tr>
                  <tr><td className={`${td} text-left font-medium text-[#9A3A2D]`}>Forecast</td>{plData.map((d) => <td key={d.label} className={`${td} text-[#9A3A2D]`}>{rm(d.forecast as number)}</td>)}</tr>
                  <tr><td className={`${td} text-left font-medium text-[#9A3A2D]`}>Forecast % of revenue</td>{plData.map((d) => <td key={d.label} className={`${td} text-[#9A3A2D]`}>{d.forecastPctOfRevenue === null ? "-" : `${d.forecastPctOfRevenue.toFixed(2)}%`}</td>)}</tr>
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

          {/* ---- Cost structure: composition + single-material trend ---- */}
          {csCats.length > 0 && (
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-[#1F1D1B] mr-2">Cost Structure</h3>
                  {([["spend", "Spend"], ["purchase", "Purchase"], ["closing", "Closing Stock"]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setCsMeasure(k)}
                      className={`rounded-md border px-2.5 py-1 text-xs cursor-pointer ${csMeasure === k ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>{l}</button>
                  ))}
                  <span className="mx-1 text-[#E2DDD8]">|</span>
                  {([["all", "All"], ["bedframe", "Bedframe"], ["sofa", "Sofa"]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setCsLine(k)}
                      className={`rounded-md border px-2.5 py-1 text-xs cursor-pointer ${csLine === k ? "bg-[#3E6570] text-white border-[#3E6570]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>{l}</button>
                  ))}
                  <span className="mx-1 text-[#E2DDD8]">|</span>
                  {([["amount", "RM"], ["pct", "% of sales"]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setCsMode(k)}
                      className={`rounded-md border px-2.5 py-1 text-xs cursor-pointer ${csMode === k ? "bg-[#9A3A2D] text-white border-[#9A3A2D]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>{l}</button>
                  ))}
                </div>
                {csLine !== "all" && (
                  <p className="text-[11px] text-[#9CA3AF]">
                    Shared materials (plywood, packaging, …) are split into this line by its share of that period's sales — the
                    same rule the Sofa / Bedframe P&amp;L uses.
                  </p>
                )}
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={csData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#F0ECE9" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false}
                        tickFormatter={(v: number) => (csMode === "amount" ? rm(v) : `${v}%`)} />
                      <Tooltip content={<ChartTip money={csMode === "amount"} />} />
                      {csCats.map((cat, i) => (
                        <Bar key={cat} dataKey={cat} name={cat} stackId="cs" maxBarSize={44}
                          fill={["#6B5C32", "#9C6F1E", "#C9B98A", "#3E6570", "#7A9EA7", "#9A3A2D", "#C58B7F", "#4F7C3A", "#8FB07A", "#6B7280", "#A9A29B", "#D8CFC4"][i % 12]} />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <tbody>
                      {csCats.map((cat) => (
                        <tr key={cat} className="border-b border-[#F0ECE9]">
                          <td className={`${td} text-left font-medium`}>
                            <button onClick={() => setCsFocus(cat)} className="cursor-pointer hover:underline" title="Show this material's trend below">{cat}</button>
                          </td>
                          {csData.map((d) => (
                            <td key={String(d.label)} className={td}>
                              {d[cat] === null || d[cat] === 0 ? "-" : csMode === "amount" ? rm(d[cat] as number) : `${(d[cat] as number).toFixed(2)}%`}
                            </td>
                          ))}
                        </tr>
                      ))}
                      <tr><td className={th} />{csData.map((d) => <td key={String(d.label)} className={th}>{d.label}</td>)}</tr>
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {csCats.length > 0 && (
            <ChartCard
              title={`Material Trend — ${csFocus || csCats[0]}`}
              tabs={csCats.map((c) => ({ key: c, label: c }))}
              active={csFocus || csCats[0]}
              onTab={(k) => setCsFocus(k)}
              data={csTrend}
              bars={[{ key: "amount", name: csMeasure === "spend" ? "Spend" : csMeasure === "purchase" ? "Purchase" : "Closing stock", color: GOLD }]}
              line={{ key: "pct", name: "% of sales", color: RUST, axis: "right" }}
              footer={
                <table className="w-full">
                  <tbody>
                    <tr><td className={`${td} text-left font-medium`}>Amount</td>{csTrend.map((d) => <td key={d.label} className={td}>{rm(d.amount)}</td>)}</tr>
                    <tr><td className={`${td} text-left font-medium text-[#9A3A2D]`}>% of sales</td>{csTrend.map((d) => <td key={d.label} className={`${td} text-[#9A3A2D]`}>{d.pct === null ? "-" : `${d.pct.toFixed(2)}%`}</td>)}</tr>
                    <tr><td className={th} />{csTrend.map((d) => <td key={d.label} className={th}>{d.label}</td>)}</tr>
                  </tbody>
                </table>
              }
            />
          )}
        </>
      )}
    </div>
  );
}
