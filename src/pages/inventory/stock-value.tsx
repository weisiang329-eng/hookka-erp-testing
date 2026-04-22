import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import {
  Calculator,
  LayoutDashboard,
  FileText,
  Download,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Package,
  Layers,
  Boxes,
  CheckCircle2,
} from "lucide-react";
import type { MonthlyStockValue, StockAccount } from "@/lib/mock-data";

// =============== TYPES ===============

type TabKey = "entry" | "dashboard" | "reports";

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "entry", label: "Stock Value Entry", icon: <Calculator className="h-4 w-4" /> },
  { key: "dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
  { key: "reports", label: "Reports", icon: <FileText className="h-4 w-4" /> },
];

// =============== HELPERS ===============

function getCategoryLabel(cat: string) {
  switch (cat) {
    case "FG": return "Finished Goods";
    case "WIP": return "Work-in-Progress";
    case "RAW_MATERIAL": return "Raw Material";
    default: return cat;
  }
}

function getCategoryBadgeClass(cat: string) {
  switch (cat) {
    case "FG": return "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]";
    case "WIP": return "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]";
    case "RAW_MATERIAL": return "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]";
    default: return "bg-gray-100 text-gray-600 border-gray-300";
  }
}

function getAvailablePeriods(): string[] {
  const periods: string[] = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return periods;
}

function periodLabel(period: string) {
  const [y, m] = period.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
}

// =============== MAIN PAGE ===============

export default function StockValuePage() {
  const [tab, setTab] = useState<TabKey>("entry");
  const [accounts, setAccounts] = useState<StockAccount[]>([]);
  const [stockValues, setStockValues] = useState<MonthlyStockValue[]>([]);
  const [allStockValues, setAllStockValues] = useState<MonthlyStockValue[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [loading, setLoading] = useState(true);

  const fetchAccounts = useCallback(async () => {
    const res = await fetch("/api/stock-accounts");
    const data = await res.json();
    if (data.success) setAccounts(data.data);
  }, []);

  const fetchStockValues = useCallback(async (period?: string) => {
    const url = period ? `/api/stock-value?period=${period}` : "/api/stock-value";
    const res = await fetch(url);
    const data = await res.json();
    if (data.success) {
      if (period) {
        setStockValues(data.data);
      } else {
        setAllStockValues(data.data);
      }
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      fetchAccounts(),
      fetchStockValues(selectedPeriod),
      fetchStockValues(),
    ]);
    setLoading(false);
  }, [fetchAccounts, fetchStockValues, selectedPeriod]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handlePeriodChange = async (period: string) => {
    setSelectedPeriod(period);
    setLoading(true);
    await fetchStockValues(period);
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Monthly Stock Value</h1>
          <p className="text-xs text-[#6B7280]">
            Stock account valuation and monthly closing (AutoCount 330-xxxx series)
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              tab === t.key
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-[#6B7280] hover:text-[#1F1D1B] hover:border-[#E2DDD8]"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-[#6B7280]">Loading stock value data...</div>
        </div>
      ) : (
        <>
          {tab === "entry" && (
            <EntryTab
              accounts={accounts}
              stockValues={stockValues}
              selectedPeriod={selectedPeriod}
              onPeriodChange={handlePeriodChange}
              onRefresh={fetchAll}
            />
          )}
          {tab === "dashboard" && (
            <DashboardTab
              allStockValues={allStockValues}
              selectedPeriod={selectedPeriod}
            />
          )}
          {tab === "reports" && (
            <ReportsTab
              allStockValues={allStockValues}
              selectedPeriod={selectedPeriod}
              onPeriodChange={handlePeriodChange}
            />
          )}
        </>
      )}
    </div>
  );
}

// =============== TAB 1: STOCK VALUE ENTRY ===============

