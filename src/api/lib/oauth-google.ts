// ---------------------------------------------------------------------------
// Google Workspace OAuth 2.0 — authorization-code flow with id_token.
//
// Why id_token (not access_token-only):
//   We don't need to call Google APIs on behalf of the user — we just want to
//   know "who is this person at Google?". The id_token is a signed JWT
//   containing the user's `sub` (Google account ID), `email`, `email_verified`
//   and `hd` (hosted domain) claims. We verify its signature against Google's
//   public keys, trust the claims, and link/create the local user.
//
// Endpoints used (stable, public):
//   AUTH:    https://accounts.google.com/o/oauth2/v2/auth
//   TOKEN:   https://oauth2.googleapis.com/token
//   JWKS:    https://www.googleapis.com/oauth2/v3/certs
//
// Required env (set via wrangler secret put for *_SECRET):
//   OAUTH_GOOGLE_CLIENT_ID
//   OAUTH_GOOGLE_CLIENT_SECRET
//   OAUTH_GOOGLE_REDIRECT_URI
//   OAUTH_GOOGLE_HOSTED_DOMAIN  — optional; if set, restricts to that Google
//                                  Workspace tenant (e.g. 'hookka.com').
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const JWKS_KV_KEY = "oauth:google:jwks:v1";
const JWKS_KV_TTL_S = 60 * 60; // 1 hour — Google rotates keys infrequently

export type GoogleEnv = {
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  OAUTH_GOOGLE_REDIRECT_URI?: string;
  OAUTH_GOOGLE_HOSTED_DOMAIN?: string;
  SESSION_CACHE?: KVNamespace;
};

export type GoogleClaims = {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
  picture?: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
};

// --- 1. Build the authorize URL --------------------------------------------

/**
 * Build the Google OAuth 2.0 authorize URL. The caller is responsible for
 * generating + persisting the `state` (CSRF) token; we only embed it.
 *
 * Scope: `openid email profile` is the minimum to get the id_token claims
 * we need. We do NOT request `https://www.googleapis.com/auth/...` API
 * scopes — login-only.
 */
export function buildGoogleAuthUrl(
  state: string,
  redirectUri: string,
  clientId: string,
  hostedDomain?: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    include_granted_scopes: "true",
    prompt: "select_account",
  });
  if (hostedDomain) {
    // `hd` is a HINT to Google's account picker; it does NOT enforce. We
    // RE-CHECK claims.hd in verifyIdToken — never trust the hint alone.
    params.set("hd", hostedDomain);
  }
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// --- 2. Exchange code for tokens -------------------------------------------

