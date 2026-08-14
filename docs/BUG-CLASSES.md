# Recurring bug classes — the index that makes P5 executable

> **Last verified: 2026-08-14** — restamped on branch `fix/dashboard-tiles`, which
> **closes C15 row 33 and adds rows 42–44** (BUG-2026-08-13-144/-145/-146/-147: the MRP
> shortage that ignored every open PO plus its invented MOQ / lead time, `/production`
> Overview's 0-of-0 on a cold landing, and `/production/wip-times`' four tiles — including
> the Missing-BOM tile that could not observe the worst case it exists to count).
>
> **One correction to a prior claim, verified in source.** The audit note on row 33 said
> `|| 50` "also overrides a genuine stored MOQ of 0". It cannot: `supplier_material_bindings`
> declares `moq INTEGER NOT NULL DEFAULT 0` and `leadTimeDays INTEGER NOT NULL DEFAULT 0`
> (`migrations/0001_init.sql:273,275`), so **0 is what an untouched row holds** and is
> indistinguishable from never-filled-in. 0 is therefore UNMEASURED, not a value — which is
> the opposite of the usual corollary and worth stating: *"`0` is a claim, not a blank"*
> cuts both ways. A column whose NOT NULL DEFAULT is 0 cannot make that claim at all.
>
> **A second write-side instance found and NOT fixed** (reported in
> `docs/DASHBOARD-DATA-AUDIT.md` Part 4): `POST /api/supplier-materials` persists
> `Number(body.leadTimeDays) || 7` and `Number(body.moq) || 1`
> (`supplier-materials.ts:206,208`) — the same class on the write path, where it is worse,
> because a read-side fix cannot undo a literal already in the table. Left as one change
> with an owner decision about what a blank field means; two agents editing one constant is
> how a half-fix ships.
> Enforced by `tests/planning-production-tile-truthfulness.test.mjs`; all 23 reversions
> proved RED with bytes-changed-on-disk asserted first. Suite at that point:
> 4,139 tests / 0 fail.

