# Auth: Google Workspace OAuth + TOTP 2FA — admin setup guide

Phase B.3 (Google Workspace SSO) and Phase C.6 (TOTP 2FA) are scaffolded but
**inert until the credentials below are set**. The integration code reads
them from env vars and `wrangler secret`. Follow this guide once per
environment (preview, staging, production).

> Audience: Hookka platform admin. The end user (employee) only sees a
> "Sign in with Google" button and a "Set up 2FA" page — they don't touch
> any of this.

---

## A. Google Cloud Console — create OAuth client

1. Open https://console.cloud.google.com/, choose / create the project that
   owns Hookka's Workspace.
2. Navigate to **APIs & Services → OAuth consent screen**.
   * User type: **Internal** (locks consent to your Workspace tenant).
   * App name: `Hookka ERP`.
   * Support email: pick a Workspace mailbox you control.
   * Authorized domains: `hookka-erp-testing.pages.dev` (or your prod
     domain) AND your Workspace primary domain (e.g. `hookka.com`).
   * Scopes: leave only `openid`, `email`, `profile`. (We do not call any
     Google APIs on behalf of the user — login only.)
   * Save.
3. **APIs & Services → Credentials → + CREATE CREDENTIALS → OAuth client ID**.
   * Application type: **Web application**.
   * Name: `Hookka ERP — <env>` (one client per env so revocation is
     surgical).
   * Authorized JavaScript origins:
     ```
     https://hookka-erp-testing.pages.dev
     ```
   * Authorized redirect URIs:
     ```
     https://hookka-erp-testing.pages.dev/api/auth/oauth/google/callback
     ```
   * Click **Create**. Copy the **Client ID** and **Client secret**
     immediately — Google won't show the secret again.

---

## B. Cloudflare — set env vars + secrets

Run the `wrangler` commands from the project root (`hookka-erp-testing/`).

### B.1 Public (non-secret) env vars

Edit `wrangler.toml` `[vars]` block, or set per-env via the dashboard:

```toml
[vars]
OAUTH_GOOGLE_CLIENT_ID    = "<paste from step A.3>"
OAUTH_GOOGLE_REDIRECT_URI = "https://hookka-erp-testing.pages.dev/api/auth/oauth/google/callback"
# Optional. If set, restricts login to the named Google Workspace tenant.
# Recommended for production (locks out personal gmail accounts).
OAUTH_GOOGLE_HOSTED_DOMAIN = "hookka.com"
```

### B.2 Secrets (NEVER commit)

```bash
# OAuth client secret — paste when prompted, do NOT echo.
wrangler secret put OAUTH_GOOGLE_CLIENT_SECRET

# Used to sign the CSRF state token on the OAuth handshake. Generate fresh:
#   node -e "console.log(crypto.randomBytes(48).toString('base64url'))"
wrangler secret put JWT_SECRET
```

For local dev (`wrangler dev` / `vite + wrangler pages dev`), put the same
keys in `.dev.vars`:

```ini
OAUTH_GOOGLE_CLIENT_ID=<…>
OAUTH_GOOGLE_CLIENT_SECRET=<…>
OAUTH_GOOGLE_REDIRECT_URI=http://localhost:8787/api/auth/oauth/google/callback
OAUTH_GOOGLE_HOSTED_DOMAIN=hookka.com
JWT_SECRET=<…>
```

> `.dev.vars` is git-ignored; never commit it. If you commit one by accident,
> rotate `OAUTH_GOOGLE_CLIENT_SECRET` immediately in the Google Cloud Console.

---

## C. D1 / Postgres migrations

Apply both migrations:

```bash
# D1 (legacy / rollback path)
npm run db:migrate:remote

# Postgres (Supabase — the live source of truth)
psql "$DATABASE_URL" -f migrations-postgres/0053_oauth_identities.sql
psql "$DATABASE_URL" -f migrations-postgres/0054_user_totp.sql
```

Both files are idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).

---

## D. Smoke-test the flow

1. Visit `https://hookka-erp-testing.pages.dev/api/auth/oauth/google/start?next=/dashboard`.
   You should bounce to Google's account picker.
2. Sign in with a Workspace account. The redirect should land on
   `/dashboard` and you should be logged in.
3. Hit `/api/auth/me` from the browser console:
   ```js
   await fetch("/api/auth/me", {
     headers: { authorization: "Bearer " + document.cookie.split("=")[1] }
   }).then(r => r.json())
   ```
   You should see your email + role.

If anything fails, `wrangler tail --format=pretty` will surface the
server-side error from `[oauth/google/callback]`.

---

## E. TOTP 2FA — per-user enrollment

There is no admin step to "turn on TOTP" — it is opt-in per user. The
`POST /api/auth/totp/enroll` route:

1. Generates a fresh TOTP secret + 8 single-use recovery codes.
2. Returns `{ otpauthUrl, qrUrl, secret, recoveryCodes }`.
3. **Recovery codes are shown ONCE.** The frontend MUST display them with a
   "save these" warning. Subsequent calls return only the QR (the codes
   are gone — already hashed and persisted).

The user scans the QR with Google Authenticator / Authy / 1Password,
submits the 6-digit code to `/api/auth/totp/verify`, and from that
moment their next login will require both password + code.

Disable: `POST /api/auth/totp/disable` with `{ password }` re-auth.

Recovery: at the login-verify step the user can enter a recovery code
instead of the 6-digit TOTP. The matched code is permanently burned.
When they're down to 0, they re-enroll (which generates fresh codes).

---

## F. Required env vars summary

| Variable                       | Where           | Purpose                                            |
| ------------------------------ | --------------- | -------------------------------------------------- |
| `OAUTH_GOOGLE_CLIENT_ID`       | wrangler vars   | Google OAuth client ID (public).                   |
| `OAUTH_GOOGLE_CLIENT_SECRET`   | wrangler secret | Google OAuth client secret. Rotates on leak.       |
| `OAUTH_GOOGLE_REDIRECT_URI`    | wrangler vars   | Callback URL — must match Google Console exactly.  |
| `OAUTH_GOOGLE_HOSTED_DOMAIN`   | wrangler vars   | Optional. Locks login to one Workspace tenant.     |
| `JWT_SECRET`                   | wrangler secret | HMAC secret for the OAuth CSRF state token.        |

Until **all of the required ones above** are set, the OAuth `/start` route
returns `503` with a pointer to this doc. The TOTP routes do NOT depend on
any env vars and work as soon as migrations 0053/0054 are applied.

---

## G. What's NOT scaffolded yet

* **SCIM** (User Provisioning) — Phase C.6 punted; admins still create
  users by invite.
* **Microsoft 365 OAuth** — Phase B.3 punted; the schema is provider-
  agnostic so adding Microsoft is a copy of `oauth-google.ts` against the
  Microsoft Graph endpoints.
* **WebAuthn / passkeys** — separate roadmap item.
