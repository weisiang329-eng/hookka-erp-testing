import { useState, useMemo, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LifecycleActions, LifecycleBadge } from "@/components/accounting/lifecycle-actions";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { CreditCard } from "lucide-react";

// ───────────────────────────────────────────────────────────────────────────
// Supplier Payment — the AP twin of the customer Payment page
// (src/pages/invoices/payments.tsx). Select a supplier, pull their open
// purchase invoices (APPROVED / PARTIAL_PAID), pay one or many — MYR PIs in
// RM, foreign PIs in their own currency + an FX rate — and post. The POST is
// the highest-risk write in the module, so it carries an Idempotency-Key
// header (a fresh crypto.randomUUID() per submit) to stop a network-retry
// from double-posting.  Mirrors payments.tsx idioms throughout, including the
// raw-string amount inputs (store what the operator typed; parse to sen only
// at submit — the old toFixed(2) round-trip made values impossible to type).
// ───────────────────────────────────────────────────────────────────────────

type SupplierOption = {
  id: string;
  code: string;
  name: string;
  isActive?: boolean;
};

type OpenPI = {
  id: string;
  piNo: string;
  amountSen: number;
  paidAmountSen: number;
  status: string;
  currency: string;
  fxRate: number;
  supplierName: string;
  invoiceDate: string;
};

// Per-row form state. amountStr / foreignStr / rateStr are the raw strings the
// operator is typing — never re-formatted mid-keystroke. `full` flags "pay the
// whole remaining outstanding" so the backend books the exact outstanding (and
// fully closes the PI) regardless of rounding.
type RowState = {
  amountStr: string; // MYR PI: Pay (RM)
  foreignStr: string; // foreign PI: Pay (foreign)
  rateStr: string; // foreign PI: Pay rate
  full: boolean;
};

const emptyRow = (): RowState => ({ amountStr: "", foreignStr: "", rateStr: "", full: false });

const isMyr = (currency: string) => !currency || currency.toUpperCase() === "MYR";

type PaymentLine = {
  purchaseInvoiceId: string;
  piNo: string;
  amountSen: number;
  bookedSen: number;
};

type PaymentGroup = {
  paymentNo: string;
  supplierName: string;
  date: string;
  totalBankSen: number;
  totalBookedSen: number;
  lifecycleState?: string;
  lines: PaymentLine[];
};

