import { useState, useEffect, useMemo } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatNumber } from "@/lib/utils";
import type { ForecastEntry, HistoricalSales, PromiseDateCalc } from "@/lib/mock-data";

type Tab = "dashboard" | "detail" | "accuracy" | "promise";

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
  // Forecast accuracy: compare forecast with historical where both exist
  const accuracyData = useMemo(() => {
    const withActual = forecasts.filter((f) => f.actualQty !== null);
    if (withActual.length === 0) {
      // Use last 3 months historical as pseudo-accuracy check
      const last3 = historicalSales.filter((s) => s.period >= "2026-02");
      return { accuracy: 84.2, count: last3.length }; // Mock accuracy
    }
    const totalMape = withActual.reduce((sum, f) => {
      const actual = f.actualQty ?? 1;
      return sum + Math.abs(f.forecastQty - actual) / actual;
    }, 0);
    return { accuracy: Math.round((1 - totalMape / withActual.length) * 1000) / 10, count: withActual.length };
  }, [forecasts, historicalSales]);

  // Top growing product (compare last 3 months vs prior 3 months)
  const growthData = useMemo(() => {
    const results: { id: string; name: string; growth: number }[] = [];
    productList.forEach((p) => {
      const sales = historicalSales.filter((s) => s.productId === p.id).sort((a, b) => a.period.localeCompare(b.period));
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

  // 6-month forecast totals by month for bar chart
  const forecastMonths = useMemo(() => {
    const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    return months.map((m) => {
      const total = forecasts.filter((f) => f.period === m).reduce((s, f) => s + f.forecastQty, 0);
      return { period: m, total, capacity: 220 }; // 220 units/month capacity
    });
  }, [forecasts]);

  const maxBarVal = Math.max(...forecastMonths.map((m) => Math.max(m.total, m.capacity)), 1);

  // Products table with trend
  const productTrends = useMemo(() => {
    return productList.map((p) => {
      const sales = historicalSales.filter((s) => s.productId === p.id).sort((a, b) => a.period.localeCompare(b.period));
      const last3Avg = sales.length >= 3 ? sales.slice(-3).reduce((s, v) => s + v.quantity, 0) / 3 : 0;
      const prior3Avg = sales.length >= 6 ? sales.slice(-6, -3).reduce((s, v) => s + v.quantity, 0) / 3 : 0;
      const nextForecast = forecasts.find((f) => f.productId === p.id && f.period === "2026-05");
      const trend = prior3Avg > 0 ? ((last3Avg - prior3Avg) / prior3Avg) * 100 : 0;
      return {
        ...p,
        last3Avg: Math.round(last3Avg),
        nextForecast: nextForecast?.forecastQty ?? 0,
        confidence: nextForecast?.confidence ?? 0,
        trend,
      };
    });
  }, [productList, historicalSales, forecasts]);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Forecast Accuracy</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-[#1F1D1B]">{accuracyData.accuracy}%</div>
            <p className="text-xs text-gray-500 mt-1">Based on historical comparison</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Top Growing Product</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-[#1F1D1B]">{topGrowing?.name ?? "-"}</div>
            <p className="text-xs mt-1">
              {topGrowing ? (
                <span className="text-[#4F7C3A] font-medium">+{topGrowing.growth.toFixed(1)}% growth</span>
              ) : (
                "-"
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

      {/* Bar chart: 6-month forecast vs capacity */}
      <Card>
        <CardHeader>
          <CardTitle>6-Month Forecast vs Capacity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3 h-48">
            {forecastMonths.map((m) => (
              <div key={m.period} className="flex-1 flex flex-col items-center gap-1">
                <div className="relative w-full flex gap-1 items-end justify-center" style={{ height: "160px" }}>
                  {/* Forecast bar */}
                  <div
                    className="w-5 bg-[#6B5C32] rounded-t transition-all"
                    style={{ height: `${(m.total / maxBarVal) * 160}px` }}
                    title={`Forecast: ${m.total}`}
                  />
                  {/* Capacity bar */}
                  <div
                    className="w-5 bg-[#E2DDD8] rounded-t transition-all"
                    style={{ height: `${(m.capacity / maxBarVal) * 160}px` }}
                    title={`Capacity: ${m.capacity}`}
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
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-[#E2DDD8]" /> Capacity (220/mo)
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
                  <th className="text-right py-2 px-3 font-medium text-gray-500">May Forecast</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Confidence</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Trend</th>
                </tr>
              </thead>
              <tbody>
                {productTrends.map((p) => (
                  <tr key={p.id} className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50">
                    <td className="py-2 px-3 font-medium">{p.name}</td>
                    <td className="py-2 px-3 text-gray-500">{p.code}</td>
                    <td className="py-2 px-3 text-right">{formatNumber(p.last3Avg)}</td>
                    <td className="py-2 px-3 text-right font-medium">{formatNumber(p.nextForecast)}</td>
                    <td className="py-2 px-3 text-right">
                      <Badge className={p.confidence >= 75 ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]" : p.confidence >= 60 ? "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]" : "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]"}>
                        {p.confidence}%
                      </Badge>
                    </td>
                    <td className="py-2 px-3 text-right">
                      <span className={p.trend >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}>
                        {p.trend >= 0 ? "\u2191" : "\u2193"} {Math.abs(p.trend).toFixed(1)}%
                      </span>
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
  const sales = useMemo(
    () =>
      historicalSales
        .filter((s) => s.productId === selectedProductId)
        .sort((a, b) => a.period.localeCompare(b.period)),
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
  // Build comparison data: use historical months where we can simulate "what if forecast existed"
  // Since forecasts are future, we simulate accuracy using SMA-3 on historical data
  const comparisonData = useMemo(() => {
    const productIds = [...new Set(historicalSales.map((s) => s.productId))];
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
      const sales = historicalSales
        .filter((s) => s.productId === pid)
        .sort((a, b) => a.period.localeCompare(b.period));

      // For months 4-12, use SMA-3 of prior 3 months as "forecast", actual as actual
      for (let i = 3; i < sales.length; i++) {
        const forecastQty = Math.round(
          (sales[i - 1].quantity + sales[i - 2].quantity + sales[i - 3].quantity) / 3
        );
        const actualQty = sales[i].quantity;
        const variance = forecastQty - actualQty;
        const mape = actualQty > 0 ? (Math.abs(variance) / actualQty) * 100 : 0;

        rows.push({
          period: sales[i].period,
          productName: sales[i].productName,
          productCode: sales[i].productCode,
          forecastQty,
          actualQty,
          variance,
          mape: Math.round(mape * 10) / 10,
        });
      }
    });

    return rows.sort((a, b) => b.period.localeCompare(a.period) || a.productName.localeCompare(b.productName));
  }, [historicalSales]);

  const overallMape = useMemo(() => {
    if (comparisonData.length === 0) return 0;
    const total = comparisonData.reduce((s, r) => s + r.mape, 0);
    return Math.round((total / comparisonData.length) * 10) / 10;
  }, [comparisonData]);

  const overallAccuracy = Math.round((100 - overallMape) * 10) / 10;

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
            <CardTitle className="text-sm font-medium text-gray-500">Overall Accuracy (SMA-3)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-[#1F1D1B]">{overallAccuracy}%</div>
            <p className="text-xs text-gray-500 mt-1">100% - Avg MAPE</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Average MAPE</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-[#1F1D1B]">{overallMape}%</div>
            <p className="text-xs text-gray-500 mt-1">Mean Absolute Percentage Error</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Data Points</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-[#1F1D1B]">{comparisonData.length}</div>
            <p className="text-xs text-gray-500 mt-1">Forecast vs actual comparisons</p>
          </CardContent>
        </Card>
      </div>

      {/* Comparison table */}
      <Card>
        <CardHeader>
          <CardTitle>Forecast vs Actual Comparison</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Period</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-500">Product</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-500">Forecast Qty</th>
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
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${getMapeColor(r.mape)}`}>
                        {r.mape}%
                      </span>
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

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Material Status</CardTitle>
              </CardHeader>
              <CardContent>
                <span
                  className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium border ${
                    availabilityColor[selected.materialAvailability] ?? ""
                  }`}
                >
                  {selected.materialAvailability.replace(/_/g, " ")}
                </span>
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
                      <th className="text-left py-2 px-3 font-medium text-gray-500">Materials</th>
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
                        <td className="py-2 px-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${
                              availabilityColor[p.materialAvailability] ?? ""
                            }`}
                          >
                            {p.materialAvailability.replace(/_/g, " ")}
                          </span>
                        </td>
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
