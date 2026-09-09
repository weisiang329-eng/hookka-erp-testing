// ---------------------------------------------------------------------------
// sessions.ts — see and end active sign-ins.
//
// Mounted at /api/sessions from worker.ts.
//
//   GET    /api/sessions            — my own live sessions
//   DELETE /api/sessions/:id        — end one of mine
//   GET    /api/sessions/all        — every user's live sessions (SUPER_ADMIN)
//   DELETE /api/sessions/all/:id    — end anyone's (SUPER_ADMIN)
//
// WHY THIS EXISTS
// A login log answers "who authenticated, and when". It cannot answer "who is
// signed in right now" — and with "Remember me" those are weeks apart. One
// login grants a sliding week of access, so the log shows a single entry from
// last month while the account is used daily. That is exactly the shape of an
// un-offboarded employee, a shared machine nobody signed out of, or a stolen
// session. None of them produce a second login event.
//
// The account owner is the best detector: they are the one person who knows
// they were not in Ipoh at 3am on a Linux box. This gives them the list and a
// button, and gives an admin the same across every account.
//
// TOKENS NEVER LEAVE THE SERVER. Sessions are addressed by `id`, a random
// handle. Returning the token — the actual credential — in a list endpoint
// would mean a screenshot of the security page hands over every session on it.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { emitAudit } from "../lib/audit";
import { ensureSessionColumns } from "../lib/session-registry";
import { requireSuperAdmin } from "../lib/rbac";

const app = new Hono<Env>();

type SessionRow = {
  id: string | null;
  userId: string;
  createdAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  lastSeenAt: string | null;
  email?: string | null;
  displayName?: string | null;
  role?: string | null;
};

function ctxUserId(c: unknown): string | undefined {
  return (c as { get: (k: string) => unknown }).get("userId") as
    | string
    | undefined;
}

/**
 * Turn a raw UA string into something a non-technical operator can match
 * against "was that me?". Deliberately coarse: the point is recognition, not
 * fingerprinting. "Chrome on Windows" is answerable; the full UA string is not.
 */
function describeDevice(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser =
    /edg\//i.test(ua) ? "Edge"
    : /opr\/|opera/i.test(ua) ? "Opera"
    : /chrome|crios/i.test(ua) ? "Chrome"
    : /firefox|fxios/i.test(ua) ? "Firefox"
    : /safari/i.test(ua) ? "Safari"
    : "Browser";
  const os =
    /windows/i.test(ua) ? "Windows"
    : /android/i.test(ua) ? "Android"
    : /iphone|ipad|ios/i.test(ua) ? "iOS"
    : /mac os|macintosh/i.test(ua) ? "Mac"
    : /linux/i.test(ua) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
}

function shape(r: SessionRow, currentToken: string | null, isCurrent: boolean) {
  return {
    id: r.id,
    device: describeDevice(r.userAgent),
    ipAddress: r.ipAddress,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    expiresAt: r.expiresAt,
    current: isCurrent,
    ...(r.email !== undefined
      ? { email: r.email, displayName: r.displayName, role: r.role }
      : {}),
  };
}

