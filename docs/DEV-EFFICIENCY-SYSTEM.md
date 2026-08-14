# Hookka ERP — Development Efficiency System (the "big plan")

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `docs/` (file listing), `docs/PLAYBOOKS.md`
> (8 `##` procedures — the "8 procedures" claim is correct), `docs/context-packs/`,
> `docs/modules/` (15 guides), `src/lib/fe-rum.ts`, `src/pages/admin/`.
> Corrected 2026-08-13: `HOOKKA-GOTCHAS` lives at `docs/context-packs/HOOKKA-GOTCHAS.md`,
> not `docs/`. Note also that the roadmap below is now **behind reality** — see the
> status note added under "Build roadmap".

Goal: development that is **快 (fast) · 简单 (simple) · 省 (low token) · 无 bug · 准 (accurate)**.
This is the roadmap for our lightweight **ERP Center of Excellence (CoE)** — the system
that makes every future task start *fast, without long searching*. Read `docs/DOCS-INDEX.md`
→ this → the layer you need.

---

## The 6 layers (status)

| # | Layer | Plain meaning | Status | Assets |
|---|---|---|---|---|
| 1 | **Governance** | when to review-all vs not; 快准省; risk tiers | ✅ have | `DEV-OPERATING-FRAMEWORK`, `AI-DEVELOPMENT-MODES`, `LLM-CONTEXT-STRATEGY` |
| 2 | **Knowledge** | the traps + standards, don't relearn | ✅ strong | `context-packs/HOOKKA-GOTCHAS.md`, `BUG-HISTORY` (by date), **`BUG-CLASSES` (by class — makes P5 executable)**, `UI-CONVENTIONS`, MEMORY |
| 3 | **Reliability / Tracking** | never forget an ask, never skip a message | ⚠️ exists — must be USED (see below) | `WORK-TRACKER` + intake discipline |
| 4 | **Navigation** | go straight to the files — **no searching** | ✅ built | `CODEBASE-MAP.md` (**15 modules = whole system** + line-range index for ~30 monster files) |
| 5 | **Methodology** | fixed steps for recurring tasks | ✅ built | `PLAYBOOKS.md` (8 procedures) |
| 6 | **Data model** | entities/relationships + business glossary | ⚪ optional | ERD map + glossary |

---

## Layer 3 — the reliability fix (root cause: I have been skipping asks — owning it)

**Problem:** in a long multi-part message I act on the first ask and skip the rest; work
lives only in my head and gets forgotten. **Structural fix — request-intake discipline,
applied to EVERY message:**

1. **Parse every ask in the message into the queue FIRST** (Task tool + `WORK-TRACKER`)
   *before* starting any work — so nothing depends on me "remembering".
2. **Re-read `WORK-TRACKER` at the start of each turn and before reporting "done".**
3. Each ask is a tracked item with a status; a multi-part message becomes multiple items.
4. Code-work-in-progress lives on a **branch/worktree** — a durable artifact, not memory.

This is non-negotiable and overrides the urge to "just start coding the first thing".

---

## Build roadmap (ordered by token / efficiency ROI)

> **Status as of 2026-08-13 (verified against the tree):** items 1 and 2 are **done** —
> `docs/CODEBASE-MAP.md` plus 15 per-module guides in `docs/modules/` cover navigation, and
> `docs/PLAYBOOKS.md` ships 8 procedures (P1–P8), one more than the "~6" planned here.
> Item 3 is **not** done: `UI-DATA-DOCUMENT-STANDARDS.md` was never folded into
> `UI-CONVENTIONS.md` and both are still separate live docs. Item 4 is not done.

1. **Navigation maps** *(now — the biggest search-killer)* — per-module map + big-file
   section indexes so any task jumps straight to the right lines.
2. **Playbooks** *(the methodology — the biggest re-derive-killer)* — ~6 fixed procedures:
   add-a-field-end-to-end · fix-a-camelCase-read-bug · ship-a-PDF/email-change ·
   add-a-new-column (migration self-apply) · verify-live recipe · system-wide sweep.
