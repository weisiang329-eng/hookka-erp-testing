import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { humanizeError } from "@/lib/humanize-error";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { exportReportCsv, exportReportXlsx, exportReportPdf, type Aoa } from "@/lib/export-report";
import { COA_TYPE_COLOR, SUCCESS, DANGER, INFO, ACCENT_PLUM } from "@/lib/design-tokens";
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
} from "lucide-react";
import type {
  ChartOfAccount,
  JournalEntry,
  JournalLine,
  ARAgingEntry,
  APAgingEntry,
  BalanceSheetEntry,
} from "@/types";

// =============== TYPES ===============

type TabKey = "overview" | "coa" | "journals" | "tb" | "gl" | "ar" | "ap" | "odc" | "pl" | "trend" | "ceclass" | "coststruct" | "cashflow" | "bs" | "payments" | "receipts" | "cashbook" | "assets" | "labor" | "stock" | "stockmap" | "opening" | "maint";

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
              <span className="tabular-nums text-xs text-[#6B7280] mr-2">{a.code}</span>
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

// Grouped per the owner's 2026-06 UI reorg (sidebar drives navigation; the
// in-page bar mirrors the same grouping). Standalone-page items (Supplier
// Payment, Credit/Debit Notes, e-Invoice, Reports) live in the sidebar, not
// here.
const TABS: { key: TabKey; label: string; icon: React.ReactNode; group: string }[] = [
  // Monthly Report
  { key: "overview", label: "Overview", icon: <LayoutDashboard className="h-4 w-4" />, group: "Monthly Report" },
  { key: "pl", label: "P&L", icon: <BarChart3 className="h-4 w-4" />, group: "Monthly Report" },
  { key: "coststruct", label: "Cost Structure", icon: <List className="h-4 w-4" />, group: "Monthly Report" },
  { key: "cashflow", label: "Cash Flow", icon: <TrendingUp className="h-4 w-4" />, group: "Monthly Report" },
  { key: "bs", label: "Balance Sheet", icon: <Scale className="h-4 w-4" />, group: "Monthly Report" },
  { key: "tb", label: "Trial Balance", icon: <Scale className="h-4 w-4" />, group: "Monthly Report" },
  { key: "gl", label: "General Ledger", icon: <FileText className="h-4 w-4" />, group: "Monthly Report" },
  { key: "trend", label: "Monthly Trend", icon: <TrendingUp className="h-4 w-4" />, group: "Monthly Report" },
  { key: "ceclass", label: "Cost / Expense Classes", icon: <BarChart3 className="h-4 w-4" />, group: "Monthly Report" },
  // Daily Operation
  { key: "payments", label: "Expense Payment", icon: <BookOpen className="h-4 w-4" />, group: "Daily Operation" },
  { key: "receipts", label: "Receipts", icon: <BookOpen className="h-4 w-4" />, group: "Daily Operation" },
  // Monthly Operation
  { key: "journals", label: "Journal Entries", icon: <BookOpen className="h-4 w-4" />, group: "Monthly Operation" },
  { key: "cashbook", label: "Cash Book", icon: <BookOpen className="h-4 w-4" />, group: "Monthly Operation" },
  { key: "assets", label: "Fixed Assets", icon: <Building2 className="h-4 w-4" />, group: "Monthly Operation" },
  // Debtor / Creditor
  { key: "ar", label: "Debtor Aging", icon: <Users className="h-4 w-4" />, group: "Debtor / Creditor" },
  { key: "ap", label: "Creditor Aging", icon: <Building2 className="h-4 w-4" />, group: "Debtor / Creditor" },
  { key: "odc", label: "Other Debtor / Creditor", icon: <Users className="h-4 w-4" />, group: "Debtor / Creditor" },
  // Maintenance
  { key: "coa", label: "Chart of Accounts", icon: <List className="h-4 w-4" />, group: "Maintenance" },
  { key: "labor", label: "Labour", icon: <Users className="h-4 w-4" />, group: "Maintenance" },
  { key: "stock", label: "Stock", icon: <List className="h-4 w-4" />, group: "Maintenance" },
  { key: "stockmap", label: "Stock Mapping", icon: <List className="h-4 w-4" />, group: "Maintenance" },
  { key: "opening", label: "Opening Balance", icon: <Scale className="h-4 w-4" />, group: "Maintenance" },
  { key: "maint", label: "Maintenance", icon: <List className="h-4 w-4" />, group: "Maintenance" },
];

// =============== MAIN PAGE ===============

