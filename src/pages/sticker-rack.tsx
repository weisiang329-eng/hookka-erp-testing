// Public packing-sticker → RACK assignment page — opened by a storekeeper
// scanning the QR printed on a Packing (FG) sticker (/p/<token>).
// Intentionally standalone (no dashboard / worker-portal chrome), mobile-first,
// NO LOGIN — the unguessable 64-hex token in the URL is the credential, and the
// backend (/api/public/rack-write) only performs the one action this page
// needs: set/clear the warehouse rack number for THIS piece. Mirrors the public
// /d/:token (do-scan) and /r/:rackId (rack-scan) pages' mounting + visual style.
//
// This is the ITEM→RACK direction. It exists because the Packing-sticker QR used
// to deep-link into /worker/scan — a Worker-Portal page that bounces anyone
// without a PIN to the login screen — so a storekeeper scanning the sticker was
// blocked from doing the one thing they wanted: tell the system which rack the
// piece went onto.
//
// Flow:
//   1. On mount, GET the piece summary (PO no., SO no., WIP description, current
//      rack) + the warehouse rack catalog.
//   2. Pick a rack from the dropdown (natural-sorted like worker/scan.tsx), or
//      pick "— Clear rack —" to remove it.
//   3. Two-tap Save (arm → confirm, like the DO/rack-scan buttons) POSTs the
//      rack. Plain fetch + csrfHeaders() so a logged-in staff phone also works.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  MapPin,
  PackageCheck,
} from "lucide-react";
import { csrfHeaders } from "@/lib/csrf";

// ── Backend shape (API contract — see routes/public-rack-write.ts) ─────────
type RackOption = { rack: string; occupied: boolean };
type PieceSummary = {
  poNo: string;
  salesOrderNo: string;
  description: string;
  rackingNumber: string;
  racks: RackOption[];
};

// Sentinel for the "clear the rack" dropdown option — distinct from a real
// rack value (which is never empty in the catalog) and from "not chosen".
const CLEAR = "__CLEAR__";