/** The caller's own session token, so the list can mark "This device". */
function currentToken(c: {
  req: { header: (k: string) => string | undefined };
}): string | null {
  const cookie = c.req.header("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)hookka_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// ----- GET /api/sessions ---------------------------------------------------
// Every live session for the calling user. No permission gate beyond being
// signed in: these are your own sessions, and a person who cannot see where
// their account is signed in cannot notice that it is signed in somewhere wrong.
app.get("/", async (c) => {
  const userId = ctxUserId(c);
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);

  try {
    await ensureSessionColumns(c.var.DB);
  } catch {
    /* listing still works without the extra columns, just sparser */
  }

  const tok = currentToken(c);
  const res = await c.var.DB
    .prepare(
      `SELECT id, userId, createdAt, expiresAt, ipAddress, userAgent, lastSeenAt, token
         FROM user_sessions
        WHERE userId = ?
          AND expiresAt > ?
        ORDER BY lastSeenAt DESC NULLS LAST, createdAt DESC`,
    )
    .bind(userId, new Date().toISOString())
    .all<SessionRow & { token: string }>();

  const rows = res.results ?? [];
  return c.json({
    success: true,
    data: rows.map((r) => shape(r, tok, tok !== null && r.token === tok)),
  });
});

// ----- GET /api/sessions/all ----------------------------------------------
// Every live session across every account. SUPER_ADMIN only.
//
// REGISTERED BEFORE /:id DELIBERATELY. Hono matches in registration order and
// /:id is a single-segment wildcard, so declaring it first would swallow
// /all as an id lookup.
//
// This is the view that answers the questions a login log cannot: which
// accounts are signed in right now, from how many places at once, and how long
// since each was actually used. A shared account with five concurrent sessions
// from five IPs, or a departed employee's account still being used on a
// remembered session, both show up here and nowhere else.
app.get("/all", async (c) => {
  const su = requireSuperAdmin(c);
  if (su) return su;

  try {
    await ensureSessionColumns(c.var.DB);
  } catch {
    /* sparser listing is better than none */
  }

  const tok = currentToken(c);
  const res = await c.var.DB
    .prepare(
      `SELECT s.id AS id, s.userId AS userId, s.createdAt AS createdAt,
              s.expiresAt AS expiresAt, s.ipAddress AS ipAddress,
              s.userAgent AS userAgent, s.lastSeenAt AS lastSeenAt,
              s.token AS token,
              u.email AS email, u.displayName AS displayName, u.role AS role
         FROM user_sessions s
         JOIN users u ON u.id = s.userId
        WHERE s.expiresAt > ?
        ORDER BY s.lastSeenAt DESC NULLS LAST, s.createdAt DESC
        LIMIT 500`,
    )
    .bind(new Date().toISOString())
    .all<SessionRow & { token: string }>();

  const rows = res.results ?? [];
  return c.json({
    success: true,
    data: rows.map((r) => shape(r, tok, tok !== null && r.token === tok)),
  });
});

// ----- DELETE /api/sessions/all/:id ---------------------------------------
// End anyone's session. SUPER_ADMIN only.
//
// This is the offboarding lever that did not exist: previously the only way to
// end someone else's session was to force a password change, which kills every
// session they have and tells them something happened. This ends one.
app.delete("/all/:id", async (c) => {
  const su = requireSuperAdmin(c);
  if (su) return su;
  const id = c.req.param("id");

  const row = await c.var.DB
    .prepare("SELECT id, userId FROM user_sessions WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ id: string; userId: string }>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);

  await c.var.DB
    .prepare("DELETE FROM user_sessions WHERE id = ?")
    .bind(id)
    .run();

  // Compliance-critical: an admin ending another person's session is exactly
  // the kind of action the journal must be able to reconstruct afterwards,
  // including WHOSE session it was.
  await emitAudit(c, {
    resource: "auth",
    resourceId: row.userId,
    action: "session.revoke",
    after: { sessionId: id, scope: "admin" },
  });

  return c.json({ success: true });
});

// ----- DELETE /api/sessions/:id -------------------------------------------
// End one of MY sessions. Scoped by userId in the WHERE clause, so a guessed
// id from another account matches nothing rather than revoking a stranger.
app.delete("/:id", async (c) => {
  const userId = ctxUserId(c);
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);
  const id = c.req.param("id");

  const row = await c.var.DB
    .prepare("SELECT id FROM user_sessions WHERE id = ? AND userId = ? LIMIT 1")
    .bind(id, userId)
    .first<{ id: string }>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);

  await c.var.DB
    .prepare("DELETE FROM user_sessions WHERE id = ? AND userId = ?")
    .bind(id, userId)
    .run();

  // Signing a device out is a security action and belongs in the journal —
  // it is also the trail that shows someone reacted to a session they did
  // not recognise.
  await emitAudit(c, {
    resource: "auth",
    resourceId: userId,
    action: "session.revoke",
    after: { sessionId: id, scope: "self" },
  });

  return c.json({ success: true });
});

export default app;