export default function AccountingPage() {
  // The sidebar deep-links each report via /accounting?tab=<key>; keep the
  // selected tab in the URL so those links land on the right screen and the
  // tab is shareable/bookmarkable.
  const [searchParams] = useSearchParams();
  const urlTab = searchParams.get("tab");
  // The URL is the source of truth — derive the active tab. Navigation comes
  // from the sidebar's deep links (/accounting?tab=<key>); the in-page tab bar
  // was removed as a duplicate of the sidebar (owner 2026-06).
  const tab: TabKey = (TABS.some((t) => t.key === urlTab) ? urlTab : "overview") as TabKey;
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

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-[#6B7280]">Loading accounting data...</div>
        </div>
      ) : (
        <>
          {tab === "overview" && (
            <OverviewTab accounts={accounts} journals={journals} arData={arData} apData={apData} />
          )}
          {tab === "pl" && <PLStatementTab />}
          {tab === "trend" && <MonthlyTrendTab />}
          {tab === "ceclass" && <CostExpenseClassesTab />}
          {tab === "coststruct" && <CostStructureTab />}
          {tab === "bs" && <BalanceSheetTab />}
          {tab === "cashflow" && <CashFlowTab />}
          {tab === "coa" && <COATab accounts={accounts} onRefresh={fetchAll} />}
          {tab === "journals" && (
            <JournalsTab journals={journals} accounts={accounts} onRefresh={fetchAll} />
          )}
          {tab === "tb" && <TrialBalanceTab />}
          {tab === "gl" && <GeneralLedgerTab accounts={accounts} />}
          {tab === "ar" && <ARTab arData={arData} onRefresh={fetchAll} />}
          {tab === "ap" && (
            <div className="space-y-4">
              <ContraCard />
              <APTab apData={apData} onRefresh={fetchAll} />
            </div>
          )}
          {tab === "odc" && <OtherPartiesTab />}
          {tab === "payments" && <PaymentsTab accounts={accounts} />}
          {tab === "receipts" && <ReceiptsTab accounts={accounts} />}
          {tab === "cashbook" && <CashBookTab accounts={accounts} />}
          {tab === "assets" && <FixedAssetsTab accounts={accounts} />}
          {tab === "labor" && <LaborTab accounts={accounts} />}
          {tab === "stock" && <StockSummaryTab />}
          {tab === "opening" && <OpeningBalanceTab accounts={accounts} onRefresh={fetchAll} />}
          {tab === "stockmap" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-[#1F1D1B]">Stock Group Mapping</h2>
              <StockMapCard accounts={accounts} />
            </div>
          )}
          {tab === "maint" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-[#1F1D1B]">Account Maintenance</h2>
              <GstRateCard />
              <FyeCard />
              <CleanupReportCard />
              <LandedCostCard />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// =============== TAB 1: OVERVIEW ===============

// Phase 4.7 — cleanup report: data that can't be allocated to a material
// group / product line, so the owner can fix it before trusting the split
// reports.
function CleanupReportCard() {
  const [data, setData] = useState<{
    posWithoutCategory: { poNumber: string; costSen: number }[];
    rmWithoutGroup: { itemCode: string; name: string }[];
    unmappedGroups: string[];
    defaultRmAccount: { stock: string; opening: string; closing: string };
  } | null>(null);
  useEffect(() => {
    let stale = false;
    fetch("/api/accounting/cleanup-report")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof data> }>)
      .then((j) => { if (!stale && j?.success && j.data) setData(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, []);
  const clean = data && data.posWithoutCategory.length === 0 && data.rmWithoutGroup.length === 0 && data.unmappedGroups.length === 0;
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[#1F1D1B]">
          Unallocated data cleanup <span className="font-normal text-[#6B7280]">— fix these so the split P&L and stock reports are complete</span>
        </h3>
        {!data ? (
          <p className="text-sm text-[#6B7280]">Loading…</p>
        ) : clean ? (
          <p className="text-sm text-[#27500A]">All clean ✓ — every production order has a product line, every material has a group, every group is mapped.</p>
        ) : (
          <div className="space-y-3 text-sm">
            {data.posWithoutCategory.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-[#9A3A2D] mb-1">Production orders with cost but no product line ({data.posWithoutCategory.length}) — set Sofa/Bedframe on the order:</p>
                <div className="flex flex-wrap gap-2">
                  {data.posWithoutCategory.slice(0, 40).map((p) => (
                    <span key={p.poNumber} className="inline-flex items-center gap-1.5 rounded-full border border-[#F7C1C1] bg-[#FCEBEB] px-2 py-0.5 text-xs tabular-nums">{p.poNumber} · {formatCurrency(p.costSen)}</span>
                  ))}
                </div>
              </div>
            )}
            {data.rmWithoutGroup.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-[#9A3A2D] mb-1">Raw materials with no stock group ({data.rmWithoutGroup.length}) — fall to {data.defaultRmAccount.stock}; set itemGroup:</p>
                <div className="flex flex-wrap gap-2">
                  {data.rmWithoutGroup.slice(0, 40).map((r) => (
                    <span key={r.itemCode} className="inline-flex items-center rounded-full border border-[#E2DDD8] bg-white px-2 py-0.5 text-xs"><span className="tabular-nums text-[#6B7280] mr-1">{r.itemCode}</span>{r.name}</span>
                  ))}
                </div>
              </div>
            )}
            {data.unmappedGroups.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-[#9A3A2D] mb-1">Stock groups in use but not mapped ({data.unmappedGroups.length}) — fall to {data.defaultRmAccount.stock}; add them in the Stock-Group map:</p>
                <div className="flex flex-wrap gap-2">
                  {data.unmappedGroups.map((g) => (
                    <span key={g} className="inline-flex items-center rounded-full border border-[#FAC775] bg-[#FAEEDA] px-2 py-0.5 text-xs tabular-nums">{g}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Phase 3.8 — Contra: a customer who is ALSO a supplier — offset ticked
// APPROVED PIs against their oldest unpaid invoices via the 490-0000
// suspense. Both control accounts and both subledgers settle together.
function ContraCard() {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [pis, setPis] = useState<{ id: string; piNo: string; invoiceDate: string | null; amountSen: number }[]>([]);
  const [arUnpaidSen, setArUnpaidSen] = useState(0);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/customers")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { id: string; name: string }[] }>)
      .then((j) => { if (j?.success) setCustomers((j.data ?? []).map((x) => ({ id: x.id, name: x.name }))); })
      .catch(() => {});
    fetch("/api/suppliers")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { id: string; name: string }[] }>)
      .then((j) => { if (j?.success) setSuppliers((j.data ?? []).map((x) => ({ id: x.id, name: x.name }))); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!supplierId && !customerId) return;
    let stale = false;
    const p = new URLSearchParams();
    if (supplierId) p.set("supplierId", supplierId);
    if (customerId) p.set("customerId", customerId);
    fetch(`/api/accounting/contra/candidates?${p.toString()}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { pis?: typeof pis; arUnpaidSen?: number } }>)
      .then((j) => {
        if (stale) return;
        if (j?.success && j.data) {
          setPis(j.data.pis ?? []);
          setArUnpaidSen(j.data.arUnpaidSen ?? 0);
        }
      })
      .catch(() => {});
    return () => { stale = true; };
  }, [supplierId, customerId]);

  const totalSen = pis.filter((p) => ticked[p.id]).reduce((s, p) => s + p.amountSen, 0);
  const canPost = customerId && totalSen > 0 && totalSen <= arUnpaidSen;

  const handlePost = async () => {
    if (!window.confirm(`Contra ${formatCurrency(totalSen)} of payables against this customer's oldest unpaid invoices?`)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/accounting/contra", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, piIds: pis.filter((p) => ticked[p.id]).map((p) => p.id) }),
      });
      const j = await res.json() as { success?: boolean; data?: { totalSen: number; pis: number }; error?: string };
      if (j?.success && j.data) {
        toast.success(`Contra posted — ${formatCurrency(j.data.totalSen)} across ${j.data.pis} PIs`);
        setTicked({});
        setSupplierId("");
        setCustomerId("");
      } else toast.error(j?.error || "Contra failed");
    } finally {
      setBusy(false);
    }
  };

  const selCls = "rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm";
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[#1F1D1B]">
          Contra <span className="font-normal text-[#6B7280]">— customer who is also a supplier: offset payables against receivables via 490-0000</span>
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">Supplier (we owe them)</label>
            <select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPis([]); setTicked({}); }} className={`${selCls} w-56`}>
              <option value="">— supplier —</option>
              {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">Customer (they owe us)</label>
            <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setArUnpaidSen(0); }} className={`${selCls} w-56`}>
              <option value="">— customer —</option>
              {customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </div>
          {customerId && (
            <span className="text-sm text-[#6B7280] pb-2">Customer owes <span className="font-medium text-[#1F1D1B] tabular-nums">{formatCurrency(arUnpaidSen)}</span></span>
          )}
          <Button variant="primary" size="sm" disabled={!canPost || busy} onClick={handlePost}>
            {busy ? "Posting…" : `Contra ${formatCurrency(totalSen)}`}
          </Button>
          {totalSen > arUnpaidSen && (
            <span className="text-xs text-[#9A3A2D] pb-2">Selected payables exceed what the customer owes</span>
          )}
        </div>
        {supplierId && (
          pis.length === 0 ? (
            <p className="text-xs text-[#9CA3AF]">No APPROVED (unpaid) purchase invoices for this supplier.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-2 py-1.5 w-8" />
                  <th className="px-2 py-1.5 text-left">PI No</th>
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {pis.map((p) => (
                  <tr key={p.id} className="border-b border-[#F0ECE9]">
                    <td className="px-2 py-1">
                      <input type="checkbox" checked={!!ticked[p.id]} onChange={(e) => setTicked({ ...ticked, [p.id]: e.target.checked })} className="h-4 w-4 accent-[#6B5C32]" />
                    </td>
                    <td className="px-2 py-1 tabular-nums text-xs">{p.piNo}</td>
                    <td className="px-2 py-1 text-xs text-[#6B7280]">{p.invoiceDate ?? ""}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(p.amountSen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
        <p className="text-[11px] text-[#9CA3AF]">
          Whole PIs only; the amount auto-settles the customer's OLDEST unpaid invoices first (FIFO). 490-0000 nets to zero in the same entry.
        </p>
      </CardContent>
    </Card>
  );
}

// Phase 3.7 — landed cost: spread import charges (freight/duty/clearance)
// onto a GRN's stock batches proportional to value. No GL legs here: the
// charge PI already debits 700-1015 into the Manufacturing Account, and
// closing stock valued off the higher batch costs credits the unused part
// back out. Server refuses once any batch has been issued from.
function LandedCostCard() {
  const { toast } = useToast();
  const [grn, setGrn] = useState("");
  const [amount, setAmount] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    grnId: string; grnNumber: string; eligible: boolean;
    batches: { id: string; itemCode: string | null; name: string | null; originalQty: number; remainingQty: number; unitCostSen: number; valueSen: number; allocSen: number; newUnitCostSen: number }[];
  } | null>(null);
  const toSen = (s: string) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? Math.round(v * 100) : 0;
  };
  const amountSen = toSen(amount);

  const handlePreview = async () => {
    setPreview(null);
    const p = new URLSearchParams({ grn: grn.trim() });
    if (amountSen > 0) p.set("amountSen", String(amountSen));
    const res = await fetch(`/api/accounting/landed-cost/preview?${p.toString()}`);
    const j = await res.json() as { success?: boolean; data?: NonNullable<typeof preview>; error?: string };
    if (j?.success && j.data) setPreview(j.data);
    else toast.error(j?.error || "Preview failed");
  };

  const handleAllocate = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/accounting/landed-cost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grnId: preview!.grnId, amountSen, ref }),
      });
      const j = await res.json() as { success?: boolean; data?: { grnNumber: string; batches: number }; error?: string };
      if (j?.success && j.data) {
        toast.success(`${formatCurrency(amountSen)} spread over ${j.data.batches} batches of ${j.data.grnNumber}`);
        setPreview(null);
        setGrn(""); setAmount(""); setRef("");
      } else toast.error(j?.error || "Allocation failed");
    } finally {
      setBusy(false);
    }
  };

  const inCls = "rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm";
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[#1F1D1B]">
          Landed Cost <span className="font-normal text-[#6B7280]">— spread import charges (freight/duty/clearance) onto a GRN's batch costs</span>
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">GRN number</label>
            <input type="text" placeholder="GRN-…" value={grn} onChange={(e) => { setGrn(e.target.value); setPreview(null); }} className={`${inCls} w-44`} />
          </div>
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">Charges (RM)</label>
            <input type="text" value={amount} onChange={(e) => { setAmount(e.target.value); setPreview(null); }} className={`${inCls} w-28 text-right tabular-nums`} />
          </div>
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">Ref (forwarder PI no, optional)</label>
            <input type="text" value={ref} onChange={(e) => setRef(e.target.value)} className={`${inCls} w-40`} />
          </div>
          <Button variant="outline" size="sm" disabled={!grn.trim() || amountSen <= 0} onClick={handlePreview}>Preview</Button>
          {preview && preview.eligible && (
            <Button variant="primary" size="sm" disabled={busy} onClick={handleAllocate}>
              {busy ? "Allocating…" : `Allocate ${formatCurrency(amountSen)}`}
            </Button>
          )}
        </div>
        {preview && !preview.eligible && (
          <p className="text-xs text-[#9A3A2D]">
            Some batches of {preview.grnNumber} are already partly issued — the charge stays in 700-1015 (Manufacturing Account still absorbs it) or adjust by JV.
          </p>
        )}
        {preview && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                <th className="px-2 py-1.5 text-left">Material</th>
                <th className="px-2 py-1.5 text-right">Qty</th>
                <th className="px-2 py-1.5 text-right">Unit cost</th>
                <th className="px-2 py-1.5 text-right">Batch value</th>
                <th className="px-2 py-1.5 text-right">Share</th>
                <th className="px-2 py-1.5 text-right">New unit cost</th>
              </tr>
            </thead>
            <tbody>
              {preview.batches.map((b) => (
                <tr key={b.id} className="border-b border-[#F0ECE9]">
                  <td className="px-2 py-1"><span className="tabular-nums text-xs text-[#6B7280] mr-1">{b.itemCode ?? ""}</span>{b.name ?? ""}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{b.originalQty}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(b.unitCostSen)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(b.valueSen)}</td>
                  <td className="px-2 py-1 text-right tabular-nums font-medium">{formatCurrency(b.allocSen)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(b.newUnitCostSen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

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

// Maintenance — AutoCount-style stock-group account grid (owner request
// 2026-06-12: the raw JSON textarea was unusable). One row per raw-material
// stock group with editable Purchase / Balance Stock / Opening / Closing
// account cells, plus Default / WIP / FG rows. Loads the EFFECTIVE mapping
// (kv overrides over built-in defaults) and saves the full grid back to
// the same kv key the posting + manufacturing reports already read.
function StockMapCard({ accounts }: { accounts: ChartOfAccount[] }) {
  const { toast } = useToast();
  type Entry = { stock: string; opening: string; closing: string; purchase?: string };
  type GridRow = Entry & { group: string; description?: string };
  const [rows, setRows] = useState<GridRow[] | null>(null);
  const [rmDefault, setRmDefault] = useState<Entry & { purchase: string }>({ stock: "", opening: "", closing: "", purchase: "" });
  const [wip, setWip] = useState<Entry>({ stock: "", opening: "", closing: "" });
  const [fg, setFg] = useState<Entry>({ stock: "", opening: "", closing: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let stale = false;
    fetch("/api/accounting/stock-map/effective")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { groups: GridRow[]; rmDefault: Entry & { purchase: string }; wip: Entry; fg: Entry } }>)
      .then((j) => {
        if (stale || !j?.success || !j.data) return;
        setRows(j.data.groups);
        setRmDefault(j.data.rmDefault);
        setWip(j.data.wip);
        setFg(j.data.fg);
      })
      .catch(() => {});
    return () => { stale = true; };
  }, []);

  const setCell = (i: number, field: keyof Entry, v: string) =>
    setRows((prev) => (prev ? prev.map((r, x) => (x === i ? { ...r, [field]: v } : r)) : prev));

  const save = async () => {
    if (!rows) return;
    setSaving(true);
    try {
      const rm: Record<string, Entry> = {};
      for (const r of rows)
        rm[r.group] = { stock: r.stock, opening: r.opening, closing: r.closing, purchase: r.purchase };
      const res = await fetch("/api/kv-config/coa_stock_map", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rmDefault, rm, wip, fg }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (j?.success) toast.success("Stock-group account mapping saved");
      else toast.error(j?.error || "Failed to save mapping");
    } catch {
      toast.error("Failed to save mapping");
    } finally {
      setSaving(false);
    }
  };

  // Owner request 2026-06-12: cells are COA pickers, not blind number
  // boxes — the selected account shows as "code - name" and typing a
  // keyword searches the chart.
  const cell = (value: string, onChange: (v: string) => void) => (
    <div className="w-56">
      <AccountPicker
        accounts={accounts}
        value={value}
        onChange={onChange}
        placeholder="Type code or name…"
      />
    </div>
  );

  return (
    <Card className="mb-4">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-[#1F1D1B]">Stock Group → Account Mapping</h3>
            <p className="text-xs text-[#6B7280] max-w-3xl">
              One row per raw-material stock group: which PURCHASE account a
              purchase-invoice line posts to, and which BALANCE STOCK /
              OPENING / CLOSING accounts the manufacturing report uses.
              Values shown are the ones currently in effect.
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={save} disabled={saving || !rows}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
        {!rows ? (
          <div className="py-8 text-center text-[#6B7280] text-sm">Loading mapping…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">Stock Group</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-left">Purchase Code</th>
                  <th className="px-3 py-2 text-left">Balance Stock Code</th>
                  <th className="px-3 py-2 text-left">Opening Code</th>
                  <th className="px-3 py-2 text-left">Closing Code</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.group} className="border-b border-[#F0ECE9]">
                    <td className="px-3 py-1.5 font-medium text-[#1F1D1B] whitespace-nowrap">{r.group}</td>
                    <td className="px-3 py-1.5 text-[#6B7280] whitespace-nowrap">{r.description ?? r.group}</td>
                    <td className="px-3 py-1">{cell(r.purchase ?? "", (v) => setCell(i, "purchase", v))}</td>
                    <td className="px-3 py-1">{cell(r.stock, (v) => setCell(i, "stock", v))}</td>
                    <td className="px-3 py-1">{cell(r.opening, (v) => setCell(i, "opening", v))}</td>
                    <td className="px-3 py-1">{cell(r.closing, (v) => setCell(i, "closing", v))}</td>
                  </tr>
                ))}
                <tr className="border-b border-[#F0ECE9] bg-[#F7F4EF]">
                  <td className="px-3 py-1.5 font-medium text-[#6B7280] whitespace-nowrap">(Default)</td>
                  <td className="px-3 py-1.5 text-xs text-[#9CA3AF]">unmapped groups</td>
                  <td className="px-3 py-1">{cell(rmDefault.purchase, (v) => setRmDefault({ ...rmDefault, purchase: v }))}</td>
                  <td className="px-3 py-1">{cell(rmDefault.stock, (v) => setRmDefault({ ...rmDefault, stock: v }))}</td>
                  <td className="px-3 py-1">{cell(rmDefault.opening, (v) => setRmDefault({ ...rmDefault, opening: v }))}</td>
                  <td className="px-3 py-1">{cell(rmDefault.closing, (v) => setRmDefault({ ...rmDefault, closing: v }))}</td>
                </tr>
                <tr className="border-b border-[#F0ECE9] bg-[#F7F4EF]">
                  <td className="px-3 py-1.5 font-medium text-[#6B7280]">WIP</td>
                  <td className="px-3 py-1.5 text-xs text-[#9CA3AF]">WORK IN PROGRESS</td>
                  <td className="px-3 py-1 text-xs text-[#9CA3AF]">—</td>
                  <td className="px-3 py-1">{cell(wip.stock, (v) => setWip({ ...wip, stock: v }))}</td>
                  <td className="px-3 py-1">{cell(wip.opening, (v) => setWip({ ...wip, opening: v }))}</td>
                  <td className="px-3 py-1">{cell(wip.closing, (v) => setWip({ ...wip, closing: v }))}</td>
                </tr>
                <tr className="border-b border-[#F0ECE9] bg-[#F7F4EF]">
                  <td className="px-3 py-1.5 font-medium text-[#6B7280]">FG</td>
                  <td className="px-3 py-1.5 text-xs text-[#9CA3AF]">FINISHED GOODS</td>
                  <td className="px-3 py-1 text-xs text-[#9CA3AF]">—</td>
                  <td className="px-3 py-1">{cell(fg.stock, (v) => setFg({ ...fg, stock: v }))}</td>
                  <td className="px-3 py-1">{cell(fg.opening, (v) => setFg({ ...fg, opening: v }))}</td>
                  <td className="px-3 py-1">{cell(fg.closing, (v) => setFg({ ...fg, closing: v }))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
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
  const { confirm, confirmDialog } = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    code: "",
    name: "",
    // Owner: the create form offers the same NINE sections as the tree —
    // the section maps onto a DB type + code band on submit (handleAdd).
    section: "NCA",
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
  // Code bands per section (mirrors sectionOf) — placeholder example +
  // the rejection hint when a new account's code lands outside its section.
  const SECTION_CODE_BAND: Record<string, { example: string; hint: string }> = {
    NCA: { example: "200-1000", hint: "below 300" },
    CA: { example: "330-5000", hint: "300 and above" },
    CL: { example: "440-0000", hint: "outside 480–489" },
    NCL: { example: "480-0050", hint: "480–489" },
    EQ: { example: "100-0005", hint: "any band" },
    REV: { example: "500-0040", hint: "below 530" },
    OI: { example: "530-0010", hint: "530 and above" },
    COGS: { example: "701-0040", hint: "any band" },
    EXP: { example: "900-A001", hint: "any band" },
  };
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    Object.fromEntries(SECTIONS.map((s) => [s.key, true])),
  );
  // Per-parent expand/collapse (owner request) — default expanded;
  // a missing key means expanded.
  const [collapsedParents, setCollapsedParents] = useState<Record<string, boolean>>({});
  // Drag & drop re-parenting (owner: "按着就能移动").
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Drop a dragged account onto a new parent. Same-section only (a
  // Current-Asset child can't live under a COGS parent), no self/descendant
  // drops (server re-validates the cycle). Dropping onto a LEAF account
  // promotes it into a parent — only while it carries no amount (the
  // server re-checks the ledger and flips it non-postable on promotion).
  const handleMove = async (srcCode: string, dstCode: string) => {
    if (!srcCode || srcCode === dstCode) return;
    const src = accounts.find((a) => a.code === srcCode);
    const dst = accounts.find((a) => a.code === dstCode);
    if (!src || !dst) return;
    if (sectionOf(src) !== sectionOf(dst)) {
      toast.error("Cannot move across sections — the account stays within its own section");
      return;
    }
    let cur: string | undefined = dst.parentCode;
    for (let hops = 0; cur && hops < 20; hops++) {
      if (cur === srcCode) {
        toast.error("Cannot move an account inside its own sub-accounts");
        return;
      }
      cur = accounts.find((a) => a.code === cur)?.parentCode;
    }
    const dstHasKids = accounts.some((a) => a.parentCode === dstCode);
    if (!dstHasKids && (dst.balance ?? 0) !== 0) {
      toast.error(`${dstCode} already has an amount — it can only become a parent while its balance is zero`);
      return;
    }
    const res = await fetch("/api/accounting/coa", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: srcCode, parentCode: dstCode }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) {
      toast.success(`${srcCode} moved under ${dstCode}`);
      onRefresh();
    } else toast.error(j?.error || "Move failed");
  };

  // Change an account's CODE — history follows via the alias layer (the
  // server refuses system-posted accounts).
  const handleRenameCode = async (node: ChartOfAccount) => {
    const nc = window.prompt(
      `Change account code for ${node.code} - ${node.name}\n\nAll past transactions on ${node.code} will follow to the new code on every report (trial balance, GL, P&L, statements).\n\nNew code:`,
      node.code,
    );
    if (!nc || nc.trim() === "" || nc.trim() === node.code) return;
    const res = await fetch("/api/accounting/coa/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldCode: node.code, newCode: nc.trim() }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) {
      toast.success(`${node.code} → ${nc.trim()} (history follows)`);
      onRefresh();
    } else toast.error(j?.error || "Rename failed");
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
    const sec = SECTIONS.find((s) => s.key === formData.section);
    if (!sec) return;
    const code = formData.code.trim();
    if (!code || !formData.name.trim()) {
      toast.error("Code and name are required");
      return;
    }
    // The nine sections map onto six DB types + a code band (sectionOf) —
    // refuse a code outside the chosen section's band, or the new account
    // would silently render under a different section of the tree.
    const landing = sectionOf({ code, type: sec.type } as ChartOfAccount);
    if (landing !== sec.key) {
      const other = SECTIONS.find((s) => s.key === landing);
      toast.error(
        `Code ${code} lands in ${other?.label ?? landing} — ${sec.label} uses codes ${SECTION_CODE_BAND[sec.key].hint}`,
      );
      return;
    }
    const { section: _section, ...rest } = formData;
    void _section;
    const res = await fetch("/api/accounting/coa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rest, code, name: formData.name.trim(), type: sec.type }),
    });
    const data = asMutationResponse(await res.json());
    if (data?.success) {
      setShowForm(false);
      setFormData({
        code: "",
        name: "",
        section: "NCA",
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
  // Owner rule ([[feedback_no_naked_edits]]): no naked auto-save — the
  // dropdown's onChange must ask an in-app Confirm before the PUT fires.
  // On cancel we re-fetch so the controlled <select> snaps back to the
  // stored category (the change was never written).
  const handleSetPnl = async (code: string, value: string) => {
    const PNL_LABEL: Record<string, string> = {
      "": "— (none)",
      FIXED: "Fixed",
      VARIABLE: "Variable",
      OTHERS: "Others",
    };
    const ok = await confirm({
      title: "Change P&L category?",
      message: (
        <>
          Set account{" "}
          <span className="font-semibold text-[#6B5C32]">{code}</span> P&L
          category to{" "}
          <span className="font-semibold text-[#6B5C32]">{PNL_LABEL[value] ?? value}</span>?
        </>
      ),
      confirmLabel: "Change",
    });
    if (!ok) {
      onRefresh();
      return;
    }
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
      {confirmDialog}
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
                  placeholder={`e.g. ${SECTION_CODE_BAND[formData.section].example}`}
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
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Section</label>
                <select
                  value={formData.section}
                  onChange={(e) => setFormData({ ...formData, section: e.target.value, parentCode: "" })}
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  {SECTIONS.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
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
                    .filter((a) => sectionOf(a) === formData.section)
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
                {/* Only the values the posting/report code consumes (or is
                    committed to): SDC drives AR Control + customer
                    control-account checks, SCC drives AP Control, SOS/SCS
                    feed the Manufacturing P&L opening/closing stock lines,
                    SBK/SCA gate the Phase-3 Payment/Expense paying-account
                    picker. Anything else is inert, so free text only
                    invited typos. */}
                <select
                  value={formData.specialAccountType}
                  onChange={(e) =>
                    setFormData({ ...formData, specialAccountType: e.target.value })
                  }
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                >
                  <option value="">(None)</option>
                  <option value="SDC">SDC — Debtor Control (AR)</option>
                  <option value="SCC">SCC — Creditor Control (AP)</option>
                  <option value="SBK">SBK — Bank Account (Payment)</option>
                  <option value="SCH">SCH — Cash Account (Payment)</option>
                  <option value="SOS">SOS — Opening Stock (Mfg P&L)</option>
                  <option value="SCS">SCS — Closing Stock (Mfg P&L)</option>
                </select>
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
                className={`flex items-center justify-between py-2 pr-2 text-sm border-b ${isHeader ? "bg-[#F0ECE9]/60 border-[#E2DDD8] font-semibold text-[#1F1D1B]" : "border-[#F0ECE9] hover:bg-[#F0ECE9]/30"} ${hasKids ? "cursor-pointer" : ""} ${dragOver === node.code ? "ring-2 ring-inset ring-[#6B5C32]" : ""} ${dragging === node.code ? "opacity-40" : ""} group`}
                style={{ paddingLeft: `${8 + depth * 22}px` }}
                draggable
                onDragStart={(e) => {
                  e.stopPropagation();
                  setDragging(node.code);
                  e.dataTransfer.setData("text/plain", node.code);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => { setDragging(null); setDragOver(null); }}
                onDragOver={
                  // Any node can receive a drop — a leaf target gets
                  // promoted into a parent (handleMove gates on amount).
                  dragging && dragging !== node.code
                    ? (e) => { e.preventDefault(); setDragOver(node.code); }
                    : undefined
                }
                onDragLeave={() => { if (dragOver === node.code) setDragOver(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const src = e.dataTransfer.getData("text/plain");
                  setDragOver(null);
                  setDragging(null);
                  handleMove(src, node.code);
                }}
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
                  {/* Fixed column width — letter codes (900-D003 vs 900-I001)
                      vary in width under a proportional font, so without it
                      the account names never line up. */}
                  <span className="text-[#6B7280] tabular-nums text-xs min-w-[4.25rem] shrink-0">{node.code}</span>
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
                    <span className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[#9CA3AF]">
                      {kids.length} sub-accounts
                      <button
                        onClick={() => handleRenameCode(node)}
                        className="normal-case tracking-normal text-[#6B7280] hover:text-[#6B5C32] underline decoration-dotted cursor-pointer"
                        title="Change account code (history follows)"
                      >
                        code
                      </button>
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
                              onClick={() => handleRenameCode(node)}
                              className="text-[#6B7280] hover:text-[#6B5C32] px-1 text-[11px] underline decoration-dotted cursor-pointer"
                              title="Change account code (history follows)"
                            >
                              code
                            </button>
                            <button
                              onClick={() => { setEditCode(node.code); setEditName(node.name); }}
                              className="text-[#6B7280] hover:text-[#6B5C32] p-1 cursor-pointer"
                              title="Edit name"
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

  // Phase 3 (owner): recurring JVs — copy any entry into a fresh DRAFT
  // dated today, same lines; edit then post.
  const handleDuplicate = async (row: JournalEntry) => {
    const res = await fetch("/api/accounting/journals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        description: row.description,
        lines: row.lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName,
          debitSen: l.debitSen,
          creditSen: l.creditSen,
          description: l.description,
        })),
      }),
    });
    if (!res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await res.json().catch(() => ({}));
      alert(humanizeError({ status: res.status, message: body?.error }, "Couldn't duplicate the journal entry."));
      return;
    }
    onRefresh();
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
    items.push({ label: "Duplicate as draft (template)", action: (r) => handleDuplicate(r) });
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
  // debitStr/creditStr keep the raw text being typed so the controlled
  // inputs never reformat mid-entry (owner bug 2026-06-12).
  type JournalLineRow = JournalLine & { _uid: string; debitStr?: string; creditStr?: string };
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
                        value={line.debitStr ?? (line.debitSen ? (line.debitSen / 100).toFixed(2) : "")}
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
                        value={line.creditStr ?? (line.creditSen ? (line.creditSen / 100).toFixed(2) : "")}
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
                    <td className="px-3 py-1.5 tabular-nums text-xs">{n.noteNumber}</td>
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


// Phase 5.1/5.2 — manufacturing-account P&L statement (owner workbook
// format): Overall / Sofa / Bedframe, L1–L4 expand, columns
// ITEM | FY YTD | YTD % | <period> | %  (% = of net sales).
type PnlStmtRow = {
  kind: "group" | "line" | "total" | "grandtotal" | "gap";
  depth: number;
  label: string;
  periodSen?: number;
  ytdSen?: number;
  groupId?: string;
  totalLabel?: string;
  badge?: string;
  accountCode?: string;
  bucket?: string;
};

// Phase 5.6 — Cost Structure: a FY, per material group, months as rows,
// each group a block of O/P · Purchase · C/L · Spend; leading SALES column
// and a Spend % of sales. Line filter by group prefix (B.* Bedframe,
// S.* Sofa); shared groups (no prefix) appear under Overall only.
type CsGroup = { group: string; description: string; months: { opening: number; purchase: number; closing: number; spend: number }[] };

function CostStructureTab() {
  const yrNow = new Date().getUTCFullYear();
  const [fy, setFy] = useState(yrNow);
  const [line, setLine] = useState<"all" | "sofa" | "bedframe">("all");
  const [data, setData] = useState<{ fyLabel: string; cols: string[]; groups: CsGroup[]; salesSofa: number[]; salesBed: number[]; salesAll: number[] } | null>(null);
  const loading = data === null;
  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/cost-structure?fy=${fy}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof data> }>)
      .then((j) => { if (!stale && j?.success && j.data) setData(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [fy]);

  // Amounts shown WITHOUT the RM prefix (the section title carries "(RM)")
  // and slightly larger, so the table reads without scrolling far right.
  const n = (v: number) => (v === 0 ? "-" : (v / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const groupsFor = (pred: (g: CsGroup) => boolean) => (data?.groups ?? []).filter(pred);
  const bedGroups = groupsFor((g) => g.group.startsWith("B."));
  const sofaGroups = groupsFor((g) => g.group.startsWith("S."));
  const sharedGroups = groupsFor((g) => !g.group.startsWith("B.") && !g.group.startsWith("S."));

  // One Cost-Structure table for a set of groups + that line's sales.
  const renderCsTable = (title: string, grps: CsGroup[], salesArr: number[]) => {
    if (!data || grps.length === 0) return null;
    return (
      <Card key={title}>
        <CardContent className="p-0 overflow-x-auto">
          <div className="px-3 py-2 bg-[#6B5C32] text-white text-sm font-semibold">{title} · {data.fyLabel} · all amounts RM</div>
          <table className="text-[13px] whitespace-nowrap">
            <thead>
              <tr className="border-b border-[#E2DDD8] text-[11px] text-[#6B7280]">
                <th className="px-2 py-1.5 text-left sticky left-0 bg-white">MONTH</th>
                <th className="px-2 py-1.5 text-right">SALES</th>
                {grps.map((g) => (
                  <th key={g.group} colSpan={4} className="px-2 py-1.5 text-center border-l border-[#E2DDD8]">{g.description}</th>
                ))}
                <th className="px-2 py-1.5 text-right border-l border-[#E2DDD8]">SPEND % SALES</th>
              </tr>
              <tr className="border-b border-[#E2DDD8] text-[10px] text-[#9CA3AF]">
                <th className="sticky left-0 bg-white" /><th />
                {grps.map((g) => (
                  <React.Fragment key={g.group}>
                    <th className="px-1.5 py-1 text-right border-l border-[#E2DDD8]">O/P</th>
                    <th className="px-1.5 py-1 text-right">PUR</th>
                    <th className="px-1.5 py-1 text-right">C/L</th>
                    <th className="px-1.5 py-1 text-right">SPEND</th>
                  </React.Fragment>
                ))}
                <th className="border-l border-[#E2DDD8]" />
              </tr>
            </thead>
            <tbody>
              {data.cols.map((m, i) => {
                const monthSpend = grps.reduce((s, g) => s + g.months[i].spend, 0);
                const s = salesArr[i] || 0;
                const pctTxt = s > 0 ? `${((monthSpend / s) * 100).toFixed(1)}%` : "-";
                return (
                  <tr key={m} className="border-b border-[#F0ECE9]">
                    <td className="px-2 py-1 text-left sticky left-0 bg-white">{m}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{n(s)}</td>
                    {grps.map((g) => (
                      <React.Fragment key={g.group}>
                        <td className="px-1.5 py-1 text-right tabular-nums border-l border-[#F0ECE9]">{n(g.months[i].opening)}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{n(g.months[i].purchase)}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums">{n(g.months[i].closing)}</td>
                        <td className="px-1.5 py-1 text-right tabular-nums font-medium">{n(g.months[i].spend)}</td>
                      </React.Fragment>
                    ))}
                    <td className="px-2 py-1 text-right tabular-nums text-[#9A3A2D] border-l border-[#F0ECE9]">{pctTxt}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    );
  };

  // Export covers whatever sections are visible for the current line.
  const exportGroups = line === "sofa" ? sofaGroups : line === "bedframe" ? bedGroups : data?.groups ?? [];
  const exportSales = data ? (line === "sofa" ? data.salesSofa : line === "bedframe" ? data.salesBed : data.salesAll) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {([["all", "Overall"], ["sofa", "Sofa"], ["bedframe", "Bedframe"]] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setLine(k)} className={`rounded-md border px-3 py-1.5 text-sm cursor-pointer ${line === k ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>{lbl}</button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {data && (
            <ExportButtons
              build={() => {
                const head = ["MONTH", "SALES", ...exportGroups.flatMap((g) => [`${g.description} O/P`, "PUR", "C/L", "SPEND"]), "SPEND % SALES"];
                const body: Aoa = data.cols.map((m, i) => {
                  const monthSpend = exportGroups.reduce((s, g) => s + g.months[i].spend, 0);
                  const s = exportSales[i] || 0;
                  return [m, (s / 100).toFixed(2), ...exportGroups.flatMap((g) => [(g.months[i].opening / 100).toFixed(2), (g.months[i].purchase / 100).toFixed(2), (g.months[i].closing / 100).toFixed(2), (g.months[i].spend / 100).toFixed(2)]), s > 0 ? `${((monthSpend / s) * 100).toFixed(1)}%` : "-"];
                });
                return [head, ...body];
              }}
              filenameBase={`CostStructure-${line}-FY${fy}`}
              title={`Cost Structure (${line})`}
              subtitle={data.fyLabel}
            />
          )}
          <select value={fy} onChange={(e) => setFy(parseInt(e.target.value, 10))} className="rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-sm">
            {[yrNow, yrNow - 1, yrNow - 2].map((y) => <option key={y} value={y}>FY {y}</option>)}
          </select>
        </div>
      </div>
      {loading ? (
        <Card><CardContent className="py-12 text-center text-[#6B7280] text-sm">Loading…</CardContent></Card>
      ) : line === "sofa" ? (
        renderCsTable("SOFA COST STRUCTURE", sofaGroups, data!.salesSofa)
      ) : line === "bedframe" ? (
        renderCsTable("BEDFRAME COST STRUCTURE", bedGroups, data!.salesBed)
      ) : (
        // Overall — stacked: Bedframe on top, Sofa below, then shared.
        <>
          {renderCsTable("BEDFRAME COST STRUCTURE", bedGroups, data!.salesBed)}
          {renderCsTable("SOFA COST STRUCTURE", sofaGroups, data!.salesSofa)}
          {renderCsTable("SHARED / COMMON MATERIALS", sharedGroups, data!.salesAll)}
        </>
      )}
      <p className="text-[11px] text-[#9CA3AF]">O/P = opening stock, PUR = purchases, C/L = closing stock, SPEND = consumed (O/P + PUR − C/L). % = month spend ÷ that line's sales. Shared materials (no B./S. prefix) shown as their own section under Overall.</p>
    </div>
  );
}

// Phase 5.9 — Cost & Expense classes: a FY's COST and EXPENSE accounts
// laid out months-as-columns + TOTAL, grouped by pnl_category
// (Fixed/Variable/Others). Independent report; does not affect the P&L.
type CeRow = { account: string; name: string; months: number[]; total: number };
type CeSection = Record<string, CeRow[]>;

function CostExpenseClassesTab() {
  const yrNow = new Date().getUTCFullYear();
  const [fy, setFy] = useState<number>(yrNow);
  const [data, setData] = useState<{ fyLabel: string; cols: string[]; cost: CeSection; expense: CeSection } | null>(null);
  const loading = data === null;
  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/cost-expense-classes?fy=${fy}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof data> }>)
      .then((j) => { if (!stale && j?.success && j.data) setData(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [fy]);

  const numTd = (v: number, key: string) => (
    <td key={key} className="px-2 py-0.5 text-right tabular-nums whitespace-nowrap">{v === 0 ? "-" : v < 0 ? `(${formatCurrency(Math.abs(v))})` : formatCurrency(v)}</td>
  );

  const renderSection = (title: string, section: CeSection) => {
    const cols = data!.cols;
    const classOrder = ["FIXED", "VARIABLE", "OTHERS"];
    const sectionMonths = new Array(cols.length).fill(0);
    let sectionTotal = 0;
    for (const k of classOrder) for (const r of section[k] ?? []) { r.months.forEach((m, i) => sectionMonths[i] += m); sectionTotal += r.total; }
    return (
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <div className="px-3 py-2 bg-[#6B5C32] text-white text-sm font-semibold">{title}</div>
          <table className="text-[12px] whitespace-nowrap">
            <thead>
              <tr className="border-b border-[#E2DDD8] text-[11px] text-[#6B7280]">
                <th className="px-3 py-2 text-left sticky left-0 bg-white">CLASS / ACCOUNT</th>
                {cols.map((m) => <th key={m} className="px-2 py-2 text-right">{m.slice(2)}</th>)}
                <th className="px-2 py-2 text-right font-semibold">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {classOrder.map((cls) => {
                const rows = section[cls] ?? [];
                if (rows.length === 0) return null;
                const clsMonths = new Array(cols.length).fill(0);
                let clsTotal = 0;
                for (const r of rows) { r.months.forEach((m, i) => clsMonths[i] += m); clsTotal += r.total; }
                return (
                  <React.Fragment key={cls}>
                    <tr className="bg-[#F0ECE9]/60 font-semibold text-[#1F1D1B]">
                      <td className="px-3 py-1 text-left sticky left-0 bg-[#F7F4EF]">{cls}{cls === "OTHERS" ? " (unclassified — tag in COA)" : ""}</td>
                      {clsMonths.map((m, i) => numTd(m, `c${i}`))}
                      {numTd(clsTotal, "ct")}
                    </tr>
                    {rows.map((r) => (
                      <tr key={r.account} className="border-b border-[#F0ECE9]">
                        <td className="px-3 py-0.5 text-left pl-6 sticky left-0 bg-white"><span className="tabular-nums text-[#9CA3AF] mr-1">{r.account}</span>{r.name}</td>
                        {r.months.map((m, i) => numTd(m, `${r.account}-${i}`))}
                        {numTd(r.total, `${r.account}-t`)}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
              <tr className="bg-[#1F1D1B] text-white font-bold">
                <td className="px-3 py-1.5 text-left sticky left-0 bg-[#1F1D1B]">TOTAL {title}</td>
                {sectionMonths.map((m, i) => <td key={i} className="px-2 py-1.5 text-right tabular-nums">{m === 0 ? "-" : formatCurrency(m)}</td>)}
                <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(sectionTotal)}</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Cost &amp; Expense Classes</h2>
        {data && (
          <div className="ml-auto flex items-center gap-2">
            <ExportButtons
              build={() => {
                const aoa: Aoa = [["CLASS / ACCOUNT", ...data.cols.map((m) => m.slice(2)), "TOTAL"]];
                const section = (title: string, sec: CeSection) => {
                  aoa.push([title]);
                  for (const cls of ["FIXED", "VARIABLE", "OTHERS"]) {
                    const rws = sec[cls] ?? [];
                    if (!rws.length) continue;
                    aoa.push([cls, ...data.cols.map((_, i) => (rws.reduce((s, r) => s + r.months[i], 0) / 100).toFixed(2)), (rws.reduce((s, r) => s + r.total, 0) / 100).toFixed(2)]);
                    for (const r of rws) aoa.push([`  ${r.account} ${r.name}`, ...r.months.map((m) => (m / 100).toFixed(2)), (r.total / 100).toFixed(2)]);
                  }
                };
                section("COST OF PRODUCTION", data.cost);
                section("OPERATING EXPENSES", data.expense);
                return aoa;
              }}
              filenameBase={`CostExpenseClasses-FY${fy}`}
              title="Cost & Expense Classes"
              subtitle={data.fyLabel}
            />
            <select value={fy} onChange={(e) => setFy(parseInt(e.target.value, 10))} className="rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-sm">
              {[yrNow, yrNow - 1, yrNow - 2].map((y) => <option key={y} value={y}>FY {y}</option>)}
            </select>
          </div>
        )}
        {!data && (
          <select value={fy} onChange={(e) => setFy(parseInt(e.target.value, 10))} className="ml-auto rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-sm">
            {[yrNow, yrNow - 1, yrNow - 2].map((y) => <option key={y} value={y}>FY {y}</option>)}
          </select>
        )}
      </div>
      {loading ? (
        <Card><CardContent className="py-12 text-center text-[#6B7280] text-sm">Loading…</CardContent></Card>
      ) : (
        <>
          <p className="text-xs text-[#6B7280]">{data!.fyLabel} · Fixed / Variable / Others is driven by each account's P&amp;L Category (set on the Chart of Accounts) and only affects this report.</p>
          {renderSection("COST OF PRODUCTION — BY CLASS", data!.cost)}
          {renderSection("OPERATING EXPENSES — BY CLASS", data!.expense)}
        </>
      )}
    </div>
  );
}

// Phase 5.8 — Monthly Trend: months as columns (newest left), P&L lines as
// rows, with the % of net sales under each amount; negatives in red.
function MonthlyTrendTab() {
  const [line, setLine] = useState<"all" | "sofa" | "bedframe">("all");
  const [months, setMonths] = useState(6);
  const [data, setData] = useState<{ cols: { ym: string; netSalesSen: number; cogsSen: number; grossProfitSen: number; otherIncomeSen: number; expenseSen: number; netProfitSen: number }[] } | null>(null);
  const loading = data === null;
  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/pl-trend?line=${line}&months=${months}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof data> }>)
      .then((j) => { if (!stale && j?.success && j.data) setData(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [line, months]);

  const cols = data?.cols ?? [];
  const rowDefs: { key: "netSalesSen" | "cogsSen" | "grossProfitSen" | "otherIncomeSen" | "expenseSen" | "netProfitSen"; label: string; strong?: boolean }[] = [
    { key: "netSalesSen", label: "NET SALES", strong: true },
    { key: "cogsSen", label: "COST OF GOODS SOLD" },
    { key: "grossProfitSen", label: "GROSS PROFIT", strong: true },
    { key: "otherIncomeSen", label: "OTHER INCOME" },
    { key: "expenseSen", label: "OPERATING EXPENSES" },
    { key: "netProfitSen", label: "NET PROFIT / (LOSS)", strong: true },
  ];
  const cell = (key: string, v: number, ns: number) => {
    const pctTxt = ns > 0 ? `${((v / ns) * 100).toFixed(1)}%` : "";
    const neg = v < 0;
    return (
      <td key={key} className="px-2 py-1 text-right whitespace-nowrap">
        <div className={`tabular-nums ${neg ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>{neg ? `(${formatCurrency(Math.abs(v))})` : formatCurrency(v)}</div>
        <div className="text-[10px] text-[#9CA3AF] tabular-nums">{pctTxt}</div>
      </td>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {([["all", "Overall"], ["sofa", "Sofa"], ["bedframe", "Bedframe"]] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setLine(k)} className={`rounded-md border px-3 py-1.5 text-sm cursor-pointer ${line === k ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>{lbl}</button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {[6, 9, 12].map((n) => (
            <button key={n} onClick={() => setMonths(n)} className={`rounded-md border px-3 py-1.5 text-sm cursor-pointer ${months === n ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>{n} mo</button>
          ))}
          {!loading && cols.length > 0 && (
            <ExportButtons
              build={() => [["ITEM", ...cols.map((c2) => c2.ym)], ...rowDefs.map((rd) => [rd.label, ...cols.map((c2) => (c2[rd.key] / 100).toFixed(2))])]}
              filenameBase={`MonthlyTrend-${line}`}
              title={`Monthly Trend (${line})`}
              subtitle={`${months} months`}
            />
          )}
        </div>
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : (
            <table className="text-[12.5px] whitespace-nowrap">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left sticky left-0 bg-white">ITEM</th>
                  {cols.map((c2) => <th key={c2.ym} className="px-2 py-2 text-right">{c2.ym}</th>)}
                </tr>
              </thead>
              <tbody>
                {rowDefs.map((rd) => (
                  <tr key={rd.key} className={`border-b border-[#F0ECE9] ${rd.strong ? "font-semibold bg-[#F0ECE9]/30" : ""}`}>
                    <td className="px-3 py-1 text-left sticky left-0 bg-white">{rd.label}</td>
                    {cols.map((c2) => cell(c2.ym, c2[rd.key], c2.netSalesSen))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <p className="text-[11px] text-[#9CA3AF]">Newest month at left · the small number under each amount is % of that month's net sales · negatives in red.</p>
    </div>
  );
}

// Shared CSV / Excel / PDF export buttons for the finance reports. The tab
// supplies a builder that returns the table as an array-of-arrays (header
// row + body) plus a filename base + title.
function ExportButtons({ build, filenameBase, title, subtitle }: { build: () => Aoa; filenameBase: string; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => exportReportCsv(`${filenameBase}.csv`, build())} className="rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1.5 text-xs text-[#4B5563] hover:bg-[#F0ECE9] cursor-pointer">CSV</button>
      <button onClick={() => exportReportXlsx(`${filenameBase}.xlsx`, title.slice(0, 28), build())} className="rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1.5 text-xs text-[#4B5563] hover:bg-[#F0ECE9] cursor-pointer">Excel</button>
      <button onClick={() => exportReportPdf(`${filenameBase}.pdf`, title, subtitle, build())} className="rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1.5 text-xs text-[#4B5563] hover:bg-[#F0ECE9] cursor-pointer">PDF</button>
    </div>
  );
}

function PLStatementTab() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [line, setLine] = useState<"all" | "sofa" | "bedframe">("all");
  const [level, setLevel] = useState(4);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [data, setData] = useState<{ rows: PnlStmtRow[]; netSalesSen: number; fyLabel: string; periodLabel: string } | null>(null);
  const loading = data === null;
  const { toast } = useToast();
  const [edit, setEdit] = useState(false);
  const [pmap, setPmap] = useState<Record<string, string>>({});
  const [dragCode, setDragCode] = useState<string | null>(null);
  const [dragClass, setDragClass] = useState<"income" | "cost" | null>(null);
  const [dragOverBucket, setDragOverBucket] = useState<string | null>(null);
  const classOfBucket = (b?: string) => (b === "REVENUE" || b === "OTHER_INCOME" ? "income" : "cost");

  const collapseForLevel = (stmtRows: PnlStmtRow[], L: number) => {
    const next = new Set<string>();
    for (const r of stmtRows) if (r.kind === "group" && r.groupId && r.depth >= L - 1) next.add(r.groupId);
    return next;
  };

  const load = () => {
    fetch(`/api/accounting/pl-statement?period=${period}&line=${line}${edit ? "&editable=1" : ""}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof data> }>)
      .then((j) => { if (!j?.success || !j.data) return; setData(j.data); setCollapsed(collapseForLevel(j.data.rows, level)); })
      .catch(() => {});
  };
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => { load(); }, [period, line, edit]);
  useEffect(() => { if (edit) fetch("/api/accounting/pnl/section-map").then((r) => r.json() as Promise<{ data?: { map?: Record<string, string> } }>).then((j) => setPmap(j?.data?.map ?? {})).catch(() => {}); }, [edit]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const moveTo = async (code: string, bucket: string) => {
    const prev = pmap;
    const next = { ...pmap, [code]: bucket };
    setPmap(next);
    try {
      const res = await fetch("/api/accounting/pnl/section-map", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ map: next }) });
      const j = (await res.json()) as { success?: boolean };
      if (j?.success) { toast.success("P&L mapping updated"); load(); } else { setPmap(prev); toast.error("Save failed"); }
    } catch { setPmap(prev); toast.error("Save failed"); }
  };

  // L-level button: collapse every group whose depth >= L-1.
  const applyLevel = (stmtRows: PnlStmtRow[], L: number) => {
    setCollapsed(collapseForLevel(stmtRows, L));
    setLevel(L);
  };

  const rows = data?.rows ?? [];
  const net = data?.netSalesSen || 0;
  const pct = (v: number | undefined) => (net > 0 && v !== undefined ? `${((v / net) * 100).toFixed(1)}%` : "");

  // Walk rows honouring collapsed groups: when a group is collapsed, skip
  // its descendants and render the group row WITH its total; when open,
  // render the group header (no amount) + children + a TOTAL line.
  const visible: { row: PnlStmtRow; showGroupTotal?: boolean }[] = [];
  let skipDepth: number | null = null;
  for (const r of rows) {
    if (skipDepth !== null) {
      if (r.depth > skipDepth) continue;
      skipDepth = null;
    }
    visible.push({ row: r });
    if (r.kind === "group" && r.groupId && collapsed.has(r.groupId)) skipDepth = r.depth;
  }

  const numCell = (v: number | undefined) =>
    v === undefined ? "" : v < 0 ? `(${formatCurrency(Math.abs(v))})` : formatCurrency(v);

  // Export: every row (indented by depth), with both money columns.
  const buildExport = (): Aoa => {
    const aoa: Aoa = [["ITEM", "FY YTD (RM)", "YTD %", `${data?.periodLabel ?? period} (RM)`, "%"]];
    for (const r of rows) {
      if (r.kind === "gap") { aoa.push(["", "", "", "", ""]); continue; }
      const indent = "  ".repeat(r.depth) + (r.kind === "group" ? "› " : "");
      aoa.push([
        indent + r.label,
        r.ytdSen === undefined ? "" : (r.ytdSen / 100).toFixed(2),
        pct(r.ytdSen),
        r.periodSen === undefined ? "" : (r.periodSen / 100).toFixed(2),
        pct(r.periodSen),
      ]);
    }
    return aoa;
  };

  const lineTabs: { k: "all" | "sofa" | "bedframe"; label: string }[] = [
    { k: "all", label: "Overall" },
    { k: "sofa", label: "Sofa P&L" },
    { k: "bedframe", label: "Bedframe P&L" },
  ];

  // Phase 5.5 — grouped period selector: Monthly + Accumulated (quarters,
  // half-years, full year). Values are the period strings the /pl-statement
  // endpoint already understands (YYYY-MM, YYYY-Qn, YYYY).
  const months: string[] = [];
  {
    const now = new Date();
    for (let i = 0; i < 18; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
  }
  const yrNow = new Date().getUTCFullYear();
  const years = [yrNow, yrNow - 1];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {lineTabs.map((t) => (
          <button key={t.k} onClick={() => setLine(t.k)} className={`rounded-md border px-3 py-1.5 text-sm cursor-pointer ${line === t.k ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>{t.label}</button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-sm">
            <optgroup label="Monthly">
              {months.map((m) => <option key={m} value={m}>{m}</option>)}
            </optgroup>
            <optgroup label="Quarter">
              {years.flatMap((yr) => [1, 2, 3, 4].map((q) => <option key={`${yr}-Q${q}`} value={`${yr}-Q${q}`}>Q{q} {yr}</option>))}
            </optgroup>
            <optgroup label="Full year">
              {years.map((yr) => <option key={`${yr}`} value={`${yr}`}>Full Year {yr}</option>)}
            </optgroup>
          </select>
          <button onClick={() => { const ne = !edit; setEdit(ne); if (ne) { setLevel(4); setCollapsed(new Set()); } }}
            className={`rounded-md border px-3 py-1.5 text-sm cursor-pointer ${edit ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>
            {edit ? "Done" : "Edit"}
          </button>
          {[1, 2, 3, 4].map((L) => (
            <button key={L} onClick={() => applyLevel(rows, L)} className={`rounded-md border px-3 py-1.5 text-sm cursor-pointer ${level === L ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>L{L}</button>
          ))}
          {!loading && rows.length > 0 && (
            <ExportButtons build={buildExport} filenameBase={`PL-${line}-${period}`} title={`P&L ${line === "all" ? "Overall" : line === "sofa" ? "Sofa" : "Bedframe"}`} subtitle={`Period: ${data?.periodLabel ?? period} · ${data?.fyLabel ?? ""}`} />
          )}
        </div>
      </div>
      {edit && <p className="text-[11px] text-[#6B5C32]">Drag an account row onto a target group to reclassify it (within the same side: Revenue ↔ Other Income; Labour / Manufacturing / Operating Expenses / Payroll are interchangeable) · all months recompute under the new rule · Net Profit unchanged · drag back to undo</p>}

      <Card>
        <CardContent className="p-4">
          <div className="text-center mb-3">
            <div className="font-semibold text-[15px] text-[#1F1D1B]">HOOKKA MANUFACTURING SDN BHD</div>
            <div className="text-[13px] text-[#6B7280] mt-0.5">{line === "all" ? "Manufacturing & Profit-and-Loss Account (Overall)" : line === "sofa" ? "Profit-and-Loss Account — SOFA" : "Profit-and-Loss Account — BEDFRAME"}</div>
            <div className="text-[12px] text-[#9CA3AF] mt-0.5">Period: {data?.periodLabel ?? period} · {data?.fyLabel ?? ""} · % = of net sales</div>
          </div>
          {loading ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[12px] text-[#6B7280]">
                  <td />
                  <td className="text-right px-2 pb-1">FY YTD (RM)</td>
                  <td className="text-right px-2 pb-1 w-14">YTD %</td>
                  <td className="text-right px-2 pb-1">{data?.periodLabel ?? period} (RM)</td>
                  <td className="text-right px-2 pb-1 w-14">%</td>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ row }, i) => {
                  if (row.kind === "gap") return <tr key={i}><td colSpan={5} className="py-1.5" /></tr>;
                  const isOpen = row.kind === "group" && row.groupId ? !collapsed.has(row.groupId) : false;
                  const pad = { paddingLeft: `${8 + row.depth * 18}px` };
                  if (row.kind === "grandtotal") {
                    return (
                      <tr key={i} className="border-t-2 border-[#1F1D1B] font-bold text-[#1F1D1B]">
                        <td className="py-2" style={pad}>{row.label}</td>
                        <td className="text-right px-2 tabular-nums">{numCell(row.ytdSen)}</td>
                        <td className="text-right px-2 text-[#6B7280]">{pct(row.ytdSen)}</td>
                        <td className="text-right px-2 tabular-nums">{numCell(row.periodSen)}</td>
                        <td className="text-right px-2 text-[#6B7280]">{pct(row.periodSen)}</td>
                      </tr>
                    );
                  }
                  if (row.kind === "total") {
                    return (
                      <tr key={i} className="border-t border-[#9CA3AF] font-semibold bg-[#F0ECE9]/40">
                        <td className="py-1" style={pad}>{row.label}</td>
                        <td className="text-right px-2 tabular-nums">{numCell(row.ytdSen)}</td>
                        <td className="text-right px-2 text-[#6B7280]">{pct(row.ytdSen)}</td>
                        <td className="text-right px-2 tabular-nums">{numCell(row.periodSen)}</td>
                        <td className="text-right px-2 text-[#6B7280]">{pct(row.periodSen)}</td>
                      </tr>
                    );
                  }
                  if (row.kind === "group") {
                    const dropOk = edit && !!row.bucket && dragClass !== null && classOfBucket(row.bucket) === dragClass;
                    return (
                      <tr key={i} className={`font-semibold text-[#1F1D1B] bg-[#F0ECE9]/40 ${!edit ? "cursor-pointer hover:bg-[#F7F4EF]" : ""} ${dropOk && dragOverBucket === row.bucket ? "ring-2 ring-inset ring-[#6B5C32]" : ""}`}
                        onClick={!edit ? () => { const n = new Set(collapsed); if (n.has(row.groupId!)) n.delete(row.groupId!); else n.add(row.groupId!); setCollapsed(n); } : undefined}
                        onDragOver={dropOk ? (e) => { e.preventDefault(); setDragOverBucket(row.bucket!); } : undefined}
                        onDragLeave={dropOk ? () => { if (dragOverBucket === row.bucket) setDragOverBucket(null); } : undefined}
                        onDrop={dropOk ? (e) => { e.preventDefault(); const src = e.dataTransfer.getData("text/plain"); setDragOverBucket(null); setDragCode(null); setDragClass(null); if (src && row.bucket) void moveTo(src, row.bucket); } : undefined}>
                        <td className="py-1" style={pad}>{!edit ? (isOpen ? "▾" : "▸") : "•"} {row.label}</td>
                        <td className="text-right px-2 tabular-nums">{numCell(row.ytdSen)}</td>
                        <td className="text-right px-2 text-[#6B7280]">{pct(row.ytdSen)}</td>
                        <td className="text-right px-2 tabular-nums">{numCell(row.periodSen)}</td>
                        <td className="text-right px-2 text-[#6B7280]">{pct(row.periodSen)}</td>
                      </tr>
                    );
                  }
                  const draggable = edit && !!row.accountCode;
                  return (
                    <tr key={i} className={`hover:bg-[#F7F4EF] ${draggable ? "cursor-move" : ""} ${dragCode === row.accountCode ? "opacity-40" : ""}`}
                      draggable={draggable}
                      onDragStart={draggable ? (e) => { setDragCode(row.accountCode!); setDragClass(classOfBucket(row.bucket)); e.dataTransfer.setData("text/plain", row.accountCode!); e.dataTransfer.effectAllowed = "move"; } : undefined}
                      onDragEnd={draggable ? () => { setDragCode(null); setDragClass(null); setDragOverBucket(null); } : undefined}>
                      <td className="py-0.5 text-[#4B5563]" style={pad}>{draggable ? "⠿ " : ""}{row.label}{row.badge ? <span className="ml-1 text-[10px] text-[#9CA3AF]">[{row.badge}]</span> : null}</td>
                      <td className="text-right px-2 tabular-nums">{numCell(row.ytdSen)}</td>
                      <td className="text-right px-2 text-[#6B7280]">{pct(row.ytdSen)}</td>
                      <td className="text-right px-2 tabular-nums">{numCell(row.periodSen)}</td>
                      <td className="text-right px-2 text-[#6B7280]">{pct(row.periodSen)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="text-[11px] text-[#9CA3AF] mt-3">
            Stock (raw material / WIP / FG) is live from the cost ledger; labour, overhead, carriage, SST, revenue and
            expenses from the GL. Sofa = Sofa + Accessory. For Sofa/Bedframe, directly-attributable material &amp; labour
            follow the production order; shared/indirect costs are apportioned by the net-sales ratio.
          </p>
        </CardContent>
      </Card>
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
  tin: string;
  registrationNo: string;
  address: string;
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
    tin: "",
    registrationNo: "",
    address: "",
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
      setForm({ type: "CREDITOR", name: "", contactPerson: "", phone: "", email: "", tin: "", registrationNo: "", address: "", notes: "" });
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
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">TIN</label>
              <input type="text" value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} placeholder="e.g. C12345678900 / IG…" className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Registration No (SSM)</label>
              <input type="text" value={form.registrationNo} onChange={(e) => setForm({ ...form, registrationNo: e.target.value })} placeholder="e.g. 202301012345" className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
            </div>
            <div className="sm:col-span-3">
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Address</label>
              <textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} rows={2} placeholder="Full address for statements / e-Invoice" className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
            </div>
            <div className="sm:col-span-2">
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
                  <th className="px-4 py-2 text-left">TIN / Reg No</th>
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
                    <td className="px-4 py-1.5 text-[#1F1D1B] font-medium">{p.name}{p.address ? <span className="block text-[11px] font-normal text-[#9CA3AF]">{p.address}</span> : null}</td>
                    <td className="px-4 py-1.5 text-[#6B7280] text-xs tabular-nums">{[p.tin, p.registrationNo].filter(Boolean).join(" / ")}</td>
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
                      <span className="tabular-nums text-xs text-[#6B7280] mr-2">{r.accountCode}</span>
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
  const [all, setAll] = useState<{
    rows: GlAllRow[];
    totalRows: number;
    capped: boolean;
    accountTotals?: { accountCode: string; accountName: string; debitSen: number; creditSen: number }[];
  } | null>(null);
  const [gl, setGl] = useState<{
    account: { code: string; name: string; type: string };
    openingSen: number;
    closingSen: number;
    totalDebitSen?: number;
    totalCreditSen?: number;
    rows: GlRow[];
  } | null>(null);
  // AutoCount-style ledger scope (owner): sales = SDC debtor controls
  // (300-x trade + 305-0000 Other Debtor), purchase = SCC creditor
  // controls (400-0000 + 405-0000 Other Creditors), general = everything
  // that is neither.
  const [ledger, setLedger] = useState<"all" | "general" | "sales" | "purchase">("all");
  // Owner (2026-06-12, AutoCount Ledger screenshot): the default view
  // groups the listing PER ACCOUNT — B/F opening, rows with running
  // balance and the double-entry counter account, per-account DR/CR
  // totals + closing, grand totals at the bottom.
  const [view, setView] = useState<"grouped" | "flat">("grouped");
  const [report, setReport] = useState<{
    capped: boolean;
    grandDr: number;
    grandCr: number;
    accounts: {
      code: string; name: string; openingSen: number;
      totalDr: number; totalCr: number; closingSen: number;
      rows: { id: string; day: string; description: string; sourceType: string; sourceId: string; deDesc: string; debitSen: number; creditSen: number; runningSen: number }[];
    }[];
  } | null>(null);
  const [collapsedAccts, setCollapsedAccts] = useState<Record<string, boolean>>({});
  const account = picked.length === 1 ? picked[0] : "";
  const loading = account ? gl === null : view === "grouped" ? report === null : all === null;
  const nameOf = (code: string) => accounts.find((a) => a.code === code)?.name ?? "";
  const inLedgerScope = (a: ChartOfAccount): boolean => {
    switch (ledger) {
      case "sales":
        return a.specialAccountType === "SDC";
      case "purchase":
        return a.specialAccountType === "SCC";
      case "general":
        return a.specialAccountType !== "SDC" && a.specialAccountType !== "SCC";
      default:
        return true;
    }
  };

  useEffect(() => {
    let stale = false;
    const params = new URLSearchParams();
    if (picked.length > 1) params.set("accounts", picked.join(","));
    if (ledger !== "all") params.set("ledger", ledger);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (picked.length === 1) {
      params.set("account", picked[0]);
      fetch(`/api/accounting/gl?${params.toString()}`)
        .then((r) => r.json() as Promise<{ success?: boolean; data?: unknown }>)
        .then((j) => { if (!stale && j?.success && j.data) setGl(j.data as NonNullable<typeof gl>); })
        .catch(() => {});
    } else if (view === "grouped") {
      fetch(`/api/accounting/gl-report?${params.toString()}`)
        .then((r) => r.json() as Promise<{ success?: boolean; data?: unknown }>)
        .then((j) => { if (!stale && j?.success && j.data) setReport(j.data as NonNullable<typeof report>); })
        .catch(() => {});
    } else {
      fetch(`/api/accounting/gl?${params.toString()}`)
        .then((r) => r.json() as Promise<{ success?: boolean; data?: unknown }>)
        .then((j) => { if (!stale && j?.success && j.data) setAll(j.data as NonNullable<typeof all>); })
        .catch(() => {});
    }
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked.join(","), ledger, from, to, view]);

  const reset = () => {
    setAll(null);
    setGl(null);
    setReport(null);
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
            <div>
              <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">Ledger</label>
              <select
                value={ledger}
                onChange={(e) => {
                  setLedger(e.target.value as typeof ledger);
                  // Scope change clears the picked set — keeping accounts
                  // outside the new scope would just intersect to nothing.
                  setPicked([]);
                  reset();
                }}
                className="rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm"
              >
                <option value="all">All Ledgers</option>
                <option value="general">General Ledger</option>
                <option value="sales">Sales Ledger (Debtors)</option>
                <option value="purchase">Purchase Ledger (Creditors)</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">View</label>
              <select
                value={view}
                onChange={(e) => { setView(e.target.value as typeof view); reset(); }}
                className="rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm"
              >
                <option value="grouped">By Account (AutoCount style)</option>
                <option value="flat">Flat listing</option>
              </select>
            </div>
            <div className="w-80">
              <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">
                Account filter <span className="font-normal text-[#6B7280]">(type keyword, pick one or MORE)</span>
              </label>
              <AccountPicker
                accounts={accounts.filter((a) => !picked.includes(a.code) && inLedgerScope(a))}
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
            {(picked.length > 0 || ledger !== "all" || from || to) && (
              <Button variant="outline" size="sm" onClick={() => { setPicked([]); setLedger("all"); setFrom(""); setTo(""); reset(); }}>
                Clear all
              </Button>
            )}
          </div>
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {picked.map((code) => (
                <span key={code} className="inline-flex items-center gap-1.5 rounded-full border border-[#6B5C32] bg-white px-3 py-1 text-xs font-medium text-[#6B5C32]">
                  <span className="tabular-nums">{code}</span> {nameOf(code)}
                  <button onClick={() => removeAccount(code)} className="ml-1 text-[#9A3A2D] hover:text-[#791F1F] cursor-pointer" title="Remove">✕</button>
                </span>
              ))}
            </div>
          )}
          <p className="text-[11px] text-[#9CA3AF]">
            Ledger scope first (AutoCount-style: Sales = debtor controls, Purchase = creditor controls, General = the rest) · no account picked = whole scope · pick ONE for running balances · pick SEVERAL to review together
          </p>
        </CardContent>
      </Card>

      {account && gl && (
        <p className="text-sm text-[#6B7280]">
          <span className="tabular-nums text-xs mr-1">{gl.account.code}</span>
          <span className="font-medium text-[#1F1D1B]">{gl.account.name}</span>
          {" · "}Opening {formatCurrency(gl.openingSen)} · Closing {formatCurrency(gl.closingSen)} ({gl.account.type})
        </p>
      )}
      {!account && view === "flat" && all && (
        <p className="text-sm text-[#6B7280]">
          {all.totalRows} entries{picked.length > 1 ? ` across ${picked.length} accounts` : ""}{all.capped ? ` — showing latest ${all.rows.length}, narrow the date range to see older ones` : ""}
        </p>
      )}

      {/* AutoCount-style grouped Ledger (owner screenshot): one section per
          account — B/F, rows with running balance + counter account,
          per-account totals + closing, grand totals at the bottom. */}
      {!account && view === "grouped" && (
        loading ? (
          <Card><CardContent className="py-12 text-center text-[#6B7280] text-sm">Loading ledger…</CardContent></Card>
        ) : report ? (
          <div className="space-y-3">
            {report.capped && (
              <p className="text-xs text-[#9A3A2D]">Report capped at 4,000 rows — narrow the date range to see every account.</p>
            )}
            {report.accounts.map((a) => {
              const open = !collapsedAccts[a.code];
              return (
                <Card key={a.code}>
                  <CardContent className="p-0 overflow-x-auto">
                    <button
                      onClick={() => setCollapsedAccts({ ...collapsedAccts, [a.code]: open })}
                      className="w-full flex items-center justify-between px-3 py-2 bg-[#F0ECE9]/60 text-left cursor-pointer"
                    >
                      <span className="text-sm font-semibold text-[#1F1D1B]">
                        {open ? "▾" : "▸"} Acc. No.: <span className="tabular-nums">{a.code}</span> {a.name}
                      </span>
                      <span className="text-xs text-[#6B7280] tabular-nums">
                        DR = {formatCurrency(a.totalDr)} · CR = {formatCurrency(a.totalCr)} · Balance = <span className={a.closingSen < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}>{formatCurrency(a.closingSen)}</span>
                      </span>
                    </button>
                    {open && (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                            <th className="px-3 py-1.5 text-left">Date</th>
                            <th className="px-3 py-1.5 text-left">Description</th>
                            <th className="px-3 py-1.5 text-left">DE Account</th>
                            <th className="px-3 py-1.5 text-left">Source</th>
                            <th className="px-3 py-1.5 text-right">Debit</th>
                            <th className="px-3 py-1.5 text-right">Credit</th>
                            <th className="px-3 py-1.5 text-right">Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b border-[#F0ECE9] text-[#6B7280]">
                            <td className="px-3 py-1" colSpan={6}>BALANCE B/F</td>
                            <td className={`px-3 py-1 text-right tabular-nums ${a.openingSen < 0 ? "text-[#9A3A2D]" : ""}`}>{formatCurrency(a.openingSen)}</td>
                          </tr>
                          {a.rows.map((r) => {
                            const href = sourceHref(r.sourceType, r.sourceId);
                            return (
                              <tr key={r.id} className="border-b border-[#F0ECE9]">
                                <td className="px-3 py-1 text-xs text-[#6B7280] whitespace-nowrap">{r.day}</td>
                                <td className="px-3 py-1 text-[#1F1D1B]">{r.description}</td>
                                <td className="px-3 py-1 text-xs text-[#6B7280]">{r.deDesc}</td>
                                <td className="px-3 py-1 text-xs">
                                  {href ? (
                                    <a href={href} className="text-[#6B5C32] underline decoration-dotted hover:text-[#1F1D1B]" title={r.sourceId}>{r.sourceType}</a>
                                  ) : (
                                    <span className="text-[#6B7280]" title={r.sourceId}>{r.sourceType}</span>
                                  )}
                                </td>
                                <td className="px-3 py-1 text-right tabular-nums">{r.debitSen ? formatCurrency(r.debitSen) : ""}</td>
                                <td className="px-3 py-1 text-right tabular-nums">{r.creditSen ? formatCurrency(r.creditSen) : ""}</td>
                                <td className={`px-3 py-1 text-right tabular-nums ${r.runningSen < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>{formatCurrency(r.runningSen)}</td>
                              </tr>
                            );
                          })}
                          <tr className="bg-[#F0ECE9]/60 font-semibold text-[#1F1D1B]">
                            <td className="px-3 py-1.5" colSpan={4} />
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(a.totalDr)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(a.totalCr)}</td>
                            <td className={`px-3 py-1.5 text-right tabular-nums ${a.closingSen < 0 ? "text-[#9A3A2D]" : ""} bg-[#EAF3DE]`}>{formatCurrency(a.closingSen)}</td>
                          </tr>
                        </tbody>
                      </table>
                    )}
                  </CardContent>
                </Card>
              );
            })}
            <Card>
              <CardContent className="px-3 py-2 flex justify-end gap-8 text-sm font-semibold text-[#1F1D1B] tabular-nums">
                <span>TOTAL DR {formatCurrency(report.grandDr)}</span>
                <span>TOTAL CR {formatCurrency(report.grandCr)}</span>
                <span className={report.grandDr - report.grandCr !== 0 ? "text-[#9A3A2D]" : "text-[#27500A]"}>
                  {report.grandDr - report.grandCr === 0 ? "Balanced ✓" : `Diff ${formatCurrency(report.grandDr - report.grandCr)}`}
                </span>
              </CardContent>
            </Card>
            {report.accounts.length === 0 && (
              <Card><CardContent className="py-12 text-center text-[#9CA3AF] text-sm">No activity in this window</CardContent></Card>
            )}
          </div>
        ) : null
      )}

      {/* Owner: per-account total DR / CR for the filtered window — summed
          server-side over EVERY matching leg, so it stays right even when
          the listing below is capped at 1000 rows. */}
      {!account && view === "flat" && all && (all.accountTotals?.length ?? 0) > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">Account totals{from || to ? " (filtered period)" : ""}</th>
                  <th className="px-3 py-2 text-right">Total Debit</th>
                  <th className="px-3 py-2 text-right">Total Credit</th>
                  <th className="px-3 py-2 text-right">Net (DR−CR)</th>
                </tr>
              </thead>
              <tbody>
                {all.accountTotals!.map((t) => (
                  <tr key={t.accountCode} className="border-b border-[#F0ECE9]">
                    <td className="px-3 py-1.5">
                      <button
                        onClick={() => { setPicked([t.accountCode]); reset(); }}
                        className="text-left cursor-pointer hover:underline"
                        title="Open this account's running-balance inquiry"
                      >
                        <span className="tabular-nums text-xs text-[#6B7280] mr-1">{t.accountCode}</span>
                        <span className="text-[#1F1D1B]">{t.accountName}</span>
                      </button>
                    </td>
                    <td className="px-3 py-1.5 text-right">{t.debitSen ? formatCurrency(t.debitSen) : "-"}</td>
                    <td className="px-3 py-1.5 text-right">{t.creditSen ? formatCurrency(t.creditSen) : "-"}</td>
                    <td className={`px-3 py-1.5 text-right font-medium ${t.debitSen - t.creditSen < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                      {formatCurrency(t.debitSen - t.creditSen)}
                    </td>
                  </tr>
                ))}
                <tr className="bg-[#F0ECE9]/60 font-semibold text-[#1F1D1B]">
                  <td className="px-3 py-2">TOTAL</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(all.accountTotals!.reduce((s, t) => s + t.debitSen, 0))}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(all.accountTotals!.reduce((s, t) => s + t.creditSen, 0))}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(all.accountTotals!.reduce((s, t) => s + t.debitSen - t.creditSen, 0))}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {(account || view === "flat") && (
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
                {/* Owner: window totals — total DR / total CR within the
                    picked date range, with the closing balance alongside. */}
                <tr className="bg-[#F0ECE9]/60 font-semibold text-[#1F1D1B]">
                  <td className="px-3 py-2" colSpan={3}>TOTAL{from || to ? " (filtered period)" : ""}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(gl.totalDebitSen ?? 0)}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(gl.totalCreditSen ?? 0)}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(gl.closingSen)}</td>
                </tr>
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
                          <span className="tabular-nums text-xs text-[#6B7280] mr-1">{r.accountCode}</span>
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
      )}
    </div>
  );
}

// =============== TAB: PAYMENT / EXPENSE (Phase 3.2) ===============
//
// PV pays an expense: DR lines, CR bank/cash (SBK/SCH). 「先挂账」 credits
// an accrual account (410-x / 405-0000) instead and clears it on Settle.
// Optional SOFA/BEDFRAME tag overrides the split-P&L allocation later.

type PvRow = {
  id: string; pvNo: string; date: string; payee: string | null;
  description: string | null; payFrom: string | null; accrued: number;
  accrualAccount: string | null; settledAt: string | null;
  productLine: string | null; totalSen: number; status: string;
  lines: { accountCode: string; description: string | null; amountSen: number }[];
};

function PaymentsTab({ accounts }: { accounts: ChartOfAccount[] }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<PvRow[] | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    payee: "",
    description: "",
    accrued: false,
    payFrom: "",
    accrualAccount: "",
    productLine: "",
  });
  const [lines, setLines] = useState<{ accountCode: string; description: string; amount: string }[]>([
    { accountCode: "", description: "", amount: "" },
  ]);

  const bankCash = accounts.filter(
    (a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH",
  );
  const accrualOpts = accounts.filter(
    (a) =>
      a.type === "LIABILITY" &&
      a.isPostable !== false &&
      (a.code.startsWith("410") || a.code.startsWith("405")),
  );
  const lineAccounts = accounts.filter(
    (a) =>
      a.isPostable !== false &&
      a.specialAccountType !== "SDC" &&
      a.specialAccountType !== "SBK" &&
      a.specialAccountType !== "SCH",
  );

  const load = useCallback(() => {
    fetch("/api/accounting/payment-vouchers")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: PvRow[]; migrationMissing?: boolean }>)
      .then((j) => {
        if (j?.success) {
          setRows(j.data ?? []);
          setMigrationMissing(!!j.migrationMissing);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const toSen = (s: string) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? Math.round(v * 100) : 0;
  };
  const totalSen = lines.reduce((s, l) => s + toSen(l.amount), 0);

  const handleSave = async () => {
    const body = {
      date: form.date,
      payee: form.payee,
      description: form.description,
      accrued: form.accrued,
      payFrom: form.accrued ? undefined : form.payFrom,
      accrualAccount: form.accrued ? form.accrualAccount : undefined,
      productLine: form.productLine || undefined,
      lines: lines
        .filter((l) => l.accountCode && toSen(l.amount) > 0)
        .map((l) => ({ accountCode: l.accountCode, description: l.description, amountSen: toSen(l.amount) })),
    };
    if (body.lines.length === 0) {
      toast.error("Add at least one line with an account and a positive amount");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/accounting/payment-vouchers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = asMutationResponse(await res.json());
      if (j?.success) {
        toast.success("Payment posted");
        setShowForm(false);
        setForm({ date: new Date().toISOString().slice(0, 10), payee: "", description: "", accrued: false, payFrom: "", accrualAccount: "", productLine: "" });
        setLines([{ accountCode: "", description: "", amount: "" }]);
        load();
      } else toast.error(j?.error || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleSettle = async (row: PvRow) => {
    const payFrom = window.prompt(
      `Settle ${row.pvNo} (${formatCurrency(row.totalSen)}) — pay from which account?\n\n${bankCash.map((a) => `${a.code}  ${a.name}`).join("\n")}\n\nEnter account code:`,
      bankCash[0]?.code ?? "",
    );
    if (!payFrom) return;
    const res = await fetch(`/api/accounting/payment-vouchers/${row.id}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payFrom: payFrom.trim() }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) { toast.success(`${row.pvNo} settled`); load(); }
    else toast.error(j?.error || "Settle failed");
  };

  const handleVoid = async (row: PvRow) => {
    if (!window.confirm(`Void ${row.pvNo}? A reversal entry will be posted (nothing is deleted).`)) return;
    const res = await fetch(`/api/accounting/payment-vouchers/${row.id}/void`, { method: "POST" });
    const j = asMutationResponse(await res.json());
    if (j?.success) { toast.success(`${row.pvNo} voided`); load(); }
    else toast.error(j?.error || "Void failed");
  };

  const selCls = "rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm";

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Payment / Expense</h2>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4" /> New Payment
        </Button>
      </div>
      {migrationMissing && (
        <Card><CardContent className="p-4 text-sm text-[#9A3A2D]">Migration 0159 not applied yet — run the paste-version SQL first.</CardContent></Card>
      )}

      {showForm && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
                <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={selCls} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Payee</label>
                <input type="text" placeholder="Who was paid" value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} className={`${selCls} w-48`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Description</label>
                <input type="text" placeholder="e.g. Factory rent June" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${selCls} w-64`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Product line (optional)</label>
                <select value={form.productLine} onChange={(e) => setForm({ ...form, productLine: e.target.value })} className={selCls}>
                  <option value="">(shared — allocate by sales ratio)</option>
                  <option value="SOFA">Sofa</option>
                  <option value="BEDFRAME">Bedframe</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex items-center gap-2 text-sm text-[#1F1D1B] cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={form.accrued}
                  onChange={(e) => setForm({ ...form, accrued: e.target.checked })}
                  className="h-4 w-4 accent-[#6B5C32]"
                />
                Accrue now, pay later
              </label>
              {form.accrued ? (
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Accrual account (CR)</label>
                  <select value={form.accrualAccount} onChange={(e) => setForm({ ...form, accrualAccount: e.target.value })} className={`${selCls} w-72`}>
                    <option value="">— pick 410-x / 405-0000 —</option>
                    {accrualOpts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">Pay From (CR bank/cash)</label>
                  <select value={form.payFrom} onChange={(e) => setForm({ ...form, payFrom: e.target.value })} className={`${selCls} w-72`}>
                    <option value="">— pick bank/cash —</option>
                    {bankCash.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-[#6B7280] block">Expense lines (DR)</label>
              {lines.map((l, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <div className="w-80">
                    <AccountPicker
                      accounts={lineAccounts}
                      value={l.accountCode}
                      onChange={(code) => setLines(lines.map((x, j) => (j === i ? { ...x, accountCode: code } : x)))}
                      placeholder="Account…"
                    />
                  </div>
                  <input type="text" placeholder="Line description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} className={`${selCls} w-56`} />
                  <input type="text" placeholder="Amount (RM)" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className={`${selCls} w-32 text-right tabular-nums`} />
                  {lines.length > 1 && (
                    <button onClick={() => setLines(lines.filter((_, j) => j !== i))} className="text-[#9A3A2D] text-xs underline decoration-dotted cursor-pointer">remove</button>
                  )}
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setLines([...lines, { accountCode: "", description: "", amount: "" }])}>
                <Plus className="h-4 w-4" /> Line
              </Button>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-[#6B7280]">Total <span className="font-semibold text-[#1F1D1B] tabular-nums">{formatCurrency(totalSen)}</span></span>
              <Button variant="primary" size="sm" disabled={saving || totalSen <= 0 || (form.accrued ? !form.accrualAccount : !form.payFrom)} onClick={handleSave}>
                {saving ? "Posting…" : form.accrued ? "Post (accrued)" : "Post payment"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {rows === null ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">PV No</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Payee / Description</th>
                  <th className="px-3 py-2 text-left">Paid From / Accrual</th>
                  <th className="px-3 py-2 text-left">Line</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-[#F0ECE9] ${r.status === "VOID" ? "opacity-50" : ""}`}>
                    <td className="px-3 py-1.5 tabular-nums text-xs">{r.pvNo}</td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{r.date}</td>
                    <td className="px-3 py-1.5">{[r.payee, r.description].filter(Boolean).join(" · ")}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {r.accrued === 1 && !r.settledAt
                        ? <span className="text-[#9A3A2D]">accrued → {r.accrualAccount}</span>
                        : (r.payFrom ?? "")}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280]">{r.productLine ?? "shared"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.totalSen)}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {r.status === "VOID" ? "VOID" : r.accrued === 1 && !r.settledAt ? "UNPAID (accrued)" : "PAID"}
                    </td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      {r.status === "POSTED" && r.accrued === 1 && !r.settledAt && (
                        <button onClick={() => handleSettle(r)} className="text-[#6B5C32] hover:text-[#1F1D1B] text-xs underline decoration-dotted cursor-pointer mr-3">settle</button>
                      )}
                      {r.status === "POSTED" && (
                        <button onClick={() => handleVoid(r)} className="text-[#9A3A2D] hover:text-[#791F1F] text-xs underline decoration-dotted cursor-pointer">void</button>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-[#9CA3AF]">No payments yet</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB: OFFICIAL RECEIPT (Phase 3.3) ===============
//
// Money in that is NOT a trade-invoice payment: DR bank/cash, CR each
// line (sundry income / other-debtor recovery via 305-0000).

type OrRow = {
  id: string; orNo: string; date: string; receivedFrom: string | null;
  description: string | null; payTo: string; totalSen: number; status: string;
  lines: { accountCode: string; description: string | null; amountSen: number }[];
};

function ReceiptsTab({ accounts }: { accounts: ChartOfAccount[] }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<OrRow[] | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    receivedFrom: "",
    description: "",
    payTo: "",
  });
  const [lines, setLines] = useState<{ accountCode: string; description: string; amount: string }[]>([
    { accountCode: "", description: "", amount: "" },
  ]);

  const bankCash = accounts.filter(
    (a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH",
  );
  const lineAccounts = accounts.filter(
    (a) =>
      a.isPostable !== false &&
      a.specialAccountType !== "SDC" &&
      a.specialAccountType !== "SBK" &&
      a.specialAccountType !== "SCH",
  );

  const load = useCallback(() => {
    fetch("/api/accounting/official-receipts")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: OrRow[]; migrationMissing?: boolean }>)
      .then((j) => {
        if (j?.success) {
          setRows(j.data ?? []);
          setMigrationMissing(!!j.migrationMissing);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const toSen = (s: string) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? Math.round(v * 100) : 0;
  };
  const totalSen = lines.reduce((s, l) => s + toSen(l.amount), 0);

  const handleSave = async () => {
    const body = {
      date: form.date,
      receivedFrom: form.receivedFrom,
      description: form.description,
      payTo: form.payTo,
      lines: lines
        .filter((l) => l.accountCode && toSen(l.amount) > 0)
        .map((l) => ({ accountCode: l.accountCode, description: l.description, amountSen: toSen(l.amount) })),
    };
    if (body.lines.length === 0) {
      toast.error("Add at least one line with an account and a positive amount");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/accounting/official-receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = asMutationResponse(await res.json());
      if (j?.success) {
        toast.success("Receipt posted");
        setShowForm(false);
        setForm({ date: new Date().toISOString().slice(0, 10), receivedFrom: "", description: "", payTo: "" });
        setLines([{ accountCode: "", description: "", amount: "" }]);
        load();
      } else toast.error(j?.error || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleVoid = async (row: OrRow) => {
    if (!window.confirm(`Void ${row.orNo}? A reversal entry will be posted (nothing is deleted).`)) return;
    const res = await fetch(`/api/accounting/official-receipts/${row.id}/void`, { method: "POST" });
    const j = asMutationResponse(await res.json());
    if (j?.success) { toast.success(`${row.orNo} voided`); load(); }
    else toast.error(j?.error || "Void failed");
  };

  const selCls = "rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm";

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Official Receipt</h2>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4" /> New Receipt
        </Button>
      </div>
      {migrationMissing && (
        <Card><CardContent className="p-4 text-sm text-[#9A3A2D]">Migration 0159 not applied yet — run the paste-version SQL first.</CardContent></Card>
      )}

      {showForm && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
                <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={selCls} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Received from</label>
                <input type="text" placeholder="Who paid us" value={form.receivedFrom} onChange={(e) => setForm({ ...form, receivedFrom: e.target.value })} className={`${selCls} w-48`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Description</label>
                <input type="text" placeholder="e.g. Scrap sale" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${selCls} w-64`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Deposit To (DR bank/cash)</label>
                <select value={form.payTo} onChange={(e) => setForm({ ...form, payTo: e.target.value })} className={`${selCls} w-72`}>
                  <option value="">— pick bank/cash —</option>
                  {bankCash.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-[#6B7280] block">Receipt lines (CR — income account or 305-0000 recovery)</label>
              {lines.map((l, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <div className="w-80">
                    <AccountPicker
                      accounts={lineAccounts}
                      value={l.accountCode}
                      onChange={(code) => setLines(lines.map((x, j) => (j === i ? { ...x, accountCode: code } : x)))}
                      placeholder="Account…"
                    />
                  </div>
                  <input type="text" placeholder="Line description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} className={`${selCls} w-56`} />
                  <input type="text" placeholder="Amount (RM)" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className={`${selCls} w-32 text-right tabular-nums`} />
                  {lines.length > 1 && (
                    <button onClick={() => setLines(lines.filter((_, j) => j !== i))} className="text-[#9A3A2D] text-xs underline decoration-dotted cursor-pointer">remove</button>
                  )}
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setLines([...lines, { accountCode: "", description: "", amount: "" }])}>
                <Plus className="h-4 w-4" /> Line
              </Button>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-[#6B7280]">Total <span className="font-semibold text-[#1F1D1B] tabular-nums">{formatCurrency(totalSen)}</span></span>
              <Button variant="primary" size="sm" disabled={saving || totalSen <= 0 || !form.payTo} onClick={handleSave}>
                {saving ? "Posting…" : "Post receipt"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {rows === null ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">OR No</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">From / Description</th>
                  <th className="px-3 py-2 text-left">Deposit To</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-[#F0ECE9] ${r.status === "VOID" ? "opacity-50" : ""}`}>
                    <td className="px-3 py-1.5 tabular-nums text-xs">{r.orNo}</td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{r.date}</td>
                    <td className="px-3 py-1.5">{[r.receivedFrom, r.description].filter(Boolean).join(" · ")}</td>
                    <td className="px-3 py-1.5 text-xs">{r.payTo}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.totalSen)}</td>
                    <td className="px-3 py-1.5 text-xs">{r.status}</td>
                    <td className="px-3 py-1.5 text-right">
                      {r.status === "POSTED" && (
                        <button onClick={() => handleVoid(r)} className="text-[#9A3A2D] hover:text-[#791F1F] text-xs underline decoration-dotted cursor-pointer">void</button>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-[#9CA3AF]">No receipts yet</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB: STOCK SUMMARY (Phase 4.2) ===============
//
// Per material-group, for the chosen month: opening + purchases −
// consumption = closing (a real cross-check — closing is recomputed from
// the cost ledger, not opening±deltas). WIP and FG roll up too. This is
// the read layer the Phase-5 Cost Structure report and the closing-stock
// posting build on.

function StockSummaryTab() {
  const { toast } = useToast();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [reloadKey, setReloadKey] = useState(0);
  const [posting, setPosting] = useState(false);
  const [data, setData] = useState<{
    rows: { group: string; description: string; openingSen: number; purchasesSen: number; consumptionSen: number; closingSen: number; balanced: boolean; accounts: { stock: string; opening: string; closing: string } }[];
    wip: { openingSen: number; closingSen: number };
    fg: { openingSen: number; closingSen: number };
    totals: { openingSen: number; purchasesSen: number; consumptionSen: number; closingSen: number };
    posted: boolean;
  } | null>(null);

  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/stock-summary?period=${month}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof data> }>)
      .then((j) => { if (!stale && j?.success && j.data) setData(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [month, reloadKey]);

  const [byLine, setByLine] = useState<{
    sofa: { materialSen: number; labourSen: number };
    bedframe: { materialSen: number; labourSen: number };
    unallocated: { materialSen: number; labourSen: number };
    totalMaterialSen: number;
    totalLabourSen: number;
    salesByLine: { sofa: number; bedframe: number };
    salesRatio: { sofa: number; bedframe: number };
  } | null>(null);

  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/cost-by-line?period=${month}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof byLine> }>)
      .then((j) => { if (!stale && j?.success && j.data) setByLine(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [month, reloadKey]);

  const anyUnbalanced = (data?.rows ?? []).some((r) => !r.balanced);

  const handlePost = async () => {
    if (!window.confirm(`Post closing stock for ${month}? This takes the period's stock onto the balance-sheet stock accounts (DR 330-x · CR closing-stock) and brings down opening; re-posting/next month re-bases automatically.`)) return;
    setPosting(true);
    try {
      const res = await fetch("/api/accounting/stock/close-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const j = await res.json() as { success?: boolean; data?: { closingTotalSen: number }; error?: string };
      if (j?.success && j.data) {
        toast.success(`Closing stock ${month} posted — ${formatCurrency(j.data.closingTotalSen)} on the balance sheet`);
        setReloadKey((k) => k + 1);
      } else toast.error(j?.error || "Post failed");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[#1F1D1B]">Stock Summary</h2>
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-4 bg-[#F7F4EF] rounded-lg">
          <div>
            <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">Month</label>
            <input type="month" value={month} onChange={(e) => { setData(null); setMonth(e.target.value); }} className="rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm" />
          </div>
          {data && (
            <>
              <Button variant="primary" size="sm" disabled={posting || data.totals.closingSen === 0} onClick={handlePost}>
                {posting ? "Posting…" : data.posted ? "Re-post closing stock" : "Post closing stock to GL"}
              </Button>
              {data.posted && <span className="text-xs text-[#27500A] pb-2">Posted ✓ — on the balance sheet</span>}
            </>
          )}
          <p className="text-[11px] text-[#9CA3AF] pb-1">Opening + Purchases − Consumption = Closing, per material group, live from the cost ledger.</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {data === null ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">Material group</th>
                  <th className="px-3 py-2 text-right">Opening</th>
                  <th className="px-3 py-2 text-right">Purchases</th>
                  <th className="px-3 py-2 text-right">Consumption</th>
                  <th className="px-3 py-2 text-right">Closing</th>
                  <th className="px-3 py-2 text-center">✓</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.group} className="border-b border-[#F0ECE9]">
                    <td className="px-3 py-1.5"><span className="tabular-nums text-xs text-[#6B7280] mr-1">{r.accounts.stock}</span>{r.description}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.openingSen)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.purchasesSen)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.consumptionSen)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium">{formatCurrency(r.closingSen)}</td>
                    <td className="px-3 py-1.5 text-center">{r.balanced ? <span className="text-[#27500A]">✓</span> : <span className="text-[#9A3A2D]" title="opening+purchases−consumption ≠ closing">!</span>}</td>
                  </tr>
                ))}
                <tr className="border-b border-[#F0ECE9] text-[#6B7280]">
                  <td className="px-3 py-1.5">330-8000 WORK IN PROGRESS</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(data.wip.openingSen)}</td>
                  <td className="px-3 py-1.5 text-right" colSpan={2} />
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium">{formatCurrency(data.wip.closingSen)}</td>
                  <td className="px-3 py-1.5" />
                </tr>
                <tr className="border-b border-[#F0ECE9] text-[#6B7280]">
                  <td className="px-3 py-1.5">330-9000 FINISHED GOODS</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(data.fg.openingSen)}</td>
                  <td className="px-3 py-1.5 text-right" colSpan={2} />
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium">{formatCurrency(data.fg.closingSen)}</td>
                  <td className="px-3 py-1.5" />
                </tr>
                <tr className="bg-[#F0ECE9]/60 font-semibold">
                  <td className="px-3 py-2">RAW MATERIAL TOTAL</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totals.openingSen)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totals.purchasesSen)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totals.consumptionSen)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totals.closingSen)}</td>
                  <td className="px-3 py-2" />
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      {anyUnbalanced && (
        <p className="text-[11px] text-[#9A3A2D]">Some groups show "!" — opening + purchases − consumption ≠ closing. This usually means an ADJUSTMENT or non-receipt/issue movement in the period; check the cost ledger.</p>
      )}

      {/* Phase 4.5 — consumption + labour split by product line, following
          the RM_ISSUE / LABOR_POSTED → production-order category. */}
      {byLine && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">By product line (this month)</th>
                  <th className="px-3 py-2 text-right">Material consumed</th>
                  <th className="px-3 py-2 text-right">Labour</th>
                  <th className="px-3 py-2 text-right">Sales</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-[#F0ECE9]">
                  <td className="px-3 py-1.5">Sofa <span className="text-[11px] text-[#9CA3AF]">(incl. Accessory)</span></td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(byLine.sofa.materialSen)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(byLine.sofa.labourSen)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(byLine.salesByLine.sofa)}</td>
                </tr>
                <tr className="border-b border-[#F0ECE9]">
                  <td className="px-3 py-1.5">Bedframe</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(byLine.bedframe.materialSen)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(byLine.bedframe.labourSen)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(byLine.salesByLine.bedframe)}</td>
                </tr>
                {(byLine.unallocated.materialSen !== 0 || byLine.unallocated.labourSen !== 0) && (
                  <tr className="border-b border-[#F0ECE9] text-[#9A3A2D]">
                    <td className="px-3 py-1.5">Unallocated <span className="text-[11px]">(issue/labour with no PO category — fix the PO)</span></td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(byLine.unallocated.materialSen)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(byLine.unallocated.labourSen)}</td>
                    <td className="px-3 py-1.5 text-right" />
                  </tr>
                )}
                <tr className="bg-[#F0ECE9]/60 font-semibold">
                  <td className="px-3 py-2">TOTAL</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(byLine.totalMaterialSen)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(byLine.totalLabourSen)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(byLine.salesByLine.sofa + byLine.salesByLine.bedframe)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      <p className="text-[11px] text-[#9CA3AF]">
        Sofa material + Bedframe material + Unallocated = total consumption (the COGS material part). Shared/indirect
        costs (no-issue factory materials, SST, admin) are apportioned by the sales ratio shown, in the Phase-5 split P&L.
      </p>

      <WipDetailCard month={month} reloadKey={reloadKey} />
    </div>
  );
}

// Phase 4.3 — WIP per open production order: material + labour − completed.
function WipDetailCard({ month, reloadKey }: { month: string; reloadKey: number }) {
  const [wip, setWip] = useState<{ rows: { poId: string; poNumber: string; category: string; status: string; materialSen: number; labourSen: number; completedSen: number; wipSen: number }[]; totalSen: number } | null>(null);
  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/wip-detail?asOf=${month}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof wip> }>)
      .then((j) => { if (!stale && j?.success && j.data) setWip(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [month, reloadKey]);
  if (!wip || wip.rows.length === 0) return null;
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
              <th className="px-3 py-2 text-left">Work in progress — by production order (as of {month})</th>
              <th className="px-3 py-2 text-left">Line</th>
              <th className="px-3 py-2 text-right">Material</th>
              <th className="px-3 py-2 text-right">Labour</th>
              <th className="px-3 py-2 text-right">Completed</th>
              <th className="px-3 py-2 text-right">WIP value</th>
            </tr>
          </thead>
          <tbody>
            {wip.rows.slice(0, 200).map((w) => (
              <tr key={w.poId} className="border-b border-[#F0ECE9]">
                <td className="px-3 py-1.5 tabular-nums text-xs">{w.poNumber}{w.status ? <span className="text-[#9CA3AF]"> · {w.status}</span> : null}</td>
                <td className="px-3 py-1.5 text-xs text-[#6B7280]">{w.category || "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(w.materialSen)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(w.labourSen)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#9CA3AF]">{w.completedSen ? formatCurrency(w.completedSen) : "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium">{formatCurrency(w.wipSen)}</td>
              </tr>
            ))}
            <tr className="bg-[#F0ECE9]/60 font-semibold">
              <td className="px-3 py-2" colSpan={5}>TOTAL WIP{wip.rows.length > 200 ? ` (showing top 200 of ${wip.rows.length})` : ""}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(wip.totalSen)}</td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// =============== TAB: LABOUR MONTH-END POSTING (Phase 4.1) ===============
//
// Accrue the month's labour cost by department: per-worker employer cost
// (gross + employer EPF/SOCSO/EIS) grouped by department, each mapped to a
// COST/EXPENSE account. Preview → Post (DR accounts · CR 410-0010). The
// department→account map is editable inline.

function LaborTab({ accounts }: { accounts: ChartOfAccount[] }) {
  const { toast } = useToast();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<{
    posted: boolean;
    totalSen: number;
    accrualAccount: string;
    byDept: { departmentCode: string; account: string; accountName: string; workers: number; grossSen: number; employerSen: number; costSen: number }[];
    accounts: { code: string; name: string; costSen: number }[];
  } | null>(null);
  const [posting, setPosting] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [map, setMap] = useState<{ fallback: string; byDept: Record<string, string> }>({ fallback: "750-0010", byDept: {} });

  const costAccounts = accounts.filter(
    (a) => (a.type === "COST" || a.type === "EXPENSE") && a.isPostable !== false,
  );

  const load = useCallback(() => {
    fetch(`/api/accounting/labor/preview?month=${month}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof data>; error?: string }>)
      .then((j) => { if (j?.success && j.data) setData(j.data); })
      .catch(() => {});
  }, [month]);
  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/labor/preview?month=${month}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof data>; error?: string }>)
      .then((j) => { if (!stale && j?.success && j.data) setData(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [month]);
  useEffect(() => {
    fetch("/api/accounting/labor/map")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { fallback: string; byDept: Record<string, string> } }>)
      .then((j) => { if (j?.success && j.data) setMap(j.data); })
      .catch(() => {});
  }, []);

  const handlePost = async () => {
    setPosting(true);
    try {
      const res = await fetch("/api/accounting/labor/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const j = await res.json() as { success?: boolean; data?: { totalSen: number }; error?: string };
      if (j?.success && j.data) {
        toast.success(`Labour ${month} posted — ${formatCurrency(j.data.totalSen)}`);
        load();
      } else toast.error(j?.error || "Post failed");
    } finally {
      setPosting(false);
    }
  };

  const saveMap = async () => {
    const res = await fetch("/api/accounting/labor/map", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(map),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) { toast.success("Mapping saved"); setShowMap(false); load(); }
    else toast.error(j?.error || "Save failed");
  };

  const selCls = "rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm";

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Labour — Month-end Posting</h2>
        <Button variant="outline" size="sm" onClick={() => setShowMap(!showMap)}>Department → Account map</Button>
      </div>

      {showMap && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <p className="text-xs text-[#6B7280]">Each department's labour posts to the chosen account. Departments not listed use the fallback. Add a row by typing the department code exactly as it appears in the preview.</p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Fallback (all unlisted depts)</label>
                <select value={map.fallback} onChange={(e) => setMap({ ...map, fallback: e.target.value })} className={`${selCls} w-72`}>
                  {costAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
              </div>
            </div>
            {Object.entries(map.byDept).map(([dept, acct]) => (
              <div key={dept} className="flex flex-wrap items-end gap-2">
                <span className="text-sm tabular-nums w-44 pb-2">{dept}</span>
                <select value={acct} onChange={(e) => setMap({ ...map, byDept: { ...map.byDept, [dept]: e.target.value } })} className={`${selCls} w-72`}>
                  {costAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
                <button onClick={() => { const b = { ...map.byDept }; delete b[dept]; setMap({ ...map, byDept: b }); }} className="text-[#9A3A2D] text-xs underline decoration-dotted cursor-pointer pb-2">remove</button>
              </div>
            ))}
            <AddDeptMapRow onAdd={(dept) => setMap({ ...map, byDept: { ...map.byDept, [dept]: map.fallback } })} />
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={saveMap}>Save mapping</Button>
              <Button variant="outline" size="sm" onClick={() => setShowMap(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-4 bg-[#F7F4EF] rounded-lg">
          <div>
            <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">Month</label>
            <input type="month" value={month} onChange={(e) => { setData(null); setMonth(e.target.value); }} className={selCls} />
          </div>
          {data && (
            <>
              <span className="text-sm text-[#6B7280] pb-1">Total labour cost <span className="font-semibold text-[#1F1D1B] tabular-nums">{formatCurrency(data.totalSen)}</span></span>
              {data.posted ? (
                <span className="text-xs text-[#27500A] pb-2">Already posted ✓ (DR accounts · CR {data.accrualAccount})</span>
              ) : (
                <Button variant="primary" size="sm" disabled={posting || data.totalSen <= 0} onClick={handlePost}>
                  {posting ? "Posting…" : `Post ${formatCurrency(data.totalSen)} to GL`}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                    <th className="px-3 py-2 text-left">Department</th>
                    <th className="px-3 py-2 text-left">→ Account</th>
                    <th className="px-3 py-2 text-right">Workers</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byDept.map((d) => (
                    <tr key={d.departmentCode} className="border-b border-[#F0ECE9]">
                      <td className="px-3 py-1.5">{d.departmentCode}</td>
                      <td className="px-3 py-1.5 text-xs"><span className="tabular-nums text-[#6B7280] mr-1">{d.account}</span>{d.accountName}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{d.workers}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(d.costSen)}</td>
                    </tr>
                  ))}
                  {data.byDept.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-8 text-center text-sm text-[#9CA3AF]">No payslips for {month}</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                    <th className="px-3 py-2 text-left">GL posting preview</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => (
                    <tr key={a.code} className="border-b border-[#F0ECE9]">
                      <td className="px-3 py-1.5"><span className="tabular-nums text-xs text-[#6B7280] mr-1">{a.code}</span>{a.name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(a.costSen)}</td>
                      <td className="px-3 py-1.5 text-right" />
                    </tr>
                  ))}
                  <tr className="border-b border-[#F0ECE9]">
                    <td className="px-3 py-1.5"><span className="tabular-nums text-xs text-[#6B7280] mr-1">{data.accrualAccount}</span>ACCRUAL - SALARY</td>
                    <td className="px-3 py-1.5 text-right" />
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(data.totalSen)}</td>
                  </tr>
                  <tr className="bg-[#F0ECE9]/60 font-semibold">
                    <td className="px-3 py-2">TOTAL</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totalSen)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totalSen)}</td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}
      <p className="text-[11px] text-[#9CA3AF]">
        Cost basis = gross pay + employer EPF/SOCSO/EIS (the full company cost). Posting credits 410-0010 ACCRUAL - SALARY;
        when you later pay salaries via Payments, debit 410-0010 to clear it. Net pay vs statutory split is handled at payment time.
      </p>
    </div>
  );
}

function AddDeptMapRow({ onAdd }: { onAdd: (dept: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Department code (e.g. MAINTENANCE)"
        className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm w-72"
      />
      <Button variant="outline" size="sm" disabled={!v.trim()} onClick={() => { onAdd(v.trim()); setV(""); }}>
        <Plus className="h-4 w-4" /> Add dept
      </Button>
    </div>
  );
}

// =============== TAB: FIXED ASSETS + DEPRECIATION (Phase 3.5) ===============
//
// Owner-maintained register (asset / accum / expense accounts, cost,
// life in months). Monthly straight-line run: preview → check → Post
// (DR expense, CR accumulated; capped at remaining book value).

type FaRow = {
  id: string; name: string; assetAccount: string; accumAccount: string;
  expenseAccount: string; purchaseDate: string; costSen: number;
  residualSen: number; usefulLifeMonths: number; openingAccumSen: number;
  disposedAt: string | null; remarks: string | null;
  accumSen: number; lastMonth: string | null;
};

function FixedAssetsTab({ accounts }: { accounts: ChartOfAccount[] }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<FaRow[] | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "", assetAccount: "", accumAccount: "", expenseAccount: "",
    purchaseDate: "", cost: "", residual: "", lifeMonths: "", openingAccum: "",
  });
  const [runMonth, setRunMonth] = useState(new Date().toISOString().slice(0, 7));
  const [preview, setPreview] = useState<{ rows: { assetId: string; name: string; expenseAccount: string; accumAccount: string; amountSen: number }[]; totalSen: number } | null>(null);
  const [posting, setPosting] = useState(false);

  const ncaAccounts = accounts.filter((a) => a.type === "ASSET" && a.isPostable !== false);
  const expAccounts = accounts.filter((a) => (a.type === "EXPENSE" || a.type === "COST") && a.isPostable !== false);

  const load = useCallback(() => {
    fetch("/api/accounting/fixed-assets")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: FaRow[]; migrationMissing?: boolean }>)
      .then((j) => {
        if (j?.success) {
          setRows(j.data ?? []);
          setMigrationMissing(!!j.migrationMissing);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const toSen = (s: string) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? Math.round(v * 100) : 0;
  };

  const handleAdd = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/accounting/fixed-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          assetAccount: form.assetAccount,
          accumAccount: form.accumAccount,
          expenseAccount: form.expenseAccount,
          purchaseDate: form.purchaseDate,
          costSen: toSen(form.cost),
          residualSen: toSen(form.residual),
          usefulLifeMonths: parseInt(form.lifeMonths, 10) || 0,
          openingAccumSen: toSen(form.openingAccum),
        }),
      });
      const j = asMutationResponse(await res.json());
      if (j?.success) {
        toast.success("Asset added");
        setShowForm(false);
        setForm({ name: "", assetAccount: "", accumAccount: "", expenseAccount: "", purchaseDate: "", cost: "", residual: "", lifeMonths: "", openingAccum: "" });
        load();
      } else toast.error(j?.error || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDispose = async (row: FaRow) => {
    if (!window.confirm(`Dispose ${row.name}? Depreciation stops; the disposal gain/loss entry stays a manual JV for now.`)) return;
    const res = await fetch(`/api/accounting/fixed-assets/${row.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dispose: true }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) load();
    else toast.error(j?.error || "Dispose failed");
  };

  const handleDelete = async (row: FaRow) => {
    if (!window.confirm(`Delete ${row.name}? Only possible while it has no posted depreciation.`)) return;
    const res = await fetch(`/api/accounting/fixed-assets/${row.id}`, { method: "DELETE" });
    const j = asMutationResponse(await res.json());
    if (j?.success) load();
    else toast.error(j?.error || "Delete failed");
  };

  const handlePreview = async () => {
    setPreview(null);
    const res = await fetch(`/api/accounting/fixed-assets/depreciation-preview?month=${runMonth}`);
    const j = await res.json() as { success?: boolean; data?: NonNullable<typeof preview>; error?: string };
    if (j?.success && j.data) setPreview(j.data);
    else toast.error(j?.error || "Preview failed");
  };

  const handleRun = async () => {
    setPosting(true);
    try {
      const res = await fetch("/api/accounting/fixed-assets/depreciation-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: runMonth }),
      });
      const j = await res.json() as { success?: boolean; data?: { assets: number; totalSen: number }; error?: string };
      if (j?.success && j.data) {
        toast.success(`Depreciation ${runMonth} posted — ${j.data.assets} assets, ${formatCurrency(j.data.totalSen)}`);
        setPreview(null);
        load();
      } else toast.error(j?.error || "Run failed");
    } finally {
      setPosting(false);
    }
  };

  const selCls = "rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm";
  const nbv = (r: FaRow) => r.costSen - r.accumSen;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Fixed Assets · Depreciation</h2>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4" /> Add Asset
        </Button>
      </div>
      {migrationMissing && (
        <Card><CardContent className="p-4 text-sm text-[#9A3A2D]">Migration 0161 not applied yet — run the paste-version SQL first.</CardContent></Card>
      )}

      {showForm && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Asset name</label>
                <input type="text" placeholder="e.g. CNC Cutting Machine" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${selCls} w-64`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Purchase date</label>
                <input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} className={selCls} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Cost (RM)</label>
                <input type="text" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} className={`${selCls} w-28 text-right tabular-nums`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Residual (RM)</label>
                <input type="text" placeholder="0" value={form.residual} onChange={(e) => setForm({ ...form, residual: e.target.value })} className={`${selCls} w-24 text-right tabular-nums`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Life (months)</label>
                <input type="text" placeholder="e.g. 60" value={form.lifeMonths} onChange={(e) => setForm({ ...form, lifeMonths: e.target.value })} className={`${selCls} w-20 text-center`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Accum. depn b/f (RM)</label>
                <input type="text" placeholder="0" value={form.openingAccum} onChange={(e) => setForm({ ...form, openingAccum: e.target.value })} className={`${selCls} w-28 text-right tabular-nums`} title="Depreciation already taken before the opening date" />
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-72">
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Asset (cost) account</label>
                <AccountPicker accounts={ncaAccounts} value={form.assetAccount} onChange={(code) => setForm({ ...form, assetAccount: code })} placeholder="e.g. 200-1001…" />
              </div>
              <div className="w-72">
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Accumulated depn account</label>
                <AccountPicker accounts={ncaAccounts} value={form.accumAccount} onChange={(code) => setForm({ ...form, accumAccount: code })} placeholder="e.g. 200-1005…" />
              </div>
              <div className="w-72">
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Depreciation expense account</label>
                <AccountPicker accounts={expAccounts} value={form.expenseAccount} onChange={(code) => setForm({ ...form, expenseAccount: code })} placeholder="780-0080 / 780-0090 / 900-D001…" />
              </div>
              <Button variant="primary" size="sm" disabled={saving} onClick={handleAdd}>{saving ? "Saving…" : "Save asset"}</Button>
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Monthly run */}
      <Card>
        <CardContent className="p-4 space-y-3 bg-[#F7F4EF] rounded-lg">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">Depreciation month</label>
              <input type="month" value={runMonth} onChange={(e) => { setRunMonth(e.target.value); setPreview(null); }} className={selCls} />
            </div>
            <Button variant="outline" size="sm" onClick={handlePreview}>Preview</Button>
            {preview && preview.rows.length > 0 && (
              <Button variant="primary" size="sm" disabled={posting} onClick={handleRun}>
                {posting ? "Posting…" : `Post ${formatCurrency(preview.totalSen)} (${preview.rows.length} assets)`}
              </Button>
            )}
          </div>
          {preview && (
            preview.rows.length === 0 ? (
              <p className="text-sm text-[#6B7280]">Nothing to depreciate for {runMonth} — already run, disposed, or fully depreciated.</p>
            ) : (
              <table className="w-full text-sm bg-white rounded">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                    <th className="px-3 py-2 text-left">Asset</th>
                    <th className="px-3 py-2 text-left">DR expense</th>
                    <th className="px-3 py-2 text-left">CR accum.</th>
                    <th className="px-3 py-2 text-right">This month</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.assetId} className="border-b border-[#F0ECE9]">
                      <td className="px-3 py-1.5">{r.name}</td>
                      <td className="px-3 py-1.5 text-xs tabular-nums">{r.expenseAccount}</td>
                      <td className="px-3 py-1.5 text-xs tabular-nums">{r.accumAccount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.amountSen)}</td>
                    </tr>
                  ))}
                  <tr className="bg-[#F0ECE9]/60 font-semibold">
                    <td className="px-3 py-2" colSpan={3}>TOTAL</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(preview.totalSen)}</td>
                  </tr>
                </tbody>
              </table>
            )
          )}
        </CardContent>
      </Card>

      {/* Register */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {rows === null ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">Asset</th>
                  <th className="px-3 py-2 text-left">Accounts (cost / accum / expense)</th>
                  <th className="px-3 py-2 text-left">Purchased</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2 text-right">Accum. depn</th>
                  <th className="px-3 py-2 text-right">NBV</th>
                  <th className="px-3 py-2 text-left">Life</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-[#F0ECE9] ${r.disposedAt ? "opacity-50" : ""}`}>
                    <td className="px-3 py-1.5">{r.name}{r.disposedAt ? " (disposed)" : ""}</td>
                    <td className="px-3 py-1.5 text-xs tabular-nums text-[#6B7280]">{r.assetAccount} / {r.accumAccount} / {r.expenseAccount}</td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{r.purchaseDate}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.costSen)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.accumSen)}{r.lastMonth ? <span className="text-[11px] text-[#9CA3AF]"> (to {r.lastMonth})</span> : null}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium">{formatCurrency(nbv(r))}</td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280]">{r.usefulLifeMonths} mo</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      {!r.disposedAt && (
                        <button onClick={() => handleDispose(r)} className="text-[#6B7280] hover:text-[#9A3A2D] text-xs underline decoration-dotted cursor-pointer mr-3">dispose</button>
                      )}
                      <button onClick={() => handleDelete(r)} className="text-[#9CA3AF] hover:text-[#9A3A2D] text-xs underline decoration-dotted cursor-pointer">del</button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-[#9CA3AF]">No assets yet — add the register here (or hand me the list and I will seed it)</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB: CASH BOOK / BANK RECONCILIATION (Phase 3.4) ===============
//
// Pick a bank/cash account + month window → statement lines on the left,
// book legs on the right. CSV paste with column mapping; exact-amount
// matching (manual pick or unambiguous auto-match); whatever stays
// unmatched on either side IS the 未达账项 list.

type RecoLeg = { id: string; day: string; description: string; sourceType: string; sourceId: string; amountSen: number; matched: boolean };
type RecoLine = { id: string; txnDate: string; description: string | null; amountSen: number; matchedLegId: string | null; matchedAt: string | null };

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function CashBookTab({ accounts }: { accounts: ChartOfAccount[] }) {
  const { toast } = useToast();
  const bankCash = accounts.filter(
    (a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH",
  );
  const [account, setAccount] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<{ migrationMissing: boolean; legs: RecoLeg[]; statementLines: RecoLine[] } | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState("");
  const [map, setMap] = useState({ date: "1", desc: "2", out: "3", in: "4", header: true, fmt: "DD/MM/YYYY" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!account) return;
    const p = new URLSearchParams({ account });
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    fetch(`/api/accounting/bank-reco?${p.toString()}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { migrationMissing: boolean; legs: RecoLeg[]; statementLines: RecoLine[] } }>)
      .then((j) => { if (j?.success && j.data) setData(j.data); })
      .catch(() => {});
  }, [account, from, to]);
  useEffect(() => { load(); }, [load]);

  const parseDate = (s: string): string | null => {
    const v = s.trim();
    if (map.fmt === "YYYY-MM-DD") {
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    }
    const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!m) return null;
    const [, a, b, y] = m;
    const dd = map.fmt === "DD/MM/YYYY" ? a : b;
    const mm = map.fmt === "DD/MM/YYYY" ? b : a;
    return `${y}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  };
  const parseAmt = (s: string): number => {
    let v = s.replace(/[RM,\s]/gi, "").trim();
    let neg = false;
    if (/^\(.*\)$/.test(v)) { neg = true; v = v.slice(1, -1); }
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) * (neg ? -1 : 1);
  };

  const parsedRows = (() => {
    if (!csv.trim()) return [];
    const rawLines = csv.trim().split(/\r?\n/);
    const rows: { date: string; description: string; amountSen: number }[] = [];
    const di = parseInt(map.date, 10) - 1;
    const ci = parseInt(map.desc, 10) - 1;
    const oi = parseInt(map.out, 10) - 1;
    const ii = parseInt(map.in, 10) - 1;
    for (let i = map.header ? 1 : 0; i < rawLines.length; i++) {
      const cells = parseCsvLine(rawLines[i]);
      const date = parseDate(cells[di] ?? "");
      if (!date) continue;
      let amountSen = 0;
      if (oi === ii) {
        amountSen = parseAmt(cells[ii] ?? "");
      } else {
        const outAmt = Math.abs(parseAmt(cells[oi] ?? ""));
        const inAmt = Math.abs(parseAmt(cells[ii] ?? ""));
        amountSen = inAmt - outAmt;
      }
      if (amountSen === 0) continue;
      rows.push({ date, description: (cells[ci] ?? "").trim(), amountSen });
    }
    return rows;
  })();

  const handleImport = async () => {
    if (!account) { toast.error("Pick an account first"); return; }
    if (parsedRows.length === 0) { toast.error("No parsable rows — check the column mapping"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/accounting/bank-reco/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountCode: account, lines: parsedRows }),
      });
      const j = asMutationResponse(await res.json());
      if (j?.success) {
        toast.success(`${parsedRows.length} statement lines imported`);
        setCsv("");
        setShowImport(false);
        load();
      } else toast.error(j?.error || "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const handleAutoMatch = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/accounting/bank-reco/automatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountCode: account, from, to }),
      });
      const j = await res.json() as { success?: boolean; data?: { matched: number }; error?: string };
      if (j?.success) {
        toast.success(`${j.data?.matched ?? 0} lines auto-matched`);
        load();
      } else toast.error(j?.error || "Auto-match failed");
    } finally {
      setBusy(false);
    }
  };

  const handleMatch = async (lineId: string, legId: string) => {
    if (!legId) return;
    const res = await fetch("/api/accounting/bank-reco/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statementLineId: lineId, legId }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) load();
    else toast.error(j?.error || "Match failed");
  };

  const handleUnmatch = async (lineId: string) => {
    const res = await fetch("/api/accounting/bank-reco/unmatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statementLineId: lineId }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) load();
    else toast.error(j?.error || "Unmatch failed");
  };

  const handleDeleteLine = async (lineId: string) => {
    const res = await fetch(`/api/accounting/bank-reco/line/${lineId}`, { method: "DELETE" });
    const j = asMutationResponse(await res.json());
    if (j?.success) load();
    else toast.error(j?.error || "Delete failed");
  };

  const legs = data?.legs ?? [];
  const stmt = data?.statementLines ?? [];
  const unmatchedLegs = legs.filter((l) => !l.matched);
  const unmatchedStmt = stmt.filter((s) => !s.matchedLegId);
  const selCls = "rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm";
  const amtCls = (n: number) => `tabular-nums ${n < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Cash Book · Bank Reconciliation</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!account} onClick={() => setShowImport(!showImport)}>Import statement</Button>
          <Button variant="outline" size="sm" disabled={!account || busy || unmatchedStmt.length === 0} onClick={handleAutoMatch}>Auto-match</Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-4 bg-[#F7F4EF] rounded-lg">
          <div>
            <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">Bank / Cash account</label>
            <select value={account} onChange={(e) => { setAccount(e.target.value); setData(null); }} className={`${selCls} w-72`}>
              <option value="">— pick account —</option>
              {bankCash.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={selCls} />
          </div>
          <div>
            <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={selCls} />
          </div>
          {data && !data.migrationMissing && (
            <div className="text-sm text-[#6B7280] pb-1">
              Book {legs.length} legs ({unmatchedLegs.length} unmatched) · Statement {stmt.length} lines ({unmatchedStmt.length} unmatched)
            </div>
          )}
        </CardContent>
      </Card>

      {data?.migrationMissing && (
        <Card><CardContent className="p-4 text-sm text-[#9A3A2D]">Migration 0160 not applied yet — run the paste-version SQL first.</CardContent></Card>
      )}

      {showImport && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <p className="text-xs text-[#6B7280]">
              Paste the bank statement CSV below, then point each column. Money-out and money-in can be two columns
              (typical bank export) or the SAME column number for a single signed-amount column.
            </p>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={6}
              placeholder={"Date,Description,Withdrawal,Deposit\n02/06/2026,CHEQUE 001234,1500.00,\n05/06/2026,TRANSFER FROM CARRESS,,12500.00"}
              className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
            />
            <div className="flex flex-wrap items-end gap-3">
              {([["date", "Date col #"], ["desc", "Description col #"], ["out", "Money OUT col #"], ["in", "Money IN col #"]] as const).map(([k, label]) => (
                <div key={k}>
                  <label className="text-xs font-medium text-[#6B7280] mb-1 block">{label}</label>
                  <input type="text" value={map[k]} onChange={(e) => setMap({ ...map, [k]: e.target.value })} className={`${selCls} w-16 text-center`} />
                </div>
              ))}
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date format</label>
                <select value={map.fmt} onChange={(e) => setMap({ ...map, fmt: e.target.value })} className={selCls}>
                  <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                  <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                  <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm pb-2 cursor-pointer">
                <input type="checkbox" checked={map.header} onChange={(e) => setMap({ ...map, header: e.target.checked })} className="h-4 w-4 accent-[#6B5C32]" />
                First row is a header
              </label>
              <span className="text-sm text-[#6B7280] pb-2">{parsedRows.length} rows parsed · net {formatCurrency(parsedRows.reduce((s, r) => s + r.amountSen, 0))}</span>
              <Button variant="primary" size="sm" disabled={busy || parsedRows.length === 0} onClick={handleImport}>Import {parsedRows.length} lines</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {account && data && !data.migrationMissing && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {/* Statement side */}
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                    <th className="px-3 py-2 text-left" colSpan={4}>Bank statement ({stmt.length})</th>
                  </tr>
                </thead>
                <tbody>
                  {stmt.map((s) => {
                    const candidates = unmatchedLegs.filter((l) => l.amountSen === s.amountSen);
                    return (
                      <tr key={s.id} className={`border-b border-[#F0ECE9] ${s.matchedLegId ? "bg-[#EAF3DE]/40" : ""}`}>
                        <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{s.txnDate}</td>
                        <td className="px-3 py-1.5 text-xs">{s.description}</td>
                        <td className={`px-3 py-1.5 text-right ${amtCls(s.amountSen)}`}>{formatCurrency(s.amountSen)}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          {s.matchedLegId ? (
                            <button onClick={() => handleUnmatch(s.id)} className="text-[#6B7280] hover:text-[#9A3A2D] text-xs underline decoration-dotted cursor-pointer" title="Matched — click to unmatch">✓ unmatch</button>
                          ) : candidates.length > 0 ? (
                            <select defaultValue="" onChange={(e) => handleMatch(s.id, e.target.value)} className="rounded border border-[#E2DDD8] bg-white px-1 py-0.5 text-[11px] max-w-44">
                              <option value="">match to…</option>
                              {candidates.map((l) => (
                                <option key={l.id} value={l.id}>{l.day} {l.description.slice(0, 30)}</option>
                              ))}
                            </select>
                          ) : (
                            <>
                              <span className="text-[11px] text-[#9A3A2D] mr-2">no book entry</span>
                              <button onClick={() => handleDeleteLine(s.id)} className="text-[#9CA3AF] hover:text-[#9A3A2D] text-xs underline decoration-dotted cursor-pointer">del</button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {stmt.length === 0 && (
                    <tr><td className="px-3 py-8 text-center text-sm text-[#9CA3AF]" colSpan={4}>No statement lines in this window — import one</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
          {/* Book side */}
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                    <th className="px-3 py-2 text-left" colSpan={4}>Book (ledger {account}) — {legs.length} legs</th>
                  </tr>
                </thead>
                <tbody>
                  {legs.map((l) => (
                    <tr key={l.id} className={`border-b border-[#F0ECE9] ${l.matched ? "bg-[#EAF3DE]/40" : ""}`}>
                      <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{l.day}</td>
                      <td className="px-3 py-1.5 text-xs">{l.description}</td>
                      <td className={`px-3 py-1.5 text-right ${amtCls(l.amountSen)}`}>{formatCurrency(l.amountSen)}</td>
                      <td className="px-3 py-1.5 text-right text-xs">
                        {l.matched ? <span className="text-[#27500A]">✓</span> : <span className="text-[#9A3A2D]">not in bank</span>}
                      </td>
                    </tr>
                  ))}
                  {legs.length === 0 && (
                    <tr><td className="px-3 py-8 text-center text-sm text-[#9CA3AF]" colSpan={4}>No book entries in this window</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}
      {account && data && !data.migrationMissing && (
        <p className="text-[11px] text-[#9CA3AF]">
          Unreconciled items = the red rows: "not in bank" (book has it, statement doesn't — uncleared cheques etc.) and
          "no book entry" (bank has it, book doesn't — record it via Payments / Receipts, then match).
        </p>
      )}
    </div>
  );
}

// =============== TAB: OPENING BALANCE (Phase-5 prerequisite, owner-entered) ===============
//
// AutoCount-style split: AR/AP one opening invoice per customer/supplier
// (subledger only — aging/statements/three-card recon all flow); GL one
// balanced 'opening_balance' batch over BALANCE SHEET accounts, with the
// debtor/creditor control legs locked to the per-party sums. Re-posting
// reverses the prior batch (immutable ledger).

type ObState = {
  openingDate: string | null;
  posted: boolean;
  migrationMissing: boolean;
  glRows: { accountCode: string; debitSen: number; creditSen: number }[];
  arInvoices: { id: string; invoiceNo: string; customerId: string; customerName: string; invoiceDate: string | null; dueDate: string | null; totalSen: number; paidAmount: number; status: string }[];
  apInvoices: { id: string; piNo: string; supplierId: string; supplierName: string; invoiceDate: string | null; dueDate: string | null; amountSen: number; status: string }[];
  arByControl: Record<string, number>;
  arTotalSen: number;
  apTotalSen: number;
};

function OpeningBalanceTab({ accounts, onRefresh }: { accounts: ChartOfAccount[]; onRefresh: () => void }) {
  const { toast } = useToast();
  const [data, setData] = useState<ObState | null>(null);
  const [openingDate, setOpeningDate] = useState("");
  // GL grid — raw RM strings per account so typing never reformats.
  const [amounts, setAmounts] = useState<Record<string, { dr: string; cr: string }>>({});
  const [posting, setPosting] = useState(false);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [arForm, setArForm] = useState({ customerId: "", invoiceNo: "", invoiceDate: "", amount: "" });
  const [apForm, setApForm] = useState({ supplierId: "", piNo: "", invoiceDate: "", amount: "" });

  const load = useCallback((hydrate: boolean) => {
    fetch("/api/accounting/opening-balance")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: ObState }>)
      .then((j) => {
        if (!j?.success || !j.data) return;
        const d = j.data;
        setData(d);
        if (d.openingDate) setOpeningDate((prev) => prev || d.openingDate!);
        if (hydrate) {
          // Pre-fill the grid from the posted batch — control rows are
          // derived live, so skip them here.
          const next: Record<string, { dr: string; cr: string }> = {};
          const isControl = (code: string) => {
            const a = accounts.find((x) => x.code === code);
            return a?.specialAccountType === "SDC" || a?.specialAccountType === "SCC";
          };
          for (const r of d.glRows) {
            if (isControl(r.accountCode)) continue;
            next[r.accountCode] = {
              dr: r.debitSen ? (r.debitSen / 100).toFixed(2) : "",
              cr: r.creditSen ? (r.creditSen / 100).toFixed(2) : "",
            };
          }
          setAmounts(next);
        }
      })
      .catch(() => {});
  }, [accounts]);

  useEffect(() => {
    load(true);
    fetch("/api/customers")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { id: string; name: string }[] }>)
      .then((j) => { if (j?.success) setCustomers((j.data ?? []).map((x) => ({ id: x.id, name: x.name }))); })
      .catch(() => {});
    fetch("/api/suppliers")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { id: string; name: string }[] }>)
      .then((j) => { if (j?.success) setSuppliers((j.data ?? []).map((x) => ({ id: x.id, name: x.name }))); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toSen = (s: string): number => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? Math.round(v * 100) : 0;
  };

  // BALANCE SHEET accounts only; controls are derived rows.
  const glAccounts = accounts
    .filter(
      (a) =>
        ["ASSET", "LIABILITY", "EQUITY"].includes(a.type) &&
        a.isPostable !== false &&
        a.specialAccountType !== "SDC" &&
        a.specialAccountType !== "SCC",
    )
    .sort((a, b) => a.code.localeCompare(b.code));

  const userDr = glAccounts.reduce((s, a) => s + toSen(amounts[a.code]?.dr ?? ""), 0);
  const userCr = glAccounts.reduce((s, a) => s + toSen(amounts[a.code]?.cr ?? ""), 0);
  const totalDr = userDr + (data?.arTotalSen ?? 0);
  const totalCr = userCr + (data?.apTotalSen ?? 0);
  const diff = totalDr - totalCr;

  const handlePost = async () => {
    if (!openingDate) {
      toast.error("Set the opening date first");
      return;
    }
    setPosting(true);
    try {
      const rows = glAccounts
        .map((a) => ({
          code: a.code,
          debitSen: toSen(amounts[a.code]?.dr ?? ""),
          creditSen: toSen(amounts[a.code]?.cr ?? ""),
        }))
        .filter((r) => r.debitSen !== 0 || r.creditSen !== 0);
      const res = await fetch("/api/accounting/opening-balance/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openingDate, rows }),
      });
      const j = asMutationResponse(await res.json());
      if (j?.success) {
        toast.success(`Opening balance posted as at ${openingDate}`);
        load(false);
        onRefresh();
      } else toast.error(j?.error || "Post failed");
    } finally {
      setPosting(false);
    }
  };

  const handleAddAr = async () => {
    const amountSen = toSen(arForm.amount);
    if (!arForm.customerId || !arForm.invoiceNo.trim() || !arForm.invoiceDate || amountSen <= 0) {
      toast.error("Customer, invoice no, date and a positive amount are required");
      return;
    }
    const res = await fetch("/api/accounting/opening-balance/ar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: arForm.customerId,
        invoiceNo: arForm.invoiceNo.trim(),
        invoiceDate: arForm.invoiceDate,
        amountSen,
      }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) {
      setArForm({ customerId: "", invoiceNo: "", invoiceDate: "", amount: "" });
      load(false);
    } else toast.error(j?.error || "Failed to add opening invoice");
  };

  const handleAddAp = async () => {
    const amountSen = toSen(apForm.amount);
    if (!apForm.supplierId || !apForm.piNo.trim() || !apForm.invoiceDate || amountSen <= 0) {
      toast.error("Supplier, PI no, date and a positive amount are required");
      return;
    }
    const res = await fetch("/api/accounting/opening-balance/ap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supplierId: apForm.supplierId,
        piNo: apForm.piNo.trim(),
        invoiceDate: apForm.invoiceDate,
        amountSen,
      }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) {
      setApForm({ supplierId: "", piNo: "", invoiceDate: "", amount: "" });
      load(false);
    } else toast.error(j?.error || "Failed to add opening PI");
  };

  const handleDelete = async (kind: "ar" | "ap", id: string) => {
    const res = await fetch(`/api/accounting/opening-balance/${kind}/${id}`, { method: "DELETE" });
    const j = asMutationResponse(await res.json());
    if (j?.success) load(false);
    else toast.error(j?.error || "Delete failed");
  };

  const inputCls =
    "w-full rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-[#6B5C32]";

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[#1F1D1B]">Opening Balance</h2>

      {data?.migrationMissing && (
        <Card>
          <CardContent className="p-4 text-sm text-[#9A3A2D]">
            Migration 0158 (isOpening column) has not been applied yet — the AR/AP opening
            sections will not work until it runs. Ask for the paste-version SQL.
          </CardContent>
        </Card>
      )}

      {/* Opening date + balance check + Post */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-4">
          <div>
            <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">Opening date</label>
            <input
              type="date"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
              className="rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm"
            />
          </div>
          <div className="text-sm">
            <span className="text-[#6B7280] mr-2">Total DR</span>
            <span className="font-medium tabular-nums">{formatCurrency(totalDr)}</span>
            <span className="text-[#6B7280] mx-2">· Total CR</span>
            <span className="font-medium tabular-nums">{formatCurrency(totalCr)}</span>
            <span className={`ml-3 inline-flex items-center rounded-full px-3 py-1 text-xs font-medium border ${diff === 0 ? "bg-[#EAF3DE] text-[#27500A] border-[#C0DD97]" : "bg-[#FCEBEB] text-[#791F1F] border-[#F7C1C1]"}`}>
              {diff === 0 ? "Balanced ✓" : `Difference ${formatCurrency(Math.abs(diff))} ${diff > 0 ? "DR" : "CR"}`}
            </span>
          </div>
          <Button variant="primary" size="sm" disabled={posting || diff !== 0 || !openingDate} onClick={handlePost}>
            {posting ? "Posting…" : data?.posted ? "Re-post opening balance" : "Post opening balance"}
          </Button>
          {data?.posted && (
            <span className="text-xs text-[#6B7280]">
              Already posted{data.openingDate ? ` as at ${data.openingDate}` : ""} — re-posting reverses the
              previous figures first (the ledger keeps both, nothing is deleted).
            </span>
          )}
        </CardContent>
      </Card>

      {/* AR opening invoices */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#1F1D1B]">
              Debtor opening invoices <span className="font-normal text-[#6B7280]">(per customer — feeds aging, statements and the control account)</span>
            </h3>
            <span className="text-sm text-[#6B7280]">Total <span className="font-medium text-[#1F1D1B] tabular-nums">{formatCurrency(data?.arTotalSen ?? 0)}</span> DR</span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <select value={arForm.customerId} onChange={(e) => setArForm({ ...arForm, customerId: e.target.value })} className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm w-56">
              <option value="">— customer —</option>
              {customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <input type="text" placeholder="Old invoice no" value={arForm.invoiceNo} onChange={(e) => setArForm({ ...arForm, invoiceNo: e.target.value })} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm w-40" />
            <input type="date" value={arForm.invoiceDate} onChange={(e) => setArForm({ ...arForm, invoiceDate: e.target.value })} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm" />
            <input type="text" placeholder="Amount (RM)" value={arForm.amount} onChange={(e) => setArForm({ ...arForm, amount: e.target.value })} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm w-32 text-right tabular-nums" />
            <Button variant="outline" size="sm" onClick={handleAddAr}><Plus className="h-4 w-4" /> Add</Button>
          </div>
          {(data?.arInvoices.length ?? 0) > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-2 py-1.5 text-left">Customer</th>
                  <th className="px-2 py-1.5 text-left">Invoice No</th>
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                  <th className="px-2 py-1.5 text-right">Paid</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {data!.arInvoices.map((r) => (
                  <tr key={r.id} className="border-b border-[#F0ECE9]">
                    <td className="px-2 py-1.5">{r.customerName}</td>
                    <td className="px-2 py-1.5 tabular-nums text-xs">{r.invoiceNo}</td>
                    <td className="px-2 py-1.5 text-xs text-[#6B7280]">{r.invoiceDate ?? ""}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(r.totalSen)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-xs text-[#6B7280]">{r.paidAmount ? formatCurrency(r.paidAmount) : "-"}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => handleDelete("ar", r.id)} className="text-[#9A3A2D] hover:text-[#791F1F] text-xs underline decoration-dotted cursor-pointer">remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* AP opening invoices */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#1F1D1B]">
              Creditor opening invoices <span className="font-normal text-[#6B7280]">(per supplier — feeds aging, statements and 400-0000)</span>
            </h3>
            <span className="text-sm text-[#6B7280]">Total <span className="font-medium text-[#1F1D1B] tabular-nums">{formatCurrency(data?.apTotalSen ?? 0)}</span> CR</span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <select value={apForm.supplierId} onChange={(e) => setApForm({ ...apForm, supplierId: e.target.value })} className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm w-56">
              <option value="">— supplier —</option>
              {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <input type="text" placeholder="Old PI no" value={apForm.piNo} onChange={(e) => setApForm({ ...apForm, piNo: e.target.value })} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm w-40" />
            <input type="date" value={apForm.invoiceDate} onChange={(e) => setApForm({ ...apForm, invoiceDate: e.target.value })} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm" />
            <input type="text" placeholder="Amount (RM)" value={apForm.amount} onChange={(e) => setApForm({ ...apForm, amount: e.target.value })} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm w-32 text-right tabular-nums" />
            <Button variant="outline" size="sm" onClick={handleAddAp}><Plus className="h-4 w-4" /> Add</Button>
          </div>
          {(data?.apInvoices.length ?? 0) > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-2 py-1.5 text-left">Supplier</th>
                  <th className="px-2 py-1.5 text-left">PI No</th>
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {data!.apInvoices.map((r) => (
                  <tr key={r.id} className="border-b border-[#F0ECE9]">
                    <td className="px-2 py-1.5">{r.supplierName}</td>
                    <td className="px-2 py-1.5 tabular-nums text-xs">{r.piNo}</td>
                    <td className="px-2 py-1.5 text-xs text-[#6B7280]">{r.invoiceDate ?? ""}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(r.amountSen)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => handleDelete("ap", r.id)} className="text-[#9A3A2D] hover:text-[#791F1F] text-xs underline decoration-dotted cursor-pointer">remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* GL grid — balance-sheet accounts; controls are derived read-only rows */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                <th className="px-3 py-2 text-left">Balance-sheet account</th>
                <th className="px-3 py-2 text-right w-40">Debit (RM)</th>
                <th className="px-3 py-2 text-right w-40">Credit (RM)</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data?.arByControl ?? {}).map(([ctl, amt]) => (
                <tr key={ctl} className="border-b border-[#F0ECE9] bg-[#F7F4EF]">
                  <td className="px-3 py-1.5">
                    <span className="tabular-nums text-xs text-[#6B7280] mr-1">{ctl}</span>
                    {accounts.find((a) => a.code === ctl)?.name ?? ""}
                    <span className="ml-2 text-[11px] text-[#9CA3AF]">auto — Σ debtor opening invoices</span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(amt)}</td>
                  <td className="px-3 py-1.5 text-right text-[#9CA3AF]">—</td>
                </tr>
              ))}
              {(data?.apTotalSen ?? 0) !== 0 && (
                <tr className="border-b border-[#F0ECE9] bg-[#F7F4EF]">
                  <td className="px-3 py-1.5">
                    <span className="tabular-nums text-xs text-[#6B7280] mr-1">400-0000</span>
                    {accounts.find((a) => a.code === "400-0000")?.name ?? "TRADE CREDITORS"}
                    <span className="ml-2 text-[11px] text-[#9CA3AF]">auto — Σ creditor opening invoices</span>
                  </td>
                  <td className="px-3 py-1.5 text-right text-[#9CA3AF]">—</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(data!.apTotalSen)}</td>
                </tr>
              )}
              {glAccounts.map((a) => (
                <tr key={a.code} className="border-b border-[#F0ECE9]">
                  <td className="px-3 py-1.5">
                    <span className="tabular-nums text-xs text-[#6B7280] mr-1">{a.code}</span>
                    <span className="text-[#1F1D1B]">{a.name}</span>
                  </td>
                  <td className="px-3 py-1">
                    <input
                      type="text"
                      value={amounts[a.code]?.dr ?? ""}
                      onChange={(e) => setAmounts({ ...amounts, [a.code]: { dr: e.target.value, cr: "" } })}
                      placeholder=""
                      className={inputCls}
                    />
                  </td>
                  <td className="px-3 py-1">
                    <input
                      type="text"
                      value={amounts[a.code]?.cr ?? ""}
                      onChange={(e) => setAmounts({ ...amounts, [a.code]: { dr: "", cr: e.target.value } })}
                      placeholder=""
                      className={inputCls}
                    />
                  </td>
                </tr>
              ))}
              <tr className="bg-[#F0ECE9]/60 font-semibold text-[#1F1D1B]">
                <td className="px-3 py-2">TOTAL (incl. auto control rows)</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalDr)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalCr)}</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
      <p className="text-[11px] text-[#9CA3AF]">
        P&L accounts are deliberately absent — prior years' results belong in retained earnings /
        capital, not in this year's P&L. The difference line, if any, usually goes to 150-0000
        RETAINED EARNING or the capital account.
      </p>
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

type CashFlowResp = { operating: number; investing: number; financing: number; netChange: number; note: string };

function BalanceSheetTab() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const months: string[] = [];
  {
    const now = new Date();
    for (let i = 0; i < 18; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
  }
  const { data: bsResp, loading: bsLoading, refresh: bsRefresh } = useCachedJson<{ success?: boolean; data?: { balanceSheet?: BalanceSheetEntry[]; cashFlow?: CashFlowResp } }>(`/api/accounting/pl?period=${period}`);
  const bsData: BalanceSheetEntry[] = useMemo(
    () => (bsResp?.success && bsResp.data?.balanceSheet ? bsResp.data.balanceSheet : []),
    [bsResp]
  );

  const { toast } = useToast();
  const [edit, setEdit] = useState(false);
  const [bmap, setBmap] = useState<Record<string, string>>({});
  const [dragCode, setDragCode] = useState<string | null>(null);
  const [dragOverSec, setDragOverSec] = useState<string | null>(null);
  useEffect(() => {
    if (!edit) return;
    fetch("/api/accounting/bs/section-map")
      .then((r) => r.json() as Promise<{ data?: { map?: Record<string, string> } }>)
      .then((j) => setBmap(j?.data?.map ?? {}))
      .catch(() => {});
  }, [edit]);
  const moveTo = async (code: string, section: string) => {
    const prev = bmap;
    const next = { ...bmap, [code]: section };
    setBmap(next);
    try {
      const res = await fetch("/api/accounting/bs/section-map", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ map: next }) });
      const j = (await res.json()) as { success?: boolean };
      if (j?.success) { toast.success("Balance-sheet mapping updated"); bsRefresh(); } else { setBmap(prev); toast.error("Save failed"); }
    } catch { setBmap(prev); toast.error("Save failed"); }
  };

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
    bgClass: string,
    section: string,
  ) => (
    <>
      <tr className={`${bgClass} ${edit && dragCode && dragOverSec === section ? "ring-2 ring-inset ring-[#6B5C32]" : ""}`}
        onDragOver={edit && dragCode ? (e) => { e.preventDefault(); setDragOverSec(section); } : undefined}
        onDragLeave={edit && dragCode ? () => { if (dragOverSec === section) setDragOverSec(null); } : undefined}
        onDrop={edit && dragCode ? (e) => { e.preventDefault(); const src = e.dataTransfer.getData("text/plain"); setDragOverSec(null); setDragCode(null); if (src) void moveTo(src, section); } : undefined}>
        <td colSpan={3} className={`px-4 py-2 font-semibold ${colorClass}`}>{title}</td>
      </tr>
      {entries.map((e) => {
        const draggable = edit && e.accountCode !== "NP-CURRENT";
        return (
          <tr key={e.id} className={`border-t border-[#E2DDD8]/50 ${draggable ? "cursor-move" : ""} ${dragCode === e.accountCode ? "opacity-40" : ""}`}
            draggable={draggable}
            onDragStart={draggable ? (ev) => { setDragCode(e.accountCode); ev.dataTransfer.setData("text/plain", e.accountCode); ev.dataTransfer.effectAllowed = "move"; } : undefined}
            onDragEnd={draggable ? () => { setDragCode(null); setDragOverSec(null); } : undefined}>
            <td className="px-4 py-1.5 pl-8 text-[#6B7280] text-xs">{draggable ? "⠿ " : ""}{e.accountCode}</td>
            <td className="px-4 py-1.5 text-[#4B5563]">{e.accountName}</td>
            <td className={`px-4 py-1.5 text-right font-medium ${e.balance < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
              {e.balance < 0 ? `(${formatCurrency(Math.abs(e.balance))})` : formatCurrency(e.balance)}
            </td>
          </tr>
        );
      })}
      <tr className={`border-t border-[#E2DDD8] ${bgClass} font-semibold`}>
        <td colSpan={2} className={`px-4 py-2 ${colorClass}`}>Total {title}</td>
        <td className={`px-4 py-2 text-right ${colorClass}`}>{formatCurrency(total)}</td>
      </tr>
    </>
  );

  return (
    <div className="space-y-6">
      <YearCloseCard />
      <div className="flex items-center gap-2">
        <label className="text-xs font-semibold text-[#1F1D1B]">As at month-end</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-sm">
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button onClick={() => setEdit((v) => !v)}
          className={`ml-2 rounded-md border px-3 py-1.5 text-sm cursor-pointer ${edit ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>
          {edit ? "Done" : "Edit"}
        </button>
        {edit && <span className="text-[11px] text-[#6B5C32]">Drag an account row onto a target section to reclassify it · Assets ↔ Liabilities is allowed too (the sign flips on the move, the statement still balances) · all months recompute under the new rule · drag back to undo</span>}
      </div>
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
            Balance Sheet as at end {period}
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
                {renderBSSection("Current Assets", currentAssets, totalCurrentAssets, INFO.text, INFO.bg, "CURRENT_ASSET")}
                {renderBSSection("Fixed Assets (Net)", fixedAssets, totalFixedAssets, INFO.text, INFO.bg, "FIXED_ASSET")}
                <tr className={`border-t-2 ${INFO.border} ${INFO.bg} font-bold`}>
                  <td colSpan={2} className={`px-4 py-3 ${INFO.text}`}>TOTAL ASSETS</td>
                  <td className={`px-4 py-3 text-right ${INFO.text}`}>{formatCurrency(totalAssets)}</td>
                </tr>

                {/* LIABILITIES — DANGER (red) tint */}
                <tr className={`${DANGER.bg} border-t-2 ${DANGER.border}`}>
                  <td colSpan={3} className={`px-4 py-2 font-bold text-base ${DANGER.text}`}>LIABILITIES</td>
                </tr>
                {renderBSSection("Current Liabilities", currentLiabilities, totalCurrentLiab, DANGER.text, DANGER.bg, "CURRENT_LIABILITY")}
                {renderBSSection("Long-Term Liabilities", longTermLiabilities, totalLongTermLiab, DANGER.text, DANGER.bg, "LONG_TERM_LIABILITY")}
                <tr className={`border-t border-[#E2DDD8] font-semibold ${DANGER.bg}`}>
                  <td colSpan={2} className={`px-4 py-2 ${DANGER.text}`}>Total Liabilities</td>
                  <td className={`px-4 py-2 text-right ${DANGER.text}`}>{formatCurrency(totalLiabilities)}</td>
                </tr>

                {/* EQUITY — ACCENT_PLUM tint */}
                {renderBSSection("Equity", equityItems, totalEquity, ACCENT_PLUM.text, ACCENT_PLUM.bg, "EQUITY")}

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

// Phase 5.4 — Cash Flow (Operating / Investing / Financing), pulled out as
// its own report (owner UI reorg). Categorised P&L-result view by each
// account's O/I/F tag — not a full IAS7 working-capital statement. The
// fuller cash-flow template the owner is preparing will replace this.
type CfApiRow = {
  kind: "section" | "group" | "line" | "subtotal" | "result" | "total" | "bf" | "cf" | "gap";
  label: string;
  section?: string;
  depth: number;
  groupId?: string;
  values: (number | null)[];
  accountCode?: string;
};
type CfApiData = { period: string; columns: { key: string; label: string; accum?: boolean }[]; rows: CfApiRow[] };

function CashFlowTab() {
  const { toast } = useToast();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [level, setLevel] = useState(3);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState(false);
  const [map, setMap] = useState<Record<string, { section: string; order: number }>>({});
  const [dragCode, setDragCode] = useState<string | null>(null);
  const [dragOverSec, setDragOverSec] = useState<string | null>(null);
  const { data: resp, refresh } = useCachedJson<{ success?: boolean; data?: CfApiData }>(
    `/api/accounting/cashflow-statement?period=${period}${edit ? "&editable=1" : ""}`,
  );
  const data = resp?.success ? resp.data : undefined;
  const cols = data?.columns ?? [];
  const rows = data?.rows ?? [];

  useEffect(() => {
    if (!edit) return;
    fetch("/api/accounting/cashflow/map")
      .then((r) => r.json() as Promise<{ data?: { map?: Record<string, { section: string; order: number }> } }>)
      .then((j) => setMap(j?.data?.map ?? {}))
      .catch(() => {});
  }, [edit]);

  const cfCollapseForLevel = (rs: CfApiRow[], L: number): Set<string> => {
    const s = new Set<string>();
    if (L >= 3) return s;
    for (const r of rs) if (r.kind === "group" && r.groupId) {
      if (L <= 1) s.add(r.groupId);
    }
    return s;
  };
  const applyLevel = (L: number) => { setCollapsed(cfCollapseForLevel(rows, L)); setLevel(L); };
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => { setCollapsed(cfCollapseForLevel(rows, level)); }, [data]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const sectionAccounts = (sec: string): string[] =>
    rows.filter((r) => r.kind === "line" && r.section === sec && r.accountCode).map((r) => r.accountCode!);
  const moveTo = async (code: string, sec: string, beforeCode?: string) => {
    const peers = sectionAccounts(sec).filter((c) => c !== code);
    let idx = beforeCode ? peers.indexOf(beforeCode) : peers.length;
    if (idx < 0) idx = peers.length;
    const ordered = [...peers.slice(0, idx), code, ...peers.slice(idx)];
    const next = { ...map };
    ordered.forEach((c, i) => { next[c] = { section: sec, order: i }; });
    setMap(next);
    try {
      const res = await fetch("/api/accounting/cashflow/map", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ map: next }),
      });
      const j = (await res.json()) as { success?: boolean };
      if (j?.success) { toast.success("Mapping updated"); refresh(); }
      else toast.error("Save failed");
    } catch { toast.error("Save failed"); }
  };

  const fmt = (v: number | null): string => {
    if (v === null || v === undefined) return "";
    if (v === 0) return "-";
    const a = Math.abs(v / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v < 0 ? `(${a})` : a;
  };
  const months: string[] = [];
  { const now = new Date(); for (let i = 0; i < 18; i++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); months.push(d.toISOString().slice(0, 7)); } }
  const yrNow = new Date().getUTCFullYear(); const years = [yrNow, yrNow - 1];

  const visibleRows = rows.filter((r) =>
    r.depth <= (level >= 3 ? 9 : level) && (!r.groupId || r.kind === "group" || !collapsed.has(r.groupId)),
  );

  const buildExport = (): Aoa => {
    const head: (string | number)[] = ["ITEM", ...cols.map((c) => c.label)];
    const aoa: Aoa = [head];
    for (const r of rows) {
      if (r.kind === "gap") { aoa.push([]); continue; }
      const indent = "  ".repeat(r.depth) + (r.kind === "group" ? "› " : "");
      aoa.push([indent + r.label, ...r.values.map((v) => (v === null ? "" : (v / 100).toFixed(2)))]);
    }
    return aoa;
  };

  const isDropTarget = (r: CfApiRow) => edit && (r.kind === "group" || r.kind === "section") && !!r.section;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Statement of Cash Flow</h2>
        <span className="text-xs text-[#9CA3AF]">cash basis · full detail</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { const ne = !edit; setEdit(ne); if (ne) { setLevel(3); setCollapsed(new Set()); } }}
            className={`rounded-md border px-3 py-1.5 text-sm cursor-pointer ${edit ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>
            {edit ? "Done" : "Edit"}
          </button>
          {[1, 2, 3].map((L) => (
            <button key={L} onClick={() => applyLevel(L)}
              className={`rounded-md border px-3 py-1.5 text-sm cursor-pointer ${level === L ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>L{L}</button>
          ))}
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-sm">
            <optgroup label="Monthly">{months.map((m) => <option key={m} value={m}>{m}</option>)}</optgroup>
            <optgroup label="Quarter">{years.flatMap((yr) => [1, 2, 3, 4].map((q) => <option key={`${yr}-Q${q}`} value={`${yr}-Q${q}`}>Q{q} {yr}</option>))}</optgroup>
            <optgroup label="Full year">{years.map((yr) => <option key={`${yr}`} value={`${yr}`}>Full Year {yr}</option>)}</optgroup>
          </select>
          <ExportButtons build={buildExport} filenameBase={`CashFlow-${period}`} title="Statement of Cash Flow" subtitle={`Period: ${period}`} />
        </div>
      </div>
      {edit && <p className="text-[11px] text-[#6B5C32]">Drag an account row onto a target section heading to reclassify it · this changes the rule, so all months recompute under it · Bank c/f total unchanged · drag back to undo</p>}
      <Card>
        <CardContent className="p-4 overflow-x-auto">
          {!data ? (
            <div className="py-8 text-center text-[#6B7280] text-sm">No cash-flow data for {period}.</div>
          ) : (
            <table className="text-[13px]" style={{ minWidth: 760 }}>
              <thead>
                <tr className="text-[12px] text-[#6B7280]">
                  <td />
                  {cols.map((c) => <td key={c.key} className="text-right px-2 pb-1 whitespace-nowrap">{c.label}</td>)}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r, i) => {
                  if (r.kind === "gap") return <tr key={i}><td colSpan={cols.length + 1} className="py-1.5" /></tr>;
                  const pad = { paddingLeft: `${8 + r.depth * 16}px` };
                  const isGroup = r.kind === "group";
                  const isOpen = isGroup && r.groupId ? !collapsed.has(r.groupId) : false;
                  const strong = r.kind === "subtotal" || r.kind === "result" || r.kind === "total" || r.kind === "cf" || r.kind === "section" || isGroup;
                  const draggable = edit && r.kind === "line" && !!r.accountCode;
                  const dropHere = isDropTarget(r);
                  const rowCls =
                    r.kind === "result" ? "bg-[#F0ECE9]/60 font-semibold" :
                    r.kind === "total" ? "border-t-2 border-[#6B5C32] font-semibold" :
                    r.kind === "cf" ? "border-b-2 border-[#6B5C32] bg-[#F0ECE9]/40 font-semibold" :
                    r.kind === "section" ? "font-semibold text-[#1F1D1B]" : "";
                  return (
                    <tr key={i}
                      className={`${rowCls} ${isGroup ? "cursor-pointer hover:bg-[#F7F4EF] bg-[#F0ECE9]/30 font-semibold" : ""} ${draggable ? "cursor-move" : ""} ${dragCode === r.accountCode ? "opacity-40" : ""} ${dropHere && dragOverSec === r.section ? "ring-2 ring-inset ring-[#6B5C32]" : ""}`}
                      draggable={draggable}
                      onDragStart={draggable ? (e) => { setDragCode(r.accountCode!); e.dataTransfer.setData("text/plain", r.accountCode!); e.dataTransfer.effectAllowed = "move"; } : undefined}
                      onDragEnd={draggable ? () => { setDragCode(null); setDragOverSec(null); } : undefined}
                      onDragOver={(dropHere || (edit && r.kind === "line" && !!r.accountCode)) && dragCode ? (e) => { e.preventDefault(); if (r.section) setDragOverSec(r.section); } : undefined}
                      onDragLeave={dropHere ? () => { if (dragOverSec === r.section) setDragOverSec(null); } : undefined}
                      onDrop={(edit && dragCode) ? (e) => {
                        e.preventDefault();
                        const src = e.dataTransfer.getData("text/plain");
                        setDragOverSec(null); setDragCode(null);
                        if (!src || !r.section) return;
                        if (r.kind === "line" && r.accountCode && r.accountCode !== src) void moveTo(src, r.section, r.accountCode);
                        else void moveTo(src, r.section);
                      } : undefined}
                      onClick={isGroup && !edit ? () => { const n = new Set(collapsed); if (n.has(r.groupId!)) n.delete(r.groupId!); else n.add(r.groupId!); setCollapsed(n); } : undefined}>
                      <td className="py-1 whitespace-nowrap" style={pad}>{isGroup ? (isOpen ? "▾ " : "▸ ") : ""}{draggable ? "⠿ " : ""}{r.label}</td>
                      {r.values.map((v, j) => (
                        <td key={j} className={`text-right px-2 tabular-nums whitespace-nowrap ${typeof v === "number" && v < 0 ? "text-[#9A3A2D]" : ""} ${strong ? "font-semibold" : ""}`}>{fmt(v)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="text-[11px] text-[#9CA3AF] mt-3">Cash basis · classified from bank/cash ledger movements · Raw Materials traced to PI stock groups · Bank c/f = b/f + Cash Surplus.</p>
        </CardContent>
      </Card>
    </div>
  );
}
