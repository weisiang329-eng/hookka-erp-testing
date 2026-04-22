// ---------------------------------------------------------------------------
// D1-backed users (admin CRUD) route.
//
// Gated behind authMiddleware — every handler assumes a SUPER_ADMIN caller.
// passwordHash is NEVER returned by any endpoint (strip it in publicUser).
//
// DELETE is soft — flips isActive to 0 and purges the user's sessions so
// any live token for that user is invalidated immediately. The row stays
// around so FK references in other tables (audit logs, assignments, etc.)
// remain valid.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { hashPassword } from "../lib/password";

const app = new Hono<Env>();

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
  const res = await c.env.DB.prepare(
    "SELECT * FROM users ORDER BY createdAt DESC",
  ).all<UserRow>();
  const data = (res.results ?? []).map(publicUser);
  return c.json({ success: true, data });
});

// GET /api/users/:id — single user
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  if (!user) {
    return c.json({ success: false, error: "User not found" }, 404);
  }
  return c.json({ success: true, data: publicUser(user) });
});

// POST /api/users — create a new user
// Body: { email, password, displayName?, role? }
app.post("/", async (c) => {
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

    const existing = await c.env.DB.prepare(
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

    await c.env.DB.prepare(
      `INSERT INTO users (id, email, passwordHash, role, isActive, createdAt, lastLoginAt, displayName)
       VALUES (?, ?, ?, ?, 1, ?, NULL, ?)`,
    )
      .bind(
        id,
        email.trim(),
        passwordHash,
        role ?? "SUPER_ADMIN",
        createdAt,
        displayName ?? "",
      )
      .run();

    const created = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
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
  const id = c.req.param("id");
  try {
    const existing = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
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

    await c.env.DB.prepare(
      `UPDATE users SET email = ?, role = ?, displayName = ?, isActive = ? WHERE id = ?`,
    )
      .bind(merged.email, merged.role, merged.displayName, merged.isActive, id)
      .run();

    // If we just disabled the user, nuke their sessions so the token the
    // frontend is holding stops working on the next request.
    if (merged.isActive === 0 && existing.isActive === 1) {
      await c.env.DB.prepare(
        "DELETE FROM user_sessions WHERE userId = ?",
      )
        .bind(id)
        .run();
    }

    const updated = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(id)
      .first<UserRow>();
    if (!updated) {
      return c.json({ success: false, error: "User vanished" }, 500);
    }
    return c.json({ success: true, data: publicUser(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/users/:id — soft delete + session purge
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  if (!existing) {
    return c.json({ success: false, error: "User not found" }, 404);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET isActive = 0 WHERE id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM user_sessions WHERE userId = ?").bind(id),
  ]);

  const updated = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
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

  const existing = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  if (!existing) {
    return c.json({ success: false, error: "User not found" }, 404);
  }

  const newHash = await hashPassword(newPassword);
  // Also purge sessions — force the user to log in again with the new password.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET passwordHash = ? WHERE id = ?").bind(
      newHash,
      id,
    ),
    c.env.DB.prepare("DELETE FROM user_sessions WHERE userId = ?").bind(id),
  ]);

  return c.json({ success: true });
});

export default app;
