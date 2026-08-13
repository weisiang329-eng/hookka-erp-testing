import { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { cachedFetchJsonResult } from "@/lib/cached-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, roundSen } from "@/lib/utils";
import {
  AlertTriangle,
  BarChart3,
  Factory,
  ShoppingCart,
  Boxes,
  Users,
  Download,
  Loader2,
  FileSpreadsheet,
  RefreshCw,
} from "lucide-react";

// ── Types mirroring API response shapes ──────────────────────────────

type SalesOrderItem = {
  productCode: string;
  productName: string;
  quantity: number;
  unitPriceSen: number;
  lineTotalSen: number;
};

type SalesOrder = {
  id: string;
  companySOId: string;
  customerName: string;
  totalSen: number;
  status: string;
  companySODate: string;
  items: SalesOrderItem[];
};

type InvoiceItem = {
  productCode: string;
  productName: string;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
};

type Invoice = {
  id: string;
  invoiceNo: string;
  customerName: string;
  customerId: string;
  totalSen: number;
  paidAmount: number;
  status: string;
  invoiceDate: string;
  dueDate: string;
  items: InvoiceItem[];
};

// GET /api/production-orders/report-summary — the whole Production tab, added
// up in SQL. The browser used to download every PO with every job card to
// compute this; see BUG-2026-08-13-005.
type ProductionDeptRow = {
  departmentCode: string;
  departmentName: string;
  completedCards: number;
  stdMinutes: number;
  measuredCards: number;
  measuredStdMinutes: number;
  measuredActualMinutes: number;
  // Measured cards whose recorded minutes actually DIFFER from the standard
  // minutes. On prod 2026-08-13 this is 0 of 4,289 — the column is populated
  // with a copy of the estimate, so any ratio off it is 100.0% by construction.
  measuredDistinctCards: number;
};

type ProductionOverdueRow = {
  poNo: string;
  productName: string;
  currentDepartment: string;
  targetEndDate: string;
  daysOverdue: number;
};

type ProductionSummary = {
  range: { from: string; to: string };
  totals: {
    totalOrders: number;
    completed: number;
    inProgress: number;
    avgCompletionDays: number | null;
    completedWithDates: number;
  };
  departments: ProductionDeptRow[];
  overdue: ProductionOverdueRow[];
};

// GET /api/department-performance?view=summary — clocked working minutes vs
// production minutes, per worker, over a date range. The ONLY trustworthy
// efficiency source in the app: its denominator is `working_hour_entries`,
// i.e. time people actually clocked, not an estimate.
type WorkerPerfRow = {
  workerId: string;
  workerName: string;
  workingMinutes: number;
  productionMinutes: number;
  efficiencyPct: number;
  // Distinct job cards this worker was credited on across the range.
  jobCards: number;
};

type DeptPerformanceSummary = {
  range: { from: string; to: string };
  totals: {
    workingMinutes: number;
    productionMinutes: number;
    efficiencyPct: number;
    workerCount: number;
  };
  workers: WorkerPerfRow[];
};

type AttendanceRecord = {
  employeeId: string;
  date: string;
  status: string;
  workingMinutes: number;
  overtimeMinutes: number;
};

type Product = {
  id: string;
  code: string;
  name: string;
  category: string;
  costPriceSen: number;
  baseModel: string;
  sizeCode: string;
  sizeLabel: string;
};

type Worker = {
  id: string;
  empNo: string;
  name: string;
  departmentCode: string;
  position: string;
  status: string;
  basicSalarySen: number;
};

type PurchaseOrder = {
  id: string;
  poNo: string;
  supplierName: string;
  totalSen: number;
  status: string;
  orderDate: string;
  expectedDate: string;
};

// ── Date helpers ─────────────────────────────────────────────────────

// All date pickers on this page default to today so the calendar popup
// opens at the current month instead of jumping back to whichever past
// month a hard-coded constant was last set to. The operator's last
// selection persists in localStorage — keyed per report tab — so flipping
// between tabs and revisiting the page lands on the range they last cared
// about. Mirrors the pattern in employees.tsx (introduced 2026-05-08).
function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function readPersistedDateRange(key: string): { from?: string; to?: string } {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { from?: unknown; to?: unknown };
    return {
      from: typeof parsed.from === "string" ? parsed.from : undefined,
      to: typeof parsed.to === "string" ? parsed.to : undefined,
    };
  } catch {
    return {};
  }
}

function writePersistedDateRange(key: string, from: string, to: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ from, to }));
  } catch {
    /* localStorage full / blocked — non-fatal, just lose persistence */
  }
}

// ── Fetch-result helper ──────────────────────────────────────────────

// The first failure among several parallel fetches, or null if all succeeded.
// A tab that needs two sources must fail on EITHER — half a report still reads
// as fact (see BUG-2026-08-13-005).
function firstError(
  ...results: { ok: boolean; error?: string }[]
): string | null {
  for (const r of results) {
    if (!r.ok) return r.error ?? "Couldn't load this report. Please try again.";
  }
  return null;
}

// ── CSV helper ───────────────────────────────────────────────────────

