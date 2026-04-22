// ---------------------------------------------------------------------------
// Global auth middleware for the D1-backed Hono app.
//
// Reads `Authorization: Bearer <token>`, resolves the session row in
// user_sessions, verifies the session hasn't expired and the user is still
// active, and stashes `userId` / `userRole` on the Hono context so downstream
// handlers can `c.get('userId')`.
//
// Paths in PUBLIC_PATHS (login/logout/health) bypass the middleware so the
// client can authenticate before acquiring a token. OPTIONS preflight always
// passes through (CORS already handled by the top-level cors() middleware).
// ---------------------------------------------------------------------------
import type { MiddlewareHandler } from "hono";
import type { Env } from "../worker";

// Exact-match endpoints that always bypass the dashboard auth gate.
export const PUBLIC_PATHS = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/accept-invite",
  "/api/health",
];

// Prefix-match endpoints that bypass the dashboard auth gate. These cover the
// shop-floor Worker Portal (its own PIN/token flow via /api/worker-auth and
// /api/worker) and the invite preflight (GET /api/auth/invite/:token —
// anyone with the token URL can hit it).
// Anything else under /api/* goes through the Bearer token check.
const PUBLIC_PREFIXES = [
  "/api/worker-auth/",
  "/api/worker/",
  "/api/auth/invite/",
];

// Customer QR tracking lookup: only the single-unit GET is public. The list
// endpoint and all writes (scan/generate) require auth — otherwise anyone on
// the internet can dump inventory or mutate unit status.
const FG_UNIT_PUBLIC_GET_RE = /^\/api\/fg-units\/[^/]+$/;

function isPublicPath(path: string, method: string): boolean {
  if (PUBLIC_PATHS.includes(path)) return true;
  if (method === "GET" && FG_UNIT_PUBLIC_GET_RE.test(path)) return true;
  for (const pfx of PUBLIC_PREFIXES) {
    if (path === pfx || path.startsWith(pfx)) return true;
  }
  return false;
}

type SessionJoinRow = {
  userId: string;
  expiresAt: string;
  role: string;
  isActive: number;
};

export const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const path = c.req.path;

  // CORS preflight — let the cors() middleware handle it.
  if (c.req.method === "OPTIONS") return next();

  // Anything outside /api/* is served as a static asset — the middleware is
  // only registered under /api/* in worker.ts, but guard here too.
  if (!path.startsWith("/api/")) return next();

  // Public endpoints (login/logout/health + worker portal + public tracking)
  // bypass the auth check entirely.
  if (isPublicPath(path, c.req.method)) return next();

  const authHeader = c.req.header("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  const token = match[1].trim();
  if (!token) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const row = await c.env.DB.prepare(
    `SELECT s.userId AS userId, s.expiresAt AS expiresAt,
            u.role AS role, u.isActive AS isActive
       FROM user_sessions s
       JOIN users u ON u.id = s.userId
      WHERE s.token = ?
      LIMIT 1`,
  )
    .bind(token)
    .first<SessionJoinRow>();

  if (!row) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  if (row.isActive !== 1) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const now = new Date().toISOString();
  if (row.expiresAt <= now) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  // Stash on ctx so downstream handlers can read via c.get('userId').
  // Cast avoids needing to touch the exported Env in worker.ts.
  (c as unknown as { set: (k: string, v: unknown) => void }).set(
    "userId",
    row.userId,
  );
  (c as unknown as { set: (k: string, v: unknown) => void }).set(
    "userRole",
    row.role,
  );

  await next();
};
