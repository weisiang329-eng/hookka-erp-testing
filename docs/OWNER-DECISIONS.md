# Owner decisions — the ONE list

> **Last verified: 2026-08-14** by enumerating every `owner decision` / `owner's call` /
> `needs the owner` marker across `docs/WORK-TRACKER.md`, `docs/BUG-CLASSES.md`,
> `docs/AUDIT-UNSWEPT-ROUTES.md`, `docs/CODEBASE-MAP.md`, `docs/PERF-BACKLOG.md`,
> `docs/DASHBOARD-DATA-AUDIT.md` and `docs/DOCS-VS-CODE-AUDIT.md`, then reading each in
> context. `docs/BUG-HISTORY.md` and `docs/archive/` are excluded by construction — a
> ledger narrates decisions already taken; counting history as backlog is the same
> category error as reading a migration as current state.

## Why this file exists

The owner asked what was waiting on him. The answer came back **53**, then **8**, then
**~30** — three different numbers within one conversation, because "what needs deciding"
lived scattered across six documents and was counted by pattern-matching prose. All three
were wrong. **A backlog nobody can count is a backlog nobody can clear.**

So this is the single register. Anything that needs the owner belongs here; the source
docs keep their detail and link back. `npm run trust` reads THIS file — the number stops
being something a script guesses from wording.

**Nothing here is a bug waiting to be fixed.** Every row is a question only the owner can
answer: a business rule, a customer-facing consequence, or a credential only he can enter.
Findings that merely need work are not on this list.

---


---

## ⚠️ READ THIS BEFORE THE TABLES — measured usage, 2026-08-14

The owner's observation, and he was right: **most of what follows touches features
barely in use.** The register was built by enumerating documents, not by asking which
features carry real data. Measured against prod:

| in daily use | rows |   | barely / not used | rows |
|---|---|---|---|---|
| sales orders | 1,385 |  | **employee advances** | **0** |
| supplier materials | 920 |  | **leave records** | **0** |
| invoices | 490 |  | **debit notes** | **0** |
| delivery orders | 396 |  | **delivery returns** | **0** |
| purchase orders | 165 |  | **fixed assets** | **0** |
| **payslips** | **138** |  | sales leads | 1 |
| service cases | 39 |  | journal entries | 2 |
| QC pending | 36 |  | payment vouchers / official receipts | route 404 |
| consignment orders | 18 |  | bank accounts (cash-flow) | route 404 |

**This corrects a priority I got wrong.** I ranked **A5** (payroll negative net pay)
second and said it "may pay someone wrong this month". It cannot, today: negative net pay
arises when advances exceed pay, **there are zero advances**, and **zero of the 138
payslips have a negative net pay**. It is LATENT — worth fixing before advances are ever
used, not urgent. I had read that from a document instead of from the data.

The same correction applies to **A6** (leave tiers — 0 leave records), **D2**
(receipts/vouchers — those routes 404), and much of **C**.

**What genuinely touches daily work:** A1 (the database holds all of the above),
A2 + C2 (invoices, 490 of them), A4 (payslips, 138 being generated), B1 (purchase orders,
165), B3/C1 (supplier materials, 920 rows).

Each row below is now tagged **[LIVE]** or **[LATENT]** accordingly. A LATENT row is not
worthless — it is cheap insurance to fix before the feature is switched on — but it should
never outrank something touching a document that goes to a customer.

## A — Money and people. These have a cost per day of not deciding.

| # | Decision | Blocked / at stake | Recommendation |
|---|---|---|---|
| **A1** | [LIVE] **Rotate the two database passwords.** Four places: Supabase, Cloudflare Hyperdrive ×2, GitHub secrets, local `.dev.vars`. Runbook: `docs/runbooks/ROTATE-DB-PASSWORDS.md`. | The credential in use is **publicly readable on GitHub right now** — not the old leak (that one is dead), the *replacement*. Assume captured. | **Do this first.** Passwords go straight into the dashboards; they must not pass through chat. Do not miss the GitHub secret — the site stays fine but the nightly backup fails silently. |
| **A2** | [LIVE] **~RM 18,000 of height-surcharge under-billing across ~200 SENT invoices** (`WORK-TRACKER:1370`). Re-issue? Debit note? Absorb the old ones and bill correctly from here? 336 further lines were skipped as ambiguous and are in no total. | No invoice has been amended and none will be until this is answered. Customer-facing. | Absorb the issued ones and bill correctly forward, unless the customer relationship makes a debit note routine. Correcting 200 sent invoices costs more trust than RM 18k. |
| **A3** | [LIVE] **RM 440 SO↔invoice divergence, 5 lines, 2 of them PAID** (`BUG-2026-07-17-002`). SOs carry the surcharge, invoices read 0. All three are **Houzs Century — your own company**. | Two are PAID, so it is an accounting decision, not a re-send. | Fix the one unpaid invoice (RM 80); record the RM 360 on paid invoices as accepted. Internal company, small sum, and restating paid invoices costs bookkeeping for nothing. |
| **A4** | [LIVE] **PCB rate schedule must be confirmed by your tax agent** before it is switched on for anyone. Computed by `src/lib/pcb.ts`; per-worker flag `workers.pcb_enabled`. | 1 of 42 workers currently has the flag TRUE. With the tax profile blank the payslip prints "cannot be computed" — it does **not** withhold. | Confirm the schedule, then fill the tax profile (residency / category / child relief) for whoever should have PCB. Under-withholding leaves the employee owing LHDN; over-withholding takes their money now. |
| **A5** | [LATENT] **Payroll: three open items** (`WORK-TRACKER:3771`) — negative net pay is not clamped and does not carry forward; "Total Pay" now means what is still to be handed over, so it no longer equals Labor Cost when advances exist; settling is tied to payroll APPROVAL, not generation. | Affects what a worker is handed. | Decide the carry-forward rule first — a negative net pay that neither clamps nor carries is the one that produces a wrong payment. |
| **A6** | [LATENT] **Annual leave: flat 8 days, or statutory tiers** (<2y 8 · 2–5y 12 · >5y 16)? Mechanism is built; the default deliberately reproduces today's 8/14 so nothing changed on deploy. | Nobody's balance moves until this is answered. | Statutory tiers — it is the legal floor and the mechanism already exists. But it is your call whether Hookka gives more than the minimum. |

