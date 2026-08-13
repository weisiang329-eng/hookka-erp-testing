# 🔑 Database Password Rotation — Runbook

> **Last verified: 2026-08-13** against `wrangler.toml` (`HYPERDRIVE` + `HYPERDRIVE_STAGING` bindings), `.github/workflows/` (`secrets.PROD_DATABASE_URL`, `secrets.STAGING_DATABASE_URL`, `secrets.SUPABASE_DATABASE_URL`, `secrets.DATABASE_URL`, `secrets.SUPABASE_PROD_URL` are all referenced), and a re-scan of `scripts/` for embedded DSN literals.
> Corrected 2026-08-13: the working-tree count is **3 files, not 109**. The rest were converted to `process.env.DATABASE_URL`. This changes nothing about the need to rotate — the passwords are still in git history.
> **UNVERIFIED ASSERTION** (as of 2026-08-13): rotation status. Not checkable from source; **assume NOT DONE until the owner confirms in the Supabase dashboard.**
> Overlaps `docs/SECURITY-ROTATION-TODO.md` (same open item, filed a week earlier, thinner procedure). This file is the better runbook of the two — recommend keeping this one and folding that one in.

**Status: ACTION REQUIRED (owner).** Filed 2026-07-30.

## Why
The two Supabase database passwords (STAGING project `zaxygxwadidiqcphibma`,
PROD project `vpwdqtsxexpiqxzweivd`) were hard-coded in ~109 tracked
`scripts/*.mjs` files and therefore live in **git history on both `main` and
`staging`**. Anyone with repo access (or a clone) has both passwords.

As of 2026-08-13 only **3** files still carry a literal —
`scripts/_db.mjs`, `scripts/check-fg-ledger.mjs`,
`scripts/reset-wip-quantities.mjs`. That cleanup does **not** reduce the
exposure by one bit: history is unchanged. Rotation is still the only fix.

Deleting the files does **not** un-leak them — the history still has them. **The
passwords must be rotated.** Rotation makes every leaked copy useless.

The live app does **not** embed the password — it connects via the Cloudflare
**Hyperdrive** binding (`HYPERDRIVE`), whose config stores the connection
string. So rotating requires updating Hyperdrive too, or the live site goes down.

## ⚠️ Downtime window
Between resetting the password in Supabase (step 1) and updating Hyperdrive
(step 2) the live app cannot reach the DB. Do it at a quiet time and do steps
1–2 back-to-back. Ping me right after and I'll verify the site.

## Procedure — do PROD first, verify, then STAGING

### PROD (Supabase project `vpwdqtsxexpiqxzweivd`)
1. **Supabase** → log in → open the PROD project → **Settings → Database →
   Database password → Reset database password** → generate a strong one →
   **copy it immediately** (shown once).
2. **Cloudflare → Hyperdrive → `hookka-erp-supabase`** (prod) → Edit → replace
   the password in the connection string → Save. Wait ~1 min to propagate.
3. **GitHub → repo → Settings → Secrets and variables → Actions →
   `PROD_DATABASE_URL`** → update with the new password.
4. **Local** (if you run scripts locally): update `DATABASE_URL` in `.dev.vars`.
5. **Verify:** open the live site → it loads + shows data (read OK) → make a
   small edit and save (write OK). If it errors, the Hyperdrive password in
   step 2 is wrong — re-check it.

### STAGING (Supabase project `zaxygxwadidiqcphibma`)
Repeat with: Supabase STAGING project → Cloudflare Hyperdrive
**`hookka-erp-staging`** → GitHub secret **`STAGING_DATABASE_URL`** → verify the
staging site.

## Follow-up (Claude, after rotation)
Once rotated, the embedded creds in the 109 scripts are **dead/harmless**. I'll
then do a **clean, reviewed** cleanup: either switch those scripts to read
`DATABASE_URL` from env (the staging `#75` intent, but re-done without its CI
entanglement) or untrack the one-off ones. Not done autonomously overnight
because staging's `#75` commit conflicts with `main`'s deploy workflows and is
unreviewed — not safe to push to prod unattended.

## Notes
- Who created the exposure: the scripts accumulated over months of data-fix
  work (mostly agent-generated one-offs). `scripts/audit-wip-both-dbs.mjs` is
  already gitignored; the other ~109 are tracked.
- This runbook itself contains **no secrets**.
