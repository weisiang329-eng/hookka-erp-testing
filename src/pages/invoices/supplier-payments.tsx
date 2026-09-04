import { useState, useMemo, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LifecycleActions, LifecycleBadge } from "@/components/accounting/lifecycle-actions";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { defaultBankCode } from "@/lib/default-bank";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { COMPANY } from "@/lib/constants";
import { amountInWords } from "@/lib/amount-in-words";
import { printVouchers, type VoucherSpec, type VoucherLine } from "@/lib/print-voucher";
import { useRowSelection } from "@/lib/use-row-selection";
import { BatchActionsBar } from "@/components/accounting/batch-actions-bar";
import { CreditCard, Printer } from "lucide-react";
// One money parser. NOTE: `rateStr` on this page is an FX RATE, not money, and
// deliberately keeps `parseFloat` - see the comment at `rowBankSenWith`.
import { moneyFieldToRinggit, moneyFieldToSen, firstMoneyFieldError, isUnreadableMoney } from "@/lib/money-field";

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
  supplierInvoiceNo?: string; // the supplier's own invoice number (their reference)
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
  id: string;
  purchaseInvoiceId: string;
  piNo: string;
  supplierInvoiceNo?: string;
  amountSen: number;
  bookedSen: number;
};

type PaymentGroup = {
  paymentNo: string;
  supplierId: string;
  supplierName: string;
  date: string;
  totalBankSen: number;
  totalBookedSen: number;
  lifecycleState?: string;
  lines: PaymentLine[];
};

// An advance/prepayment line has no PI attached. Once fully knocked off (via
// the Knock Off action below) its remaining amountSen reaches 0 -- so "still
// unapplied" is BOTH conditions, not just "no purchaseInvoiceId" (owner rule
// 2026-06-30: unapplied advances show in blue in the All Payments list).
const isUnappliedAdvanceLine = (l: PaymentLine) => !l.purchaseInvoiceId && l.amountSen > 0;
const hasUnappliedAdvance = (p: PaymentGroup) => p.lines.some(isUnappliedAdvanceLine);

// Trade finance (owner 2026-08-11): payload of GET /api/accounting/trade-finance.
type TfDrawRow = {
  drawSourceId: string;
  drawDate: string;
  dueDate: string;
  amountSen: number;
  repaidSen: number;
  outstandingSen: number;
  paidSupplier: string;
};
type TfSourceRow = {
  accountCode: string;
  lenderSupplierId: string;
  lenderName: string;
  tenorDays: number;
  accountName: string;
  draws: TfDrawRow[];
};

// COMPANY.HOOKKA → the VoucherSpec.company shape (single source of truth);
// mirrors VOUCHER_COMPANY in accounting/index.tsx.
const VOUCHER_COMPANY: VoucherSpec["company"] = {
  name: COMPANY.HOOKKA.name,
  addressLines: COMPANY.HOOKKA.addressLines,
  regNo: COMPANY.HOOKKA.regNo,
  tin: COMPANY.HOOKKA.tin,
  phone: COMPANY.HOOKKA.phone,
  email: COMPANY.HOOKKA.email,
};

