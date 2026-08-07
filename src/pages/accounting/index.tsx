import * as React from "react";
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { humanizeError } from "@/lib/humanize-error";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LifecycleActions, LifecycleBadge } from "@/components/accounting/lifecycle-actions";
import { defaultBankCode } from "@/lib/default-bank";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { MoneyInput } from "@/components/ui/money-input";
import { useVirtualRows } from "@/components/ui/virtual-rows";
import { DeferredBlock } from "@/components/ui/deferred-block";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { exportReportCsv, exportReportXlsx, exportReportPdf, type Aoa, type PdfExportOpts } from "@/lib/export-report";
import { buildAgingExportAoa, agingRowKind } from "@/lib/aging-export";
import { isCleanImportShape, detectRawShape, parseRawStockTakeRows, impliedYmFromFilename, type ParsedRawItem } from "@/lib/stock-take-import";
import { printVoucher, printVouchers, type VoucherSpec, type VoucherLine } from "@/lib/print-voucher";
import { useRowSelection } from "@/lib/use-row-selection";
import { BatchActionsBar } from "@/components/accounting/batch-actions-bar";
import { amountInWords } from "@/lib/amount-in-words";
import { COMPANY } from "@/lib/constants";
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
  Wallet,
  Printer,
  Upload,
  Download,
} from "lucide-react";
import type {
  ChartOfAccount,
  JournalEntry,
  JournalLine,
  ARAgingEntry,
  APAgingEntry,
  BalanceSheetEntry,
} from "@/types";
// Shared helpers + per-tab components extracted from this file (2026-07-04
// split of the ~9.6k-line Accounting page; behaviour-identical, more tabs
// to follow).
import { asMutationResponse, useCompanyOptions, orgIdParam, type CompanyOption } from "./shared";
import { AuditLogTab } from "./tabs/AuditLogTab";
import { bestMatch } from "@/lib/party-fuzzy-match";
import {
  resolveAlias,
  usePartyAliases,
  teachPartyAlias,
} from "@/lib/party-alias-client";

