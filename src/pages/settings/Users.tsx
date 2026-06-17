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
import { humanizeError } from "@/lib/humanize-error";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";
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
  Pencil,
  AtSign,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { copyText } from "@/lib/copy-text";

// The three assignable roles, shown in BOTH the invite dropdown and the
// per-row "Change role" dialog. ONE source of truth so the two pickers can
// never drift apart.
//  • SUPER_ADMIN — full access + manage user accounts (the ONLY role that can
//    enable/disable, delete, reset, or invite — see requireSuperAdmin in
//    src/api/lib/rbac.ts).
//  • ADMIN       — full operational access but CANNOT manage user accounts.
//  • READ_ONLY   — Viewer: sees everything, every mutation is blocked 403.
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "SUPER_ADMIN", label: "Super Admin (full access + manage users)" },
  { value: "ADMIN", label: "Admin (full access, cannot manage users)" },
  { value: "READ_ONLY", label: "Viewer (read-only)" },
];

function roleLabel(role: string): string {
  return ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role;
}

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

// A hookka.com email alias record from the Mail Center. NOTE: the
// /api/mail-center endpoints return their payload DIRECTLY (a bare array /
// object), NOT wrapped in the { success, data } envelope the /api/users
// routes use — so this fetch is handled differently below.
type MailAddress = {
  id: string;
  address: string;
  label: string;
  assignedUserId?: string;
  assignedUserName?: string;
  assignedDept?: string;
  active: boolean;
  createdAt: string;
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

// Suggest a default @hookka.com alias for a user: first name (or the email
// local-part) lowercased and stripped to [a-z0-9]. The admin can always edit
// it before creating.
function suggestAlias(u: { displayName: string; email: string }): string {
  const fromName = (u.displayName || "").trim().split(/\s+/)[0] || "";
  const local = (u.email || "").split("@")[0] || "";
  const base = (fromName || local)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return base ? `${base}@hookka.com` : "";
}

// ---------- Main component -------------------------------------------------

export default function UsersPage() {
  const currentUser = getCurrentUser();
  // Only a Super Admin may enable/disable, delete, reset a password, or send/
  // revoke invites. An Admin can open this page and SEE everyone (users:read),
  // but the account-management controls are hidden for them — mirrors the
  // requireSuperAdmin gate on every user-management route server-side, so a
  // stray Admin can never disable the owner's account. (owner 2026-06-12)
  const canManageUsers = currentUser?.role?.toUpperCase() === "SUPER_ADMIN";

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

  // Change-role modal (SUPER_ADMIN only). Role drives access, so the save goes
  // through verifiedSave — the read-back confirms the role actually changed
  // (a stale-cache 200 that didn't really re-role someone is a security smell).
  const [editRoleForUser, setEditRoleForUser] = useState<UserRow | null>(null);
  const [editRole, setEditRole] = useState("");
  const [editRoleSubmitting, setEditRoleSubmitting] = useState(false);
  const [editRoleError, setEditRoleError] = useState<string | null>(null);

  // Email-alias modal. Creating an @hookka.com alias for a user is a
  // SUPER_ADMIN-only account action (POST /api/mail-center/addresses is gated
  // by requireSuperAdmin). Explicit Create button — never auto-save.
  const [aliasForUser, setAliasForUser] = useState<UserRow | null>(null);
  const [aliasAddress, setAliasAddress] = useState("");
  // Department the mailbox is grouped under (owner 2026-06-17): HR people → HR,
  // Finance people → Finance, Operations + everyone else → Support. Posted as
  // assignedDept (the email_addresses table has an assigned_dept column).
  const [aliasDept, setAliasDept] = useState("Support");
  // Free-text job title recorded on the mailbox alongside the department
  // (owner 2026-06-17). Optional; posted as assignedPosition (the
  // email_addresses table has an assigned_position column).
  const [aliasPosition, setAliasPosition] = useState("");
  const [aliasSubmitting, setAliasSubmitting] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);

  // Inline flash banner
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );
  // Which pending invite is currently being re-emailed — drives a spinner +
  // disabled state on that row's Resend button so the click gives IMMEDIATE
  // feedback. (Before: the only feedback was the top-of-page banner, which is
  // off-screen when you're scrolled down to the invite list — felt dead.)
  const [resendingToken, setResendingToken] = useState<string | null>(null);
  // Manual-copy fallback: when the Clipboard API + execCommand both
  // refuse (e.g. plain HTTP, sandboxed iframe), we render a small modal
  // with the URL pre-selected so the user can Ctrl/Cmd+C themselves.
  const [manualCopyText, setManualCopyText] = useState<string | null>(null);
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
  // Mail Center returns a bare array (no { success, data } envelope).
  const { data: addressesResp, refresh: refreshAddressesHook } = useCachedJson<MailAddress[]>("/api/mail-center/addresses");

  const fetchUsers = useCallback(() => {
    invalidateCachePrefix("/api/users");
    refreshUsersHook();
  }, [refreshUsersHook]);

  const fetchInvites = useCallback(() => {
    invalidateCachePrefix("/api/users/invites");
    refreshInvitesHook();
  }, [refreshInvitesHook]);

  const fetchAddresses = useCallback(() => {
    invalidateCachePrefix("/api/mail-center/addresses");
    refreshAddressesHook();
  }, [refreshAddressesHook]);

  const users: UserRow[] = useMemo(
    () => (usersResp?.success ? usersResp.data ?? [] : []),
    [usersResp],
  );
  const invites: InviteRow[] = useMemo(
    () => (invitesResp?.success ? invitesResp.data ?? [] : []),
    [invitesResp],
  );
  // Map each user id → their (first) alias, so the row can show the existing
  // address instead of the "Add alias" control.
  const aliasByUserId = useMemo(() => {
    const m = new Map<string, MailAddress>();
    for (const a of addressesResp ?? []) {
      if (a.assignedUserId && !m.has(a.assignedUserId)) m.set(a.assignedUserId, a);
    }
    return m;
  }, [addressesResp]);

  // ---------- User actions -------------------------------------------------

  const toggleActive = async (u: UserRow) => {
    const next = !u.isActive;
    if (!next && !confirm(`Disable ${u.email}? Their sessions will be killed.`))
      return;
    // 2026-05-27 verifiedSave migration. Auth toggle drives login access —
    // a stale-cache 200 that didn't actually disable the user is a real
    // security smell. Readback fetches the users list and finds this row.
    const result = await verifiedSave<UserRow>({
      endpoint: `/api/users/${u.id}`,
      method: "PUT",
      body: { isActive: next },
      readback: async () => {
        const r = await fetch(`/api/users?_v=${Date.now()}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { success?: boolean; data?: UserRow[] };
        const list = j?.data ?? [];
        return list.find((row) => row.id === u.id) ?? null;
      },
      expect: { isActive: next },
    });
    if (result.ok) {
      showFlash("ok", next ? "User enabled" : "User disabled");
      fetchUsers();
    } else if (result.reason === "mismatch") {
      showFlash("err", formatMismatchError(result.diffs));
    } else if (result.reason === "http") {
      let parsedErr = result.body;
      try {
        const j = JSON.parse(result.body) as { error?: string };
        if (j.error) parsedErr = j.error;
      } catch { /* keep raw body */ }
      showFlash("err", humanizeError({ status: result.status, message: parsedErr }, "Couldn't update the user. Please try again."));
    } else {
      showFlash("err", humanizeError(result.details, "Couldn't save. Please try again."));
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

  const submitRoleChange = async () => {
    if (!editRoleForUser) return;
    const target = editRoleForUser;
    setEditRoleError(null);
    if (editRole === target.role) {
      setEditRoleForUser(null);
      return;
    }
    // A role change ends their current session (they re-sign-in with the new
    // access). Spell that out — and flag the self-demotion foot-gun.
    const selfNote =
      target.id === currentUser?.id
        ? "\n\nThis is YOUR OWN account — moving away from Super Admin signs you out and you may lose access to this page."
        : "";
    if (
      !confirm(
        `Change ${target.email} to ${roleLabel(editRole)}?\n\nTheir current session ends immediately; they sign back in with the new access.${selfNote}`,
      )
    )
      return;
    setEditRoleSubmitting(true);
    try {
      const result = await verifiedSave<UserRow>({
        endpoint: `/api/users/${target.id}`,
        method: "PUT",
        body: { role: editRole },
        readback: async () => {
          const r = await fetch(`/api/users?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: UserRow[] };
          return (j?.data ?? []).find((row) => row.id === target.id) ?? null;
        },
        expect: { role: editRole },
      });
      if (result.ok) {
        showFlash("ok", `${target.email} is now ${roleLabel(editRole)}`);
        setEditRoleForUser(null);
        fetchUsers();
      } else if (result.reason === "mismatch") {
        setEditRoleError(formatMismatchError(result.diffs));
      } else if (result.reason === "http") {
        let parsedErr = result.body;
        try {
          const j = JSON.parse(result.body) as { error?: string };
          if (j.error) parsedErr = j.error;
        } catch {
          /* keep raw body */
        }
        setEditRoleError(
          humanizeError(
            { status: result.status, message: parsedErr },
            "Couldn't change the role. Please try again.",
          ),
        );
      } else {
        setEditRoleError(
          humanizeError(result.details, "Couldn't save. Please try again."),
        );
      }
    } finally {
      setEditRoleSubmitting(false);
    }
  };

  // ---------- Email-alias actions ------------------------------------------

  const submitAlias = async () => {
    if (!aliasForUser) return;
    const target = aliasForUser;
    setAliasError(null);
    const address = aliasAddress.trim().toLowerCase();
    if (!address || !address.includes("@")) {
      setAliasError("Enter a valid email address");
      return;
    }
    if (!address.endsWith("@hookka.com")) {
      setAliasError("Address must end with @hookka.com");
      return;
    }
    setAliasSubmitting(true);
    try {
      const res = await fetch("/api/mail-center/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          assignedUserId: target.id,
          assignedUserName: target.displayName || target.email,
          assignedDept: aliasDept,
          assignedPosition: aliasPosition || undefined,
        }),
      });
      // Mail Center returns the created row directly (201), or
      // { error } on 400/409/500 — there is no { success } envelope.
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        address?: string;
      };
      if (res.ok) {
        showFlash("ok", `Alias ${json.address ?? address} created for ${target.email}`);
        setAliasForUser(null);
        setAliasAddress("");
        fetchAddresses();
      } else {
        setAliasError(
          json.error ??
            (res.status === 409
              ? "That address already exists"
              : "Couldn't create the alias. Please try again."),
        );
      }
    } catch (err) {
      setAliasError(
        humanizeError(err, "Network problem — please try again."),
      );
    } finally {
      setAliasSubmitting(false);
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
        // When emailSent is false, surface the server's reason verbatim
        // so the admin sees actionable detail (e.g. "RESEND_API_KEY not
        // configured" or "outbox_emails table missing — apply migration
        // 0081"). Without it the toast was just a vague "not sent".
        const emailErr = json.data.emailError;
        setInviteResult({
          kind: "ok",
          message: json.data.emailSent
            ? `Invite sent to ${inviteEmail.trim()}`
            : emailErr
            ? `Invite created — but email failed: ${emailErr}. Copy the link below.`
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
        message: humanizeError(err, "Network problem — please try again."),
      });
    } finally {
      setInviteSubmitting(false);
    }
  };

  const copyInviteLink = async (token: string) => {
    const origin = window.location.origin;
    const url = `${origin}/invite/${token}`;
    const result = await copyText(url);
    if (result.ok) {
      showFlash("ok", "Invite link copied");
    } else {
      // Both the modern Clipboard API and the execCommand fallback
      // refused. Fall back to a manual-copy modal so the user still
      // has a path to get the link out of the page.
      setManualCopyText(url);
    }
  };

  const resendInvite = async (inv: InviteRow) => {
    setResendingToken(inv.token);
    try {
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
    } catch (err) {
      // Previously there was NO try/catch: a network error or a non-JSON
      // response made `res.json()` throw, the handler died, and the operator
      // saw absolutely nothing. Always surface a result now.
      showFlash(
        "err",
        `Failed to resend: ${err instanceof Error ? err.message : "network error"}`,
      );
    } finally {
      setResendingToken(null);
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
              // Fixed bottom-right so the confirmation is ALWAYS on-screen,
              // even when the operator is scrolled down to the Pending Invites
              // list to click Resend (the old in-flow banner at the top was
              // off-screen there — the root of "no reaction / never told me").
              "fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-md px-4 py-3 text-sm shadow-lg " +
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
                  <Th>Email alias</Th>
                  <Th>Last login</Th>
                  <Th>Created</Th>
                  <Th className="text-right pr-2">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {loadingUsers ? (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-gray-500">
                      <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                      Loading users…
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-gray-500">
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
                      <Td>
                        {(() => {
                          const alias = aliasByUserId.get(u.id);
                          if (alias) {
                            return (
                              <span
                                className={
                                  "inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded " +
                                  (alias.active
                                    ? "bg-[#EEF3E4] text-[#4F7C3A]"
                                    : "bg-[#F0ECE9] text-[#6B7280]")
                                }
                                title={
                                  alias.active
                                    ? "hookka.com alias"
                                    : "hookka.com alias (inactive)"
                                }
                              >
                                <AtSign className="h-3 w-3" />
                                {alias.address}
                              </span>
                            );
                          }
                          if (!canManageUsers) {
                            return <span className="text-xs text-gray-400">—</span>;
                          }
                          return (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setAliasForUser(u);
                                setAliasAddress(suggestAlias(u));
                                setAliasDept("Support");
                                setAliasPosition("");
                                setAliasError(null);
                              }}
                              title="Create @hookka.com alias"
                            >
                              <AtSign className="h-3.5 w-3.5 mr-1" />
                              Add alias
                            </Button>
                          );
                        })()}
                      </Td>
                      <Td className="text-gray-600">
                        {fmtDateTime(u.lastLoginAt)}
                      </Td>
                      <Td className="text-gray-600">
                        {fmtDateTime(u.createdAt)}
                      </Td>
                      <Td className="text-right pr-2">
                        {canManageUsers ? (
                          <div className="inline-flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setEditRoleForUser(u);
                                setEditRole(u.role);
                                setEditRoleError(null);
                              }}
                              title="Change role"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
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
                        ) : (
                          <span className="text-xs text-[#9C8F7A]">
                            Super Admin only
                          </span>
                        )}
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
                          {canManageUsers && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => resendInvite(inv)}
                                disabled={resendingToken === inv.token}
                                title="Resend email"
                              >
                                <RefreshCw
                                  className={
                                    "h-3.5 w-3.5" +
                                    (resendingToken === inv.token
                                      ? " animate-spin"
                                      : "")
                                  }
                                />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => revokeInvite(inv)}
                                title="Revoke"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-red-600" />
                              </Button>
                            </>
                          )}
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
      {/* 3. SEND NEW INVITE — Super Admin only (POST /invite is gated by
          requireSuperAdmin). An Admin never sees the form. */}
      {/* =========================================================== */}
      {canManageUsers && (
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
                  {ROLE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
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
      )}

      {/* =========================================================== */}
      {/* Manual-copy fallback modal — fires when both navigator.clipboard
          and execCommand refused (e.g. plain HTTP / sandboxed iframe).
          Renders the link in a readonly textarea pre-selected so the
          user can Ctrl/Cmd+C themselves. */}
      {/* =========================================================== */}
      {manualCopyText && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setManualCopyText(null)}
        >
          <div
            className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-[#1F1D1B] flex items-center gap-2">
              <Copy className="h-5 w-5 text-[#6B5C32]" />
              Copy invite link
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Your browser blocked automatic clipboard access (this happens
              over plain HTTP or in some sandboxed contexts). Select the
              link below and press <kbd className="px-1 py-0.5 bg-gray-100 border border-gray-300 rounded text-xs">Ctrl/Cmd</kbd>+
              <kbd className="px-1 py-0.5 bg-gray-100 border border-gray-300 rounded text-xs">C</kbd> to copy manually.
            </p>
            <div className="mt-4">
              <textarea
                readOnly
                autoFocus
                value={manualCopyText}
                rows={3}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full text-xs font-mono border border-gray-200 rounded px-3 py-2 bg-[#FAF9F7] focus:outline-none focus:border-[#6B5C32]"
              />
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="primary"
                onClick={() => setManualCopyText(null)}
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      )}

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

      {/* =========================================================== */}
      {/* Change-role modal (SUPER_ADMIN only) */}
      {/* =========================================================== */}
      {editRoleForUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !editRoleSubmitting && setEditRoleForUser(null)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-[#1F1D1B] flex items-center gap-2">
              <Pencil className="h-5 w-5 text-[#6B5C32]" />
              Change role
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Set the role for <strong>{editRoleForUser.email}</strong>. Saving
              ends their current session — they sign back in with the new
              access.
            </p>
            <div className="mt-4 space-y-2">
              <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
                Role
              </label>
              <select
                value={editRole}
                onChange={(e) => setEditRole(e.target.value)}
                className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                {/* Preserve any legacy/non-standard role the account already
                    carries so the picker never silently blanks it. */}
                {!ROLE_OPTIONS.some((o) => o.value === editRoleForUser.role) && (
                  <option value={editRoleForUser.role}>
                    {editRoleForUser.role} (current)
                  </option>
                )}
              </select>
              <p className="text-xs text-gray-500">
                {roleLabel(editRole)}
              </p>
              {editRoleError && (
                <p className="text-xs text-red-600">{editRoleError}</p>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setEditRoleForUser(null)}
                disabled={editRoleSubmitting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={submitRoleChange}
                disabled={
                  editRoleSubmitting || editRole === editRoleForUser.role
                }
              >
                {editRoleSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Save role
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================== */}
      {/* Email-alias modal — create a hookka.com address for a user.
          SUPER_ADMIN only (POST /api/mail-center/addresses is gated by
          requireSuperAdmin). This creates an in-ERP address record that
          receives mail in the Mail Center once the domain MX points at
          Cloudflare Email Routing — it is NOT a Google/Gmail account. */}
      {/* =========================================================== */}
      {aliasForUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !aliasSubmitting && setAliasForUser(null)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-[#1F1D1B] flex items-center gap-2">
              <AtSign className="h-5 w-5 text-[#6B5C32]" />
              Create email alias
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Create a <strong>@hookka.com</strong> address for{" "}
              <strong>{aliasForUser.email}</strong>. Mail to and from it shows
              up in the Mail Center. This is a company address received into the
              ERP — not a separate Gmail login.
            </p>
            <div className="mt-4 space-y-2">
              <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
                Alias address
              </label>
              <div className="relative">
                <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                <Input
                  type="email"
                  autoFocus
                  value={aliasAddress}
                  onChange={(e) => setAliasAddress(e.target.value)}
                  placeholder="name@hookka.com"
                  className="pl-9"
                  autoComplete="off"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitAlias();
                  }}
                />
              </div>
              <p className="text-xs text-gray-500">
                Must end with @hookka.com. Edit the suggestion if needed.
              </p>
              <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide pt-2">
                Department
              </label>
              <select
                value={aliasDept}
                onChange={(e) => setAliasDept(e.target.value)}
                className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
              >
                <option value="Support">Support (Operations &amp; others)</option>
                <option value="Finance">Finance</option>
                <option value="HR">HR</option>
              </select>
              <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide pt-2">
                Position
              </label>
              <Input
                type="text"
                value={aliasPosition}
                onChange={(e) => setAliasPosition(e.target.value)}
                placeholder="e.g. Sales Manager"
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitAlias();
                }}
              />
              <p className="text-xs text-gray-500">
                Optional — the person&apos;s job title.
              </p>
              {aliasError && (
                <p className="text-xs text-red-600">{aliasError}</p>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setAliasForUser(null)}
                disabled={aliasSubmitting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={submitAlias}
                disabled={aliasSubmitting || !aliasAddress.trim()}
              >
                {aliasSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Create alias
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
