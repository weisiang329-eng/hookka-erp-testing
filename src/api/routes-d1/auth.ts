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

export default app;
