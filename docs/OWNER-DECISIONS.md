# Owner decisions — the ONE list

> **Last verified: 2026-08-19** — every row re-read against the source it cites. What changed
> this pass: **D1, D3 and D4 were describing code that has moved on**; **C6 gained the repair
> path that landed today**; **C7 is new**; and **B3 / C3 / C5 were reworded** because their
> prose accidentally satisfied `trust-report.mjs`'s settled-row regex (`/DECIDED|DONE|PARKED|
> CLOSED|SHIPPED/i`) — "already shipped", "genuinely abandoned" (aban·**done**·d) and "if both
> parts shipped" were each being counted as a ruling the owner had already given. **The open
> count therefore RISES from 17 to 21 without a single new problem appearing**; it was under-
> reported. Files opened this pass: `src/dashboard-routes.tsx:471,548`,
> `src/components/layout/sidebar.tsx:280`, `src/api/routes/accounting.ts:8316,8584,8643,8765`,
> `src/api/routes/admin-health.ts:72-97`, `src/api/lib/agent-console.ts:351-353`,
> `src/api/routes/rd-projects.ts:195-205,330-352`, `.github/workflows/deploy.yml:294`,
> `docs/CANARY-DEPLOY.md:70-78`, `docs/AGENTS-COMMIT-HYGIENE.md:43,51`,
> `docs/SDK-MIGRATION-STATUS.md:90-91`, `src/api/routes/fg-units.ts:789-853`,
> `src/api/routes/sales-orders.ts:706-718,900-931`, `src/api/routes/qc-pending.ts:2459`,
> `src/api/routes/three-pl-vehicles.ts:153`, `src/lib/pcb.ts:352`,
> `src/lib/leave-entitlement.ts:266`, `migrations-postgres/0228_job_cards_completed_at.sql`,
> and the six `docs/WORK-TRACKER.md` / `docs/PERF-BACKLOG.md` line citations (1158, 1207,
> 1294, 1370, 3771, 141 — all still resolve to what the rows say they do).
>
> **Four things merged on 2026-08-19 and NONE of them closes a row here** — they were defects,
> not rulings: BUG-2026-08-19-155 (SO scan modal keeps the customer's original PO, `#336`),
> BUG-2026-08-19-156 (supplier scan modal keeps the source document on the PI, `#337`),
> BUG-2026-08-19-157 (a hub change now cascades to `fg_units` from all five handlers, `#338`),
> and the six module-guide audit (`#339`). **157 did produce a new question for you — C7.**
>
> Prior stamp, 2026-08-14: built by enumerating every `owner decision` / `owner's call` /
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

**Editing rule (added 2026-08-19):** `npm run trust` counts a row as SETTLED if the row's line
contains `DECIDED`, `DONE`, `PARKED`, `CLOSED` or `SHIPPED` (case-insensitive, **substring**).
So an OPEN row must not say "already shipped", "genuinely abandoned" (aban·**done**·d),
"disclosed", or quote an identifier containing one of those words. Use those five words ONLY
when you mean the owner has ruled. Three rows were silently mis-counted this way until
2026-08-19.

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
| **A4** | ✅ **DECIDED 2026-08-14 — correct as is.** The owner confirms only ANN should carry PCB/EPF; the other 41 are not liable. No change needed. Note the calculation still needs the tax profile (residency / category / child relief) before it can withhold anything for her, and the rate schedule still wants his tax agent's eye. Original entry: **PCB rate schedule must be confirmed by your tax agent** before it is switched on for anyone. Computed by `src/lib/pcb.ts`; per-worker flag `workers.pcb_enabled`. | 1 of 42 workers currently has the flag TRUE. With the tax profile blank the payslip prints "cannot be computed" — it does **not** withhold. | Confirm the schedule, then fill the tax profile (residency / category / child relief) for whoever should have PCB. Under-withholding leaves the employee owing LHDN; over-withholding takes their money now. |
| **A5** | [LATENT] **Payroll: three open items** (`WORK-TRACKER:3771`) — negative net pay is not clamped and does not carry forward; "Total Pay" now means what is still to be handed over, so it no longer equals Labor Cost when advances exist; settling is tied to payroll APPROVAL, not generation. | Affects what a worker is handed. | Decide the carry-forward rule first — a negative net pay that neither clamps nor carries is the one that produces a wrong payment. |
| **A6** | [LATENT] **Annual leave: flat 8 days, or statutory tiers** (<2y 8 · 2–5y 12 · >5y 16)? Mechanism is built; the default deliberately reproduces today's 8/14 so nothing changed on deploy. | Nobody's balance moves until this is answered. | Statutory tiers — it is the legal floor and the mechanism already exists. But it is your call whether Hookka gives more than the minimum. |

---

