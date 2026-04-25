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
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { hashPassword } from "../lib/password";
import { inviteEmailTemplate, sendEmail } from "../lib/email";
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
  };
}

function genId(): string {
  return `user-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/users — list all users
app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — users:read.
  const denied = await requirePermission(c, "users", "read");
  if (denied) return denied;
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
  try {
    const body = await c.req.json();
    const { email, password, displayName, role } = body as {
      email?: string;
      password?: string;
      displayName?: string;
      role?: string;
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

    await c.var.DB.prepare(
      `INSERT INTO users (id, email, passwordHash, role, isActive, createdAt, lastLoginAt, displayName)
       VALUES (?, ?, ?, ?, 1, ?, NULL, ?)`,
    )
      .bind(
        id,
        email.trim(),
        passwordHash,
        role ?? "STAFF",
        createdAt,
        displayName ?? "",
      )
      .run();

    const created = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(id)
      .first<UserRow>();
    if (!created) {
      return c.json({ success: false, error: "Failed to create user" }, 500);
    }
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
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(id)
      .first<UserRow>();
    if (!existing) {
      return c.json({ success: false, error: "User not found" }, 404);
    }
    const body = await c.req.json();

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
    };

    await c.var.DB.prepare(
      `UPDATE users SET email = ?, role = ?, displayName = ?, isActive = ? WHERE id = ?`,
    )
      .bind(merged.email, merged.role, merged.displayName, merged.isActive, id)
      .run();

    // If we just disabled the user, nuke their sessions (DB + KV cache) so
    // the token the frontend is holding stops working on the next request.
    if (merged.isActive === 0 && existing.isActive === 1) {
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
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  if (!existing) {
    return c.json({ success: false, error: "User not found" }, 404);
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
// live in routes-d1/auth.ts because they run without a bearer token.
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

async function sendInviteEmail(
  env: Env["Bindings"],
  invite: InviteRow,
  inviterName: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const baseUrl = (env.APP_URL || "").replace(/\/$/, "");
  const inviteUrl = `${baseUrl}/invite/${invite.token}`;
  const tpl = inviteEmailTemplate({
    appName: "Hookka ERP",
    inviterName: inviterName || "A Hookka ERP admin",
    inviteUrl,
    expiresInHours: INVITE_TTL_HOURS,
  });
  return sendEmail(env.RESEND_API_KEY, env.RESEND_FROM_EMAIL, {
    to: invite.email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });
}

// POST /api/users/invite — create + send invite
// Body: { email, role?, displayName? }
app.post("/invite", async (c) => {
  // RBAC gate (P3.3-followup) — invite is a users:create flow.
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
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

    const emailRes = await sendInviteEmail(c.env, invite, inviterName);
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

  const emailRes = await sendInviteEmail(c.env, invite, inviterName);
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