export type GoogleTokenResponse = {
  id_token: string;
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  env: GoogleEnv,
): Promise<GoogleTokenResponse> {
  if (!env.OAUTH_GOOGLE_CLIENT_ID || !env.OAUTH_GOOGLE_CLIENT_SECRET) {
    throw new Error(
      "OAUTH_GOOGLE_CLIENT_ID/SECRET not configured — see docs/AUTH-OAUTH-SETUP.md",
    );
  }
  const body = new URLSearchParams({
    code,
    client_id: env.OAUTH_GOOGLE_CLIENT_ID,
    client_secret: env.OAUTH_GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    // Don't echo the body verbatim — it may include client_id we'd rather
    // not log. Surface a generic error; the caller logs server-side.
    const txt = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

// --- 3. Verify the id_token (JWT) ------------------------------------------

type JwksKey = {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
  use: string;
};

type Jwks = { keys: JwksKey[] };

async function fetchJwks(env: GoogleEnv): Promise<Jwks> {
  if (env.SESSION_CACHE) {
    const cached = await env.SESSION_CACHE.get(JWKS_KV_KEY, { type: "json" });
    if (cached) return cached as Jwks;
  }
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const jwks = (await res.json()) as Jwks;
  if (env.SESSION_CACHE) {
    // Fire-and-forget would be cleaner but the caller is already async.
    await env.SESSION_CACHE.put(JWKS_KV_KEY, JSON.stringify(jwks), {
      expirationTtl: JWKS_KV_TTL_S,
    });
  }
  return jwks;
}

function base64UrlDecodeBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlDecodeJson<T>(s: string): T {
  const bytes = base64UrlDecodeBytes(s);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Verify a Google id_token: signature against JWKS, issuer, audience, expiry.
 * Returns the parsed claims on success; throws on any verification failure.
 */
export async function verifyIdToken(
  idToken: string,
  env: GoogleEnv,
): Promise<GoogleClaims> {
  if (!env.OAUTH_GOOGLE_CLIENT_ID) {
    throw new Error("OAUTH_GOOGLE_CLIENT_ID not configured");
  }

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = base64UrlDecodeJson<{ alg: string; kid: string }>(headerB64);
  const claims = base64UrlDecodeJson<GoogleClaims>(payloadB64);

  // RS256 only — Google does not currently sign with anything else, but
  // an attacker could try to slip an `alg: none` or HS256 token past us.
  if (header.alg !== "RS256") {
    throw new Error(`Unexpected id_token alg: ${header.alg}`);
  }

  let jwk: JwksKey | undefined;
  {
    const jwks = await fetchJwks(env);
    jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      // Possible JWKS rotation race — invalidate and refetch ONCE.
      if (env.SESSION_CACHE) await env.SESSION_CACHE.delete(JWKS_KV_KEY);
      const fresh = await fetchJwks(env);
      jwk = fresh.keys.find((k) => k.kid === header.kid);
      if (!jwk) throw new Error(`No JWKS key matching kid=${header.kid}`);
    }
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "RSA",
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      ext: true,
    },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = base64UrlDecodeBytes(sigB64);
  const sigOk = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Uint8Array.from(sigBytes),
    data,
  );
  if (!sigOk) throw new Error("id_token signature invalid");

  // Claim checks.
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) throw new Error("id_token expired");
  if (
    claims.iss !== "https://accounts.google.com" &&
    claims.iss !== "accounts.google.com"
  ) {
    throw new Error(`id_token iss mismatch: ${claims.iss}`);
  }
  if (claims.aud !== env.OAUTH_GOOGLE_CLIENT_ID) {
    throw new Error("id_token aud mismatch");
  }

  if (env.OAUTH_GOOGLE_HOSTED_DOMAIN) {
    if (claims.hd !== env.OAUTH_GOOGLE_HOSTED_DOMAIN) {
      throw new Error(
        `id_token hd mismatch: got ${claims.hd}, expected ${env.OAUTH_GOOGLE_HOSTED_DOMAIN}`,
      );
    }
  }

  if (!claims.email_verified) {
    throw new Error("id_token email not verified");
  }

  return claims;
}

// --- 4. Find or link a local user ------------------------------------------

export type LinkedUser = {
  userId: string;
  created: boolean;     // true if we just inserted a fresh users row
  linked: boolean;      // true if we just inserted an oauth_identities row
};

/**
 * Look up `oauth_identities` by (provider='google', sub). Three cases:
 *
 *   (a) Match → bump lastSeenAt, return the userId.
 *   (b) No match BUT users.email exists → link (insert oauth_identities row).
 *   (c) No match, no users row → create users row with role='READ_ONLY'
 *       (the safe default; admin can promote later) + link.
 *
 * `READ_ONLY` is enforced via roleId 'role_read_only' (see RBAC migration
 * 0045). The legacy `role` TEXT column is also set for backward-compat with
 * routes that still read `users.role`.
 */
export async function findOrLinkUser(
  db: D1Database,
  claims: GoogleClaims,
): Promise<LinkedUser> {
  const provider = "google";
  const nowIso = new Date().toISOString();

  // (a) match by (provider, sub) ?
  const existing = await db
    .prepare(
      "SELECT userId FROM oauth_identities WHERE provider = ? AND providerSubject = ? LIMIT 1",
    )
    .bind(provider, claims.sub)
    .first<{ userId: string }>();
  if (existing) {
    await db
      .prepare(
        "UPDATE oauth_identities SET lastSeenAt = ?, email = ? WHERE provider = ? AND providerSubject = ?",
      )
      .bind(nowIso, claims.email, provider, claims.sub)
      .run();
    return { userId: existing.userId, created: false, linked: false };
  }

  // (b) match by users.email ?
  const userByEmail = await db
    .prepare(
      "SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
    )
    .bind(claims.email)
    .first<{ id: string }>();

  if (userByEmail) {
    const oauthId = `oauth-${crypto.randomUUID().slice(0, 8)}`;
    await db
      .prepare(
        `INSERT INTO oauth_identities
           (id, userId, provider, providerSubject, email, emailVerified, hostedDomain, rawProfile, linkedAt, lastSeenAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        oauthId,
        userByEmail.id,
        provider,
        claims.sub,
        claims.email,
        claims.email_verified ? 1 : 0,
        claims.hd ?? null,
        JSON.stringify(claims),
        nowIso,
        nowIso,
      )
      .run();
    return { userId: userByEmail.id, created: false, linked: true };
  }

  // (c) create users + link.
  const userId = `user-${crypto.randomUUID().slice(0, 8)}`;
  const oauthId = `oauth-${crypto.randomUUID().slice(0, 8)}`;
  // No password (OAuth-only). passwordHash is NOT NULL in the schema, so we
  // store a sentinel that no real password can ever hash to (rejected by
  // verifyPassword's split-and-parse; format is `oauth-only$$$`).
  const sentinelHash = "oauth-only$0$0$0";
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, email, passwordHash, role, isActive, createdAt, lastLoginAt, displayName)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        userId,
        claims.email,
        sentinelHash,
        "READ_ONLY",
        nowIso,
        nowIso,
        claims.name ?? "",
      ),
    db
      .prepare(
        `INSERT INTO oauth_identities
           (id, userId, provider, providerSubject, email, emailVerified, hostedDomain, rawProfile, linkedAt, lastSeenAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        oauthId,
        userId,
        provider,
        claims.sub,
        claims.email,
        claims.email_verified ? 1 : 0,
        claims.hd ?? null,
        JSON.stringify(claims),
        nowIso,
        nowIso,
      ),
  ]);
  return { userId, created: true, linked: true };
}

// --- 5. CSRF state token ---------------------------------------------------

/**
 * Sign a short-lived CSRF state payload with the JWT_SECRET. The signature
 * is a SHA-256 HMAC of the payload — a full JWT is overkill here.
 *
 * Format: `<b64-payload>.<b64-mac>`
 *   payload = JSON { nonce, next, ts }
 */
export async function signState(
  payload: { nonce: string; next: string; ts: number },
  secret: string,
): Promise<string> {
  const body = btoa(JSON.stringify(payload))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  const mac = btoa(String.fromCharCode(...sig))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${body}.${mac}`;
}

export async function verifyState(
  token: string,
  secret: string,
  maxAgeMs: number = 10 * 60 * 1000,
): Promise<{ nonce: string; next: string; ts: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sigBytes = base64UrlDecodeBytes(mac);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(sigBytes),
    new TextEncoder().encode(body),
  );
  if (!ok) return null;
  let payload: { nonce: string; next: string; ts: number };
  try {
    const decoded = base64UrlDecodeBytes(body);
    payload = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }
  if (Date.now() - payload.ts > maxAgeMs) return null;
  return payload;
}