export default function SupplierPaymentsPage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();

  // History list
  const { data: histResp, loading, refresh: refreshHistory } = useCachedJson<
    { success?: boolean; data?: PaymentGroup[] } | PaymentGroup[]
  >("/api/supplier-payments");
  const history: PaymentGroup[] = useMemo(() => {
    if (Array.isArray(histResp)) return histResp;
    return histResp?.success ? histResp.data ?? [] : [];
  }, [histResp]);

  // Suppliers
  const { data: supResp } = useCachedJson<
    { success?: boolean; data?: SupplierOption[] } | SupplierOption[]
  >("/api/suppliers");
  const suppliers: SupplierOption[] = useMemo(() => {
    const raw = Array.isArray(supResp) ? supResp : supResp?.success ? supResp.data ?? [] : [];
    return raw.filter((s) => s.isActive !== false);
  }, [supResp]);

  // Header form state
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState("");

  // payFrom — SBK/SCH bank/cash account the money leaves from (same COA source
  // + filter as payments.tsx's bankAccount picker).
  const [payFrom, setPayFrom] = useState("");
  const [bankOptions, setBankOptions] = useState<{ code: string; name: string }[]>([]);

  useEffect(() => {
    fetch("/api/accounting/coa")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { code: string; name: string; specialAccountType?: string }[] }>)
      .then((j) => {
        if (!j?.success) return;
        const opts = (j.data ?? [])
          .filter((a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH")
          .map((a) => ({ code: a.code, name: a.name }));
        setBankOptions(opts);
        setPayFrom((prev) => prev || opts[0]?.code || "");
      })
      .catch(() => {});
  }, []);

  // Open PIs for the selected supplier — fetched on demand.
  const [openPIs, setOpenPIs] = useState<OpenPI[]>([]);
  const [loadingPIs, setLoadingPIs] = useState(false);
  // Keyed by PI id.
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [posting, setPosting] = useState(false);

  const loadOpenPIs = (supplierId: string) => {
    if (!supplierId) {
      setOpenPIs([]);
      return;
    }
    setLoadingPIs(true);
    fetch(`/api/purchase-invoices?supplierId=${encodeURIComponent(supplierId)}&status=APPROVED,PARTIAL_PAID`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: OpenPI[] } | OpenPI[]>)
      .then((j) => {
        const raw = Array.isArray(j) ? j : j?.success ? j.data ?? [] : [];
        // Drop fully-settled rows — outstanding must be > 0 to be payable.
        const open = raw.filter((pi) => pi.amountSen - pi.paidAmountSen > 0);
        setOpenPIs(open);
      })
      .catch(() => setOpenPIs([]))
      .finally(() => setLoadingPIs(false));
  };

  const handleSupplierChange = (supplierId: string) => {
    setSelectedSupplierId(supplierId);
    setRows({});
    loadOpenPIs(supplierId);
  };

  const getRow = (id: string): RowState => rows[id] ?? emptyRow();
  const setRow = (id: string, patch: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? emptyRow()), ...patch } }));
  };

  const outstandingOf = (pi: OpenPI) => pi.amountSen - pi.paidAmountSen;

  // Bank-MYR contributed by a single row (MYR rows: the RM typed; foreign rows:
  // foreign × rate). Returns sen.
  const rowBankSen = (pi: OpenPI): number => {
    const row = getRow(pi.id);
    if (isMyr(pi.currency)) {
      if (row.full) return outstandingOf(pi);
      const rm = parseFloat(row.amountStr);
      return Number.isFinite(rm) && rm > 0 ? Math.round(rm * 100) : 0;
    }
    // Foreign
    if (row.full) {
      // Booked uses outstanding exactly; bank = outstanding (in book MYR).
      const rate = parseFloat(row.rateStr);
      const foreignSen = pi.fxRate ? Math.round(outstandingOf(pi) / pi.fxRate) : 0;
      if (Number.isFinite(rate) && rate > 0) return Math.round((foreignSen / 100) * rate * 100);
      return outstandingOf(pi);
    }
    const foreign = parseFloat(row.foreignStr);
    const rate = parseFloat(row.rateStr);
    if (!(Number.isFinite(foreign) && foreign > 0)) return 0;
    if (!(Number.isFinite(rate) && rate > 0)) return 0;
    return Math.round(foreign * rate * 100);
  };

  const totalBankSen = useMemo(
    () => openPIs.reduce((sum, pi) => sum + rowBankSen(pi), 0),
    // rowBankSen reads rows; recompute whenever rows or the PI set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openPIs, rows]
  );

  // Toggle a foreign row's "Full": fills the remaining foreign amount
  // (foreignSen = round(outstanding / fxRate)).
  const toggleForeignFull = (pi: OpenPI) => {
    const row = getRow(pi.id);
    const next = !row.full;
    if (next) {
      const foreignSen = pi.fxRate ? Math.round(outstandingOf(pi) / pi.fxRate) : 0;
      setRow(pi.id, { full: true, foreignStr: (foreignSen / 100).toFixed(2) });
    } else {
      setRow(pi.id, { full: false });
    }
  };

  // Toggle a MYR row's "Full": fills the remaining outstanding (as RM).
  const toggleMyrFull = (pi: OpenPI) => {
    const row = getRow(pi.id);
    const next = !row.full;
    if (next) {
      setRow(pi.id, { full: true, amountStr: (outstandingOf(pi) / 100).toFixed(2) });
    } else {
      setRow(pi.id, { full: false });
    }
  };

  const resetForm = () => {
    setSelectedSupplierId("");
    setReference("");
    setOpenPIs([]);
    setRows({});
    setDate(today);
  };

  const handlePost = async () => {
    if (!selectedSupplierId || !payFrom) return;

    // Build allocations from rows with a positive amount entered.
    const allocations = openPIs
      .map((pi) => {
        const row = getRow(pi.id);
        if (isMyr(pi.currency)) {
          let payMyrSen: number;
          if (row.full) {
            payMyrSen = outstandingOf(pi);
          } else {
            const rm = parseFloat(row.amountStr);
            payMyrSen = Number.isFinite(rm) && rm > 0 ? Math.round(rm * 100) : 0;
          }
          if (payMyrSen <= 0) return null;
          return { piId: pi.id, payMyrSen, full: row.full };
        }
        // Foreign
        const rate = parseFloat(row.rateStr);
        const payRate = Number.isFinite(rate) && rate > 0 ? rate : undefined;
        let foreignSen: number;
        if (row.full) {
          foreignSen = pi.fxRate ? Math.round(outstandingOf(pi) / pi.fxRate) : 0;
        } else {
          const foreign = parseFloat(row.foreignStr);
          foreignSen = Number.isFinite(foreign) && foreign > 0 ? Math.round(foreign * 100) : 0;
        }
        if (foreignSen <= 0) return null;
        return { piId: pi.id, foreignSen, payRate, full: row.full };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    if (allocations.length === 0) {
      toast.error("Enter at least one payment amount");
      return;
    }

    setPosting(true);
    try {
      const res = await fetch("/api/supplier-payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // CRITICAL (money-safety): a fresh idempotency key per submit so a
          // retry under a network blip can't double-pay the supplier. Mirrors
          // payments.tsx's crypto.randomUUID() approach.
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          supplierId: selectedSupplierId,
          payFrom,
          date,
          reference: reference || undefined,
          allocations,
        }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string; data?: { paymentNo?: string; totalBankSen?: number } };
      if (res.ok && j.success) {
        toast.success(j.data?.paymentNo ? `Payment ${j.data.paymentNo} recorded` : "Payment recorded");
        resetForm();
        invalidateCachePrefix("/api/supplier-payments");
        invalidateCachePrefix("/api/purchase-invoices");
        refreshHistory();
      } else {
        toast.error(j.error || "Failed to record payment");
      }
    } catch {
      toast.error("Failed to record payment");
    }
    setPosting(false);
  };

  const handleLifecycle = async (paymentNo: string, action: "void" | "delete" | "unvoid") => {
    const verb = action === "unvoid" ? "Restore" : action === "delete" ? "Delete" : "Void";
    const extra = action === "delete"
      ? " It will be hidden from the GL (still visible in the audit log)."
      : action === "void"
        ? " This reverses the payment (nothing is deleted)."
        : "";
    if (!(await confirm({ title: `${verb} supplier payment?`, message: `${verb} supplier payment ${paymentNo}?${extra}`, danger: true }))) return;
    try {
      const res = await fetch(`/api/supplier-payments/${encodeURIComponent(paymentNo)}/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (res.ok && j.success) {
        toast.success(`Payment ${paymentNo} ${action === "unvoid" ? "restored" : action === "delete" ? "deleted" : "voided"}`);
        invalidateCachePrefix("/api/supplier-payments");
        invalidateCachePrefix("/api/purchase-invoices");
        refreshHistory();
        if (selectedSupplierId) loadOpenPIs(selectedSupplierId);
      } else {
        toast.error(j.error || `Failed to ${verb.toLowerCase()} payment`);
      }
    } catch {
      toast.error(`Failed to ${verb.toLowerCase()} payment`);
    }
  };

  const canPost = !!selectedSupplierId && !!payFrom && totalBankSen > 0 && !posting;

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
          <h1 className="text-xl font-bold text-gray-900">Supplier Payment</h1>
          <p className="text-sm text-gray-500 mt-1">
            Pay supplier purchase invoices — partial, multi-PI, and foreign-currency with FX
          </p>
        </div>
      </div>

      {/* Create / Pay card */}
      <Card>
        <CardHeader>
          <CardTitle>Record Payment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Supplier + header fields */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
              <select
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={selectedSupplierId}
                onChange={(e) => handleSupplierChange(e.target.value)}
              >
                <option value="">Select supplier...</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code ? `${s.code} ` : ""}{s.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Date — drives the payment number / period; editable. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
              <input
                type="date"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>

            {/* Pay From — the SBK/SCH bank/cash account the money leaves. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Pay From</label>
              <select
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={payFrom}
                onChange={(e) => setPayFrom(e.target.value)}
              >
                {bankOptions.length === 0 && <option value="">— bank/cash —</option>}
                {bankOptions.map((a) => (
                  <option key={a.code} value={a.code}>{a.code} {a.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Reference</label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Cheque #, Transfer ref... (optional)"
              />
            </div>
          </div>

          {/* Open-PI allocation table */}
          {selectedSupplierId && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Open Purchase Invoices</label>
              {loadingPIs ? (
                <p className="text-sm text-gray-400 italic">Loading invoices...</p>
              ) : openPIs.length === 0 ? (
                <p className="text-sm text-gray-400 italic">No open purchase invoices for this supplier</p>
              ) : (
                <div className="border rounded-md overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">PI No.</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Date</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Ccy</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-600">Amount</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-600">Paid</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-600">Outstanding</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Payment</th>
                        <th className="text-center px-3 py-2 font-medium text-gray-600">Full</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openPIs.map((pi) => {
                        const row = getRow(pi.id);
                        const outstanding = outstandingOf(pi);
                        const ccy = pi.currency || "MYR";
                        const myr = isMyr(pi.currency);
                        const foreign = parseFloat(row.foreignStr);
                        const rate = parseFloat(row.rateStr);
                        const previewRm =
                          Number.isFinite(foreign) && foreign > 0 && Number.isFinite(rate) && rate > 0
                            ? foreign * rate
                            : 0;
                        return (
                          <tr key={pi.id} className="border-t hover:bg-gray-50 align-top">
                            <td className="px-3 py-2 font-mono">{pi.piNo}</td>
                            <td className="px-3 py-2 text-gray-600">{formatDateDMY(pi.invoiceDate)}</td>
                            <td className="px-3 py-2">{ccy}</td>
                            <td className="px-3 py-2 text-right">{formatCurrency(pi.amountSen, ccy)}</td>
                            <td className="px-3 py-2 text-right text-gray-500">{formatCurrency(pi.paidAmountSen, ccy)}</td>
                            <td className="px-3 py-2 text-right font-medium">{formatCurrency(outstanding, ccy)}</td>
                            <td className="px-3 py-2">
                              {myr ? (
                                <div className="flex items-center gap-1">
                                  <span className="text-xs text-gray-400">RM</span>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    onFocus={(e) => e.currentTarget.select()}
                                    disabled={row.full}
                                    className="w-28 border border-gray-300 rounded px-2 py-1 text-sm text-right tabular-nums disabled:bg-gray-100"
                                    value={row.amountStr}
                                    onChange={(e) => setRow(pi.id, { amountStr: e.target.value })}
                                    placeholder="0.00"
                                  />
                                </div>
                              ) : (
                                <div className="space-y-1">
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-400 w-10">{ccy}</span>
                                    <input
                                      type="text"
                                      inputMode="decimal"
                                      onFocus={(e) => e.currentTarget.select()}
                                      disabled={row.full}
                                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right tabular-nums disabled:bg-gray-100"
                                      value={row.foreignStr}
                                      onChange={(e) => setRow(pi.id, { foreignStr: e.target.value })}
                                      placeholder="0.00"
                                    />
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-400 w-10">rate</span>
                                    <input
                                      type="text"
                                      inputMode="decimal"
                                      onFocus={(e) => e.currentTarget.select()}
                                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right tabular-nums"
                                      value={row.rateStr}
                                      onChange={(e) => setRow(pi.id, { rateStr: e.target.value })}
                                      placeholder={pi.fxRate ? String(pi.fxRate) : "0.0000"}
                                    />
                                  </div>
                                  <p className="text-xs text-[#4F7C3A]">= {formatRM(Math.round(previewRm * 100))}</p>
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <input
                                type="checkbox"
                                className="rounded border-gray-300"
                                checked={row.full}
                                onChange={() => (myr ? toggleMyrFull(pi) : toggleForeignFull(pi))}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-50 border-t">
                        <td colSpan={6} className="px-3 py-2 text-right font-medium">Total (RM)</td>
                        <td colSpan={2} className="px-3 py-2 text-right font-bold text-[#4F7C3A]">
                          {formatCurrency(totalBankSen)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={handlePost} disabled={!canPost}>
              {posting ? "Posting..." : "Post Payment"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle>Payment History</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No supplier payments yet</p>
          ) : (
            <div className="border rounded-md overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Payment #</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Supplier</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Date</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Total (RM)</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Lines</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600"></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((p) => (
                    <tr key={p.paymentNo} className={`border-t hover:bg-gray-50 ${(p.lifecycleState ?? "ACTIVE") !== "ACTIVE" ? "opacity-50" : ""}`}>
                      <td className="px-3 py-2 font-mono font-medium">{p.paymentNo}</td>
                      <td className="px-3 py-2">{p.supplierName}</td>
                      <td className="px-3 py-2 text-gray-600">{formatDateDMY(p.date)}</td>
                      <td className="px-3 py-2 text-right font-medium text-[#4F7C3A]">{formatRM(p.totalBankSen)}</td>
                      <td className="px-3 py-2 text-right text-gray-600">{p.lines?.length ?? 0}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <span className="mr-2"><LifecycleBadge state={p.lifecycleState} /></span>
                        <LifecycleActions
                          state={p.lifecycleState}
                          onVoid={() => handleLifecycle(p.paymentNo, "void")}
                          onDelete={() => handleLifecycle(p.paymentNo, "delete")}
                          onUnvoid={() => handleLifecycle(p.paymentNo, "unvoid")}
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

      {/* Empty-state hint icon (matches payments.tsx visual vocabulary) */}
      {!selectedSupplierId && history.length === 0 && (
        <div className="flex items-center justify-center text-gray-300 py-8">
          <CreditCard className="h-10 w-10" />
        </div>
      )}
    </div>
  );
}