3. **Light docs reorg** — group `DOCS-INDEX` into these 6 layers; merge the 2-3 redundant
   docs (`UI-DATA-DOCUMENT-STANDARDS` → `UI-CONVENTIONS`; the AI-* docs already linked).
4. **(Optional) Data dictionary + ERD map** — for 准 (accuracy), cheap to seed from MEMORY.

---

## How this stays current (self-maintenance)

The CoE is **not** a one-time snapshot — it stays current by two no-cost mechanisms (chosen
over a token-burning scheduled re-scan):

1. **Update-on-touch.** Whenever you work a module, refresh its `CODEBASE-MAP` entry as a
   byproduct — you're already in those files. Line numbers drift as files grow; the section
   *names* stay stable, so grep the named function near the listed line if it's off by a bit.
2. **Knowledge self-growth.** Every bug → `BUG-HISTORY.md` + a regression test; a task done
   3+ times → a new `PLAYBOOKS` entry; a new trap → `docs/context-packs/HOOKKA-GOTCHAS.md`.

> **The "line numbers drift, grep the named function" clause above is not a small caveat —
> it has already failed once, and the fix was to stop hand-maintaining.** Measured
> 2026-08-13: only 24.9% of the 891 `file:line` pointers in the hand-written
> `docs/SYMBOLS.md` still landed on a route registration, and 94 pointed past end-of-file.
> Update-on-touch did not hold for that file, so it was **deleted** and replaced by
> `docs/API.md`, generated from source by `node scripts/gen-api-docs.mjs`. Lesson: for any
> index that is mechanically derivable, generate it — a discipline that has to hold across
> 1,300 commits a month will not. Treat every remaining hand-held line number (CODEBASE-MAP,
> the module guides) as a hint, never as an offset to `Read` at blindly.

*Optional, OFF by default (costs tokens):* a scheduled monthly re-run of the mapping workflow
for a full line-number refresh + auto-pickup of new modules. Turn on only if hands-off
automation is worth the token cost.

---

## What else do big ERPs / CoEs have? (the full menu — what we have / build / skip)

| ERP / CoE asset | Plain meaning | Us |
|---|---|---|
| Governance / Change management | the rules for making changes | ✅ have |
| Knowledge base / runbooks | SOPs + hard-won traps | ✅ have |
| Navigation / integration catalog | find the code fast | ✅ have (`CODEBASE-MAP.md` + 15 `modules/*.md`) |
| Methodology / SOPs | fixed steps per task type | ✅ have (`PLAYBOOKS.md`, 8 procedures P1–P8) |
| **Data dictionary / glossary** | business terms → meaning (WIP, landed cost, consignment…) | ⚪ build — cheap, helps 准 |
| **ERD / data model map** | tables + relationships + FKs | ⚪ build — mostly in MEMORY already |
| Master Data Management (MDM) | clean, unique canonical codes | 🟡 partial (#3 code field, dup-merge) |
| **Test selection matrix** | which tests to run per change type | ⚪ build — cheap, speeds the safety net |
| Environments + release mgmt | dev/staging/prod + deploy gates | ✅ have (staging+prod, CI gate) |
| Observability + incident / DR | know when prod breaks + what to do | 🟡 partial (admin/health, fe-rum, `DR-RUNBOOK`) |
| Security / RBAC / audit | access control + audit trail | ✅ have |
| Config / feature-flag management | safe toggles | 🟡 partial (`kv-config`) |
| Backlog / roadmap governance | what's next, single source of truth | ✅ have (`WORK-TRACKER.md`, this doc). **`PROGRAM-90D` was archived 2026-08-13** — its 90 days elapsed in July; do not cite it as current. |
| Performance budgets | speed targets | ⏭️ skip — premature for us |
| CAB / formal release boards | committee sign-off on changes | ⏭️ skip — doesn't fit solo + AI + direct-to-main |

**Principle:** adopt the assets that cut tokens / bugs for a *small shop + AI* team; skip the
heavyweight enterprise rituals (CAB, perf budgets, formal onboarding) that assume a big team.
