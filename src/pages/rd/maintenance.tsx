// ---------------------------------------------------------------------------
// R&D Maintenance — manage R&D team members (separate from /workers).
//
// Two sections side-by-side: Full-time (hourly rate) and Part-time (monthly
// fixed cost). Each member has create / edit / soft-delete (archive) buttons.
// Soft-deleted (active=false) members are hidden by default; toggle to show.
// ---------------------------------------------------------------------------
import { useState, useCallback, useMemo } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatCurrency } from "@/lib/utils";
import { Plus, Pencil, Archive, RotateCcw, X, Users, Clock, Wallet } from "lucide-react";
import type { RDTeamMember } from "@/types";
import { moneyFieldToRinggit, firstMoneyFieldError } from "@/lib/money-field";

type EmploymentType = "FULL_TIME" | "PART_TIME";

type EditDraft = {
  id?: string;
  name: string;
  employmentType: EmploymentType;
  hourlyRateRM: string;       // RM string for the form (sen on save)
  monthlyFixedCostRM: string; // RM string for the form (sen on save)
  notes: string;
};

const labelClass = "block text-xs font-semibold text-gray-500 mb-1";
const inputClass =
  "w-full rounded-lg border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]";
const selectClass = inputClass;

function ModalOverlay({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    // Backdrop click does NOT close the modal — strays clicks should not
    // wipe a half-typed form. Use the X icon to dismiss.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="relative w-full max-w-lg rounded-xl bg-white border border-[#E2DDD8] shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[#E2DDD8] px-6 py-4">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

function blankDraft(employmentType: EmploymentType): EditDraft {
  return {
    name: "",
    employmentType,
    hourlyRateRM: "",
    monthlyFixedCostRM: "",
    notes: "",
  };
}

function memberToDraft(m: RDTeamMember): EditDraft {
  return {
    id: m.id,
    name: m.name,
    employmentType: m.employmentType,
    hourlyRateRM:
      typeof m.hourlyRateSen === "number"
        ? (m.hourlyRateSen / 100).toFixed(2)
        : "",
    monthlyFixedCostRM:
      typeof m.monthlyFixedCostSen === "number"
        ? (m.monthlyFixedCostSen / 100).toFixed(2)
        : "",
    notes: m.notes ?? "",
  };
}

export default function RDMaintenancePage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: resp, loading, refresh } = useCachedJson<{
    data?: RDTeamMember[];
  }>("/api/rd-team-members");

  const members: RDTeamMember[] = useMemo(() => resp?.data ?? [], [resp]);
  const fullTime = useMemo(
    () =>
      members.filter(
        (m) => m.employmentType === "FULL_TIME" && (showInactive || m.active),
      ),
    [members, showInactive],
  );
  const partTime = useMemo(
    () =>
      members.filter(
        (m) => m.employmentType === "PART_TIME" && (showInactive || m.active),
      ),
    [members, showInactive],
  );

  const reload = useCallback(() => {
    invalidateCachePrefix("/api/rd-team-members");
    refresh();
  }, [refresh]);

  const handleSave = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      toast.error("Name is required");
      return;
    }
    let hourlyRateSen: number | null = null;
    let monthlyFixedCostSen: number | null = null;
    // BUG-2026-08-13-095 - a monthly cost typed "3,500" became RM 3.00 and
    // every R&D labour costing built on it was wrong by three orders of
    // magnitude. One parser; unreadable refuses by name.
    if (editing.employmentType === "FULL_TIME") {
      const err = firstMoneyFieldError([{ label: "Hourly Rate (RM)", value: editing.hourlyRateRM }]);
      if (err) { toast.error(err); return; }
      const rm = moneyFieldToRinggit(editing.hourlyRateRM) as number;
      if (rm < 0) {
        toast.error("Hourly Rate must be a non-negative number");
        return;
      }
      hourlyRateSen = Math.round(rm * 100);
    } else {
      const err = firstMoneyFieldError([{ label: "Monthly Fixed Cost (RM)", value: editing.monthlyFixedCostRM }]);
      if (err) { toast.error(err); return; }
      const rm = moneyFieldToRinggit(editing.monthlyFixedCostRM) as number;
      if (rm < 0) {
        toast.error("Monthly Fixed Cost must be a non-negative number");
        return;
      }
      monthlyFixedCostSen = Math.round(rm * 100);
    }

    setSaving(true);
    try {
      const url = editing.id
        ? `/api/rd-team-members/${editing.id}`
        : "/api/rd-team-members";
      const method = editing.id ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          employmentType: editing.employmentType,
          hourlyRateSen,
          monthlyFixedCostSen,
          notes: editing.notes.trim(),
        }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      toast.success(editing.id ? "Member updated" : "Member added");
      setEditing(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (m: RDTeamMember) => {
    if (!(await confirm({ title: "Archive member?", message: `Archive ${m.name}? Their logged hours stay attributable.`, danger: true }))) return;
    try {
      const res = await fetch(`/api/rd-team-members/${m.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) throw new Error(j.error ?? `HTTP ${res.status}`);
      toast.success("Member archived");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Archive failed");
    }
  };

  const handleRestore = async (m: RDTeamMember) => {
    try {
      const res = await fetch(`/api/rd-team-members/${m.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: true }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) throw new Error(j.error ?? `HTTP ${res.status}`);
      toast.success("Member restored");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restore failed");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">R&D Maintenance</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage R&D team members and their pay structure. Logged labour hours
            on R&D projects auto-compute labour cost from these rates.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-2 text-xs text-gray-500">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show archived
          </label>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <MemberSection
            title="Full-time"
            description="Wage per hour. Labour hours x hourly rate = auto labour cost."
            icon={<Clock className="h-4 w-4 text-gray-400" />}
            members={fullTime}
            onAdd={() => setEditing(blankDraft("FULL_TIME"))}
            onEdit={(m) => setEditing(memberToDraft(m))}
            onArchive={handleArchive}
            onRestore={handleRestore}
          />
          <MemberSection
            title="Part-time"
            description="Flat monthly fixed cost. Counted as a separate overhead line per project."
            icon={<Wallet className="h-4 w-4 text-gray-400" />}
            members={partTime}
            onAdd={() => setEditing(blankDraft("PART_TIME"))}
            onEdit={(m) => setEditing(memberToDraft(m))}
            onArchive={handleArchive}
            onRestore={handleRestore}
          />
        </div>
      )}

      <ModalOverlay
        open={!!editing}
        onClose={() => (saving ? null : setEditing(null))}
        title={editing?.id ? "Edit Team Member" : "Add Team Member"}
      >
        {editing && (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Name</label>
              <input
                className={inputClass}
                value={editing.name}
                onChange={(e) =>
                  setEditing((d) => (d ? { ...d, name: e.target.value } : d))
                }
                placeholder="e.g. Ahmad Razif"
              />
            </div>
            <div>
              <label className={labelClass}>Employment Type</label>
              <select
                className={selectClass}
                value={editing.employmentType}
                onChange={(e) =>
                  setEditing((d) =>
                    d
                      ? {
                          ...d,
                          employmentType: e.target.value as EmploymentType,
                        }
                      : d,
                  )
                }
              >
                <option value="FULL_TIME">Full-time</option>
                <option value="PART_TIME">Part-time</option>
              </select>
            </div>
            {editing.employmentType === "FULL_TIME" ? (
              <div>
                <label className={labelClass}>Hourly Rate (RM/hr)</label>
                <input
                  type="number" onFocus={(e) => e.currentTarget.select()}
                  inputMode="decimal"
                  min={0}
                  step={0.01}
                  className={inputClass}
                  value={editing.hourlyRateRM}
                  onChange={(e) =>
                    setEditing((d) =>
                      d ? { ...d, hourlyRateRM: e.target.value } : d,
                    )
                  }
                  placeholder="15.00"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Wage per hour. Labour cost on a project = total logged hours x
                  this rate.
                </p>
              </div>
            ) : (
              <div>
                <label className={labelClass}>Monthly Fixed Cost (RM)</label>
                <input
                  type="number" onFocus={(e) => e.currentTarget.select()}
                  inputMode="decimal"
                  min={0}
                  step={0.01}
                  className={inputClass}
                  value={editing.monthlyFixedCostRM}
                  onChange={(e) =>
                    setEditing((d) =>
                      d ? { ...d, monthlyFixedCostRM: e.target.value } : d,
                    )
                  }
                  placeholder="500.00"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Flat retainer cost. Surfaced as a separate overhead line on
                  any R&D project this person logs hours on.
                </p>
              </div>
            )}
            <div>
              <label className={labelClass}>Notes (optional)</label>
              <textarea
                className={`${inputClass} resize-none`}
                rows={3}
                value={editing.notes}
                onChange={(e) =>
                  setEditing((d) =>
                    d ? { ...d, notes: e.target.value } : d,
                  )
                }
                placeholder="Skills, contact info, schedule..."
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : editing.id ? "Save" : "Add Member"}
              </Button>
            </div>
          </div>
        )}
      </ModalOverlay>
    </div>
  );
}

