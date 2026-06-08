// ---------------------------------------------------------------------------
// MaintenanceConfigHistoryDialog
//
// Shared dialog component for the effective-dated Maintenance config history
// table (master + per-customer). Backed by:
//
//   GET    /api/maintenance-config/history?scope=...
//   DELETE /api/maintenance-config/changes/:id
//
// Used from:
//   * src/pages/products/index.tsx       (scope = "master")
//   * src/pages/customers.tsx            (scope = "customer:<id>")
//
// Companion modal `MaintenanceConfigSaveModal` collects effectiveFrom + notes
// before POSTing /api/maintenance-config/changes.
//
// Also exports `EffectiveDateConfirmModal`, a generic effective-date +
// notes confirmation dialog used by every catalog Save flow that wants the
// "applies to new SOs only, old ones keep their snapshot" banner. The plain
// banner copy lives in OLD_SO_SAFE_BANNER below so every modal uses the
// exact same wording.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { humanizeError } from "@/lib/humanize-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";

// Single source of truth for the "old SOs are unaffected" copy. Every
// catalog Save modal renders this so the operator hears the same promise
// in every workflow.
export const OLD_SO_SAFE_BANNER =
  "This change applies to NEW sales orders going forward. Existing SOs already saved keep their original prices and config — they are snapshotted at creation time.";

export type MaintenanceHistoryRow = {
  id: string;
  scope: string;
  config: unknown;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  isPending: boolean;
};

const todayIso = () => new Date().toISOString().slice(0, 10);

const daysUntil = (iso: string): number => {
  const t = new Date(todayIso() + "T00:00:00Z").getTime();
  const d = new Date(iso + "T00:00:00Z").getTime();
  return Math.round((d - t) / 86400000);
};

