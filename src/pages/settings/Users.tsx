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
import {
  ROLE_OPTIONS,
  roleShort,
  roleLabel,
  suggestedRoleForDepartment,
} from "@/lib/role-labels";
import { appOrigin } from "@/lib/app-origin";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { OrgChart } from "@/components/org-chart";
import { humanizeError } from "@/lib/humanize-error";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";
import { UserDetailDrawer, type DrawerUser } from "@/components/user-detail-drawer";
import { AddUserDrawer } from "@/components/add-user-drawer";
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
import { useConfirm } from "@/components/ui/confirm-dialog";
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


// ---------- Org Chart taxonomy (mirrors Houzs-Century) ---------------------
// The Org Chart tab is a Houzs-style TABLE (Name · Department · Position ·
// Reports to), NOT a kanban — owner kept asking for "like Houzs ERP". This
// mirrors AdminUsersPage.tsx's POSITIONS_BY_DEPARTMENT (lines 17-23): the
// chosen Department scopes the Position dropdown. These are sensible
// furniture-factory roles for HOOKKA (Production / Sales / Office / Warehouse /
// Management) and stay free-text on the user row, so the list can be extended
// later without a migration. ORG_DEPARTMENTS drives the Department <select>.
// Owner 2026-08-01. Every FACTORY employee (the `workers` table) sits under
// Production regardless of their production sub-department (Fab Cut, Framing,
// …) — that split is a costing dimension, not a reporting line. Office accounts
// pick from the rest.
const ORG_DEPARTMENTS = [
  "Management",
  "Production",
  "R&D",
  "QA",
  "Sales",
  "Office",
  "Finance",
  "HR",
  "Others",
] as const;

// Department options for an @hookka.com mailbox. ONE list, shared with the org
// chart below — the alias dialog itself says "Department … feed the org chart",
// but the two used to be different sets ("Support / Finance / HR" here versus
// "Management / Production / Sales / Office / Warehouse" there), so a person
// filed under Support could not be placed on the chart at all.
const DEPT_OPTIONS = ORG_DEPARTMENTS;


// ---------- Row types ------------------------------------------------------

