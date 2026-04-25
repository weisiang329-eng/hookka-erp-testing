// ---------------------------------------------------------------------------
// User Management (SUPER_ADMIN only) — three sections stacked vertically:
//
//   1. Active Users   — list + toggle, reset password, delete
//   2. Pending Invites — list + resend, copy link, revoke
//   3. Send New Invite — form (email, displayName, role)
//
// All data comes from /api/users and /api/users/invite* — no client-side
// caching library, plain fetch + useState so the page matches the rest of
// the dashboard.
// ---------------------------------------------------------------------------
import { useCallback, useMemo, useState } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Mail,
  UserPlus,
  Copy,
  RefreshCw,
  Trash2,
  KeyRound,
  CheckCircle2,
  XCircle,
  Ban,
  Check,
  Users as UsersIcon,
  Clock,
  Send,
  Loader2,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";

// ---------- Row types ------------------------------------------------------

type UserRow = {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  displayName: string;
};

type InviteRow = {
  token: string;
  email: string;
  role: string;
  displayName: string;
  invitedBy: string;
  inviterName: string;
  createdAt: string;
  expiresAt: string;
  emailSentAt: string | null;
};

// All /api/* responses follow { success, data, error? }.
type ApiEnvelope<T = unknown> = {
  success: boolean;
  data?: T;
  error?: string;
};

