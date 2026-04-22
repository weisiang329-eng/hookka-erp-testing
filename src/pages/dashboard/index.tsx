import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import { asArray } from "@/lib/safe-json";
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Package,
  Factory,
  Truck,
  Users,
  AlertTriangle,
  Clock,
  CheckCircle2,
  ArrowUpRight,
  Loader2,
  ShoppingCart,
  FileText,
  Beaker,
  ClipboardCheck,
} from "lucide-react";

// ---------- Types ----------

interface SalesOrderItem {
  id: string;
  lineNo: number;
  productName: string;
  quantity: number;
  lineTotalSen: number;
}

interface SalesOrder {
  id: string;
  companySOId: string;
  customerName: string;
  status: string;
  totalSen: number;
  items: SalesOrderItem[];
}

interface JobCard {
  departmentCode: string;
  departmentName: string;
  status: string;
  completedDate: string | null;
}

interface ProductionOrder {
  id: string;
  status: string;
  progress: number;
  currentDepartment: string;
  completedDate: string | null;
  jobCards: JobCard[];
}

interface DeliveryOrder {
  id: string;
  status: string;
}

interface Invoice {
  id: string;
  totalSen: number;
  paidAmount: number;
  status: string;
  dueDate?: string;
}

interface PurchaseOrderItem {
  quantity: number;
  receivedQty: number;
}

interface PurchaseOrder {
  id: string;
  poNo: string;
  status: string;
  items: PurchaseOrderItem[];
}

interface QCInspection {
  id: string;
  result: "PASS" | "FAIL" | "CONDITIONAL_PASS";
}

interface RawMaterial {
  itemCode: string;
  description: string;
  balanceQty: number;
}

interface RDProject {
  id: string;
  status: "ACTIVE" | "ON_HOLD" | "COMPLETED" | "CANCELLED";
  currentStage?: string;
  name?: string;
}

// ---------- Department config ----------

const DEPARTMENTS = [
  { code: "FAB_CUT", name: "Fab Cut", color: "#3B82F6" },
  { code: "FAB_SEW", name: "Fab Sew", color: "#6366F1" },
  { code: "FOAM", name: "Foam", color: "#8B5CF6" },
  { code: "WOOD_CUT", name: "Wood Cut", color: "#F59E0B" },
  { code: "FRAMING", name: "Framing", color: "#F97316" },
  { code: "WEBBING", name: "Webbing", color: "#10B981" },
  { code: "UPHOLSTERY", name: "Upholstery", color: "#F43F5E" },
  { code: "PACKING", name: "Packing", color: "#06B6D4" },
];

// ---------- KPI Card component ----------

