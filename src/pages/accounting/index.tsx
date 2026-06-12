import { useCallback, useEffect, useMemo, useState } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { humanizeError } from "@/lib/humanize-error";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { COA_TYPE_COLOR, SUCCESS, DANGER, INFO, WARNING, ACCENT_PLUM } from "@/lib/design-tokens";
import {
  BookOpen,
  TrendingUp,
  TrendingDown,
  DollarSign,
  FileText,
  ArrowUpRight,
  ArrowDownRight,
  Plus,
  ChevronRight,
  ChevronDown as ChevronDownIcon,
  Trash2,
  Check,
  X,
  CreditCard,
  LayoutDashboard,
  List,
  Users,
  Building2,
  BarChart3,
  Scale,
  Download,
  Filter,
  PieChart,
} from "lucide-react";
import type {
  ChartOfAccount,
  JournalEntry,
  JournalLine,
  ARAgingEntry,
  APAgingEntry,
  PLEntry,
  BalanceSheetEntry,
} from "@/types";

// =============== TYPES ===============

type TabKey = "overview" | "coa" | "journals" | "tb" | "gl" | "ar" | "ap" | "odc" | "pl" | "bs";

type MutationResponse = { success: true; error?: string } | { success: false; error?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

function asMutationResponse(v: unknown): MutationResponse | null {
  if (!isRecord(v)) return null;
  if (v.success === true) {
    return {
      success: true,
      error: typeof v.error === "string" ? v.error : undefined,
    };
  }
  if (v.success === false) {
    return {
      success: false,
      error: typeof v.error === "string" ? v.error : undefined,
    };
  }
  return null;
}

// Phase 2 follow-up (owner) — searchable account combobox: type a keyword
// (code or name fragment) to filter, click to pick. Headers (isPostable
// false) are excluded — journals must hit leaf accounts.
function AccountPicker({
  accounts,
  value,
  onChange,
  placeholder,
  allowAll,
}: {
  accounts: ChartOfAccount[];
  value: string;
  onChange: (code: string) => void;
  placeholder?: string;
  allowAll?: boolean;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const selected = accounts.find((a) => a.code === value);
  const shown = open
    ? text
    : selected
      ? `${selected.code} - ${selected.name}`
      : allowAll && value === ""
        ? ""
        : text;
  const kw = text.trim().toLowerCase();
  const matches = accounts
    .filter((a) => a.isPostable !== false && a.isActive !== false)
    .filter(
      (a) =>
        !kw ||
        a.code.toLowerCase().includes(kw) ||
        a.name.toLowerCase().includes(kw),
    )
    .slice(0, 50);
  return (
    <div className="relative">
      <input
        type="text"
        value={shown}
        placeholder={placeholder ?? "Type code or name…"}
        onFocus={() => {
          setOpen(true);
          setText("");
        }}
        // eslint-disable-next-line no-restricted-syntax -- event-handler-only delay so the option's onMouseDown fires before the dropdown closes; not a React render timer
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
      />
      {open && (
        <div className="absolute z-20 mt-1 max-h-64 w-full min-w-72 overflow-y-auto rounded-md border border-[#E2DDD8] bg-white shadow-lg">
          {allowAll && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange("");
                setText("");
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-[#6B7280] hover:bg-[#F0ECE9] cursor-pointer"
            >
              (All accounts)
            </button>
          )}
          {matches.map((a) => (
            <button
              key={a.code}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(a.code);
                setText("");
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[#F0ECE9] cursor-pointer"
            >
              <span className="font-mono text-xs text-[#6B7280] mr-2">{a.code}</span>
              {a.name}
            </button>
          ))}
          {matches.length === 0 && (
            <div className="px-3 py-2 text-sm text-[#9CA3AF]">No match</div>
          )}
        </div>
      )}
    </div>
  );
}

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "overview", label: "Overview", icon: <LayoutDashboard className="h-4 w-4" /> },
  { key: "pl", label: "P&L Report", icon: <BarChart3 className="h-4 w-4" /> },
  { key: "bs", label: "Balance Sheet", icon: <Scale className="h-4 w-4" /> },
  { key: "coa", label: "Chart of Accounts", icon: <List className="h-4 w-4" /> },
  { key: "journals", label: "Journal Entries", icon: <BookOpen className="h-4 w-4" /> },
  { key: "tb", label: "Trial Balance", icon: <Scale className="h-4 w-4" /> },
  { key: "gl", label: "General Ledger", icon: <FileText className="h-4 w-4" /> },
  { key: "ar", label: "Accounts Receivable", icon: <Users className="h-4 w-4" /> },
  { key: "ap", label: "Accounts Payable", icon: <Building2 className="h-4 w-4" /> },
  { key: "odc", label: "Other D/C", icon: <Users className="h-4 w-4" /> },
];

// =============== MAIN PAGE ===============

export default function AccountingPage() {
  const [tab, setTab] = useState<TabKey>("overview");
  const { data: coaResp, loading: coaLoading, refresh: refreshCoa } = useCachedJson<{ success?: boolean; data?: ChartOfAccount[] }>("/api/accounting/coa");
  const { data: jeResp, loading: jeLoading, refresh: refreshJe } = useCachedJson<{ success?: boolean; data?: JournalEntry[] }>("/api/accounting/journals");
  const { data: agingResp, loading: agingLoading, refresh: refreshAging } = useCachedJson<{ success?: boolean; data?: { ar: ARAgingEntry[]; ap: APAgingEntry[] } }>("/api/accounting/aging");

  const accounts: ChartOfAccount[] = useMemo(() => (coaResp?.success ? coaResp.data ?? [] : []), [coaResp]);
  const journals: JournalEntry[] = useMemo(() => (jeResp?.success ? jeResp.data ?? [] : []), [jeResp]);
  const arData: ARAgingEntry[] = useMemo(() => (agingResp?.success ? agingResp.data?.ar ?? [] : []), [agingResp]);
  const apData: APAgingEntry[] = useMemo(() => (agingResp?.success ? agingResp.data?.ap ?? [] : []), [agingResp]);
  const loading = coaLoading || jeLoading || agingLoading;

  const fetchAll = useCallback(() => {
    invalidateCachePrefix("/api/accounting");
    refreshCoa();
    refreshJe();
    refreshAging();
  }, [refreshCoa, refreshJe, refreshAging]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Accounting</h1>
          <p className="text-xs text-[#6B7280]">General ledger, accounts receivable, and accounts payable</p>
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

      <GstRateCard />
      <FyeCard />
      <StockMapCard />

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-[#6B7280]">Loading accounting data...</div>
        </div>
      ) : (
        <>
          {tab === "overview" && (
            <OverviewTab accounts={accounts} journals={journals} arData={arData} apData={apData} />
          )}
          {tab === "pl" && <PLReportTab />}
          {tab === "bs" && <BalanceSheetTab />}
          {tab === "coa" && <COATab accounts={accounts} onRefresh={fetchAll} />}
          {tab === "journals" && (
            <JournalsTab journals={journals} accounts={accounts} onRefresh={fetchAll} />
          )}
          {tab === "tb" && <TrialBalanceTab />}
          {tab === "gl" && <GeneralLedgerTab accounts={accounts} />}
          {tab === "ar" && <ARTab arData={arData} onRefresh={fetchAll} />}
          {tab === "ap" && <APTab apData={apData} onRefresh={fetchAll} />}
          {tab === "odc" && <OtherPartiesTab />}
        </>
      )}
    </div>
  );
}

// =============== TAB 1: OVERVIEW ===============

