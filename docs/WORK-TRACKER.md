# Hookka ERP — Work Tracker

Durable, cross-session list of assigned / in-progress / shipped work so nothing is
forgotten. **Newest first. Update on every state change** (assigned → in progress →
shipped/parked). Re-read this + `MEMORY.md` at the start of each session and before
reporting "done". See `docs/DEV-OPERATING-FRAMEWORK.md` for the discipline.

Status key: 🔵 in progress · 🟡 parked/needs owner · ✅ shipped to prod · ⚪ queued

---

## 2026-07-22 — 🟡 ON HOLD looked like it "didn't run" — it did; the dept sheet served a stale SWR snapshot
**Owner: 「账单明明已经 on hold 了,可是却好像没有 on hold 的 back end 跑动」** (SO-2607-120 /
PO-009515 / their SO-012637, 11 rows still plain on the Fab Sew sheet). **Not a hold bug.**
- **The cascade ran correctly.** `sales_orders` ON_HOLD + reason + held_by/held_at stamped
  14:22:26.229Z, and all **6 production orders → ON_HOLD at the identical timestamp**
  (`cascadeSOStatusToPOs`, `src/api/routes/sales-orders.ts:665`). Verified directly on prod.
- **What the operator saw was cache lag.** `production_orders_list_snapshot` for
  `dept=FAB_SEW&excludeCompleted=true&fields=minimal` was `built_at` 06:19:24Z / `built_from`
  06:11:11Z — **~8 h before the hold**. The dept sheet runs `staleWhileRevalidate`
  (`production-orders.ts:5612`), so the first read after the hold returns the pre-hold body and
  only kicks the refresh in the background. Live proof: first `GET /api/production-orders?
  dept=FAB_SEW…` returned `status:"PENDING", holdReason:""`; the next call returned
  `status:"ON_HOLD"` + the reason. `X-Cache: MISS` both times — it is the snapshot layer, not KV.
- **Confirmed fixed-by-refresh in the real UI:** /production/fab-sew search "12637" now renders
  all 11 rows amber with an **ON HOLD** badge + reason.
- **Root cause of the lag:** the SO status-change path never invalidates the production
  snapshot. The hub-change path already does exactly this (`invalidateHubChangeSnapshots`,
  `src/api/lib/snapshot.ts:432`, wired at `sales-orders.ts:5259`) *because the freshness probe
  is known to lie*. **Proposed fix:** call the same wipe after an ON_HOLD / CANCELLED / RESUME
  cascade so the shop floor sees a hold on the first render, not the second. Not yet built.
- Script: `scripts/audit-hold-cache-2026-07-22.mjs` (read-only).

## 2026-07-22 — 🟡 Hub audit vs Houzs "PO chasing list 20260722" — 7 wrong hubs + 20 mislabelled PG DOs
**Ask (owner): 「幫我查看我的顧客 hubs 全部對嗎？有哪些錯的」** — assessment only, nothing changed.
Script: `scripts/audit-hok-hubs-2026-07-22.mjs` (read-only, prod). Join key = their
`Doc No` (PO-0096xx) → `sales_orders.customer_po_id`. 74/74 POs matched; **66 hubs agree**.
- **7 SOs carry the wrong hub** (all stamped `Houzs KL`, customer says otherwise):
  PO-009401→PG, PO-009442→**SRW** (INVOICED), PO-009467→PG, PO-009495→PG (DO-2607-084 LOADED),
  PO-009529→PG, PO-009544→PG (INVOICED), PO-009567→**SRW** (SHIPPED). 30 FG units stamped
  "Houzs KL" follow the SO, so box stickers are wrong too.
- **PO-009631 (their SO-012060, KL) is on their chasing list but not in our ERP** — never keyed in.
- **20 delivery orders labelled "Houzs KL" whose lines are 100 % Houzs PG SOs** (DO-2605-037 →
  DO-2607-083, the last one LOADED 07-21). Address printed is the correct Penang one; only the
  hub label is wrong. **Root cause:** `createDeliveryOrderForPOs`
  (`src/api/routes/delivery-orders.ts:3423`) resolves `hubTarget = body.hubId ?? salesOrderRow?.hubId`,
  and on a consolidated multi-SO DO `salesOrderRow` is NULL → falls through to
  `ORDER BY isDefault DESC LIMIT 1` = Houzs KL (line 3454). Same default-hub class as
  BUG-2026-06-05-003 (FG stickers) and BUG-2026-06-11-009 (service DOs).
- **Hub master data (`delivery_hubs`, 7 rows) — owner confirmed CORRECT, do not "fix":**
  Houzs SRW + SBH really do deliver to the KL Balakong address (consolidated, Houzs ships
  onward themselves), same for `2990 KL`; **LIM + SOON genuinely have no hub** (walk-in
  customers) so their blank Deliver-To is expected, not a bug.
- **The 55 blank-hub DOs are explained, not a live bug:** 51 are the 2026-05-05/06 historical
  import batch (rows came in with `hubId` set but `hubName` + `deliveryAddress` NULL — the
  importer never populated the snapshot; all DELIVERED long ago). DO-2606-004 + DO-2606-030 are
  the BUG-2026-06-11-008 blank-address quirk, fixed 06-11. DO-2606-086 (SOON) + DO-2607-060
  (LIM) are the no-hub customers above. **Zero blank DOs created since 2026-07-14.**
- **Legacy `customer_hubs` table disagrees with `delivery_hubs`** (different ids, missing 2990/
  LIM/SOON). No page reads it, but `src/lib/api/resources/customers.ts` exposes
  create/update/delete against the GET-only route — dead code pointing at stale data.
- ✅ **DONE 2026-07-22 — the 3 unshipped SOs corrected to Houzs PG on prod** via the UI's
  Change Delivery Hub modal (owner's own logged-in Chrome; the committed script credentials all
  401 now — password was rotated, stale creds in the old one-shot `scripts/*.mjs` should be
  stripped). SO-2607-010 (PO-009401), SO-2607-087 (PO-009467), SO-2607-108 (PO-009529).
  **Verified on prod** with `scripts/verify-houzs-hubs-2026-07-22.mjs`: all three
  `hubName=Houzs PG`, `customerState=PG`, and `production_orders.customer_state` cascaded to PG.
  `fg_units.customer_hub` still stores "Houzs KL" on the 8 units — cosmetic only, the sticker
  reads the live `COALESCE(so.hubName, co.hubName) AS resolvedHub` join
  (`src/api/routes/fg-units.ts:550`, the BUG-2026-06-05-003 fix); `POST /api/fg-units/backfill-hub`
  can restamp if a stored value is ever wanted.
- **4 left alone — already shipped, guard refuses (owner's rule):** SO-2607-074 (PO-009495,
  DO-2607-084 LOADED + DO-2607-058 INVOICED), SO-2607-040 (PO-009442, SRW), SO-2607-115
  (PO-009544), SO-2607-130 (PO-009567, SRW). These 4 were physically sent to the KL address
  while Houzs's own list says PG/SRW — a commercial question for the owner, not a data fix.
- **Still open:** the DO default-hub fallback fix (line 3423/3454) — 20 mislabelled PG DOs;
  and PO-009631 never keyed into the ERP.

## 2026-07-17 — ✅ RM 750 special-order backfill CLOSED on prod (DO-judgment) — owner re-sends 6 Houzs invoices
**Owner: 「直接上 prod。你重发」 + 2 unshipped lines 「写到 SO 线上」. DONE + reconciled.**
- **6 invoices corrected via `PUT /api/invoices/:id {priceEdits}`** (the tested GL-restate
  path) = **+RM 540**: INV-2606-082 +100, -087 +50, -001 +50, -163 +160, -057 +50, -136 +130.
- **5 SOs re-priced via `POST /backfill-special-order-surcharge {scope:"all", soNos:[5]}`** =
  9 lines / **+RM 750** (includes the 2 never-shipped lines: SO-2605-121 line 02 RM50 +
  SO-2605-275 line 02 Left Drawer RM160 — SO-only, the forward-fix bills them on any future
  invoice).
- **Line targeting = DO position-match:** invoice items are 1:1 with their DO's items in the
  same order, and each DO item carries `productionOrderId = pord-<soId>-<lineNo>`. Matched the
  exact invoice_item by DO position + verified SKU — robust against the duplicate SKUs in the
  consolidated invoices (INV-082 had 2008(A)-(K) ×3). All 7 verified before writing.
- **priceEdits TRAP handled:** these invoice lines had base/divan/leg = 0 with the whole price
  lumped in unitPriceSen. `priceEdits` REPLACES unit = base+divan+leg+special, so sending
  special alone would have ZEROED the price. Set base = current unit, special = surcharge →
  unit = old + surcharge (the phase-2 pattern).
- 🔴 **MY BUG, CAUGHT BY READ-BACK — logged as the lesson:** I priced the drawer lines from the
  STATIC `bedframeSpecialOrders` config (Right 15000, Front 12000) but the backend executor
  uses the LIVE `specials` config (Right **16000**, Front **13000**, Left **16000**). The SO
  came out RM30 above my invoice total; the reconciliation read caught it. Topped up
  INV-2606-163 (+RM10) and INV-2606-136 (+RM10). **RULE: price special orders from the SAME
  source the backend does (loadSpecialsConfig / kv_config `specials`), never the static
  catalog** — memory already warned "Left/Right Drawer 16000 vs static 15000; Front 13000 vs
  12000". Now heeded.
- **FINAL RECONCILIATION VERIFIED:** all 7 invoiced lines lockstep (SO special == invoice
  special, every one); `GET /backfill-invoiced-plan` → `invoicesToCorrect:0, needsManual:0`.
  All 6 invoices SENT/unpaid (raising is safe), all customer = Houzs Century (inter-company).
🔴 **OWNER'S STEP:** re-send the 6 corrected invoices to Houzs (INV-2606-082, -087, -001, -163,
-057, -136). Sending is his action. **The special-order surcharge backfill is now 100% closed**
(uninvoiced 78 SOs + invoiced 10 + these 5 = every under-billed SO priced).

## 2026-07-17 — 🔵 RM 720 (not 750): DO-judgment plan BUILT + read-verified — awaiting owner go on the GL writes (SUPERSEDED — executed above)
**Owner ask: 「用 DO 判断的方法我已經找到,可以做」.** Cracked it: every invoice carries
ONE `deliveryOrderId`, and each DO line carries `productionOrderId` = `pord-<soId>-<lineNo>`.
So the DO deterministically says WHICH invoice a given special SO line shipped on — no
guessing. Resolved all 9 owed lines across the 5 SOs (all customer = **Houzs Century**,
inter-company). All 6 target invoices are **SENT, paidAmount 0, 0 payments** → safe to raise
(no reconciliation break). Prices from live kv_config: Divan Curve 5000, Divan Top Fully
Cover 5000, Right Drawer 15000, Front Drawer 12000, Left Drawer 15000.

**7 lines → a definite issued invoice (RM 520):**
| SO | line | option | RM | → invoice (via its DO) |
|----|------|--------|----|----|
| SO-2605-234 | 01 Divan Curve | 50 | INV-2606-082 (DO-2606-001) |
| SO-2605-234 | 03 Divan Curve | 50 | INV-2606-082 (DO-2606-001) |
| SO-2605-234 | 02 Divan Curve | 50 | INV-2606-087 (DO-2606-007) |
| SO-2605-185 | 02 Divan Top Fully Cover | 50 | INV-2606-001 (DO-2606-002) |
| SO-2606-135 | 01 Right Drawer | 150 | INV-2606-163 (DO-2606-088) |
| SO-2605-121 | 01 Divan Curve (PC151-14) | 50 | INV-2606-057 (DO-2605-053) |
| SO-2605-275 | 01 Front Drawer (PC151-01) | 120 | INV-2606-136 (DO-2606-062) |

Per-invoice delta: 082 +100, 087 +50, 001 +50, 163 +150, 057 +50, 136 +120.
(The planner refused these as "two live invoices"/"no unmatched line" because it matched by
SKU only; the DO line-number + fabric code disambiguate cleanly.)

**2 lines → NEVER delivered, no invoice to correct (RM 200):**
- SO-2605-121 line 02 (1007-(Q) **PC151-16** Divan Curve, RM 50) — line 01 shipped on
  DO-2605-053; line 02 never did. SO is INVOICED (closed).
- SO-2605-275 line 02 (1007-(Q) **PC151-01** Left Drawer, RM 150) — SO is READY_TO_SHIP;
  only line 01 shipped (INV-2606-136). Line 02 not yet delivered.
  These have NO issued invoice. Correct action = price the SO LINE only; the forward-fix
  (production_order_id on invoice_items) makes any FUTURE invoice bill it automatically.

**EXECUTION PATH (per prior phase-2, tested): for each of the 7 lines** → `PUT /api/invoices/
:id {priceEdits}` (the ONLY GL-restating path on a SENT invoice) to add the surcharge to that
specific line, THEN re-price the SO via `POST /backfill-special-order-surcharge {scope:"all",
soNos:[...]}` so SO and invoice stay in lockstep. For the 2 unshipped lines → SO re-price only.
🔴 **AWAITING OWNER GO** — issued inter-company GL, highest-risk area; every prior phase was
rehearsed on staging then prod with per-phase approval, and the write hits the permission
classifier. Read-only investigation is COMPLETE; only the irreversible writes remain.

## 2026-07-17 — 🟢 Heartbeat made reliable: CF Cron Worker DEPLOYED — owner owes 1 secret command
**Owner ask: 「心跳每 1-3.5 小时(GitHub 不跑) 做」.**
Root cause was never the code — it was the DRIVER. GitHub Actions cron drifted
1–3.5h (measured 2026-07-16), starving every agent + delaying the morning brief.
The heartbeat is the universal fallback for the punctual 07:00 report / 07:30
delivery crons, so making it reliable makes the whole agent+report system reliable.

**Built + DEPLOYED a sibling Cloudflare Cron Worker** `agent-heartbeat-worker/`
(CF cron fires on time; Pages can't host a cron trigger — Workers-only, per the
root wrangler.toml note; mirrors `mail-inbound-worker`). Live at
`https://hookka-agent-heartbeat.houzs-erp.workers.dev`, cron `*/30 * * * *`
(tighter than hourly on purpose: prompt fallback + faster backlog drain; the
endpoint self-throttles real agent runs to the 1h min). GitHub yml KEPT as a
belt-and-suspenders fallback (endpoint dedups → double-fire is a no-op).

🔴 **OWNER OWES ONE COMMAND** — the worker is deployed but the beat 401s until the
shared secret is set (I must not handle the secret value). Verified live: hitting
the worker URL returns exactly `CRON_SECRET unset or too short`. From
`agent-heartbeat-worker/`:
```
npx wrangler secret put CRON_SECRET      # paste the SAME value as the ERP's CRON_SECRET
```
If the original value isn't to hand (GitHub/CF secrets can't be read back),
rotate on BOTH sides: `wrangler pages secret put CRON_SECRET` on the ERP Pages
project + the worker + the GitHub repo secret. Full runbook in the worker README.
Verify: `curl https://hookka-agent-heartbeat.houzs-erp.workers.dev/` → `beat ok`.

## 2026-07-17 — ✅ ANN's docks CLEARED on prod (owner approved the write) — RM 291.91
**Owner approved「你批准,我来跑重算」.** Ran the plan below via the system's own
`POST /auto-from-punch` (14 days) + 1 DELETE (07-11, no punch). Read-back confirms ANN
now has **exactly ONE dock left: 06-30 = 0.22h (AUTO)** — her real 13-min shortfall.
**21.48h of wrong docks removed = RM 291.91** (at her 1359 sen/h). That is MORE than the
RM 233.58 the owner remembered, because 233.58 counted only July's 13 rows; it excluded
June's 06-29 (0.5h) and the wrong portion of 06-30 (1.72→0.22). No refund needed — no
payslip was ever generated, so she is simply paid right at the first July run. 06-30 kept
its AUTO tag so a future settle can still manage it. ✅ DONE.

--- original plan (kept for the audit trail) ---
**Owner ask: 「ANN 被多扣的 RM 233.58 要」.**

✅ **Code fixed + on prod** (BUG-2026-07-17-007, commit 80dc540f): the first fix caught
only the live-punch path; the MONTHLY settle still used the global 9h. Both now share
`rulesForWorkerHours`. **Deleting her docks before this would have let the next settle
re-create them silently.**

🔴 **The premise is wrong, and the owner needs to hear it: NOTHING HAS BEEN DOCKED YET.**
`/api/payslips?period=2026-07` → **0 payslips**; 2026-06 → **0 payslips**. No payslip has
ever been generated for either month, so no money has left. The RM 233.58 is a PENDING
deduction sitting in `payroll_hour_deductions` waiting for the first payroll run. Remove
the rows before payroll and she is simply paid right — there is nothing to refund.

**Verified per-day against her real punches (not assumed) — 15 AUTO rows, 0 MANUAL:**
- **2026-07 (13 rows / 19.48h) — ALL WRONG.** Her punches are 08:00–18:00 → 9h regular →
  0 short against her 7.5h day. Note: **0 short against the OLD global 9h too** — so
  these rows are NOT explained by the 7.5-vs-9 bug on today's data. They are STALE:
  written at punch time from an earlier clock-out, and the attendance was later keyed to
  18:00 with nothing recomputing the dock. (Today, 07-17, she punched out 16:31 — that IS
  the shape the 7.5h bug bites, and the fix now returns 0 for it.)
- **2026-06 (2 rows / 2.22h) — MIXED. This is why a blanket delete was wrong:**
  - 06-29 docked 0.5h →真 0 → remove.
  - 06-30 docked 1.72h (08:11–16:32) → **genuinely 0.22h short** → must be CORRECTED to
    0.22, NOT deleted.
**Plan (dry-run built + verified, not executed):** 14 days → `POST /auto-from-punch`
(the system's own guarded self-heal: recomputes with the fixed rules, deletes a 0,
overwrites 0.22, keeps source=AUTO so a future settle can still manage it — a manual
POST would tag it MANUAL and permanently freeze it). 1 day (07-11, no punch record at
all) → plain DELETE: no clock-out = no evidence of shortfall, per the helper's own
guard; an absence is settled by the monthly salary deduction instead.
🔴 **BLOCKED:** the prod write was refused by the permission classifier. Not worked
around. Owner must either approve the write or click Undo on those rows in the Labor
Cost review himself. **No urgency — the docks only bite when payroll is first run.**
Do NOT reach for `POST /settle-period` as a shortcut: it would recompute ALL 42 workers
(30 other AUTO docks) from today's data and could silently ADD docks nobody approved.