export default function StickerRackPage() {
  const { token } = useParams();

  // ── Piece summary (mount fetch) ──────────────────────────────────────────
  const [summary, setSummary] = useState<PieceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Rack selection + save (two-tap arm → confirm) ────────────────────────
  // selected: "" = nothing chosen yet, CLEAR = remove rack, else a rack value.
  const [selected, setSelected] = useState<string>("");
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  // ── Mount: load the piece summary + rack catalog ─────────────────────────
  // No synchronous setState before the first await — `loading` starts true and
  // every write lands in the async continuation (matches do-scan / rack-scan).
  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(
        `/api/public/rack-write/${encodeURIComponent(token)}`,
        { cache: "no-store" },
      );
      setLoadError(null);
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: PieceSummary;
        error?: string;
      };
      if (!r.ok || !j.success || !j.data) {
        setSummary(null);
        setLoadError(
          j.error ||
            "This QR is not valid. Please ask the Hookka office for a freshly printed sticker.",
        );
      } else {
        // Natural-sort the rack picker (Rack 1, 2, 3 … 10 — not lexical) just
        // like the worker scan page.
        const racks = [...(j.data.racks ?? [])].sort((a, b) =>
          a.rack.localeCompare(b.rack, undefined, { numeric: true }),
        );
        setSummary({ ...j.data, racks });
        // Pre-select the current rack so the picker reflects reality.
        setSelected(j.data.rackingNumber || "");
      }
    } catch {
      setSummary(null);
      setLoadError("Network error. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount (public page, no session deps); same pattern as do-scan.tsx / rack-scan.tsx
    void load();
  }, [load]);

  // ── Save the rack onto THIS piece (two-tap arm → confirm) ────────────────
  const handleSave = useCallback(async () => {
    if (!token || saving || !summary) return;
    if (selected === "") return; // nothing chosen
    // First tap arms, second tap confirms — same guard as the DO/rack-scan
    // buttons.
    if (!armed) {
      setArmed(true);
      return;
    }
    // CLEAR sends an empty string (the backend treats "" as clear-the-rack).
    const rackingNumber = selected === CLEAR ? "" : selected;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch(
        `/api/public/rack-write/${encodeURIComponent(token)}/rack`,
        {
          method: "POST",
          // csrfHeaders: cookieless public users send no CSRF header (silently
          // omitted); a logged-in staff phone carries the session cookie and the
          // backend then requires the echo — include it so both paths work.
          headers: csrfHeaders(),
          body: JSON.stringify({ rackingNumber }),
        },
      );
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { rackingNumber?: string };
        error?: string;
      };
      if (!r.ok || !j.success) {
        setSaveError(j.error || "Could not save. Please try again.");
        return;
      }
      const saved = j.data?.rackingNumber ?? "";
      setDoneMsg(saved ? `✓ Rack set to ${saved}` : "✓ Rack cleared");
      // Reflect the new rack in the summary header.
      setSummary((s) => (s ? { ...s, rackingNumber: saved } : s));
    } catch {
      setSaveError("Network error. Please check your connection and try again.");
    } finally {
      setArmed(false);
      setSaving(false);
    }
  }, [token, saving, summary, selected, armed]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#F0ECE9]">
      {/* Header — mirrors the DO/rack-scan dark bar. */}
      <header className="bg-[#1F1D1B] text-white">
        <div className="max-w-xl mx-auto px-4 py-5 flex items-center gap-3">
          <div className="h-9 w-9 rounded bg-[#6B5C32] flex items-center justify-center">
            <MapPin className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Assign Rack</h1>
            <p className="text-xs text-gray-400">HOOKKA INDUSTRIES</p>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-6 space-y-4 pb-12">
        {loading && (
          <div className="rounded-xl bg-white p-8 text-center shadow-sm border border-[#E6E0D9]">
            <div className="h-8 w-8 mx-auto rounded-full border-4 border-[#6B5C32] border-t-transparent animate-spin" />
            <p className="mt-3 text-sm text-gray-500">Looking up this piece...</p>
          </div>
        )}

        {!loading && loadError && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-[#E8B2A1]">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-[#9A3A2D] shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-[#9A3A2D]">QR not valid</p>
                <p className="text-sm text-[#9A3A2D] mt-1">{loadError}</p>
              </div>
            </div>
          </div>
        )}

        {!loading && summary && (
          <>
            {/* Piece header card — what is being racked (no prices). */}
            <div className="rounded-xl bg-[#1F1D1B] text-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-widest text-gray-400">
                Packing piece
              </p>
              <p className="text-xl font-bold mt-0.5 leading-snug">
                {summary.description || summary.poNo || "Item"}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-300">
                {summary.poNo && (
                  <div>
                    <span className="text-gray-500">PO</span>{" "}
                    <span className="font-semibold text-white">
                      {summary.poNo}
                    </span>
                  </div>
                )}
                {summary.salesOrderNo && (
                  <div>
                    <span className="text-gray-500">SO</span>{" "}
                    <span className="font-semibold text-white">
                      {summary.salesOrderNo}
                    </span>
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-400 mt-2">
                Current rack:{" "}
                <span className="font-semibold text-white">
                  {summary.rackingNumber || "— none —"}
                </span>
              </p>
            </div>

            {/* Success banner (last save). */}
            {doneMsg && (
              <div className="rounded-xl bg-[#4F7C3A] text-white p-5 text-center shadow-sm">
                <CheckCircle2 className="h-12 w-12 mx-auto" strokeWidth={2.5} />
                <p className="text-lg font-bold mt-2">{doneMsg}</p>
                <p className="text-sm opacity-90 mt-1">
                  You can change it again any time by re-scanning this sticker.
                </p>
              </div>
            )}

            {/* Rack picker + Save. */}
            <div className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-4 space-y-3">
              <label
                htmlFor="rack-select"
                className="block text-base font-bold text-[#1F1D1B]"
              >
                Which rack did this go onto?
              </label>
              <select
                id="rack-select"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setArmed(false);
                  setDoneMsg(null);
                }}
                className="w-full rounded-xl border border-[#E6E0D9] bg-white px-3 py-3 text-base text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="">— Choose a rack —</option>
                {summary.racks.map((r) => (
                  <option key={r.rack} value={r.rack}>
                    {r.rack}
                    {r.occupied ? " (occupied)" : ""}
                  </option>
                ))}
                {/* Clear is offered only when a rack is currently set. */}
                {summary.rackingNumber && (
                  <option value={CLEAR}>— Clear rack —</option>
                )}
              </select>

              {saveError && <p className="text-sm text-[#9A3A2D]">{saveError}</p>}

              <button
                type="button"
                disabled={selected === "" || saving}
                onClick={() => void handleSave()}
                className="w-full rounded-xl bg-[#9C6F1E] active:bg-[#835D19] text-white py-4 text-lg font-bold shadow-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {saving ? (
                  <span className="h-5 w-5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                ) : (
                  <PackageCheck className="h-5 w-5" />
                )}
                {armed
                  ? selected === CLEAR
                    ? "Tap again to confirm — Clear rack"
                    : `Tap again to confirm — Save to ${selected}`
                  : selected === CLEAR
                    ? "Clear rack"
                    : "Save rack"}
              </button>
              {armed && !saving && (
                <button
                  type="button"
                  onClick={() => setArmed(false)}
                  className="w-full rounded-xl bg-white border border-[#E6E0D9] text-gray-600 py-2.5 text-sm font-medium"
                >
                  Cancel
                </button>
              )}
            </div>

            <p className="text-[10px] text-center text-gray-400">
              For other changes, contact the Hookka office.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
