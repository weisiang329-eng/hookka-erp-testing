import { useState, useEffect, useMemo } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatNumber } from "@/lib/utils";
import type { ForecastEntry, HistoricalSales, PromiseDateCalc } from "@/types";

type Tab = "dashboard" | "detail" | "accuracy" | "promise";

// What a figure reads when nothing sourced it. Same convention as
// src/pages/reports.tsx — never "0", never a plausible number.
const NO_FIGURE = "—";

// `historical_sales` has one row per product PER MONTH PER CUSTOMER
// (src/api/routes/historical-sales.ts groups by period, productCode,
// customerId). Every derivation on this page treated one row as one month:
// `sales.slice(-3)` was described as "the last 3 months" but on a product sold
// to three customers in one month it is that ONE month, three times. Fold to
// one row per period first, then all the month arithmetic below means what its
// captions say. BUG-2026-08-13-014.
function byPeriod(rows: HistoricalSales[]): { period: string; quantity: number; revenue: number }[] {
  const m = new Map<string, { period: string; quantity: number; revenue: number }>();
  for (const s of rows) {
    const cur = m.get(s.period);
    if (cur) {
      cur.quantity += s.quantity;
      cur.revenue += s.revenue;
    } else {
      m.set(s.period, { period: s.period, quantity: s.quantity, revenue: s.revenue });
    }
  }
  return Array.from(m.values()).sort((a, b) => a.period.localeCompare(b.period));
}

