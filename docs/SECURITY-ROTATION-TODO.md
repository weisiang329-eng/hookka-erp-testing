# 🔴 Secret rotation — OPEN, owner action required

> **Last verified: 2026-08-13** by re-scanning `scripts/` for an embedded `postgres://…:<password>@…` literal.
> Corrected 2026-08-13: the working-tree count is **3 files, not ~109** — `scripts/_db.mjs`, `scripts/check-fg-ledger.mjs`, `scripts/reset-wip-quantities.mjs`. 14 scripts now read `process.env.DATABASE_URL`. The doc's own argument still stands: the tree count is irrelevant, only rotation makes the leaked copies inert.
> **UNVERIFIED ASSERTION** (as of 2026-08-13): whether the password has been rotated. That is a Supabase-dashboard fact and cannot be checked from source — **assume NOT rotated until the owner confirms**, and keep reminding.
> **Overlap:** `docs/SECURITY-db-credential-rotation.md` (filed 2026-07-30) documents the same open item with a fuller procedure and the correct GitHub secret names. Recommend keeping that one as the runbook and folding this file into it.

## The live prod DB password is hardcoded in committed scripts (and in git history)

Found 2026-07-23 while scrubbing the dead login password.

**What is exposed:** the Supabase **prod** Postgres connection string —
`postgresql://postgres:<PASSWORD>@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres` —
was in plaintext in ~109 files under `scripts/` (one-shot audit/backfill scripts), with a
staging string (`…zaxygxwadidiqcphibma…`) alongside it in several. As of 2026-08-13 only
**3** such files remain in the working tree — but see below: that does not reduce the
exposure.

**Why editing the files is NOT enough:** the strings are in **git history**. Anyone with a
clone (or a leaked clone) can read them from any past commit even after the working tree is
clean. The only real remediation is to **rotate the database password** so the exposed one
stops working.

### To remediate (owner)

1. **Rotate the Supabase DB password** — Supabase dashboard → Project `vpwdqtsxexpiqxzweivd`
   → Settings → Database → Reset database password. Do the same for staging
   (`zaxygxwadidiqcphibma`) if that one was ever real.
2. **Update the live consumers** — the Cloudflare Hyperdrive configs
   (`hookka-erp-supabase` for prod and `hookka-erp-staging` for staging; both are bound
   in `wrangler.toml` as `HYPERDRIVE` / `HYPERDRIVE_STAGING`), the GitHub Actions secrets
   `PROD_DATABASE_URL` / `STAGING_DATABASE_URL` / `DATABASE_URL` / `SUPABASE_PROD_URL`
   (all four names are referenced by workflows in `.github/workflows/`), and `.dev.vars`
   locally. (None of these live in the repo.) See
   `docs/SECURITY-db-credential-rotation.md` for the ordered procedure and the
   downtime window between resetting the password and updating Hyperdrive.
3. After rotation, the hardcoded strings in history are inert — no history rewrite needed.
4. Going forward, scripts read the connection string from `DATABASE_URL`. As of
   2026-08-13, 14 scripts do — but `scripts/_db.mjs`, `scripts/check-fg-ledger.mjs` and
   `scripts/reset-wip-quantities.mjs` still carry an embedded literal. `_db.mjs` is the
   shared helper, so fixing that one is the highest-leverage change.

### Already done (2026-07-23)

- The **login** password (`weisiang329@gmail.com`) was already rotated earlier (it 401s), and
  its plaintext copies were scrubbed from ~59 scripts → `process.env.HOOKKA_EMAIL` /
  `HOOKKA_PASSWORD`. That one is inert; this DB-password item is the remaining live exposure.

> Per the global rule §7 (secrets never pass through chat): this file exists to keep the
> reminder alive until the DB password is rotated. **Delete it once rotation is confirmed.**
