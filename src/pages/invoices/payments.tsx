import { useState, useMemo, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { defaultBankCode } from "@/lib/default-bank";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LifecycleBadge } from "@/components/accounting/lifecycle-actions";
import { CreditCard } from "lucide-react";
import type { PaymentRecord, Invoice } from "@/types";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { PaymentSchema } from "@/lib/schemas/invoice";
import { COMPANY } from "@/lib/constants";
import { amountInWords } from "@/lib/amount-in-words";
import { printVouchers, type VoucherSpec, type VoucherLine } from "@/lib/print-voucher";
import { BatchActionsBar } from "@/components/accounting/batch-actions-bar";

const PaymentMutationSchema = mutationWithData(PaymentSchema);

type CustomerOption = {
  id: string;
  name: string;
};

// COMPANY.HOOKKA → the VoucherSpec.company shape (single source of truth);
// mirrors VOUCHER_COMPANY in supplier-payments.tsx / accounting/index.tsx.
const VOUCHER_COMPANY: VoucherSpec["company"] = {
  name: COMPANY.HOOKKA.name,
  addressLines: COMPANY.HOOKKA.addressLines,
  regNo: COMPANY.HOOKKA.regNo,
  tin: COMPANY.HOOKKA.tin,
  phone: COMPANY.HOOKKA.phone,
  email: COMPANY.HOOKKA.email,
};