## 2026-07-18 — 🟡 ISO 9001 + MFRS gap analyses DELIVERED (owner「跟著 ISO standard」+「accounting 根據 MFRS」)
Owner confirmed **ISO 9001** (quality) and wants **accounting per MFRS**; both asked as a **gap
report first** (not a blind rebuild). Ran 4 parallel read-only Explore agents over the whole
codebase, synthesized two code-grounded documents:
- `docs/ISO-9001-GAP-ANALYSIS.md` — 11 clauses mapped. Strong: 8.5.2 doc-chain traceability, 8.4
  supplier performance/3-way match, 9.1 monitoring. Gaps: QC release gate (8.6), formal NCR (8.7),
  CAPA effectiveness-verification (10.2), document version/approval control (7.5), calibration
  (7.1.5), competence/training (7.2), internal-audit program (9.2), management-review record (9.3),
  risk register (6.1), AVL approval (8.4). Suggested P1: NCR + CAPA closure + doc control + internal
  audit + mgmt review.
- `docs/MFRS-GAP-ANALYSIS.md` — accounting is **strong**: hash-chained double-entry GL, revenue on
  delivery (MFRS 15), FIFO/periodic inventory, all 4 statements, fixed-asset depreciation w/ GL
  posting, SST to real liability accounts, AP realised FX. Gaps: inventory NRV/obsolescence (102),
  receivables ECL (9), income/deferred tax (112), warranty provision (137), payroll GL automation +
  statutory-payable split (119), cash-flow MFRS-107 classification + SOCIE (101), MYR-only AR +
  no FX retranslation (121), no DB-level ledger immutability trigger. Suggested P1 (the ones that
  change reported numbers): NRV, ECL, payroll GL, deposit/contract-liability — **to be scoped WITH
  the accountant** (ERP builds the mechanism, the accountant sets the rates/policy).
**NOTHING built — assessment only.** Owner picks which gaps to build; each is mockup→approve→
staging→prod, and the MFRS P1 items need the accountant's rates before coding.

## 2026-07-18 — ✅ Agent health check + Employee/Service starvation FIXED (owner「確保 agent 有做到」)
**Owner asked to confirm the production + delivery agents are actually working.** They ARE:
production-brief ran 07-17 08:01, production-proposals 07-17 20:20 (cleared 872 due dates),
delivery-run 07-17 09:03. Both healthy.
**But found a real bug: Employee + Service agents ran ONCE all July** (Production 48×,
Delivery 11×, Employee/Service 1× each). Root cause was reach, not the digests (run-now fires
them fine in ~1.3s): the beat is one sequential Worker invocation and the two cheap read-only
digests sat AFTER the backlog drain; while the drain was per-row it killed the Worker before
them nearly every beat. **Fixed (BUG-2026-07-17-011, deployed): reordered the beat to reap →
Employee → Service → drain → generation**, so the cheapest agents run first and nothing
downstream can starve them. Verified the reordered beat fires clean post-deploy.
**Made every agent current tonight** via `POST /api/agents/run-now`: employee + service
(07-18 01:52) and production-learning (07-18 02:02) all ran green. All six agents now healthy.
**Heartbeat cadence traced:** GitHub fires it every 60–205 min (a 205-min hole on 07-17) vs
the intended 20 — the reason `agent-heartbeat-worker/` (reliable CF cron) exists. That worker
is deployed and waiting on the owner's one `wrangler secret put CRON_SECRET`.
✅ **Payslip `(26 x 9)` label lie — DONE + LIVE-verified (BUG-2026-07-17-012).** Owner asked to
finish all pending, so completed it: label now reads each worker's real `(workingDays x
workingHoursPerDay)`. employees.tsx looks hours up from the workers prop (no backend change);
the PDF path reads it off the worker via GET /:id. Verified live: ANN's May payslip now
`2650 / (26 x 7.5) = 13.59` (matches the rate); 9h workers still `(26 x 9)`.

## 2026-07-17 — ✅ Owner final batch COMPLETE (「其他兩個也處理掉」 + earlier asks)
All of the owner's 2026-07-17 batch are now shipped or cleanly handed off:
1. ✅ Brief recipients → you + Violet (sent:2); **owner added Lim 2026-07-18 → now 3**
(list lives in `kv_config['daily_report_recipients']` as a BARE JSON array — this repo is
PUBLIC, so staff emails must never be committed here; edit the DB row, not code).
2. ✅ ANN RM 291.91 cleared on prod
(1 genuine 0.22h kept). 3. ✅ Heartbeat CF Cron Worker deployed (owner owes 1 `wrangler
secret put CRON_SECRET`). 4. ✅ RM 750 special-order backfill closed via DO-judgment
(6 Houzs invoices + 5 SOs, reconciled; owner re-sends). 5. ✅ Sticky tick column
(BUG-008). 6. ✅ Employee Master 「歪了」 (below).
🟡 **Deferred, NOT in the batch (flagged so it's not lost):** the payslip label
`(26 x 9)` is hardcoded in generate-payslip-pdf.ts:178 + employees.tsx:~7561 while the
rate is computed from the worker's real hours (ANN = 2650/(26×7.5) = 13.59). The label
lies for any non-9h worker. Fix needs `workingHoursPerDay` threaded into the payslip
payload + PDF — a small payload change, so spun off as its own task rather than
scope-crept here.

### 2026-07-17 — 🔵 Owner batch (3 asks, screenshots) — Employee Master / payroll
Logged before working (multi-part rule). Owner's words + what each means:
1. ✅ 「歪了」 — Employee Master INLINE EDIT row was misaligned: the resign-date input
   (01/07/2026) and the status dropdown overflowed / clipped out of the 110px Status
   column. FIXED (BUG-2026-07-17-010): widened Status to 150px, both controls
   w-full min-w-0, "Resigned on" label moved to its own line. Deployed to prod.
2. 「確保resign了 就payroll 出去」 — once a worker is RESIGNED they must drop out of
   payroll. Verify (resign-lockout.test.mjs + the payroll active-only filter exist —
   check before assuming it's broken).
3. 🔴 **「我記得ann是工作少1.5小時的」「沒有跟?」 — CONFIRMED REAL, and it costs her money.**
   ANN (EMP-004) has `workingHoursPerDay = 7.5`. The PAY side honours it
   (`hourlyRate = payrollDailyRateSen / worker.workingHoursPerDay` → RM 2650/(26×7.5) =
   RM 13.59/hr, payslips.ts:581 + :921). The DOCK side does NOT: short-hours are measured
   against the GLOBAL constant `HOOKKA_ATTENDANCE.standardWorkMin = 9*60`
   (attendance-rules.ts:45), which is not per-employee. **9 − 7.5 = 1.5 → she is marked
   "1.5h short" EVERY working day** (01,02,03,04,06,07,08,09,10,11,13,15 Jul …) and docked
   −RM 233.58 (13d). Blast radius measured on prod: 42 workers — 38 at 9h (unaffected),
   3 at 0h (test accts), **ANN the only one at 7.5**. Fix = the dock must read the
   employee's own hours, same source the hourly rate already uses.
   Related display bug: "Hourly Rate: RM2650 / **(26 x 9)** = RM13.59" — the `(26 x 9)` is
   HARDCODED in `generate-payslip-pdf.ts:178` + `employees.tsx:7561` while the number shown
   is computed from 7.5 (2650/195 = 13.59, NOT 2650/234 = 11.32). The label lies.

## 2026-07-17 — 🟢 MONEY fix LIVE (RM 8,060) · 🔵 BACKFILL SO+SI = NEXT · 🔴 invoice PO mis-match
**Code fix SHIPPED + LIVE + verified** (merge `efbba63e`): scanned customer POs never charged
the special-order surcharge because the scan clients POST /api/sales-orders directly without
`specialOrderPriceSen` while the typed form always sends it (RM 80 typed vs RM 0 scanned).
Server now derives it ONLY when the field is omitted. Verified live on staging against the
real write path (Divan Full Cover→8000; HB+Divan→10000 combo cap; plain→0); test SO deleted.
**Number corrected to RM 8,060** (the first RM 8,390 mis-counted the HB+Divan combo as RM 130
instead of the RM 100 cap).

🔵 **NEXT — BACKFILL SO + SI. OWNER APPROVED (asked TWICE): 「改罷了 然後我們重新法國」**
(法國=發過) = **re-price the old SOs + invoices; HE re-sends them.** Same route he chose on
the invoice money-path work. **The decision is made — execute, don't re-ask.** Only open
sub-question: PAID / part-paid invoices (raising a total breaks reconciliation) — surface
that list separately instead of assuming.
**START HERE:** (1) re-run the sweep UNBOUNDED (the RM 8,060 came from the first 500 SOs —
the list endpoint caps/paginates, so the real scope may be bigger); (2) dry-run planner →
per-SO list + delta + invoice status; (3) execute via the existing re-price/GL-restate path
(`PUT :id`), never a hand-rolled GL write.
66 SOs / 82 lines / RM 8,060 + their invoices. **Read BUG-2026-07-17-002's backfill block
before doing anything** — it lists the 6 decisions/traps (issued invoices are accounting
records → no silent edits, owner's precedent is re-price + he re-sends; paid invoices break
reconciliation; GL must reuse the existing `PUT :id` GL-void, don't re-implement;
confirmed SOs may cascade; build a DRY-RUN planner first per this repo's own precedent; and
re-run the sweep unbounded — it only read the first 500 SOs).
Deliberately stopped before writing: this touches issued documents + the GL and deserves a
fresh session, not the tail of a long one.

## 2026-07-17 — (superseded header) MONEY: special-order surcharges + invoice PO mis-match
Owner spotted both from ONE invoice (DO-2607-051 / INV-2607-060). Full evidence, ruled-out
causes and fix options in `docs/BUG-HISTORY.md` — **BUG-2026-07-17-002** (money) and
**BUG-2026-07-17-001** (wrong PO refs). Do not re-derive; read those entries first.
- **RM 8,390 under-billed** across **66 SOs / 82 lines** (500 SOs scanned live on prod).
  INV-2607-060 alone = RM 210. Price list + `calculateUnitPrice` are CORRECT — a specific
  WRITE PATH stores the special-order label without its surcharge (`specialOrderPriceSen=0`).
- **Owner ruling: 「先修 然後再 backfill」** — fix the code FIRST, backfill the 66 after.
- 🔵 NEXT (not started): confirm the culprit path — strong lead is the OCR/scan consumer
  (stored text is COMMA-joined like `scan-po.ts:430`, while the form joins with `"; "`;
  scan-po only extracts, so its consumer builds the SO). **Verify before coding** — the
  similar-looking `buildLinesFromCopyDraft` bug is Service-Order-only where RM 0 is correct.
- Fix must be BACKEND-side at write time (FE+BE unified rule) so no client path can skip it;
  dedicated branch + tests (money ⇒ isolated-branch rule). Preserve: SV mode = 0, operator
  price edits not overridden, HB+Divan combined-cover = RM 100.
- Backfill is SEPARATE and needs an owner decision: issued invoices are accounting records —
  no silent edits (credit-note vs re-issue). INV-2607-060: ask whether it's already sent.

## 2026-07-16 — Handoff tasks 1 + 2 (owner, THIS session) — see docs/HANDOFF-2026-07-16.md
1. ❌ **Impersonation ("login as user") — OWNER DECLINED 2026-07-16, do NOT build.**
   Owner ruling: 「這個不需要啊 我去staging用他們的戶口就可以了」 — he reproduces per-user
   views by logging into their accounts on STAGING, so the feature has no owner demand.
   All work reverted (nothing left in the tree). **Do not re-propose** unless he asks.
   Known limit he accepted: a staging account can't reproduce a blank page caused by PROD
   data (a specific order / dept config). If that case ever bites, revisit then — the spec
   + the 5 security invariants stay in docs/HANDOFF-2026-07-16.md.
   Findings worth keeping if it IS ever built (both cost real time to find):
   - auth-middleware's sliding refresh extends ANY session with <24h left back to 7 days →
     a 2h impersonation TTL would be silently promoted to 7d on the FIRST request. Gate it
     on the session's ISSUED length (expiresAt − createdAt), not on a new column.
   - the middleware SELECT runs on EVERY request, so it must never reference a
     not-yet-created column: that 503s the whole API *including* the endpoint whose runtime
     ALTER would create it → total lockout, unrecoverable without DB creds.
2. 🟡 **/invoices jank — PARKED by owner 2026-07-16 (「那就等」), premise DISPROVEN.**
   Owner parked it after being shown the evidence + the honest cost: chasing the remaining
   ~94ms floor means touching the shell EVERY page shares (and likely the monolith-page
   decomposition), which is high-risk for a 0.1–0.3s-per-navigation win — lower value than
   the real pain (duplicate invoices, planning cold starts). **Do NOT restart this on a
   "page feels slow" report alone.** Resume only if the owner asks, or if a page regresses
   badly enough to matter.
   Diagnostic headers REMOVED from BOTH prod (50e0904e) and staging (b0d8f0d1) and verified
   clean — deliberately not left on staging, because staging↔main merge regularly in this
   repo and a `_headers` line would ride into prod unnoticed. To resume: re-add
   `Document-Policy: js-profiling` under `/*` in `public/_headers` (one line) and profile on
   staging — it DOES reproduce once its cache is warm.
   Evidence below stands. Owner said (before parking):
   「先抓火焰图再改,别盲改」 — measured first, and the measurement killed the task.
   Full evidence in docs/HANDOFF-2026-07-16.md (Task 2 block). Short version:
   - **/invoices is one of the CHEAPEST pages (153/193ms)**, not the worst. There is a
     **~94ms floor on EVERY route transition** (/notifications, the lightest page, costs 94ms);
     invoices sits only ~60ms above it. The real hotspots are **/planning (238–384ms)** and
     **/delivery (377ms)**.
   - **"/planning = 0ms" — the handoff's entire proof — was measurement error.** Sidebar links
     don't match on exact text (badge → `Notifications9`), so the click no-ops, nothing
     navigates, and the observer honestly logs 0ms. Reproduced the false zero.
     **RULE: assert `location.pathname` changed before trusting a perf number.**
   - **The block fires BEFORE the data lands** (long task at ~40ms, `/api/invoices*` responds
     at ~560ms) → it CANNOT be per-row work. Grid = 11 DOM rows (paginated, not mounting all);
     all array ops during mount = ~17k elements/~50ms (no O(n²)); 1 offsetWidth read (no layout
     thrash); parsing all 17 localStorage cache entries (1.1MB) = 8.2ms. Every suspect dead.
   - **FLAME CHART CAPTURED (prod, JS Self-Profiling API).** Enabled `Document-Policy:
     js-profiling` on prod just long enough to capture, then REVERTED (4a9c21a4 → 50e0904e,
     verified gone from prod). **Staging keeps the header (51b993e2) — profile there next.**
     Verdict: **the block is React render/commit, not our code** — 17 of 21 JS self-samples
     are inside `react-dom`; invoices/data-grid barely appear. There is no hot function of
     ours to optimise. Sentry is NOT active on prod; the CF beacon never runs during the block.
     GOTCHA: Chrome CLAMPS `sampleInterval` (asked 1ms, got ~17ms median) → each sample ≈17ms;
     21 samples ≈364ms ≈ the measured blocks. Don't read sample count as ms.
   - **⚠️ The "0ms" trap bit me too — same root cause as the handoff's.** Staging looked 0ms on
     byte-identical src (verified zero src diff main↔staging), which looked like a major clue.
     Artifact: staging had never visited /invoices → no SWR cache → nothing to render → 0ms.
     Warm (940 cached rows) staging = **145–284ms = same as prod**. No prod/staging difference.
     **RULE: a 0ms perf reading is a measurement bug until proven otherwise — assert the route
     changed AND that there were rows to render.**
   - **NOT root-caused: the ~94ms floor.** It's React render/commit, app-wide, but the
     profiler's ~17ms resolution can't attribute it to a component. Next: profile on staging
     (header already live) or bisect the shell (Sidebar/Topbar/Breadcrumbs/`<Routes>`) — ~94ms
     of React render for a 1,210-node page is abnormal and the shell is common to every route.
     (`TabbedOutlet` keep-alive is referenced in stale comments but NO LONGER EXISTS — not it.)
   NOTHING SHIPPED to app code — the only prod change was the profiling header, now reverted.

## 2026-07-14 — 🔵 Durable read-perf rollout (ON STAGING, byte-identical gate) — see docs/PERF-DURABLE-ARCHITECTURE.md
Owner-approved rebuild: stop shipping whole-org lists to the client; compute
server-side (shared builder = byte-identical by construction) + snapshot-cache +
serve-stale. Each slice = own commit → staging → LIVE byte-identical verify →
(owner) merge to prod. Canonical + deployed branch = `staging` (this branch,
staging-delivery-ready). NOTE: the older `perf-durable-arch` branch holds the same
work via a messier revert/reapply history and is now BEHIND on code — treat THIS
branch (staging) as source of truth; perf-durable-arch is superseded (kept only for
its doc history, now copied here).

**Slices DONE + LIVE-verified on staging (NOT on prod — await owner merge):**
- ✅ **Sales SO list** — `?fields=minimal&include=` (empty include drops jobCards).
  1.2MB→72kb. Sales total RM 1,155,048.95 + "194 of 200" byte-identical.
- ✅ **Delivery Planning/Ready** — `GET /api/delivery-orders/ready-planning`
  (shared buildReadyPlanning, withSnapshot+SWR, runtime-CREATE snapshot table). FE
  drops the 1.2MB PO pull → ~10 KB. Planning 179/RM136,340.35, Ready 52/RM24,982.22,
  Delivered 265/RM1,004,020.88 byte-identical. (BUG-2026-07-13-001 fixed en route.)
- ✅ **Mobile Home Pending-Delivery** — reuses /ready-planning; dropped its 1.2MB PO pull.
- ✅ **Inventory FG-stock (2026-07-14, THIS session)** — `GET /api/inventory/fg-stock`
  returns DELTAS `{counts, dyn}` via shared `splitFgDeltas` (snapshot-cached
  `inventory_fg_stock_snapshot` + SWR + runtime CREATE). FE keeps its /api/products
  and merges by id via shared `mergeFgDeltas` → dropped THREE fetches
  (production-orders ~1.2MB + delivery-orders + consignment-notes). LIVE-verified:
  page now calls ONLY /api/inventory/fg-stock (0 production-orders/DO/CN calls);
  rendered tallies Total SKUs 272 / Available 52 / Reserved 22 / Bedframe 160 —
  byte-identical (0 per-product diffs in the live compare). Round-trip unit test
  `tests/fg-stock.test.mjs` (7 cases) proves merge(split(derive))≡derive.
  Commit ebc4d1b6. build:strict + full suite green.