---

## B — Which number is the real one. Two figures currently disagree in public.

| # | Decision | Why it matters | Recommendation |
|---|---|---|---|
| **B1** | [LIVE] **Does a DRAFT purchase order count as "on order"?** `/planning/mrp` and `/accounting/cash-flow` currently answer this **opposite ways**. | Same question, two screens, two answers. One ruling covers both. | Exclude drafts from MRP (a draft cannot arrive) and include them in cash-flow only as a separate "committed but not issued" line. |
| **B2** | **AR aging vs AP aging vs the control accounts** — three "what we are owed / what we owe" figures with different definitions on one page. | A reader cannot tell which is authoritative. | Name the control account as *the* number and label the other two as views of it. |
| **B3** | [LIVE] **What does a blank MOQ / lead time mean?** Both columns are `NOT NULL DEFAULT 0`, so blank has no encoding of its own. Creating a binding no longer invents 7/1 — it writes 0, which the reader shows as "—". | Existing rows created before the fix carry a 7 and a 1 that cannot be told from real values. | Accept 0 = unknown (already shipped). For the old rows see C1. |
| **B4** | **Is real production time going to be measured at all?** `job_cards.completed_at` now records completions; BOM standard time remains the basis of production hours by your ruling. | Only matters if workers scan **at completion**. Scanning the next morning makes the timestamp misleading. | Leave it accumulating and decide later — it costs nothing and is not read by any metric today. |
| **B5** | **P&L bucket mapping** (`PERF-BACKLOG:141`) — which accounts roll into which bucket. Explicitly flagged "do NOT invent". | Until answered the grouping cannot be trusted. | Give the mapping once; it is a finance decision, not an engineering one. |

---

## C — Historical data. Deciding "leave it" is a valid answer, and often the right one.

| # | Decision | Recommendation |
|---|---|---|
| **C1** | [LIVE] Supplier bindings created before the fix carry an invented **7-day lead time / MOQ 1**, indistinguishable from real values. | Leave them. The information to tell them apart was never recorded — correcting would be inventing a second time. Fix them as they are next edited. |
| **C2** | [LIVE] **Invoice→SO line backfill**: 2,533 lines link exactly, 147 are contested and stay NULL. Writes only `so_item_id`; touches no amount. | **Run it.** It is additive, refuses ambiguity, and it is what makes the book auditable. It needs your go-ahead because a safety guard blocked me. |
| **C3** | [LIVE] **2,839 pending QC inspections back to 2026-04-28** (`WORK-TRACKER:1207`). `POST /api/qc-pending/bulk-skip` exists, is reviewed, and has never been run. | Confirm they are genuinely abandoned, then run the dry-run first. |
| **C4** | **Vehicle plate collisions** (`WORK-TRACKER:1158`) — which duplicate wins, and what happens to the loser's history. New duplicates are already blocked. | Keep the one with movement history; retire the other. |
| **C5** | **OCEAN SKY DO 26061056** carries two invoices — 2,058.64 kept, 1,410.90 voided. If the DO really is 3,469.54 billed in two parts, the voided one is a real payable. | Check the delivery. If both parts shipped, restore it. |
| **C6** | **SO-2607 rows carrying state 'KL'** (`WORK-TRACKER:1294`) — assign hub-h1, or leave unassigned. | Assign; an unassigned hub silently drops rows from hub-filtered views. |

---

## D — Conventions and cleanup. No money at stake; they cost clarity.

| # | Decision |
|---|---|
| **D1** | `/analytics/forecast` is UNREACHABLE — delete it, or route it. |
| **D2** | [LATENT] `/payment-vouchers` has a `/restate` endpoint; `/official-receipts` does not. Add it, or document why not. |
| **D3** | `/admin/health` KPIs and agent-console FX/LLM prices are seeded-random constants. They are tagged `_mock`, so they are honest — keep, or wire to real sources? |
| **D4** | R&D material unit cost uses six hardcoded per-item-group constants. Real costing, or label as an estimate? |
| **D5** | `deploy.yml:294` tells every reviewer the canary "is wired to the same Hyperdrive as production" — the exact belief `CANARY-DEPLOY.md` exists to kill. It is a workflow string, so it was recorded rather than edited. |
| **D6** | The commit convention points at a doc that has moved; repointing it changes a standing convention. |

---

## Not on this list, and why

**Findings that need work, not a decision, are not here** — those live in
`docs/DASHBOARD-DATA-AUDIT.md` and `docs/DOCS-VS-CODE-AUDIT.md` and are mine to finish:
the `× 0.85` sites outside `attendance.ts`, `/api/cash-flow` having no permission gate,
and the `actualMinutes ?? estMinutes` pattern surviving at ~30 sites.

**30 UNMEASURED markers** are also not decisions. They are questions needing a live query,
which no agent could run without database credentials. They resolve with A1, not with a
ruling.
