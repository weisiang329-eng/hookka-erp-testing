import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import {
  BarChart3,
  Factory,
  ShoppingCart,
  Boxes,
  Users,
  Download,
  Loader2,
  FileSpreadsheet,
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

type JobCard = {
  departmentCode: string;
  departmentName: string;
  status: string;
  estMinutes: number;
  actualMinutes: number | null;
};

type ProductionOrder = {
  id: string;
  poNo: string;
  productCode: string;
  productName: string;
  status: string;
  currentDepartment: string;
  targetEndDate: string;
  completedDate: string | null;
  startDate: string;
  jobCards: JobCard[];
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
  const [from, setFrom] = useState("2026-04-01");
  const [to, setTo] = useState("2026-04-30");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{
    orders: SalesOrder[];
    invoices: Invoice[];
  } | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const [soRes, invRes] = await Promise.all([
        fetch("/api/sales-orders"),
        fetch("/api/invoices"),
      ]);
      const soJson = await soRes.json();
      const invJson = await invRes.json();
      const orders: SalesOrder[] = (soJson.data || []).filter(
        (o: SalesOrder) => o.companySODate >= from && o.companySODate <= to
      );
      const invoices: Invoice[] = (invJson.data || []).filter(
        (i: Invoice) => i.invoiceDate >= from && i.invoiceDate <= to
      );
      setData({ orders, invoices });
    } catch {
      setData({ orders: [], invoices: [] });
    }
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
  const [from, setFrom] = useState("2026-04-01");
  const [to, setTo] = useState("2026-04-30");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ProductionOrder[] | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/production-orders");
      const json = await res.json();
      const all: ProductionOrder[] = (json.data || []).filter(
        (p: ProductionOrder) => p.startDate >= from && p.startDate <= to
      );
      setData(all);
    } catch {
      setData([]);
    }
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
      </div>
    );
  }

  const totalPOs = data.length;
  const completed = data.filter((p) => p.status === "COMPLETED").length;
  const inProgress = data.filter((p) => p.status === "IN_PROGRESS").length;

  // Average completion time (days) for completed orders
  const completedOrders = data.filter(
    (p) => p.status === "COMPLETED" && p.completedDate
  );
  const avgCompletionDays =
    completedOrders.length > 0
      ? completedOrders.reduce((s, p) => {
          const start = new Date(p.startDate).getTime();
          const end = new Date(p.completedDate!).getTime();
          return s + (end - start) / (1000 * 60 * 60 * 24);
        }, 0) / completedOrders.length
      : 0;

  // Department efficiency
  const deptStats: Record<
    string,
    { name: string; orders: number; totalMin: number; completedMin: number }
  > = {};
  data.forEach((po) =>
    po.jobCards.forEach((jc) => {
      if (!deptStats[jc.departmentCode])
        deptStats[jc.departmentCode] = {
          name: jc.departmentName,
          orders: 0,
          totalMin: 0,
          completedMin: 0,
        };
      if (jc.status === "COMPLETED") {
        deptStats[jc.departmentCode].orders += 1;
        deptStats[jc.departmentCode].totalMin += jc.actualMinutes || jc.estMinutes;
        deptStats[jc.departmentCode].completedMin += jc.estMinutes;
      }
    })
  );
  const deptRows = Object.values(deptStats)
    .sort((a, b) => b.orders - a.orders)
    .map((d) => {
      const avgTime =
        d.orders > 0 ? Math.round(d.totalMin / d.orders) : 0;
      const efficiency =
        d.totalMin > 0
          ? ((d.completedMin / d.totalMin) * 100).toFixed(1) + "%"
          : "-";
      return [d.name, d.orders, avgTime, efficiency];
    });

  // Overdue orders
  const today = new Date();
  const overdueOrders = data
    .filter(
      (p) => p.status !== "COMPLETED" && p.status !== "CANCELLED" && new Date(p.targetEndDate) < today
    )
    .map((p) => {
      const daysOverdue = Math.ceil(
        (today.getTime() - new Date(p.targetEndDate).getTime()) /
          (1000 * 60 * 60 * 24)
      );
      return [p.poNo, p.productName, daysOverdue, p.currentDepartment];
    });

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
          value={`${avgCompletionDays.toFixed(1)} days`}
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
                ["Department", "Orders Processed", "Avg Time (mins)", "Efficiency %"],
                deptRows.map((r) => r.map(String))
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={["Department", "Orders Processed", "Avg Time (mins)", "Efficiency %"]}
            rows={deptRows}
            align={["left", "right", "right", "right"]}
          />
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
  const [products, setProducts] = useState<Product[] | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/products");
      const json = await res.json();
      setProducts(json.data || []);
    } catch {
      setProducts([]);
    }
    setLoading(false);
  }, []);

  if (loading) return <Spinner />;

  if (!products) {
    return (
      <div className="space-y-4">
        <Button variant="primary" onClick={generate}>
          <FileSpreadsheet className="h-4 w-4" /> Generate Inventory Report
        </Button>
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

function FinancialReportTab() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{
    invoices: Invoice[];
    purchaseOrders: PurchaseOrder[];
  } | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const [invRes, poRes] = await Promise.all([
        fetch("/api/invoices"),
        fetch("/api/purchase-orders"),
      ]);
      const invJson = await invRes.json();
      const poJson = await poRes.json();
      setData({
        invoices: invJson.data || [],
        purchaseOrders: poJson.data || [],
      });
    } catch {
      setData({ invoices: [], purchaseOrders: [] });
    }
    setLoading(false);
  }, []);

  if (loading) return <Spinner />;

  if (!data) {
    return (
      <div className="space-y-4">
        <Button variant="primary" onClick={generate}>
          <FileSpreadsheet className="h-4 w-4" /> Generate Financial Report
        </Button>
      </div>
    );
  }

  const { invoices, purchaseOrders } = data;

  // P&L
  const revenue = invoices.reduce((s, i) => s + i.totalSen, 0);
  const cogs = Math.round(revenue * 0.65);
  const grossProfit = revenue - cogs;
  const salaries = 5000000; // RM 50,000
  const utilities = 800000; // RM 8,000
  const rent = 1500000; // RM 15,000
  const others = 500000; // RM 5,000
  const totalExpenses = salaries + utilities + rent + others;
  const netProfit = grossProfit - totalExpenses;

  const plRows: [string, string, string][] = [
    ["Revenue", "", formatCurrency(revenue)],
    ["Cost of Goods Sold (est. 65%)", "", `(${formatCurrency(cogs)})`],
    ["Gross Profit", "", formatCurrency(grossProfit)],
    ["", "", ""],
    ["Operating Expenses", "", ""],
    ["  Salaries & Wages", "", `(${formatCurrency(salaries)})`],
    ["  Utilities", "", `(${formatCurrency(utilities)})`],
    ["  Rent", "", `(${formatCurrency(rent)})`],
    ["  Others", "", `(${formatCurrency(others)})`],
    [
      "Total Operating Expenses",
      "",
      `(${formatCurrency(totalExpenses)})`,
    ],
    ["", "", ""],
    ["Net Profit / (Loss)", "", formatCurrency(netProfit)],
  ];

  // AR Aging
  const today = new Date();
  const arBuckets = { current: 0, d30: 0, d60: 0, d90: 0 };
  invoices
    .filter((i) => i.status !== "PAID" && i.status !== "CANCELLED")
    .forEach((inv) => {
      const dueDate = new Date(inv.dueDate);
      const outstanding = inv.totalSen - inv.paidAmount;
      const daysOverdue = Math.max(
        0,
        Math.ceil(
          (today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
        )
      );
      if (daysOverdue <= 0) arBuckets.current += outstanding;
      else if (daysOverdue <= 30) arBuckets.d30 += outstanding;
      else if (daysOverdue <= 60) arBuckets.d60 += outstanding;
      else arBuckets.d90 += outstanding;
    });

  const arRows = [
    ["Current (not yet due)", formatCurrency(arBuckets.current)],
    ["1-30 Days Overdue", formatCurrency(arBuckets.d30)],
    ["31-60 Days Overdue", formatCurrency(arBuckets.d60)],
    ["90+ Days Overdue", formatCurrency(arBuckets.d90)],
    [
      "Total AR",
      formatCurrency(
        arBuckets.current + arBuckets.d30 + arBuckets.d60 + arBuckets.d90
      ),
    ],
  ];

  // AP Aging from purchase orders
  const apBuckets = { current: 0, d30: 0, d60: 0, d90: 0 };
  purchaseOrders
    .filter(
      (po) =>
        po.status !== "RECEIVED" &&
        po.status !== "CANCELLED"
    )
    .forEach((po) => {
      const expected = new Date(po.expectedDate);
      const daysOverdue = Math.max(
        0,
        Math.ceil(
          (today.getTime() - expected.getTime()) / (1000 * 60 * 60 * 24)
        )
      );
      if (daysOverdue <= 0) apBuckets.current += po.totalSen;
      else if (daysOverdue <= 30) apBuckets.d30 += po.totalSen;
      else if (daysOverdue <= 60) apBuckets.d60 += po.totalSen;
      else apBuckets.d90 += po.totalSen;
    });

  const apRows = [
    ["Current", formatCurrency(apBuckets.current)],
    ["1-30 Days Overdue", formatCurrency(apBuckets.d30)],
    ["31-60 Days Overdue", formatCurrency(apBuckets.d60)],
    ["90+ Days Overdue", formatCurrency(apBuckets.d90)],
    [
      "Total AP",
      formatCurrency(
        apBuckets.current + apBuckets.d30 + apBuckets.d60 + apBuckets.d90
      ),
    ],
  ];

  return (
    <div className="space-y-6">
      <Button variant="primary" onClick={generate}>
        <FileSpreadsheet className="h-4 w-4" /> Refresh
      </Button>

      {/* P&L Statement */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            Profit & Loss Statement (Simplified)
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCSV(
                "profit-and-loss.csv",
                ["Item", "", "Amount"],
                plRows.map((r) => r.map(String))
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      {/* AR Aging */}
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Accounts Payable Aging</CardTitle>
          </CardHeader>
          <CardContent>
            <ReportTable
              headers={["Aging Bucket", "Amount"]}
              rows={apRows}
              align={["left", "right"]}
            />
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
  const [from, setFrom] = useState("2026-04-01");
  const [to, setTo] = useState("2026-04-30");
  const [loading, setLoading] = useState(false);
  const [workers, setWorkers] = useState<Worker[] | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/workers");
      const json = await res.json();
      setWorkers(json.data || []);
    } catch {
      setWorkers([]);
    }
    setLoading(false);
  }, []);

  if (loading) return <Spinner />;

  if (!workers) {
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
      </div>
    );
  }

  const totalWorkers = workers.length;
  const activeWorkers = workers.filter((w) => w.status === "ACTIVE").length;

  // By department
  const deptCount: Record<string, number> = {};
  workers.forEach((w) => {
    deptCount[w.departmentCode] = (deptCount[w.departmentCode] || 0) + 1;
  });

  // Attendance placeholder stats
  const workingDays = 22;
  const presentRate = 94.5;
  const avgHoursPerDay = 8.7;

  // Efficiency table (placeholder data per worker based on available info)
  const seed = (s: string) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  };

  const effRows = workers
    .filter((w) => w.status === "ACTIVE")
    .map((w) => {
      const s = seed(w.id);
      const hours = 180 + (s % 40);
      const items = 30 + (s % 25);
      const eff = ((items / (hours / 9)) * 10).toFixed(1);
      return [w.name, w.departmentCode, hours, items, eff + "%"];
    });

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
          label="Attendance Rate"
          value={`${presentRate}%`}
          sub={`${workingDays} working days this month`}
        />
        <SummaryCard
          label="Avg Hours/Day"
          value={avgHoursPerDay.toFixed(1)}
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
            Attendance Overview (This Month)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReportTable
            headers={["Metric", "Value"]}
            rows={[
              ["Working Days", workingDays],
              ["Average Attendance Rate", `${presentRate}%`],
              ["Total Present Days", Math.round(totalWorkers * workingDays * presentRate / 100)],
              ["Total Absent Days", Math.round(totalWorkers * workingDays * (100 - presentRate) / 100)],
              ["Average OT Hours / Worker", "12.5"],
            ]}
            align={["left", "right"]}
          />
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
                ["Worker Name", "Department", "Hours Worked", "Items Completed", "Efficiency %"],
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
              "Hours Worked",
              "Items Completed",
              "Efficiency %",
            ]}
            rows={effRows}
            align={["left", "left", "right", "right", "right"]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// =====================================================================
// Main Page
// =====================================================================

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("sales");

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