## B — Which number is the real one. Two figures currently disagree in public.

| # | Decision | Why it matters | Recommendation |
|---|---|---|---|
| **B1** | ⏸️ **PARKED 2026-08-14 — MRP is not in use yet** (owner). Revisit before MRP goes live; until then the two screens disagreeing costs nothing. Original entry: **Does a DRAFT purchase order count as "on order"?** `/planning/mrp` and `/accounting/cash-flow` currently answer this **opposite ways**. | Same question, two screens, two answers. One ruling covers both. | Exclude drafts from MRP (a draft cannot arrive) and include them in cash-flow only as a separate "committed but not issued" line. |
| **B2** | **AR aging vs AP aging vs the control accounts** — three "what we are owed / what we owe" figures with different definitions on one page. | A reader cannot tell which is authoritative. | Name the control account as *the* number and label the other two as views of it. |
| **B3** | [LIVE] **What does a blank MOQ / lead time mean?** Both columns are `NOT NULL DEFAULT 0`, so blank has no encoding of its own. Creating a binding no longer invents 7/1 — it writes 0, which the reader shows as "—". | Existing rows created before the fix carry a 7 and a 1 that cannot be told from real values. | Accept 0 = unknown — that behaviour is already live in the write path. For the old rows see C1. |
| **B4** | **Is real production time going to be measured at all?** `job_cards.completed_at` now records completions; BOM standard time remains the basis of production hours by your ruling. | Only matters if workers scan **at completion**. Scanning the next morning makes the timestamp misleading. | Leave it accumulating and decide later — it costs nothing and is not read by any metric today. |
| **B5** | **P&L bucket mapping** (`PERF-BACKLOG:141`) — which accounts roll into which bucket. Explicitly flagged "do NOT invent". | Until answered the grouping cannot be trusted. | Give the mapping once; it is a finance decision, not an engineering one. |

---

## C — Historical data. Deciding "leave it" is a valid answer, and often the right one.

| # | Decision | Recommendation |
|---|---|---|
| **C1** | [LIVE] Supplier bindings created before the fix carry an invented **7-day lead time / MOQ 1**, indistinguishable from real values. | Leave them. The information to tell them apart was never recorded — correcting would be inventing a second time. Fix them as they are next edited. |
| **C2** | ✅ **DONE 2026-08-14 — executed on prod.** 2,574 of 2,938 invoice lines (87.6%) now carry `so_item_id`; the 364 that remain NULL are exactly the refused set (147 ambiguous · 207 no PO link · 10 code-only) and the planner now reports `exact: 0`. Money fingerprint over all 490 invoices identical before and after (-936861664). Original entry: **Invoice→SO line backfill**: 2,533 lines link exactly, 147 are contested and stay NULL. Writes only `so_item_id`; touches no amount. | **Run it.** It is additive, refuses ambiguity, and it is what makes the book auditable. It needs your go-ahead because a safety guard blocked me. |
| **C3** | [LIVE] **2,839 pending QC inspections back to 2026-04-28** (`WORK-TRACKER:1207`). `POST /api/qc-pending/bulk-skip` exists, is reviewed, and has never been run. | Confirm they are genuinely stale and no longer wanted, then run the dry-run first. |
| **C4** | **Vehicle plate collisions** (`WORK-TRACKER:1158`) — which duplicate wins, and what happens to the loser's history. New duplicates are already blocked. | Keep the one with movement history; retire the other. |
| **C5** | **OCEAN SKY DO 26061056** carries two invoices — 2,058.64 kept, 1,410.90 voided. If the DO really is 3,469.54 billed in two parts, the voided one is a real payable. | Check the delivery. If both parts really left the warehouse, restore it. |
| **C6** | **SO-2607 rows carrying state 'KL'** (`WORK-TRACKER:1294`) — assign hub-h1, or leave unassigned. **Updated 2026-08-19:** the repair tool `POST /api/sales-orders/backfill-hub-by-state?execute=1` (`sales-orders.ts:804`) is dry-run by default and never auto-touches a dispatched order — it returns them in a separate review list instead (`sales-orders.ts:920`). As of `#338` it also cascades the corrected hub onto `fg_units`, so the printed packing sticker follows; before today it did not, and a corrected order would still have printed the old hub on the box. The 126 historical rows and 34 hub-less SOs in `WORK-TRACKER:1294` are from a **2026-07-27** read-only prod script — today's counts are **UNMEASURED**. | Assign; an unassigned hub silently drops rows from hub-filtered views. Run the dry-run first and read the review list at `sales-orders.ts:920` yourself — those are the orders whose goods already left. |
| **C7** | ✅ **DECIDED 2026-08-19 — leave them** (owner: 「这些不需要」). Dry-run was run on prod the same day and the answer is small: **342 in-stock units scanned, 2 diverge**, both `Houzs KL -> Houzs PG` on **SO-2607-087** (Houzs Century, delivering PG, hub changed 2026-08-18, status `READY_TO_SHIP`). So the historical backlog this row feared is essentially nil — the endpoint comment's "~190 rows" was from the 2026-06-05 incident and is long stale. **This resolves the UNMEASURED marker: it is now measured.** Worth knowing what "leave them" means here, stated plainly rather than buried: those two units are on an order that has not shipped, so if it ships as-is the box carries a **KL** label for a **PG** delivery. The owner has the fuller picture of that one order; recording the consequence is this file's job, not overriding him. Re-run the dry-run any time — it is read-only — if that order is still open and the labels matter. Original entry: **Repair the FG units stamped with a stale hub — run `POST /api/fg-units/backfill-hub?execute=1`, or leave them?** Raised by BUG-2026-08-19-157 (`#338`). The fix stops NEW divergence: all five handlers that can move an order's hub now cascade to `fg_units`. It does **not** touch units already stamped before today. The packing sticker prints `fg_units.customerHub` **as stored** (`/api/fg-units/generate/:poId` returns the row verbatim), while the fg-units LIST screen computes a live `COALESCE(so.hubName, co.hubName)` — so a diverged unit **looks correct on screen and wrong on the box**, which is why nobody would report it. The repair is `src/api/routes/fg-units.ts:796`: **dry-run by default** (`?execute=1` to write), idempotent, skips `LOADED` / `DELIVERED` / `RETURNED`, and returns the full per-unit before/after list so the dry-run can be saved as a restore point. **How many units actually diverge today is UNMEASURED** — no agent here has DB credentials (`.dev.vars` is rotated, `28P01`); the endpoint's own comment says "~190 rows", but that number is from the 2026-06-05 incident, not from now. Run the dry-run and the answer is on the screen. **What is at stake:** boxes already in the warehouse may carry a hub label naming the wrong branch, and re-printing needs the data fixed first. | Run the **dry-run**, save its `units` array, read the `moves` breakdown, then decide. If the moves look like the ones BUG-157 describes, execute and re-print the affected stickers. Do not execute blind — it rewrites a field the warehouse reads off a physical box. |

