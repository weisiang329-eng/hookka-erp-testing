// ---------------------------------------------------------------------------
// D1-backed auth route — login / logout / me / change-password.
//
// Session tokens are opaque UUIDs (crypto.randomUUID) stored in user_sessions
// with a 30-day sliding window from issue time. The authMiddleware in
// src/api/lib/auth-middleware.ts handles token verification for every
// non-public /api/* request, so /me and /change-password can assume the
// request is already authenticated by the time the handler runs.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { hashPassword, verifyPassword } from "../lib/password";

const app = new Hono<Env>();

// 30 days, in ms — tweak here, not in the schema.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    displayName: u.displayName ?? "",
  };
}

function bearerTokenFrom(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ----- POST /api/auth/login -----------------------------------------------
// Body: { email, password }
// Returns: { success, data: { token, user } }
app.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { email, password } = body as { email?: string; password?: string };
  if (!email || !password) {
    return c.json(
      { success: false, error: "email and password are required" },
      400,
    );
  }

  const user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
  )
    .bind(email.trim())
    .first<UserRow>();
  if (!user) {
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }
  if (user.isActive !== 1) {
    return c.json({ success: false, error: "Account disabled" }, 403);
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }

  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);

  // Atomic: write session + update lastLoginAt in one batch.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO user_sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)",
    ).bind(token, user.id, now.toISOString(), expires.toISOString()),
    c.env.DB.prepare("UPDATE users SET lastLoginAt = ? WHERE id = ?").bind(
      now.toISOString(),
      user.id,
    ),
  ]);

  return c.json({
    success: true,
    data: { token, user: publicUser(user) },
  });
});

// ----- POST /api/auth/logout ----------------------------------------------
// Deletes the caller's session. Idempotent: unknown/missing token → still ok.
app.post("/logout", async (c) => {
  const token = bearerTokenFrom(c.req.raw);
  if (token) {
    await c.env.DB.prepare("DELETE FROM user_sessions WHERE token = ?")
      .bind(token)
      .run();
  }
  return c.json({ success: true });
});

// ----- GET /api/auth/me ---------------------------------------------------
// Requires the auth middleware to have stashed userId on the ctx.
app.get("/me", async (c) => {
  const userId = (c as unknown as { get: (k: string) => unknown }).get(
    "userId",
  ) as string | undefined;
  if (!userId) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!user) {
    return c.json({ success: false, error: "User not found" }, 404);
  }
  return c.json({ success: true, data: { user: publicUser(user) } });
});

// ----- POST /api/auth/change-password -------------------------------------
// Body: { oldPassword, newPassword }
app.post("/change-password", async (c) => {
  const userId = (c as unknown as { get: (k: string) => unknown }).get(
    "userId",
  ) as string | undefined;
  if (!userId) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  const body = await c.req.json().catch(() => ({}));
  const { oldPassword, newPassword } = body as {
    oldPassword?: string;
    newPassword?: string;
  };
  if (!oldPassword || !newPassword) {
    return c.json(
      { success: false, error: "oldPassword and newPassword are required" },
      400,
    );
  }
  if (newPassword.length < 6) {
    return c.json(
      { success: false, error: "newPassword must be at least 6 characters" },
      400,
    );
  }

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!user) {
    return c.json({ success: false, error: "User not found" }, 404);
  }
  const ok = await verifyPassword(oldPassword, user.passwordHash);
  if (!ok) {
    return c.json({ success: false, error: "Old password incorrect" }, 401);
  }

  const newHash = await hashPassword(newPassword);
  await c.env.DB.prepare("UPDATE users SET passwordHash = ? WHERE id = ?")
    .bind(newHash, userId)
    .run();

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Invite acceptance flow — PUBLIC routes, exempted in auth-middleware.ts.
//
// GET /api/auth/invite/:token   → preflight (fetches the invite meta so the
//                                   recipient can see "You were invited as X")
// POST /api/auth/accept-invite  → creates the users row, marks the invite
//                                   accepted, and logs the user in.
// ---------------------------------------------------------------------------

type InviteRow = {
  token: string;
  email: string;
  role: string;
  displayName: string | null;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
};

// GET /api/auth/invite/:token
app.get("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const nowIso = new Date().toISOString();

  const row = await c.env.DB.prepare(
    `SELECT i.email, i.displayName, i.expiresAt, i.acceptedAt,
            u.displayName AS inviterDisplayName,
            u.email AS inviterEmail
       FROM user_invites i
       LEFT JOIN users u ON u.id = i.invitedBy
      WHERE i.token = ?
      LIMIT 1`,
  )
    .bind(token)
    .first<{
      email: string;
      displayName: string | null;
      expiresAt: string;
      acceptedAt: string | null;
      inviterDisplayName: string | null;
      inviterEmail: string | null;
    }>();

  if (!row || row.acceptedAt || row.expiresAt <= nowIso) {
    return c.json({ success: false, error: "Invalid or expired invite" }, 404);
  }

  const inviterName =
    row.inviterDisplayName && row.inviterDisplayName.length > 0
      ? row.inviterDisplayName
      : (row.inviterEmail ?? "");

  return c.json({
    success: true,
    data: {
      email: row.email,
      displayName: row.displayName ?? "",
      inviterName,
      expiresAt: row.expiresAt,
    },
  });
});

// POST /api/auth/accept-invite
// Body: { token, password, displayName? }
app.post("/accept-invite", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { token, password, displayName } = body as {
    token?: string;
    password?: string;
    displayName?: string;
  };
  if (!token || !password) {
    return c.json(
      { success: false, error: "token and password are required" },
      400,
    );
  }
  if (password.length < 6) {
    return c.json(
      { success: false, error: "password must be at least 6 characters" },
      400,
    );
  }

  const nowIso = new Date().toISOString();
  const invite = await c.env.DB.prepare(
    "SELECT * FROM user_invites WHERE token = ? LIMIT 1",
  )
    .bind(token)
    .first<InviteRow>();
  if (!invite || invite.acceptedAt || invite.expiresAt <= nowIso) {
    return c.json({ success: false, error: "Invalid or expired invite" }, 404);
  }

  // Race condition: someone else (re-)created a user with this email between
  // invite send and now. Bail loudly rather than silently overwriting.
  const existingUser = await c.env.DB.prepare(
    "SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
  )
    .bind(invite.email)
    .first<{ id: string }>();
  if (existingUser) {
    return c.json(
      { success: false, error: "A user with this email already exists" },
      409,
    );
  }

  const resolvedDisplayName =
    (displayName && displayName.trim()) ||
    invite.displayName ||
    "";
  const userId = `user-${crypto.randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword(password);
  const sessionToken = crypto.randomUUID();
  const sessionExpires = new Date(
    Date.now() + SESSION_TTL_MS,
  ).toISOString();

  // Atomic: create user, mark invite accepted, issue session in one batch.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, email, passwordHash, role, isActive, createdAt, lastLoginAt, displayName)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      userId,
      invite.email,
      passwordHash,
      invite.role,
      nowIso,
      nowIso,
      resolvedDisplayName,
    ),
    c.env.DB.prepare(
      "UPDATE user_invites SET acceptedAt = ? WHERE token = ?",
    ).bind(nowIso, token),
    c.env.DB.prepare(
      "INSERT INTO user_sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)",
    ).bind(sessionToken, userId, nowIso, sessionExpires),
  ]);

  return c.json({
    success: true,
    data: {
      token: sessionToken,
      user: {
        id: userId,
        email: invite.email,
        role: invite.role,
        displayName: resolvedDisplayName,
      },
    },
  });
});

export default app;
