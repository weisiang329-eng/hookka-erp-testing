# Hookka ERP — Development Operating Framework (快 · 准 · 省)

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — re-measured: 410
> `tests/*.test.mjs` files, `npm test` = 4,123 tests / 0 fail (33 s idle, 208 s under load). Two corrections:
> the "don't re-derive" bullet had been corrected twice and ended up asserting that
> `docs/context-packs/HOOKKA-GOTCHAS.md` is **not** at `docs/context-packs/HOOKKA-GOTCHAS.md`;
> and `delivery-pipeline.ts` lives at `src/lib/`, not `src/api/lib/`. See
> `docs/DOCS-VS-CODE-AUDIT.md` rows D4–D6.
>
> **Previously verified: 2026-08-13** against `package.json`, `tests/` (375 `*.test.mjs` files),
> `migrations-postgres/`, `src/api/lib/` (`journal-hash.ts`, `document-lifecycle.ts`,
> `auth-middleware.ts`, `rbac.ts`, `tenant.ts`, `supabase-compat.ts`,
> `column-rename-map.json`), `src/lib/` and `docs/context-packs/`.
> Corrected 2026-08-13: the test count was ~4× too low; the root-level HOOKKA-GOTCHAS path is the
> wrong path (it lives under `docs/context-packs/`); `src/lib/payroll*` matches nothing;
> `column-rename-map.json` is in `src/api/lib/`, not at the repo root as the bare filename
> implied.

The standing manual for **how work gets done here**: fast (快), accurate (准),
economical (省), without breaking prod. Read this + `docs/LLM-CONTEXT-STRATEGY.md`
at the start of every session.

---

## The core question: do we review the whole system on every change?

**No. No real system does — it is impossible and it is slow.** Large systems
(SAP, Odoo, every serious SaaS) do **not** re-read the whole codebase per change.
They replace manual full-review with **automated guardrails + risk-tiered review**:

1. **Automated regression tests — the #1 safety net.** Tests catch breakage so you
   don't re-inspect everything by hand. Hookka has **410 test files** under `tests/`, and
   `npm test` reports **4,123 tests / 4,120 pass / 3 skip / 0 fail** (measured
   2026-08-14 on this branch; it was 375 files / ~3,700 cases on 2026-08-13, and "~993"
   before that — the count moves every few days, so re-measure rather than quote this).
   Wall-clock ranged 33 s idle to 208 s under concurrent load in the same session, so it is
   not a figure worth quoting at all. A deploy gate runs the suite on every push. **The rule that makes this work: when a bug slips
   through, add a test that would have caught it — so it can NEVER come back.**
   That is how the net gets *stronger* over time instead of you getting more
   paranoid.
2. **Type checking** — `npx tsc -p tsconfig.app.json --noEmit` (`build:strict`)
   catches contract breaks (wrong shapes, missing fields) before deploy.
3. **CI deploy gate** — every push re-runs typecheck + tests; a red gate blocks
   the deploy.
4. **Blast-radius review** — you review what the change can *affect*, not the whole
   system. A button label affects that button. A schema/money/cascade change
   affects the whole flow + everything downstream (reports, PDFs, accounting).
5. **Risk tiers** (`docs/AI-DEVELOPMENT-MODES.md`): Fast lane / Focused / Flow /
   Deep — match review depth to risk.

**So: "if we don't review everything, won't we get bugs?"** Occasionally — and
that's acceptable, because **(a)** the test net catches most regressions
automatically, **(b)** we add a test for each one so it can't recur, and **(c)**
the genuinely dangerous areas DO get deep review every time. We buy speed
everywhere and pay for safety only where it actually matters.

---

## The decision: FAST vs FOCUSED vs DEEP (use the smallest that fits)

### ALWAYS deep-review (slow down, trace the full flow, add/keep tests)
when the change touches any of these **HIGH-RISK areas** in Hookka:

| High-risk area | Why | Key files |
| --- | --- | --- |
| DB schema / migrations | migrations DON'T auto-apply — must wire the runtime self-apply | `migrations-postgres/`, `ensurePendingMigrations`/`ensureGrnMigrations` |
| Money / accounting / ledger | journal hash chain, payments, invoices | `src/api/lib/journal-hash.ts`, `accounting.ts`, `invoices.ts`, `payments.ts` |
| Payroll engine | day-typed OT, ÷26, costing divisor | `src/lib/pay-rules.ts`, `src/lib/generate-payslip-pdf.ts`, `src/pages/employees.tsx` (**corrected 2026-08-13 — no file matches `src/lib/payroll*`**) |
| Inventory cascade | stock movements, batches, cost ledger | `fg-units.ts`, stock-adjustment + `applyWipInventoryChange` |
| Status lifecycle | SO→PO→DO→Invoice transitions, delivery pipeline | `src/api/lib/document-lifecycle.ts`, `src/lib/delivery-pipeline.ts` (**not** `src/api/lib/` — it is shared with the frontend) |
| Security / RBAC / tenancy / auth | access + isolation | `auth-middleware.ts`, `rbac.ts`, `tenant.ts`, `users.ts` |
| Shared libs / cross-module | one edit hits many screens | `pdf-utils.ts`, `data-grid.tsx`, `utils.ts` |
| supabase-compat camelCase layer | silent 400s + read-undefined bite here | `src/api/lib/supabase-compat.ts`, `src/api/lib/column-rename-map.json` |

