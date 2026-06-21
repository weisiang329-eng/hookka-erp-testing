// ---------------------------------------------------------------------------
// LeadTimeHistoryDialog
//
// Schedule + view effective-dated changes for production lead times and the
// Hookka Expected DD buffer. Mirrors MasterPriceHistoryDialog exactly:
//   * top section: "New scheduled change" form (kind/category/dept selector,
//     days, effective_from with past dates allowed, notes, ➕ Schedule)
//   * bottom section: full history table (Pending/Active/Past with countdown
//     coloring, 🗑 delete button)
//   * ESC closes; click-outside closes
//
// Backend endpoints (production-leadtimes.ts, migration 0105):
//   GET    /api/production/leadtimes/history
//   POST   /api/production/leadtimes/schedule
//   DELETE /api/production/leadtimes/history/:id
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { humanizeError } from "@/lib/humanize-error";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Trash2, X } from "lucide-react";

type LeadTimeHistoryRow = {
  id: string;
  kind: "leadTime";
  category: string;
  deptCode: string;
  days: number;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  status: "Pending" | "Active" | "Past";
};

type HookkaBufferHistoryRow = {
  id: string;
  kind: "hookkaBuffer";
  category: string;
  days: number;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  status: "Pending" | "Active" | "Past";
};

type AnyHistoryRow = LeadTimeHistoryRow | HookkaBufferHistoryRow;

const todayIso = () => new Date().toISOString().slice(0, 10);

const daysUntil = (iso: string): number => {
  const t = new Date(todayIso() + "T00:00:00Z").getTime();
  const d = new Date(iso + "T00:00:00Z").getTime();
  return Math.round((d - t) / 86400000);
};

const DEPT_OPTIONS = [
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
] as const;