// One supplier payment → a SUPPLIER PAYMENT VOUCHER: one line per purchase
// invoice paid (PI No · bank amount), total = totalBankSen. Money stays integer
// sen, formatted with formatCurrency. Mirrors buildPvVoucher in accounting/index.
function buildSupplierPaymentVoucher(p: PaymentGroup): VoucherSpec {
  const active = (p.lifecycleState ?? "ACTIVE") === "ACTIVE";
  const lines: VoucherLine[] = p.lines.map((l) => ({
    cells: [l.piNo, l.supplierInvoiceNo || "—", formatCurrency(l.amountSen)],
  }));
  return {
    title: active ? "SUPPLIER PAYMENT VOUCHER" : "SUPPLIER PAYMENT VOUCHER — VOID",
    company: VOUCHER_COMPANY,
    docNo: p.paymentNo,
    date: formatDateDMY(p.date),
    partyLabel: "Paid To",
    partyName: p.supplierName ?? "",
    columns: [{ label: "Purchase Invoice" }, { label: "Supplier Inv No" }, { label: "Amount", align: "right" }],
    lines,
    totalCells: ["Total", "", formatCurrency(p.totalBankSen)],
    amountWords: amountInWords(p.totalBankSen),
    signatures: [{ label: "Prepared by" }, { label: "Approved by" }, { label: "Received by" }],
    printedOn: formatDateDMY(new Date()),
  };
}

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

  // Header form state. Lazily seeded from ?supplier=<id> (the trade-finance
  // aging block's Repay deep-link) — no setState-in-effect needed.
  const [selectedSupplierId, setSelectedSupplierId] = useState(
    () => new URLSearchParams(window.location.search).get("supplier") ?? "",
  );
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState("");
  // Supplier advance / prepayment (RM string). Pay a supplier BEFORE any invoice;
  // posts to Trade Creditors (400-0000) as a prepayment to knock off later.
  const [advanceStr, setAdvanceStr] = useState("");

  // payFrom — SBK/SCH bank/cash account the money leaves from (same COA source
  // + filter as payments.tsx's bankAccount picker).
  const [payFrom, setPayFrom] = useState("");
  const [bankOptions, setBankOptions] = useState<{ code: string; name: string }[]>([]);
  // Trade-finance config + per-draw repayment rows (owner 2026-08-11).
  const [tfSources, setTfSources] = useState<TfSourceRow[]>([]);
  const [tfRows, setTfRows] = useState<Record<string, { amountStr: string; full: boolean }>>({});

  useEffect(() => {
    fetch("/api/accounting/coa")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { code: string; name: string; specialAccountType?: string }[] }>)
      .then((j) => {
        if (!j?.success) return;
        const opts = (j.data ?? [])
          .filter((a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH")
          .map((a) => ({ code: a.code, name: a.name }));
        setBankOptions(opts);
        setPayFrom((prev) => prev || defaultBankCode(opts));
      })
      .catch(() => {});
  }, []);

  // Open PIs for the selected supplier — fetched on demand.
  const [openPIs, setOpenPIs] = useState<OpenPI[]>([]);
  const [loadingPIs, setLoadingPIs] = useState(false);
  // Keyed by PI id.
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [posting, setPosting] = useState(false);
  // Edit mode: when set, the form is editing this payment in place (same number).
  const [editingNo, setEditingNo] = useState<string | null>(null);
  // Edit-mode advance bookkeeping: the voucher's ORIGINAL bank total anchors
  // the auto-balance (typing invoice amounts shrinks the Advance field so the
  // total stays put), until the operator edits the Advance field manually.
  const [editOriginalBankSen, setEditOriginalBankSen] = useState(0);
  const [advanceTouched, setAdvanceTouched] = useState(false);
  // Advance rows on the voucher being edited — PRESERVED server-side (the edit
  // form is allocations-only), surfaced here so the operator sees the full
  // voucher total and knows the advance is untouched.
  const [editAdvanceKeptSen, setEditAdvanceKeptSen] = useState(0);

  const loadOpenPIs = (
    supplierId: string,
    editLines?: { purchaseInvoiceId: string; bookedSen: number }[],
  ) => {
    if (!supplierId) {
      setOpenPIs([]);
      return;
    }
    setLoadingPIs(true);
    // In edit mode include PAID PIs so the ones this payment settled still show;
    // their paid amount is rolled back for display so they're re-allocatable.
    const status = editLines ? "CONFIRMED,APPROVED,PARTIAL_PAID,PAID" : "CONFIRMED,APPROVED,PARTIAL_PAID";
    fetch(`/api/purchase-invoices?supplierId=${encodeURIComponent(supplierId)}&status=${status}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: OpenPI[] } | OpenPI[]>)
      .then((j) => {
        const raw = Array.isArray(j) ? j : j?.success ? j.data ?? [] : [];
        const back = new Map((editLines ?? []).map((l) => [l.purchaseInvoiceId, l.bookedSen]));
        const adj = raw.map((pi) =>
          back.has(pi.id)
            ? { ...pi, paidAmountSen: Math.max(0, pi.paidAmountSen - (back.get(pi.id) ?? 0)) }
            : pi,
        );
        // Oldest first, newest at the bottom — the order a payment is worked
        // down (owner 2026-08-06, on the customer side; the same action here).
        // The API returns them by number, which for back-entered documents is
        // not chronological.
        const open = adj
          .filter((pi) => pi.amountSen - pi.paidAmountSen > 0)
          .sort(
            (a, b) =>
              String(a.invoiceDate ?? "").localeCompare(String(b.invoiceDate ?? "")) ||
              String(a.piNo ?? "").localeCompare(String(b.piNo ?? "")),
          );
        setOpenPIs(open);
        // Edit flow: seed each PI's MYR amount from the payment being edited.
        // Foreign PIs need their rate re-entered (the line only carries booked MYR).
        if (editLines) {
          const seeded: Record<string, RowState> = {};
          for (const l of editLines) {
            if (l.bookedSen > 0) seeded[l.purchaseInvoiceId] = { ...emptyRow(), amountStr: (l.bookedSen / 100).toFixed(2) };
          }
          setRows(seeded);
        }
      })
      .catch(() => setOpenPIs([]))
      .finally(() => setLoadingPIs(false));
  };

  const handleSupplierChange = (supplierId: string) => {
    setSelectedSupplierId(supplierId);
    setRows({});
    setTfRows({});
    loadOpenPIs(supplierId);
  };

  // ---- Trade finance (owner 2026-08-11) ----
  // Selecting the LENDER supplier flips the form into repayment mode: the
  // grid lists open DRAWS instead of purchase invoices and the GL will be
  // DR TF-liability / CR bank. TF source accounts are appended to Pay From
  // in normal mode (paying FROM one records a draw); a repayment must come
  // from a real bank, so in lender mode they are excluded.
  const refreshTf = () => {
    fetch("/api/accounting/trade-finance", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { sources?: TfSourceRow[] } }>)
      .then((j) => { if (j?.success) setTfSources(j.data?.sources ?? []); })
      .catch(() => {});
  };
  useEffect(() => {
    refreshTf();
    // Deep-linked supplier (state was lazily seeded from the URL above) —
    // fetch its open PIs the same way handleSupplierChange would have.
    // Justified disable: loadOpenPIs flips its loading flag synchronously
    // before the fetch; this mount-only effect IS the external-system sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selectedSupplierId) loadOpenPIs(selectedSupplierId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tfCfg = tfSources.find((s) => s.lenderSupplierId === selectedSupplierId) ?? null;
  const lenderIds = useMemo(() => new Set(tfSources.map((s) => s.lenderSupplierId)), [tfSources]);
  const tfOpenDraws = useMemo(() => (tfCfg?.draws ?? []).filter((d) => d.outstandingSen > 0), [tfCfg]);
  const tfRowSen = (d: TfDrawRow): number => {
    const row = tfRows[d.drawSourceId];
    if (!row) return 0;
    if (row.full) return d.outstandingSen;
    const rmv = moneyFieldToRinggit(row.amountStr);
    return rmv !== null && rmv > 0 ? Math.round(rmv * 100) : 0;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tfTotalSen = useMemo(() => tfOpenDraws.reduce((s, d) => s + tfRowSen(d), 0), [tfOpenDraws, tfRows]);
  const payFromOptions = useMemo(() => {
    if (tfCfg) return bankOptions.filter((o) => !tfSources.some((s) => s.accountCode === o.code));
    const extras = tfSources
      .filter((s) => !bankOptions.some((o) => o.code === s.accountCode))
      .map((s) => ({ code: s.accountCode, name: `${s.accountName || s.lenderName} · trade finance` }));
    return [...bankOptions, ...extras];
  }, [bankOptions, tfSources, tfCfg]);

  const getRow = (id: string): RowState => rows[id] ?? emptyRow();
  const setRow = (id: string, patch: Partial<RowState>) => {
    const next = { ...rows, [id]: { ...(rows[id] ?? emptyRow()), ...patch } };
    setRows(next);
    // Auto-balance (edit mode, owner 2026-07-24): typing invoice amounts
    // consumes the advance, so the voucher total stays anchored at the
    // original bank figure. Editing the Advance field by hand takes over
    // (advanceTouched) — the deliberate "change what left the bank" case.
    if (editingNo && !advanceTouched && editAdvanceKeptSen > 0) {
      const rowsSen = openPIs.reduce(
        (sum, pi) => sum + rowBankSenWith(pi, next[pi.id] ?? emptyRow()),
        0,
      );
      const remain = Math.max(0, editOriginalBankSen - rowsSen);
      setAdvanceStr(remain > 0 ? (remain / 100).toFixed(2) : "0.00");
    }
  };

  const outstandingOf = (pi: OpenPI) => pi.amountSen - pi.paidAmountSen;

  // Bank-MYR contributed by a single row (MYR rows: the RM typed; foreign rows:
  // foreign × rate). Returns sen.
  const rowBankSenWith = (pi: OpenPI, row: RowState): number => {
    // BUG-2026-08-13-095 - amountStr / foreignStr are `type="text"` money
    // fields, so a supplier payment typed "12,500" paid RM 12.00 and left the
    // invoice looking almost entirely unpaid. `rateStr` stays on `parseFloat`
    // on purpose: an FX rate is not money, has no thousands separator, and
    // giving it money syntax (a leading RM, accounting parentheses) would be
    // wrong. `handlePost` refuses on any unreadable MONEY field, so the 0
    // fallbacks below are only reached by a field the operator is being told
    // to fix.
    if (isMyr(pi.currency)) {
      if (row.full) return outstandingOf(pi);
      const rm = moneyFieldToRinggit(row.amountStr);
      return rm !== null && rm > 0 ? Math.round(rm * 100) : 0;
    }
    // Foreign
    if (row.full) {
      // Booked uses outstanding exactly; bank = outstanding (in book MYR).
      const rate = parseFloat(row.rateStr);
      const foreignSen = pi.fxRate ? Math.round(outstandingOf(pi) / pi.fxRate) : 0;
      if (Number.isFinite(rate) && rate > 0) return Math.round((foreignSen / 100) * rate * 100);
      return outstandingOf(pi);
    }
    const foreign = moneyFieldToRinggit(row.foreignStr);
    const rate = parseFloat(row.rateStr);
    if (!(foreign !== null && foreign > 0)) return 0;
    if (!(Number.isFinite(rate) && rate > 0)) return 0;
    return Math.round(foreign * rate * 100);
  };
  const rowBankSen = (pi: OpenPI): number => rowBankSenWith(pi, getRow(pi.id));

  // Advance is editable in BOTH modes (owner 2026-07-24: Edit is his bulk
  // knock-off workbench — the invoice grid shows everything at once, typing
  // amounts uses the advance up; before this he had to void + re-record).
  const advanceSen = Math.max(0, moneyFieldToSen(advanceStr) ?? 0);

  const totalBankSen = useMemo(
    () => (tfCfg ? tfTotalSen : openPIs.reduce((sum, pi) => sum + rowBankSen(pi), 0) + advanceSen),
    // rowBankSen reads rows; recompute whenever rows / PI set / advance changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openPIs, rows, advanceSen, tfCfg, tfTotalSen]
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
    setAdvanceStr("");
    setOpenPIs([]);
    setRows({});
    setDate(today);
  };

  // Every MONEY field on the voucher (not the FX rates), labelled so a refusal
  // names the row. Checked before anything is posted.
  const voucherMoneyError = () =>
    firstMoneyFieldError([
      { label: "Advance (RM)", value: advanceStr },
      ...tfOpenDraws
        .filter((d) => !tfRows[d.drawSourceId]?.full)
        .map((d) => ({ label: `Draw ${d.drawSourceId} amount`, value: tfRows[d.drawSourceId]?.amountStr ?? "" })),
      ...openPIs
        .filter((pi) => !getRow(pi.id).full)
        .map((pi) =>
          isMyr(pi.currency)
            ? { label: `${pi.piNo} amount`, value: getRow(pi.id).amountStr }
            : { label: `${pi.piNo} foreign amount`, value: getRow(pi.id).foreignStr },
        ),
    ]);

  const handlePost = async () => {
    const moneyErr = voucherMoneyError();
    if (moneyErr) { toast.error(moneyErr); return; }
    if (!selectedSupplierId || !payFrom) return;

    // Trade-finance REPAYMENT (owner 2026-08-11): the selected supplier is the
    // lender — allocations reference draws, not PIs. No advance, no FX.
    if (tfCfg) {
      const tfAllocations = tfOpenDraws
        .map((d) => {
          const paySen = tfRowSen(d);
          return paySen > 0 ? { drawSourceId: d.drawSourceId, paySen } : null;
        })
        .filter((a): a is NonNullable<typeof a> => a !== null);
      if (tfAllocations.length === 0) {
        toast.error("Enter an amount against at least one draw");
        return;
      }
      setPosting(true);
      try {
        const res = await fetch("/api/supplier-payments", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ supplierId: selectedSupplierId, payFrom, date, reference: reference || undefined, tfAllocations }),
        });
        const j = (await res.json()) as { success?: boolean; error?: string; data?: { paymentNo?: string } };
        if (res.ok && j.success) {
          toast.success(j.data?.paymentNo ? `Repayment ${j.data.paymentNo} recorded` : "Repayment recorded");
          resetForm();
          setTfRows({});
          refreshTf();
          invalidateCachePrefix("/api/supplier-payments");
          invalidateCachePrefix("/api/accounting");
          refreshHistory();
        } else {
          toast.error(j.error || "Failed to record the repayment");
        }
      } catch {
        toast.error("Failed to record the repayment");
      }
      setPosting(false);
      return;
    }

    // Build allocations from rows with a positive amount entered.
    const allocations = openPIs
      .map((pi) => {
        const row = getRow(pi.id);
        if (isMyr(pi.currency)) {
          let payMyrSen: number;
          if (row.full) {
            payMyrSen = outstandingOf(pi);
          } else {
            const rm = moneyFieldToRinggit(row.amountStr);
            payMyrSen = rm !== null && rm > 0 ? Math.round(rm * 100) : 0;
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
          const foreign = moneyFieldToRinggit(row.foreignStr);
          foreignSen = foreign !== null && foreign > 0 ? Math.round(foreign * 100) : 0;
        }
        if (foreignSen <= 0) return null;
        return { piId: pi.id, foreignSen, payRate, full: row.full };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    if (allocations.length === 0 && advanceSen <= 0) {
      toast.error("Enter a payment amount or an advance");
      return;
    }

    setPosting(true);
    try {
      const res = await fetch(
        editingNo ? `/api/supplier-payments/${encodeURIComponent(editingNo)}/restate` : "/api/supplier-payments",
        {
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
          // Edit mode ALWAYS sends advanceSen — 0 is meaningful there (the
          // advance was fully allocated to invoices in this edit).
          ...(editingNo ? { advanceSen } : (advanceSen > 0 ? { advanceSen } : {})),
        }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string; data?: { paymentNo?: string; totalBankSen?: number } };
      if (res.ok && j.success) {
        toast.success(editingNo ? "Payment updated" : j.data?.paymentNo ? `Payment ${j.data.paymentNo} recorded` : "Payment recorded");
        setEditingNo(null);
        setEditAdvanceKeptSen(0);
        setEditOriginalBankSen(0);
        setAdvanceTouched(false);
        resetForm();
        invalidateCachePrefix("/api/supplier-payments");
        invalidateCachePrefix("/api/purchase-invoices");
        // Aging/GL on the accounting page must not keep serving the pre-payment
        // snapshot (owner 2026-09-03: 「aging 每次点开不是最新的资料」).
        invalidateCachePrefix("/api/accounting");
        refreshHistory();
      } else {
        toast.error(j.error || `Failed to ${editingNo ? "update" : "record"} payment`);
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
        // Aging/GL on the accounting page must not keep serving the pre-payment
        // snapshot (owner 2026-09-03: 「aging 每次点开不是最新的资料」).
        invalidateCachePrefix("/api/accounting");
        refreshHistory();
        if (selectedSupplierId) loadOpenPIs(selectedSupplierId);
      } else {
        toast.error(j.error || `Failed to ${verb.toLowerCase()} payment`);
      }
    } catch {
      toast.error(`Failed to ${verb.toLowerCase()} payment`);
    }
  };

  // Edit = void the original (GL reversed, PIs reopened) then reload the form
  // prefilled, so the operator corrects and re-posts. Mirrors the expense-PV
  // edit pattern; the immutable ledger is never mutated in place.
  // In-place edit: load the payment into the form (no void). Save re-states it
  // under the same voucher number; the original is untouched until then.
  const editPayment = (p: PaymentGroup) => {
    setDetail(null);
    setEditingNo(p.paymentNo);
    const advRemainSen = p.lines.filter((l) => !l.purchaseInvoiceId).reduce((acc, l) => acc + (l.amountSen || 0), 0);
    setEditAdvanceKeptSen(advRemainSen);
    setAdvanceStr(advRemainSen > 0 ? (advRemainSen / 100).toFixed(2) : "");
    setEditOriginalBankSen(p.totalBankSen || 0);
    setAdvanceTouched(false);
    setDate(p.date || today);
    const sup = suppliers.find((s) => s.name === p.supplierName);
    if (sup) {
      setSelectedSupplierId(sup.id);
      setRows({});
      loadOpenPIs(
        sup.id,
        p.lines.map((l) => ({ purchaseInvoiceId: l.purchaseInvoiceId, bookedSen: l.bookedSen })),
      );
    } else {
      setSelectedSupplierId("");
      setRows({});
      setOpenPIs([]);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancelEdit = () => {
    setEditingNo(null);
    setEditAdvanceKeptSen(0);
    setEditOriginalBankSen(0);
    setAdvanceTouched(false);
    setSelectedSupplierId("");
    setRows({});
    setOpenPIs([]);
    setReference("");
    setAdvanceStr("");
  };

  const canPost = !!selectedSupplierId && !!payFrom && totalBankSen > 0 && !posting;
  const [histQ, setHistQ] = useState("");
  const [detail, setDetail] = useState<PaymentGroup | null>(null);

  // Manual knock-off (owner rule 2026-06-30: "我要手动去knock off，不是自动knock
  // off") — apply part/all of an unapplied advance line against an open PI for
  // the SAME supplier. Scoped state, separate from the main form's openPIs/rows,
  // so it can't clash with whatever the main form is doing while this modal is
  // open.
  const [koForAdvanceId, setKoForAdvanceId] = useState<string | null>(null);
  const [koOpenPIs, setKoOpenPIs] = useState<OpenPI[]>([]);
  const [koLoadingPIs, setKoLoadingPIs] = useState(false);
  const [koPiId, setKoPiId] = useState("");
  const [koAmountStr, setKoAmountStr] = useState("");
  const [koSubmitting, setKoSubmitting] = useState(false);

  const openKnockOff = (advanceLine: PaymentLine, supplierId: string) => {
    setKoForAdvanceId(advanceLine.id);
    setKoPiId("");
    setKoAmountStr((advanceLine.amountSen / 100).toFixed(2));
    setKoOpenPIs([]);
    setKoLoadingPIs(true);
    fetch(`/api/purchase-invoices?supplierId=${encodeURIComponent(supplierId)}&status=CONFIRMED,APPROVED,PARTIAL_PAID`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: OpenPI[] } | OpenPI[]>)
      .then((j) => {
        const raw = Array.isArray(j) ? j : j?.success ? j.data ?? [] : [];
        setKoOpenPIs(raw.filter((pi) => pi.amountSen - pi.paidAmountSen > 0));
      })
      .catch(() => toast.error("Failed to load open invoices for this supplier"))
      .finally(() => setKoLoadingPIs(false));
  };

  const submitKnockOff = async () => {
    if (!koForAdvanceId || !koPiId) return;
    // BUG-2026-08-13-095 - knocking an advance off an invoice: "1,000" applied
    // RM 1.00 and left the advance looking almost untouched.
    const koErr = firstMoneyFieldError([{ label: "Amount to apply (RM)", value: koAmountStr }]);
    if (koErr) { toast.error(koErr); return; }
    const amountSen = moneyFieldToSen(koAmountStr) as number;
    if (amountSen <= 0) { toast.error("Enter an amount to apply"); return; }
    setKoSubmitting(true);
    try {
      const res = await fetch("/api/supplier-payments/knock-off", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ advanceRowId: koForAdvanceId, purchaseInvoiceId: koPiId, amountSen }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string; data?: { piNo?: string } };
      if (res.ok && j.success) {
        toast.success(`Applied RM ${(amountSen / 100).toFixed(2)} to ${j.data?.piNo ?? "the invoice"}`);
        setKoForAdvanceId(null);
        setDetail(null); // its snapshot is now stale — reopen the row to see the fresh split
        invalidateCachePrefix("/api/supplier-payments");
        invalidateCachePrefix("/api/purchase-invoices");
        // Aging/GL on the accounting page must not keep serving the pre-payment
        // snapshot (owner 2026-09-03: 「aging 每次点开不是最新的资料」).
        invalidateCachePrefix("/api/accounting");
        refreshHistory();
      } else {
        toast.error(j?.error || "Failed to apply the advance");
      }
    } catch {
      toast.error("Failed to apply the advance");
    } finally {
      setKoSubmitting(false);
    }
  };

  // Summary across active (non-void) payments — mirrors the customer page cards.
  const activePayments = history.filter((p) => (p.lifecycleState ?? "ACTIVE") === "ACTIVE");
  const totalPaidSen = activePayments.reduce((s, p) => s + (p.totalBankSen || 0), 0);
  const ymNow = new Date().toISOString().slice(0, 7);
  const thisMonthSen = activePayments
    .filter((p) => String(p.date).slice(0, 7) === ymNow)
    .reduce((s, p) => s + (p.totalBankSen || 0), 0);
  const supplierCount = new Set(activePayments.map((p) => p.supplierName)).size;
  const histLc = histQ.trim().toLowerCase();
  const filteredHistory = history.filter(
    (p) => !histLc || p.paymentNo.toLowerCase().includes(histLc) || (p.supplierName ?? "").toLowerCase().includes(histLc),
  );
  // Ticked-row selection for batch print + export, keyed by payment number.
  const sel = useRowSelection(filteredHistory, (p) => p.paymentNo);

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

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-gray-500">Total Paid</p>
                <p className="text-xl font-bold text-[#4F7C3A] truncate">{formatCurrency(totalPaidSen)}</p>
              </div>
              <CreditCard className="h-8 w-8 text-[#4F7C3A] shrink-0" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm text-gray-500">Payments</p>
              <p className="text-2xl font-bold">{activePayments.length}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm text-gray-500">This Month</p>
              <p className="text-xl font-bold text-[#3E6570] truncate">{formatCurrency(thisMonthSen)}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm text-gray-500">Suppliers</p>
              <p className="text-2xl font-bold">{supplierCount}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Create / Pay card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{editingNo ? "Edit Payment" : "Record Payment"}</CardTitle>
            <div className="flex items-center gap-2">
              {editingNo && <Button variant="outline" size="sm" onClick={cancelEdit}>Cancel</Button>}
              <Button onClick={handlePost} disabled={!canPost} size="sm">
                {posting ? (editingNo ? "Updating..." : "Posting...") : editingNo ? "Update Payment" : "Post Payment"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Supplier + header fields */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-[#6B7280] mb-1">Supplier</label>
              <SearchableSelect
                value={selectedSupplierId}
                onChange={handleSupplierChange}
                options={suppliers.map((s) => ({ value: s.id, label: s.code ? `${s.code} ${s.name}` : s.name }))}
                placeholder="Type supplier code or name..."
                allowClear
              />
            </div>

            {/* Date — drives the payment number / period; editable. */}
            <div>
              <label className="block text-sm font-medium text-[#6B7280] mb-1">Date</label>
              <input
                type="date"
                className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>

            {/* Pay From — the SBK/SCH bank/cash account the money leaves. */}
            <div>
              <label className="block text-sm font-medium text-[#6B7280] mb-1">Pay From</label>
              <select
                className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm"
                value={payFrom}
                onChange={(e) => setPayFrom(e.target.value)}
              >
                {payFromOptions.length === 0 && <option value="">— bank/cash —</option>}
                {payFromOptions.map((a) => (
                  <option key={a.code} value={a.code}>{a.code} {a.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-[#6B7280] mb-1">Reference</label>
              <input
                type="text"
                className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Cheque #, Transfer ref... (optional)"
              />
            </div>

            {/* Knock-off total — kept at the top, beside Reference, so the
                operator sees it without scrolling past the allocation table. */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-[#6B7280] mb-1">Total (RM)</label>
              <div className="w-full rounded-md border border-[#E2DDD8] bg-[#FAF8F5] px-3 py-2 text-sm text-right tabular-nums font-bold text-[#4F7C3A]">
                {formatCurrency(totalBankSen)}
              </div>
            </div>
          </div>

          {editingNo && editAdvanceKeptSen > 0 && (
            <p className="text-xs text-[#6B5C32] bg-[#F6F1E7] rounded-md px-3 py-2">
              This voucher carries an unapplied advance of <strong>RM {(editAdvanceKeptSen / 100).toFixed(2)}</strong> — typing amounts into the invoices below uses it up (the Advance field shrinks by itself, voucher total stays put). Edit the Advance field yourself only to change what actually left the bank.
            </p>
          )}
          {tfCfg && (
            <p className="text-xs text-[#6B5C32] bg-[#F6F1E7] rounded-md px-3 py-2">
              Repaying <strong>{tfCfg.lenderName}</strong> — this pays down the trade-finance draws below
              (DR {tfCfg.accountCode} / CR the bank you picked). Advance and FX do not apply here.
            </p>
          )}
          {/* Supplier advance / prepayment — editable in create AND edit.
              Hidden for a trade-finance lender: a repayment is always
              allocated to draws, never held on account. */}
          {!tfCfg && (
          <div>
            <label className="block text-sm font-medium text-[#6B7280] mb-1">
              Advance / Prepayment (RM)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              className="w-full md:w-1/3 border border-[#E2DDD8] rounded-md px-3 py-2 text-sm text-right tabular-nums"
              value={advanceStr}
              onChange={(e) => { setAdvanceStr(e.target.value); if (editingNo) setAdvanceTouched(true); }}
              placeholder="0.00"
            />
            <p className="text-xs text-[#6B7280] mt-1">
              {editingNo
                ? "The voucher's unapplied advance after this edit — auto-fills as you allocate invoices below."
                : <>Pay a supplier <strong>before any invoice</strong> — posts to Trade Creditors (400-0000) as a prepayment you can knock off invoices later. Leave blank for a normal payment.</>}
            </p>
          </div>
          )}

          {/* Trade-finance draw allocation table (lender mode). Same working
              order as the PI grid: oldest due first, Full fills the balance. */}
          {selectedSupplierId && tfCfg && (
            <div>
              <label className="block text-sm font-medium text-[#6B7280] mb-2">Open Trade-Finance Draws</label>
              {tfOpenDraws.length === 0 ? (
                <p className="text-sm text-gray-400 italic">No open draws for {tfCfg.lenderName}</p>
              ) : (
                <div className="border rounded-md overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Draw</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Paid supplier</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Draw date</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Due date</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-600">Outstanding</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Repay</th>
                        <th className="text-center px-3 py-2 font-medium text-gray-600">Full</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tfOpenDraws.map((d) => {
                        const row = tfRows[d.drawSourceId] ?? { amountStr: "", full: false };
                        return (
                          <tr key={d.drawSourceId} className="border-t hover:bg-gray-50 align-top">
                            <td className="px-3 py-2 font-mono">{d.drawSourceId}</td>
                            <td className="px-3 py-2 text-gray-600">{d.paidSupplier || "—"}</td>
                            <td className="px-3 py-2 text-gray-600">{formatDateDMY(d.drawDate)}</td>
                            <td className="px-3 py-2 text-gray-600">{formatDateDMY(d.dueDate)}</td>
                            <td className="px-3 py-2 text-right font-medium">{formatCurrency(d.outstandingSen)}</td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                className="w-28 border border-[#E2DDD8] rounded-md px-2 py-1 text-sm text-right tabular-nums"
                                value={row.full ? (d.outstandingSen / 100).toFixed(2) : row.amountStr}
                                disabled={row.full}
                                onChange={(e) =>
                                  setTfRows((prev) => ({ ...prev, [d.drawSourceId]: { amountStr: e.target.value, full: false } }))
                                }
                                placeholder="0.00"
                              />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={row.full}
                                onChange={() =>
                                  setTfRows((prev) => ({
                                    ...prev,
                                    [d.drawSourceId]: row.full
                                      ? { amountStr: "", full: false }
                                      : { amountStr: (d.outstandingSen / 100).toFixed(2), full: true },
                                  }))
                                }
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

          {/* Open-PI allocation table */}
          {selectedSupplierId && !tfCfg && (
            <div>
              <label className="block text-sm font-medium text-[#6B7280] mb-2">Open Purchase Invoices</label>
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
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Supplier Inv No</th>
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
                        const foreign = moneyFieldToRinggit(row.foreignStr) ?? NaN;
                        const rate = parseFloat(row.rateStr);
                        const previewRm =
                          Number.isFinite(foreign) && foreign > 0 && Number.isFinite(rate) && rate > 0
                            ? foreign * rate
                            : 0;
                        return (
                          <tr key={pi.id} className="border-t hover:bg-gray-50 align-top">
                            <td className="px-3 py-2 font-mono">{pi.piNo}</td>
                            <td className="px-3 py-2 font-mono text-gray-600">{pi.supplierInvoiceNo || "—"}</td>
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
                                    className={`w-28 border rounded px-2 py-1 text-sm text-right tabular-nums disabled:bg-gray-100 ${isUnreadableMoney(row.amountStr) ? "border-[#9A3A2D] text-[#9A3A2D]" : "border-[#E2DDD8]"}`}
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
                                      className={`w-24 border rounded px-2 py-1 text-sm text-right tabular-nums disabled:bg-gray-100 ${isUnreadableMoney(row.foreignStr) ? "border-[#9A3A2D] text-[#9A3A2D]" : "border-[#E2DDD8]"}`}
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
                                      className="w-24 border border-[#E2DDD8] rounded px-2 py-1 text-sm text-right tabular-nums"
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
                                className="rounded border-[#E2DDD8]"
                                checked={row.full}
                                onChange={() => (myr ? toggleMyrFull(pi) : toggleForeignFull(pi))}
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

      {/* History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>All Payments</CardTitle>
            <input
              type="text"
              value={histQ}
              onChange={(e) => setHistQ(e.target.value)}
              placeholder="Search payment # / supplier..."
              className="w-64 max-w-full border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm"
            />
          </div>
        </CardHeader>
        <CardContent>
          <BatchActionsBar
            count={sel.count}
            onClear={sel.clear}
            onPrint={() => printVouchers(sel.selectedRows.map(buildSupplierPaymentVoucher))}
            exportName="supplier-payments"
            exportAoa={() => [
              ["Payment #", "Date", "Supplier", "Status", "Voucher Total (RM)", "PI No", "Supplier Inv No", "Amount (RM)"],
              ...sel.selectedRows.flatMap((p) =>
                p.lines.map((l) => [
                  p.paymentNo,
                  formatDateDMY(p.date),
                  p.supplierName ?? "",
                  p.lifecycleState ?? "ACTIVE",
                  (Number(p.totalBankSen ?? 0) / 100).toFixed(2),
                  l.piNo,
                  l.supplierInvoiceNo || "",
                  (Number(l.amountSen ?? 0) / 100).toFixed(2),
                ]),
              ),
            ]}
          />
          {history.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No supplier payments yet</p>
          ) : (
            <div className="border rounded-md overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 w-8 text-center">
                      <input
                        type="checkbox"
                        checked={sel.allSelected}
                        onChange={sel.toggleAll}
                        className="h-3.5 w-3.5 accent-[#6B5C32] align-middle"
                      />
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Payment #</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Supplier</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Date</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Total (RM)</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Lines</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.map((p) => (
                    <tr key={p.paymentNo} onClick={() => setDetail(p)} className={`border-t hover:bg-gray-50 cursor-pointer ${(p.lifecycleState ?? "ACTIVE") !== "ACTIVE" ? "opacity-50" : ""}`}>
                      <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={sel.isSelected(p.paymentNo)}
                          onChange={() => sel.toggle(p.paymentNo)}
                          className="h-3.5 w-3.5 accent-[#6B5C32] align-middle"
                        />
                      </td>
                      <td className={`px-3 py-2 font-mono font-medium ${hasUnappliedAdvance(p) ? "text-blue-600" : ""}`} title={hasUnappliedAdvance(p) ? "Has an unapplied advance — click to knock it off against an invoice" : undefined}>
                        {p.paymentNo}
                      </td>
                      <td className={`px-3 py-2 ${hasUnappliedAdvance(p) ? "text-blue-600" : ""}`}>{p.supplierName}</td>
                      <td className="px-3 py-2 text-gray-600">{formatDateDMY(p.date)}</td>
                      <td className="px-3 py-2 text-right font-medium text-[#4F7C3A]">{formatRM(p.totalBankSen)}</td>
                      <td className="px-3 py-2 text-right text-gray-600">{p.lines?.length ?? 0}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => printVouchers([buildSupplierPaymentVoucher(p)])}
                          title="Print payment voucher"
                          className="inline-flex items-center gap-1 text-[#6B5C32] hover:text-[#1F1D1B] text-xs underline decoration-dotted cursor-pointer mr-3"
                        >
                          <Printer className="h-3 w-3" />print
                        </button>
                        {(p.lifecycleState ?? "ACTIVE") === "ACTIVE" && !lenderIds.has(p.supplierId) && (
                          // A trade-finance repayment has no in-place edit (its
                          // draw allocations live outside the rows) — void it
                          // and record it again. Backend enforces the same.
                          <button onClick={() => editPayment(p)} className="text-xs text-[#3E6570] hover:underline mr-2">Edit</button>
                        )}
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

      {/* Payment detail — click any row to see which invoices it paid */}
      {detail && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setDetail(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b">
              <h2 className="text-lg font-semibold">Payment {detail.paymentNo}</h2>
              <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            <div className="p-5 space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-gray-500">Supplier</p><p className="font-medium">{detail.supplierName}</p></div>
                <div><p className="text-gray-500">Date</p><p className="font-medium">{formatDateDMY(detail.date)}</p></div>
                <div><p className="text-gray-500">Total paid</p><p className="font-bold text-[#4F7C3A]">{formatRM(detail.totalBankSen)}</p></div>
                <div><p className="text-gray-500">Status</p><p><LifecycleBadge state={detail.lifecycleState} /></p></div>
              </div>
              <div>
                <p className="text-gray-500 mb-1">Invoices paid</p>
                <div className="border rounded-md overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50"><tr><th className="text-left px-3 py-1.5 font-medium text-gray-600">PI No</th><th className="text-right px-3 py-1.5 font-medium text-gray-600">Amount (RM)</th><th></th></tr></thead>
                    <tbody>
                      {detail.lines.map((l) => (
                        <tr key={l.id} className="border-t">
                          {isUnappliedAdvanceLine(l) ? (
                            <td className="px-3 py-1.5 font-medium text-blue-600" colSpan={1}>Advance (unapplied)</td>
                          ) : (
                            <td className="px-3 py-1.5 font-mono">{l.piNo}</td>
                          )}
                          <td className={`px-3 py-1.5 text-right tabular-nums ${isUnappliedAdvanceLine(l) ? "text-blue-600" : ""}`}>{formatRM(l.amountSen)}</td>
                          <td className="px-3 py-1.5 text-right">
                            {isUnappliedAdvanceLine(l) && koForAdvanceId !== l.id && (
                              <button
                                onClick={() => openKnockOff(l, detail.supplierId)}
                                className="text-xs text-[#3E6570] hover:underline whitespace-nowrap"
                              >
                                Knock off
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {detail.lines.map(
                  (l) =>
                    koForAdvanceId === l.id && (
                      <div key={`ko-${l.id}`} className="mt-3 p-3 border rounded-md bg-[#FAF8F5] space-y-2">
                        <p className="text-xs text-gray-500">
                          Apply part or all of this RM {formatRM(l.amountSen)} advance to an open invoice — no new
                          payment is made, this just re-attributes it (manual only, per your rule).
                        </p>
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="flex-1 min-w-[10rem]">
                            <label className="block text-xs text-gray-500 mb-0.5">Invoice</label>
                            <select
                              value={koPiId}
                              onChange={(e) => setKoPiId(e.target.value)}
                              className="w-full border border-[#E2DDD8] rounded-md px-2 py-1.5 text-sm"
                              disabled={koLoadingPIs}
                            >
                              <option value="">{koLoadingPIs ? "Loading…" : "Select an invoice"}</option>
                              {koOpenPIs.map((pi) => (
                                <option key={pi.id} value={pi.id}>
                                  {pi.piNo} — outstanding {formatCurrency(pi.amountSen - pi.paidAmountSen)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="w-32">
                            <label className="block text-xs text-gray-500 mb-0.5">Amount (RM)</label>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={koAmountStr}
                              onChange={(e) => setKoAmountStr(e.target.value)}
                              className="w-full border border-[#E2DDD8] rounded-md px-2 py-1.5 text-sm text-right"
                            />
                          </div>
                          <Button size="sm" onClick={submitKnockOff} disabled={koSubmitting || !koPiId}>
                            {koSubmitting ? "Applying…" : "Apply"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setKoForAdvanceId(null)} disabled={koSubmitting}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ),
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty-state hint icon (matches payments.tsx visual vocabulary) */}
      {!selectedSupplierId && history.length === 0 && (
        <div className="flex items-center justify-center text-gray-300 py-8">
          <CreditCard className="h-10 w-10" />
        </div>
      )}
    </div>
  );
}