// =============== MULTI-COMPANY (Phase 2) — company selector ===============
//
// A compact company dropdown that matches the existing period selector's
// styling (rounded-md border, bg-white, px-3 py-1.5, text-sm). DEFAULT is
// "All companies (group)" (value "") — the report then fetches with NO orgId
// param, i.e. today's consolidated numbers, byte-identical to before. Picking
// a company appends `&orgId=<code>` and scopes the report to that one entity.
function CompanySelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: CompanyOption[];
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs font-semibold text-[#1F1D1B]">Company</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
      >
        {options.map((o) => (
          <option key={o.value || "__all__"} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// =============== TYPES ===============

type TabKey = "overview" | "coa" | "journals" | "tb" | "gl" | "ar" | "ap" | "supplier-discount" | "debtorledger" | "creditorledger" | "odebtor" | "ocreditor" | "odebtorbills" | "odebtorpay" | "ocreditorbills" | "ocreditorpay" | "pl" | "trend" | "plmonthly" | "ceclass" | "coststruct" | "cashflow" | "bs" | "payments" | "receipts" | "transfer" | "cashbook" | "assets" | "labor" | "stock" | "stockmap" | "openstock" | "stocktake" | "opening" | "audit" | "maint";

// =============== VOUCHER PRINTING (PV / OR / JV) ===============
//
// Build a one-page printable voucher from a document's already-loaded data and
// hand it to printVoucher() (the shared inline-HTML + window.print renderer in
// src/lib/print-voucher.ts). The three tabs below (PaymentsTab, ReceiptsTab,
// JournalsTab) map their rows → a VoucherSpec via the builders here. Letterhead
// comes from COMPANY.HOOKKA — never hardcoded. Money stays integer sen and is
// formatted with formatCurrency.

// COMPANY.HOOKKA → the VoucherSpec.company shape (single source of truth).
const VOUCHER_COMPANY: VoucherSpec["company"] = {
  name: COMPANY.HOOKKA.name,
  addressLines: COMPANY.HOOKKA.addressLines,
  regNo: COMPANY.HOOKKA.regNo,
  tin: COMPANY.HOOKKA.tin,
  phone: COMPANY.HOOKKA.phone,
  email: COMPANY.HOOKKA.email,
};

// "<code> · <name>" using the already-loaded chart of accounts; falls back to
// the bare code if the account isn't in the COA (deleted / not yet synced).
function accountLabel(accounts: ChartOfAccount[], code: string): string {
  const nm = accounts.find((a) => a.code === code)?.name;
  return nm ? `${code} · ${nm}` : code;
}

function todayDMY(): string {
  return formatDateDMY(new Date());
}

// PV → voucher: expense (DR) lines, "Paid from" bank note, amount in words.
function buildPvVoucher(
  pv: PvRow,
  accounts: ChartOfAccount[],
): VoucherSpec {
  const lines: VoucherLine[] = pv.lines.map((l) => ({
    cells: [accountLabel(accounts, l.accountCode), l.description ?? "", formatCurrency(l.amountSen)],
  }));
  const paidFrom = pv.accrued === 1 && !pv.settledAt
    ? `Accrued to: ${pv.accrualAccount ? accountLabel(accounts, pv.accrualAccount) : "—"}`
    : `Paid from: ${pv.payFrom ? accountLabel(accounts, pv.payFrom) : "—"}`;
  return {
    // A voided voucher must never print as a clean/valid document.
    title: pv.status === "VOID" ? "PAYMENT VOUCHER — VOID" : "PAYMENT VOUCHER",
    company: VOUCHER_COMPANY,
    docNo: pv.pvNo,
    date: formatDateDMY(pv.date),
    partyLabel: "Pay To",
    partyName: pv.payee ?? "",
    columns: [{ label: "Account" }, { label: "Description" }, { label: "Amount", align: "right" }],
    lines,
    footerNote: paidFrom,
    totalCells: ["", "Total", formatCurrency(pv.totalSen)],
    amountWords: amountInWords(pv.totalSen),
    remarks: pv.description ?? undefined,
    signatures: [{ label: "Prepared by" }, { label: "Approved by" }, { label: "Received by" }],
    printedOn: todayDMY(),
  };
}

// OR → voucher: income (CR) lines, "Deposited to" bank note, amount in words.
function buildOrVoucher(
  or: OrRow,
  accounts: ChartOfAccount[],
): VoucherSpec {
  const lines: VoucherLine[] = or.lines.map((l) => ({
    cells: [accountLabel(accounts, l.accountCode), l.description ?? "", formatCurrency(l.amountSen)],
  }));
  return {
    title: or.status === "VOID" ? "OFFICIAL RECEIPT — VOID" : "OFFICIAL RECEIPT",
    company: VOUCHER_COMPANY,
    docNo: or.orNo,
    date: formatDateDMY(or.date),
    partyLabel: "Received From",
    partyName: or.receivedFrom ?? "",
    columns: [{ label: "Account" }, { label: "Description" }, { label: "Amount", align: "right" }],
    lines,
    footerNote: `Deposited to: ${or.payTo ? accountLabel(accounts, or.payTo) : "—"}`,
    totalCells: ["", "Total", formatCurrency(or.totalSen)],
    amountWords: amountInWords(or.totalSen),
    remarks: or.description ?? undefined,
    signatures: [{ label: "Received by" }, { label: "Issued by" }],
    printedOn: todayDMY(),
  };
}

// JV → voucher: each journal line as Account · Description · Debit · Credit,
// with a balancing Totals row (ΣDebit = ΣCredit). No amount-in-words.
function buildJvVoucher(je: JournalEntry): VoucherSpec {
  const totalDebit = je.lines.reduce((s, l) => s + l.debitSen, 0);
  const totalCredit = je.lines.reduce((s, l) => s + l.creditSen, 0);
  const lines: VoucherLine[] = je.lines.map((l) => ({
    cells: [
      l.accountName ? `${l.accountCode} · ${l.accountName}` : l.accountCode,
      l.description ?? "",
      l.debitSen ? formatCurrency(l.debitSen) : "",
      l.creditSen ? formatCurrency(l.creditSen) : "",
    ],
  }));
  const jvTag =
    je.lifecycleState === "VOID" || je.lifecycleState === "DELETED"
      ? " — VOID"
      : je.status === "DRAFT"
        ? " — DRAFT"
        : "";
  return {
    title: `JOURNAL VOUCHER${jvTag}`,
    company: VOUCHER_COMPANY,
    docNo: je.entryNo,
    date: formatDateDMY(je.date),
    partyLabel: "Description",
    partyName: je.description ?? "",
    columns: [
      { label: "Account" },
      { label: "Description" },
      { label: "Debit", align: "right" },
      { label: "Credit", align: "right" },
    ],
    lines,
    totalCells: ["", "Total", formatCurrency(totalDebit), formatCurrency(totalCredit)],
    signatures: [{ label: "Prepared by" }, { label: "Approved by" }],
    printedOn: todayDMY(),
  };
}

// Other-party bill → voucher: one line per item (Account · Description · Amount),
// "Reference" footer note, amount in words. VOID-tagged if voided/deleted.
function buildOtherPartyBillVoucher(b: OtherPartyBill, accounts: ChartOfAccount[]): VoucherSpec {
  const voided = b.lifecycleState === "VOID" || b.lifecycleState === "DELETED";
  const lines: VoucherLine[] = b.items.map((it) => ({
    cells: [accountLabel(accounts, it.counterAccount), it.description ?? "", formatCurrency(it.amountSen)],
  }));
  return {
    title: voided ? "OTHER-PARTY BILL — VOID" : "OTHER-PARTY BILL",
    company: VOUCHER_COMPANY,
    docNo: b.billNo,
    date: formatDateDMY(b.billDate),
    partyLabel: "Party",
    partyName: b.partyName,
    columns: [{ label: "Account" }, { label: "Description" }, { label: "Amount", align: "right" }],
    lines,
    footerNote: `Reference: ${b.referenceNo || "—"}`,
    totalCells: ["", "Total", formatCurrency(b.totalSen)],
    amountWords: amountInWords(b.totalSen),
    signatures: [{ label: "Prepared by" }, { label: "Approved by" }],
    printedOn: todayDMY(),
  };
}

// Other-party payment → voucher: one line per allocated bill (Bill No · Amount),
// "Paid from" bank note, amount in words. VOID-tagged if voided/deleted.
function buildOtherPartyPaymentVoucher(p: PaymentGroup, accounts: ChartOfAccount[]): VoucherSpec {
  const voided = p.lifecycleState === "VOID" || p.lifecycleState === "DELETED";
  const lines: VoucherLine[] = p.lines.map((l) => ({
    cells: [l.billNo, formatCurrency(l.amountSen)],
  }));
  return {
    title: voided ? "OTHER-PARTY PAYMENT VOUCHER — VOID" : "OTHER-PARTY PAYMENT VOUCHER",
    company: VOUCHER_COMPANY,
    docNo: p.paymentNo,
    date: formatDateDMY(p.date),
    partyLabel: "Party",
    partyName: p.partyName,
    columns: [{ label: "Bill No" }, { label: "Amount", align: "right" }],
    lines,
    footerNote: `Paid from: ${p.bankAccount ? accountLabel(accounts, p.bankAccount) : "—"}`,
    totalCells: ["Total", formatCurrency(p.totalSen)],
    amountWords: amountInWords(p.totalSen),
    signatures: [{ label: "Prepared by" }, { label: "Approved by" }, { label: "Received by" }],
    printedOn: todayDMY(),
  };
}

// Fund transfer → voucher: a single From/To/Amount line (no line items). The
// chart of accounts is in scope here, so From/To resolve to "code · name" via
// accountLabel. VOID-tagged when voided/deleted.
function buildFundTransferVoucher(t: FtRow, accounts: ChartOfAccount[]): VoucherSpec {
  const voided = t.lifecycleState === "VOID" || t.lifecycleState === "DELETED";
  return {
    title: voided ? "FUND TRANSFER VOUCHER — VOID" : "FUND TRANSFER VOUCHER",
    company: VOUCHER_COMPANY,
    docNo: t.no,
    date: formatDateDMY(t.date),
    partyLabel: "Description",
    partyName: t.description ?? "",
    columns: [{ label: "From" }, { label: "To" }, { label: "Amount", align: "right" }],
    lines: [{ cells: [accountLabel(accounts, t.fromAccount), accountLabel(accounts, t.toAccount), formatCurrency(t.amountSen)] }],
    totalCells: ["", "Total", formatCurrency(t.amountSen)],
    amountWords: amountInWords(t.amountSen),
    signatures: [{ label: "Prepared by" }, { label: "Approved by" }],
    printedOn: todayDMY(),
  };
}

// Supplier discount (purchase credit note) → voucher: a single
// reason/amount line (no per-account items). Voided notes carry status
// "CANCELLED" (see /purchase-credit-notes/:id/void) — VOID-tag those.
function buildSupplierDiscountVoucher(d: SDHistoryRow): VoucherSpec {
  const voided = d.status === "CANCELLED" || d.status === "VOID";
  return {
    title: voided ? "SUPPLIER DISCOUNT NOTE — VOID" : "SUPPLIER DISCOUNT NOTE",
    company: VOUCHER_COMPANY,
    docNo: d.noteNumber,
    date: formatDateDMY(d.date),
    partyLabel: "Supplier",
    partyName: d.supplierName ?? "",
    columns: [{ label: "Description" }, { label: "Amount", align: "right" }],
    lines: [{ cells: [d.reason || "Supplier discount", formatCurrency(d.totalAmount)] }],
    footerNote: d.piNo ? `Against PI: ${d.piNo}` : undefined,
    totalCells: ["Total", formatCurrency(d.totalAmount)],
    amountWords: amountInWords(d.totalAmount),
    signatures: [{ label: "Prepared by" }, { label: "Approved by" }],
    printedOn: todayDMY(),
  };
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
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
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

  const pick = (code: string) => {
    onChange(code);
    setText("");
    setOpen(false);
    setHi(0);
  };

  // Keep the highlighted row scrolled into view while arrowing through matches.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${hi}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  return (
    <div className="relative">
      <input
        type="text"
        value={shown}
        placeholder={placeholder ?? "Type code or name…"}
        onFocus={() => {
          setOpen(true);
          setText("");
          setHi(0);
        }}
        // eslint-disable-next-line no-restricted-syntax -- event-handler-only delay so the option's onMouseDown fires before the dropdown closes; not a React render timer
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            setHi((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            const sel = matches[hi];
            if (open && sel) {
              e.preventDefault();
              pick(sel.code);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
      />
      {open && (
        <div ref={listRef} className="absolute z-20 mt-1 max-h-64 w-full min-w-72 overflow-y-auto rounded-md border border-[#E2DDD8] bg-white shadow-lg">
          {allowAll && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                pick("");
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-[#6B7280] hover:bg-[#F0ECE9] cursor-pointer"
            >
              (All accounts)
            </button>
          )}
          {matches.map((a, idx) => (
            <button
              key={a.code}
              type="button"
              data-idx={idx}
              onMouseEnter={() => setHi(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(a.code);
              }}
              className={`block w-full px-3 py-1.5 text-left text-sm cursor-pointer ${idx === hi ? "bg-[#F0ECE9]" : "hover:bg-[#F0ECE9]"}`}
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
  // Owner 2026-07-29: Monthly Trend + Cost / Expense Classes retired from the
  // tab bar (unused; components + endpoints stay — re-adding a registry line
  // here restores either instantly).
  { key: "plmonthly", label: "Monthly P&L", icon: <BarChart3 className="h-4 w-4" />, group: "Monthly Report" },
  // Daily Operation
  { key: "payments", label: "Expense Payment", icon: <BookOpen className="h-4 w-4" />, group: "Daily Operation" },
  { key: "receipts", label: "Receipts", icon: <BookOpen className="h-4 w-4" />, group: "Daily Operation" },
  { key: "transfer", label: "Fund Transfer", icon: <Wallet className="h-4 w-4" />, group: "Daily Operation" },
  // Monthly Operation
  { key: "journals", label: "Journal Entries", icon: <BookOpen className="h-4 w-4" />, group: "Monthly Operation" },
  { key: "cashbook", label: "Cash Book", icon: <BookOpen className="h-4 w-4" />, group: "Monthly Operation" },
  { key: "assets", label: "Fixed Assets", icon: <Building2 className="h-4 w-4" />, group: "Monthly Operation" },
  // Debtor / Creditor
  { key: "ar", label: "Debtor Aging", icon: <Users className="h-4 w-4" />, group: "Debtor / Creditor" },
  { key: "ap", label: "Creditor Aging", icon: <Building2 className="h-4 w-4" />, group: "Debtor / Creditor" },
  { key: "supplier-discount", label: "Supplier Discount", icon: <CreditCard className="h-4 w-4" />, group: "Debtor / Creditor" },
  { key: "odebtor", label: "Other Debtor", icon: <Users className="h-4 w-4" />, group: "Debtor / Creditor" },
  { key: "odebtorbills", label: "Other Debtor Bills", icon: <BookOpen className="h-4 w-4" />, group: "Debtor / Creditor" },
  { key: "odebtorpay", label: "Other Debtor Receipts", icon: <Wallet className="h-4 w-4" />, group: "Debtor / Creditor" },
  { key: "ocreditor", label: "Other Creditor", icon: <Building2 className="h-4 w-4" />, group: "Debtor / Creditor" },
  { key: "ocreditorbills", label: "Other Creditor Bills", icon: <BookOpen className="h-4 w-4" />, group: "Debtor / Creditor" },
  { key: "ocreditorpay", label: "Other Creditor Payments", icon: <Wallet className="h-4 w-4" />, group: "Debtor / Creditor" },
  // Maintenance
  { key: "coa", label: "Chart of Accounts", icon: <List className="h-4 w-4" />, group: "Maintenance" },
  { key: "labor", label: "Labour", icon: <Users className="h-4 w-4" />, group: "Maintenance" },
  { key: "stock", label: "Stock", icon: <List className="h-4 w-4" />, group: "Maintenance" },
  { key: "stockmap", label: "Stock Mapping", icon: <List className="h-4 w-4" />, group: "Maintenance" },
  { key: "openstock", label: "Opening Stock", icon: <Scale className="h-4 w-4" />, group: "Maintenance" },
  { key: "stocktake", label: "Stock Take", icon: <Scale className="h-4 w-4" />, group: "Maintenance" },
  { key: "opening", label: "Opening Balance", icon: <Scale className="h-4 w-4" />, group: "Maintenance" },
  { key: "audit", label: "Audit Log", icon: <FileText className="h-4 w-4" />, group: "Maintenance" },
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
    <div className="space-y-6 max-md:space-y-4">
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
          {tab === "audit" && <AuditLogTab />}
          {tab === "trend" && <MonthlyTrendTab />}
          {tab === "plmonthly" && <MonthlyPlTab />}
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
          {tab === "supplier-discount" && <SupplierDiscountTab />}
          {tab === "odebtor" && <OtherPartiesTab side="DEBTOR" />}
          {tab === "odebtorbills" && <OtherPartyBillsTab accounts={accounts} side="DEBTOR" />}
          {tab === "odebtorpay" && <OtherPartyPaymentsTab accounts={accounts} side="DEBTOR" />}
          {tab === "ocreditor" && <OtherPartiesTab side="CREDITOR" />}
          {tab === "ocreditorbills" && <OtherPartyBillsTab accounts={accounts} side="CREDITOR" />}
          {tab === "ocreditorpay" && <OtherPartyPaymentsTab accounts={accounts} side="CREDITOR" />}
          {tab === "payments" && <PaymentsTab accounts={accounts} />}
          {tab === "receipts" && <ReceiptsTab accounts={accounts} />}
          {tab === "transfer" && <FundTransferTab accounts={accounts} />}
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
          {tab === "openstock" && <OpeningStockTab />}
          {tab === "stocktake" && <StockTakeTab />}
          {tab === "maint" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-[#1F1D1B]">Account Maintenance</h2>
              <GstRateCard />
              <FyeCard />
              <CleanupReportCard />
              <LandedCostCard />
              <DocNumberingCard accounts={accounts} />
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
  const { confirm } = useConfirm();
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
    if (!(await confirm({ title: "Post contra?", message: `Contra ${formatCurrency(totalSen)} of payables against this customer's oldest unpaid invoices?`, danger: true }))) return;
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
            <div className="overflow-x-auto">
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
            </div>
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
          <div className="overflow-x-auto">
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DocNumberingCard({ accounts }: { accounts: ChartOfAccount[] }) {
  const { toast } = useToast();
  const [map, setMap] = useState<Record<string, { out: string; in: string }>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    fetch("/api/accounting/doc-number-prefixes")
      .then((r) => r.json() as Promise<{ data?: { map?: Record<string, { out?: string; in?: string }> } }>)
      .then((j) => {
        const m = j?.data?.map ?? {};
        const norm: Record<string, { out: string; in: string }> = {};
        for (const [k, v] of Object.entries(m)) norm[k] = { out: v?.out ?? "", in: v?.in ?? "" };
        setMap(norm);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  const banks = accounts.filter((a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH");
  const setField = (code: string, dir: "out" | "in", val: string) => {
    setMap((prev) => ({ ...prev, [code]: { out: prev[code]?.out ?? "", in: prev[code]?.in ?? "", [dir]: val } }));
  };
  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/accounting/doc-number-prefixes", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ map }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (j?.success) toast.success("Numbering prefixes saved"); else toast.error(j?.error || "Save failed");
    } catch { toast.error("Save failed"); } finally { setSaving(false); }
  };
  return (
    <Card className="mb-4">
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-2">
          <h3 className="text-sm font-semibold text-[#1F1D1B]">Document Numbering</h3>
          <Button variant="primary" size="sm" onClick={save} disabled={saving || !loaded} className="ml-auto">{saving ? "Saving…" : "Save"}</Button>
        </div>
        <p className="text-[11px] text-[#9CA3AF] mb-3">Number = prefix + voucher month + running no. Outgoing (Expense / Supplier payment) uses the OUT prefix; incoming (Customer payment / Receipt) uses the IN prefix. Per bank.</p>
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[12px] text-[#6B7280]">
              <td className="text-left pb-1">Bank / Cash account</td>
              <td className="text-left pb-1 w-40">OUT prefix (payments)</td>
              <td className="text-left pb-1 w-40">IN prefix (receipts)</td>
            </tr>
          </thead>
          <tbody>
            {banks.map((a) => (
              <tr key={a.code} className="border-t border-[#F0ECE9]">
                <td className="py-1.5"><span className="tabular-nums text-xs text-[#6B7280] mr-2">{a.code}</span>{a.name}</td>
                <td className="py-1.5"><input value={map[a.code]?.out ?? ""} onChange={(e) => setField(a.code, "out", e.target.value)} placeholder="e.g. HPV" className="w-32 rounded border border-[#E2DDD8] px-2 py-1 text-sm" /></td>
                <td className="py-1.5"><input value={map[a.code]?.in ?? ""} onChange={(e) => setField(a.code, "in", e.target.value)} placeholder="e.g. HOR" className="w-32 rounded border border-[#E2DDD8] px-2 py-1 text-sm" /></td>
              </tr>
            ))}
            {banks.length === 0 && <tr><td colSpan={3} className="py-3 text-[#9CA3AF] text-sm">No bank/cash accounts (SBK/SCH).</td></tr>}
          </tbody>
        </table>
        </div>
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

// =============== TAB: OPENING STOCK (F6 — material-cost FIFO seed) ===============
//
// Maintenance grid where the owner fills the per-material cutover layer the
// FIFO cost engine seeds from: opening quantity + unit cost as of the switch
// date. Fill once; later months roll forward automatically (this month's
// closing becomes next month's opening). Amounts entered in RM, stored as
// integer sen; quantity is a plain number. Rows are dual-keyed on read.
type OpeningStockApiRow = {
  id: string;
  itemCode: string;
  description: string;
  itemGroup: string;
  baseUOM: string;
  qty: number | null;
  unitCostSen: number | null;
  asOfDate: string | null;
};

// WIP / Finished Goods use the SAME stock_take table + override semantics as the
// material groups (owner 2026-07-01: "wip 和fg 有两种性质...按save 的时候时0，那么他
// 就根据我之前的逻辑去算（用消耗），如果我save时有amount,那么他就根据我提供的数额录入") —
// item_group = the literal string "WIP" / "FG" (materialWindow reads them the same
// way as any material-group override). Rendered as a separate small section so the
// owner doesn't mistake them for material groups.
const WIP_FG_KEYS = ["WIP", "FG"] as const;
const WIP_FG_LABELS: Record<string, string> = { WIP: "Work-in-Progress (WIP)", FG: "Finished Goods (FG)" };

// <select> values are always strings, so "ignore this line" (item_group = null in
// stock_take_item_alias) needs a sentinel string in the "needs mapping" picker.
const STOCK_TAKE_IGNORE_VALUE = "__IGNORE__";

// Month-end stock-take entry (owner periodic-inventory option). Per material-group
// closing value at a month-end → the P&L uses it as that month's closing (and the
// next month's opening) instead of the FIFO/BOM value. Reuses /material-opening-stock
// for the group list; saves via PUT /stock-take.
function StockTakeTab() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [groups, setGroups] = useState<string[] | null>(null);
  const [entries, setEntries] = useState<{ itemGroup: string; ym: string; valueSen: number }[]>([]);
  const [ym, setYm] = useState(() => new Date().toISOString().slice(0, 7));
  // Edits keyed by `${ym}::${itemGroup}` (not by group alone) so switching the
  // month never needs an effect to reset stale values from another month — the
  // displayed value is derived straight from state + `entries` on every render.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // Periodic-inventory switch (owner rule 2026-07-03): 'stock_take_only' turns
  // OFF the BOM/FIFO auto-consumption — closing = latest count + purchases since.
  const [rmMode, setRmMode] = useState<"auto" | "stock_take_only" | null>(null);
  const [modeSaving, setModeSaving] = useState(false);

  useEffect(() => {
    let stale = false;
    Promise.all([
      fetch("/api/accounting/material-opening-stock").then((r) => r.json() as Promise<{ data?: { itemGroup: string }[] }>),
      fetch("/api/accounting/stock-take").then((r) => r.json() as Promise<{ data?: { itemGroup: string; ym: string; valueSen: number }[]; rmValuationMode?: "auto" | "stock_take_only" }>),
    ])
      .then(([mos, st]) => {
        if (stale) return;
        setGroups([...new Set((mos.data ?? []).map((r) => r.itemGroup).filter(Boolean))].sort());
        setEntries(st.data ?? []);
        setRmMode(st.rmValuationMode ?? "auto");
      })
      .catch(() => {});
    return () => { stale = true; };
  }, []);

  const saveMode = async (mode: "auto" | "stock_take_only") => {
    if (mode === rmMode) return;
    setModeSaving(true);
    try {
      const res = await fetch("/api/accounting/rm-valuation-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (j?.success) {
        setRmMode(mode);
        toast.success(
          mode === "stock_take_only"
            ? "Raw-material valuation switched to stock-take only — no automatic BOM/FIFO consumption."
            : "Raw-material valuation switched back to automatic (BOM/FIFO).",
        );
      } else toast.error(j?.error || "Failed to switch valuation mode");
    } catch {
      toast.error("Failed to switch valuation mode");
    } finally {
      setModeSaving(false);
    }
  };

  const key = (g: string) => `${ym}::${g}`;
  const savedFor = (g: string) => entries.find((e) => e.ym === ym && e.itemGroup === g);
  const valueFor = (g: string): string => {
    const edited = edits[key(g)];
    if (edited != null) return edited;
    const saved = savedFor(g);
    return saved ? (saved.valueSen / 100).toFixed(2) : "";
  };
  const setValueFor = (g: string, v: string) => setEdits((p) => ({ ...p, [key(g)]: v }));
  // Material groups + WIP/FG together — the set save()/Export/Import actually operate
  // over. The JSX renders them as two visually separate tables, but they share one
  // Save action and one Excel round trip.
  const allRowGroups = groups ? [...groups, ...WIP_FG_KEYS] : null;

  // Raw (uncategorized) monthly stock-count import (owner rule 2026-07-01; design
  // doc docs/superpowers/specs/2026-07-01-stock-take-item-alias-import-design.md).
  // rawImportItems = every physical line parsed from the LAST raw import (whether
  // resolved or not); rawImportResolutions maps item_key -> assigned group (or
  // null = "ignore this line"), seeded from the fetched alias table and grown as
  // the owner assigns any unrecognised lines below. A key ABSENT from this record
  // still needs a decision — that's what blocks Save and what the "needs mapping"
  // panel lists.
  const [rawImportItems, setRawImportItems] = useState<ParsedRawItem[] | null>(null);
  const [rawImportResolutions, setRawImportResolutions] = useState<Record<string, string | null>>({});
  const rawNeedsMapping = rawImportItems ? rawImportItems.filter((it) => !(it.key in rawImportResolutions)) : [];

  // Re-derives each touched group's grid value from scratch (SUM of every
  // resolved-non-ignored item mapping to it) — never additive — so re-resolving
  // one item, or re-importing, can never double-count. Returns how many distinct
  // groups this import actually touches.
  const applyRawResolutions = (items: ParsedRawItem[], resolutions: Record<string, string | null>) => {
    const sumsByGroup = new Map<string, number>();
    for (const it of items) {
      const g = resolutions[it.key];
      if (g == null) continue; // unresolved (absent) or explicitly ignored (null)
      sumsByGroup.set(g, (sumsByGroup.get(g) ?? 0) + it.totalSen);
    }
    for (const [g, sen] of sumsByGroup) setValueFor(g, (sen / 100).toFixed(2));
    return sumsByGroup.size;
  };

  const resolveRawItem = (itemKey: string, group: string | null) => {
    if (!rawImportItems) return;
    const next = { ...rawImportResolutions, [itemKey]: group };
    setRawImportResolutions(next);
    applyRawResolutions(rawImportItems, next);
  };

  // One-time seed: loads the ~230 (item -> group) pairs already confirmed with
  // the owner this session (derived from their 30/05/2026 file) so day-one raw
  // imports need no manual mapping. Dry-run -> confirm -> real POST, same
  // pattern as the Purchase Invoices "Post to GL" button. Safe to click more
  // than once (idempotent; existing aliases are left alone unless overwritten).
  const [seeding, setSeeding] = useState(false);
  const runAliasSeed = async () => {
    setSeeding(true);
    try {
      const dry = (await (await fetch("/api/accounting/stock-take-item-alias-seed?dry=1", { method: "POST" })).json()) as {
        success?: boolean; error?: string; inserted?: number; skippedAlreadyPresent?: number; totalSeedPairs?: number;
      };
      if (!dry?.success) { toast.error(dry?.error || "Preview failed"); return; }
      if (!dry.inserted) {
        toast.success(`Already up to date — all ${dry.totalSeedPairs ?? 0} seeded item mappings are already remembered.`);
        return;
      }
      const ok = await confirm({
        title: "Load remembered item mappings",
        message: `Load ${dry.inserted} item->group mapping(s) confirmed this session (of ${dry.totalSeedPairs ?? 0} total; ${dry.skippedAlreadyPresent ?? 0} already known)? This is one-time setup so future raw stock-take imports resolve automatically.`,
        danger: false,
      });
      if (!ok) return;
      const real = (await (await fetch("/api/accounting/stock-take-item-alias-seed", { method: "POST" })).json()) as {
        success?: boolean; error?: string; inserted?: number;
      };
      if (real?.success) toast.success(`Loaded ${real.inserted ?? 0} item mapping(s).`);
      else toast.error(real?.error || "Failed to load mappings");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load mappings");
    } finally {
      setSeeding(false);
    }
  };

  // Excel round trip (owner 2026-07-01): "upload it, but still be able to
  // manually adjust" — Export downloads the current on-screen values as a
  // template; Import parses a file back into `edits` (prefilling the grid,
  // NOT auto-saving) so the owner reviews/tweaks before hitting Save. Column
  // lookup is by header NAME (not position) so reordering columns in Excel
  // doesn't break the import — same pattern as WIP Times' bulk import.
  const handleExportTemplate = async () => {
    if (!allRowGroups) return;
    const aoa: (string | number)[][] = [
      ["Material Group", "Closing Stock (RM)"],
      ...allRowGroups.map((g) => [g, valueFor(g)] as (string | number)[]),
    ];
    await exportReportXlsx(`stock-take-${ym}.xlsx`, "Stock Take", aoa);
  };

  const [importing, setImporting] = useState(false);
  const handleImportFile = async (file: File) => {
    if (!allRowGroups) return;
    setImporting(true);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) { toast.error("Workbook has no sheets"); return; }
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1 });
      if (aoa.length < 2) { toast.error("No data rows after the header"); return; }
      const headerRow = aoa[0] as unknown[];

      // Safety check (owner 2026-07-01): a May-dated file was once saved under July
      // because the Month picker still showed today's month, not the file's. If the
      // filename names a different month than what's selected, stop and ask BEFORE
      // touching anything. On confirm, switch the month and ask for a re-import
      // (rather than continuing this same call) — `ym` is a state value, so it
      // wouldn't actually reflect the new month until next render if we pressed on.
      const impliedYm = impliedYmFromFilename(file.name);
      if (impliedYm && impliedYm !== ym) {
        const switchMonth = await confirm({
          title: "Check the month",
          message: `"${file.name}" looks like it's for ${impliedYm}, but Month is set to ${ym}. Switch to ${impliedYm}?`,
          danger: false,
        });
        if (switchMonth) {
          setYm(impliedYm);
          toast.success(`Switched to ${impliedYm} — click Import Excel again to load into the correct month.`);
          return;
        }
        // Owner explicitly chose to keep the currently-selected month — proceed below.
      }

      // Shape 1: the clean "Material Group" / "Closing Stock (RM)" template (this
      // page's own Export Excel round trip) — unchanged from before.
      if (isCleanImportShape(headerRow)) {
        setRawImportItems(null);
        setRawImportResolutions({});
        const headers = headerRow.map((h) => (typeof h === "string" ? h.trim().toLowerCase() : ""));
        const findCol = (...names: string[]) => {
          for (const n of names) { const i = headers.indexOf(n.toLowerCase()); if (i >= 0) return i; }
          return -1;
        };
        const colGroup = findCol("Material Group", "Group", "Item Group");
        const colValue = findCol("Closing Stock (RM)", "Closing Stock", "RM", "Value");
        const byGroupLower = new Map(allRowGroups.map((g) => [g.toLowerCase(), g]));
        let filled = 0;
        const unmatched: string[] = [];
        for (let i = 1; i < aoa.length; i++) {
          const row = aoa[i] as unknown[];
          if (!row || row.length === 0) continue;
          const rawGroup = typeof row[colGroup] === "string" ? (row[colGroup] as string).trim() : "";
          if (!rawGroup) continue;
          const raw = row[colValue];
          const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
          if (typeof raw === "string" && raw.trim() === "") continue; // blank = no change intended
          if (!Number.isFinite(n)) continue;
          const g = byGroupLower.get(rawGroup.toLowerCase());
          if (!g) { unmatched.push(rawGroup); continue; }
          setValueFor(g, n.toFixed(2));
          filled++;
        }
        if (filled === 0) {
          toast.error(unmatched.length ? `No matching material groups found (unrecognised: ${unmatched.slice(0, 5).join(", ")}).` : "No rows with a value to import.");
          return;
        }
        toast.success(`Filled ${filled} group${filled === 1 ? "" : "s"} from ${file.name} — review and Save.`);
        if (unmatched.length) toast.error(`${unmatched.length} row(s) didn't match a known material group: ${unmatched.slice(0, 5).join(", ")}${unmatched.length > 5 ? "…" : ""}`);
        return;
      }

      // Shape 2: the owner's raw monthly stock-count file (no category column,
      // layout varies) — resolve each physical line against the remembered
      // item-alias table; anything unrecognised goes to the "needs mapping" panel
      // below instead of being silently guessed (design doc 2026-07-01).
      const shape = detectRawShape(headerRow);
      if (!shape) {
        toast.error(
          `Missing required columns. Need either "Material Group" + "Closing Stock (RM)", ` +
            `or a "Total" column (your raw monthly stock-count file). Found: ${headerRow.filter(Boolean).join(", ") || "no headers"}.`,
        );
        return;
      }
      const items = parseRawStockTakeRows(aoa, shape);
      if (items.length === 0) { toast.error("No item rows found in this file."); return; }

      const aliasJson = (await (await fetch("/api/accounting/stock-take-item-aliases")).json()) as {
        data?: { itemKey: string; itemGroup: string | null }[];
      };
      const aliasMap = new Map((aliasJson.data ?? []).map((a) => [a.itemKey, a.itemGroup]));
      const resolutions: Record<string, string | null> = {};
      for (const it of items) if (aliasMap.has(it.key)) resolutions[it.key] = aliasMap.get(it.key) ?? null;

      const touchedGroups = applyRawResolutions(items, resolutions);
      setRawImportItems(items);
      setRawImportResolutions(resolutions);

      const unresolvedCount = items.filter((it) => !(it.key in resolutions)).length;
      toast.success(
        `Recognised ${items.length - unresolvedCount} of ${items.length} items from ${file.name} across ${touchedGroups} group(s) — review and Save.`,
      );
      if (unresolvedCount) {
        toast.error(`${unresolvedCount} item${unresolvedCount === 1 ? "" : "s"} need mapping below before you can Save.`);
      }
    } catch (err) {
      toast.error(humanizeError(err, "Import failed. Please check the file and try again."));
    } finally {
      setImporting(false);
    }
  };

  const save = async () => {
    if (!allRowGroups) return;
    if (!/^\d{4}-\d{2}$/.test(ym)) { toast.error("Pick a month first"); return; }
    if (rawNeedsMapping.length > 0) {
      toast.error(`${rawNeedsMapping.length} imported item${rawNeedsMapping.length === 1 ? "" : "s"} still need${rawNeedsMapping.length === 1 ? "s" : ""} a group below before you can Save.`);
      return;
    }
    const rows = allRowGroups
      .filter((g) => valueFor(g).trim() !== "")
      .map((g) => ({ itemGroup: g, valueSen: Math.round((parseFloat(valueFor(g)) || 0) * 100) }));
    // Every resolution from the last raw import (fetched-known + newly picked)
    // round-trips back so next month's import of the SAME items is automatic.
    // Re-upserting an already-known pair is a harmless no-op (idempotent).
    const newAliases = rawImportItems
      ? Object.entries(rawImportResolutions).map(([itemKey, itemGroup]) => ({ itemKey, itemGroup }))
      : undefined;
    setSaving(true);
    try {
      const res = await fetch("/api/accounting/stock-take", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ym, rows, ...(newAliases ? { newAliases } : {}) }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string; saved?: number; cleared?: number; aliasesSaved?: number };
      if (j?.success) {
        const saved = j.saved ?? rows.filter((r) => r.valueSen > 0).length;
        const cleared = j.cleared ?? 0;
        toast.success(
          `Stock-take saved for ${ym}: ${saved} group${saved === 1 ? "" : "s"} set` +
            (cleared ? `, ${cleared} reverted to automatic` : "") +
            (j.aliasesSaved ? `, ${j.aliasesSaved} item mapping${j.aliasesSaved === 1 ? "" : "s"} remembered` : ""),
        );
        // Zero-valued rows were DELETED server-side (= automatic) — drop them from
        // the local cache too so a re-render shows blank, not a stale "0.00".
        setEntries((prev) => [
          ...prev.filter((e) => e.ym !== ym),
          ...rows.filter((r) => r.valueSen > 0).map((r) => ({ ...r, ym })),
        ]);
        setRawImportItems(null);
        setRawImportResolutions({});
      } else toast.error(j?.error || "Failed to save stock-take");
    } catch {
      toast.error("Failed to save stock-take");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Month-End Stock Take</h2>
          <p className="text-xs text-[#6B7280] max-w-3xl">
            Enter the closing stock value per material group at each month-end. The P&amp;L
            uses it as that month&apos;s closing (and the next month&apos;s opening), so material
            cost works without a full BOM. Leave a group blank OR enter 0 to keep the
            system&apos;s automatic (FIFO) figure — only a positive amount overrides it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={runAliasSeed}
            disabled={seeding}
            title="One-time setup: loads the item->group mappings already confirmed this session, so raw stock-take imports resolve automatically from day one. Safe to click more than once."
          >
            {seeding ? "Loading…" : "Load Item Mappings"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportTemplate} disabled={!allRowGroups}>
            <Download className="h-4 w-4 mr-1.5" /> Export Excel
          </Button>
          <label
            className="inline-flex items-center h-8 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm text-[#1F1D1B] hover:bg-[#F0ECE9] cursor-pointer"
            title='Fill "Closing Stock (RM)" in the exported Excel, then upload it back here — it fills the grid below (nothing is saved yet), so you can still review or adjust before hitting Save.'
          >
            <Upload className="h-4 w-4 mr-1.5" />
            {importing ? "Importing…" : "Import Excel"}
            <input
              type="file"
              accept=".xlsx,.xls"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Reset so re-picking the same filename (edited + re-saved) still fires onChange.
                e.target.value = "";
                if (f) void handleImportFile(f);
              }}
            />
          </label>
          <Button variant="primary" size="sm" onClick={save} disabled={saving || !allRowGroups}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <Card>
        <CardContent className="p-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[16rem] flex-1">
            <div className="text-sm font-medium text-[#1F1D1B]">Closing-stock source</div>
            <p className="text-xs text-[#6B7280] mt-0.5 max-w-3xl">
              {rmMode === "stock_take_only"
                ? "Stock take only: each month-end shows exactly what you imported for that month — 0 when nothing is imported yet (the 30/04 opening seed counts as April). The system never computes stock or consumption on its own, so every nonzero figure is your own number."
                : "Automatic: the system computes consumption from BOM/FIFO; a stock-take entry overrides that month's closing where present."}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant={rmMode === "stock_take_only" ? "default" : "outline"}
              disabled={modeSaving || rmMode === null}
              onClick={() => void saveMode("stock_take_only")}
            >
              Stock take only
            </Button>
            <Button
              size="sm"
              variant={rmMode === "auto" ? "default" : "outline"}
              disabled={modeSaving || rmMode === null}
              onClick={() => void saveMode("auto")}
            >
              Automatic (BOM/FIFO)
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-[#6B7280]">Month (closes at month-end)</label>
              <input
                type="month"
                className="border border-[#E2DDD8] rounded-md px-3 py-2 text-sm"
                value={ym}
                onChange={(e) => setYm(e.target.value)}
              />
            </div>
          </div>
          {!groups ? (
            <p className="text-sm text-gray-400 italic">Loading…</p>
          ) : groups.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No material groups found.</p>
          ) : (
            <div className="border rounded-md overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Material Group</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Closing Stock (RM)</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g} className="border-t">
                      <td className="px-3 py-1.5">{g}</td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className="w-40 border border-[#E2DDD8] rounded-md px-2 py-1 text-sm text-right tabular-nums"
                          value={valueFor(g)}
                          onChange={(e) => setValueFor(g, e.target.value)}
                          placeholder="(auto / FIFO)"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* WIP / FG — same override semantics, kept visually separate from material
          groups since they're distinct P&L lines, not material groups. */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-[#1F1D1B]">Work-in-Progress / Finished Goods</h3>
            <p className="text-xs text-[#6B7280]">
              Same rule: blank or 0 = the system&apos;s automatic figure (from production
              consumption); a positive amount overrides it for this month.
            </p>
          </div>
          <div className="border rounded-md overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Line</th>
                  <th className="text-right px-3 py-2 font-medium text-gray-600">Closing Value (RM)</th>
                </tr>
              </thead>
              <tbody>
                {WIP_FG_KEYS.map((g) => (
                  <tr key={g} className="border-t">
                    <td className="px-3 py-1.5">{WIP_FG_LABELS[g]}</td>
                    <td className="px-3 py-1.5 text-right">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        className="w-40 border border-[#E2DDD8] rounded-md px-2 py-1 text-sm text-right tabular-nums"
                        value={valueFor(g)}
                        onChange={(e) => setValueFor(g, e.target.value)}
                        placeholder="(auto)"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Raw-import "needs mapping" review (owner rule 2026-07-01): items parsed
          from an uncategorized monthly file with no remembered group yet. Save
          is blocked while this list is non-empty. Assigning a group here fills
          the grid above immediately AND is remembered for every future import
          of the same physical item. */}
      {rawNeedsMapping.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-[#9A3A2D]">
                {rawNeedsMapping.length} item{rawNeedsMapping.length === 1 ? "" : "s"} need mapping
              </h3>
              <p className="text-xs text-[#6B7280]">
                These lines weren&apos;t recognised from a previous import. Pick a group (or
                Ignore for a non-stock line, e.g. a subtotal row) — remembered for every
                future month automatically. Save is blocked until all are resolved.
              </p>
            </div>
            <div className="border rounded-md overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Item</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Amount (RM)</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Assign to</th>
                  </tr>
                </thead>
                <tbody>
                  {rawNeedsMapping.map((it) => (
                    <tr key={it.key} className="border-t">
                      <td className="px-3 py-1.5">{it.description || "(blank)"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{(it.totalSen / 100).toFixed(2)}</td>
                      <td className="px-3 py-1.5">
                        <select
                          className="w-56 border border-[#E2DDD8] rounded-md px-2 py-1 text-sm"
                          value=""
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!v) return;
                            resolveRawItem(it.key, v === STOCK_TAKE_IGNORE_VALUE ? null : v);
                          }}
                        >
                          <option value="" disabled>
                            — choose —
                          </option>
                          <option value={STOCK_TAKE_IGNORE_VALUE}>Ignore (not a stock line)</option>
                          {allRowGroups?.map((g) => (
                            <option key={g} value={g}>
                              {g}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Measured height of one Opening Stock row on prod (py-1 around an h-10
// input). The windowing spacers are computed from this, so it must match the
// rendered row — the row carries it as an explicit `height` to keep them
// locked together.
const OPENING_STOCK_ROW_PX = 49;

function OpeningStockTab() {
  const { toast } = useToast();
  // Per-row editable state, keyed by raw-material id. qty/costRm are the live
  // input values (RM for cost); meta carries the read-only catalogue columns.
  type RowState = {
    id: string;
    itemCode: string;
    description: string;
    itemGroup: string;
    baseUOM: string;
    qty: number | null;
    costRm: number | null;
  };
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [asOfDate, setAsOfDate] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  // Every row carries two controlled inputs (qty + MoneyInput), so this table
  // is the most expensive in the module per row: 423 active materials meant
  // 846 mounted inputs, a 5.8s freeze on open and a 2.3s freeze on the FOURTH
  // keystroke in the search box (measured on prod 2026-08-01). The search term
  // is deferred so keystrokes paint immediately, and the body is windowed so
  // only the visible rows exist.
  const deferredSearch = useDeferredValue(search);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stale = false;
    fetch("/api/accounting/material-opening-stock")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: OpeningStockApiRow[] }>)
      .then((j) => {
        if (stale || !j?.success || !j.data) return;
        const data = j.data;
        setRows(
          data.map((r) => ({
            id: r.id,
            itemCode: r.itemCode,
            description: r.description,
            itemGroup: r.itemGroup,
            baseUOM: r.baseUOM,
            qty: r.qty ?? null,
            costRm: r.unitCostSen != null ? r.unitCostSen / 100 : null,
          })),
        );
        // Seed the global as-of date from the first material that already has
        // one, so re-opening the page shows the previously saved cutover date.
        const existing = data.find((r) => r.asOfDate)?.asOfDate ?? "";
        setAsOfDate(existing);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  const setCell = (id: string, field: "qty" | "costRm", v: number | null) =>
    setRows((prev) => (prev ? prev.map((r) => (r.id === id ? { ...r, [field]: v } : r)) : prev));

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = deferredSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.itemCode.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.itemGroup.toLowerCase().includes(q),
    );
  }, [rows, deferredSearch]);

  // 49px is the measured height of one row (py-1 around an h-10 input). It has
  // to match the rendered height or the spacer math drifts and the scrollbar
  // lies about how much is left.
  const virt = useVirtualRows({
    count: filtered.length,
    rowHeight: OPENING_STOCK_ROW_PX,
    scrollRef,
    colSpan: 6,
  });

  const save = async () => {
    if (!rows) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      toast.error("Pick an as-of date (the cutover day) before saving");
      return;
    }
    // Only send rows the owner actually filled (a qty or a cost). Each gets the
    // single global as-of date. RM → integer sen at the boundary.
    const payload = rows
      .filter((r) => r.qty != null || r.costRm != null)
      .map((r) => ({
        rmId: r.id,
        qty: r.qty ?? 0,
        unitCostSen: r.costRm != null ? Math.round(r.costRm * 100) : 0,
        asOfDate,
      }));
    setSaving(true);
    try {
      const res = await fetch("/api/accounting/material-opening-stock", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (j?.success) toast.success(`Opening stock saved (${payload.length} item${payload.length === 1 ? "" : "s"})`);
      else toast.error(humanizeError(j?.error) || "Failed to save opening stock");
    } catch {
      toast.error("Failed to save opening stock");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Opening Stock</h2>
          <p className="text-xs text-[#6B7280] max-w-3xl">
            Per-material cutover layer for the FIFO material-cost report: the
            quantity on hand and its unit cost as of the switch date. Fill once
            at cutover; later months roll automatically (this month&apos;s
            closing becomes next month&apos;s opening).
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={save} disabled={saving || !rows}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-[#6B7280]">As-of date (cutover)</label>
              <input
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
                className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] focus-visible:border-transparent"
              />
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
              <label className="text-xs text-[#6B7280]">Search</label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by code, description, or group…"
                className="h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] focus-visible:border-transparent"
              />
            </div>
          </div>

          {!rows ? (
            <div className="py-8 text-center text-[#6B7280] text-sm">Loading materials…</div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-[#6B7280] text-sm">
              {rows.length === 0 ? "No active raw materials found." : "No materials match your search."}
            </div>
          ) : (
            <>
            <div ref={scrollRef} className="overflow-auto max-h-[70vh]">
              <table className="text-sm w-full">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                    <th className="px-3 py-2 text-left">Item Code</th>
                    <th className="px-3 py-2 text-left">Description</th>
                    <th className="px-3 py-2 text-left">Group</th>
                    <th className="px-3 py-2 text-left">UOM</th>
                    <th className="px-3 py-2 text-right">Opening Qty</th>
                    <th className="px-3 py-2 text-right">Unit Cost (RM)</th>
                  </tr>
                </thead>
                <tbody>
                  {virt.topSpacer}
                  {(virt.active ? virt.indices.map((i) => filtered[i]) : filtered).map((r) =>
                    !r ? null : (
                    <tr key={r.id} className="border-b border-[#F0ECE9]" style={{ height: OPENING_STOCK_ROW_PX }}>
                      <td className="px-3 py-1.5 font-medium text-[#1F1D1B] whitespace-nowrap">{r.itemCode}</td>
                      <td className="px-3 py-1.5 text-[#1F1D1B]">{r.description}</td>
                      <td className="px-3 py-1.5 text-[#6B7280] whitespace-nowrap">{r.itemGroup || "—"}</td>
                      <td className="px-3 py-1.5 text-[#6B7280] whitespace-nowrap">{r.baseUOM || "—"}</td>
                      <td className="px-3 py-1 w-32">
                        <input
                          type="number"
                          inputMode="decimal"
                          step="any"
                          min={0}
                          value={r.qty ?? ""}
                          onChange={(e) => {
                            const v = e.target.value.trim();
                            setCell(r.id, "qty", v === "" ? null : Number(v));
                          }}
                          className="h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-right text-[#1F1D1B] placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] focus-visible:border-transparent"
                        />
                      </td>
                      <td className="px-3 py-1 w-32">
                        <MoneyInput
                          value={r.costRm}
                          onChange={(v) => setCell(r.id, "costRm", v)}
                          placeholder="0.00"
                        />
                      </td>
                    </tr>
                    ),
                  )}
                  {virt.bottomSpacer}
                </tbody>
              </table>
            </div>
            {/* Edits live in `rows`, never in the DOM, so windowing cannot lose
                a typed quantity: scrolling a row out of view unmounts its input
                but the value stays in state and still goes out on Save. */}
            <p className="text-xs text-[#9CA3AF]">
              {filtered.length} material{filtered.length === 1 ? "" : "s"}
              {search.trim() ? ` matching “${search.trim()}”` : ""}
            </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
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

// Measured height of one Chart-of-Accounts tree row on prod (py-2 row).
// Only used to size the DeferredBlock placeholder so the scrollbar holds
// steady while an off-screen section is unmounted.
const COA_ROW_PX = 37;

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
                {/* The CoA is 9 sections expanded by default; the whole tree
                    is ~5,100 DOM nodes on prod (each account is a draggable
                    row with nested handlers). No freeze — 218ms — but the
                    off-screen sections need not build until scrolled to. Each
                    row is ~37px; a placeholder holds the space so the page
                    height and drag targets stay correct once mounted. */}
                <DeferredBlock estimatedHeight={COA_ROW_PX * Math.max(1, typeAccounts.length)}>
                  <div className="border-t border-[#E2DDD8]">
                    {treeTops.map((node) => renderNode(node, 0))}
                  </div>
                </DeferredBlock>
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
  const { confirm } = useConfirm();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [selectedJvs, setSelectedJvs] = useState<JournalEntry[]>([]);

  // Owner 2026-07-28 (JE-2607-0001): this used to ignore the response entirely
  // — a rejected/aborted Post showed NOTHING and the entry silently stayed
  // DRAFT. Success and failure both speak now.
  const handlePost = async (id: string) => {
    try {
      const res = await fetch(`/api/accounting/journals/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "POSTED" }),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (res.ok && j?.success) toast.success("Journal entry posted");
      else toast.error(j?.error || "Couldn't post the journal entry — please try again.");
    } catch {
      toast.error("Couldn't post the journal entry — connection hiccup, please try again.");
    }
    onRefresh();
  };

  const handleLifecycle = async (id: string, entryNo: string, action: "void" | "delete" | "unvoid") => {
    const verb = action === "unvoid" ? "Restore" : action === "delete" ? "Delete" : "Void";
    const extra = action === "delete"
      ? " It will be hidden from the GL (still visible in the audit log)."
      : action === "void"
        ? " A reversal entry will be posted (nothing is deleted)."
        : "";
    if (!(await confirm({ title: `${verb} entry?`, message: `${verb} ${entryNo}?${extra}`, danger: true }))) return;
    try {
      const res = await fetch(`/api/accounting/journals/${id}/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json().catch(() => ({}));
        alert(humanizeError({ status: res.status, message: body?.error }, `Couldn't ${verb.toLowerCase()} the journal entry.`));
        return;
      }
      onRefresh();
    } catch (e) {
      alert(humanizeError(e, `Couldn't ${verb.toLowerCase()} the journal entry.`));
    }
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
        <span className="inline-flex items-center gap-1">
          <Badge variant="status" status={row.status}>
            {row.status}
          </Badge>
          <LifecycleBadge state={row.lifecycleState} />
        </span>
      ),
    },
    {
      key: "print",
      label: "",
      sortable: false,
      render: (value, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); printVoucher(buildJvVoucher(row)); }}
          title="Print journal voucher"
          className="inline-flex items-center gap-1 text-[#6B5C32] hover:text-[#1F1D1B] text-xs underline decoration-dotted cursor-pointer"
        >
          <Printer className="h-3 w-3" />print
        </button>
      ),
    },
  ];

  const contextMenuItems = (row: JournalEntry): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: "View", action: () => {} },
      { label: "Print voucher", action: (r) => printVoucher(buildJvVoucher(r)) },
    ];
    if (row.status === "DRAFT") {
      items.push({ label: "Post", action: (r) => handlePost(r.id) });
      items.push({ label: "Delete", danger: true, action: (r) => handleDelete(r.id) });
    } else {
      // Posted (or already reversed) — drive lifecycle off document state.
      const state = row.lifecycleState ?? "ACTIVE";
      if (state === "ACTIVE") {
        items.push({ label: "Void", action: (r) => handleLifecycle(r.id, r.entryNo, "void") });
        items.push({ label: "Delete", danger: true, action: (r) => handleLifecycle(r.id, r.entryNo, "delete") });
      } else if (state === "VOID") {
        items.push({ label: "Unvoid", action: (r) => handleLifecycle(r.id, r.entryNo, "unvoid") });
        items.push({ label: "Delete", danger: true, action: (r) => handleLifecycle(r.id, r.entryNo, "delete") });
      }
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

      <BatchActionsBar
        count={selectedJvs.length}
        onPrint={() => printVouchers(selectedJvs.map(buildJvVoucher))}
        exportName="journal-vouchers"
        exportAoa={() => [
          ["Entry No", "Date", "Description", "Status", "Voucher Total (RM)", "Account Code", "Account Name", "Line Description", "Debit (RM)", "Credit (RM)"],
          ...selectedJvs.flatMap((r) => {
            const vt = r.lines.reduce((s, l) => s + (Number(l.debitSen) || 0), 0);
            return r.lines.map((l) => [
              r.entryNo ?? r.id,
              r.date ?? "",
              r.description ?? "",
              r.status ?? "",
              (vt / 100).toFixed(2),
              l.accountCode,
              l.accountName ?? "",
              l.description ?? "",
              l.debitSen ? (Number(l.debitSen) / 100).toFixed(2) : "",
              l.creditSen ? (Number(l.creditSen) / 100).toFixed(2) : "",
            ]);
          }),
        ]}
      />

      <Card>
        <CardContent className="p-4">
          <DataGrid
            columns={columns}
            data={journals}
            keyField="id"
            virtualize
            gridId="accounting-journals"
            contextMenuItems={contextMenuItems}
            selectable
            onSelectionChange={setSelectedJvs}
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

          {/* Lines Table — no overflow wrapper: it would clip the AccountPicker
              dropdown vertically (overflow-x:auto forces overflow-y:auto). */}
          <div>
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
                  <tr
                    key={line._uid}
                    className="border-b border-[#F0ECE9]"
                    onKeyDown={(e) => {
                      if (e.key === "Insert") {
                        e.preventDefault();
                        setLines([...lines.slice(0, idx + 1), newRow(), ...lines.slice(idx + 1)]);
                      }
                    }}
                  >
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
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={addLine}>
                <Plus className="h-3.5 w-3.5" /> Add Line
              </Button>
              <span className="text-[11px] text-[#B4B2A9]">press <span className="font-medium text-[#6B7280]">Insert</span> to add a line below</span>
            </div>
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
function ARControlPanel({ company = "" }: { company?: string }) {
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

  // Multi-company (Phase 2): scope the control reconciliation to the selected
  // company. Absent (group) → URL unchanged = today's consolidated numbers.
  const [ctlRev, setCtlRev] = useState(0);
  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/ar-control${company ? `?orgId=${encodeURIComponent(company)}` : ""}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: typeof data }>)
      .then((j) => { if (!stale && j?.success && j.data) setData(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [company, ctlRev]);

  // One-shot counter rebuild (owner request 2026-07-06): reset every
  // customer's running counter to its invoice-derived outstanding.
  const { toast: ctlToast } = useToast();
  const { confirm: ctlConfirm } = useConfirm();
  const [rebuilding, setRebuilding] = useState(false);
  const rebuildCounter = async () => {
    if (!(await ctlConfirm({
      title: "Recalculate customer counters?",
      message: "Reset every customer's running counter to its invoice-derived outstanding (the same figure as the middle card). The old counter values are overwritten; the action is logged in the Audit Log.",
      danger: false,
    }))) return;
    setRebuilding(true);
    try {
      const res = await fetch("/api/accounting/ar-control/rebuild-counter", { method: "POST" });
      const j = (await res.json()) as { success?: boolean; error?: string; data?: { customersUpdated: number; beforeSen: number; afterSen: number } };
      if (j?.success && j.data) {
        ctlToast.success(`Counter rebuilt: ${j.data.customersUpdated} customer(s) updated, ${formatCurrency(j.data.beforeSen - j.data.afterSen)} of drift cleared.`);
        setCtlRev((n) => n + 1);
      } else ctlToast.error(j?.error || "Failed to rebuild the counter");
    } catch {
      ctlToast.error("Failed to rebuild the counter");
    } finally {
      setRebuilding(false);
    }
  };

  useEffect(() => {
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
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-[#6B7280]">Customer running counter (outstandingSen)</p>
                <Button variant="outline" size="sm" onClick={() => void rebuildCounter()} disabled={rebuilding} title="Reset every customer's counter to its invoice-derived outstanding (audited)">
                  {rebuilding ? "Recalculating…" : "Recalculate"}
                </Button>
              </div>
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
  // Expandable detail (owner 2026-07-08): click a row to show every open
  // document in its aging column — the old system's "Aging - Detail" layout.
  const [openAging, setOpenAging] = useState<Set<string>>(new Set());
  const toggleAging = (id: string) =>
    setOpenAging((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Multi-company (Phase 2): "" = All companies (group). The consolidated
  // aging arrives via the arData prop (unchanged). Picking a company fetches
  // a company-scoped /aging locally and shows that instead — additive, the
  // group path is untouched.
  const [company, setCompany] = useState("");
  const companyOptions = useCompanyOptions();
  const [scopedAr, setScopedAr] = useState<ARAgingEntry[] | null>(null);
  // Clearing scoped state on de-select happens in the selector's onChange (not
  // in the effect) to keep the effect side-effect-free per lint.
  const pickCompany = (v: string) => { setCompany(v); if (!v) setScopedAr(null); };
  useEffect(() => {
    if (!company) return;
    let stale = false;
    fetch(`/api/accounting/aging?orgId=${encodeURIComponent(company)}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { ar: ARAgingEntry[] } }>)
      .then((j) => { if (!stale && j?.success && j.data) setScopedAr(j.data.ar ?? []); })
      .catch(() => {});
    return () => { stale = true; };
  }, [company]);
  const rows = company ? (scopedAr ?? []) : arData;

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

  const totalOutstanding = rows.reduce(
    (s, a) => s + a.currentSen + a.days30Sen + a.days60Sen + a.days90Sen + a.over90Sen,
    0
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <CompanySelect value={company} onChange={pickCompany} options={companyOptions} />
      </div>
      <ARControlPanel company={company} />
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Accounts Receivable</h2>
          <p className="text-sm text-[#6B7280]">Total Outstanding: <span className="font-semibold text-[#9C6F1E]">{formatCurrency(totalOutstanding)}</span></p>
        </div>
        <ExportButtons
          build={() => buildAgingExportAoa("Customer", rows.map((a) => ({
            name: a.customerName, currentSen: a.currentSen, days30Sen: a.days30Sen,
            days60Sen: a.days60Sen, days90Sen: a.days90Sen, over90Sen: a.over90Sen, docs: a.docs,
          })))}
          filenameBase={`debtor-aging-${new Date().toISOString().slice(0, 10)}${company ? `-${company}` : ""}`}
          title="Debtor Aging (AR)" pdfOpts={{ rowKind: agingRowKind, leftCols: [1, 2], colWidths: { 0: 168, 1: 62, 2: 118, 3: 66, 4: 66, 5: 66, 6: 66, 7: 66, 8: 78 } }} moneyFormat
          subtitle={`As at ${new Date().toISOString().slice(0, 10)}${company ? ` · ${company}` : " · All companies"}`}
        />
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
                {rows.map((ar) => {
                  const total = ar.currentSen + ar.days30Sen + ar.days60Sen + ar.days90Sen + ar.over90Sen;
                  const open = openAging.has(ar.customerId);
                  return (
                    <Fragment key={ar.customerId}>
                    <tr className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/30">
                      <td className="py-3 px-4 font-medium text-[#1F1D1B]">
                        <button className="inline-flex items-center gap-1.5 text-left" onClick={() => toggleAging(ar.customerId)} title="Show the documents behind this balance">
                          {open ? <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[#6B5C32]" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#6B5C32]" />}
                          {ar.customerName}
                        </button>
                      </td>
                      <td className={`py-3 px-4 text-right ${ar.currentSen < 0 ? "text-[#9A3A2D]" : ""}`}>{ar.currentSen !== 0 ? formatCurrency(ar.currentSen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ar.days30Sen < 0 ? "text-[#9A3A2D]" : ""}`}>{ar.days30Sen !== 0 ? formatCurrency(ar.days30Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ar.days60Sen < 0 ? "text-[#9A3A2D]" : ar.days60Sen > 0 ? "text-[#9C6F1E]" : ""}`}>{ar.days60Sen !== 0 ? formatCurrency(ar.days60Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ar.days90Sen < 0 ? "text-[#9A3A2D]" : ar.days90Sen > 0 ? "text-[#B8601A] font-medium" : ""}`}>{ar.days90Sen !== 0 ? formatCurrency(ar.days90Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ar.over90Sen !== 0 ? "text-[#9A3A2D] font-medium" : ""}`}>{ar.over90Sen !== 0 ? formatCurrency(ar.over90Sen) : "-"}</td>
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
                    {open && (ar.docs ?? []).map((d, i) => (
                      <tr key={`d-${i}`} className="border-b border-[#F7F4F1] bg-[#FAF8F6] text-xs">
                        <td className="py-1.5 px-4 pl-10 text-[#6B7280]"><span className="tabular-nums text-[#9CA3AF]">{d.date}</span><span className="ml-4">{d.no}</span></td>
                        {[0, 1, 2, 3, 4].map((b) => (
                          <td key={b} className={`py-1.5 px-4 text-right tabular-nums ${d.amountSen < 0 ? "text-[#9A3A2D]" : "text-[#4B5563]"}`}>
                            {d.mo === b ? formatCurrency(d.amountSen) : ""}
                          </td>
                        ))}
                        <td className={`py-1.5 px-4 text-right tabular-nums font-medium ${d.amountSen < 0 ? "text-[#9A3A2D]" : "text-[#4B5563]"}`}>{formatCurrency(d.amountSen)}</td>
                        <td></td>
                      </tr>
                    ))}
                    {open && !(ar.docs ?? []).length && (
                      <tr className="border-b border-[#F7F4F1] bg-[#FAF8F6] text-xs">
                        <td colSpan={8} className="py-1.5 px-4 pl-10 text-[#9CA3AF] italic">No document detail (refresh after the next aging rebuild)</td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9]/50 font-semibold">
                  <td className="py-3 px-4 text-[#1F1D1B]">Total</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(rows.reduce((s, a) => s + a.currentSen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(rows.reduce((s, a) => s + a.days30Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(rows.reduce((s, a) => s + a.days60Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(rows.reduce((s, a) => s + a.days90Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(rows.reduce((s, a) => s + a.over90Sen, 0))}</td>
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
                Record Payment - {rows.find((a) => a.customerId === paymentForm)?.customerName}
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
// Mirror of ARControlPanel for the payable side. NOTE: the third "supplier
// running counter (outstandingSen)" card was removed (2026-06-25) — suppliers
// .outstandingSen is never maintained on PI approve/pay, so it only ever showed
// a false drift. The real reconciliation is Creditor-control-ledger vs PI.
function APControlPanel({ company = "" }: { company?: string }) {
  const [data, setData] = useState<{
    controls: { code: string; name: string; balanceSen: number }[];
    tradeControlSen: number;
    piOutstandingSen: number;
    unappliedAdvanceSen?: number;
    netOutstandingSen?: number;
    driftControlVsPiSen: number;
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
  // Multi-company (Phase 2): scope the creditor-control reconciliation to the
  // selected company. Absent (group) → URL unchanged = consolidated numbers.
  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/ap-control${company ? `?orgId=${encodeURIComponent(company)}` : ""}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: typeof data }>)
      .then((j) => { if (!stale && j?.success && j.data) setData(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [company]);
  useEffect(() => {
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
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280]">Creditor control (ledger{data.controls.filter((x) => x.code !== "405-0000").map((x) => ` ${x.code}`).join(",")})</p>
              <p className="text-xl font-bold text-[#9A3A2D]">{formatCurrency(data.tradeControlSen)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280]">Net owed to suppliers (bills − advances)</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{formatCurrency(data.netOutstandingSen ?? data.piOutstandingSen)}</p>
              <div className="mt-1 flex items-center gap-2 flex-wrap">
                {drift(data.driftControlVsPiSen)}
                {(data.unappliedAdvanceSen ?? 0) > 0 && (
                  <span className="text-xs text-[#6B7280]">
                    bills {formatCurrency(data.piOutstandingSen)} − un-knocked advances {formatCurrency(data.unappliedAdvanceSen ?? 0)}
                  </span>
                )}
              </div>
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
    </div>
  );
}

// =============== TAB: SUPPLIER DISCOUNT ===============
//
// Replaces the buried "purchase credit note" form that used to live inside
// APControlPanel. The owner records a supplier discount/credit (net + optional
// SST) and OPTIONALLY knocks it off one / many / none of that supplier's
// unpaid purchase invoices (PIs).
//
// Save flow = CREATE then POST: POST creates a DRAFT credit note and returns
// its id, then we immediately PUT { status:"POSTED", allocations } to post +
// allocate it. allocations may be empty (record-only). The backend
// validates every allocation (≤ each PI's outstanding, Σ ≤ the CN total) and
// returns 400 on a bad one — we surface that error via toast. A left-behind
// DRAFT (PUT failed) is harmless, so we do NOT auto-retry.
//
// Money is integer sen everywhere (RM × 100 via Math.round). UI is English.

type SDSupplier = { id: string; code: string; name: string; isActive?: boolean };

// Open PI for the selected supplier — same shape supplier-payments.tsx reads.
type SDOpenPI = {
  id: string;
  piNo: string;
  invoiceDate: string;
  amountSen: number;
  paidAmountSen: number;
};

type SDHistoryRow = {
  id: string;
  noteNumber: string;
  supplierName: string;
  date: string;
  reason: string;
  totalAmount: number;
  status: string;
  piNo?: string;
};

// Per-PI allocation row state: ticked + the raw RM string the operator typed.
type SDAllocRow = { checked: boolean; amountStr: string };

function SupplierDiscountTab() {
  const { toast } = useToast();
  const { confirm } = useConfirm();

  // Suppliers (active only) for the picker.
  const [suppliers, setSuppliers] = useState<SDSupplier[]>([]);
  const [supplierId, setSupplierId] = useState("");

  // Inputs.
  const [netRm, setNetRm] = useState("");
  const [sstRm, setSstRm] = useState("");
  const [reason, setReason] = useState("");

  // Open PIs for the picked supplier + per-PI allocation rows (keyed by PI id).
  const [openPIs, setOpenPIs] = useState<SDOpenPI[]>([]);
  const [loadingPIs, setLoadingPIs] = useState(false);
  const [allocRows, setAllocRows] = useState<Record<string, SDAllocRow>>({});

  const [saving, setSaving] = useState(false);

  // History list.
  const [history, setHistory] = useState<SDHistoryRow[]>([]);

  const loadHistory = useCallback(() => {
    fetch("/api/accounting/purchase-credit-notes")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: SDHistoryRow[] }>)
      .then((j) => { if (j?.success) setHistory(j.data ?? []); })
      .catch(() => {});
  }, []);

  // Hide orphan DRAFTs (a Save whose post leg failed) — the rows actually shown.
  const visibleHistory = history.filter((n) => n.status !== "DRAFT");
  const sdSel = useRowSelection(visibleHistory, (d) => d.noteNumber ?? d.id);

  useEffect(() => {
    fetch("/api/suppliers")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: SDSupplier[] }>)
      .then((j) => { if (j?.success) setSuppliers((j.data ?? []).filter((s) => s.isActive !== false)); })
      .catch(() => {});
    loadHistory();
  }, [loadHistory]);

  // On supplier change, fetch their open PIs (APPROVED / PARTIAL_PAID, then keep
  // only rows with outstanding > 0) — mirrors supplier-payments.tsx loadOpenPIs.
  const handleSupplierChange = (id: string) => {
    setSupplierId(id);
    setAllocRows({});
    if (!id) { setOpenPIs([]); return; }
    setLoadingPIs(true);
    fetch(`/api/purchase-invoices?supplierId=${encodeURIComponent(id)}&status=CONFIRMED,APPROVED,PARTIAL_PAID`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: SDOpenPI[] } | SDOpenPI[]>)
      .then((j) => {
        const raw = Array.isArray(j) ? j : j?.success ? j.data ?? [] : [];
        setOpenPIs(raw.filter((pi) => pi.amountSen - pi.paidAmountSen > 0));
      })
      .catch(() => setOpenPIs([]))
      .finally(() => setLoadingPIs(false));
  };

  const outstandingOf = (pi: SDOpenPI) => pi.amountSen - pi.paidAmountSen;

  const netSen = useMemo(() => {
    const n = Math.round(Number(netRm) * 100);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [netRm]);
  const sstSen = useMemo(() => {
    const n = Math.round(Number(sstRm) * 100);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [sstRm]);
  const discountTotalSen = netSen + sstSen;

  // Sen allocated by a single PI row (full-outstanding cap applied at submit too).
  const rowAllocSen = useCallback(
    (pi: SDOpenPI): number => {
      const row = allocRows[pi.id];
      if (!row || !row.checked) return 0;
      const n = Math.round(Number(row.amountStr) * 100);
      return Number.isFinite(n) && n > 0 ? n : 0;
    },
    [allocRows],
  );

  const allocatedSen = useMemo(
    () => openPIs.reduce((sum, pi) => sum + rowAllocSen(pi), 0),
    [openPIs, rowAllocSen],
  );
  const unallocatedSen = discountTotalSen - allocatedSen;

  const setRow = (id: string, patch: Partial<SDAllocRow>) =>
    setAllocRows((prev) => {
      const base: SDAllocRow = prev[id] ?? { checked: false, amountStr: "" };
      return { ...prev, [id]: { ...base, ...patch } };
    });

  // "Full" shortcut — tick the row and fill its outstanding (in RM).
  const fillFull = (pi: SDOpenPI) =>
    setRow(pi.id, { checked: true, amountStr: (outstandingOf(pi) / 100).toFixed(2) });

  const resetForm = () => {
    setSupplierId("");
    setNetRm("");
    setSstRm("");
    setReason("");
    setOpenPIs([]);
    setAllocRows({});
  };

  const canSave = !!supplierId && netSen > 0 && !saving;

  const handleSave = async () => {
    if (!supplierId) { toast.error("Select a supplier"); return; }
    if (!(netSen > 0)) { toast.error("Discount amount (net) must be greater than 0"); return; }

    // Build the allocations from the ticked rows; cap each at its outstanding.
    const allocations: { piId: string; amountSen: number }[] = [];
    for (const pi of openPIs) {
      const amt = rowAllocSen(pi);
      if (amt <= 0) continue;
      const cap = outstandingOf(pi);
      if (amt > cap) {
        toast.error(`${pi.piNo}: allocation exceeds outstanding (${formatCurrency(cap)})`);
        return;
      }
      allocations.push({ piId: pi.id, amountSen: amt });
    }
    if (allocatedSen > discountTotalSen) {
      toast.error(`Allocated (${formatCurrency(allocatedSen)}) exceeds the discount total (${formatCurrency(discountTotalSen)})`);
      return;
    }

    setSaving(true);
    try {
      // 1) CREATE the DRAFT credit note. items = net line (+ SST line if any).
      const items: { description: string; quantity: number; unitPriceSen: number; lineType: string }[] = [
        { description: reason || "Discount", quantity: 1, unitPriceSen: netSen, lineType: "STOCKED" },
      ];
      if (sstSen > 0) items.push({ description: "SST portion", quantity: 1, unitPriceSen: sstSen, lineType: "TAX" });

      const createRes = await fetch("/api/accounting/purchase-credit-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId, reason, items }),
      });
      const createJson = (await createRes.json()) as { success?: boolean; error?: string; data?: { id?: string } };
      if (!createRes.ok || !createJson.success || !createJson.data?.id) {
        toast.error(createJson.error || "Failed to create supplier discount");
        return;
      }
      const newId = createJson.data.id;

      // 2) POST + allocate. If this fails the DRAFT is harmless; do not retry.
      const postRes = await fetch(`/api/accounting/purchase-credit-notes/${encodeURIComponent(newId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "POSTED", allocations }),
      });
      const postJson = (await postRes.json()) as { success?: boolean; error?: string };
      if (!postRes.ok || !postJson.success) {
        toast.error(postJson.error || "Failed to post supplier discount");
        return;
      }

      toast.success("Supplier discount saved");
      resetForm();
      loadHistory();
    } catch {
      toast.error("Failed to save supplier discount");
    } finally {
      setSaving(false);
    }
  };

  const voidNote = async (row: SDHistoryRow) => {
    if (!(await confirm({
      title: "Void supplier discount?",
      message: `Void ${row.noteNumber} (${formatCurrency(row.totalAmount)})? This reverses the GL posting and re-opens any invoices it was knocked off.`,
      danger: true,
    }))) return;
    try {
      const res = await fetch(`/api/accounting/purchase-credit-notes/${encodeURIComponent(row.id)}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const j = asMutationResponse(await res.json());
      if (res.ok && j?.success) {
        toast.success(`${row.noteNumber} voided`);
        loadHistory();
      } else {
        toast.error(j?.error || "Failed to void supplier discount");
      }
    } catch {
      toast.error("Failed to void supplier discount");
    }
  };

  const supplierOptions = useMemo(
    () => suppliers.map((s) => ({ value: s.id, label: s.code ? `${s.code} — ${s.name}` : s.name })),
    [suppliers],
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Supplier Discount</h2>
        <p className="text-xs text-[#6B7280]">Record a discount/credit from a supplier. Optionally knock it off specific unpaid bills.</p>
      </div>

      {/* Entry form */}
      <Card>
        <CardContent className="p-4 space-y-4">
          {/* Supplier + amounts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="lg:col-span-2">
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Supplier</label>
              <SearchableSelect
                value={supplierId}
                onChange={handleSupplierChange}
                options={supplierOptions}
                placeholder="Type supplier name..."
                allowClear
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Discount amount (net) (RM)</label>
              <input
                type="number" step="0.01" min="0" inputMode="decimal"
                value={netRm}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setNetRm(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">SST (RM) <span className="font-normal text-[#9CA3AF]">(optional)</span></label>
              <input
                type="number" step="0.01" min="0" inputMode="decimal"
                value={sstRm}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setSstRm(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">Reason</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. damaged fabric returned"
              className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
            />
          </div>

          {/* Allocation table — only once a supplier is picked. */}
          {supplierId && (
            <div className="border-t border-[#F0ECE9] pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-[#1F1D1B]">Knock off unpaid bills <span className="font-normal text-[#9CA3AF]">(optional)</span></p>
              </div>
              {loadingPIs ? (
                <div className="py-6 text-center text-[#6B7280] text-sm">Loading unpaid bills…</div>
              ) : openPIs.length === 0 ? (
                <div className="py-6 text-center text-[#9CA3AF] text-sm">No unpaid bills for this supplier.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                        <th className="px-3 py-2 text-left w-10" />
                        <th className="px-3 py-2 text-left">PI No.</th>
                        <th className="px-3 py-2 text-left">Date</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2 text-right">Outstanding</th>
                        <th className="px-3 py-2 text-right">Apply (RM)</th>
                        <th className="px-3 py-2 text-left w-16" />
                      </tr>
                    </thead>
                    <tbody>
                      {openPIs.map((pi) => {
                        const row = allocRows[pi.id] ?? { checked: false, amountStr: "" };
                        return (
                          <tr key={pi.id} className="border-b border-[#F0ECE9]">
                            <td className="px-3 py-1.5">
                              <input
                                type="checkbox"
                                checked={row.checked}
                                onChange={(e) => setRow(pi.id, { checked: e.target.checked, amountStr: e.target.checked ? row.amountStr : "" })}
                                className="h-4 w-4 cursor-pointer accent-[#6B5C32]"
                              />
                            </td>
                            <td className="px-3 py-1.5 tabular-nums text-xs font-medium">{pi.piNo}</td>
                            <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{formatDateDMY(pi.invoiceDate)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-xs">{formatCurrency(pi.amountSen)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-xs font-medium">{formatCurrency(outstandingOf(pi))}</td>
                            <td className="px-3 py-1.5 text-right">
                              <input
                                type="number" step="0.01" min="0" inputMode="decimal"
                                value={row.amountStr}
                                disabled={!row.checked}
                                onFocus={(e) => e.currentTarget.select()}
                                onChange={(e) => setRow(pi.id, { amountStr: e.target.value })}
                                placeholder="0.00"
                                className="w-28 rounded-md border border-[#E2DDD8] px-2 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-[#6B5C32] disabled:bg-[#F7F4F0] disabled:text-[#9CA3AF]"
                              />
                            </td>
                            <td className="px-3 py-1.5">
                              <button
                                type="button"
                                onClick={() => fillFull(pi)}
                                className="text-xs text-[#6B5C32] underline decoration-dotted cursor-pointer"
                              >
                                Full
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {/* Live footer */}
              <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs text-[#6B7280] pt-1">
                <span>Allocated: <span className="font-semibold text-[#1F1D1B]">{formatCurrency(allocatedSen)}</span></span>
                <span>Discount total: <span className="font-semibold text-[#1F1D1B]">{formatCurrency(discountTotalSen)}</span></span>
                <span>Unallocated: <span className={`font-semibold ${unallocatedSen < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>{formatCurrency(unallocatedSen)}</span></span>
              </div>
            </div>
          )}

          <div className="flex justify-end border-t border-[#F0ECE9] pt-3">
            <Button variant="primary" size="sm" onClick={handleSave} disabled={!canSave}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-semibold text-[#1F1D1B]">History</h3>
          <BatchActionsBar
            count={sdSel.count}
            onClear={sdSel.clear}
            onPrint={() => printVouchers(sdSel.selectedRows.map(buildSupplierDiscountVoucher))}
            exportName="supplier-discounts"
            exportAoa={() => [
              ["Note No", "Date", "Supplier", "Status", "Against PI", "Reason", "Amount (RM)"],
              ...sdSel.selectedRows.map((d) => [
                d.noteNumber,
                formatDateDMY(d.date),
                d.supplierName ?? "",
                d.status ?? "ACTIVE",
                d.piNo ?? "",
                d.reason ?? "",
                (d.totalAmount / 100).toFixed(2),
              ]),
            ]}
          />
          {history.length === 0 ? (
            <div className="py-8 text-center text-[#9CA3AF] text-sm">No supplier discounts yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                    <th className="px-3 py-2 w-8"><input type="checkbox" checked={sdSel.allSelected} onChange={sdSel.toggleAll} className="h-3.5 w-3.5 accent-[#6B5C32] align-middle" /></th>
                    <th className="px-3 py-2 text-left">No.</th>
                    <th className="px-3 py-2 text-left">Supplier</th>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Knocked off</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {visibleHistory.map((n) => (
                    <tr key={n.id} className="border-b border-[#F0ECE9]">
                      <td className="px-3 py-1.5 w-8">
                        <input type="checkbox" checked={sdSel.isSelected(n.noteNumber ?? n.id)} onChange={() => sdSel.toggle(n.noteNumber ?? n.id)} className="h-3.5 w-3.5 accent-[#6B5C32] align-middle" />
                      </td>
                      <td className="px-3 py-1.5 tabular-nums text-xs font-medium">{n.noteNumber}</td>
                      <td className="px-3 py-1.5">{n.supplierName}</td>
                      <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{n.date}</td>
                      <td className="px-3 py-1.5 text-xs text-[#6B7280]">{n.piNo || "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium">{formatCurrency(n.totalAmount)}</td>
                      <td className="px-3 py-1.5">
                        {n.status === "POSTED" ? (
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#EAF3DE] text-[#27500A] border border-[#C0DD97]">POSTED</span>
                        ) : (
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#F3F0EC] text-[#6B7280] border border-[#E2DDD8]">{n.status}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {n.status === "POSTED" && (
                          <button onClick={() => voidNote(n)} className="text-xs text-[#9A3A2D] hover:text-[#7A2E24] underline decoration-dotted cursor-pointer">Void</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
  // Expandable detail (owner 2026-07-08): click a row to show every open
  // document in its aging column; un-knocked advances show as negative docs.
  const [openAging, setOpenAging] = useState<Set<string>>(new Set());
  const toggleAging = (id: string) =>
    setOpenAging((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Multi-company (Phase 2): "" = All companies (group). Consolidated aging
  // arrives via apData prop (unchanged); a company scopes /aging locally.
  const [company, setCompany] = useState("");
  const companyOptions = useCompanyOptions();
  const [scopedAp, setScopedAp] = useState<APAgingEntry[] | null>(null);
  const pickCompany = (v: string) => { setCompany(v); if (!v) setScopedAp(null); };
  useEffect(() => {
    if (!company) return;
    let stale = false;
    fetch(`/api/accounting/aging?orgId=${encodeURIComponent(company)}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { ap: APAgingEntry[] } }>)
      .then((j) => { if (!stale && j?.success && j.data) setScopedAp(j.data.ap ?? []); })
      .catch(() => {});
    return () => { stale = true; };
  }, [company]);
  const rows = company ? (scopedAp ?? []) : apData;

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

  const totalOutstanding = rows.reduce(
    (s, a) => s + a.currentSen + a.days30Sen + a.days60Sen + a.days90Sen + a.over90Sen,
    0
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <CompanySelect value={company} onChange={pickCompany} options={companyOptions} />
      </div>
      <APControlPanel company={company} />
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Accounts Payable</h2>
          <p className="text-sm text-[#6B7280]">Total Outstanding: <span className="font-semibold text-[#3E6570]">{formatCurrency(totalOutstanding)}</span></p>
        </div>
        <ExportButtons
          build={() => buildAgingExportAoa("Supplier", rows.map((a) => ({
            name: a.supplierName, currentSen: a.currentSen, days30Sen: a.days30Sen,
            days60Sen: a.days60Sen, days90Sen: a.days90Sen, over90Sen: a.over90Sen, docs: a.docs,
          })))}
          filenameBase={`creditor-aging-${new Date().toISOString().slice(0, 10)}${company ? `-${company}` : ""}`}
          title="Creditor Aging (AP)" pdfOpts={{ rowKind: agingRowKind, leftCols: [1, 2], colWidths: { 0: 168, 1: 62, 2: 118, 3: 66, 4: 66, 5: 66, 6: 66, 7: 66, 8: 78 } }} moneyFormat
          subtitle={`As at ${new Date().toISOString().slice(0, 10)}${company ? ` · ${company}` : " · All companies"}`}
        />
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
                {rows.map((ap) => {
                  const total = ap.currentSen + ap.days30Sen + ap.days60Sen + ap.days90Sen + ap.over90Sen;
                  const open = openAging.has(ap.supplierId);
                  return (
                    <Fragment key={ap.supplierId}>
                    <tr className="border-b border-[#F0ECE9] hover:bg-[#F0ECE9]/30">
                      <td className="py-3 px-4 font-medium text-[#1F1D1B]">
                        <button className="inline-flex items-center gap-1.5 text-left" onClick={() => toggleAging(ap.supplierId)} title="Show the documents behind this balance">
                          {open ? <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[#6B5C32]" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#6B5C32]" />}
                          {ap.supplierName}
                        </button>
                      </td>
                      <td className={`py-3 px-4 text-right ${ap.currentSen < 0 ? "text-[#9A3A2D]" : ""}`}>{ap.currentSen !== 0 ? formatCurrency(ap.currentSen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ap.days30Sen < 0 ? "text-[#9A3A2D]" : ""}`}>{ap.days30Sen !== 0 ? formatCurrency(ap.days30Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ap.days60Sen < 0 ? "text-[#9A3A2D]" : ap.days60Sen > 0 ? "text-[#9C6F1E]" : ""}`}>{ap.days60Sen !== 0 ? formatCurrency(ap.days60Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ap.days90Sen < 0 ? "text-[#9A3A2D]" : ap.days90Sen > 0 ? "text-[#B8601A] font-medium" : ""}`}>{ap.days90Sen !== 0 ? formatCurrency(ap.days90Sen) : "-"}</td>
                      <td className={`py-3 px-4 text-right ${ap.over90Sen !== 0 ? "text-[#9A3A2D] font-medium" : ""}`}>{ap.over90Sen !== 0 ? formatCurrency(ap.over90Sen) : "-"}</td>
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
                    {open && (ap.docs ?? []).map((d, i) => (
                      <tr key={`d-${i}`} className="border-b border-[#F7F4F1] bg-[#FAF8F6] text-xs">
                        <td className="py-1.5 px-4 pl-10 text-[#6B7280]"><span className="tabular-nums text-[#9CA3AF]">{d.date}</span><span className="ml-4">{d.no}</span></td>
                        {[0, 1, 2, 3, 4].map((b) => (
                          <td key={b} className={`py-1.5 px-4 text-right tabular-nums ${d.amountSen < 0 ? "text-[#9A3A2D]" : "text-[#4B5563]"}`}>
                            {d.mo === b ? formatCurrency(d.amountSen) : ""}
                          </td>
                        ))}
                        <td className={`py-1.5 px-4 text-right tabular-nums font-medium ${d.amountSen < 0 ? "text-[#9A3A2D]" : "text-[#4B5563]"}`}>{formatCurrency(d.amountSen)}</td>
                        <td></td>
                      </tr>
                    ))}
                    {open && !(ap.docs ?? []).length && (
                      <tr className="border-b border-[#F7F4F1] bg-[#FAF8F6] text-xs">
                        <td colSpan={8} className="py-1.5 px-4 pl-10 text-[#9CA3AF] italic">No document detail (refresh after the next aging rebuild)</td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9]/50 font-semibold">
                  <td className="py-3 px-4 text-[#1F1D1B]">Total</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(rows.reduce((s, a) => s + a.currentSen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(rows.reduce((s, a) => s + a.days30Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(rows.reduce((s, a) => s + a.days60Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(rows.reduce((s, a) => s + a.days90Sen, 0))}</td>
                  <td className="py-3 px-4 text-right">{formatCurrency(rows.reduce((s, a) => s + a.over90Sen, 0))}</td>
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
                Record Payment - {rows.find((a) => a.supplierId === paymentForm)?.supplierName}
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

// Material data-quality warnings surfaced on the P&L (from the FIFO engine):
// materials that went negative (need opening/GRN fixes) and item codes that
// could not be resolved to a raw material.
type PnlMaterialWarnings = {
  negatives: { rmId: string; itemCode: string; units: number }[];
  unresolved: { source: string; code: string }[];
};

// Phase 5.6 — Cost Structure: a FY, per material group, months as rows,
// each group a block of O/P · Purchase · C/L · Spend; leading SALES column
// and a Spend % of sales. Line filter by group prefix (B.* Bedframe,
// S.* Sofa); shared groups (no prefix) appear under Overall only.
type CsGroup = { group: string; description: string; months: { opening: number; purchase: number; closing: number; spend: number }[] };

function CostStructureTab() {
  const yrNow = new Date().getUTCFullYear();
  // fy=null → the SERVER picks the financial year containing today (owner
  // 2026-07-28: the old `yrNow` default pointed Jan–Aug users at the NEXT,
  // still-empty FY because the FYE is August). A number = user's pick.
  const [fy, setFy] = useState<number | null>(null);
  const [line, setLine] = useState<"all" | "sofa" | "bedframe">("all");
  const [data, setData] = useState<{ fyLabel: string; cols: string[]; groups: CsGroup[]; salesSofa: number[]; salesBed: number[]; salesAll: number[] } | null>(null);
  const loading = data === null;
  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/cost-structure${fy !== null ? `?fy=${fy}` : ""}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: NonNullable<typeof data> }>)
      .then((j) => { if (!stale && j?.success && j.data) setData(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [fy]);
  // The FY the data on screen belongs to (start year), parsed from the label
  // — drives the selector display when the user hasn't picked yet.
  const fyShown = fy ?? (data ? parseInt((/FY (\d{4})/.exec(data.fyLabel) ?? [])[1] ?? `${yrNow}`, 10) : yrNow);

  // Amounts shown WITHOUT the RM prefix (the section title carries "(RM)")
  // and slightly larger, so the table reads without scrolling far right.
  const n = (v: number) => (v === 0 ? "-" : (v / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const groupsFor = (pred: (g: CsGroup) => boolean) => (data?.groups ?? []).filter(pred);
  // Rows are keyed by PURCHASE ACCOUNT now (same source as the P&L); the
  // bed/sofa/shared split reads the account NAME ("PURCHASE - B.M FABRIC" →
  // bedframe, "… S.FILLER"/"… S FABRIC" → sofa, PLYWOOD etc. → shared).
  // Legacy itemGroup keys ("B.M-FABR") still match via the same prefixes.
  const csSection = (g: CsGroup): "bedframe" | "sofa" | "shared" => {
    const t = `${g.group} ${g.description}`.toUpperCase();
    if (/(^|[^A-Z])B\./.test(t)) return "bedframe";
    if (/(^|[^A-Z])S[.\s-]/.test(t)) return "sofa";
    return "shared";
  };
  const bedGroups = groupsFor((g) => csSection(g) === "bedframe");
  const sofaGroups = groupsFor((g) => csSection(g) === "sofa");
  const sharedGroups = groupsFor((g) => csSection(g) === "shared");
  // Owner 2026-07-29: on a single-line view the SHARED materials are
  // apportioned into that line by ITS share of that month's sales — the same
  // rule the Sofa/Bedframe P&L uses. Overall keeps them as their own section
  // (allocating there would just double-show the same money).
  const lineShare = (i: number): number => {
    const bed = data?.salesBed[i] ?? 0;
    const sofa = data?.salesSofa[i] ?? 0;
    const tot = bed + sofa;
    if (tot <= 0) return 0;
    return line === "bedframe" ? bed / tot : sofa / tot;
  };
  const allocateShared = (g: CsGroup): CsGroup => ({
    ...g,
    description: `${g.description} (shared)`,
    months: g.months.map((m, i) => {
      const s = lineShare(i);
      return {
        opening: Math.round(m.opening * s),
        purchase: Math.round(m.purchase * s),
        closing: Math.round(m.closing * s),
        spend: Math.round(m.spend * s),
      };
    }),
  });
  const bedView = [...bedGroups, ...sharedGroups.map(allocateShared)];
  const sofaView = [...sofaGroups, ...sharedGroups.map(allocateShared)];

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
                <th className="px-3 py-2 text-left sticky left-0 bg-white">MONTH</th>
                <th className="px-3 py-2 text-right">SALES</th>
                {grps.map((g) => (
                  <th key={g.group} colSpan={5} className="px-3 py-2 text-center border-l border-[#E2DDD8]">{g.description}</th>
                ))}
                <th className="px-3 py-2 text-right border-l border-[#E2DDD8]">SPEND % SALES</th>
              </tr>
              <tr className="border-b border-[#E2DDD8] text-[10px] text-[#9CA3AF]">
                <th className="sticky left-0 bg-white" /><th />
                {grps.map((g) => (
                  <React.Fragment key={g.group}>
                    <th className="px-2.5 py-1.5 text-right border-l border-[#E2DDD8]">O/P</th>
                    <th className="px-2.5 py-1.5 text-right">PUR</th>
                    <th className="px-2.5 py-1.5 text-right">C/L</th>
                    <th className="px-2.5 py-1.5 text-right">SPEND</th>
                    <th className="px-2.5 py-1.5 text-right">%</th>
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
                // Per-group spend as % of the SAME section's sales (owner
                // 2026-07-28: 「spend 旁边放 percentage,就是 spend / sales」).
                const gPct = (spend: number) => (s > 0 && spend !== 0 ? `${((spend / s) * 100).toFixed(1)}%` : "-");
                return (
                  <tr key={m} className="border-b border-[#F0ECE9]">
                    <td className="px-3 py-1.5 text-left sticky left-0 bg-white">{m}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{n(s)}</td>
                    {grps.map((g) => (
                      <React.Fragment key={g.group}>
                        <td className="px-2.5 py-1.5 text-right tabular-nums border-l border-[#F0ECE9]">{n(g.months[i].opening)}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{n(g.months[i].purchase)}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{n(g.months[i].closing)}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums font-medium">{n(g.months[i].spend)}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-[#9A3A2D]">{gPct(g.months[i].spend)}</td>
                      </React.Fragment>
                    ))}
                    <td className="px-3 py-1.5 text-right tabular-nums text-[#9A3A2D] border-l border-[#F0ECE9]">{pctTxt}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    );
  };

  // Export covers whatever sections are visible for the current line —
  // including the apportioned shared materials.
  const exportGroups = line === "sofa" ? sofaView : line === "bedframe" ? bedView : data?.groups ?? [];
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
                const head = ["MONTH", "SALES", ...exportGroups.flatMap((g) => [`${g.description} O/P`, "PUR", "C/L", "SPEND", "%"]), "SPEND % SALES"];
                const body: Aoa = data.cols.map((m, i) => {
                  const monthSpend = exportGroups.reduce((s, g) => s + g.months[i].spend, 0);
                  const s = exportSales[i] || 0;
                  const gp = (spend: number) => (s > 0 && spend !== 0 ? `${((spend / s) * 100).toFixed(1)}%` : "-");
                  return [m, (s / 100).toFixed(2), ...exportGroups.flatMap((g) => [(g.months[i].opening / 100).toFixed(2), (g.months[i].purchase / 100).toFixed(2), (g.months[i].closing / 100).toFixed(2), (g.months[i].spend / 100).toFixed(2), gp(g.months[i].spend)]), s > 0 ? `${((monthSpend / s) * 100).toFixed(1)}%` : "-"];
                });
                return [head, ...body];
              }}
              filenameBase={`CostStructure-${line}-FY${fyShown}`}
              title={`Cost Structure (${line})`}
              subtitle={data.fyLabel}
            />
          )}
          <select value={fyShown} onChange={(e) => setFy(parseInt(e.target.value, 10))} className="rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-sm">
            {[...new Set([yrNow, yrNow - 1, yrNow - 2, fyShown])].sort((a, b) => b - a).map((y) => <option key={y} value={y}>FY {y}</option>)}
          </select>
        </div>
      </div>
      {loading ? (
        <Card><CardContent className="py-12 text-center text-[#6B7280] text-sm">Loading…</CardContent></Card>
      ) : line === "sofa" ? (
        renderCsTable("SOFA COST STRUCTURE", sofaView, data!.salesSofa)
      ) : line === "bedframe" ? (
        renderCsTable("BEDFRAME COST STRUCTURE", bedView, data!.salesBed)
      ) : (
        // Overall — stacked: Bedframe on top, Sofa below, then shared.
        <>
          {renderCsTable("BEDFRAME COST STRUCTURE", bedGroups, data!.salesBed)}
          {renderCsTable("SOFA COST STRUCTURE", sofaGroups, data!.salesSofa)}
          {renderCsTable("SHARED / COMMON MATERIALS", sharedGroups, data!.salesAll)}
        </>
      )}
      <p className="text-[11px] text-[#9CA3AF]">
        O/P = opening stock, PUR = purchases, C/L = closing stock, SPEND = consumed (O/P + PUR − C/L). % = month spend ÷ that
        line's sales.{" "}
        {line === "all"
          ? "Shared materials (no B./S. prefix) are listed as their own section here — pick Sofa or Bedframe to see them apportioned."
          : "Rows marked (shared) are common materials apportioned into this line by its share of that month's sales — the same rule the Sofa / Bedframe P&L uses."}
      </p>
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
      <div className="flex flex-wrap items-center gap-2">
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

type PlMatrixRow = { kind: "group" | "line" | "total" | "grandtotal" | "gap"; depth: number; label: string; groupId?: string; accountCode?: string; values: number[]; pctValues: number[] };
type PlMonthlyData = { fyLabel: string; line: string; anchor: string; columns: { key: string; label: string; accum: boolean }[]; rows: PlMatrixRow[] };

function MonthlyPlTab() {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [line, setLine] = useState<"all" | "sofa" | "bedframe">("all");
  const [anchor, setAnchor] = useState(thisMonth);
  const [data, setData] = useState<PlMonthlyData | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<number | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setData(null);
    fetch(`/api/accounting/pl-monthly?line=${line}&anchor=${anchor}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: PlMonthlyData }>)
      .then((j) => { if (j?.success && j.data) setData(j.data); })
      .catch(() => {});
  }, [line, anchor]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const fmt = (sen: number) => { const v = sen / 100; const s = Math.abs(v).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return v < 0 ? `(${s})` : s; };

  const cols = data?.columns ?? [];
  const rows = data?.rows ?? [];
  // Detail-level control (AutoCount-style): "show level L" = collapse every
  // group at depth >= L-1 so rows deeper than L are hidden. maxLevel = deepest
  // row depth + 1 (P&L: depth 0..3 → L1..L4, L4 = fully expanded).
  const maxLevel = rows.reduce((m, r) => Math.max(m, r.depth), 0) + 1;
  const applyLevel = (L: number) => {
    setLevel(L);
    setCollapsed(new Set(rows.filter((r) => r.kind === "group" && r.groupId && r.depth >= L - 1).map((r) => r.groupId!)));
  };
  const visible: PlMatrixRow[] = [];
  {
    let hideDepth = Infinity;
    for (const r of rows) {
      if (r.depth > hideDepth) continue;
      hideDepth = Infinity;
      visible.push(r);
      if (r.kind === "group" && r.groupId && collapsed.has(r.groupId)) hideDepth = r.depth;
    }
  }
  const toggle = (gid: string) => { setLevel(null); setCollapsed((s) => { const n = new Set(s); if (n.has(gid)) n.delete(gid); else n.add(gid); return n; }); };

  const buildExport = (): (string | number)[][] => {
    // Each column → two cells: RM amount + % of net sales (beside, not below).
    const header: (string | number)[] = ["Item"];
    for (const c of cols) { header.push(c.label, "%"); }
    const aoa: (string | number)[][] = [header];
    for (const r of rows) {
      if (r.kind === "gap") continue;
      const row: (string | number)[] = [r.label];
      r.values.forEach((v, j) => { row.push((v / 100).toFixed(2), `${(r.pctValues[j] ?? 0).toFixed(1)}%`); });
      aoa.push(row);
    }
    return aoa;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[#3E6570]">Monthly P&amp;L</h2>
          <p className="text-xs text-[#9CA3AF]">{data ? `${data.fyLabel} · read-only · all amounts RM` : "Loading…"}</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="month" value={anchor} onChange={(e) => setAnchor(e.target.value || thisMonth)} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm" />
          <select value={line} onChange={(e) => setLine(e.target.value as "all" | "sofa" | "bedframe")} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm">
            <option value="all">All</option><option value="sofa">Sofa</option><option value="bedframe">Bedframe</option>
          </select>
          {data && maxLevel > 1 && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-[#9CA3AF] mr-0.5">DETAIL</span>
              {Array.from({ length: maxLevel }, (_, i) => i + 1).map((L) => (
                <button key={L} onClick={() => applyLevel(L)} title={`Expand to level ${L}`} className={`rounded-md border px-2.5 py-1.5 text-xs cursor-pointer ${level === L ? "border-[#3E6570] bg-[#3E6570] text-white" : "border-[#E2DDD8] bg-white text-[#4B5563] hover:bg-[#F0ECE9]"}`}>L{L}</button>
              ))}
            </div>
          )}
          {data && <ExportButtons build={buildExport} filenameBase={`monthly-pl-${data.anchor}-${line}`} title="Monthly P&L" subtitle={`${data.fyLabel} · ${line}`} />}
        </div>
      </div>

      <Card><CardContent className="p-0 overflow-x-auto">
        {!data ? (
          <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
        ) : (
          <table className="text-[13px] min-w-full">
            <thead>
              <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                <th rowSpan={2} className="px-3 py-2 text-left sticky left-0 bg-white align-bottom">Item</th>
                {cols.map((c) => <th key={c.key} colSpan={2} className={`px-3 py-2 text-center whitespace-nowrap border-l border-[#F0ECE9] ${c.accum ? "font-semibold text-[#3E6570]" : ""}`}>{c.label}</th>)}
              </tr>
              <tr className="border-b border-[#E2DDD8] text-[10px] text-[#9CA3AF]">
                {cols.map((c) => (
                  <React.Fragment key={c.key}>
                    <th className="px-3 py-1 text-right border-l border-[#F0ECE9]">RM</th>
                    <th className="px-2 py-1 text-right">%</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => {
                if (r.kind === "gap") return <tr key={`gap${i}`}><td colSpan={cols.length * 2 + 1} className="py-1"></td></tr>;
                const isGroup = r.kind === "group";
                const isTot = r.kind === "total" || r.kind === "grandtotal";
                const open = isGroup && r.groupId ? !collapsed.has(r.groupId) : false;
                // Visual hierarchy: section heads (depth-0 groups) tinted +
                // semibold; totals bordered; deep detail lines recede. The
                // sticky Item cell carries the SAME background as its row so
                // horizontal scrolling never shows a white notch.
                const rowBg = r.kind === "grandtotal" ? "bg-[#F7F5F2]" : r.kind === "total" ? "bg-[#FBFAF8]" : isGroup && r.depth === 0 ? "bg-[#F3F0EC]" : "bg-white";
                const rowCls = r.kind === "grandtotal" ? "font-semibold border-t-2 border-[#C9C2BA]" : r.kind === "total" ? "font-medium border-t border-[#E2DDD8]" : isGroup && r.depth === 0 ? "font-semibold border-t border-[#E2DDD8]" : isGroup ? "font-medium" : "";
                const deepLine = !isGroup && !isTot && r.depth >= 3;
                return (
                  <tr key={i} className={`${rowBg} ${rowCls} ${isGroup ? "cursor-pointer" : ""}`} onClick={isGroup && r.groupId ? () => toggle(r.groupId!) : undefined}>
                    {/* uppercase = display-only: unifies the COA's ALL-CAPS names with the owner-keyed Title Case historical labels */}
                    <td className={`px-3 py-1.5 sticky left-0 ${rowBg} uppercase whitespace-nowrap ${deepLine ? "text-[12px] text-[#6B7280]" : ""} ${isGroup && r.depth === 0 ? "tracking-wide" : ""}`} style={{ paddingLeft: `${12 + r.depth * 16}px` }}>{isGroup ? (open ? "▾ " : "▸ ") : ""}{r.label}</td>
                    {r.values.map((v, j) => (
                      <React.Fragment key={j}>
                        <td className={`px-3 py-1.5 text-right tabular-nums border-l border-[#F0ECE9] ${deepLine ? "text-[12px]" : ""} ${v < 0 ? "text-[#9A3A2D]" : ""}`}>{fmt(v)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[11px] text-[#9CA3AF]">{(r.pctValues[j] ?? 0).toFixed(1)}%</td>
                      </React.Fragment>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  );
}

// Shared CSV / Excel / PDF export buttons for the finance reports. The tab
// supplies a builder that returns the table as an array-of-arrays (header
// row + body) plus a filename base + title.
// `pdfOpts` controls the PDF: banded rows (rowKind), text columns kept
// left-aligned (leftCols) and fixed column widths; `moneyFormat` renders
// numbers as 1,392.50 in PDF+Excel (still real numbers in Excel so SUM
// works) and fixes CSV numbers to 2 dp.
function ExportButtons({ build, filenameBase, title, subtitle, pdfOpts, moneyFormat }: {
  build: () => Aoa; filenameBase: string; title: string; subtitle: string;
  pdfOpts?: PdfExportOpts;
  moneyFormat?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => exportReportCsv(`${filenameBase}.csv`, build(), moneyFormat ? { moneyFormat: true } : undefined)} className="rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1.5 text-xs text-[#4B5563] hover:bg-[#F0ECE9] cursor-pointer">CSV</button>
      <button onClick={() => exportReportXlsx(`${filenameBase}.xlsx`, title.slice(0, 28), build(), moneyFormat ? { moneyFormat: true } : undefined)} className="rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1.5 text-xs text-[#4B5563] hover:bg-[#F0ECE9] cursor-pointer">Excel</button>
      <button onClick={() => exportReportPdf(`${filenameBase}.pdf`, title, subtitle, build(), pdfOpts)} className="rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1.5 text-xs text-[#4B5563] hover:bg-[#F0ECE9] cursor-pointer">PDF</button>
    </div>
  );
}

function PLStatementTab() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [line, setLine] = useState<"all" | "sofa" | "bedframe">("all");
  const [level, setLevel] = useState(4);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [data, setData] = useState<{ rows: PnlStmtRow[]; netSalesSen: number; fyLabel: string; periodLabel: string; materialWarnings?: PnlMaterialWarnings } | null>(null);
  const loading = data === null;
  const { toast } = useToast();
  const [edit, setEdit] = useState(false);
  const [showMatWarnings, setShowMatWarnings] = useState(false);
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

  const matWarn = data?.materialWarnings;
  const negCount = matWarn?.negatives.length ?? 0;
  const unresCount = matWarn?.unresolved.length ?? 0;
  const hasMatWarnings = negCount > 0 || unresCount > 0;

  return (
    <div className="space-y-4">
      {hasMatWarnings && (
        <div className="rounded-md border border-[#F7C1C1] bg-[#FCEBEB] px-3 py-2">
          <button
            type="button"
            onClick={() => setShowMatWarnings((v) => !v)}
            className="flex w-full items-center gap-1.5 text-left text-sm font-semibold text-[#9A3A2D] cursor-pointer"
          >
            {showMatWarnings ? <ChevronDownIcon className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <span>
              ⚠ {negCount} material{negCount === 1 ? "" : "s"} with negative stock and {unresCount} unresolved — material cost may be understated. Click to {showMatWarnings ? "hide" : "view"}.
            </span>
          </button>
          {showMatWarnings && (
            <div className="mt-2 space-y-3 pl-6 text-sm">
              {negCount > 0 && (
                <div>
                  <p className="text-xs font-semibold text-[#9A3A2D] mb-1">Negative stock ({negCount}) — fix opening stock or GRN receipts so layers cover issues:</p>
                  <div className="flex flex-wrap gap-2">
                    {matWarn!.negatives.map((n) => (
                      <span key={n.rmId} className="inline-flex items-center gap-1.5 rounded-full border border-[#F7C1C1] bg-white px-2 py-0.5 text-xs tabular-nums">{n.itemCode} · {n.units} units</span>
                    ))}
                  </div>
                </div>
              )}
              {unresCount > 0 && (
                <div>
                  <p className="text-xs font-semibold text-[#9A3A2D] mb-1">Unresolved item codes ({unresCount}) — no matching raw material; check the code or master data:</p>
                  <div className="flex flex-wrap gap-2">
                    {matWarn!.unresolved.map((u) => (
                      <span key={`${u.source} ${u.code}`} className="inline-flex items-center rounded-full border border-[#F7C1C1] bg-white px-2 py-0.5 text-xs"><span className="tabular-nums mr-1">{u.code}</span><span className="text-[#6B7280]">{u.source}</span></span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
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
            <div className="overflow-x-auto">
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
            </div>
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

function OtherPartiesTab({ side }: { side: "DEBTOR" | "CREDITOR" }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [parties, setParties] = useState<OtherParty[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [form, setForm] = useState({
    type: side as "DEBTOR" | "CREDITOR",
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

  const save = async () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    const url = editingId ? `/api/accounting/other-parties/${editingId}` : "/api/accounting/other-parties";
    const method = editingId ? "PUT" : "POST";
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const j = asMutationResponse(await res.json());
    if (j?.success) {
      setShowForm(false); setEditingId(null);
      setForm({ type: side, name: "", contactPerson: "", phone: "", email: "", tin: "", registrationNo: "", address: "", notes: "" });
      load();
    } else toast.error(j?.error || (editingId ? "Failed to update party" : "Failed to create party"));
  };

  const startEdit = (p: OtherParty) => {
    setEditingId(p.id);
    setForm({ type: p.type, name: p.name, contactPerson: p.contactPerson, phone: p.phone, email: p.email, tin: p.tin, registrationNo: p.registrationNo, address: p.address, notes: p.notes });
    setShowForm(true);
  };
  const del = async (p: OtherParty) => {
    if (!(await confirm({ title: "Delete party?", message: `Delete ${p.name}? (only allowed if it has no bills/payments)`, danger: true }))) return;
    const res = await fetch(`/api/accounting/other-parties/${p.id}`, { method: "DELETE" });
    const j = asMutationResponse(await res.json());
    if (j?.success) load();
    else toast.error(j?.error || "Failed to delete party");
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

  const kw = q.trim().toLowerCase();
  const visible = (parties ?? []).filter((p) => {
    if (p.type !== side) return false;
    if (statusFilter === "ACTIVE" && !p.isActive) return false;
    if (statusFilter === "INACTIVE" && p.isActive) return false;
    if (kw && ![p.name, p.email, p.contactPerson, p.phone].some((s) => (s ?? "").toLowerCase().includes(kw))) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[#3E6570]">{side === "DEBTOR" ? "Other Debtor" : "Other Creditor"}</h2>
      <div className="grid gap-4 grid-cols-1">
        {side === "DEBTOR" ? (
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280]">305-0000 OTHER DEBTOR — control balance</p>
              <p className="text-xl font-bold text-[#3E6570]">{controls ? formatCurrency(controls.od) : "—"}</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[#6B7280]">405-0000 OTHER CREDITORS — control balance</p>
              <p className="text-xl font-bold text-[#9A3A2D]">{controls ? formatCurrency(controls.oc) : "—"}</p>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / email / contact" className="rounded-md border border-[#E2DDD8] px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "ALL" | "ACTIVE" | "INACTIVE")} className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm">
            <option value="ALL">All status</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </div>
        <Button variant="primary" size="sm" onClick={() => { setEditingId(null); setForm({ type: side, name: "", contactPerson: "", phone: "", email: "", tin: "", registrationNo: "", address: "", notes: "" }); setShowForm(!showForm); }}>
          <Plus className="h-4 w-4" /> Add Party
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
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
              <Button variant="primary" size="sm" onClick={save}>{editingId ? "Save changes" : "Save"}</Button>
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
                  <th className="px-4 py-2 text-left">Email</th>
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
                    <td className="px-4 py-1.5 text-[#6B7280] text-xs">{p.email}</td>
                    <td className="px-4 py-1.5 text-[#6B7280]">{p.phone}</td>
                    <td className="px-4 py-1.5 text-[#6B7280] text-xs">{p.notes}</td>
                    <td className="px-4 py-1.5 text-right">
                      <button onClick={() => startEdit(p)} className="text-[#6B5C32] hover:underline text-xs mr-3">Edit</button>
                      <button onClick={() => del(p)} className="text-[#9A3A2D] hover:underline text-xs mr-3">Delete</button>
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

// Bills / Payments are their own sidebar pages now (F4 #4) — thin wrappers
// that fetch the party roster (for the form dropdowns) and render the manager.
function useOtherPartiesList(): OtherParty[] {
  const [parties, setParties] = useState<OtherParty[]>([]);
  useEffect(() => {
    fetch("/api/accounting/other-parties")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: OtherParty[] }>)
      .then((j) => { if (j?.success) setParties(j.data ?? []); })
      .catch(() => {});
  }, []);
  return parties;
}

type AgingRowData = { partyId: string; partyName: string; current: number; d31_60: number; d61_90: number; d91_120: number; d120plus: number; totalSen: number };
type AgingBillLite = { partyId: string; partyName: string; billNo: string; billDate: string; outstandingSen: number };

// Per-party aging at the top of the Bills page (F4 #3). Live from unpaid bills;
// click a party to drill into its unpaid bills.
function OtherPartyAging({ side }: { side: "DEBTOR" | "CREDITOR" }) {
  const [data, setData] = useState<{ aging: AgingRowData[]; bills: AgingBillLite[] } | null>(null);
  const [openParty, setOpenParty] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/accounting/other-party-aging?type=${side}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { aging: AgingRowData[]; bills: AgingBillLite[] } }>)
      .then((j) => { if (j?.success && j.data) setData(j.data); })
      .catch(() => {});
  }, [side]);
  if (!data || data.aging.length === 0) return null;
  const grand = data.aging.reduce((s, r) => s + r.totalSen, 0);
  const cell = (v: number, danger = false) => <td className={`px-4 py-1.5 text-right tabular-nums ${danger && v ? "text-[#9A3A2D]" : ""}`}>{v ? formatCurrency(v) : "—"}</td>;
  return (
    <Card><CardContent className="p-0 overflow-x-auto">
      <div className="px-4 pt-3 pb-1 text-sm font-semibold text-[#3E6570]">Outstanding by {side === "DEBTOR" ? "debtor" : "creditor"} — aging</div>
      <table className="w-full text-sm">
        <thead><tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
          <th className="px-4 py-2 text-left">Party</th>
          <th className="px-4 py-2 text-right">Current</th>
          <th className="px-4 py-2 text-right">31-60</th>
          <th className="px-4 py-2 text-right">61-90</th>
          <th className="px-4 py-2 text-right">91-120</th>
          <th className="px-4 py-2 text-right">120+</th>
          <th className="px-4 py-2 text-right">Total</th>
        </tr></thead>
        <tbody>
          {data.aging.map((r) => (
            <React.Fragment key={r.partyId}>
              <tr className="border-b border-[#F0ECE9] cursor-pointer hover:bg-[#FAF8F5]" onClick={() => setOpenParty(openParty === r.partyId ? null : r.partyId)}>
                <td className="px-4 py-1.5 font-medium">{openParty === r.partyId ? "▾ " : "▸ "}{r.partyName}</td>
                {cell(r.current)}{cell(r.d31_60)}{cell(r.d61_90)}{cell(r.d91_120)}{cell(r.d120plus, true)}
                <td className="px-4 py-1.5 text-right tabular-nums font-semibold">{formatCurrency(r.totalSen)}</td>
              </tr>
              {openParty === r.partyId && data.bills.filter((b) => b.partyId === r.partyId).map((b) => (
                <tr key={b.billNo} className="border-b border-[#F0ECE9] bg-[#FAF8F5] text-xs text-[#6B7280]">
                  <td className="px-4 py-1 pl-8">{b.billNo} · {b.billDate}</td>
                  <td colSpan={5} />
                  <td className="px-4 py-1 text-right tabular-nums">{formatCurrency(b.outstandingSen)}</td>
                </tr>
              ))}
            </React.Fragment>
          ))}
          <tr className="border-t border-[#C9C2BA] bg-[#F7F5F2] font-semibold">
            <td className="px-4 py-1.5">Total outstanding</td>
            <td colSpan={5} />
            <td className="px-4 py-1.5 text-right tabular-nums">{formatCurrency(grand)}</td>
          </tr>
        </tbody>
      </table>
    </CardContent></Card>
  );
}

// OCR prefill (owner 2026-07-08): scan a bill / receipt (PDF or photo) → the
// supplier-document AI extracts party / doc no / date / amount lines → the
// caller PREFILLS its form for review. Nothing posts automatically — the
// operator still picks the GL account(s) and saves through the normal flow.
type ScanFinanceResult = {
  partyName: string | null;
  docType: string | null;
  docNo: string | null;
  docDate: string | null;
  lines: { description: string; amountSen: number }[];
  subtotalSen: number | null;
  taxSen: number | null;
  totalSen: number | null;
  extraDocs: number;
};
function ScanPrefillButton({ label, onResult }: { label: string; onResult: (d: ScanFinanceResult) => void | Promise<void> }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/scan-finance/extract", { method: "POST", body: fd });
      const j = (await res.json()) as { success?: boolean; error?: string; data?: ScanFinanceResult };
      if (j?.success && j.data) {
        await onResult(j.data);
        if (j.data.extraDocs > 0) {
          toast.success(`Heads up: the file contains ${j.data.extraDocs + 1} documents — only the first was used.`);
        }
      } else toast.error(j?.error || "Scan failed");
    } catch {
      toast.error("Scan failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  // Clicking the button opens an upload dialog with a big drop zone (owner
  // 2026-07-08: 「我希望是这样点了打开 upload」— same pattern as the PI scan
  // wizard). Drop a PDF/photo into the zone or click it to browse; the modal
  // shows the scanning state and closes itself when the form is prefilled.
  const [open, setOpen] = useState(false);
  const startFile = (f: File | undefined) => {
    void onFile(f).then(() => setOpen(false));
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} title="Scan a bill / receipt — AI prefills the form for your review">
        <Upload className="h-4 w-4 mr-1.5" /> {label}
      </Button>
      {open && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => { if (!busy) setOpen(false); }}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-[#E2DDD8]">
              <div>
                <h2 className="text-base font-semibold text-[#1F1D1B]">{label}</h2>
                <p className="text-xs text-[#6B7280] mt-0.5">Upload a bill / receipt (PDF or photo) — AI prefills the form for your review; nothing posts automatically.</p>
              </div>
              <button
                onClick={() => { if (!busy) setOpen(false); }}
                className="text-[#9CA3AF] hover:text-[#6B7280] text-lg leading-none"
                title={busy ? "Scanning — please wait" : "Close"}
              >
                ✕
              </button>
            </div>
            <div className="p-5">
              <div
                className={`rounded-lg border-2 border-dashed px-6 py-12 text-center cursor-pointer transition-colors ${dragOver ? "border-[#6B5C32] bg-[#F0ECE9]" : "border-[#E2DDD8] hover:bg-[#FAF8F6]"}`}
                onClick={() => { if (!busy) inputRef.current?.click(); }}
                onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (busy) return;
                  startFile(e.dataTransfer?.files?.[0] ?? undefined);
                }}
              >
                <Upload className="h-8 w-8 mx-auto text-[#B4B2A9]" />
                <p className="mt-3 text-sm font-medium text-[#1F1D1B]">
                  {busy ? "Scanning… (~30–90s, keep this open)" : dragOver ? "Drop to scan" : "Drop a PDF or photo here"}
                </p>
                {!busy && (
                  <p className="mt-1 text-xs text-[#6B7280]">or click to browse — one document, max 32MB</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,image/*"
        className="sr-only"
        onChange={(e) => startFile(e.target.files?.[0] ?? undefined)}
      />
    </>
  );
}
// Party match for scan prefill. Same precedence as every other OCR surface
// (owner 2026-08-01: 「我们的全部OCR都要有这样的功能」):
//
//   1. a taught alias   — a human already told us who this letterhead is
//   2. loose containment — the original behaviour, kept so nothing that
//                          resolves today starts failing
//   3. fuzzy ranking     — crosses a typo in the party master, refuses a
//                          near-tie (see party-fuzzy-match.ts)
//
// This surface used to be the LOOSEST of the four: bare substring either way,
// `.find()` first-hit-wins, and no ambiguity guard at all — two parties whose
// names contain one another would silently resolve to whichever sat earlier in
// the array. Step 3 replaces that tail with a ranked, separation-checked pick.
function scanNameMatch<T extends { id: string; name: string }>(
  list: T[],
  name: string | null,
  aliasMap?: Record<string, string> | null,
): T | undefined {
  if (!name) return undefined;
  const taughtId = resolveAlias(aliasMap, name);
  if (taughtId) {
    const taught = list.find((p) => p.id === taughtId);
    if (taught) return taught;
  }
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const b = norm(name);
  if (!b) return undefined;
  const contained = list.filter((p) => {
    const a = norm(p.name);
    return !!a && (a.includes(b) || b.includes(a));
  });
  // Unique-guarded now: 2+ containment hits is ambiguous, so fall through to
  // ranking rather than taking whichever happened to be first.
  if (contained.length === 1) return contained[0];
  return bestMatch(list, name)?.party ?? undefined;
}

function OtherPartyBillsTab({ accounts, side }: { accounts: ChartOfAccount[]; side: "DEBTOR" | "CREDITOR" }) {
  const parties = useOtherPartiesList();
  return (
    <div className="space-y-4">
      <OtherPartyAging side={side} />
      <OtherPartyBillsManager parties={parties} accounts={accounts} side={side} />
    </div>
  );
}

function OtherPartyPaymentsTab({ accounts, side }: { accounts: ChartOfAccount[]; side: "DEBTOR" | "CREDITOR" }) {
  return <OtherPartyPaymentsManager parties={useOtherPartiesList()} accounts={accounts} side={side} />;
}

type BillLineDraft = { counterAccount: string; amountStr: string; description: string };
type OtherPartyBill = {
  id: string; billNo: string; partyId: string; partyType: "DEBTOR" | "CREDITOR";
  partyName: string; billDate: string; referenceNo: string; description: string;
  subtotalSen: number; taxSen: number; totalSen: number; paidAmountSen: number;
  outstandingSen: number; status: string; isOpening?: boolean; lifecycleState?: string;
  items: { counterAccount: string; amountSen: number; description: string; lineNo: number }[];
};

function OtherPartyBillsManager({ parties, accounts, side }: { parties: OtherParty[]; accounts: ChartOfAccount[]; side: "DEBTOR" | "CREDITOR" }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [bills, setBills] = useState<OtherPartyBill[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [q, setQ] = useState("");
  const [openBill, setOpenBill] = useState<string | null>(null);
  // Edit-in-place (owner 2026-07-09): non-null = the form saves via PUT to
  // this bill number instead of creating a new bill.
  const [editingBillNo, setEditingBillNo] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const blankLine = (): BillLineDraft => ({ counterAccount: "", amountStr: "", description: "" });
  const [form, setForm] = useState({ partyId: "", billDate: today, referenceNo: "", description: "", taxStr: "", lines: [blankLine()], isOpening: false });

  const load = () => {
    fetch(`/api/accounting/other-party-bills?type=${side}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: OtherPartyBill[] }>)
      .then((j) => { if (j?.success) setBills(j.data ?? []); })
      .catch(() => {});
  };
  useEffect(load, [side]);

  const sideParties = parties.filter((p) => p.type === side && p.isActive);
  const toSen = (s: string) => Math.round((parseFloat(s) || 0) * 100);

  const updateLine = (idx: number, field: keyof BillLineDraft, value: string) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l, i) => (i === idx ? { ...l, [field]: value } : l)) }));
  const addLine = () => setForm((f) => ({ ...f, lines: [...f.lines, blankLine()] }));
  const removeLine = (idx: number) => setForm((f) => ({ ...f, lines: f.lines.length > 1 ? f.lines.filter((_, i) => i !== idx) : f.lines }));

  const subtotalSen = form.lines.reduce((s, l) => s + toSen(l.amountStr), 0);
  const totalSen = subtotalSen + toSen(form.taxStr);

  const submit = async () => {
    if (!editingBillNo && !form.partyId) { toast.error("Select a party"); return; }
    const items = form.lines
      .filter((l) => l.counterAccount && toSen(l.amountStr) > 0)
      .map((l) => ({ counterAccount: l.counterAccount, amountSen: toSen(l.amountStr), description: l.description }));
    if (items.length === 0) { toast.error("Add at least one line with account + amount"); return; }
    const payload = { partyId: form.partyId, billDate: form.billDate, referenceNo: form.referenceNo, description: form.description, taxSen: toSen(form.taxStr), items, isOpening: form.isOpening };
    const res = editingBillNo
      ? await fetch(`/api/accounting/other-party-bills/${encodeURIComponent(editingBillNo)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      : await fetch("/api/accounting/other-party-bills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
    const j = asMutationResponse(await res.json());
    if (j?.success) {
      // TEACH: if this bill came from a scan, the letterhead OCR read now maps
      // to the party the operator actually filed it under — right first time or
      // corrected by hand. Next scan of the same letterhead resolves directly.
      if (scannedPartyName && form.partyId) {
        void teachPartyAlias({
          partyType: "OTHER_PARTY",
          partyId: form.partyId,
          rawName: scannedPartyName,
          knownMap: partyAliases,
        });
      }
      setScannedPartyName(null);
      setShowForm(false);
      setEditingBillNo(null);
      setForm({ partyId: "", billDate: today, referenceNo: "", description: "", taxStr: "", lines: [blankLine()], isOpening: false });
      load();
    } else toast.error(j?.error || (editingBillNo ? "Failed to save changes" : "Failed to create bill"));
  };

  // Copy = open a fresh bill prefilled from an existing one. F4 #1.
  const copyBill = (b: OtherPartyBill) => {
    setEditingBillNo(null);
    setForm({
      partyId: b.partyId,
      billDate: today,
      referenceNo: "",
      description: b.description ?? "",
      taxStr: b.taxSen ? (b.taxSen / 100).toString() : "",
      lines: b.items.length
        ? b.items.map((it) => ({ counterAccount: it.counterAccount, amountStr: (it.amountSen / 100).toString(), description: it.description ?? "" }))
        : [blankLine()],
      isOpening: false,
    });
    setShowForm(true);
  };

  // Edit-in-place: same bill number, GL reversed + re-posted server-side
  // (owner 2026-07-09 「开了无法edit,我要能edit」). Party stays fixed.
  const editBill = (b: OtherPartyBill) => {
    setEditingBillNo(b.billNo);
    setForm({
      partyId: b.partyId,
      billDate: b.billDate,
      referenceNo: b.referenceNo ?? "",
      description: b.description ?? "",
      taxStr: b.taxSen ? (b.taxSen / 100).toString() : "",
      lines: b.items.length
        ? b.items.map((it) => ({ counterAccount: it.counterAccount, amountStr: (it.amountSen / 100).toString(), description: it.description ?? "" }))
        : [blankLine()],
      isOpening: !!b.isOpening,
    });
    setShowForm(true);
  };

  const kw = q.trim().toLowerCase();
  const visibleBills = (bills ?? []).filter((b) =>
    !kw || [b.billNo, b.partyName, b.referenceNo, b.description].some((s) => (s ?? "").toLowerCase().includes(kw)),
  );
  const billSel = useRowSelection(visibleBills, (b) => b.billNo ?? b.id);

  const handleLifecycle = async (billNo: string, action: "void" | "delete" | "unvoid") => {
    const verb = action === "unvoid" ? "Restore" : action === "delete" ? "Delete" : "Void";
    const extra = action === "delete"
      ? " It will be hidden from the GL (still visible in the audit log)."
      : action === "void"
        ? " A reversal entry will be posted (nothing is deleted)."
        : "";
    if (!(await confirm({ title: `${verb} bill?`, message: `${verb} ${billNo}?${extra}`, danger: true }))) return;
    const res = await fetch(`/api/accounting/other-party-bills/${encodeURIComponent(billNo)}/lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) load();
    else toast.error(j?.error || `${verb} failed`);
  };

  // OCR → prefill the bill form. Party matched by letterhead name; an
  // UNKNOWN party offers one-click creation into the register (owner
  // 2026-07-08); the account(s) prefill from the party's LATEST bill (same
  // creditor almost always books to the same account) — still editable.
  const [extraParties, setExtraParties] = useState<OtherParty[]>([]);
  // Taught aliases (scanned letterhead → other-party id), same memory the
  // PI / GRN / customer-PO scanners use. Always active — this is a page, not
  // a modal, so there is no open flag to gate on.
  const partyAliases = usePartyAliases("OTHER_PARTY", true);
  // The letterhead OCR read for the bill currently in the form — null when the
  // operator keyed it by hand (nothing to learn from a manual entry).
  const [scannedPartyName, setScannedPartyName] = useState<string | null>(null);
  const allSideParties = [...sideParties, ...extraParties.filter((p) => p.type === side)];
  // Unknown scanned party → a small NEW-PARTY dialog: name prefilled from the
  // letterhead, every other field OPTIONAL and left to the operator (owner
  // 2026-07-08: 「只是要让我决定要不要填」). Create → register + auto-select;
  // Skip → pick manually.
  const blankPartyDraft = { name: "", contactPerson: "", phone: "", email: "", tin: "", registrationNo: "", address: "", notes: "" };
  const [newPartyDraft, setNewPartyDraft] = useState<typeof blankPartyDraft | null>(null);
  const [creatingParty, setCreatingParty] = useState(false);
  const createPartyFromDraft = async () => {
    if (!newPartyDraft || !newPartyDraft.name.trim()) { toast.error("Name is required"); return; }
    setCreatingParty(true);
    try {
      const res = await fetch("/api/accounting/other-parties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: side, ...newPartyDraft }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string; data?: OtherParty };
      if (j?.success && j.data?.id) {
        setExtraParties((p) => [...p, j.data as OtherParty]);
        setForm((f) => ({ ...f, partyId: (j.data as OtherParty).id }));
        setNewPartyDraft(null);
        toast.success(`Created "${j.data.name}" and selected it for this bill.`);
      } else toast.error(j?.error || "Failed to create the party");
    } catch {
      toast.error("Failed to create the party");
    } finally {
      setCreatingParty(false);
    }
  };
  const applyScan = (d: ScanFinanceResult) => {
    setEditingBillNo(null); // a scan always drafts a NEW bill, never overwrites an edit
    setScannedPartyName(d.partyName ?? null);
    const hit = scanNameMatch(allSideParties, d.partyName, partyAliases);
    // Last-used account for this party (latest bill's first line).
    const lastAcct = hit
      ? ((bills ?? [])
          .filter((b) => b.partyId === hit.id && b.items?.length)
          .sort((a, b) => (b.billDate || "").localeCompare(a.billDate || ""))[0]?.items[0]?.counterAccount ?? "")
      : "";
    setForm((f) => ({
      ...f,
      partyId: hit?.id ?? "",
      billDate: d.docDate ?? f.billDate,
      referenceNo: d.docNo ?? f.referenceNo,
      description: d.partyName ? `${d.partyName}${d.docType ? ` · ${d.docType}` : ""}` : f.description,
      taxStr: d.taxSen ? (d.taxSen / 100).toFixed(2) : f.taxStr,
      lines: d.lines.length
        ? d.lines.map((l) => ({ counterAccount: lastAcct, amountStr: (l.amountSen / 100).toFixed(2), description: l.description }))
        : d.totalSen
          ? [{ counterAccount: lastAcct, amountStr: ((d.totalSen - (d.taxSen ?? 0)) / 100).toFixed(2), description: d.docType ?? "" }]
          : f.lines,
      isOpening: false,
    }));
    setShowForm(true);
    if (!hit && d.partyName) {
      setNewPartyDraft({ ...blankPartyDraft, name: d.partyName });
      return;
    }
    toast.success(
      hit
        ? lastAcct
          ? "Scanned — account prefilled from this party's last bill; review before saving."
          : "Scanned — review the lines and pick the account(s)."
        : "Scanned — review the lines and pick the account(s).",
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <ScanPrefillButton label="Scan Bill" onResult={applyScan} />
        <Button variant="primary" size="sm" onClick={() => {
          if (editingBillNo) {
            setEditingBillNo(null);
            setForm({ partyId: "", billDate: today, referenceNo: "", description: "", taxStr: "", lines: [blankLine()], isOpening: false });
            setShowForm(true);
          } else setShowForm(!showForm);
        }}>
          <Plus className="h-4 w-4" /> New Bill
        </Button>
      </div>

      {newPartyDraft && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => { if (!creatingParty) setNewPartyDraft(null); }}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-[#E2DDD8]">
              <div>
                <h2 className="text-base font-semibold text-[#1F1D1B]">{side === "CREDITOR" ? "New creditor from scan" : "New debtor from scan"}</h2>
                <p className="text-xs text-[#6B7280] mt-0.5">Not in the register yet. Name comes from the scanned document; everything else is optional — fill what you want, or Skip and pick a party manually.</p>
              </div>
              <button onClick={() => { if (!creatingParty) setNewPartyDraft(null); }} className="text-[#9CA3AF] hover:text-[#6B7280] text-lg leading-none">✕</button>
            </div>
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="sm:col-span-2">
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Name *</label>
                <input type="text" value={newPartyDraft.name} onChange={(e) => setNewPartyDraft({ ...newPartyDraft, name: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Contact Person</label>
                <input type="text" value={newPartyDraft.contactPerson} onChange={(e) => setNewPartyDraft({ ...newPartyDraft, contactPerson: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Phone</label>
                <input type="text" value={newPartyDraft.phone} onChange={(e) => setNewPartyDraft({ ...newPartyDraft, phone: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Email</label>
                <input type="text" value={newPartyDraft.email} onChange={(e) => setNewPartyDraft({ ...newPartyDraft, email: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">TIN</label>
                <input type="text" value={newPartyDraft.tin} onChange={(e) => setNewPartyDraft({ ...newPartyDraft, tin: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Registration No</label>
                <input type="text" value={newPartyDraft.registrationNo} onChange={(e) => setNewPartyDraft({ ...newPartyDraft, registrationNo: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Address</label>
                <input type="text" value={newPartyDraft.address} onChange={(e) => setNewPartyDraft({ ...newPartyDraft, address: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Notes</label>
                <input type="text" value={newPartyDraft.notes} onChange={(e) => setNewPartyDraft({ ...newPartyDraft, notes: e.target.value })} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-5 pt-0">
              <Button variant="outline" size="sm" onClick={() => setNewPartyDraft(null)} disabled={creatingParty}>
                Skip — pick manually
              </Button>
              <Button variant="primary" size="sm" onClick={() => void createPartyFromDraft()} disabled={creatingParty}>
                {creatingParty ? "Creating…" : "Create & use"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <Card><CardContent className="p-4 space-y-3">
          {editingBillNo && (
            <div className="text-xs font-medium text-[#6B5C32] bg-[#F6F1E7] rounded-md px-3 py-2">
              Editing {editingBillNo} — saving reverses its ledger entry and posts the corrected one under the same number. The party cannot change (Copy for that).
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">{side === "CREDITOR" ? "Creditor" : "Debtor"}</label>
              <select value={form.partyId} onChange={(e) => setForm({ ...form, partyId: e.target.value })} disabled={!!editingBillNo}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm disabled:bg-[#F5F3F0] disabled:text-[#9CA3AF]">
                <option value="">Select…</option>
                {allSideParties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Bill Date</label>
              <input type="date" value={form.billDate} onChange={(e) => setForm({ ...form, billDate: e.target.value })}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Reference No</label>
              <input type="text" value={form.referenceNo} onChange={(e) => setForm({ ...form, referenceNo: e.target.value })}
                placeholder="their invoice / DO no" className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">&nbsp;</label>
              <label
                className="flex items-center gap-2 h-[38px] px-3 rounded-md border border-[#E2DDD8] text-sm cursor-pointer"
                title="Check for a bill dated BEFORE the accounting opening date — it still shows correctly in aging instead of being floored out. Pick a Balance-Sheet counter account below (e.g. Retained Earnings), not a P&L expense."
              >
                <input type="checkbox" checked={form.isOpening} onChange={(e) => setForm({ ...form, isOpening: e.target.checked })} className="h-3.5 w-3.5 accent-[#6B5C32]" />
                Opening balance
              </label>
            </div>
          </div>

          <div>
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-[#6B7280]">
              <th className="text-left py-1">Account</th><th className="text-left py-1">Description</th>
              <th className="text-right py-1">Amount (RM)</th><th></th>
            </tr></thead>
            <tbody>
              {form.lines.map((l, idx) => (
                <tr
                  key={idx}
                  onKeyDown={(e) => {
                    if (e.key === "Insert") {
                      e.preventDefault();
                      setForm((f) => ({ ...f, lines: [...f.lines.slice(0, idx + 1), blankLine(), ...f.lines.slice(idx + 1)] }));
                    }
                  }}
                >
                  <td className="py-1 pr-2 w-1/3">
                    <AccountPicker accounts={accounts} value={l.counterAccount} onChange={(code) => updateLine(idx, "counterAccount", code)} placeholder="counter account" />
                  </td>
                  <td className="py-1 pr-2">
                    <input type="text" value={l.description} onChange={(e) => updateLine(idx, "description", e.target.value)}
                      className="w-full rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm" />
                  </td>
                  <td className="py-1 pl-2 w-32">
                    <input type="text" inputMode="decimal" value={l.amountStr} onChange={(e) => updateLine(idx, "amountStr", e.target.value)}
                      className="w-full rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm text-right tabular-nums" />
                  </td>
                  <td className="py-1 pl-2">
                    <button onClick={() => removeLine(idx)} className="text-[#9A3A2D] text-xs">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={addLine}>+ Add Line</Button>
            <span className="text-[11px] text-[#B4B2A9]">press <span className="font-medium text-[#6B7280]">Insert</span> to add a line below</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end pt-2 border-t border-[#F0ECE9]">
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Tax / SST (RM, optional)</label>
              <input type="text" inputMode="decimal" value={form.taxStr} onChange={(e) => setForm({ ...form, taxStr: e.target.value })}
                placeholder="0.00" className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm text-right tabular-nums" />
              <p className="text-[10px] text-[#9CA3AF] mt-0.5">{side === "CREDITOR" ? "→ 706-0000 input SST" : "→ 350-0000 output SST"}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Description</label>
              <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
            </div>
            <div className="text-right">
              <p className="text-xs text-[#6B7280]">Total</p>
              <p className="text-lg font-bold text-[#3E6570] tabular-nums">{formatCurrency(totalSen)}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={submit}>{editingBillNo ? "Save Changes (re-post)" : "Save & Post"}</Button>
            <Button variant="outline" size="sm" onClick={() => { setShowForm(false); setEditingBillNo(null); }}>Cancel</Button>
          </div>
        </CardContent></Card>
      )}

      <div className="flex items-center">
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bill no / party / reference / description" className="rounded-md border border-[#E2DDD8] px-3 py-1.5 text-sm w-80 focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
      </div>

      <BatchActionsBar
        count={billSel.count}
        onClear={billSel.clear}
        onPrint={() => printVouchers(billSel.selectedRows.map((b) => buildOtherPartyBillVoucher(b, accounts)))}
        exportName="other-party-bills"
        exportAoa={() => [
          ["Bill No", "Date", "Party", "Status", "Reference No", "Voucher Total (RM)", "Account", "Description", "Amount (RM)"],
          ...billSel.selectedRows.flatMap((b) =>
            b.items.map((it) => [
              b.billNo,
              formatDateDMY(b.billDate),
              b.partyName ?? "",
              b.status ?? "ACTIVE",
              b.referenceNo ?? "",
              (b.totalSen / 100).toFixed(2),
              accountLabel(accounts, it.counterAccount),
              it.description ?? "",
              (it.amountSen / 100).toFixed(2),
            ]),
          ),
        ]}
      />

      <Card><CardContent className="p-0 overflow-x-auto">
        {bills === null ? (
          <div className="py-10 text-center text-[#6B7280] text-sm">Loading…</div>
        ) : bills.length === 0 ? (
          <div className="py-10 text-center text-[#6B7280] text-sm">No bills yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
              <th className="px-3 py-2 w-8"><input type="checkbox" checked={billSel.allSelected} onChange={billSel.toggleAll} className="h-3.5 w-3.5 accent-[#6B5C32] align-middle" /></th>
              <th className="px-4 py-2 text-left">Bill No</th><th className="px-4 py-2 text-left">Party</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-left">Date</th><th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2 text-right">Paid</th><th className="px-4 py-2 text-right">Outstanding</th>
              <th className="px-4 py-2 text-center">Status</th><th className="px-4 py-2 text-right"></th>
            </tr></thead>
            <tbody>
              {visibleBills.map((b) => (
                <React.Fragment key={b.id}>
                  <tr className="border-b border-[#F0ECE9]">
                    <td className="px-3 py-1.5 w-8">
                      <input type="checkbox" checked={billSel.isSelected(b.billNo ?? b.id)} onChange={() => billSel.toggle(b.billNo ?? b.id)} className="h-3.5 w-3.5 accent-[#6B5C32] align-middle" />
                    </td>
                    <td className="px-4 py-1.5 font-mono text-xs">
                      <button onClick={() => setOpenBill(openBill === b.id ? null : b.id)} className="cursor-pointer hover:underline">{openBill === b.id ? "▾ " : "▸ "}{b.billNo}</button>
                    </td>
                    <td className="px-4 py-1.5">{b.partyName}</td>
                    <td className="px-4 py-1.5 text-xs text-[#6B7280] max-w-[16rem] truncate">{[b.referenceNo, b.description].filter(Boolean).join(" · ")}</td>
                    <td className="px-4 py-1.5">{b.billDate}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{formatCurrency(b.totalSen)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{formatCurrency(b.paidAmountSen)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums font-medium">{formatCurrency(b.outstandingSen)}</td>
                    <td className="px-4 py-1.5 text-center text-xs">
                      <LifecycleBadge state={b.lifecycleState} />
                      {(b.lifecycleState ?? "ACTIVE") === "ACTIVE" && b.status}
                    </td>
                    <td className="px-4 py-1.5 text-right whitespace-nowrap">
                      <button onClick={() => printVoucher(buildOtherPartyBillVoucher(b, accounts))} title="Print bill voucher" className="inline-flex items-center gap-1 text-[#6B5C32] hover:text-[#1F1D1B] text-xs underline decoration-dotted cursor-pointer mr-3"><Printer className="h-3 w-3" />print</button>
                      {(b.lifecycleState ?? "ACTIVE") === "ACTIVE" && (
                        <button onClick={() => editBill(b)} className="text-[#6B5C32] hover:underline text-xs mr-3">Edit</button>
                      )}
                      <button onClick={() => copyBill(b)} className="text-[#6B5C32] hover:underline text-xs mr-3">Copy</button>
                      <LifecycleActions
                        state={b.lifecycleState}
                        disabled={(b.lifecycleState ?? "ACTIVE") === "ACTIVE" && b.paidAmountSen > 0}
                        onVoid={() => handleLifecycle(b.billNo, "void")}
                        onDelete={() => handleLifecycle(b.billNo, "delete")}
                        onUnvoid={() => handleLifecycle(b.billNo, "unvoid")}
                      />
                    </td>
                  </tr>
                  {openBill === b.id && (
                    <tr className="border-b border-[#F0ECE9] bg-[#FAF8F5]">
                      <td colSpan={10} className="px-8 py-2">
                        <div className="text-xs text-[#6B7280] space-y-0.5">
                          {b.items.map((it, i) => (
                            <div key={i} className="flex justify-between max-w-md">
                              <span>{it.counterAccount}{it.description ? ` · ${it.description}` : ""}</span>
                              <span className="tabular-nums">{formatCurrency(it.amountSen)}</span>
                            </div>
                          ))}
                          {b.taxSen ? <div className="flex justify-between max-w-md border-t border-[#E2DDD8] mt-0.5 pt-0.5"><span>Tax / SST</span><span className="tabular-nums">{formatCurrency(b.taxSen)}</span></div> : null}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {visibleBills.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-sm text-[#9CA3AF]">No bills match</td></tr>
              )}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  );
}

type OpenBill = { id: string; billNo: string; outstandingSen: number };
type PaymentGroup = {
  paymentNo: string; partyId: string; partyType: "DEBTOR" | "CREDITOR"; partyName: string;
  date: string; bankAccount: string; totalSen: number; lifecycleState?: string;
  lines: { billId: string; billNo: string; amountSen: number }[];
};

function OtherPartyPaymentsManager({ parties, accounts, side }: { parties: OtherParty[]; accounts: ChartOfAccount[]; side: "DEBTOR" | "CREDITOR" }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const today = new Date().toISOString().slice(0, 10);
  const banks = accounts.filter((a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH");
  const [partyId, setPartyId] = useState("");
  const [bankAccountSel, setBankAccountSel] = useState("");
  const bankAccount = bankAccountSel || defaultBankCode(banks);
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState("");
  const [openBills, setOpenBills] = useState<OpenBill[]>([]);
  const [rows, setRows] = useState<Record<string, { amountStr: string; full: boolean }>>({});
  const [history, setHistory] = useState<PaymentGroup[] | null>(null);
  const [detail, setDetail] = useState<PaymentGroup | null>(null);
  const [posting, setPosting] = useState(false);
  // Edit mode: when set, the form is editing this payment in place (same number).
  const [editingNo, setEditingNo] = useState<string | null>(null);

  const sideParties = parties.filter((p) => p.type === side && p.isActive);
  const verb = side === "CREDITOR" ? "Payment" : "Receipt";

  const loadHistory = () => {
    fetch(`/api/accounting/other-party-payments?type=${side}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: PaymentGroup[] }>)
      .then((j) => { if (j?.success) setHistory(j.data ?? []); })
      .catch(() => {});
  };
  useEffect(loadHistory, [side]);

  const loadOpenBills = (
    pid: string,
    editLines?: { billId: string; billNo: string; amountSen: number }[],
  ) => {
    setPartyId(pid); setRows({});
    if (!pid) { setOpenBills([]); return; }
    fetch(`/api/accounting/other-party-bills?type=${side}&partyId=${pid}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { id: string; billNo: string; outstandingSen: number }[] }>)
      .then((j) => {
        if (!j?.success) return;
        // Edit flow: add the receipt-being-edited's amount back to each bill's
        // outstanding (it'll be reversed on save), and surface any bills it fully
        // paid so they stay re-allocatable.
        const back = new Map((editLines ?? []).map((l) => [l.billId, l.amountSen]));
        let open = (j.data ?? [])
          .filter((b) => b.outstandingSen > 0)
          .map((b) => ({ id: b.id, billNo: b.billNo, outstandingSen: b.outstandingSen + (back.get(b.id) ?? 0) }));
        const have = new Set(open.map((b) => b.id));
        for (const l of editLines ?? []) {
          if (!have.has(l.billId) && l.amountSen > 0) {
            open = [...open, { id: l.billId, billNo: l.billNo, outstandingSen: l.amountSen }];
          }
        }
        setOpenBills(open);
        if (editLines) {
          const seeded: Record<string, { amountStr: string; full: boolean }> = {};
          for (const l of editLines) {
            if (l.amountSen > 0) seeded[l.billId] = { amountStr: (l.amountSen / 100).toFixed(2), full: false };
          }
          setRows(seeded);
        }
      })
      .catch(() => {});
  };

  const toSen = (s: string) => Math.round((parseFloat(s) || 0) * 100);
  const getRow = (id: string) => rows[id] ?? { amountStr: "", full: false };
  const setRow = (id: string, patch: Partial<{ amountStr: string; full: boolean }>) =>
    setRows((r) => ({ ...r, [id]: { ...getRow(id), ...patch } }));
  const allocSen = (b: OpenBill) => { const row = getRow(b.id); return row.full ? b.outstandingSen : toSen(row.amountStr); };
  const totalSen = openBills.reduce((s, b) => s + allocSen(b), 0);

  const handleSave = async () => {
    if (!partyId) { toast.error("Select a party"); return; }
    if (!bankAccount) { toast.error("Select a bank/cash account"); return; }
    const allocations = openBills
      .map((b) => ({ billId: b.id, amountSen: allocSen(b) }))
      .filter((a) => a.amountSen > 0);
    if (allocations.length === 0) { toast.error("Enter at least one amount"); return; }
    setPosting(true);
    const url = editingNo
      ? `/api/accounting/other-party-payments/${encodeURIComponent(editingNo)}/restate`
      : "/api/accounting/other-party-payments";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ partyId, bankAccount, date, reference: reference || undefined, allocations }),
    });
    setPosting(false);
    const j = asMutationResponse(await res.json());
    if (!j?.success) {
      toast.error(j?.error || `Failed to ${editingNo ? "update" : "post"} ${verb.toLowerCase()}`);
      return;
    }
    if (editingNo) {
      setEditingNo(null); setReference(""); setPartyId(""); setOpenBills([]); setRows({});
      loadHistory();
      toast.success(`${verb} updated`);
    } else {
      setReference(""); loadOpenBills(partyId); loadHistory();
      toast.success(`${verb} posted`);
    }
  };

  const cancelEdit = () => {
    setEditingNo(null); setPartyId(""); setOpenBills([]); setRows({}); setReference("");
  };

  const handleLifecycle = async (paymentNo: string, action: "void" | "delete" | "unvoid") => {
    const lcVerb = action === "unvoid" ? "Restore" : action === "delete" ? "Delete" : "Void";
    const extra = action === "delete"
      ? " It will be hidden from the GL (still visible in the audit log)."
      : action === "void"
        ? " A reversal entry will be posted (nothing is deleted)."
        : "";
    if (!(await confirm({ title: `${lcVerb} payment?`, message: `${lcVerb} ${paymentNo}?${extra}`, danger: true }))) return;
    const res = await fetch(`/api/accounting/other-party-payments/${encodeURIComponent(paymentNo)}/lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) { loadHistory(); if (partyId) loadOpenBills(partyId); }
    else toast.error(j?.error || `${lcVerb} failed`);
  };

  // Edit in place: load the payment into the form (no void). Save re-states it
  // under the same number; the original is untouched until then.
  const editPayment = (g: PaymentGroup) => {
    setDetail(null);
    setEditingNo(g.paymentNo);
    if (g.bankAccount) setBankAccountSel(g.bankAccount);
    setDate(g.date || today);
    setReference("");
    loadOpenBills(g.partyId, g.lines);
  };

  const opaySel = useRowSelection(history ?? [], (p) => p.paymentNo);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#3E6570]">{editingNo ? `Edit ${verb.toLowerCase()}` : side === "CREDITOR" ? "Payments" : "Receipts"}</h3>
        <div className="flex items-center gap-2">
          {editingNo && <Button variant="outline" size="sm" onClick={cancelEdit}>Cancel</Button>}
          <Button variant="primary" size="sm" disabled={posting || !partyId || !bankAccount || totalSen <= 0} onClick={handleSave}>
            {editingNo ? `Update ${verb.toLowerCase()}` : `Post ${verb.toLowerCase()}`}
          </Button>
        </div>
      </div>
      <Card><CardContent className="p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">{side === "CREDITOR" ? "Creditor" : "Debtor"}</label>
            <SearchableSelect
              value={partyId}
              onChange={(v) => loadOpenBills(v)}
              options={sideParties.map((p) => ({ value: p.id, label: p.name }))}
              placeholder={`Type ${side === "CREDITOR" ? "creditor" : "debtor"} name…`}
              allowClear
            />
          </div>
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">{side === "CREDITOR" ? "Pay from" : "Deposit to"} (bank / cash)</label>
            <select value={bankAccount} onChange={(e) => setBankAccountSel(e.target.value)} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm">
              {banks.map((b) => <option key={b.code} value={b.code}>{b.code} {b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-[#6B7280] mb-1 block">Reference (optional)</label>
            <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="cheque / transfer no" className="w-full rounded-md border border-[#E2DDD8] px-3 py-2 text-sm" />
          </div>
        </div>

        {partyId && openBills.length > 0 && (
          <div className="flex items-center justify-end gap-3 rounded-md border border-[#E2DDD8] bg-[#FAF8F5] px-3 py-2">
            <span className="text-xs font-medium text-[#6B7280]">Total (RM)</span>
            <span className="text-lg font-bold text-[#3E6570] tabular-nums">{formatCurrency(totalSen)}</span>
          </div>
        )}

        {partyId && (openBills.length === 0 ? (
          <p className="text-xs text-[#9CA3AF]">No outstanding bills for this party.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-[#6B7280] text-left">
              <th className="py-1">Bill No</th><th className="py-1 text-right">Outstanding</th>
              <th className="py-1 text-right">{side === "CREDITOR" ? "Pay" : "Receive"} (RM)</th><th className="py-1 text-center">Full</th>
            </tr></thead>
            <tbody>
              {openBills.map((b) => {
                const row = getRow(b.id);
                return (
                  <tr key={b.id} className="border-t border-[#F0ECE9]">
                    <td className="py-1 font-mono text-xs">{b.billNo}</td>
                    <td className="py-1 text-right tabular-nums">{formatCurrency(b.outstandingSen)}</td>
                    <td className="py-1 text-right">
                      <input type="text" inputMode="decimal" disabled={row.full}
                        value={row.full ? (b.outstandingSen / 100).toFixed(2) : row.amountStr}
                        onChange={(e) => setRow(b.id, { amountStr: e.target.value })}
                        className="w-28 rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm text-right tabular-nums disabled:bg-[#F0ECE9]" />
                    </td>
                    <td className="py-1 text-center">
                      <input type="checkbox" checked={row.full} onChange={(e) => setRow(b.id, { full: e.target.checked })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        ))}

      </CardContent></Card>

      <BatchActionsBar
        count={opaySel.count}
        onClear={opaySel.clear}
        onPrint={() => printVouchers(opaySel.selectedRows.map((p) => buildOtherPartyPaymentVoucher(p, accounts)))}
        exportName="other-party-payments"
        exportAoa={() => [
          ["Payment No", "Date", "Party", "Status", "Voucher Total (RM)", "Bill No", "Amount (RM)"],
          ...opaySel.selectedRows.flatMap((p) =>
            p.lines.map((l) => [
              p.paymentNo,
              formatDateDMY(p.date),
              p.partyName ?? "",
              p.lifecycleState ?? "ACTIVE",
              (p.totalSen / 100).toFixed(2),
              l.billNo,
              (l.amountSen / 100).toFixed(2),
            ]),
          ),
        ]}
      />

      <Card><CardContent className="p-0 overflow-x-auto">
        {history === null ? (
          <div className="py-8 text-center text-[#6B7280] text-sm">Loading…</div>
        ) : history.length === 0 ? (
          <div className="py-8 text-center text-[#6B7280] text-sm">No {verb.toLowerCase()}s yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280] text-left">
              <th className="px-3 py-2 w-8"><input type="checkbox" checked={opaySel.allSelected} onChange={opaySel.toggleAll} className="h-3.5 w-3.5 accent-[#6B5C32] align-middle" /></th>
              <th className="px-4 py-2">No</th><th className="px-4 py-2">Party</th><th className="px-4 py-2">Date</th>
              <th className="px-4 py-2 text-right">Total</th><th className="px-4 py-2 text-center">Bills</th><th className="px-4 py-2 text-right"></th>
            </tr></thead>
            <tbody>
              {history.map((g) => (
                <tr key={g.paymentNo} onClick={() => setDetail(g)} className="border-b border-[#F0ECE9] cursor-pointer hover:bg-[#FAF8F5]">
                  <td className="px-3 py-1.5 w-8" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={opaySel.isSelected(g.paymentNo)} onChange={() => opaySel.toggle(g.paymentNo)} className="h-3.5 w-3.5 accent-[#6B5C32] align-middle" />
                  </td>
                  <td className="px-4 py-1.5 font-mono text-xs">{g.paymentNo}</td>
                  <td className="px-4 py-1.5">{g.partyName}</td>
                  <td className="px-4 py-1.5">{g.date}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{formatCurrency(g.totalSen)}</td>
                  <td className="px-4 py-1.5 text-center">{g.lines.length}</td>
                  <td className="px-4 py-1.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => printVoucher(buildOtherPartyPaymentVoucher(g, accounts))} title="Print payment voucher" className="inline-flex items-center gap-1 text-[#6B5C32] hover:text-[#1F1D1B] text-xs underline decoration-dotted cursor-pointer mr-3"><Printer className="h-3 w-3" />print</button>
                    {(g.lifecycleState ?? "ACTIVE") === "ACTIVE" && (
                      <button onClick={() => editPayment(g)} className="text-xs text-[#3E6570] hover:underline mr-2">Edit</button>
                    )}
                    <span className="mr-2"><LifecycleBadge state={g.lifecycleState} /></span>
                    <LifecycleActions
                      state={g.lifecycleState}
                      onVoid={() => handleLifecycle(g.paymentNo, "void")}
                      onDelete={() => handleLifecycle(g.paymentNo, "delete")}
                      onUnvoid={() => handleLifecycle(g.paymentNo, "unvoid")}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent></Card>

      {detail && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setDetail(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-[#E2DDD8]">
              <h2 className="text-base font-semibold">{verb} {detail.paymentNo}</h2>
              <button onClick={() => setDetail(null)} className="text-[#9CA3AF] hover:text-[#6B7280] text-lg leading-none">✕</button>
            </div>
            <div className="p-5 space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-[#9CA3AF]">{side === "CREDITOR" ? "Creditor" : "Debtor"}</p><p className="font-medium">{detail.partyName}</p></div>
                <div><p className="text-[#9CA3AF]">Date</p><p className="font-medium">{detail.date}</p></div>
                <div><p className="text-[#9CA3AF]">Total</p><p className="font-bold text-[#3E6570]">{formatCurrency(detail.totalSen)}</p></div>
                <div><p className="text-[#9CA3AF]">Status</p><p><LifecycleBadge state={detail.lifecycleState} /></p></div>
              </div>
              <div>
                <p className="text-[#9CA3AF] mb-1">Bills {side === "CREDITOR" ? "paid" : "received against"}</p>
                <div className="border border-[#E2DDD8] rounded-md overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-[#FAF8F5]"><tr><th className="text-left px-3 py-1.5 font-medium text-[#6B7280]">Bill No</th><th className="text-right px-3 py-1.5 font-medium text-[#6B7280]">Amount (RM)</th></tr></thead>
                    <tbody>
                      {detail.lines.map((l) => (
                        <tr key={l.billId} className="border-t border-[#F0ECE9]">
                          <td className="px-3 py-1.5 font-mono">{l.billNo}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(l.amountSen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
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
  // Multi-company (Phase 2): "" = All companies (group). trial-balance accepts
  // ?orgId= — absent = today's consolidated TB, unchanged.
  const [company, setCompany] = useState("");
  const companyOptions = useCompanyOptions();
  const [tb, setTb] = useState<{
    rows: TbRow[];
    totalDr: number;
    totalCr: number;
    balanced: boolean;
  } | null>(null);
  const loadingTb = tb === null;

  useEffect(() => {
    let stale = false;
    fetch(`/api/accounting/trial-balance?asOf=${asOf}${orgIdParam(company)}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { rows: TbRow[]; totalDr: number; totalCr: number; balanced: boolean } }>)
      .then((j) => { if (!stale && j?.success && j.data) setTb(j.data); })
      .catch(() => {});
    return () => { stale = true; };
  }, [asOf, company]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Trial Balance</h2>
        <div className="flex items-end gap-3">
          <div className="pb-0.5">
            <CompanySelect value={company} onChange={setCompany} options={companyOptions} />
          </div>
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

// Debtor / Creditor Ledger — the subsidiary ledger as one report: every party
// as its own section (Balance b/f → dated transactions → running balance →
// Balance c/f). Data from /debtor-ledger | /creditor-ledger.
type PartyLedgerData = {
  from: string | null;
  to: string | null;
  parties: {
    party: { id: string; name: string; code: string };
    openingSen: number;
    closingSen: number;
    rows: { date: string; ref: string; type: string; debitSen: number; creditSen: number; runningSen: number }[];
  }[];
};

function PartyLedgerTab({ side }: { side: "DEBTOR" | "CREDITOR" }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<PartyLedgerData | null>(null);
  const [loading, setLoading] = useState(false);
  const endpoint = side === "DEBTOR" ? "debtor-ledger" : "creditor-ledger";
  const title = side === "DEBTOR" ? "Debtor Ledger" : "Creditor Ledger";

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    fetch(`/api/accounting/${endpoint}?${p.toString()}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: PartyLedgerData }>)
      .then((j) => setData(j?.success ? j.data ?? null : null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [endpoint, from, to]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard data-fetch effect; `load` (a useCallback also wired to the Refresh button) sets loading/data when endpoint/from/to change, not a cascading-render bug
  useEffect(() => { load(); }, [load]);

  const fmtType = (t: string) => t.replace(/_/g, " ").toLowerCase();

  // Owner 2026-07-24 (「purchase/sales ledger 没有 total」): per-party DR/CR
  // subtotals + a grand TOTAL DR / TOTAL CR / net Balance across all parties.
  // A one-sided subledger is NOT supposed to balance, so no Balanced badge.
  const partyDr = (pl: PartyLedgerData["parties"][number]) => pl.rows.reduce((s, r) => s + (r.debitSen || 0), 0);
  const partyCr = (pl: PartyLedgerData["parties"][number]) => pl.rows.reduce((s, r) => s + (r.creditSen || 0), 0);
  const grandDrSen = data?.parties.reduce((s, pl) => s + partyDr(pl), 0) ?? 0;
  const grandCrSen = data?.parties.reduce((s, pl) => s + partyCr(pl), 0) ?? 0;
  const grandBalSen = data?.parties.reduce((s, pl) => s + pl.closingSen, 0) ?? 0;

  const printLedger = () => {
    if (!data) return;
    const w = window.open("", "_blank");
    if (!w) return;
    const sections = data.parties
      .map(
        (pl) =>
          `<h3 style="margin:16px 0 4px;font-size:13px">${pl.party.code ? pl.party.code + " · " : ""}${pl.party.name}</h3>` +
          `<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="border-bottom:1px solid #000;text-align:left"><th>Date</th><th>Ref</th><th>Type</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th><th style="text-align:right">Balance</th></tr></thead><tbody>` +
          `<tr><td colspan="5"><i>Balance b/f</i></td><td style="text-align:right">${formatCurrency(pl.openingSen)}</td></tr>` +
          pl.rows
            .map(
              (r) =>
                `<tr><td>${r.date}</td><td>${r.ref}</td><td>${fmtType(r.type)}</td><td style="text-align:right">${r.debitSen ? formatCurrency(r.debitSen) : ""}</td><td style="text-align:right">${r.creditSen ? formatCurrency(r.creditSen) : ""}</td><td style="text-align:right">${formatCurrency(r.runningSen)}</td></tr>`,
            )
            .join("") +
          `<tr style="border-top:1px solid #000;font-weight:bold"><td colspan="3">TOTAL</td><td style="text-align:right">${formatCurrency(partyDr(pl))}</td><td style="text-align:right">${formatCurrency(partyCr(pl))}</td><td></td></tr>` +
          `<tr style="font-weight:bold"><td colspan="5">Balance c/f</td><td style="text-align:right">${formatCurrency(pl.closingSen)}</td></tr></tbody></table>`,
      )
      .join("");
    const grandLine = `<p style="margin-top:16px;font-size:12px;font-weight:bold;text-align:right">TOTAL DR ${formatCurrency(grandDrSen)} &nbsp;·&nbsp; TOTAL CR ${formatCurrency(grandCrSen)} &nbsp;·&nbsp; Balance ${formatCurrency(grandBalSen)}</p>`;
    w.document.write(
      `<html><head><title>${title}</title></head><body><h2>HOOKKA MANUFACTURING SDN BHD</h2><p>${title}${data.from || data.to ? ` · ${data.from || "…"} → ${data.to || "…"}` : ""}</p>${sections}${grandLine}</body></html>`,
    );
    w.document.close();
    w.print();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">{title}</h2>
        <div className="flex items-center gap-2">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm" />
          <span className="text-xs text-[#9CA3AF]">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm" />
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
          <Button variant="outline" size="sm" onClick={printLedger} disabled={!data || data.parties.length === 0}>Print</Button>
        </div>
      </div>
      <p className="text-xs text-[#6B7280]">每个{side === "DEBTOR" ? "客户" : "供应商"}各一段:Balance b/f → 交易 → 累计余额 → Balance c/f。空白起止日 = 全部。</p>
      {loading ? (
        <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
      ) : !data || data.parties.length === 0 ? (
        <div className="py-12 text-center text-[#6B7280] text-sm">No activity.</div>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardContent className="px-3 py-2 flex justify-end gap-8 text-sm font-semibold text-[#1F1D1B] tabular-nums">
              <span>TOTAL DR {formatCurrency(grandDrSen)}</span>
              <span>TOTAL CR {formatCurrency(grandCrSen)}</span>
              <span>Balance {formatCurrency(grandBalSen)}</span>
            </CardContent>
          </Card>
          {data.parties.map((pl) => (
            <Card key={pl.party.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-[#3E6570]">{pl.party.code ? `${pl.party.code} · ` : ""}{pl.party.name}</h3>
                  <span className="text-sm text-[#6B7280]">Balance <span className="font-bold text-[#1F1D1B] tabular-nums">{formatCurrency(pl.closingSen)}</span></span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-[#6B7280] text-left border-b border-[#E2DDD8]">
                        <th className="py-1 px-2">Date</th><th className="py-1 px-2">Ref</th><th className="py-1 px-2">Type</th>
                        <th className="py-1 px-2 text-right">Debit</th><th className="py-1 px-2 text-right">Credit</th><th className="py-1 px-2 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="text-[#9CA3AF] italic"><td className="py-1 px-2" colSpan={5}>Balance b/f</td><td className="py-1 px-2 text-right tabular-nums">{formatCurrency(pl.openingSen)}</td></tr>
                      {pl.rows.map((r, i) => (
                        <tr key={i} className="border-t border-[#F0ECE9]">
                          <td className="py-1 px-2 whitespace-nowrap">{r.date}</td>
                          <td className="py-1 px-2 font-mono text-xs">{r.ref}</td>
                          <td className="py-1 px-2 text-xs">{fmtType(r.type)}</td>
                          <td className="py-1 px-2 text-right tabular-nums">{r.debitSen ? formatCurrency(r.debitSen) : ""}</td>
                          <td className="py-1 px-2 text-right tabular-nums">{r.creditSen ? formatCurrency(r.creditSen) : ""}</td>
                          <td className="py-1 px-2 text-right tabular-nums font-medium">{formatCurrency(r.runningSen)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-[#E2DDD8] bg-[#F0ECE9]/60 font-semibold text-[#1F1D1B]">
                        <td className="py-1.5 px-2" colSpan={3}>TOTAL</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{formatCurrency(partyDr(pl))}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{formatCurrency(partyCr(pl))}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums bg-[#EAF3DE]">{formatCurrency(pl.closingSen)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ))}
          <Card>
            <CardContent className="px-3 py-2 flex justify-end gap-8 text-sm font-semibold text-[#1F1D1B] tabular-nums">
              <span>TOTAL DR {formatCurrency(grandDrSen)}</span>
              <span>TOTAL CR {formatCurrency(grandCrSen)}</span>
              <span>Balance {formatCurrency(grandBalSen)}</span>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// Floating back-to-top button (owner 2026-07-24: 「一键返顶」— the ledger
// runs thousands of rows and the walk back up is a chore). Window-scroll
// driven; appears after one screen's worth of scroll.
function BackToTopButton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!show) return null;
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      title="Back to top"
      aria-label="Back to top"
      className="fixed bottom-6 right-6 z-50 h-11 w-11 rounded-full bg-[#6B5C32] text-white shadow-lg hover:bg-[#1F1D1B] cursor-pointer text-lg leading-none"
    >
      ↑
    </button>
  );
}

// Grouped-ledger geometry, measured on prod. GL_ROW_PX is one leg row;
// GL_CARD_CHROME_PX is everything else in an account card (the clickable
// account header, the table header, the BALANCE B/F row and the per-account
// totals row). Together they size the placeholder that holds a card's space
// while it is off-screen.
const GL_ROW_PX = 29;
const GL_CARD_CHROME_PX = 128;

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
  // The two FLAT listings (all-accounts listing and single-account inquiry)
  // are capped server-side at 1,000 rows; both are windowed so the cap stops
  // being a browser-protection measure and becomes just a data limit.
  const flatScrollRef = useRef<HTMLDivElement>(null);
  const inquiryScrollRef = useRef<HTMLDivElement>(null);
  const account = picked.length === 1 ? picked[0] : "";
  const loading = account ? gl === null : view === "grouped" ? report === null : all === null;
  const nameOf = (code: string) => accounts.find((a) => a.code === code)?.name ?? "";
  const flatVirt = useVirtualRows({
    count: all?.rows.length ?? 0,
    rowHeight: GL_ROW_PX,
    scrollRef: flatScrollRef,
    colSpan: 6,
  });
  const inquiryVirt = useVirtualRows({
    count: gl?.rows.length ?? 0,
    rowHeight: GL_ROW_PX,
    scrollRef: inquiryScrollRef,
    colSpan: 6,
  });

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

  // Sales / Purchase Ledger scope shows the per-customer / per-supplier ledger
  // (one section each) — the "subsidiary" ledger — instead of the flat
  // control-account listing. (Owner: a debtor/creditor ledger should be per party.)
  if (ledger === "sales" || ledger === "purchase") {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">General Ledger</h2>
        <Card>
          <CardContent className="p-4 bg-[#F7F4EF] rounded-lg">
            <label className="text-xs font-semibold text-[#1F1D1B] mb-1 block">Ledger</label>
            <select
              value={ledger}
              onChange={(e) => { setLedger(e.target.value as typeof ledger); setPicked([]); reset(); }}
              className="rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm"
            >
              <option value="all">All Ledgers</option>
              <option value="general">General Ledger</option>
              <option value="sales">Sales Ledger (Debtors)</option>
              <option value="purchase">Purchase Ledger (Creditors)</option>
            </select>
          </CardContent>
        </Card>
        <PartyLedgerTab side={ledger === "sales" ? "DEBTOR" : "CREDITOR"} />
        <BackToTopButton />
      </div>
    );
  }

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
          {" · "}Opening {formatCurrency(gl.openingSen)} · Total DR {formatCurrency(gl.totalDebitSen ?? 0)} · Total CR {formatCurrency(gl.totalCreditSen ?? 0)} · Closing {formatCurrency(gl.closingSen)} ({gl.account.type})
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
            {/* Owner 2026-07-24: the grand DR/CR totals also live UP HERE —
                the bottom card alone meant scrolling past the whole report. */}
            {report.accounts.length > 0 && (
              <Card>
                <CardContent className="px-3 py-2 flex justify-end gap-8 text-sm font-semibold text-[#1F1D1B] tabular-nums">
                  <span>TOTAL DR {formatCurrency(report.grandDr)}</span>
                  <span>TOTAL CR {formatCurrency(report.grandCr)}</span>
                  <span className={report.grandDr - report.grandCr !== 0 ? "text-[#9A3A2D]" : "text-[#27500A]"}>
                    {report.grandDr - report.grandCr === 0 ? "Balanced ✓" : `Diff ${formatCurrency(report.grandDr - report.grandCr)}`}
                  </span>
                </CardContent>
              </Card>
            )}
            {report.accounts.map((a) => {
              const open = !collapsedAccts[a.code];
              // Height to hold while the card is off-screen: the account
              // header + the table's own header, B/F and totals rows, plus one
              // GL_ROW_PX per leg. Only used to keep the scrollbar steady —
              // being a few pixels out costs a small jump, nothing more.
              const estimated = open ? GL_CARD_CHROME_PX + a.rows.length * GL_ROW_PX : GL_CARD_CHROME_PX;
              return (
                <DeferredBlock key={a.code} estimatedHeight={estimated}>
                <Card>
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
                </DeferredBlock>
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
            <div ref={inquiryScrollRef} className="overflow-auto max-h-[75vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-white">
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
                {/* The B/F line stays mounted above the window rather than
                    becoming item 0 — an opening balance that scrolls away is
                    worse than the one-row coordinate offset it introduces,
                    which the 10-row overscan absorbs. */}
                <tr className="border-b border-[#F0ECE9] text-[#6B7280]" style={{ height: GL_ROW_PX }}>
                  <td className="px-3 py-1.5" colSpan={5}>Opening balance</td>
                  <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(gl.openingSen)}</td>
                </tr>
                {inquiryVirt.topSpacer}
                {(inquiryVirt.active ? inquiryVirt.indices.map((i) => gl.rows[i]) : gl.rows).map((r) => {
                  if (!r) return null;
                  const href = sourceHref(r.sourceType, r.sourceId);
                  return (
                    <tr key={r.id} className="border-b border-[#F0ECE9]" style={{ height: GL_ROW_PX }}>
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
                {inquiryVirt.bottomSpacer}
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
            </div>
          ) : all ? (
            <div ref={flatScrollRef} className="overflow-auto max-h-[75vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-white">
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
                {flatVirt.topSpacer}
                {(flatVirt.active ? flatVirt.indices.map((i) => all.rows[i]) : all.rows).map((r) => {
                  if (!r) return null;
                  const href = sourceHref(r.sourceType, r.sourceId);
                  return (
                    <tr key={r.id} className="border-b border-[#F0ECE9]" style={{ height: GL_ROW_PX }}>
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
                {flatVirt.bottomSpacer}
              </tbody>
            </table>
            </div>
          ) : null}
        </CardContent>
      </Card>
      )}
      <BackToTopButton />
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
  lifecycleState?: string;
  lines: { accountCode: string; description: string | null; amountSen: number }[];
};

function PaymentsTab({ accounts }: { accounts: ChartOfAccount[] }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [rows, setRows] = useState<PvRow[] | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [expandedPv, setExpandedPv] = useState<Record<string, boolean>>({});
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

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "PAID" | "UNPAID" | "VOID">("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [bankFilter, setBankFilter] = useState("");

  const bankCash = accounts.filter(
    (a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH",
  );
  // Accrual must land in an accrued-EXPENSE account (410-x). 405-0000 (Other
  // Creditors) is deliberately excluded — to record a creditor liability,
  // raise an Other Creditor bill so it shows in that creditor's aging (F4 #5).
  const accrualOpts = accounts.filter(
    (a) =>
      a.type === "LIABILITY" &&
      a.isPostable !== false &&
      a.code.startsWith("410"),
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

  const statusOf = (r: PvRow) => r.status === "VOID" ? "VOID" : (r.accrued === 1 && !r.settledAt ? "UNPAID" : "PAID");
  const visibleRows = (rows ?? []).filter((r) => {
    if (q.trim()) { const kw = q.toLowerCase(); if (![r.pvNo, r.payee ?? "", r.description ?? ""].some((s) => s.toLowerCase().includes(kw))) return false; }
    if (statusFilter !== "ALL" && statusOf(r) !== statusFilter) return false;
    if (dateFrom && r.date < dateFrom) return false;
    if (dateTo && r.date > dateTo) return false;
    if (bankFilter && (r.payFrom ?? "") !== bankFilter) return false;
    return true;
  });

  const pvSel = useRowSelection(visibleRows, (r) => r.pvNo ?? r.id);

  const [editingId, setEditingId] = useState<string | null>(null);

  const handleSave = async () => {
    const body = {
      date: form.date,
      payee: form.payee,
      description: form.description,
      accrued: form.accrued,
      payFrom: form.accrued ? undefined : (form.payFrom || defaultBankCode(bankCash)),
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
      const res = await fetch(
        editingId ? `/api/accounting/payment-vouchers/${editingId}/restate` : "/api/accounting/payment-vouchers",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      const j = asMutationResponse(await res.json());
      if (j?.success) {
        toast.success(editingId ? "Payment updated" : "Payment posted");
        setShowForm(false);
        setEditingId(null);
        setForm({ date: new Date().toISOString().slice(0, 10), payee: "", description: "", accrued: false, payFrom: "", accrualAccount: "", productLine: "" });
        setLines([{ accountCode: "", description: "", amount: "" }]);
        load();
      } else toast.error(j?.error || (editingId ? "Update failed" : "Save failed"));
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

  const handleLifecycle = async (id: string, pvNo: string, action: "void" | "delete" | "unvoid") => {
    const verb = action === "unvoid" ? "Restore" : action === "delete" ? "Delete" : "Void";
    const extra = action === "delete"
      ? " It will be hidden from the GL (still visible in the audit log)."
      : action === "void"
        ? " A reversal entry will be posted (nothing is deleted)."
        : "";
    if (!(await confirm({ title: `${verb} voucher?`, message: `${verb} ${pvNo}?${extra}`, danger: true }))) return;
    const res = await fetch(`/api/accounting/payment-vouchers/${id}/lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) {
      toast.success(`${pvNo} ${action === "unvoid" ? "restored" : action === "delete" ? "deleted" : "voided"}`);
      load();
    } else toast.error(j?.error || `${verb} failed`);
  };

  // In-place edit: load the voucher into the form (no void). Save re-states it
  // under the same PV number; the original is untouched until then.
  const startEdit = (r: PvRow) => {
    setEditingId(r.id);
    setForm({ date: r.date, payee: r.payee ?? "", description: r.description ?? "", accrued: r.accrued === 1, payFrom: r.payFrom ?? "", accrualAccount: r.accrualAccount ?? "", productLine: r.productLine ?? "" });
    setLines(r.lines.length ? r.lines.map((l) => ({ accountCode: l.accountCode, description: l.description ?? "", amount: (l.amountSen / 100).toFixed(2) })) : [{ accountCode: "", description: "", amount: "" }]);
    setShowForm(true);
  };

  const selCls = "rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm";

  // OCR → prefill the voucher form (payee/date/lines). Receipts carry no GL
  // account, so the account prefills from the SAME payee's latest voucher
  // (same payee almost always books to the same expense account) — blank when
  // the payee is new. Amount = the printed line amounts; single-total docs
  // (petrol slip) prefill one line with the total.
  const applyScan = (d: ScanFinanceResult) => {
    setEditingId(null);
    const normName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const prior = d.partyName
      ? (rows ?? [])
          .filter((r) => r.status !== "VOID" && r.lines?.length && normName(r.payee ?? "") && normName(r.payee ?? "") === normName(d.partyName ?? ""))
          .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0]
      : undefined;
    const lastAcct = prior?.lines?.[0]?.accountCode ?? "";
    setForm((f) => ({
      ...f,
      date: d.docDate ?? new Date().toISOString().slice(0, 10),
      payee: d.partyName ?? f.payee,
      description: [d.docType, d.docNo].filter(Boolean).join(" · ") || f.description,
      accrued: false,
    }));
    setLines(
      d.lines.length
        ? d.lines.map((l) => ({ accountCode: lastAcct, description: l.description, amount: (l.amountSen / 100).toFixed(2) }))
        : d.totalSen
          ? [{ accountCode: lastAcct, description: d.docNo ?? "", amount: (d.totalSen / 100).toFixed(2) }]
          : [{ accountCode: "", description: "", amount: "" }],
    );
    setShowForm(true);
    toast.success(
      lastAcct
        ? "Scanned — account prefilled from this payee's last voucher; review before posting."
        : "Scanned — review the lines and pick the expense account(s).",
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Payment / Expense</h2>
        <div className="flex items-center gap-2">
          <ScanPrefillButton label="Scan Receipt" onResult={applyScan} />
          <Button variant="primary" size="sm" onClick={() => {
            if (showForm) { setShowForm(false); setEditingId(null); }
            else {
              setEditingId(null);
              setForm({ date: new Date().toISOString().slice(0, 10), payee: "", description: "", accrued: false, payFrom: "", accrualAccount: "", productLine: "" });
              setLines([{ accountCode: "", description: "", amount: "" }]);
              setShowForm(true);
            }
          }}>
            <Plus className="h-4 w-4" /> New Payment
          </Button>
        </div>
      </div>
      {migrationMissing && (
        <Card><CardContent className="p-4 text-sm text-[#9A3A2D]">Migration 0159 not applied yet — run the paste-version SQL first.</CardContent></Card>
      )}

      {showForm && (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
                <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={`${selCls} w-full`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">
                  {form.accrued ? "Accrual account" : "Pay from"}
                  <span className="ml-1 text-[#B4B2A9] cursor-help" title={form.accrued ? "Liability account credited (CR)" : "Bank / cash account credited (CR)"}>ⓘ</span>
                </label>
                {form.accrued ? (
                  <select value={form.accrualAccount} onChange={(e) => setForm({ ...form, accrualAccount: e.target.value })} className={`${selCls} w-full`}>
                    <option value="">— pick 410-x / 405-0000 —</option>
                    {accrualOpts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                  </select>
                ) : (
                  <select value={form.payFrom || defaultBankCode(bankCash)} onChange={(e) => setForm({ ...form, payFrom: e.target.value })} className={`${selCls} w-full`}>
                    <option value="">— pick bank/cash —</option>
                    {bankCash.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                  </select>
                )}
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Payee</label>
                <input type="text" placeholder="Who was paid" value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} className={`${selCls} w-full`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Product line (optional)</label>
                <select value={form.productLine} onChange={(e) => setForm({ ...form, productLine: e.target.value })} className={`${selCls} w-full`}>
                  <option value="">(shared — allocate by sales ratio)</option>
                  <option value="SOFA">Sofa</option>
                  <option value="BEDFRAME">Bedframe</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Description</label>
                <input type="text" placeholder="e.g. Factory rent June" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${selCls} w-full`} />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-[#1F1D1B] cursor-pointer">
              <input type="checkbox" checked={form.accrued} onChange={(e) => setForm({ ...form, accrued: e.target.checked })} className="h-4 w-4 accent-[#6B5C32]" />
              Accrue now, pay later
            </label>

            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Expense lines (DR)</label>
              <div className="border border-[#E2DDD8] rounded-md">
                <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_7rem_2rem] bg-[#FAF8F5] text-[11px] font-medium text-[#9CA3AF]">
                  <div className="px-2.5 py-1.5">Account</div>
                  <div className="px-2.5 py-1.5">Description</div>
                  <div className="px-2.5 py-1.5 text-right">Amount (RM)</div>
                  <div />
                </div>
                {lines.map((l, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_7rem_2rem] items-center border-t border-[#F0ECE9]"
                    onKeyDown={(e) => { if (e.key === "Insert") { e.preventDefault(); setLines((prev) => [...prev.slice(0, i + 1), { accountCode: "", description: "", amount: "" }, ...prev.slice(i + 1)]); } }}
                  >
                    <div className="px-1 py-1">
                      <AccountPicker accounts={lineAccounts} value={l.accountCode} onChange={(code) => setLines(lines.map((x, j) => (j === i ? { ...x, accountCode: code } : x)))} placeholder="Account…" />
                    </div>
                    <input type="text" placeholder="Line description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} className="border-0 bg-transparent px-2.5 py-1.5 text-sm w-full focus:outline-none" />
                    <input type="text" placeholder="0.00" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className="border-0 bg-transparent px-2.5 py-1.5 text-sm w-full text-right tabular-nums focus:outline-none" />
                    <button onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : lines)} title="Remove line" className="text-[#B4B2A9] hover:text-[#9A3A2D] text-sm">✕</button>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between mt-2">
                <div className="flex items-center gap-3">
                  <Button variant="outline" size="sm" onClick={() => setLines([...lines, { accountCode: "", description: "", amount: "" }])}>
                    <Plus className="h-4 w-4" /> Add line
                  </Button>
                  <span className="text-[11px] text-[#B4B2A9]">press <span className="font-medium text-[#6B7280]">Insert</span> to add a line below</span>
                </div>
                <span className="text-sm text-[#6B7280]">Total <span className="text-lg font-semibold text-[#1F1D1B] tabular-nums">{formatCurrency(totalSen)}</span></span>
              </div>
            </div>

            <div className="flex gap-2 pt-3 border-t border-[#F0ECE9]">
              <Button variant="primary" size="sm" disabled={saving || totalSen <= 0 || (form.accrued ? !form.accrualAccount : !(form.payFrom || defaultBankCode(bankCash)))} onClick={handleSave}>
                {saving ? (editingId ? "Updating…" : "Posting…") : editingId ? "Update payment" : form.accrued ? "Post (accrued)" : "Post payment"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setShowForm(false); setEditingId(null); }}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search PV no / payee / description" className="rounded-md border border-[#E2DDD8] px-3 py-1.5 text-sm w-64" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "ALL" | "PAID" | "UNPAID" | "VOID")} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm">
          <option value="ALL">All status</option><option value="PAID">Paid</option><option value="UNPAID">Unpaid (accrued)</option><option value="VOID">Void</option>
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm" />
        <span className="text-xs text-[#9CA3AF]">→</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm" />
        <select value={bankFilter} onChange={(e) => setBankFilter(e.target.value)} className="rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm">
          <option value="">All banks</option>
          {bankCash.map((b) => <option key={b.code} value={b.code}>{b.code} {b.name}</option>)}
        </select>
      </div>

      <BatchActionsBar
        count={pvSel.count}
        onClear={pvSel.clear}
        onPrint={() => printVouchers(pvSel.selectedRows.map((r) => buildPvVoucher(r, accounts)))}
        exportName="expense-vouchers"
        exportAoa={() => [
          ["PV No", "Date", "Pay To", "Paid From", "Status", "Remarks", "Product Line", "Voucher Total (RM)", "Account Code", "Account Name", "Line Description", "Amount (RM)"],
          ...pvSel.selectedRows.flatMap((r) => {
            const bank = r.payFrom || r.accrualAccount || "";
            return r.lines.map((l) => [
              r.pvNo ?? r.id,
              r.date ?? "",
              r.payee ?? "",
              bank ? accountLabel(accounts, bank) : "",
              r.status ?? "",
              r.description ?? "",
              r.productLine ?? "",
              (Number(r.totalSen ?? 0) / 100).toFixed(2),
              l.accountCode,
              accounts.find((a) => a.code === l.accountCode)?.name ?? "",
              l.description ?? "",
              (Number(l.amountSen ?? 0) / 100).toFixed(2),
            ]);
          }),
        ]}
      />

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {rows === null ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 w-8"><input type="checkbox" checked={pvSel.allSelected} onChange={pvSel.toggleAll} className="h-3.5 w-3.5 accent-[#6B5C32]" /></th>
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
                {visibleRows.map((r) => (
                  <React.Fragment key={r.id}>
                  <tr
                    className={`border-b border-[#F0ECE9] cursor-pointer hover:bg-[#FAF8F5] ${r.status === "VOID" ? "opacity-50" : ""}`}
                    onClick={() => setExpandedPv((m) => ({ ...m, [r.id]: !m[r.id] }))}
                  >
                    <td className="px-3 py-1.5 w-8" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={pvSel.isSelected(r.pvNo ?? r.id)} onChange={() => pvSel.toggle(r.pvNo ?? r.id)} className="h-3.5 w-3.5 accent-[#6B5C32]" />
                    </td>
                    <td className="px-3 py-1.5 tabular-nums text-xs whitespace-nowrap">
                      <span className="inline-block w-3 text-[#9CA3AF]">{expandedPv[r.id] ? "▾" : "▸"}</span> {r.pvNo}
                    </td>
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
                    <td className="px-3 py-1.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => printVoucher(buildPvVoucher(r, accounts))} title="Print payment voucher" className="inline-flex items-center gap-1 text-[#6B5C32] hover:text-[#1F1D1B] text-xs underline decoration-dotted cursor-pointer mr-3"><Printer className="h-3 w-3" />print</button>
                      {r.status === "POSTED" && (
                        <button onClick={() => startEdit(r)} className="text-[#6B5C32] hover:text-[#1F1D1B] text-xs underline decoration-dotted cursor-pointer mr-3">edit</button>
                      )}
                      {r.status === "POSTED" && r.accrued === 1 && !r.settledAt && (
                        <button onClick={() => handleSettle(r)} className="text-[#6B5C32] hover:text-[#1F1D1B] text-xs underline decoration-dotted cursor-pointer mr-3">settle</button>
                      )}
                      <LifecycleActions
                        state={r.lifecycleState}
                        onVoid={() => handleLifecycle(r.id, r.pvNo, "void")}
                        onDelete={() => handleLifecycle(r.id, r.pvNo, "delete")}
                        onUnvoid={() => handleLifecycle(r.id, r.pvNo, "unvoid")}
                      />
                    </td>
                  </tr>
                  {expandedPv[r.id] && (
                    <tr className="bg-[#FAF8F5] border-b border-[#F0ECE9]">
                      <td colSpan={9} className="px-8 py-2">
                        {r.lines.length === 0 ? (
                          <div className="text-xs text-[#9CA3AF]">No line detail.</div>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-[#9CA3AF] text-left">
                                <th className="py-1 pr-4 font-medium">Account</th>
                                <th className="py-1 pr-4 font-medium">Description</th>
                                <th className="py-1 font-medium text-right">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.lines.map((l, i) => {
                                const nm = accounts.find((a) => a.code === l.accountCode)?.name;
                                return (
                                  <tr key={i} className="border-t border-[#F0ECE9]">
                                    <td className="py-1 pr-4 whitespace-nowrap">{l.accountCode}{nm ? ` · ${nm}` : ""}</td>
                                    <td className="py-1 pr-4">{l.description ?? ""}</td>
                                    <td className="py-1 text-right tabular-nums">{formatCurrency(l.amountSen)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                ))}
                {visibleRows.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-sm text-[#9CA3AF]">No payments match</td></tr>
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
  lifecycleState?: string;
  lines: { accountCode: string; description: string | null; amountSen: number }[];
};

function ReceiptsTab({ accounts }: { accounts: ChartOfAccount[] }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
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

  const orSel = useRowSelection(rows ?? [], (r) => r.orNo ?? r.id);

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
      payTo: form.payTo || defaultBankCode(bankCash),
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

  const handleLifecycle = async (id: string, orNo: string, action: "void" | "delete" | "unvoid") => {
    const verb = action === "unvoid" ? "Restore" : action === "delete" ? "Delete" : "Void";
    const extra = action === "delete"
      ? " It will be hidden from the GL (still visible in the audit log)."
      : action === "void"
        ? " A reversal entry will be posted (nothing is deleted)."
        : "";
    if (!(await confirm({ title: `${verb} receipt?`, message: `${verb} ${orNo}?${extra}`, danger: true }))) return;
    const res = await fetch(`/api/accounting/official-receipts/${id}/lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) {
      toast.success(`${orNo} ${action === "unvoid" ? "restored" : action === "delete" ? "deleted" : "voided"}`);
      load();
    } else toast.error(j?.error || `${verb} failed`);
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
          <CardContent className="p-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
                <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={`${selCls} w-full`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">
                  Deposit to
                  <span className="ml-1 text-[#B4B2A9] cursor-help" title="Bank / cash account debited (DR)">ⓘ</span>
                </label>
                <select value={form.payTo || defaultBankCode(bankCash)} onChange={(e) => setForm({ ...form, payTo: e.target.value })} className={`${selCls} w-full`}>
                  <option value="">— pick bank/cash —</option>
                  {bankCash.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Received from</label>
                <input type="text" placeholder="Who paid us" value={form.receivedFrom} onChange={(e) => setForm({ ...form, receivedFrom: e.target.value })} className={`${selCls} w-full`} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B7280] mb-1 block">Description</label>
                <input type="text" placeholder="e.g. Scrap sale" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${selCls} w-full`} />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Receipt lines (CR — income account or 305-0000 recovery)</label>
              <div className="border border-[#E2DDD8] rounded-md">
                <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_7rem_2rem] bg-[#FAF8F5] text-[11px] font-medium text-[#9CA3AF]">
                  <div className="px-2.5 py-1.5">Account</div>
                  <div className="px-2.5 py-1.5">Description</div>
                  <div className="px-2.5 py-1.5 text-right">Amount (RM)</div>
                  <div />
                </div>
                {lines.map((l, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_7rem_2rem] items-center border-t border-[#F0ECE9]"
                    onKeyDown={(e) => { if (e.key === "Insert") { e.preventDefault(); setLines((prev) => [...prev.slice(0, i + 1), { accountCode: "", description: "", amount: "" }, ...prev.slice(i + 1)]); } }}
                  >
                    <div className="px-1 py-1">
                      <AccountPicker accounts={lineAccounts} value={l.accountCode} onChange={(code) => setLines(lines.map((x, j) => (j === i ? { ...x, accountCode: code } : x)))} placeholder="Account…" />
                    </div>
                    <input type="text" placeholder="Line description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} className="border-0 bg-transparent px-2.5 py-1.5 text-sm w-full focus:outline-none" />
                    <input type="text" placeholder="0.00" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className="border-0 bg-transparent px-2.5 py-1.5 text-sm w-full text-right tabular-nums focus:outline-none" />
                    <button onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : lines)} title="Remove line" className="text-[#B4B2A9] hover:text-[#9A3A2D] text-sm">✕</button>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between mt-2">
                <div className="flex items-center gap-3">
                  <Button variant="outline" size="sm" onClick={() => setLines([...lines, { accountCode: "", description: "", amount: "" }])}>
                    <Plus className="h-4 w-4" /> Add line
                  </Button>
                  <span className="text-[11px] text-[#B4B2A9]">press <span className="font-medium text-[#6B7280]">Insert</span> to add a line below</span>
                </div>
                <span className="text-sm text-[#6B7280]">Total <span className="text-lg font-semibold text-[#1F1D1B] tabular-nums">{formatCurrency(totalSen)}</span></span>
              </div>
            </div>

            <div className="flex gap-2 pt-3 border-t border-[#F0ECE9]">
              <Button variant="primary" size="sm" disabled={saving || totalSen <= 0 || !(form.payTo || defaultBankCode(bankCash))} onClick={handleSave}>
                {saving ? "Posting…" : "Post receipt"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <BatchActionsBar
        count={orSel.count}
        onClear={orSel.clear}
        onPrint={() => printVouchers(orSel.selectedRows.map((r) => buildOrVoucher(r, accounts)))}
        exportName="official-receipts"
        exportAoa={() => [
          ["OR No", "Date", "Received From", "Deposited To", "Status", "Remarks", "Voucher Total (RM)", "Account Code", "Account Name", "Line Description", "Amount (RM)"],
          ...orSel.selectedRows.flatMap((r) =>
            r.lines.map((l) => [
              r.orNo ?? r.id,
              r.date ?? "",
              r.receivedFrom ?? "",
              r.payTo ? accountLabel(accounts, r.payTo) : "",
              r.status ?? "",
              r.description ?? "",
              (Number(r.totalSen ?? 0) / 100).toFixed(2),
              l.accountCode,
              accounts.find((a) => a.code === l.accountCode)?.name ?? "",
              l.description ?? "",
              (Number(l.amountSen ?? 0) / 100).toFixed(2),
            ]),
          ),
        ]}
      />

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {rows === null ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 w-8"><input type="checkbox" checked={orSel.allSelected} onChange={orSel.toggleAll} className="h-3.5 w-3.5 accent-[#6B5C32]" /></th>
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
                    <td className="px-3 py-1.5 w-8">
                      <input type="checkbox" checked={orSel.isSelected(r.orNo ?? r.id)} onChange={() => orSel.toggle(r.orNo ?? r.id)} className="h-3.5 w-3.5 accent-[#6B5C32]" />
                    </td>
                    <td className="px-3 py-1.5 tabular-nums text-xs">{r.orNo}</td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{r.date}</td>
                    <td className="px-3 py-1.5">{[r.receivedFrom, r.description].filter(Boolean).join(" · ")}</td>
                    <td className="px-3 py-1.5 text-xs">{r.payTo}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.totalSen)}</td>
                    <td className="px-3 py-1.5 text-xs">
                      <LifecycleBadge state={r.lifecycleState} />
                      {(r.lifecycleState ?? "ACTIVE") === "ACTIVE" && r.status}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button onClick={() => printVoucher(buildOrVoucher(r, accounts))} title="Print official receipt" className="inline-flex items-center gap-1 text-[#6B5C32] hover:text-[#1F1D1B] text-xs underline decoration-dotted cursor-pointer mr-3"><Printer className="h-3 w-3" />print</button>
                      <LifecycleActions
                        state={r.lifecycleState}
                        onVoid={() => handleLifecycle(r.id, r.orNo, "void")}
                        onDelete={() => handleLifecycle(r.id, r.orNo, "delete")}
                        onUnvoid={() => handleLifecycle(r.id, r.orNo, "unvoid")}
                      />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-[#9CA3AF]">No receipts yet</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============== TAB: FUND TRANSFER (Phase 3) ===============
//
// Move money between bank / cash accounts: DR to-account, CR from-account.
// Posts via POST /api/accounting/fund-transfers; history + void also wired.

type FtRow = {
  no: string;
  date: string;
  fromAccount: string;
  fromName: string;
  toAccount: string;
  toName: string;
  amountSen: number;
  description: string | null;
  lifecycleState?: string;
};

function FundTransferTab({ accounts }: { accounts: ChartOfAccount[] }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const banks = accounts.filter(
    (a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH",
  );
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<FtRow[] | null>(null);
  const ftSel = useRowSelection(rows ?? [], (t) => t.no);

  const selCls = "rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm";

  const load = useCallback(() => {
    fetch("/api/accounting/fund-transfers")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: FtRow[] }>)
      .then((j) => { if (j?.success) setRows(j.data ?? []); })
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async () => {
    const amount = parseFloat(amountStr);
    if (!from || !to || from === to || !(amount > 0)) {
      toast.error(!from || !to ? "Select both From and To accounts" : from === to ? "From and To must be different accounts" : "Enter a positive amount");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/accounting/fund-transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAccount: from,
          toAccount: to,
          amountSen: Math.round(amount * 100),
          date,
          reference,
        }),
      });
      const j = await res.json() as { success?: boolean; data?: { transferNo?: string }; error?: string };
      if (j?.success) {
        toast.success(`Transfer ${j.data?.transferNo ?? ""} posted`);
        setFrom("");
        setTo("");
        setAmountStr("");
        setDate(new Date().toISOString().slice(0, 10));
        setReference("");
        load();
      } else {
        toast.error((j as { error?: string })?.error || "Transfer failed");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleLifecycle = async (no: string, action: "void" | "delete" | "unvoid") => {
    const verb = action === "unvoid" ? "Restore" : action === "delete" ? "Delete" : "Void";
    const extra = action === "delete"
      ? " It will be hidden from the GL (still visible in the audit log)."
      : action === "void"
        ? " A reversal entry will be posted (nothing is deleted)."
        : "";
    if (!(await confirm({ title: `${verb} transfer?`, message: `${verb} transfer ${no}?${extra}`, danger: true }))) return;
    const res = await fetch(`/api/accounting/fund-transfers/${encodeURIComponent(no)}/lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = await res.json() as { success?: boolean; error?: string };
    if (j?.success) {
      toast.success(`${no} ${action === "unvoid" ? "restored" : action === "delete" ? "deleted" : "voided"}`);
      load();
    } else toast.error(j?.error || `${verb} failed`);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[#1F1D1B]">Fund Transfer</h2>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={selCls} />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">From (CR)</label>
              <select value={from} onChange={(e) => setFrom(e.target.value)} className={`${selCls} w-64`}>
                <option value="">— pick bank/cash —</option>
                {banks.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">To (DR)</label>
              <select value={to} onChange={(e) => setTo(e.target.value)} className={`${selCls} w-64`}>
                <option value="">— pick bank/cash —</option>
                {banks.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Amount (RM)</label>
              <input
                type="text"
                placeholder="0.00"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                className={`${selCls} w-36 text-right tabular-nums`}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[#6B7280] mb-1 block">Reference</label>
              <input
                type="text"
                placeholder="Optional"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className={`${selCls} w-48`}
              />
            </div>
          </div>
          <div>
            <Button
              variant="primary"
              size="sm"
              disabled={saving}
              onClick={handleSubmit}
            >
              {saving ? "Posting…" : "Post Transfer"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <BatchActionsBar
        count={ftSel.count}
        onClear={ftSel.clear}
        onPrint={() => printVouchers(ftSel.selectedRows.map((t) => buildFundTransferVoucher(t, accounts)))}
        exportName="fund-transfers"
        exportAoa={() => [
          ["No", "Date", "From", "To", "Status", "Description", "Amount (RM)"],
          ...ftSel.selectedRows.map((t) => [
            t.no,
            formatDateDMY(t.date),
            accountLabel(accounts, t.fromAccount),
            accountLabel(accounts, t.toAccount),
            t.lifecycleState ?? "ACTIVE",
            t.description ?? "",
            (t.amountSen / 100).toFixed(2),
          ]),
        ]}
      />

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {rows === null ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 w-8"><input type="checkbox" checked={ftSel.allSelected} onChange={ftSel.toggleAll} className="h-3.5 w-3.5 accent-[#6B5C32] align-middle" /></th>
                  <th className="px-3 py-2 text-left">No</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">From</th>
                  <th className="px-3 py-2 text-center">→</th>
                  <th className="px-3 py-2 text-left">To</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.no} className={`border-b border-[#F0ECE9] ${(r.lifecycleState ?? "ACTIVE") !== "ACTIVE" ? "opacity-50" : ""}`}>
                    <td className="px-3 py-1.5 w-8">
                      <input type="checkbox" checked={ftSel.isSelected(r.no)} onChange={() => ftSel.toggle(r.no)} className="h-3.5 w-3.5 accent-[#6B5C32] align-middle" />
                    </td>
                    <td className="px-3 py-1.5 tabular-nums text-xs">{r.no}</td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{r.date}</td>
                    <td className="px-3 py-1.5 text-xs">{r.fromAccount} {r.fromName}</td>
                    <td className="px-3 py-1.5 text-center text-[#6B7280]">→</td>
                    <td className="px-3 py-1.5 text-xs">{r.toAccount} {r.toName}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(r.amountSen)}</td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280]">{r.description ?? ""}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <span className="mr-2"><LifecycleBadge state={r.lifecycleState} /></span>
                      <LifecycleActions
                        state={r.lifecycleState}
                        onVoid={() => handleLifecycle(r.no, "void")}
                        onDelete={() => handleLifecycle(r.no, "delete")}
                        onUnvoid={() => handleLifecycle(r.no, "unvoid")}
                      />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-sm text-[#9CA3AF]">No transfers yet</td></tr>
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
  const { confirm } = useConfirm();
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
    if (!(await confirm({ title: "Post closing stock?", message: `Post closing stock for ${month}? This takes the period's stock onto the balance-sheet stock accounts (DR 330-x · CR closing-stock) and brings down opening; re-posting/next month re-bases automatically.`, danger: false }))) return;
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
  const { confirm } = useConfirm();
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

  // Unpost — the way back from a month posted in the wrong shape (owner
  // 2026-08-06: July went in before EPF/SOCSO/EIS were split out). Reverses in
  // the ledger; the month then re-posts in whatever the current shape is.
  const handleUnpost = async () => {
    if (!(await confirm({
      title: `Unpost labour for ${month}?`,
      message:
        "This reverses the posting in the general ledger (nothing is deleted — the reversal is recorded) " +
        "and lets the month be posted again. Do it when the accounts or the split have changed since it was posted.",
      danger: true,
    }))) return;
    setPosting(true);
    try {
      const res = await fetch("/api/accounting/labor/unpost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const j = await res.json() as { success?: boolean; data?: { reversedLegs?: number }; error?: string };
      if (j?.success) {
        toast.success(`Labour ${month} unposted — you can post it again now`);
        load();
      } else toast.error(j?.error || "Unpost failed");
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
                <>
                  <span className="text-xs text-[#27500A] pb-2">Already posted ✓ (DR accounts · CR {data.accrualAccount})</span>
                  {/* Without this the month is frozen in whatever shape it was
                      first posted — the only way back was a hand-written JE. */}
                  <Button variant="outline" size="sm" disabled={posting} onClick={handleUnpost}
                    className="text-[#9A3A2D] hover:bg-[#9A3A2D]/5">
                    {posting ? "Unposting…" : "Unpost"}
                  </Button>
                </>
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
  const { confirm } = useConfirm();
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
    if (!(await confirm({ title: "Dispose asset?", message: `Dispose ${row.name}? Depreciation stops; the disposal gain/loss entry stays a manual JV for now.`, danger: true }))) return;
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
    if (!(await confirm({ title: "Delete asset?", message: `Delete ${row.name}? Only possible while it has no posted depreciation.`, danger: true }))) return;
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
              <div className="overflow-x-auto">
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
              </div>
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
  // PIs entered before the opening date — counted as opening by default
  // (rows untouched); `excluded` marks the wrong/phantom exceptions.
  preExistingAp?: { id: string; piNo: string; supplierName: string; invoiceDate: string | null; amountSen: number; status: string; excluded: number }[];
  arByControl: Record<string, number>;
  arTotalSen: number;
  apTotalSen: number;
  // Other-party controls auto-derived from pre-opening bills (BUG-2026-07-23-003).
  opb405Sen?: number;
  opb305Sen?: number;
};

// One row of the Opening Balance GL grid: either a derived control row the
// server computes, or an account the owner types a figure into.
type ObGridItem =
  | { kind: "auto"; code: string; name: string; note: string; drSen?: number; crSen?: number }
  | { kind: "account"; code: string; name: string };

// Measured height of one GL-grid row on prod. Derived rows are naturally a few
// pixels shorter, so they are pinned to the same height — a uniform row height
// is what makes the spacer arithmetic exact.
const OPENING_BALANCE_ROW_PX = 42;

function OpeningBalanceTab({ accounts, onRefresh }: { accounts: ChartOfAccount[]; onRefresh: () => void }) {
  const { toast } = useToast();
  const [data, setData] = useState<ObState | null>(null);
  const [openingDate, setOpeningDate] = useState("");
  const [savingDate, setSavingDate] = useState(false);
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

  // Mid-year opening: ALL postable accounts (balance sheet AND P&L) — the
  // opening date sits inside the financial year, so the old books' YTD
  // sales/purchases/expenses must ride along. Controls stay derived rows.
  const glAccounts = accounts
    .filter(
      (a) =>
        a.isPostable !== false &&
        a.specialAccountType !== "SDC" &&
        a.specialAccountType !== "SCC",
    )
    .sort((a, b) => a.code.localeCompare(b.code));

  const userDr = glAccounts.reduce((s, a) => s + toSen(amounts[a.code]?.dr ?? ""), 0);
  const userCr = glAccounts.reduce((s, a) => s + toSen(amounts[a.code]?.cr ?? ""), 0);

  // The GL grid carries TWO text inputs per account — ~200 accounts meant 400
  // mounted inputs, a 951ms freeze on open and a re-render of all 400 on every
  // keystroke (measured on prod 2026-08-01). It is windowed below.
  //
  // The derived control rows live in the SAME item array as the editable
  // account rows rather than in a static block above the window: the
  // virtualizer measures offsets from the top of the scroll container, so a
  // static block above it would shift every row by the block's height and the
  // window would drift off by that many rows.
  const obGridItems = useMemo<ObGridItem[]>(() => {
    const auto: ObGridItem[] = [];
    for (const [ctl, amt] of Object.entries(data?.arByControl ?? {})) {
      auto.push({
        kind: "auto", code: ctl, name: accounts.find((a) => a.code === ctl)?.name ?? "",
        note: "auto — Σ debtor opening invoices", drSen: amt,
      });
    }
    if ((data?.apTotalSen ?? 0) !== 0) {
      auto.push({
        kind: "auto", code: "400-0000",
        name: accounts.find((a) => a.code === "400-0000")?.name ?? "TRADE CREDITORS",
        note: "auto — Σ creditor opening + included pre-opening invoices", crSen: data!.apTotalSen,
      });
    }
    if ((data?.opb405Sen ?? 0) !== 0) {
      auto.push({
        kind: "auto", code: "405-0000",
        name: accounts.find((a) => a.code === "405-0000")?.name ?? "OTHER CREDITOR",
        note: "auto — Σ pre-opening other-creditor bills", crSen: data!.opb405Sen ?? 0,
      });
    }
    if ((data?.opb305Sen ?? 0) !== 0) {
      auto.push({
        kind: "auto", code: "305-0000",
        name: accounts.find((a) => a.code === "305-0000")?.name ?? "OTHER DEBTOR",
        note: "auto — Σ pre-opening other-debtor bills", drSen: data!.opb305Sen ?? 0,
      });
    }
    return [...auto, ...glAccounts.map((a) => ({ kind: "account" as const, code: a.code, name: a.name }))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, accounts, glAccounts.length]);

  const obScrollRef = useRef<HTMLDivElement>(null);
  const obVirt = useVirtualRows({
    count: obGridItems.length,
    rowHeight: OPENING_BALANCE_ROW_PX,
    scrollRef: obScrollRef,
    colSpan: 3,
  });
  // Derived controls: 300-x/305 (DR) and 400/405 (CR) ride alongside the
  // manual rows — must mirror /opening-balance/post exactly or the preview
  // difference lies (405 was missing → the grid showed a smaller gap than
  // the server would enforce).
  const totalDr = userDr + (data?.arTotalSen ?? 0) + (data?.opb305Sen ?? 0);
  const totalCr = userCr + (data?.apTotalSen ?? 0) + (data?.opb405Sen ?? 0);
  const diff = totalDr - totalCr;

  // Save just the opening date (self-service, no posting required) — sets when
  // the books start from this Maintenance tab.
  const saveOpeningDate = async () => {
    if (!openingDate) { toast.error("Pick an opening date first"); return; }
    setSavingDate(true);
    try {
      const res = await fetch("/api/accounting/opening-date", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openingDate }),
      });
      const j = asMutationResponse(await res.json());
      if (res.ok && j?.success) toast.success(`Opening date set to ${openingDate}`);
      else toast.error(j?.error || "Failed to save opening date");
    } catch {
      toast.error("Failed to save opening date");
    } finally {
      setSavingDate(false);
    }
  };

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

  // Collapsed by default (owner 2026-07-02) — the totals in the header carry
  // the signal; expand only to audit or exclude a row.
  const [preApOpen, setPreApOpen] = useState(false);

  // Pre-opening PIs count as opening by default; toggling exclusion only
  // writes the exclude table — the PI row itself is never touched.
  const toggleApExclude = async (piId: string, excluded: boolean) => {
    const res = await fetch("/api/accounting/opening-balance/ap-exclude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ piId, excluded }),
    });
    const j = asMutationResponse(await res.json());
    if (res.ok && j?.success) {
      toast.success(excluded ? "Excluded from opening" : "Included in opening again");
      load(false);
    } else toast.error(j?.error || "Failed to update opening inclusion");
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
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={openingDate}
                onChange={(e) => setOpeningDate(e.target.value)}
                className="rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm"
              />
              <Button variant="outline" size="sm" disabled={savingDate || !openingDate} onClick={saveOpeningDate}>
                {savingDate ? "Saving…" : "Save"}
              </Button>
            </div>
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
            <div className="overflow-x-auto">
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
            </div>
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
            <div className="overflow-x-auto">
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
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pre-opening PIs — counted as opening by default; rows never touched */}
      {(data?.preExistingAp?.length ?? 0) > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <button
              type="button"
              onClick={() => setPreApOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-3 flex-wrap text-left cursor-pointer"
            >
              <h3 className="text-sm font-semibold text-[#1F1D1B] flex items-center gap-1">
                {preApOpen ? <ChevronDownIcon className="h-4 w-4 shrink-0 text-[#6B5C32]" /> : <ChevronRight className="h-4 w-4 shrink-0 text-[#6B5C32]" />}
                Already-entered supplier invoices (before opening date){" "}
                <span className="font-normal text-[#6B7280]">
                  — counted as opening automatically ({(data?.preExistingAp ?? []).length} PIs)
                </span>
              </h3>
              <span className="text-sm text-[#6B7280]">
                Included{" "}
                <span className="font-medium text-[#1F1D1B] tabular-nums">
                  {formatCurrency((data?.preExistingAp ?? []).filter((r) => !r.excluded).reduce((s, r) => s + (Number(r.amountSen) || 0), 0))}
                </span>
                {" "}· Excluded{" "}
                <span className="font-medium text-[#9A3A2D] tabular-nums">
                  {formatCurrency((data?.preExistingAp ?? []).filter((r) => r.excluded).reduce((s, r) => s + (Number(r.amountSen) || 0), 0))}
                </span>
              </span>
            </button>
            {preApOpen && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                    <th className="px-2 py-1.5 text-left">Supplier</th>
                    <th className="px-2 py-1.5 text-left">PI No</th>
                    <th className="px-2 py-1.5 text-left">Date</th>
                    <th className="px-2 py-1.5 text-right">Amount</th>
                    <th className="px-2 py-1.5 text-left">Status</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {(data?.preExistingAp ?? []).map((r) => (
                    <tr key={r.id} className={`border-b border-[#F0ECE9] ${r.excluded ? "opacity-50" : ""}`}>
                      <td className="px-2 py-1.5">{r.supplierName}</td>
                      <td className="px-2 py-1.5 tabular-nums text-xs">{r.piNo}</td>
                      <td className="px-2 py-1.5 text-xs text-[#6B7280]">{r.invoiceDate ?? ""}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(r.amountSen)}</td>
                      <td className="px-2 py-1.5 text-xs text-[#6B7280]">
                        {r.excluded ? <span className="text-[#9A3A2D] font-medium">EXCLUDED</span> : "counted as opening"}
                      </td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">
                        {r.excluded ? (
                          <button onClick={() => toggleApExclude(r.id, false)} className="text-xs text-[#3E6570] hover:underline cursor-pointer">include again</button>
                        ) : (
                          <button onClick={() => toggleApExclude(r.id, true)} className="text-xs text-[#9A3A2D] hover:underline decoration-dotted cursor-pointer">exclude</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* GL grid — all postable accounts (BS + P&L, mid-year opening); controls are derived read-only rows */}
      <Card>
        <CardContent className="p-0">
          <div ref={obScrollRef} className="overflow-auto max-h-[70vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white">
              <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                <th className="px-3 py-2 text-left">Account (balance sheet &amp; P&amp;L)</th>
                <th className="px-3 py-2 text-right w-40">Debit (RM)</th>
                <th className="px-3 py-2 text-right w-40">Credit (RM)</th>
              </tr>
            </thead>
            <tbody>
              {obVirt.topSpacer}
              {(obVirt.active ? obVirt.indices.map((i) => obGridItems[i]) : obGridItems).map((it) =>
                !it ? null : it.kind === "auto" ? (
                <tr key={`auto-${it.code}`} className="border-b border-[#F0ECE9] bg-[#F7F4EF]" style={{ height: OPENING_BALANCE_ROW_PX }}>
                  <td className="px-3 py-1.5">
                    <span className="tabular-nums text-xs text-[#6B7280] mr-1">{it.code}</span>
                    {it.name}
                    <span className="ml-2 text-[11px] text-[#9CA3AF]">{it.note}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {it.drSen != null ? formatCurrency(it.drSen) : <span className="text-[#9CA3AF]">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {it.crSen != null ? formatCurrency(it.crSen) : <span className="text-[#9CA3AF]">—</span>}
                  </td>
                </tr>
              ) : (
                <tr key={it.code} className="border-b border-[#F0ECE9]" style={{ height: OPENING_BALANCE_ROW_PX }}>
                  <td className="px-3 py-1.5">
                    <span className="tabular-nums text-xs text-[#6B7280] mr-1">{it.code}</span>
                    <span className="text-[#1F1D1B]">{it.name}</span>
                  </td>
                  <td className="px-3 py-1">
                    <input
                      type="text"
                      value={amounts[it.code]?.dr ?? ""}
                      onChange={(e) => setAmounts({ ...amounts, [it.code]: { dr: e.target.value, cr: "" } })}
                      placeholder=""
                      className={inputCls}
                    />
                  </td>
                  <td className="px-3 py-1">
                    <input
                      type="text"
                      value={amounts[it.code]?.cr ?? ""}
                      onChange={(e) => setAmounts({ ...amounts, [it.code]: { dr: "", cr: e.target.value } })}
                      placeholder=""
                      className={inputCls}
                    />
                  </td>
                </tr>
                ),
              )}
              {obVirt.bottomSpacer}
              <tr className="bg-[#F0ECE9]/60 font-semibold text-[#1F1D1B]">
                <td className="px-3 py-2">TOTAL (incl. auto control rows)</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalDr)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalCr)}</td>
              </tr>
            </tbody>
          </table>
          </div>
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
  const { confirm } = useConfirm();
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
    if (!(await confirm({
      title: "Close financial year?",
      message: `Close FY ended ${preview.fyEnd}?\n\nNet ${preview.netSen >= 0 ? "profit" : "loss"} of ${formatCurrency(Math.abs(preview.netSen))} across ${preview.accountCount} P&L accounts will be posted to 150-0000 RETAINED EARNING. This writes immutable ledger entries.`,
      danger: false,
    }))) return;
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

// Multi-company (Phase 2) — compact "by company" breakdown for the group view.
// Fetches /pl per active company IN PARALLEL and shows each one's Net Profit
// (P&L for the period) and Total Equity (net worth as at period end), so the
// owner sees the consolidated group split into its sister companies at a
// glance. Purely additive: it reuses the SAME /pl?orgId= endpoint the drill
// already uses and never touches the consolidated statement above it. All
// money is integer sen (formatCurrency divides by 100).
function GroupByCompanyCard({ period, options }: { period: string; options: CompanyOption[] }) {
  // Only real companies (drop the "" group option). useCompanyOptions returns
  // a fresh array each render, so key the memo/effect off a STABLE string of
  // the company codes (not the array identity) to avoid a re-fetch loop.
  const companyKey = options.filter((o) => o.value !== "").map((o) => o.value).join(",");
  const companies = useMemo(
    () => options.filter((o) => o.value !== ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- companyKey is the stable identity of `options`
    [companyKey],
  );
  const [rows, setRows] = useState<{ value: string; label: string; netProfitSen: number; equitySen: number }[] | null>(null);

  useEffect(() => {
    if (companies.length === 0) return;
    let stale = false;
    Promise.all(
      companies.map(async (co) => {
        try {
          const r = await fetch(`/api/accounting/pl?period=${period}${orgIdParam(co.value)}`);
          const j = (await r.json()) as {
            success?: boolean;
            data?: { totals?: { netProfit?: number }; balanceSheet?: { category: string; balance: number }[] };
          };
          const netProfitSen = j?.data?.totals?.netProfit ?? 0;
          const equitySen = (j?.data?.balanceSheet ?? [])
            .filter((e) => e.category === "EQUITY")
            .reduce((s, e) => s + (e.balance || 0), 0);
          return { value: co.value, label: co.label, netProfitSen, equitySen };
        } catch {
          return { value: co.value, label: co.label, netProfitSen: 0, equitySen: 0 };
        }
      }),
    ).then((res) => { if (!stale) setRows(res); });
    return () => { stale = true; };
  }, [period, companies]);

  if (companies.length === 0) return null;

  const totalNet = (rows ?? []).reduce((s, r) => s + r.netProfitSen, 0);
  const totalEquity = (rows ?? []).reduce((s, r) => s + r.equitySen, 0);

  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="text-sm font-semibold text-[#1F1D1B] mb-1">
          Group P&amp;L by company
          <span className="font-normal text-[#6B7280]"> — net profit for {period} &amp; net worth at period-end, per sister company</span>
        </h3>
        {rows === null ? (
          <p className="text-sm text-[#6B7280] py-2">Loading company breakdown…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">Company</th>
                  <th className="px-3 py-2 text-right">Net Profit ({period})</th>
                  <th className="px-3 py-2 text-right">Total Equity (net worth)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.value} className="border-b border-[#F0ECE9]">
                    <td className="px-3 py-1.5 text-[#1F1D1B]">{r.label}</td>
                    <td className={`px-3 py-1.5 text-right font-medium ${r.netProfitSen < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                      {r.netProfitSen < 0 ? `(${formatCurrency(Math.abs(r.netProfitSen))})` : formatCurrency(r.netProfitSen)}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-medium ${r.equitySen < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                      {r.equitySen < 0 ? `(${formatCurrency(Math.abs(r.equitySen))})` : formatCurrency(r.equitySen)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-[#1F1D1B] font-semibold">
                  <td className="px-3 py-2 text-[#1F1D1B]">Group total</td>
                  <td className={`px-3 py-2 text-right ${totalNet < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                    {totalNet < 0 ? `(${formatCurrency(Math.abs(totalNet))})` : formatCurrency(totalNet)}
                  </td>
                  <td className={`px-3 py-2 text-right ${totalEquity < 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                    {totalEquity < 0 ? `(${formatCurrency(Math.abs(totalEquity))})` : formatCurrency(totalEquity)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-[#B4B2A9]">
              Each row = that company scoped via ?orgId=. Today all data sits under HOOKKA, so sister companies read near-zero until their books are posted. The consolidated statement below is unchanged.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BalanceSheetTab() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  // Multi-company (Phase 2): "" = All companies (group) → URL unchanged =
  // today's consolidated sheet. A company code scopes /pl via &orgId=.
  const [company, setCompany] = useState("");
  const companyOptions = useCompanyOptions();
  const months: string[] = [];
  {
    const now = new Date();
    for (let i = 0; i < 18; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
  }
  const { data: bsResp, loading: bsLoading, refresh: bsRefresh } = useCachedJson<{ success?: boolean; data?: { balanceSheet?: BalanceSheetEntry[]; cashFlow?: CashFlowResp } }>(`/api/accounting/pl?period=${period}${orgIdParam(company)}`);
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
    <div className="space-y-6 max-md:space-y-4">
      <YearCloseCard />
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-semibold text-[#1F1D1B]">As at month-end</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border border-[#E2DDD8] bg-white px-3 py-1.5 text-sm">
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <CompanySelect value={company} onChange={setCompany} options={companyOptions} />
        <button onClick={() => setEdit((v) => !v)}
          className={`ml-2 rounded-md border px-3 py-1.5 text-sm cursor-pointer ${edit ? "bg-[#6B5C32] text-white border-[#6B5C32]" : "bg-white text-[#4B5563] border-[#E2DDD8] hover:bg-[#F0ECE9]"}`}>
          {edit ? "Done" : "Edit"}
        </button>
        {edit && <span className="text-[11px] text-[#6B5C32]">Drag an account row onto a target section to reclassify it · Assets ↔ Liabilities is allowed too (the sign flips on the move, the statement still balances) · all months recompute under the new rule · drag back to undo</span>}
      </div>
      {/* Group P&L / net-worth by company — only on the consolidated (group)
          view; picking a single company hides it (you're already scoped). */}
      {company === "" && <GroupByCompanyCard period={period} options={companyOptions} />}
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
          <div className="border border-[#E2DDD8] rounded-lg overflow-hidden overflow-x-auto">
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