// ---------- Small helpers --------------------------------------------------

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-MY", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtRelativeExpiry(iso: string): string {
  const now = Date.now();
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return iso;
  const diffMs = target - now;
  if (diffMs <= 0) return "expired";
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) {
    const mins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
    return `${mins}m left`;
  }
  if (hours < 24) return `${hours}h left`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h left`;
}

// ---------- Main component -------------------------------------------------

export default function UsersPage() {
  const currentUser = getCurrentUser();

  // Invite form
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteDisplayName, setInviteDisplayName] = useState("");
  const [inviteRole, setInviteRole] = useState("SUPER_ADMIN");
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{
    kind: "ok" | "err";
    message: string;
    inviteUrl?: string;
    emailSent?: boolean;
  } | null>(null);

  // Reset-password modal
  const [resetForUser, setResetForUser] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  // Inline flash banner
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );
  const showFlash = useCallback(
    (kind: "ok" | "err", msg: string) => {
      setFlash({ kind, msg });
      // Fire-and-forget timer scheduled inside an event-style callback (the
      // user did something that produced a flash banner). Not bound to
      // component lifecycle in a way useTimeout can express cleanly without
      // adding an extra effect+state pair just to time-out a banner.
      // eslint-disable-next-line no-restricted-syntax -- one-shot timer scheduled from event handler / callback
      setTimeout(() => setFlash(null), 4000);
    },
    [],
  );

  // ---------- Fetchers -----------------------------------------------------

  const { data: usersResp, loading: loadingUsers, refresh: refreshUsersHook } = useCachedJson<ApiEnvelope<UserRow[]>>("/api/users");
  const { data: invitesResp, loading: loadingInvites, refresh: refreshInvitesHook } = useCachedJson<ApiEnvelope<InviteRow[]>>("/api/users/invites");

  const fetchUsers = useCallback(() => {
    invalidateCachePrefix("/api/users");
    refreshUsersHook();
  }, [refreshUsersHook]);

  const fetchInvites = useCallback(() => {
    invalidateCachePrefix("/api/users/invites");
    refreshInvitesHook();
  }, [refreshInvitesHook]);

  const users: UserRow[] = useMemo(
    () => (usersResp?.success ? usersResp.data ?? [] : []),
    [usersResp],
  );
  const invites: InviteRow[] = useMemo(
    () => (invitesResp?.success ? invitesResp.data ?? [] : []),
    [invitesResp],
  );

  // ---------- User actions -------------------------------------------------

  const toggleActive = async (u: UserRow) => {
    const next = !u.isActive;
    if (!next && !confirm(`Disable ${u.email}? Their sessions will be killed.`))
      return;
    const res = await fetch(`/api/users/${u.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: next }),
    });
    const json = (await res.json()) as ApiEnvelope;
    if (json.success) {
      showFlash("ok", next ? "User enabled" : "User disabled");
      fetchUsers();
    } else {
      showFlash("err", json.error ?? "Failed to update user");
    }
  };

  const deleteUser = async (u: UserRow) => {
    if (u.id === currentUser?.id) {
      showFlash("err", "You can't delete your own account");
      return;
    }
    if (!confirm(`Delete ${u.email}? Their sessions will be purged.`)) return;
    const res = await fetch(`/api/users/${u.id}`, { method: "DELETE" });
    const json = (await res.json()) as ApiEnvelope;
    if (json.success) {
      showFlash("ok", "User deleted");
      fetchUsers();
    } else {
      showFlash("err", json.error ?? "Failed to delete user");
    }
  };

  const submitReset = async () => {
    if (!resetForUser) return;
    setResetError(null);
    if (resetPassword.length < 6) {
      setResetError("Password must be at least 6 characters");
      return;
    }
    setResetSubmitting(true);
    try {
      const res = await fetch(
        `/api/users/${resetForUser.id}/reset-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPassword: resetPassword }),
        },
      );
      const json = (await res.json()) as ApiEnvelope;
      if (json.success) {
        showFlash("ok", `Password reset for ${resetForUser.email}`);
        setResetForUser(null);
        setResetPassword("");
      } else {
        setResetError(json.error ?? "Failed to reset password");
      }
    } finally {
      setResetSubmitting(false);
    }
  };

  // ---------- Invite actions -----------------------------------------------

  const submitInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteResult(null);
    if (!inviteEmail.trim() || !inviteEmail.includes("@")) {
      setInviteResult({ kind: "err", message: "Valid email required" });
      return;
    }
    setInviteSubmitting(true);
    try {
      const res = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          displayName: inviteDisplayName.trim() || undefined,
          role: inviteRole,
        }),
      });
      const json = (await res.json()) as ApiEnvelope<{
        token: string;
        inviteUrl: string;
        emailSent: boolean;
        emailError?: string;
      }>;
      if (json.success && json.data) {
        setInviteResult({
          kind: "ok",
          message: json.data.emailSent
            ? `Invite sent to ${inviteEmail.trim()}`
            : `Invite created. Email not sent — copy the link below.`,
          inviteUrl: json.data.inviteUrl,
          emailSent: json.data.emailSent,
        });
        setInviteEmail("");
        setInviteDisplayName("");
        fetchInvites();
      } else {
        setInviteResult({
          kind: "err",
          message: json.error ?? "Failed to create invite",
        });
      }
    } catch (err) {
      setInviteResult({
        kind: "err",
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setInviteSubmitting(false);
    }
  };

  const copyInviteLink = async (token: string) => {
    const origin = window.location.origin;
    const url = `${origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      showFlash("ok", "Invite link copied");
    } catch {
      showFlash("err", "Clipboard blocked — copy manually");
    }
  };

  const resendInvite = async (inv: InviteRow) => {
    const res = await fetch(`/api/users/invites/${inv.token}/resend`, {
      method: "POST",
    });
    const json = (await res.json()) as ApiEnvelope<{
      emailSent: boolean;
      emailError?: string;
    }>;
    if (json.success && json.data) {
      if (json.data.emailSent) {
        showFlash("ok", `Invite email resent to ${inv.email}`);
      } else {
        showFlash(
          "err",
          `Email not sent: ${json.data.emailError ?? "unknown"}`,
        );
      }
      fetchInvites();
    } else {
      showFlash("err", json.error ?? "Failed to resend");
    }
  };

  const revokeInvite = async (inv: InviteRow) => {
    if (!confirm(`Revoke invite for ${inv.email}?`)) return;
    const res = await fetch(`/api/users/invites/${inv.token}`, {
      method: "DELETE",
    });
    const json = (await res.json()) as ApiEnvelope;
    if (json.success) {
      showFlash("ok", "Invite revoked");
      fetchInvites();
    } else {
      showFlash("err", json.error ?? "Failed to revoke");
    }
  };

  // ---------- Render -------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">User Management</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage team access: invite new admins, enable/disable accounts,
            reset passwords.
          </p>
        </div>
        {flash && (
          <div
            className={
              "flex items-center gap-2 rounded-md px-4 py-2 text-sm " +
              (flash.kind === "ok"
                ? "bg-[#EEF3E4] border border-[#C6DBA8] text-[#4F7C3A]"
                : "bg-[#FCE4E4] border border-[#E8B2A1] text-[#9A3A2D]")
            }
          >
            {flash.kind === "ok" ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            {flash.msg}
          </div>
        )}
      </div>

      {/* =========================================================== */}
      {/* 1. ACTIVE USERS */}
      {/* =========================================================== */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <UsersIcon className="h-5 w-5 text-[#6B5C32]" />
            <div>
              <CardTitle>Active Users</CardTitle>
              <CardDescription>
                {loadingUsers ? "Loading…" : `${users.length} user(s) total`}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-left">
                  <Th>Email</Th>
                  <Th>Name</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Last login</Th>
                  <Th>Created</Th>
                  <Th className="text-right pr-2">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {loadingUsers ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-gray-500">
                      <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                      Loading users…
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-gray-500">
                      No users yet
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr
                      key={u.id}
                      className="border-b border-[#F0ECE9] hover:bg-[#FAF9F8]"
                    >
                      <Td>
                        <span className="font-medium">{u.email}</span>
                        {u.id === currentUser?.id && (
                          <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider bg-[#6B5C32]/10 text-[#6B5C32] px-2 py-0.5 rounded">
                            You
                          </span>
                        )}
                      </Td>
                      <Td>{u.displayName || "—"}</Td>
                      <Td>
                        <span className="text-xs font-semibold uppercase tracking-wider text-[#6B5C32]">
                          {u.role}
                        </span>
                      </Td>
                      <Td>
                        {u.isActive ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium bg-[#EEF3E4] text-[#4F7C3A] px-2 py-0.5 rounded-full">
                            <Check className="h-3 w-3" /> Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium bg-[#F0ECE9] text-[#6B7280] px-2 py-0.5 rounded-full">
                            <Ban className="h-3 w-3" /> Disabled
                          </span>
                        )}
                      </Td>
                      <Td className="text-gray-600">
                        {fmtDateTime(u.lastLoginAt)}
                      </Td>
                      <Td className="text-gray-600">
                        {fmtDateTime(u.createdAt)}
                      </Td>
                      <Td className="text-right pr-2">
                        <div className="inline-flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleActive(u)}
                            title={u.isActive ? "Disable" : "Enable"}
                          >
                            {u.isActive ? (
                              <Ban className="h-3.5 w-3.5" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setResetForUser(u);
                              setResetPassword("");
                              setResetError(null);
                            }}
                            title="Reset password"
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => deleteUser(u)}
                            title="Delete"
                            disabled={u.id === currentUser?.id}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-red-600" />
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* =========================================================== */}
      {/* 2. PENDING INVITES */}
      {/* =========================================================== */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-[#6B5C32]" />
            <div>
              <CardTitle>Pending Invites</CardTitle>
              <CardDescription>
                {loadingInvites
                  ? "Loading…"
                  : invites.length === 0
                    ? "No pending invites"
                    : `${invites.length} invite(s) awaiting acceptance`}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-left">
                  <Th>Email</Th>
                  <Th>Invited by</Th>
                  <Th>Sent</Th>
                  <Th>Expires</Th>
                  <Th className="text-right pr-2">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {loadingInvites ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-gray-500">
                      <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                      Loading…
                    </td>
                  </tr>
                ) : invites.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-gray-500">
                      No pending invites — use the form below to invite
                      someone.
                    </td>
                  </tr>
                ) : (
                  invites.map((inv) => (
                    <tr
                      key={inv.token}
                      className="border-b border-[#F0ECE9] hover:bg-[#FAF9F8]"
                    >
                      <Td>
                        <div className="flex flex-col">
                          <span className="font-medium">{inv.email}</span>
                          {inv.displayName && (
                            <span className="text-xs text-gray-500">
                              {inv.displayName}
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td>{inv.inviterName || "—"}</Td>
                      <Td className="text-gray-600">
                        {inv.emailSentAt ? (
                          fmtDateTime(inv.emailSentAt)
                        ) : (
                          <span className="text-xs text-amber-700">
                            not sent
                          </span>
                        )}
                      </Td>
                      <Td className="text-gray-600">
                        {fmtRelativeExpiry(inv.expiresAt)}
                      </Td>
                      <Td className="text-right pr-2">
                        <div className="inline-flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copyInviteLink(inv.token)}
                            title="Copy invite link"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => resendInvite(inv)}
                            title="Resend email"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => revokeInvite(inv)}
                            title="Revoke"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-red-600" />
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* =========================================================== */}
      {/* 3. SEND NEW INVITE */}
      {/* =========================================================== */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <UserPlus className="h-5 w-5 text-[#6B5C32]" />
            <div>
              <CardTitle>Send New Invite</CardTitle>
              <CardDescription>
                Recipient receives an email with a 72-hour acceptance link.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitInvite} className="space-y-4 max-w-2xl">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1 uppercase tracking-wide">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                  <Input
                    type="email"
                    placeholder="new-admin@hookka.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="pl-9"
                    autoComplete="off"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1 uppercase tracking-wide">
                  Display Name
                </label>
                <Input
                  type="text"
                  placeholder="Jane Doe"
                  value={inviteDisplayName}
                  onChange={(e) => setInviteDisplayName(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1 uppercase tracking-wide">
                  Role
                </label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
                >
                  <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                </select>
              </div>
            </div>

            {inviteResult && (
              <div
                className={
                  "rounded-md px-4 py-3 text-sm space-y-2 " +
                  (inviteResult.kind === "ok"
                    ? "bg-[#EEF3E4] border border-[#C6DBA8] text-[#4F7C3A]"
                    : "bg-[#FCE4E4] border border-[#E8B2A1] text-[#9A3A2D]")
                }
              >
                <div className="flex items-center gap-2 font-medium">
                  {inviteResult.kind === "ok" ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <XCircle className="h-4 w-4" />
                  )}
                  {inviteResult.message}
                </div>
                {inviteResult.inviteUrl && !inviteResult.emailSent && (
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={inviteResult.inviteUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 rounded border border-[#C6DBA8] bg-white px-2 py-1 text-xs text-[#1F1D1B]"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            inviteResult.inviteUrl!,
                          );
                          showFlash("ok", "Link copied");
                        } catch {
                          showFlash("err", "Clipboard blocked");
                        }
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <Button
                type="submit"
                variant="primary"
                disabled={inviteSubmitting}
              >
                {inviteSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {inviteSubmitting ? "Sending…" : "Send Invite"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* =========================================================== */}
      {/* Reset password modal */}
      {/* =========================================================== */}
      {resetForUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !resetSubmitting && setResetForUser(null)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-[#1F1D1B] flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-[#6B5C32]" />
              Reset password
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Set a new password for <strong>{resetForUser.email}</strong>.
              Their active sessions will be invalidated.
            </p>
            <div className="mt-4 space-y-2">
              <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
                New password
              </label>
              <Input
                type="password"
                autoFocus
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="min 6 characters"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitReset();
                }}
              />
              {resetError && (
                <p className="text-xs text-red-600">{resetError}</p>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setResetForUser(null)}
                disabled={resetSubmitting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={submitReset}
                disabled={resetSubmitting}
              >
                {resetSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Reset password
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={
        "py-2 px-2 text-xs font-semibold uppercase tracking-wider text-gray-500 " +
        (className ?? "")
      }
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={"py-3 px-2 " + (className ?? "")}>{children}</td>;
}