function KPICard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  trendValue,
  onClick,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ElementType;
  trend?: "up" | "down";
  trendValue?: string;
  onClick?: () => void;
}) {
  return (
    <Card
      className={`bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] ${onClick ? "cursor-pointer hover:shadow-[0_2px_8px_rgba(107,92,50,0.12)] transition-shadow" : ""}`}
      onClick={onClick}
    >
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-[#5A5550] font-medium mb-1">{title}</p>
            <p className="text-[26px] font-[800] tracking-[-0.5px] text-[#1F1D1B]">{value}</p>
            {subtitle && <p className="text-xs text-[#9CA3AF] mt-1">{subtitle}</p>}
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="rounded-lg bg-[#F5F2ED] p-2.5">
              <Icon className="h-5 w-5 text-[#6B5C32]" />
            </div>
            {trend && (
              <div
                className={`flex items-center gap-1 text-[11px] font-semibold ${
                  trend === "up" ? "text-[#16A34A]" : "text-[#DC2626]"
                }`}
              >
                {trend === "up" ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {trendValue}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Section Header ----------

function SectionHeader({ label }: { label: string }) {
  return (
    <h2 className="text-xs font-bold text-[#5A5550] uppercase tracking-wider mb-3">{label}</h2>
  );
}

// ---------- R&D Stage Badge ----------

const STAGE_COLORS: Record<string, string> = {
  ACTIVE: "bg-[#DCFCE7] text-[#15803D]",
  ON_HOLD: "bg-[#FEF9C3] text-[#A16207]",
  COMPLETED: "bg-[#E0E7FF] text-[#3730A3]",
  CANCELLED: "bg-[#FEE2E2] text-[#B91C1C]",
};

function StageBadge({ status }: { status: string }) {
  const cls = STAGE_COLORS[status] ?? "bg-[#F5F2ED] text-[#5A5550]";
  return (
    <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${cls}`}>
      {status}
    </span>
  );
}

// ---------- Main Dashboard ----------

export default function DashboardPage() {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([]);
  const [productionOrders, setProductionOrders] = useState<ProductionOrder[]>([]);
  const [deliveryOrders, setDeliveryOrders] = useState<DeliveryOrder[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [qcInspections, setQcInspections] = useState<QCInspection[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [rdProjects, setRdProjects] = useState<RDProject[]>([]);
  const [workerCount, setWorkerCount] = useState(0);
  const [customerCount, setCustomerCount] = useState(0);

  useEffect(() => {
    async function fetchAll() {
      try {
        const [soRes, prodRes, doRes, invRes, wRes, cRes, poRes, qcRes, invtRes, rdRes] =
          await Promise.all([
            fetch("/api/sales-orders"),
            fetch("/api/production-orders"),
            fetch("/api/delivery-orders"),
            fetch("/api/invoices"),
            fetch("/api/workers"),
            fetch("/api/customers"),
            fetch("/api/purchase-orders"),
            fetch("/api/qc-inspections"),
            fetch("/api/inventory"),
            fetch("/api/rd-projects"),
          ]);

        const [soData, prodData, doData, invData, wData, cData, poData, qcData, invtData, rdData] =
          await Promise.all([
            soRes.json(),
            prodRes.json(),
            doRes.json(),
            invRes.json(),
            wRes.json(),
            cRes.json(),
            poRes.json(),
            qcRes.json(),
            invtRes.json(),
            rdRes.json(),
          ]);

        setSalesOrders(asArray(soData));
        setProductionOrders(asArray(prodData));
        setDeliveryOrders(asArray(doData));
        setInvoices(asArray(invData));
        setWorkerCount(asArray(wData).length);
        setCustomerCount(asArray(cData).length);
        setPurchaseOrders(asArray(poData));
        setQcInspections(asArray(qcData));
        const rmNested =
          invtData && typeof invtData === "object" && !Array.isArray(invtData)
            ? ((invtData as { data?: { rawMaterials?: unknown } }).data
                ?.rawMaterials ?? [])
            : [];
        setRawMaterials(Array.isArray(rmNested) ? rmNested : []);
        setRdProjects(asArray(rdData));
      } catch (err) {
        console.error("Dashboard fetch error:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchAll();
  }, []);

  // --- Computed KPIs ---

  // Financial
  const monthlyRevenue = invoices.reduce((sum, inv) => sum + inv.totalSen, 0);

  const accountsReceivable = invoices
    .filter((inv) => inv.status !== "PAID" && inv.status !== "CANCELLED")
    .reduce((sum, inv) => sum + (inv.totalSen - (inv.paidAmount ?? 0)), 0);

  const accountsPayable = purchaseOrders
    .filter((po) => po.status !== "RECEIVED" && po.status !== "CANCELLED")
    .reduce((sum, po) => {
      // Sum outstanding quantity as proxy for AP (no unit price in type, so count items)
      return (
        sum +
        (po.items ?? []).reduce(
          (s, item) => s + Math.max(0, item.quantity - (item.receivedQty ?? 0)),
          0
        )
      );
    }, 0);

  const ordersPipelineValue = salesOrders
    .filter((so) => so.status === "CONFIRMED" || so.status === "IN_PRODUCTION")
    .reduce((sum, so) => sum + so.totalSen, 0);

  // Sales & Delivery
  const totalOrders = salesOrders.length;
  const outstandingOrders = salesOrders.filter(
    (so) => so.status === "CONFIRMED" || so.status === "IN_PRODUCTION"
  ).length;
  const pendingDeliveries = deliveryOrders.filter(
    (d) => d.status === "DRAFT" || d.status === "LOADED" || d.status === "IN_TRANSIT"
  ).length;
  const overdueInvoices = invoices.filter(
    (inv) => inv.status !== "PAID" && inv.status !== "CANCELLED"
  ).length;

  // Production
  const activeJobs = productionOrders.filter((po) => po.status === "IN_PROGRESS").length;
  const inQueue = productionOrders.filter((po) => po.status === "PENDING").length;
  const today = new Date().toISOString().split("T")[0];
  const completedToday = productionOrders.filter(
    (po) => po.completedDate && po.completedDate.startsWith(today)
  ).length;
  const passCount = qcInspections.filter(
    (q) => q.result === "PASS" || q.result === "CONDITIONAL_PASS"
  ).length;
  const qcPassRate =
    qcInspections.length > 0
      ? Math.round((passCount / qcInspections.length) * 100)
      : 0;

  // Procurement & Inventory
  const openPOs = purchaseOrders.filter(
    (po) => po.status !== "RECEIVED" && po.status !== "CANCELLED"
  ).length;
  const poOutstandingItems = purchaseOrders
    .filter((po) => po.status !== "RECEIVED" && po.status !== "CANCELLED")
    .reduce(
      (sum, po) =>
        sum +
        (po.items ?? []).reduce(
          (s, item) => s + Math.max(0, item.quantity - (item.receivedQty ?? 0)),
          0
        ),
      0
    );
  const lowStockItems = rawMaterials.filter((rm) => rm.balanceQty < 10).length;
  const activeRD = rdProjects.filter((p) => p.status === "ACTIVE").length;

  // Department status from jobCards
  const deptStatus = DEPARTMENTS.map((dept) => {
    let active = 0;
    let queue = 0;
    let done = 0;
    for (const po of productionOrders) {
      for (const jc of po.jobCards ?? []) {
        if (jc.departmentCode === dept.code) {
          if (jc.status === "IN_PROGRESS") active++;
          else if (jc.status === "WAITING") queue++;
          else if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") done++;
        }
      }
    }
    return { ...dept, active, queue, done };
  });

  // Recent orders (latest 8)
  const recentOrders = salesOrders.slice(0, 8);

  // Active R&D projects for sidebar
  const activeRDProjects = rdProjects.filter((p) => p.status === "ACTIVE").slice(0, 4);

  // --- Loading state ---

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
          <p className="text-xs text-[#6B7280]">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-[26px] font-[800] tracking-[-0.5px] text-[#1F1D1B]">
          {(() => {
            const hour = new Date().getHours();
            const greeting =
              hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
            const name = getCurrentUser()?.displayName?.split(/\s+/)[0] || "there";
            return `${greeting}, ${name}`;
          })()}
        </h1>
        <p className="text-sm text-[#5A5550] mt-0.5">
          {new Date().toLocaleDateString("en-MY", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

      {/* 1. Financial Overview */}
      <div>
        <SectionHeader label="Financial Overview" />
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <KPICard
            title="Monthly Revenue"
            value={formatCurrency(monthlyRevenue)}
            subtitle={`From ${invoices.length} invoices`}
            icon={DollarSign}
            trend="up"
            trendValue="+12%"
            onClick={() => navigate("/finance/invoices")}
          />
          <KPICard
            title="Accounts Receivable"
            value={formatCurrency(accountsReceivable)}
            subtitle="Total outstanding"
            icon={TrendingUp}
            trend="up"
            trendValue="+5%"
            onClick={() => navigate("/finance/receivables")}
          />
          <KPICard
            title="Accounts Payable"
            value={accountsPayable.toString()}
            subtitle="Outstanding PO items"
            icon={TrendingDown}
            onClick={() => navigate("/procurement")}
          />
          <KPICard
            title="Orders Pipeline"
            value={formatCurrency(ordersPipelineValue)}
            subtitle="Confirmed + In Production"
            icon={DollarSign}
            trend="up"
            trendValue="+8%"
            onClick={() => navigate("/sales")}
          />
        </div>
      </div>

      {/* 2. Sales & Delivery */}
      <div>
        <SectionHeader label="Sales & Delivery" />
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <KPICard
            title="Total Orders"
            value={totalOrders.toString()}
            subtitle="All sales orders"
            icon={ShoppingCart}
            trend="up"
            trendValue="+3"
            onClick={() => navigate("/sales")}
          />
          <KPICard
            title="Outstanding Orders"
            value={outstandingOrders.toString()}
            subtitle="Confirmed + In Production"
            icon={Clock}
            onClick={() => navigate("/sales")}
          />
          <KPICard
            title="Pending Delivery"
            value={pendingDeliveries.toString()}
            subtitle="Draft / Loaded / In Transit"
            icon={Truck}
            onClick={() => navigate("/tms")}
          />
          <KPICard
            title="Overdue Invoices"
            value={overdueInvoices.toString()}
            subtitle="Unpaid invoices"
            icon={AlertTriangle}
            onClick={() => navigate("/finance/invoices")}
          />
        </div>
      </div>

      {/* 3. Production */}
      <div>
        <SectionHeader label="Production" />
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <KPICard
            title="Active Jobs"
            value={activeJobs.toString()}
            subtitle={`${completedToday} completed today`}
            icon={Factory}
            trend="up"
            trendValue="+2"
            onClick={() => navigate("/production")}
          />
          <KPICard
            title="In Queue"
            value={inQueue.toString()}
            subtitle="Pending production"
            icon={Clock}
            onClick={() => navigate("/production")}
          />
          <KPICard
            title="Completed Today"
            value={completedToday.toString()}
            subtitle="Production orders"
            icon={CheckCircle2}
            onClick={() => navigate("/production")}
          />
          <KPICard
            title="QC Pass Rate"
            value={`${qcPassRate}%`}
            subtitle={`${qcInspections.length} inspections total`}
            icon={ClipboardCheck}
            trend="up"
            trendValue="+2%"
            onClick={() => navigate("/qms")}
          />
        </div>
      </div>

      {/* 4. Procurement & Inventory */}
      <div>
        <SectionHeader label="Procurement & Inventory" />
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <KPICard
            title="Open POs"
            value={openPOs.toString()}
            subtitle="Not fully received"
            icon={FileText}
            onClick={() => navigate("/procurement")}
          />
          <KPICard
            title="PO Outstanding"
            value={poOutstandingItems.toString()}
            subtitle="Items pending receipt"
            icon={Package}
            onClick={() => navigate("/procurement")}
          />
          <KPICard
            title="Low Stock Items"
            value={lowStockItems.toString()}
            subtitle="Raw materials < 10 units"
            icon={AlertTriangle}
            onClick={() => navigate("/inventory")}
          />
          <KPICard
            title="R&D Projects"
            value={activeRD.toString()}
            subtitle="Active projects"
            icon={Beaker}
            trend="up"
            trendValue="+1"
            onClick={() => navigate("/rd")}
          />
        </div>
      </div>

      {/* Bottom section: Recent Orders + Quick Stats sidebar */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        {/* Recent Sales Orders (span 2) */}
        <Card className="lg:col-span-2 bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold">Recent Sales Orders</CardTitle>
              <button
                onClick={() => navigate("/sales")}
                className="text-sm text-[#6B5C32] hover:underline flex items-center gap-1"
              >
                View All <ArrowUpRight className="h-3 w-3" />
              </button>
            </div>
          </CardHeader>
          <CardContent>
            <table className="w-full">
              <thead>
                <tr>
                  <th className="text-left text-xs text-[#5A5550] font-semibold pb-2 border-b-2 border-[#E2DDD8] px-3">
                    Order No
                  </th>
                  <th className="text-left text-xs text-[#5A5550] font-semibold pb-2 border-b-2 border-[#E2DDD8] px-3">
                    Customer
                  </th>
                  <th className="text-left text-xs text-[#5A5550] font-semibold pb-2 border-b-2 border-[#E2DDD8] px-3 hidden sm:table-cell">
                    Items
                  </th>
                  <th className="text-left text-xs text-[#5A5550] font-semibold pb-2 border-b-2 border-[#E2DDD8] px-3">
                    Status
                  </th>
                  <th className="text-right text-xs text-[#5A5550] font-semibold pb-2 border-b-2 border-[#E2DDD8] px-3">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {recentOrders.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="text-[13px] text-[#9CA3AF] text-center py-4"
                    >
                      No sales orders yet
                    </td>
                  </tr>
                )}
                {recentOrders.map((order) => (
                  <tr
                    key={order.id}
                    onDoubleClick={() => navigate(`/sales/${order.id}`)}
                    onClick={() => navigate(`/sales/${order.id}`)}
                    className="hover:bg-[#6B5C32]/[0.03] transition-colors cursor-pointer border-b border-[#E2DDD8] last:border-b-0"
                  >
                    <td className="text-[13px] py-2.5 px-3">
                      <span className="font-medium text-[#6B5C32]">{order.companySOId}</span>
                    </td>
                    <td className="text-[13px] py-2.5 px-3 text-[#374151]">
                      {order.customerName}
                    </td>
                    <td className="text-[13px] py-2.5 px-3 text-[#9CA3AF] hidden sm:table-cell">
                      {order.items?.length ?? 0} items
                    </td>
                    <td className="text-[13px] py-2.5 px-3">
                      <Badge variant="status" status={order.status} />
                    </td>
                    <td className="text-[13px] py-2.5 px-3 text-right font-medium">
                      {formatCurrency(order.totalSen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Quick Stats sidebar */}
        <div className="flex flex-col gap-4">
          {/* Department Status */}
          <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold">Department Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2.5">
                {deptStatus.map((dept) => {
                  const total = dept.active + dept.queue;
                  const pct = total > 0 ? (dept.active / total) * 100 : 0;
                  return (
                    <div
                      key={dept.code}
                      onClick={() => navigate(`/production/department/${dept.code}`)}
                      className="flex items-center gap-3 cursor-pointer hover:bg-[#6B5C32]/[0.03] rounded-lg p-1 -mx-1 transition-colors"
                    >
                      <span className="w-[90px] shrink-0 text-xs font-semibold text-[#374151] truncate">
                        {dept.name}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="h-2 w-full rounded-full border border-[#E2DDD8] bg-[#F5F2ED]">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${pct}%`, backgroundColor: dept.color }}
                          />
                        </div>
                      </div>
                      <span className="text-[11px] text-[#5A5550] whitespace-nowrap shrink-0">
                        {total}
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Workforce & Customers */}
          <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold">Workforce & Customers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div
                className="flex items-center justify-between cursor-pointer hover:bg-[#6B5C32]/[0.03] rounded-lg p-1.5 -mx-1.5 transition-colors"
                onClick={() => navigate("/hr")}
              >
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-[#6B5C32]" />
                  <span className="text-sm text-[#374151]">Total Workers</span>
                </div>
                <span className="text-sm font-bold text-[#1F1D1B]">{workerCount}</span>
              </div>
              <div
                className="flex items-center justify-between cursor-pointer hover:bg-[#6B5C32]/[0.03] rounded-lg p-1.5 -mx-1.5 transition-colors"
                onClick={() => navigate("/customers")}
              >
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-[#6B5C32]" />
                  <span className="text-sm text-[#374151]">Total Customers</span>
                </div>
                <span className="text-sm font-bold text-[#1F1D1B]">{customerCount}</span>
              </div>
            </CardContent>
          </Card>

          {/* Active R&D Projects */}
          {activeRDProjects.length > 0 && (
            <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-bold">Active R&D Projects</CardTitle>
                  <button
                    onClick={() => navigate("/rd")}
                    className="text-xs text-[#6B5C32] hover:underline flex items-center gap-0.5"
                  >
                    All <ArrowUpRight className="h-3 w-3" />
                  </button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {activeRDProjects.map((project) => (
                  <div
                    key={project.id}
                    className="flex items-center justify-between gap-2 cursor-pointer hover:bg-[#6B5C32]/[0.03] rounded-lg p-1.5 -mx-1.5 transition-colors"
                    onClick={() => navigate(`/rd/${project.id}`)}
                  >
                    <span className="text-[13px] text-[#374151] truncate">
                      {project.name ?? project.id}
                    </span>
                    <StageBadge status={project.status} />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