| **C8** | **The 12 `B.FILLER` sponges — move them to `S.FILLER`, or leave them?** Raised 2026-08-21 by the owner. **This is not a filing question:** the group is the AutoCount stock-group code and four GL accounts hang off it (BUG-2026-08-21-160) — purchase `703-0010` → `703-0020`, stock `330-2001` → `330-2002`, opening/closing likewise. Both accounts carry real money (measured that day: **RM 76,732.35** and **RM 92,768.43**). Purchases already posted keep the old account, so a move **splits each material's own history across two accounts**; stock valuation, by contrast, re-attributes **retroactively**. The 12: `NLY-D12-6MM` · `NLY-D12-1"` · `NLY-D12-1.5"` · `NLY-D12-2"` · `NLY-D16-2"` · `NLY-D25-0.5"` · `NLY-D25-1"` · `NLY-D27-10MM` · `NLY-D27-2"` · `NLY-D30-1"` · `NLY-D30-1.5"` · `NLY-D38-1"` — 8,765 pcs on hand, all now stamped 75×42, RM 18,516.80 of posted purchases. **Evidence both ways, measured.** For moving: every one of their six density families (D12/D16/D25/D27/D30/D38) **already has a sibling in `S.FILLER`** — no density is B-only, so the dividing line is *thickness*, not bed-vs-sofa. Against: that thickness line is **the owner's own** — `stock-take-item-alias-seed-2026-05.ts` is a verbatim copy of his May-2026 physical count sheet, and it puts `1"‖d25` under B.FILLER with `2"‖d25`/`3"‖d25` under S.FILLER, exactly as prod stands. All 12 are ≤ 2". **Related and already done:** 11 sponges were moved to `S.FILLER` on his instruction at 12:26 that day (「全部都是sofa的海绵来的」); 6 of them carry **RM 11,414.25 across 20 posted PIs** now stranded in `703-0010`. | **Leave them.** Thin foam is used on both bed and sofa, so moving swaps "all bed" for "all sofa" — equally a guess, at the cost of splitting six still-moving materials' purchase history. If the goal is real bed/sofa cost attribution, the lever is the **BOM** (which product consumes it), not the stock group: a material can only have one group, and that group is an accounting classification. |

---

## D — Conventions and cleanup. No money at stake; they cost clarity.

