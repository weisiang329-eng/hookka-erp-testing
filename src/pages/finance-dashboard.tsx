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
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Bar,
  ComposedChart,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { BarChart3, ChevronDown, ChevronRight } from "lucide-react";

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
  costStructure?: {
    salesSplit: { bedframe: number; sofa: number };
    forecast?: Record<string, number>;
    categories: CsCat[];
  };
  /** Denominators for the Production Salary card: heads on the payroll and
      units completed in the period. unitsCompleted is known to run high. */
  labourBase?: { headcount: number | null; unitsCompleted: number | null };
  /** Wage bill per department (payslips-sourced) for the stacked salary card,
      with each department's forecast (dept: rows) beside it. */
  salaryByDept?: { dept: string; costSen: number; forecastSen?: number; nonProd?: boolean }[];
  cashFlow: {
    operating: number; investing: number; financing: number; net: number; freeCashFlow: number;
    inflow?: number; outflow?: number;
    lines?: { label: string; section: string; value: number }[];
  };
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
// Stack colours for the cost-structure chart, indexed by the material's
// position. Lifted out of the JSX so the Show chips can paint themselves the
// same colour as the band they toggle — a chip whose swatch didn't match its
// band would be worse than no swatch at all.
const CS_COLOURS = [
  "#6B5C32", "#9C6F1E", "#C9B98A", "#3E6570", "#7A9EA7", "#9A3A2D",
  "#C58B7F", "#4F7C3A", "#8FB07A", "#6B7280", "#A9A29B", "#D8CFC4",
];
const TEAL = "#3E6570";