> **Last verified: 2026-08-14** — restamped on branch
> **Last verified: 2026-08-14 on branch `docs/docs-vs-code-audit`** (prose audit vs source).
> **C20 row 3 is CLOSED, not open.** It read *"⬜ open, and it is the NEXT one"* about
> `job_cards.actual_minutes` while `docs/context-packs/HOOKKA-GOTCHAS.md` — corrected by the
> owner the same day — says that column equalling `est_minutes` is standard costing working as
> designed and *"Do not 'fix' it."* Two required-reading docs, opposite orders, one column.
> A scope box now caps the class so it cannot re-swallow the costing model. Verified separately
> in this pass and **still accurate**: every `tests/*.test.mjs` path this file cites exists (0
> missing); C15 row 34 (`kpi_periods` has no writer — `who-writes.mjs` finds only the
> `CREATE TABLE` in `ensure-kpi-tables.ts:40`); C15 row 31 (all three
> `INSERT INTO attendance_records` sites bind the literal `'PRESENT'` and nothing writes
> `'ABSENT'`). See `docs/DOCS-VS-CODE-AUDIT.md` rows D12–D13.
> **Last verified: 2026-08-14** — restamped on branch `fix/first-one-wins-sweep`:
> adds **C21 — first-one-wins: taking `[0]` when several rows could answer**, the class
> BUG-2026-07-17-001 named and never got an index entry. 15 rows: five FIXED
> (BUG-2026-08-13-144…147, incl. the three-way match pricing a receipt line against another
> ORDER's line at the same position), two left OPEN with reasons, and eight classified
> BENIGN **with the reason**, so the next sweep does not re-litigate them. Enforced by
> `tests/first-one-wins-refusal.test.mjs`; all 23 mutations proved RED with bytes-changed
> asserted first, and that run caught one **blind** assertion (a bare-substring match on
> `await ensurePoItemLineNo(...)` that stayed green with the call commented out). Suite at
> that point: 4,139 tests / 0 fail. Prod blast radius is **UNMEASURED** — no DB credential
> on that branch; `scripts/check-first-one-wins-blast-radius.mjs` is the measurement.
>
> **Previously verified: 2026-08-14** — restamped on branch
> `fix/on-time-delivery-and-decisions`: **C15 gains rows 39–41** (the Hookka Report's
> on-time delivery %, the Daily Report's inability to say "I could not check", and the
> customer-concentration denominator) and a **seventh corollary** — audit the DENOMINATOR
> and the POPULATION, not only the numerator; ask what CANNOT appear in a figure and
> whether its absence flatters us. Enforced by `tests/on-time-delivery.test.mjs`,
> `tests/compliance-unknown-outcome.test.mjs` and the concentration block in
> `tests/dashboard-truthfulness.test.mjs`; all 31 assertions proved RED by reintroducing
> the bug with the file's bytes asserted changed on disk first. Suite at that point:
> 4,078 tests / 0 fail (post-merge with `main`).
>
> **Previously verified: 2026-08-14** — restamped on branch `feat/leave-entitlement`:
> **C4 gains row 4** (leave entitlement — a POLICY, not a price list, with the office on
> 8 annual days and the worker's phone on 14, invisible because the two numbers never
> share a screen). BUG-2026-08-13-130…133; enforced by `tests/leave-entitlement.test.mjs`.
> All 21 mutations proved RED with bytes-changed asserted first, and that run caught
> **four blind guards** — including a single-site `computeLeaveBalance(` check that stayed
> green while one of its two required call sites was deleted (the same shape C15 records),
> and two substring matches satisfied by a longer string (`"/api/leaves/balancesXX"`,
> `"public_holidays_v2"`). **A source guard that matches a substring is not a guard: anchor
> it to a complete quoted string.** Suite at that point: 4,048 tests / 0 fail.
>
> **Previously verified: 2026-08-14** — restamped on branch `feat/job-card-completed-at`: adds
> **C20 (a measurement thrown away at the moment of capture)**, the class UPSTREAM of C15.
> `job_cards.completed_date` was written as `nowIso.split("T")[0]` by 14 sites while the full
> instant sat in a local variable one line above, so no job's duration was ever derivable and
> every "production time" figure downstream HAD to be an estimate — `production_time_minutes =
> est_minutes` on all 36,796 rows. BUG-2026-08-13-120 adds `job_cards.completed_at` beside it
> (additive; `completed_date` untouched) and enforces "the pair travels in one statement" across
> all of `src/api` via `tests/job-card-completed-at.test.mjs`. Historical rows stay NULL on
> purpose — backfilling them would BE C15. Suite at that point: 3,998 tests / 0 fail; all 11
> assertions proved RED by mutation.
>
> **Last verified: 2026-08-14** — restamped on branch `docs/dashboard-data-audit`:
> the system-wide dashboard audit (`docs/DASHBOARD-DATA-AUDIT.md`) adds **C15 rows
> 28–38** and a **sixth corollary** (a class guard that grows by matching the first
> instance's WORDS does not grow — the Command Center's false sentence was "All
> clear", not "not found", so it was never in the map). Rows 28–30 are fixed and
> guarded by `tests/dashboard-truthfulness.test.mjs`; 31–38 are open and each is
> traced to file:line in the audit doc.
>
> **Last verified: 2026-08-14** — restamped on branch `fix/efficiency-fabrication`:
> **C15 gains row 28** (BUG-2026-08-13-103) — `attendance_records.production_time_minutes`
> was `working_minutes × 0.85` on every row ever written, and the `efficiencyPct` and
> `deptBreakdown` published beside it were derived from that constant. Prod, August 2026:
> 180,928 / 212,850 = 0.85005. It adds a **sixth corollary** (below the table): *a metric
> can be honest arithmetic on a dishonest input — audit the DISTRIBUTION of the source
> column, not the formula.* Three writers carried the same ratio, not one, and the guard
> that pinned the surviving real metric was **single-site** — it passed while the OTHER
> copy of the formula had its denominator replaced with a literal. Enforced by
> `tests/no-fabricated-attendance-production-time.test.mjs`; all 13 assertions proved RED
> by reintroducing the bug (bytes-changed-on-disk asserted before each run).
>
> **Previously verified: 2026-08-14** — restamped on branch `fix/security-posture`: **C16 gains
> row 7** (a projection narrowed by PERMISSION rather than payload size — the more dangerous
> variant, because the author cannot reproduce what the affected role sees) with its
> OMIT-do-not-BLANK corollary, and **C12 gains rows 12 and 13** (the whole `organisations.ts`
> router; the `send-quote` recipient allow-list). Suite at that point: 3,908 tests / 0 fail.
>
> **Previously verified 2026-08-14** — classes C17 (a file the search tool refuses to read) and C18
> **Last verified: 2026-08-14** — class **C19 (a typed money string read by `parseFloat`,
> which stops at the thousands separator)** added on branch `fix/money-input-parsing`
> (BUG-2026-08-13-095): 119 money inputs on the accounting page, not one `type="number"`,
> and a fixed asset typed `12,000` created at RM 12.00. Enforced by
> `tests/money-input-parsing.test.mjs`; every assertion proved RED by reintroducing the
> bug, and one of them was BLIND on the first draft — the "the guard must `return`" check
> searched a fixed 400-character window and passed with the `return` deleted.
>
> Classes C17 (a file the search tool refuses to read) and C18
> (a per-party document and its all-party twin, only one maintained) added from the accounting
> audit. Every one of the source/test paths this file cites
> exists (checked mechanically against the tree), and `npm test` is green
> (3,868 tests / 0 fail).
>
> *(Two separate branches each appended a stamp paragraph here on 2026-08-13, leaving the
> header with two "Last verified" lines and a superseded test count. Collapsed into this
> one stamp; no claim was dropped.)*
>
> **C1 was re-opened and extended the same day** (BUG-2026-08-13-040): the class had a
> second axis nobody had counted — the DOCUMENT TYPE — and the consignment-order write
> path plus the sofa-combo recompute shared by both order types were still carrying it.
>
> **Updated 2026-08-13 by the thin-module sweep** (accounting · customers ·
> quality-warehouse · rnd — see [`AUDIT-THIN-MODULES.md`](AUDIT-THIN-MODULES.md)):
> C14 gains row 11 (`qc-pending`, ~80M comparisons — the sibling row 5 missed the day
> before), C12 gains rows 8–11, and C15 gains rows 18–22. One correction to an existing
> claim: the C14 test's annotation calling `qc-inspections.ts` *"the largest in the class"*
> was **wrong** and has been fixed in place.
>
> **Updated 2026-08-13 (BUG-2026-08-13-071):** C15 gains **row 23**
> (`/consignment/return`), a fifth enforcing test file, and a fourth corollary —
> a row that mixes real and invented columns is *more* dangerous, not less.
> Suite at that point: 3,866 tests / 0 fail.
>
> **Also 2026-08-13, branch `fix/accounting-audit`** (the first read-through of
> `src/api/routes/accounting.ts` since the NUL byte that had made it invisible to `grep`
> was removed): adds **C17 — a file the search tool refuses to read** (five more source
> files still carried a raw NUL, two of them on the money path) and **C18 — a per-party
> document and its all-party twin, only one of them maintained**. **C12 row 11 closes** —
> the comment claiming `journal_entries` has no `orgId` column was false and is gone.
> Suite at that point: 3,857 tests / 0 fail.
> **Also 2026-08-13, branch `fix/accounting-ui-audit`:** the FIRST audit of
> `src/pages/accounting/index.tsx` (11k lines, ~25 tabs, never opened before) added
> **C15 rows 25–27** and a **fifth corollary** — an ACTION and a VERIFICATION are figures
> too. Five defects, guarded by `tests/accounting-ui-truthfulness.test.mjs`
> (BUG-2026-08-13-090…094); every assertion proved RED by reintroducing the bug, and one
> of them passed on the first draft because `[^)]*` could not cross the `)` in a reducer's
> own parameter list. Note also that the naive `/\/\*[\s\S]*?\*\//g` comment-stripper
> the older guard files use **silently ate ~200 lines** of that page — an `accept` attribute
> ending in a star-slash-star wildcard reads as a block-comment opener. Anchor block
> comments to the start of a line.
>
> **Also 2026-08-13, branch `fix/stock-grn-org-filter`:** added **C16 — a field the
> projection drops and a consumer still reads** (the class behind BUG-2026-08-13-050,
> with the four open siblings enumerated), and **C15 row 24** (the Balance Sheet's
> per-company card printing RM 0.00 for all four companies, BUG-2026-08-13-051).

`PLAYBOOKS.md` **P5** says: *"Fix all instances of the same class, not just the flagged one."*

That instruction is unusable without a list of the instances. `BUG-HISTORY.md` is ordered by
**date**, so "the same class" only exists in whoever's memory. The result, measured:

| class | times fixed | each fix repaired |
|---|---|---|
| server trusts a client-supplied price | 3 | only the one column that had been noticed |
| write path skips the dept-sheet cache wipe | 3 | only the one file someone was looking at |
| fallback to the customer's DEFAULT hub | 3 | only the one document that printed wrong |
| a child array scanned once per parent row (C14) | 3 | only the one list endpoint that was slow that week — the third miss was the hottest path in the app |
| a dead request rendered as an answer (C15) | 2 so far | the reports pass (2026-08-13) fixed 5 tabs and left the same conflation on 19 detail/edit screens, because the shared primitive was swallowing the abort |

The 2026-07-17 fix header literally reads *"This is the same bug class as the 2026-07-14
totalHeightPriceSen fix"* — the author saw the class, and still fixed one column. The sibling
fields were on adjacent lines.

**This file is the missing list.** When you fix anything below, you are not done until every
row in that class is ✅ or has a written reason.

> **Adding a class:** you have earned one the moment you write "same bug as…" in a commit
> message or a code comment. Add the section then, not later.

---

## C1 — The server stores whatever the client posted

**Shape.** A write path does `const x = Number(item.x) || 0`. One client computes `x` and
sends it; another does not. The order looks fine on the screen that computes it and is silently
wrong from every other entry point.

**Why it keeps happening.** The components sit on adjacent lines, so a fix to one reads as
complete. Both scan-PO clients POST `/api/sales-orders` **directly**, never through the form.

**The rule.** The server derives the value when the client OMITS the field, and trusts any
supplied number — including a deliberate `0`. Never guess a price for something not in the
owner's list.

| # | component | fixed | cost | resolver |
|---|---|---|---|---|
| 1 | `totalHeightPriceSen` | 2026-07-14 | — | client-supplied (no stored height to derive from) |
| 2 | `specialOrderPriceSen` | 2026-07-17 | RM 8,060 / 66 SOs | `resolveSpecialOrderPriceSen` |
| 3 | `divanPriceSen` | 2026-07-22 | RM 9,895 | `resolveHeightPriceSen` |
| 4 | `legPriceSen` | 2026-07-22 | RM 2,560 | `resolveHeightPriceSen` |
| 5 | `basePriceSen` | n/a — correct by design | — | customer price → product price (`resolveLineBasePriceSen`) |

**The class has a SECOND axis: the document type.** Rows 1–4 were all fixed in
`sales-orders.ts`, and this test read only that file — so `consignment-orders.ts`, a
structural clone writing the same columns for the same customers through the same
screens, kept `Number(it.X) || 0` on three of them and left the fourth out of its INSERT
column list entirely. A CO therefore saved for LESS than the operator approved on screen,
for as long as COs have existed.

| # | site | fixed | what it was |
|---|---|---|---|
| a | `sales-orders.ts` POST + PUT | 2026-07-14 … 07-23 | rows 1–4 above |
| b | `consignment-orders.ts` POST + PUT | ✅ 2026-08-13 (BUG-2026-08-13-040) | three components on trust; `totalHeightPriceSen` computed and then **omitted from the INSERT**, so the value was parsed and thrown away |
| c | `sofa-combo-pass.ts` — the recompute **shared by both** | ✅ 2026-08-13 | rewrote a renegotiated line's unit price from FOUR components (losing total height) and its line total from a bare `unit × qty` (refunding the operator's discount to us). One function, both document types |
| d | invoice / DO / CN write paths | ⬜ unswept | they copy components from an order line rather than resolving them; check before adding a component-computing path there |

**Enforced by** `tests/price-component-class.test.mjs` — it iterates DOCUMENT × COMPONENT
and fails if any component returns to `Number(x.X) || 0`, if a resolver is missing from
either the POST or the PUT loop, **if an item INSERT's column list omits a component**
(the shape that made row b invisible), or if the shared combo recompute drops a component
or the discount. Behaviour is proved separately by
`tests/consignment-total-height-surcharge.test.mjs` (real handlers, stored value asserted
equal to the screen's arithmetic to the sen) and
`tests/sofa-combo-pass-components.test.mjs`.

**Adding a 6th component?** Add it to `COMPONENTS` in that test first. **Adding a document
type that stores a priced line?** Add it to `DOCUMENTS`. Either fails until wired.

---

## C2 — A write that the dept sheets never hear about

**Shape.** Something writes `production_orders`, but the operator's screen reads a
cache-aside snapshot behind a KV body. Neither layer notices the write, so the shop floor keeps
seeing the old state until a TTL expires.

**Both layers, always.** Wiping only the snapshot leaves a warm KV body serving `X-Cache: HIT`;
bumping only the KV version lets the snapshot re-serve stale. `invalidateProductionListCaches`
in `src/api/lib/po-list-cache.ts` does both — call it, don't hand-roll.

**Do not trust the freshness probe.** It compares `built_from` against `MAX(updated_at)` across
mixed TEXT/TIMESTAMP columns and is documented in `snapshot.ts` as unreliable ("the probe
lies"). Wipe explicitly.

| # | writer | fixed | symptom that exposed it |
|---|---|---|---|
| 1 | scan completion | 2026-06-06 | Fab Cut stuck PENDING while the card was COMPLETED |
| 2 | `applyPoUpdate` (dept-cell edit) | 2026-06-24 | a PIC / completion-date edit invisible for a full day |
| 3 | SO status cascade | 2026-07-22 | an SO went ON_HOLD; the Fab Sew sheet showed no hold |
| 4 | CO status cascade | 2026-07-22 | same, consignment side |
| 5 | `admin.ts` rebuild-all-pos | 2026-07-23 | found by the class test, not by an incident |
| 6 | `import-completion.ts` | 2026-07-23 | ditto |
| 7 | `service-orders.ts` cascade | 2026-07-23 | ditto |
| 8 | `sheets-sync.ts` webhook | 2026-07-23 | ditto |

Rows 5–8 are the point of this file: the 07-22 fix repaired 3 and 4 and stopped, because
nothing counted the rest.

**Enforced by** `tests/production-write-invalidation-class.test.mjs` — enumerates the writers
from disk. A new writer fails the test until wired, or is listed in `EXEMPT` with a reason.

---

## C3 — Falling back to the customer's DEFAULT hub

**Shape.** Code needs a hub, the specific one is unavailable on that path, so it takes
`ORDER BY isDefault DESC LIMIT 1`. Every Houzs document silently becomes "Houzs KL".

**The rule.** Derive the hub from the document's own contents. A consolidated DO has no single
`salesOrderId`, but its LINES all carry one — and the composition guard already proves they
share one hub, so the lookup is safe.

| # | site | fixed | symptom |
|---|---|---|---|
| 1 | FG sticker `customerHub` | 2026-06-05 | every box label printed "Houzs KL", incl. Sabah / Sarawak |
| 2 | service-order DO | 2026-06-11 | service DO printed a blank / wrong Deliver-To |
| 3 | SO create hub resolution | — | correct: `body.hubId` → customer default only when absent |
| 4 | **consolidated DO header** (`delivery-orders.ts`) | ✅ 2026-07-23 | 15 post-guard DOs whose lines are 100% PG/SRW/SBH were labelled "Houzs KL" |

Row 4 is now derived from the SO lines (DISTINCT hub across the DO's SOs, accepted only when
there is exactly one — the composition guard's invariant), before the default-hub fallback.
The 15 already-shipped DOs were deliberately left as-is per the owner: **fix forward, do not
relabel shipped documents**. The printed address was always correct; only the header label was
wrong, so the damage was to reporting (delivery planning, 3PL state rates), not deliveries.
Pinned by `tests/do-consolidated-hub.test.mjs`.

**Not the same as** a mixed-hub DO. Different hubs on one DO is blocked by the composition
guard (BUG-2026-06-11-008) and that guard works — zero mixed DOs since it landed.

---

## C4 — More than one copy of the same price list

**Shape.** The same prices exist in several places; only one is read; the others are never
updated and quietly rot. Anyone (human or agent) who reads the wrong copy prices from a dead
list.

| # | copy | read by | state |
|---|---|---|---|
| 1 | `kv_config variants-config.specials` / `.divanHeights` / `.legHeights` | **everything** | ✅ the source of truth |
| 2 | `src/lib/pricing-options.ts` | the silent fallback when the config fails to load | ✅ realigned 2026-07-23 — had drifted a whole price increase behind |
| 3 | `variants-config.bedframeSpecialOrders` / `.sofaSpecialOrders` | **nothing** | ✅ deleted 2026-07-22; the seeder stopped writing them 2026-07-23 |
| 4 | **leave entitlement** — `LEAVE_ENTITLEMENTS = {ANNUAL:8, MEDICAL:14}` (`employees.tsx`) vs `annualEntitlement = 14` / `medicalEntitlement = 14` (`worker.ts`) | the office screen read one, the worker's phone read the other | ✅ 2026-08-14 (BUG-2026-08-13-133) — both now call `src/lib/leave-entitlement.ts`; entitlement moved into `workers.*_leave_entitlement_days` |

**Row 4 is the class's cheapest lesson and its loudest.** It was not a price list, it
was a POLICY, and the two copies disagreed on the headline number — 14 annual days on
the worker's phone against 8 in the office — for as long as the worker endpoint has
existed. Nobody reported it because the two numbers are never on one screen: the
worker sees theirs, the approver sees theirs, and each looks entirely reasonable
alone. That is the signature of this class, and it is why the fix is a shared module
rather than "make the second literal say 8".

Note also what the class test must check. The first draft of the guard asserted
`/computeLeaveBalance\s*\(/` over the whole file — a **single-site** check that stayed
green when one of the two required calls was deleted, because the other still matched.
A class guard has to name each site it is protecting; the same trap is recorded on C15.

Copy 3 cost real money: the 2026-07-17 backfill priced from it and had to be topped up RM 30
after read-back. It survived because **one script planted it while another weeded it**
(`seed-from-production-sheet.ts` wrote it; `sync-maintenance-config.ts` deleted it) — whichever
ran last won. Deleting the data was not enough; the producer had to stop.

**Enforced by** the drift assertion in `tests/price-component-class.test.mjs`. It compares the
static catalog against the live values. If the owner changes a price in Settings, update
`pricing-options.ts` and that test's expectations together.

---

## C5 — A leg whose identity carries a suffix, read by exact match

**Shape.** Correction/restate legs reuse their document's identity **plus a suffix** —
sourceType `invoice_restate_post:<stamp>`, sourceId `pi-xxx:edit-<stamp>`. Any reader that
matches the RAW value misses them, and the miss is silent: the leg simply falls into whatever
the fallback is (postedAt dating, "no legs to reverse", "nothing to hide").

| # | reader | matched on | state |
|---|---|---|---|
| 1 | sourceTYPE suffixes everywhere (`stripLegSuffix`) | stripped | ✅ handled since the restate pattern; `tests/doc-date.test.mjs` |
| 2 | `ap-recon.ts` doc attribution | strips `:edit-` | ✅ born correct |
| 3 | `loadDocDateResolver` (dates every leg for /gl, P&L windows, **the opening floor**) | raw sourceId → postedAt fallback | ✅ fixed 2026-07-24 (BUG-2026-07-24-001: two May PI tax-edits dated as July, escaped the floor, +407.04 drift) |
| 4 | `applyLifecycle` reversal SELECT + hidden UPDATEs | raw sourceId | ⬜ latent — unreachable today (PIs don't use lifecycle; PI delete is DRAFT-only = no legs). Warning comment in place; widen the matches if a `:<tag>`-legged doc type is ever wired in |
| 5 | supplier-payment UNVOID leg un-hiding | exact `supplier_payment` sourceType | ✅ fixed 2026-07-24 (BUG-2026-07-24-002: an edited payment's live legs are `restate_post:<stamp>` — unvoid resurrected the stale pre-edit base legs; now picks `latestRestatePostType`) |

**Enforced by** the `stripSourceIdSuffix` cases in `tests/doc-date.test.mjs`. When adding a NEW
suffixed identity (a second `:<tag>` writer), grep every `sourceId = ?` / `.get(sourceId)`
against ledger legs first.

---

## C6 — One day, charged twice

**Shape.** A worker-day's pay is reduced by two INDEPENDENT mechanisms that don't know about
each other:

- **absence** — `labor-engine.ts` calls a day absent when it has **no logged hours**, and docks
  the full contractual day (`salary ÷ workingDaysPerMonth`);
- **hour docks** — `payroll_hour_deductions` rows, valued at the hourly rate.

Nothing ever said they were mutually exclusive, so a day with zero logged hours could take BOTH.
The absence is the bigger charge and the dock rides on top, invisibly — the payroll screen shows
"Absent 18d" and "Late/short 9h" as separate lines and neither looks wrong on its own.

The trigger is always a punch the shift maths can't read as a working day: someone who forgot the
morning punch and does both at knock-off (18:01 in / 18:02 out) produces `regularWorkMin = 0`,
which the dock path read as "short the whole 9h day".

| # | writer | state |
|---|---|---|
| 1 | live punch-out (`POST /worker/clock` → `maybeApplyAutoPunchDock`) | ✅ covered by the core guard. NOTE the call order: `autofillWorkingHoursFromPunch` MUST run first, or the guard sees a day with no hours yet and skips every legitimate dock |
| 2 | monthly settle (`POST /payroll-hour-deductions/settle-period`) | ✅ covered by the core guard |
| 3 | office re-apply-from-punch (`POST /payroll-hour-deductions/apply-punch`) | ✅ covered by the core guard |
| 4 | owner's MANUAL dock (`POST /payroll-hour-deductions`) | ⬜ deliberately NOT guarded — an owner docking an absent day is their decision, and the `manual-exists` guard already stops auto from touching it |
| 5 | the shift maths itself (`computePunchShortfallHours`) | ✅ a window yielding no payable minutes at all is a BROKEN PUNCH, not a zero-hour day → `valid: false`, no evidence, no dock |

**The rule.** *A day with zero logged working hours is an ABSENCE — already charged in full — and
must never also carry an automatic hour dock.* It is enforced in ONE place,
`maybeApplyAutoDayDock` (reason `absent-day`), because every automatic path funnels through it;
it also DELETES any stale AUTO row it finds, so old damage self-heals on the next settle.

**Enforced by** `tests/punch-degenerate-window.test.mjs`. The mock DBs in
`tests/auto-attendance-deduct.test.mjs` and `tests/settle-period-punch.test.mjs` now return a
day's logged hours (default 8) — if you add a dock test and it unexpectedly returns
`absent-day`, that is the guard, not a bug.

**When adding a new deduction mechanism**, ask first: can it land on a day the absence rule
already charges? If yes, route it through `maybeApplyAutoDayDock` rather than writing
`payroll_hour_deductions` directly.

---

## C7 — Two segments of one grid sharing a sticky filter

**Shape.** `DataGrid` persists column value-filters under
`datagrid-filters-<gridId>-<valueFilterKey>-<user>`, and seeds a column's
selection from the values **present in the data it is currently showing**
(`defaultExcludedValues` effect, `data-grid.tsx`). If two segments of the same
page share one storage key, a set seeded while looking at segment A contains
none of segment B's values — so switching to B hides every row while the footer
cheerfully reports `0 of N records · 1 filter active`.

It reads as data loss, not as a filter, which is why it gets re-reported.

**Instances**

| Date | Where | Segmenting state that was missing from the key |
|---|---|---|
| 2026-05-16 | Sales Orders | the Status dropdown → fix added `filterStatus` |
| 2026-08-01 | Sales Orders **again** | the Draft/Confirmed `tab` — never covered by the first fix. Owner: 「包裹为什么by default是kosong的」 |

The repeat is the point: the 2026-05-16 fix repaired the instance in front of
the author and left the sibling state alone.

**The rule.** *Every* state that segments the rows must appear in either
`gridId` or `valueFilterKey`. Adding a new tab / dept / mode selector to a page
that already has a grid means extending that key in the same commit.

**Already-safe siblings** (checked 2026-08-01, pinned by
`tests/grid-filter-session-class.test.mjs`):
* Production — bakes the department into `gridId`
  (`production-dept-<code>`), so each department has its own key.
* Service Cases — `statusFilter` is its only segment and it *is* the key.

**Also worth knowing.** A default exclusion that cannot apply to a segment
should not be sent at all: on the Draft tab every row is already `DRAFT`, so
seeding a Status exclusion there can only narrow a list that is exactly what was
asked for. That was the other half of the blank tab.

## C8 — The D1 integer idiom, bound to a real Postgres BOOLEAN

**Shape.** `.bind(flag ? 1 : 0)` against a column whose type is `boolean`.
`postgres.js` maps **every value that is not a JS boolean** to `FALSE`:

| bound | stored |
|---|---|
| `true` (boolean) | `true` |
| `false` (boolean) | `false` |
| `1` (number) | **`false`** |
| `0` (number) | `false` |
| `"1"` / `"true"` (string) | **`false`** |

No error. No 500. HTTP 200, success toast, and the value on screen is not the
value in the database. That is the whole danger: every other write bug in this
file announces itself somewhere. This one does not.

**Why it keeps happening.** `flag ? 1 : 0` is **correct** for most of this
codebase. It came from Cloudflare D1 (SQLite), where a boolean *is* the integer
0/1, and the great majority of flag columns here really are `INTEGER`. Only
**ten** columns in 267 tables were created as an actual `BOOLEAN`. On those ten,
and nowhere else, the ordinary idiom silently writes false. `tsc` cannot see it
— the SQL is a string — and no test in the suite executes a real INSERT.

**Instances**

| Date | Where | Effect |
|---|---|---|
| 2026-08-02 | `workers.is_outsource` — `merged.isOutsource ? 1 : 0` (`routes/workers.ts`) | Ticking "Outsourced" never stuck. `pay_mode` and `daily_rate_sen` in the SAME statement saved fine, so it read as a cache bug. Owner: 「我明明设置了这个人是 outsource…他又没有 save 成功」 |
| 2026-08-02 | `sales_orders.is_service_order` — bare `0` (`lib/intercompany-mirror-create.ts`) | Latent. `0` lands on `false`, which is the intended value, so nothing was visibly wrong — but only by luck. |

**The rule.** A column of type `boolean` is bound a **JS boolean**. Never
`? 1 : 0`, never `Number(...)`, never a string.

**Covered by** `tests/boolean-column-binds.test.mjs`, which maps `.bind()`
arguments positionally onto the columns of each INSERT/UPDATE and fails on a
non-boolean bound to any column in `tests/db-boolean-columns.json`. That fixture
is regenerated from production by `scripts/refresh-db-schema-fixture.mjs` —
**re-run it after any migration that adds a boolean column**, or the new column
is unguarded.

> The first version of that test counted only the `?` in `SET` and not the one
> in `WHERE id = ?`. The counts disagreed by one, the statement was skipped, and
> the test passed while the bug was still in the file. It was caught by putting
> the bug back and checking the test went red. Do that; a guard nobody has seen
> fail is not a guard.

**The other nine boolean columns, checked 2026-08-02 and safe:**
`workers.{epf,socso,eis,pcb}_enabled` (real booleans on both INSERT and UPDATE),
`worker_pins.must_reset` (SQL literal `false`), `announcements.is_active`
(`? true : false`), `organisations.is_default` (`=== true ? true : false`),
`rd_team_members.active` (real boolean).

## C9 — A runtime migration memoised as a PROMISE

**Shape.** Migrations are inert on deploy here, so a column reaches production
only through an `ALTER TABLE … IF NOT EXISTS` awaited before the first write.
Every one of those was memoised like this:

```ts
let _mig: Promise<void> | null = null;
export function ensureX(db) {
  if (_mig) return _mig;          // a REJECTED promise is still a promise
  _mig = (async () => { … })();
  return _mig;
}
```

Two defects share that one shape:

1. **A failed round is remembered as done.** One transient DDL blip on the first
   write after an isolate boots leaves the column unapplied and never retried
   for that isolate's life. Every later write fails on a missing column and
   nothing says why. Worse where the body did `.catch(() => undefined)`: the
   memo *resolves*, so failure is recorded as success.
2. **A pending promise holds its creator's socket.** `db-pg.ts` forbids sharing
   that across requests in capitals. A cache change doing exactly this took
   Sales Orders down on 2026-08-02.

**Why it keeps happening.** The shape reads as an obvious optimisation, and it
is correct for anything idempotent that cannot fail. It is only wrong because
this is the *load-bearing* path for schema.

**Instances**

| Date | What | Outcome |
|---|---|---|
| 2026-08-02 (am) | #222 converted 26 sites to `runSelfApply` | Half a fix. The helper throws "so the caller's memo can be cleared" — and 38 callers cleared nothing, so the retry it enables never happened. |
| 2026-08-02 (pm) | The 38 remaining callers | 32 by codemod, 6 by hand (they swallowed errors inline). Two of the six guard *unique indexes* that win a concurrent-create race — an isolate that remembered a failed `CREATE INDEX` as done is exactly the one where two documents get the same number. |
| 2026-08-04 | `ensureCustomerOemColumn` + `ensureCustomerGroupColumn` (`customers.ts`), `ensureCustomerStageColumns` (`customer-stage.ts`) | A THIRD variant the sweep produced: promise→boolean, but the setter was placed PAST the `catch`, so the boolean is set true even when the `ALTER` threw. All three feed columns in the customer PUT `UPDATE` (`oem_marking`, `group_org_code`, `customer_stage`, `salesperson_user_id`); one poisoned isolate 500s the whole save — the reported "OEM marking / phone / name won't save". Fixed by moving each setter INSIDE its try, after `.run()` (matching the correct `ensureCustomerCompanyColumn` next door). Behavioural cover: `tests/customer-stage-self-apply-retry.test.mjs` (the generic `self-apply-memo-is-boolean` test passes this variant — an `await` does precede the setter). |

**The rule.** Memoise a **boolean**, set only after the statement lands
(`src/api/lib/payment-columns.ts`), or use `memoizeSelfApply`, which clears the
memo on failure for you. Never cache the promise itself.

**Covered by** `tests/self-apply-memo-is-boolean.test.mjs`.

> Both halves of that test were proved by putting the bug back. The
> premature-flag half did **not** fire at first: it decided "is this a DDL
> guard?" over the window between the declaration and the setter — the exact
> window the bug empties — so it skipped the case it was written for. An earlier
> draft also flagged 16 ordinary local booleans (`inQuotes`, `hasMore`) as
> migration bugs; a test that cries wolf gets muted, and a muted test protects
> nothing. Scope narrowly, then watch it fail.

## C10 — One quantity, two ceilings — and only one branch is checked

**Shape.** A quantity can be drawn down through more than one route (invoice a PO directly, or
invoice the receipt raised against it). Each route grew its OWN ceiling, measured against its
OWN counter. Whichever route was written second is capped only by what IT can see, so the
quantity is spendable once per route. It is invisible from either side: each guard fires
correctly for the case its author had in mind, and the totals only disagree when you add them
up. Worse, these holes are usually **one-directional** — the route whose counter the other one
happens to read is caught, so the pair looks guarded under half the test orders you'd try.

| # | quantity | routes | state |
|---|---|---|---|
| 1 | PO line, invoiced | PI create off a PO / PI create off a GRN | ✅ fixed 2026-08-07 (BUG-2026-08-07-003 — 100 billed off the PO then 100 more off its GRN = 200 payable on a 100 PO. GRN→PO order was already caught, because the PO ceiling reads GRN-sourced lines through `COALESCE(pii.po_id, pi.purchaseOrderId)`) |
| 2 | PO line, invoiced | PI **re-line** (PUT items) | ✅ fixed 2026-08-07 — same hole with one more step: raise the invoice for 1, edit it to 100. Now shares the helper, with the edited PI excluded from its own already-invoiced total |
| 3 | GRN line, invoiced (`grn_items.invoiced_qty`) | PI create / PI re-line / PI delete / PI cancel / GRN un-post | ✅ one counter, incremented and restored through the shared `convert-chain.ts` helpers |
| 4 | PO line, received (`purchase_order_items.receivedQty`) | GRN post-on-create / GRN post-on-PUT | ✅ both go through `cascadePOStatusAfterGRNPost`; reversal through `restorePOReceivedQtyForGRN` |

**The rule.** One quantity gets ONE ceiling function, called by every route that spends it —
not one guard per route. When you add a second way to draw something down, the question is not
"does my branch check?" but "which counter does the OTHER branch read, and would it see mine?"
Two things make the shared helper safe to reuse: the document being written must be excluded
from its own consumption total (or an edit that LOWERS a quantity gets rejected), and requested
quantity must be aggregated per key before measuring (or two lines of one material each pass
against the same remaining).

**Covered by** `tests/purchasing-convert-flow.test.mjs` — the real handlers against a stateful
mock D1, asserting both the block AND that legitimate splits, PO-less receipts and reducing
edits still pass. The source pins in `tests/pi-multi-po.test.mjs` count the callers of the
shared helper, so a fourth route that grows its own copy fails the test.

---

## C11 — A `wip_items` add and its matching take, counted in different units

**Shape.** `wip_items.stock_qty` is a running balance that only ever moves by deltas — nothing
re-derives it, so every mismatched pair is permanent and cumulative. The cascade puts stock in
at one point and takes it out at another, and the two are written by different people at
different times against different mental models of what the row counts. When the add and the
take disagree — about the quantity, about how many times they fire, or about whether they fire
at all — the residue never comes back out, and the order it belonged to shipped months ago.

It is invisible per-order: one card leaves 1 or 2 units behind, and only the whole-ledger sum
shows it. It surfaces as a WIP board carrying stock nobody can find, or — when the take is the
side that runs twice — as **negative** rows, which is the loudest symptom and the worst one.

| # | the add | the take | state |
|---|---|---|---|
| 1 | every stage's `+wipQty` | only ever removed when a DOWNSTREAM card was scanned; the WIP→FG subtract took only UPHOLSTERY's own rows | ✅ fixed 2026-08-08 (`630b9e13`) — `settlePoTerminalWip` drains structurally, whatever the last stage is |
| 2 | one add per completion | the idempotency ticket was keyed `(org, jc, from, to)`, so a redone card's take was swallowed while the revert's refund had already run | ✅ fixed 2026-08-08 (`bdfe14ac`) — the ticket names an OCCURRENCE, not a transition |
| 3 | merged FAB_CUT `+wipQty` = the PIECES the card covers | the set-level consume took the literal `1`, believing the row counted SETS | ✅ fixed 2026-08-08 (BUG-2026-08-08-005) — the consume takes the upstream card's own `wipQty`, and the rollback refund the same |

**The rule.** Before changing either side, name the UNIT the row is in, and check the other side
agrees. `src/api/lib/wip-expected.ts` is the answer, and it is deliberately not a mirror of the
cascade's arithmetic: it is a physical model — *a stage's output sits on a shelf iff the stage
is finished, its downstream has not started, and the order has not left WIP; quantity carried =
the card's OWN `wipQty`*. Any consume that does not bring the stored balance to what that model
says is wrong, whichever side looks more natural. And every forward path needs its exact
rollback inverse written in the same commit: a refund that hands back less than the consume took
is how a row goes negative, which is the failure mode this class is being cleaned up to remove.

**Covered by** `tests/wip-quantity-drift.test.mjs` — the real cascade against an in-memory stub
of the three tables it writes, asserting balances (not source shape), including a
`reconcileWip` cross-check that the ledger and the derivation agree. The stub reads each
STATEMENT to decide what it enforces, so reintroducing a fixed instance fails the suite instead
of quietly passing.

**Still open:** none of the three fixes repairs the data they already produced. Prod carries
~2,100 net overstated units and 162 negative rows; `GET /api/inventory/wip/reconcile` lists
them, read-only. A one-off correction pass is owed.

---

## C12 — Narrowed by CUSTOMER, not by TENANT

**Shape.** A read carries a row-level rule — `customerScopeSql`, an RBAC check, a status
filter — and the reviewer, seeing a `WHERE` clause that is visibly *about who may see this*,
reads the query as scoped. It is not. Those rules narrow WITHIN one tenant; the tenant boundary
itself is `withOrgScope`, and it is a separate predicate. A query with one and not the other
looks more finished than a query with neither, which is exactly why it survives review.

**Why it keeps happening.** Three compounding reasons:

1. **There is one org on prod.** Every instance is latent, so nothing fails, no page looks
   wrong, and no bug report is ever filed. These are found only by reading.
2. **`customerScopeSql` is deliberately a choke point** (one middleware, all 29 endpoints) and
   `withOrgScope` deliberately is not (per-query, because each query knows its own table). So
   the one that scales is the one that does NOT draw the boundary.
3. **The fixes are one-line**, which makes "fix the instance in front of me" feel complete.

**The rule.** `withOrgScope` is not an alternative to the customer scope — the orgId binds
FIRST, the row rule follows, both apply. And when the endpoint is CACHED, the query's scope must
match the cache's key: a snapshot keyed per-org over a query computed org-wide is the same
defect wearing a different hat, and needs a `cacheKey` bump so pre-fix rows cannot still be
served.

| # | endpoint | state |
|---|---|---|
| 1 | `GET/PUT /api/notifications` | ✅ fixed 2026-08-08 (BUG-2026-08-08-003) — no scope of any kind, read side and write side |
| 2 | `GET /api/consignment-orders/stats` | ✅ fixed 2026-08-08 (`39fd7a99`) — customer-scoped, org-unscoped, cached per org |
| 3 | `GET /api/consignment-orders` + every by-id read on that router | ✅ fixed 2026-08-09 (BUG-2026-08-09-001) |
| 4 | `GET /api/consignment-notes` + `/stats` + `/linked-po-ids` + `/:id/print-extras` | ✅ fixed 2026-08-09 (BUG-2026-08-09-001) — `/stats` was #2's untouched twin |
| 5 | `GET/PUT/DELETE /api/consignments` (legacy surface, SAME tables) | ✅ fixed 2026-08-09 (BUG-2026-08-09-001) — found only by sweeping the module, not the two files named in the report |
| 6 | `GET /api/sales-orders/:id` | ⬜ open — the LIST is org-scoped, the by-id read next to it is not. Same shape as #3, different module; not in scope for the consignment pass. Sweep sales the way consignment was swept. |
| 8 | `POST /api/customers` | ✅ 2026-08-13 (-061) — the LIST reads `WHERE orgId = ?` while the INSERT let the column DEFAULT fill it; now stamps `getOrgId(c)`. Byte-identical today (`DEFAULT_ORG_ID` and the column DEFAULT are both `'hookka'`) |
| 12 | `organisations.ts` — the whole router | ✅ 2026-08-13 (-100) — `loadOrganisations` selected the table unscoped; PATCH / DELETE / PUT resolved by bare `id`; POST bound the literal `'hookka'` and deduped `WHERE code = ?` across every tenant. Read scoping AND write stamping fixed in the same change, per the rule above. Note the read degrades to the LEGACY unscoped SELECT when `org_id` is missing — the alternative fallback replaces a real registry with two hardcoded companies, which is worse |
| 13 | `customer-crm.ts:send-quote` → `customers` / `customer_contacts` | ✅ 2026-08-13 (-102) — the recipient allow-list is org-scoped on both lookups, so a customer id from another tenant resolves to an empty set (a refusal) instead of that tenant's addresses |
| 9 | `customer-scope.ts:117-121` | ⬜ open — the choke point that narrows **every** scoped GET under 11 prefixes is unbounded (no LIMIT) and org-blind, and it filters rows **by name**, so a same-named customer in a second tenant would vanish from this tenant's lists |
| 10 | R&D — `rd_projects` reads + all five R&D INSERTs | ⬜ open — `GET /` and `GET /:id` carry no orgId predicate though `rd_projects.org_id` exists; `rd_prototypes`, `rd_material_issuances`, `rd_labour_hours` and `rd_team_members` bind the **literal `'hookka'`**, which mislabels a second tenant's rows rather than merely defaulting them |
| 11 | `journal_entries` / `journal_lines` | ✅ 2026-08-13 (BUG-2026-08-13-083) — the justification *"journal_entries has no orgId column (it predates multi-tenancy)"* was false: `0087_org_id_full_rollout.sql:105-106` adds `org_id TEXT NOT NULL DEFAULT 'hookka'` to both, `0206` re-applies it, `ensureFinanceOrgColumns` self-applies it at runtime, and `tests/db-schema.json` (from prod) lists it. Reads scoped **and** INSERTs stamped in the same change, per the rule below. Guard: `tests/accounting-subledger-parity.test.mjs` |
| 7 | write-side `orgId` stamping | ⬜ open — `INSERT INTO consignment_orders` (and its siblings) do NOT stamp orgId; the column takes its SQL `DEFAULT 'hookka'` (see `lib/tenant.ts`, "§1 finish step"). Read scoping is therefore only half the boundary: a second tenant's writes would land labelled `hookka`. **Do this before onboarding a second org**, or the reads above will correctly hide rows from the tenant that created them. |

**Covered by** `tests/consignment-tenant-scope.test.mjs` — the real handlers against a
two-tenant book, asserting a caller in org A cannot reach org B through a list OR a by-id read,
that the customer scope still narrows on top, and that the CN `/stats` cacheKey moved. The mock
reads binds POSITIONALLY, so deleting an org predicate stops the filtering and the assertions
fail rather than passing over a query that no longer narrows.

**Finding the next one.** Grep is the wrong tool (it times out here, and a missing predicate has
no text to match). Enumerate instead: for a router, list every `FROM <tenant_table>` with the
handler it sits in, and require each ENTRY-POINT read to carry `orgId`. Downstream reads keyed
off an already-gated id are transitively safe and should say so in a comment, so the next
reader does not "fix" them again.

---

## C13 — The screen calls a field optional; the write path requires it

**Shape.** A form labels a field "optional" (or simply doesn't mark it required), the operator
leaves it blank, and a table two hops downstream has a NOT NULL or a FOREIGN KEY on the column
it feeds. The refusal therefore arrives from **Postgres**, at INSERT time, phrased as a
constraint name. Two separate defects fall out of one root: the user was told the field didn't
matter by the very screen that then failed, **and** the failure text is unusable — and because
`humanizeError` correctly classifies a constraint string as technical, what actually reaches the
toast is *"Something went wrong. Please try again."*, which is worse than the raw string,
because retrying fails identically forever.

**Why it keeps happening.** The requirement is not written down anywhere both sides can read.
The screen encodes one belief about what a mode/branch needs, the route encodes another, and
nothing forces them to agree — so they drift the moment either side is edited. `?? ""` makes it
land as a *constraint* error rather than a *null* error, which reads like a data problem instead
of a validation gap: **an empty string is not NULL**, so a nullable FK column still runs its
check against `""` and rejects it.

**The rule.** Derive the requirement from **what the branch WRITES**, put it in one pure module,
and have the screen and the route both call it. Refuse BEFORE composing any statement, so the
refusal can name the row the operator can see and say what to do. Never coerce a missing foreign
key to `""` — pass `null` if the column truly allows it, or refuse.

| # | surface | state |
|---|---|---|
| 1 | Spawn Service Order — CODE "optional", REPRODUCE's `production_orders.product_id` FK | ✅ fixed 2026-08-10 — rules moved to `src/lib/service-order-modes.ts`, called by dialog AND route |
| 2 | `PUT /api/service-orders/:id/mode` → REPRODUCE — the same FK, reached by "decide later" | ✅ fixed 2026-08-10 in the same pass; fixing only #1 would have left this door open |
| 3 | STOCK_SWAP "FG Batch" pickers fed from `/api/inventory` (which returns **products**, not `fg_batches`) — the id sent as `resolutionFgBatchId` was always a `prod-*` id, so the mode could never succeed | ✅ fixed 2026-08-10 — the route derives the batch FIFO from the product and tolerates a product-id hint; the spawn dialog's column is gone, the mode-change dropdown relabelled (it also printed a hardcoded "(0 on hand)") |
| 4 | `CreateServiceOrderModal` in `src/pages/service-orders/index.tsx` — 900 lines that POST **without** `caseId`, which the route has required since 0074 | ⬜ open, but **unreachable**: `setCreateOpen(true)` is never called and nothing imports it. Delete it or wire it to the shared module; do not let it be re-enabled as-is |
| 5 | the rest of the app | ⬜ unswept. The shape to look for is a form control whose label says *optional* feeding a column with a FK/NOT NULL, or a route binding `x ?? ""` into an id column |

**Covered by** `tests/service-order-spawn-product.test.mjs` — the real handlers against an
in-memory book whose `production_orders` insert **re-implements the FK** (an unknown id,
including `""`, throws exactly what prod threw) and whose `batch()` is atomic like
`SupabaseAdapter.batch`. So a regression that reintroduces `?? ""` fails the test the same way
it failed the operator, and every refusal is asserted to pass `looksTechnical === false`.

**Finding the next one.** Start from the SCHEMA, not the screen: list the FK / NOT NULL columns
a route writes, then find the control that feeds each one and read its label. A field the user
can leave blank must map to a column that accepts blank — or the screen must say so.

---

## C14 — A child array scanned once per parent row

**Shape.** A LIST handler fetches its rows' children in ONE batched query, then
hands the **whole** child array to a per-row mapper whose first act is
`children.filter(c => c.parentFk === row.id)`. That is a full scan of the child
array for every parent — O(N×M) — and it reads as correct, because it *is*
correct. Only the cost is wrong, and nothing about the code says so.

**Why it keeps happening.** Three reinforcing reasons:

1. **The batched fetch looks like the fix.** Most of these sites were *already*
   improved once, by narrowing `SELECT * FROM child` to `WHERE fk IN (...)`. That
   removes the wire cost and leaves the join cost, and the commit reads as done.
2. **It never fails, it only gets slower** — so there is no bug report, no stack
   trace, and no date on which it started. It is found by reading or by
   measuring, never by an incident, until it crosses the cliff.
3. **The failure is a CLIFF, not a slope.** Cost is quadratic while the cache
   window is constant, so the endpoint is fine, fine, fine, then unusable. The
   dashboard broke exactly this way when sales orders grew 720 → 1,334 in two
   months.

**The rule.** Bucket the child array into a `Map<parentId, child[]>` **once** at
the handler, and hand each mapper its own bucket. Keep the mapper's internal
`.filter()` — as a passthrough it makes the change byte-identical by
construction, and because `.filter()` copies before any following `.sort()`, the
shared bucket can never be reordered under another row.

Use the *other* shape — an optional pre-grouped `Map` parameter on the mapper
(`groupJobCardsByPoId` / `rowToMinimalPO`) — only when the mapper also has
single-record callers that must keep the legacy filter. That variant DOES need
an explicit `.slice()` before sorting, because it drops the filter.

**Instances**

| # | site | fixed | scale when measured |
|---|---|---|---|
| 1 | production orders, NON-minimal path (`rowsToPOsBatch`) | ✅ 2026-05-21 | 530 PO × 2,200 JC ≈ 1.16 M |
| 2 | sales orders full list (`itemsBySO`) | ✅ 2026-06-04 | — |
| 3 | `customers.ts` hubs · `suppliers.ts` materials · `warehouse.ts` rack items · `consignment-orders.ts` items · `delivery-orders.ts` items | ✅ (caller-side buckets) | all small |
| 4 | production orders, **MINIMAL** path (`rowToMinimalPO`) | ✅ 2026-08-13 (#275) | **957 PO × 36,796 JC ≈ 35 M — 6,473 ms of a 9,587 ms `/planning` cold call** |
| 5 | `qc-inspections.ts` defects + items | ✅ 2026-08-13 | 500 × 2,151 = 1,075,500 — 20.8 ms |
| 6 | `products.ts` boms + dept_working_times | ✅ 2026-08-13 | 365 × 1,697 = 619,405 — 18.2 ms |
| 7 | `purchase-orders.ts` items | ✅ 2026-08-13 | 165 × 369 = 60,885 — 1.3 ms |
| 8 | `grn.ts` items | ✅ 2026-08-13 | 37 × 45 = 1,665 — 0.1 ms |
| 9 | `accounting.ts:190` + `cash-flow.ts:185` journal lines | ⬜ **open, deliberate** | 2 entries × 50 lines = 100 |
| 11 | `qc-pending.ts:1848` checklist items per pending inspection | ✅ 2026-08-13 (thin-module sweep) | **2,839 PENDING/IN_PROGRESS × ~28,000 items ≈ 80M — NO LIMIT, and the page calls the endpoint with no query string** |
| 10 | `qc-templates.ts:91` · `qc-pending.ts:388` · `service-cases.ts:494,506` · `service-orders.ts:311,325` · `rd-projects.ts:166` · `consignment-note-shared.ts:132` | ⬜ measured-and-cheap | ≤ 7,781 cmp each, 2026-08-13 |

Row 4 is why this class exists: rows 1 and 2 fixed the same shape twice and
neither author looked for row 4, which was on the hottest path in the app.

**Row 11 is the same lesson, one day later.** Row 5 (`qc-inspections.ts`) was fixed on
2026-08-13 and annotated in the class test as *"the largest in the class"*. It was not: its
twin in `qc-pending.ts` — same mapper name, same child table, same shape — is **~75×
larger and unbounded**, and it was missed because the audit named one file and the author
fixed that file. The annotation has been corrected. When you fix a row here, grep the
sibling routes for the same **mapper**, not the same filename.

**Row 9 is the one to watch.** Both fetch the ENTIRE `journal_lines` table with
no scoping and put no `LIMIT` on the entries — the exact pair of defects #275
fixed — and are trivial only because the GL is unused (2 entries). Fix it when
the GL is adopted, and fix it by **reusing the entries query's own `WHERE`** as a
sub-select: that query carries a `LEFT JOIN document_lifecycle`, and
hand-writing a second predicate that can drift from the first is the specific
trap #275 documented (a child fetch scoped to a different parent set than the
parent fetch silently drops rows).

**Row 10 is closed, not unexamined.** Every one was measured on prod on
2026-08-13 and costs under 7,781 comparisons over a structurally small parent
set. If a grep brings you back to one of those lines, that is the answer — do
not re-audit them.

**Not instances** (checked 2026-08-13, and each says so in place): `invoices.ts`
— the LIST passes `[]`, only the single-invoice read passes real arrays;
`production-orders/_helpers.ts:422,923` — the documented single-PO path, every
batched caller goes through `rowsToPOsBatch`; `wip-expected.ts:103`,
`assistant-tools.ts:1696`, `worker.ts:2762`, `_helpers.ts:3858` — each is
already handed a per-parent bucket, a one-document set, or a `LIMIT 100`.

**Enforced by** `tests/list-endpoint-child-grouping.test.mjs` — part 1 pins the
equivalence every fix in this class rests on (`bucket[id].filter(pred)` is
element-for-element the same objects, in the same order, as
`all.filter(pred)`) against an adversarial fixture; part 2 is a per-site source
guard that fails if a handler goes back to passing the whole array. All four
2026-08-13 guards were proved by reintroducing the bug and watching them go red.
`tests/production-orders-jobcard-grouping.test.mjs` covers row 4's own shape.

**Finding the next one.** Grep `\.(filter|find)\(...=== \w+\.\w*[Ii]d\)` under
`src/api` — but a match is not a bug. Establish, in this order: (a) is it inside
a per-row `.map()`/loop, or a single-record path? (b) how many parents and
children does the real prod payload have? (c) is the parent set **bounded** (a
`LIMIT`, a work queue that drains) or unbounded? An unbounded list is worth
fixing at any size; a bounded one is worth fixing only for what it costs today.

---

## C15 — A request that DIED, rendered as an answer

**Shape.** A read fails, the failure is not distinguishable from success-with-
nothing, and the screen states the empty case as fact. Three surfaces, one
shape:

| surface | the false sentence |
|---|---|
| a report over a date range | *"No data available"* |
| a record detail page | *"Order not found"* / *"Invoice not found"* |
| a list page | *"No draft orders."* |

Each is a **statement about the business**, and each has a recovery an operator
will actually perform — re-key the order, re-raise the invoice, tell the
customer nothing shipped.

**Why it keeps happening.** The failure is *silent by construction*. Before
this fix `useCachedJson` caught the 30 s `AbortError` and `return`ed with no
error set, while `.finally` cleared `loading` — so a dead request produced
`data = null, loading = false, error = null`, which is the exact state a
successful empty response produces. There is no stack trace, no toast and no
red anything; the page looks like it worked. And `cachedFetchJson` (the
non-hook variant) still returns `null` for a timeout, a 500 and a `_stub` body
alike, so `json?.data || []` writes emptiness into state.

**The rule.** *Only an observed HTTP 404 licenses the words "not found", and
only a 2xx body licenses "no data".* Everything else — abort, network, 5xx, a
`_stub` envelope — leaves the answer UNKNOWN, and the screen must say it could
not load, why, and offer a retry. Never launder a real absence into a network
message either: a genuine 404 must still read as absence.

Mechanically: `classifyFetchFailure` (`src/lib/cached-fetch.ts`) is the single
decision, `isUnknownOutcome(failure)` is the single guard, and
`useCachedJson().failure` / `cachedFetchJsonResult().kind` are the only two ways
to obtain it. `cachedFetchJson` cannot express the distinction — a page in this
class must not use it.

**Instances**

| # | surface | state |
|---|---|---|
| 1 | **reports** (5 tabs) — *"No data available"* over `/api/production-orders` killed at 30,012 ms | ✅ 2026-08-13 (BUG-2026-08-13-005) — `cachedFetchJsonResult` + `<ReportError>` |
| 2 | **detail pages / edit forms / one embedded panel / the public QR page** — 11 printed a false absence, 4 hung on `Loading…`, 1 asserted an empty child set | ✅ 2026-08-13 (BUG-2026-08-13-016) — `useCachedJson().failure` + `isUnknownOutcome` + `<RecordLoadError>`; 19 files changed, 6 more repaired by the primitive alone |
| 3 | **list pages** — ~25 grids whose empty caption (*"No draft orders."*, `DataGrid`'s default *"No data found."*) renders over a failed fetch | ⬜ **open, enumerated.** Each page owns its own caption and its own fetch shape, so this is a separate PR with its own before/after — not a blind sweep. Start from the files that import `useCachedJson` and pass an `emptyMessage`, and give `DataGrid` a `loadFailure` prop rather than editing 25 captions by hand |
| 4 | **`cachedFetchJson` callers outside this class** | ⬜ unswept. The function returns `null` on every failure; any caller that renders that null as a factual empty state is row 1/2/3 wearing a different hat. `products/bom.tsx` and `products/documents.tsx` were two, found by this pass |

Rows 3 and 4 are why this section exists rather than a note in the bug entry.
Row 2's pass fixed **19 files across 11 modules**; every one would have been
missed by an author who fixed only `sales/detail.tsx`, which is the file the
audit named.

**Cancellation is not a failure.** An unmount or a URL change aborts in-flight
reads on purpose, and making that noisy is a new bug. The separation is
structural: `releaseInflight` aborts only when the refcount hits 0, i.e. after
every subscriber has set its own `cancelled` flag and returned — so an
`AbortError` that reaches a *non-cancelled* consumer is the 30 s timeout.

**Enforced by** `tests/record-load-failure-class.test.mjs` — it pins the
primitive (the swallowed-abort line must stay gone; the `cancelled` guard must
stay FIRST), enumerates every consumer with the guard it uses, and **fails when
a new file reads through the cache layer and prints "…not found" without being
in the map**. Behaviour is proved separately in
`tests/cached-fetch-result.test.mjs`, which runs the real fetch wrapper for all
three outcomes. Every guard was proved by reintroducing the bug and watching it
go red — including one that did NOT fire at first: the consumer check only
looked for the identifier `isUnknownOutcome` and passed happily while the guard
had been short-circuited out of the branch. It now requires the CALL to gate
the `<RecordLoadError>` render.

## C15 — A figure that reads as measured, and is not

**Shape.** A number reaches the screen from somewhere that is not a measurement: a
literal typed into the source, a hash of a primary key, `Math.random()`, a fixed
ratio of a different number, a constant `0` standing in for "not computed", or a
ratio whose numerator and denominator come from the same place. It renders in the
same typeface, under the same caption, beside figures that *are* real. Nothing
about it looks wrong.

**Why it keeps happening — and why it is the worst class in this file.**

1. **It never fails.** Every other class here announces itself somewhere: a 500, a
   blank tab, a stuck card, a negative row. This one is silent by construction —
   a plausible number is exactly what it produces.
2. **`tsc` cannot see it and no runtime assertion can catch it.** `84.2` is a
   valid number. `revenue * 0.65` is valid arithmetic. Only a **source guard**
   catches these, which is why every fix in this class ships one.
3. **The placeholder outlives its author's intent.** Most of these were scaffolding
   written to make a screen render before its data source existed. The source
   never arrived; the scaffolding shipped; the comment saying "mock" stayed right
   next to the number for months.
4. **The damage is decision-shaped.** The owner reads these and acts. A wrong
   number he trusts is worse than a page that fails to load — the failing page
   costs him a refresh, the wrong number costs him the decision.

**The rule.** *Where a real source exists, use it. Where none exists, render "—"
and say why. Never a plausible-looking number.* Three corollaries that each cost
a fix here:

* **`0` is a claim, not a blank.** "Zero on hand" and "on-hand not computed" are
  different statements. Never `?? 0` a missing measurement.
* **A total inherits the weakest input.** If one line is "—", the sum is "—" — a
  total must not launder a missing figure into a complete-looking one.
* **Publish the provenance beside the figure.** "Measured Cards", "Accounts
  Posted", "Valuation Basis", `assumedEfficiency` — a percentage off 12 of 400
  cards must not read like a departmental KPI, and a denominator carrying an
  unstated assumption is this bug wearing a hat.

**Do not over-correct.** The mirror-image mistake is deleting a *measured* metric
while cleaning up a fabricated one. Each guard below also pins the real thing in
place: `/api/department-performance` must keep dividing by clocked time,
`/api/inventory/fg-stock` must keep existing, `payslips.ts` must keep calling
`computeMonthlyLabor`.

| # | figure | where | what it actually was | fixed |
|---|---|---|---|---|
| 1 | Department Efficiency | `/reports` › Production | `(actual \|\| est) / est` — an estimate divided by itself, so ~100% forever | ✅ 2026-08-13 (-004) |
| 2 | "No data available" over a dead 30 s request | `/reports` › Production | a failed read rendered as an empty result | ✅ 2026-08-13 (-005) |
| 3 | Hours Worked / Items Completed / Efficiency | `/reports` › Employee | `seed(w.id)` — a hash of the worker's primary key; plus typed-in 94.5 / 8.7 / 12.5 | ✅ 2026-08-13 (-006) |
| 4 | COGS + all four operating expenses | `/reports` › Financial | `revenue × 0.65`; Salaries/Utilities/Rent/Others as constants | ✅ 2026-08-13 (-009) |
| 5 | "Accounts Payable Aging" | `/reports` › Financial | aged *unreceived POs* by expected delivery date — not AP at all | ✅ 2026-08-13 (-010) |
| 6 | finished-goods `stockQty` | `/api/inventory` → 5 screens | literal `0` for all 380 products, printed as an on-hand quantity; ×`basePriceSen` for a mobile "Amount" | ✅ 2026-08-13 (-014) |
| 7 | "Stock Valuation by Category" | `/reports` › Inventory | `Σ costPriceSen` — **no quantity**; exported to CSV | ✅ 2026-08-13 (-014) |
| 8 | "Avg Sell Price" column | `/reports` › Inventory | rendered `p.sizeLabel` | ✅ 2026-08-13 (-014) |
| 9 | "Forecast Accuracy 84.2%" | `/analytics/forecast` | a literal on a branch always taken (`actualQty` has no writer) | ✅ 2026-08-13 (-014) |
| 10 | "Capacity 220/mo", a frozen 6-month window, "May Forecast" | `/analytics/forecast` | literals presented as configuration | ✅ 2026-08-13 (-014) |
| 11 | "Overall Accuracy 100%" | `/analytics/forecast` › Accuracy | `100 − 0` off an empty set | ✅ 2026-08-13 (-014) |
| 12 | per-product "Material Status" | `/api/promise-date` | ONE whole-table `raw_materials` reading stamped on every product | ✅ 2026-08-13 (-014) |
| 13 | OT hours → gross + net pay | `POST /api/payroll` | three `Math.random()` calls, INSERTed into `payroll_records` | ✅ 2026-08-13 (-014) — endpoint refuses |
| 14 | LHDN submission ID + clearance UUID | `PUT /api/e-invoices/:id` | random strings, status flipped to VALID, no LHDN client in the repo | ✅ 2026-08-13 (-014) — endpoint refuses |
| 15 | department capacity + utilization RAG | `/api/scheduling/capacity` | `9 h` literal while `workingHoursPerDay` was SELECTed and discarded; `0.85` unstated | ✅ 2026-08-13 (-014) |
| 16 | forecast `confidence` | `POST /api/forecasts` | defaulted to the literal `50`, rendered as a colour-coded badge | ✅ 2026-08-13 (-014) |
| 17 | `/admin/health` KPIs · agent-console FX + LLM prices | `/admin/health`, `/agents` | seeded-random / frozen constants — **but tagged `_mock`/`est*` and captioned as estimates** | ⬜ deliberate — honest labels; the FX rate gating a real spend limit is an owner decision |
| 18 | QC `result` / `department` | `/quality` › History | `row.result ?? "PASS"`, `row.department ?? "UPHOLSTERY"` — an inspection nobody performed rendered as a **green PASS** | ✅ 2026-08-13 (-063) |
| 19 | R&D material unit cost | `/rd/:id` budget card, chips, KPIs, CSV | `estimateFIFOCost` — six hardcoded per-itemGroup constants (and a `2000` catch-all) **persisted** into `rd_material_issuances` and summed into `actualCost`; the arg `_itemCode` is unused, so it does not even vary by material | ⬜ open — owner decision (refuse vs `null`+`—`); probe in `AUDIT-THIN-MODULES.md` R1 |
| 20 | Cash Flow "AP Outflow" / "Expected Outflows (12w)" | `/accounting/cash-flow` | built from **unreceived `purchase_orders` bucketed by expected DELIVERY date** — the surviving twin of row 5, which was fixed on `/reports` the same day | ⬜ open — the replacement basis is a finance decision |
| 21 | Fabrics `soh` / `priceTier` | `/customers` › Fabrics | `m?.soh ?? 0` printed as an on-hand quantity; `?? "PRICE_1"` printed as a tier; and a genuine `PRICE_3` renders as **Price 2** | ⬜ open |
| 22 | credit-utilisation bar | `/customers` grid | `limit > 0 ? outstanding/limit : 0` → a COD customer owing RM 50,000 shows a **green 0%** bar; the Available column beside it returns `—` correctly | ⬜ open |
| 23 | CR No. · return status · return date | `/consignment/return` | `buildMockCRs()`: a module-level counter as a document number, `Math.random()` thresholds as a PENDING→INSPECTED→ACCEPTED→RESTOCKED status, `now −` 1-10 random days as the return date — **beside real customers and real RM, and exported to CSV** | ✅ 2026-08-13 (-071) |
| 24 | Balance Sheet › "by company" Net Profit + Total Equity | `/accounting` › BS (`GroupByCompanyCard`) | RM 0.00 for all four companies — the per-company `/pl?orgId=<code>` filtered the TENANT column with a DISPLAY code and matched nothing, and the `catch` returned 0 as well. Printed beside a consolidated statement showing the real money | ✅ 2026-08-13 (-051) — the card renders nothing because no truthful per-company option exists; see C16 |
| 25 | "Revenue (MTD)" · "Expenses (MTD)" · "Net Profit" | `/accounting` › Overview | `Σ chart_of_accounts.balanceSen`, a column ONLY the manual-JV paths write — so hand-keyed journals were reported as the company's revenue; "(MTD)" with no date filter anywhere in the component; and the whole `COST` type dropped from the expense side | ✅ 2026-08-13 (-091) — now `GET /accounting/pl`, dash for an unposted category |
| 26 | every material group's green "✓" | `/accounting` › Stock Summary | `balanced = opening + purchases − consumption === closing` where consumption IS `opening + purchase − closing` → `closing === closing`, true forever. A verification nobody performed, printed on a stock valuation | ✅ 2026-08-13 (-093) |
| 27 | the whole Cash Flow statement on a Quarter / Full-year period | `/accounting` › Cash Flow | `fyMonths` parses `YYYY-MM`, so `"2026-Q1"` keyed all 13 columns `"2026-NaN"`: every income and expense line rendered `-` while `balBefore` string-compared TRUE against every real month and printed a large, REAL Bank b/f + c/f | ✅ 2026-08-13 (-092) |
| 28 | Daily Report headline · OCR Accuracy caption | `/dashboard` (Command Center) | a dead read rendered as an answer — a **green `0` + "All clear — nothing flagged today"**, and *"No scans yet."* Same endpoint as `/daily-report`, which said *"Could not load"* correctly | ✅ 2026-08-14 (-103, -104) |
| 29 | Supplier OCR success rate | `/dashboard` › OCR Accuracy | `rateColor(s.rate)` / `pct(s.rate)` with no `total` — the `MIN_SAMPLE` guard, added **because that panel printed a red 0% off ONE document**, was the one call site that never forwarded the sample size | ✅ 2026-08-14 (-105) |
| 30 | printed receivables aging strip | Hookka Report › Billing Desk | five buckets computed, **four printed** — `d30Sen` (one month overdue) silently dropped, so the boxes did not tie to the total beside them, and every surviving caption named the bucket one to its left | ✅ 2026-08-14 (-106) |
| 31 | **"Attendance %"** | Hookka Report › Workforce | `SUM(status='PRESENT')/COUNT(*)` where **every writer of `attendance_records.status` writes the literal `'PRESENT'`** and nothing writes `'ABSENT'`; absence creates no row → **100.0% by construction**, on a printed report | ⬜ open — `docs/DASHBOARD-DATA-AUDIT.md` |
| 32 | **"Current Cash Position"** + the 12-week Running Balance | `/accounting/cash-flow` | `bank_accounts.balanceSen`, whose only writers are **migration seed fixtures** and that page's own Add-Transaction form. No invoice, receipt or payment touches it | ⬜ open — owner decision (wire it, or label the tab a scratchpad) |
| 33 | MRP Net Req · Shortage · Sugg. PO · "14d lead" | `/planning/mrp` | `const onOrder = 0`, `moq \|\| 50`, `leadTimeDays \|\| 14` — material already on an open PO reports as a full shortage; the invented MOQ and lead time print under the supplier's name | ✅ 2026-08-14 (-144, -145) — `onOrder` sums open PO lines using the **same** definition the Fabric tab of this page already uses (`fabric-usage.ts` PO Outstanding), and is rendered in a new **On Order** column beside where it is subtracted. MOQ and lead time are `number \| null` end to end and render "—": both columns are `INTEGER NOT NULL DEFAULT 0`, so **0 cannot be told apart from never-filled-in** and is read as unstated. No MOQ → suggest exactly the shortage; no lead time → **no** `suggestedOrderDate`, because the cell that turns red must not turn red on a guess |
| 34 | KPI "last month" score + ↑/↓ delta + "settled" | `/kpi` | `kpi_periods` has **no writer anywhere** (DDL + two SELECTs), so `isLocked` can never be true: every settled month is silently recomputed against today's data | ⬜ open |
| 35 | Labor Cost **"Reconciled · 0 difference"** ✓ | `/employees` › Labor Cost | overhead is the closing plug, so `reconciledSum ≡ totalPayrollCost` and the diff is **algebraically 0 forever** — a verification no input can turn red, printed on a payroll report | ⬜ open |
| 36 | **PCB** on every payslip | `/employees` › Payroll, the CSV, the printed slip, the worker phone | `pcb: pcbOn ? 0 : 0` — hardcoded on both branches, feeds `totalDeductions → netPay`, under a tooltip that lists PCB as included. **The inputs LHDN's calculation needs (tax residency, marital category, child relief) did not exist on `workers` at all**, so there was nothing to compute from either | ✅ 2026-08-14 (-121) — `src/lib/pcb.ts` returns a STATUS, never a bare number: `DISABLED` / `COMPUTED` / `ZERO_PROVEN` / `UNKNOWN`, and every screen prints `—` unless something was actually worked out |
| 37 | Balance-sheet **"balanced ✓"**, AR/AP Outstanding, Opening-Balance **"Balanced ✓" + enabled Post** | `/accounting` | all render `RM 0.00` / a green tick over a **failed** fetch — the same page already publishes `NO_FIGURE = "—"` for three other cards | ⬜ open — row 28's shape, on a second page |
| 38 | Trade Finance *"Draws + unallocated = account balance"* | `/accounting` › Trade Finance | `unallocated = net − Σ outstanding` and `total = Σ outstanding`, so the identity holds in integer sen **always**; the red branch is unreachable | ⬜ open |
| 39 | **"On-time delivery %"** — lead headline, Logistics desk AND Production desk | Hookka Report | scored `dispatched_at` (not delivery) against `hookka_expected_dd` (OUR back-derived target, which `kpi-metrics.ts:18-19` forbids scoring), over a population requiring `dispatched_at IS NOT NULL` — so an order NEVER DISPATCHED, the worst case, could not appear and lateness could only be under-reported. `production.onTimePct = delivery.onTimePct` printed one number twice, as if two desks agreed | ✅ 2026-08-14 (-131) — `delivered_at` vs `customer_delivery_date` per SO, last delivery counts, every exclusion counted and published |
| 40 | the Daily Report headline, every chip, and the Command Center tile | `/daily-report` + `/dashboard` | **all 15 checks `catch → return []`**, so a check that THREW contributed 0 to its chip and 0 to the headline — a green `0` under *"A Quiet Day on the Floor"* over a sweep that had partly not happened. The payload had no way to say "3 of 15 could not run", so no renderer COULD have told the truth. Two of the fifteen are money detectors, and `pricing-integrity.ts`'s own header records the concrete case: a type error that threw on every row and reported a clean book | ✅ 2026-08-14 (-130) — checks rethrow, `runCheck` records the failure, counts are `number \| null`, `checksRun`/`checksTotal`/`unavailable` published |
| 41 | *"Top 3 = N% … of total customer revenue"* | `/dashboard` › Sales by Customer | the denominator was the **top-12 subtotal** — the only rows the browser receives — so numerator and denominator moved together and the figure sat near 100% by construction. A concentration metric that cannot rise is not a metric. The card's own "All customers" row above it used the REAL total | ✅ 2026-08-14 (-132) — denominator is period TOTAL over all customers, computed server-side; largest-customer and top-10 shares published with `customerCount` |
| 42 | *"0 of 0 work orders · 0/0 cells complete"*, the Overview tab fraction, **all eight department tab fractions**, *"N of M orders"*, and *"No production orders found."* | `/production` Overview | the fetch is armed by `shouldFetch` (default `false` in overview mode) while the matrix is gated on `activeTab === "ALL"` alone — so on a cold landing **no request is ever sent** and the page printed a confident `0` next to its own *"No orders loaded yet."* callout. `orders` is `[]` for three different reasons (never fetched / in flight / dead read) and `failure` was not read, so a timeout was byte-identical to an empty factory | ✅ 2026-08-14 (-146) — one named `ordersObserved` predicate over `isUnknownOutcome`; every count states WHICH of the three cases it is in, because "—" with no reason is only a prettier lie |
| 43 | all four totals tiles, incl. **"⚠️ Missing BOM time"** | `/production/wip-times` | `loading` was destructured and used only for the export button and the table; `failure` was never read. During the fetch, on a dead read and on an empty body all four printed `0` — and the Missing-BOM tile goes amber **only when `> 0`**, so a failed load rendered its `0` in the NEUTRAL colour and was pixel-identical to all-clear | ✅ 2026-08-14 (-147) — gated on `Array.isArray(resp?.data)` (**not** `!loading`: a dead read also ends with `loading === false`), unknown branch tested FIRST so it can never wear the all-clear colour, failure banner + Retry |
| 44 | **"⚠️ Missing BOM time"** could not observe its own worst case | `/production/wip-times` | `loadActiveBomRows` filters `versionStatus = 'ACTIVE'` and `walkTree` emits a row only per `processes[]` entry carrying a `deptCode` — so a product with **no active BOM template at all**, the most complete form of "missing BOM time", produces no row and can never be counted. A `0` there asserted a coverage the query cannot establish (row 28's shape / BUG-2026-08-13-096) | ✅ 2026-08-14 (-147) — `countProductsWithoutActiveBom()` mirrors the exact filter that creates the blind spot and is published beside the figure as an EXCLUSION, never folded into `missing`; `number \| null` so a failed count reads "—", never 0; the caption states it is category-scoped and can never be dept-scoped |
| 28 | `production_time_minutes`, the `efficiencyPct` and the `deptBreakdown` on EVERY attendance row | `POST /api/attendance` + `POST /api/worker/clock` + the midnight auto-close → `GET /api/attendance`, `GET /api/worker/history` | `round(workingMinutes × 0.85)` — a fixed ratio of the clock time, written at clock-out and captioned as production. The efficiency divided it by the standard day, so it measured ATTENDANCE LENGTH; the dept split republished the same number under an EMPTY productCode. Prod Aug 2026: 180,928 / 212,850 = **0.85005**. Three writers, one of which (the forgotten-punch auto-close) produced a flat **85%** that could not vary — both sides came from `stdMin` | ✅ 2026-08-13 (-103) — writers cleared, readers publish `null` / `[]`, column made nullable |

**Enforced by** six files, all structural (`readFileSync` source assertions),
because nothing else can catch a number that is merely wrong-but-plausible:
`tests/no-fabricated-efficiency.test.mjs` (rows 1–2),
`tests/no-fabricated-worker-metrics.test.mjs` (row 3),
`tests/no-fabricated-financials.test.mjs` (rows 4–5),
`tests/no-fabricated-inventory-and-forecast.test.mjs` (rows 6–16),
`tests/no-fabricated-consignment-returns.test.mjs` (row 23),
`tests/accounting-ui-truthfulness.test.mjs` (rows 25–27, plus the two
non-figure defects the same accounting-page audit found — see below),
`tests/dashboard-truthfulness.test.mjs` (rows 28–30),
`tests/pcb-not-fabricated.test.mjs` (row 36 — with the behaviour proved
separately in `tests/pcb-calculation.test.mjs`),
`tests/planning-production-tile-truthfulness.test.mjs` (rows 33, 42–44).
Rows 17–22, 31–32, 34–35 and 37–38 are open or deliberate and carry no guard yet.

**A seventh corollary, from row 36 (PCB, 2026-08-14).** *When no real source
exists, the fix is a REFUSAL with a name — and the refusal has to be
representable.* Every earlier fix in this class had somewhere honest to read
from. PCB had nowhere: the inputs LHDN's calculation needs were not columns
anybody had ever added, so there was no "use the real source" available.
Deleting the fabricated `0` was not enough either — a blank in a Deductions
column reads as *nothing was due*, which is the same false claim in a quieter
font. Three things make a refusal survive contact with the rest of the app:

* **The figure and its provenance travel together.** `pcb_sen` is meaningless
  without `pcb_status` beside it in the *same* INSERT (C20's lesson), and
  `pcbHasFigure(status)` is the single decision every screen asks before
  printing an amount. Without the second column, a later reader has no way to
  tell a computed zero from an uncomputed one — which is where this bug came
  from in the first place.
* **A new input column gets no DEFAULT.** A default silently manufactures the
  very declaration the refusal exists to demand, and does it for every row at
  once.
* **A partially-unknown input can still yield a real answer — if that is
  PROVED.** Here, relief only ever reduces the tax, so the least-relief profile
  is a ceiling: when it computes to zero, zero is the answer whatever the
  missing declaration says. That is `ZERO_PROVEN`, and it is only allowed
  because a test asserts the monotonicity it rests on across the whole profile
  grid — an argument in a comment would not have been enough.

⚠️ **`tests/no-fabricated-efficiency.test.mjs:6-10` states something false in
prose** — *"Real work time IS being recorded, on a minority of cards."* It was
refuted by the later prod count at `src/pages/reports.tsx:782-786` (4,289 of
4,289 non-zero `actualMinutes` byte-identical to `estMinutes`). A wrong claim
inside a **test file** is the worst place for one, because it reads as verified.

**A sixth corollary, from rows 28–30 (the dashboard audit, 2026-08-14).** *A
class guard that grows by matching the first instance's WORDS will not grow.*
`tests/record-load-failure-class.test.mjs` enumerates new members of the
dead-request class by scanning for the string *"not found"* — so the Command
Center, whose false sentences are *"All clear — nothing flagged today"* and
*"No scans yet."*, was never in the map, on the most-read screen in the app.
When a class guard scans for text, scan for the SHAPE (a cached read whose empty
branch renders a factual claim), or accept that it only ever finds re-runs of
the case you already fixed. Corollary to the corollary: the honest sibling was
right there — `/daily-report` reads the **same endpoint** and says *"Could not
load the report."* **Two screens on one endpoint disagreeing about whether the
data arrived is a cheap thing to grep for and a reliable smell.**
`tests/no-fabricated-attendance-production-time.test.mjs` (row 28 — all three
writers, both readers, AND the capture-coverage caption on the metric that
survived).
Rows 17–22 are open or deliberate and carry no guard yet.

**A fourth corollary, from row 23.** *Real money on an invented status is more
dangerous than fully fake data.* The `/consignment/return` grid carried the real
customer, the real branch and (where priced) the real RM; only the status, the
date and the identifier were invented. The correct figures are what made the
fabricated column beside them credible — nobody questions a status sitting next
to money that reconciles. So when a row mixes sources, the *honest* half is not
mitigation, it is camouflage: audit every column of a row, not the row.

**A fifth corollary, from rows 25–27 (the accounting-page audit).** *An ACTION and a
VERIFICATION are figures too.* The same page carried a "Record Payment" button that POSTed to
a live endpoint which UPDATEs a table nothing reads (`ar_aging`/`ap_aging`, called "dead" in
three places in the API), never checked `res.ok`, and closed the form as if it had saved
(BUG-2026-08-13-090); and a green ✓ column whose predicate was algebraically `closing ===
closing` (BUG-2026-08-13-093). Neither is a number, and both told the owner something untrue
with the same confidence a fabricated figure does. When auditing a screen, ask of every
control *"what would prove this did what it says?"* and of every tick *"what input makes this
go red?"* — if the answer is "nothing", it belongs in this class.

**A seventh corollary, from rows 39–41 (2026-08-14).** *Audit the DENOMINATOR and the
POPULATION, not only the numerator.* All three of these rows are arithmetic nobody would
call wrong. Row 39's population silently dropped the worst case (`dispatched_at IS NOT
NULL` — an order never dispatched cannot be late); row 40's headline summed fifteen checks
of which any number may not have run; row 41 divided by its own numerator's source. The
question to ask of any published share or count is **"what CANNOT appear in this figure,
and would its absence flatter us?"** — and, having answered it, to publish the answer
beside the number. Every one of the three fixes here ships a coverage field for exactly
that reason (`onTime.coveragePct`, `counts.checksRun`/`checksTotal`, `customerCount`).

Row 39 adds a narrower one worth stating on its own: **a target we generate is not a
promise we made.** `hookka_expected_dd` is the customer's date minus our own buffer, so
scoring against it can only ever measure whether we hit our own arithmetic. When a metric
is about keeping a commitment, find the field the CUSTOMER agreed to — here
`sales_orders.customer_delivery_date`, which existed and was 99.8% populated the whole
time.
**A sixth corollary, from row 28.** *A metric can be honest arithmetic on a dishonest
input.* Nothing in the attendance efficiency formula was wrong —
`productionTimeMinutes ÷ standardMinutes × 100` is exactly how you compute an efficiency.
The defect was one level down, in what `productionTimeMinutes` HELD. Reviewing the formula
is therefore not a check; the check is on the SOURCE COLUMN, and the test is its
**distribution**: divide the column by its supposed input across the whole table and see
whether a constant falls out. Here 180,928 ÷ 212,850 = 0.85005 and the fabrication was
visible in one query. Three further lessons this row paid for:

* **Count the writers before fixing one.** The same ratio lived in the office punch, the
  phone punch and the midnight forgotten-punch auto-close. Fixing the file you were pointed
  at would have left two live fabricators — and the auto-close was the worst of them,
  producing a flat 85% that could not vary because both sides of the ratio came from
  `stdMin`. Grep for the CONSTANT, not for the endpoint.
* **A column with no measuring writer will not announce itself by being NULL.** This one was
  100% populated. So was `job_cards.actualMinutes`, whose 4,289 populated values are copies
  of their own `estMinutes`. Ask "what code path could ever have OBSERVED this?" — if there
  is none, coverage is zero however full the column looks.
* **A single-site source pin is not a pin.** The guard protecting the surviving real metric
  matched one of the two places the formula lives, and stayed green while the other had its
  denominator swapped for a literal. Count occurrences; do not `assert.match` a formula that
  appears more than once.

**Finding these two shapes.** For an action: follow the endpoint to the TABLE it writes, then
grep for a reader of that table — a write nobody reads is inert however healthy the HTTP
status. For a tick: substitute the definition of each term into the predicate and see whether
it collapses.

> Every assertion in the 2026-08-13 files was proved by **reintroducing the bug
> and watching the guard go red**. Do that for any row you add: four of these
> guards passed on their first draft while the bug was still in the file, because
> the pattern was anchored to the wrong text.

**Finding the next one.** Grep is a starting point, never a verdict — follow the
call chain before concluding. Look for: `Math.random`, `seed(`, a literal
money/percent reaching JSX, a metric defined as a fixed multiple of another, a
comment containing *mock / TODO / placeholder / stub / for now / estimate* within
a few lines of a returned value, a guard whose "no data" branch returns a number
instead of `null`, and a column whose input **has no writer**. That last one is
the trap: a column can be fully populated and still meaningless —
`job_cards.actualMinutes` is non-null on 4,289 rows and every one is a
byte-identical copy of that card's `estMinutes`. **Check the distribution, not
the NULL rate.**

---

## C16 — a field the projection drops and a consumer still reads

**Shape.** A slim `?fields=` / `include=` projection is introduced for payload size, its
author greps each consumer for the one field they had in mind, and every OTHER field the
page reads off that response silently becomes `undefined`. Nothing throws: a missing key
renders `-`, or `RM 0.00`, or — the dangerous case — flips a guard, because `!undefined`
is `true`.

**Why it keeps happening.** The projection is a plain object literal and the consumer's
read is `po.someField` against a hand-written inline type, so `tsc` cannot see the gap
(`DataGrid`'s `Column<T>.key` is `string`, not `keyof T`, for the same reason). And the
slimming commit reads as careful precisely *because* it audited something — b7d00c78's
message says *"based on a grep of what each file actually reads"*; it grepped for
`.jobCards`.

**The rule.** When you narrow a projection, enumerate the consumer's reads, not the field
you are removing. And pin the projection's **whole key set** in a test, so the next
narrowing has to state what it is dropping.

**Instances**

| # | field | projection | consumer | state |
|---|---|---|---|---|
| 1 | `stockedIn` | `rowToMinimalPO` | `warehouse.tsx:610` Stock-In dropdown | ✅ 2026-08-13 (-050) — **the reason this class exists**: `!po.stockedIn` was always true, so one delivery could be racked twice and write a second `STOCK_IN` |
| 2 | `actualMinutes` | `slimJobCardsToPlanningLite` | `planning/index.tsx` ×8 | ⬜ **deliberately left dropped** — restoring it resurrects a 100%-by-construction efficiency figure (C15 row 1 / BUG-2026-08-13-005). The fix owed here is removing the `useActual` branch, not the field |
| 3 | `notes`, `rackingNumber` | `rowToMinimalPO` | `planning/index.tsx:2825`, `:2866` | ⬜ open, display-only — two Master Tracker columns permanently `-`. `notes` is free text on the hottest payload; `rackingNumber` at PO level is the value the DO side deliberately rejects as lossy (`delivery/index.tsx:1556-1562`), so filling the CN twin is a decision |
| 4 | `rackingNumber` | `rowToMinimalPO` → `buildCnReadyPlanning` | `src/lib/delivery-pipeline.ts:486` | ⬜ open, display-only — CN ready/planning rows carry `""` |
| 5 | `createdAt` | `rowToMinimalPO` | `production/index.tsx:2862` | ⬜ open — `?axis=created_at` is a silent no-op; URL-only since the dropdown was removed 2026-05-07 |
| 6 | `finishedGoods` / `finishedProducts` | `/api/inventory` | `suppliers/detail.tsx:214` | ✅ 2026-08-13 (-024) — and note the fix was to DELETE the read, not rename it; the two payload halves are different entities |
| 7 | `regNo` / `tin` / `address` | the PERMISSION projection on `GET /api/organisations` | `letterheadForPurchaseOrg` → the PO / GRN / PI letterhead | ✅ 2026-08-13 (-100) — caught **before** merge, by looking for this class rather than by an incident |

**Row 7 adds an axis: a projection can be narrowed by PERMISSION, not only by payload
size, and it is the more dangerous variant.** The slim-payload kind at least drops the same
fields for everyone, so a broken screen is broken for the author too. A permission
projection drops them for *some* callers, so the author — usually an admin — cannot
reproduce what the affected role sees. Row 7's consumer would have printed
`Reg.  | TIN ` on a tax-relevant document for QA users only.

**Corollary (from row 7): OMIT the key, do not blank it.** `letterheadForPurchaseOrg`
reads `org.regNo ?? ""`, so an empty string is indistinguishable from a real one and the
consumer proceeds. An ABSENT key is a fact the consumer can test, which is what lets
`hasLetterheadDetails` (`src/lib/org-letterhead-row.ts`) fall back to the hardcoded
letterhead. Where the reduced shape is not obvious from the rows themselves, say so at the
envelope — that endpoint sets `restricted: true`.

**Enforced by** the key-set assertion in `tests/minimal-po-stocked-in.test.mjs`, which
pins every field `rowToMinimalPO` emits and asserts value-for-value agreement with
`rowToPO` on all shared keys. Dropping any field from the minimal PO projection now fails
CI with the list. Row 7 is enforced by
`tests/organisations-registry-projection.test.mjs`, which asserts each withheld key is
`!(key in org)` — absent, not empty — and separately runs `hasLetterheadDetails` against a
reduced row. **Other projections have no such guard yet** — add one in the same commit as
any new `?fields=` variant.

**Finding the next one.** For each `?fields=`/`include=` caller, diff the projection's
key set against every `x.` read on the response object in that file. Follow the call
chain: a field can be read inside a shared helper the page merely passes the row to
(`delivery-pipeline.ts` reads `po.rackingNumber` off a payload assembled two modules
away), and a grep of the page alone will miss it.

---

## C17 — a file the search tool refuses to read

**Shape.** A source file contains a raw **NUL byte** — almost always someone typing
`U+0000` straight into a template literal as a composite map-key separator instead of
writing the escape `\u0000`. GNU `grep` then classifies the file as **binary**: it
answers `Binary file matches` and prints **nothing**. Every grep-driven audit skips
the file in total silence and reports it clean.

**Why it is the nastiest entry in this file.** Every other class here is a bug in the
PRODUCT. This one is a bug in the INVESTIGATION — it does not make anything wrong, it
makes wrongness invisible, and it does so on exactly the files a search would otherwise
have found something in. `accounting.ts` (13,064 lines, the money module) carried one
and had never been read by any grep-based pass.

**It is tool-dependent, which is why it survives.** `rg`, `git grep`, `git diff` and the
Read tool are all unaffected. Whether the largest unreviewed surface in the repo is
visible depends on which binary you happened to reach for.

| # | file | fixed | what the byte was |
|---|---|---|---|
| 1 | `src/api/routes/accounting.ts` | ✅ 2026-08-13 (`a9d413f6`) | unresolved-line map key |
| 2 | `src/lib/ap-recon.ts` | ✅ 2026-08-13 (-084) | `` `${sourceType}<NUL>${sourceId}` `` — the AP-drift engine |
| 3 | `src/lib/pnl-historical.ts` | ✅ 2026-08-13 (-084) | `` `${code}<NUL>${name}` `` |
| 4 | `src/api/lib/keyset.ts` | ✅ 2026-08-13 (-084) | `const SEP` ×3 (two of them inside a comment) |
| 5 | `src/api/lib/ocr-code-misses.ts` | ✅ 2026-08-13 (-084) | two composite keys |
| 6 | `docs/WORK-TRACKER.md` | ✅ 2026-08-13 (-084) | a **stray** byte in prose — and this is the file every session is told to read first |

Row 1 is why this class exists: that fix repaired the one file its author was reading and
nobody counted the rest, which is the pattern this whole document was written for.

**The rule.** *Never a raw NUL in a tracked file.* Write `\u0000` — identical at
runtime — `\u0000` denotes exactly the character `String.fromCharCode(0)` produces — and visible to every tool. Apply the
replacement at BYTE level: a utf8 round-trip plus a lint pass rewrites line endings and
turns a one-line change into an unreviewable whole-file diff.

**Expect a whole-file diff anyway, once.** While the NUL is there git stores the blob as
binary and keeps CRLF verbatim; without it the file is text and normalises to LF. That
EOL churn is genuine and one-time — `git diff --ignore-cr-at-eol` shows the real change.

**Enforced by** the NUL walk in `tests/accounting-subledger-parity.test.mjs`
(`src/ docs/ tests/ scripts/ functions/`, all text extensions). Proved red by putting a
byte back into `ap-recon.ts`.

---

## C18 — a per-party document and its all-party twin, only one of them maintained

**Shape.** The same subsidiary ledger is served by TWO endpoints: one **per party** (the
statement you print and send) and one **over all parties** (the report the accountant
reads). They are written months apart from the same line model, so each carries its own
copy of the source queries — and a filter added to one is not added to the other. The
divergence is invisible from either screen alone; you have to open both, for the same
party, and compare.

**Why it survives review.** The two files read as one feature. The all-party version's
own header even says *"Same line model as the per-party statement, looped over all
parties in a single pass"* — which is true of the maths and false of the queries.

| # | pair | the filter one had and the other did not | state |
|---|---|---|---|
| 1 | `/customer-statement` vs `/debtor-ledger` | lifecycle VOID/DELETED receipts | ✅ 2026-08-13 (-080) |
| 2 | `/supplier-statement` vs `/creditor-ledger` | lifecycle VOID/DELETED payments | ✅ 2026-08-13 (-080) |
| 3 | `/ap-control` vs `rebuildApCounterSen` | the PI status set each one sums over (`CONFIRMED/APPROVED/PARTIAL_PAID` vs *everything but DRAFT/CANCELLED*) — legitimate, but it is what turned BUG-2026-08-13-081 into a permanent drift on one card and not the other | ✅ by fixing the writer, not the readers |
| 4 | `/ar-control` vs `/ap-control` · `/ar-reconciliation` vs `/ap-reconciliation` | — | ✅ checked 2026-08-13, no divergence found |
| 5 | `/payment-vouchers` vs `/official-receipts` | OR has no `/restate` endpoint, PV does | ⬜ owner decision, not a defect |

**The rule.** When you add a predicate to one subsidiary-ledger surface, open its twin in
the same commit and diff the query — not the file. And when the two must agree on a
FIGURE, pin the figure in a test for **both**, not the clause in one.

---

## C19 — a typed money string read by a parser that stops at the first character it dislikes

**Shape.** A money field is `type="text"` (or a plain `<input>` with no type at all),
its value goes to `parseFloat`, and `parseFloat` returns the digits BEFORE the
separator with no error and no `NaN`. `parseFloat("12,000") === 12`. The document
saves, the toast says success, and the figure on the ledger is three orders of
magnitude out.

**Why it keeps happening — and why it is worse than it looks.**

1. **The browser was doing the protecting, and nobody wrote that down.** On a
   `type="number"` input the comma never reaches the parser, so the identical line of
   code is harmless there and fatal here. Nothing in the source connects the two —
   the input type is in the JSX, the parser is in a handler fifty lines away.
   Measured 2026-08-13: `src/pages/accounting/index.tsx` has **119 money inputs and
   NOT ONE is `type="number"`**.
2. **The wrong value is PLAUSIBLE.** Every other money defect in this file announces
   itself somewhere — a 500, a mismatch, a negative row. RM 12.00 is a valid asset
   cost. It reconciles, it depreciates, it reports. Only the person who typed it
   knows.
3. **Fixing it invites the same bug in a new shape.** The strict parser returns
   `null`, and the shortest way to make that compile is `?? 0` — which books RM 0.00
   just as silently. The fix is not a better parser; it is a REFUSAL.
4. **Everyone who noticed fixed their own copy.** Seven separate money parsers had
   grown across the front end, each handling a different subset (one stripped commas
   but not spaces, one stripped commas in `onChange` only, one stripped `RM` too, one
   wrote `null` on failure — which its route read as *"clear the field"*).

**The rule.** *One parser: `parseMoneyInput` / `parseMoneyToSen` (`src/lib/parse-money.ts`),
reached through `src/lib/money-field.ts`. A blank box is `0`. An unreadable box is
`null`, and the caller REFUSES — names the field, quotes the value, returns before
composing a payload, and does not STATE a total it had to substitute a 0 into.*
`type="number"` does not exempt a site: converting it costs nothing and stops the
component being reused with a text input, which is how this class spreads.

| # | surface | state |
|---|---|---|
| 1 | `accounting/index.tsx` — Fixed Assets (the reported instance), Landed Cost, Fund Transfer, Opening Balance, Stock Take, other-party bills, payment allocation, payment vouchers, official receipts, bank-CSV import | ✅ 2026-08-13 (-095) |
| 2 | the six hand-rolled `.replace(/,/g, "")` parsers — `rd/detail.tsx`, `rd/index.tsx`, `forecast.tsx`, the bank-CSV `parseAmt`, `batch-import-dialog.tsx`, `assistant-tools.ts` | ✅ 2026-08-13 (-095) except `assistant-tools.ts`, which parses a string IT formatted for a sort key — no operator input, left alone |
| 3 | `type="number"` money sites across invoices / procurement / customers / products / inventory / employees | ✅ 2026-08-13 (-095) — defence in depth, never live; they DID write `NaN` into a price on unreadable input, which the conversion also removes |
| 4 | `components/ui/money-input.tsx` | ✅ 2026-08-13 (-095) — **never a live bug** (`type="number"`); converted so the guard survives the input type changing |
| 5 | the SERVER side | ⬜ unswept. This pass is front-end only. A route that does `Number(body.amountSen)` on a client-supplied money string is C1's territory, not this one, but the same "plausible wrong number, no error" property applies |
| 6 | `invoices/detail.tsx` price editor (`sen = Math.max(0, Math.round((Number(s) || 0) * 100))`) | ⬜ open, not a `parseFloat` site. `Number("12,000")` is `NaN` → `0`, so it fails to ZERO rather than to 12; the input is `type="number"` and its drafts are machine-serialised, so it is latent. Convert when that editor is next touched |

**Enforced by** `tests/money-input-parsing.test.mjs` — a per-file pin that no
executable `parseFloat` returns to the 17 fully-converted files; an ALLOW-LIST naming
the exact non-money identifiers still permitted to reach `parseFloat` in the 5 mixed
files (so a money field cannot quietly join them); a refusal check per submit path
that brace-matches the guard's own block; the `"—"` abstention check; and a BUDGETED
count of every surviving `?? 0` on a money parse, so shape 3 above has to be argued
for rather than merely typed. Behaviour is proved separately in
`tests/parse-money.test.mjs`.

> Nine mutations were run against that file to prove it fails when the bug is back.
> One did **not**: the "the guard must `return`" assertion searched a fixed
> 400-character window and passed with the `return` deleted, because a handler has
> other `return`s within 400 characters. It now brace-matches the guard's own block.
> Same lesson as C8 and C9 — a guard nobody has watched fail is not a guard.

**Finding the next one.** Do not grep for `parseFloat` and start converting: most hits
are quantities, percentages, hours, dimensions and CSS pixels, and converting those is
a behaviour change nobody asked for. Grep for the INPUT instead — a money-labelled
field whose element is not `type="number"` — then follow its state to whatever parses
it. And ask the question that actually decides it: *if this box gets a comma, what
number reaches the database?*

---

## C20 — a measurement thrown away at the moment of capture

> **SCOPE, set by the owner 2026-08-14.** This class is about a value the code **held and
> discarded** (row 1: the completion instant). It is **NOT** a licence to treat standard costing
> as a defect. Hookka credits a completing worker the **BOM standard time** on purpose and does
> **not** compute elapsed start→end duration, so `production_time_minutes = est_minutes =
> actual_minutes` is the model working as designed. Row 3 below was mis-filed as open on that
> basis and is now closed. Read
> [`docs/context-packs/HOOKKA-GOTCHAS.md`](context-packs/HOOKKA-GOTCHAS.md) §"PRODUCTION TIME IS
> STANDARD TIME, BY DESIGN" before adding a row here about a production-time column.

**Shape.** The code holds a precise value, uses a coarser projection of it for the column it is
writing, and never stores the precise one. `nowIso.split("T")[0]` is the canonical instance: the
full instant is in a local variable, one line above the write, and only the date survives. The
write is CORRECT for the column it targets — `completed_date` really is a date — so nothing
about the line looks wrong, and nothing ever fails.

**Why it is worse than a wrong value.** A wrong value can be recomputed once someone notices. A
value that was never recorded is gone: no query, no audit table, no re-derivation and no amount
of later cleverness can recover it. C15 is about a number that reads as measured and is not —
this class is the reason such numbers exist. When the only real input has been discarded, every
downstream figure MUST be an estimate, a constant or a ratio of itself, and the person writing
that dashboard has no honest option available. Fixing C15 at the display layer without fixing
this leaves the screen saying "—" forever.

**How it hides.** Three ways, all of them structural:

1. **It never errors and never looks lossy.** `completed_date` is date-only by design; the
   truncation is the intended shape for THAT column. The defect is the absence of a second
   column, and an absent column has no text to grep for.
2. **The count looks healthy.** `job_cards.actual_minutes` is non-null on 4,289 rows (measured
   2026-08-14; **UNMEASURED since**) and every one is byte-identical to that card's
   `est_minutes`. Populated, plausible, and carrying no *additional* information — the shape
   C15's closing note warns about: check the DISTRIBUTION, not the NULL rate. **Here the
   distribution is the answer, not the bug** (see the scope box above); keep the technique,
   drop the verdict.
3. **The other end of the interval is fine.** `distributed_at` stores a full instant, so the
   data model LOOKS like it supports duration maths. Only when you try to subtract do you find
   one end rounded to the day.

**The rule.** *When a write coarsens a value the code already holds precisely, and the precise
value is the only evidence of an event, store the precise one too — in its own column, beside
the coarse one, never instead of it.* Three corollaries, each of which cost something here:

* **Additive, never a reinterpretation.** The coarse column has consumers who depend on its
  shape (`completed_date` is compared with `substr(…,1,10)` in a dozen queries and filtered by
  range in the dept sheets). Widening it in place is a different, bigger change with its own
  blast radius; adding a column beside it is not.
* **Only OBSERVE — never derive the precise value from the coarse one.** A backfill that turns
  `2026-08-14` into `2026-08-14T09:00:00.000Z` produces exactly the C15 figure the capture was
  supposed to make unnecessary. Historical rows stay NULL, visibly.
* **The pair must be written by the SAME statement.** Otherwise one moves without the other and
  a stale instant outlives the completion it described — a card that is re-dated, un-completed
  or QC-blocked would still hand a reader a duration.

| # | discarded value | where | state |
|---|---|---|---|
| 1 | the completion INSTANT — 14 `.slice(0, 10)` / `split("T")[0]` truncations across the production + worker write paths | `job_cards.completed_date` | ✅ 2026-08-14 (BUG-2026-08-13-120) — `job_cards.completed_at` added beside it, written by the four observing paths only |
| 2 | `attendance_records.production_time_minutes = working_minutes × 0.85` — the clocked span was recorded, the productive part of it never was | `attendance.ts` | ✅ 2026-08-14 by a separate change (BUG-2026-08-13-103, filed under C15 row 28). Listed here because it is the SAME root: a punch measures presence, and no writer ever measured production, so the only available figure was a ratio of the one number that WAS captured. That fix removed the false figure; **row 1 is what gives the replacement something real to divide** |
| 3 | `job_cards.actual_minutes` — written as a copy of `est_minutes` by every path that sets it (`import-completion/_shared.ts:493` → `jc.productionTimeMinutes \|\| jc.estMinutes`; `completion-cascades.ts:424,858` and `wip-fixes.ts:116,456` → `productionTimeMinutes ?? estMinutes ?? 0`) | `import-completion/_shared.ts` and the cascade backfills | ❌ **NOT A DEFECT — closed by owner ruling, 2026-08-14.** Hookka runs **standard costing**: the BOM time IS the production hours, and a completing worker is credited that standard time; elapsed start→end duration is deliberately not computed. So `actual_minutes = est_minutes` is the intended model, not a copy someone forgot to replace. **Do not "fix" it** — read [`docs/context-packs/HOOKKA-GOTCHAS.md`](context-packs/HOOKKA-GOTCHAS.md) §"PRODUCTION TIME IS STANDARD TIME, BY DESIGN" before touching this column. *(This row was flagged OPEN — "the NEXT one" — until 2026-08-14, which ordered the opposite of what GOTCHAS orders — two required-reading docs pointing opposite ways on one column. Reopening it is the owner's call, not an engineer's.)* |
| 4 | the rest of the app | ⬜ unswept. The shape to look for is a `.slice(0, 10)` / `split("T")[0]` / `Math.round` / `toFixed` applied to a value the code obtained precisely, where nothing else stores the precise form |

**Enforced by** `tests/job-card-completed-at.test.mjs`. Four things, all EOL-agnostic (these are
CRLF files; a literal `\n` anchor matches nothing and reports clean): the decision function is
property-tested over its whole input cross-product to prove it can only return the instant it
was handed or null — never one derived from a date; a source sweep over ALL of `src/api` fails
any statement that writes `job_cards.completedDate` without writing `completedAt` in the SAME
statement (and asserts it found at least 15 such statements, so a broken extractor cannot make
the guard vacuous); the four observation sites must bind `nowIso`, not `today`; and no statement
anywhere may write a full instant into `completed_date`. Every assertion was proved RED by
reintroducing the bug, with the mutation asserting the bytes on disk changed first.

**Finding the next one.** Do not grep for `slice(0, 10)` and start converting — most hits are
formatting a date for display, which is correct and changing it is a regression nobody asked
for. Ask instead: *what event does this row record, and is the row the only evidence it
happened?* If yes, check whether the code held something more precise at the moment it wrote.
The tell is a sibling column that IS precise (`distributed_at` next to `completed_date`,
`last_scan_at` next to a date) — a table that measures one end of an interval to the millisecond
and the other to the day cannot answer the question it looks like it can.

---

## C21 — first-one-wins: taking `[0]` when several rows could answer

**Shape.** Code needs ONE row. Several could answer, or none exactly does, and it takes the
first: `xs.find(exact) ?? xs[0]`, or a `.find` on a key that is not unique. The pick is
silent, and it is not even stable — `WHERE id IN (...)` and a `.filter` carry no order
anyone chose. Every consumer downstream then reads the result as if it had been *looked up*.

**Why it is the expensive direction.** A MISSING answer says "cannot check". A WRONG answer
says "checked, all fine". The first is a bad day; the second is how a mispriced receipt gets
a `FULL_MATCH`, a worker completes a card they never scanned, and an audit reports clean over
a comparison that did not happen. BUG-2026-07-17-001 named this class ("first-one-wins
guess") when three invoice lines inherited one sales order's customer PO.

**The rule — count the claimants and REFUSE.** The reference implementation is
`src/api/lib/invoice-so-item-link.ts`: exactly one match → link; contested → NULL **with a
reason**; and no fall-through from a tight key to a looser one, because *a key that two rows
answer to does not become decidable by asking a vaguer question*. `src/api/lib/grn-po-line-link.ts`
applies the same discipline to the receipt → purchase-order-line link.

> **Being the ONLY candidate is an observation. Being FIRST in a list of several is a guess.**
> So `xs.length === 1 ? xs[0] : undefined` is legitimate and `?? xs[0]` is not — and the
> single-candidate branch is what keeps every legacy single-document flow bit-identical.

**⚠ Not every `[0]` is this class.** Three shapes are fine and "fixing" them is a regression:

* a **visible, editable default** on a form the user is about to review (`defaultBankCode`,
  the BOM template picker, the main-supplier pre-fill — the full candidate list is rendered
  beside it);
* a **display truncation that admits it** — `accounting.ts:11043` prints `"Cash +2"`, so the
  reader can see something was dropped;
* a **deliberate one, labelled as deliberate** — `priceForItem`'s maps in `do-value.ts` are
  first-one-wins on purpose, because for a PRICE LOOKUP any matching line's value will do.
  Its identity twin next door counts instead, and both say so in comments. If that annotation
  disappears, the next reader "fixes" the wrong one.

The dangerous shape is a fallback to `[0]`, **or a match on a NON-UNIQUE key**, deciding
IDENTITY or MONEY.

| # | site | what `[0]` decided | state |
|---|---|---|---|
| 1 | `three-way-match.ts:590/596/600` — `pos.find(p => p.id === grn.poId) ?? pos[0]`, then a POSITIONAL index into that order | the PO **price** a receipt line is matched against | ✅ 2026-08-14 (BUG-2026-08-13-144) — `grn-po-line-link.ts`; unresolved lines price NULL, carry a `resolution`, and cannot reach `FULL_MATCH` |
| 2 | same site — `poItemIndex` read against `ORDER BY id` while `grn.ts:930` reads it against `PO_ITEMS_ORDER` | which PO line was **priced** vs which was **drawn down** | ✅ 2026-08-14 (BUG-2026-08-13-144) — both now read `PO_ITEMS_ORDER` |
| 3 | `worker/scan.tsx:1010` — `matches.find(exact) ?? matches[0]`, then `wholeCard: true` | which job card a worker **completes** | ✅ 2026-08-14 (BUG-2026-08-13-145) — sole claimant only |
| 4 | `worker.ts:687` + `public-rack-qr.ts:337` — `cand.find(deriveBarcodeToken(...) === term)` over EVERY card in a dept | which physical piece a scan refers to, and which card a stock-in is stamped with | ✅ 2026-08-14 (BUG-2026-08-13-146) — `filter` + `length === 1`, refusal logged |
| 5 | `production-orders.ts:2063` — `slots.find(s => s.pieceNo === pieceNo) ?? slots[0]` | which **piece** gets completed and who is credited | ✅ 2026-08-14 (BUG-2026-08-13-147) — sole-slot cards only |
| 6 | `production/scan.tsx:186` — `order.jobCards.find(IN_PROGRESS\|WAITING) \|\| order.jobCards[0]` on a PO-number search | which job card the production floor opens | ⬜ **open** — same shape as row 3 on the desktop scan page. Not touched on 2026-08-14 because `src/pages/production/` was owned by another branch that day |
| 7 | `service-cases/detail.tsx:270` — `hubs.find(h => h.isDefault) ?? hubs[0]` | the **Deliver-To address printed** on a service report | ⬜ **open, and it is also C3.** C3's rule is *derive the hub from the document's own contents* — the case's SV orders carry one. Left for the owner: whether a service report may print a hub the customer never flagged is a judgement call, not a provable defect (owner rule: ask when unsure) |
| 8 | `admin.ts:1229`, `delivery-orders/_helpers.ts:1419` — `inv.salesOrderId ?? soIds[0]` as `priceForItem`'s `fallbackSoId` | a price, but only for lines with **no production-order link** | ⬜ **deliberate, do not "fix" in isolation** — this is `priceForItem`'s documented first-one-wins, whose last resort is `byAnyCode` anyway. Closed as the price half of BUG-2026-07-17-001 (2026-08-07) |
| 9 | `delivery-orders/_helpers.ts:1741`, `delivery-orders.ts:1651` — `doRow.salesOrderId \|\| soIds[0]` | the **header** SO id on a combined invoice | ✅ benign, and labelled in place: the authoritative link is `deliveryOrderId`, and identity is per-line via `invoice_items.so_item_id` |
| 10 | `worker/scan.tsx:1107` — `?? wkCards[0]` | which card of a compartment is DISPLAYED | ✅ benign: `wkCards` is already filtered to ONE production order **and** ONE `wipKey`, so every candidate is the same physical compartment, and the server decides the completion from the worker's token |
| 11 | `purchase-invoices.ts:1178`, `sales-orders.ts:1653` — `?? dupNums[0]` | which reference is **named** in a duplicate-rejection message | ✅ benign: the `.find` covers the real case and the authoritative `duplicateOf` is exact. (Sub-note: their `LIMIT 1` has no `ORDER BY`, so with two duplicates it names an arbitrary one — still a rejection either way) |
| 12 | `mail-center.ts:401` — `recipients.find(/@hookka\.com/) \|\| recipients[0]` | which mailbox an inbound email is filed under | ✅ low-risk: a stated preference rule, no configured mailbox matched, and the message is stored intact |
| 13 | UI selection defaults — `default-bank.ts:12`, `bom.tsx` ×6, `procurement/{create,detail,index}.tsx` + `pi/create.tsx` (`bindings.find(isMainSupplier) ?? bindings[0]`), `employees.tsx:5376`, `finance-dashboard.tsx:549`, `leads/index.tsx:402`, `m/FormSheet.tsx:527`, `m/ModuleListScreen.tsx:220-221`, `mail-center/index.tsx:3301`, `maintenance/sofa-combos.tsx:1212`, `inventory/index.tsx:2607`, `scan-supplier-modal.tsx` ×4 (`activeOrgs[0]?.code ?? "HOOKKA"`) | a **pre-filled** value the user sees and can change before saving | ✅ benign — see "Not every `[0]` is this class" above |
| 14 | `accounting.ts:11043` (`others[0]` + `"+N"`), `delivery-orders.ts:2274` (error text) | display only, and the truncation is visible | ✅ benign |
| 15 | grep false positives — `web-push.ts:107` (`pub[0] !== 0x04`, a byte), `do-component-breakdown.ts:102` (`a[0]`/`b[0]`, Map-entry tuples in a comparator), `sales/index.tsx:250-251` (`_flStatus[0]`, "any filter active?") | nothing | ✅ not this class |

**Enforced by** `tests/first-one-wins-refusal.test.mjs` — 8 behavioural assertions driving
the pure resolver with adversarial fixtures (two orders with the SAME line count, so a
positional read against the wrong one *succeeds* instead of falling off the end: that is what
made row 1 silent), plus structural assertions at each of rows 1–5 and one that keeps row 8's
"deliberate" annotation alive. Every pattern is written with `\s` / `[\s\S]`, never a literal
newline — this tree is CRLF. All 23 mutations proved RED with the file's bytes asserted
changed on disk first, and that run caught a **blind** assertion: `await ensurePoItemLineNo(...)`
matched as a bare substring and stayed green with the call commented out. **A guard that
matches a substring is not a guard** — anchor it to the line (the same trap C4 and C15 record).

**Blast radius on prod is UNMEASURED** — this branch had no database credential.
`scripts/check-first-one-wins-blast-radius.mjs` (read-only) counts rows 1–5's exact
conditions, including persisted `three_way_matches` verdicts broken down by `matchStatus`,
because a `FULL_MATCH` over a guessed price is the only row that actively asserts correctness.

**Finding the next one.** `?? xs[0]` / `|| xs[0]` finds the obvious half. The other half has
no `[0]` in it at all: a `.find` on a key that is not unique — a truncated hash, a product
code inside the wrong scope, a `LIMIT 1` with no `ORDER BY`. Ask of every such lookup: *if
two rows answered, would anything downstream notice?* If the answer is no, it belongs here.

---

## What tests cannot catch — and what covers it

None of C1–C4's money leaks were introduced by a code change on the day they started leaking:

- the height surcharge broke when the **scan flow became the main entry route**
- the price list drifted when someone **edited a price in Settings**
- 202 invoice lines under-bill because of **history**, not present-day code

Tests protect the code. Only a data check protects the data — `src/api/lib/pricing-integrity.ts`
runs the money invariants on every daily report:

| invariant | catches |
|---|---|
| `unit <> base + divan + leg + special` | C1, a dropped component |
| a priced height stored at 0 | C1, the scan-path leak |
| an issued invoice line under its SO line | history, revisions, partial fixes |

Had it existed in May, the RM 12,455 would have surfaced on day one instead of after ten weeks
and 105 mispriced lines.

---

## When you fix something here

1. Find its class above. If there isn't one, add it.
2. Fix **every ⬜ row**, or write why not.
3. Extend the class test so the next instance cannot be added silently.
4. Ask whether a data invariant would have caught it sooner — if yes, add it to
   `pricing-integrity.ts`.
5. Update the row: date, cost, and how it was verified.

*Sources: `BUG-HISTORY.md` (chronological detail), `WORK-TRACKER.md` (2026-07-22/23 audit),
`PLAYBOOKS.md` P5.*
