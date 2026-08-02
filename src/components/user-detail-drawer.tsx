// ---------------------------------------------------------------------------
// user-detail-drawer.tsx — edit a person in a side panel, like Employee Master.
//
// Owner 2026-08-02:「我要做到像 employee master 这样子,在旁边去做 maintenance,
// 去 add、去 save,一模一样…全部功能应该都要有:删除、disable、edit」.
//
// What it replaces
// ----------------
// Department and Position could only be set through the "Edit details" MODAL,
// which is gated on the person having an @hookka.com mailbox — so seven of the
// ten accounts had no way to be placed on the org chart at all. Worse, that
// modal wrote to the ALIAS row while the grid and the chart read the USER row,
// which is why the modal showed "Finance" and the grid showed "—".
//
// This edits the USER, through PUT /api/users/:id, which already accepts
// department / position / reportsTo / role / isActive and leaves any field
// absent from the body untouched. No mailbox required.
//
// Guardrails kept from the page it came from
// ------------------------------------------
//   * the server refuses to disable or demote the LAST active Super Admin, and
//     its wording is shown verbatim — "You can't disable the last active Super
//     Admin" is actionable in a way a generic failure is not
//   * you cannot disable or delete YOURSELF; the buttons are not offered
//   * delete asks first, by name, and says it cannot be undone
//   * Save sends only what changed, so a department edit can never silently
//     rewrite a role
// ---------------------------------------------------------------------------
import { useState } from "react";
import { X, Trash2, Ban, CheckCircle2, Save } from "lucide-react";

export type DrawerUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  department: string;
  position: string;
  reportsTo: string;
};

type Props = {
  user: DrawerUser;
  /**
   * The person's REAL upline key from org_reporting ("user:<id>" / "worker:<id>"),
   * or null. `user.reportsTo` is the legacy `users.reports_to` column and is
   * blank for everyone whose line was set through the org chart — which is
   * everyone — so showing it made the drawer say "no manager (top)" for people
   * the chart draws a line for.
   */
  currentManagerKey?: string | null;
  /** Everyone who could be an upline — excludes the person themselves. */
  uplineOptions: { id: string; label: string }[];
  departments: readonly string[];
  roleOptions: { value: string; label: string }[];
  /** The signed-in user's id — you may not disable or delete yourself. */
  currentUserId: string;
  canManage: boolean;
  onClose: () => void;
  /** Called after any successful write so the grid can refetch. */
  onSaved: () => void;
};