function ChartTip(props: {
  active?: boolean;
  label?: string | number;
  payload?: {
    name?: string;
    value?: number | string;
    color?: string;
    dataKey?: string;
    payload?: Record<string, unknown>;
  }[];
  money?: boolean;
  /** Show each series' share of sales beside its amount (cost-structure chart). */
  shares?: boolean;
}) {
  if (!props.active || !props.payload?.length) return null;
  // The point object every series in this chart was built from — csData carries
  // __pct__<cat> and __fcpct__<cat> alongside the amounts, so the share needs no
  // recomputation here (owner 2026-08-06: 「帮我在 diagram 也显示 %」). An
  // amount on a chart says how big; only the share says whether that is a lot.
  const point = props.payload[0]?.payload ?? {};
  const shareOf = (dataKey: string): number | null => {
    if (!props.shares) return null;
    const key = dataKey === "__fctotal__" ? "__fctotalpct__" : `__pct__${dataKey}`;
    const v = point[key];
    return typeof v === "number" ? v : null;
  };
  return (
    <div className="rounded-lg border border-[#E2DDD8] bg-white px-3 py-2 shadow-md text-xs">
      <div className="font-semibold text-[#5A5550] mb-1">{props.label}</div>
      {props.payload.map((p) => {
        const pct = shareOf(String(p.dataKey));
        return (
          <div key={String(p.dataKey)} className="flex justify-between gap-4 tabular-nums">
            <span style={{ color: p.color }}>{p.name}</span>
            <span>
              {typeof p.value === "number"
                ? props.money !== false && !/%|Ratio/i.test(String(p.name))
                  ? rm2(p.value as number)
                  : `${(p.value as number).toFixed(2)}${/%/.test(String(p.name)) ? "%" : ""}`
                : String(p.value ?? "-")}
              {pct !== null && <span className="ml-1.5 text-[10px] text-[#9CA3AF]">{pct.toFixed(2)}%</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---- Production / Non-Production salary card (owner 2026-08-31: 「dashboard
// 多一个non production 的，和production 一模一样，只是变成non production 的
// 数据，然后拿forecast 的 non production」). One component, two instances —
// `depts` decides which departments it draws, and every total / forecast /
// percentage on the card is the sum of ITS OWN departments. Where a period has
// no dept data at all it falls back to the `base` row (the production card
// passes the P&L labour bucket so pre-payroll months stay alive; the
// non-production card passes nulls so it shows "-", never borrowed figures).
type SalCardBase = {
  label: string; amount: number | null; forecast: number | null;
  pct: number | null; forecastPct: number | null;
  headcount: number | null; units: number | null; perHead: number | null; perUnit: number | null;
};
function SalaryDeptCard({
  title,
  subtitle,
  depts,
  data,
  base,
  showDenominators,
}: {
  title: string;
  subtitle: string;
  depts: string[];
  data: Record<string, number | string | null>[];
  base: SalCardBase[];
  showDenominators: boolean;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const shownCount = depts.filter((d) => !hidden.has(d)).length;
  const tdc = "px-2 py-1 text-right tabular-nums text-[12px] whitespace-nowrap";
  const rowsData = useMemo(
    () =>
      data.map((rec, i) => {
        const sales = (rec.__sales__ as number | null) ?? null;
        const fcSales = (rec.__fcsales__ as number | null) ?? null;
        let amt: number | null = null;
        let fc: number | null = null;
        let drawn = 0;
        for (const d of depts) {
          const v = rec[d];
          if (typeof v === "number") {
            amt = (amt ?? 0) + v;
            if (!hidden.has(d)) drawn += v;
          }
          const f = rec[`__fc__${d}`];
          if (typeof f === "number") fc = (fc ?? 0) + f;
        }
        const b = base[i];
        const amount = amt === null && fc === null ? (b?.amount ?? null) : amt;
        const forecast = amt === null && fc === null ? (b?.forecast ?? null) : fc;
        const pctOf = (v: number | null, s: number | null) =>
          v !== null && s !== null && s !== 0 ? Math.round((v / s) * 10000) / 100 : null;
        return {
          ...rec,
          __cardamt__: amount,
          __cardfc__: forecast,
          __cardpct__: pctOf(amount, sales),
          __cardfcpct__: pctOf(forecast, fcSales),
          __drawnpct__: sales && sales !== 0 ? Math.round((drawn / sales) * 10000) / 100 : null,
        } as Record<string, number | string | null>;
      }),
    [data, base, depts, hidden],
  );
  if (!rowsData.length) return null;
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold text-[#1F1D1B] mr-2">{title}</h3>
          <span className="text-[11px] text-[#9CA3AF]">{subtitle}</span>
          <span className="ml-1 text-[11px] text-[#9CA3AF]">RM + % of sales</span>
        </div>
        {depts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-[#6B7280] mr-0.5">Show</span>
            {depts.map((dept, i) => {
              const colour = CS_COLOURS[i % CS_COLOURS.length];
              const on = !hidden.has(dept);
              return (
                <button
                  key={dept}
                  onClick={() =>
                    setHidden((prev) => {
                      const next = new Set(prev);
                      if (next.has(dept)) next.delete(dept);
                      else next.add(dept);
                      return next;
                    })
                  }
                  className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] cursor-pointer ${
                    on ? "border-[#E2DDD8] bg-white text-[#1F1D1B]" : "border-[#E2DDD8] bg-[#F0ECE9] text-[#9CA3AF]"
                  }`}
                  title={on ? `Hide ${dept} from the chart` : `Show ${dept} on the chart`}
                >
                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: on ? colour : "#D8D3CE" }} />
                  {dept}
                </button>
              );
            })}
            {hidden.size > 0 && (
              <button onClick={() => setHidden(new Set())}
                className="rounded-md border border-[#E2DDD8] px-2 py-0.5 text-[11px] text-[#3E6570] cursor-pointer hover:bg-[#F0ECE9]">
                Show all
              </button>
            )}
            {hidden.size < depts.length && (
              <button onClick={() => setHidden(new Set(depts))}
                className="rounded-md border border-[#E2DDD8] px-2 py-0.5 text-[11px] text-[#6B7280] cursor-pointer hover:bg-[#F0ECE9]">
                Clear
              </button>
            )}
          </div>
        )}
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rowsData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#F0ECE9" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="amt" tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false}
                tickFormatter={(v: number) => rm(v)} />
              {showDenominators && (
                <YAxis yAxisId="unit" orientation="right" tick={{ fontSize: 11, fill: "#9A3A2D" }} axisLine={false} tickLine={false}
                  tickFormatter={(v: number) => rm(v)} />
              )}
              <Tooltip content={<ChartTip shares />} />
              {depts.length === 0 ? (
                <Bar yAxisId="amt" dataKey="__cardamt__" name={title} fill={GOLD} radius={[3, 3, 0, 0]} maxBarSize={38} />
              ) : (
                depts.map((dept, i) =>
                  hidden.has(dept) ? null : (
                    <Bar key={dept} yAxisId="amt" dataKey={dept} name={dept} stackId="sal" maxBarSize={38}
                      fill={CS_COLOURS[i % CS_COLOURS.length]}>
                      {shownCount === 1 && (
                        <LabelList dataKey="__drawnpct__" position="top" offset={6}
                          formatter={(v: unknown) => (typeof v === "number" ? `${v.toFixed(2)}%` : "")}
                          style={{ fontSize: 10, fill: "#6B5C32" }} />
                      )}
                    </Bar>
                  ),
                )
              )}
              <Line yAxisId="amt" type="monotone" dataKey="__cardfc__" name="Forecast" stroke={RUST}
                strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
              {showDenominators && (
                <Line yAxisId="unit" type="monotone" dataKey="perHead" name="RM / head" stroke="#3E6570"
                  strokeWidth={2} dot={{ r: 2 }} connectNulls={false} />
              )}
              {showDenominators && (
                <Line yAxisId="unit" type="monotone" dataKey="perUnit" name="RM / unit" stroke="#4F7C3A"
                  strokeWidth={2} strokeDasharray="2 3" dot={{ r: 2 }} connectNulls={false} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <tbody>
              <tr className="border-b border-[#E2DDD8] bg-[#F7F4EF]">
                <td className="px-2 py-1.5 text-left text-[11px] font-bold text-[#6B5C32] tracking-wide">PERIOD</td>
                {rowsData.map((d) => (
                  <td key={String(d.label)} colSpan={2}
                    className="px-2 py-1.5 text-center text-[12px] font-bold text-[#1F1D1B] whitespace-nowrap border-l border-[#E2DDD8]">
                    {String(d.label)}
                  </td>
                ))}
              </tr>
              <tr className="border-b-2 border-[#E2DDD8] bg-[#F7F4EF]">
                <td className="px-2 py-1 text-left text-[10px] text-[#9CA3AF]"></td>
                {rowsData.map((d) => (
                  <Fragment key={String(d.label)}>
                    <td className="px-2 py-1 text-right text-[10px] font-semibold text-[#6B5C32] border-l border-[#E2DDD8]">Actual</td>
                    <td className="px-2 py-1 text-right text-[10px] font-semibold text-[#9A3A2D]">Forecast</td>
                  </Fragment>
                ))}
              </tr>
              <tr className="border-b border-[#E2DDD8] bg-[#F6F1E7]">
                <td className={`${tdc} text-left font-semibold`}>REVENUE</td>
                {rowsData.map((d) => (
                  <Fragment key={String(d.label)}>
                    <td className={`${tdc} font-semibold border-l border-[#E2DDD8]`}>{rm(d.__sales__ as number | null)}</td>
                    <td className={`${tdc} font-semibold text-[#9A3A2D]`}>{rm(d.__fcsales__ as number | null)}</td>
                  </Fragment>
                ))}
              </tr>
              {depts.map((dept) => (
                <tr key={dept} className="border-b border-[#F0ECE9]">
                  <td className={`${tdc} text-left font-medium`}>{dept}</td>
                  {rowsData.map((d) => {
                    const amt = (d[dept] as number | null) ?? null;
                    const p = (d[`__pct__${dept}`] as number | null) ?? null;
                    const fc = (d[`__fc__${dept}`] as number | null) ?? null;
                    const fp = (d[`__fcpct__${dept}`] as number | null) ?? null;
                    const over = p !== null && fp !== null && p > fp;
                    return (
                      <Fragment key={String(d.label)}>
                        <td className={`${tdc} border-l border-[#E2DDD8]`}>
                          {amt === null || amt === 0 ? "-" : (
                            <>
                              {rm(amt)}
                              <span className={`ml-1.5 text-[10px] ${fp === null ? "text-[#6B5C32]" : over ? "text-[#9A3A2D]" : "text-[#27500A]"}`}>
                                {p === null ? "" : `${p.toFixed(2)}%`}
                              </span>
                            </>
                          )}
                        </td>
                        <td className={`${tdc} text-[#9A3A2D]`}>
                          {fc === null ? "-" : (
                            <>
                              {rm(fc)}
                              <span className="ml-1.5 text-[10px]">{fp === null ? "" : `${fp.toFixed(2)}%`}</span>
                            </>
                          )}
                        </td>
                      </Fragment>
                    );
                  })}
                </tr>
              ))}
              <tr className="border-b border-[#E2DDD8] bg-[#F7F4EF] font-semibold">
                <td className={`${tdc} text-left`}>TOTAL</td>
                {rowsData.map((d) => (
                  <Fragment key={String(d.label)}>
                    <td className={`${tdc} border-l border-[#E2DDD8]`}>
                      {rm(d.__cardamt__ as number | null)}
                      {d.__cardpct__ !== null && <span className="ml-1.5 text-[10px] text-[#6B5C32]">{(d.__cardpct__ as number).toFixed(2)}%</span>}
                    </td>
                    <td className={`${tdc} text-[#9A3A2D]`}>
                      {rm(d.__cardfc__ as number | null)}
                      {d.__cardfcpct__ !== null && <span className="ml-1.5 text-[10px]">{(d.__cardfcpct__ as number).toFixed(2)}%</span>}
                    </td>
                  </Fragment>
                ))}
              </tr>
              {showDenominators && (
                <>
                  <tr className="border-b border-[#F0ECE9]">
                    <td className={`${tdc} text-left font-medium text-[#3E6570]`}>Headcount</td>
                    {base.map((d) => (
                      <td key={d.label} colSpan={2} className={`${tdc} text-[#3E6570] border-l border-[#E2DDD8]`}>{d.headcount ?? "-"}</td>
                    ))}
                  </tr>
                  <tr className="border-b border-[#F0ECE9]">
                    <td className={`${tdc} text-left font-medium text-[#3E6570]`}>RM / head</td>
                    {base.map((d) => (
                      <td key={d.label} colSpan={2} className={`${tdc} text-[#3E6570] border-l border-[#E2DDD8]`}>{rm(d.perHead)}</td>
                    ))}
                  </tr>
                  <tr className="border-b border-[#F0ECE9]">
                    <td className={`${tdc} text-left font-medium text-[#4F7C3A]`}>Units completed</td>
                    {base.map((d) => (
                      <td key={d.label} colSpan={2} className={`${tdc} text-[#4F7C3A] border-l border-[#E2DDD8]`}>{d.units ?? "-"}</td>
                    ))}
                  </tr>
                  <tr>
                    <td className={`${tdc} text-left font-medium text-[#4F7C3A]`}>RM / unit</td>
                    {base.map((d) => (
                      <td key={d.label} colSpan={2} className={`${tdc} text-[#4F7C3A] border-l border-[#E2DDD8]`}>{rm(d.perUnit)}</td>
                    ))}
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
        {showDenominators && (
          <p className="text-[11px] text-[#9A3A2D]">
            ⚠ RM / unit uses completed-batch quantities, which are known to double-count some
            completions — the unit count runs high, so this cost runs low. RM / head is unaffected.
          </p>
        )}
      </CardContent>
    </Card>
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
  const [cfView, setCfView] = useState<"summary" | "detail">("summary");
  // Explicit window (owner 2026-08-05). Blank = the rolling default: last 12
  // periods plus however far the forecast reaches.
  const [fromYm, setFromYm] = useState("");
  const [toYm, setToYm] = useState("");
  // Cash-flow detail is grouped by section and opens one section at a time —
  // the flat every-account list was unreadable (owner: 太复杂了).
  const [cfOpenSection, setCfOpenSection] = useState<string | null>(null);
  const [ratioTab, setRatioTab] = useState<
    "grossMarginPct" | "netMarginPct" | "currentRatio" | "quickRatio" | "roePct" | "roaPct"
  >("grossMarginPct");
  // Cost-structure card controls: which measure, which product line, amount
  // or share of sales, and which single material the trend card focuses on.
  const [csMeasure, setCsMeasure] = useState<"spend" | "purchase" | "closing">("spend");
  const [csLine, setCsLine] = useState<"all" | "bedframe" | "sofa">("all");
  const [csFocus, setCsFocus] = useState<string>("");
  // Which materials the CHART draws (owner 2026-08-06: 「我想把 cost structure
  // 的 diagram 做成我勾选我要看的」). Held as the HIDDEN set, not the shown one,
  // so a material that appears in a later period is visible by default instead
  // of silently missing from a stack the operator believes is complete.
  // The table below stays complete — it is the record; the chart is the view.
  const [csHidden, setCsHidden] = useState<Set<string>>(new Set());

  // The loading state is cleared by the toggle handler (a user action), not
  // here — setting state synchronously inside an effect cascades renders.
  useEffect(() => {
    let stale = false;
    const range = fromYm && toYm && fromYm <= toYm ? `&from=${fromYm}&to=${toYm}` : "";
    fetch(`/api/accounting/dashboard?granularity=${granularity}&periods=${granularity === "quarter" ? 8 : 12}${range}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { rows: Row[] } }>)
      .then((j) => { if (!stale && j?.success && j.data) setRows(j.data.rows); })
      .catch(() => { if (!stale) setRows([]); });
    return () => { stale = true; };
  }, [granularity, fromYm, toYm]);

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

  // Production Salary card. The wage bill against its two denominators — the
  // percentages follow the rule BUG-2026-08-06-002 set: each side divides by
  // its OWN revenue.
  const labourData = useMemo(
    () =>
      (rows ?? []).map((r) => {
        const amount = r.actual?.labour ?? null;
        const forecast = r.forecast?.labour ?? null;
        const sales = r.actual?.sales ?? null;
        const fcSales = r.forecast?.sales ?? null;
        const headcount = r.labourBase?.headcount ?? null;
        const units = r.labourBase?.unitsCompleted ?? null;
        const per = (v: number | null, base: number | null) =>
          v !== null && base !== null && base > 0 ? Math.round(v / base) : null;
        const share = (v: number | null, base: number | null) =>
          v !== null && base !== null && base !== 0 ? Math.round((v / base) * 10000) / 100 : null;
        return {
          label: r.label + (r.partial ? " *" : ""),
          amount,
          forecast,
          pct: share(amount, sales),
          forecastPct: share(forecast, fcSales),
          headcount,
          units,
          perHead: per(amount, headcount),
          perUnit: per(amount, units),
        };
      }),
    [rows],
  );
  // Department stacks for the two salary cards (owner 2026-08-11: 「弄到像
  // cost structure 这样」; owner 2026-08-31: 「dashboard 多一个non production
  // 的」). One shared data array carries every department's keys; each card
  // draws only ITS list, split by the master's nonProd flag.
  const salDeptSplit = useMemo(() => {
    const flags = new Map<string, boolean>();
    for (const r of rows ?? [])
      for (const d of r.salaryByDept ?? []) flags.set(d.dept, (flags.get(d.dept) ?? false) || !!d.nonProd);
    const all = [...flags.keys()].sort();
    return { prod: all.filter((d) => !flags.get(d)), non: all.filter((d) => flags.get(d)) };
  }, [rows]);
  const salData = useMemo(
    () =>
      (rows ?? []).map((r, i) => {
        const base = labourData[i];
        const sales = r.actual?.sales ?? null;
        const fcSales = r.forecast?.sales ?? null;
        const rec: Record<string, number | string | null> = { ...base };
        rec.__sales__ = sales;
        rec.__fcsales__ = fcSales;
        for (const d of r.salaryByDept ?? []) {
          if (d.costSen !== 0) {
            rec[d.dept] = d.costSen;
            if (sales && sales !== 0) rec[`__pct__${d.dept}`] = Math.round((d.costSen / sales) * 10000) / 100;
          }
          const fc = d.forecastSen ?? 0;
          if (fc !== 0) {
            rec[`__fc__${d.dept}`] = fc;
            if (fcSales && fcSales !== 0) rec[`__fcpct__${d.dept}`] = Math.round((fc / fcSales) * 10000) / 100;
          }
        }
        if (base?.forecastPct !== null && base?.forecastPct !== undefined) rec.__pct__forecast = base.forecastPct;
        return rec;
      }),
    [rows, labourData],
  );
  // Null totals for the non-production card: where it has no dept data at
  // all it must show "-", never borrow the production labour bucket.
  const nullBase = useMemo(
    () => labourData.map((d) => ({ ...d, amount: null, forecast: null, pct: null, forecastPct: null, headcount: null, units: null, perHead: null, perUnit: null })),
    [labourData],
  );

  const cfData = useMemo(
    () =>
      (rows ?? []).map((r) => ({
        label: r.label + (r.partial ? " *" : ""),
        value: r.cashFlow?.[cfTab] ?? null,
        net: r.cashFlow?.net ?? null,
        inflow: r.cashFlow?.inflow ?? null,
        outflow: r.cashFlow?.outflow ?? null,
      })),
    [rows, cfTab],
  );
  // Detail view: every account line the Cash Flow statement prints, one row
  // per account across the periods (owner 2026-07-30: 「每个科目一行先」).
  const cfDetailRows = useMemo(() => {
    const keys = new Map<string, { label: string; section: string }>();
    for (const r of rows ?? []) {
      for (const l of r.cashFlow?.lines ?? []) keys.set(`${l.section}||${l.label}`, { label: l.label, section: l.section });
    }
    return [...keys.entries()]
      .sort((a, b) => a[1].section.localeCompare(b[1].section) || a[1].label.localeCompare(b[1].label))
      .map(([k, meta]) => ({
        key: k,
        ...meta,
        values: (rows ?? []).map((r) => (r.cashFlow?.lines ?? []).find((l) => `${l.section}||${l.label}` === k)?.value ?? 0),
      }));
  }, [rows]);
  // …grouped by section, each with its own per-period totals, so Detail opens
  // as a handful of section rows instead of forty account rows at once.
  const cfSections = useMemo(() => {
    const bySec = new Map<string, typeof cfDetailRows>();
    for (const r of cfDetailRows) bySec.set(r.section, [...(bySec.get(r.section) ?? []), r]);
    return [...bySec.entries()].map(([name, secRows]) => ({
      name,
      rows: secRows,
      totals: (rows ?? []).map((_, i) => secRows.reduce((s, r) => s + (r.values[i] ?? 0), 0)),
    }));
  }, [cfDetailRows, rows]);

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
  // How many bands the chart is drawing right now — the bar label only appears
  // at exactly one, where there is room for it.
  const csShownCount = useMemo(
    () => csCats.filter((c) => !csHidden.has(c)).length,
    [csCats, csHidden],
  );
  // A category can exist on more than one line (B.M FABRIC and S FABRIC are
  // both FABRIC) — sum every matching entry under the current line filter.
  const csAmount = (r: Row, cat: string): number => {
    const s = r.costStructure?.salesSplit;
    const tot = (s?.bedframe ?? 0) + (s?.sofa ?? 0);
    let out = 0;
    for (const cc of r.costStructure?.categories ?? []) {
      if (cc.name !== cat) continue;
      const raw = cc[csMeasure];
      if (csLine === "all" || cc.line === csLine) out += raw;
      else if (cc.line === "shared" && tot > 0) {
        out += Math.round(raw * ((csLine === "bedframe" ? s!.bedframe : s!.sofa) / tot));
      }
    }
    return out;
  };
  const csLineSales = (r: Row): number => {
    const s = r.costStructure?.salesSplit;
    if (!s) return r.actual?.sales ?? 0;
    return csLine === "all" ? s.bedframe + s.sofa : csLine === "bedframe" ? s.bedframe : s.sofa;
  };
  // The base a FORECAST percentage divides by is the FORECAST revenue, not the
  // actual (owner 2026-08-06: 「他应该是我 forecast 的 percentage, 而不是出
  // actual 的percentage」). Dividing a plan by an actual mixes two worlds: in a
  // month only part-billed it read 45,000 / 37,098 = 121.30% for a target that
  // is 15% of the 300,000 planned. Both sides must be a share of their OWN
  // revenue, or comparing them says nothing.
  //
  // A line view pro-rates by the ACTUAL split, the same way csForecastAmt
  // pro-rates the target itself — the plan is keyed whole-company, so that
  // split is the only one there is, and using it on both sides keeps the
  // percentage internally consistent.
  const csForecastSales = (r: Row): number | null => {
    const fs = r.forecast?.sales ?? null;
    if (fs === null) return null;
    if (csLine === "all") return fs;
    const s = r.costStructure?.salesSplit;
    const tot = s ? s.bedframe + s.sofa : 0;
    if (!s || tot <= 0) return null;
    return Math.round(fs * ((csLine === "bedframe" ? s.bedframe : s.sofa) / tot));
  };
  // Chart plots the amounts; the table under it carries the amount AND its
  // share of sales side by side (owner 2026-07-29: 「把 percentage 和 RM 做在
  // 一起…% 在 spend 旁边」), so the toggle is gone.
  // Forecast for a category in the current line view — the target is keyed
  // whole-company, so a line view pro-rates it by that line's sales share.
  const csForecastAmt = (r: Row, cat: string): number | null => {
    const f = r.costStructure?.forecast?.[cat];
    if (f === undefined) return null;
    if (csLine === "all") return f;
    const s = r.costStructure!.salesSplit;
    const tot = s.bedframe + s.sofa;
    if (tot <= 0) return null;
    return Math.round(f * ((csLine === "bedframe" ? s.bedframe : s.sofa) / tot));
  };
  const csData = useMemo(
    () =>
      (rows ?? []).map((r) => {
        const point: Record<string, number | string | null> = { label: r.label + (r.partial ? " *" : "") };
        const sales = csLineSales(r);
        point.__sales__ = sales;
        for (const cat of csCats) {
          const amt = csAmount(r, cat);
          point[cat] = amt;
          point[`__pct__${cat}`] = sales > 0 ? Math.round((amt / sales) * 10000) / 100 : null;
          const fc = csMeasure === "spend" ? csForecastAmt(r, cat) : null; // targets are spend-side
          point[`__fc__${cat}`] = fc;
          const fcSales = csForecastSales(r);
          point[`__fcpct__${cat}`] =
            fc !== null && fcSales !== null && fcSales > 0
              ? Math.round((fc / fcSales) * 10000) / 100
              : null;
        }
        // Planned spend for the period — the dashed line over the stacked bars
        // (owner 2026-08-06: 「diagram 可以把 forecast 也放进去？」). It totals
        // only the materials currently DRAWN, so it always states the target for
        // the stack beneath it: tick one material and the line becomes that
        // material's target, which is what 「forecast line 只能一个？」 was
        // asking for. Null rather than 0 when nothing is keyed, so recharts
        // breaks the line instead of dropping it to the axis on a month with no
        // plan.
        let fcTotal: number | null = null;
        for (const cat of csCats) {
          if (csHidden.has(cat)) continue;
          const v = point[`__fc__${cat}`] as number | null;
          if (v !== null) fcTotal = (fcTotal ?? 0) + v;
        }
        point.__fctotal__ = fcTotal;
        // …and its share, against FORECAST revenue (BUG-2026-08-06-002's rule).
        const fcSalesTot = csForecastSales(r);
        point.__fctotalpct__ =
          fcTotal !== null && fcSalesTot !== null && fcSalesTot > 0
            ? Math.round((fcTotal / fcSalesTot) * 10000) / 100
            : null;
        // Share of the STACK currently drawn, for the bar label when a single
        // material is picked. Summing the drawn bands rather than reusing one
        // category's __pct__ keeps the label honest if several are ticked.
        let drawn: number | null = null;
        for (const cat of csCats) {
          if (csHidden.has(cat)) continue;
          const v = point[cat] as number | null;
          if (v !== null) drawn = (drawn ?? 0) + v;
        }
        point.__drawn__ = drawn;
        point.__drawnpct__ =
          drawn !== null && sales > 0 ? Math.round((drawn / sales) * 10000) / 100 : null;
        return point;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, csCats, csLine, csMeasure, csHidden],
  );
  // The focus falls back to the first category until the operator picks one —
  // the trend read a blank key before this and drew a flat zero line.
  const csFocusEff = csFocus || csCats[0] || "";
  const csTrend = useMemo(
    () =>
      (rows ?? []).map((r) => {
        const amt = csAmount(r, csFocusEff);
        const sales = csLineSales(r);
        const fc = csMeasure === "spend" ? csForecastAmt(r, csFocusEff) : null;
        const fcSales = csForecastSales(r);
        return {
          label: r.label + (r.partial ? " *" : ""),
          amount: amt,
          // The base both percentages divide by (owner 2026-08-06: 「帮我把
          // revenue 显示出来」). Showing it is what let him catch the forecast
          // percentage dividing by the wrong one this morning — a share is only
          // checkable when its denominator is on screen.
          sales,
          forecastSales: csForecastSales(r),
          pct: sales > 0 ? Math.round((amt / sales) * 10000) / 100 : null,
          forecast: fc,
          // Same rule as the table above: a forecast share divides by forecast
          // revenue. This row read the same 121.30% for the same reason.
          forecastPct:
            fc !== null && fcSales !== null && fcSales > 0
              ? Math.round((fc / fcSales) * 10000) / 100
              : null,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, csFocusEff, csLine, csMeasure],
  );

  const td = "px-2 py-1 text-right tabular-nums text-[12px] whitespace-nowrap";
  // Period header (owner 2026-07-29: 「月份能移上去上面…明显一点」) — the
  // months now open every figures table in bold instead of trailing it in grey.
  const periodHead = (labels: string[]) => (
    <tr className="border-b-2 border-[#E2DDD8] bg-[#F7F4EF]">
      <td className="px-2 py-1.5 text-left text-[11px] font-bold text-[#6B5C32] tracking-wide">PERIOD</td>
      {labels.map((l) => (
        <td key={l} className="px-2 py-1.5 text-right text-[12px] font-bold text-[#1F1D1B] whitespace-nowrap">{l}</td>
      ))}
    </tr>
  );
  // Two columns per month (owner 2026-08-06: 「每个月分成两个 column, 一个
  // actual + percentage, 一个 forecast amount 和 percentage」). The forecast used
  // to ride inside the actual cell as "(fc 80.87%)", which put two different
  // measures in one column and left the forecast AMOUNT nowhere to go.
  const periodHeadSplit = (labels: string[]) => (
    <>
      <tr className="border-b border-[#E2DDD8] bg-[#F7F4EF]">
        <td className="px-2 py-1.5 text-left text-[11px] font-bold text-[#6B5C32] tracking-wide">PERIOD</td>
        {labels.map((l) => (
          <td key={l} colSpan={2} className="px-2 py-1.5 text-center text-[12px] font-bold text-[#1F1D1B] whitespace-nowrap border-l border-[#E2DDD8]">{l}</td>
        ))}
      </tr>
      <tr className="border-b-2 border-[#E2DDD8] bg-[#F7F4EF]">
        <td className="px-2 py-1 text-left text-[10px] text-[#9CA3AF]"></td>
        {labels.map((l) => (
          <Fragment key={l}>
            <td className="px-2 py-1 text-right text-[10px] font-semibold text-[#6B5C32] border-l border-[#E2DDD8]">Actual</td>
            <td className="px-2 py-1 text-right text-[10px] font-semibold text-[#9A3A2D]">Forecast</td>
          </Fragment>
        ))}
      </tr>
    </>
  );

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-[#1F1D1B] flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-[#6B5C32]" /> Financial Dashboard
        </h2>
        <span className="text-xs text-[#9CA3AF]">* = period still running / not a full quarter</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-[#6B7280]">Period</span>
          <input type="month" value={fromYm} onChange={(e) => { setRows(null); setFromYm(e.target.value); }}
            className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm" />
          <span className="text-xs text-[#9CA3AF]">→</span>
          <input type="month" value={toYm} onChange={(e) => { setRows(null); setToYm(e.target.value); }}
            className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm" />
          {(fromYm || toYm) && (
            <button onClick={() => { setRows(null); setFromYm(""); setToYm(""); }}
              className="rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1.5 text-xs text-[#4B5563] hover:bg-[#F0ECE9] cursor-pointer">
              Reset
            </button>
          )}
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
                  {periodHead(plData.map((d) => d.label))}
                  {/* Amount and its share of revenue in ONE cell (owner
                      2026-08-05: percentage beside the amount, not its own row). */}
                  <tr>
                    <td className={`${td} text-left font-medium`}>Actual</td>
                    {plData.map((d) => (
                      <td key={d.label} className={td}>
                        {rm(d.actual as number)}
                        {d.pctOfRevenue !== null && <span className="ml-1.5 text-[10px] text-[#6B5C32]">{d.pctOfRevenue.toFixed(2)}%</span>}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className={`${td} text-left font-medium text-[#9A3A2D]`}>Forecast</td>
                    {plData.map((d) => (
                      <td key={d.label} className={`${td} text-[#9A3A2D]`}>
                        {rm(d.forecast as number)}
                        {d.forecastPctOfRevenue !== null && <span className="ml-1.5 text-[10px]">{d.forecastPctOfRevenue.toFixed(2)}%</span>}
                      </td>
                    ))}
                  </tr>
                  {/* Variance row (owner 2026-07-30): money gap + points gap. */}
                  <tr className="bg-[#F7F4EF]">
                    <td className={`${td} text-left font-semibold`}>vs Forecast</td>
                    {plData.map((d) => {
                      const gap = d.actual !== null && d.forecast !== null ? (d.actual as number) - (d.forecast as number) : null;
                      const pts = d.pctOfRevenue !== null && d.forecastPctOfRevenue !== null ? d.pctOfRevenue - d.forecastPctOfRevenue : null;
                      return (
                        <td key={d.label} className={`${td} font-semibold ${(gap ?? 0) < 0 ? "text-[#9A3A2D]" : "text-[#27500A]"}`}>
                          {gap === null ? "-" : `${gap > 0 ? "+" : ""}${rm(gap)}`}
                          {pts !== null && <span className="ml-1 text-[10px]">{`${pts > 0 ? "+" : ""}${pts.toFixed(2)}pt`}</span>}
                        </td>
                      );
                    })}
                  </tr>
                  <tr><td className={`${td} text-left font-medium`}>vs last period</td>{plData.map((d) => <td key={d.label} className={`${td} ${(d.mom ?? 0) < 0 ? "text-[#9A3A2D]" : "text-[#27500A]"}`}>{d.mom === null ? "-" : `${d.mom > 0 ? "+" : ""}${d.mom.toFixed(1)}%`}</td>)}</tr>
                </tbody>
              </table>
            }
          />

          {/* ---- Production Salary: the wage bill per head and per unit ----
              Owner 2026-08-06: 「我要把 production salary 也另外分出来一个
              diagram」, sitting under the P&L because it is part of COGS. The
              total alone says nothing — 91,631 reads very differently against
              20 heads than against 40. Owner 2026-08-31: a Non-Production twin
              card follows it — same layout, the master-flagged non-production
              departments, forecast from the Forecast page's non-prod section. */}
          {labourData.some((d) => d.amount !== null) && (
            <SalaryDeptCard
              title="Production Salary"
              subtitle="750-0010 SALARIES · 750-0020 EPF · 750-0030 SOCSO · 750-0040 EIS"
              depts={salDeptSplit.prod}
              data={salData}
              base={labourData}
              showDenominators
            />
          )}
          {salDeptSplit.non.length > 0 && (
            <SalaryDeptCard
              title="Non-Production Salary"
              subtitle="Warehouse · Repair · Maintenance · Shortfall · R&D — actual = clocked-hours share of payroll"
              depts={salDeptSplit.non}
              data={salData}
              base={nullBase}
              showDenominators={false}
            />
          )}

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
                  <span className="ml-1 text-[11px] text-[#9CA3AF]">RM + % of sales</span>
                </div>
                {csLine !== "all" && (
                  <p className="text-[11px] text-[#9CA3AF]">
                    Shared materials (plywood, packaging, …) are split into this line by its share of that period's sales — the
                    same rule the Sofa / Bedframe P&amp;L uses.
                  </p>
                )}
                {/* Which materials the chart draws. Colours match the stack, so
                    a chip reads as its own band. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-[#6B7280] mr-0.5">Show</span>
                  {csCats.map((cat, i) => {
                    const colour = CS_COLOURS[i % CS_COLOURS.length];
                    const on = !csHidden.has(cat);
                    return (
                      <button
                        key={cat}
                        onClick={() =>
                          setCsHidden((prev) => {
                            const next = new Set(prev);
                            if (next.has(cat)) next.delete(cat);
                            else next.add(cat);
                            return next;
                          })
                        }
                        className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] cursor-pointer ${
                          on ? "border-[#E2DDD8] bg-white text-[#1F1D1B]" : "border-[#E2DDD8] bg-[#F0ECE9] text-[#9CA3AF]"
                        }`}
                        title={on ? `Hide ${cat} from the chart` : `Show ${cat} on the chart`}
                      >
                        <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: on ? colour : "#D8D3CE" }} />
                        {cat}
                      </button>
                    );
                  })}
                  {csHidden.size > 0 && (
                    <button onClick={() => setCsHidden(new Set())}
                      className="rounded-md border border-[#E2DDD8] px-2 py-0.5 text-[11px] text-[#3E6570] cursor-pointer hover:bg-[#F0ECE9]">
                      Show all
                    </button>
                  )}
                  {csHidden.size < csCats.length && (
                    <button onClick={() => setCsHidden(new Set(csCats))}
                      className="rounded-md border border-[#E2DDD8] px-2 py-0.5 text-[11px] text-[#6B7280] cursor-pointer hover:bg-[#F0ECE9]">
                      Clear
                    </button>
                  )}
                </div>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={csData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#F0ECE9" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false}
                        tickFormatter={(v: number) => rm(v)} />
                      <Tooltip content={<ChartTip shares />} />
                      {csCats.map((cat, i) =>
                        csHidden.has(cat) ? null : (
                          <Bar key={cat} dataKey={cat} name={cat} stackId="cs" maxBarSize={44}
                            fill={CS_COLOURS[i % CS_COLOURS.length]}>
                            {/* The share printed ON the stack, but only while a
                                single material is drawn — a dozen labels stacked
                                inside one bar is unreadable, and the tooltip
                                already carries every band's share. */}
                            {csShownCount === 1 && (
                              <LabelList dataKey="__drawnpct__" position="top" offset={6}
                                formatter={(v: unknown) => (typeof v === "number" ? `${v.toFixed(2)}%` : "")}
                                style={{ fontSize: 10, fill: "#6B5C32" }} />
                            )}
                          </Bar>
                        ),
                      )}
                      {/* Total planned spend — the dashed line the rest of this
                          dashboard uses for a forecast, so the stack can be read
                          against its target at a glance. connectNulls stays OFF:
                          a month with no plan should leave a gap, not a line
                          drawn straight through it. */}
                      <Line type="monotone" dataKey="__fctotal__" name="Forecast" stroke={RUST}
                        strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <tbody>
                      {periodHeadSplit(csData.map((d) => String(d.label)))}
                      {/* The base every percentage divides by (owner 2026-07-30). */}
                      <tr className="border-b border-[#E2DDD8] bg-[#F6F1E7]">
                        <td className={`${td} text-left font-semibold`}>REVENUE</td>
                        {csData.map((d, i) => (
                          <Fragment key={String(d.label)}>
                            <td className={`${td} font-semibold border-l border-[#E2DDD8]`}>{rm(d.__sales__ as number)}</td>
                            <td className={`${td} font-semibold text-[#9A3A2D]`}>
                              {(rows ?? [])[i]?.forecast?.sales != null ? rm((rows ?? [])[i]!.forecast!.sales!) : "-"}
                            </td>
                          </Fragment>
                        ))}
                      </tr>
                      {csCats.map((cat) => (
                        <tr key={cat} className="border-b border-[#F0ECE9]">
                          <td className={`${td} text-left font-medium`}>
                            <button onClick={() => setCsFocus(cat)} className="cursor-pointer hover:underline" title="Show this material's trend below">{cat}</button>
                          </td>
                          {csData.map((d) => {
                            const amt = d[cat] as number | null;
                            const p = d[`__pct__${cat}`] as number | null;
                            const fc = d[`__fc__${cat}`] as number | null;
                            const fp = d[`__fcpct__${cat}`] as number | null;
                            // Over the target reads rust, at or under reads green
                            // — the comparison only means something when both
                            // sides exist.
                            const over = p !== null && fp !== null && p > fp;
                            return (
                              <Fragment key={String(d.label)}>
                                <td className={`${td} border-l border-[#E2DDD8]`}>
                                  {amt === null || amt === 0 ? "-" : (
                                    <>
                                      {rm(amt)}
                                      <span className={`ml-1.5 text-[10px] ${fp === null ? "text-[#9A3A2D]" : over ? "text-[#9A3A2D]" : "text-[#27500A]"}`}>
                                        {p === null ? "" : `${p.toFixed(2)}%`}
                                      </span>
                                    </>
                                  )}
                                </td>
                                <td className={`${td} text-[#9A3A2D]`}>
                                  {fc === null ? "-" : (
                                    <>
                                      {rm(fc)}
                                      <span className="ml-1.5 text-[10px]">{fp === null ? "" : `${fp.toFixed(2)}%`}</span>
                                    </>
                                  )}
                                </td>
                              </Fragment>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {csCats.length > 0 && (
            <ChartCard
              title={`Material Trend — ${csFocusEff}`}
              tabs={csCats.map((c) => ({ key: c, label: c }))}
              active={csFocusEff}
              onTab={(k) => setCsFocus(k)}
              data={csTrend}
              bars={[{ key: "amount", name: csMeasure === "spend" ? "Spend" : csMeasure === "purchase" ? "Purchase" : "Closing stock", color: GOLD }]}
              line={{ key: "forecast", name: "Forecast", color: RUST, dashed: true }}
              footer={
                /* Split per month like the Cost Structure table above (owner
                   2026-08-06: 「material trend 也做成分栏」). Two rows instead
                   of four: the plan no longer needs its own pair of rows once
                   it has its own column, and Amount now sits directly beside
                   the target it should be read against. */
                <table className="w-full">
                  <tbody>
                    {periodHeadSplit(csTrend.map((d) => d.label))}
                    <tr className="border-b border-[#E2DDD8] bg-[#F6F1E7]">
                      <td className={`${td} text-left font-semibold`}>REVENUE</td>
                      {csTrend.map((d) => (
                        <Fragment key={d.label}>
                          <td className={`${td} font-semibold border-l border-[#E2DDD8]`}>{rm(d.sales)}</td>
                          <td className={`${td} font-semibold text-[#9A3A2D]`}>{d.forecastSales === null ? "-" : rm(d.forecastSales)}</td>
                        </Fragment>
                      ))}
                    </tr>
                    <tr className="border-b border-[#F0ECE9]">
                      <td className={`${td} text-left font-medium`}>Amount</td>
                      {csTrend.map((d) => (
                        <Fragment key={d.label}>
                          <td className={`${td} border-l border-[#E2DDD8]`}>{rm(d.amount)}</td>
                          <td className={`${td} text-[#9A3A2D]`}>{d.forecast === null ? "-" : rm(d.forecast)}</td>
                        </Fragment>
                      ))}
                    </tr>
                    <tr>
                      <td className={`${td} text-left font-medium text-[#6B5C32]`}>% of sales</td>
                      {csTrend.map((d) => {
                        // Over target reads rust, at or under reads green — the
                        // same signal the Cost Structure table carries, and it
                        // only means anything when both sides exist.
                        const over = d.pct !== null && d.forecastPct !== null && d.pct > d.forecastPct;
                        return (
                          <Fragment key={d.label}>
                            <td className={`${td} border-l border-[#E2DDD8] ${d.forecastPct === null ? "text-[#6B5C32]" : over ? "text-[#9A3A2D]" : "text-[#27500A]"}`}>
                              {d.pct === null ? "-" : `${d.pct.toFixed(2)}%`}
                            </td>
                            <td className={`${td} text-[#9A3A2D]`}>{d.forecastPct === null ? "-" : `${d.forecastPct.toFixed(2)}%`}</td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              }
            />
          )}

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
            bars={[{ key: "inflow", name: "Money in", color: "#4F7C3A" }, { key: "outflow", name: "Money out", color: RUST }]}
            line={{ key: "net", name: "Net change", color: TEAL }}
            footer={
              <>
                <div className="mb-2 flex items-center gap-2">
                  {([["summary", "Summary"], ["detail", "Detail"]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setCfView(k)}
                      className={`rounded-md border px-2.5 py-1 text-xs cursor-pointer ${cfView === k ? "bg-[#3E6570] text-white border-[#3E6570]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>{l}</button>
                  ))}
                  <span className="text-[11px] text-[#9CA3AF]">Detail lists every account that moved cash.</span>
                </div>
                <table className="w-full">
                  <tbody>
                    {periodHead(cfData.map((d) => d.label))}
                    <tr><td className={`${td} text-left font-medium text-[#4F7C3A]`}>Money in</td>{cfData.map((d) => <td key={d.label} className={`${td} text-[#4F7C3A]`}>{rm(d.inflow as number)}</td>)}</tr>
                    <tr><td className={`${td} text-left font-medium text-[#9A3A2D]`}>Money out</td>{cfData.map((d) => <td key={d.label} className={`${td} text-[#9A3A2D]`}>{rm(d.outflow as number)}</td>)}</tr>
                    <tr><td className={`${td} text-left font-medium`}>{cfTab === "freeCashFlow" ? "Free cash flow" : cfTab[0].toUpperCase() + cfTab.slice(1)}</td>{cfData.map((d) => <td key={d.label} className={`${td} ${(d.value as number) < 0 ? "text-[#9A3A2D]" : ""}`}>{rm(d.value as number)}</td>)}</tr>
                    <tr className="bg-[#F7F4EF]"><td className={`${td} text-left font-semibold`}>Net change</td>{cfData.map((d) => <td key={d.label} className={`${td} font-semibold ${(d.net as number) < 0 ? "text-[#9A3A2D]" : ""}`}>{rm(d.net as number)}</td>)}</tr>
                    {cfView === "detail" &&
                      cfSections.map((sec) => {
                        const open = cfOpenSection === sec.name;
                        return (
                          <Fragment key={sec.name}>
                            <tr className="border-b border-[#F0ECE9] bg-[#F7F4EF]">
                              <td className={`${td} text-left`}>
                                <button
                                  onClick={() => setCfOpenSection(open ? null : sec.name)}
                                  className="cursor-pointer font-medium text-[#6B5C32] inline-flex items-center gap-1"
                                >
                                  {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                  {sec.name.replace(/_/g, " ")}
                                  <span className="text-[10px] font-normal text-[#9CA3AF]">({sec.rows.length})</span>
                                </button>
                              </td>
                              {sec.totals.map((v, i) => (
                                <td key={i} className={`${td} font-medium ${v < 0 ? "text-[#9A3A2D]" : v > 0 ? "text-[#4F7C3A]" : ""}`}>{v === 0 ? "-" : rm(v)}</td>
                              ))}
                            </tr>
                            {open &&
                              sec.rows.map((l) => (
                                <tr key={l.key} className="border-b border-[#F0ECE9]">
                                  <td className={`${td} text-left pl-8 text-[#4B5563]`}>{l.label}</td>
                                  {l.values.map((v, i) => (
                                    <td key={i} className={`${td} ${v < 0 ? "text-[#9A3A2D]" : v > 0 ? "text-[#4F7C3A]" : ""}`}>{v === 0 ? "-" : rm(v)}</td>
                                  ))}
                                </tr>
                              ))}
                          </Fragment>
                        );
                      })}
                  </tbody>
                </table>
              </>
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
                    {periodHead(bsData.map((d) => d.label))}
                    <tr><td className={`${td} text-left font-medium`}>Total assets</td>{bsData.map((d) => <td key={d.label} className={td}>{rm(d.assets)}</td>)}</tr>
                    <tr><td className={`${td} text-left font-medium`}>Total liabilities</td>{bsData.map((d) => <td key={d.label} className={td}>{rm(d.liabilities)}</td>)}</tr>
                    <tr><td className={`${td} text-left font-medium text-[#9A3A2D]`}>Debt to assets</td>{bsData.map((d) => <td key={d.label} className={`${td} text-[#9A3A2D]`}>{d.debtPct === null ? "-" : `${d.debtPct.toFixed(2)}%`}</td>)}</tr>
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
                  {periodHead(ratioData.map((d) => d.label))}
                  <tr>
                    <td className={`${td} text-left font-medium`}>{/Pct$/.test(ratioTab) ? "Percent" : "Ratio"}</td>
                    {ratioData.map((d) => (
                      <td key={d.label} className={`${td} ${(d.value ?? 0) < 0 ? "text-[#9A3A2D]" : ""}`}>
                        {d.value === null ? "-" : `${(d.value as number).toFixed(2)}${/Pct$/.test(ratioTab) ? "%" : ""}`}
                      </td>
                    ))}
                  </tr>
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
