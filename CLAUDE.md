# Hookka ERP — Start Here (read before any task)

> **Last verified: 2026-08-13** against `src/lib/api-client.ts` (global `window.fetch`
> CSRF patch), `src/api/lib/column-rename-map.json`, `src/lib/utils.ts` (`roundSen`),
> `src/components/ui/money-input.tsx`, `tsconfig.app.json`, `src/api/lib/self-apply.ts`,
> and the five docs it links (all exist). Every rule below still holds.
>
> **Docs freshness rule (2026-08-13):** every doc under `docs/` now carries a
> `Last verified: <date> against <what>` line under its title. **If a doc has no such
> line, or the date is old, treat it as UNVERIFIED and check the code before acting on
> it.** Docs that describe finished work live in `docs/archive/` and are not current.
> When you correct a doc, restamp it. This habit is the fix for the "same question,
> three different answers" problem — an unstamped doc used to be indistinguishable
> from a fresh one.

This repo has a lightweight **ERP Center of Excellence** that keeps work fast / accurate /
low-token. **Before any development task, consult the map — do NOT `grep`/`glob` the whole
repo: they TIME OUT on this repo's size (~1,600 tracked files). Use the map's file:line +
`Read offset/limit` to jump straight in:**

1. **Find the code** → [`docs/CODEBASE-MAP.md`](docs/CODEBASE-MAP.md)
   — all 15 modules → pages / routes / tables / tests + a line-range index for the ~30 big
   files. Jump to the listed lines instead of reading a 10k-line file or grepping.
2. **How to do it** → [`docs/PLAYBOOKS.md`](docs/PLAYBOOKS.md) — fixed steps for recurring
   tasks (add-a-field, fix-camelCase-read-bug, ship+verify, money field, fix-then-sweep,
   new grid / PDF, touching a monster file).
3. **Avoid the traps** → [`docs/context-packs/HOOKKA-GOTCHAS.md`](docs/context-packs/HOOKKA-GOTCHAS.md) — read before any
   schema / money / SQL / ship work.
3b. **Before fixing ANY bug** → [`docs/BUG-CLASSES.md`](docs/BUG-CLASSES.md) — the recurring
   classes and every known instance. Three classes have each been "fixed" three times because
   each fix repaired only the instance in front of the author. Find your bug's class, fix every
   open row, extend the class test.
4. **How deep to review** → [`docs/DEV-OPERATING-FRAMEWORK.md`](docs/DEV-OPERATING-FRAMEWORK.md)
   — fast-lane vs focused vs deep; the high-risk areas that always need deep review.

5. **Which endpoint** → [`docs/API.md`](docs/API.md) — **generated** from
   `src/api/worker.ts` + `src/api/routes/*.ts` by `node scripts/gen-api-docs.mjs`
   (139 mounts, 935 handlers, plus the exact public/auth surface). Regenerate it
   instead of hand-editing; `--check` tells you if it is stale.

Doc map: [`docs/DOCS-INDEX.md`](docs/DOCS-INDEX.md). The big picture: [`docs/DEV-EFFICIENCY-SYSTEM.md`](docs/DEV-EFFICIENCY-SYSTEM.md).

## Non-negotiable rules (the ones that bite hardest)
- **build:strict before every push:** `npx tsc -p tsconfig.app.json --noEmit`. The base
  `tsconfig.json` is looser and misses errors this catches. **Measured 2026-08-13: exit 0,
  zero errors** — the old "ignore the 3 jsbarcode / @zxing sandbox errors" carve-out did not
  reproduce on a clean install, so treat any error as yours.
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
- **Update-on-touch:** when you edit a module, refresh its `CODEBASE-MAP` entry as a byproduct,
  and restamp `Last verified:` on any doc whose claims you just changed or re-checked.
  A doc you leave stale is a wrong answer you have shipped to every future session.
