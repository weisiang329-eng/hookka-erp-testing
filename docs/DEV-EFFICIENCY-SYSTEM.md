# Hookka ERP — Development Efficiency System (the "big plan")

Goal: development that is **快 (fast) · 简单 (simple) · 省 (low token) · 无 bug · 准 (accurate)**.
This is the roadmap for our lightweight **ERP Center of Excellence (CoE)** — the system
that makes every future task start *fast, without long searching*. Read `docs/DOCS-INDEX.md`
→ this → the layer you need.

---

## The 6 layers (status)

| # | Layer | Plain meaning | Status | Assets |
|---|---|---|---|---|
| 1 | **Governance** | when to review-all vs not; 快准省; risk tiers | ✅ have | `DEV-OPERATING-FRAMEWORK`, `AI-DEVELOPMENT-MODES`, `LLM-CONTEXT-STRATEGY` |
| 2 | **Knowledge** | the traps + standards, don't relearn | ✅ strong | `HOOKKA-GOTCHAS`, `BUG-HISTORY` (by date), **`BUG-CLASSES` (by class — makes P5 executable)**, `UI-CONVENTIONS`, MEMORY |
| 3 | **Reliability / Tracking** | never forget an ask, never skip a message | ⚠️ exists — must be USED (see below) | `WORK-TRACKER` + intake discipline |
| 4 | **Navigation** | go straight to the files — **no searching** | ✅ built | `context-packs/NAVIGATION-MAP.md` (**15 modules = whole system** + line-range index for ~30 monster files) |
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

1. **Update-on-touch.** Whenever you work a module, refresh its `NAVIGATION-MAP` entry as a
   byproduct — you're already in those files. Line numbers drift as files grow; the section
   *names* stay stable, so grep the named function near the listed line if it's off by a bit.
2. **Knowledge self-growth.** Every bug → `BUG-HISTORY.md` + a regression test; a task done
   3+ times → a new `PLAYBOOKS` entry; a new trap → `HOOKKA-GOTCHAS.md`.

*Optional, OFF by default (costs tokens):* a scheduled monthly re-run of the mapping workflow
for a full line-number refresh + auto-pickup of new modules. Turn on only if hands-off
automation is worth the token cost.

---

## What else do big ERPs / CoEs have? (the full menu — what we have / build / skip)

| ERP / CoE asset | Plain meaning | Us |
|---|---|---|
| Governance / Change management | the rules for making changes | ✅ have |
| Knowledge base / runbooks | SOPs + hard-won traps | ✅ have |
| Navigation / integration catalog | find the code fast | 🔨 building |
| Methodology / SOPs | fixed steps per task type | ⏭️ next |
| **Data dictionary / glossary** | business terms → meaning (WIP, landed cost, consignment…) | ⚪ build — cheap, helps 准 |
| **ERD / data model map** | tables + relationships + FKs | ⚪ build — mostly in MEMORY already |
| Master Data Management (MDM) | clean, unique canonical codes | 🟡 partial (#3 code field, dup-merge) |
| **Test selection matrix** | which tests to run per change type | ⚪ build — cheap, speeds the safety net |
| Environments + release mgmt | dev/staging/prod + deploy gates | ✅ have (staging+prod, CI gate) |
| Observability + incident / DR | know when prod breaks + what to do | 🟡 partial (admin/health, fe-rum, `DR-RUNBOOK`) |
| Security / RBAC / audit | access control + audit trail | ✅ have |
| Config / feature-flag management | safe toggles | 🟡 partial (`kv-config`) |
| Backlog / roadmap governance | what's next, single source of truth | ✅ have (`PROGRAM-90D`, this doc) |
| Performance budgets | speed targets | ⏭️ skip — premature for us |
| CAB / formal release boards | committee sign-off on changes | ⏭️ skip — doesn't fit solo + AI + direct-to-main |

**Principle:** adopt the assets that cut tokens / bugs for a *small shop + AI* team; skip the
heavyweight enterprise rituals (CAB, perf budgets, formal onboarding) that assume a big team.