// ---------------------------------------------------------------------------
// MaintenanceConfigSaveModal — effective-date picker shown when the user
// clicks "Save" on a maintenance config edit. Confirming POSTs a new row
// to /api/maintenance-config/changes.
// ---------------------------------------------------------------------------
export function MaintenanceConfigSaveModal({
  open,
  scope,
  config,
  onClose,
  onSaved,
}: {
  open: boolean;
  scope: string;
  config: unknown;
  onClose: () => void;
  onSaved: (effectiveFrom: string) => void;
}) {
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  /* eslint-disable react-hooks/set-state-in-effect -- one-shot reset of modal form fields when it opens */
  useEffect(() => {
    if (!open) return;
    setEffectiveFrom(todayIso());
    setNotes("");
    setErrorMsg("");
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSubmit() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      setErrorMsg("Effective From date is required (YYYY-MM-DD).");
      return;
    }
    setSaving(true);
    setErrorMsg("");
    try {
      const res = await fetch("/api/maintenance-config/changes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, config, effectiveFrom, notes: notes || undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErrorMsg(
          humanizeError(
            { status: res.status, message: (j as { error?: string }).error },
            "Couldn't save. Please try again.",
          ),
        );
        return;
      }
      onSaved(effectiveFrom);
    } catch (e) {
      setErrorMsg(humanizeError(e, "Network problem — please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl flex flex-col w-[90vw] max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">
            Save maintenance config
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#E2DDD8]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div className="flex items-start gap-2 rounded border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-xs text-[#6B5C32]">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{OLD_SO_SAFE_BANNER}</span>
          </div>
          <p className="text-xs text-[#6B7280]">
            Choose when this snapshot becomes the live config. Today is the
            usual choice; future-dating queues a pending change.
          </p>
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Effective from *
            </label>
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              className="h-8"
            />
          </div>
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Notes
            </label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Q3 surcharge update"
              className="h-8"
            />
          </div>
          {errorMsg && (
            <p className="text-xs text-[#9A3A2D]">{errorMsg}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EffectiveDateConfirmModal — generic confirm-and-collect modal for any
// catalog Save flow that needs effectiveFrom + notes plus the standard
// "old SOs are unaffected" banner. The host owns the actual save call:
// onConfirm receives { effectiveFrom, notes } and resolves on success.
// Errors thrown from onConfirm bubble back into errorMsg in the modal.
//
// `irreversible` swaps the banner for a red "this can't be effective-dated"
// warning — used by flows where the backend mutates a shared field directly
// but old SOs are protected by an in-line snapshot at SO creation (e.g.
// fabric tier on fabric_tracking).
// ---------------------------------------------------------------------------
export function EffectiveDateConfirmModal({
  open,
  title,
  summary,
  ctaLabel = "Save",
  defaultEffectiveFrom,
  notesPlaceholder,
  irreversible = false,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  summary?: string;
  ctaLabel?: string;
  defaultEffectiveFrom?: string;
  notesPlaceholder?: string;
  irreversible?: boolean;
  onClose: () => void;
  onConfirm: (args: { effectiveFrom: string; notes: string }) => Promise<void> | void;
}) {
  const [effectiveFrom, setEffectiveFrom] = useState(
    defaultEffectiveFrom ?? todayIso(),
  );
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  /* eslint-disable react-hooks/set-state-in-effect -- one-shot reset of modal form fields when it opens */
  useEffect(() => {
    if (!open) return;
    setEffectiveFrom(defaultEffectiveFrom ?? todayIso());
    setNotes("");
    setErrorMsg("");
  }, [open, defaultEffectiveFrom]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, saving]);

  if (!open) return null;

  async function handleSubmit() {
    if (!irreversible) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
        setErrorMsg("Effective From date is required (YYYY-MM-DD).");
        return;
      }
    }
    setSaving(true);
    setErrorMsg("");
    try {
      await onConfirm({ effectiveFrom, notes });
    } catch (e) {
      setErrorMsg(humanizeError(e, "Couldn't save. Please try again."));
      setSaving(false);
      return;
    }
    setSaving(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => !saving && onClose()}
    >
      <div
        className="bg-white rounded-lg shadow-xl flex flex-col w-[90vw] max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">{title}</h2>
          <button
            onClick={() => !saving && onClose()}
            className="p-1 rounded hover:bg-[#E2DDD8]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-4 space-y-3">
          {irreversible ? (
            <div className="flex items-start gap-2 rounded border border-[#E8B2A1] bg-[#FBE0DC] px-3 py-2 text-xs text-[#9A3A2D]">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                This change is applied immediately and is not effective-dated.
                Existing sales orders are unaffected because their values were
                snapshotted at creation time, but the catalog itself flips to
                the new value right away.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-xs text-[#6B5C32]">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{OLD_SO_SAFE_BANNER}</span>
            </div>
          )}
          {summary && (
            <p className="text-xs text-[#6B7280]">{summary}</p>
          )}
          {!irreversible && (
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">
                Effective from *
              </label>
              <Input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className="h-8"
              />
              <p className="text-[10px] text-[#9CA3AF] mt-1">
                Today applies the change immediately. A future date queues
                it as Pending until that day.
              </p>
            </div>
          )}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Notes (optional)
            </label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={notesPlaceholder ?? "e.g. Q3 contract update"}
              className="h-8"
            />
          </div>
          {errorMsg && <p className="text-xs text-[#9A3A2D]">{errorMsg}</p>}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {ctaLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MaintenanceConfigHistoryDialog — full history listing for a given scope,
// with per-row Delete. The "active" row is the newest one with
// effectiveFrom <= today (matches the resolver in maintenance-config.ts).
// ---------------------------------------------------------------------------
export function MaintenanceConfigHistoryDialog({
  open,
  scope,
  title,
  onClose,
  onChanged,
}: {
  open: boolean;
  scope: string;
  title: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [history, setHistory] = useState<MaintenanceHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  async function loadHistory() {
    setLoading(true);
    setErrorMsg("");
    try {
      const res = await fetch(
        `/api/maintenance-config/history?scope=${encodeURIComponent(scope)}`,
      );
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: MaintenanceHistoryRow[];
        error?: string;
      };
      if (j.success && j.data) {
        setHistory(j.data);
      } else {
        setErrorMsg(j.error ?? "Failed to load history");
      }
    } catch (e) {
      setErrorMsg(humanizeError(e, "Network problem — please try again."));
    } finally {
      setLoading(false);
    }
  }

  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- loadHistory triggers setState as part of an async fetch on open/scope change */
  useEffect(() => {
    if (!open) return;
    void loadHistory();
  }, [open, scope]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // The "active" row mirrors the API resolver: newest where
  // effectiveFrom <= today. Past rows below it become "Past".
  const today = todayIso();
  let activeId: string | null = null;
  for (const r of history) {
    if (r.effectiveFrom <= today) {
      activeId = r.id;
      break;
    }
  }

  async function handleDelete(rowId: string) {
    if (!confirm("Delete this maintenance config history entry?")) return;
    try {
      const res = await fetch(
        `/api/maintenance-config/changes/${encodeURIComponent(rowId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(
          humanizeError(
            { status: res.status, message: (j as { error?: string }).error },
            "Couldn't delete. Please try again.",
          ),
        );
        return;
      }
      await loadHistory();
      onChanged?.();
    } catch (e) {
      alert(humanizeError(e, "Network problem — please try again."));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl flex flex-col w-[80vw] h-[80vh] max-w-3xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-semibold text-[#1F1D1B]">{title}</h2>
            <p className="text-xs text-[#6B7280] mt-0.5">
              Effective-dated history. Newest row whose date is on or before
              today is the live config.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#E2DDD8]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-[#6B5C32]" />
            </div>
          ) : errorMsg ? (
            <p className="text-sm text-[#9A3A2D]">{errorMsg}</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-[#9CA3AF] py-6 text-center">
              No maintenance config history yet.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[#6B7280]">
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-2 px-2">Effective from</th>
                  <th className="text-left py-2 px-2">Notes</th>
                  <th className="text-left py-2 px-2">Created</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const status: "Pending" | "Active" | "Past" = h.isPending
                    ? "Pending"
                    : h.id === activeId
                      ? "Active"
                      : "Past";
                  const days = daysUntil(h.effectiveFrom);
                  return (
                    <tr key={h.id} className="border-b border-[#F0EEEA]">
                      <td className="py-1.5 px-2 doc-number">
                        {h.effectiveFrom}
                      </td>
                      <td className="py-1.5 px-2 text-[#6B7280]">
                        {h.notes || "—"}
                      </td>
                      <td className="py-1.5 px-2 text-[#9CA3AF] tabular-nums">
                        {h.createdAt?.slice(0, 10) ?? "—"}
                      </td>
                      <td className="py-1.5 px-2">
                        {status === "Pending" ? (
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                              days <= 3
                                ? "bg-[#FBE0DC] text-[#9A3A2D] border-[#E8B2A1]"
                                : days <= 14
                                  ? "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]"
                                  : "bg-[#F4F0E8] text-[#6B5C32] border-[#D4CCB4]"
                            }`}
                            title={`Becomes effective on ${h.effectiveFrom}`}
                          >
                            Pending · {days}d
                          </span>
                        ) : status === "Active" ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#E0EDF0] text-[#3E6570] border border-[#B8D0D5]">
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#F4F0E8] text-[#6B7280] border border-[#D4CCB4]">
                            Past
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 px-2 text-right">
                        <button
                          onClick={() => handleDelete(h.id)}
                          className="p-1 rounded text-[#9A3A2D] hover:bg-[#FBE0DC]"
                          title="Delete this entry"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
