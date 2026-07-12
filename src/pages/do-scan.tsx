// Public QR dispatch/deliver page — opened by the loading crew / driver
// scanning the QR printed on a Delivery Order or Packing List (/d/<token>).
// Intentionally standalone (no dashboard/portal chrome), mobile-first,
// NO LOGIN — the unguessable token in the URL is the credential, and the
// backend (/api/public/do-qr) only allows the forward transitions the office
// "Mark Dispatched" / "Mark Delivered" buttons perform. Mirrors the public
// /track page's mounting + visual style.

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  PackageX,
  Plus,
  Send,
  SlidersHorizontal,
  Truck,
} from "lucide-react";
import { csrfHeaders } from "@/lib/csrf";
import { compareDoLinesByCustomerPO } from "@/lib/do-item-order";

type PublicDoLine = {
  productionOrderId: string;
  poNo: string;
  productCode: string;
  productName: string;
  quantity: number;
};

type PublicDoSummary = {
  id: string;
  doNo: string;
  customerName: string;
  area: string;
  status: string;
  itemCount: number;
  productNames: string[];
  // Delivered "with issues" — paperwork incomplete, invoice on hold.
  incomplete?: boolean;
  // Full line list — powers the "which items are returning?" checklist on
  // Delivered with Issue.
  items?: PublicDoLine[];
};

type PublicPayload =
  | { kind: "DO"; dos: PublicDoSummary[] }
  | { kind: "PL"; packingNo: string; plId: string; dos: PublicDoSummary[] };

type AdvanceResult = {
  doNo: string;
  outcome: "DONE" | "SKIPPED" | "BLOCKED" | "FAILED";
  from: string;
  to?: string;
  note?: string;
};

// The button the crew tapped. DISPATCH = 1st scan. The 2nd scan splits into
// two outcomes: DELIVER_OK (complete → auto-invoice + receipt) and
// DELIVER_ISSUE (delivered but paperwork incomplete → invoice held back).
type ActionMode = "DISPATCH" | "DELIVER_OK" | "DELIVER_ISSUE";

type AdvanceResponse = {
  success?: boolean;
  error?: string;
  data?: {
    action: "DISPATCH" | "DELIVER";
    results: AdvanceResult[];
    done: number;
    skipped: number;
    blocked: number;
    failed: number;
    summary?: PublicPayload;
  };
};

// Item-edit (lorry space) — load before dispatch, adjust what's on the truck.
// `items` are already on the DO (ticked = keep); `addable` are other ready POs
// for the same customer (ticked = add to this trip). Server owns the trusted
// set — the page only sends back the chosen production-order ids.
type EditItem = {
  productionOrderId: string;
  poNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  itemM3: number;
  // Sort keys — the scan list orders these EXACTLY like the printed DO
  // (customer PO asc, then SO no.; see compareDoLinesByCustomerPO).
  salesOrderNo?: string | null;
  customerPOId?: string | null;
};

// One DO's edit model. A single-DO scan returns one; a packing-list scan
// returns one per member DO so the phone can show + edit each.
type EditDoModel = {
  doId: string;
  doNo: string;
  status: string;
  customerName: string;
  area: string;
  editable: boolean;
  items: EditItem[];
  addable: EditItem[];
};

type EditResponse = {
  kind: "DO" | "PL";
  packingNo?: string;
  dos: EditDoModel[];
};

// Same words the office Delivery page uses for the DO pipeline.
const STATUS_CHIP: Record<string, { bg: string; text: string; label: string }> = {
  DRAFT: { bg: "bg-[#F5EDDC]", text: "text-[#9C6F1E]", label: "Pending Dispatch" },
  LOADED: { bg: "bg-[#E0EDF0]", text: "text-[#3E6570]", label: "Dispatched" },
  IN_TRANSIT: { bg: "bg-[#E0EDF0]", text: "text-[#3E6570]", label: "In Transit" },
  DELIVERED: { bg: "bg-[#E3EBE6]", text: "text-[#2F5D3F]", label: "Delivered" },
  INVOICED: { bg: "bg-[#E3EBE6]", text: "text-[#2F5D3F]", label: "Invoiced" },
  CANCELLED: { bg: "bg-[#F9E1DA]", text: "text-[#9A3A2D]", label: "Cancelled" },
};