export function UserDetailDrawer({
  user,
  currentManagerKey,
  uplineOptions,
  departments,
  roleOptions,
  currentUserId,
  canManage,
  onClose,
  onSaved,
}: Props) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [department, setDepartment] = useState(user.department);
  const [position, setPosition] = useState(user.position);
  const [role, setRole] = useState(user.role);
  // Seeded from the org_reporting edge, not the legacy column.
  const [reportsTo, setReportsTo] = useState(currentManagerKey ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // No re-seed effect: the caller gives this component a `key`, so pointing the
  // drawer at a different person REMOUNTS it and every field starts from that
  // person's data. An effect that setState'd on a prop change was a cascading
  // render, and the fix for that is not to suppress the rule.

  const isSelf = user.id === currentUserId;

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || j.success === false) {
        // The server's wording is the actionable one — "You can't disable the
        // last active Super Admin" beats "Save failed".
        setError(j.error || `Save failed (HTTP ${res.status})`);
        return false;
      }
      setOk(done);
      onSaved();
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    // Only what CHANGED. A department edit must never silently rewrite a role.
    const body: Record<string, unknown> = {};
    if (displayName !== user.displayName) body.displayName = displayName.trim();
    if (department !== user.department) body.department = department;
    if (position !== user.position) body.position = position.trim();
    if (role !== user.role) body.role = role;
    const uplineChanged = reportsTo !== (currentManagerKey ?? "");
    if (Object.keys(body).length === 0 && !uplineChanged) {
      setOk("No changes to save");
      return;
    }
    if (Object.keys(body).length > 0) {
      const okSave = await send(body, "Saved");
      if (!okSave) return;
    }
    if (uplineChanged) {
      // The reporting line lives in org_reporting, keyed (source, id), because
      // it has to be able to cross `users` and `workers`. Writing
      // users.reports_to would put it somewhere the chart does not read.
      setBusy(true);
      try {
        const res = await fetch("/api/org-chart/reporting", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personKey: `user:${user.id}`, managerKey: reportsTo }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
        };
        if (!res.ok || j.success === false) {
          // "That reporting line would create a loop." is the server's, and it
          // is the useful sentence.
          setError(j.error || `Could not save the reporting line (HTTP ${res.status})`);
          return;
        }
        setOk("Saved");
        onSaved();
      } catch {
        setError("Could not reach the server.");
      } finally {
        setBusy(false);
      }
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE",
      });
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || j.success === false) {
        setError(j.error || `Delete failed (HTTP ${res.status})`);
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const field = "h-9 w-full rounded-md border border-[#E2DDD8] bg-white px-2 text-sm";
  const label =
    "block text-[11px] font-medium uppercase tracking-wide text-[#8A8577] mb-1";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="flex-1 bg-black/20" onClick={onClose} aria-hidden />
      <div className="flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-[#E2DDD8] px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-[#1F1D1B]">
              {user.displayName || user.email}
            </div>
            <div className="truncate text-xs text-[#8A8577]">
              {user.email}
              {user.isActive ? "" : " · Disabled"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#9CA3AF] hover:text-[#1F1D1B]"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {error && (
            <div className="rounded-md border border-[#E8AFA4] bg-[#FBE9E5] px-3 py-2 text-[12px] text-[#7E251A]">
              {error}
            </div>
          )}
          {ok && (
            <div className="rounded-md border border-[#CFE0DB] bg-[#F1F7F5] px-3 py-2 text-[12px] text-[#2F6E62]">
              {ok}
            </div>
          )}

          <div>
            <label className={label} htmlFor="ud-name">
              Name
            </label>
            <input
              id="ud-name"
              className={field}
              value={displayName}
              disabled={!canManage || busy}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div>
            <label className={label} htmlFor="ud-dept">
              Department
            </label>
            {/* On the USER row — no mailbox required. This is the whole point:
                seven of ten accounts had no alias and so could never be placed. */}
            <select
              id="ud-dept"
              className={field}
              value={department}
              disabled={!canManage || busy}
              onChange={(e) => setDepartment(e.target.value)}
            >
              <option value="">— none —</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={label} htmlFor="ud-pos">
              Position
            </label>
            <input
              id="ud-pos"
              className={field}
              placeholder="e.g. Production Head"
              value={position}
              disabled={!canManage || busy}
              onChange={(e) => setPosition(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-[#9CA3AF]">
              A title containing Head or Manager sorts to the top of its
              department on the org chart.
            </p>
          </div>

          <div>
            <label className={label} htmlFor="ud-upline">
              Reports to
            </label>
            <select
              id="ud-upline"
              className={field}
              value={reportsTo}
              disabled={!canManage || busy}
              onChange={(e) => setReportsTo(e.target.value)}
            >
              <option value="">— no manager (top) —</option>
              {uplineOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={label} htmlFor="ud-role">
              Role
            </label>
            <select
              id="ud-role"
              className={field}
              value={role}
              disabled={!canManage || busy}
              onChange={(e) => setRole(e.target.value)}
            >
              {roleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {canManage && (
          <div className="space-y-2 border-t border-[#E2DDD8] px-5 py-4">
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#6B5C32] text-sm font-semibold text-white disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {busy ? "Saving…" : "Save"}
            </button>

            <div className="flex gap-2">
              {/* You may not lock yourself out, so the action is not offered. */}
              {!isSelf && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    send(
                      { isActive: !user.isActive },
                      user.isActive ? "Account disabled" : "Account enabled",
                    )
                  }
                  className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-[#E2DDD8] text-[13px] text-[#6B7280] hover:text-[#1F1D1B] disabled:opacity-50"
                >
                  {user.isActive ? (
                    <>
                      <Ban className="h-4 w-4" /> Disable
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" /> Enable
                    </>
                  )}
                </button>
              )}
              {!isSelf && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                  className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-[#E8AFA4] text-[13px] text-[#9A3A2D] hover:bg-[#FBE9E5] disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </button>
              )}
            </div>

            {confirmDelete && (
              // By name, and it says what cannot be undone. A delete confirmed
              // by a bare "Are you sure?" is the one people click through.
              <div className="rounded-md border border-[#E8AFA4] bg-[#FBE9E5] p-3 text-[12px] text-[#7E251A]">
                <div className="mb-2">
                  Delete <strong>{user.displayName || user.email}</strong>? Their
                  account and access are removed. This cannot be undone.
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={remove}
                    disabled={busy}
                    className="h-8 flex-1 rounded-md bg-[#9A3A2D] text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    {busy ? "Deleting…" : "Yes, delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="h-8 flex-1 rounded-md border border-[#E2DDD8] bg-white text-[13px] text-[#6B7280]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