- ✅ **Consignment note (2026-07-14, THIS session)** — `GET /api/consignment-notes/ready-planning`
  returns `{planning, ready, poLookups}` via shared `buildCnReadyPlanning` (verbatim from
  note.tsx mapPO + poReadyForConsignment/poInPlanningConsignment gates) + `poLookups`
  (companyCOId/fabricCode/rack for CN-referenced POs, rack via shared
  aggregateRacksFromPackingCards). Snapshot-cached (`consignment_ready_planning_snapshot`,
  cache_key **v2**). FE drops THREE fetches (production-orders ~1.2MB + consignment-orders +
  linked-po-ids) — Planning/Ready rows + the 3 CN-item lookup maps now come from the endpoint.
  Derived tabs carry NO money (CN amounts live on the CN records, untouched). LIVE-verified:
  planning 1 / ready 4 / poLookups 22 byte-identical (0 diffs); page calls ONLY /ready-planning.
  Commits daf711c0 / ab245466 / eadb25c8 / 6909192e.
  GOTCHA (new rule): adding `poLookups` did NOT surface — `withSnapshot` tracks source-table
  mtimes, NOT code, so it served the old v1 blob as "fresh" and the FE lookup columns went
  blank. **A payload-SHAPE change MUST bump the snapshot `cache_key`** (arch-doc rule #3). Fixed 6909192e.
- ✅ **Mobile ProductionScreen (2026-07-14, THIS session, PARTIAL)** — dropped `include=jobCards`
  (board reads only currentDepartment+status, never jobCards) → `?fields=minimal&include=`.
  Byte-identical display, big weak-wifi payload cut. Commit 68e24403. FULL keyset fix (server
  search + per-dept count + infinite scroll) still QUEUED — this is just the safe cut.

- ✅ **Planning (2026-07-14, THIS session)** — the interactive board can't drop the PO
  rows (drag-drop + bulk-patch writes), so two additive levers instead: (1)
  `warmPoListPlanningVariant` warms the previously-unwarmed `excludeCompleted=true`
  snapshot every cron tick → planning serve-stales instantly, no more ~8s cold block
  (measured live on prod: 10MB/8s cold). (2) `include=jobCards-lite` ships only the 12
  job-card fields planning reads (audited: every access is jc.X in a local loop) via
  `slimJobCardsToPlanningLite` (post-pass, no threading; blast radius = the lite request
  only). LIVE-verified on staging: 0 field-diffs across 14,310 JCs, payload 9.92MB→4.99MB
  (50%), warm load ~0.7s; the only PO-set delta is 21 old COMPLETED POs at the 35-day
  rolling-window boundary (NO live/schedulable work dropped — onlyInLite=0). Planning
  page renders, calls jobCards-lite (0 full-jobCards). Commits e670820d / 9b45c37e.

**Reports (2026-07-14, THIS session) — DONE + verified:**
- ✅ **Daily Report (compliance.json ~6s)** — snapshot + serve-stale + warm cron
  (reports_compliance_snapshot, keyed by SGT date; sourceTables = the transactional tables).
  LIVE: 6.8s cold → **0.87s** warm, data intact (4 sections incl. generatedAtIso), byte-identical.
- ✅ **Dashboard brief.json (~4.4s)** — same pattern (reports_brief_snapshot, no-AI/no-write
  variant). AI HTML /brief untouched. warmComplianceReport + warmBriefReport on the cron.
- 🟡 **aging (3s)** — LEFT ALONE: it's a MONEY report (AR/AP) that ALREADY has a cache +
  revision-invalidation (BUG-2026-07-09-002 history). Too sensitive to re-cache under the
  "no past bugs" rule; the 3s is a cold rebuild that the existing rev-bump handles.

**Remaining perf — RISK/REWARD reassessed (2026-07-14):**
- 🟡 **Mobile ProductionScreen — full keyset — NOT WORTH IT (present to owner).** After the
  jobCards drop + Brotli the board is **72KB over the wire** (1.6MB decoded @ 22.5×). The
  keyset would save mainly ~1s of client parse, at the cost of INTRODUCING the dead-data bug
  class (search must reach the whole table). Poor risk/reward — recommend NOT doing it; the
  jobCards drop already solved the payload. Await owner's informed call.
- 🟡 **service-cases (5MB / 19 rows) — CANNOT slim (known trap).** The /m L2 detail
  (m/config/modules.ts) reads responsibleUnit/preventionStatus/affectedProducts/root-cause
  details straight off the list row → slimming blanks the mobile detail. Proper fix = a
  SEPARATE mobile detail endpoint so the list can slim; bigger, deferred. (Snapshot-caching
  it is safe but stores a 5MB JSONB row per refresh — marginal, skipped.)
- ✅ **warehouse wip (2.9MB / 1219 rows) — DONE (2026-07-14, THIS session).** Two safe wins,
  no slim/L2 risk: (1) dropped the dead `grouped` field — a per-rack-name copy of the WHOLE
  `data` array that NO consumer reads (verified desktop warehouse.tsx + /m WarehouseScreen +
  whole src) → ~halves the payload. (2) Map-bucket rack_items by rackLocationId (was
  O(racks×items) via per-rack `items.filter`). Byte-identical rack grid. Commit 387840ad,
  BUG-2026-07-14-005. Procurement PO list already small (89KB); its page also pulls
  /api/inventory as a sibling — that fetch could be slimmed next if the owner wants it.
- ✅ **Snapshot freshness sweep (2026-07-14, THIS session) — dead-data guard.** /review
  correctness pass found inventory /fg-stock tracked delivery_order_items but read the parent
  delivery_orders.status (dispatch flips the parent, not the item) → stale stock after a
  dispatch. Swept the whole ready-planning family: added every status/enrichment table each
  snapshot actually reads to its sourceTables (delivery_orders, sales_orders, sales_order_items,
  consignment_orders, consignment_notes, products). Freshness-only, no cache_key bump. Commit
  ca9789aa, BUG-2026-07-14-004. RULE: sourceTables must cover every JOINed parent's
  status/columns, not just the FROM table.
- ✅ **Site-wide compression ALREADY ON** ("white-pickup" = done) — Cloudflare serves
  Brotli (`content-encoding: br`) at ~20×; the 5MB planning JSON is only ~255KB over the
  wire. So the bottleneck was NEVER the wire — it's server COMPUTE (cold snapshot builds)
  + client PARSE/derive of the decoded JSON. The warm-cron (compute) + payload slims
  (decoded size → parse) target exactly that; no compression work needed.
Method for a derive-and-drop slice: extract shared builder (verbatim from FE) → additive
server endpoint (withSnapshot+SWR+runtime CREATE, **bump cache_key on any shape change**) →
LIVE byte-identical compare (endpoint vs current client compute) → swap FE → re-verify.
Golden rule (owner's #1 fear): search/filter/count/money-total ALWAYS server-side over
the WHOLE dataset; page window is render-only. 11-pt checklist in the arch doc.

## 2026-07-14 — ✅ Edit Customer modal — short-screen "can't save" fix (THIS session)
Owner reported (2nd screenshot): on a short laptop screen the tall single-column
Edit Customer modal overflowed with no way to scroll to Save — users literally couldn't
save. Fix (customers.tsx, commit 2b205a51): landscape 2-column layout (Company | Credit)
+ `max-h-[90vh] flex flex-col` with a scrollable middle + PINNED header/footer, so Save is
always reachable. Pure layout, no data/save-logic change. Sweep of the other ~40 modal
overlays: the vast majority are short confirm/QR/picker dialogs (max-w-sm/md) that can't
overflow — only genuinely tall entity-edit forms share the bug. NONE blanket-fixed (risky,
mostly unnecessary); flag specific tall edit-forms to the owner before reshaping. Add-Customer
is an inline Card (scrolls with the page — not vulnerable).

---

## 2026-07-13 — 🔵 Delivery Return — driver item-flagging + desktop deliver/DR/SV convert
Owner ask (4 parts, feature → staging):
1. **Driver scan** (do-scan.tsx): on "Delivered with issues", show item list → driver
   ticks the specific damaged items (+ problem) → system AUTO-creates a Delivery
   Return for the damaged items, and the remaining good items are all marked delivered
   (good lines invoice normally; DR lines already excluded from invoice via Phase 5
   computeDoInvoiceLines). Backend: public-do-qr `/advance` accepts `damagedItems`,
   creates DR BEFORE the delivered cascade so auto-invoice excludes them.
2. **Desktop DO detail**: support Dispatched → Delivered with the same per-item damaged
   handling (Mark Delivered → optional flag damaged items → auto DR + deliver rest).
   (Post-hoc "Convert to Delivery Return" button already exists for DELIVERED/INVOICED.)
3. **DR → Service Order convert**: DR detail "Repair & re-deliver" should create the SV
   order carrying the DR's damaged item lines — `/sales/create?fromReturn=<drId>` hydrates
   the SV from the DR items + links DR.service_order_id (today it makes a bare case from
   the whole SO, not the specific damaged items).
Shared backend: extract `createDeliveryReturnRecord()` helper (reused by DR POST +
driver advance). **Mockup FIRST (UI rule) → owner OK → build.**

**CORRECTED (2026-07-13, 2nd pass) — PER-LINE returns:** Owner clarified: NOT whole-DO —
partial (e.g. 10 items, only 2 returned). Driver "Delivered with Issue" → tick WHICH lines
are returning → those open a DR, the rest deliver + INVOICE as normal (no invoice hold).
- `public-do-qr /advance`: replaced whole-DO `returnGoods` with per-DO `returnItems` map
  (doId→productionOrderId[]). DR for the ticked subset created BEFORE the delivered cascade
  so computeDoInvoiceLines excludes them; kept lines bill + send the normal notice.
- DO summary payload now carries `items[]` (productionOrderId/code/name/qty) so the phone
  renders the return checklist with no extra fetch.
- `loadDoItemsForReturn(db, doId, onlyProductionOrderIds?)` gained the subset filter.
- `do-scan.tsx`: 2nd button "Delivered with Issue" (amber) opens a return-picker panel →
  tick returned lines → "Deliver — return N items"; success stays green "Delivered". Reverted
  the whole-DO "Returned"/incomplete copy.
- Desktop "Convert to Delivery Return" (DELIVERED/INVOICED, item picker) already covers the
  office route-2 (assume delivered → then DR). build:strict clean; 116 do-qr/delivery tests pass.

--- superseded first pass below (whole-DO, WRONG) ---
Driver side = NO item picker. Clean either/or after dispatch: customer received →
Mark Delivered (normal, invoices); customer did NOT receive → **"Not received —
return goods"** → whole-DO Delivery Return, NO invoice. Built:
- `src/api/lib/delivery-return-create.ts` NEW — shared `createDeliveryReturnRecord()`
  + `loadDoItemsForReturn()` + ensure/nextReturnNo/genId (moved out of the route so
  office + driver write identical DRs).
- `delivery-returns.ts` POST refactored onto the shared helper.
- `public-do-qr.ts` `/advance`: `returnGoods` flag → DO marked DELIVERED +
  deliveryIncomplete (invoice+notice withheld) + auto full-DO DR (best-effort).
- `do-scan.tsx`: 2nd button relabelled "Not received — return goods" (PackageX, red),
  sends `returnGoods`; success screen "Returned"; DoCard/already-done copy updated.
- Desktop #1: `delivery/detail.tsx` — direct "Mark Delivered" from LOADED (parity;
  backend already allows LOADED→DELIVERED).
- Desktop #2: "Convert to Delivery Return" already exists (DELIVERED/INVOICED).
- Desktop #3: DR detail "Repair & re-deliver" now seeds the service case with the
  RETURNED items as affectedProducts → the SV order pre-fills just the damaged lines
  (reuses the existing ?fromCase hydration; no new route).
build:strict clean. Design note (mark-delivered+hold reuses the tested COGS reversal;
DO chip shows "Delivered" though driver saw "Returned" — DR is source of truth).
Owner to test on staging → then prod. Possible follow-up: show a "Return opened" link
on the DO detail so the office finds the auto-DR without going to the DR list.

---

## 2026-07-11 — 🔵 Hookka Report program — BUILT + ON STAGING (verified real data)
Operations Report LIVE on staging (staging.hookka-erp-testing.pages.dev/reports,
default "Operations" tab). Backend collector src/api/lib/operations-report.ts (11
sections, per-section guard → one bad query degrades not 500s, _errors diagnostics)
+ GET /api/reports/operations.json?period=daily|weekly|monthly&date=. Newspaper
frontend src/pages/operations-report.tsx wired into src/pages/reports.tsx. Feature
branch feature/ops-report → merged to staging (NOT main/prod yet — needs owner OK).
VERIFIED live 200 with real numbers: 176 bf + 28 sofa units, 96 overdue, sales
RM128k, 36 workers/11 bonus, RM9.47M stock, RM1.09M AR aging, delivery 42 DOs
(1.4d→0.8d). Fixed en route: delivery `do` reserved-word alias; newProducts
self-applies products.created_at.
**Honest gaps to raise with owner:** (1) on-time 21% is real (dispatch vs internal
hookka_expected_dd) — looks alarming, confirm the target basis; (2) foam/other
material cost = 0 (partial month OR wrong foam itemGroup code — need owner's real
foam category); (3) low-stock = 0 because raw_materials.minStock reorder points are
unset — owner must set them; (4) still UNBUILT sub-metrics: dept-cost analysis
(highest dept + Prod vs Non-prod), RM-category analysis, QC defect %, service open,
supplier on-time rate, price-rise alerts, attendance %, new-product photos.
Prior spec + caveats below.
Owner approved newspaper/broadsheet design (Artifact monthly-gazette-v1) + full content
+ "就这样 proceed". Liked inventory (dead-stock idle days) content specifically. Build =
in-app "Operations Report" page (Daily/Weekly/Monthly tabs), newspaper CSS ported into
app (English UI), reuse EXISTING module calc helpers for口径 consistency, Print→PDF via
existing print engine + unified letterhead. Feature → staging first, then prod on owner OK.
Data-source mapping via 4 read-only agents in progress. Prior spec below.
Owner wants an official daily/weekly/monthly operations report, freshly designed
(claudedesign). Same section set, time-window + emphasis shifts (daily = act-now
queues + per-person efficiency; weekly = trends/SLA/rankings; monthly = totals +
analysis + cumulative). 9 base sections (owner's 5 + my 4 additions):
1 Production (on-time %, overdue, output, production cost) ·
2 Purchasing (PO total, top suppliers, supplier on-time, price-rise alerts) ·
3 Delivery SOP — 3-stage SLA (produce→ship, ship→dispatch, dispatch→deliver) + pain pts ·
4 Employee/QC (attendance, efficiency [daily=per-person, weekly=top/bottom-5, monthly=
   cumulative bonus gate], QC defect %, Service issues) ·
5 Sales (top-seller SKU, sales analysis + insights, one-off specials) ·
6 Inventory (low-stock reorder alerts, FG buffer, stock value, dead stock) — MY ADD ·
7 Finance/AR (aging 30/60/90, billed vs collected) — MY ADD ·
8 Material variance (actual vs BOM standard = waste, fabric cost/meter) — MY ADD ·
9 Supplier performance (on-time rate, price-rise) — MY ADD (folds into Purchasing).
**Monthly-only additions (owner):** People changes (new hires + leavers named lists;
promotions = no system data, skip) · New products showcase (this month's new products,
one representative per category + product photo).
**Weekly-only additions (owner):** Dept cost analysis (highest-cost dept + Production
vs Non-production comparison) · Raw-material analysis (highest-cost/share RM category).
**Dept split (owner confirmed):** Production = the 8 shop-floor depts (Sew/Cut/Uph/
Frame…); Non-production = office/admin/sales/delivery.
Data all from mature modules (reuse existing endpoints). NEXT: monthly mockup → owner
approves layout → build. Not started coding.

---

## 2026-07-11 — ✅ Data-tally fixes P1-P3 (owner "全做" after 4-agent audit) — ALL SHIPPED
P2+P3 shipped in c1cb3bb0 (unify metrics + honest labels + month defaults + OCR
confirm wiring + date clip + div-zero + consolidated-DO + 153/RM0 + same-dept skip).
P1 last item shipped: future-dated PO completedDate → 26 POs re-dated to updated_at
(one-shot POST /api/admin/fix-future-completion-dates, RUN on prod + REMOVED after;
0 future RM_ISSUE rows remain, 148.7m/28m fabric moved back to real months) + a
guard capping job-card completedDate at today. P4 (forward scheduling / bottleneck
lead time / Hookka Report program) still parked — needs owner design.
Branch `data/tally-fixes-0711` (P2+P3), `data/tally-fixes-p1` (P1). Findings in memory
`project_data_accuracy_audit_0711.md`. Scope approved by owner:
**P1 real bugs:** OCR accuracy never populated (confirm step unwired + 'T' vs space
date clip in ocr-accuracy.ts:72); process-skips same-dept false positives
(compliance-report.ts:971-1010, "PACKING ahead of PACKING"); "153 Closed Sales"
mislabeled DELIVERED + RM0 service-order overcount; delivered-cohort drops
consolidated DOs (dashboard-overview.ts:1013-1048); div-by-zero backlog blow-ups
(dashboard-overview.ts:893, planning/index.tsx:991); future-dated fabric RM_ISSUE
rows (2026-09 148.7m BF, 2026-12 28m sofa) — prod data fix, locate + propose first.
**P2 unify:** efficiency → department-performance ratio-of-sums everywhere
(Attendance card fetches dept-perf totals; low-eff threshold 60 shared); backlog
headline = backlogGrandMin basis so dashboard 9.4d == drill == planning 9.1d;
mobile Home Daily-Report chips → read /api/reports/compliance.json (kill client
re-derivations incl. 70-vs-60); workforce excludes TEST everywhere (owner OK'd);
sales month excludes ON_HOLD (align to so-status CONFIRMED set).
**P3 labels/defaults:** Planning "Today's Capacity"→queued-work label, "Used %"→
backlog-pressure; dashboard QUEUE LOAD label, "Below Pace Today"→yesterday,
"153" headline wording; employees ALL tabs default current month (clamp persisted);
remove stale "full data parity" footer + dead planning capacity legend; daily-cap
divisor excludes today (partial day).
**P4 (parked, needs owner design):** forward scheduling wiring, bottleneck-based
lead time, daily/weekly/monthly Hookka Report program.

---

## 2026-07-11 — ⚪ Add FG: bulk auto-generate variants from Model (owner)
Owner wants Inventory → Finished Products → "Add FG" to STOP creating variants one
by one. Flow: he adds Sofa Compartments / Bedframe Sizes in Products → Maintenance,
then on Add FG he enters only Code + Name + Category (+ picks the Model, e.g. 2990).
The system auto-generates ALL variants from the Maintenance config:
  • Bedframe → one FG per Bedframe Size (K/Q/S/SS/SK), auto-filling Base Model /
    Size Code / Size Label.
  • Sofa → one FG per Sofa Compartment (1A(LHF), 1A(RHF), 1B…, 2A…, etc.).
Fabric Usage + Base Price left blank — filled later via Batch Edit (batch-by-batch),
for BOTH sofa and bedframe. Goal: "open all compartments/sizes at once", not one by
one. Feature → staging + mockup first. Config lives at /api/kv-config/variants-config.

---

## 2026-07-10 — 🔵 Mobile Delivery + Warehouse UX batch (owner 7 asks + screenshots)
**STATUS: all 6 built + committed (branch mobile-delivery-warehouse-ux 86130bdf),
build:strict + tests green. NOT yet on prod — awaiting owner's explicit "ship"
(default-Floor changes live inventory behavior; hold per no-merge-without-command).**
Diagnosis correction: the "blank DO detail / no QR / squished" report did NOT
reproduce at 390px — the detail shows Customer/State/Driver/barcode/QR fine; the
real gap was a consolidated (multi-SO) DO's blank HEADER, now backfilled.
Owner reviewed /m Delivery & Warehouse. Captured asks (do not drop any):
1. **Planning & Pending Delivery cards** → richer, like the detailed SO card (screenshot: NICO
   TEST — code+ref on one line, customer, 🏠 hub, Processing→Delivery dates, created, amount).
   Card structure already carries the 5 IDs (code=our SO, Cust PO/Ref/Cust SO metas); gap is
   DATA (reference/customerSO showing "—") + a richer layout.
2. **Delivery search "040"** — searching one status doesn't make clear the same number also lives
   in Dispatched; want it obvious a match spans statuses.
3. **Search delivery by customer SO / Reference** — must actually find the order (data present).
4. **Mobile DO detail** (DO-2607-043) shows BLANK Company SO/Customer/State/Expected DD/Driver/
   Vehicle; **line items** carry NO customer info (Cust PO/SO/Ref, our SOID); layout squished;
   **QR/barcode** on desktop DO — bring parity to /m. (Detail config is complete → root cause is
   payload fields empty OR Draft DO genuinely lacks them — verify live.)
5. **Default packing → "Floor"**: when packing done, by default stock-in to the Floor location;
   operator reassigns to a specific rack later.
6. (Warehouse, carried) search by **Company SOID** — rack item payload lacks companySOId/customerSO.
7. (Delivery, carried) **cross-source unified search** — one query finds an order whether it's still
   a Sales Order (Planning/Pending Delivery) or already a DO (Pending Dispatch/Dispatched/Delivered).

---

## 2026-07-09 — ✅ Aging snapshot invalidation (BUG-2026-07-09-002)

Voiding an advance-only payment writes no probed source table, so the cached
/aging kept phantom advance rows (BIG GREEN −1,560, AUN CHING YAP −3,570)
after the owner voided them. bumpSupplierPaymentsRev() now rides in every
payment mutation batch (create/void/unvoid/knock/un-knock/restate) bumping
kv_config. Verified live: phantoms gone; aging Σ = /ap-control net = GL
400-0000 = 242,798.69. Owner then voided all four GVP payments himself
(reorganising GVP start-to-finish) — PI-2605-011 back to 2,650 outstanding is
EXPECTED; GVP is owner-managed now, hands off.

## 2026-07-09 — ✅ Other-Party Bills editable in place (owner: 「开了无法edit,我要能edit」)

`PUT /other-party-bills/:billNo` (restate: reverse visible GL + repost under
`other_party_bill_restate_rev/post:<stamp>`, collapse; same number; party
fixed; new total ≥ paid via pure `editedBillStatus`). Lifecycle void/delete/
unvoid now pass the whole leg family (`otherPartyBillLegFamily`) so voiding an
edited bill can't leak restate legs. FE: Edit button (ACTIVE rows), edit
banner, locked party, New/Copy/Scan clear the edit state. GET returns
`isOpening` for the prefill. 1461 tests green. Deployed + owner to exercise
the first real edit (his ask) — verify GL via /ap-reconciliation ties after.

## 2026-07-08 — ✅ AP drift −966.60 BROKEN TO THE SEN: /ap-reconciliation endpoint + BUG-003 fix

Owner rule 「做账就是要准」. Shipped `GET /api/accounting/ap-reconciliation`
(read-only; pure `src/lib/ap-recon.ts`, 16 tests asserting Σ item contributions
≡ drift — residual is structurally 0). First prod run itemized −966.60 EXACTLY:
- **GVP −950.00** — HPV-2605-001 (ACTIVE) booked 950 to PI-2605-001 which sits
  in opening_ap_excludes. ✅ RESOLVED 2026-07-09: owner ruled the payment is NOT
  for PI-2605-001 ("还另外一张单" — likely PI-2604-010, also excluded); detached
  back to an unapplied advance via the new `POST /supplier-payments/un-knock`
  (subsidiary-only reverse of knock-off; PI paid re-derived via the truth-guard
  SQL). This matches the old accountant's TB (GVP −950 credit balance).
  **DRIFT NOW 0.00 — control = net = 195,692.69; recon items empty; residual
  0.00 (verified live).**
  ✅ CLOSED 2026-07-09: owner ruled 「不认，继续当预付款，过后我会进回这张单」 —
  the advance state IS the final state; the owner will enter the bill himself
  later and knock the 950 onto it via the normal Knock-off flow. No action.
- **INNOVATEX −418.00** — HPV-2607-009 GL kept DR 836 vs subledger 418.
  ✅ OWNER CONFIRMED 2026-07-09 「我只付RM418罢了」→ the 836 is the system's
  double-record: BOTH the original supplier_payment legs AND the 07-06
  restate_post legs stayed visible (that restate's hide-old-legs step didn't
  bite). Repair = re-run restate with the true 418 (its rev nets out whatever
  is visible — bounded: worst case unchanged, never worse). Was blocked by
  **BUG-2026-07-09-001** (restate rejected fully-paid PIs) — fixed
  (restateHeadroom), deployed, then executed live. Bank 310-0010 was
  overstated by the same 418; heals together.
  ✅ CLOSED 2026-07-09: owner ruled 「不理它」 — PI-2606-001 stays
  CONFIRMED/unpaid 418 in the creditor aging BY OWNER CHOICE. Do not re-raise;
  not a bug.
- **WF LEATHER +401.40** — voided payment's advance row still counted →
  **BUG-2026-07-08-003, FIXED** (lifecycle NOT-EXISTS in
  loadUnappliedSupplierAdvances; heals /aging AP + /ap-control + advance card).
- ±15.06 pi edit-leg pair — folds into base PI after sourceId suffix strip, no
  effect (this was the "strange DR 15.06" clue; 152.40 clue = 401.40 advance
  + prior-snapshot noise, both accounted).
After the fix the card reads **−1,368.00 = GVP −950 + INNOVATEX −418** (both
owner-pending data decisions, permanently itemized by the endpoint). The old
"+16.60 identity" hand-math is obsolete — use the endpoint.

## 2026-07-04 — 🔵 Multi-Company Phase 3: dual-identity + inter-company mirror (worktree branch, NOT pushed)

ADDITIVE-only, opt-in, default OFF. Finance-adjacent — built conservatively;
external customers/suppliers/POs/SOs behave byte-identical.

**Delivered (foundation of inter-company flow):**
- **Dual-identity link** — new snake_case `group_org_code` on BOTH `customers`
  and `suppliers` (default ''). A customer and a supplier that share the same
  code (e.g. 'HOUZS') are the one real group company wearing its two hats
  (AR/customer + AP/supplier stay separate streams). Reuses the existing
  `suppliers.is_group_company`; the mirror decision also name-matches legacy
  rows flagged only via is_group_company. Runtime-ensured, backfilled off.
- **PO→SO mirror** — when a PO's seller is a flagged SISTER group company (not
  HOOKKA) and the global `auto_create_mirror_docs` config is ON, PO create
  auto-raises a mirror SALES ORDER under that sister (`sales_org_code` = sister,
  buyer HOOKKA as customer, PO lines copied 1:1 in sen, status DRAFT — a doc
  record, NO production cascade). Idempotent via `intercompany_mirror_log`
  (UNIQUE source_type+source_id → retry never double-creates). Non-blocking:
  any mirror failure is logged + swallowed so PO create never breaks. External
  POs never reach the DB work (pure decision short-circuits).
- Pure decision logic in `src/lib/intercompany-mirror.ts` (12 unit tests,
  `tests/intercompany-mirror.test.mjs`, wired into `npm test`).
- DO/Invoice customer auto-send: UNTOUCHED (no code near it changed).

**TODO'd (deliberately deferred):** consolidated-P&L intra-group profit
elimination (`TODO(intercompany-pnl-elimination)`); GRN mirror
(`TODO(grn-mirror)` — needs inventory-safe design since GRN posts stock+cost).

**Risk note:** mirror SO customer resolution requires HOOKKA to exist as a
CUSTOMER of the sister in the catalog — if absent the mirror SKIPS (no back-door
customer creation) and releases its log claim so a later retry succeeds.

---

## 2026-07-04 — 🔵 Multi-Company Phase 2: company dimension on SO + PO (worktree branch, NOT pushed)

ADDITIVE-only. Company selector on create + Company column + Company filter on
the Sales Orders and Purchase Orders lists. Existing docs → Hookka; default list
view shows EVERYTHING; filter defaults to ALL companies.

**Findings (verified before coding):**
- PO side largely DONE already: `/procurement/create` full-page form has the
  "Purchase company" dropdown (persists `purchaseOrgCode` via POST); PO list has a
  "Purchase co" column. Only the PO list **company filter** is missing.
- SO side: `sales_orders.orgId` is the TENANT-isolation column and the SO list is
  tenant-scoped (`withOrgScope` → `WHERE orgId=?` bound to users.orgId='hookka').
  Writing a non-hookka `orgId` would HIDE the SO → violates "show everything".
  → Company dimension for SO is a NEW snake_case `sales_org_code` column (mirrors
  PO's `purchase_org_code`), leaving `orgId` untouched.

**Plan:** (1) SO create dropdown → sales_org_code; (2) SO list column + filter;
(3) PO list filter. Runtime ensure + DEFAULT 'HOOKKA' backfill for sales_org_code.

**DONE (worktree, NOT pushed):**
- New pure helper `src/lib/company-dimension.ts` (resolveCompanyCode /
  readCompanyCode / matchesCompanyFilter) + `tests/company-dimension.test.mjs`.
- Backend `sales-orders.ts`: `sales_org_code` runtime ensure + DEFAULT 'HOOKKA'
  backfill; POST INSERT + PUT UPDATE persist it; SalesOrderRow type + rowToSO
  read (dual-keyed). PO backend already accepted purchaseOrgCode — untouched.
- SO create `sales/create.tsx`: "Company" dropdown (defaults HOOKKA), payload +
  localStorage draft. PO create `/procurement/create` already had it.
- SO list `sales/index.tsx`: "Company" column (code→name) + "Company" filter
  (default All Companies). PO list `procurement/index.tsx`: "Company" filter
  added (column already existed).
- `SalesOrder` type in `src/types/index.ts` gained `salesOrgCode?`.
- build:strict clean; company-dimension + so-category + sql-write-column-coverage
  + delivery-refs + sofa-combo tests green.

---

## 2026-07-04 — 🟡 FULL-auto payroll settlement, manual panel REMOVED (staging branch, NOT pushed)

Owner picked (A): FULL auto — auto-dock the shortfall on partial/under-logged
days too, and REMOVE the manual Keep-pay/Deduct review panel entirely. Delta
built on top of the prior-round auto-settle, on the worktree branch (NOT pushed).

**Delta this round:**
1. **Under-logged (To-fill) days now auto-dock.** New pure helper
   `computeUnderLoggedShortfallHours(logged, expected)` (= expected − logged on a
   partial day; 0 logged = absence, left to the salary deduction). Extracted the
   shared guard/apply core `maybeApplyAutoDayDock` (MANUAL never overridden,
   finalised month skipped, full day clears stale AUTO); `maybeApplyAutoPunchDock`
   now delegates to it (byte-identical — all prior tests green).
2. **`POST /settle-period` rewritten** to a unified per-day settle over ALL factory
   workers × working days: dock = max(punch shortfall, under-logged shortfall).
   Returns punch-source vs logged-source counts. `Settle month` button + confirm
   text updated; live punch-out path unchanged.
3. **Manual panel removed.** `WorkerDayDrillIn` is now READ-ONLY (dropped
   onAction/busyKey/workerId, the Action column, Keep-pay/Deduct buttons). Removed
   `handleUnderAction` + `underActionBusy` + the auto-settle-chip code + the
   period-attendance fetch. Panels re-labelled "under-logged (auto-docked)". Undo
   on a stored dock kept (restores pay for a wrong auto-dock).
3b. Historical MANUAL overrides respected (guard) + finalised months never
   re-settled.

**FULL-auto month recompute (June 2026, before=nothing docked → after=full auto):**
- AH SENG perfect → RM0.00 (byte-identical).
- MEI 15m-late (punch) → −RM51.25 (6.5h, already auto last round).
- **ZAW LIN under-logged, NO punch → −RM33.12 (4.2h To-fill) — NEW this round**
  (previously waited for a manual Deduct click).
- KUMAR mixed → −RM29.57 (0.75h punch + 3h To-fill; forgot-punch-out day logged
  full so NOT docked; OT paid).
- Crew Δ −RM113.94; of which **7.2h is NEW To-fill/under-logged auto-dock** (the
  hours the manual panel used to hold — ~RM57 on this crew, in the ballpark of the
  ~RM52.73 To-fill the owner cited).

**Tests:** `tests/settle-period-punch.test.mjs` rewritten (13 cases: To-fill maths,
day-dock core guards, unified mixed month, ZAW-LIN under-log, idempotent,
MANUAL-survives, approved-skip, corrected-clears). Full suite 1387 pass / 0 fail;
strict typecheck clean; eslint 0 errors.

**RISK owner explicitly ACCEPTED (do not re-litigate):** weak wifi → a worker who
worked full but whose punch-out failed AND whose office grid logs fewer hours
will now be auto-docked. His call; the office fixes it by keying the real hours
(clears the dock on next settle) or a MANUAL Keep-pay row.

---

## 2026-07-04 — (superseded) Auto-settle with manual panel kept for no-punch days

Prior round (before owner picked A): punched days auto-settled, no-punch days kept
a manual choice. Superseded by the FULL-auto entry above.

**What already existed (verified):** the shift algorithm + auto short-hour dock
(`maybeApplyAutoPunchDock`, `attendance-deduct.ts`) already runs on EVERY worker
punch-out (`worker.ts:1182`) and office grid save (`employees.tsx`) — ≥9h check,
late-past-grace, OT-from-30-min (owner 2026-07-04 correction confirmed live in
`attendance-rules.ts:130-136`), day-typed 2×/3× multipliers, unified ÷26. So the
per-day auto engine was DONE; the remaining "manual choice" was the Labor Cost
Under-recorded review's Keep-pay / Deduct buttons.

**What I built (auto-settlement, no manual pick for punched days):**
1. `employees.tsx` — the Under-recorded drill-in now loads the period's punches
   (`/api/attendance`) + the AUTO docks; a day with a COMPLETE real punch
   (in + out) is **auto-settled** → the Keep-pay / Deduct buttons are REPLACED by
   a read-only "Auto-docked Xh" / "Auto-settled" chip. Days with NO punch keep
   the manual choice (conservative — never auto-dock a no-evidence day). A
   clock-in-only day (forgot punch-out) stays manual, mirroring the engine guard.
2. New `POST /api/payroll-hour-deductions/settle-period` — batch-replays the
   per-day helper over EVERY punch in a month (idempotent, same guards: no
   clock-out → skip, finalised month → skip, MANUAL never overridden, full day
   clears stale AUTO). Wired a "Settle from punches" button (single-month view)
   that runs it then regenerates payslips once.
3. Tests: `tests/settle-period-punch.test.mjs` (5 cases: mixed month, idempotent,
   MANUAL-preserved, approved-month-skip, corrected-punch-clears). Added to the
   `npm test` list. Full suite 1374 pass / 0 fail; strict typecheck clean.

**Month recompute (June 2026, representative crew, before→after gross):**
- AH SENG perfect full days → **RM0.00 Δ** (byte-identical, no-change worker).
- SITI 18:25-out → **RM0.00 Δ** (OT-30 rule: 0 OT, full day — not a spurious 15m).
- MEI 15m-late daily → −RM51.25 (6.5h × ~RM7.88/h).
- RAJ leaves-30m-early daily → −RM102.50 (13h).
- KUMAR mixed → −RM21.68 (forgot-punch-out day kept full; OT day paid; short docked).
- Crew total RM10,200.72 → RM10,025.29 (Δ −RM175.43).

**Flag for owner:** the no-punch under-recorded day still shows a manual
Keep-pay / Deduct choice (conservative). If owner wants those auto-DEDUCTED too
(treat missing punch as short → dock), that's a one-line policy flip — but it
docks pay on absent-punch evidence, so left as manual pending his call.

---

## 2026-07-04 — 🔵 Owner: mobile parity sweep + FULL brutal technical audit

A. **Mobile parity**: every problem class already solved on desktop must be
   re-checked and solved on mobile (/m + worker portal) too — explicitly:
   mobile loading performance (measured /m home = 4.3MB/20 calls) and scan/OCR
   issues. Method: BUG-HISTORY + this week's fixes → per-fix mobile
   counterpart check → fix list → implement (staging for /m).
B. **Full technical audit** per owner's pasted 15-area prompt (architecture,
   DB, API, perf BE/FE, UX, business logic, AI, security, monitoring, testing,
   devops, scalability, code quality, consistency) — DONE. 12 reviewers (6
   by-domain + 6 by-module/tab), every claim file:line-verified. Report artifact
   published (erp-audit-v1). Overall 66/100 = "solid single-tenant, harden
   before 100 users". FALSE POSITIVES caught: assistant.ts "no auth" (has
   SUPER_ADMIN gate at :532); cost_ledger "out of control" (narrow COUNT-race,
   real but bounded). 5 real bugs found+fixed live this session (delivery
   bulk/POD invoice cache, folder-detail bulk cache, customer sofa-combo cache,
   /m bulk+mail cache, 52 updated_at indexes). Fix queue by tier in the artifact:
   scale-blockers (cascade transactions, N+1 bulk cascade, cost_ledger UNIQUE,
   composite indexes, money idempotency), correctness (SO→INVOICED WHERE guard,
   CN-reversal-ledger VERIFY, AR-aging page-1, warehouse stock-in rollback),
   quality (monolith files, camelCase map, API envelope, error tracking), quick
   wins. Owner picks what to build. VERIFY-BEFORE-FIX applies to every flagged item.

---

## 2026-07-04 — 🔵 Owner multi-ask batch (labor hours + OCR ordering + sweeps)

Logged verbatim so nothing is skipped:
1. **SO + GRN should follow the uploaded documentation's ORDER** — owner
   CLARIFIED 2026-07-04: he means the order of RECORDS from a combined
   multi-PO upload (10 customer POs in one file → the 10 created SOs must be
   numbered/listed 1st→10th like the paper stack), NOT line order within one
   SO (the within-SO category sort is fine / not his complaint — do NOT
   remove it). Batch-pipeline investigation running. SEPARATE keeper from
   the first investigation: desktop GRN create sends poItemIndex from an
   un-sorted array while the backend matches ORDER BY id — same class the
   mobile fix (2cfa3ba7) closed; fix desktop too (correctness, not display).
2. **Invoice-page bug classes → whole-system sweep** ("查看全系統還有哪個這樣"):
   (a) filter dropdowns sending NAME where the API expects an ID
   (b) stale grid selections surviving filter changes (DataGrid fix 99c20d3c
   already app-wide; verify no page keeps its own parallel selection state).
3. **Labor/Payroll go-live decision (owner)**: the manual Keep-pay/Deduct
   backlog panel on Labor Cost vs Revenue is NO LONGER wanted — punch clock is
   live, so the system must auto-settle from real punches per the Payroll
   algorithm (≥9h check, late deduction, OT). No manual choice. NOTE memory:
   auto-deduct was gated on staging verification (can't test pay on prod).
   Investigate current flow → propose exact auto rules → owner confirms → build.
4. **Bug: auto-from-punch hour attribution looks wrong** (owner screenshots,
   entries dated 2026-07-01): AUNG KYAW SOE punch 07:32→18:02 but only 1.33h
   logged (an approved R&D non-production row seems to displace the auto
   rows?); PHYU SIN MOE 0.01h fragment row; ZAW LIN 12:59→18:28 = 0.94+4.31
   (5.3h short — half-day, maybe correct). Also: punch-out 6:28 vs expected
   6:30 — rounding/grace? does OT count from it?
5. **Explain the pay rules in plain language**: when is a day late/short,
   when does OT start, what adds/deducts money — full list for owner. DONE
   2026-07-04 — and owner CORRECTED one rule: **OT only counts from 30
   minutes past 18:00** (code currently pays from >15 min; 18:28 must be 0
   OT, not 15 min). Fix with the ① batch on staging; affects punch autofill,
   labor engine, payslips — verify numbers on staging before prod.
6. Owner "ok" 2026-07-04 → plan approved: ① autofill safety-gate bug (an
   approved non-prod row blocks punch-row generation → AUNG KYAW SOE 1.33h
   day) + fragment rule (fold <0.1h scan-boundary rows into largest bucket)
   + OT-30min correction, all on staging → ② SO/GRN document-order fixes
   (batch investigation pending) → ③ full-auto Keep-pay/Deduct settlement
   (staging month-recalc shown to owner before prod).

Invoice-page 4-fix (BUG-2026-07-03-003) pushed to main 99c20d3c, deploy
in progress; verify live then report.

---

## 2026-07-03 — 🔵 Visibility plan EXECUTING on staging (owner: "上staging就行")

**Phase 1a SHIPPED to staging (commit 64d62058) + verified live on staging:**
KV serve-stale for the non-paginated production list — body stored under stable
key `pos:body:{org}:{qs}` with org version in KV METADATA; version mismatch →
serve previous body instantly (X-Cache: STALE) + single-flighted background
rebuild (buildListPayload(swr:false)) stores fresh body stamped with
post-compute version. Paginated path unchanged (versioned key). Freshness
semantics identical to the 2026-06-06 mark-stale SWR design — only the COST of
the stale serve drops (1.3-5.4s → ~0.1s KV read). Verified on staging (9.8MB
data, same volume as prod): MISS 5.1s cold → HIT ~0.9s → benign write (JC
dueDate set to same value) → next poll STALE 0.87s (was 1.3-5.4s MISS) →
+16s HIT fresh. Convergence ≤2 poll cycles, all reads sub-2s.
**Phase 2 SHIPPED to staging (4392e710):** new src/lib/upload-file.ts (50MB
pre-check, 180s timeout, verify-bytes-servable via Range probe before success
toast) wired into products/documents.tsx + catalog.tsx; files.ts 413 message
humanised; worker punch POST got catch + status check + 60s timeout + new
home.punchFailed i18n (was: failed punch showed NOTHING).
**Phases 3+4 SHIPPED to staging (20ceeb7a):** verify-before-fix killed most
audit claims (invoices-page create, PO/GRN/PI, inventory all already
invalidate fine). Real fixes: ① delivery-page invoice-generate now broadcasts
invoices/SO/DO cache invalidation (was: nothing) ② NEW scan-queue-sweep.yml
cron every 15min (endpoint existed, NOTHING scheduled it) ③ backup retention
prune wired: pruneOldBackups exported + CRON_SECRET-gated
/api/internal/backup-prune + backup.yml step after upload (was: prune code
orphaned behind a never-provisioned Workers Cron Trigger, dumps unbounded).
Pre-auth route allowlist test updated (security-public-endpoints.test.mjs).
NOTE: schedule: workflows only fire from main — sweep/prune go live at merge.
**Remaining:** restore drill (needs owner's Supabase dashboard, PITR confirm);
deeper perf levers (BOM parse cache, fabric precompute, per-dept versions) =
diminishing returns, only if lag persists after Phase 1a.

**2026-07-03 late: all-tab perf sweep on staging (17 pages, live measured).**
Owner upgraded Supabase (plan/compute — helps DB speed + PITR; app-side fixes
still needed). HEAVY tabs (payload/slowest): ① /m mobile home 4.3MB/20 calls
(652KB delivery-orders + eager prefetch of everything — phones on weak wifi!)
② /inventory 4.0MB (inventory/wip 2.9MB + delivery-orders 652KB + products)
③ /delivery 2.4MB (pulls FULL unpaginated sales-orders 1.4MB @ 6.1s + products
277KB) ④ /warehouse 1.7MB (one 1.45MB call @3.8s) ⑤ /procurement 1.3MB
(inventory 895KB on the PO page). HEALTHY: invoices 156KB, customers 14KB,
GRN/PI ~200KB, planning 37KB, reports lazy, consignment 320KB, employees
274KB, sales ~1MB acceptable. Disease = same as production had: pages eagerly
pull FULL sibling-module lists. Cure queue (owner to green-light): slim/paged
variants for delivery→sales-orders, inventory/wip, warehouse list; /m home
lazy per-tile loading. Reuse Phase-1a KV serve-stale pattern where applicable.

**Phase 0 SHIPPED to staging (commit bb104e1f) + verified live on staging URL:**
① archive real-run hard-disabled (POST ?dryRun=false → 410 confirmed; dry-run still
returns counts) ② global search shows "Search failed — connection problem" on network
failure instead of "No results" (verified by fetch-fail simulation; normal search
regression-checked OK). NOTE: lock protects PROD only after staging→main merge (owner
must order the merge explicitly).
**Phase 1 measurement (live prod, read-only):** wire transfer is only 0.5MB (CF
compression) — download is NOT the bottleneck; TTFB = 5.4s on cold snapshot rebuild,
1.3-1.8s snapshot-warm/KV-miss, 0.77s KV HIT. 92% of decompressed 10MB = jobCards
(14,702 JCs / 1,007 POs). fields=minimal already slims non-active-dept JCs in DEPT
mode but OVERVIEW mode (activeDeptCode=null) sends full shape for all 8 depts.
piecePics NOT emitted in minimal (agent claim corrected). → Phase 1 = attack server
compute (5.4s rebuild + per-write version-bump churn) + overview-shape trim as
secondary; NOT pagination (breaks 10 features), NOT transfer size (already 0.5MB).

---

## 2026-07-03 — 🟡 Full-system "visibility" audit DONE → plan proposed, awaiting owner pick

4-agent audit completed (archive reads / uploads / caches / archived-row writes).
**Verdict: NEVER run the archive as-is** — hot-only reads mean archived orders vanish
from search + detail 404 + dashboards/reports/accounting undercount (dashboard-overview,
department-performance, leadtimes, compliance-report, accounting.ts all hot-only;
INNER JOINs in invoices.ts:1306 / planning-schedule.ts:131 DROP rows); writes silently
no-op on archived rows (invoice-from-old-DO can bill RM 0 via computeDoInvoiceLines
fallback, po-cost-cascade.ts:529 skips cost posting, consignment hold 0-row UPDATE,
recomputePoStatusAndProgress no-ops); NO unarchive endpoint. Archive stays dormant/never
run; 45d COLD_DAYS harmless. Speed to be solved by pagination instead (Fix #1).
Other real gaps found (all need verify-before-fix at file:line before touching):
① invoices POST doesn't invalidateCachePrefix("/api/invoices") → cross-tab stale list
② PO/GRN/PI caches not cross-linked ③ inventory list manual-refresh only ④ uploads:
file listed in DB but bytes possibly not yet openable (storage lag) → "uploaded but
can't open"; presigned URL 300s expiry mid-Export-Pack; 413 error prints raw bytes.
Proposed 3-step plan to owner (1 = paginate+server-search Production, 2 = upload
verify-then-confirm + retries + human errors, 3 = cache invalidation patch set).
Stale-chunk white-screen: already well-mitigated (main.tsx preloadError + SW purge).

---

## 2026-07-02 — 🔵 Debtor/Creditor OPENING 工程(年中开账,owner 全程拍板)

- ✅ Supplier Payment 每行加 print(已上线 prod)
- ✅ Debtor 对账定案 v5(货品级三层验证 PO→SO→description):opening 52 张 RM 148,803 + knock 系统发票 RM 7,588 = 旧TB 156,391 分毫不差。工作簿 Downloads/debtor-opening-最终清单-v5.xlsx。**Debtor+sales 等业主最终确认才录(铁律)**
- 🔵 年中开账功能(分支 `claude/midyear-opening`,canary 就绪待业主验):opening 表格收 P&L + 22/05 前 PI 默认当 opening(`opening_ap_excludes` 排除表,原单零改动)
- ✅ Creditor 开工包已交付:Downloads/creditor-opening-开工包.xlsx + creditor-opening-粘贴版.sql(76 张期初 PI RM 118,138.41;排除 8 定案 + GVP×2/CLM×1 待业主决定;Advance GVP 950/CHL 640;开账表格数值页)
- ⏳ 待业主:① canary 验收→合 main ② 建 DELIMIX 供应商 ③ 决定 GVP×2/CLM 排除与否 ④ 按开工包顺序执行
- 铁律:之前录入的不删不改;录入动作全部等业主下令

---

## 2026-07-01 — ✅ Supplier Payment list showed empty despite a real, GL-posted payment (BUG-2026-07-01-003)

Owner recorded HPV-2607-002 (ADD WOORD TRADING, RM 11,476.00) via the normal Record
Payment form — visible in Supplier Statement + Creditor Ledger, but the Supplier
Payment page's own All Payments list + summary cards showed all-zero/empty, even
after a hard refresh. Root cause: `GET /api/supplier-payments` read `row.payment_no`
(snake_case) but the Postgres adapter camelCases every result column regardless of
SQL alias text — same class as BUG-2026-06-30-001. Second, independent bug found
in the same sweep: `purchase_invoices.amount_sen` / `paid_amount_sen` misreads made
PI-targeted allocations (POST /, restate, and today's own Knock-off feature) always
see outstanding=0 — likely why the owner ended up using the Advance field for this
payment instead of paying PI-2606-037 directly. Fixed both (dual-keyed reads,
extracted to tested pure helpers in `src/lib/supplier-payment-alloc.ts`); shipped to
`main`. **Owner follow-up needed:** use the Knock-off feature to re-attribute
HPV-2607-002's advance to PI-2606-037 (GL is correct; only the subsidiary
attribution is off). See `docs/BUG-HISTORY.md` BUG-2026-07-01-003 for full detail.

---

## 2026-06-30 (late) — ⚪ Supplier-PI OCR quality QA (owner batch, after the compression fix)

Owner scanned a real 13-PI bundle (compression fix WORKED — it split + extracted).
Found 7 issues to triage/fix:
1. 🔴 **Price = 0 on some PIs** — NHL invoice (IV-91176) shows 99.40 / total 757.68
   but the PI line came out Unit Price 0 / RM 0.00. Haiku missed the price on a
   faint/messy scan; existing "Fix A" backfills unitPrice from supplier price
   bindings only (no binding → stays 0). ⚠️ check if the ~150-DPI compression
   hurt price legibility (raise quality?). Money path — highest priority.
2. 🟡 **Preview cards NOT in upload/page order** — children named pi-9-10 / pi-28-29
   (split works) but cards aren't sorted by page range → owner tallies manually.
3. **Ensure INVOICE-type docs convert as Purchase Invoice** (vs DO/GRN) — confirm
   docType=INVOICE → PI flow holds.
4. **Dup detection — same PI scanned twice:** only EXACT same file bytes are
   deduped (file-hash). A re-scan/re-photo of the same invoice = different bytes
   → NOT caught. GAP: detect by supplier invoice number.
5. **Different invoice numbers (451 vs 450)** — each doc's invoice no is extracted
   separately (treated as distinct ✓); relates to #4 (dupe-by-number).
6. **Discount:** PI DETAIL supports a DISCOUNT line type (exists), but the scan
   preview doesn't capture the invoice's discount → manual add today. Could
   extract discount in OCR + surface on the preview card.
7. **Sponge density + thickness** (3rd photo) — density (NLY22GH) + thickness
   (25MM) are critical for matching the right Internal Code; ensure OCR extracts
   + uses them.

---

## 2026-06-30 — 🔵 "全部强化掉" — SRE / infra resilience + perf + OCR (owner directive)

Owner authorized hardening the whole reliability layer. Playbook written:
[`docs/INFRA-RESILIENCE-PLAYBOOK.md`](INFRA-RESILIENCE-PLAYBOOK.md) (reusable
across sibling projects). Goals in owner's words: entering the system must not
white-screen / be slow / lag; DB fetch fast; EVERY operation incl. the Workers
mobile (`/worker`, `/m`) must not lag (currently laggy). Plus OCR + research.

**Asks logged (so none drop):**
1. ✅ Pool size 50 (owner set in Supabase). ⏳ Compute → Small blocked by a
   Supabase platform incident (project resizing failing globally). Re-do once
   status.supabase.com clears; verify it lands on prod `vpwdqtsxexpiqxzweivd`.
2. 🔵 **B — DB connection retry + graceful 503 login** (`supabase-compat.ts`,
   `auth.ts`) — written, shipping now.
3. ⬜ **Keep-warm heartbeat** — ping `/api/pg-ping` every 1–5 min (GitHub Action
   or UptimeRobot; Pages can't cron).
4. ⬜ **Don't logout on transient failure** — session-verify returns 503 (not
   401/500) when DB errors; frontend retries once before `clearAuth()`.
5. ⬜ **Monitoring** — set `SENTRY_DSN`; UptimeRobot on `/health`.
6. ⬜ **Perf diagnosis** — white-screen / slow mobile (`/worker`, `/m`) — needs
   real diagnosis, not a blind switch.
7. ⬜ **OCR** — confirm/enhance: upload 100 imgs → auto-split (by SO / by GRN),
   done docs show first + rest "loading", non-blocking (mostly shipped in
   BUG-2026-06-30-003; verify the grouping matches the ask).
8. ⬜ **Research** — what else normal ERPs do for SRE/infra → add to playbook.

---

## 2026-06-29 — ⚪ PARKED for study: Weak-wifi resilience campaign

**Owner (2026-06-29) — factory remote, wifi weak, workers can't punch / can't
login / white-screen. Asked for the "full campaign" root-cause solution. Decided
to STUDY first before building — too big to do reactively.**

**Already shipped this session (preventive):**
- ✅ `SameSite=Strict` → `Lax` on session cookies (`session-cookie.ts`,
  `auth.ts`, `auth-oauth.ts`) — workers opening ERP from WhatsApp/email no
  longer arrive without cookie → silent 401 → /login bounce. Industry-standard
  posture; CSRF defence retained via double-submit `X-CSRF-Token`. Test
  assertions updated in `tests/session-cookie-remember-me.test.mjs` (NOT yet
  pushed — owner rejected; pending owner OK).
- ✅ SPA `<script>`-tag asset-404 recovery (`main.tsx` + earlier
  `vite:preloadError`) — catches stale chunk after deploy → SW purge + reload
  (was only catching dynamic `import()` failures before).
- ✅ Sticker `legsPair` overflow on DIVAN piece (root cause was unrelated to
  wifi but surfaced same week).

**Studied solution menu (DO NOT START — needs owner go-ahead per item):**

Level 1 — Network infrastructure (most effective, $-cheap, OWNER ACTION):
- Mesh wifi APs in factory (1 per dept ≈ RM 300-800 each, total ~RM 1.5-3k)
- 4G/5G failover router (~RM 400) — auto-switch when wifi dies
- Cat6 to fixed punch stations / total office PC

Level 2 — Software (engineering work, large):
- **A. Offline-first punch + sync** — IndexedDB queue, UUID idempotency, GPS+selfie
  captured locally + uploaded on reconnect. 99%+ achievable, NOT 100% (browser
  cache-clear + reinstall lose unsynced events). 2-3 hours code, 1-2 weeks
  pilot before full rollout.
- **B. Pre-cache login page + app shell** — login renders even with wifi flicker
  on first hit. ~1 hour.
- **C. Don't kick out on transient 401** — retry once with fresh cookie before
  redirecting to /login. ~45 min.

Level 3 — Architecture (medium):
- Split shop-floor view (offline-first) from office view (online-required)
- Local edge server per dept (Raspberry Pi-style) caching + buffering

Level 4 — Hardware (long-term):
- Dedicated factory tablets at punch stations (more stable than worker
  phones) — runs same /worker PWA but fixed location + reliable power + 4G

**Specifically called out risks for A (offline punch):**
- Worker clears browser cache → unsynced punches LOST
- Clock manipulation (server must record device-time + sync-time)
- Late-arriving sync hitting closed payroll day → cron re-run needed
- Selfie + GPS upload retry logic if first attempt fails
- Server dedup on (workerId, ts, action) via UUID per event

**Owner's gating decision:** "放进 pending tasks 先, 大工程, 我们需要先 study."
Plan: revisit AFTER Level 1 network improvements are done, see if pain
remaining justifies Level 2 work.

---

## 2026-06-26 (late) — CURRENT STATE (tidy summary; detailed logs below)

**✅ LIVE on prod + staging:** PIC flicker fix · mint+jc sticker · packing-list per-piece racks · Standard Times (#B) · announcement collapse · 2-PIC everywhere · DO-email PDF · schedule Barcode→QR · **PIC2 save fix** (Hyperdrive read-after-write false mismatch).

**🟡 ON STAGING — awaiting owner verify → then promote to prod:**
- Real-logo PWA icons · Auto-sent mail full-detail view (was a modal)
- **Announcement photos/PDF now render** — worker-token file proxy `/api/worker/ann-files/:id/download` (root cause: `/api/files` is cookie-gated, 401s on the phone)
- Media lightbox (square tiles + fullscreen swipe) · Past-announcements moved to Me tab (below Standard Times) · Clock-in full-width (no box-in-box) · single-dept label
- **Announcement targeting** — All / specific departments / specific people, multi-select (default All)
- **Web Push** — announcement→push (respects targeting) + 8:00/18:00 clock reminders. ⚠️ needs VAPID secrets set to work
- **#C Time-adjustment** — non-prod hours + NEW extra-production-time claim; efficiency = (WIP std min + approved extra min) ÷ ((prod clock-hrs − approved non-prod) × 60); no-claim workers byte-identical. ⚠️ owner verify the efficiency math
- Earlier staging batch: #3 mail-list UI · #5+/r/ per-piece QR/rack · #D media columns · #E archive · multi-dept · staging trim

**⚙️ DEPLOY STEPS before Web Push works:** set Worker secrets `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` / `PUSH_CRON_SECRET` (+ `VAPID_PUBLIC_KEY` matching the committed fallback) on prod AND staging; add `PUSH_CRON_SECRET` as a GitHub repo secret for the clock-reminder workflow.

**🔍 Investigated, NOT bugs:** Eff-allowance @86% = per-worker "Eff. Threshold %" set ≤86 (data edit, not code) · Fab Cut "10 min" = BOM `dept_working_times` data (fix in WIP Times maint); WIP-time edits aren't audited so there's no record of who changed it (could add `emitAudit`).

---

## 2026-06-26 — Coding-base kickoff → staging deploy + test (owner rapid-fire)

**Branch: `feat/packing-mint-jc` → pushed to `staging` (NOT main/prod). Owner ruling: route this whole batch to staging, verify, then decide prod promotion.**

**✅ Shipped to staging:**
- **TASK 1 — packing mint poNo-drift fallback** (`production-orders.ts` POST `/packing-rack-tokens`): mirror worker.ts scan-lookup recovery (trim/CI poNo → `fg_units.poId`, live-PO only). + **TASK 2 — FG-PACKING sticker carries `&jc=`** (mint returns `cardIds`; `packingStickerUrl` appends jc; `parseStickerData` reads jc; worker `handleDecoded` resolves jc first). +6 source-assert tests. BUG-2026-06-26-001. ⚠️ Owner later said **packing scan no longer needs internal/external split** — but KEEP the public `/p/` + `/r/` codes (warehouse rack stock-in uses them); the mint/jc work is additive/harmless, left in place.
- **PIC cell flicker fix** (BUG-2026-06-26-002): the live overlay + baserows read `pic1Name`; the `?fresh=1` read-back + list snapshot return `pic1Id` but not always the joined name → cell blanked → flicker. Fix: overlay derives name from `pic1Id` via the `workers` roster when `pic{1,2}Name` empty (`deptRows` overlay, `production/index.tsx`). **All production departments** (one shared row model / PIC renderer). Completion date never flickered (stored field).
- **Packing List per-piece STACKED rack layout** (owner-approved mockup): rack column shows `HB: Rack 19` / `Divan: Rack 19, 20` (labelled, compact, newline-stacked); `generatePackingListPdf` takes optional `DOPrintExtras`; new `fmtRackStacked` reuses `formatRacksCompact`; col 30→34mm; falls back to flat rackingNumber; call site fetches `/print-extras`.
- **Staging DB refresh** (sync-staging.yml) + **staging trim**: deleted the 347 pre-2026-05-01 sales-order chains (619 POs, 9434 job cards, 923 fg_units, 151 invoices, 91 fully-owned DOs, etc.) via new `trim-staging.yml` (staging-scoped GH workflow, single transaction, FK-ordered, divide-by-zero guard, ANALYZE). 564 SOs kept, **0 orphans**. Undo = re-run sync. `trim-staging.yml` lives on `main` (inert tool — report default, execute needs `confirm=TRIM`); can be removed.

**🟡 In progress / queued (this session):**
- **② Unify the two rack UIs** (owner approved direction): make `warehouse.tsx` rack-contents card + `rack-scan.tsx` public `/r/` stock-in page share ONE rack card (same olive header + same item row: product code → customer·PO → SO; public adds trash + Stock In). Mockup approved 2026-06-26. NOT built yet.
- **③ Barcode scan feedback** — owner: QR scan turns blue (hit) but Barcode shows no blue/red; the gun/phone capture is also less sensitive. Add the same colour feedback to the barcode path. NEED to pinpoint the exact scan screen (worker-portal result card vs `/r/` rack scan). NOT built.

**⚪ Owner live-verify (staging) — no code unless a check fails:**
- Completed-row vanish (TASK 3) — owner tests one-by-one / batch / status-cell completion, names the path that drops a row → wire into `forceShowCompletedIds`.
- Doc-date basis · opening_date floor · PARTIAL_PAID (paste `Hookka迁移11` + test partial supplier payment) · QR canonical domain · customer-email drain. (All backend-shipped earlier.)

**Owner notes this session:** staging slowness = Tokyo region + small tier, NOT data volume (prod has same data, fast) — trim won't fix speed (owner trimmed anyway for shorter lists). Login bounce on staging = use incognito + prod creds (DB cloned from prod).

### Owner "把 pending 全部做掉" — parallel-agent build batch (late 2026-06-26) — SHIPPED to staging
Built via parallel worktree subagents, each reviewed + cherry-picked onto `staging` (typecheck app+base clean, tests pass). **STAGING-ONLY — owner must verify before prod:**
- **#3** Auto-sent mail view restyled to match the normal mail list (OutboxPanel rows/header).
- **#B-2** Standard Times multi-department selector (worker with >1 dept picks which dept's WIP times; backend `?dept=` validated vs the worker's set).
- **#E** Worker portal "Past announcements" archive — expired/hidden notices re-readable (collapsible).
- **#5 + /r/** Per-PIECE packing QR/rack: `piece_pics.racking_number` (mig 0192 + runtime self-apply), `/p/<token>?p=N`, per-piece `applyPackingRack`, `packingPieceIdentity` carries pieceNo, AND the `/r/` "scan items into rack" stock-in is per-piece — fixes "2nd DIVAN piece already in this rack". Additive (single-piece/old stickers byte-identical).
- **#D** Announcements carry image/video/PDF (mig 0193 `announcements.attachments` + runtime self-apply; reuses `/api/files`; worker renders inline).
- **PWA phase-1** installable worker portal (manifest + safe SW [network-first nav, never caches /api, version-keyed, prod-only] + Android/iOS install prompt + already-installed detection + geolocation re-ask suppression). build:strict passes. **SW is the riskiest — verify the app still loads.**
- **#C** Non-production hours APPLY (worker) + APPROVE (admin Working Hours) — new `worker_nonprod_requests` (mig 0110 + runtime self-apply); approve writes a non-prod `working_hour_entry` via the EXISTING path → efficiency denominator already excludes non-prod (departments.isProduction) → efficiency rises, NO pay-formula change.

**Investigated, NOT bugs (no code):**
- **Efficiency allowance @86%** → BY DESIGN: per-worker "Eff. Allowance (RM)" + "Eff. Threshold %" columns; that worker's threshold is set ≤86. Fix = data edit (raise threshold). Label is just misleading. (docs/investigations/2026-06-26-efficiency-allowance-86pct.md)
- **Fab Cut "suddenly 10 min"** → BOM-config data (the bedframe products' Fab Cut minutes in dept_working_times = 10), not a code regression; fix in WIP Times maintenance.

**STILL PENDING (the one big piece not built):** PWA **phase 2/3 = Web Push notifications** (announcement→push + 8:00/18:00 clock reminders) — needs VAPID + subscription storage + send + cron. Phase-1 install is the prerequisite (done); iOS push needs the PWA installed (16.4+).

### Owner spec batch (late 2026-06-26) — design/propose, then build (logged so none drop)
- **#A Department scan restriction — ❌ DROPPED by owner (2026-06-26).** Owner decided NOT to build the restriction/popup. Simpler model kept: the department is inferred from WHO scans (their own section), exactly like the shared Sew/Uph sticker (women's section → FAB_SEW, men's → UPHOLSTERY). No blocking, no "wrong dept" popup. Don't re-propose. ~~(proposed): worker may only scan stickers of their CURRENT dept (= latest dept-scan today, else punch dept); cross-dept scan → blocked popup "you are in <DEPT>". Choke point = `GET /scan-lookup` (skip shared Sew/Uph `wk=`/`c=` stickers, already self-route by section) + backend guard on scan-complete / scan-complete-dept. NO current enforcement exists. Full flow map done (clock→dept_scan_events→buckets→working_hour_entries via dept-scan-split.ts/punch-autofill.ts). Mockup popup → build after owner confirms current-dept rule + edge cases.
- **#B Show Production WIP Time to workers by their dept** (mockup requested): WIP time IS per-dept (BOM Time per WIP×dept; `dept_working_times`; FAB_CUT card mins = Σ BOM dept slots). Workers "totally don't know" the standard minutes → disputes. Worker Portal needs a read-only "your dept's standard times" view (their dept ONLY, from `workers.departmentCode`). Mockup the Worker-Portal placement.
- **#C Non-Production hours apply + approve flow** (design): depts have a Prod/Non-prod flag (Warehouse/Repair/Maint/Shortfall/R&D = Non-prod; Packing/Fab/etc = Prod). Worker who did non-prod work but missed the scan applies "Xh in <non-prod dept> today" → approval (prefer the approve action in the Working Hours screen). On approve: 9h all-prod → e.g. 7h prod + 2h non-prod, so efficiency = output/prod-hours (7/7 = 100%). Design where it lives.
- **#D Announcements rich media**: support image / video / PDF upload (tutorials, SOP PDFs, feature guides) — currently text-only. Reuse `/api/files`?
- **#E Announcement UX in Worker Portal**: (1) collapse/expand each announcement (tap to fold/unfold even after "got it" — long ones eat space); (2) expired announcements currently VANISH from the worker portal — owner wants past ones still READABLE (archive). Clarify Hide (manual) vs Expired (auto past hide-date) vs Delete. Worker portal (worker/index.tsx) home shows only Live, non-hidden.

## 2026-06-25

### QR/Barcode · Rack · Packing · Warehouse · Payroll — rapid-QA batch (owner rapid-fire)
**✅ SHIPPED to prod + staging:**
- **Identity trio** (Customer · Customer PO · Our SO) on rack scan / rack warehouse grid / rack popup / stock-out / Packing List / DO PDF
- Rack display **dedup** (Assign-Rack SO/PO + grid "SO SO") + mobile rack **contents list**
- **Unified `/p/<token>` packing-rack scan fix** — archive-aware `resolveCard` + `pickPackingCard` tiers + token-mint hardening (BUG-2026-06-25-003..006)
- Schedule **"Barcode" column: QR → 1D Code 128** (barcode-gun reads it)
- Packing List **per-piece rack label** (HB / Divan can be on different racks)
- **Warehouse search** — partial match (Our SO / customer PO / customer / product)
- Rack card **de-cram** (cleaner per-item layout)
- **DO dispatch → auto stock-out** (whole DO's items leave their racks) — delivery-orders.ts `stampedOnDispatch`
- **Payroll TOTAL row alignment** (was missing the Allowance cell)
- Barcode + QR **render-resolution bump** (clarity)
- **Manual Rack dropdown now saves** — `patchRack` was the only mutating call missing the CSRF token → 403 → silent rollback (`f9f05433`)
- **Staging code + DB sync** (FF + sync-staging.yml)

**✅ SHIPPED (cont.) to prod + staging:**
- **Sticker show/print slowness** — preview paints instantly (fallback URL) then upgrades to /p/ in the background; mint endpoint batched (serial per-piece loop → 2 queries + parallel mint). `bcb000d4` (BUG-2026-06-25-008a)
- **Manual rack assignment → warehouse occupancy** (owner B) — `applyPackingRack` now mirrors a `rack_items` row (set/move/clear + `rack_locations` status); office dropdown / `/p/` / worker scan all now show in the Warehouse grid; NEW shared `packingPieceIdentity` locks the identity vs the `/r/` scan. `3ec97e43` + CI wiring `4604c1a0` (BUG-2026-06-25-007)
- **CSRF audit = FALSE POSITIVES** (closed, NOT a bug) — `api-client.ts` globally monkey-patches `window.fetch` to auto-inject the token; the 40 "missing-CSRF" hits are non-bugs; the earlier `patchRack` CSRF "fix" (`f9f05433`) was a no-op. Don't re-chase. (BUG-2026-06-25-008b)

**✅ QR canonical domain (2026-06-26)** — prod's legacy `hookka-erp-testing.pages.dev` now renders as `erp.hookka.com` on EVERY QR / printed link / invite (new `src/lib/app-origin.ts` `canonicalizeOrigin`/`appOrigin`, applied to rackScanUrl / generateStickerData family / packingStickerUrl / dept-QR cards / invite link / DO+PL `qrScanUrl`); staging / preview / localhost keep their own origin so their QRs still resolve against their own DB. Scanning stays path-based so old pages.dev stickers still work. `fb31ab80`, +6 tests (owner "比较好看").

**✅ CoE docs + CLAUDE.md refreshed** (2026-06-26) for this session — NAVIGATION-MAP (warehouse rack→occupancy, `packingPieceIdentity`, FG-sticker batch), HOOKKA-GOTCHAS (+CSRF global interceptor, QR-follows-origin + canonicalization, rack-occupancy identity, codes-always-scannable), CLAUDE.md (CSRF-is-automatic + QR-origin non-negotiables).

**❌ Code 3-day lifecycle rule — DECLINED by owner (2026-06-26).** Owner chose **(A) always-scannable, NO time limit** after learning the old "expiry" was structural resolution failures, not a timer. NOT building a time-based expiry; the structural fixes (archive-aware resolve + pickPackingCard + token re-read) already shipped are the whole ask. See [[project_qr_no_3day_expiry]].

**🟡 PENDING / owner action:**
- **#1 external-phone scan opens Worker Portal not /p/** — owner reprint a sticker on staging + scan: old sticker = reprint; still wrong = mint bug (I dig)
- **#3 completed-piece "Complete" button** — CONFIRMED **NORMAL** (2-PIC sign-off), no change
- **Packing List stacked per-piece layout** mockup — awaiting owner OK
- **Verify on staging**: pick Rack 9 on the packing sheet → confirm it shows under Rack 9 in Warehouse; sticker preview/print is fast now

### 🔵 Owner "继续财务" → document-date reporting basis (was entry-date / postedAt)
Owner: "一切跟单据日期，不是开单日期 — 7月开6月的东西算6月." Root: the immutable ledger stores only `postedAt` (entry time) and ALL GL reports bucket/floor by it; a June invoice entered in July landed in July. Owner saw it as Monthly P&L Sales (634k, by postedAt) ≠ Command Center invoices (312k, by invoiceDate) — confirmed not my floor (pre-existing accrual-vs-issue gap). Owner approved a read-time **document-date resolver** (no DB change, postedAt fallback). Design/plan: `财务模块-单据日期口径-设计.md`/`-实施计划.md`.
- **Good news**: subledger reports (AR/AP control, statements, debtor/creditor-ledger, aging) were ALREADY document-date (read invoiceDate/date directly) — only the GL-based reports used postedAt.
- Pure `src/lib/doc-date.ts` (`stripLegSuffix` drops _void/_bounce/_reversal/_settle/_restate_rev|post:stamp → base family; `DOC_DATE_FAMILIES` maps 12 families → table/no/date cols, snake_case) + 8 tests. `loadDocDateResolver(db)` (accounting.ts) loads each family's (id, human-no → own date) ONCE, dual-keyed (sourceId is sometimes UUID, sometimes the doc number), try/catch per family, `docDate(sourceType,sourceId,postedAt)`: opening→opening_date, mapped family→doc date, period-end bookkeeping→parsed from sourceId (`parseSourceIdDate`: depreciation `dep-YYYY-MM`→month-end, closing_stock `cs-YYYY-MM`→month-end, year_close `fyclose-YYYY-MM-DD`→that date), else→**postedAt fallback (= legacy, safe)**. contra is always same-day (`today`) → postedAt is already its doc date (kept). (Follow-up 1 `f7c49d8a`: period-end parser. Follow-up 2: per owner "银行转账也需要根据文件日期" — fund_transfer (pure-ledger, no date stored day-precise) now records its date in a new `fund_transfers` table (no→date, runtime self-apply + migration 0190 / Hookka迁移12); resolver family fund_transfer→fund_transfers; the /fund-transfers list also shows the doc date. Existing transfers (no row) fall back to postedAt.)
- Wired 13 GL read paths to docDate (bucket + floor): trial-balance, gl all+one, gl-report, pl, cashflow, bank-reco+automatch, glWindowSigned (P&L windows), cost-expense-classes, computeUnclosedAsOf, ar/ap-control GL sums. Added `sourceId` to the queries that lacked it.
- **Perf**: `computePnlWindow`→`glWindowSigned` is called per-month (pl-monthly/trend); threaded a `DocDateCtx` so the resolver loads ONCE per request, not ~12 tables × N months. typecheck+eslint+1189 tests green.
- ⚠️ Backend-only (no frontend chunk change) → owner verifies live: a backdated invoice (doc date earlier than entry) should land in its DOCUMENT month on P&L/GL.

### 🔵 Owner "继续财务" → opening_date hard floor (pre-opening data not extracted) — ALL financial reports
Owner set opening_date=2026-05-22 but the GL ledger still showed pre-opening (2026-05-18) invoices — opening_date was only used to DATE opening legs, never as a floor. Owner chose "排除 + 之后重录真实期初" + "直接全做" (floor every financial report, not just AR/AP). Pure helper `src/lib/opening-floor.ts` (`legBeforeOpening` GL / `rowBeforeOpening` subledger; opening SEEDS exempt — GL opening_balance legs + invoices/PIs `is_opening=1` — so opening balances are never lost) + 11 tests. Floored (17 read paths in accounting.ts): trial-balance, gl (all+one), gl-report, pl (P&L+BS), cashflow-statement, bank-reco + automatch, computePnlWindow (pl-statement/trend/monthly), cost-expense-classes, **computeUnclosedAsOf** (BS retained earnings — would've inflated), ar-control (GL sum + invoices), ap-control (GL sum + PIs), customer/supplier-statement, debtor/creditor-ledger, aging (snapshot — added kv_config to sourceTables so it rebuilds on opening_date save), other-party-aging. Floor preserves double-entry balance (whole events skipped, both legs). NOT floored (by design): manufacturing cost/stock reports (own `material_opening_date` cutover), fixed-asset register (master data), document-list registers (fund-transfers/PV/OR — operational, not balances). ⚠️ Expected effect until owner enters real opening balances: AR/AP/P&L/BS ≈ near-zero (post-05-22 activity only). typecheck+eslint clean.

### ✅ Owner "继续财务" → "收尾小项" — task-chip cleanup batch (AP / supplier-discount) — SHIPPED (main `78f47bb2`; prod chunk `accounting-Bzp1Jg9y.js`→`accounting-D2ouG57q.js`)
🟡 **Pending owner**: run `Hookka迁移11-粘贴到SQL-Editor.sql` (permissive PARTIAL_PAID/CANCELLED constraint, names + registers it — runtime self-apply already relaxes it) + live-test one partial supplier payment / discount-allocation (status → PARTIAL_PAID, no 500). Owner confirmed the Supplier-counter card stays removed ("就先这样"). See BUG-2026-06-25-001.
Owner picked the no-data cleanup bucket. Investigated all chips against real code (did NOT trust notes blindly — one was a false alarm, one a confirmed prod bug):
- 🔴 **CONFIRMED PROD BUG — `purchase_invoices.status` CHECK rejects `PARTIAL_PAID`.** `0057_purchase_invoices.sql:30` = `CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PAID'))` — no PARTIAL_PAID. Supplier-discount alloc (accounting.ts:2001) + supplier partial-payment both write `status='PARTIAL_PAID'` → constraint violation → POST fails in prod. Second independent reason partial payments are silently broken (migration-7 missing column is the first). FIX: (a) runtime relax in `ensurePartialPaymentColumns` (`DROP CONSTRAINT IF EXISTS purchase_invoices_status_check`); (b) extract that helper to shared lib + call from `supplier-payments.ts` routes (closes the existing "supplier-payments should call ensure" chip); (c) migration 0186 + paste `Hookka迁移11` (DO-block: drop status CHECK, add permissive named `purchase_invoices_status_chk`).
- 🔵 **CREDIT_NOTE marker defensive filter** — markers = `supplier_payments` rows (amountSen=0, method='CREDIT_NOTE', no GL leg). Add `AND COALESCE(method,'')<>'CREDIT_NOTE'` to: supplier-statement (accounting.ts:2331) + creditor-ledger (2466) [hide 0-amount noise rows], and supplier-payments void/restate reads+delete [defense-in-depth; no number collision today].
- 🔵 **Remove dead AP "Supplier running counter" card** (accounting/index.tsx:3184-3190) — `suppliers.outstandingSen` never maintained → always red drift; the real reconciliation is card #2 (Creditor control vs booked-unpaid PI, drift=0). Keep symmetric AR Customer-counter card (that one IS maintained).
- ✅ **FALSE ALARM — journal-hash.ts:113 ledger UNIQUE constraint comment is CORRECT.** Prior note said it "lies"; actually `0117_ledger_idempotency.sql` really creates `UNIQUE(org_id,source_type,source_id,leg_no)`. The mislead: stale `delivery-snapshot.ts:6` comment cites a non-existent `0117_delivery_snapshots.sql` (real file = `0124_delivery_snapshots.sql`). No change to journal-hash; fix the stale delivery-snapshot comment.
- ⚪ **Voucher-print "loose ends"** — no TODO/FIXME in print-voucher.ts; nothing concrete found. Report back for specifics.

### ✅ Owner "全部做完" — Production/Dispatch/Worker-UX backlog closed out
Scoped all 6 open items (read-only multi-agent investigation). Result: most were already shipped after the 06-23 tracker entry; built the genuine gaps.
- ✅ **#1A Overview search by Customer PO** — `customerPOId` is in the search haystack (production/index.tsx:2659) + 98% populated live → already works. Complaint predated the haystack line.
- ✅ **#1B Overdue chip clears filters** — handler at :1376-1378 already clears q/state/customer/cat + clearAllOverviewFilters() (06-23 fix). Done.
- ✅ **#2 Pending-Dispatch QR-scan popup** — `do-scan.tsx`: product code already the primary line (prior commits); added shared **Customer PO** in the per-DO header (shown once when all lines agree, `hideCustomerPO` flag avoids per-row dup). Cherry-picked `571e3806`→main, shipped.
- ✅ **#3 Print uses SAVED layout + Org Default** — print preset wired (`printPresetLabel`); DataGrid auto-wires onSaveAsOrgDefault/onResetToOrgDefault when gridId present (data-grid.tsx:2846-7); ③ made them backend-shared. Done.
- ✅ **#4 Barcode** — already migrated 1D→compact ~12mm QR, column already "Barcode". The "thick/long/hard-to-scan" complaint was the OLD 1D code. Done (shrinking further would hurt scannability).
- ✅ **#5 Sticker component-type label** — `generate-sticker-pdf.ts`: new `componentTypeLabel(wipType)` (HB/Divan/Base/Cushion/Armrest/Headrest; blank for FG/merged) on landscape bottom-right + portrait right column. `wipType` already on the sticker model (no loader change). Cherry-picked `2c3804fd`→main, shipped.
- ✅ **#6 Catalog family tile** — already implemented (products/catalog.tsx: family grouping, one-tile-per-family, variant drill-down, family-keyed photos). My 14-photo seed lit the tiles up.

### ✅ Archive includeArchive UNION 500 — FIXED (BUG-2026-06-24-009b)
Self-healing `src/api/lib/archive-union.ts` (introspect + ALTER archive to column parity + explicit quoted ordered column list, replacing the fragile SELECT * UNION) + org_id backfill so pre-multi-tenant archive rows pass the org filter. includeArchive=true now 200 (was 500). NOTE: production_orders_archive is effectively empty — the 1665 purged pre-Apr docs live in `zz_purge_backup_*`, so model "559" is NOT in this archive; awaiting owner on WHERE they saw "559".

### ✅ ③ Org-shared DataGrid layouts · ④ Production-time resync · catalog photo seed · customer-email drain — all shipped + verified earlier this session (see BUG-HISTORY FEATURE-003/004/005, BUG-006/009b).

## 2026-06-23

### ✅ Post-work bug review + fixes (owner: "check for any bugs")
Two adversarial review agents over today's diff. **Money paths CLEAN** (PI posting, supplier discount, ap-control, void — all balanced/idempotent/atomic, drift=0). **UI: no crashes/corruption.** Fixed: (1) voided PV/OR/JV now print with a **VOID** stamp (control hazard); (2) orphaned DRAFT supplier-discount hidden from history (failed-save dead-end); (3) **`BUG-2026-06-23-008`** — editing an APPROVED **foreign** PI's lines corrupted its home amount (pre-existing, currency-blind edit path) → now blocked 409 "cancel & re-raise". Noted-not-fixed (pre-existing/product-call): AP "supplier counter" drift metric is unmaintained (GL-vs-subledger reconciliation is the correct one & is 0); popup-blocked print silent; repo-wide "Loading…" hang on API error; ledger unique-constraint + CREDIT_NOTE marker hardening (task chips).

### ✅ Printable vouchers — PV / OR / JV (→ main, feature)
Owner: "can the Payment Voucher etc. print out?" — they couldn't (no print on PV/OR/JV). Added a **Print** button per row on Expense Payment (PV), Official Receipt (OR), and Journal Voucher (JV) → opens a one-page A4 voucher via the browser-print pattern (`window.open`+`print`, like `printStmt`). Letterhead from `COMPANY.HOOKKA` ("Hookka Industries", per owner). Shared renderer `src/lib/print-voucher.ts` (`printVoucher`/`buildVoucherHtml`, HTML-escaped, pure builder) + pure `src/lib/amount-in-words.ts` (`amountInWords`, Malaysian "Ringgit … And Sen … Only", 9 tests). Layout: letterhead · title · No/Date · party · account lines (PV/OR amount; JV debit/credit + Σ) · total · amount-in-words (PV/OR) · remarks · signatures (Prepared/Approved/Received etc.). **No backend change** — list endpoints already return each doc's lines. tsc + eslint clean; 1168 tests. Subagent-built, reviewed (amount-in-words spot-checked, mappers verified vs edit view).

### ✅ Supplier Discount (purchase-CN upgrade) · #6 (→ main, feature)
Owner #6: "supplier gives me a discount, I need somewhere to input it" — can apply to one / many / no specific unpaid PI. The old standalone purchase-CN form (buried in Creditor Aging, jargon-named) is upgraded into a dedicated **Supplier Discount** tab (sidebar, Debtor/Creditor): select supplier → auto-list unpaid PIs → net+SST+reason → optionally tick/allocate per PI → Save (create→post) → history + Void. Design/plan: `财务模块-供应商折扣-设计.md`/`-实施计划.md`.
- **Task 1** pure `src/lib/discount-alloc.ts computeDiscountAlloc` (validate 0/1/many allocations, ≤ each PI outstanding, Σ ≤ total) + 10 tests (`f10a078f`).
- **Task 2** backend (`6b8b1d54`): PUT post takes `allocations[]` → reduces each PI `paid_amount_sen` + a `supplier_payments` `method=CREDIT_NOTE` marker (no bank/GL leg — the CN's DR400/CR-purchase already moved the GL); new `/:id/void` reverses GL (mirror legs) + allocations + supplier counter. No migration (reuses tables).
- **Task 3** frontend `SupplierDiscountTab` + sidebar + removed old form (`25030277`, subagent-built, reviewed).
- **Task 4** adversarial money-review → **GL/subledger/void all correct, atomic, idempotent, server-validated**. Fixed one real defect: `/ap-control` double-counted an allocated discount (`49fa5228`) — piOutstandingSen now net (amount−paid, incl PARTIAL_PAID), pcnPostedSen nets only the unallocated remainder → drift stays 0 (also fixes pre-existing partial-payment coarseness). Payment-history list excludes the markers.
- **Follow-ups (non-blocking, task chip):** defensive `method<>'CREDIT_NOTE'` on supplier-payment lifecycle queries; filter zero-amount markers from supplier-statement/creditor-ledger displays; confirm prod `purchase_invoices` status CHECK allows PARTIAL_PAID (stale migration file vs prod; existing supplier-payment flow already writes it).
- tsc + eslint clean; 1156/1157 tests.

### ✅ Audit Log — search box + "who" (actor name) · #10 (→ main)
Owner #10. (1) The **By** column now shows the actor's **name**, not a raw user id: `/audit-log` (`accounting.ts`) resolves the distinct `actorUserId`s → `users.displayName` (one `IN (...)` lookup) and returns `actorName` per row. (2) New **search box** on `AuditLogTab` — client-side filter over the ≤1000 loaded rows (reference / party / who / type / state). `AuditRow` gains `actorName?`; dynamic empty-state message. tsc clean, eslint clean, 1136/1137 tests. Read-only, low-risk → main.

### ✅ Sales-invoice "create-as-SENT doesn't post" — VERIFIED NO BUG (no change)
Checked all 4 invoice-create paths: `invoices.ts:1116` (manual from-DO) + `consignment-notes.ts:1213` (CN→invoice) create **DRAFT** (post on the PUT DRAFT→SENT transition); `delivery-orders.ts:908` (auto-on-delivery) + `:2142` (re-issue) create **SENT** and post in the SAME batch via `buildInvoiceLedgerLegs(..., itemsOverride)`. **No path creates SENT without posting** — unlike PI (whose POST accepted `body.status=APPROVED`, set by the import). The memory's "invoice is symmetric" assumption was wrong; corrected. Nothing to fix.

### ✅ PI created-as-APPROVED now posts to GL (bug fix → main) · `BUG-2026-06-23-007`
Root cause: `purchase-invoices.ts` only posted GL legs on a PUT status *transition* to APPROVED; the POST handler never posted. So a PI born APPROVED (bulk import / any create-as-APPROVED) fed Creditor Aging but not the ledger → 400-0000 drifted below aging (prod: 56 APPROVED PIs RM 75,340 in aging, 1 in GL). Fix: new pure `src/lib/pi-posting.ts buildPiApprovalLegs()` (DR buckets · CR 400-0000, balances) + 6 unit tests; POST posts on create-as-APPROVED (idempotent via `ledgerHasSource`, same atomic batch); PUT refactored onto the same helper (byte-identical, no drift). Opening PIs (`/opening-balance/ap`, isOpening) unaffected; history not retroactively posted (→ owner reconciliation). Backend-only; no operational module touched. build:strict clean, 1080/1081 tests, adversarial money-review SAFE (7/7). **NEXT: symmetric sales-invoice (DRAFT→SENT) fix.** Owner acceptance: create APPROVED PI → check Trial Balance / AP control.

### Mega-message backlog (owner, late 2026-06-23) — Production / Dispatch / Worker UX
- ✅ **Apply Completion single-row revert** — owner: "一个个按本来就没事,别动它". Reverted the forceShow change on the per-row completion + Status-cell paths; restored exact prior behaviour; kept ONLY the batch multi-select fix (BUG-2026-06-23-004). tsc 0 → main (741f5fa0).
- ✅ **Customer email — live prod check** — read 199 DOs on prod: **0 have any deliveredEmailAt/dispatchEmailAt** → customer-notify NEVER actually fired (dispatch OR invoice). Validates the backend-choke-point fix (already merged). No outbox GET endpoint exists. Historical 199 NOT auto-resent. Awaiting owner: do ONE real dispatch/invoice (I watch the stamp live) OR use the resend button (building).
- 🔵 **Production Overview — search by Customer PO returns nothing** (dept tabs DO find it) + **overdue chip should CLEAR search/customer/category and show full N** (owner: clicking red should pop the N, not make me clear the search first). Workflow wf_92a58d9f-c75 FAILED on transient API 500s → re-dispatching.
- ⚪ **Pending-Dispatch QR scan popup UI** (scan PL/DO QR → item list, e.g. DO-2606-072): show (1) **Customer PO** in the header, (2) per item **Product SKU = our Product Code** (e.g. 1013-(K)) **+ colour/fabric** (e.g. PC151-01). Example: "PO2605-123 · SO2606-133 · 1013(K) · Fabrics: PC151-01".
- ⚪ **Production Schedule PRINT must use the SAVED layout** — once owner sets columns + "Save as Production Schedule", every "Print Schedule" should print THAT saved column layout (not the current on-screen view); operator shouldn't hand-hide columns each print. ALSO verify "Save as Org Default" / "Reset to Org Default" actually work.
- ⚪ **Barcode (Print Schedule)** — (a) rename the "Scan" column → **"Barcode"**; (b) printed barcodes too THICK/LONG → only 6 items/page (30 items = many pages) AND insensitive/hard to scan ("scan 到半死都 scan 不到"). Redesign: compact + reliably scannable + more per page.
- 🟡 **Production STICKER component-type label (MISSED on first pass — added after owner flagged dropped tasks)** — on the printed per-job-card production stickers (the SO-2605-302-01 cards with QR + Fab Cut/Fab Sew + Qty), the bottom-right should clearly state WHAT PART this sticker is for: **HB / Armrest / Base / Divan / Cushion / Leg** etc. Owner asked "給我設計你會怎麽做" → propose a DESIGN first (mockup), get OK, then build. Component is derivable from the WIP/piece string (reuse the existing piece derivation).
- 🔵 **Catalog photos** — owner CHOSE: collapse same-family variants into ONE base tile (e.g. 1003 covers 1003 / 1003(A) / 1003(A)(HF)(W) + sizes), click tile → see variants, ONE family-level photo applies to all. Dispatched wf_6ed2a0bc-f17 (products/, parallel-safe). Feature → decide main vs staging at merge.
- ❌ **#54 Supplier Pricing merge — DROPPED** — owner: doesn't recognise it / not needed. Removed from scope.
- 🟢 **Announcement** — owner asked how workers see it / does it pop up. Current build = banner on worker phone home screen when they OPEN the app (no web-push). Offered: forced popup-on-open if wanted.

### ✅ JV account picker dropdown un-clipped (bug fix → main)
Owner screenshot: New Journal Entry line **Account** picker cut off after ~3 rows (CAPITAL / RETAINED EARNING / RESERVES). Root cause = `<div className="overflow-x-auto">` wrapping the JV lines table → `overflow-x:auto` forces `overflow-y:auto` → clipped the `absolute` AccountPicker dropdown. Fix = drop the wrapper (`accounting/index.tsx` ~L2493), matching OD/OC (bare table) / PV-OR (`w-80`) / labour (grid). Swept all 9 AccountPicker sites on the page — JV was the last clipped one. `BUG-2026-06-23-006`. tsc clean. → main.
- *Incidental:* paid down one pre-existing lint error blocking the gate on this file — `react-hooks/set-state-in-effect` (eslint-plugin-react-hooks v7) on the debtor/creditor ledger fetch effect (L5219, from today's `52fbe419` merge, which skipped the pre-commit hook). Targeted justified `eslint-disable-next-line` (standard `useCallback` data-load reused by the Refresh button; no behavior change).

## 2026-06-22

### 🔵 Mail Center — Gmail-style redesign with toggles (worktree, feature; do NOT push/merge)
Owner showed Gmail screenshots; asked for ALL of:
1. Compact single-line conversation rows (checkbox · star · unread dot · **Sender** · Subject — snippet … date right; hover row actions; tighter rows; unread distinct). Toggle = density compact/comfortable.
2. Category tabs above list: All / Primary / Notifications. CLIENT-SIDE heuristic over fetched rows (no backend cols). Toggle = show/hide tabs.
3. Reading-pane toggle: split (list + right pane, current) vs full-width list (row opens detail route). Persist in localStorage.
4. Cleaner Gmail-like visual polish; keep left nav functional (Inbox/Starred/Sent/Archive/Drafts/Trash/All + Labels + Departments/Mailboxes).
PLUS a master toggle Gmail-view vs Classic-view OR per-feature toggles ARE the "可以开关" (document choice).
PRESERVE ALL behaviour: reply/forward/star/unread/archive/trash, labels, Assign to, mailbox+dept scoping, unread counts, search, pagination, ~300 conversations. No API-contract change. build:strict must pass; UI 100% English.

### 🔵 F6 T4b — wire FIFO engine into P&L (branch `f6-material-fifo`, only `src/api/routes/accounting.ts`)
- New `loadMaterialCost(db, orgId, startIso, endIso)` → `{rmGroups[], wipOpenSen, wipCloseSen, fgOpenSen, fgCloseSen, warnings}` using the verified engine (`computeMaterialPeriod`/`rollupByGroup`/`valueIssues`).
- RM: opening (material_opening_stock) + GRN receipts (PI-weighted-avg if APPROVED PI else grn_items.unit_price) + cost_ledger RM_ISSUE/ADJUSTMENT, post-cutover, same-date receipts before issues.
- WIP: per-PO Σ FIFO issue cost (ref=PO) + LABOR_POSTED for POs in-progress as-of-D (date reconstruction).
- FG: per completed-not-delivered batch, FIFO unit cost = (PO FIFO material@completion + labor@completion)/original_qty × undelivered-qty-as-of-D (fg_units.delivered_at).
- Swap rmGroups/wip/fg values in computePnlWindow to loadMaterialCost; keep 704-x excluded from GL bands.

---

## 2026-06-21

### ⏸️ AWAITING OWNER — 3 decisions to finish the purchasing batch
- ✅ **① PI import DONE** — Excel reconcile: all 15 Excel POs already present; 19 PIs were missing (PI-2604-019→037, OCEAN SKY, RM 7,258) → imported via a piNo-override on the PI POST (commit `95bfd036`), preserving original numbers + status APPROVED + supplier Inv#/DO# + items. Verified live (19/19 present+APPROVED, line counts + amounts match Excel). Total PIs 592→611.
- **② J cleanup** — delete ~1665 pre-1-Apr docs (PO 555 / GRN 555 / PI 555): (a) docs only, or (b) docs + their stock batches + cost ledger? Destructive → needs a one-time script (option-A lock blocks normal delete). Snapshot first.
- **③ GRN no-draft** — imports-in-transit use the arrival pipeline (Planning→Arrived) instead of Draft; local goods → direct create + post. OK?

### ✅ Effective-dated supplier pricing + Price Change Log + Supplier Quotation PDF (G/H) — shipped main `ba306a41` (effective_from, append-only price_histories, PDF matches Customer Quotation).

### ✅ Purchasing create: no-draft (PO/PI) + supplier reference numbers — shipped main `8374fc6d`
- ✅ **PART 1 — no-Draft on manual create** (owner: manual → active; only OCR → Draft, like SO).
  - **PO create** (`procurement/create.tsx`): button "Save as Draft"→"Create Purchase Order";
    payload sends `status: "CONFIRMED"` (POST takes body.status verbatim, else DRAFT). Split-by-Supplier
    groups also CONFIRMED. Summary hint → "Status will be set to CONFIRMED". PO has no OCR path.
  - **PI create** (`procurement/pi/create.tsx`): manual → `PENDING_APPROVAL` (first non-DRAFT in
    purchase-invoices.ts VALID_TRANSITIONS); OCR/scan (`?scan=1` deep-link OR in-form Scan modal's
    applyOcr) flips `ocrUsed`→DRAFT. Button "Create Invoice" unchanged. Convert-from-GRN/PO prefill =
    PENDING_APPROVAL (operator-initiated, not OCR). Convert chain (line guard + grnItemId increment)
    unaffected — status-independent.
- ✅ **PART 2 — supplier reference numbers** (snake_case + runtime self-apply + migration file + SQLite mirror):
  - `grns.supplier_do_no` (ensureGrnMigrations); `purchase_invoices.supplier_do_no` +
    `purchase_invoices.supplier_invoice_no` (ensurePiMigrations). Migration files
    `migrations-postgres/0183` + `migrations/0105`.
  - FE: "Supplier DO No." on GRN create + GRN detail (inline edit via main PUT); "Supplier Invoice No."
    + "Supplier DO No." on PI create + PI detail (edit-mode, DRAFT-only). Read dual-keyed. Persist
    through create + edit (GRN main PUT + PI PUT both extended).
- tsc clean (only 3 known jsbarcode/@zxing). `npm test` 1010 pass / 0 fail. **NOT pushed** (worktree commit only).

### 🔵 IN FLIGHT — parallel agents (owner: "全部做完，不要紧" + ultracode; review+test+confirm before prod)
- ✅ **Convert-chain backend foundation** — line-level invoice guard (partial/2nd PI ok, blocks over-draw) + per-line `availableQty` + `grn_item_id` link + **OPTION A** (owner: received/POSTED GRN LOCKED from delete+un-post → no stock-reversal hole). 17 tests. Shipped main `97a69de6`; **verified live** (DELETE posted GRN → 409). postGRNToStock untouched.
- ✅ **P2 convert UX** — `convert-from-po-modal` (GRN) + `convert-to-pi-modal` (PI, GRN+PO tabs, carries grnItemId); picks show availableQty + clamp ≤ available; GRN "From PO|Manual" toggle DROPPED (manual default + PO-linked banner). Shipped main `77ed0013`; verified live (availableQty + grn item id exposed). 1010 tests.
- ⚪ **P3 multi-source** — multi-GRN→1 PI is close (per-line grnItemId already supports it; needs picker UI). **多PO→1 GRN needs SCHEMA** (grns.poId single-column → per-line PO source) = high-risk, own branch.
- ⚪ **P4 PI→COGS cascade** — highest-risk cost cascade; own branch + owner buy-in.
- ✅ **Supplier Price History → PO view + filter/sort** — shipped `774ed7ff` (suppliers/detail.tsx).
- ✅ **GRN arrival DO-parity** — Planning rename + forward jumps (FE+BE) + DO tab layout. Shipped `dc6a880a`.
- ✅ **Price Comparison multi-select + cross-material** — multi-select, A-vs-B table, badge legend, filter+sort. Shipped `e695c3c1`.
- **NEXT after backend lands:** P2 convert UX (Convert-from buttons + line-pick pickers, drop GRN Manual toggle), P3 multi-doc consolidation endpoints, P4 PI→COGS cascade.

- 🔵 **PURCHASING CONVERT-CHAIN ALIGNMENT (the big one, owner directive + 2990 ref)** — owner wants
  Hookka's PO→GRN→PI (+PO→PI) to match 2990: create & convert = SAME page; a top-right **"Convert from
  <upstream>"** button (GRN→From PO, PI→From Goods Receipt/PO) that PRE-FILLS; manual = blank default
  (NO "From PO|Manual" toggle); every add/delete line must cascade to INVENTORY. **High-risk (inventory
  cascade) → investigate→propose→confirm + isolated branch.** Study agent `a9320f47` reading 2990 fe+be
  + Hookka gap → will return a plan. This SUPERSEDES the earlier GRN "Manual (no PO)" toggle.
- ✅ **PI/GRN/PO line-picker dropdown clip FIXED** — MaterialPicker dropdown was absolute → clipped by
  the rounded `overflow-hidden` items-table wrapper (owner: "drop down 还没展开完"). Portaled to <body>
  (fixed pos, scroll/resize tracked). tsc+tests, shipped `1dc8e361`.
- ✅ **Supplier Batch Edit** (task #54 follow-up) — upgraded grid Batch Edit to sofa-combos pattern:
  useConfirm + 4 fields (payment terms / company / status / rating). Agent `cc0e3fa3`, cherry-picked, shipped `2cbade89`.
- ✅ **Supplier Quotation PDF** — found ALREADY built (`generate-supplier-quotation-pdf.ts` + button on
  supplier detail, shared letterhead). Parked item was stale; nothing to do.
- ✅ **Purchasing Phase D — lineage SmartButtons** — new `PurchaseLineageBar` on PO/GRN/PI detail
  (PO→GRN→PI clickable, counts, client-side derived, read-only). Agent `c91834df`, cherry-picked, shipped `2cbade89`.
- ✅ **GRN list: arrival chips fixed + explicit From PO entry** — (1) arrival filter chips were
  misaligned (dot used `<Badge variant=status>` which renders the status TEXT in a 6px dot →
  overflow/overlap); swapped for a plain `getStatusColor(state).hex` dot. (2) Header only showed
  "Create GRN" though create.tsx already defaults to PO mode → added explicit **From PO / Manual
  Receipt (`?manual=1`) / Scan GRN**. tsc clean, shipped `5bcbbcd3`, **verified live** (chips clean,
  3 buttons present). Found via owner screenshot; fixed via NAVIGATION-MAP (Procurement module).

## 2026-06-20

- ✅ **CoE / Dev-Efficiency System built** — the "big plan" ([DEV-EFFICIENCY-SYSTEM.md](DEV-EFFICIENCY-SYSTEM.md)):
  Layer 4 **Navigation** = [NAVIGATION-MAP.md](context-packs/NAVIGATION-MAP.md) (**15 modules = full system
  coverage**, line-range index for ~30 monster files, spot-verified); Layer 5 **Methodology** = [PLAYBOOKS.md](PLAYBOOKS.md)
  (8 procedures); 9 Codex docs tailored; DOCS-INDEX surfaces all. **Still optional:** light docs reorg
  (merge UI-DATA-DOCUMENT-STANDARDS→UI-CONVENTIONS), Data-dictionary/glossary, ERD map, Test-selection matrix.
- ✅ **#3 / GRN read-bug fix** — dual-key read for snake_case cols folded to camelCase by
  `toCamel`. Shipped `cdfcae69`. **VERIFIED LIVE 2026-06-20:** create→read→delete round-trip on
  prod (`PO-2606-006` throwaway) → `materialCode` stored as "VERIFY-CODE-001" and **read back
  correctly** (was "" before the fix), name clean, deleted 200. GRN arrival reads dual-keyed too.
- ✅ **Employees summary stale-on-date FIX** (task #55) — wired all 6 date-bearing tabs
  (handleSummaryDateChange + onDateChange prop on Efficiency/Dept-Labor/Employee-Detail/
  Dept-Performance/Labor-Cost). Done myself via NAVIGATION-MAP (read ~250 lines not 10,951).
  tsc clean, shipped `4157cf88`, verified-live (renders clean). **SWEEP DONE (2026-06-21, CLEAN):**
  audited dashboard-b month switcher, reports, daily-report, analytics, ~10 accounting date-tabs,
  planning — all correctly put the date in the URL/deps → react. **Employees was the only real
  instance.** 2 minor non-same-class notes: reports.tsx "Generate" gate (change-date-forget-to-click
  → stale display, intentional UX); accounting AR cards mount-once (no date picker). **Task #55 DONE.**
- ✅ **Supplier Pricing → Supplier merge** (task #54) — cherry-picked `5064505c` onto main
  ([Suppliers | Price Comparison] tabs in maintenance.tsx; supplier detail [Pricing & SKUs |
  Price History]; nav "Suppliers"→maintenance; `/procurement/pricing` redirects). Reviewed diff:
  ComparisonTab was PORTED from pricing.tsx → **deleted the now-dead pricing.tsx** so there's one
  comparison surface (no drift). tsc clean. Shipped `b3b42b6c`. **TODO left: verify-live.**
- ✅ **Dev Operating Framework + Work Tracker** — this doc set + the 快准省 / review-
  discipline answer + durable tracking cadence. Committed.
- ✅ **Codex docs read + efficiency framework adopted** — read all context-packs +
  LLM-CONTEXT-STRATEGY + AI-DEVELOPMENT-MODES; saved smallest-mode discipline to memory.

## Parked — needs owner one-line confirm (from 2026-06-18 queue)

- 🟡 Supplier inline **Batch Edit** in grid (scope ambiguous).
- 🟡 Supplier **quotation export / print** (scope ambiguous).
- 🟡 Purchasing **Phase D** — document-flow lineage / SmartButtons (deferred).

## 2026-07-03 — Opening-month P&L slice (report-layer) + purchases read ledger

- ✅ **Purchases read the LEDGER** (owner: 「照 C 做,采购改读 ledger」) — P&L raw-material
  PURCHASE lines now come from GL per purchase account; stock stays engine-valued, mapped
  onto the same account rows. Shipped `b092a405`.
- ✅ **Route C ABANDONED before execution** (owner: 「我不想要 ledger 留痕迹」) — no re-post
  with April values, no 22/05 slice JV, no 190 bridge account. Replaced by a REPORT-LAYER
  slice: kv `pnl_opening_prior_cum` (30/04 TB P&L balances, {code: signedSen}) +
  `applyOpeningSlice` in `glWindowSigned` and `/cost-expense-classes`. The opening month
  shows `opening − prior-cum`; earlier months read pnl_historical; ledger keeps exactly ONE
  clean opening entry. `src/lib/opening-slice.ts` (+7 tests, suite 1364 green). Shipped
  `b798847c`, deployed, April TB PUT to prod (20 accounts, RM 125,310.83).
- ✅ **Verified live (sen-exact)**: May purchases 115,981.54 = slice 95,297.58 + real
  post-22/05 GL 20,683.96; May FACTORY OVERHEAD +1,560 (780-0030) + OPEX +1,768
  (900-R002/900-T003) = expense slice 3,328; matrix vs /cost-expense-classes agree
  (119,309.54 both paths); TB untouched (701-0010 cumulative 46,481.42 = opening
  23,038.56 + May real 5,223.60 + Jun 18,219.26).
- Owner-visible effect: Monthly P&L May column now shows the 1–21 May slice on top of real
  post-opening trading; sales opening (debtor v5, still awaiting owner confirm) will land
  in May automatically (April sales = 0, not in the kv).

## 2026-07-03 (later) — Periodic-inventory mode + June-purchase reconciliation + incident

- ⚠️ **INCIDENT (disclosed to owner, zero visible impact)**: intended a dry-run of
  POST /purchase-invoices/backfill-gl-postings but the dry switch is `?dry=1` (query),
  not `{dry:true}` (body) → 46 unposted PIs (RM 58,736.70) actually posted. All 46 are
  dated BEFORE the 22/05 opening → floored out of every report (TB/P&L/aging/GL inquiry
  unchanged, verified to the sen). The nightly cron runs the same call nightly — same
  end state. Found the cron itself has FAILED both nights since shipping (suspect 60s
  curl timeout against the 46-PI backlog); backlog now zero so it should self-heal —
  watch one night.
- ✅ **June purchases reconciled** (owner asked "那么少?"): 103 CONFIRMED + 1 PAID June
  PIs = 187,141.01 = P&L purchase lines 184,954.20 + SST 1,616.81 + R&D 570.00
  (PI-2606-010 maps to 900-R002). 2 DRAFTs (2,427.60) unposted by design. The "small"
  number the owner saw was CONSUMED (BOM under-consumption, no May/June stock takes).
- ✅ **Periodic-inventory mode shipped** (`3a4b92b7`, owner: 「不要用 BOM 算先」): kv
  `rm_valuation_mode = stock_take_only` → RM month-end value = latest stock-take +
  PI purchases since (opening seed before any count); consumption only in counted
  months. Toggle card on Stock Take tab; PUT /rm-valuation-mode (audited); GET
  /stock-take returns mode. Pure stockTakeChainValue in material-cost-fifo.ts (+5
  tests; suite 1369 green). **Prod switched to stock_take_only + verified**: June RM
  consumed 8,353.67 → 5,310.56 (= FEE/SERVICE/unmapped lines GL posts to purchase
  accounts but that never become stock — correct immediate-consumption semantics, not
  BOM). May shows 73,692.84 (opening-slice boundary + hand-keyed pre-opening PI
  attribution) — absorbed once the owner enters the 31/05 count. Until counts exist,
  June COGS is ~0/negative and GP ≈ sales — expected shape, meaningful after counts.
- ✅ **v2 (owner: 「不要我还没 import 就用 BOM 的方式」, `590fbaad`)**: stock_take_only P&L
  chain moved to ACCOUNT level off the GL — month-end value = latest import (complete
  statement; absent groups = 0) + GL purchases since (opening seed before any import).
  Un-imported months show consumed = 0 BY CONSTRUCTION (May 73,692.84 / June 5,310.56
  residuals → 0.00, verified live; chain continuity 107,268.13 → 223,249.67 → 408,203.87).
  Import month absorbs true consumption. glWindowSigned gained a per-request memo
  (DocDateCtx.glMemo). Group-level PI chain still serves Stock Summary + closing-stock GL
  posting. Until imports exist COGS is FG/WIP/labour only (GP > sales) — owner-accepted
  interim shape.

## 2026-07-12 (morning) — Agent 再进化 (owner ask)
- [x] 答概念问题：是否全部基于 LLM / 是否都会自我进化+懂数据 (诚实盘点)
- [x] Console 补齐全部 blueprint Agent ID (10 个卡片, 未建=COMING SOON)
- [x] 共用 LLM 大脑抽层 (agent-brain.ts, production-brief 重构复用)
- [x] Delivery 进化: LLM focus + console pause/run-now 接线 + 学习环→跨 Agent 调参提案 (实际州运输天数 → cs-agent transitDays)
- [x] CS 进化: promise log 表 + 承诺达成率 KPI 基础
- [ ] gates → merge main → deploy → prod 验证 → 文档/memory

- [x] 自主排班心跳 (owner 裁定: 节奏 Agent 自己定) — agent-scheduler.ts + heartbeat 30min + 理由留痕
