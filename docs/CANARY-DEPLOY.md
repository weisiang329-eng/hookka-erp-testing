# Canary Deploys on PR — Phase B.5

> **Last verified: 2026-08-13** against `.github/workflows/deploy.yml` (the `Deploy to Cloudflare Pages (canary)` step and its `github-script` comment), `src/api/worker.ts:293-311` (`isPreviewHostname` / `pickDbUrl`), and `wrangler.toml` (`[[hyperdrive]] HYPERDRIVE` + `HYPERDRIVE_STAGING`).
> Corrected 2026-08-13: the "What canary deploys share with production" section was backwards and listed a binding that no longer exists. Canary URLs are `*.hookka-erp-testing.pages.dev`, which `isPreviewHostname` classifies as PREVIEW, so they hit **staging Supabase, not production**. And there is no D1 binding — it was retired 2026-04-27.

**Status:** Live as of 2026-04-25 (`feat(ci): canary deploy on PR`).

Every pull request targeting `main` automatically deploys to a unique
Cloudflare Pages preview branch and comments the preview URL on the
PR. Reviewers test the change against real Pages infrastructure
(Hyperdrive → Supabase, KV `SESSION_CACHE`, Supabase Storage when the
service-role key is set) before merging — no more "looks fine on my
laptop, broke on prod."

---

## How it works

1. PR open / push to PR head → `.github/workflows/deploy.yml` runs.
2. Same job as production: `npm run lint:app` (non-blocking,
   `continue-on-error: true`), `npm test`, then `npm run build:strict`
   (BLOCKING — a TS error fails the deploy). The bundle-size budget step
   is also non-blocking.
3. On success, the workflow runs:
   ```bash
   wrangler pages deploy dist \
     --project-name=hookka-erp-testing \
     --branch=canary-<PR_NUMBER>
   ```
4. Cloudflare Pages auto-issues a preview URL of the form:
   ```
   https://canary-<PR_NUMBER>.hookka-erp-testing.pages.dev
   ```
5. A bot comment is posted (or updated if it already exists) with the
   URL and a link to this doc.

The main-branch deploy path is **unchanged**. Pushes to `main` and
`claude/**` continue to deploy to the matching branch slug exactly as
before.

---

## What canary deploys share with production — and what they do NOT

The Pages project is the same, so every branch slug receives the same
*bindings*:

* `HYPERDRIVE` → prod Supabase, and `HYPERDRIVE_STAGING` → staging Supabase.
  **Both are bound; the worker picks between them at runtime.**
* `SESSION_CACHE` (KV) → live KV namespace (shared with production)
* `ERP_METRICS` (Analytics Engine) → same dataset
* Supabase Storage credentials (`SUPABASE_PROJECT_REF`,
  `SUPABASE_SERVICE_KEY`) → live Supabase Storage bucket when set
* All `[vars]` from `wrangler.toml`

There is **no D1 binding**. It was removed from `wrangler.toml` on
2026-04-27 (commit `7059259`); the deploy workflow's own PR comment says
so. Any doc or review checklist that tells you to check D1 on a canary is
out of date.

### The database a canary actually talks to: STAGING

`pickDbUrl` (`src/api/worker.ts:305`) routes on the request **hostname**,
not on an env var — Cloudflare Pages ignores `[env.preview.vars]` and locks
dashboard vars once `wrangler.toml` defines `[vars]`, so hostname is the
only reliable signal. `isPreviewHostname` (`worker.ts:293`) returns:

* `hookka-erp-testing.pages.dev` exactly → production
* anything else ending in `.hookka-erp-testing.pages.dev` → **preview**
* a custom domain (`erp.hookka.com`) → production

A canary URL is `https://canary-<PR>.hookka-erp-testing.pages.dev`, which
matches the second rule. So a canary reads and writes **staging Supabase
(`HYPERDRIVE_STAGING`)**, not production.

Consequences — the opposite of what this doc used to say:

* Canary writes do NOT reach production data. Destructive testing on a
  canary is comparatively safe.
* But a canary is NOT a production-data test either. "It worked on the
  canary" says nothing about prod row counts, prod-only data shapes, or
  prod schema drift. `docs/PRE-DEPLOY-CHECKLIST.md` exists precisely
  because that gap caused the 2026-04-29 outage.
* Staging schema can lag prod. A PR depending on a new migration will hit
  "column not found" on the canary until someone applies it to staging —
  migrations are never applied automatically by any deploy
  (`.github/workflows/deploy.yml` only prints a reminder).

---

## Reviewer checklist

When you click the canary URL, run through:

1. **Login flow** — does the SPA load? Does `/api/health` return ok?
2. **The change itself** — exercise the code path the PR touches. If
   the PR adds a new endpoint, hit it. If it changes a UI page, walk
   through the affected workflow.
3. **Console errors** — open devtools. PR fails if there are uncaught
   exceptions on the canary that aren't on production.
4. **Network panel** — same. Watch for unexpected 4xx/5xx that aren't
   in production.
5. **Performance** — for performance-sensitive PRs, compare canary vs.
   production load times on the same page.

Compare side-by-side: open canary in one tab, production
(`https://erp.hookka.com` — the pages.dev URL also still resolves and is
in the CORS allowlist) in another, walk the same flow, look for
behavioral diffs. Remember the two tabs are on **different databases**
(staging vs prod), so data differences are expected and only *behavioral*
differences are signal.

---

## Promoting to main

Just merge the PR. The push event on `main` re-runs the workflow and
deploys to the production branch slug.

There is no separate "promote canary" step. The canary preview branch
on Pages is left around (Cloudflare auto-prunes after 30 days of no
deploys); it's harmless because the URL is only discoverable via the
PR comment.

To force-clean a canary preview before that:

```bash
wrangler pages deployment list --project-name=hookka-erp-testing
wrangler pages deployment delete <deployment-id>
```

---

## Cost / quota notes

* Canary deploys count against the project's preview-branch quota
  (Pages Free: 100 unique preview branches; Paid: 500). At our PR
  cadence (~5/week → ~250/year), Free is enough but not by much.
* Each preview URL is publicly accessible by anyone with the link.
  Don't paste the URL in public Slack channels for PRs that touch
  sensitive code paths.

---

## Rollback

If the canary workflow itself breaks (e.g. the github-script comment
bot starts erroring), edit `.github/workflows/deploy.yml` and gate
the canary block off:

```yaml
- name: Deploy to Cloudflare Pages (canary)
  if: false  # disabled — canary broken, see issue #N
  ...
```

The main-branch deploy stays green because it's a separate `if:` block.

---

## What's next (out of scope here)

* **Branch deploys for teammates.** `main`, `claude/**` and `staging`
  deploy via push events; other teammate branches do not. Once we
  standardize on a PR-only workflow (Phase B.6), the canary handles every
  branch.
* **Smoke test in CI on the canary URL.** Run `playwright` against the
  preview URL after deploy and fail the PR if homepage, login, and
  pg-ping don't all return 200. Tracked as Phase B.6.
* **Per-tenant test data on canaries.** Once Phase C #1 lands fully,
  each canary could be wired to a synthetic tenant so reviewers can
  break things without touching production data. Tracked as Phase D.