function downloadCSV(
  filename: string,
  headers: string[],
  rows: (string | number)[][]
) {
  const escape = (v: string | number) => {
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const csv = [
    headers.map(escape).join(","),
    ...rows.map((r) => r.map(escape).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Shared Components ────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
      <span className="ml-3 text-[#6B7280]">Generating report...</span>
    </div>
  );
}

// ── Failed fetch ≠ empty result ──────────────────────────────────────
//
// Every tab on this page used to do `catch { setData([]) }`, and
// `cachedFetchJson` returns `null` on failure anyway — so a request that timed
// out, 500'd or hit the 30 s global abort landed in state as an empty array and
// rendered through `ReportTable`'s "No data available" caption. That caption is
// a STATEMENT ABOUT THE BUSINESS ("nothing happened in this range"), and it was
// being printed over dead requests: BUG-2026-08-13-005, where the Production
// report claimed no department activity for a window in which prod had 370 and
// 367 job cards completed on two consecutive days.
//
// The rule this component exists to enforce: a report that could not load says
// so, and offers a retry. It never renders a number, a row, or an emptiness.
function ReportError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card className="border-[#C2410C]/30 bg-[#FFF7ED]">
      <CardContent className="p-5 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-[#C2410C] shrink-0 mt-0.5" />
        <div className="space-y-2">
          <p className="text-sm font-semibold text-[#1F1D1B]">
            This report couldn&apos;t load
          </p>
          <p className="text-sm text-[#4B5563]">{message}</p>
          <p className="text-xs text-[#6B7280]">
            Nothing is shown below because the data never arrived — this is not
            a statement that there was no activity in this range.
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DateRangeSelector({
  from,
  to,
  onFromChange,
  onToChange,
}: {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <label className="text-sm text-[#6B7280]">From</label>
      <input
        type="date"
        value={from}
        onChange={(e) => onFromChange(e.target.value)}
        className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm text-[#1F1D1B] bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
      />
      <label className="text-sm text-[#6B7280]">To</label>
      <input
        type="date"
        value={to}
        onChange={(e) => onToChange(e.target.value)}
        className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm text-[#1F1D1B] bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-[#6B7280]">{label}</p>
        <p className="text-xl font-bold text-[#1F1D1B] mt-1">{value}</p>
        {sub && <p className="text-xs text-[#6B7280] mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function ReportTable({
  headers,
  rows,
  align,
}: {
  headers: string[];
  rows: (string | number)[][];
  align?: ("left" | "right")[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
            {headers.map((h, i) => (
              <th
                key={i}
                className={`px-4 py-2.5 font-medium text-[#1F1D1B] ${
                  align?.[i] === "right" ? "text-right" : "text-left"
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50"
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={`px-4 py-2 text-[#4B5563] ${
                    align?.[ci] === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={headers.length}
                className="px-4 py-6 text-center text-[#6B7280]"
              >
                No data available
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Tab definitions ──────────────────────────────────────────────────

const TABS = [
  { id: "sales", label: "Sales", icon: <ShoppingCart className="h-4 w-4" /> },
  {
    id: "production",
    label: "Production",
    icon: <Factory className="h-4 w-4" />,
  },
  { id: "inventory", label: "Inventory", icon: <Boxes className="h-4 w-4" /> },
  {
    id: "financial",
    label: "Financial",
    icon: <BarChart3 className="h-4 w-4" />,
  },
  { id: "employee", label: "Employee", icon: <Users className="h-4 w-4" /> },
] as const;

type TabId = (typeof TABS)[number]["id"];

// =====================================================================
// Tab 1: Sales Reports
// =====================================================================

function SalesReportTab() {
  const [from, setFrom] = useState<string>(
    () => readPersistedDateRange("reports:sales:dateRange").from ?? todayStr()
  );
  const [to, setTo] = useState<string>(
    () => readPersistedDateRange("reports:sales:dateRange").to ?? todayStr()
  );
  useEffect(() => {
    writePersistedDateRange("reports:sales:dateRange", from, to);
  }, [from, to]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    orders: SalesOrder[];
    invoices: Invoice[];
  } | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [soRes, invRes] = await Promise.all([
      cachedFetchJsonResult<{ data?: SalesOrder[] }>("/api/sales-orders"),
      cachedFetchJsonResult<{ data?: Invoice[] }>("/api/invoices"),
    ]);
    // Half a report is still a wrong report — an invoice count computed over a
    // failed sales-order fetch reads as fact. Fail the whole tab.
    const failure = firstError(soRes, invRes);
    if (failure || !soRes.ok || !invRes.ok) {
      setData(null);
      setError(failure);
      setLoading(false);
      return;
    }
    const orders: SalesOrder[] = (soRes.data?.data || []).filter(
      (o: SalesOrder) => o.companySODate >= from && o.companySODate <= to
    );
    const invoices: Invoice[] = (invRes.data?.data || []).filter(
      (i: Invoice) => i.invoiceDate >= from && i.invoiceDate <= to
    );
    setData({ orders, invoices });
    setLoading(false);
  }, [from, to]);

  if (loading) return <Spinner />;

  if (!data) {
    return (
      <div className="space-y-4">
        <div className="flex items-end gap-4 flex-wrap">
          <DateRangeSelector
            from={from}
            to={to}
            onFromChange={setFrom}
            onToChange={setTo}
          />
          <Button variant="primary" onClick={generate}>
            <FileSpreadsheet className="h-4 w-4" /> Generate
          </Button>
        </div>
        {error && <ReportError message={error} onRetry={generate} />}
      </div>
    );
  }

  const { orders, invoices } = data;
  const totalOrders = orders.length;
  const totalRevenue = orders.reduce((s, o) => s + o.totalSen, 0);
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  // Orders by status
  const statusCounts: Record<string, number> = {};
  orders.forEach((o) => {
    statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
  });

  // Revenue by customer
  const custMap: Record<
    string,
    { name: string; count: number; revenue: number }
  > = {};
  orders.forEach((o) => {
    if (!custMap[o.customerName])
      custMap[o.customerName] = { name: o.customerName, count: 0, revenue: 0 };
    custMap[o.customerName].count += 1;
    custMap[o.customerName].revenue += o.totalSen;
  });
  const custRows = Object.values(custMap)
    .sort((a, b) => b.revenue - a.revenue)
    .map((c) => [
      c.name,
      c.count,
      formatCurrency(c.revenue),
      totalRevenue > 0
        ? ((c.revenue / totalRevenue) * 100).toFixed(1) + "%"
        : "0%",
    ]);

  // Revenue by product
  const prodMap: Record<
    string,
    { code: string; name: string; qty: number; revenue: number }
  > = {};
  orders.forEach((o) =>
    o.items.forEach((it) => {
      const key = it.productCode;
      if (!prodMap[key])
        prodMap[key] = {
          code: it.productCode,
          name: it.productName,
          qty: 0,
          revenue: 0,
        };
      prodMap[key].qty += it.quantity;
      prodMap[key].revenue += it.lineTotalSen;
    })
  );
  const prodRows = Object.values(prodMap)
    .sort((a, b) => b.revenue - a.revenue)
    .map((p) => [p.code, p.name, p.qty, formatCurrency(p.revenue)]);

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-4 flex-wrap">
        <DateRangeSelector
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
        />
        <Button variant="primary" onClick={generate}>
          <FileSpreadsheet className="h-4 w-4" /> Generate
        </Button>
      </div>

      {/* Summary */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Orders" value={totalOrders} />
        <SummaryCard
          label="Total Revenue"
          value={formatCurrency(totalRevenue)}
        />
        <SummaryCard
          label="Average Order Value"
          value={formatCurrency(avgOrderValue)}
        />
        <SummaryCard
          label="Invoices Issued"
          value={invoices.length}
          sub={`Paid: ${invoices.filter((i) => i.status === "PAID").length}`}
        />
      </div>

      {/* Orders by Status */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Orders by Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {Object.entries(statusCounts).map(([status, count]) => (
              <div
                key={status}
                className="flex items-center gap-2 border border-[#E2DDD8] rounded-lg px-3 py-2"
              >
                <Badge variant="status" status={status} />
                <span className="text-sm font-semibold text-[#1F1D1B]">
                  {count}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Revenue by Customer */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Revenue by Customer</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCSV(
                "revenue-by-customer.csv",
                ["Customer", "Orders", "Revenue", "% of Total"],
                custRows.map((r) => r.map(String))
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={["Customer Name", "Order Count", "Total Revenue", "% of Total"]}
            rows={custRows}
            align={["left", "right", "right", "right"]}
          />
        </CardContent>
      </Card>

      {/* Revenue by Product */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Revenue by Product</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCSV(
                "revenue-by-product.csv",
                ["Product Code", "Product Name", "Qty Sold", "Revenue"],
                prodRows.map((r) => r.map(String))
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={["Product Code", "Product Name", "Qty Sold", "Revenue"]}
            rows={prodRows}
            align={["left", "left", "right", "right"]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// =====================================================================
// Tab 2: Production Reports
// =====================================================================

function ProductionReportTab() {
  const [from, setFrom] = useState<string>(
    () => readPersistedDateRange("reports:production:dateRange").from ?? todayStr()
  );
  const [to, setTo] = useState<string>(
    () => readPersistedDateRange("reports:production:dateRange").to ?? todayStr()
  );
  useEffect(() => {
    writePersistedDateRange("reports:production:dateRange", from, to);
  }, [from, to]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ProductionSummary | null>(null);

  // ONE scoped, server-aggregated request. This tab used to fetch bare
  // `/api/production-orders` — the whole org, every PO, every job card — and
  // add it up here: 30,012 ms on prod, killed by api-client's 30 s global
  // abort, after which the report printed "No data available" over the corpse.
  // BUG-2026-08-13-005; same family as -001 / -002 / -003.
  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await cachedFetchJsonResult<ProductionSummary>(
      `/api/production-orders/report-summary?from=${encodeURIComponent(
        from,
      )}&to=${encodeURIComponent(to)}`,
    );
    if (!res.ok || !res.data?.totals) {
      setData(null);
      setError(res.ok ? "The server sent an unexpected reply." : res.error);
      setLoading(false);
      return;
    }
    setData(res.data);
    setLoading(false);
  }, [from, to]);

  if (loading) return <Spinner />;

  if (!data) {
    return (
      <div className="space-y-4">
        <div className="flex items-end gap-4 flex-wrap">
          <DateRangeSelector
            from={from}
            to={to}
            onFromChange={setFrom}
            onToChange={setTo}
          />
          <Button variant="primary" onClick={generate}>
            <FileSpreadsheet className="h-4 w-4" /> Generate
          </Button>
        </div>
        {error && <ReportError message={error} onRetry={generate} />}
      </div>
    );
  }

  const totalPOs = data.totals.totalOrders;
  const completed = data.totals.completed;
  const inProgress = data.totals.inProgress;
  const avgCompletionDays = data.totals.avgCompletionDays;

  // Department efficiency.
  //
  // An efficiency ratio's denominator must be a MEASUREMENT, and both sides of
  // the ratio must cover the SAME cards. This table used to break both rules —
  // it summed each completed card's actual minutes OR-ed with its estimate into
  // one total, summed the estimates into the other, and divided, so every
  // unmeasured card contributed its own estimate to BOTH sides and pinned the
  // department at ~100% (BUG-2026-08-13-004).
  //
  // The paired accumulation that fixed it now runs in SQL — see
  // `GET /api/production-orders/report-summary`. The rule is unchanged and the
  // guard travelled with it: a completed card enters the ratio ONLY when it
  // recorded a duration, and then it enters BOTH subtotals. There is no
  // `actualMinutes -> estMinutes` fallback on either side, in either place.
  //
  // `productionTimeMinutes` is deliberately NOT used as a stand-in: it equals
  // `estMinutes` on every row, so it is the standard time wearing another name.
  //
  // The genuine, fully-measured efficiency figure lives elsewhere and is NOT
  // affected: /api/department-performance (and the employee / department /
  // payslip surfaces on it, including this page's Employee tab) divides
  // production minutes by CLOCKED time from `working_hour_entries`.
  const deptStats = data.departments.map((d) => ({
    name: d.departmentName || d.departmentCode,
    orders: d.completedCards,
    stdMin: d.stdMinutes,
    // The paired subtotals — only cards that actually recorded a duration.
    measuredCards: d.measuredCards,
    measuredStdMin: d.measuredStdMinutes,
    measuredActualMin: d.measuredActualMinutes,
    // ...of which the recording DIFFERS from the estimate. See below.
    measuredDistinctCards: d.measuredDistinctCards,
  }));
  const deptRows = deptStats
    .slice()
    .sort((a, b) => b.orders - a.orders)
    .map((d) => {
      // Standard (spec) minutes per completed card — an estimate, and now
      // labelled as one — the old header omitted "Std", so it read as time
      // actually taken.
      const avgStdTime = d.orders > 0 ? Math.round(d.stdMin / d.orders) : 0;
      const measured =
        d.measuredCards > 0 ? `${d.measuredCards} / ${d.orders}` : "—";
      const ratio =
        d.measuredActualMin > 0
          ? ((d.measuredStdMin / d.measuredActualMin) * 100).toFixed(1) + "%"
          : "—";
      // Second honesty gate, added with BUG-2026-08-13-005 after counting the
      // column on prod: all 4,289 non-zero `actualMinutes` values are
      // byte-identical to that card's own `estMinutes` (4,289 of 4,289). The
      // column is populated, but with a COPY of the standard time — so the
      // ratio above is 100.0% by construction, which is the SAME fabricated
      // number BUG-2026-08-13-004 removed, arriving by a different route.
      // Publish a percentage only once at least one card's recording actually
      // differs from its estimate.
      const efficiency = d.measuredDistinctCards > 0 ? ratio : "—";
      return [d.name, d.orders, avgStdTime, measured, efficiency];
    });
  // Drives the explanatory caption under the table.
  const anyActualMinutesRecorded = deptStats.some((d) => d.measuredCards > 0);
  const anyDistinctRecording = deptStats.some(
    (d) => d.measuredDistinctCards > 0,
  );

  // Overdue orders — the whole predicate (not COMPLETED / not CANCELLED,
  // targetEndDate strictly before today) now runs in SQL, so this is a render.
  const overdueOrders = data.overdue.map((p) => [
    p.poNo,
    p.productName,
    p.daysOverdue,
    p.currentDepartment,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-4 flex-wrap">
        <DateRangeSelector
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
        />
        <Button variant="primary" onClick={generate}>
          <FileSpreadsheet className="h-4 w-4" /> Generate
        </Button>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total POs" value={totalPOs} />
        <SummaryCard label="Completed" value={completed} />
        <SummaryCard label="In Progress" value={inProgress} />
        <SummaryCard
          label="Avg Completion Time"
          value={
            avgCompletionDays === null
              ? "—"
              : `${avgCompletionDays.toFixed(1)} days`
          }
          sub={
            avgCompletionDays === null
              ? "No completed order in this range carries a completion date"
              : `Over ${data.totals.completedWithDates} completed orders`
          }
        />
      </div>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Department Efficiency</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCSV(
                "department-efficiency.csv",
                ["Department", "Orders Processed", "Avg Std Time (mins)", "Measured Cards", "Efficiency %"],
                deptRows.map((r) => r.map(String))
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={["Department", "Orders Processed", "Avg Std Time (mins)", "Measured Cards", "Efficiency %"]}
            rows={deptRows}
            align={["left", "right", "right", "right", "right"]}
          />
          <p className="mt-2 text-xs text-[#6B7280]">
            {anyDistinctRecording ? (
              <>
                Efficiency is standard minutes ÷ recorded minutes, over the
                completed job cards that actually recorded a duration —
                “Measured Cards” says how many that is. Most cards record none,
                so treat a small sample as an indication, not a departmental
                KPI. For a fully measured figure use the Employee tab, which
                divides production minutes by clocked working hours.
              </>
            ) : anyActualMinutesRecorded ? (
              <>
                Efficiency reads “—” even though {" "}
                {deptStats.reduce((s, d) => s + d.measuredCards, 0)} completed
                job cards in this range carry a recorded duration: on every one
                of them the recorded minutes are identical to the standard
                minutes, so the recording is a copy of the estimate rather than
                a measurement, and the ratio would be exactly 100% by
                construction. For a genuinely measured figure use the Employee
                tab, which divides production minutes by clocked working hours.
              </>
            ) : (
              <>
                Efficiency reads “—” because no completed job card in this date
                range recorded how long it actually took. It is never filled in
                from the standard time — that would just show 100% for every
                department. For a measured figure use the Employee tab, which
                divides production minutes by clocked working hours.
              </>
            )}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Overdue Orders</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCSV(
                "overdue-orders.csv",
                ["SO ID", "Product", "Days Overdue", "Current Dept"],
                overdueOrders.map((r) => r.map(String))
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={["SO ID", "Product", "Days Overdue", "Current Dept"]}
            rows={overdueOrders}
            align={["left", "left", "right", "left"]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// =====================================================================
// Tab 3: Inventory Reports
// =====================================================================

function InventoryReportTab() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await cachedFetchJsonResult<{ data?: Product[] }>(
      "/api/products",
    );
    if (!res.ok) {
      setProducts(null);
      setError(res.error);
      setLoading(false);
      return;
    }
    setProducts(res.data?.data || []);
    setLoading(false);
  }, []);

  if (loading) return <Spinner />;

  if (!products) {
    return (
      <div className="space-y-4">
        <Button variant="primary" onClick={generate}>
          <FileSpreadsheet className="h-4 w-4" /> Generate Inventory Report
        </Button>
        {error && <ReportError message={error} onRetry={generate} />}
      </div>
    );
  }

  const totalProducts = products.length;
  // Use costPriceSen and avg price to estimate stock value
  const categoryMap: Record<
    string,
    { count: number; totalValue: number }
  > = {};
  products.forEach((p) => {
    if (!categoryMap[p.category])
      categoryMap[p.category] = { count: 0, totalValue: 0 };
    categoryMap[p.category].count += 1;
    // Estimate value as costPriceSen (each product is now a single SKU)
    categoryMap[p.category].totalValue += p.costPriceSen;
  });

  const catRows = Object.entries(categoryMap)
    .sort(([, a], [, b]) => b.totalValue - a.totalValue)
    .map(([cat, v]) => [cat, v.count, formatCurrency(v.totalValue)]);

  // Product detail table
  const detailRows = products.map((p) => {
    return [
      p.code,
      p.name,
      p.category,
      p.sizeCode,
      formatCurrency(p.costPriceSen),
      p.sizeLabel,
    ];
  });

  return (
    <div className="space-y-6">
      <Button variant="primary" onClick={generate}>
        <FileSpreadsheet className="h-4 w-4" /> Refresh
      </Button>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <SummaryCard label="Total Products" value={totalProducts} />
        <SummaryCard
          label="Product Categories"
          value={Object.keys(categoryMap).length}
          sub={Object.keys(categoryMap).join(", ")}
        />
      </div>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Stock Valuation by Category</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCSV(
                "stock-valuation.csv",
                ["Category", "Item Count", "Total Value"],
                catRows.map((r) => r.map(String))
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={["Category", "Item Count", "Total Value"]}
            rows={catRows}
            align={["left", "right", "right"]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Product Listing</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCSV(
                "product-listing.csv",
                ["Code", "Name", "Category", "Sizes", "Cost Price", "Avg Sell Price"],
                detailRows.map((r) => r.map(String))
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={["Code", "Name", "Category", "Sizes", "Cost Price", "Avg Sell Price"]}
            rows={detailRows}
            align={["left", "left", "left", "right", "right", "right"]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// =====================================================================
// Tab 4: Financial Reports
// =====================================================================

// GET /api/accounting/pl — the POSTED general ledger, netted per account and
// classified by that account's own `type` in `chart_of_accounts`
// (REVENUE / COST → COGS / EXPENSE → operating). The endpoint drops any account
// whose net for the window is zero, so the number of entries in a category is
// exactly the number of accounts that CARRY a posting. That count is this tab's
// provenance: it is printed beside every figure, and a category with zero
// accounts publishes "—" instead of RM 0.00. See BUG-2026-08-13-009.
type LedgerPlEntry = {
  accountCode: string;
  accountName: string;
  category: "REVENUE" | "COGS" | "OPERATING_EXPENSE";
  amount: number;
};

type LedgerPl = {
  entries: LedgerPlEntry[];
  totals: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    operatingExpenses: number;
    netProfit: number;
  };
};

// What a cell shows when nothing sourced it. Deliberately not "0.00", not
// "N/A", and never a plausible number: the reader must be able to tell an
// absent figure from a measured zero at a glance.
const NO_FIGURE = "—";

function FinancialReportTab() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    invoices: Invoice[];
    purchaseOrders: PurchaseOrder[];
    ledger: LedgerPl | null;
    ledgerError: string | null;
  } | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [invRes, poRes, plRes] = await Promise.all([
      cachedFetchJsonResult<{ data?: Invoice[] }>("/api/invoices"),
      cachedFetchJsonResult<{ data?: PurchaseOrder[] }>("/api/purchase-orders"),
      cachedFetchJsonResult<{ data?: LedgerPl }>("/api/accounting/pl"),
    ]);
    // The two operational sources drive the receivables and the invoiced-sales
    // card; half of that is wrong rather than partial, so either failing fails
    // the tab (BUG-2026-08-13-005).
    const failure = firstError(invRes, poRes);
    if (failure || !invRes.ok || !poRes.ok) {
      setData(null);
      setError(failure);
      setLoading(false);
      return;
    }
    // The ledger is treated differently ON PURPOSE. If it does not load — a
    // timeout, or a user without `accounting:read` — the P&L is not broken, it
    // is UNSOURCED, and the page must say that with dashes rather than blank
    // the receivables that did load.
    const ledger = plRes.ok ? plRes.data?.data ?? null : null;
    setData({
      invoices: invRes.data?.data || [],
      purchaseOrders: poRes.data?.data || [],
      ledger,
      ledgerError: plRes.ok
        ? ledger
          ? null
          : "The server sent an unexpected reply."
        : plRes.error,
    });
    setLoading(false);
  }, []);

  if (loading) return <Spinner />;

  if (!data) {
    return (
      <div className="space-y-4">
        <Button variant="primary" onClick={generate}>
          <FileSpreadsheet className="h-4 w-4" /> Generate Financial Report
        </Button>
        {error && <ReportError message={error} onRetry={generate} />}
      </div>
    );
  }

  const { invoices, purchaseOrders, ledger, ledgerError } = data;

  // ── Invoiced sales — operational, and labelled as such ──────────────
  //
  // This is what the sales module billed, NOT what the ledger recognised as
  // revenue; the two can legitimately disagree and are never mixed into one
  // subtotal on this page. Drafts and cancellations are excluded, matching how
  // `costByLineWindow` / `/api/accounting/pl` cut operational revenue
  // (`status NOT IN ('DRAFT','CANCELLED')`). The old code summed EVERY invoice
  // row including both.
  const billable = invoices.filter(
    (i) => i.status !== "DRAFT" && i.status !== "CANCELLED",
  );
  const invoicedSen = roundSen(
    billable.reduce((s, i) => s + (Number(i.totalSen) || 0), 0),
  );
  const collectedSen = roundSen(
    billable.reduce((s, i) => s + (Number(i.paidAmount) || 0), 0),
  );

  // ── P&L — every line off the posted ledger, or a dash ───────────────
  //
  // What this replaced (BUG-2026-08-13-009): COGS was `revenue × 0.65` and the
  // four expense lines were the literals 5000000 / 800000 / 1500000 / 500000
  // sen. Gross profit, net profit and both margins were arithmetic on those, so
  // the entire lower half of the statement was invented and rendered in the
  // same typeface as the revenue line.
  //
  // Nothing here maps an account to a bucket. Revenue / COGS / operating
  // expense come from the account's own `type`, and each expense line is
  // printed under its own account code and name — so no "Rent" or "Utilities"
  // grouping is asserted that the owner has not himself defined.
  const glEntries = ledger?.entries ?? [];
  const inCategory = (cat: LedgerPlEntry["category"]) =>
    glEntries.filter((e) => e.category === cat);
  const revenueAccts = inCategory("REVENUE").length;
  const cogsAccts = inCategory("COGS").length;
  const opexEntries = inCategory("OPERATING_EXPENSE")
    .slice()
    .sort((a, b) => b.amount - a.amount);
  const opexAccts = opexEntries.length;
  const totals = ledger?.totals;

  // A figure is published only when at least one account behind it carries a
  // posting. Zero posted cost accounts does not mean the factory spent
  // nothing — it means nobody has booked it — so the cell reads "—".
  const sourced = (n: number, v: number | undefined): string =>
    n > 0 && v !== undefined ? formatCurrency(roundSen(v)) : NO_FIGURE;
  // Costs print in accounting brackets. A cost account that nets to a CREDIT
  // (a reversal, a rebate) is shown plain rather than as a bracketed negative,
  // which reads as a double negation.
  const costCell = (v: number): string => {
    const sen = roundSen(v);
    return sen < 0 ? formatCurrency(sen) : `(${formatCurrency(sen)})`;
  };
  const sourcedCost = (n: number, v: number | undefined): string =>
    n > 0 && v !== undefined ? costCell(v) : NO_FIGURE;
  // A derived line is only as sourced as the weakest line it derives from.
  const derived = (deps: number[], v: number | undefined): string =>
    deps.every((n) => n > 0) && v !== undefined
      ? formatCurrency(roundSen(v))
      : NO_FIGURE;
  const provenance = (n: number): string =>
    ledger === null
      ? "ledger unavailable"
      : n === 0
      ? "no account posted"
      : `${n} account${n === 1 ? "" : "s"} posted`;

  const plRows: [string, string, string][] = [
    ["Revenue", provenance(revenueAccts), sourced(revenueAccts, totals?.revenue)],
    [
      "Cost of Goods Sold",
      provenance(cogsAccts),
      sourcedCost(cogsAccts, totals?.cogs),
    ],
    [
      "Gross Profit",
      "",
      derived([revenueAccts, cogsAccts], totals?.grossProfit),
    ],
    ["", "", ""],
    ["Operating Expenses", provenance(opexAccts), ""],
    ...(opexAccts > 0
      ? opexEntries.map(
          (e): [string, string, string] => [
            `  ${e.accountCode} · ${e.accountName}`,
            "",
            costCell(e.amount),
          ],
        )
      : ([
          [
            "  No expense account carries a posting",
            "",
            NO_FIGURE,
          ],
        ] as [string, string, string][])),
    [
      "Total Operating Expenses",
      "",
      sourcedCost(opexAccts, totals?.operatingExpenses),
    ],
    ["", "", ""],
    [
      "Net Profit / (Loss)",
      "",
      derived([revenueAccts, cogsAccts, opexAccts], totals?.netProfit),
    ],
  ];

  // ── AR Aging ────────────────────────────────────────────────────────
  //
  // DRAFT invoices are excluded: an unissued invoice is not a receivable. The
  // last bucket is labelled "61+" because that is what the arithmetic below
  // actually collects — everything past 60 days, not everything past 90.
  const today = new Date();
  const arBuckets = { current: 0, d1to30: 0, d31to60: 0, over60: 0 };
  invoices
    .filter(
      (i) =>
        i.status !== "PAID" && i.status !== "CANCELLED" && i.status !== "DRAFT",
    )
    .forEach((inv) => {
      const dueDate = new Date(inv.dueDate);
      const outstanding =
        (Number(inv.totalSen) || 0) - (Number(inv.paidAmount) || 0);
      const daysOverdue = Math.max(
        0,
        Math.ceil(
          (today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
        )
      );
      if (daysOverdue <= 0) arBuckets.current += outstanding;
      else if (daysOverdue <= 30) arBuckets.d1to30 += outstanding;
      else if (daysOverdue <= 60) arBuckets.d31to60 += outstanding;
      else arBuckets.over60 += outstanding;
    });

  const arRows = [
    ["Current (not yet due)", formatCurrency(roundSen(arBuckets.current))],
    ["1-30 Days Overdue", formatCurrency(roundSen(arBuckets.d1to30))],
    ["31-60 Days Overdue", formatCurrency(roundSen(arBuckets.d31to60))],
    ["61+ Days Overdue", formatCurrency(roundSen(arBuckets.over60))],
    [
      "Total Outstanding",
      formatCurrency(
        roundSen(
          arBuckets.current +
            arBuckets.d1to30 +
            arBuckets.d31to60 +
            arBuckets.over60
        )
      ),
    ],
  ];

  // ── Open purchase orders by expected date ───────────────────────────
  //
  // This card used to be headed "Accounts Payable Aging", which it has never
  // been: it buckets orders that are NOT yet received by their expected
  // DELIVERY date, and it excludes every received order — i.e. it excludes
  // exactly the population that can be owed. It is a delivery-commitment view
  // and is now labelled as one. Real AP lives in Accounting › AP Aging
  // (`/api/accounting/aging?kind=ap`), which ages supplier invoices by due date.
  const poBuckets = { current: 0, d1to30: 0, d31to60: 0, over60: 0 };
  purchaseOrders
    .filter(
      (po) =>
        po.status !== "RECEIVED" &&
        po.status !== "CANCELLED"
    )
    .forEach((po) => {
      const expected = new Date(po.expectedDate);
      const total = Number(po.totalSen) || 0;
      const daysLate = Math.max(
        0,
        Math.ceil(
          (today.getTime() - expected.getTime()) / (1000 * 60 * 60 * 24)
        )
      );
      if (daysLate <= 0) poBuckets.current += total;
      else if (daysLate <= 30) poBuckets.d1to30 += total;
      else if (daysLate <= 60) poBuckets.d31to60 += total;
      else poBuckets.over60 += total;
    });

  const poRows = [
    ["Not yet due", formatCurrency(roundSen(poBuckets.current))],
    ["1-30 Days Late", formatCurrency(roundSen(poBuckets.d1to30))],
    ["31-60 Days Late", formatCurrency(roundSen(poBuckets.d31to60))],
    ["61+ Days Late", formatCurrency(roundSen(poBuckets.over60))],
    [
      "Total Open PO Value",
      formatCurrency(
        roundSen(
          poBuckets.current +
            poBuckets.d1to30 +
            poBuckets.d31to60 +
            poBuckets.over60
        )
      ),
    ],
  ];

  return (
    <div className="space-y-6">
      <Button variant="primary" onClick={generate}>
        <FileSpreadsheet className="h-4 w-4" /> Refresh
      </Button>

      {/* P&L Statement — posted ledger only */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            Profit &amp; Loss — from the posted general ledger (all periods)
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCSV(
                "profit-and-loss.csv",
                ["Item", "Accounts Posted", "Amount"],
                plRows.map((r) => r.map(String))
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          {ledgerError && (
            <div className="mb-3 rounded-md border border-[#C2410C]/30 bg-[#FFF7ED] px-3 py-2 text-sm text-[#4B5563]">
              <span className="font-semibold text-[#1F1D1B]">
                The ledger could not be read, so every figure below is “—”.
              </span>{" "}
              {ledgerError} Nothing is estimated in its place.
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {plRows.map((row, ri) => {
                  const isHeader =
                    row[0] === "Gross Profit" ||
                    row[0] === "Net Profit / (Loss)" ||
                    row[0] === "Total Operating Expenses" ||
                    row[0] === "Revenue";
                  const isSpacer = row[0] === "" && row[2] === "";
                  const isSection =
                    row[0] === "Operating Expenses";
                  if (isSpacer) return <tr key={ri} className="h-3" />;
                  return (
                    <tr
                      key={ri}
                      className={`${
                        isHeader
                          ? "border-t border-b border-[#E2DDD8] bg-[#F0ECE9]"
                          : isSection
                          ? "bg-[#F0ECE9]/50"
                          : "border-b border-[#E2DDD8]/50"
                      }`}
                    >
                      <td
                        className={`px-4 py-2 ${
                          isHeader
                            ? "font-semibold text-[#1F1D1B]"
                            : "text-[#4B5563]"
                        }`}
                      >
                        {row[0]}
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-[#6B7280] whitespace-nowrap">
                        {row[1]}
                      </td>
                      <td
                        className={`px-4 py-2 text-right ${
                          isHeader
                            ? "font-semibold text-[#1F1D1B]"
                            : "text-[#4B5563]"
                        }`}
                      >
                        {row[2]}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 space-y-2 text-xs text-[#6B7280]">
            <p>
              Every figure comes from <code>/api/accounting/pl</code> — the
              posted general ledger, netted per account and classified by that
              account&apos;s own type in the chart of accounts. The
              &ldquo;accounts posted&rdquo; column is the number of accounts
              actually carrying an entry behind that subtotal.
            </p>
            <p>
              A line reads &ldquo;—&rdquo; when no account behind it has been
              posted. That is not RM&nbsp;0.00: it means the ledger has no
              answer yet, and a total built on it (gross profit, net profit)
              reads &ldquo;—&rdquo; too rather than inheriting the gap silently.
            </p>
            <p>
              Until 2026-08-13 this statement showed Cost of Goods Sold as
              revenue&nbsp;×&nbsp;0.65 and Salaries&nbsp;RM&nbsp;50,000,
              Utilities&nbsp;RM&nbsp;8,000, Rent&nbsp;RM&nbsp;15,000 and
              Others&nbsp;RM&nbsp;5,000 as fixed constants written into the
              page. None of it was data. Expense lines are now listed under
              their own account code and name — the page does not decide which
              accounts are &ldquo;rent&rdquo; or &ldquo;utilities&rdquo;.
            </p>
            <p>
              The full manufacturing statement — opening/closing stock, raw
              material, direct labour, factory overhead and WIP movement, by
              period and by product line — is Accounting ›
              Profit&nbsp;&amp;&nbsp;Loss.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Invoiced sales — operational, deliberately separate from the ledger */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Invoiced Sales &amp; Collections (from invoices, not the ledger)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={["Metric", "Value"]}
            rows={[
              ["Invoices issued (excl. draft & cancelled)", billable.length],
              ["Total invoiced", formatCurrency(invoicedSen)],
              ["Collected to date", formatCurrency(collectedSen)],
              ["Outstanding", formatCurrency(invoicedSen - collectedSen)],
            ]}
            align={["left", "right"]}
          />
          <p className="mt-2 text-xs text-[#6B7280]">
            Sourced from <code>/api/invoices</code>. This is what the sales
            module billed, which is not the same thing as the revenue the ledger
            has recognised — the two are shown apart on purpose and are never
            added into one subtotal.
          </p>
        </CardContent>
      </Card>

      {/* Receivables + open purchase commitments */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Accounts Receivable Aging
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ReportTable
              headers={["Aging Bucket", "Amount"]}
              rows={arRows}
              align={["left", "right"]}
            />
            <p className="mt-2 text-xs text-[#6B7280]">
              Unpaid, uncancelled, non-draft invoices aged by due date;
              outstanding = invoice total − amount paid.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Open Purchase Orders by Expected Date
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ReportTable
              headers={["Expected Delivery", "Order Value"]}
              rows={poRows}
              align={["left", "right"]}
            />
            <p className="mt-2 text-xs text-[#6B7280]">
              This is <strong>not</strong> accounts payable. It ages purchase
              orders that have <em>not</em> been received, by expected delivery
              date — so it excludes exactly the orders that can be owed for. It
              was captioned as an A/P aging report until 2026-08-13. Real
              payables live in Accounting › AP Aging, which ages supplier
              invoices by due date.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// =====================================================================
// Tab 5: Employee Reports
// =====================================================================

function EmployeeReportTab() {
  const [from, setFrom] = useState<string>(
    () => readPersistedDateRange("reports:employee:dateRange").from ?? todayStr()
  );
  const [to, setTo] = useState<string>(
    () => readPersistedDateRange("reports:employee:dateRange").to ?? todayStr()
  );
  useEffect(() => {
    writePersistedDateRange("reports:employee:dateRange", from, to);
  }, [from, to]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    workers: Worker[];
    perf: DeptPerformanceSummary;
    attendance: AttendanceRecord[];
  } | null>(null);

  // Three REAL sources, all windowed by the date range this tab already had
  // (and previously ignored):
  //   /api/workers                                  — the roster
  //   /api/department-performance?view=summary      — clocked working minutes
  //       vs production minutes per worker. Its denominator is
  //       `working_hour_entries`, i.e. time people actually punched.
  //   /api/attendance?from&to                       — punch records
  // Nothing on this tab is derived from anything else. See BUG-2026-08-13-006.
  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [wRes, pRes, aRes] = await Promise.all([
      cachedFetchJsonResult<{ data?: Worker[] }>("/api/workers"),
      cachedFetchJsonResult<{ data?: DeptPerformanceSummary }>(
        `/api/department-performance?view=summary&from=${encodeURIComponent(
          from,
        )}&to=${encodeURIComponent(to)}`,
      ),
      cachedFetchJsonResult<{ data?: AttendanceRecord[] }>(
        `/api/attendance?from=${encodeURIComponent(
          from,
        )}&to=${encodeURIComponent(to)}`,
      ),
    ]);
    const failure = firstError(wRes, pRes, aRes);
    if (failure || !wRes.ok || !pRes.ok || !aRes.ok) {
      setData(null);
      setError(failure);
      setLoading(false);
      return;
    }
    const perf = pRes.data?.data;
    if (!perf?.totals || !Array.isArray(perf.workers)) {
      setData(null);
      setError("The server sent an unexpected reply.");
      setLoading(false);
      return;
    }
    setData({
      workers: wRes.data?.data || [],
      perf,
      attendance: aRes.data?.data || [],
    });
    setLoading(false);
  }, [from, to]);

  if (loading) return <Spinner />;

  if (!data) {
    return (
      <div className="space-y-4">
        <div className="flex items-end gap-4 flex-wrap">
          <DateRangeSelector
            from={from}
            to={to}
            onFromChange={setFrom}
            onToChange={setTo}
          />
          <Button variant="primary" onClick={generate}>
            <FileSpreadsheet className="h-4 w-4" /> Generate
          </Button>
        </div>
        {error && <ReportError message={error} onRetry={generate} />}
      </div>
    );
  }

  const { workers, perf, attendance } = data;
  const totalWorkers = workers.length;
  const activeWorkers = workers.filter((w) => w.status === "ACTIVE").length;

  // By department
  const deptCount: Record<string, number> = {};
  workers.forEach((w) => {
    deptCount[w.departmentCode] = (deptCount[w.departmentCode] || 0) + 1;
  });

  // ── Attendance, from `attendance_records` ──────────────────────────
  //
  // What this table can and cannot answer, checked on prod 2026-08-13.
  //
  // CAN: how many days were recorded, how many punch records exist, how long
  // people were on the clock, and how much overtime was booked.
  //
  // CANNOT: an attendance RATE. A row is written when somebody punches, so
  // every row is a presence — 2,780 of 2,780 records across all of 2026 carry
  // status PRESENT, and there is not one ABSENT row in the table (absence is
  // derived elsewhere, by `labor-engine.ts`, from a day having no logged
  // hours; it is never materialised here). present ÷ records is therefore
  // 100% by construction, and the "94.5%" that used to sit in this card was
  // simply typed into the source. The card now reads "—" and says why.
  const attendanceDates = new Set(attendance.map((r) => r.date));
  const recordedDays = attendanceDates.size;
  const withMinutes = attendance.filter((r) => r.workingMinutes > 0);
  const clockedMinutes = withMinutes.reduce(
    (s, r) => s + r.workingMinutes,
    0,
  );
  const avgHoursPerRecordedDay =
    withMinutes.length > 0 ? clockedMinutes / withMinutes.length / 60 : null;
  const overtimeMinutes = attendance.reduce(
    (s, r) => s + (r.overtimeMinutes || 0),
    0,
  );
  const attendingWorkers = new Set(attendance.map((r) => r.employeeId)).size;
  const avgOvertimeHours =
    attendingWorkers > 0 ? overtimeMinutes / attendingWorkers / 60 : null;

  // ── Worker efficiency, from clocked time ──────────────────────────
  //
  // Every column here used to come out of `seed(w.id)` — a hash of the
  // worker's own id, so the same person showed the same invented hours and the
  // same invented efficiency forever, and it moved only if the id changed.
  // BUG-2026-08-13-006.
  //
  // The replacement is /api/department-performance, whose denominator is
  // clocked time from `working_hour_entries`. Prod for 2026-06-14 → 2026-08-13
  // returns 38 workers spanning 28%–186% efficiency and 312–2,270 job cards —
  // it varies, which the hash never did in any way related to the factory.
  //
  // A worker who clocked nothing in the range gets "—", not 0% and not a
  // plausible number: the row exists, the measurement does not.
  const deptByWorkerId = new Map(workers.map((w) => [w.id, w.departmentCode]));
  const effRows = perf.workers.map((w) => [
    w.workerName || w.workerId,
    deptByWorkerId.get(w.workerId) ?? "—",
    w.workingMinutes > 0 ? (w.workingMinutes / 60).toFixed(1) : "—",
    w.jobCards,
    w.workingMinutes > 0 ? `${w.efficiencyPct}%` : "—",
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-4 flex-wrap">
        <DateRangeSelector
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
        />
        <Button variant="primary" onClick={generate}>
          <FileSpreadsheet className="h-4 w-4" /> Generate
        </Button>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Workers" value={totalWorkers} sub={`Active: ${activeWorkers}`} />
        <SummaryCard label="Departments" value={Object.keys(deptCount).length} />
        <SummaryCard
          label="Days With Attendance"
          value={recordedDays}
          sub={`${attendance.length} punch records in range`}
        />
        <SummaryCard
          label="Avg Hours / Recorded Day"
          value={
            avgHoursPerRecordedDay === null
              ? "—"
              : avgHoursPerRecordedDay.toFixed(1)
          }
          sub={
            avgHoursPerRecordedDay === null
              ? "No punch in range has a clock-out to measure"
              : `Over ${withMinutes.length} records with a clock-out`
          }
        />
      </div>

      {/* Department breakdown */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Workers by Department</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {Object.entries(deptCount)
              .sort(([, a], [, b]) => b - a)
              .map(([dept, count]) => (
                <div
                  key={dept}
                  className="flex items-center gap-2 border border-[#E2DDD8] rounded-lg px-3 py-2"
                >
                  <span className="text-sm text-[#6B7280]">{dept}</span>
                  <span className="text-sm font-semibold text-[#1F1D1B]">
                    {count}
                  </span>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>

      {/* Attendance Overview */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Attendance Overview ({from} to {to})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={["Metric", "Value"]}
            rows={[
              ["Days With Attendance Recorded", recordedDays],
              ["Punch Records", attendance.length],
              ["Workers Who Punched", attendingWorkers],
              [
                "Total Clocked Hours",
                clockedMinutes > 0 ? (clockedMinutes / 60).toFixed(1) : "—",
              ],
              [
                "Average OT Hours / Worker",
                avgOvertimeHours === null ? "—" : avgOvertimeHours.toFixed(1),
              ],
              ["Average Attendance Rate", "—"],
            ]}
            align={["left", "right"]}
          />
          <p className="mt-2 text-xs text-[#6B7280]">
            Attendance Rate reads “—” because it cannot be computed from this
            data: <code>attendance_records</code> gets a row only when somebody
            punches, so every row is a presence — all {attendance.length} rows
            in this range, and all 2,780 in 2026, carry status PRESENT and
            there is no ABSENT row anywhere in the table. A rate would be 100%
            by construction. Absence is derived separately by payroll, from a
            day having no logged hours. Everything above is counted from the
            punch records themselves.
          </p>
        </CardContent>
      </Card>

      {/* Efficiency table */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Worker Efficiency</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCSV(
                "worker-efficiency.csv",
                ["Worker Name", "Department", "Clocked Hours", "Job Cards Completed", "Efficiency %"],
                effRows.map((r) => r.map(String))
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={[
              "Worker Name",
              "Department",
              "Clocked Hours",
              "Job Cards Completed",
              "Efficiency %",
            ]}
            rows={effRows}
            align={["left", "left", "right", "right", "right"]}
          />
          <p className="mt-2 text-xs text-[#6B7280]">
            Efficiency is production minutes ÷ clocked minutes over{" "}
            {from} to {to}, from the same engine as Employees › Department
            Performance — the denominator is time actually punched
            (<code>working_hour_entries</code>), never an estimate. Clocked
            Hours is that denominator; Job Cards Completed counts the distinct
            cards the worker was credited on. Over 100% means the standard
            minutes on the cards they finished exceeded the hours they clocked.
            A worker who clocked nothing in this range reads “—”. Range total:{" "}
            {perf.totals.workingMinutes > 0
              ? `${perf.totals.efficiencyPct}% across ${perf.totals.workerCount} workers`
              : "no clocked time recorded"}
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// =====================================================================
// Main Page
// =====================================================================

export default function ReportsPage() {
  // Persist activeTab to the URL (?tab=inventory) so that:
  //   1. Reload / hard-refresh restores the user's last tab.
  //   2. TabbedOutlet unmount/remount on tab-bar switching doesn't reset
  //      back to the default ("sales").  Without this, the user clicks
  //      "Inventory", switches to another shell tab, comes back, and the
  //      page mounts fresh with activeTab="sales" (Apr 2026 Wei Siang
  //      report: "Check Inventory 不见了").
  //   3. Direct links / bookmarks land on the right tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get("tab");
  const isValidTab = (t: string | null): t is TabId =>
    !!t && (TABS as readonly { id: string }[]).some((x) => x.id === t);
  const [activeTab, setActiveTabState] = useState<TabId>(
    isValidTab(tabFromUrl) ? tabFromUrl : "sales",
  );
  // Whenever the URL ?tab= changes (back / forward / external nav),
  // sync activeTab to it so the visible pane matches the address bar.
  /* eslint-disable react-hooks/set-state-in-effect -- URL-to-state sync for browser back/forward navigation */
  useEffect(() => {
    if (isValidTab(tabFromUrl) && tabFromUrl !== activeTab) {
      setActiveTabState(tabFromUrl);
    }
  }, [tabFromUrl, activeTab]);
  /* eslint-enable react-hooks/set-state-in-effect */
  const setActiveTab = useCallback(
    (next: TabId) => {
      setActiveTabState(next);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === "sales") params.delete("tab");
          else params.set("tab", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B]">Reports</h1>
        <p className="text-xs text-[#6B7280]">
          Generate and view reports across all departments
        </p>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-[#E2DDD8]">
        <nav className="flex gap-0 -mb-px overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === tab.id
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B] hover:border-[#E2DDD8]"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === "sales" && <SalesReportTab />}
        {activeTab === "production" && <ProductionReportTab />}
        {activeTab === "inventory" && <InventoryReportTab />}
        {activeTab === "financial" && <FinancialReportTab />}
        {activeTab === "employee" && <EmployeeReportTab />}
      </div>
    </div>
  );
}
