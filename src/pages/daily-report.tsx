// ===========================================================================
// Daily Report — newspaper-style process / SOP exceptions page.
//
// Reads /api/reports/compliance.json (see src/api/lib/compliance-report.ts)
// and lays out a top count strip + one section card per exception group, each
// with a compact table of the offending records linking back to the source.
// Plain tables / lists (NOT the DataGrid component). English only.
// ===========================================================================
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCachedJson } from "@/lib/cached-fetch";
import {
  Loader2,
  ClipboardCheck,
  Truck,
  PackageCheck,
  FileText,
  ShoppingCart,
  Receipt,
  CalendarClock,
  PackageX,
  Users,
  CheckCircle2,
  ArrowUpRight,
} from "lucide-react";

// ── API response types (mirror src/api/lib/compliance-report.ts) ────────────

interface DoPendingDispatchRow {
  id: string;
  doNo: string;
  customerName: string;
  createdAt: string;
  daysWaiting: number;
}
interface DoNotDeliveredRow {
  id: string;
  doNo: string;
  customerName: string;
  dispatchedAt: string;
  daysSinceDispatch: number;
}
interface DoNotInvoicedRow {
  id: string;
  doNo: string;
  customerName: string;
  deliveredAt: string;
  daysSinceDelivered: number;
}
interface SoNoDoRow {
  id: string;
  companySOId: string;
  customerName: string;
  status: string;
}
interface SoNoInvoiceRow {
  id: string;
  companySOId: string;
  customerName: string;
  status: string;
}
interface OverdueRow {
  salesOrderId: string;
  companySOId: string;
  customerName: string;
  customerDeliveryDate: string;
  daysOverdue: number;
  status: string;
  totalQty: number;
  totalSen: number;
  productSummary: string;
}
interface PoNotReceivedRow {
  id: string;
  poNo: string;
  supplierName: string;
  status: string;
  orderDate: string;
  daysOpen: number;
}
interface WorkerRow {
  name: string;
  empNo: string;
  departmentName: string;
  efficiencyPct: number;
  jobsCompleted: number;
  workingMinutes: number;
  productionMinutes: number;
}

interface ComplianceData {
  generatedAtIso: string;
  today: string;
  counts: {
    total: number;
    doPendingDispatch: number;
    doNotDelivered: number;
    doNotInvoiced: number;
    soNoDo: number;
    soNoInvoice: number;
    overdueOrders: number;
    poNotReceived: number;
    lowEfficiencyWorkers: number;
  };
  groups: {
    doPendingDispatch: DoPendingDispatchRow[];
    doNotDelivered: DoNotDeliveredRow[];
    doNotInvoiced: DoNotInvoicedRow[];
    soNoDo: SoNoDoRow[];
    soNoInvoice: SoNoInvoiceRow[];
    overdueOrders: OverdueRow[];
    poNotReceived: PoNotReceivedRow[];
    lowEfficiencyWorkers: WorkerRow[];
  };
}
type ComplianceResp = { success?: boolean; data?: ComplianceData };

// ── Helpers ──────────────────────────────────────────────────────────────