export function LeadTimeHistoryDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { confirm } = useConfirm();
  const [rows, setRows] = useState<AnyHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form fields. Defaults seeded so a typical "schedule a change" workflow
  // is one date-pick + days-input away.
  const [kind, setKind] = useState<"leadTime" | "hookkaBuffer">("leadTime");
  const [category, setCategory] = useState<"BEDFRAME" | "SOFA">("BEDFRAME");
  const [deptCode, setDeptCode] = useState<(typeof DEPT_OPTIONS)[number]>("FAB_CUT");
  const [days, setDays] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [notes, setNotes] = useState("");

  // Reset the form on open. Form state is user-editable while dialog is open
  // so we can't derive these from props — one-shot sync on open is simplest.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setKind("leadTime");
    setCategory("BEDFRAME");
    setDeptCode("FAB_CUT");
    setDays("");
    setEffectiveFrom(todayIso());
    setNotes("");
    void loadHistory();
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ESC closes the dialog so it never traps the user.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function loadHistory() {
    setLoading(true);
    try {
      const res = await fetch("/api/production/leadtimes/history");
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { leadTimes?: LeadTimeHistoryRow[]; hookkaBuffer?: HookkaBufferHistoryRow[] };
      };
      const lt = j.data?.leadTimes ?? [];
      const buf = j.data?.hookkaBuffer ?? [];
      // Merge + re-sort by effectiveFrom DESC, createdAt DESC so the table
      // displays newest first regardless of which table the row came from.
      const merged: AnyHistoryRow[] = [...lt, ...buf];
      merged.sort((a, b) => {
        if (a.effectiveFrom !== b.effectiveFrom) {
          return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
        }
        return a.createdAt < b.createdAt ? 1 : -1;
      });
      setRows(j.success ? merged : []);
    } finally {
      setLoading(false);
    }
  }

  async function saveScheduled() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      alert("Effective From date is required (YYYY-MM-DD).");
      return;
    }
    const n = Number(days);
    if (!Number.isFinite(n) || n < 0) {
      alert("Days must be a non-negative number.");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        kind,
        category,
        days: Math.round(n),
        effectiveFrom,
        notes: notes || null,
      };
      if (kind === "leadTime") body.deptCode = deptCode;
      const res = await fetch("/api/production/leadtimes/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(
          humanizeError(
            { status: res.status, message: (j as { error?: string }).error },
            "Couldn't schedule the change. Please try again.",
          ),
        );
        return;
      }
      // Reset just the editable fields (not category/dept/kind — likely the
      // user is queuing several changes in a row for the same dept).
      setDays("");
      setNotes("");
      await loadHistory();
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function deleteRow(rowId: string) {
    if (!(await confirm({ title: "Delete history entry", message: "Delete this history entry?", danger: true }))) return;
    const res = await fetch(`/api/production/leadtimes/history/${rowId}`, {
      method: "DELETE",
    });
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
    onSaved();
  }

  const labelFor = (r: AnyHistoryRow): string => {
    if (r.kind === "hookkaBuffer") return `${r.category} · Hookka DD buffer`;
    return `${r.category} · ${r.deptCode}`;
  };

  const pendingCount = useMemo(
    () => rows.filter((r) => r.status === "Pending").length,
    [rows],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl flex flex-col w-[80vw] h-[85vh] max-w-4xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-semibold text-[#1F1D1B]">
              Schedule lead-time change
            </h2>
            <p className="text-xs text-[#6B7280] mt-0.5">
              Stage future-dated changes for any department lead time or the
              Hookka Expected DD buffer. SO confirms after each effective date
              automatically pick up the new value.
              {pendingCount > 0 && (
                <span className="ml-2 text-[#B8601A] font-medium">
                  {pendingCount} pending
                </span>
              )}
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

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* ===== New scheduled change ===== */}
          <section>
            <h3 className="text-sm font-medium text-[#1F1D1B] mb-3">
              New scheduled change
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">Kind</label>
                <select
                  value={kind}
                  onChange={(e) =>
                    setKind(e.target.value === "hookkaBuffer" ? "hookkaBuffer" : "leadTime")
                  }
                  className="h-8 w-full px-2 text-sm border border-[#E2DDD8] rounded bg-white"
                >
                  <option value="leadTime">Department lead time</option>
                  <option value="hookkaBuffer">Hookka DD buffer</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">Category</label>
                <select
                  value={category}
                  onChange={(e) =>
                    setCategory(e.target.value === "SOFA" ? "SOFA" : "BEDFRAME")
                  }
                  className="h-8 w-full px-2 text-sm border border-[#E2DDD8] rounded bg-white"
                >
                  <option value="BEDFRAME">BEDFRAME</option>
                  <option value="SOFA">SOFA</option>
                </select>
              </div>
              {kind === "leadTime" ? (
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">
                    Department
                  </label>
                  <select
                    value={deptCode}
                    onChange={(e) =>
                      setDeptCode(e.target.value as (typeof DEPT_OPTIONS)[number])
                    }
                    className="h-8 w-full px-2 text-sm border border-[#E2DDD8] rounded bg-white"
                  >
                    {DEPT_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">
                    Target
                  </label>
                  <Input
                    value="Hookka Expected DD buffer"
                    disabled
                    className="h-8 bg-[#F4F0E8] text-[#6B7280]"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">Days *</label>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-8 text-right"
                  placeholder="e.g. 7"
                />
              </div>
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
                  Past dates allowed — backfill or back-date a correction here.
                </p>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">Notes</label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Q3 staffing change"
                  className="h-8"
                />
              </div>
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                size="sm"
                onClick={saveScheduled}
                disabled={saving}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4 mr-1" />
                )}
                Schedule
              </Button>
            </div>
          </section>

          {/* ===== History table ===== */}
          <section>
            <h3 className="text-sm font-medium text-[#1F1D1B] mb-3">
              History ({rows.length})
            </h3>
            {loading ? (
              <p className="text-sm text-[#9CA3AF] py-6 text-center">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-[#9CA3AF] py-6 text-center">
                No scheduled or past changes yet. The current effective values
                come from the inline /planning Save Lead Times form.
              </p>
            ) : (<div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[#6B7280]">
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 px-2">Effective from</th>
                    <th className="text-left py-2 px-2">Target</th>
                    <th className="text-right py-2 px-2">Days</th>
                    <th className="text-left py-2 px-2">Notes</th>
                    <th className="text-right py-2 px-2">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const pending = r.status === "Pending";
                    const days = daysUntil(r.effectiveFrom);
                    return (
                      <tr key={r.id} className="border-b border-[#F0EEEA]">
                        <td className="py-1.5 px-2 doc-number">
                          {r.effectiveFrom}
                        </td>
                        <td className="py-1.5 px-2 text-[#1F1D1B]">
                          {labelFor(r)}
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums">
                          {r.days}
                        </td>
                        <td className="py-1.5 px-2 text-[#6B7280]">
                          {r.notes || "—"}
                        </td>
                        <td className="py-1.5 px-2 text-right">
                          {pending ? (
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                                days <= 3
                                  ? "bg-[#FBE0DC] text-[#9A3A2D] border-[#E8B2A1]"
                                  : days <= 14
                                    ? "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]"
                                    : "bg-[#F4F0E8] text-[#6B5C32] border-[#D4CCB4]"
                              }`}
                              title={`Becomes effective on ${r.effectiveFrom}`}
                            >
                              Pending · {days}d
                            </span>
                          ) : r.status === "Active" ? (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#E0EDF0] text-[#3E6570] border border-[#B8D0D5]">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#F4F0E8] text-[#9CA3AF] border border-[#E2DDD8]">
                              Past
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right">
                          <button
                            onClick={() => deleteRow(r.id)}
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
</div>)}
          </section>
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
