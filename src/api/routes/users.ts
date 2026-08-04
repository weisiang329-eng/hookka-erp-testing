// ---------------------------------------------------------------------------
// D1-backed users (admin CRUD) route.
//
// Gated per-handler via requirePermission (P3.3-followup, audit S1). Replaces
// the previous blanket `if (role !== "SUPER_ADMIN")` middleware so non-admin
// roles with a `users:*` grant in role_permissions can read / invite / update
// users without escalating to SUPER_ADMIN. SUPER_ADMIN still short-circuits
// every check via lib/rbac.ts.
//
// passwordHash is NEVER returned by any endpoint (strip it in publicUser).
//
// DELETE is soft — flips isActive to 0 and purges the user's sessions so
// any live token for that user is invalidated immediately. The row stays
// around so FK references in other tables (audit logs, assignments, etc.)
// remain valid.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { runSelfApply } from "../lib/self-apply";
import type { Env } from "../worker";
import { requirePermission, requireSuperAdmin } from "../lib/rbac";
import { ensureOrgRoles } from "../lib/ensure-org-roles";
import { hashPassword } from "../lib/password";
import { inviteEmailTemplate, sendMail } from "../lib/email";
import { enqueueEmail } from "../lib/email-outbox";
import { emitAudit } from "../lib/audit";

const app = new Hono<Env>();

// Invite TTL — 72 hours is a standard SaaS balance between "oops I missed it"
// and "stale tokens floating around". Change here, not in the schema.
const INVITE_TTL_HOURS = 72;
const INVITE_TTL_MS = INVITE_TTL_HOURS * 60 * 60 * 1000;

type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  isActive: number;
  createdAt: string;
  lastLoginAt: string | null;
  displayName: string | null;
  // User-level org placement (owner 2026-06-17, "這個是看 position，不需要 alias").
  // These live on the USER row — not on the @hookka.com mail alias — so the Org
  // Chart works for EVERY user, aliased or not. The columns are snake_case in
  // Postgres (department / position / reports_to), but the postgres.js driver
  // (lib/db-pg.ts, transform.column.from) camelCases EVERY result column — they
  // are absent from the column-rename map, so they fall back to postgres.toCamel
  // (reports_to → reportsTo, department/position unchanged). So a SELECT * row
  // exposes `reportsTo`, NOT `reports_to`. We keep `reports_to` in the type as
  // an optional dual-read alias for any code path that still reads the raw name
  // (e.g. a hypothetical D1 fallback), but `reportsTo` is the live shape.
  department: string | null;
  position: string | null;
  reportsTo: string | null;
  reports_to?: string | null;
};

type InviteRow = {
  token: string;
  email: string;
  role: string;
  displayName: string | null;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  emailSentAt: string | null;
  emailResendId: string | null;
};

type InviteWithInviterRow = InviteRow & {
  inviterDisplayName: string | null;
  inviterEmail: string | null;
};

function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    isActive: u.isActive === 1,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    displayName: u.displayName ?? "",
    // User-level org placement — drives the Org Chart for every user.
    // The driver camelCases the column to `reportsTo`; dual-read the raw
    // `reports_to` only as a defensive fallback (it's normally undefined).
    department: u.department ?? "",
    position: u.position ?? "",
    reportsTo: u.reportsTo ?? u.reports_to ?? "",
  };
}