### FAST-LANE (edit + one quick check — no broad scan, no agent)
when **ALL** are true: no DB/schema change · no API contract change · no
auth/accounting/inventory/payroll/status change · no customer-facing PDF/email
data-shape change · the UI/component is easy to find.
*Examples that should be fast-lane: a font fix, a code-display split, a label/copy
change, a column width.*

### FOCUSED (read the one module's page + route + tests, small impact check, implement)
for normal single-module features/bugs. This is the default for most work.

---

## 快 · 准 · 省 working rules

- **Classify first, then use the smallest mode.** Don't broad-grep or spawn an
  agent for a small fix — do it inline.
- **Context-packs as entry maps** (`docs/context-packs/*`) — don't re-read the repo
  each time. Expand only along the real dependency path.
- **Agents / Workflows only for genuinely large or parallel work** (multi-file
  schema feature, system-wide sweep, audit). One UI fix ≠ an agent.
- **Batch tool calls; keep responses tight.** Less narration = fewer tokens.
- **Don't re-derive what's already mapped** — `MEMORY.md`, `docs/BUG-HISTORY.md`,
  `docs/context-packs/HOOKKA-GOTCHAS.md` (**that path is the correct one** — a 2026-08-13
  correction was applied twice here and left the line saying the file is not where it is),
  `docs/CODEBASE-MAP.md`, `docs/modules/*.md`.

## 准 — staying accurate without reviewing everything

- `build:strict` + `npm test` before **every** push.
- **Verify live on prod after every deploy — read AND write path** (deploy exit 0
  ≠ feature works).
- For any bug fixed: append to `docs/BUG-HISTORY.md` **and add a regression test**.
  This test-per-bug rule is the mechanism that lets us safely NOT review everything.

---

## Durable task tracking — so nothing gets forgotten

The owner sends many requests across a long session; without a durable record,
items slip. Three layers:

1. **`docs/WORK-TRACKER.md`** is the living, cross-session list of every assigned /
   in-progress / parked / shipped task (one line each, newest first). **Update it
   when a task is assigned, when it ships, when it's parked.**
2. **In-session:** > **UNVERIFIED ASSERTION** (as of 2026-08-13): the tool names
   `TaskCreate`/`TaskUpdate` are not checkable from this repo's source and depend on the
   agent harness in use; treat as owner intent, not fact. The intent — mirror the tracker
   in whatever in-session task list exists — stands.
   The Task tool (`TaskCreate`/`TaskUpdate`) mirrors the tracker
   for the current session. Code work in progress lives on a **branch/worktree** —
   a durable artifact, not just chat memory.
3. **Periodic self-review (the cadence):** at the **START of each session** and
   **BEFORE reporting "done"**, re-read the `MEMORY.md` index + `WORK-TRACKER.md`
   so no assigned item is dropped. If the owner gives 2+ asks in one message, log
   each into the tracker immediately before starting.

---

## Doc set — keep these canonical, fold the rest in

| Keep (canonical) | Role |
| --- | --- |
| **THIS file** | the operating manual (review-discipline + 快准省 + tracking) |
| `docs/LLM-CONTEXT-STRATEGY.md` + `docs/AI-DEVELOPMENT-MODES.md` | context-loading + mode framework |
| `docs/context-packs/*` | per-area entry maps |
| `docs/context-packs/HOOKKA-GOTCHAS.md` | hard-won Hookka-specific traps |
| `docs/CODEBASE-MAP.md` + `docs/modules/*.md` | the authoritative code map + the 15 per-module guides (added 2026-08-13 — this table predates both) |
| `docs/UI-CONVENTIONS.md` (+ fold in `UI-DATA-DOCUMENT-STANDARDS.md`) | UI/PDF/grid standards |
| `docs/BUG-HISTORY.md` | living bug log — source of truth |
| `docs/WORK-TRACKER.md` | durable task tracker |

`ENGINEERING-ONBOARDING-SOP.md` + the PR template describe a human-team flow we
don't use (solo + AI, direct-to-main) — keep for reference, don't enforce.