function StatusChip({ status }: { status: string }) {
  const c = STATUS_CHIP[(status || "").toUpperCase()] ?? {
    bg: "bg-gray-200",
    text: "text-gray-700",
    label: status || "-",
  };
  return (
    <span
      className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}
    >
      {c.label}
    </span>
  );
}

// The ONE forward action the page offers (forward-only, same rule as the
// backend): any DO still Pending Dispatch → "Mark Dispatched"; otherwise any
// dispatched DO → "Mark Delivered"; otherwise nothing remains.
function nextAction(dos: PublicDoSummary[]): "DISPATCH" | "DELIVER" | null {
  const up = (s: string) => (s || "").toUpperCase();
  if (dos.some((d) => up(d.status) === "DRAFT")) return "DISPATCH";
  if (dos.some((d) => up(d.status) === "LOADED" || up(d.status) === "IN_TRANSIT"))
    return "DELIVER";
  return null;
}

function DoCard({ d }: { d: PublicDoSummary }) {
  return (
    <div className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-base font-bold text-[#1F1D1B]">{d.doNo}</p>
        <StatusChip status={d.status} />
      </div>
      <div className="text-sm text-[#1F1D1B]">
        <p className="font-medium">{d.customerName || "-"}</p>
        {d.area && <p className="text-xs text-gray-500 mt-0.5">{d.area}</p>}
      </div>
      <div className="pt-2 border-t border-[#E6E0D9] text-xs text-gray-600">
        <p>
          <span className="font-semibold text-[#1F1D1B]">{d.itemCount}</span>{" "}
          item{d.itemCount === 1 ? "" : "s"}
          {d.productNames.length > 0 && (
            <>
              {" — "}
              {d.productNames.join(", ")}
              {d.itemCount > d.productNames.length ? ", …" : ""}
            </>
          )}
        </p>
      </div>
      {d.incomplete && (
        <div className="flex items-start gap-1.5 rounded-lg bg-[#FBF1DF] px-2.5 py-2 text-xs text-[#9C6F1E]">
          <PackageX className="h-4 w-4 shrink-0 mt-px" />
          <span>
            Delivered with issues — paperwork incomplete, the office will
            invoice once resolved.
          </span>
        </div>
      )}
    </div>
  );
}

// Big confirm-on-second-tap button. Spinner shows only on the button actually
// firing (its mode is the armed one); the others just disable while busy.
function ActionButton({
  mode,
  armed,
  busy,
  onTap,
  tone,
  icon,
  label,
}: {
  mode: ActionMode;
  armed: ActionMode | null;
  busy: boolean;
  onTap: (m: ActionMode) => void;
  tone: string;
  icon: ReactNode;
  label: string;
}) {
  const isArmed = armed === mode;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onTap(mode)}
      className={`w-full rounded-xl ${tone} py-4 text-lg font-bold shadow-sm flex items-center justify-center gap-2 disabled:opacity-60`}
    >
      {busy && isArmed ? (
        <span className="h-5 w-5 rounded-full border-2 border-current border-t-transparent animate-spin" />
      ) : (
        icon
      )}
      {isArmed ? `Tap again to confirm — ${label}` : label}
    </button>
  );
}

