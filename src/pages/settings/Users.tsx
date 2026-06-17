// ---------------------------------------------------------------------------
// User Management (SUPER_ADMIN only) — split into THREE tabs (mirrors the
// Products "SKU Master / Maintenance" top-level toggle, via the shared Tabs
// component):
//
//   • Users          — Active Users table (+ Position / Department / Email
//                       alias columns) + Pending Invites + Send New Invite.
//   • Org Chart       — active staff grouped by department → position.
//   • Mailbox Access  — the @hookka.com mailbox matrix + per-user view level.
//
// "No naked edits" ([[feedback_no_naked_edits]]): the Mailbox Access matrix is
// READ-ONLY until you click Edit. Edits go to a local draft (view-level selects
// + access checkboxes + alias→user links); Save commits EVERY changed cell in
// one go (PUT /scope-level, POST/DELETE /access, PATCH /addresses for links);
// Cancel discards the draft. Nothing auto-saves on change.
//
// All data comes from /api/users, /api/users/invite* and /api/mail-center/* —
// no client-side caching library, plain fetch + useCachedJson so the page
// matches the rest of the dashboard.
// ---------------------------------------------------------------------------
import { useCallback, useMemo, useState } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { humanizeError } from "@/lib/humanize-error";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { DataGrid, type Column } from "@/components/ui/data-grid";
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
  Link2,
  X,
  SlidersHorizontal,
  ShieldCheck,
  GripVertical,
  Layers,
  ChevronDown,
  ChevronRight,
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

// Department options for an @hookka.com mailbox (owner 2026-06-17). Used by the
// create-alias modal; the same three buckets the org chart sorts first.
const DEPT_OPTIONS = ["Support", "Finance", "HR"] as const;

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
  assignedPosition?: string;
  active: boolean;
  createdAt: string;
};

type TabKey = "users" | "org" | "mailbox";

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