// Operator-configurable GST/SST rate (kv_config key `gst_rate_pct`).
// Applied automatically when a sales invoice is posted (Phase 4).
function GstRateCard() {
  const { toast } = useToast();
  const [pct, setPct] = useState<number>(0);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    fetch("/api/kv-config/gst_rate_pct")
      .then((r) => r.json() as Promise<{ data?: { pct?: number } | null }>)
      .then((j) => {
        const v = (j?.data as { pct?: number } | null)?.pct;
        if (typeof v === "number" && isFinite(v)) setPct(v);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  const save = async () => {
    if (!(pct >= 0 && pct <= 100)) {
      toast.error("GST rate must be between 0 and 100");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/kv-config/gst_rate_pct", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pct }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (j?.success) toast.success(`GST rate saved: ${pct}%`);
      else toast.error(j?.error || "Failed to save GST rate");
    } catch {
      toast.error("Failed to save GST rate");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="mb-4">
      <CardContent className="p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="text-xs font-medium text-[#6B7280] mb-1 block">
            GST / SST Rate (%)
          </label>
          <input
            type="number"
            step="0.01"
            min={0}
            max={100}
            value={pct}
            disabled={!loaded}
            onChange={(e) => setPct(Number(e.target.value))}
            className="w-32 rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={save}
          disabled={saving || !loaded}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <p className="text-[11px] text-[#9CA3AF] max-w-sm">
          Applied automatically when a sales invoice is posted: tax =
          subtotal × this rate, credited to GST 350-0000. 0 = no GST.
        </p>
      </CardContent>
    </Card>
  );
}

// Operator-configurable financial year end (kv_config key `fye_month`).
// Phase 1 (2026-06): every fiscal-year-aware report (P&L YTD window,
// quarter/half buckets, year-end profit close, cost-structure pages)
// reads this single setting.
function FyeCard() {
  const { toast } = useToast();
  const [month, setMonth] = useState<number>(12);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const MONTHS = [
    "31 Jan", "28/29 Feb", "31 Mar", "30 Apr", "31 May", "30 Jun",
    "31 Jul", "31 Aug", "30 Sep", "31 Oct", "30 Nov", "31 Dec",
  ];
  useEffect(() => {
    fetch("/api/kv-config/fye_month")
      .then((r) => r.json() as Promise<{ data?: { month?: number } | null }>)
      .then((j) => {
        const v = (j?.data as { month?: number } | null)?.month;
        if (typeof v === "number" && v >= 1 && v <= 12) setMonth(v);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/kv-config/fye_month", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (j?.success) toast.success(`Financial year end saved: ${MONTHS[month - 1]}`);
      else toast.error(j?.error || "Failed to save FYE");
    } catch {
      toast.error("Failed to save FYE");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="mb-4">
      <CardContent className="p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="text-xs font-medium text-[#6B7280] mb-1 block">
            Financial Year End (FYE)
          </label>
          <select
            value={month}
            disabled={!loaded}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="w-36 rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
          >
            {MONTHS.map((label, i) => (
              <option key={i + 1} value={i + 1}>{label}</option>
            ))}
          </select>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={save}
          disabled={saving || !loaded}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <p className="text-[11px] text-[#9CA3AF] max-w-sm">
          Sets the FY window for YTD figures, quarter/half buckets, the
          year-end profit close and cost-structure pages. Changing it after
          posting re-bases historical YTD groupings — set once at go-live.
        </p>
      </CardContent>
    </Card>
  );
}

// Operator-editable inventory → stock/opening/closing account mapping
// (kv_config key `coa_stock_map`). Drives the detailed closing-stock
// breakdown in the Manufacturing Account. Empty = built-in default.
function StockMapCard() {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    fetch("/api/kv-config/coa_stock_map")
      .then((r) => r.json() as Promise<{ data?: unknown }>)
      .then((j) => {
        if (j?.data) setText(JSON.stringify(j.data, null, 2));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      toast.error("Mapping must be valid JSON");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/kv-config/coa_stock_map", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (j?.success) toast.success("Stock account mapping saved");
      else toast.error(j?.error || "Failed to save mapping");
    } catch {
      toast.error("Failed to save mapping");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="mb-4">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-[#1F1D1B]">
            Inventory → Stock Account Mapping
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={saving || !loaded}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-[11px] text-[#9CA3AF] mb-2">
          Maps each raw-material item_group (+ WIP, FG) to its stock /
          opening / closing accounts for the detailed Manufacturing-account
          breakdown AND the purchase account a purchase-invoice line posts
          to (per material item_group). Leave blank for the built-in
          default. Shape:{" "}
          <code>{`{ "rmDefault": {...}, "rm": { "FABRIC": {"stock":"330-0001","opening":"701-0001","closing":"701-9991","purchase":"701-0010"} }, "wip": {...}, "fg": {...} }`}</code>
        </p>
        <textarea
          value={text}
          disabled={!loaded}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="(empty — built-in default mapping in effect)"
          className="w-full font-mono text-xs rounded-md border border-[#E2DDD8] px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
        />
      </CardContent>
    </Card>
  );
}

function OverviewTab({
  accounts,
  journals,
  arData,
  apData,
}: {
  accounts: ChartOfAccount[];
  journals: JournalEntry[];
  arData: ARAgingEntry[];
  apData: APAgingEntry[];
}) {
  const revenue = accounts
    .filter((a) => a.type === "REVENUE" && a.parentCode)
    .reduce((s, a) => s + a.balance, 0);
  const expenses = accounts
    .filter((a) => a.type === "EXPENSE" && a.parentCode)
    .reduce((s, a) => s + a.balance, 0);
  const netProfit = revenue - expenses;
  const totalAR = arData.reduce(
    (s, a) => s + a.currentSen + a.days30Sen + a.days60Sen + a.days90Sen + a.over90Sen,
    0
  );
  const totalAP = apData.reduce(
    (s, a) => s + a.currentSen + a.days30Sen + a.days60Sen + a.days90Sen + a.over90Sen,
    0
  );

  // Aggregate aging buckets
  const arBuckets = [
    { period: "Current", amountSen: arData.reduce((s, a) => s + a.currentSen, 0) },
    { period: "1 month", amountSen: arData.reduce((s, a) => s + a.days30Sen, 0) },
    { period: "2 months", amountSen: arData.reduce((s, a) => s + a.days60Sen, 0) },
    { period: "3 months", amountSen: arData.reduce((s, a) => s + a.days90Sen, 0) },
    { period: "3+ months", amountSen: arData.reduce((s, a) => s + a.over90Sen, 0) },
  ];
  const apBuckets = [
    { period: "Current", amountSen: apData.reduce((s, a) => s + a.currentSen, 0) },
    { period: "1 month", amountSen: apData.reduce((s, a) => s + a.days30Sen, 0) },
    { period: "2 months", amountSen: apData.reduce((s, a) => s + a.days60Sen, 0) },
    { period: "3 months", amountSen: apData.reduce((s, a) => s + a.days90Sen, 0) },
    { period: "3+ months", amountSen: apData.reduce((s, a) => s + a.over90Sen, 0) },
  ];

  const recentJournals = journals.slice(0, 5);

  const recentColumns: Column<JournalEntry>[] = [
    {
      key: "entryNo",
      label: "Entry No.",
      render: (value, row) => <span className="doc-number font-medium">{row.entryNo}</span>,
    },
    {
      key: "date",
      label: "Date",
      render: (value, row) => <span className="text-[#4B5563]">{formatDateDMY(row.date)}</span>,
    },
    {
      key: "description",
      label: "Description",
      render: (value, row) => <span className="font-medium text-[#1F1D1B]">{row.description}</span>,
    },
    {
      key: "totalDebit",
      label: "Total Debit",
      align: "right",
      render: (value, row) => {
        const total = row.lines.reduce((s, l) => s + l.debitSen, 0);
        return <span className="amount font-medium">{formatRM(total)}</span>;
      },
    },
    {
      key: "status",
      label: "Status",
      render: (value, row) => (
        <Badge variant="status" status={row.status}>
          {row.status}
        </Badge>
      ),
    },
  ];

  const overviewContextMenu: ContextMenuItem[] = [
    { label: "View", action: () => {} },
    { label: "Edit", action: () => {} },
    { separator: true, label: "", action: () => {} },
    { label: "Refresh", action: () => {} },
  ];

  return (
    <>
      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-5">
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Revenue (MTD)</p>
              <p className="text-xl font-bold text-[#4F7C3A]">{formatCurrency(revenue)}</p>
            </div>
            <ArrowUpRight className="h-5 w-5 text-[#4F7C3A]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Expenses (MTD)</p>
              <p className="text-xl font-bold text-[#9A3A2D]">{formatCurrency(expenses)}</p>
            </div>
            <ArrowDownRight className="h-5 w-5 text-[#9A3A2D]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Net Profit</p>
              <p className={`text-xl font-bold ${netProfit >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>
                {formatCurrency(netProfit)}
              </p>
            </div>
            <DollarSign className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">AR Outstanding</p>
              <p className="text-xl font-bold text-[#9C6F1E]">{formatCurrency(totalAR)}</p>
            </div>
            <TrendingUp className="h-5 w-5 text-[#9C6F1E]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">AP Outstanding</p>
              <p className="text-xl font-bold text-[#3E6570]">{formatCurrency(totalAP)}</p>
            </div>
            <TrendingDown className="h-5 w-5 text-[#3E6570]" />
          </CardContent>
        </Card>
      </div>

      {/* AR & AP Aging Summary */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        <AgingCard title="Accounts Receivable Aging" icon={<TrendingUp className="h-5 w-5 text-[#6B5C32]" />} buckets={arBuckets} barColor="bg-[#6B5C32]" />
        <AgingCard title="Accounts Payable Aging" icon={<TrendingDown className="h-5 w-5 text-[#6B5C32]" />} buckets={apBuckets} barColor="bg-[#9C6F1E]" />
      </div>

      {/* Recent Journal Entries */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-[#6B5C32]" />
            Recent Journal Entries
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid
            columns={recentColumns}
            data={recentJournals}
            keyField="id"
            virtualize
            gridId="accounting-overview-journals"
            contextMenuItems={overviewContextMenu}
          />
        </CardContent>
      </Card>
    </>
  );
}

function AgingCard({
  title,
  icon,
  buckets,
  barColor,
}: {
  title: string;
  icon: React.ReactNode;
  buckets: { period: string; amountSen: number }[];
  barColor: string;
}) {
  const total = buckets.reduce((s, b) => s + b.amountSen, 0);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {buckets.map((item) => {
            const pct = total > 0 ? Math.round((item.amountSen / total) * 100) : 0;
            return (
              <div key={item.period} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[#4B5563]">{item.period}</span>
                  <span className="font-medium text-[#1F1D1B]">{formatCurrency(item.amountSen)}</span>
                </div>
                <div className="h-2 bg-[#F0ECE9] rounded-full overflow-hidden">
                  <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          <div className="flex items-center justify-between text-sm font-semibold pt-2 border-t border-[#E2DDD8]">
            <span className="text-[#1F1D1B]">Total</span>
            <span className="text-[#1F1D1B]">{formatCurrency(total)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// =============== TAB 2: CHART OF ACCOUNTS ===============

function COATab({ accounts, onRefresh }: { accounts: ChartOfAccount[]; onRefresh: () => void }) {
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    code: "",
    name: "",
    type: "ASSET" as ChartOfAccount["type"],
    parentCode: "",
    cashFlowCategory: "" as "" | "O" | "I" | "F",
    specialAccountType: "",
    pnlCategory: "" as "" | "FIXED" | "VARIABLE" | "OTHERS",
  });
  const [editCode, setEditCode] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // Phase 2 follow-up (owner) — nine balance-sheet/P&L sections instead of
  // the six raw DB types, classified from type + account-number band per
  // the owner's workbook:
  //   ASSET   <300 → Non-Current Assets; ≥300 → Current Assets
  //   LIABILITY 480-489 (hire purchase) → Non-Current; else Current
  //   REVENUE ≥530 (forex gain, discount received) → Other Income
  //   COST → Cost of Goods Sold · EXPENSE → Expenses · EQUITY → Equity
  const SECTIONS = [
    { key: "NCA", label: "Non-Current Assets", type: "ASSET" as const },
    { key: "CA", label: "Current Assets", type: "ASSET" as const },
    { key: "CL", label: "Current Liabilities", type: "LIABILITY" as const },
    { key: "NCL", label: "Non-Current Liabilities", type: "LIABILITY" as const },
    { key: "EQ", label: "Equity", type: "EQUITY" as const },
    { key: "REV", label: "Revenue", type: "REVENUE" as const },
    { key: "COGS", label: "Cost of Goods Sold", type: "COST" as const },
    { key: "OI", label: "Other Income", type: "REVENUE" as const },
    { key: "EXP", label: "Expenses", type: "EXPENSE" as const },
  ];
  const sectionOf = (a: ChartOfAccount): string => {
    const p = parseInt(a.code.split("-")[0], 10) || 0;
    switch (a.type) {
      case "ASSET":
        return p < 300 ? "NCA" : "CA";
      case "LIABILITY":
        return p >= 480 && p < 490 ? "NCL" : "CL";
      case "EQUITY":
        return "EQ";
      case "REVENUE":
        return p >= 530 ? "OI" : "REV";
      case "COST":
        return "COGS";
      default:
        return "EXP";
    }
  };
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    Object.fromEntries(SECTIONS.map((s) => [s.key, true])),
  );
  // Per-parent expand/collapse (owner request) — default expanded;
  // a missing key means expanded.
  const [collapsedParents, setCollapsedParents] = useState<Record<string, boolean>>({});

  const typeOrder: ChartOfAccount["type"][] = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "COST", "EXPENSE"];
  const typeLabels: Record<string, string> = {
    ASSET: "Assets",
    LIABILITY: "Liabilities",
    EQUITY: "Equity",
    REVENUE: "Revenue",
    COST: "Cost of Production",
    EXPENSE: "Expenses",
  };
  // Use the canonical COA type palette from design-tokens.
  // Colour meaning (accounting convention):
  //   ASSET=info, LIABILITY=danger, EQUITY=plum, REVENUE=success, EXPENSE=warning.
  const typeColors: Record<string, string> = {
    ASSET:     `${COA_TYPE_COLOR.ASSET.bg} ${COA_TYPE_COLOR.ASSET.text} ${COA_TYPE_COLOR.ASSET.border}`,
    LIABILITY: `${COA_TYPE_COLOR.LIABILITY.bg} ${COA_TYPE_COLOR.LIABILITY.text} ${COA_TYPE_COLOR.LIABILITY.border}`,
    EQUITY:    `${COA_TYPE_COLOR.EQUITY.bg} ${COA_TYPE_COLOR.EQUITY.text} ${COA_TYPE_COLOR.EQUITY.border}`,
    REVENUE:   `${COA_TYPE_COLOR.REVENUE.bg} ${COA_TYPE_COLOR.REVENUE.text} ${COA_TYPE_COLOR.REVENUE.border}`,
    COST:      `${COA_TYPE_COLOR.COST.bg} ${COA_TYPE_COLOR.COST.text} ${COA_TYPE_COLOR.COST.border}`,
    EXPENSE:   `${COA_TYPE_COLOR.EXPENSE.bg} ${COA_TYPE_COLOR.EXPENSE.text} ${COA_TYPE_COLOR.EXPENSE.border}`,
  };

  const handleAdd = async () => {
    const res = await fetch("/api/accounting/coa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });
    const data = asMutationResponse(await res.json());
    if (data?.success) {
      setShowForm(false);
      setFormData({
        code: "",
        name: "",
        type: "ASSET",
        parentCode: "",
        cashFlowCategory: "",
        specialAccountType: "",
        pnlCategory: "",
      });
      onRefresh();
    } else {
      toast.error(data?.error || "Failed to create account");
    }
  };

  // Phase 1 — quick per-row P&L category tagging (FIXED / VARIABLE /
  // OTHERS). Drives the expense grouping on the Phase-5 reports.
  const handleSetPnl = async (code: string, value: string) => {
    const res = await fetch("/api/accounting/coa", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, pnlCategory: value || null }),
    });
    const data = asMutationResponse(await res.json());
    if (data?.success) onRefresh();
    else toast.error(data?.error || "Failed to update P&L category");
  };

  const handleEdit = async (code: string) => {
    const res = await fetch("/api/accounting/coa", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: editName }),
    });
    const data = asMutationResponse(await res.json());
    if (data?.success) {
      setEditCode(null);
      onRefresh();
    }
  };

  const handleDeactivate = async (code: string) => {
    const res = await fetch("/api/accounting/coa", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, isActive: false }),
    });
    const data = asMutationResponse(await res.json());
    if (data?.success) onRefresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Chart of Accounts</h2>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4" /> Add Account
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Code</label>
                <input
                  type="text"
                  placeholder="100-0003"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Name</label>
                <input
                  type="text"
                  placeholder="Account Name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Type</label>
                <select
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value as ChartOfAccount["type"] })}
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  {typeOrder.map((t) => (
                    <option key={t} value={t}>{typeLabels[t]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Parent Code</label>
                <select
                  value={formData.parentCode}
                  onChange={(e) => setFormData({ ...formData, parentCode: e.target.value })}
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  <option value="">(None - Top Level)</option>
                  {accounts
                    .filter((a) => a.type === formData.type)
                    .map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Cash Flow</label>
                <select
                  value={formData.cashFlowCategory}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      cashFlowCategory: e.target.value as "" | "O" | "I" | "F",
                    })
                  }
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  <option value="">(None)</option>
                  <option value="O">Operating</option>
                  <option value="I">Investing</option>
                  <option value="F">Financing</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Special Type</label>
                <input
                  type="text"
                  placeholder="e.g. SDC, SBK (optional)"
                  value={formData.specialAccountType}
                  onChange={(e) =>
                    setFormData({ ...formData, specialAccountType: e.target.value })
                  }
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">P&L Category</label>
                <select
                  value={formData.pnlCategory}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      pnlCategory: e.target.value as "" | "FIXED" | "VARIABLE" | "OTHERS",
                    })
                  }
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  <option value="">(None)</option>
                  <option value="FIXED">Fixed</option>
                  <option value="VARIABLE">Variable</option>
                  <option value="OTHERS">Others</option>
                </select>
              </div>
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={handleAdd}>
                  Save
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {SECTIONS.map((section) => {
        const type = section.type;
        const typeAccounts = accounts.filter((a) => sectionOf(a) === section.key);
        // Owner (round 3) — the COA is a REAL multi-level tree, e.g.
        // 700-0000 MANUFACTURING ACCOUNT → 701-0000 PURCHASE - FABRIC →
        // 701-0010 PURCHASE - B.M FABRIC. Render it RECURSIVELY (any
        // depth), AutoCount-style: every node with children gets a caret
        // and collapses; code-sorted at every level. Postable parents
        // (e.g. 410-0000 ACCRUALS) keep their balance + actions alongside
        // the caret; non-postable headers show the sub-account count.
        const byCode = (x: ChartOfAccount, y: ChartOfAccount) =>
          x.code.localeCompare(y.code);
        const kidsOf = (code: string) =>
          typeAccounts.filter((a) => a.parentCode === code).sort(byCode);
        const codesInSection = new Set(typeAccounts.map((a) => a.code));
        const treeTops = typeAccounts
          .filter((a) => !a.parentCode || !codesInSection.has(a.parentCode))
          .sort(byCode);
        const isExpanded = expanded[section.key];

        const renderNode = (node: ChartOfAccount, depth: number): React.ReactNode => {
          const kids = kidsOf(node.code);
          const hasKids = kids.length > 0;
          const open = !collapsedParents[node.code];
          const isHeader = node.isPostable === false;
          return (
            <div key={node.code}>
              <div
                className={`flex items-center justify-between py-2 pr-2 text-sm border-b ${isHeader ? "bg-[#F0ECE9]/60 border-[#E2DDD8] font-semibold text-[#1F1D1B]" : "border-[#F0ECE9] hover:bg-[#F0ECE9]/30"} ${hasKids ? "cursor-pointer" : ""} group`}
                style={{ paddingLeft: `${8 + depth * 22}px` }}
                onClick={
                  hasKids
                    ? () =>
                        setCollapsedParents({
                          ...collapsedParents,
                          [node.code]: open,
                        })
                    : undefined
                }
              >
                <div className="flex items-center gap-2">
                  {hasKids ? (
                    open ? (
                      <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[#6B5C32]" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#6B5C32]" />
                    )
                  ) : (
                    <span className="w-3.5 shrink-0" />
                  )}
                  <span className="text-[#6B7280] font-mono text-xs">{node.code}</span>
                  {editCode === node.code ? (
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleEdit(node.code)}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded border border-[#E2DDD8] px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                      autoFocus
                    />
                  ) : (
                    <span className={isHeader ? "" : "text-[#1F1D1B]"}>{node.name}</span>
                  )}
                </div>
                <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                  {isHeader ? (
                    <span className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">
                      {kids.length} sub-accounts
                    </span>
                  ) : (
                    <>
                      {(node.type === "EXPENSE" || node.type === "COST") && (
                        <select
                          value={node.pnlCategory ?? ""}
                          onChange={(e) => handleSetPnl(node.code, e.target.value)}
                          className="rounded border border-[#E2DDD8] bg-white px-1 py-0.5 text-[11px] text-[#6B7280] focus:outline-none"
                          title="P&L category (Fixed / Variable / Others)"
                        >
                          <option value="">P&L: —</option>
                          <option value="FIXED">Fixed</option>
                          <option value="VARIABLE">Variable</option>
                          <option value="OTHERS">Others</option>
                        </select>
                      )}
                      <span className={`font-medium ${node.balance < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                        {formatCurrency(Math.abs(node.balance))}
                        {node.balance < 0 ? " CR" : ""}
                      </span>
                      <div className="flex gap-1">
                        {editCode === node.code ? (
                          <>
                            <button onClick={() => handleEdit(node.code)} className="text-[#4F7C3A] hover:text-[#3D6329] p-1 cursor-pointer"><Check className="h-3.5 w-3.5" /></button>
                            <button onClick={() => setEditCode(null)} className="text-[#6B7280] hover:text-[#1F1D1B] p-1 cursor-pointer"><X className="h-3.5 w-3.5" /></button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => { setEditCode(node.code); setEditName(node.name); }}
                              className="text-[#6B7280] hover:text-[#6B5C32] p-1 cursor-pointer"
                              title="Edit"
                            >
                              <FileText className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeactivate(node.code)}
                              className="text-[#6B7280] hover:text-[#9A3A2D] p-1 cursor-pointer"
                              title="Deactivate"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
              {hasKids && open && kids.map((k) => renderNode(k, depth + 1))}
            </div>
          );
        };

        return (
          <Card key={section.key}>
            <div
              className="flex items-center justify-between p-4 cursor-pointer hover:bg-[#F0ECE9]/50"
              onClick={() => setExpanded({ ...expanded, [section.key]: !isExpanded })}
            >
              <div className="flex items-center gap-2">
                {isExpanded ? <ChevronDownIcon className="h-4 w-4 text-[#6B7280]" /> : <ChevronRight className="h-4 w-4 text-[#6B7280]" />}
                <span className="font-semibold text-[#1F1D1B]">{section.label}</span>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${typeColors[type]}`}>
                  {typeAccounts.length} accounts
                </span>
              </div>
              <span className="font-semibold text-[#1F1D1B]">
                {formatCurrency(typeAccounts.filter((a) => a.isPostable !== false).reduce((s, a) => s + a.balance, 0))}
              </span>
            </div>
            {isExpanded && (
              <CardContent className="pt-0 pb-2">
                <div className="border-t border-[#E2DDD8]">
                  {treeTops.map((node) => renderNode(node, 0))}
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// =============== TAB 3: JOURNAL ENTRIES ===============

function JournalsTab({
  journals,
  accounts,
  onRefresh,
}: {
  journals: JournalEntry[];
  accounts: ChartOfAccount[];
  onRefresh: () => void;
}) {
  const [showForm, setShowForm] = useState(false);

  const handlePost = async (id: string) => {
    await fetch(`/api/accounting/journals/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "POSTED" }),
    });
    onRefresh();
  };

  const handleReverse = async (id: string) => {
    await fetch(`/api/accounting/journals/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "REVERSED" }),
    });
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/accounting/journals/${id}`, { method: "DELETE" });
      if (!res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json().catch(() => ({}));
        alert(humanizeError({ status: res.status, message: body?.error }, "Couldn't delete the journal entry. Please try again."));
        return;
      }
      onRefresh();
    } catch (e) {
      alert(humanizeError(e, "Couldn't delete the journal entry. Please try again."));
    }
  };

  const columns: Column<JournalEntry>[] = [
    {
      key: "entryNo",
      label: "Entry No.",
      render: (value, row) => <span className="doc-number font-medium">{row.entryNo}</span>,
    },
    {
      key: "date",
      label: "Date",
      render: (value, row) => <span className="text-[#4B5563]">{formatDateDMY(row.date)}</span>,
    },
    {
      key: "description",
      label: "Description",
      render: (value, row) => <span className="font-medium text-[#1F1D1B]">{row.description}</span>,
    },
    {
      key: "totalDebit",
      label: "Total Debit",
      align: "right",
      render: (value, row) => {
        const total = row.lines.reduce((s, l) => s + l.debitSen, 0);
        return <span className="amount font-medium">{formatRM(total)}</span>;
      },
    },
    {
      key: "totalCredit",
      label: "Total Credit",
      align: "right",
      render: (value, row) => {
        const total = row.lines.reduce((s, l) => s + l.creditSen, 0);
        return <span className="amount font-medium">{formatRM(total)}</span>;
      },
    },
    {
      key: "status",
      label: "Status",
      render: (value, row) => (
        <Badge variant="status" status={row.status}>
          {row.status}
        </Badge>
      ),
    },
  ];

  const contextMenuItems = (row: JournalEntry): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: "View", action: () => {} },
    ];
    if (row.status === "DRAFT") {
      items.push({ label: "Post", action: (r) => handlePost(r.id) });
      items.push({ label: "Delete", danger: true, action: (r) => handleDelete(r.id) });
    }
    if (row.status === "POSTED") {
      items.push({ label: "Reverse", action: (r) => handleReverse(r.id) });
    }
    items.push({ separator: true, label: "", action: () => {} });
    items.push({ label: "Refresh", action: () => onRefresh() });
    return items;
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Journal Entries</h2>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
          <FileText className="h-4 w-4" /> New Journal Entry
        </Button>
      </div>

      {showForm && <JournalEntryForm accounts={accounts} onSave={() => { setShowForm(false); onRefresh(); }} onCancel={() => setShowForm(false)} />}

      <Card>
        <CardContent className="p-4">
          <DataGrid
            columns={columns}
            data={journals}
            keyField="id"
            virtualize
            gridId="accounting-journals"
            contextMenuItems={contextMenuItems}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function JournalEntryForm({
  accounts,
  onSave,
  onCancel,
}: {
  accounts: ChartOfAccount[];
  onSave: () => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [description, setDescription] = useState("");
  // Editor rows carry a client-only `_uid` so React keys stay stable as rows
  // are added / removed / reordered. The uid is stripped before POST in
  // handleSave().  See sprint 7 — replacing key={idx} on mutable rows.
  type JournalLineRow = JournalLine & { _uid: string };
  const newRow = (): JournalLineRow => ({
    _uid: crypto.randomUUID(),
    accountCode: "",
    accountName: "",
    debitSen: 0,
    creditSen: 0,
    description: "",
  });
  const [lines, setLines] = useState<JournalLineRow[]>([newRow(), newRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Postable accounts only (headers excluded). Phase 2 fix: the old
  // `parentCode` filter also dropped legitimate TOP-LEVEL postable
  // accounts (300-0000, 100-0000, …) from the journal picker entirely.
  const leafAccounts = accounts.filter((a) => a.isPostable !== false);

  const totalDebit = lines.reduce((s, l) => s + l.debitSen, 0);
  const totalCredit = lines.reduce((s, l) => s + l.creditSen, 0);
  const isBalanced = totalDebit === totalCredit && totalDebit > 0;

  const updateLine = (idx: number, field: string, value: string | number) => {
    const updated = [...lines];
    if (field === "accountCode") {
      const acc = accounts.find((a) => a.code === value);
      updated[idx] = { ...updated[idx], accountCode: value as string, accountName: acc?.name || "" };
    } else if (field === "debitSen" || field === "creditSen") {
      // Convert from ringgit input to sen
      const sen = Math.round(Number(value) * 100);
      updated[idx] = { ...updated[idx], [field]: sen };
    } else {
      updated[idx] = { ...updated[idx], [field]: value };
    }
    setLines(updated);
  };

  const addLine = () => {
    setLines([...lines, newRow()]);
  };

  const removeLine = (idx: number) => {
    if (lines.length <= 2) return;
    setLines(lines.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setError("");
    if (!date || !description) {
      setError("Date and description are required");
      return;
    }
    if (!isBalanced) {
      setError("Debits must equal credits and be non-zero");
      return;
    }
    const validLines = lines.filter((l) => l.accountCode && (l.debitSen > 0 || l.creditSen > 0));
    if (validLines.length < 2) {
      setError("At least 2 lines with amounts are required");
      return;
    }
    // Strip the client-only `_uid` so the server receives a clean JournalLine[].
    const payloadLines = validLines.map((l) => {
      const { _uid: _drop, ...rest } = l;
      void _drop;
      return rest;
    });

    setSaving(true);
    const res = await fetch("/api/accounting/journals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, description, lines: payloadLines }),
    });
    const data = asMutationResponse(await res.json());
    setSaving(false);

    if (data?.success) {
      onSave();
    } else {
      setError(data?.error || "Failed to save journal entry");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>New Journal Entry</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {error && (
            <div className={`rounded-md ${DANGER.bg} ${DANGER.border} border ${DANGER.text} px-4 py-2 text-sm`}>{error}</div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Description</label>
              <input
                type="text"
                placeholder="Journal entry description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              />
            </div>
          </div>

          {/* Lines Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-left">
                  <th className="py-2 px-2 text-[#6B7280] font-medium">Account</th>
                  <th className="py-2 px-2 text-[#6B7280] font-medium w-36">Debit (RM)</th>
                  <th className="py-2 px-2 text-[#6B7280] font-medium w-36">Credit (RM)</th>
                  <th className="py-2 px-2 text-[#6B7280] font-medium">Line Description</th>
                  <th className="py-2 px-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={line._uid} className="border-b border-[#F0ECE9]">
                    <td className="py-1.5 px-2">
                      <AccountPicker
                        accounts={leafAccounts}
                        value={line.accountCode}
                        onChange={(code) => updateLine(idx, "accountCode", code)}
                        placeholder="Type code or name…"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="number" onFocus={(e) => e.currentTarget.select()}
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={line.debitSen ? (line.debitSen / 100).toFixed(2) : ""}
                        onChange={(e) => updateLine(idx, "debitSen", e.target.value)}
                        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="number" onFocus={(e) => e.currentTarget.select()}
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={line.creditSen ? (line.creditSen / 100).toFixed(2) : ""}
                        onChange={(e) => updateLine(idx, "creditSen", e.target.value)}
                        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="text"
                        placeholder="Description"
                        value={line.description}
                        onChange={(e) => updateLine(idx, "description", e.target.value)}
                        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      {lines.length > 2 && (
                        <button onClick={() => removeLine(idx)} className="text-[#9A3A2D] hover:text-[#9A3A2D] cursor-pointer p-1">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#E2DDD8]">
                  <td className="py-2 px-2 font-semibold text-[#1F1D1B]">Totals</td>
                  <td className={`py-2 px-2 text-right font-semibold ${isBalanced ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>
                    {formatCurrency(totalDebit)}
                  </td>
                  <td className={`py-2 px-2 text-right font-semibold ${isBalanced ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>
                    {formatCurrency(totalCredit)}
                  </td>
                  <td colSpan={2} className="py-2 px-2">
                    {!isBalanced && totalDebit > 0 && (
                      <span className="text-xs text-[#9A3A2D]">
                        Difference: {formatCurrency(Math.abs(totalDebit - totalCredit))}
                      </span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex justify-between">
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus className="h-3.5 w-3.5" /> Add Line
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || !isBalanced}>
                {saving ? "Saving..." : "Save Journal Entry"}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// =============== TAB 4: ACCOUNTS RECEIVABLE ===============

// Phase 2 (2026-06) — AR control reconciliation + customer statement.
// Three numbers that must agree: the SDC control accounts in the ledger,
// the invoice-derived outstanding (gross of SST), and the running
// customers.outstandingSen counter. Drift badges make divergence loud.
function ARControlPanel() {
  const [data, setData] = useState<{
    asOf: string;
    controls: { code: string; name: string; balanceSen: number }[];
    tradeControlSen: number;
    invoiceOutstandingSen: number;
    customerCounterSen: number;
    driftControlVsInvoicesSen: number;
    driftCounterVsInvoicesSen: number;
  } | null>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [stmtCustomer, setStmtCustomer] = useState("");
  const [stmtFrom, setStmtFrom] = useState("");
  const [stmtTo, setStmtTo] = useState("");
  const [stmt, setStmt] = useState<{
    customer: { id: string; name: string; code: string };
    openingSen: number;
    closingSen: number;
    rows: { date: string; ref: string; type: string; debitSen: number; creditSen: number; runningSen: number }[];
  } | null>(null);

  useEffect(() => {
    fetch("/api/accounting/ar-control")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: typeof data }>)
      .then((j) => { if (j?.success && j.data) setData(j.data); })
      .catch(() => {});
    fetch("/api/customers")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { id: string; name: string }[] }>)
      .then((j) => { if (j?.success) setCustomers((j.data ?? []).map((c2) => ({ id: c2.id, name: c2.name }))); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!stmtCustomer) return;
    let stale = false;
    const p = new URLSearchParams({ customerId: stmtCustomer });
    if (stmtFrom) p.set("from", stmtFrom);
    if (stmtTo) p.set("to", stmtTo);
    fetch(`/api/accounting/customer-statement?${p.toString()}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof stmt> }>)
      .then((j) => { if (!stale && j?.success && j.data) setStmt(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [stmtCustomer, stmtFrom, stmtTo]);

  const printStmt = () => {
    if (!stmt) return;
    const w = window.open("", "_blank");
    if (!w) return;
    const rows = stmt.rows
      .map(
        (r) =>
          `<tr><td>${r.date}</td><td>${r.ref}</td><td>${r.type}</td><td style="text-align:right">${r.debitSen ? formatCurrency(r.debitSen) : ""}</td><td style="text-align:right">${r.creditSen ? formatCurrency(r.creditSen) : ""}</td><td style="text-align:right">${formatCurrency(r.runningSen)}</td></tr>`,
      )
      .join("");
    w.document.write(`<html><head><title>Statement — ${stmt.customer.name}</title>
<style>body{font-family:Segoe UI,sans-serif;font-size:12px;padding:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left}h2{margin:0}p{color:#555}</style>
</head><body><h2>HOOKKA MANUFACTURING SDN BHD</h2><p>Statement of Account — ${stmt.customer.name} (${stmt.customer.code})${stmtFrom || stmtTo ? ` · ${stmtFrom || "…"} → ${stmtTo || "…"}` : ""}</p>
<table><tr><th>Date</th><th>Ref</th><th>Type</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th><th style="text-align:right">Balance</th></tr>
<tr><td colspan="5">Opening balance</td><td style="text-align:right">${formatCurrency(stmt.openingSen)}</td></tr>
${rows}
<tr><td colspan="5" style="font-weight:bold">Closing balance</td><td style="text-align:right;font-weight:bold">${formatCurrency(stmt.closingSen)}</td></tr>
</table></body></html>`);
    w.document.close();
    w.print();
  };

  const drift = (n: number) => (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${n === 0 ? "bg-[#EAF3DE] text-[#27500A] border-[#C0DD97]" : "bg-[#FCEBEB] text-[#791F1F] border-[#F7C1C1]"}`}>
      {n === 0 ? "matches ✓" : `drift ${formatCurrency(n)}`}
    </span>
  );

  return (
    <div className="space-y-4 mb-2">
      {data && (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280]">Debtor control (ledger{data.controls.filter((x) => x.code !== "305-0000").map((x) => ` ${x.code}`).join(",")})</p>
              <p className="text-xl font-bold text-[#3E6570]">{formatCurrency(data.tradeControlSen)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280]">Outstanding from invoices (gross)</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{formatCurrency(data.invoiceOutstandingSen)}</p>
              <div className="mt-1">{drift(data.driftControlVsInvoicesSen)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280]">Customer running counter (outstandingSen)</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{formatCurrency(data.customerCounterSen)}</p>
              <div className="mt-1">{drift(data.driftCounterVsInvoicesSen)}</div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Customer statement</label>
              <select
                value={stmtCustomer}
                onChange={(e) => { setStmtCustomer(e.target.value); setStmt(null); }}
                className="rounded-md border border-[#E2DDD8] px-3 py-2 text-sm min-w-56 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="">— select customer —</option>
                {customers.map((c2) => (
                  <option key={c2.id} value={c2.id}>{c2.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-[#6B7280] block">From</label>
              <input type="date" value={stmtFrom} onChange={(e) => { setStmtFrom(e.target.value); setStmt(null); }} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-xs" />
            </div>
            <div>
              <label className="text-[11px] text-[#6B7280] block">To</label>
              <input type="date" value={stmtTo} onChange={(e) => { setStmtTo(e.target.value); setStmt(null); }} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-xs" />
            </div>
            {stmt && (
              <Button variant="outline" size="sm" onClick={printStmt}>Print</Button>
            )}
          </div>
          {stmtCustomer && !stmt && (
            <div className="py-6 text-center text-[#6B7280] text-sm">Loading statement…</div>
          )}
          {stmt && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Ref</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                    <th className="px-3 py-2 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-[#F0ECE9] text-[#6B7280]">
                    <td className="px-3 py-1.5" colSpan={5}>Opening balance</td>
                    <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(stmt.openingSen)}</td>
                  </tr>
                  {stmt.rows.map((r, i) => (
                    <tr key={`${r.ref}-${i}`} className="border-b border-[#F0ECE9]">
                      <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{r.date}</td>
                      <td className="px-3 py-1.5 text-[#1F1D1B]">{r.ref}</td>
                      <td className="px-3 py-1.5 text-xs text-[#6B7280]">{r.type}</td>
                      <td className="px-3 py-1.5 text-right">{r.debitSen ? formatCurrency(r.debitSen) : ""}</td>
                      <td className="px-3 py-1.5 text-right">{r.creditSen ? formatCurrency(r.creditSen) : ""}</td>
                      <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(r.runningSen)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-[#1F1D1B] font-semibold">
                    <td className="px-3 py-2" colSpan={5}>Closing balance</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(stmt.closingSen)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ARTab({ arData, onRefresh }: { arData: ARAgingEntry[]; onRefresh: () => void }) {
  const [paymentForm, setPaymentForm] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split("T")[0]);
  const [paymentRef, setPaymentRef] = useState("");

  const handlePayment = async (customerId: string) => {
    const amountSen = Math.round(Number(paymentAmount) * 100);
    if (amountSen <= 0) return;

    await fetch("/api/accounting/aging", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ar", id: customerId, amountSen, date: paymentDate, reference: paymentRef }),
    });

    setPaymentForm(null);
    setPaymentAmount("");
    setPaymentRef("");
    onRefresh();
  };

  const totalOutstanding = arData.reduce(
    (s, a) => s + a.currentSen + a.days30Sen + a.days60Sen + a.days90Sen + a.over90Sen,
    0
  );

  return (
    <div className="space-y-4">
      <ARControlPanel />
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Accounts Receivable</h2>
          <p className="text-sm text-[#6B7280]">Total Outstanding: <span className="font-semibold text-[#9C6F1E]">{formatCurrency(totalOutstanding)}</span></p>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                  <th className="py-3 px-4 text-left text-[#6B7280] font-medium">Customer</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">Current</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">1 mth</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">2 mth</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">3 mth</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">3+ mth</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">Total</th>
                  <th className="py-3 px-4 text-center text-[#6B7280] font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {arData.map((ar) => {
                  const total = ar.currentSen + ar.days30Sen + ar.days60Sen + ar.days90Sen + ar.over90Sen;
                  return (
                    <tr key={ar.customerId} className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/30">
                      <td className="py-3 px-4 font-medium text-[#1F1D1B]">{ar.customerName}</td>
                      <td className="py-3 px-4 text-right">{ar.currentSen > 0 ? formatCurrency(ar.currentSen) : "-"}</td>
                      <td className="py-3 px-4 text-right">{ar.days30Sen > 0 ? formatCurrency(ar.days30Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ar.days60Sen > 0 ? "text-[#9C6F1E]" : ""}`}>{ar.days60Sen > 0 ? formatCurrency(ar.days60Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ar.days90Sen > 0 ? "text-[#B8601A] font-medium" : ""}`}>{ar.days90Sen > 0 ? formatCurrency(ar.days90Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ar.over90Sen > 0 ? "text-[#9A3A2D] font-medium" : ""}`}>{ar.over90Sen > 0 ? formatCurrency(ar.over90Sen) : "-"}</td>
                      <td className="py-3 px-4 text-right font-semibold text-[#1F1D1B]">{formatCurrency(total)}</td>
                      <td className="py-3 px-4 text-center">
                        {total > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setPaymentForm(paymentForm === ar.customerId ? null : ar.customerId)}
                          >
                            <CreditCard className="h-3.5 w-3.5" /> Record Payment
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9]/50 font-semibold">
                  <td className="py-3 px-4 text-[#1F1D1B]">Total</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(arData.reduce((s, a) => s + a.currentSen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(arData.reduce((s, a) => s + a.days30Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(arData.reduce((s, a) => s + a.days60Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(arData.reduce((s, a) => s + a.days90Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(arData.reduce((s, a) => s + a.over90Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(totalOutstanding)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Payment Form */}
          {paymentForm && (
            <div className="border-t border-[#E2DDD8] p-4 bg-[#F0ECE9]/30">
              <h4 className="text-sm font-medium text-[#1F1D1B] mb-3">
                Record Payment - {arData.find((a) => a.customerId === paymentForm)?.customerName}
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Amount (RM)</label>
                  <input
                    type="number" onFocus={(e) => e.currentTarget.select()}
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
                  <input
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Reference</label>
                  <input
                    type="text"
                    placeholder="e.g. Bank Ref No."
                    value={paymentRef}
                    onChange={(e) => setPaymentRef(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => handlePayment(paymentForm)}>
                    Submit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setPaymentForm(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB 5: ACCOUNTS PAYABLE ===============

// Phase 2 (2026-06) — AP control reconciliation + supplier statement.
// Mirror of ARControlPanel for the payable side.
function APControlPanel() {
  const [data, setData] = useState<{
    controls: { code: string; name: string; balanceSen: number }[];
    tradeControlSen: number;
    piOutstandingSen: number;
    supplierCounterSen: number;
    driftControlVsPiSen: number;
    driftCounterVsPiSen: number;
  } | null>(null);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [stmtSupplier, setStmtSupplier] = useState("");
  const [stmtFrom, setStmtFrom] = useState("");
  const [stmtTo, setStmtTo] = useState("");
  const [stmt, setStmt] = useState<{
    supplier: { id: string; name: string };
    openingSen: number;
    closingSen: number;
    rows: { date: string; ref: string; type: string; debitSen: number; creditSen: number; runningSen: number }[];
  } | null>(null);
  const { toast } = useToast();
  const [pcns, setPcns] = useState<{ id: string; noteNumber: string; supplierName: string; date: string; reason: string; totalAmount: number; status: string }[]>([]);
  const [showPcnForm, setShowPcnForm] = useState(false);
  const [pcnForm, setPcnForm] = useState({ supplierId: "", reason: "", netRm: "", sstRm: "" });

  const loadPcns = () => {
    fetch("/api/accounting/purchase-credit-notes")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: typeof pcns }>)
      .then((j) => { if (j?.success && j.data) setPcns(j.data); })
      .catch(() => {});
  };
  useEffect(loadPcns, []);

  const createPcn = async () => {
    const netSen = Math.round(Number(pcnForm.netRm) * 100);
    const sstSen = Math.round(Number(pcnForm.sstRm || 0) * 100);
    if (!pcnForm.supplierId) { toast.error("Select a supplier"); return; }
    if (!(netSen > 0)) { toast.error("Net amount must be > 0"); return; }
    const items: { description: string; quantity: number; unitPriceSen: number; lineType: string }[] = [
      { description: pcnForm.reason || "Purchase return / credit", quantity: 1, unitPriceSen: netSen, lineType: "STOCKED" },
    ];
    if (sstSen > 0) items.push({ description: "SST portion", quantity: 1, unitPriceSen: sstSen, lineType: "TAX" });
    const res = await fetch("/api/accounting/purchase-credit-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supplierId: pcnForm.supplierId, reason: pcnForm.reason, items }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) {
      setShowPcnForm(false);
      setPcnForm({ supplierId: "", reason: "", netRm: "", sstRm: "" });
      loadPcns();
    } else toast.error(j?.error || "Failed to create purchase CN");
  };

  const postPcn = async (id: string, noteNumber: string, amount: number) => {
    if (!window.confirm(`Post ${noteNumber} (${formatCurrency(amount)})?\n\nDR 400-0000 Trade Creditors / CR purchase accounts — immutable ledger entries.`)) return;
    const res = await fetch(`/api/accounting/purchase-credit-notes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "POSTED" }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) loadPcns();
    else toast.error(j?.error || "Failed to post purchase CN");
  };

  useEffect(() => {
    fetch("/api/accounting/ap-control")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: typeof data }>)
      .then((j) => { if (j?.success && j.data) setData(j.data); })
      .catch(() => {});
    fetch("/api/suppliers")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { id: string; name: string }[] }>)
      .then((j) => { if (j?.success) setSuppliers((j.data ?? []).map((s) => ({ id: s.id, name: s.name }))); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!stmtSupplier) return;
    let stale = false;
    const p = new URLSearchParams({ supplierId: stmtSupplier });
    if (stmtFrom) p.set("from", stmtFrom);
    if (stmtTo) p.set("to", stmtTo);
    fetch(`/api/accounting/supplier-statement?${p.toString()}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof stmt> }>)
      .then((j) => { if (!stale && j?.success && j.data) setStmt(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [stmtSupplier, stmtFrom, stmtTo]);

  const drift = (n: number) => (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${n === 0 ? "bg-[#EAF3DE] text-[#27500A] border-[#C0DD97]" : "bg-[#FCEBEB] text-[#791F1F] border-[#F7C1C1]"}`}>
      {n === 0 ? "matches ✓" : `drift ${formatCurrency(n)}`}
    </span>
  );

  return (
    <div className="space-y-4 mb-2">
      {data && (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280]">Creditor control (ledger{data.controls.filter((x) => x.code !== "405-0000").map((x) => ` ${x.code}`).join(",")})</p>
              <p className="text-xl font-bold text-[#9A3A2D]">{formatCurrency(data.tradeControlSen)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280]">Booked-unpaid purchase invoices (APPROVED)</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{formatCurrency(data.piOutstandingSen)}</p>
              <div className="mt-1">{drift(data.driftControlVsPiSen)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280]">Supplier running counter (outstandingSen)</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{formatCurrency(data.supplierCounterSen)}</p>
              <div className="mt-1">{drift(data.driftCounterVsPiSen)}</div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Supplier statement</label>
              <select
                value={stmtSupplier}
                onChange={(e) => { setStmtSupplier(e.target.value); setStmt(null); }}
                className="rounded-md border border-[#E2DDD8] px-3 py-2 text-sm min-w-56 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="">— select supplier —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-[#6B7280] block">From</label>
              <input type="date" value={stmtFrom} onChange={(e) => { setStmtFrom(e.target.value); setStmt(null); }} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-xs" />
            </div>
            <div>
              <label className="text-[11px] text-[#6B7280] block">To</label>
              <input type="date" value={stmtTo} onChange={(e) => { setStmtTo(e.target.value); setStmt(null); }} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-xs" />
            </div>
          </div>
          {stmtSupplier && !stmt && (
            <div className="py-6 text-center text-[#6B7280] text-sm">Loading statement…</div>
          )}
          {stmt && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Ref</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                    <th className="px-3 py-2 text-right">Owing</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-[#F0ECE9] text-[#6B7280]">
                    <td className="px-3 py-1.5" colSpan={5}>Opening balance</td>
                    <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(stmt.openingSen)}</td>
                  </tr>
                  {stmt.rows.map((r, i) => (
                    <tr key={`${r.ref}-${i}`} className="border-b border-[#F0ECE9]">
                      <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{r.date}</td>
                      <td className="px-3 py-1.5 text-[#1F1D1B]">{r.ref}</td>
                      <td className="px-3 py-1.5 text-xs text-[#6B7280]">{r.type}</td>
                      <td className="px-3 py-1.5 text-right">{r.debitSen ? formatCurrency(r.debitSen) : ""}</td>
                      <td className="px-3 py-1.5 text-right">{r.creditSen ? formatCurrency(r.creditSen) : ""}</td>
                      <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(r.runningSen)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-[#1F1D1B] font-semibold">
                    <td className="px-3 py-2" colSpan={5}>Closing balance</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(stmt.closingSen)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-[#1F1D1B]">Purchase credit notes</h3>
              <p className="text-xs text-[#6B7280]">Supplier returns / price credits — pure finance document; posting reverses into the same purchase accounts the PI debited (SST portion → 706-0000).</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => setShowPcnForm(!showPcnForm)}>
              <Plus className="h-4 w-4" /> New
            </Button>
          </div>
          {showPcnForm && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end border-t border-[#F0ECE9] pt-3">
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Supplier</label>
                <select value={pcnForm.supplierId} onChange={(e) => setPcnForm({ ...pcnForm, supplierId: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm">
                  <option value="">— select —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Reason</label>
                <input type="text" value={pcnForm.reason} onChange={(e) => setPcnForm({ ...pcnForm, reason: e.target.value })} placeholder="e.g. damaged fabric returned" className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
              </div>
              <div className="flex gap-2 items-end">
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Net (RM)</label>
                  <input type="number" step="0.01" value={pcnForm.netRm} onChange={(e) => setPcnForm({ ...pcnForm, netRm: e.target.value })} className="w-28 rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">SST (RM)</label>
                  <input type="number" step="0.01" value={pcnForm.sstRm} onChange={(e) => setPcnForm({ ...pcnForm, sstRm: e.target.value })} className="w-24 rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
                </div>
                <Button variant="primary" size="sm" onClick={createPcn}>Save</Button>
              </div>
            </div>
          )}
          {pcns.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">No.</th>
                  <th className="px-3 py-2 text-left">Supplier</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {pcns.map((n) => (
                  <tr key={n.id} className="border-b border-[#F0ECE9]">
                    <td className="px-3 py-1.5 font-mono text-xs">{n.noteNumber}</td>
                    <td className="px-3 py-1.5">{n.supplierName}</td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280]">{n.date}</td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280]">{n.reason}</td>
                    <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(n.totalAmount)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {n.status === "POSTED" ? (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#EAF3DE] text-[#27500A] border border-[#C0DD97]">POSTED</span>
                      ) : (
                        <button onClick={() => postPcn(n.id, n.noteNumber, n.totalAmount)} className="text-xs text-[#6B5C32] underline decoration-dotted cursor-pointer">Post</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function APTab({ apData, onRefresh }: { apData: APAgingEntry[]; onRefresh: () => void }) {
  const [paymentForm, setPaymentForm] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split("T")[0]);
  const [paymentRef, setPaymentRef] = useState("");

  const handlePayment = async (supplierId: string) => {
    const amountSen = Math.round(Number(paymentAmount) * 100);
    if (amountSen <= 0) return;

    await fetch("/api/accounting/aging", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ap", id: supplierId, amountSen, date: paymentDate, reference: paymentRef }),
    });

    setPaymentForm(null);
    setPaymentAmount("");
    setPaymentRef("");
    onRefresh();
  };

  const totalOutstanding = apData.reduce(
    (s, a) => s + a.currentSen + a.days30Sen + a.days60Sen + a.days90Sen + a.over90Sen,
    0
  );

  return (
    <div className="space-y-4">
      <APControlPanel />
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Accounts Payable</h2>
          <p className="text-sm text-[#6B7280]">Total Outstanding: <span className="font-semibold text-[#3E6570]">{formatCurrency(totalOutstanding)}</span></p>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50">
                  <th className="py-3 px-4 text-left text-[#6B7280] font-medium">Supplier</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">Current</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">1 mth</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">2 mth</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">3 mth</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">3+ mth</th>
                  <th className="py-3 px-4 text-right text-[#6B7280] font-medium">Total</th>
                  <th className="py-3 px-4 text-center text-[#6B7280] font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {apData.map((ap) => {
                  const total = ap.currentSen + ap.days30Sen + ap.days60Sen + ap.days90Sen + ap.over90Sen;
                  return (
                    <tr key={ap.supplierId} className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/30">
                      <td className="py-3 px-4 font-medium text-[#1F1D1B]">{ap.supplierName}</td>
                      <td className="py-3 px-4 text-right">{ap.currentSen > 0 ? formatCurrency(ap.currentSen) : "-"}</td>
                      <td className="py-3 px-4 text-right">{ap.days30Sen > 0 ? formatCurrency(ap.days30Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ap.days60Sen > 0 ? "text-[#9C6F1E]" : ""}`}>{ap.days60Sen > 0 ? formatCurrency(ap.days60Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ap.days90Sen > 0 ? "text-[#B8601A] font-medium" : ""}`}>{ap.days90Sen > 0 ? formatCurrency(ap.days90Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ap.over90Sen > 0 ? "text-[#9A3A2D] font-medium" : ""}`}>{ap.over90Sen > 0 ? formatCurrency(ap.over90Sen) : "-"}</td>
                      <td className="py-3 px-4 text-right font-semibold text-[#1F1D1B]">{formatCurrency(total)}</td>
                      <td className="py-3 px-4 text-center">
                        {total > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setPaymentForm(paymentForm === ap.supplierId ? null : ap.supplierId)}
                          >
                            <CreditCard className="h-3.5 w-3.5" /> Record Payment
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9]/50 font-semibold">
                  <td className="py-3 px-4 text-[#1F1D1B]">Total</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(apData.reduce((s, a) => s + a.currentSen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(apData.reduce((s, a) => s + a.days30Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(apData.reduce((s, a) => s + a.days60Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(apData.reduce((s, a) => s + a.days90Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(apData.reduce((s, a) => s + a.over90Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(totalOutstanding)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Payment Form */}
          {paymentForm && (
            <div className="border-t border-[#E2DDD8] p-4 bg-[#F0ECE9]/30">
              <h4 className="text-sm font-medium text-[#1F1D1B] mb-3">
                Record Payment - {apData.find((a) => a.supplierId === paymentForm)?.supplierName}
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Amount (RM)</label>
                  <input
                    type="number" onFocus={(e) => e.currentTarget.select()}
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
                  <input
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Reference</label>
                  <input
                    type="text"
                    placeholder="e.g. Cheque No."
                    value={paymentRef}
                    onChange={(e) => setPaymentRef(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => handlePayment(paymentForm)}>
                    Submit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setPaymentForm(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB 6: P&L REPORT ===============

type PLData = {
  entries: PLEntry[];
  totals: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    grossProfitPct: number;
    operatingExpenses: number;
    netProfit: number;
    netProfitPct: number;
  };
  revenueByProduct: Record<string, number>;
  revenueByCustomer: Record<string, number>;
  cogsByAccount: Record<string, number>;
  opexByAccount: Record<string, number>;
  manufacturing?: {
    openingStock: number;
    purchases: number;
    directLabour: number;
    factoryOverhead: number;
    otherMfg: number;
    closingStock: number;
    costOfProduction: number;
    inventoryBreakdown?: {
      bucket: string;
      value: number;
      stockAcct: string;
      openingAcct: string;
      closingAcct: string;
    }[];
    stockNote?: string;
  };
  cashFlow?: {
    operating: number;
    investing: number;
    financing: number;
    netChange: number;
    note: string;
  };
};

function PLReportTab() {
  const [period, setPeriod] = useState("2026-Q1");
  const [productCategory, setProductCategory] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [stateFilter, setStateFilter] = useState("");

  const periods = [
    { value: "2026-01", label: "January 2026" },
    { value: "2026-02", label: "February 2026" },
    { value: "2026-03", label: "March 2026" },
    { value: "2026-Q1", label: "Q1 2026" },
    { value: "2026", label: "Full Year 2026" },
  ];

  const productCategories = [
    { value: "", label: "All Products" },
    { value: "BEDFRAME", label: "Bedframe" },
    { value: "SOFA", label: "Sofa" },
    { value: "ACCESSORY", label: "Accessories" },
  ];

  const customerOptions = [
    { value: "", label: "All Customers" },
    { value: "hub-houzs-kl", label: "Houzs KL" },
    { value: "hub-houzs-pg", label: "Houzs PG" },
    { value: "hub-houzs-srw", label: "Houzs SRW" },
    { value: "hub-houzs-sbh", label: "Houzs SBH" },
    { value: "hub-carress", label: "Carress" },
    { value: "hub-conts", label: "The Conts" },
  ];

  const stateOptions = [
    { value: "", label: "All States" },
    { value: "KL", label: "KL" },
    { value: "PG", label: "Penang" },
    { value: "SRW", label: "Sarawak" },
    { value: "SBH", label: "Sabah" },
    { value: "JB", label: "Johor" },
  ];

  const plUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (period) params.set("period", period);
    if (productCategory) params.set("productCategory", productCategory);
    if (customerId) params.set("customerId", customerId);
    if (stateFilter) params.set("state", stateFilter);
    return `/api/accounting/pl?${params.toString()}`;
  }, [period, productCategory, customerId, stateFilter]);

  const { data: plResp, loading: plLoading } = useCachedJson<{ success?: boolean; data?: PLData }>(plUrl);
  const plData: PLData | null = useMemo(() => (plResp?.success ? plResp.data ?? null : null), [plResp]);

  const handleExportCSV = () => {
    if (!plData) return;
    const rows: string[][] = [
      ["HOOKKA Industries Sdn Bhd"],
      [`Profit & Loss Statement - ${periods.find((p) => p.value === period)?.label || period}`],
      [],
      ["Section", "Account", "Amount (RM)"],
    ];
    Object.entries(plData.revenueByProduct).forEach(([k, v]) => {
      rows.push(["Revenue", k, (v / 100).toFixed(2)]);
    });
    rows.push(["", "Total Revenue", (plData.totals.revenue / 100).toFixed(2)]);
    rows.push([]);
    Object.entries(plData.cogsByAccount).forEach(([k, v]) => {
      rows.push(["COGS", k, (v / 100).toFixed(2)]);
    });
    rows.push(["", "Total COGS", (plData.totals.cogs / 100).toFixed(2)]);
    rows.push(["", "Gross Profit", (plData.totals.grossProfit / 100).toFixed(2)]);
    rows.push(["", "GP %", `${plData.totals.grossProfitPct}%`]);
    rows.push([]);
    Object.entries(plData.opexByAccount).forEach(([k, v]) => {
      rows.push(["Operating Expenses", k, (v / 100).toFixed(2)]);
    });
    rows.push(["", "Total Operating Expenses", (plData.totals.operatingExpenses / 100).toFixed(2)]);
    rows.push(["", "Net Profit", (plData.totals.netProfit / 100).toFixed(2)]);
    rows.push(["", "Net Margin %", `${plData.totals.netProfitPct}%`]);

    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `PL-${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (plLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[#6B7280]">Loading P&L data...</div>
      </div>
    );
  }

  if (!plData) return null;

  const maxRevenue = Math.max(...Object.values(plData.revenueByProduct), 1);
  const maxCustomerRev = Math.max(...Object.values(plData.revenueByCustomer), 1);

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="h-4 w-4 text-[#6B5C32]" />
            <span className="text-sm font-medium text-[#1F1D1B]">Multi-Dimensional Filters</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Period</label>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] bg-white"
              >
                {periods.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Product Category</label>
              <select
                value={productCategory}
                onChange={(e) => setProductCategory(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] bg-white"
              >
                {productCategories.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Customer</label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] bg-white"
              >
                {customerOptions.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">State</label>
              <select
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] bg-white"
              >
                {stateOptions.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
          </div>
          {(productCategory || customerId || stateFilter) && (
            <div className="mt-2 flex items-center gap-2 text-xs text-[#6B5C32]">
              <span>Active filters:</span>
              {productCategory && <Badge variant="status" status="CONFIRMED">{productCategory}</Badge>}
              {customerId && <Badge variant="status" status="CONFIRMED">{customerOptions.find((c) => c.value === customerId)?.label}</Badge>}
              {stateFilter && <Badge variant="status" status="CONFIRMED">{stateFilter}</Badge>}
              <button onClick={() => { setProductCategory(""); setCustomerId(""); setStateFilter(""); }} className="text-[#9A3A2D] hover:text-[#7A2E24] ml-2 underline cursor-pointer">Clear all</button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Revenue</p>
            <p className="text-xl font-bold text-[#4F7C3A]">{formatCurrency(plData.totals.revenue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">COGS</p>
            <p className="text-xl font-bold text-[#9A3A2D]">{formatCurrency(plData.totals.cogs)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Gross Profit</p>
            <p className="text-xl font-bold text-[#6B5C32]">{formatCurrency(plData.totals.grossProfit)}</p>
            <p className="text-xs text-[#6B7280] mt-1">GP: {plData.totals.grossProfitPct}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Net Profit</p>
            <p className={`text-xl font-bold ${plData.totals.netProfit >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>
              {formatCurrency(plData.totals.netProfit)}
            </p>
            <p className="text-xs text-[#6B7280] mt-1">Margin: {plData.totals.netProfitPct}%</p>
          </CardContent>
        </Card>
      </div>

      {/* P&L Statement */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-[#6B5C32]" />
            Profit & Loss Statement
          </CardTitle>
          <Button variant="outline" size="sm" onClick={handleExportCSV}>
            <Download className="h-4 w-4 mr-1" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#F0ECE9]">
                  <th className="text-left px-4 py-2 font-semibold text-[#1F1D1B]">Account</th>
                  <th className="text-right px-4 py-2 font-semibold text-[#1F1D1B]">Amount (RM)</th>
                </tr>
              </thead>
              <tbody>
                {/* Revenue Section — SUCCESS (green) tint */}
                <tr className={SUCCESS.bg}>
                  <td colSpan={2} className={`px-4 py-2 font-semibold ${SUCCESS.text}`}>Revenue</td>
                </tr>
                {Object.entries(plData.revenueByProduct).map(([name, amount]) => (
                  <tr key={name} className="border-t border-[#E2DDD8]/50">
                    <td className="px-4 py-1.5 pl-8 text-[#4B5563]">Sales - {name}</td>
                    <td className="px-4 py-1.5 text-right font-medium text-[#1F1D1B]">{formatCurrency(amount)}</td>
                  </tr>
                ))}
                <tr className={`border-t border-[#E2DDD8] font-semibold ${SUCCESS.bg}`}>
                  <td className={`px-4 py-2 ${SUCCESS.text}`}>Total Revenue</td>
                  <td className={`px-4 py-2 text-right ${SUCCESS.text}`}>{formatCurrency(plData.totals.revenue)}</td>
                </tr>

                {/* COGS Section — DANGER (red) tint, money leaving */}
                <tr className={`${DANGER.bg} border-t-2 border-[#E2DDD8]`}>
                  <td colSpan={2} className={`px-4 py-2 font-semibold ${DANGER.text}`}>Less: Cost of Goods Sold</td>
                </tr>
                {Object.entries(plData.cogsByAccount).map(([name, amount]) => (
                  <tr key={name} className="border-t border-[#E2DDD8]/50">
                    <td className="px-4 py-1.5 pl-8 text-[#4B5563]">{name}</td>
                    <td className={`px-4 py-1.5 text-right font-medium ${DANGER.text}`}>({formatCurrency(amount)})</td>
                  </tr>
                ))}
                <tr className={`border-t border-[#E2DDD8] font-semibold ${DANGER.bg}`}>
                  <td className={`px-4 py-2 ${DANGER.text}`}>Total COGS</td>
                  <td className={`px-4 py-2 text-right ${DANGER.text}`}>({formatCurrency(plData.totals.cogs)})</td>
                </tr>

                {/* Gross Profit */}
                <tr className="border-t-2 border-[#6B5C32] bg-[#F0ECE9] font-bold">
                  <td className="px-4 py-3 text-[#6B5C32]">
                    Gross Profit
                    <span className="ml-2 text-xs font-normal text-[#6B7280]">
                      (GP: {plData.totals.grossProfitPct}%)
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-[#6B5C32]">{formatCurrency(plData.totals.grossProfit)}</td>
                </tr>

                {/* Operating Expenses — WARNING (amber) tint */}
                <tr className={`${WARNING.bg} border-t-2 border-[#E2DDD8]`}>
                  <td colSpan={2} className={`px-4 py-2 font-semibold ${WARNING.text}`}>Less: Operating Expenses</td>
                </tr>
                {Object.entries(plData.opexByAccount).map(([name, amount]) => (
                  <tr key={name} className="border-t border-[#E2DDD8]/50">
                    <td className="px-4 py-1.5 pl-8 text-[#4B5563]">{name}</td>
                    <td className={`px-4 py-1.5 text-right font-medium ${WARNING.text}`}>({formatCurrency(amount)})</td>
                  </tr>
                ))}
                <tr className={`border-t border-[#E2DDD8] font-semibold ${WARNING.bg}`}>
                  <td className={`px-4 py-2 ${WARNING.text}`}>Total Operating Expenses</td>
                  <td className={`px-4 py-2 text-right ${WARNING.text}`}>({formatCurrency(plData.totals.operatingExpenses)})</td>
                </tr>

                {/* Net Profit */}
                <tr className="border-t-2 border-[#1F1D1B] bg-[#1F1D1B] text-white font-bold">
                  <td className="px-4 py-3">
                    Net Profit
                    <span className="ml-2 text-xs font-normal text-gray-300">
                      (Margin: {plData.totals.netProfitPct}%)
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">{formatCurrency(plData.totals.netProfit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Charts Row */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        {/* Revenue by Product */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <PieChart className="h-5 w-5 text-[#6B5C32]" />
              Revenue by Product Category
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(plData.revenueByProduct).map(([name, amount]) => {
                const pct = plData.totals.revenue > 0 ? Math.round((amount / plData.totals.revenue) * 100) : 0;
                const colors: Record<string, string> = {
                  BEDFRAME: "bg-[#6B5C32]",
                  SOFA: "bg-[#8B7A4A]",
                  ACCESSORY: "bg-[#A99B6A]",
                };
                return (
                  <div key={name} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[#4B5563]">{name}</span>
                      <span className="font-medium text-[#1F1D1B]">{formatCurrency(amount)} ({pct}%)</span>
                    </div>
                    <div className="h-3 bg-[#F0ECE9] rounded-full overflow-hidden">
                      <div
                        className={`h-full ${colors[name] || "bg-[#6B5C32]"} rounded-full transition-all`}
                        style={{ width: `${Math.round((amount / maxRevenue) * 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Revenue by Customer */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-5 w-5 text-[#6B5C32]" />
              Revenue by Customer
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(plData.revenueByCustomer)
                .sort(([, a], [, b]) => b - a)
                .map(([name, amount]) => {
                  const pct = plData.totals.revenue > 0 ? Math.round((amount / plData.totals.revenue) * 100) : 0;
                  return (
                    <div key={name} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-[#4B5563]">{name}</span>
                        <span className="font-medium text-[#1F1D1B]">{formatCurrency(amount)} ({pct}%)</span>
                      </div>
                      <div className="h-3 bg-[#F0ECE9] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#6B5C32] rounded-full transition-all"
                          style={{ width: `${Math.round((amount / maxCustomerRev) * 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Manufacturing Account + Cash Flow (O/I/F) */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        {plData.manufacturing && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Manufacturing Account</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {[
                    ["Opening Stock", plData.manufacturing.openingStock],
                    ["Add: Purchases", plData.manufacturing.purchases],
                    ["Add: Direct Labour", plData.manufacturing.directLabour],
                    [
                      "Add: Factory Overhead",
                      plData.manufacturing.factoryOverhead,
                    ],
                    ["Add: Other Mfg Cost", plData.manufacturing.otherMfg],
                    [
                      "Less: Closing Stock",
                      -plData.manufacturing.closingStock,
                    ],
                  ].map(([label, val]) => (
                    <tr key={label as string} className="border-b border-[#F0ECE9]">
                      <td className="px-2 py-1.5 text-[#4B5563]">{label}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-[#1F1D1B]">
                        {formatCurrency(Math.abs(val as number))}
                      </td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="px-2 py-2 text-[#1F1D1B]">
                      Cost of Production
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-[#1F1D1B]">
                      {formatCurrency(plData.manufacturing.costOfProduction)}
                    </td>
                  </tr>
                </tbody>
              </table>
              {plData.manufacturing.inventoryBreakdown &&
                plData.manufacturing.inventoryBreakdown.length > 0 && (
                  <div className="mt-3 border-t border-[#F0ECE9] pt-2">
                    <p className="text-[11px] font-semibold text-[#6B7280] mb-1">
                      Closing stock — live from cost ledger
                    </p>
                    <table className="w-full text-xs">
                      <tbody>
                        {plData.manufacturing.inventoryBreakdown.map((b) => (
                          <tr
                            key={b.bucket}
                            className="border-b border-[#F7F4EF]"
                          >
                            <td className="px-2 py-1 text-[#4B5563]">
                              {b.bucket}
                            </td>
                            <td className="px-2 py-1 text-[#9CA3AF] tabular-nums">
                              {b.closingAcct}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums text-[#1F1D1B]">
                              {formatCurrency(b.value)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              <p className="text-[11px] text-[#9CA3AF] mt-2">
                {plData.manufacturing.stockNote ??
                  "Opening + Purchases + Labour + Overhead + Other − Closing."}
              </p>
            </CardContent>
          </Card>
        )}
        {plData.cashFlow && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Cash Flow — Operating / Investing / Financing
              </CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {[
                    ["Operating", plData.cashFlow.operating],
                    ["Investing", plData.cashFlow.investing],
                    ["Financing", plData.cashFlow.financing],
                  ].map(([label, val]) => (
                    <tr key={label as string} className="border-b border-[#F0ECE9]">
                      <td className="px-2 py-1.5 text-[#4B5563]">{label}</td>
                      <td
                        className={`px-2 py-1.5 text-right tabular-nums ${(val as number) >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}
                      >
                        {formatCurrency(val as number)}
                      </td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="px-2 py-2 text-[#1F1D1B]">Net Change</td>
                    <td
                      className={`px-2 py-2 text-right tabular-nums ${plData.cashFlow.netChange >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}
                    >
                      {formatCurrency(plData.cashFlow.netChange)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="text-[11px] text-[#9CA3AF] mt-2">
                {plData.cashFlow.note}
              </p>
            </CardContent>
          </Card>
        )}
      </div>

    </div>
  );
}

// =============== TAB: OTHER DEBTORS / CREDITORS (Phase 1, 2026-06) ===============
//
// Registry of non-trade counterparties (transporters, deposit holders,
// staff advances, misc payables) — separate from the operational customer/
// supplier masters so they never appear in SO/PO pickers. Control accounts
// 305-0000 (Other Debtor, asset) and 405-0000 (Other Creditors,
// liability); per-party balances arrive with the Phase-3 vouchers.

type OtherParty = {
  id: string;
  type: "DEBTOR" | "CREDITOR";
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  notes: string;
  isActive: boolean;
};

function OtherPartiesTab() {
  const { toast } = useToast();
  const [parties, setParties] = useState<OtherParty[] | null>(null);
  const [filter, setFilter] = useState<"ALL" | "DEBTOR" | "CREDITOR">("ALL");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    type: "CREDITOR" as "DEBTOR" | "CREDITOR",
    name: "",
    contactPerson: "",
    phone: "",
    email: "",
    notes: "",
  });
  const [controls, setControls] = useState<{ od: number; oc: number } | null>(null);

  const load = () => {
    fetch("/api/accounting/other-parties")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: OtherParty[] }>)
      .then((j) => { if (j?.success) setParties(j.data ?? []); })
      .catch(() => {});
    fetch("/api/accounting/trial-balance")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { rows: { accountCode: string; debitSen: number; creditSen: number }[] } }>)
      .then((j) => {
        if (!j?.success || !j.data) return;
        const find = (code: string) => j.data!.rows.find((r) => r.accountCode === code);
        const od = find("305-0000");
        const oc = find("405-0000");
        setControls({
          od: (od?.debitSen ?? 0) - (od?.creditSen ?? 0),
          oc: (oc?.creditSen ?? 0) - (oc?.debitSen ?? 0),
        });
      })
      .catch(() => {});
  };
  useEffect(load, []);

  const add = async () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    const res = await fetch("/api/accounting/other-parties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) {
      setShowForm(false);
      setForm({ type: "CREDITOR", name: "", contactPerson: "", phone: "", email: "", notes: "" });
      load();
    } else toast.error(j?.error || "Failed to create party");
  };

  const setActive = async (id: string, isActive: boolean) => {
    const res = await fetch(`/api/accounting/other-parties/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) load();
    else toast.error(j?.error || "Failed to update party");
  };

  const visible = (parties ?? []).filter((p) => filter === "ALL" || p.type === filter);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">305-0000 OTHER DEBTOR — control balance</p>
            <p className="text-xl font-bold text-[#3E6570]">{controls ? formatCurrency(controls.od) : "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">405-0000 OTHER CREDITORS — control balance</p>
            <p className="text-xl font-bold text-[#9A3A2D]">{controls ? formatCurrency(controls.oc) : "—"}</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
          {(["ALL", "DEBTOR", "CREDITOR"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium border ${filter === f ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}
            >
              {f === "ALL" ? "All" : f === "DEBTOR" ? "Other Debtors" : "Other Creditors"}
            </button>
          ))}
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4" /> Add Party
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as "DEBTOR" | "CREDITOR" })}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="CREDITOR">Other Creditor (we owe them)</option>
                <option value="DEBTOR">Other Debtor (they owe us)</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Name</label>
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. ABC Transport Sdn Bhd" className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Contact Person</label>
              <input type="text" value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Phone</label>
              <input type="text" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Email</label>
              <input type="text" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Notes</label>
              <input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
            </div>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={add}>Save</Button>
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {parties === null ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : visible.length === 0 ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">No parties yet — add transporters, deposit holders, staff advances…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-4 py-2 text-left">Type</th>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">Contact</th>
                  <th className="px-4 py-2 text-left">Phone</th>
                  <th className="px-4 py-2 text-left">Notes</th>
                  <th className="px-4 py-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.id} className={`border-b border-[#F0ECE9] ${p.isActive ? "" : "opacity-50"}`}>
                    <td className="px-4 py-1.5">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${p.type === "DEBTOR" ? "bg-[#E6F1FB] text-[#0C447C] border-[#B5D4F4]" : "bg-[#FAEEDA] text-[#633806] border-[#FAC775]"}`}>
                        {p.type === "DEBTOR" ? "Other Debtor" : "Other Creditor"}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-[#1F1D1B] font-medium">{p.name}</td>
                    <td className="px-4 py-1.5 text-[#6B7280]">{p.contactPerson}</td>
                    <td className="px-4 py-1.5 text-[#6B7280]">{p.phone}</td>
                    <td className="px-4 py-1.5 text-[#6B7280] text-xs">{p.notes}</td>
                    <td className="px-4 py-1.5 text-right">
                      <button
                        onClick={() => setActive(p.id, !p.isActive)}
                        className={`text-xs underline decoration-dotted cursor-pointer ${p.isActive ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}
                      >
                        {p.isActive ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB: GENERAL LEDGER (Phase 1, 2026-06) ===============
//
// Trial balance (all accounts, natural debit/credit columns, balanced
// flag) + per-account GL inquiry: click a row to see that account's
// leg-by-leg flow with opening/running balances and a link back to the
// source document of every auto-posted leg.

type TbRow = {
  accountCode: string;
  accountName: string;
  type: string;
  debitSen: number;
  creditSen: number;
};
type GlRow = {
  id: string;
  postedAt: string;
  description: string;
  sourceType: string;
  sourceId: string;
  debitSen: number;
  creditSen: number;
  runningSen: number;
};

// Best-effort deep link for a ledger leg's source document.
function sourceHref(sourceType: string, sourceId: string): string | null {
  switch (sourceType) {
    case "invoice":
    case "invoice_void":
      return `/invoices/${sourceId}`;
    case "payment":
    case "payment_bounce":
      return "/invoices/payments";
    case "credit_note":
      return "/invoices/credit-notes";
    case "debit_note":
      return "/invoices/debit-notes";
    case "purchase_invoice":
    case "supplier_payment":
      return "/procurement/pi";
    default:
      return null; // manual / manual_reversal / year_close — no doc page
  }
}

// Phase 2 follow-up (owner): Trial Balance is its OWN tab now — just the
// statement, no inquiry attached.
function TrialBalanceTab() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [tb, setTb] = useState<{
    rows: TbRow[];
    totalDr: number;
    totalCr: number;
    balanced: boolean;
  } | null>(null);
  const loadingTb = tb === null;

  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/trial-balance?asOf=${asOf}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { rows: TbRow[]; totalDr: number; totalCr: number; balanced: boolean } }>)
      .then((j) => { if (!stale && j?.success && j.data) setTb(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [asOf]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Trial Balance</h2>
        <div className="flex items-end gap-3">
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">As of</label>
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="rounded-md border border-[#E2DDD8] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
            />
          </div>
          {tb && (
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium border ${tb.balanced ? "bg-[#EAF3DE] text-[#27500A] border-[#C0DD97]" : "bg-[#FCEBEB] text-[#791F1F] border-[#F7C1C1]"}`}
            >
              {tb.balanced ? "Balanced ✓" : "OUT OF BALANCE"}
            </span>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loadingTb || !tb ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading trial balance…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-4 py-2 text-left">Account</th>
                  <th className="px-4 py-2 text-left">Type</th>
                  <th className="px-4 py-2 text-right">Debit</th>
                  <th className="px-4 py-2 text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((r) => (
                  <tr
                    key={r.accountCode}
                    className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/30"
                  >
                    <td className="px-4 py-1.5">
                      <span className="font-mono text-xs text-[#6B7280] mr-2">{r.accountCode}</span>
                      <span className="text-[#1F1D1B]">{r.accountName}</span>
                    </td>
                    <td className="px-4 py-1.5 text-xs text-[#6B7280]">{r.type}</td>
                    <td className="px-4 py-1.5 text-right font-medium">{r.debitSen ? formatCurrency(r.debitSen) : ""}</td>
                    <td className="px-4 py-1.5 text-right font-medium">{r.creditSen ? formatCurrency(r.creditSen) : ""}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-[#1F1D1B] font-semibold">
                  <td className="px-4 py-2" colSpan={2}>TOTAL</td>
                  <td className="px-4 py-2 text-right">{formatCurrency(tb.totalDr)}</td>
                  <td className="px-4 py-2 text-right">{formatCurrency(tb.totalCr)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

    </div>
  );
}

// =============== TAB: GENERAL LEDGER (Phase 2 follow-up, owner) ===============
//
// Default = the FULL ledger (every leg, newest first, capped at 1000).
// Filters: date range + searchable account picker. Picking an account
// switches to inquiry mode with opening / running / closing balances.

type GlAllRow = {
  id: string;
  postedAt: string;
  accountCode: string;
  accountName: string;
  description: string;
  sourceType: string;
  sourceId: string;
  debitSen: number;
  creditSen: number;
};

function GeneralLedgerTab({ accounts }: { accounts: ChartOfAccount[] }) {
  // Multi-account review (owner): 0 picked = full ledger; 1 picked =
  // inquiry mode with running balance; 2+ picked = listing filtered to
  // the picked set.
  const [picked, setPicked] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [all, setAll] = useState<{ rows: GlAllRow[]; totalRows: number; capped: boolean } | null>(null);
  const [gl, setGl] = useState<{
    account: { code: string; name: string; type: string };
    openingSen: number;
    closingSen: number;
    rows: GlRow[];
  } | null>(null);
  const account = picked.length === 1 ? picked[0] : "";
  const loading = account ? gl === null : all === null;
  const nameOf = (code: string) => accounts.find((a) => a.code === code)?.name ?? "";

  useEffect(() => {
    let stale = false;
    const params = new URLSearchParams();
    if (picked.length === 1) params.set("account", picked[0]);
    else if (picked.length > 1) params.set("accounts", picked.join(","));
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    fetch(`/api/accounting/gl?${params.toString()}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: unknown }>)
      .then((j) => {
        if (stale || !j?.success || !j.data) return;
        if (picked.length === 1) setGl(j.data as NonNullable<typeof gl>);
        else setAll(j.data as NonNullable<typeof all>);
      })
      .catch(() => {});
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked.join(","), from, to]);

  const reset = () => {
    setAll(null);
    setGl(null);
  };
  const addAccount = (code: string) => {
    if (!code || picked.includes(code)) return;
    setPicked([...picked, code]);
    reset();
  };
  const removeAccount = (code: string) => {
    setPicked(picked.filter((c) => c !== code));
    reset();
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[#1F1D1B]">General Ledger</h2>

      {/* Filter bar — deliberately loud (owner: "不够明显") */}
      <Card>
        <CardContent className="p-4 space-y-3 bg-[#F7F4EF] rounded-lg">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-80">
              <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">
                Account filter <span className="font-normal text-[#6B7280]">(type keyword, pick one or MORE)</span>
              </label>
              <AccountPicker
                accounts={accounts.filter((a) => !picked.includes(a.code))}
                value=""
                onChange={addAccount}
                placeholder="Type code or name to add an account…"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">From</label>
              <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} className="rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">To</label>
              <input type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} className="rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm" />
            </div>
            {(picked.length > 0 || from || to) && (
              <Button variant="outline" size="sm" onClick={() => { setPicked([]); setFrom(""); setTo(""); reset(); }}>
                Clear all
              </Button>
            )}
          </div>
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {picked.map((code) => (
                <span key={code} className="inline-flex items-center gap-1.5 rounded-full border border-[#6B5C32] bg-white px-3 py-1 text-xs font-medium text-[#6B5C32]">
                  <span className="font-mono">{code}</span> {nameOf(code)}
                  <button onClick={() => removeAccount(code)} className="ml-1 text-[#9A3A2D] hover:text-[#791F1F] cursor-pointer" title="Remove">✕</button>
                </span>
              ))}
            </div>
          )}
          <p className="text-[11px] text-[#9CA3AF]">
            No account picked = full ledger · pick ONE for running balances · pick SEVERAL to review them together
          </p>
        </CardContent>
      </Card>

      {account && gl && (
        <p className="text-sm text-[#6B7280]">
          <span className="font-mono text-xs mr-1">{gl.account.code}</span>
          <span className="font-medium text-[#1F1D1B]">{gl.account.name}</span>
          {" · "}Opening {formatCurrency(gl.openingSen)} · Closing {formatCurrency(gl.closingSen)} ({gl.account.type})
        </p>
      )}
      {!account && all && (
        <p className="text-sm text-[#6B7280]">
          {all.totalRows} entries{picked.length > 1 ? ` across ${picked.length} accounts` : ""}{all.capped ? ` — showing latest ${all.rows.length}, narrow the date range to see older ones` : ""}
        </p>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading ledger…</div>
          ) : account && gl ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-[#F0ECE9] text-[#6B7280]">
                  <td className="px-3 py-1.5" colSpan={5}>Opening balance</td>
                  <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(gl.openingSen)}</td>
                </tr>
                {gl.rows.map((r) => {
                  const href = sourceHref(r.sourceType, r.sourceId);
                  return (
                    <tr key={r.id} className="border-b border-[#F0ECE9]">
                      <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{String(r.postedAt).slice(0, 10)}</td>
                      <td className="px-3 py-1.5 text-[#1F1D1B]">{r.description}</td>
                      <td className="px-3 py-1.5 text-xs">
                        {href ? (
                          <a href={href} className="text-[#6B5C32] underline decoration-dotted hover:text-[#1F1D1B]" title={r.sourceId}>
                            {r.sourceType}
                          </a>
                        ) : (
                          <span className="text-[#6B7280]" title={r.sourceId}>{r.sourceType}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right">{r.debitSen ? formatCurrency(r.debitSen) : ""}</td>
                      <td className="px-3 py-1.5 text-right">{r.creditSen ? formatCurrency(r.creditSen) : ""}</td>
                      <td className={`px-3 py-1.5 text-right font-medium ${r.runningSen < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>{formatCurrency(r.runningSen)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : all ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Account</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {all.rows.map((r) => {
                  const href = sourceHref(r.sourceType, r.sourceId);
                  return (
                    <tr key={r.id} className="border-b border-[#F0ECE9]">
                      <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{String(r.postedAt).slice(0, 10)}</td>
                      <td className="px-3 py-1.5">
                        <button
                          onClick={() => { setPicked([r.accountCode]); reset(); }}
                          className="text-left cursor-pointer hover:underline"
                          title="Filter to this account"
                        >
                          <span className="font-mono text-xs text-[#6B7280] mr-1">{r.accountCode}</span>
                          <span className="text-[#1F1D1B]">{r.accountName}</span>
                        </button>
                      </td>
                      <td className="px-3 py-1.5 text-[#4B5563]">{r.description}</td>
                      <td className="px-3 py-1.5 text-xs">
                        {href ? (
                          <a href={href} className="text-[#6B5C32] underline decoration-dotted hover:text-[#1F1D1B]" title={r.sourceId}>
                            {r.sourceType}
                          </a>
                        ) : (
                          <span className="text-[#6B7280]" title={r.sourceId}>{r.sourceType}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right">{r.debitSen ? formatCurrency(r.debitSen) : ""}</td>
                      <td className="px-3 py-1.5 text-right">{r.creditSen ? formatCurrency(r.creditSen) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB 7: BALANCE SHEET ===============

// Phase 1 (2026-06) — year-end profit close. Previews the un-closed P&L
// result of the last ENDED financial year (per the FYE setting) and posts
// it into 150-0000 RETAINED EARNING with sourceType='year_close' ledger
// legs. Idempotent server-side; the button disables once closed.
function YearCloseCard() {
  const { toast } = useToast();
  const [preview, setPreview] = useState<{
    fyEnd: string;
    alreadyClosed: boolean;
    netSen: number;
    accountCount: number;
  } | null>(null);
  const [posting, setPosting] = useState(false);
  const load = () => {
    fetch("/api/accounting/year-close/preview")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { fyEnd: string; alreadyClosed: boolean; netSen: number; accountCount: number } }>)
      .then((j) => { if (j?.success && j.data) setPreview(j.data); })
      .catch(() => {});
  };
  useEffect(load, []);
  const post = async () => {
    if (!preview) return;
    if (!window.confirm(
      `Close FY ended ${preview.fyEnd}?\n\nNet ${preview.netSen >= 0 ? "profit" : "loss"} of ${formatCurrency(Math.abs(preview.netSen))} across ${preview.accountCount} P&L accounts will be posted to 150-0000 RETAINED EARNING. This writes immutable ledger entries.`,
    )) return;
    setPosting(true);
    try {
      const res = await fetch("/api/accounting/year-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fyEnd: preview.fyEnd }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (j?.success) {
        toast.success(`FY ended ${preview.fyEnd} closed to retained earnings`);
        load();
      } else toast.error(j?.error || "Year-end close failed");
    } catch {
      toast.error("Year-end close failed");
    } finally {
      setPosting(false);
    }
  };
  if (!preview) return null;
  return (
    <Card className="mb-4">
      <CardContent className="p-4 flex flex-wrap items-center gap-4">
        <div className="text-sm">
          <span className="font-medium text-[#1F1D1B]">Year-end close</span>
          <span className="text-[#6B7280]"> · FY ended {preview.fyEnd}: </span>
          {preview.alreadyClosed ? (
            <span className="text-[#4F7C3A] font-medium">already closed ✓</span>
          ) : preview.accountCount === 0 ? (
            <span className="text-[#6B7280]">nothing to close</span>
          ) : (
            <span className={preview.netSen >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}>
              net {preview.netSen >= 0 ? "profit" : "loss"} {formatCurrency(Math.abs(preview.netSen))} un-closed
            </span>
          )}
        </div>
        {!preview.alreadyClosed && preview.accountCount > 0 && (
          <Button variant="primary" size="sm" onClick={post} disabled={posting}>
            {posting ? "Posting…" : "Close to Retained Earnings"}
          </Button>
        )}
        <p className="text-[11px] text-[#9CA3AF] max-w-md">
          Posts every P&L account's un-closed balance to 150-0000. P&L
          reports exclude close entries; the balance sheet absorbs them —
          "Current Year Earnings (unclosed)" then shows only the open year.
        </p>
      </CardContent>
    </Card>
  );
}

function BalanceSheetTab() {
  const { data: bsResp, loading: bsLoading } = useCachedJson<{ success?: boolean; data?: { balanceSheet?: BalanceSheetEntry[] } }>("/api/accounting/pl");
  const bsData: BalanceSheetEntry[] = useMemo(
    () => (bsResp?.success && bsResp.data?.balanceSheet ? bsResp.data.balanceSheet : []),
    [bsResp]
  );

  if (bsLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[#6B7280]">Loading balance sheet...</div>
      </div>
    );
  }

  const currentAssets = bsData.filter((e) => e.category === "CURRENT_ASSET");
  const fixedAssets = bsData.filter((e) => e.category === "FIXED_ASSET");
  const currentLiabilities = bsData.filter((e) => e.category === "CURRENT_LIABILITY");
  const longTermLiabilities = bsData.filter((e) => e.category === "LONG_TERM_LIABILITY");
  const equityItems = bsData.filter((e) => e.category === "EQUITY");

  const totalCurrentAssets = currentAssets.reduce((s, e) => s + e.balance, 0);
  const totalFixedAssets = fixedAssets.reduce((s, e) => s + e.balance, 0);
  const totalAssets = totalCurrentAssets + totalFixedAssets;
  const totalCurrentLiab = currentLiabilities.reduce((s, e) => s + e.balance, 0);
  const totalLongTermLiab = longTermLiabilities.reduce((s, e) => s + e.balance, 0);
  const totalLiabilities = totalCurrentLiab + totalLongTermLiab;
  const totalEquity = equityItems.reduce((s, e) => s + e.balance, 0);
  const totalLiabEquity = totalLiabilities + totalEquity;

  const renderBSSection = (
    title: string,
    entries: BalanceSheetEntry[],
    total: number,
    colorClass: string,
    bgClass: string
  ) => (
    <>
      <tr className={bgClass}>
        <td colSpan={3} className={`px-4 py-2 font-semibold ${colorClass}`}>{title}</td>
      </tr>
      {entries.map((e) => (
        <tr key={e.id} className="border-t border-[#E2DDD8]/50">
          <td className="px-4 py-1.5 pl-8 text-[#6B7280] text-xs">{e.accountCode}</td>
          <td className="px-4 py-1.5 text-[#4B5563]">{e.accountName}</td>
          <td className={`px-4 py-1.5 text-right font-medium ${e.balance < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
            {e.balance < 0 ? `(${formatCurrency(Math.abs(e.balance))})` : formatCurrency(e.balance)}
          </td>
        </tr>
      ))}
      <tr className={`border-t border-[#E2DDD8] ${bgClass} font-semibold`}>
        <td colSpan={2} className={`px-4 py-2 ${colorClass}`}>Total {title}</td>
        <td className={`px-4 py-2 text-right ${colorClass}`}>{formatCurrency(total)}</td>
      </tr>
    </>
  );

  return (
    <div className="space-y-6">
      <YearCloseCard />
      {/* Balance equation */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-[#6B7280]">Total Assets</p>
            <p className="text-xl font-bold text-[#3E6570]">{formatCurrency(totalAssets)}</p>
          </CardContent>
        </Card>
        <Card className="flex items-center justify-center">
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-[#6B5C32]">=</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-[#6B7280]">Liabilities + Equity</p>
            <p className="text-xl font-bold text-[#6B4A6D]">{formatCurrency(totalLiabEquity)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Balance Sheet Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-5 w-5 text-[#6B5C32]" />
            Balance Sheet as at 31 March 2026
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#F0ECE9]">
                  <th className="text-left px-4 py-2 font-semibold text-[#1F1D1B] w-28">Code</th>
                  <th className="text-left px-4 py-2 font-semibold text-[#1F1D1B]">Account</th>
                  <th className="text-right px-4 py-2 font-semibold text-[#1F1D1B] w-40">Amount (RM)</th>
                </tr>
              </thead>
              <tbody>
                {/* ASSETS — INFO (teal) tint */}
                <tr className={`${INFO.bg} border-t-2 ${INFO.border}`}>
                  <td colSpan={3} className={`px-4 py-2 font-bold text-base ${INFO.text}`}>ASSETS</td>
                </tr>
                {renderBSSection("Current Assets", currentAssets, totalCurrentAssets, INFO.text, INFO.bg)}
                {renderBSSection("Fixed Assets (Net)", fixedAssets, totalFixedAssets, INFO.text, INFO.bg)}
                <tr className={`border-t-2 ${INFO.border} ${INFO.bg} font-bold`}>
                  <td colSpan={2} className={`px-4 py-3 ${INFO.text}`}>TOTAL ASSETS</td>
                  <td className={`px-4 py-3 text-right ${INFO.text}`}>{formatCurrency(totalAssets)}</td>
                </tr>

                {/* LIABILITIES — DANGER (red) tint */}
                <tr className={`${DANGER.bg} border-t-2 ${DANGER.border}`}>
                  <td colSpan={3} className={`px-4 py-2 font-bold text-base ${DANGER.text}`}>LIABILITIES</td>
                </tr>
                {renderBSSection("Current Liabilities", currentLiabilities, totalCurrentLiab, DANGER.text, DANGER.bg)}
                {renderBSSection("Long-Term Liabilities", longTermLiabilities, totalLongTermLiab, DANGER.text, DANGER.bg)}
                <tr className={`border-t border-[#E2DDD8] font-semibold ${DANGER.bg}`}>
                  <td colSpan={2} className={`px-4 py-2 ${DANGER.text}`}>Total Liabilities</td>
                  <td className={`px-4 py-2 text-right ${DANGER.text}`}>{formatCurrency(totalLiabilities)}</td>
                </tr>

                {/* EQUITY — ACCENT_PLUM tint */}
                {renderBSSection("Equity", equityItems, totalEquity, ACCENT_PLUM.text, ACCENT_PLUM.bg)}

                {/* Total L+E */}
                <tr className="border-t-2 border-[#1F1D1B] bg-[#1F1D1B] text-white font-bold">
                  <td colSpan={2} className="px-4 py-3">TOTAL LIABILITIES + EQUITY</td>
                  <td className="px-4 py-3 text-right">{formatCurrency(totalLiabEquity)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Balance check */}
          <div className={`mt-3 p-3 rounded-lg text-sm border ${totalAssets === totalLiabEquity ? `${SUCCESS.bg} ${SUCCESS.text} ${SUCCESS.border}` : `${DANGER.bg} ${DANGER.text} ${DANGER.border}`}`}>
            {totalAssets === totalLiabEquity ? (
              <span className="flex items-center gap-2"><Check className="h-4 w-4" /> Balance sheet is balanced. Assets = Liabilities + Equity</span>
            ) : (
              <span className="flex items-center gap-2"><X className="h-4 w-4" /> Balance sheet is NOT balanced. Difference: {formatCurrency(Math.abs(totalAssets - totalLiabEquity))}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