/** "YYYY-MM" for `offset` months from the current month. */
function periodFromNow(offset: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

type PromiseDateEnriched = PromiseDateCalc & {
  productName: string;
  productCode: string;
  departments: { departmentCode: string; departmentName: string; minutesPerUnit: number }[];
};

export default function ForecastPage() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [selectedMethod, setSelectedMethod] = useState<"SMA_3" | "SMA_6" | "WMA">("SMA_3");
  const [promiseProductId, setPromiseProductId] = useState<string>("");

  const { data: forecastsResp } = useCachedJson<unknown>("/api/forecasts");
  const { data: historicalResp } = useCachedJson<unknown>("/api/historical-sales");
  const { data: promiseResp } = useCachedJson<unknown>("/api/promise-date");

  const asArray = (j: unknown): unknown[] => {
    if (Array.isArray(j)) return j;
    const d = (j as { data?: unknown })?.data;
    return Array.isArray(d) ? d : [];
  };
  const forecasts: ForecastEntry[] = useMemo(() => asArray(forecastsResp) as ForecastEntry[], [forecastsResp]);
  const historicalSales: HistoricalSales[] = useMemo(() => asArray(historicalResp) as HistoricalSales[], [historicalResp]);
  const promiseDates: PromiseDateEnriched[] = useMemo(() => asArray(promiseResp) as PromiseDateEnriched[], [promiseResp]);

  // Unique products from historical data
  const productList = useMemo(() => {
    const map = new Map<string, { id: string; code: string; name: string }>();
    historicalSales.forEach((s) => {
      if (!map.has(s.productId)) {
        map.set(s.productId, { id: s.productId, code: s.productCode, name: s.productName });
      }
    });
    return Array.from(map.values());
  }, [historicalSales]);

  // Set default selections once data loads.
  //
  // One-shot default-selection seed (data arrives -> auto-pick first item).
  // The dropdown is user-editable afterwards, so a pure derive would prevent
  // the user from picking a different product.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (productList.length > 0 && !selectedProductId) {
      setSelectedProductId(productList[0].id);
    }
  }, [productList, selectedProductId]);

  useEffect(() => {
    if (promiseDates.length > 0 && !promiseProductId) {
      setPromiseProductId(promiseDates[0].productId);
    }
  }, [promiseDates, promiseProductId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const tabs: { key: Tab; label: string }[] = [
    { key: "dashboard", label: "Dashboard" },
    { key: "detail", label: "Forecast Detail" },
    { key: "accuracy", label: "Accuracy" },
    { key: "promise", label: "Promise Date" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B]">Demand Forecasting & Analytics</h1>
        <p className="text-sm text-gray-500 mt-1">
          Predict future demand based on historical sales. Support production, inventory, and capacity planning.
        </p>
      </div>

      {/* Provenance. `forecast_entries` has NO writer that anything in this app
          calls: POST /api/forecasts exists but no screen posts to it, there is
          no PUT at all, and the seed array (src/lib/mock-data.ts) is empty. So
          `forecasts` is expected to be empty and every forecast figure below is
          absent rather than measured. Saying so once, at the top, is the point
          — the previous version filled the same space with 84.2%, a 220/month
          capacity line and a frozen 2026-05 window. BUG-2026-08-13-014. */}
      {forecasts.length === 0 && (
        <div className="rounded-md border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-xs text-[#7A5712]">
          <span className="font-semibold">No forecasts are recorded.</span>{" "}
          Nothing in the app writes <span className="font-mono">forecast_entries</span>,
          so the forecast columns and the accuracy KPI read “—”. The Historical
          and Promise-Date tabs are computed from real invoices and job cards
          and are unaffected.
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === t.key
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-gray-500 hover:text-[#1F1D1B]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "dashboard" && (
        <DashboardTab forecasts={forecasts} historicalSales={historicalSales} productList={productList} />
      )}
      {activeTab === "detail" && (
        <DetailTab
          forecasts={forecasts}
          historicalSales={historicalSales}
          productList={productList}
          selectedProductId={selectedProductId}
          setSelectedProductId={setSelectedProductId}
          selectedMethod={selectedMethod}
          setSelectedMethod={setSelectedMethod}
        />
      )}
      {activeTab === "accuracy" && (
        <AccuracyTab forecasts={forecasts} historicalSales={historicalSales} />
      )}
      {activeTab === "promise" && (
        <PromiseDateTab
          promiseDates={promiseDates}
          promiseProductId={promiseProductId}
          setPromiseProductId={setPromiseProductId}
        />
      )}
    </div>
  );
}

// ============ DASHBOARD TAB ============
function DashboardTab({
  forecasts,
  historicalSales,
  productList,
}: {
  forecasts: ForecastEntry[];
  historicalSales: HistoricalSales[];
  productList: { id: string; code: string; name: string }[];
}) {
  // Forecast accuracy: compare each forecast against the actual later recorded
  // against it.
  //
  // The `withActual.length === 0` branch used to return a literal accuracy of
  // 84.2, with a trailing comment that called it a mock, and that branch is
  // taken EVERY time:
  // `forecast_entries.actualQty` has no writer anywhere. POST /api/forecasts
  // inserts it as a literal NULL (src/api/routes/forecasts.ts) and there is no
  // PUT/PATCH on that table, so no row can ever carry one. Nothing in the app
  // even POSTs a forecast — this page is read-only. So "84.2%" was printed as
  // a 3xl KPI captioned "Based on historical comparison", forever, and the
  // `last3` count computed to justify that caption was discarded unused.
  // BUG-2026-08-13-014. `null` = unmeasurable; the card says which input is
  // missing.
  const accuracyData = useMemo((): { accuracy: number | null; count: number } => {
    const withActual = forecasts.filter((f) => f.actualQty !== null);
    if (withActual.length === 0) {
      return { accuracy: null, count: 0 };
    }
    const totalMape = withActual.reduce((sum, f) => {
      const actual = f.actualQty ?? 1;
      return sum + Math.abs(f.forecastQty - actual) / actual;
    }, 0);
    return { accuracy: Math.round((1 - totalMape / withActual.length) * 1000) / 10, count: withActual.length };
  }, [forecasts]);

  // Top growing product — last 3 MONTHS vs the prior 3 MONTHS. `byPeriod`
  // folds the per-customer rows first; without it `slice(-3)` could take three
  // customers out of a single month and call the result a quarter.
  const growthData = useMemo(() => {
    const results: { id: string; name: string; growth: number }[] = [];
    productList.forEach((p) => {
      const sales = byPeriod(historicalSales.filter((s) => s.productId === p.id));
      if (sales.length >= 6) {
        const recent3 = sales.slice(-3).reduce((s, v) => s + v.quantity, 0);
        const prior3 = sales.slice(-6, -3).reduce((s, v) => s + v.quantity, 0);
        const growth = prior3 > 0 ? ((recent3 - prior3) / prior3) * 100 : 0;
        results.push({ id: p.id, name: p.name, growth });
      }
    });
    return results.sort((a, b) => b.growth - a.growth);
  }, [productList, historicalSales]);

  const topGrowing = growthData[0];
  const atRiskProducts = growthData.filter((g) => g.growth < -5);

  // The next 6 months, rolling. This was a frozen literal array
  // `["2026-05" … "2026-10"]` under the title "6-Month Forecast vs Capacity" —
  // by today (2026-08) three of the six bars were already in the past.
  //
  // The capacity series is GONE. It was a `capacity` field set to the literal
  // 220, annotated as a units-per-month plant capacity, with a legend saying
  // so: a constant from no configuration, no table and no calculation, drawn as a
  // reference line the forecast was judged against. A real per-department
  // capacity does exist (`departments.workingHoursPerDay`, which
  // /api/promise-date divides by) but converting it to units/month needs a
  // per-product routing assumption that nobody has made. Publishing no line is
  // correct; publishing 220 was not. BUG-2026-08-13-014.
  const forecastMonths = useMemo(() => {
    return Array.from({ length: 6 }, (_, i) => periodFromNow(i)).map((m) => ({
      period: m,
      total: forecasts.filter((f) => f.period === m).reduce((s, f) => s + f.forecastQty, 0),
    }));
  }, [forecasts]);

  const maxBarVal = Math.max(...forecastMonths.map((m) => m.total), 1);

  // The "next forecast" column was pinned to the literal period "2026-05"
  // under a header that read "May Forecast". It follows the calendar now.
  const nextPeriod = periodFromNow(1);

  // Products table with trend
  const productTrends = useMemo(() => {
    return productList.map((p) => {
      const sales = byPeriod(historicalSales.filter((s) => s.productId === p.id));
      const last3Avg = sales.length >= 3 ? sales.slice(-3).reduce((s, v) => s + v.quantity, 0) / 3 : 0;
      const prior3Avg = sales.length >= 6 ? sales.slice(-6, -3).reduce((s, v) => s + v.quantity, 0) / 3 : 0;
      const nextForecast = forecasts.find((f) => f.productId === p.id && f.period === nextPeriod);
      const trend = prior3Avg > 0 ? ((last3Avg - prior3Avg) / prior3Avg) * 100 : 0;
      return {
        ...p,
        // `null` where there is nothing to average / nothing forecast, so the
        // cell reads "—". `nextForecast?.forecastQty ?? 0` and
        // `?.confidence ?? 0` printed a hard 0 and a red "0%" confidence badge
        // for every product, which reads as a measured collapse in demand
        // rather than as an absent forecast.
        last3Avg: sales.length >= 3 ? Math.round(last3Avg) : null,
        nextForecast: nextForecast ? nextForecast.forecastQty : null,
        confidence: nextForecast ? nextForecast.confidence : null,
        trend: sales.length >= 6 ? trend : null,
      };
    });
  }, [productList, historicalSales, forecasts, nextPeriod]);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Forecast Accuracy</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-[#1F1D1B]">
              {accuracyData.accuracy === null ? NO_FIGURE : `${accuracyData.accuracy}%`}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {accuracyData.accuracy === null
                ? "No forecast has an actual recorded against it, so accuracy cannot be measured."
                : `From ${accuracyData.count} forecast${accuracyData.count === 1 ? "" : "s"} with a recorded actual`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Top Growing Product</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-[#1F1D1B]">{topGrowing?.name ?? NO_FIGURE}</div>
            <p className="text-xs mt-1">
              {topGrowing ? (
                // The "+" used to be hardcoded into the string, so the leader
                // of a shrinking catalogue rendered as "+-12.3% growth".
                <span
                  className={
                    topGrowing.growth >= 0
                      ? "text-[#4F7C3A] font-medium"
                      : "text-[#9A3A2D] font-medium"
                  }
                >
                  {topGrowing.growth >= 0 ? "+" : ""}
                  {topGrowing.growth.toFixed(1)}% growth
                </span>
              ) : (
                <span className="text-gray-500">
                  Needs 6 months of sales history for at least one product
                </span>
              )}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">At-Risk Products</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-[#1F1D1B]">{atRiskProducts.length}</div>
            <p className="text-xs text-gray-500 mt-1">Declining demand ({">"}5% drop)</p>
          </CardContent>
        </Card>
      </div>

      {/* Bar chart: next 6 months of forecast. No capacity series — see the
          comment on forecastMonths. */}
      <Card>
        <CardHeader>
          <CardTitle>6-Month Forecast</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3 h-48">
            {forecastMonths.map((m) => (
              <div key={m.period} className="flex-1 flex flex-col items-center gap-1">
                <div className="relative w-full flex gap-1 items-end justify-center" style={{ height: "160px" }}>
                  <div
                    className="w-5 bg-[#6B5C32] rounded-t transition-all"
                    style={{ height: `${(m.total / maxBarVal) * 160}px` }}
                    title={`Forecast: ${m.total}`}
                  />
                </div>
                <span className="text-[10px] text-gray-500">{m.period.slice(5)}</span>
                <span className="text-[10px] font-medium">{m.total}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 mt-3 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-[#6B5C32]" /> Forecast
            </span>
            <span>
              No production-capacity line: there is no per-month unit capacity
              recorded anywhere to draw one from.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Products table */}
      <Card>
        <CardHeader>
          <CardTitle>Product Forecast Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Product</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Code</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">3M Avg</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">
                    {nextPeriod} Forecast
                  </th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Confidence</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Trend</th>
                </tr>
              </thead>
              <tbody>
                {productTrends.map((p) => (
                  <tr key={p.id} className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50">
                    <td className="py-2 px-3 font-medium">{p.name}</td>
                    <td className="py-2 px-3 text-gray-500">{p.code}</td>
                    <td className="py-2 px-3 text-right">
                      {p.last3Avg === null ? NO_FIGURE : formatNumber(p.last3Avg)}
                    </td>
                    <td className="py-2 px-3 text-right font-medium">
                      {p.nextForecast === null ? NO_FIGURE : formatNumber(p.nextForecast)}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {p.confidence === null ? (
                        <span className="text-gray-400">{NO_FIGURE}</span>
                      ) : (
                        <Badge className={p.confidence >= 75 ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]" : p.confidence >= 60 ? "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]" : "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]"}>
                          {p.confidence}%
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {p.trend === null ? (
                        <span className="text-gray-400">{NO_FIGURE}</span>
                      ) : (
                        <span className={p.trend >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}>
                          {p.trend >= 0 ? "\u2191" : "\u2193"} {Math.abs(p.trend).toFixed(1)}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============ DETAIL TAB ============
function DetailTab({
  forecasts,
  historicalSales,
  productList,
  selectedProductId,
  setSelectedProductId,
  selectedMethod,
  setSelectedMethod,
}: {
  forecasts: ForecastEntry[];
  historicalSales: HistoricalSales[];
  productList: { id: string; code: string; name: string }[];
  selectedProductId: string;
  setSelectedProductId: (id: string) => void;
  selectedMethod: "SMA_3" | "SMA_6" | "WMA";
  setSelectedMethod: (m: "SMA_3" | "SMA_6" | "WMA") => void;
}) {
  // One row per MONTH (see byPeriod) — the moving averages below index rows as
  // if they were consecutive months, and historical_sales rows are per
  // customer.
  const sales = useMemo(
    () => byPeriod(historicalSales.filter((s) => s.productId === selectedProductId)),
    [historicalSales, selectedProductId]
  );

  const productForecasts = useMemo(
    () =>
      forecasts
        .filter((f) => f.productId === selectedProductId)
        .sort((a, b) => a.period.localeCompare(b.period)),
    [forecasts, selectedProductId]
  );

  // Calculate moving averages from historical data
  const movingAverages = useMemo(() => {
    const quantities = sales.map((s) => s.quantity);
    const result: { period: string; sma3: number | null; sma6: number | null; wma: number | null }[] = [];

    sales.forEach((s, i) => {
      let sma3: number | null = null;
      let sma6: number | null = null;
      let wma: number | null = null;

      if (i >= 2) {
        sma3 = Math.round((quantities[i] + quantities[i - 1] + quantities[i - 2]) / 3);
      }
      if (i >= 5) {
        sma6 = Math.round(quantities.slice(i - 5, i + 1).reduce((a, b) => a + b, 0) / 6);
      }
      if (i >= 2) {
        // WMA: weights 3,2,1 for most recent
        wma = Math.round((quantities[i] * 3 + quantities[i - 1] * 2 + quantities[i - 2] * 1) / 6);
      }

      result.push({ period: s.period, sma3, sma6, wma });
    });
    return result;
  }, [sales]);

  // Combined timeline
  const allPeriods = useMemo(() => {
    const periods: { period: string; actual: number | null; forecast: number | null; maValue: number | null }[] = [];
    sales.forEach((s) => {
      const ma = movingAverages.find((m) => m.period === s.period);
      const maVal = ma ? (selectedMethod === "SMA_3" ? ma.sma3 : selectedMethod === "SMA_6" ? ma.sma6 : ma.wma) : null;
      periods.push({ period: s.period, actual: s.quantity, forecast: null, maValue: maVal });
    });
    productForecasts.forEach((f) => {
      periods.push({ period: f.period, actual: null, forecast: f.forecastQty, maValue: null });
    });
    return periods;
  }, [sales, productForecasts, movingAverages, selectedMethod]);

  const maxQty = Math.max(...allPeriods.map((p) => Math.max(p.actual ?? 0, p.forecast ?? 0, p.maValue ?? 0)), 1);
  const selectedProduct = productList.find((p) => p.id === selectedProductId);

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Product</label>
          <select
            value={selectedProductId}
            onChange={(e) => setSelectedProductId(e.target.value)}
            className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
          >
            {productList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} - {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Method</label>
          <div className="flex gap-1">
            {(["SMA_3", "SMA_6", "WMA"] as const).map((m) => (
              <Button
                key={m}
                variant={selectedMethod === m ? "primary" : "outline"}
                size="sm"
                onClick={() => setSelectedMethod(m)}
              >
                {m === "SMA_3" ? "SMA-3" : m === "SMA_6" ? "SMA-6" : "WMA"}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Timeline chart */}
      <Card>
        <CardHeader>
          <CardTitle>
            {selectedProduct?.name ?? "Product"} — 12M Historical + 6M Forecast
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-1 h-52 overflow-x-auto">
            {allPeriods.map((p) => (
              <div key={p.period} className="flex-1 min-w-[36px] flex flex-col items-center gap-0.5">
                <div className="relative w-full flex items-end justify-center gap-px" style={{ height: "180px" }}>
                  {p.actual !== null && (
                    <div
                      className="w-4 bg-[#6B5C32] rounded-t"
                      style={{ height: `${(p.actual / maxQty) * 170}px` }}
                      title={`Actual: ${p.actual}`}
                    />
                  )}
                  {p.forecast !== null && (
                    <div
                      className="w-4 bg-[#6B5C32]/40 rounded-t border-2 border-dashed border-[#6B5C32]"
                      style={{ height: `${(p.forecast / maxQty) * 170}px` }}
                      title={`Forecast: ${p.forecast}`}
                    />
                  )}
                  {p.maValue !== null && (
                    <div
                      className="absolute bottom-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-[#9A3A2D]"
                      style={{ bottom: `${(p.maValue / maxQty) * 170}px` }}
                      title={`${selectedMethod}: ${p.maValue}`}
                    />
                  )}
                </div>
                <span className="text-[9px] text-gray-500 -rotate-45 origin-top-left whitespace-nowrap mt-1">
                  {p.period.slice(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 mt-4 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-[#6B5C32]" /> Actual
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-[#6B5C32]/40 border border-dashed border-[#6B5C32]" /> Forecast
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#9A3A2D]" /> {selectedMethod.replace("_", "-")} Line
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Data table */}
      <Card>
        <CardHeader>
          <CardTitle>Monthly Data</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Period</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Actual Qty</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Forecast Qty</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Revenue</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">{selectedMethod.replace("_", "-")}</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => {
                  const ma = movingAverages.find((m) => m.period === s.period);
                  const maVal = ma ? (selectedMethod === "SMA_3" ? ma.sma3 : selectedMethod === "SMA_6" ? ma.sma6 : ma.wma) : null;
                  return (
                    <tr key={s.period} className="border-b border-[#E2DDD8]">
                      <td className="py-2 px-3">{s.period}</td>
                      <td className="py-2 px-3 text-right font-medium">{formatNumber(s.quantity)}</td>
                      <td className="py-2 px-3 text-right text-gray-400">-</td>
                      <td className="py-2 px-3 text-right">{formatCurrency(s.revenue)}</td>
                      <td className="py-2 px-3 text-right">{maVal !== null ? formatNumber(maVal) : "-"}</td>
                    </tr>
                  );
                })}
                {productForecasts.map((f) => (
                  <tr key={f.period} className="border-b border-[#E2DDD8] bg-[#F0ECE9]/30">
                    <td className="py-2 px-3">
                      {f.period} <Badge>Forecast</Badge>
                    </td>
                    <td className="py-2 px-3 text-right text-gray-400">-</td>
                    <td className="py-2 px-3 text-right font-medium">{formatNumber(f.forecastQty)}</td>
                    <td className="py-2 px-3 text-right text-gray-400">-</td>
                    <td className="py-2 px-3 text-right text-gray-400">-</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============ ACCURACY TAB ============
function AccuracyTab({
  forecasts: _forecasts,
  historicalSales,
}: {
  forecasts: ForecastEntry[];
  historicalSales: HistoricalSales[];
}) {
  // This tab is a BACK-TEST, not a record of what the business forecast.
  //
  // No forecast ever existed for these periods (`_forecasts` is unused, and
  // nothing writes forecast_entries). Each "forecast" is the SMA-3 of the three
  // months before it, computed here, now, from the very actuals it is then
  // scored against. That is a legitimate way to test a method — it is not
  // "Forecast vs Actual", which is what the card, the KPI and the column
  // headers used to call it. The captions now say back-test, so the number
  // means what it says. BUG-2026-08-13-014.
  const comparisonData = useMemo(() => {
    const productIds = [...new Set(historicalSales.map((s) => s.productId))];
    const nameById = new Map<string, { name: string; code: string }>();
    for (const s of historicalSales) {
      if (!nameById.has(s.productId))
        nameById.set(s.productId, { name: s.productName, code: s.productCode });
    }
    const rows: {
      period: string;
      productName: string;
      productCode: string;
      forecastQty: number;
      actualQty: number;
      variance: number;
      mape: number;
    }[] = [];

    productIds.forEach((pid) => {
      // Per MONTH, not per customer-month — otherwise the "prior 3 months"
      // window can be three customers inside one month.
      const sales = byPeriod(historicalSales.filter((s) => s.productId === pid));
      const meta = nameById.get(pid) ?? { name: "", code: "" };

      for (let i = 3; i < sales.length; i++) {
        const forecastQty = Math.round(
          (sales[i - 1].quantity + sales[i - 2].quantity + sales[i - 3].quantity) / 3
        );
        const actualQty = sales[i].quantity;
        const variance = forecastQty - actualQty;
        // A month with zero actual has no percentage error — it is excluded
        // from the average rather than scored as a perfect 0% miss, which is
        // what `actualQty > 0 ? … : 0` did.
        const mape = actualQty > 0 ? Math.round((Math.abs(variance) / actualQty) * 1000) / 10 : null;

        rows.push({
          period: sales[i].period,
          productName: meta.name,
          productCode: meta.code,
          forecastQty,
          actualQty,
          variance,
          mape: mape ?? Number.NaN,
        });
      }
    });

    return rows.sort((a, b) => b.period.localeCompare(a.period) || a.productName.localeCompare(b.productName));
  }, [historicalSales]);

  // `null` when there is nothing to average. It used to return 0, and the card
  // below then printed `100 - 0 = 100%` — a perfect score off an empty set,
  // which is exactly what an empty forecast_entries table produces.
  const overallMape = useMemo((): number | null => {
    const scored = comparisonData.filter((r) => Number.isFinite(r.mape));
    if (scored.length === 0) return null;
    const total = scored.reduce((s, r) => s + r.mape, 0);
    return Math.round((total / scored.length) * 10) / 10;
  }, [comparisonData]);

  const overallAccuracy =
    overallMape === null ? null : Math.round((100 - overallMape) * 10) / 10;
  const scoredCount = comparisonData.filter((r) => Number.isFinite(r.mape)).length;

  function getMapeColor(mape: number): string {
    if (mape < 10) return "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]";
    if (mape < 20) return "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]";
    return "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]";
  }

  return (
    <div className="space-y-6">
      {/* Overall accuracy score */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              SMA-3 Back-test Accuracy
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-[#1F1D1B]">
              {overallAccuracy === null ? NO_FIGURE : `${overallAccuracy}%`}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {overallAccuracy === null
                ? "No month has both a prior 3-month window and a non-zero actual."
                : "100% − average MAPE, over months replayed from history"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Average MAPE</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-[#1F1D1B]">
              {overallMape === null ? NO_FIGURE : `${overallMape}%`}
            </div>
            <p className="text-xs text-gray-500 mt-1">Mean Absolute Percentage Error</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Data Points</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-[#1F1D1B]">{scoredCount}</div>
            <p className="text-xs text-gray-500 mt-1">
              Months replayed against their own prior 3 months
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Comparison table */}
      <Card>
        <CardHeader>
          <CardTitle>SMA-3 Back-test vs Actual</CardTitle>
          <p className="text-xs text-gray-500 mt-1">
            The “SMA-3” column is not a forecast the business made — no forecast
            exists for these months. It is the average of the three months
            before each row, computed now from this same history.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Period</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Product</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">SMA-3 (back-test)</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Actual Qty</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Variance</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">MAPE %</th>
                </tr>
              </thead>
              <tbody>
                {comparisonData.map((r, i) => (
                  <tr key={`${r.period}-${r.productCode}-${i}`} className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50">
                    <td className="py-2 px-3">{r.period}</td>
                    <td className="py-2 px-3">
                      <span className="font-medium">{r.productName}</span>
                      <span className="text-gray-400 ml-1 text-xs">({r.productCode})</span>
                    </td>
                    <td className="py-2 px-3 text-right">{formatNumber(r.forecastQty)}</td>
                    <td className="py-2 px-3 text-right font-medium">{formatNumber(r.actualQty)}</td>
                    <td className="py-2 px-3 text-right">
                      <span className={r.variance >= 0 ? "text-[#9C6F1E]" : "text-[#3E6570]"}>
                        {r.variance >= 0 ? "+" : ""}{r.variance}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right">
                      {Number.isFinite(r.mape) ? (
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${getMapeColor(r.mape)}`}>
                          {r.mape}%
                        </span>
                      ) : (
                        <span className="text-gray-400" title="Actual was zero — no percentage error is defined">
                          {NO_FIGURE}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============ PROMISE DATE TAB ============
function PromiseDateTab({
  promiseDates,
  promiseProductId,
  setPromiseProductId,
}: {
  promiseDates: PromiseDateEnriched[];
  promiseProductId: string;
  setPromiseProductId: (id: string) => void;
}) {
  const selected = promiseDates.find((p) => p.productId === promiseProductId);

  const availabilityColor: Record<string, string> = {
    IN_STOCK: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]",
    PARTIAL: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]",
    NEED_ORDER: "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]",
  };

  return (
    <div className="space-y-6">
      {/* Product selector */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Select Product</label>
        <select
          value={promiseProductId}
          onChange={(e) => setPromiseProductId(e.target.value)}
          className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
        >
          {promiseDates.map((p) => (
            <option key={p.productId} value={p.productId}>
              {p.productCode} - {p.productName}
            </option>
          ))}
        </select>
      </div>

      {selected && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Current Queue</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold text-[#1F1D1B]">{selected.currentQueueDays} days</div>
                <p className="text-xs text-gray-500 mt-1">Orders ahead in production</p>
              </CardContent>
            </Card>

            {/* This card used to be captioned "Material Status" beside the
                selected product, but /api/promise-date computes ONE reading of
                the whole raw_materials table and stamps it on every product —
                no BOM is consulted. It is the same value for every row, so it
                is now labelled as the org-wide figure it is. The per-product
                answer would come from the BOM-driven /api/mrp check.
                BUG-2026-08-13-014. */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">
                  Raw Materials (all products)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <span
                  className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium border ${
                    availabilityColor[selected.orgMaterialAvailability] ?? ""
                  }`}
                >
                  {selected.orgMaterialAvailability.replace(/_/g, " ")}
                </span>
                <p className="text-xs text-gray-500 mt-1">
                  Whole-warehouse reading — not specific to this product
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Est. Completion</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold text-[#1F1D1B]">{selected.estimatedCompletionDays} days</div>
                <p className="text-xs text-gray-500 mt-1">Queue + production + materials</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Promise Date</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-[#6B5C32]">{selected.promiseDate}</div>
                <p className="text-xs text-gray-500 mt-1">Earliest delivery to customer</p>
              </CardContent>
            </Card>
          </div>

          {/* Department queue visualization */}
          <Card>
            <CardHeader>
              <CardTitle>Department Production Pipeline</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {(selected.departments ?? []).map((dept) => {
                  const maxMin = Math.max(...(selected.departments ?? []).map((d) => d.minutesPerUnit), 1);
                  const widthPct = (dept.minutesPerUnit / maxMin) * 100;
                  return (
                    <div key={dept.departmentCode} className="flex items-center gap-3">
                      <div className="w-32 text-sm text-gray-600 truncate">{dept.departmentName}</div>
                      <div className="flex-1 bg-[#F0ECE9] rounded-full h-6 overflow-hidden">
                        <div
                          className="h-full bg-[#6B5C32] rounded-full flex items-center justify-end pr-2 transition-all"
                          style={{ width: `${widthPct}%` }}
                        >
                          <span className="text-[10px] text-white font-medium">{dept.minutesPerUnit}m</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* All products summary */}
          <Card>
            <CardHeader>
              <CardTitle>All Products Promise Date Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8]">
                      <th className="text-left py-2 px-3 font-medium text-gray-500">Product</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-500">Queue (days)</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-500">Est. Days</th>
                      <th className="text-left py-2 px-3 font-medium text-gray-500">Promise Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promiseDates.map((p) => (
                      <tr
                        key={p.productId}
                        className={`border-b border-[#E2DDD8] cursor-pointer hover:bg-[#F0ECE9]/50 ${
                          p.productId === promiseProductId ? "bg-[#F0ECE9]" : ""
                        }`}
                        onClick={() => setPromiseProductId(p.productId)}
                      >
                        <td className="py-2 px-3">
                          <span className="font-medium">{p.productName}</span>
                          <span className="text-gray-400 ml-1 text-xs">({p.productCode})</span>
                        </td>
                        <td className="py-2 px-3 text-right">{p.currentQueueDays}</td>
                        {/* The "Materials" column is gone: every row carried
                            the identical whole-org reading, so as a per-product
                            column it was pure noise. BUG-2026-08-13-014. */}
                        <td className="py-2 px-3 text-right font-medium">{p.estimatedCompletionDays}</td>
                        <td className="py-2 px-3 font-medium text-[#6B5C32]">{p.promiseDate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