function EntryTab({
  accounts,
  stockValues,
  selectedPeriod,
  onPeriodChange,
  onRefresh,
}: {
  accounts: StockAccount[];
  stockValues: MonthlyStockValue[];
  selectedPeriod: string;
  onPeriodChange: (period: string) => void;
  onRefresh: () => void;
}) {
  const [editingPhysical, setEditingPhysical] = useState<Record<string, string>>({});
  const [posting, setPosting] = useState(false);
  const [initializingMonth, setInitializingMonth] = useState(false);

  // Build display rows: merge accounts with stock values
  const rows = accounts.map((acct) => {
    const sv = stockValues.find((v) => v.accountCode === acct.code);
    return { account: acct, value: sv ?? null };
  });

  const handlePhysicalChange = (id: string, val: string) => {
    setEditingPhysical((prev) => ({ ...prev, [id]: val }));
  };

  const handlePhysicalBlur = async (sv: MonthlyStockValue) => {
    const rawVal = editingPhysical[sv.id];
    if (rawVal === undefined) return;

    const senValue = Math.round(parseFloat(rawVal) * 100);
    if (isNaN(senValue)) {
      setEditingPhysical((prev) => {
        const next = { ...prev };
        delete next[sv.id];
        return next;
      });
      return;
    }

    await fetch(`/api/stock-value/${sv.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ physicalCountValue: senValue }),
    });

    setEditingPhysical((prev) => {
      const next = { ...prev };
      delete next[sv.id];
      return next;
    });
    onRefresh();
  };

  const handlePostAll = async () => {
    setPosting(true);
    const draftEntries = stockValues.filter((v) => v.status === "DRAFT");
    const now = new Date().toISOString();

    await Promise.all(
      draftEntries.map((sv) =>
        fetch(`/api/stock-value/${sv.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "POSTED",
            postedDate: now,
            postedBy: "Current User",
          }),
        })
      )
    );
    setPosting(false);
    onRefresh();
  };

  const handleInitializeMonth = async () => {
    setInitializingMonth(true);
    await fetch("/api/stock-value", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period: selectedPeriod }),
    });
    setInitializingMonth(false);
    onRefresh();
  };

  const hasDraftEntries = stockValues.some((v) => v.status === "DRAFT");
  const hasEntries = stockValues.length > 0;

  return (
    <div className="space-y-4">
      {/* Period selector + action buttons */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-[#1F1D1B]">Period:</label>
          <select
            value={selectedPeriod}
            onChange={(e) => onPeriodChange(e.target.value)}
            className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
          >
            {getAvailablePeriods().map((p) => (
              <option key={p} value={p}>
                {periodLabel(p)}
              </option>
            ))}
          </select>
          {hasEntries && (
            <Badge variant="status" status={stockValues[0]?.status ?? "DRAFT"}>
              {stockValues[0]?.status ?? "DRAFT"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!hasEntries && (
            <Button
              variant="primary"
              onClick={handleInitializeMonth}
              disabled={initializingMonth}
            >
              {initializingMonth ? "Initializing..." : "Initialize Month"}
            </Button>
          )}
          {hasDraftEntries && (
            <Button
              variant="primary"
              onClick={handlePostAll}
              disabled={posting}
            >
              <CheckCircle2 className="h-4 w-4" />
              {posting ? "Posting..." : "Calculate & Post"}
            </Button>
          )}
        </div>
      </div>

      {!hasEntries ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center text-[#6B7280]">
              <Calculator className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-lg font-medium">No entries for {periodLabel(selectedPeriod)}</p>
              <p className="text-sm mt-1">Click &quot;Initialize Month&quot; to create stock value entries for this period.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                    <th className="text-left px-4 py-3 font-medium text-[#1F1D1B]">Account Code</th>
                    <th className="text-left px-4 py-3 font-medium text-[#1F1D1B]">Description</th>
                    <th className="text-left px-4 py-3 font-medium text-[#1F1D1B]">Category</th>
                    <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Opening</th>
                    <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Purchases</th>
                    <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Consumption</th>
                    <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Closing</th>
                    <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Physical Count</th>
                    <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Variance %</th>
                    <th className="text-center px-4 py-3 font-medium text-[#1F1D1B]">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ account, value }) => {
                    const isEditable = value?.status === "DRAFT";
                    const varianceExceedsThreshold =
                      value?.variancePercent !== null &&
                      value?.variancePercent !== undefined &&
                      Math.abs(value.variancePercent) > 3;

                    return (
                      <tr
                        key={account.code}
                        className="border-b border-[#E2DDD8] last:border-b-0 hover:bg-[#F0ECE9]/30 transition-colors"
                      >
                        <td className="px-4 py-3 font-mono text-xs">{account.code}</td>
                        <td className="px-4 py-3">{account.description}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${getCategoryBadgeClass(
                              account.category
                            )}`}
                          >
                            {getCategoryLabel(account.category)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {value ? formatCurrency(value.openingValue) : "-"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {value ? formatCurrency(value.purchasesValue) : "-"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {value ? formatCurrency(value.consumptionValue) : "-"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs font-semibold">
                          {value ? formatCurrency(value.closingValue) : "-"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {value ? (
                            isEditable ? (
                              <Input
                                type="number"
                                step="0.01"
                                className="w-32 ml-auto text-right text-xs h-8"
                                placeholder="Enter RM"
                                value={
                                  editingPhysical[value.id] !== undefined
                                    ? editingPhysical[value.id]
                                    : value.physicalCountValue !== null
                                    ? (value.physicalCountValue / 100).toFixed(2)
                                    : ""
                                }
                                onChange={(e) =>
                                  handlePhysicalChange(value.id, e.target.value)
                                }
                                onBlur={() => handlePhysicalBlur(value)}
                              />
                            ) : (
                              <span className="font-mono text-xs">
                                {value.physicalCountValue !== null
                                  ? formatCurrency(value.physicalCountValue)
                                  : "-"}
                              </span>
                            )
                          ) : (
                            "-"
                          )}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono text-xs font-semibold ${
                            varianceExceedsThreshold ? "text-[#9A3A2D]" : ""
                          }`}
                        >
                          {value?.variancePercent !== null && value?.variancePercent !== undefined ? (
                            <span className="flex items-center justify-end gap-1">
                              {varianceExceedsThreshold && (
                                <AlertTriangle className="h-3.5 w-3.5 text-[#9A3A2D]" />
                              )}
                              {value.variancePercent > 0 ? "+" : ""}
                              {value.variancePercent.toFixed(2)}%
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {value ? (
                            <Badge variant="status" status={value.status} />
                          ) : (
                            <span className="text-xs text-[#6B7280]">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {/* Totals row */}
                <tfoot>
                  <tr className="bg-[#F0ECE9] font-semibold">
                    <td className="px-4 py-3" colSpan={3}>
                      Total
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {formatCurrency(
                        stockValues.reduce((s, v) => s + v.openingValue, 0)
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {formatCurrency(
                        stockValues.reduce((s, v) => s + v.purchasesValue, 0)
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {formatCurrency(
                        stockValues.reduce((s, v) => s + v.consumptionValue, 0)
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {formatCurrency(
                        stockValues.reduce((s, v) => s + v.closingValue, 0)
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {formatCurrency(
                        stockValues
                          .filter((v) => v.physicalCountValue !== null)
                          .reduce((s, v) => s + (v.physicalCountValue ?? 0), 0)
                      )}
                    </td>
                    <td className="px-4 py-3" colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// =============== TAB 2: DASHBOARD ===============

function DashboardTab({
  allStockValues,
  selectedPeriod,
}: {
  allStockValues: MonthlyStockValue[];
  selectedPeriod: string;
}) {
  const currentValues = allStockValues.filter((v) => v.period === selectedPeriod);

  // Category totals
  const categoryTotals = [
    { key: "FG", label: "Finished Goods", icon: <Package className="h-5 w-5" />, codes: ["330-9000"] },
    { key: "WIP", label: "Work-in-Progress", icon: <Layers className="h-5 w-5" />, codes: ["330-8000"] },
    {
      key: "RAW",
      label: "Raw Materials",
      icon: <Boxes className="h-5 w-5" />,
      codes: [
        "330-0001", "330-0002", "330-0003", "330-1001", "330-1002",
        "330-2001", "330-2002", "330-3001", "330-3002", "330-3003",
        "330-3004", "330-3005", "330-3008", "330-3009", "330-4000",
      ],
    },
  ];

  const catData = categoryTotals.map((cat) => {
    const entries = currentValues.filter((v) => cat.codes.includes(v.accountCode));
    const closingTotal = entries.reduce((s, v) => s + v.closingValue, 0);
    const openingTotal = entries.reduce((s, v) => s + v.openingValue, 0);
    const change = openingTotal > 0 ? ((closingTotal - openingTotal) / openingTotal) * 100 : 0;
    return { ...cat, closingTotal, openingTotal, change };
  });

  // Month-over-month trend data (last 3 months)
  const periods = [...new Set(allStockValues.map((v) => v.period))].sort();
  const recentPeriods = periods.slice(-3);

  const trendData = recentPeriods.map((p) => {
    const pVals = allStockValues.filter((v) => v.period === p);
    const total = pVals.reduce((s, v) => s + v.closingValue, 0);
    return { period: p, total };
  });

  const maxTrendVal = Math.max(...trendData.map((d) => d.total), 1);

  // Top variances
  const topVariances = currentValues
    .filter((v) => v.variancePercent !== null && v.variancePercent !== undefined)
    .sort((a, b) => Math.abs(b.variancePercent!) - Math.abs(a.variancePercent!))
    .slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Category Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {catData.map((cat) => (
          <Card key={cat.key}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-[#6B7280]">
                  {cat.label}
                </CardTitle>
                <div className="text-[#6B5C32]">{cat.icon}</div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-[#1F1D1B]">
                {formatCurrency(cat.closingTotal)}
              </div>
              <div className="flex items-center gap-1 mt-1 text-xs">
                {cat.change >= 0 ? (
                  <TrendingUp className="h-3.5 w-3.5 text-[#4F7C3A]" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5 text-[#9A3A2D]" />
                )}
                <span className={cat.change >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}>
                  {cat.change >= 0 ? "+" : ""}
                  {cat.change.toFixed(1)}%
                </span>
                <span className="text-[#6B7280]">from opening</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Trend + Variances */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Trend Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stock Value Trend</CardTitle>
          </CardHeader>
          <CardContent>
            {trendData.length === 0 ? (
              <p className="text-xs text-[#6B7280]">No trend data available</p>
            ) : (
              <div className="space-y-3">
                {trendData.map((d) => {
                  const pct = (d.total / maxTrendVal) * 100;
                  return (
                    <div key={d.period} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-[#1F1D1B]">
                          {periodLabel(d.period)}
                        </span>
                        <span className="text-[#6B7280]">
                          {formatCurrency(d.total)}
                        </span>
                      </div>
                      <div className="h-6 w-full rounded bg-[#F0ECE9]">
                        <div
                          className="h-6 rounded bg-[#6B5C32] transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Variances */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top Variances - {periodLabel(selectedPeriod)}</CardTitle>
          </CardHeader>
          <CardContent>
            {topVariances.length === 0 ? (
              <p className="text-xs text-[#6B7280]">No variance data for this period</p>
            ) : (
              <div className="space-y-3">
                {topVariances.map((v) => {
                  const exceedsThreshold = Math.abs(v.variancePercent!) > 3;
                  return (
                    <div
                      key={v.id}
                      className={`flex items-center justify-between p-3 rounded-lg border ${
                        exceedsThreshold
                          ? "border-[#E8B2A1] bg-[#F9E1DA]"
                          : "border-[#E2DDD8] bg-white"
                      }`}
                    >
                      <div>
                        <div className="text-sm font-medium text-[#1F1D1B]">
                          {v.accountDescription}
                        </div>
                        <div className="text-xs text-[#6B7280] font-mono">
                          {v.accountCode}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {exceedsThreshold && (
                          <AlertTriangle className="h-4 w-4 text-[#9A3A2D]" />
                        )}
                        <span
                          className={`text-sm font-semibold ${
                            exceedsThreshold ? "text-[#9A3A2D]" : "text-[#1F1D1B]"
                          }`}
                        >
                          {v.variancePercent! > 0 ? "+" : ""}
                          {v.variancePercent!.toFixed(2)}%
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Grand Total */}
      <Card>
        <CardContent className="py-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Total Inventory Value ({periodLabel(selectedPeriod)})</p>
              <p className="text-3xl font-bold text-[#1F1D1B] mt-1">
                {formatCurrency(currentValues.reduce((s, v) => s + v.closingValue, 0))}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-[#6B7280]">Entries</p>
              <p className="text-xl font-bold text-[#6B5C32]">{currentValues.length}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB 3: REPORTS ===============

function ReportsTab({
  allStockValues,
  selectedPeriod,
  onPeriodChange,
}: {
  allStockValues: MonthlyStockValue[];
  selectedPeriod: string;
  onPeriodChange: (period: string) => void;
}) {
  const currentValues = allStockValues.filter((v) => v.period === selectedPeriod);

  const handleExportCSV = () => {
    const headers = [
      "Period",
      "Account Code",
      "Description",
      "Opening (RM)",
      "Purchases (RM)",
      "Consumption (RM)",
      "Closing (RM)",
      "Physical Count (RM)",
      "Variance %",
      "Status",
    ];

    const rows = currentValues.map((v) => [
      v.period,
      v.accountCode,
      v.accountDescription,
      (v.openingValue / 100).toFixed(2),
      (v.purchasesValue / 100).toFixed(2),
      (v.consumptionValue / 100).toFixed(2),
      (v.closingValue / 100).toFixed(2),
      v.physicalCountValue !== null ? (v.physicalCountValue / 100).toFixed(2) : "",
      v.variancePercent !== null ? v.variancePercent.toFixed(2) : "",
      v.status,
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stock-value-${selectedPeriod}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Movement summary
  const totalOpening = currentValues.reduce((s, v) => s + v.openingValue, 0);
  const totalPurchases = currentValues.reduce((s, v) => s + v.purchasesValue, 0);
  const totalConsumption = currentValues.reduce((s, v) => s + v.consumptionValue, 0);
  const totalClosing = currentValues.reduce((s, v) => s + v.closingValue, 0);

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-[#1F1D1B]">Report Period:</label>
          <select
            value={selectedPeriod}
            onChange={(e) => onPeriodChange(e.target.value)}
            className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
          >
            {getAvailablePeriods().map((p) => (
              <option key={p} value={p}>
                {periodLabel(p)}
              </option>
            ))}
          </select>
        </div>
        <Button variant="outline" onClick={handleExportCSV}>
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* Movement Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Stock Value Movement - {periodLabel(selectedPeriod)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 rounded-lg bg-[#F0ECE9] border border-[#E2DDD8]">
              <p className="text-xs text-[#6B7280] uppercase tracking-wider">Opening</p>
              <p className="text-lg font-bold text-[#1F1D1B] mt-1">
                {formatCurrency(totalOpening)}
              </p>
            </div>
            <div className="p-4 rounded-lg bg-[#EEF3E4] border border-[#C6DBA8]">
              <p className="text-xs text-[#4F7C3A] uppercase tracking-wider">+ Purchases</p>
              <p className="text-lg font-bold text-[#4F7C3A] mt-1">
                {formatCurrency(totalPurchases)}
              </p>
            </div>
            <div className="p-4 rounded-lg bg-[#F9E1DA] border border-[#E8B2A1]">
              <p className="text-xs text-[#9A3A2D] uppercase tracking-wider">- Consumption</p>
              <p className="text-lg font-bold text-[#9A3A2D] mt-1">
                {formatCurrency(totalConsumption)}
              </p>
            </div>
            <div className="p-4 rounded-lg bg-[#E0EDF0] border border-[#A8CAD2]">
              <p className="text-xs text-[#3E6570] uppercase tracking-wider">= Closing</p>
              <p className="text-lg font-bold text-[#3E6570] mt-1">
                {formatCurrency(totalClosing)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Monthly Stock Value Summary Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Monthly Stock Value Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                  <th className="text-left px-4 py-3 font-medium text-[#1F1D1B]">Account Code</th>
                  <th className="text-left px-4 py-3 font-medium text-[#1F1D1B]">Description</th>
                  <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Opening</th>
                  <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Purchases</th>
                  <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Consumption</th>
                  <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Closing</th>
                  <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Physical</th>
                  <th className="text-right px-4 py-3 font-medium text-[#1F1D1B]">Variance %</th>
                  <th className="text-center px-4 py-3 font-medium text-[#1F1D1B]">Status</th>
                </tr>
              </thead>
              <tbody>
                {currentValues.map((v) => {
                  const exceedsThreshold =
                    v.variancePercent !== null && Math.abs(v.variancePercent) > 3;
                  return (
                    <tr
                      key={v.id}
                      className="border-b border-[#E2DDD8] last:border-b-0 hover:bg-[#F0ECE9]/30"
                    >
                      <td className="px-4 py-3 font-mono text-xs">{v.accountCode}</td>
                      <td className="px-4 py-3">{v.accountDescription}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {formatCurrency(v.openingValue)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {formatCurrency(v.purchasesValue)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {formatCurrency(v.consumptionValue)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs font-semibold">
                        {formatCurrency(v.closingValue)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {v.physicalCountValue !== null
                          ? formatCurrency(v.physicalCountValue)
                          : "-"}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-mono text-xs font-semibold ${
                          exceedsThreshold ? "text-[#9A3A2D]" : ""
                        }`}
                      >
                        {v.variancePercent !== null ? (
                          <span className="flex items-center justify-end gap-1">
                            {exceedsThreshold && (
                              <AlertTriangle className="h-3.5 w-3.5 text-[#9A3A2D]" />
                            )}
                            {v.variancePercent > 0 ? "+" : ""}
                            {v.variancePercent.toFixed(2)}%
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant="status" status={v.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9] font-semibold">
                  <td className="px-4 py-3" colSpan={2}>
                    Total
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {formatCurrency(totalOpening)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {formatCurrency(totalPurchases)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {formatCurrency(totalConsumption)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {formatCurrency(totalClosing)}
                  </td>
                  <td className="px-4 py-3" colSpan={3}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