// Lowercased local-part (before the @) of an email/alias, stripped to
// [a-z0-9]. Used to associate a floating alias to a user when its
// assigned_user_id is missing (see aliasByUserId below).
function localKey(addr: string | undefined): string {
  if (!addr) return "";
  return (addr.split("@")[0] || "").toLowerCase().replace(/[^a-z0-9]/g, "");
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

  // Which tab is showing. Default = Users.
  const [tab, setTab] = useState<TabKey>("users");

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

  // "Edit details" modal. ONE modal for the user's @hookka.com Email Alias,
  // Department and Position — all stored on the email_addresses alias row.
  // SUPER_ADMIN only (POST/PATCH /api/mail-center/addresses are gated by
  // requireSuperAdmin). Explicit Save — never auto-save (no naked edits).
  //   • If the user has NO alias yet → Save POSTs a new address.
  //   • If the user HAS an alias → Save PATCHes the changed Department /
  //     Position (the email address itself is immutable post-create — changing
  //     it means delete + recreate, which PATCH can't express). If that alias
  //     was only matched heuristically (floating assigned_user_id), the PATCH
  //     ALSO writes assigned_user_id so the link becomes the source of truth.
  // `aliasExisting` holds the alias being edited (null when creating).
  const [aliasForUser, setAliasForUser] = useState<UserRow | null>(null);
  const [aliasExisting, setAliasExisting] = useState<MailAddress | null>(null);
  const [aliasAddress, setAliasAddress] = useState("");
  // Department the mailbox is grouped under (owner 2026-06-17): HR people → HR,
  // Finance people → Finance, Operations + everyone else → Support. Posted as
  // assignedDept (the email_addresses table has an assigned_dept column).
  const [aliasDept, setAliasDept] = useState<string>("Support");
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

  // ---------- Mailbox access matrix (SUPER_ADMIN) --------------------------
  // Grants that let a user open a SHARED mailbox (support@/hr@/finance@) on top
  // of their own assigned alias. The server list is the base truth. Per-user
  // view-level rows (personal/department/company) decide how WIDE their inbox
  // is. BOTH are READ-ONLY on screen until the operator clicks Edit — then the
  // changes accumulate in local DRAFT maps and only hit the API on Save.
  const { data: accessResp, refresh: refreshAccessHook } = useCachedJson<
    { addressId: string; userId: string }[]
  >(canManageUsers ? "/api/mail-center/access" : null);
  const { data: levelsResp, refresh: refreshLevelsHook } = useCachedJson<
    { userId: string; level: string }[]
  >(canManageUsers ? "/api/mail-center/scope-levels" : null);

  // Committed server state (the read-only baseline).
  const serverGrants = useMemo(
    () => new Set((accessResp ?? []).map((g) => `${g.addressId}::${g.userId}`)),
    [accessResp],
  );
  const serverLevels = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of levelsResp ?? []) m.set(r.userId, r.level);
    return m;
  }, [levelsResp]);

  // Parsed lists. Declared here (above the Mailbox Access edit handlers) so
  // saveMailEdit can close over an already-defined `users` binding — the React
  // Compiler refuses to preserve a memo that's referenced before its
  // declaration.
  const users: UserRow[] = useMemo(
    () => (usersResp?.success ? usersResp.data ?? [] : []),
    [usersResp],
  );
  const invites: InviteRow[] = useMemo(
    () => (invitesResp?.success ? invitesResp.data ?? [] : []),
    [invitesResp],
  );

  // ----- Edit mode + draft state for the Mailbox Access tab -----
  // When mailEdit is false the matrix shows the committed server values and
  // every control is disabled. Entering edit copies the server state into the
  // draft maps; Save diffs draft↔server and fires one write per changed cell;
  // Cancel throws the drafts away.
  const [mailEdit, setMailEdit] = useState(false);
  const [draftGrants, setDraftGrants] = useState<Map<string, boolean>>(new Map());
  const [draftLevels, setDraftLevels] = useState<Map<string, string>>(new Map());
  // Alias→user links queued during edit (fixes a floating alias whose
  // assigned_user_id is empty). Keyed by addressId → userId. Committed via
  // PATCH /api/mail-center/addresses/:id on Save.
  const [draftLinks, setDraftLinks] = useState<Map<string, string>>(new Map());
  const [mailSaving, setMailSaving] = useState(false);
  // Optimistic view-level overrides written on a successful Save. They hold the
  // just-saved value for each user until the server refetch catches up — fixes
  // the "set Company, Save, dropdown jumps back to Personal" report (owner
  // 2026-06-17). The save succeeds and persists, but the immediate /scope-levels
  // refetch can race a read-after-write cache (browser HTTP cache / staging
  // Hyperdrive query cache) and return the pre-write list, blanking the change.
  // pendingLevels below drops each override the moment the server agrees, so
  // this never masks a genuine later change from another admin.
  const [savedLevels, setSavedLevels] = useState<Map<string, string>>(new Map());

  // ----- Org Chart drag-and-drop (Edit → Save, no naked edits) -----
  // The chart is READ-ONLY until the operator clicks "Edit layout". In edit
  // mode each person card becomes draggable; dropping it on a Department bucket
  // queues an assigned_dept change in `orgDraft` (addressId → newDept) without
  // touching the server. Save PATCHes every queued change
  // (/api/mail-center/addresses/:id { assignedDept }); Cancel discards. The
  // chart then rebuilds from the refreshed alias data — the dept lives on each
  // person's @hookka.com alias row, the same field the Edit-details modal sets.
  const [orgEdit, setOrgEdit] = useState(false);
  // addressId → target department (the dragged person's alias gets this dept).
  const [orgDraft, setOrgDraft] = useState<Map<string, string>>(new Map());
  const [orgSaving, setOrgSaving] = useState(false);
  // The card currently being dragged + the bucket it is hovering, so the UI
  // can show a drop-target highlight. addressId of the dragged person's alias.
  const [orgDragId, setOrgDragId] = useState<string | null>(null);
  const [orgDropDept, setOrgDropDept] = useState<string | null>(null);

  const beginMailEdit = () => {
    // Seed drafts from the committed server values so an untouched cell stays
    // exactly where it was.
    setDraftGrants(new Map(serverGrants ? [...serverGrants].map((k) => [k, true]) : []));
    const lv = new Map<string, string>();
    for (const [uid, level] of serverLevels) lv.set(uid, level);
    // Carry any just-saved-but-not-yet-confirmed level over the server baseline
    // so re-entering Edit doesn't seed a stale value while the refetch catches
    // up (same read-after-write window the pendingLevels override covers).
    for (const [uid, level] of savedLevels) {
      if (serverLevels.get(uid) !== level) lv.set(uid, level);
    }
    setDraftLevels(lv);
    setDraftLinks(new Map());
    setMailEdit(true);
  };

  const cancelMailEdit = () => {
    setMailEdit(false);
    setDraftGrants(new Map());
    setDraftLevels(new Map());
    setDraftLinks(new Map());
  };

  // Optimistic overrides that the server hasn't confirmed YET. An entry is
  // dropped the instant serverLevels reports the same value, so a stale
  // read-after-write refetch can't blank a just-saved change, and a genuine
  // later server value (e.g. another admin lowered the level) still wins once
  // it lands. Derived (not an effect) to avoid set-state-in-effect churn.
  const pendingLevels = useMemo(() => {
    const m = new Map<string, string>();
    for (const [uid, lvl] of savedLevels) {
      if (serverLevels.get(uid) !== lvl) m.set(uid, lvl);
    }
    return m;
  }, [savedLevels, serverLevels]);

  // Effective values — draft when editing, server when read-only.
  const isGranted = (addressId: string, userId: string): boolean => {
    const key = `${addressId}::${userId}`;
    if (mailEdit) return draftGrants.get(key) ?? false;
    return serverGrants.has(key);
  };
  const viewLevelFor = (userId: string): string => {
    if (mailEdit) return draftLevels.get(userId) ?? "personal";
    return pendingLevels.get(userId) ?? serverLevels.get(userId) ?? "personal";
  };

  // Draft mutators (edit mode only — never touch the server).
  const draftToggleGrant = (addressId: string, userId: string, on: boolean) => {
    setDraftGrants((prev) => new Map(prev).set(`${addressId}::${userId}`, on));
  };
  const draftSetLevel = (userId: string, level: string) => {
    setDraftLevels((prev) => new Map(prev).set(userId, level));
  };

  // Save EVERY changed cell. One PUT per changed level, one POST/DELETE per
  // changed grant, one PATCH per queued alias link. Any failure is surfaced and
  // we re-pull the server state so the matrix re-syncs to the truth.
  const saveMailEdit = async () => {
    setMailSaving(true);
    const ops: Promise<Response>[] = [];

    // Level diffs. Remember each (uid → after) so a successful save can hold
    // the new value optimistically until the server refetch confirms it.
    const levelWrites: Array<[string, string]> = [];
    const levelUserIds = new Set<string>([
      ...serverLevels.keys(),
      ...draftLevels.keys(),
    ]);
    for (const uid of levelUserIds) {
      const before = serverLevels.get(uid) ?? "personal";
      const after = draftLevels.get(uid) ?? "personal";
      if (before === after) continue;
      levelWrites.push([uid, after]);
      ops.push(
        fetch("/api/mail-center/scope-level", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: uid, level: after }),
        }),
      );
    }

    // Grant diffs.
    const grantKeys = new Set<string>([
      ...serverGrants,
      ...draftGrants.keys(),
    ]);
    for (const key of grantKeys) {
      const before = serverGrants.has(key);
      const after = draftGrants.get(key) ?? false;
      if (before === after) continue;
      const [addressId, userId] = key.split("::");
      ops.push(
        fetch("/api/mail-center/access", {
          method: after ? "POST" : "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addressId, userId }),
        }),
      );
    }

    // Alias→user link diffs (PATCH the address's assigned_user_id + name).
    for (const [addressId, userId] of draftLinks) {
      const u = users.find((x) => x.id === userId);
      ops.push(
        fetch(`/api/mail-center/addresses/${addressId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignedUserId: userId,
            assignedUserName: u ? u.displayName || u.email : undefined,
          }),
        }),
      );
    }

    try {
      if (ops.length === 0) {
        cancelMailEdit();
        showFlash("ok", "No changes to save");
        return;
      }
      const results = await Promise.all(ops);
      const failed = results.filter((r) => !r.ok).length;
      // Re-pull every list this page derived state from.
      invalidateCachePrefix("/api/mail-center/access");
      invalidateCachePrefix("/api/mail-center/scope-levels");
      invalidateCachePrefix("/api/mail-center/addresses");
      refreshAccessHook();
      refreshLevelsHook();
      refreshAddressesHook();
      if (failed > 0) {
        // Stay in edit mode so the operator can retry the ones that didn't
        // stick — the refreshed server state already reverted those cells.
        showFlash(
          "err",
          `${ops.length - failed} change(s) saved, ${failed} failed. Review and retry.`,
        );
      } else {
        // All writes landed. Hold the just-saved levels optimistically so a
        // stale read-after-write refetch can't bounce the dropdown back to its
        // old value; pendingLevels drops each one as serverLevels catches up.
        if (levelWrites.length > 0) {
          setSavedLevels((prev) => {
            const next = new Map(prev);
            for (const [uid, lvl] of levelWrites) next.set(uid, lvl);
            return next;
          });
        }
        cancelMailEdit();
        showFlash("ok", `Mailbox access saved (${ops.length} change(s))`);
      }
    } catch (err) {
      showFlash("err", humanizeError(err, "Couldn't save mailbox access. Please retry."));
    } finally {
      setMailSaving(false);
    }
  };

  // Map each user id → their (first) alias, so a row can show the existing
  // address + its dept/position instead of the "Add alias" control.
  //
  // ALIAS-VISIBILITY FIX (owner 2026-06-17): the primary key is the alias's
  // assigned_user_id. But an alias created OUTSIDE this modal (seeded, or made
  // before assigned_user_id existed) can be "floating" — assigned_user_id NULL
  // or pointing at a stale id — so it shows in the matrix (every active address
  // is a column) and the Mail Center sidebar (it's a real address) yet never
  // lands on its owner's row. To make the row reliably show it WITHOUT a
  // backend change, fall back to matching the alias local-part against the
  // user's own email local-part, then against the suggested alias. The explicit
  // assigned_user_id link always wins; the heuristic only fills gaps. (A
  // permanent fix is to PATCH assigned_user_id — see the "Link" action in the
  // Mailbox Access tab, which writes it for real.)
  const aliasByUserId = useMemo(() => {
    const all = addressesResp ?? [];
    const m = new Map<string, MailAddress>();
    // Pass 1 — explicit assigned_user_id (authoritative).
    for (const a of all) {
      if (a.assignedUserId && !m.has(a.assignedUserId)) m.set(a.assignedUserId, a);
    }
    // Pass 2 — heuristic local-part match for users still without an alias.
    // Only consider addresses NOT already claimed by an explicit assignment.
    const claimed = new Set<string>();
    for (const a of m.values()) claimed.add(a.id);
    const floating = all.filter((a) => !claimed.has(a.id));
    for (const u of users) {
      if (m.has(u.id)) continue;
      const wantEmail = localKey(u.email);
      const wantSuggest = localKey(suggestAlias(u));
      const hit = floating.find((a) => {
        const k = localKey(a.address);
        return k && (k === wantEmail || k === wantSuggest);
      });
      if (hit) m.set(u.id, hit);
    }
    return m;
  }, [addressesResp, users]);

  // Whether an alias row is only matched to its user by the local-part
  // heuristic (i.e. assigned_user_id is NOT this user). Such a row gets a
  // "Link" affordance in edit mode so the owner can write the real
  // assigned_user_id and stop relying on the heuristic.
  const aliasIsHeuristic = (u: UserRow, alias: MailAddress | undefined): boolean =>
    !!alias && alias.assignedUserId !== u.id;

  // Effective department for a user, honouring any queued drag in edit mode
  // (orgDraft on the user's alias id) over the alias's saved assigned_dept.
  // Users with no alias can't carry a draft (nothing to PATCH) → "Unassigned".
  const effectiveDept = useCallback(
    (u: UserRow): string => {
      const alias = aliasByUserId.get(u.id);
      if (alias && orgDraft.has(alias.id)) return orgDraft.get(alias.id)!;
      return alias?.assignedDept || "Unassigned";
    },
    [aliasByUserId, orgDraft],
  );

  // Org chart — active staff grouped by department → position, using the dept/
  // position recorded on each person's @hookka.com alias (the per-user org data
  // the owner already enters). In edit mode the grouping reflects queued drags
  // (orgDraft) so a card visibly moves the instant it's dropped, before Save.
  // Users without an alias fall under "Unassigned".
  const orgChart = useMemo(() => {
    const byDept = new Map<string, Map<string, UserRow[]>>();
    for (const u of users) {
      if (!u.isActive) continue;
      const alias = aliasByUserId.get(u.id);
      const dept = effectiveDept(u);
      const pos = alias?.assignedPosition || "—";
      let posMap = byDept.get(dept);
      if (!posMap) {
        posMap = new Map();
        byDept.set(dept, posMap);
      }
      const arr = posMap.get(pos);
      if (arr) arr.push(u);
      else posMap.set(pos, [u]);
    }
    return byDept;
  }, [users, aliasByUserId, effectiveDept]);
  // Stable column order: Support / Finance / HR first, other depts A–Z, then
  // "Unassigned" last. In edit mode ALWAYS surface the three fixed buckets +
  // Unassigned even when empty, so there's a visible drop target to drag onto.
  const orgDepts = useMemo(() => {
    const order = ["Support", "Finance", "HR"];
    const keys = new Set<string>(orgChart.keys());
    if (orgEdit) {
      for (const d of order) keys.add(d);
      keys.add("Unassigned");
    }
    return [...keys].sort((a, b) => {
      if (a === "Unassigned") return 1;
      if (b === "Unassigned") return -1;
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      const ra = ia === -1 ? 99 : ia;
      const rb = ib === -1 ? 99 : ib;
      return ra === rb ? a.localeCompare(b) : ra - rb;
    });
  }, [orgChart, orgEdit]);

  // ----- Org Chart edit handlers -----
  const beginOrgEdit = () => {
    setOrgDraft(new Map());
    setOrgDragId(null);
    setOrgDropDept(null);
    setOrgEdit(true);
  };
  const cancelOrgEdit = () => {
    setOrgEdit(false);
    setOrgDraft(new Map());
    setOrgDragId(null);
    setOrgDropDept(null);
  };
  // Drop a dragged person card onto a department bucket. Queues the move in
  // orgDraft (alias id → dept). If it matches the alias's saved dept, the entry
  // is dropped so Save stays a true no-op for unchanged cards.
  const dropOnDept = (u: UserRow, dept: string) => {
    const alias = aliasByUserId.get(u.id);
    setOrgDragId(null);
    setOrgDropDept(null);
    if (!alias) return; // no alias row → nothing to persist (guarded in UI)
    const saved = alias.assignedDept || "Unassigned";
    setOrgDraft((prev) => {
      const next = new Map(prev);
      if (dept === saved) next.delete(alias.id);
      else next.set(alias.id, dept);
      return next;
    });
  };
  // Save every queued dept move. One PATCH per changed alias; "Unassigned"
  // clears the field (sent as empty → stored NULL by the backend).
  const saveOrgEdit = async () => {
    if (orgDraft.size === 0) {
      cancelOrgEdit();
      showFlash("ok", "No changes to save");
      return;
    }
    setOrgSaving(true);
    try {
      const ops = [...orgDraft.entries()].map(([addressId, dept]) =>
        fetch(`/api/mail-center/addresses/${addressId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignedDept: dept === "Unassigned" ? "" : dept,
          }),
        }),
      );
      const results = await Promise.all(ops);
      const failed = results.filter((r) => !r.ok).length;
      invalidateCachePrefix("/api/mail-center/addresses");
      refreshAddressesHook();
      if (failed > 0) {
        showFlash(
          "err",
          `${ops.length - failed} move(s) saved, ${failed} failed. Review and retry.`,
        );
      } else {
        showFlash("ok", `Org chart saved (${ops.length} move(s))`);
        cancelOrgEdit();
      }
    } catch (err) {
      showFlash(
        "err",
        humanizeError(err, "Couldn't save the org chart. Please retry."),
      );
    } finally {
      setOrgSaving(false);
    }
  };

  const activeAddresses = useMemo(
    () => (addressesResp ?? []).filter((a) => a.active),
    [addressesResp],
  );

  // ---------- View-level (L1/L2/L3) helpers --------------------------------
  // The owner frames the three mailbox view levels as L1 / L2 / L3:
  //   • L1 Personal   — the user's OWN mailbox(es) + any shared mailbox
  //                     explicitly granted to them in the matrix below.
  //   • L2 Department — L1 PLUS every active @hookka.com mailbox in the user's
  //                     OWN department (the dept on their alias). No dept on
  //                     file ⇒ effectively L1.
  //   • L3 Company    — every active @hookka.com mailbox in the company.
  // These mirror getMailScope() in src/api/routes/mail-center.ts exactly, so
  // the "which mailboxes does this resolve to" peek matches what the server
  // actually serves that user in Mail Center.
  const LEVEL_META: Record<
    string,
    { code: string; name: string; blurb: string }
  > = {
    personal: {
      code: "L1",
      name: "Personal",
      blurb: "Own mailbox + any shared mailbox granted below",
    },
    department: {
      code: "L2",
      name: "Department",
      blurb: "Their department's mailboxes",
    },
    company: { code: "L3", name: "Company", blurb: "All company mailboxes" },
  };
  const levelTag = (level: string): string => {
    const m = LEVEL_META[level];
    return m ? `${m.code} ${m.name}` : level;
  };

  // Resolve the concrete @hookka.com addresses a given user sees at a given
  // level — the same set getMailScope computes server-side. Returns sorted,
  // de-duplicated addresses so the peek popover lists exactly what they'd get.
  const resolveScopeAddresses = useCallback(
    (u: UserRow, level: string): string[] => {
      const set = new Set<string>();
      if (level === "company") {
        for (const a of activeAddresses) set.add(a.address.toLowerCase());
        return [...set].sort();
      }
      // L1 base: own assigned alias(es) + granted shared mailboxes.
      for (const a of activeAddresses) {
        if (a.assignedUserId === u.id) set.add(a.address.toLowerCase());
      }
      const ownAlias = aliasByUserId.get(u.id);
      if (ownAlias?.active) set.add(ownAlias.address.toLowerCase());
      for (const a of activeAddresses) {
        if (serverGrants.has(`${a.id}::${u.id}`))
          set.add(a.address.toLowerCase());
      }
      // L2 adds the user's own department's active mailboxes.
      if (level === "department") {
        const dept = (ownAlias?.assignedDept || "").trim();
        if (dept) {
          for (const a of activeAddresses) {
            if ((a.assignedDept || "").trim() === dept)
              set.add(a.address.toLowerCase());
          }
        }
      }
      return [...set].sort();
    },
    [activeAddresses, aliasByUserId, serverGrants],
  );

  // Which user's mailbox-scope is currently expanded in the peek popover
  // (Mailbox Access tab). Null = none open. Keyed by user id.
  const [scopePeekUserId, setScopePeekUserId] = useState<string | null>(null);

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

  // Save the Edit-details modal. Branches on whether the user already has an
  // alias: PATCH the existing row's Department / Position (and repair a
  // floating assigned_user_id), else POST a brand-new address. Either way we
  // invalidate + refetch /addresses so the new/changed alias appears in the
  // grid immediately (the owner's "created an alias but it still says Add
  // alias" was a stale-cache + floating-link miss).
  const submitAlias = async () => {
    if (!aliasForUser) return;
    const target = aliasForUser;
    setAliasError(null);
    setAliasSubmitting(true);

    // ---- EDIT path: user already has an alias → PATCH dept/position (+link) --
    if (aliasExisting) {
      try {
        // Only send fields that actually changed (keeps the PATCH minimal),
        // but ALWAYS write assigned_user_id when the alias was floating /
        // heuristically matched so the explicit link becomes the source of
        // truth (#4). assignedDept now persists thanks to the mail-center.ts
        // PATCH gap fix.
        const patch: Record<string, string | undefined> = {};
        if ((aliasExisting.assignedDept || "") !== aliasDept) {
          patch.assignedDept = aliasDept;
        }
        if ((aliasExisting.assignedPosition || "") !== (aliasPosition.trim())) {
          patch.assignedPosition = aliasPosition.trim() || undefined;
        }
        if (aliasExisting.assignedUserId !== target.id) {
          // Floating / mismatched link — bind it permanently.
          patch.assignedUserId = target.id;
          patch.assignedUserName = target.displayName || target.email;
        }
        if (Object.keys(patch).length === 0) {
          setAliasForUser(null);
          setAliasExisting(null);
          showFlash("ok", "No changes to save");
          return;
        }
        const res = await fetch(
          `/api/mail-center/addresses/${aliasExisting.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        );
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.ok) {
          showFlash(
            "ok",
            `Details saved for ${aliasExisting.address}`,
          );
          setAliasForUser(null);
          setAliasExisting(null);
          fetchAddresses();
        } else {
          setAliasError(
            json.error ?? "Couldn't save the details. Please try again.",
          );
        }
      } catch (err) {
        setAliasError(humanizeError(err, "Network problem — please try again."));
      } finally {
        setAliasSubmitting(false);
      }
      return;
    }

    // ---- CREATE path: no alias yet → POST a new address --------------------
    const address = aliasAddress.trim().toLowerCase();
    if (!address || !address.includes("@")) {
      setAliasError("Enter a valid email address");
      setAliasSubmitting(false);
      return;
    }
    if (!address.endsWith("@hookka.com")) {
      setAliasError("Address must end with @hookka.com");
      setAliasSubmitting(false);
      return;
    }
    try {
      const res = await fetch("/api/mail-center/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          assignedUserId: target.id,
          assignedUserName: target.displayName || target.email,
          assignedDept: aliasDept,
          assignedPosition: aliasPosition.trim() || undefined,
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
        setAliasExisting(null);
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

  // Open the Edit-details modal for a user. Prefills from the user's existing
  // @hookka.com alias when there is one (edit mode — address locked, Dept /
  // Position editable); otherwise seeds a create with a suggested address.
  const openAliasModal = (u: UserRow) => {
    const existing = aliasByUserId.get(u.id) ?? null;
    setAliasForUser(u);
    setAliasExisting(existing);
    setAliasAddress(existing ? existing.address : suggestAlias(u));
    setAliasDept(existing?.assignedDept || "Support");
    setAliasPosition(existing?.assignedPosition || "");
    setAliasError(null);
  };

  // One-click "Link" for a floating alias whose local-part matches this user
  // but whose assigned_user_id is empty / stale (#4). Writes the real
  // assigned_user_id so the explicit link becomes the source of truth, then
  // refetches so the column flips from "(matched by name) · Link" to the solid
  // assigned chip. Used straight from the Email Alias cell — no modal needed.
  const [linkingAliasId, setLinkingAliasId] = useState<string | null>(null);
  const linkAliasToUser = async (alias: MailAddress, u: UserRow) => {
    setLinkingAliasId(alias.id);
    try {
      const res = await fetch(`/api/mail-center/addresses/${alias.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignedUserId: u.id,
          assignedUserName: u.displayName || u.email,
        }),
      });
      if (res.ok) {
        showFlash("ok", `Linked ${alias.address} to ${u.email}`);
        fetchAddresses();
      } else {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        showFlash("err", json.error ?? "Couldn't link the alias. Please retry.");
      }
    } catch (err) {
      showFlash("err", humanizeError(err, "Network problem — please try again."));
    } finally {
      setLinkingAliasId(null);
    }
  };

  // ---------- Active Users grid columns ------------------------------------
  // Migrated off the hand-rolled <table> onto the shared DataGrid so the owner
  // gets the Column chooser + per-column Filter + Sort + drag-reorder/resize +
  // freeze "for free" (gridId persists his layout per browser). Position /
  // Department / Email Alias are computed from each user's @hookka.com alias
  // (aliasByUserId) — those columns therefore supply an explicit `render`
  // PLUS `sortAccessor` / `filterAccessor` so sort + the value-filter dropdown
  // read the visible (alias-derived) value, not the absent row field.
  const userColumns = useMemo<Column<UserRow>[]>(() => [
    {
      key: "email",
      label: "Email",
      type: "text",
      width: "240px",
      sortable: true,
      sticky: true, // frozen so it stays put during horizontal scroll
      render: (_v, u, _i, hl) => (
        <span className="inline-flex items-center gap-2">
          <span className="font-medium">{hl(u.email)}</span>
          {u.id === currentUser?.id && (
            <span className="text-[10px] font-semibold uppercase tracking-wider bg-[#6B5C32]/10 text-[#6B5C32] px-2 py-0.5 rounded">
              You
            </span>
          )}
        </span>
      ),
    },
    {
      key: "displayName",
      label: "Name",
      type: "text",
      width: "150px",
      sortable: true,
      render: (_v, u, _i, hl) =>
        u.displayName ? hl(u.displayName) : <span className="text-gray-400">—</span>,
    },
    {
      key: "role",
      label: "Role",
      type: "text",
      width: "120px",
      sortable: true,
      render: (_v, u) => (
        <span className="text-xs font-semibold uppercase tracking-wider text-[#6B5C32]">
          {u.role}
        </span>
      ),
    },
    {
      key: "isActive",
      label: "Status",
      type: "text",
      width: "100px",
      sortable: true,
      // Sort + filter on a human label ("Active" / "Disabled") rather than the
      // raw boolean (which the dropdown would show as "true" / "false").
      sortAccessor: (u) => (u.isActive ? "Active" : "Disabled"),
      filterAccessor: (u) => (u.isActive ? "Active" : "Disabled"),
      render: (_v, u) =>
        u.isActive ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium bg-[#EEF3E4] text-[#4F7C3A] px-2 py-0.5 rounded-full">
            <Check className="h-3 w-3" /> Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium bg-[#F0ECE9] text-[#6B7280] px-2 py-0.5 rounded-full">
            <Ban className="h-3 w-3" /> Disabled
          </span>
        ),
    },
    {
      key: "position",
      label: "Position",
      type: "text",
      width: "140px",
      sortable: true,
      sortAccessor: (u) => aliasByUserId.get(u.id)?.assignedPosition || "",
      filterAccessor: (u) => aliasByUserId.get(u.id)?.assignedPosition || "—",
      render: (_v, u, _i, hl) => {
        const pos = aliasByUserId.get(u.id)?.assignedPosition;
        return pos ? (
          <span className="text-gray-700">{hl(pos)}</span>
        ) : (
          <span className="text-gray-400">—</span>
        );
      },
    },
    {
      key: "department",
      label: "Department",
      type: "text",
      width: "130px",
      sortable: true,
      sortAccessor: (u) => aliasByUserId.get(u.id)?.assignedDept || "",
      filterAccessor: (u) => aliasByUserId.get(u.id)?.assignedDept || "—",
      render: (_v, u) => {
        const dept = aliasByUserId.get(u.id)?.assignedDept;
        return dept ? (
          <span className="inline-flex items-center text-xs font-medium bg-[#EFEAE5] text-[#6B5C32] px-2 py-0.5 rounded">
            {dept}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        );
      },
    },
    {
      key: "emailAlias",
      label: "Email Alias",
      type: "text",
      width: "210px",
      sortable: true,
      sortAccessor: (u) => aliasByUserId.get(u.id)?.address || "",
      filterAccessor: (u) => aliasByUserId.get(u.id)?.address || "(none)",
      render: (_v, u) => {
        const alias = aliasByUserId.get(u.id);
        if (alias) {
          // Heuristic-only match (assigned_user_id is NOT this user): show the
          // address + a one-click Link to write the real assigned_user_id and
          // make the link the source of truth.
          const heuristic = aliasIsHeuristic(u, alias);
          return (
            <span className="inline-flex items-center gap-1.5">
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
              {heuristic && canManageUsers && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    linkAliasToUser(alias, u);
                  }}
                  disabled={linkingAliasId === alias.id}
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-[#6B5C32] hover:underline disabled:opacity-50"
                  title="Matched by name only — click to permanently link this alias (writes assigned_user_id)"
                >
                  {linkingAliasId === alias.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Link2 className="h-3 w-3" />
                  )}
                  Link
                </button>
              )}
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
            onClick={(e) => {
              e.stopPropagation();
              openAliasModal(u);
            }}
            title="Create @hookka.com alias"
          >
            <AtSign className="h-3.5 w-3.5 mr-1" />
            Add alias
          </Button>
        );
      },
    },
    {
      key: "lastLoginAt",
      label: "Last Login",
      type: "text",
      width: "150px",
      sortable: true,
      // Keep the date+TIME display (DefaultCellRenderer's "date" type drops the
      // time). Sort on the raw ISO so ordering stays chronological.
      sortAccessor: (u) => u.lastLoginAt || "",
      render: (_v, u) => <span className="text-gray-600">{fmtDateTime(u.lastLoginAt)}</span>,
    },
    {
      key: "createdAt",
      label: "Created",
      type: "text",
      width: "150px",
      sortable: true,
      sortAccessor: (u) => u.createdAt || "",
      render: (_v, u) => <span className="text-gray-600">{fmtDateTime(u.createdAt)}</span>,
    },
    {
      key: "actions",
      label: "Actions",
      type: "text",
      width: "200px",
      align: "right",
      sortable: false, // a button row has nothing to sort on
      noClip: true, // row of buttons must not be clipped/ellipsized
      render: (_v, u) =>
        canManageUsers ? (
          <div className="inline-flex gap-1">
            {/* Edit details — Position / Department / Email Alias (Edit→Save,
                no naked edits): opens the modal, never auto-saves. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                openAliasModal(u);
              }}
              title="Edit details (position, department, email alias)"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </Button>
            {/* Change role — kept separate because a role change ends the
                user's session (security action). */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setEditRoleForUser(u);
                setEditRole(u.role);
                setEditRoleError(null);
              }}
              title="Change role"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                toggleActive(u);
              }}
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
              onClick={(e) => {
                e.stopPropagation();
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
              onClick={(e) => {
                e.stopPropagation();
                deleteUser(u);
              }}
              title="Delete"
              disabled={u.id === currentUser?.id}
            >
              <Trash2 className="h-3.5 w-3.5 text-red-600" />
            </Button>
          </div>
        ) : (
          <span className="text-xs text-[#9C8F7A]">Super Admin only</span>
        ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [aliasByUserId, canManageUsers, currentUser?.id, linkingAliasId]);

  // ---------- Render -------------------------------------------------------

  const TABS: TabItem<TabKey>[] = [
    { key: "users", label: "Users", count: users.length },
    { key: "org", label: "Org Chart" },
    ...(canManageUsers && activeAddresses.length > 0
      ? [{ key: "mailbox" as TabKey, label: "Mailbox Access" }]
      : []),
  ];

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

      {/* Tab bar — Users / Org Chart / Mailbox Access (mirrors the Products
          top-level toggle via the shared Tabs component). */}
      <Tabs<TabKey> tabs={TABS} value={tab} onChange={setTab} />

      {/* =========================================================== */}
      {/* TAB: USERS — Active Users + Pending Invites + Send Invite    */}
      {/* =========================================================== */}
      {tab === "users" && (
        <>
          {/* ----- Active Users ----- */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <UsersIcon className="h-5 w-5 text-[#6B5C32]" />
                <div>
                  <CardTitle>Active Users</CardTitle>
                  <CardDescription>
                    {/* Cache-first: only say "Loading…" on a genuine cold first
                        load (no cached users yet). Once any data is cached the
                        count shows instantly — no spinner flash over usable
                        data. (owner: "不要有 Loading".) */}
                    {loadingUsers && users.length === 0
                      ? "Loading…"
                      : `${users.length} user(s) total`}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Shared DataGrid — the same grid the rest of the app uses, so
                  the owner gets the Column chooser (show/hide), per-column
                  Filter + Sort, drag-reorder/resize, and a frozen Email column
                  for free. His layout persists per browser via gridId.
                  `loading` is gated on an EMPTY cache so cached rows paint
                  instantly (no blocking skeleton over data we already have);
                  the skeleton only shows on the very first cold load. */}
              <DataGrid<UserRow>
                columns={userColumns}
                data={users}
                keyField="id"
                loading={loadingUsers && users.length === 0}
                stickyHeader
                gridId="user-management-users"
                emptyMessage="No users yet"
                maxHeight="calc(100vh - 320px)"
              />
            </CardContent>
          </Card>

          {/* ----- Pending Invites ----- */}
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

          {/* ----- Send New Invite — Super Admin only (POST /invite is gated
              by requireSuperAdmin). An Admin never sees the form. ----- */}
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
        </>
      )}

      {/* =========================================================== */}
      {/* TAB: ORG CHART                                               */}
      {/* =========================================================== */}
      {tab === "org" && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <UsersIcon className="h-5 w-5 text-[#6B5C32]" />
                <div>
                  <CardTitle>Org Chart</CardTitle>
                  <CardDescription>
                    Active staff grouped by department, then position.
                    {canManageUsers ? (
                      <>
                        {" "}
                        Click <strong>Edit layout</strong>, then{" "}
                        <strong>drag a person card</strong> into another
                        department column to move them. Changes apply only after
                        you click Save.
                      </>
                    ) : (
                      <>
                        {" "}
                        Department and position come from each person&apos;s
                        @hookka.com alias.
                      </>
                    )}
                  </CardDescription>
                </div>
              </div>
              {/* Edit layout / Save / Cancel — Super Admin only (the dept lives
                  on the alias row; PATCH /addresses is requireSuperAdmin).
                  Mirrors the Mailbox Access bar: read-only until Edit, Save
                  commits every queued drag, no naked edits. */}
              {canManageUsers && (
                <div className="flex shrink-0 gap-2">
                  {!orgEdit ? (
                    <Button variant="outline" size="sm" onClick={beginOrgEdit}>
                      <Pencil className="h-3.5 w-3.5" />
                      Edit layout
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={cancelOrgEdit}
                        disabled={orgSaving}
                      >
                        <X className="h-3.5 w-3.5" />
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={saveOrgEdit}
                        disabled={orgSaving}
                      >
                        {orgSaving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        {orgSaving
                          ? "Saving…"
                          : orgDraft.size > 0
                            ? `Save (${orgDraft.size})`
                            : "Save"}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {orgChart.size === 0 && !orgEdit ? (
              <div className="rounded-lg border border-dashed border-[#D6D0C8] bg-[#FAFAF9] py-10 text-center">
                <UsersIcon className="mx-auto mb-2 h-7 w-7 text-[#C4BBA9]" />
                <div className="text-sm font-medium text-[#6B7280]">
                  No staff placed on the org chart yet
                </div>
                <div className="mx-auto mt-1 max-w-md text-xs text-gray-500">
                  People appear here once they have a{" "}
                  <strong>Department</strong> set.{" "}
                  {canManageUsers ? (
                    <>
                      Click <strong>Edit layout</strong> and drag each person
                      into a department column (Support / Finance / HR), or use{" "}
                      <SlidersHorizontal className="inline h-3 w-3 -mt-0.5" />{" "}
                      Edit details on the Users tab.
                    </>
                  ) : (
                    <>
                      Ask a Super Admin to assign departments from the Org Chart
                      or the Users tab.
                    </>
                  )}
                </div>
              </div>
            ) : (
              <>
                {/* Edit-mode banner: only people WITH a @hookka.com alias can be
                    dragged (the dept is stored on that alias row). Unaliased
                    staff show a hint to create an alias first. */}
                {orgEdit && (
                  <div className="mb-4 rounded-md border border-[#CFE0F3] bg-[#F2F7FD] px-3 py-2 text-xs text-[#2C5B8F]">
                    <GripVertical className="mr-1 inline h-3.5 w-3.5 -mt-0.5" />
                    Drag a person card onto a department column to move them.
                    Only staff with a @hookka.com alias can be moved — create one
                    with{" "}
                    <SlidersHorizontal className="inline h-3 w-3 -mt-0.5" /> Edit
                    details on the Users tab first.
                  </div>
                )}
                {/* When everyone is still Unassigned (no depts entered) and not
                    editing, make the path obvious — the owner's "unusable"
                    state. */}
                {!orgEdit &&
                  orgDepts.length === 1 &&
                  orgDepts[0] === "Unassigned" && (
                    <div className="mb-4 rounded-md border border-[#EAD9A8] bg-[#FBF6E7] px-3 py-2 text-xs text-[#8A6D1E]">
                      Everyone is <strong>Unassigned</strong> because no
                      departments have been set yet. Click{" "}
                      <strong>Edit layout</strong> and drag each person into a
                      department column — they&apos;ll stay there after you Save.
                    </div>
                  )}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {orgDepts.map((dept) => {
                    const posMap = orgChart.get(dept);
                    const count = posMap
                      ? [...posMap.values()].reduce((s, arr) => s + arr.length, 0)
                      : 0;
                    const isUnassigned = dept === "Unassigned";
                    const isDropTarget = orgEdit && orgDropDept === dept;
                    // Position groups: real positions first (A–Z), the "—"
                    // (no position) bucket last so named roles lead.
                    const posEntries = posMap
                      ? [...posMap.entries()].sort((a, b) => {
                          if (a[0] === "—") return 1;
                          if (b[0] === "—") return -1;
                          return a[0].localeCompare(b[0]);
                        })
                      : [];
                    return (
                      <div
                        key={dept}
                        // The whole column is a drop zone in edit mode.
                        onDragOver={
                          orgEdit
                            ? (e) => {
                                e.preventDefault();
                                if (orgDropDept !== dept) setOrgDropDept(dept);
                              }
                            : undefined
                        }
                        onDragLeave={
                          orgEdit
                            ? (e) => {
                                // Only clear when the pointer actually leaves the
                                // column (not when moving between child cards).
                                if (
                                  !e.currentTarget.contains(
                                    e.relatedTarget as Node | null,
                                  )
                                )
                                  setOrgDropDept((d) => (d === dept ? null : d));
                              }
                            : undefined
                        }
                        onDrop={
                          orgEdit
                            ? (e) => {
                                e.preventDefault();
                                const uid = e.dataTransfer.getData("text/plain");
                                const u = users.find((x) => x.id === uid);
                                if (u) dropOnDept(u, dept);
                              }
                            : undefined
                        }
                        className={
                          "overflow-hidden rounded-lg border transition-colors " +
                          (isDropTarget
                            ? "border-[#6B5C32] ring-2 ring-[#6B5C32]/40 bg-[#F7F4EC]"
                            : isUnassigned
                              ? "border-[#EAD9A8] bg-[#FCFAF3]"
                              : "border-[#E5E7EB] bg-white")
                        }
                      >
                        {/* Department header band */}
                        <div
                          className={
                            "flex items-center justify-between px-3 py-2 " +
                            (isUnassigned ? "bg-[#F6EFD9]" : "bg-[#EFEAE5]")
                          }
                        >
                          <h3
                            className={
                              "text-sm font-semibold " +
                              (isUnassigned
                                ? "text-[#8A6D1E]"
                                : "text-[#5A4D2A]")
                            }
                          >
                            {dept}
                          </h3>
                          <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold text-[#6B5C32]">
                            {count} {count === 1 ? "person" : "people"}
                          </span>
                        </div>
                        <div className="space-y-3 p-3">
                          {count === 0 && (
                            <div
                              className={
                                "rounded-md border border-dashed px-2 py-4 text-center text-[10px] " +
                                (isDropTarget
                                  ? "border-[#6B5C32] text-[#6B5C32]"
                                  : "border-[#E0DAD0] text-[#A98F4E]")
                              }
                            >
                              {orgEdit
                                ? "Drop a person here"
                                : isUnassigned
                                  ? "No department set"
                                  : "No one here yet"}
                            </div>
                          )}
                          {posEntries.map(([pos, members]) => (
                            <div key={pos}>
                              <div className="mb-1 flex items-center gap-2">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-[#9CA3AF]">
                                  {pos === "—" ? "No position" : pos}
                                </span>
                                <span className="text-[10px] text-[#C4BBA9]">
                                  {members.length}
                                </span>
                                <span className="h-px flex-1 bg-[#F0ECE9]" />
                              </div>
                              <div className="space-y-1">
                                {members.map((m) => {
                                  const name = m.displayName || m.email;
                                  const initials = name
                                    .trim()
                                    .split(/\s+/)
                                    .slice(0, 2)
                                    .map((p) => p[0]?.toUpperCase() ?? "")
                                    .join("");
                                  const alias = aliasByUserId.get(m.id);
                                  const canDrag = orgEdit && !!alias;
                                  const dragging =
                                    orgDragId === (alias?.id ?? "");
                                  const moved =
                                    !!alias && orgDraft.has(alias.id);
                                  return (
                                    <div
                                      key={m.id}
                                      draggable={canDrag}
                                      onDragStart={
                                        canDrag
                                          ? (e) => {
                                              e.dataTransfer.setData(
                                                "text/plain",
                                                m.id,
                                              );
                                              e.dataTransfer.effectAllowed =
                                                "move";
                                              setOrgDragId(alias!.id);
                                            }
                                          : undefined
                                      }
                                      onDragEnd={
                                        canDrag
                                          ? () => {
                                              setOrgDragId(null);
                                              setOrgDropDept(null);
                                            }
                                          : undefined
                                      }
                                      title={
                                        orgEdit && !alias
                                          ? "No @hookka.com alias — create one on the Users tab to place this person"
                                          : canDrag
                                            ? "Drag to another department"
                                            : undefined
                                      }
                                      className={
                                        "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-opacity " +
                                        (dragging
                                          ? "opacity-40 "
                                          : "opacity-100 ") +
                                        (moved
                                          ? "border-[#6B5C32] bg-[#F7F4EC] "
                                          : "border-[#E5E7EB] bg-white ") +
                                        (canDrag
                                          ? "cursor-grab active:cursor-grabbing"
                                          : orgEdit
                                            ? "cursor-not-allowed opacity-60"
                                            : "")
                                      }
                                    >
                                      {canDrag && (
                                        <GripVertical className="h-3.5 w-3.5 shrink-0 text-[#C4BBA9]" />
                                      )}
                                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#EFEAE5] text-[10px] font-semibold text-[#6B5C32]">
                                        {initials || "?"}
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate text-xs font-medium text-[#111827]">
                                          {m.displayName || m.email}
                                        </div>
                                        <div className="truncate text-[10px] text-[#9CA3AF]">
                                          {m.email}
                                        </div>
                                      </div>
                                      {moved && (
                                        <span className="shrink-0 rounded bg-[#6B5C32]/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#6B5C32]">
                                          Moved
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* =========================================================== */}
      {/* TAB: MAILBOX ACCESS (SUPER_ADMIN) — Edit→Save, no naked edits */}
      {/* =========================================================== */}
      {tab === "mailbox" && canManageUsers && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <AtSign className="h-5 w-5 text-[#6B5C32]" />
                <div>
                  <CardTitle>Mailbox Access</CardTitle>
                  <CardDescription>
                    Who can open which @hookka.com mailbox in Mail Center. A
                    user always has their own alias (locked ✓); tick a shared
                    mailbox (support@ / hr@ / finance@) to let them work that
                    inbox too.
                    <span className="mt-1 block text-[11px] text-[#9CA3AF]">
                      View level —{" "}
                      <strong className="text-[#6B7280]">L1 Personal</strong>:
                      own mailbox ·{" "}
                      <strong className="text-[#6B7280]">L2 Department</strong>:
                      their department&apos;s mailboxes ·{" "}
                      <strong className="text-[#6B7280]">L3 Company</strong>: all
                      mailboxes. For L2 / L3, click{" "}
                      <Layers className="inline h-3 w-3 -mt-0.5" /> on the level
                      to see exactly which mailboxes that resolves to.
                    </span>
                    {mailEdit && (
                      <span className="mt-1 block text-[11px] font-medium text-[#6B5C32]">
                        Editing — changes apply only after you click Save.
                      </span>
                    )}
                  </CardDescription>
                </div>
              </div>
              {/* Edit / Save / Cancel — mirrors the Products SKU-Master bar.
                  Read-only until Edit; Save commits every changed cell. */}
              <div className="flex shrink-0 gap-2">
                {!mailEdit ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={beginMailEdit}
                    disabled={activeAddresses.length === 0}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={cancelMailEdit}
                      disabled={mailSaving}
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={saveMailEdit}
                      disabled={mailSaving}
                    >
                      {mailSaving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      {mailSaving ? "Saving…" : "Save"}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[#6B7280] border-b border-[#E5E7EB]">
                      User
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[#6B7280] border-b border-[#E5E7EB] whitespace-nowrap">
                      View level
                    </th>
                    {activeAddresses.map((a) => (
                      <th
                        key={a.id}
                        className="px-2 py-2 text-center text-[11px] font-medium text-[#374151] border-b border-[#E5E7EB] whitespace-nowrap"
                        title={
                          `Mailbox: ${a.address}` +
                          (a.assignedDept ? ` (${a.assignedDept})` : "") +
                          (a.assignedUserName
                            ? ` — assigned to ${a.assignedUserName}`
                            : "") +
                          ". Tick a row to let that user open this mailbox in Mail Center."
                        }
                      >
                        {/* Show the FULL address, not just the truncated local-
                            part (the owner saw a bare "lim" and couldn't tell
                            which mailbox it was — owner 2026-06-17). Local-part
                            is emphasised; the @hookka.com domain trails in a
                            lighter shade. The tooltip spells out the full
                            address + who it's assigned to. */}
                        <div className="font-semibold">
                          {a.address.split("@")[0]}
                          <span className="font-normal text-[#9CA3AF]">
                            @{a.address.split("@")[1] ?? "hookka.com"}
                          </span>
                        </div>
                        {a.assignedDept && (
                          <div className="text-[9px] uppercase text-[#9CA3AF]">
                            {a.assignedDept}
                          </div>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users
                    .filter((u) => u.isActive)
                    .map((u) => {
                      const alias = aliasByUserId.get(u.id);
                      const heuristic = aliasIsHeuristic(u, alias);
                      const linkedTo = alias ? draftLinks.get(alias.id) : undefined;
                      return (
                        <tr key={u.id} className="hover:bg-[#F9FAFB]">
                          <td className="sticky left-0 z-10 bg-white px-3 py-1.5 border-b border-[#F3F4F6] whitespace-nowrap">
                            <div className="font-medium text-[#111827]">
                              {u.displayName || u.email}
                            </div>
                            <div className="text-[10px] text-[#9CA3AF]">
                              {u.email}
                            </div>
                            {/* Floating-alias repair: when this user's alias is
                                matched only by the local-part heuristic (its
                                assigned_user_id is NOT this user), offer a Link
                                action in edit mode that PATCHes the real
                                assigned_user_id on Save. */}
                            {alias && heuristic && (
                              <div className="mt-0.5">
                                {mailEdit ? (
                                  linkedTo === u.id ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#4F7C3A]">
                                      <Link2 className="h-3 w-3" />
                                      Will link {alias.address} on Save
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setDraftLinks((prev) =>
                                          new Map(prev).set(alias.id, u.id),
                                        )
                                      }
                                      className="inline-flex items-center gap-1 text-[10px] font-medium text-[#6B5C32] hover:underline"
                                      title={`Permanently link ${alias.address} to this user (writes assigned_user_id)`}
                                    >
                                      <Link2 className="h-3 w-3" />
                                      Link {alias.address}
                                    </button>
                                  )
                                ) : (
                                  <span
                                    className="inline-flex items-center gap-1 text-[10px] text-[#B45309]"
                                    title="Alias matched by name only — its assigned_user_id is not set. Click Edit to link it permanently."
                                  >
                                    <Link2 className="h-3 w-3" />
                                    {alias.address} (matched by name)
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-1.5 border-b border-[#F3F4F6] align-top whitespace-nowrap">
                            {(() => {
                              const level = viewLevelFor(u.id);
                              const resolved = resolveScopeAddresses(u, level);
                              // The peek is meaningful at L2 / L3 (L1 is just
                              // "their own + granted" already visible as the
                              // ticked columns). Always allow it though, so the
                              // operator can confirm L1 resolves to nothing
                              // surprising.
                              const peekOpen = scopePeekUserId === u.id;
                              return (
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center gap-1.5">
                                    <select
                                      value={level}
                                      disabled={!mailEdit}
                                      onChange={(e) =>
                                        draftSetLevel(u.id, e.target.value)
                                      }
                                      title="How wide this user's Mail Center inbox is (L1 own · L2 department · L3 company)"
                                      className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 py-1 text-xs text-[#1F1D1B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] disabled:bg-[#F5F4F2] disabled:text-[#6B7280] disabled:cursor-not-allowed"
                                    >
                                      <option value="personal">
                                        L1 · Personal
                                      </option>
                                      <option value="department">
                                        L2 · Department
                                      </option>
                                      <option value="company">
                                        L3 · Company
                                      </option>
                                    </select>
                                    {/* Peek: expand the concrete mailbox list
                                        this level resolves to (mirrors the
                                        server's getMailScope). */}
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setScopePeekUserId((cur) =>
                                          cur === u.id ? null : u.id,
                                        )
                                      }
                                      title={
                                        peekOpen
                                          ? "Hide resolved mailboxes"
                                          : `Show the ${resolved.length} mailbox(es) ${levelTag(level)} resolves to`
                                      }
                                      className={
                                        "inline-flex h-8 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors " +
                                        (peekOpen
                                          ? "border-[#6B5C32] bg-[#6B5C32]/10 text-[#6B5C32]"
                                          : "border-[#E2DDD8] text-[#6B7280] hover:border-[#6B5C32] hover:text-[#6B5C32]")
                                      }
                                    >
                                      <Layers className="h-3 w-3" />
                                      {resolved.length}
                                      {peekOpen ? (
                                        <ChevronDown className="h-3 w-3" />
                                      ) : (
                                        <ChevronRight className="h-3 w-3" />
                                      )}
                                    </button>
                                  </div>
                                  {peekOpen && (
                                    <div className="rounded-md border border-[#E5E7EB] bg-[#FAFAF9] p-2">
                                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#9CA3AF]">
                                        {levelTag(level)} resolves to
                                      </div>
                                      {resolved.length === 0 ? (
                                        <div className="text-[11px] italic text-[#9CA3AF]">
                                          No mailboxes
                                          {level === "department"
                                            ? " — this user has no department on their alias, so L2 falls back to L1."
                                            : "."}
                                        </div>
                                      ) : (
                                        <ul className="space-y-0.5">
                                          {resolved.map((addr) => (
                                            <li
                                              key={addr}
                                              className="flex items-center gap-1 text-[11px] text-[#374151]"
                                            >
                                              <AtSign className="h-3 w-3 shrink-0 text-[#9CA3AF]" />
                                              <span className="truncate">
                                                {addr}
                                              </span>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          {activeAddresses.map((a) => {
                            const isPersonal = a.assignedUserId === u.id;
                            const granted = isGranted(a.id, u.id);
                            const on = isPersonal || granted;
                            return (
                              <td
                                key={a.id}
                                className="px-2 py-1.5 text-center border-b border-[#F3F4F6]"
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  disabled={isPersonal || !mailEdit}
                                  onChange={() =>
                                    draftToggleGrant(a.id, u.id, !granted)
                                  }
                                  title={
                                    isPersonal
                                      ? "Their own mailbox (always accessible)"
                                      : !mailEdit
                                        ? granted
                                          ? "Has access — click Edit to change"
                                          : "No access — click Edit to change"
                                        : granted
                                          ? "Click to revoke access"
                                          : "Click to grant access"
                                  }
                                  className="h-4 w-4 rounded border-[#D1D5DB] text-[#6B5C32] focus:ring-[#6B5C32] disabled:opacity-50 disabled:cursor-not-allowed"
                                />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
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
      {/* Edit-details modal — the user's @hookka.com Email Alias, Department
          and Position (all stored on the email_addresses alias row).
          SUPER_ADMIN only (POST/PATCH /api/mail-center/addresses are gated by
          requireSuperAdmin). Edit→Save, no naked edits.
            • No alias yet  → Save POSTs a new address.
            • Has an alias  → address is LOCKED (PATCH can't rename an address —
              that's a delete + recreate); Department / Position save via PATCH.
          The address is an in-ERP record that receives mail in the Mail Center
          once the domain MX points at Cloudflare Email Routing — NOT a Gmail
          login. */}
      {/* =========================================================== */}
      {aliasForUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => {
            if (!aliasSubmitting) {
              setAliasForUser(null);
              setAliasExisting(null);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-[#1F1D1B] flex items-center gap-2">
              {aliasExisting ? (
                <SlidersHorizontal className="h-5 w-5 text-[#6B5C32]" />
              ) : (
                <AtSign className="h-5 w-5 text-[#6B5C32]" />
              )}
              {aliasExisting ? "Edit details" : "Create email alias"}
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              {aliasExisting ? (
                <>
                  Set the <strong>department</strong> and{" "}
                  <strong>position</strong> for{" "}
                  <strong>{aliasForUser.email}</strong>. These are stored on
                  their @hookka.com mailbox and feed the org chart.
                </>
              ) : (
                <>
                  Create a <strong>@hookka.com</strong> address for{" "}
                  <strong>{aliasForUser.email}</strong>, and set its department
                  and position. Mail to and from it shows up in the Mail Center.
                  This is a company address received into the ERP — not a
                  separate Gmail login.
                </>
              )}
            </p>
            <div className="mt-4 space-y-2">
              <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
                Email alias
              </label>
              <div className="relative">
                <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                <Input
                  type="email"
                  autoFocus={!aliasExisting}
                  value={aliasAddress}
                  onChange={(e) => setAliasAddress(e.target.value)}
                  placeholder="name@hookka.com"
                  className="pl-9 disabled:bg-[#F5F4F2] disabled:text-[#6B7280] disabled:cursor-not-allowed"
                  autoComplete="off"
                  // Address is immutable once the alias exists — PATCH has no
                  // way to rename it (that's a delete + recreate). Editing here
                  // is only for the create path.
                  disabled={!!aliasExisting}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitAlias();
                  }}
                />
              </div>
              <p className="text-xs text-gray-500">
                {aliasExisting
                  ? "The address can't be changed after creation. To use a different address, delete this alias and create a new one."
                  : "Must end with @hookka.com. Edit the suggestion if needed."}
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
                {DEPT_OPTIONS.filter((d) => d !== "Support").map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
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
                onClick={() => {
                  setAliasForUser(null);
                  setAliasExisting(null);
                }}
                disabled={aliasSubmitting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={submitAlias}
                disabled={
                  aliasSubmitting || (!aliasExisting && !aliasAddress.trim())
                }
              >
                {aliasSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                {aliasExisting ? "Save" : "Create alias"}
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