function MemberSection({
  title,
  description,
  icon,
  members,
  onAdd,
  onEdit,
  onArchive,
  onRestore,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  members: RDTeamMember[];
  onAdd: () => void;
  onEdit: (m: RDTeamMember) => void;
  onArchive: (m: RDTeamMember) => void;
  onRestore: (m: RDTeamMember) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between w-full">
          <CardTitle className="text-sm flex items-center gap-2">
            {icon}
            {title}
            <span className="text-xs font-normal text-gray-400">
              ({members.length})
            </span>
          </CardTitle>
          <Button variant="outline" size="sm" onClick={onAdd} className="gap-1.5 text-xs">
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
        <p className="text-xs text-gray-500 mt-1">{description}</p>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <div className="text-center py-8 text-gray-300 text-sm">
            <Users className="h-6 w-6 mx-auto mb-2" />
            No members yet.
          </div>
        ) : (
          <div className="divide-y divide-[#E2DDD8]">
            {members.map((m) => {
              const rateLabel =
                m.employmentType === "FULL_TIME"
                  ? typeof m.hourlyRateSen === "number"
                    ? `${formatCurrency(m.hourlyRateSen)}/hr`
                    : "—"
                  : typeof m.monthlyFixedCostSen === "number"
                    ? `${formatCurrency(m.monthlyFixedCostSen)}/mo`
                    : "—";
              return (
                <div
                  key={m.id}
                  className={`flex items-center justify-between py-3 ${
                    m.active ? "" : "opacity-60"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-[#1F1D1B] truncate">
                        {m.name}
                      </span>
                      {!m.active && (
                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">
                          Archived
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      {rateLabel}
                      {m.notes ? ` · ${m.notes}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => onEdit(m)}
                      className="rounded-lg border border-[#E2DDD8] p-1.5 text-gray-500 hover:text-[#6B5C32] hover:bg-[#F0ECE9]"
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {m.active ? (
                      <button
                        onClick={() => onArchive(m)}
                        className="rounded-lg border border-[#E2DDD8] p-1.5 text-gray-500 hover:text-red-500 hover:bg-red-50"
                        title="Archive"
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => onRestore(m)}
                        className="rounded-lg border border-[#E2DDD8] p-1.5 text-gray-500 hover:text-[#6B5C32] hover:bg-[#F0ECE9]"
                        title="Restore"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