function genId(): string {
  return `user-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Lazy idempotent schema ensure for the user-level org-chart columns
// (department / position / reports_to). Mirrors the repo pattern used in
// email-outbox.ts, do-qr-token.ts, mail-center.ts etc.: a module-level
// memoized promise so the ALTERs run AT MOST once per isolate, and the
// per-statement try/catch swallows the "duplicate column" error on isolates
// where they already ran.
//
// Columns are snake_case in Postgres (department / position / reports_to) and
// are intentionally NOT in column-rename-map.json. They do NOT pass through
// verbatim on read: the postgres.js driver (lib/db-pg.ts, transform.column.from)
// camelCases every result column — reports_to surfaces as `reportsTo` via
// postgres.toCamel (department / position are unchanged by toCamel). So writes
// use the snake_case column name, but reads of a SELECT * row use `reportsTo`.
// All three are plain TEXT (org placement is free-text / id strings, never a
// toISOString timestamp), so no timestamptz round-trip hazard.
let orgColumnsEnsured: Promise<void> | null = null;
function ensureUserOrgColumns(db: D1Database): Promise<void> {
  if (orgColumnsEnsured) return orgColumnsEnsured;
  orgColumnsEnsured = (async () => {
    const stmts = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS position TEXT",
      // reports_to holds the user id of this person's upline (manager), so the
      // org chart can draw a reporting line — mirrors Houzs's parentId.
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS reports_to TEXT",
      // An account created by an admin carries a password the ADMIN chose, so
      // the admin knows it. Until the person changes it, nothing that account
      // does can be attributed to them — the admin could equally have done it.
      // Owner 2026-08-02 wants to hand out credentials directly:「我给他们密码、
      // 账号,他们都可以直接登录进来」— which is a normal way to run an ERP on
      // company mailboxes, and is safe exactly as long as the first login
      // forces a change. Defaults FALSE so nothing existing is affected.
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE",
    ];
    await runSelfApply(db, "users", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    orgColumnsEnsured = null;
    throw err;
  });
  return orgColumnsEnsured;
}

// GET /api/users — list all users
// ---------------------------------------------------------------------------
// POST /api/users/backfill-org-from-aliases
//
// One-time repair for the split this codebase carried: the "Edit details" modal
// wrote Department and Position to the ALIAS row (email_addresses.assigned_dept
// / assigned_position) while the Users grid and the Org Chart read
// users.department / users.position. The model moved to the user row on
// 2026-06-17 and only one side followed, so the modal showed "Finance" and the
// grid showed "—" — owner 2026-08-02:「明明我的 Department 里面是有数据的,为什么
// 在外面呈现出来的却是空的?」. Everyone therefore landed in the org chart's
// Unassigned column, which is why the chart had no shape at all.
//
// The modal now writes both. This carries the EXISTING alias values across.
//
// Only fills BLANKS — a department already set on the user row wins, because
// that is the newer source of truth and an alias may be stale. Idempotent: a
// second run reports 0.
// ---------------------------------------------------------------------------
app.post("/backfill-org-from-aliases", async (c) => {
  const denied = await requireSuperAdmin(c);
  if (denied) return denied;
  await ensureUserOrgColumns(c.var.DB);
  const dryRun = c.req.query("apply") !== "1";

  const res = await c.var.DB.prepare(
    `SELECT u.id            AS user_id,
            u.department    AS user_dept,
            u.position      AS user_position,
            a.assigned_dept AS alias_dept,
            a.assigned_position AS alias_position
       FROM users u
       JOIN email_addresses a ON a.assigned_user_id = u.id
      WHERE (COALESCE(u.department, '') = '' AND COALESCE(a.assigned_dept, '') <> '')
         OR (COALESCE(u.position, '')   = '' AND COALESCE(a.assigned_position, '') <> '')`,
  )
    .all<{
      userId?: string;
      user_id?: string;
      userDept?: string | null;
      user_dept?: string | null;
      userPosition?: string | null;
      user_position?: string | null;
      aliasDept?: string | null;
      alias_dept?: string | null;
      aliasPosition?: string | null;
      alias_position?: string | null;
    }>();

  const planned = (res.results ?? []).map((r) => ({
    userId: r.userId ?? r.user_id ?? "",
    department:
      (r.userDept ?? r.user_dept ?? "") || (r.aliasDept ?? r.alias_dept ?? ""),
    position:
      (r.userPosition ?? r.user_position ?? "") ||
      (r.aliasPosition ?? r.alias_position ?? ""),
  })).filter((p) => p.userId);

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      wouldUpdate: planned.length,
      data: planned,
      hint: "POST again with ?apply=1 to write.",
    });
  }

  for (const p of planned) {
    await c.var.DB.prepare(
      "UPDATE users SET department = ?, position = ? WHERE id = ?",
    )
      .bind(p.department, p.position, p.userId)
      .run();
  }
  return c.json({ success: true, dryRun: false, updated: planned.length, data: planned });
});

app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — users:read.
  const denied = await requirePermission(c, "users", "read");
  if (denied) return denied;
  // Make sure the org-chart columns exist before SELECT * reads them (first
  // call on a fresh isolate adds them; later calls are a no-op).
  await ensureUserOrgColumns(c.var.DB);
  // Every ORG department needs a role to assign people to. Seeded here because
  // this is the page that assigns them, and migrations are inert on deploy.
  // Additive and idempotent — never resets a role an admin has since edited.
  await ensureOrgRoles(c.var.DB).catch(() => undefined);
  const res = await c.var.DB.prepare(
    "SELECT * FROM users ORDER BY createdAt DESC",
  ).all<UserRow>();
  const data = (res.results ?? []).map(publicUser);
  return c.json({ success: true, data });
});

// NOTE: GET /api/users/:id is registered at the bottom of this file (after the
// invite routes). Hono's router matches routes in registration order and /:id
// is a single-segment wildcard — declaring it here would swallow GET /invites
// as GET /:id with id="invites".

// POST /api/users — create a new user
// Body: { email, password, displayName?, role? }
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — users:create.
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  // SUPER_ADMIN-only (owner 2026-06-12): an Admin can run the business but
  // not create accounts (which would let them mint a Super Admin + escalate).
  const su = requireSuperAdmin(c);
  if (su) return su;
  try {
    const body = await c.req.json();
    const { email, password, displayName, role, department, position, mustChangePassword } =
      body as {
        email?: string;
        password?: string;
        displayName?: string;
        role?: string;
        department?: string;
        position?: string;
        mustChangePassword?: boolean;
      };
    if (!email || !password) {
      return c.json(
        { success: false, error: "email and password are required" },
        400,
      );
    }
    if (password.length < 6) {
      return c.json(
        { success: false, error: "password must be at least 6 characters" },
        400,
      );
    }

    const existing = await c.var.DB.prepare(
      "SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
    )
      .bind(email.trim())
      .first<{ id: string }>();
    if (existing) {
      return c.json(
        { success: false, error: "Email already registered" },
        409,
      );
    }

    const id = genId();
    const passwordHash = await hashPassword(password);
    const createdAt = new Date().toISOString();

    // Department / position are set HERE rather than in a second call, so a new
    // person lands on the org chart the moment they exist instead of sitting in
    // Unassigned until someone remembers.
    await ensureUserOrgColumns(c.var.DB);
    await c.var.DB.prepare(
      `INSERT INTO users (id, email, passwordHash, role, isActive, createdAt, lastLoginAt,
                          displayName, department, position, must_change_password)
       VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        email.trim(),
        passwordHash,
        role ?? "STAFF",
        createdAt,
        displayName ?? "",
        (department ?? "").trim() || null,
        (position ?? "").trim() || null,
        // Default TRUE: an admin-chosen password is a handover credential, not
        // the person's password. Only an explicit false opts out.
        mustChangePassword === false ? false : true,
      )
      .run();

    const created = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(id)
      .first<UserRow>();
    if (!created) {
      return c.json({ success: false, error: "Failed to create user" }, 500);
    }
    // Minting an account — including the role it starts with — was unaudited
    // even though the subsequent role-CHANGE was logged, so an account created
    // straight into a privileged role left no trace at all. `after` is the
    // publicUser projection so the password hash never reaches audit_events.
    await emitAudit(c, {
      resource: "users",
      resourceId: id,
      action: "create",
      after: publicUser(created),
    });
    return c.json({ success: true, data: publicUser(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /api/users/:id — update non-password fields
// Body: { email?, displayName?, role?, isActive? }
app.put("/:id", async (c) => {
  // RBAC gate (P3.3-followup) — base permission is users:update.
  // The 0045 seed has no `roles` resource, so role-change requests
  // (existing.role !== merged.role) inherit the same users:update gate
  // rather than a separate roles:update permission. The audit row that
  // fires on a role flip already records the high-impact intent.
  const denied = await requirePermission(c, "users", "update");
  if (denied) return denied;
  // SUPER_ADMIN-only (owner 2026-06-12): enable/disable, role-change and
  // profile edits of an account are Super-Admin actions — an Admin must not
  // be able to disable or delete other people's accounts.
  const su = requireSuperAdmin(c);
  if (su) return su;
  const id = c.req.param("id");
  try {
    // Org-chart columns must exist before we read/write them.
    await ensureUserOrgColumns(c.var.DB);
    const existing = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(id)
      .first<UserRow>();
    if (!existing) {
      return c.json({ success: false, error: "User not found" }, 404);
    }
    const body = await c.req.json();

    // Role changes require a separate, narrower permission. Without this
    // gate, anyone with `users:update` (which includes ops staff who set
    // names / emails / activation) could promote themselves or others to
    // SUPER_ADMIN. `users:role-change` is seeded only on SUPER_ADMIN.
    const wantsRoleChange =
      body.role !== undefined && body.role !== existing.role;
    if (wantsRoleChange) {
      const roleDenied = await requirePermission(c, "users", "role-change");
      if (roleDenied) return roleDenied;
    }

    // ---- Lockout guard (owner 2026-06-18) ---------------------------------
    // Two foot-guns the UI also guards, enforced server-side so a direct API
    // call (or a stale client) can't brick login access:
    //   1) You cannot disable or role-DEMOTE your OWN account — "otherwise I
    //      disable myself and lose the page". (A self promote/keep is fine.)
    //   2) You cannot disable or demote the LAST active SUPER_ADMIN — that
    //      would leave the org with nobody able to manage accounts.
    // A "demotion" here is any role change OFF of SUPER_ADMIN. Promotions and
    // lateral edits (display name, email, dept, position) are untouched.
    const callerId = (
      c as unknown as { get: (k: string) => string | undefined }
    ).get("userId");
    // Matches the merge's own semantics below (body.isActive ? 1 : 0): a
    // disable is any explicit falsy isActive in the body against a row that is
    // currently active. Using the same falsy test (not a strict === false)
    // keeps the guard and the write in lockstep.
    const wantsDisable =
      body.isActive !== undefined && !body.isActive && existing.isActive === 1;
    const wantsDemote =
      wantsRoleChange &&
      existing.role === "SUPER_ADMIN" &&
      body.role !== "SUPER_ADMIN";

    if (callerId && callerId === id && (wantsDisable || wantsDemote)) {
      return c.json(
        {
          success: false,
          error: wantsDisable
            ? "You can't disable your own account."
            : "You can't remove Super Admin from your own account.",
        },
        400,
      );
    }

    // Last-active-SUPER_ADMIN protection. Only matters when this row IS an
    // active super admin and the request would disable or demote it. Count the
    // OTHER active super admins; if there are none, refuse.
    if (existing.role === "SUPER_ADMIN" && existing.isActive === 1 &&
        (wantsDisable || wantsDemote)) {
      const others = await c.var.DB.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'SUPER_ADMIN' AND isActive = 1 AND id != ?",
      )
        .bind(id)
        .first<{ n: number }>();
      if (!others || Number(others.n) === 0) {
        return c.json(
          {
            success: false,
            error: wantsDisable
              ? "You can't disable the last active Super Admin."
              : "You can't demote the last active Super Admin.",
          },
          400,
        );
      }
    }

    // Org-chart fields arrive camelCase from the client (department / position
    // / reportsTo) and map onto the snake_case columns. Each is left untouched
    // when the key is absent from the body (so a status-only or role-only PUT
    // never wipes someone's placement), and an explicit "" clears it. The
    // reporting line stores the upline's user id (or "" / null for none).
    //
    // IMPORTANT: read the EXISTING value off the camelCased row shape. The
    // driver renames reports_to → existing.reportsTo (see UserRow / db-pg.ts),
    // so the old `existing.reports_to` read was ALWAYS undefined — an Org Chart
    // Save (which omits reportsTo) silently NULLed the user's reporting line.
    // Dual-read camelCase first, then the raw snake_case as a defensive fallback.
    const existingReportsTo = existing.reportsTo ?? existing.reports_to ?? null;
    const merged = {
      email: body.email ?? existing.email,
      role: body.role ?? existing.role,
      displayName: body.displayName ?? existing.displayName ?? "",
      isActive:
        body.isActive === undefined
          ? existing.isActive
          : body.isActive
            ? 1
            : 0,
      department:
        body.department === undefined
          ? (existing.department ?? null)
          : (body.department || null),
      position:
        body.position === undefined
          ? (existing.position ?? null)
          : (body.position || null),
      reportsTo:
        body.reportsTo === undefined
          ? existingReportsTo
          : (body.reportsTo || null),
    };

    await c.var.DB.prepare(
      `UPDATE users SET email = ?, role = ?, displayName = ?, isActive = ?, department = ?, position = ?, reports_to = ? WHERE id = ?`,
    )
      .bind(
        merged.email,
        merged.role,
        merged.displayName,
        merged.isActive,
        merged.department,
        merged.position,
        merged.reportsTo,
        id,
      )
      .run();

    // P3.8 — security-sensitive mutations require explicit KV cache
    // invalidation. The auth-middleware caches the joined user/session row
    // (incl. role) for SESSION_CACHE_TTL_S (5 min), so without this purge a
    // demoted user would keep their old (more-privileged) role until the
    // cache entry expires. We keep the 5-min TTL for the cold-start
    // performance win and invalidate on the few writes that change the
    // cached fields (role flip, deactivation, password reset, delete).
    const roleChanged = existing.role !== merged.role;
    const justDisabled = merged.isActive === 0 && existing.isActive === 1;
    if (roleChanged || justDisabled) {
      const { purgeUserSessions } = await import("../lib/auth-middleware");
      await purgeUserSessions(c.var.DB, c.env.SESSION_CACHE, id);
    }

    const updated = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(id)
      .first<UserRow>();
    if (!updated) {
      return c.json({ success: false, error: "User vanished" }, 500);
    }

    // Audit emit (P3.4) — only fires when the role actually changed.
    // High-impact mutation: a role flip can grant/revoke permission across
    // the whole RBAC matrix. Skip plain display-name / email-only updates
    // to keep the audit log focused on security-relevant changes.
    if (existing.role !== merged.role) {
      await emitAudit(c, {
        resource: "users",
        resourceId: id,
        action: "role-change",
        before: publicUser(existing),
        after: publicUser(updated),
      });
    } else {
      // Everything that is NOT a role flip was deliberately skipped to "keep
      // the audit log focused" — but this same handler also disables accounts
      // (isActive → 0, which purges sessions and locks a person out) and
      // rewrites email, display name and the reporting line. Those are
      // security-relevant too, so the non-role edit now lands as a plain
      // update rather than vanishing.
      await emitAudit(c, {
        resource: "users",
        resourceId: id,
        action: "update",
        before: publicUser(existing),
        after: publicUser(updated),
      });
    }

    return c.json({ success: true, data: publicUser(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/users/:id — soft delete + session purge
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "users", "delete");
  if (denied) return denied;
  // SUPER_ADMIN-only (owner 2026-06-12): deleting an account is the most
  // destructive user action — never available to a plain Admin.
  const su = requireSuperAdmin(c);
  if (su) return su;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  if (!existing) {
    return c.json({ success: false, error: "User not found" }, 404);
  }

  // Lockout guard (owner 2026-06-18). DELETE is a SOFT delete (isActive → 0),
  // so it carries the SAME lockout risk as PUT { isActive: false }. Mirror the
  // PUT guard: you can't delete your own account, and you can't delete the last
  // active Super Admin (which would leave nobody able to manage accounts).
  const callerId = (
    c as unknown as { get: (k: string) => string | undefined }
  ).get("userId");
  if (callerId && callerId === id) {
    return c.json(
      { success: false, error: "You can't delete your own account." },
      400,
    );
  }
  if (existing.role === "SUPER_ADMIN" && existing.isActive === 1) {
    const others = await c.var.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'SUPER_ADMIN' AND isActive = 1 AND id != ?",
    )
      .bind(id)
      .first<{ n: number }>();
    if (!others || Number(others.n) === 0) {
      return c.json(
        {
          success: false,
          error: "You can't delete the last active Super Admin.",
        },
        400,
      );
    }
  }

  const { purgeUserSessions } = await import("../lib/auth-middleware");
  await c.var.DB
    .prepare("UPDATE users SET isActive = 0 WHERE id = ?")
    .bind(id)
    .run();
  await purgeUserSessions(c.var.DB, c.env.SESSION_CACHE, id);

  const updated = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();

  // Deleting an account revokes every permission that account held and purges
  // its live sessions — the most destructive user action in the module, and it
  // was the only one with no audit row. Soft delete, so `before` is a real
  // pre-state (the role the account held when it was removed) rather than a
  // reconstruction.
  await emitAudit(c, {
    resource: "users",
    resourceId: id,
    action: "delete",
    before: publicUser(existing),
    after: publicUser(updated ?? { ...existing, isActive: 0 }),
  });
  return c.json({
    success: true,
    data: publicUser(updated ?? { ...existing, isActive: 0 }),
  });
});

// POST /api/users/:id/reset-password — admin resets another user's password
// Body: { newPassword }
app.post("/:id/reset-password", async (c) => {
  // RBAC gate (P3.3-followup) — admin password reset is a users:update.
  const denied = await requirePermission(c, "users", "update");
  if (denied) return denied;
  // SUPER_ADMIN-only (owner 2026-06-12): resetting another account's password
  // is an account-takeover vector — Super Admin only.
  const su = requireSuperAdmin(c);
  if (su) return su;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { newPassword } = body as { newPassword?: string };
  if (!newPassword) {
    return c.json(
      { success: false, error: "newPassword is required" },
      400,
    );
  }
  if (newPassword.length < 6) {
    return c.json(
      { success: false, error: "newPassword must be at least 6 characters" },
      400,
    );
  }

  const existing = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  if (!existing) {
    return c.json({ success: false, error: "User not found" }, 404);
  }

  const newHash = await hashPassword(newPassword);
  // Also purge sessions (DB + KV cache) — force the user to log in again
  // with the new password instead of riding the old token for 5 minutes.
  const { purgeUserSessions } = await import("../lib/auth-middleware");
  await c.var.DB
    .prepare("UPDATE users SET passwordHash = ? WHERE id = ?")
    .bind(newHash, id)
    .run();
  await purgeUserSessions(c.var.DB, c.env.SESSION_CACHE, id);

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Invite routes — admin-side management. The public accept-invite endpoints
// live in routes/auth.ts because they run without a bearer token.
// ---------------------------------------------------------------------------

function publicInvite(row: InviteWithInviterRow) {
  return {
    token: row.token,
    email: row.email,
    role: row.role,
    displayName: row.displayName ?? "",
    invitedBy: row.invitedBy,
    inviterName:
      row.inviterDisplayName && row.inviterDisplayName.length > 0
        ? row.inviterDisplayName
        : (row.inviterEmail ?? ""),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    emailSentAt: row.emailSentAt,
  };
}

// Sprint 4 — invite email is normally ENQUEUED into outbox_emails. The
// cron drain (.github/workflows/process-email-outbox.yml) actually
// contacts Resend. Returns { ok: true, id: <outbox row id> } on a
// successful enqueue.
//
// FALLBACK PATH (added 2026-04-29 after BUG-2026-04-29-009): if the
// outbox enqueue throws — most commonly because migration 0081 hasn't
// been applied to the live DB so `outbox_emails` doesn't exist — we
// fall through to a direct sendEmail() call. That bypasses the queue's
// retry / durability guarantees, but it gets the invite out the door
// in environments where the queue infra hasn't shipped yet. The error
// propagates back to the route so the UI can show a meaningful toast.
async function sendInviteEmail(
  c: Parameters<typeof enqueueEmail>[0],
  invite: InviteRow,
  inviterName: string,
): Promise<{ ok: boolean; id?: string; error?: string; viaFallback?: boolean }> {
  const baseUrl = (c.env.APP_URL || "").replace(/\/$/, "");
  const inviteUrl = `${baseUrl}/invite/${invite.token}`;
  const tpl = inviteEmailTemplate({
    appName: "Hookka Manufacturing ERP",
    inviterName: inviterName || "A Hookka Manufacturing ERP admin",
    inviteUrl,
    expiresInHours: INVITE_TTL_HOURS,
  });

  // --- Primary path: send immediately (direct), like password reset. ---
  // Invites used to be ENQUEUED into outbox_emails and wait for the GitHub cron
  // drain — but that cron is throttled to multi-hour gaps and sometimes fails
  // outright (2026-06-04 had a ~7h window, 13:06→19:49 MYT, with no successful
  // drain), so an invite clicked in the afternoon sat unsent until evening — the
  // "afternoon broken" symptom. Send directly so the recipient gets it in
  // seconds; the outbox stays as a durable fallback below if the direct send
  // fails. (2026-06-05 — afternoon-invite-delay fix.)
  const env = c.env as {
    RESEND_API_KEY?: string;
    BREVO_API_KEY?: string;
    RESEND_FROM_EMAIL?: string;
  };
  const from =
    env.RESEND_FROM_EMAIL ||
    "Hookka Manufacturing ERP <noreply@hookka.com>";
  if (env.RESEND_API_KEY || env.BREVO_API_KEY) {
    const direct = await sendMail(env, from, {
      to: invite.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    if (direct.ok) {
      return { ok: true, id: direct.id };
    }
    console.warn(
      `[users.invite] direct send failed for ${invite.email}: ${direct.error ?? "unknown"}; enqueuing to outbox as durable fallback.`,
    );
  }

  // --- Durable fallback: enqueue into outbox_emails for the drain to retry. ---
  // Reached only when the immediate send failed (provider blip) or no provider
  // is configured. An invite must never be silently lost.
  try {
    const res = await enqueueEmail(c, {
      to: invite.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    return { ok: true, id: res.id, viaFallback: true };
  } catch (err) {
    const enqueueError = err instanceof Error ? err.message : "enqueue failed";
    return {
      ok: false,
      error: `Direct send failed and outbox enqueue also failed (${enqueueError}).`,
    };
  }
}

// POST /api/users/invite — create + send invite
// Body: { email, role?, displayName? }
app.post("/invite", async (c) => {
  // RBAC gate (P3.3-followup) — invite is a users:create flow.
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  // SUPER_ADMIN-only (owner 2026-06-12) — inviting a new account is account
  // creation; only a Super Admin onboards users.
  const su = requireSuperAdmin(c);
  if (su) return su;
  try {
    const body = await c.req.json();
    const { email, role, displayName } = body as {
      email?: string;
      role?: string;
      displayName?: string;
    };
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return c.json(
        { success: false, error: "valid email is required" },
        400,
      );
    }

    const trimmedEmail = email.trim();
    const nowIso = new Date().toISOString();

    // Collision: existing active user with this email?
    const existingUser = await c.var.DB.prepare(
      "SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND isActive = 1 LIMIT 1",
    )
      .bind(trimmedEmail)
      .first<{ id: string }>();
    if (existingUser) {
      return c.json(
        { success: false, error: "A user with this email already exists" },
        409,
      );
    }

    // Collision: pending (unexpired, unaccepted) invite?
    const existingInvite = await c.var.DB.prepare(
      `SELECT token FROM user_invites
         WHERE LOWER(email) = LOWER(?)
           AND acceptedAt IS NULL
           AND expiresAt > ?
         LIMIT 1`,
    )
      .bind(trimmedEmail, nowIso)
      .first<{ token: string }>();
    if (existingInvite) {
      return c.json(
        {
          success: false,
          error:
            "A pending invite already exists for this email. Revoke it first or use resend.",
        },
        409,
      );
    }

    // Purge any stale (expired or accepted) row on the same email so the
    // UNIQUE(email) constraint doesn't fight us.
    await c.var.DB.prepare(
      "DELETE FROM user_invites WHERE LOWER(email) = LOWER(?)",
    )
      .bind(trimmedEmail)
      .run();

    const userId = (c as unknown as { get: (k: string) => unknown }).get(
      "userId",
    ) as string | undefined;
    if (!userId) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

    await c.var.DB.prepare(
      `INSERT INTO user_invites
         (token, email, role, displayName, invitedBy, createdAt, expiresAt,
          acceptedAt, emailSentAt, emailResendId)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    )
      .bind(
        token,
        trimmedEmail,
        role ?? "STAFF",
        displayName ?? null,
        userId,
        nowIso,
        expiresAt,
      )
      .run();

    // Pull the inviter's displayName for the email greeting.
    const inviter = await c.var.DB.prepare(
      "SELECT displayName, email FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{ displayName: string | null; email: string }>();
    const inviterName =
      inviter?.displayName && inviter.displayName.length > 0
        ? inviter.displayName
        : (inviter?.email ?? "An admin");

    const invite: InviteRow = {
      token,
      email: trimmedEmail,
      role: role ?? "STAFF",
      displayName: displayName ?? null,
      invitedBy: userId,
      createdAt: nowIso,
      expiresAt,
      acceptedAt: null,
      emailSentAt: null,
      emailResendId: null,
    };

    const emailRes = await sendInviteEmail(c, invite, inviterName);
    if (emailRes.ok) {
      await c.var.DB.prepare(
        "UPDATE user_invites SET emailSentAt = ?, emailResendId = ? WHERE token = ?",
      )
        .bind(new Date().toISOString(), emailRes.id ?? null, token)
        .run();
    }

    const baseUrl = (c.env.APP_URL || "").replace(/\/$/, "");
    const inviteUrl = `${baseUrl}/invite/${token}`;

    return c.json({
      success: true,
      data: {
        token,
        inviteUrl,
        emailSent: emailRes.ok,
        emailError: emailRes.ok ? undefined : emailRes.error,
      },
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/users/invites — list pending (unaccepted, unexpired) invites
app.get("/invites", async (c) => {
  const denied = await requirePermission(c, "users", "read");
  if (denied) return denied;
  const nowIso = new Date().toISOString();
  const res = await c.var.DB.prepare(
    `SELECT i.*,
            u.displayName AS "inviterDisplayName",
            u.email AS "inviterEmail"
       FROM user_invites i
       LEFT JOIN users u ON u.id = i.invitedBy
      WHERE i.acceptedAt IS NULL
        AND i.expiresAt > ?
      ORDER BY i.createdAt DESC`,
  )
    .bind(nowIso)
    .all<InviteWithInviterRow>();
  const data = (res.results ?? []).map(publicInvite);
  return c.json({ success: true, data });
});

// POST /api/users/invites/:token/resend — re-email the same invite
app.post("/invites/:token/resend", async (c) => {
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  const su = requireSuperAdmin(c); // SUPER_ADMIN-only (owner 2026-06-12)
  if (su) return su;
  const token = c.req.param("token");
  const nowIso = new Date().toISOString();

  const invite = await c.var.DB.prepare(
    "SELECT * FROM user_invites WHERE token = ? LIMIT 1",
  )
    .bind(token)
    .first<InviteRow>();
  if (!invite) {
    return c.json({ success: false, error: "Invite not found" }, 404);
  }
  if (invite.acceptedAt) {
    return c.json(
      { success: false, error: "Invite already accepted" },
      409,
    );
  }
  if (invite.expiresAt <= nowIso) {
    return c.json({ success: false, error: "Invite expired" }, 410);
  }

  const inviter = await c.var.DB.prepare(
    "SELECT displayName, email FROM users WHERE id = ?",
  )
    .bind(invite.invitedBy)
    .first<{ displayName: string | null; email: string }>();
  const inviterName =
    inviter?.displayName && inviter.displayName.length > 0
      ? inviter.displayName
      : (inviter?.email ?? "An admin");

  const emailRes = await sendInviteEmail(c, invite, inviterName);
  if (emailRes.ok) {
    await c.var.DB.prepare(
      "UPDATE user_invites SET emailSentAt = ?, emailResendId = ? WHERE token = ?",
    )
      .bind(new Date().toISOString(), emailRes.id ?? null, token)
      .run();
  }

  return c.json({
    success: true,
    data: {
      emailSent: emailRes.ok,
      emailError: emailRes.ok ? undefined : emailRes.error,
    },
  });
});

// DELETE /api/users/invites/:token — revoke a pending invite
app.delete("/invites/:token", async (c) => {
  const denied = await requirePermission(c, "users", "delete");
  if (denied) return denied;
  const su = requireSuperAdmin(c); // SUPER_ADMIN-only (owner 2026-06-12)
  if (su) return su;
  const token = c.req.param("token");
  const existing = await c.var.DB.prepare(
    "SELECT token, acceptedAt FROM user_invites WHERE token = ?",
  )
    .bind(token)
    .first<{ token: string; acceptedAt: string | null }>();
  if (!existing) {
    return c.json({ success: false, error: "Invite not found" }, 404);
  }
  if (existing.acceptedAt) {
    return c.json(
      { success: false, error: "Invite already accepted; cannot revoke" },
      409,
    );
  }
  await c.var.DB.prepare("DELETE FROM user_invites WHERE token = ?")
    .bind(token)
    .run();
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/users/:id — single user lookup. MUST be declared last so the
// static invite routes above take precedence (see note near the top of file).
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "users", "read");
  if (denied) return denied;
  await ensureUserOrgColumns(c.var.DB);
  const id = c.req.param("id");
  const user = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  if (!user) {
    return c.json({ success: false, error: "User not found" }, 404);
  }
  return c.json({ success: true, data: publicUser(user) });
});

export default app;
