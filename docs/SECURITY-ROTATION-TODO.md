# 🔴 Secret rotation — OPEN, owner action required

## The live prod DB password is hardcoded in ~109 committed scripts (and in git history)

Found 2026-07-23 while scrubbing the dead login password.

**What is exposed:** the Supabase **prod** Postgres connection string —
`postgresql://postgres:<PASSWORD>@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres` —
appears in plaintext in ~109 files under `scripts/` (one-shot audit/backfill scripts), and a
staging string (`…zaxygxwadidiqcphibma…`) alongside it in several.

**Why editing the files is NOT enough:** the strings are in **git history**. Anyone with a
clone (or a leaked clone) can read them from any past commit even after the working tree is
clean. The only real remediation is to **rotate the database password** so the exposed one
stops working.

### To remediate (owner)

1. **Rotate the Supabase DB password** — Supabase dashboard → Project `vpwdqtsxexpiqxzweivd`
   → Settings → Database → Reset database password. Do the same for staging
   (`zaxygxwadidiqcphibma`) if that one was ever real.
2. **Update the live consumers** — the Cloudflare Pages/Worker binding
   (`HYPERDRIVE` / `DATABASE_URL`) and `.dev.vars` locally. (These do NOT live in the repo.)
3. After rotation, the hardcoded strings in history are inert — no history rewrite needed.
4. Going forward, scripts read the connection string from `DATABASE_URL` (the audit scripts
   written 2026-07-22/23 already do: `const PROD = process.env.DATABASE_URL`).

### Already done (2026-07-23)

- The **login** password (`weisiang329@gmail.com`) was already rotated earlier (it 401s), and
  its plaintext copies were scrubbed from ~59 scripts → `process.env.HOOKKA_EMAIL` /
  `HOOKKA_PASSWORD`. That one is inert; this DB-password item is the remaining live exposure.

> Per the global rule §7 (secrets never pass through chat): this file exists to keep the
> reminder alive until the DB password is rotated. **Delete it once rotation is confirmed.**