// One row in the Adjust-load panel — a DO item (keep) or an addable ready PO.
function ItemRow({
  it,
  checked,
  onToggle,
  addable,
  hideCustomerPO,
}: {
  it: EditItem;
  checked: boolean;
  onToggle: () => void;
  addable?: boolean;
  // The header already shows one shared Customer PO for the whole DO — drop
  // the per-row copy then to avoid showing the same reference twice.
  hideCustomerPO?: boolean;
}) {
  // The owner reads the PRODUCT CODE (our SKU, e.g. 1013-(K)) and the
  // colour/fabric (e.g. PC151-01) to identify the item — make these the
  // prominent line. Above it, the only customer-facing reference: the
  // Customer PO (there is no customer SO; never show our internal SO no.).
  // Internal product name + size drop to a quiet secondary line.
  const context = hideCustomerPO ? "" : (it.customerPOId || "").trim();
  const productCode = (it.productCode || "").trim();
  const fabric = (it.fabricCode || "").trim();
  const detail = [it.sizeLabel, it.productName]
    .map((v) => (v || "").trim())
    .filter(Boolean)
    .join(" · ");
  return (
    <label
      className={`flex items-center gap-2.5 rounded-lg border p-2.5 cursor-pointer ${
        checked
          ? "border-[#6B5C32]/40 bg-[#6B5C32]/5"
          : addable
            ? "border-dashed border-[#CDBD9B]"
            : "border-[#E6E0D9]"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 accent-[#6B5C32]"
      />
      <div className="min-w-0 flex-1">
        {context && (
          <p className="truncate text-[11px] text-gray-500">{context}</p>
        )}
        <p className="truncate text-sm font-bold text-[#1F1D1B]">
          {productCode || it.productName || it.poNo || "Item"}
          {fabric && (
            <span className="font-medium text-[#6B5C32]">
              {"  ·  Fabrics: "}
              {fabric}
            </span>
          )}
        </p>
        {detail && <p className="truncate text-xs text-gray-400">{detail}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs font-semibold text-[#1F1D1B]">×{it.quantity}</p>
        {it.itemM3 > 0 && (
          <p className="text-[10px] text-gray-400">
            {(it.itemM3 * it.quantity).toFixed(2)} m³
          </p>
        )}
      </div>
    </label>
  );
}

export default function DoScanPage() {
  const { token } = useParams();
  const [payload, setPayload] = useState<PublicPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // armed = which button got its first tap, waiting for the confirm tap. The
  // deliver step offers two outcomes so we track the specific mode, not a bool.
  const [armed, setArmed] = useState<ActionMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [lastResults, setLastResults] = useState<AdvanceResult[] | null>(null);
  const [justCompleted, setJustCompleted] = useState<ActionMode | null>(null);

  // ── Item-edit (lorry space) — single DO or every DO under a packing list ─
  const [editOpen, setEditOpen] = useState(false);
  const [editData, setEditData] = useState<EditResponse | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // doId → set of production-order ids ticked = "on the lorry".
  const [checkedByDo, setCheckedByDo] = useState<Record<string, Set<string>>>(
    {},
  );

  // ── Delivered with Issue — tick which lines are being RETURNED ───────────
  const [issueOpen, setIssueOpen] = useState(false);
  // doId → set of production-order ids ticked = "returning" (not delivered).
  const [returnByDo, setReturnByDo] = useState<Record<string, Set<string>>>({});
  const toggleReturn = (doId: string, poId: string) => {
    setReturnByDo((prev) => {
      const cur = new Set(prev[doId] ?? []);
      if (cur.has(poId)) cur.delete(poId);
      else cur.add(poId);
      return { ...prev, [doId]: cur };
    });
  };

  // No synchronous setState before the first await — `loading` starts true
  // and every write below lands in the async continuation, so the mount
  // effect's call stack stays setState-free (react-hooks/set-state-in-effect).
  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(
        `/api/public/do-qr/${encodeURIComponent(token)}`,
        { cache: "no-store" },
      );
      setLoadError(null);
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: PublicPayload;
        error?: string;
      };
      if (!r.ok || !j.success || !j.data) {
        setPayload(null);
        setLoadError(
          j.error ||
            "Unknown or expired QR code. Please ask the Hookka office for a freshly printed copy.",
        );
      } else {
        setPayload(j.data);
      }
    } catch {
      setPayload(null);
      setLoadError("Network error. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount (public page, no cached-fetch session deps); same pattern as sidebar.tsx
    void load();
  }, [load]);

  const action = useMemo(
    () => (payload ? nextAction(payload.dos) : null),
    [payload],
  );

  // DOs at the deliver step (LOADED/IN_TRANSIT) — the return-picker lists these.
  const deliverableDos = useMemo(
    () =>
      (payload?.dos ?? []).filter((d) => {
        const s = (d.status || "").toUpperCase();
        return s === "LOADED" || s === "IN_TRANSIT";
      }),
    [payload],
  );
  const returnedCount = useMemo(
    () => deliverableDos.reduce((n, d) => n + (returnByDo[d.id]?.size ?? 0), 0),
    [deliverableDos, returnByDo],
  );

  const allCancelled = useMemo(
    () =>
      !!payload &&
      payload.dos.length > 0 &&
      payload.dos.every((d) => (d.status || "").toUpperCase() === "CANCELLED"),
    [payload],
  );

  const anyIncomplete = useMemo(
    () => !!payload && payload.dos.some((d) => d.incomplete),
    [payload],
  );

  // Item editing is offered whenever there's a DO still Pending Dispatch
  // (DRAFT) — a single DO scan, or any DRAFT member of a packing-list scan.
  const canEditLoad = useMemo(
    () =>
      !!payload &&
      payload.dos.some((d) => (d.status || "").toUpperCase() === "DRAFT"),
    [payload],
  );

  const openEdit = useCallback(async () => {
    if (!token || editLoading) return;
    setEditLoading(true);
    setEditError(null);
    try {
      const r = await fetch(
        `/api/public/do-qr/${encodeURIComponent(token)}/edit`,
        { cache: "no-store" },
      );
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: EditResponse;
        error?: string;
      };
      if (!r.ok || !j.success || !j.data) {
        setEditError(j.error || "Could not load items. Please try again.");
        return;
      }
      const editable = j.data.dos.filter((d) => d.editable);
      if (editable.length === 0) {
        setEditError(
          "Nothing to adjust — these deliveries are already dispatched.",
        );
        return;
      }
      // Sort each DO's lines EXACTLY like the printed DO (customer PO asc, then
      // SO no.) so the scan mirrors the office row-for-row — D.O. 第一行 ==
      // 扫描后第一行, and add/remove keeps the same order. Then pre-tick the
      // current items. Display-only; the server still owns the trusted set.
      const init: Record<string, Set<string>> = {};
      for (const d of j.data.dos) {
        // Defensive: a malformed payload (missing items/addable) must not throw
        // here — a bare .sort() on undefined would crash the whole scan page.
        if (Array.isArray(d.items)) d.items.sort(compareDoLinesByCustomerPO);
        if (Array.isArray(d.addable))
          d.addable.sort(compareDoLinesByCustomerPO);
        init[d.doId] = new Set(
          (d.items ?? []).map((i) => i.productionOrderId).filter(Boolean),
        );
      }
      setEditData(j.data);
      setCheckedByDo(init);
      setEditOpen(true);
    } catch {
      setEditError("Network error. Please try again.");
    } finally {
      setEditLoading(false);
    }
  }, [token, editLoading]);

  const toggleChecked = (doId: string, poId: string) => {
    setCheckedByDo((prev) => {
      const cur = new Set(prev[doId] ?? []);
      if (cur.has(poId)) cur.delete(poId);
      else cur.add(poId);
      return { ...prev, [doId]: cur };
    });
  };

  // Editable DOs + running load total across all of them.
  const editableDos = editData ? editData.dos.filter((d) => d.editable) : [];
  const chosenAcross = editableDos.flatMap((d) =>
    [...d.items, ...d.addable].filter((x) =>
      (checkedByDo[d.doId] ?? new Set<string>()).has(x.productionOrderId),
    ),
  );
  const chosenCount = chosenAcross.reduce((s, x) => s + (x.quantity || 0), 0);
  const chosenM3 = chosenAcross.reduce(
    (s, x) => s + (x.itemM3 || 0) * (x.quantity || 0),
    0,
  );

  const handleAdvance = async (
    mode: ActionMode,
    edits?: Record<string, string[]>,
    returnItems?: Record<string, string[]>,
  ) => {
    if (!token || busy) return;
    // The two-tap arm→confirm guard applies to the big top-level buttons. An
    // edited dispatch (Adjust-load panel) and a Delivered-with-Issue return
    // (return-picker panel) are already deliberate actions with their own
    // confirm button, so they fire immediately.
    if (!edits && returnItems === undefined && armed !== mode) {
      setArmed(mode);
      return;
    }
    const apiAction: "DISPATCH" | "DELIVER" =
      mode === "DISPATCH" ? "DISPATCH" : "DELIVER";
    setBusy(true);
    setAdvanceError(null);
    try {
      const r = await fetch(
        `/api/public/do-qr/${encodeURIComponent(token)}/advance`,
        {
          method: "POST",
          // csrfHeaders: drivers have no cookies (header silently omitted);
          // a logged-in staff phone DOES carry the session cookie, and the
          // backend then requires the CSRF echo — include it so both work.
          headers: csrfHeaders(),
          body: JSON.stringify({
            action: apiAction,
            // Delivered-with-Issue: per-DO production-order ids the driver
            // ticked as returned → the backend opens a Delivery Return for
            // just those and delivers/invoices the rest.
            ...(returnItems ? { returnItems } : {}),
            // Edited item set per DO (production-order ids) — only sent for a
            // dispatch from the Adjust-load panel; the server rebuilds the
            // trusted items from these ids.
            ...(edits ? { edits } : {}),
          }),
        },
      );
      const j = (await r.json().catch(() => ({}))) as AdvanceResponse;
      if (!r.ok || !j.success || !j.data) {
        setAdvanceError(j.error || "Could not update. Please try again.");
        return;
      }
      setLastResults(j.data.results);
      if (j.data.summary) setPayload(j.data.summary);
      else await load();
      if (j.data.done > 0) {
        setJustCompleted(mode);
        setEditOpen(false);
        setIssueOpen(false);
      } else if (j.data.failed > 0) {
        setAdvanceError(
          j.data.results.find((x) => x.outcome === "FAILED")?.note ||
            "Could not update. Please try again.",
        );
      }
    } catch {
      setAdvanceError("Network error. Please check your connection and try again.");
    } finally {
      setArmed(null);
      setBusy(false);
    }
  };

  // Confirm the deliver step with the ticked returns. Any ticked → those lines
  // open a Delivery Return + the rest deliver; none ticked → a plain delivery.
  const submitIssue = () => {
    const picks: Record<string, string[]> = {};
    for (const d of deliverableDos) {
      const ids = [...(returnByDo[d.id] ?? new Set<string>())];
      if (ids.length) picks[d.id] = ids;
    }
    void handleAdvance(
      Object.keys(picks).length > 0 ? "DELIVER_ISSUE" : "DELIVER_OK",
      undefined,
      picks,
    );
  };

  return (
    <div className="min-h-screen bg-[#F0ECE9]">
      {/* Header */}
      <header className="bg-[#1F1D1B] text-white">
        <div className="max-w-xl mx-auto px-4 py-5 flex items-center gap-3">
          <div className="h-9 w-9 rounded bg-[#6B5C32] flex items-center justify-center">
            <Truck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Delivery Status</h1>
            <p className="text-xs text-gray-400">HOOKKA INDUSTRIES</p>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-6 space-y-4 pb-12">
        {loading && (
          <div className="rounded-xl bg-white p-8 text-center shadow-sm border border-[#E6E0D9]">
            <div className="h-8 w-8 mx-auto rounded-full border-4 border-[#6B5C32] border-t-transparent animate-spin" />
            <p className="mt-3 text-sm text-gray-500">Looking up document...</p>
          </div>
        )}

        {!loading && loadError && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-[#E8B2A1]">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-[#9A3A2D] shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-[#9A3A2D]">Document not found</p>
                <p className="text-sm text-[#9A3A2D] mt-1">{loadError}</p>
              </div>
            </div>
          </div>
        )}

        {!loading && payload && (
          <>
            {/* Document header card */}
            {payload.kind === "PL" && (
              <div className="rounded-xl bg-[#1F1D1B] text-white p-4 shadow-sm">
                <p className="text-xs uppercase tracking-widest text-gray-400">
                  Packing List
                </p>
                <p className="text-2xl font-bold mt-0.5">{payload.packingNo}</p>
                <p className="text-xs text-gray-400 mt-1">
                  {payload.dos.length} delivery order
                  {payload.dos.length === 1 ? "" : "s"} on this truck run —
                  one tap updates all of them.
                </p>
              </div>
            )}

            {/* Success state — delivery always succeeded (the flagged lines are
                just recorded as a return); green in every case. */}
            {justCompleted && (
              <div className="rounded-xl text-white p-6 text-center shadow-sm bg-[#4F7C3A]">
                <CheckCircle2 className="h-14 w-14 mx-auto" strokeWidth={2.5} />
                <p className="text-2xl font-bold mt-2">
                  {justCompleted === "DISPATCH" ? "Dispatched" : "Delivered"}
                </p>
                <p className="text-sm opacity-90 mt-1">
                  {justCompleted === "DISPATCH"
                    ? "The goods are marked as on the way."
                    : justCompleted === "DELIVER_ISSUE"
                      ? "The flagged items are set aside as a return — the office will process them."
                      : "Delivery confirmed. Thank you!"}
                </p>
              </div>
            )}

            {/* Already-done state (no forward action remains) */}
            {!justCompleted && !action && !allCancelled && payload.dos.length > 0 && (
              <div
                className={`rounded-xl bg-white p-6 text-center shadow-sm border ${anyIncomplete ? "border-[#E8D3A1]" : "border-[#E6E0D9]"}`}
              >
                {anyIncomplete ? (
                  <PackageX className="h-12 w-12 mx-auto text-[#9C6F1E]" strokeWidth={2.5} />
                ) : (
                  <CheckCircle2 className="h-12 w-12 mx-auto text-[#4F7C3A]" strokeWidth={2.5} />
                )}
                <p className="text-xl font-bold text-[#1F1D1B] mt-2">
                  {anyIncomplete ? "Delivered — paperwork pending" : "Already delivered"}
                </p>
                <p className="text-sm text-gray-500 mt-1">
                  {anyIncomplete
                    ? "Delivery is recorded. The office still needs to resolve the paperwork before this can be invoiced."
                    : "Nothing left to do here — every delivery order on this document is delivered."}
                </p>
              </div>
            )}

            {allCancelled && (
              <div className="rounded-xl bg-white p-6 text-center shadow-sm border border-[#E8B2A1]">
                <AlertTriangle className="h-10 w-10 mx-auto text-[#9A3A2D]" />
                <p className="text-lg font-bold text-[#9A3A2D] mt-2">Cancelled</p>
                <p className="text-sm text-gray-500 mt-1">
                  This document was cancelled. Please contact the Hookka office.
                </p>
              </div>
            )}

            {/* Per-DO summary cards */}
            {payload.dos.map((d) => (
              <DoCard key={d.id} d={d} />
            ))}

            {/* Per-DO outcome notes from the last action (skips/failures) */}
            {lastResults &&
              lastResults.some((x) => x.outcome === "BLOCKED" || x.outcome === "FAILED") && (
                <div className="rounded-xl bg-white p-4 shadow-sm border border-[#E8B2A1] text-sm space-y-1">
                  {lastResults
                    .filter((x) => x.outcome === "BLOCKED" || x.outcome === "FAILED")
                    .map((x) => (
                      <p key={x.doNo} className="text-[#9A3A2D]">
                        <span className="font-mono font-medium">{x.doNo}</span>
                        {": "}
                        {x.note || "Could not update"}
                      </p>
                    ))}
                </div>
              )}

            {advanceError && (
              <div className="rounded-xl bg-white p-4 shadow-sm border border-[#E8B2A1]">
                <p className="text-sm text-[#9A3A2D]">{advanceError}</p>
              </div>
            )}

            {/* Action button — one forward step: Mark Dispatched, then Mark
                Delivered. (The "Delivered with issues" outcome is parked — no
                downstream process yet; office handles problems manually.) */}
            {action && !justCompleted && !editOpen && !issueOpen && (
              <div className="space-y-3">
                {action === "DISPATCH" ? (
                  <ActionButton
                    mode="DISPATCH"
                    armed={armed}
                    busy={busy}
                    onTap={(m) => void handleAdvance(m)}
                    tone="bg-[#9C6F1E] active:bg-[#835D19] text-white"
                    icon={<Send className="h-5 w-5" />}
                    label="Mark Dispatched"
                  />
                ) : (
                  <>
                    <ActionButton
                      mode="DELIVER_OK"
                      armed={armed}
                      busy={busy}
                      onTap={(m) => void handleAdvance(m)}
                      tone="bg-[#4F7C3A] active:bg-[#426832] text-white"
                      icon={<CheckCircle2 className="h-5 w-5" />}
                      label="Mark Delivered"
                    />
                    {/* Some items have a problem and are coming back. Opens the
                        return-picker: tick the returned lines → they open a
                        Delivery Return, the rest deliver + invoice as normal. */}
                    {!armed && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setIssueOpen(true)}
                        className="w-full rounded-xl bg-white border border-[#D89B3A] text-[#8A5A12] active:bg-[#FBF3E4] py-4 text-lg font-bold shadow-sm flex items-center justify-center gap-2 disabled:opacity-60"
                      >
                        <AlertTriangle className="h-5 w-5" />
                        Delivered with Issue
                      </button>
                    )}
                  </>
                )}
                {armed && !busy && (
                  <button
                    type="button"
                    onClick={() => setArmed(null)}
                    className="w-full rounded-xl bg-white border border-[#E6E0D9] text-gray-600 py-2.5 text-sm font-medium"
                  >
                    Cancel
                  </button>
                )}
                {/* Adjust the lorry load before dispatch (single DO only). */}
                {action === "DISPATCH" && canEditLoad && !armed && (
                  <button
                    type="button"
                    disabled={editLoading || busy}
                    onClick={() => void openEdit()}
                    className="w-full rounded-xl bg-white border border-[#E6E0D9] text-[#6B5C32] py-3 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {editLoading ? (
                      <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                    ) : (
                      <SlidersHorizontal className="h-4 w-4" />
                    )}
                    Adjust load (add / remove items)
                  </button>
                )}
                {editError && (
                  <p className="text-sm text-center text-[#9A3A2D]">{editError}</p>
                )}
              </div>
            )}

            {/* Return-picker panel (Delivered with Issue) — tick the lines that
                are coming back. Ticked lines open a Delivery Return; every other
                line is delivered + invoiced. Nothing ticked = a plain delivery. */}
            {issueOpen && !justCompleted && (
              <div className="space-y-3">
                <div className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-4 space-y-1">
                  <p className="text-base font-bold text-[#1F1D1B]">
                    Which items are coming back?
                  </p>
                  <p className="text-xs text-gray-500">
                    Tick the items with a problem that are being returned. The
                    rest are delivered as normal. The office processes the return.
                  </p>
                </div>

                {deliverableDos.map((d) => {
                  const picked = returnByDo[d.id] ?? new Set<string>();
                  const items = d.items ?? [];
                  return (
                    <div
                      key={d.id}
                      className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-4 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-bold text-[#1F1D1B]">{d.doNo}</p>
                        <span className="truncate text-xs text-gray-500 text-right shrink-0">
                          {d.customerName}
                          {d.area ? ` · ${d.area}` : ""}
                        </span>
                      </div>
                      {items.length === 0 ? (
                        <p className="text-xs text-gray-400">No items on this order.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {items.map((it) => {
                            const on = picked.has(it.productionOrderId);
                            return (
                              <label
                                key={it.productionOrderId}
                                className={`flex items-center gap-2.5 rounded-lg border p-2.5 cursor-pointer ${
                                  on
                                    ? "border-[#C08457]/60 bg-[#9A3A2D]/5"
                                    : "border-[#E6E0D9]"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={() =>
                                    toggleReturn(d.id, it.productionOrderId)
                                  }
                                  className="h-4 w-4 accent-[#9A3A2D]"
                                />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-bold text-[#1F1D1B]">
                                    {it.productCode || it.productName || it.poNo || "Item"}
                                  </p>
                                  {it.productName && it.productCode && (
                                    <p className="truncate text-xs text-gray-400">
                                      {it.productName}
                                    </p>
                                  )}
                                </div>
                                <span className="shrink-0 text-xs font-semibold text-[#1F1D1B]">
                                  ×{it.quantity}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-4 space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">Returning</span>
                    <span className="font-semibold text-[#9A3A2D]">
                      {returnedCount} item{returnedCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  {advanceError && (
                    <p className="text-sm text-[#9A3A2D]">{advanceError}</p>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={submitIssue}
                    className="w-full rounded-xl bg-[#4F7C3A] active:bg-[#426832] text-white py-3.5 text-base font-bold shadow-sm flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {busy ? (
                      <span className="h-5 w-5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-5 w-5" />
                    )}
                    {returnedCount > 0
                      ? `Deliver — return ${returnedCount} item${returnedCount === 1 ? "" : "s"}`
                      : "Mark Delivered"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setIssueOpen(false);
                      setReturnByDo({});
                    }}
                    className="w-full rounded-xl bg-white border border-[#E6E0D9] text-gray-600 py-2.5 text-sm font-medium disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Adjust-load panel — one card per DO (single scan = one card;
                packing-list scan = one card per member DO). Tick what rides on
                the lorry, untick what won't fit (it returns to the ready pool
                for a later trip), add other finished items for the same
                customer, then dispatch the ticked set in one tap. */}
            {editOpen && editData && !justCompleted && (
              <div className="space-y-3">
                <div className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-4 space-y-1">
                  <p className="text-base font-bold text-[#1F1D1B]">Adjust load</p>
                  <p className="text-xs text-gray-500">
                    Tick what goes on the lorry. Untick anything that won&apos;t
                    fit — it stays ready for the next trip. Unticking a whole
                    delivery order leaves it for later.
                  </p>
                  {editData.kind === "PL" && editData.packingNo && (
                    <p className="text-xs text-gray-400">
                      Packing list {editData.packingNo} · {editableDos.length}{" "}
                      delivery order{editableDos.length === 1 ? "" : "s"}
                    </p>
                  )}
                </div>

                {editableDos.map((d) => {
                  const doChecked = checkedByDo[d.doId] ?? new Set<string>();
                  // Header shows the DO number (+ customer / branch). Show a
                  // single Customer PO here ONLY when every line on this DO
                  // (kept + addable) carries the same one — then it's a safe
                  // page-level reference. When the DO spans several customer
                  // POs a header PO would be misleading, so we leave it off and
                  // let the per-row Customer PO carry the context instead.
                  const poSet = new Set(
                    [...d.items, ...d.addable]
                      .map((it) => (it.customerPOId || "").trim())
                      .filter(Boolean),
                  );
                  const sharedCustomerPO =
                    poSet.size === 1 ? [...poSet][0] : "";
                  return (
                    <div
                      key={d.doId}
                      className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-4 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-[#1F1D1B]">
                            {d.doNo}
                          </p>
                          {sharedCustomerPO && (
                            <p className="truncate text-xs text-gray-500 mt-0.5">
                              Customer PO: {sharedCustomerPO}
                            </p>
                          )}
                        </div>
                        <span className="truncate text-xs text-gray-500 text-right shrink-0">
                          {d.customerName}
                          {d.area ? ` · ${d.area}` : ""}
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {d.items.map((it) => (
                          <ItemRow
                            key={it.productionOrderId}
                            it={it}
                            checked={doChecked.has(it.productionOrderId)}
                            onToggle={() =>
                              toggleChecked(d.doId, it.productionOrderId)
                            }
                            hideCustomerPO={!!sharedCustomerPO}
                          />
                        ))}
                      </div>
                      {d.addable.length > 0 && (
                        <div className="space-y-1.5 border-t border-[#E6E0D9] pt-2.5">
                          <p className="flex items-center gap-1 text-xs font-semibold text-[#6B5C32]">
                            <Plus className="h-3.5 w-3.5" /> Add more for{" "}
                            {d.customerName || "this customer"}
                          </p>
                          {d.addable.map((it) => (
                            <ItemRow
                              key={it.productionOrderId}
                              it={it}
                              checked={doChecked.has(it.productionOrderId)}
                              onToggle={() =>
                                toggleChecked(d.doId, it.productionOrderId)
                              }
                              addable
                              hideCustomerPO={!!sharedCustomerPO}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-4 space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">On the lorry</span>
                    <span className="font-semibold text-[#1F1D1B]">
                      {chosenCount} item{chosenCount === 1 ? "" : "s"}
                      {chosenM3 > 0 ? ` · ${chosenM3.toFixed(2)} m³` : ""}
                    </span>
                  </div>
                  {advanceError && (
                    <p className="text-sm text-[#9A3A2D]">{advanceError}</p>
                  )}
                  <button
                    type="button"
                    disabled={busy || chosenCount === 0}
                    onClick={() => {
                      const edits: Record<string, string[]> = {};
                      for (const d of editableDos) {
                        const ids = [
                          ...(checkedByDo[d.doId] ?? new Set<string>()),
                        ];
                        if (ids.length > 0) edits[d.doId] = ids;
                      }
                      void handleAdvance("DISPATCH", edits);
                    }}
                    className="w-full rounded-xl bg-[#9C6F1E] active:bg-[#835D19] text-white py-3.5 text-base font-bold shadow-sm flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {busy ? (
                      <span className="h-5 w-5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                    ) : (
                      <Send className="h-5 w-5" />
                    )}
                    Dispatch {chosenCount} item{chosenCount === 1 ? "" : "s"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setEditOpen(false)}
                    className="w-full rounded-xl bg-white border border-[#E6E0D9] text-gray-600 py-2.5 text-sm font-medium disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* No staff-ERP link here — this is the public driver/crew page
                (Wei Siang 2026-06-15: no staff login on the public scan). */}
            <p className="text-[10px] text-center text-gray-400">
              For other changes, contact the Hookka office.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
