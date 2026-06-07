// ===========================================================================
// Dashboard B — chart components, split into a lazily-loaded chunk.
//
// recharts (+ d3) is ~357 KB — by far the biggest dependency on the dashboard.
// Keeping it behind React.lazy here means the dashboard's KPI numbers paint
// from the small page chunk first, and this chart code streams in behind a
// placeholder (see <Suspense> in ./index.tsx). Same charts, same data, same
// look — only the LOAD ORDER changes. The two components and their tooltip /
// label helpers were moved here verbatim from index.tsx; colours + computed
// data come in as props so the parent keeps owning the numbers.
// ===========================================================================
import type React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { formatCurrency } from "@/lib/utils";

const rm = (sen: number | undefined) => formatCurrency(sen ?? 0);

// Revenue area-chart tooltip (moved verbatim from index.tsx).
function RevTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: { name?: string; value?: number | string; color?: string }[];
}) {
  if (!props.active || !props.payload?.length) return null;
  return (
    <div className="rounded-lg border border-[#E2DDD8] bg-white px-3 py-2 shadow-md text-xs">
      <div className="font-semibold text-[#5A5550] mb-1">{props.label}</div>
      {props.payload.map((p) => (
        <div
          key={p.name}
          className="flex items-center justify-between gap-5 py-0.5"
        >
          <span style={{ color: p.color }}>● {p.name}</span>
          <span className="font-semibold text-[#1F1D1B] tabular-nums">
            {rm(Number(p.value) * 100)}
          </span>
        </div>
      ))}
    </div>
  );
}

export type RevChartRow = {
  m: string;
  "Sales Orders": number;
  Invoices: number;
  Production: number;
};

export function RevenueChart({
  data,
  hiddenSeries,
  cSO,
  cProd,
  cInv,
}: {
  data: RevChartRow[];
  hiddenSeries: Set<string>;
  cSO: string;
  cProd: string;
  cInv: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="bSO" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={cSO} stopOpacity={0.22} />
            <stop offset="100%" stopColor={cSO} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="bPR" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={cProd} stopOpacity={0.2} />
            <stop offset="100%" stopColor={cProd} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="m"
          tick={{ fill: "#9CA3AF", fontSize: 11 }}
          axisLine={{ stroke: "#F0ECE6" }}
          tickLine={false}
        />
        <YAxis
          tickFormatter={(v) => `${Math.round(v / 1000)}k`}
          tick={{ fill: "#9CA3AF", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={38}
        />
        <Tooltip content={<RevTooltip />} cursor={{ stroke: "#E2DDD8" }} />
        <Area
          type="monotone"
          dataKey="Sales Orders"
          stroke={cSO}
          strokeWidth={2}
          fill="url(#bSO)"
          isAnimationActive={false}
          dot={false}
          hide={hiddenSeries.has("Sales Orders")}
        />
        <Area
          type="monotone"
          dataKey="Production"
          stroke={cProd}
          strokeWidth={2}
          fill="url(#bPR)"
          isAnimationActive={false}
          dot={false}
          hide={hiddenSeries.has("Production")}
        />
        <Area
          type="monotone"
          dataKey="Invoices"
          stroke={cInv}
          strokeWidth={1.75}
          fill="none"
          strokeDasharray="4 3"
          isAnimationActive={false}
          dot={false}
          hide={hiddenSeries.has("Invoices")}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// Donut leader-line label — customer name + share % pointing at the slice.
interface PieLabelArg {
  cx?: number;
  cy?: number;
  midAngle?: number;
  outerRadius?: number;
  percent?: number;
  index?: number;
  name?: string | number;
}

export type PieDatum = { name: string; value: number };

export function CustomerPieChart({
  data,
  pieColors,
  totalCustRev,
}: {
  data: PieDatum[];
  pieColors: string[];
  totalCustRev: number;
}) {
  const renderPieLabel = (a: PieLabelArg): React.ReactElement => {
    const RAD = Math.PI / 180;
    const cx = a.cx ?? 0;
    const cy = a.cy ?? 0;
    const mid = a.midAngle ?? 0;
    const oR = a.outerRadius ?? 0;
    const cos = Math.cos(-mid * RAD);
    const sin = Math.sin(-mid * RAD);
    const sx = cx + oR * cos;
    const sy = cy + oR * sin;
    const mx = cx + (oR + 13) * cos;
    const my = cy + (oR + 13) * sin;
    const right = cos >= 0;
    const ex = mx + (right ? 15 : -15);
    const ey = my;
    const idx = a.index ?? 0;
    const color = pieColors[idx % pieColors.length];
    const nm = String(a.name ?? "");
    const short = nm.length > 15 ? `${nm.slice(0, 14)}…` : nm;
    const pct = ((a.percent ?? 0) * 100).toFixed(0);
    return (
      <g>
        <polyline
          points={`${sx},${sy} ${mx},${my} ${ex},${ey}`}
          stroke={color}
          strokeWidth={1}
          fill="none"
          opacity={0.55}
        />
        <text
          x={ex + (right ? 4 : -4)}
          y={ey}
          textAnchor={right ? "start" : "end"}
          dominantBaseline="central"
          fontSize={10}
          fill="#5A5550"
        >
          {short}
          <tspan fill="#9CA3AF"> {pct}%</tspan>
        </text>
      </g>
    );
  };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={66}
          outerRadius={104}
          paddingAngle={2}
          stroke="#fff"
          strokeWidth={2}
          isAnimationActive={false}
          labelLine={false}
          label={renderPieLabel}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={pieColors[i % pieColors.length]} />
          ))}
        </Pie>
        <Tooltip
          formatter={(val, name) => {
            const v = Number(val) || 0;
            return [
              `${rm(v)} · ${((v / Math.max(1, totalCustRev)) * 100).toFixed(1)}%`,
              String(name),
            ];
          }}
          contentStyle={{
            borderRadius: 8,
            border: "1px solid #E2DDD8",
            fontSize: 12,
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
