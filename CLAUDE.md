# Hookka ERP — Start Here (read before any task)

This repo has a lightweight **ERP Center of Excellence** that keeps work fast / accurate /
low-token. **Before any development task, consult it — do not grep the repo blind:**

0. **Current foundation/staging programme** →
   [`docs/FOUNDATION-EXECUTION-LEDGER.md`](docs/FOUNDATION-EXECUTION-LEDGER.md)
   — exact staging SHA, merged PRs, active blocker, resume procedure, validation
   evidence, and remaining FE/BE/DB/performance backlog. It overrides stale
   routing or status statements in older handoff documents.
1. **Find the code** → [`docs/context-packs/NAVIGATION-MAP.md`](docs/context-packs/NAVIGATION-MAP.md)
   — all 15 modules → pages / routes / tables / tests + a line-range index for the ~30 big
   files. Jump to the listed lines instead of reading a 10k-line file or grepping.
2. **How to do it** → [`docs/PLAYBOOKS.md`](docs/PLAYBOOKS.md) — fixed steps for recurring
   tasks (add-a-field, fix-camelCase-read-bug, ship+verify, money field, fix-then-sweep,
   new grid / PDF, touching a monster file).
3. **Avoid the traps** → [`docs/context-packs/HOOKKA-GOTCHAS.md`](docs/context-packs/HOOKKA-GOTCHAS.md) — read before any
   schema / money / SQL / ship work.
4. **How deep to review** → [`docs/DEV-OPERATING-FRAMEWORK.md`](docs/DEV-OPERATING-FRAMEWORK.md)
   — fast-lane vs focused vs deep; the high-risk areas that always need deep review.

Doc map: [`docs/DOCS-INDEX.md`](docs/DOCS-INDEX.md). The big picture: [`docs/DEV-EFFICIENCY-SYSTEM.md`](docs/DEV-EFFICIENCY-SYSTEM.md).

## Non-negotiable rules (the ones that bite hardest)
- **build:strict before every push:** `npx tsc -p tsconfig.app.json --noEmit` (ignore only the
  3 jsbarcode / @zxing sandbox errors). The base `tsconfig.json` is looser and misses these.
- **Migrations do NOT auto-apply on deploy** — a new column reaches prod ONLY via the runtime
  self-apply (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, awaited at the top of the POST/PUT
  before the first write). A migration file alone is inert.
- **New DB columns = snake_case** (a camelCase column in route SQL needs a
  `column-rename-map.json` entry or it silently 400s). Read rows dual-keyed:
  `r.camelCase ?? r.snake_case`.
- **Money = integer sen** (RM × 100); use `MoneyInput` / `roundSen`, never floats.
- **CSRF is automatic** — `src/lib/api-client.ts` globally patches `window.fetch` to inject
  `X-CSRF-Token` on every mutating `/api/*` call. No raw fetch is "missing CSRF"; an audit that
  flags "N fetches missing the CSRF token" is ALL false positives — don't add `csrfHeaders()`.
- **QR / sticker URLs encode `window.location.origin`** (the print-time domain); scanning is
  path-based + domain-agnostic but resolves against the DB of whatever site you scan ON.
- **Verify live on prod after every deploy** — read AND write path. Log every bug to
  `docs/BUG-HISTORY.md` and add a regression test.
- **UI is 100% English.** Bug fixes merge straight to `main`; features go to `staging`.

## Working discipline
- Classify each task → use the SMALLEST mode. Don't spawn agents / broad-grep for small fixes.
- **Log every ask from a multi-part message into `docs/WORK-TRACKER.md` FIRST**, before working
  — don't skip asks. Re-read it at session start and before reporting done.
- **Update-on-touch:** when you edit a module, refresh its `NAVIGATION-MAP` entry as a byproduct.
