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
  Send,
  Truck,
} from "lucide-react";
import { csrfHeaders } from "@/lib/csrf";

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

  const handleAdvance = async (mode: ActionMode) => {
    if (!token || busy) return;
    // First tap arms THIS button; a second tap on the same button confirms.
    // Tapping the other button re-arms it instead of firing.
    if (armed !== mode) {
      setArmed(mode);
      return;
    }
    const apiAction: "DISPATCH" | "DELIVER" =
      mode === "DISPATCH" ? "DISPATCH" : "DELIVER";
    const incomplete = mode === "DELIVER_ISSUE";
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
          body: JSON.stringify({ action: apiAction, incomplete }),
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

            {/* Success state */}
            {justCompleted && (
              <div className="rounded-xl bg-[#4F7C3A] text-white p-6 text-center shadow-sm">
                <CheckCircle2 className="h-14 w-14 mx-auto" strokeWidth={2.5} />
                <p className="text-2xl font-bold mt-2">
                  {justCompleted === "DISPATCH" ? "Dispatched" : "Delivered"}
                </p>
                <p className="text-sm opacity-90 mt-1">
                  {justCompleted === "DISPATCH"
                    ? "The goods are marked as on the way."
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
            {action && !justCompleted && (
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
                  <ActionButton
                    mode="DELIVER_OK"
                    armed={armed}
                    busy={busy}
                    onTap={(m) => void handleAdvance(m)}
                    tone="bg-[#4F7C3A] active:bg-[#426832] text-white"
                    icon={<CheckCircle2 className="h-5 w-5" />}
                    label="Mark Delivered"
                  />
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
              </div>
            )}

            {/* No staff-ERP link here — this is the public driver page
                (Wei Siang 2026-06-15: a driver shouldn't see a staff login). */}
            <p className="text-[10px] text-center text-gray-400">
              Need a change to the load? Contact the Hookka office — this page
              only updates delivery status.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