// Money on the receipt that is not yet sitting against an invoice. The customer
// twin of hasUnappliedAdvance in supplier-payments.tsx: there, an advance is a
// payment LINE with no invoice; here a receipt is one row whose allocations may
// simply not add up to it, so the leftover is the difference. Both are integer
// sen (formatRM's input), so they subtract directly.
//
// Owner 2026-08-06: 「如果有还没 knock off clear 的我要像 supplier 这样整体字体
// 显示蓝色」— a receipt with money still on account is work outstanding, and he
// wants to spot it down the list without opening anything.
function unallocatedSen(p: PaymentRecord): number {
  const allocated = (p.allocations ?? []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
  return Math.max(0, (Number(p.amount) || 0) - allocated);
}

// Voided / deleted receipts are already dimmed and carry no obligation, so they
// never turn blue however little of them was allocated.
function hasUnallocated(p: PaymentRecord): boolean {
  return (p.lifecycleState ?? "ACTIVE") === "ACTIVE" && unallocatedSen(p) > 0;
}

// One customer receipt → a PAYMENT RECEIPT voucher: one line per invoice the
// receipt cleared (Invoice No · amount), total = the receipt amount. Money
// stays integer sen, formatted with formatCurrency. The customer twin of
// buildSupplierPaymentVoucher in supplier-payments.tsx.
function buildCustomerPaymentVoucher(p: PaymentRecord): VoucherSpec {
  const active = (p.lifecycleState ?? "ACTIVE") === "ACTIVE";
  // Date first on the printed receipt too — the customer matches it against
  // their own statement, which is ordered by date.
  const lines: VoucherLine[] = p.allocations.map((a) => ({
    cells: [a.invoiceDate ? formatDateDMY(a.invoiceDate) : "", a.invoiceNumber, formatCurrency(a.amount)],
  }));
  return {
    title: active ? "PAYMENT RECEIPT" : "PAYMENT RECEIPT — VOID",
    company: VOUCHER_COMPANY,
    docNo: p.receiptNumber,
    date: formatDateDMY(p.date),
    partyLabel: "Received From",
    partyName: p.customerName ?? "",
    columns: [{ label: "Date" }, { label: "Invoice" }, { label: "Amount", align: "right" }],
    lines,
    totalCells: ["", "Total", formatCurrency(p.amount)],
    amountWords: amountInWords(p.amount),
    // The customer receipt carries no bank/deposit account in PaymentRecord, so
    // there is no "Deposited to" footer; surface the payment reference instead.
    remarks: p.reference || undefined,
    signatures: [{ label: "Received by" }, { label: "Issued by" }],
    printedOn: formatDateDMY(new Date()),
  };
}

export default function PaymentsPage() {
  const { data: payResp, loading, refresh: refreshPayments } = useCachedJson<{ success?: boolean; data?: PaymentRecord[] }>("/api/payments");
  const payments: PaymentRecord[] = useMemo(
    () => (payResp?.success ? payResp.data ?? [] : Array.isArray(payResp) ? payResp : []),
    [payResp]
  );
  const { data: custResp } = useCachedJson<{ success?: boolean; data?: { id: string; name: string }[] }>("/api/customers");
  const { data: invResp, refresh: refreshInvoices } = useCachedJson<{ success?: boolean; data?: Invoice[] }>("/api/invoices");
  const customers: CustomerOption[] = useMemo(() => {
    const raw = custResp?.success ? custResp.data ?? [] : Array.isArray(custResp) ? (custResp as { id: string; name: string }[]) : [];
    return raw.map((c) => ({ id: c.id, name: c.name }));
  }, [custResp]);
  const invoices: Invoice[] = useMemo(
    () => (invResp?.success ? invResp.data ?? [] : Array.isArray(invResp) ? invResp : []),
    [invResp]
  );

  // Create form state
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [method, setMethod] = useState<PaymentRecord["method"]>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  // Document date (owner 2026-07-07): receipts are often keyed in days after
  // the money landed — the operator picks the real date; defaults to today.
  const [payDate, setPayDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  // Owner: the receipt deposits into a SPECIFIC bank/cash account, not a
  // method-derived default. Options = SBK/SCH accounts from the COA.
  const [bankAccount, setBankAccount] = useState("");
  const [bankOptions, setBankOptions] = useState<{ code: string; name: string }[]>([]);
  const [allocations, setAllocations] = useState<{ invoiceId: string; amount: number }[]>([]);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<PaymentRecord | null>(null);
  // Ticked-row selection for batch print + export. The history list uses the
  // shared DataGrid, which owns its own checkbox column (selectable) and
  // reports the picked rows via onSelectionChange — mirror that into state so
  // the BatchActionsBar (print receipt / Excel / CSV) can act on the selection.
  const [selectedPayments, setSelectedPayments] = useState<PaymentRecord[]>([]);
  const { toast } = useToast();
  const { confirm } = useConfirm();
  // Edit mode: when set, the inline form is editing an existing receipt in place
  // (same number). editBaseline = that receipt's original per-invoice amounts,
  // added back to each invoice's outstanding so they stay re-allocatable.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBaseline, setEditBaseline] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch("/api/accounting/coa")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { code: string; name: string; specialAccountType?: string }[] }>)
      .then((j) => {
        if (!j?.success) return;
        const opts = (j.data ?? [])
          .filter((a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH")
          .map((a) => ({ code: a.code, name: a.name }));
        setBankOptions(opts);
        // Default the deposit account to Hong Leong Bank (owner preference);
        // shared helper matches HLBB/HLB, falls back to the first bank/cash.
        setBankAccount((prev) => prev || defaultBankCode(opts));
      })
      .catch(() => {});
  }, []);

  // Outstanding invoices for the selected customer, OLDEST FIRST — newest at
  // the bottom (owner 2026-08-06: 「跟着循序往下，最新的在最下面」). A receipt
  // is applied to the oldest debt first, so the list should read in the order
  // the operator works down it; the API's order is by invoice number, which for
  // back-entered documents is not chronological at all.
  const customerInvoices = invoices
    .filter(
      (inv) =>
        inv.customerId === selectedCustomerId &&
        inv.status !== "CANCELLED" &&
        // Open invoices, plus any the receipt-being-edited paid (so they can be
        // re-allocated even though they're currently marked PAID).
        (inv.status !== "PAID" || editBaseline[inv.id] !== undefined)
    )
    .sort(
      (a, b) =>
        String(a.invoiceDate ?? "").localeCompare(String(b.invoiceDate ?? "")) ||
        String(a.invoiceNo ?? "").localeCompare(String(b.invoiceNo ?? ""))
    );

  const handleCustomerChange = (custId: string) => {
    setSelectedCustomerId(custId);
    setAllocations([]);
  };

  // Supplier-payment-style upsert: typing an amount creates the allocation if
  // it isn't there yet; clearing it (0) drops the invoice from the receipt.
  const setAllocAmount = (invId: string, sen: number) => {
    setAllocations((prev) => {
      const others = prev.filter((a) => a.invoiceId !== invId);
      return sen > 0 ? [...others, { invoiceId: invId, amount: sen }] : others;
    });
  };

  const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0);

  // What the bank actually received. Until 2026-08-06 this WAS the allocation
  // total, so a receipt could never hold money on account and the operator
  // could not record a deposit at all (owner: 「我要的就类似 advance」).
  //
  // It tracks the allocations until the operator types in it, then it is his
  // number — the same anchoring the supplier voucher uses for its Advance box.
  // That keeps the old behaviour exactly for anyone who just ticks invoices.
  const [amountStr, setAmountStr] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const receivedSen = amountTouched
    ? Math.max(0, Math.round((parseFloat(amountStr) || 0) * 100))
    : totalAllocated;
  const onAccountSen = Math.max(0, receivedSen - totalAllocated);
  const overAllocated = totalAllocated > receivedSen;
  const canSubmit = !!selectedCustomerId && receivedSen > 0 && !overAllocated;

  const handleCreate = async () => {
    if (!canSubmit) return;
    setCreating(true);
    try {
      // Sprint 3 #4 — idempotency. Payment is the highest-risk POST
      // in the app; a retry under network blip would double-collect.
      const data = await fetchJson("/api/payments", PaymentMutationSchema, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: {
          customerId: selectedCustomerId,
          amount: receivedSen,
          method,
          reference,
          bankAccount,
          date: payDate,
          allocations,
        },
      });
      if (data.success) {
        setSelectedCustomerId("");
        setMethod("BANK_TRANSFER");
        setReference("");
        setPayDate(new Date().toISOString().slice(0, 10));
        setAllocations([]);
        setAmountTouched(false);
        setAmountStr("");
        invalidateCachePrefix("/api/payments");
        invalidateCachePrefix("/api/invoices");
        // A receipt decrements the customer's A/R (accounting.ts), so the
        // Customers list' Outstanding / Available headroom is now stale. Drop
        // its cache so the next visit refetches the ledger-true balance.
        invalidateCachePrefix("/api/customers");
        refreshPayments();
        refreshInvoices();
      }
    } catch {
      // ignore
    }
    setCreating(false);
  };

  const handleLifecycle = async (id: string, action: "void" | "delete" | "unvoid") => {
    const verb = action === "unvoid" ? "Restore" : action === "delete" ? "Delete" : "Void";
    const extra = action === "delete"
      ? " It will be hidden from the GL (still visible in the audit log)."
      : action === "void"
        ? " This reverses the receipt (nothing is deleted)."
        : "";
    if (!(await confirm({ title: `${verb} receipt?`, message: `${verb} this receipt?${extra}`, danger: true }))) return;
    try {
      const res = await fetch(`/api/payments/${encodeURIComponent(id)}/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (res.ok && j.success) {
        toast.success(`Receipt ${action === "unvoid" ? "restored" : action === "delete" ? "deleted" : "voided"}`);
        invalidateCachePrefix("/api/payments");
        invalidateCachePrefix("/api/invoices");
        invalidateCachePrefix("/api/customers"); // A/R reversed/restored → refresh Outstanding/Available
        refreshPayments();
        refreshInvoices();
        setDetail(null);
      } else {
        toast.error(j.error || `Failed to ${verb.toLowerCase()} receipt`);
      }
    } catch {
      toast.error(`Failed to ${verb.toLowerCase()} receipt`);
    }
  };

  // Edit = void the original (GL reversed, invoices reopened, customer A/R
  // restored) then reload the inline form prefilled, so the operator corrects
  // and re-posts. The immutable ledger is never mutated in place.
  // In-place edit: load the receipt into the inline form (no void). The original
  // stays untouched until Save, which re-states it under the SAME number.
  const editPayment = (p: PaymentRecord) => {
    setDetail(null);
    setEditingId(p.id);
    setEditBaseline(Object.fromEntries(p.allocations.map((a) => [a.invoiceId, a.amount])));
    setSelectedCustomerId(p.customerId);
    setAllocations(p.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })));
    setMethod(p.method);
    setReference(p.reference ?? "");
    setPayDate((p.date || "").slice(0, 10) || new Date().toISOString().slice(0, 10));
    // Load the receipt's OWN amount, not the allocation sum — editing an
    // advance must not silently shrink it to whatever is knocked off so far.
    setAmountTouched(true);
    setAmountStr(((Number(p.amount) || 0) / 100).toFixed(2));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditBaseline({});
    setSelectedCustomerId("");
    setAllocations([]);
    setReference("");
    setPayDate(new Date().toISOString().slice(0, 10));
    setAmountTouched(false);
    setAmountStr("");
  };

  // Save: create a new receipt, or — in edit mode — re-state the existing one in
  // place (same number; the GL is reversed + re-posted server-side).
  const handleSave = async () => {
    if (!editingId) { handleCreate(); return; }
    if (!canSubmit) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/payments/${encodeURIComponent(editingId)}/restate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, reference, bankAccount, date: payDate, allocations, amountSen: receivedSen }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (res.ok && j.success) {
        toast.success("Receipt updated");
        invalidateCachePrefix("/api/payments");
        invalidateCachePrefix("/api/invoices");
        invalidateCachePrefix("/api/customers"); // A/R re-stated → refresh Outstanding/Available
        refreshPayments();
        refreshInvoices();
        cancelEdit();
      } else {
        toast.error(j.error || "Failed to update receipt");
      }
    } catch {
      toast.error("Failed to update receipt");
    }
    setCreating(false);
  };

  const columns: Column<PaymentRecord>[] = [
    {
      key: "receiptNumber",
      label: "Receipt #",
      type: "docno",
      render: (_value, row) => (
        <span className="font-mono font-medium text-sm">{row.receiptNumber}</span>
      ),
    },
    {
      key: "customerName",
      label: "Customer",
    },
    {
      key: "date",
      label: "Date",
      type: "date",
      render: (_value, row) => formatDateDMY(row.date),
    },
    {
      key: "amount",
      label: "Amount",
      type: "currency",
      align: "right",
      // The row-level blue only reaches cells that don't set their own colour,
      // so every hardcoded one here stands down while money is unallocated.
      render: (_value, row) => (
        <span className={`font-medium ${hasUnallocated(row) ? "" : "text-[#4F7C3A]"}`}>
          {formatRM(row.amount)}
        </span>
      ),
    },
    {
      key: "method",
      label: "Method",
      render: (_value, row) => (
        <Badge>{row.method.replace(/_/g, " ")}</Badge>
      ),
    },
    {
      key: "reference",
      label: "Reference",
      render: (_value, row) => (
        <span className={`text-sm font-mono ${hasUnallocated(row) ? "" : "text-gray-600"}`}>
          {row.reference || "-"}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      type: "status",
      render: (_value, row) => {
        const statusMap: Record<string, string> = {
          RECEIVED: "RECEIVED",
          CLEARED: "COMPLETED",
          BOUNCED: "FAIL",
        };
        return (
          <Badge variant="status" status={statusMap[row.status] || row.status}>
            {row.status}
          </Badge>
        );
      },
    },
    {
      key: "allocations",
      label: "Allocated",
      render: (_value, row) => {
        const left = unallocatedSen(row);
        if (row.allocations.length === 0)
          return <span className={`text-sm ${hasUnallocated(row) ? "" : "text-gray-400"}`}>Unallocated</span>;
        return (
          <span className={`text-sm ${hasUnallocated(row) ? "" : "text-gray-600"}`}>
            {row.allocations.length} invoice{row.allocations.length > 1 ? "s" : ""}
            {/* The number of invoices alone can't show that money is left over. */}
            {left > 0 && ` · ${formatRM(left)} left`}
          </span>
        );
      },
    },
  ];

  const contextMenuItems: ContextMenuItem[] = [
    // (Removed dead no-op "View"/"Print" — no payment detail page or payment
    // PDF exists, so they did nothing when clicked.)
    {
      label: "Refresh",
      action: (_row) => refreshPayments(),
    },
  ];

  // Summary stats
  const active = payments.filter((p) => (p.lifecycleState ?? "ACTIVE") === "ACTIVE");
  const totalReceived = active.reduce((s, p) => s + p.amount, 0);
  const clearedCount = active.filter((p) => p.status === "CLEARED").length;
  const pendingCount = active.filter((p) => p.status === "RECEIVED").length;
  const bouncedCount = active.filter((p) => p.status === "BOUNCED").length;

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-md:p-4 max-sm:p-3 max-md:space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Payment Tracking</h1>
          <p className="text-sm text-gray-500 mt-1">
            Record and track customer payments with invoice allocation
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-gray-500">Total Received</p>
                <p className="text-xl font-bold text-[#4F7C3A] truncate">{formatCurrency(totalReceived)}</p>
              </div>
              <CreditCard className="h-8 w-8 text-[#4F7C3A] shrink-0" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm text-gray-500">Cleared</p>
              <p className="text-2xl font-bold">{clearedCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm text-gray-500">Pending</p>
              <p className="text-2xl font-bold text-[#9C6F1E]">{pendingCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm text-gray-500">Bounced</p>
              <p className="text-2xl font-bold text-[#9A3A2D]">{bouncedCount}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Record Payment — inline (unified with Supplier Payment) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{editingId ? "Edit Receipt" : "Record Payment"}</CardTitle>
            <div className="flex items-center gap-2">
              {editingId && (
                <Button variant="outline" size="sm" onClick={cancelEdit}>Cancel</Button>
              )}
              <Button onClick={handleSave} disabled={creating || !canSubmit} size="sm">
                {creating ? (editingId ? "Updating..." : "Recording...") : editingId ? "Update receipt" : "Record Payment"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
              {/* Customer Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Customer</label>
                <SearchableSelect
                  value={selectedCustomerId}
                  onChange={handleCustomerChange}
                  options={customers.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder="Type customer name..."
                  allowClear
                />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 max-sm:grid-cols-1">
                {/* Document date — the day the money actually landed (receipts
                    are often keyed in later); drives the GL month bucket. */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                  <input
                    type="date"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                  />
                </div>

                {/* Deposit To — the actual bank/cash account the money lands
                    in (drives the GL bank leg; Method stays as metadata). */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Deposit To</label>
                  <select
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                    value={bankAccount}
                    onChange={(e) => setBankAccount(e.target.value)}
                  >
                    {bankOptions.length === 0 && <option value="">— bank/cash —</option>}
                    {bankOptions.map((a) => (
                      <option key={a.code} value={a.code}>{a.code} {a.name}</option>
                    ))}
                  </select>
                </div>

                {/* Method */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                  <select
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                    value={method}
                    onChange={(e) => setMethod(e.target.value as PaymentRecord["method"])}
                  >
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="CHEQUE">Cheque</option>
                    <option value="CASH">Cash</option>
                    <option value="CREDIT_CARD">Credit Card</option>
                  </select>
                </div>

                {/* Reference */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reference</label>
                  <input
                    type="text"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="Cheque #, Transfer ref..."
                  />
                </div>

                {/* Amount received — editable since 2026-08-06. Leave it alone
                    and it follows the invoices you tick, exactly as before;
                    type in it and it becomes the figure that hit the bank, with
                    anything above the allocations held on account. */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount received (RM)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    className={`w-full rounded-md border px-3 py-2 text-sm text-right tabular-nums font-bold ${
                      overAllocated ? "border-red-400 text-red-600" : "border-gray-300 text-[#4F7C3A]"
                    }`}
                    value={amountTouched ? amountStr : (totalAllocated / 100).toFixed(2)}
                    onChange={(e) => { setAmountTouched(true); setAmountStr(e.target.value); }}
                    placeholder="0.00"
                  />
                  {overAllocated ? (
                    <p className="mt-1 text-xs text-red-600">
                      Allocated {formatCurrency(totalAllocated)} — more than received.
                    </p>
                  ) : onAccountSen > 0 ? (
                    <p className="mt-1 text-xs text-blue-600">
                      {formatCurrency(totalAllocated)} knocked off · {formatCurrency(onAccountSen)} on account
                    </p>
                  ) : null}
                </div>
              </div>

              {/* Invoice Allocation */}
              {selectedCustomerId && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Allocate to Invoices
                  </label>
                  {customerInvoices.length === 0 ? (
                    <p className="text-sm text-gray-400 italic">No outstanding invoices for this customer</p>
                  ) : (
                    <div className="border rounded-md overflow-hidden overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            {/* Date first — the list is sorted by it, and it is
                                how the operator decides which invoice to knock
                                off (owner 2026-08-06: 「不然我不知道要 knock off
                                哪几张」). The supplier form has carried this
                                column all along. */}
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Date</th>
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Invoice #</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">Invoice Amount</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">Previously Paid</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">Outstanding</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">This Payment</th>
                            <th className="text-center px-3 py-2 font-medium text-gray-600">Full</th>
                          </tr>
                        </thead>
                        <tbody>
                          {customerInvoices.map((inv) => {
                            const alloc = allocations.find((a) => a.invoiceId === inv.id);
                            const outstanding = inv.totalSen - inv.paidAmount + (editBaseline[inv.id] ?? 0);
                            const isFull = !!alloc && alloc.amount === outstanding;
                            return (
                              <tr key={inv.id} className="border-t hover:bg-gray-50">
                                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatDateDMY(inv.invoiceDate)}</td>
                                <td className="px-3 py-2 font-mono">{inv.invoiceNo}</td>
                                <td className="px-3 py-2 text-right">{formatCurrency(inv.totalSen)}</td>
                                <td className="px-3 py-2 text-right text-gray-500">{formatCurrency(inv.paidAmount)}</td>
                                <td className="px-3 py-2 text-right font-medium">{formatCurrency(outstanding)}</td>
                                <td className="px-3 py-2 text-right">
                                  <input
                                    type="number" onFocus={(e) => e.currentTarget.select()}
                                    step="0.01"
                                    inputMode="decimal"
                                    min="0"
                                    className="w-28 border border-gray-300 rounded px-2 py-1 text-sm text-right tabular-nums"
                                    value={alloc && alloc.amount ? (alloc.amount / 100).toFixed(2) : ""}
                                    placeholder="0.00"
                                    onChange={(e) => {
                                      const rm = parseFloat(e.target.value);
                                      const sen = Number.isFinite(rm) && rm >= 0 ? Math.round(rm * 100) : 0;
                                      setAllocAmount(inv.id, sen);
                                    }}
                                  />
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <input
                                    type="checkbox"
                                    checked={isFull}
                                    onChange={(e) => setAllocAmount(inv.id, e.target.checked ? outstanding : 0)}
                                    className="rounded border-gray-300"
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
        </CardContent>
      </Card>

      {/* All Payments */}
      <Card>
        <CardHeader>
          <CardTitle>All Payments</CardTitle>
        </CardHeader>
        <CardContent>
          <BatchActionsBar
            count={selectedPayments.length}
            onClear={() => setSelectedPayments([])}
            onPrint={() => printVouchers(selectedPayments.map(buildCustomerPaymentVoucher))}
            exportName="customer-payments"
            exportAoa={() => [
              ["Receipt #", "Date", "Customer", "Status", "Reference", "Voucher Total (RM)", "Invoice No", "Amount (RM)"],
              ...selectedPayments.flatMap((p) =>
                p.allocations.map((a) => [
                  p.receiptNumber,
                  formatDateDMY(p.date),
                  p.customerName ?? "",
                  p.lifecycleState ?? "ACTIVE",
                  p.reference ?? "",
                  (Number(p.amount ?? 0) / 100).toFixed(2),
                  a.invoiceNumber,
                  (Number(a.amount ?? 0) / 100).toFixed(2),
                ]),
              ),
            ]}
          />
          <DataGrid
            columns={columns}
            data={payments}
            keyField="id"
            virtualize
            gridId="payments"
            selectable
            onSelectionChange={setSelectedPayments}
            contextMenuItems={contextMenuItems}
            onRowClick={(row) => setDetail(row)}
            rowClassName={(row) =>
              (row.lifecycleState ?? "ACTIVE") !== "ACTIVE"
                ? "opacity-50"
                : hasUnallocated(row)
                  ? "text-blue-600"
                  : ""
            }
          />
        </CardContent>
      </Card>

      {/* Payment detail — click any row to see which invoices it cleared */}
      {detail && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setDetail(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">Receipt {detail.receiptNumber}</h2>
                {(detail.lifecycleState ?? "ACTIVE") !== "ACTIVE" && <LifecycleBadge state={detail.lifecycleState} />}
              </div>
              <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            <div className="p-5 space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-gray-500">Customer</p><p className="font-medium">{detail.customerName}</p></div>
                <div><p className="text-gray-500">Date</p><p className="font-medium">{formatDateDMY(detail.date)}</p></div>
                <div><p className="text-gray-500">Amount</p><p className="font-bold text-[#4F7C3A]">{formatRM(detail.amount)}</p></div>
                <div><p className="text-gray-500">Method</p><p className="font-medium">{detail.method.replace(/_/g, " ")}</p></div>
                {detail.reference && <div className="col-span-2"><p className="text-gray-500">Reference</p><p className="font-medium font-mono">{detail.reference}</p></div>}
              </div>
              <div>
                <p className="text-gray-500 mb-1">Invoices allocated</p>
                {detail.allocations.length === 0 ? (
                  <p className="text-gray-400 italic">Unallocated (on account)</p>
                ) : (
                  <div className="border rounded-md overflow-hidden">
                    <table className="w-full text-sm">
                      {/* Date first — a customer's statement lists documents by
                          date, so that is the column you match on. */}
                      <thead className="bg-gray-50"><tr><th className="text-left px-3 py-1.5 font-medium text-gray-600">Date</th><th className="text-left px-3 py-1.5 font-medium text-gray-600">Invoice #</th><th className="text-right px-3 py-1.5 font-medium text-gray-600">Amount (RM)</th></tr></thead>
                      <tbody>
                        {detail.allocations.map((a) => (
                          <tr key={a.invoiceId} className="border-t">
                            <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">
                              {a.invoiceDate ? formatDateDMY(a.invoiceDate) : "-"}
                            </td>
                            {/* The server resolves a blank number from the
                                invoice; if one still arrives empty the row is
                                pointing at an invoice that no longer exists,
                                which is worth seeing rather than an empty cell. */}
                            <td className="px-3 py-1.5 font-mono">
                              {a.invoiceNumber || <span className="text-[#9A3A2D] not-italic">(invoice missing)</span>}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatRM(a.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {/* Partly-allocated receipts looked fully cleared here — the
                    table only ever showed what HAD been knocked off. */}
                {detail.allocations.length > 0 && unallocatedSen(detail) > 0 && (
                  <p className="mt-2 text-blue-600">
                    {formatRM(unallocatedSen(detail))} still on account — not knocked off yet
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t">
                {(detail.lifecycleState ?? "ACTIVE") === "ACTIVE" ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => editPayment(detail)}>Edit</Button>
                    <Button variant="outline" size="sm" onClick={() => handleLifecycle(detail.id, "void")}>Void</Button>
                    <Button variant="outline" size="sm" onClick={() => handleLifecycle(detail.id, "delete")}>Delete</Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => handleLifecycle(detail.id, "unvoid")}>Restore</Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
