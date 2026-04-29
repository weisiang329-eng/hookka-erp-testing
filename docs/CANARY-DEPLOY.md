# Canary Deploys on PR — Phase B.5

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
2. Same lint + test + `build:strict` gate as production.
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

## What canary deploys share with production

The Pages project is the same — every branch slug shares the same
bindings:

* `HYPERDRIVE` → live Supabase (production data)
* `DB` (D1) → live D1 database
* `SESSION_CACHE` (KV) → live KV namespace
* Supabase Storage credentials (`SUPABASE_PROJECT_REF`,
  `SUPABASE_SERVICE_KEY`) → live Supabase Storage bucket when set
* All `[vars]` from `wrangler.toml`

This means **canary deploys CAN write to production data**. That's
intentional — it lets you test mutations against real bindings without
maintaining a separate "preview" Postgres and re-seeding it. But it
also means:

* Reviewers MUST avoid destructive actions on canary unless the PR is
  about those actions.
* Long-running mutations (mass updates, schema changes) MUST be tested
  in a local `wrangler pages dev` first.
* Migrations are NOT applied from canary deploys — only from main
  pushes. So a PR that depends on a new migration will hit "column
  not found" errors until merged. That's by design (no schema drift
  from PRs).

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
(`hookka-erp-testing.pages.dev`) in another, walk the same flow, look
for behavioral diffs.

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

* **Branch deploys for teammates.** The `claude/**` branches deploy
  via push events; teammate branches do not. Once we standardize on a
  PR-only workflow (Phase B.6), the canary handles every branch.
* **Smoke test in CI on the canary URL.** Run `playwright` against the
  preview URL after deploy and fail the PR if homepage, login, and
  pg-ping don't all return 200. Tracked as Phase B.6.
* **Per-tenant test data on canaries.** Once Phase C #1 lands fully,
  each canary could be wired to a synthetic tenant so reviewers can
  break things without touching production data. Tracked as Phase D.
