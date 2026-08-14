# Runbook — rotate the two database passwords

> **Last verified: 2026-08-14** against `wrangler.toml` (both `[[hyperdrive]]` blocks),
> `.github/workflows/backup.yml`, `.github/workflows/analyze-staging.yml`, `gh secret list`,
> and `.gitignore`. Every location below was confirmed to exist; no value was read.

**This runbook is executed BY THE OWNER, not by Claude.** Passwords are entered directly
into the Supabase and Cloudflare dashboards. They must never be pasted into a chat, a
file, a commit, or a terminal command that gets logged. Claude prepared the steps and
will verify afterwards from the *outside* — by checking that the app still works — never
by handling the value.

---

## STATUS 2026-08-14 — read this first, the situation is not what it was

The 2026-07-20 leak (commits `1294db69` / `76687226`) **was already rotated.** Proven
by fingerprint without printing any value: those commits carry `276404ee6640` (direct)
and `cd9baa74ed36` (pooler); the credential the system actually used afterwards
fingerprints `ab5df625bc76` — a different, later value. The stale copy still in
`.dev.vars` is one of the leaked pair, which is exactly why it now fails `28P01
password authentication failed`.

**But the rotation created a second, worse exposure.** The replacement password was
written into `export HOOKKA_PROD_DB_URL=…` example comments in three tracked scripts
(`scripts/_db.mjs`, `check-fg-ledger.mjs`, `reset-wip-quantities.mjs`). When the repo
went public those comments went with it, so the **live** production password was
readable by anyone on GitHub until it was scrubbed on 2026-08-14.

So the rotation below is still required — not for the old leak, which is dead, but for
`ab5df625bc76`, which must be assumed captured. Removing it from HEAD does not remove
it from history.

A gate now exists so this cannot recur silently: `scripts/check-secrets.mjs` +
`.github/workflows/secret-hygiene.yml`, plus a pre-commit hook. A workflow of that name
existed before and was deleted; if it disappears again, that deletion is the incident.

**This file supersedes `docs/SECURITY-ROTATION-TODO.md` and
`docs/SECURITY-db-credential-rotation.md`, both deleted 2026-08-14** — three documents
on one open item is how the item stayed open.

---

## Why this is outstanding work, not a precaution

Git history contains full prod **and** staging Postgres connection strings, passwords
included, in commits **`1294db69`** and **`76687226`** — commits whose own titles are
about removing embedded credentials. Removing them from HEAD never removed them from
history.

The repository is **public**. Public GitHub is scraped continuously and automatically for
exactly this pattern. Treat both passwords as **already disclosed**.

Consequences that follow from that, and that change what "fixing" means:

- **Rewriting git history does not help.** The exposure already happened. Only changing
  the passwords ends it.
- **This is remediation, not hygiene.** It was deferred by an explicit owner decision
  («这两个放最后»), which is a scheduling call — not a cancellation.
- Returning the repo to private is a *separate, later* step. It does not undo the
  disclosure either.

---

## The rotation surface — FOUR places, not one

A password change in Supabase alone will break the app, because three other systems hold
a copy of the connection string. Miss one and you get either an outage or a system still
presenting the old password.

| # | System | What holds it | Notes |
|---|---|---|---|
| 1 | **Supabase** | the database role's password — the source of truth | prod project + staging project |
| 2 | **Cloudflare Hyperdrive** | the connection string inside each Hyperdrive config | `HYPERDRIVE` → `b0fc9d10217c42bfa793b050d1abed65` (prod)<br>`HYPERDRIVE_STAGING` → `759227c0381a4a19ab7537ea48a1560f` (staging) |
| 3 | **GitHub Actions secrets** | `PROD_DATABASE_URL` (set 2026-05-11), `STAGING_DATABASE_URL` (set 2026-08-02) | used by `backup.yml` (`pg_dump`) and `analyze-staging.yml` |
| 4 | **This machine** | `.dev.vars` (25 lines, gitignored) | local `wrangler dev` only; nothing in prod reads it |

Cloudflare account for all of the above: `27cd35c9d93a9f81daa809d0b800b059`
(**Weisiang329@gmail.com**, not the hello@houzscentury.com account).

---

## Order of operations

There is a window between changing the password in Supabase and updating Hyperdrive
during which the live site cannot reach the database. Keep it short: open every tab
first, change last.

**Do STAGING end-to-end first.** It is the same procedure with no customer impact, and it
proves the sequence before you touch production.

### Before you start
1. Open, and log into, all of these in separate tabs:
   - Supabase → the project → **Settings → Database**
   - Cloudflare → **Storage & Databases → Hyperdrive** → the config for that env
   - GitHub → repo → **Settings → Secrets and variables → Actions**
2. Have a password manager ready to generate and store the new password. Generate it
   **in the password manager**, not by hand.

### For each environment (staging first, then production)
1. **Supabase** → Settings → Database → **Reset database password**. Generate, copy,
   store in the password manager.
2. **Cloudflare Hyperdrive** → edit that env's config → paste the new connection string
   → save. (Prod = `b0fc9d10…`, staging = `759227c0…`.)
3. **GitHub secret** → update `PROD_DATABASE_URL` (or `STAGING_DATABASE_URL`) with the
   new full connection string.
4. **Redeploy** so the Worker picks up the refreshed Hyperdrive config:
   ```bash
   CLOUDFLARE_ACCOUNT_ID=27cd35c9d93a9f81daa809d0b800b059 npx wrangler pages deploy dist --project-name=hookka-erp-testing --branch=main --commit-dirty=true
   ```
5. **Local only, on this machine:** update the `DATABASE_URL` line in `.dev.vars`. This
   file is gitignored (`.gitignore:36-37`) and affects nothing but local `wrangler dev`.

---

## Verification — check all four, not just the website

A green homepage only proves Hyperdrive. Two of the four are invisible from the UI, and
a broken backup is exactly the failure you would not notice until you needed it.

1. **App reads and writes.** Load `https://erp.hookka.com`, open Sales Orders and
   Invoices, then perform one small real edit and confirm it persists after a refresh.
   Claude can do this step and report the result.
2. **The nightly backup still runs.** Trigger `backup.yml` manually
   (Actions → Backup → Run workflow) and confirm it succeeds. If `PROD_DATABASE_URL` was
   missed, this is where it shows up — and it is the one that fails silently until the
   day you need a restore.
3. **`analyze-staging.yml`** still runs, proving `STAGING_DATABASE_URL`.
4. **Local dev** starts and connects.

---

## After both are rotated

- The old passwords in commits `1294db69` / `76687226` become **dead strings**. They stay
  in history and that is now harmless.
- Record the rotation date in `docs/BUG-HISTORY.md`, and update the memory note
  `hookka-perf-serialization` (its "THE REPO IS PUBLIC" section), which currently
  instructs every session to keep raising this.
- Only then consider returning the repo to private — and note the trade-off: **while the
  repo is public an off-vendor backup cannot be added**, because workflow artifacts on a
  public repo are downloadable by anyone, so uploading a database dump would publish the
  entire production database. That is why `backup.yml` deliberately has no
  `upload-artifact` step.
