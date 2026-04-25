// ---------------------------------------------------------------------------
// Federated OAuth login routes — Google Workspace (Phase B.3 / C.6).
//
// Mounted at `/api/auth/oauth` from worker.ts. The two routes here are PUBLIC
// (no Bearer token expected) — they're added to PUBLIC_PREFIXES in
// auth-middleware.ts so the global gate doesn't 401 them.
//
// Flow:
//   1. Browser → GET /api/auth/oauth/google/start?next=/dashboard
//        We mint a CSRF state (signed with JWT_SECRET, also stored in KV
//        with 10-min TTL), redirect 302 → Google.
//   2. Google → GET /api/auth/oauth/google/callback?code=…&state=…
//        We verify state + KV TTL, exchange code for tokens, verify the
//        id_token signature, find-or-link the local user, mint a session
//        in user_sessions, set the cookie, redirect to `next`.
//
// Why both signed state AND KV?
//   * Signed state alone → replayable until expiry.
//   * KV alone → stateful but susceptible to stuffing (attacker creates
//     thousands of dummy KV entries).
//   * Both → KV gives single-use semantics; signature gives integrity even
//     if KV gets rolled.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  findOrLinkUser,
  signState,
  verifyState,
} from "../lib/oauth-google";

const app = new Hono<Env>();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;      // 30 days, mirrors auth.ts
const STATE_TTL_S = 10 * 60;                           // 10 minutes for the OAuth handshake

function safeNext(next: string | undefined): string {
  // Reject anything that looks absolute / cross-origin to avoid open-redirect.
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//")) return "/";
  return next;
}

// ----- GET /api/auth/oauth/google/start -----------------------------------
app.get("/google/start", async (c) => {
  const env = c.env as unknown as {
    OAUTH_GOOGLE_CLIENT_ID?: string;
    OAUTH_GOOGLE_REDIRECT_URI?: string;
    OAUTH_GOOGLE_HOSTED_DOMAIN?: string;
    JWT_SECRET?: string;
    SESSION_CACHE: KVNamespace;
  };
  const clientId = env.OAUTH_GOOGLE_CLIENT_ID;
  const redirectUri = env.OAUTH_GOOGLE_REDIRECT_URI;
  const jwtSecret = env.JWT_SECRET;
  if (!clientId || !redirectUri || !jwtSecret) {
    return c.json(
      {
        success: false,
        error:
          "OAuth not configured. See docs/AUTH-OAUTH-SETUP.md for the env-var list.",
      },
      503,
    );
  }

  const next = safeNext(c.req.query("next"));
  const nonce = crypto.randomUUID();
  const stateToken = await signState(
    { nonce, next, ts: Date.now() },
    jwtSecret,
  );

  // Mark the nonce as "spendable" in KV — the callback deletes it. Replay
  // attempts (re-using the same state) miss the KV and 400.
  await env.SESSION_CACHE.put(`oauth:state:${nonce}`, "1", {
    expirationTtl: STATE_TTL_S,
  });

  const url = buildGoogleAuthUrl(
    stateToken,
    redirectUri,
    clientId,
    env.OAUTH_GOOGLE_HOSTED_DOMAIN,
  );
  return c.redirect(url, 302);
});

// ----- GET /api/auth/oauth/google/callback --------------------------------
app.get("/google/callback", async (c) => {
  const env = c.env as unknown as {
    OAUTH_GOOGLE_CLIENT_ID?: string;
    OAUTH_GOOGLE_CLIENT_SECRET?: string;
    OAUTH_GOOGLE_REDIRECT_URI?: string;
    OAUTH_GOOGLE_HOSTED_DOMAIN?: string;
    JWT_SECRET?: string;
    SESSION_CACHE: KVNamespace;
    APP_URL?: string;
  };
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorQ = c.req.query("error");
  if (errorQ) {
    // Google returned an error (user denied, etc.) — bounce to home with a flag.
    return c.redirect(`/?oauth_error=${encodeURIComponent(errorQ)}`, 302);
  }
  if (!code || !state) {
    return c.json(
      { success: false, error: "missing code or state" },
      400,
    );
  }
  if (!env.JWT_SECRET || !env.OAUTH_GOOGLE_REDIRECT_URI) {
    return c.json(
      { success: false, error: "OAuth not configured" },
      503,
    );
  }

  const decoded = await verifyState(state, env.JWT_SECRET);
  if (!decoded) {
    return c.json({ success: false, error: "invalid state" }, 400);
  }
  // Single-use: state nonce must still be in KV. Delete after take.
  const kvKey = `oauth:state:${decoded.nonce}`;
  const stored = await env.SESSION_CACHE.get(kvKey);
  if (!stored) {
    return c.json({ success: false, error: "state expired or replayed" }, 400);
  }
  await env.SESSION_CACHE.delete(kvKey);

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(
      code,
      env.OAUTH_GOOGLE_REDIRECT_URI,
      env,
    );
  } catch (e) {
    console.error("[oauth/google/callback] token exchange failed:", e);
    return c.json({ success: false, error: "token exchange failed" }, 400);
  }

  let claims;
  try {
    claims = await verifyIdToken(tokens.id_token, env);
  } catch (e) {
    console.error("[oauth/google/callback] id_token verify failed:", e);
    return c.json({ success: false, error: "id_token invalid" }, 401);
  }

  let linked;
  try {
    linked = await findOrLinkUser(c.var.DB, claims);
  } catch (e) {
    console.error("[oauth/google/callback] find-or-link failed:", e);
    return c.json({ success: false, error: "user link failed" }, 500);
  }

  // Issue a session — same shape as /api/auth/login.
  const sessionToken = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  await c.var.DB.batch([
    c.var.DB
      .prepare(
        "INSERT INTO user_sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)",
      )
      .bind(sessionToken, linked.userId, now.toISOString(), expires.toISOString()),
    c.var.DB
      .prepare("UPDATE users SET lastLoginAt = ? WHERE id = ?")
      .bind(now.toISOString(), linked.userId),
  ]);

  // Set cookie + redirect to next. The frontend reads the bearer token from
  // the cookie on first paint, then keeps it in memory for subsequent
  // Authorization headers. Cookie is HttpOnly so XSS can't lift it.
  const cookieParts = [
    `hookka_session=${sessionToken}`,
    `Path=/`,
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Secure`,
  ];
  c.header("Set-Cookie", cookieParts.join("; "));
  return c.redirect(safeNext(decoded.next), 302);
});

export default app;
