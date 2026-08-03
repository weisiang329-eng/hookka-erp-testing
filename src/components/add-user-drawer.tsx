// ---------------------------------------------------------------------------
// add-user-drawer.tsx — create a working account and hand over the credential.
//
// Owner 2026-08-02:「我给他们密码、账号,他们都可以直接登录进来,然后用的是我们的
// email,这样子他就不会影响到他自己的 email」.
//
// That is a normal way to run an ERP on company mailboxes, and better than the
// invite flow for this shop: the staff need no Gmail of their own, the account
// and the mailbox both stay with the company when someone leaves, and nobody
// waits on an email that may land in spam.
//
// The invite flow STAYS. It is still the right tool when the person has their
// own company mailbox and can accept for themselves.
//
// WHY THE FIRST LOGIN FORCES A CHANGE
// An admin-chosen password is a handover credential, not the person's password.
// While it stands, the admin knows it too — so nothing that account does can be
// attributed to that person, because the admin could equally have done it. The
// tick is on by default and the reason is written on screen, not buried here.
//
// The password is typed by the OPERATOR into this form and posted straight to
// the server. It is never generated, suggested, stored or echoed back.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { X, UserPlus, Eye, EyeOff } from "lucide-react";

type Props = {
  departments: readonly string[];
  roleOptions: { value: string; label: string }[];
  onClose: () => void;
  /** Called after a successful create so the grid and the chart refetch. */
  onCreated: () => void;
};

export function AddUserDrawer({ departments, roleOptions, onClose, onCreated }: Props) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [department, setDepartment] = useState("");
  const [position, setPosition] = useState("");
  const [role, setRole] = useState(roleOptions[0]?.value ?? "STAFF");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mustChange, setMustChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Mirrors the server's own floor (users.ts). Checked here too so the operator
  // is told before the round trip, not after.
  const tooShort = password.length > 0 && password.length < 6;
  const canSubmit =
    !busy && email.trim().includes("@") && password.length >= 6;

  async function create() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          displayName: displayName.trim(),
          role,
          department,
          position: position.trim(),
          mustChangePassword: mustChange,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || j.success === false) {
        // The server's wording is the actionable one — "Email already
        // registered" tells the operator what to do next.
        setError(j.error || `Could not create the account (HTTP ${res.status})`);
        return;
      }
      setOk(`${email.trim()} can log in now.`);
      // Clear the credential from the form the moment it is no longer needed.
      setPassword("");
      setEmail("");
      setDisplayName("");
      setPosition("");
      onCreated();
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
          <div>
            <div className="flex items-center gap-2 text-base font-semibold text-[#1F1D1B]">
              <UserPlus className="h-5 w-5 text-[#6B5C32]" />
              Add user
            </div>
            <div className="text-xs text-[#8A8577]">
              Creates a working account straight away — no invite email.
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
            <label className={label} htmlFor="au-email">
              Email
            </label>
            <input
              id="au-email"
              className={field}
              placeholder="chee@hookka.com"
              autoComplete="off"
              value={email}
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-[#9CA3AF]">
              A company address keeps the account with the company when someone
              leaves.
            </p>
          </div>

          <div>
            <label className={label} htmlFor="au-name">
              Name
            </label>
            <input
              id="au-name"
              className={field}
              value={displayName}
              disabled={busy}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div>
            <label className={label} htmlFor="au-dept">
              Department
            </label>
            <select
              id="au-dept"
              className={field}
              value={department}
              disabled={busy}
              onChange={(e) => setDepartment(e.target.value)}
            >
              <option value="">— none —</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-[#9CA3AF]">
              Set it now and they appear on the org chart immediately instead of
              sitting in Unassigned.
            </p>
          </div>

          <div>
            <label className={label} htmlFor="au-pos">
              Position
            </label>
            <input
              id="au-pos"
              className={field}
              placeholder="e.g. R&D Engineer"
              value={position}
              disabled={busy}
              onChange={(e) => setPosition(e.target.value)}
            />
          </div>

          <div>
            <label className={label} htmlFor="au-role">
              Role
            </label>
            <select
              id="au-role"
              className={field}
              value={role}
              disabled={busy}
              onChange={(e) => setRole(e.target.value)}
            >
              {roleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={label} htmlFor="au-pw">
              Temporary password
            </label>
            <div className="relative">
              <input
                id="au-pw"
                className={`${field} pr-9`}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
              {/* Visible on demand: the operator has to read this back to the
                  person, and a masked field they cannot check is how the wrong
                  password gets handed over. */}
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#9CA3AF] hover:text-[#1F1D1B]"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {tooShort && (
              <p className="mt-1 text-[11px] text-[#9A3A2D]">
                At least 6 characters.
              </p>
            )}
          </div>

          <label className="flex items-start gap-2 rounded-md border border-[#E6C490] bg-[#FBF1DC] px-3 py-2 text-[12px] text-[#7A5410]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={mustChange}
              disabled={busy}
              onChange={(e) => setMustChange(e.target.checked)}
            />
            <span>
              <strong>Ask them to change it at first login.</strong> Until they
              do, you know their password too — so anything the account does
              can&apos;t be shown to be theirs. Leave this ticked unless you have
              a reason not to.
            </span>
          </label>
        </div>

        <div className="border-t border-[#E2DDD8] px-5 py-4">
          <button
            type="button"
            onClick={create}
            disabled={!canSubmit}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#6B5C32] text-sm font-semibold text-white disabled:opacity-50"
          >
            <UserPlus className="h-4 w-4" />
            {busy ? "Creating…" : "Create account"}
          </button>
        </div>
      </div>
    </div>
  );
}