function formatDateLong(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDate(ymd: string): string {
  if (!ymd) return "—";
  const d = new Date(ymd.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatRM(sen: number): string {
  if (!sen) return "—";
  return "RM " + (sen / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Day-count badge — escalates from neutral to red as the wait grows.
function DaysBadge({ days, suffix = "d" }: { days: number; suffix?: string }) {
  const color =
    days >= 14
      ? "bg-[#FEE2E2] text-[#B91C1C] border-[#FCA5A5]"
      : days >= 7
        ? "bg-[#FFEDD5] text-[#C2410C] border-[#FED7AA]"
        : days >= 3
          ? "bg-[#FEF3C7] text-[#A16207] border-[#FDE68A]"
          : "bg-[#F0ECE9] text-[#6B5C32] border-[#E2DDD8]";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${color}`}
    >
      {days}
      {suffix}
    </span>
  );
}

// Efficiency badge — always red here (only sub-threshold workers are listed).
function EffBadge({ pct }: { pct: number }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[#FCA5A5] bg-[#FEE2E2] px-2 py-0.5 text-[11px] font-semibold text-[#B91C1C] tabular-nums">
      {pct}%
    </span>
  );
}

// ── Count strip tile ────────────────────────────────────────────────────

function CountTile({
  label,
  value,
  icon: Icon,
  highlight = false,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  highlight?: boolean;
}) {
  const clear = value === 0;
  return (
    <Card
      className={`rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] ${
        highlight ? "bg-[#1F1D1B] text-white border-[#1F1D1B]" : "bg-white"
      }`}
    >
      <CardContent className="p-3.5">
        <div className="flex items-start justify-between">
          <p
            className={`text-[10px] font-semibold uppercase tracking-wider ${
              highlight ? "text-[#D8D2C6]" : "text-[#5A5550]"
            }`}
          >
            {label}
          </p>
          <Icon
            className={`h-4 w-4 ${highlight ? "text-[#C9A24B]" : "text-[#6B5C32]"}`}
          />
        </div>
        <p
          className={`mt-1.5 text-2xl font-[800] tabular-nums leading-none ${
            highlight
              ? "text-white"
              : clear
                ? "text-[#15803D]"
                : "text-[#1F1D1B]"
          }`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

// ── Section card ──────────────────────────────────────────────────────────

function Section({
  title,
  subtitle,
  count,
  icon: Icon,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <Card className="rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] bg-white">
      <CardHeader className="flex flex-row items-start justify-between gap-3 p-5 pb-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-[#F5F2ED] p-2 mt-0.5">
            <Icon className="h-4 w-4 text-[#6B5C32]" />
          </div>
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <p className="text-xs text-[#9CA3AF] mt-0.5">{subtitle}</p>
          </div>
        </div>
        {count > 0 ? (
          <Badge className="bg-[#FEE2E2] text-[#B91C1C] border-[#FCA5A5] tabular-nums">
            {count}
          </Badge>
        ) : (
          <Badge className="bg-[#DCFCE7] text-[#15803D] border-[#BBF7D0]">
            Clear
          </Badge>
        )}
      </CardHeader>
      <CardContent className="p-5 pt-0">{children}</CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-[#F7FBF8] border border-[#DCF1E3] px-4 py-3">
      <CheckCircle2 className="h-4 w-4 text-[#15803D] shrink-0" />
      <span className="text-sm text-[#15803D]">
        All clear — nothing flagged.
      </span>
    </div>
  );
}

// Shared table chrome — thin head, hairline rows, link on first column.
function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`py-2 px-2 font-medium text-[11px] uppercase tracking-wide text-[#9CA3AF] ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
function Td({
  children,
  right = false,
  strong = false,
}: {
  children: React.ReactNode;
  right?: boolean;
  strong?: boolean;
}) {
  return (
    <td
      className={`py-2 px-2 align-middle ${right ? "text-right" : "text-left"} ${
        strong ? "font-semibold text-[#1F1D1B]" : "text-[#5A5550]"
      }`}
    >
      {children}
    </td>
  );
}

function RecordLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-0.5 font-semibold text-[#6B5C32] hover:text-[#4D4224] hover:underline"
    >
      {label}
      <ArrowUpRight className="h-3 w-3" />
    </Link>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function DailyReportPage() {
  const { data: raw, loading } =
    useCachedJson<ComplianceResp>("/api/reports/compliance.json");

  const data = useMemo<ComplianceData | null>(() => {
    if (!raw) return null;
    return raw.data ?? null;
  }, [raw]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Daily Report</h1>
          <p className="text-xs text-[#6B7280]">
            Process &amp; SOP exceptions — what needs attention today
          </p>
        </div>
        <Card>
          <CardContent className="p-12 text-center">
            <ClipboardCheck className="h-10 w-10 text-[#E2DDD8] mx-auto mb-3" />
            <p className="text-sm text-[#6B7280]">
              Could not load the report. Please try again.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { counts, groups } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Daily Report</h1>
          <p className="text-xs text-[#6B7280]">
            Process &amp; SOP exceptions — what needs attention today
          </p>
          <p className="text-[11px] text-[#9CA3AF] mt-1">
            {formatDateLong(data.today)} · Hookka Manufacturing ERP
          </p>
        </div>
      </div>

      {/* Count strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <CountTile
          label="Total Issues"
          value={counts.total}
          icon={ClipboardCheck}
          highlight
        />
        <CountTile
          label="DO Pending Dispatch"
          value={counts.doPendingDispatch}
          icon={Truck}
        />
        <CountTile
          label="DO Not Delivered"
          value={counts.doNotDelivered}
          icon={PackageCheck}
        />
        <CountTile
          label="DO Not Invoiced"
          value={counts.doNotInvoiced}
          icon={FileText}
        />
        <CountTile label="SO Without DO" value={counts.soNoDo} icon={ShoppingCart} />
        <CountTile
          label="SO Without Invoice"
          value={counts.soNoInvoice}
          icon={Receipt}
        />
        <CountTile
          label="Overdue Orders"
          value={counts.overdueOrders}
          icon={CalendarClock}
        />
        <CountTile
          label="PO Not Received"
          value={counts.poNotReceived}
          icon={PackageX}
        />
        <CountTile
          label="Low-Efficiency Workers"
          value={counts.lowEfficiencyWorkers}
          icon={Users}
        />
      </div>

      {/* All-clear banner */}
      {counts.total === 0 && (
        <Card className="rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] bg-[#F7FBF8] border-[#DCF1E3]">
          <CardContent className="p-6 flex items-center gap-3">
            <CheckCircle2 className="h-6 w-6 text-[#15803D] shrink-0" />
            <div>
              <p className="text-sm font-semibold text-[#15803D]">
                All clear — nothing flagged today.
              </p>
              <p className="text-xs text-[#15803D]/80">
                Every delivery, invoice, and purchase order is on track.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sections */}
      <div className="space-y-5">
        {/* DO pending dispatch */}
        <Section
          title="Deliveries Pending Dispatch"
          subtitle="DOs still in draft for more than 1 day — load them onto a truck."
          count={counts.doPendingDispatch}
          icon={Truck}
        >
          {groups.doPendingDispatch.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>DO No.</Th>
                    <Th>Customer</Th>
                    <Th>Created</Th>
                    <Th right>Waiting</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.doPendingDispatch.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink to="/delivery" label={r.doNo || "—"} />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>{formatDate(r.createdAt)}</Td>
                      <Td right>
                        <DaysBadge days={r.daysWaiting} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* DO not delivered */}
        <Section
          title="Dispatched But Not Delivered"
          subtitle="On the road for more than 1 day with no delivery confirmation."
          count={counts.doNotDelivered}
          icon={PackageCheck}
        >
          {groups.doNotDelivered.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>DO No.</Th>
                    <Th>Customer</Th>
                    <Th>Dispatched</Th>
                    <Th right>Since</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.doNotDelivered.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink to="/delivery" label={r.doNo || "—"} />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>{formatDate(r.dispatchedAt)}</Td>
                      <Td right>
                        <DaysBadge days={r.daysSinceDispatch} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* DO not invoiced */}
        <Section
          title="Delivered But Not Invoiced"
          subtitle="Delivered more than 1 day ago with no invoice raised — bill the customer."
          count={counts.doNotInvoiced}
          icon={FileText}
        >
          {groups.doNotInvoiced.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>DO No.</Th>
                    <Th>Customer</Th>
                    <Th>Delivered</Th>
                    <Th right>Since</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.doNotInvoiced.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink to="/delivery" label={r.doNo || "—"} />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>{formatDate(r.deliveredAt)}</Td>
                      <Td right>
                        <DaysBadge days={r.daysSinceDelivered} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* SO without DO */}
        <Section
          title="Sales Orders Without a Delivery Order"
          subtitle="Confirmed / ready-to-ship orders that have no delivery order yet."
          count={counts.soNoDo}
          icon={ShoppingCart}
        >
          {groups.soNoDo.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>SO No.</Th>
                    <Th>Customer</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.soNoDo.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink
                          to={`/sales/${r.id}`}
                          label={r.companySOId || "—"}
                        />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>
                        <Badge variant="status" status={r.status} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* SO without invoice */}
        <Section
          title="Sales Orders Without an Invoice"
          subtitle="Delivered / closed orders with no invoice on record."
          count={counts.soNoInvoice}
          icon={Receipt}
        >
          {groups.soNoInvoice.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>SO No.</Th>
                    <Th>Customer</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.soNoInvoice.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink
                          to={`/sales/${r.id}`}
                          label={r.companySOId || "—"}
                        />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>
                        <Badge variant="status" status={r.status} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Overdue orders */}
        <Section
          title="Overdue Orders"
          subtitle="Sales orders past their customer delivery date and not yet finished."
          count={counts.overdueOrders}
          icon={CalendarClock}
        >
          {groups.overdueOrders.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>SO No.</Th>
                    <Th>Customer</Th>
                    <Th>Products</Th>
                    <Th right>Qty</Th>
                    <Th>Customer DD</Th>
                    <Th right>Value</Th>
                    <Th right>Overdue</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.overdueOrders.map((r) => (
                    <tr key={r.salesOrderId} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink
                          to={`/sales/${r.salesOrderId}`}
                          label={r.companySOId || "—"}
                        />
                      </Td>
                      <Td>{r.customerName || "—"}</Td>
                      <Td>{r.productSummary || "—"}</Td>
                      <Td right>{r.totalQty || "—"}</Td>
                      <Td>{formatDate(r.customerDeliveryDate)}</Td>
                      <Td right>{formatRM(r.totalSen)}</Td>
                      <Td right>
                        <DaysBadge days={r.daysOverdue} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* PO not received */}
        <Section
          title="Purchase Orders Not Received"
          subtitle="Open for more than 14 days with no goods receipt or purchase invoice."
          count={counts.poNotReceived}
          icon={PackageX}
        >
          {groups.poNotReceived.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>PO No.</Th>
                    <Th>Supplier</Th>
                    <Th>Status</Th>
                    <Th>Ordered</Th>
                    <Th right>Open</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.poNotReceived.map((r) => (
                    <tr key={r.id} className="border-b border-[#F0ECE6]">
                      <Td strong>
                        <RecordLink
                          to={`/procurement/${r.id}`}
                          label={r.poNo || "—"}
                        />
                      </Td>
                      <Td>{r.supplierName || "—"}</Td>
                      <Td>
                        <Badge variant="status" status={r.status} />
                      </Td>
                      <Td>{formatDate(r.orderDate)}</Td>
                      <Td right>
                        <DaysBadge days={r.daysOpen} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Low-efficiency workers */}
        <Section
          title="Low-Efficiency Workers"
          subtitle="Below 60% efficiency yesterday (production time ÷ clocked time)."
          count={counts.lowEfficiencyWorkers}
          icon={Users}
        >
          {groups.lowEfficiencyWorkers.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <Th>Emp No.</Th>
                    <Th>Name</Th>
                    <Th>Department</Th>
                    <Th right>Jobs</Th>
                    <Th right>Efficiency</Th>
                  </tr>
                </thead>
                <tbody>
                  {groups.lowEfficiencyWorkers.map((r) => (
                    <tr key={r.empNo + r.name} className="border-b border-[#F0ECE6]">
                      <Td>{r.empNo || "—"}</Td>
                      <Td strong>
                        <RecordLink to="/employees" label={r.name || "—"} />
                      </Td>
                      <Td>{r.departmentName || "—"}</Td>
                      <Td right>{r.jobsCompleted}</Td>
                      <Td right>
                        <EffBadge pct={r.efficiencyPct} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <div className="flex justify-end">
        <Link to="/dashboard">
          <Button variant="outline" size="sm">
            Back to Dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}