| # | Decision |
|---|---|
| **D1** | **Corrected 2026-08-19 — "UNREACHABLE" was wrong, and the fix it asked for is already in place.** `/analytics/forecast` **is** routed: `src/dashboard-routes.tsx:548` renders `src/pages/analytics/forecast.tsx`, with a lazy-import entry at `:577`. What it has no entry in is the navigation — `src/components/layout/sidebar.tsx:280` links `/forecast` ("Forecast P&L", a **different** page, `src/pages/forecast.tsx`, routed at `:471`), and no sidebar row points at `/analytics/forecast`. So it is reachable only by typing the URL. The decision that remains: **delete the page, or give it a nav entry** — and if it gets one, the two near-identically-named forecast screens need names a user can tell apart. |
| **D2** | [LATENT] **Still true, with the paths corrected 2026-08-19.** Both live under `/api/accounting`, not at the top level: `POST /api/accounting/payment-vouchers/:id/restate` exists (`src/api/routes/accounting.ts:8584`); official receipts have `GET` (`:8643`), `POST` (`:8672`) and `POST /:id/lifecycle` (`:8765`) but **no `/restate`**. Add it, or document why not. **Note on the usage table above:** it records these as "route 404", which is what a probe of a top-level `/api/payment-vouchers` would return — the handlers do exist, mounted at `worker.ts:1327`. Whether either document type has any rows in prod is **UNMEASURED**. |
| **D3** | **Corrected 2026-08-19 — this row conflated two different things, and only one of them is random.** (a) `/admin/health` KPIs: genuinely seeded-random, `mockKpis()` at `src/api/routes/admin-health.ts:72` (hour-seeded LCG, so the chart does not flicker), returned with `_mock: true` (`:95`) whenever Analytics Engine is unwired, and the UI shows a banner (`src/pages/admin/health.tsx:777`). Honest. (b) agent-console FX / LLM prices: **not random — hardcoded constants**, `USD_PER_MTOK_IN = 3`, `USD_PER_MTOK_OUT = 15`, `USD_TO_MYR_EST = 4.7` at `src/api/lib/agent-console.ts:351-353`. They carry **no `_mock` flag**, and they feed the RM figure the console shows against your RM 150/family monthly budget (`:506`). So: keep (a) as-is, but (b) is a stale-rate risk with a number in front of you — refresh the rate, label it as an estimate on screen, or wire it to a real source? |
| **D4** | **Narrowed 2026-08-19 — real costing already landed; only the fallback is left.** `resolveFifoUnitCostSen` (`src/api/routes/rd-projects.ts:330`) reads the oldest `rm_batches` row with stock remaining — the same FIFO the Inventory drilldown uses — and only when there is no such batch does it fall through to `estimateFIFOCost` (`:195`), the six per-item-group constants (PLYWOOD 4500 · B.M-FABR 2500 · S.M-FABR 3000 · B.OTHERS 800 · EQUIPMEN 5000 · SPONGE 1500, else 2000 sen). The issuance snapshots whatever comes back, with nothing on the record saying which of the two it was. **The decision is now just the no-batch case:** label those issuances as estimates, refuse the issuance until a batch exists, or leave the guess silent? How often it fires today is **UNMEASURED**. |
| **D5** | **Re-verified 2026-08-19, still open, and the line number still holds.** `.github/workflows/deploy.yml:294` posts on every PR: *"This branch is wired to the same Hyperdrive (→ Supabase Postgres) and KV bindings as production."* `docs/CANARY-DEPLOY.md:70-78` says the opposite and is the measured one — a canary URL is `*.hookka-erp-testing.pages.dev`, which `isPreviewHostname` classifies as PREVIEW, so it hits **staging** Supabase via `HYPERDRIVE_STAGING`. The comment is the first thing a reviewer reads, and it tells them their destructive test will hit prod. It is a workflow string, so it was recorded rather than edited. |
| **D6** | **Re-verified 2026-08-19, still open, now with the exact lines.** `docs/AGENTS-COMMIT-HYGIENE.md:43` tells every agent to cite task IDs from `docs/archive/UPGRADE-CONTROL-BOARD.md`, and `:51` tells them to **write** into that archived file (see the exact wording there) — while `docs/SDK-MIGRATION-STATUS.md:90-91` says of the same file *"Do not use it to check current status"* (its last real update was 2026-04-26). Repointing the convention at `docs/WORK-TRACKER.md` changes a standing per-commit rule, so it is yours to call. |

---

## Not on this list, and why

**Findings that need work, not a decision, are not here** — those live in
`docs/DASHBOARD-DATA-AUDIT.md` and `docs/DOCS-VS-CODE-AUDIT.md` and are mine to finish:
the `× 0.85` sites outside `attendance.ts`, `/api/cash-flow` having no permission gate,
and the `actualMinutes ?? estMinutes` pattern surviving at ~30 sites.

**30 UNMEASURED markers** are also not decisions. They are questions needing a live query,
which no agent could run without database credentials. They resolve with A1, not with a
ruling.