type UserRow = {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  displayName: string;
  // User-level org placement (owner 2026-06-17, "這個是看 position，不需要 alias").
  // Returned by GET /api/users; the Org Chart groups on these, NOT on the
  // @hookka.com alias — so EVERY user can be placed, aliased or not. reportsTo
  // is the upline's user id ("" = none), mirroring Houzs-Century's parentId.
  department: string;
  position: string;
  reportsTo: string;
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

  // In-app confirm ([[feedback_no_naked_edits]]) — destructive actions ask
  // through this hook's dialog, never the browser's window.confirm. Render
  // {confirmDialog} once in the tree (bottom of the component).
  const { confirm, confirmDialog } = useConfirm();

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

  // Role-change state (now driven from the Edit-details modal). Role drives
  // access, so the save goes through verifiedSave — the read-back confirms the
  // role actually changed (a stale-cache 200 that didn't really re-role someone
  // is a security smell). editRole is the role draft seeded from the user's
  // current role when the Edit-details modal opens.
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
  // Employee-Master-style side panel (owner 2026-08-02:「我要做到像 employee
  // master 这样子,在旁边去做 maintenance」). Edits the USER row, so a person
  // with no @hookka.com mailbox can still be given a Department and a Position —
  // the alias-gated modal below could never reach seven of the ten accounts.
  const [drawerUser, setDrawerUser] = useState<UserRow | null>(null);
  // Create an account outright, with a password the owner hands over. The
  // invite flow stays for people who have their own company mailbox and can
  // accept for themselves.
  const [addingUser, setAddingUser] = useState(false);
  const [aliasForUser, setAliasForUser] = useState<UserRow | null>(null);
  const [aliasExisting, setAliasExisting] = useState<MailAddress | null>(null);
  const [aliasAddress, setAliasAddress] = useState("");
  // Department the mailbox is grouped under (owner 2026-06-17): HR people → HR,
  // Finance people → Finance, Operations + everyone else → Support. Posted as
  // assignedDept (the email_addresses table has an assigned_dept column).
  const [aliasDept, setAliasDept] = useState<string>("Others");
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
  // The org chart's people, ONLY so the drawer can show the real reporting line.
  // users.reports_to is the legacy column and is blank for everyone whose line
  // was set through the chart — the edges live in org_reporting, keyed
  // (source, id) so they can cross `users` and `workers`.
  const { data: orgPeopleResp, refresh: refreshOrgPeople } = useCachedJson<{
    data?: { key: string; name: string; position: string; managerKey: string | null }[];
  }>("/api/org-chart");
  const orgPeople = useMemo(() => orgPeopleResp?.data ?? [], [orgPeopleResp]);

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

  // ----- Org Chart edit state (Edit → Save, no naked edits) -----
  // REBUILT 2026-06-17 to match Houzs-Century's AdminUsersPage (the owner kept
  // asking for "like Houzs ERP"). The chart is now a TABLE — Name · Department ·
  // Position · Reports to — exactly like Houzs (AdminUsersPage.tsx lines
  // 243-300), NOT the old department kanban. It is READ-ONLY until the operator
  // clicks "Edit layout"; in edit mode each row exposes three selectors
  // (Department / Position scoped to the department / Reports-to upline) whose
  // changes accumulate in local draft maps keyed by userId. Save PUTs every
  // changed user (PUT /api/users/:id { department, position, reportsTo }) then
  // refreshes; Cancel discards. No cell ever auto-saves (no naked edits).
  //
  // Department, position and the reporting line live on the USER row (owner
  // 2026-06-17, "這個是看 position，不需要 alias"), so EVERY active user appears
  // and is editable — no @hookka.com alias required. All three read straight
  // from GET /api/users (u.department / u.position / u.reportsTo).
  const [orgEdit, setOrgEdit] = useState(false);
  // userId → target department. "Unassigned" clears the department on Save.
  const [orgDeptDraft, setOrgDeptDraft] = useState<Map<string, string>>(
    new Map(),
  );
  // userId → position (scoped to the chosen department). "" clears it.
  const [orgPosDraft, setOrgPosDraft] = useState<Map<string, string>>(
    new Map(),
  );
  // userId → upline user id ("" clears the reporting line). Mirrors Houzs's
  // Upline picker; persisted as reportsTo on PUT /api/users/:id.
  const [orgReportsDraft, setOrgReportsDraft] = useState<Map<string, string>>(
    new Map(),
  );
  const [orgSaving, setOrgSaving] = useState(false);

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

  // Active users, for the "Reports to" upline picker (a person can report to
  // any other active user; the picker excludes the person themselves).
  const activeUsers = useMemo(
    () => users.filter((u) => u.isActive),
    [users],
  );
  // Flatten the tree to a render list (depth-first) so the hierarchy block is a
  // simple indented list of rows.

  // ----- Org Chart edit handlers -----
  const beginOrgEdit = () => {
    setOrgDeptDraft(new Map());
    setOrgPosDraft(new Map());
    setOrgReportsDraft(new Map());
    setOrgEdit(true);
  };
  const cancelOrgEdit = () => {
    setOrgEdit(false);
    setOrgDeptDraft(new Map());
    setOrgPosDraft(new Map());
    setOrgReportsDraft(new Map());
  };
  // Count of distinct users with a queued change (for the Save button badge).
  const orgDraftCount = useMemo(() => {
    const ids = new Set<string>([
      ...orgDeptDraft.keys(),
      ...orgPosDraft.keys(),
      ...orgReportsDraft.keys(),
    ]);
    return ids.size;
  }, [orgDeptDraft, orgPosDraft, orgReportsDraft]);

  // Save every queued change. One PUT per changed user merging the queued
  // department / position / reportsTo; "Unassigned" clears the department (sent
  // as "" → stored NULL by the backend), "" clears position / reporting line.
  const saveOrgEdit = async () => {
    const changedIds = new Set<string>([
      ...orgDeptDraft.keys(),
      ...orgPosDraft.keys(),
      ...orgReportsDraft.keys(),
    ]);
    if (changedIds.size === 0) {
      cancelOrgEdit();
      showFlash("ok", "No changes to save");
      return;
    }
    setOrgSaving(true);
    try {
      const ops = [...changedIds].map((userId) => {
        const body: Record<string, string> = {};
        if (orgDeptDraft.has(userId)) {
          const dept = orgDeptDraft.get(userId)!;
          body.department = dept === "Unassigned" ? "" : dept;
        }
        if (orgPosDraft.has(userId)) {
          body.position = orgPosDraft.get(userId)!;
        }
        if (orgReportsDraft.has(userId)) {
          body.reportsTo = orgReportsDraft.get(userId)!;
        }
        return fetch(`/api/users/${userId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      });
      const results = await Promise.all(ops);
      const failed = results.filter((r) => !r.ok).length;
      fetchUsers();
      if (failed > 0) {
        showFlash(
          "err",
          `${ops.length - failed} change(s) saved, ${failed} failed. Review and retry.`,
        );
      } else {
        showFlash("ok", `Org chart saved (${ops.length} change(s))`);
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

  // The matrix's grant COLUMNS are SHARED mailboxes only. A personal alias (one
  // assigned to a specific user, e.g. lim@hookka.com) is that person's OWN box —
  // not something you grant others — so it must NOT appear as a column (owner
  // 2026-06-17: "那個 lim 可以移除"). Their own mailbox is already covered by
  // View Level L1. With no shared mailbox yet, the matrix is just User + View
  // level (no confusing personal-alias columns).
  const matrixMailboxes = useMemo(() => {
    // The grant matrix lists only SHARED mailboxes (support@/hr@/finance@). A
    // PERSONAL alias — one assigned to a user OR name-matched to one
    // (aliasByUserId) — is that person's own box, not something you grant, so
    // it must NOT be a column (owner "那個 lim 可以移除"). Their own mailbox is
    // already covered by View Level L1. With no shared mailbox yet, the matrix
    // is just User + View level.
    const personalIds = new Set<string>();
    for (const al of aliasByUserId.values()) if (al?.id) personalIds.add(al.id);
    return activeAddresses.filter(
      (a) => !(a.assignedUserId ?? "").trim() && !personalIds.has(a.id),
    );
  }, [activeAddresses, aliasByUserId]);

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
    if (
      !next &&
      !(await confirm({
        title: "Disable user",
        message: `Disable ${u.email}? Their sessions will be killed.`,
        confirmLabel: "Disable",
        tone: "danger",
      }))
    )
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
    if (
      !(await confirm({
        title: "Delete user",
        message: `Delete ${u.email}? Their sessions will be purged.`,
        confirmLabel: "Delete",
        tone: "danger",
      }))
    )
      return;
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

  // Apply a role change through the verifiedSave (re-confirm + read-back) path.
  // This is the SAME security-critical path the old standalone Change-role modal
  // used (confirm + self-demotion note + verifiedSave read-back); it's now
  // driven from the Edit-details modal's Save. Returns true when the role was
  // actually committed (or was a no-op), false when the operator cancelled the
  // confirm or the save failed — the caller uses this to decide whether to keep
  // the Edit-details modal open.
  const applyRoleChange = async (
    subject: UserRow,
    nextRole: string,
  ): Promise<boolean> => {
    setEditRoleError(null);
    if (nextRole === subject.role) {
      return true;
    }
    // A role change ends their current session (they re-sign-in with the new
    // access). Spell that out — and flag the self-demotion foot-gun.
    const isSelf = subject.id === currentUser?.id;
    if (
      !(await confirm({
        title: `Change ${subject.email} to ${roleLabel(nextRole)}?`,
        message: (
          <>
            <p>
              Their current session ends immediately; they sign back in with the
              new access.
            </p>
            {isSelf && (
              <p className="mt-2 font-medium text-red-600">
                This is YOUR OWN account — moving away from Super Admin signs you
                out and you may lose access to this page.
              </p>
            )}
          </>
        ),
        confirmLabel: "Change role",
        tone: "danger",
      }))
    )
      return false;
    setEditRoleSubmitting(true);
    try {
      const result = await verifiedSave<UserRow>({
        endpoint: `/api/users/${subject.id}`,
        method: "PUT",
        body: { role: nextRole },
        readback: async () => {
          const r = await fetch(`/api/users?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: UserRow[] };
          return (j?.data ?? []).find((row) => row.id === subject.id) ?? null;
        },
        expect: { role: nextRole },
      });
      if (result.ok) {
        showFlash("ok", `${subject.email} is now ${roleLabel(nextRole)}`);
        fetchUsers();
        return true;
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
      return false;
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

    /**
   * Mirror Department / Position onto the USER row.
   *
   * The bug this closes (owner 2026-08-02: 「明明我的 Department 里面是有数据的,
   * 为什么在外面呈现出来的却是空的?」): this modal wrote department and position
   * to the ALIAS (`email_addresses.assigned_dept` / `assigned_position`) only,
   * while the Users table AND the Org Chart read `users.department` /
   * `users.position` — the column comment in this very file says "Department
   * lives on the USER row now (owner 2026-06-17)". The model moved and only one
   * side was updated, so the modal showed Finance and the grid showed "—",
   * and every person landed in the org chart's Unassigned column.
   *
   * The user row is the source of truth; the alias keeps its copy because Mail
   * Center groups mailboxes by it.
   */
  async function mirrorOrgFieldsToUser(
    userId: string,
    department: string,
    position: string,
  ): Promise<void> {
    try {
      await fetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ department, position }),
      });
    } catch {
      // Best-effort: the alias write already succeeded and the operator has
      // been told so. A failure here is picked up by the backfill endpoint.
    }
  }

  // Role is changed through the SAME verifiedSave (re-confirm) path the
    // standalone Change-role modal used — only when it actually changed, so
    // dept/position-only saves stay normal (no re-confirm prompt).
    const roleChanged = editRole !== target.role;

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
        if (Object.keys(patch).length === 0 && !roleChanged) {
          setAliasForUser(null);
          setAliasExisting(null);
          showFlash("ok", "No changes to save");
          return;
        }
        // Save dept/position first (when any changed), then the role.
        if (Object.keys(patch).length > 0) {
          const res = await fetch(
            `/api/mail-center/addresses/${aliasExisting.id}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            },
          );
          const json = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!res.ok) {
            setAliasError(
              json.error ?? "Couldn't save the details. Please try again.",
            );
            return;
          }
          showFlash("ok", `Details saved for ${aliasExisting.address}`);
          fetchAddresses();
        }
        // The Users grid and the Org Chart read the USER row, not the alias.
        // Always mirror — even when the alias patch was empty, because the user
        // row may still be out of step with it.
        await mirrorOrgFieldsToUser(target.id, aliasDept, aliasPosition.trim());
        fetchUsers();
        // Apply the role change (security-critical: confirm + verifiedSave
        // read-back). Keep the modal open if it was cancelled/failed so the
        // operator sees the role error and can retry.
        if (roleChanged) {
          const roleOk = await applyRoleChange(target, editRole);
          if (!roleOk) return;
        }
        setAliasForUser(null);
        setAliasExisting(null);
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
        fetchAddresses();
        await mirrorOrgFieldsToUser(target.id, aliasDept, aliasPosition.trim());
        fetchUsers();
        // Apply the role change too (same verifiedSave re-confirm path), only
        // when it actually changed. Keep the modal open if it was
        // cancelled/failed so the role error is visible.
        if (roleChanged) {
          const roleOk = await applyRoleChange(target, editRole);
          if (!roleOk) return;
        }
        setAliasForUser(null);
        setAliasExisting(null);
        setAliasAddress("");
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
    const origin = appOrigin();
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
    if (
      !(await confirm({
        title: "Revoke invite",
        message: `Revoke invite for ${inv.email}?`,
        confirmLabel: "Revoke",
        tone: "danger",
      }))
    )
      return;
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
    // Existing aliases still carry the retired "Support" value; it is not in
    // the list any more, so fall back rather than render a blank select.
    setAliasDept(
      existing?.assignedDept && (DEPT_OPTIONS as readonly string[]).includes(existing.assignedDept)
        ? existing.assignedDept
        : "Others",
    );
    setAliasPosition(existing?.assignedPosition || "");
    setAliasError(null);
    // Role-change folded into Edit details: seed the role draft from the user's
    // current role and clear any prior role error. Reuses the editRole /
    // editRoleError state the standalone Change-role modal used; on Save we run
    // the change through applyRoleChange (same verifiedSave re-confirm path).
    setEditRole(u.role);
    setEditRoleError(null);
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
      width: "140px",
      sortable: true,
      // The stored value is an identifier ("R_AND_D"); people read words.
      render: (_v, u) => (
        <span className="text-xs font-semibold tracking-wide text-[#6B5C32]">
          {roleShort(u.role)}
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
      // Position lives on the USER row now (owner 2026-06-17 — same field the
      // Org Chart groups on), NOT on the @hookka.com alias, so a user with no
      // alias still shows their position and the grid agrees with the chart.
      sortAccessor: (u) => u.position || "",
      filterAccessor: (u) => u.position || "—",
      render: (_v, u, _i, hl) =>
        u.position ? (
          <span className="text-gray-700">{hl(u.position)}</span>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    {
      key: "department",
      label: "Department",
      type: "text",
      width: "130px",
      sortable: true,
      // Department lives on the USER row now (owner 2026-06-17), so it reads the
      // user field rather than the alias — matches the Org Chart grouping.
      sortAccessor: (u) => u.department || "",
      filterAccessor: (u) => u.department || "—",
      render: (_v, u) =>
        u.department ? (
          <span className="inline-flex items-center text-xs font-medium bg-[#EFEAE5] text-[#6B5C32] px-2 py-0.5 rounded">
            {u.department}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        ),
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
        // ALIAS ONE-PER-PERSON (owner): an alias is one-per-person. The branch
        // above already returns the existing-alias chip, so by here `alias` is
        // undefined and "Add alias" is the only create affordance. The explicit
        // aliasByUserId guard makes that invariant impossible to break in a
        // later refactor — if a user somehow has an alias we never render the
        // create button. (Backend enforcement still lives in mail-center.ts —
        // see report.)
        if (aliasByUserId.has(u.id)) {
          return <span className="text-xs text-gray-400">—</span>;
        }
        // No alias yet — offer "Add alias" (create + assign a new @hookka.com
        // address). The old "Claim existing" picker was removed (owner 2026-06-18).
        return (
          <span className="inline-flex flex-wrap items-center gap-1.5">
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
          </span>
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
            {/* Edit details — Position / Department / Email Alias / Role
                (Edit→Save, no naked edits): opens the modal, never auto-saves.
                Role-change is folded in here (was a separate ShieldCheck icon)
                and still runs through the verifiedSave re-confirm path. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setDrawerUser(u);
              }}
              title="Edit details (name, department, position, reports to, role)"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                toggleActive(u);
              }}
              title={
                u.id === currentUser?.id
                  ? "You can't disable your own account"
                  : u.isActive
                    ? "Disable"
                    : "Enable"
              }
              // Self-guard: can't disable your own account (mirrors the Delete
              // button + the server-side lockout guard on PUT /api/users/:id).
              disabled={u.isActive && u.id === currentUser?.id}
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
    ...(canManageUsers
      ? [{ key: "mailbox" as TabKey, label: "Mailbox Access" }]
      : []),
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
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
                <div className="flex-1">
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
                {canManageUsers && (
                  <button
                    type="button"
                    onClick={() => setAddingUser(true)}
                    className="ml-auto flex h-9 items-center gap-1.5 rounded-md bg-[#6B5C32] px-3 text-[13px] font-semibold text-white"
                  >
                    <UserPlus className="h-4 w-4" />
                    Add user
                  </button>
                )}
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
                    Every active staff member, with their Department, Position
                    and who they report to (their upline).
                    {canManageUsers ? (
                      <>
                        {" "}
                        Click <strong>Edit</strong>, set each person&apos;s
                        Department &rarr; Position &rarr; Reports&nbsp;to, then{" "}
                        <strong>Save</strong>. Changes apply only after you click
                        Save.
                      </>
                    ) : (
                      <>
                        {" "}
                        Department, position and reporting line come from each
                        person&apos;s profile.
                      </>
                    )}
                  </CardDescription>
                </div>
              </div>
              {/* Edit / Save / Cancel — Super Admin only (PUT /api/users/:id is
                  requireSuperAdmin). Mirrors the Mailbox Access bar: read-only
                  until Edit, Save commits every changed user in one go, no naked
                  edits. */}
              {canManageUsers && (
                <div className="flex shrink-0 gap-2">
                  {!orgEdit ? (
                    <Button variant="outline" size="sm" onClick={beginOrgEdit}>
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
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
                          : orgDraftCount > 0
                            ? `Save (${orgDraftCount})`
                            : "Save"}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {activeUsers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#D6D0C8] bg-[#FAFAF9] py-10 text-center">
                <UsersIcon className="mx-auto mb-2 h-7 w-7 text-[#C4BBA9]" />
                <div className="text-sm font-medium text-[#6B7280]">
                  No active staff yet
                </div>
                <div className="mx-auto mt-1 max-w-md text-xs text-gray-500">
                  Invite team members from the <strong>Users</strong> tab; once
                  active they appear here and can be given a Department, Position
                  and reporting line.
                </div>
              </div>
            ) : (
              <>
                {/* Edit-mode banner — department, position and reporting line
                    all live on the USER record, so EVERY active person is
                    editable here, no @hookka.com alias required (owner
                    2026-06-17). */}
                {orgEdit && (
                  <div className="mb-4 rounded-md border border-[#CFE0F3] bg-[#F2F7FD] px-3 py-2 text-xs text-[#2C5B8F]">
                    <Pencil className="mr-1 inline h-3.5 w-3.5 -mt-0.5" />
                    Set each person&apos;s <strong>Department</strong>, then their{" "}
                    <strong>Position</strong> (the list narrows to that
                    department), and <strong>Reports&nbsp;to</strong> (their
                    upline). Every active user can be placed — no email alias
                    needed. Changes apply only after you click Save.
                  </div>
                )}

                {/* The board. Replaces an indented tree drawn from `users`
                    alone — which is ten people, while the other forty-two work
                    on the floor and live in `workers` with no account. The
                    component reads /api/org-chart, where both tables arrive as
                    one list, so the factory is on the same board and a
                    reporting line can run between them (owner 2026-08-01). The
                    TABLE below still edits department and position. */}
                <div className="mb-5 rounded-lg border border-[#E5E7EB] bg-white p-3">
                  <OrgChart canManage={canManageUsers} />
                </div>

                {/* The Houzs-style table that used to sit here is gone —
                    owner 2026-08-02:「下面的不需要」. It covered the ten OFFICE
                    accounts only, and its Reports-to column read the legacy
                    users.reportsTo instead of the org_reporting edges, so it
                    printed "—" for people the chart directly above it draws a
                    line for. Everything it could edit, the side drawer edits
                    properly, on the user row, for all fifty. */}
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
                    disabled={users.length === 0}
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
                    {matrixMailboxes.map((a) => (
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
                            {/* Account actions (Disable/Enable · Reset password ·
                                Delete) intentionally do NOT live here — the
                                Mailbox Access tab is about WHO can open which
                                mailbox, not account management. Those actions
                                stay on the Users / Org Chart tabs (owner
                                2026-06-18). */}
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
                          {matrixMailboxes.map((a) => {
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

      {/* The standalone Change-role modal was removed — role-change now lives
          inside the Edit-details modal (it runs through the same verifiedSave
          re-confirm path via applyRoleChange). */}

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
      {addingUser && (
        <AddUserDrawer
          departments={ORG_DEPARTMENTS}
          roleOptions={ROLE_OPTIONS}
          onClose={() => setAddingUser(false)}
          onCreated={() => {
            fetchUsers();
            invalidateCachePrefix("/api/org-chart");
          }}
        />
      )}

      {drawerUser && (
        <UserDetailDrawer
          key={drawerUser.id}
          user={
            {
              id: drawerUser.id,
              email: drawerUser.email,
              displayName: drawerUser.displayName ?? "",
              role: drawerUser.role,
              isActive: drawerUser.isActive,
              department: drawerUser.department ?? "",
              position: drawerUser.position ?? "",
              reportsTo: drawerUser.reportsTo ?? "",
            } satisfies DrawerUser
          }
          currentManagerKey={
            orgPeople.find((p) => p.key === `user:${drawerUser.id}`)?.managerKey ?? null
          }
          // Everyone on the chart, factory floor included — a reporting line is
          // allowed to cross the two tables, and offering office accounts only
          // would make half the company unpickable.
          uplineOptions={orgPeople
            .filter((p) => p.key !== `user:${drawerUser.id}`)
            .map((p) => ({
              id: p.key,
              label: `${p.name}${p.position ? ` · ${p.position}` : ""}`,
            }))}
          departments={ORG_DEPARTMENTS}
          roleOptions={ROLE_OPTIONS}
          currentUserId={currentUser?.id ?? ""}
          canManage={canManageUsers}
          onClose={() => setDrawerUser(null)}
          onSaved={() => {
            fetchUsers();
            refreshOrgPeople();
            // The chart groups on these, so it must not keep serving the old
            // department for the rest of the session.
            invalidateCachePrefix("/api/org-chart");
          }}
        />
      )}

      {aliasForUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => {
            if (!aliasSubmitting && !editRoleSubmitting) {
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
                  Set the <strong>department</strong>,{" "}
                  <strong>position</strong> and <strong>role</strong> for{" "}
                  <strong>{aliasForUser.email}</strong>. Department and position
                  are stored on their @hookka.com mailbox and feed the org
                  chart; the role controls their access.
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
                {DEPT_OPTIONS.map((d) => (
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
              {/* Role — folded in from the old standalone Change-role modal.
                  Changing it on Save runs through the SAME verifiedSave
                  re-confirm path (security-critical), and only when it actually
                  changed; dept/position-only saves stay normal. */}
              <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide pt-2">
                Role
              </label>
              {/* The department suggests a role, it does not set one. Somebody
                  in Office may legitimately hold PROCUREMENT, and Management
                  maps to the master key — neither is safe to apply on its own. */}
              {(() => {
                const suggested = suggestedRoleForDepartment(aliasDept);
                if (!suggested || suggested === editRole) return null;
                return (
                  <p className="text-xs text-[#6B5C32]">
                    {aliasDept} usually gets{" "}
                    <button
                      type="button"
                      onClick={() => setEditRole(suggested)}
                      className="font-semibold underline underline-offset-2 hover:text-[#5a4d2a]"
                    >
                      {roleShort(suggested)}
                    </button>
                  </p>
                );
              })()}
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
                {!ROLE_OPTIONS.some((o) => o.value === aliasForUser.role) && (
                  <option value={aliasForUser.role}>
                    {aliasForUser.role} (current)
                  </option>
                )}
              </select>
              <p className="text-xs text-gray-500">
                {roleLabel(editRole)}
                {editRole !== aliasForUser.role && (
                  <span className="text-[#B45309]">
                    {" "}
                    — changing the role ends their current session; they sign
                    back in with the new access.
                  </span>
                )}
              </p>
              {editRoleError && (
                <p className="text-xs text-red-600">{editRoleError}</p>
              )}
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
                disabled={aliasSubmitting || editRoleSubmitting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={submitAlias}
                disabled={
                  aliasSubmitting ||
                  editRoleSubmitting ||
                  (!aliasExisting && !aliasAddress.trim())
                }
              >
                {aliasSubmitting || editRoleSubmitting ? (
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

      {/* In-app confirm dialog ([[feedback_no_naked_edits]]) — rendered once;
          driven by the useConfirm() hook above for Disable / Delete / role
          change / revoke-invite. */}
      {confirmDialog}
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
