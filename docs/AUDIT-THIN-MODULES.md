# Audit — the four modules no dedicated sweep had ever covered

> **Last verified: 2026-08-13** against `src/api/routes/{rd-projects,rd-team-members,cash-flow,accounting,invoices,qc-pending,qc-inspections,qc-templates,warehouse,public-rack-qr,public-rack-write,public-do-qr,customers,customer-products,customer-maintenance,customer-hubs,customer-quotation}.ts`, `src/pages/{rd/*,quality,warehouse,rack-scan,do-scan,customers,accounting/cash-flow}.tsx`, `src/lib/cached-fetch.ts`, `src/api/lib/{db-pg,tenant,column-rename-map.json}`, `tests/db-schema.json` and `tests/db-boolean-columns.json`.
> Where a claim needed live data I say so and give the probe. **No prod session existed this session** — the login gate is closed and `.dev.vars` is rotated dead. Every "measured" number below is either executed locally or quoted from an in-repo measurement with its date.

A day of sweeps covered 11 of 15 modules deeply. **accounting** (cash-flow, journals,
aging, AR/AP), **customers**, **quality-warehouse** and **rnd** had only ever been touched
incidentally by cross-cutting passes. This is their dedicated review.

---

## Coverage — read this before trusting anything below

The point of this table is that **a module you believe was swept when it was not is worse
than a module openly marked unreached.** "Read" means every line; "read in part" names the
regions.

| Module | Verdict | Actually read | **Never reached** |
|---|---|---|---|
| **rnd** | ✅ **swept** | `rd-projects.ts` (2,261 — all handlers, both cost helpers, the full issuance/reversal path), `rd-team-members.ts`, `health.ts` (whole), `rd/index.tsx` (whole) | `rd/detail.tsx` (3,143 lines) read only via targeted greps + the budget/issuance regions; `rd/maintenance.tsx` **not opened** |
| **quality-warehouse** | ✅ **swept** | all 7 routes + 4 pages covered; I personally re-verified 7 load-bearing claims at both ends | the `/m` mobile WarehouseScreen; `qc-templates.ts` covered only by the delegated pass |
| **customers** | 🟡 **swept, thinly verified** | all 5 routes + `customers.tsx` covered | **see the caveat below — I personally re-verified only 1 of ~10 findings** |
| **accounting** | 🟠 **partially swept** | `cash-flow.ts` (whole), `accounting.ts` `/aging` + every `/journals*` handler + `rowToJournal`, `invoices.ts` invoice-create guard region + a whole-file snake_case sweep, `cash-flow.tsx` | **the bulk of the module — see below** |

### What in accounting was never reached

The brief scoped accounting to "cash-flow, journals, aging, AR/AP". Cash-flow, journals and
aging are done. **AR/AP is only half done**, and the rest of the module is untouched:

- **`/ar-control` (`:1672`) and `/ap-control` (`:2470`) — bodies never read.** I confirmed
  they exist and that `/ap-control`'s dual-keying is pinned by an existing test; I did not
  audit their arithmetic. The AR/AP *aging* computation (`/aging`) **was** read in full.
- **`/ap-reconciliation` (`:2704`) / `/ar-reconciliation` (`:2879`) — never read.**
- **`accounting.ts` is 13,054 lines and I read roughly 2,000 of them.** Never opened:
  trial balance (`:4792`), year-close (`:5235`), stock-summary (`:5819`), the FIFO engine
  `loadMaterialCostData`/`computePnlWindow` (`:6305`/`:7048`), `/pl-statement` (`:7578`),
  `/pl` + balance sheet (`:7840`), labour post (`:9499`), opening-balance post (`:12452`),
  stock-take (`:12617`), COA, debtor/creditor ledger, other-party bills.
- **`src/pages/accounting/index.tsx` — the 11,147-line mega-page hosting ~30 tabs — was
  never opened at all.** Every finding I report on the accounting *UI* comes from
  `cash-flow.tsx`, a different file. Note main has since landed a UI-English fix in this
  file (#300); it does not overlap my commits.
- **Never opened:** `payments.ts`, `e-invoices.ts`, `cost-ledger.ts`, `stock-value.ts`,
  `stock-accounts.ts`, and the invoices / credit-note / debit-note / supplier-payment
  **pages**. `supplier-payments.ts` and `invoices.ts` were grepped for the snake_case class,
  not audited.

**A second accounting pass is owed**, and the P&L/FIFO engine and the mega-page are where
I would start — they are the largest unreviewed money surfaces in the repo.

### Caveat on customers, and on quality-warehouse

Those two modules were swept by delegated agents working from an explicit brief; I
re-verified by reading both ends myself before acting. Concretely:

- **quality-warehouse — 7 claims re-verified by me:** the `?? "PASS"` fabrication and its
  consumer, the C14 quadratic and its prod scale, `performedBy: "Warehouse Staff"`, the
  `companySOId` layer mismatch, the dead `insp.department` fallback, the rack-id/UUID
  question, and the occupancy metric — which I **rejected** as a finding (see Cleared).
- **customers — only the `orgId` finding was re-verified by me**, and it is the only
  customers change I shipped. **C1–C5 below are delegated findings I did not personally
  re-read at both ends.** Treat them as leads with file:line to check, not as established
  fact. That is exactly why none of them were fixed.

Rejecting one delegated claim (occupancy) is the evidence that these were filtered rather
than relayed — but one rejection is not proof the rest are right.

### What "verified" means here

**No prod session existed.** Nothing below was observed on a running system. The strongest
evidence I have is of three kinds, and I label which applies:

1. **Executed locally** — e.g. `columnFrom()` run against the real rename map. This is why
   A1 and the `createdAt` fix are stated as fact.
2. **Read at both ends** — producer and consumer opened, call chain followed.
3. **Quoted from an in-repo measurement**, with its date (e.g. the 2,839-row QC backlog,
   measured on prod 2026-08-01 and recorded in `quality.tsx`).

Anything needing live data carries a one-line SQL probe instead of a number.

---

## What changed (5 fixes, 4 commits)

| # | Module | Fix | Why it was safe to land |
|---|---|---|---|
| 1 | quality-warehouse | **C14** — bucket `qc_inspection_items` by inspection in `GET /api/qc-pending` (~80M comparisons/load) | mapper keeps its internal `.filter()`, so byte-identical by construction; guard proved red→green |
| 2 | quality-warehouse | **C15** — stop emitting a literal `"PASS"` verdict and a literal `"UPHOLSTERY"` department for NULL rows | worst case is a no-op (if no NULLs exist); cannot make anything worse |
| 3 | customers | **C12 row 7** — stamp `orgId` on the customers INSERT | `DEFAULT_ORG_ID` and the column DEFAULT are both `'hookka'` → byte-identical today |
| 4 | accounting | dual-key `createdAt` in `rowToJournal` | nothing renders the field yet, so no consumer can break; closes a typed-but-absent trap |
| 5 | rnd | **C15 row 3** — `/rd` no longer prints "All active projects are on track and within budget. ✓" over a dead fetch | additive; success path untouched, cached data still shown |

**Gates:** `npx tsc -p tsconfig.app.json --noEmit` exit 0 · `npx eslint <changed>` 0 errors ·
`npm test` **3,851 pass / 0 fail / 3 skipped**. **NOT DEPLOYED.**

---

## Method note — how a wrong answer nearly got produced here

Twice, and both are worth recording because both were *comments*:

1. `cash-flow.ts:154-156` states that `bank_accounts` / `bank_transactions` "were never
   created in the Supabase schema". I was one step from filing "Current Cash is
   structurally RM 0.00". **`tests/db-schema.json` shows both tables exist** (8 and 11
   columns). The comment is stale; the finding it would have produced was wrong.
2. `_helpers.ts:565-567` calls `delivery_incomplete` a "folded-lowercase runtime column",
   implying it survives the read transform. It does not — and the reason is exact:
   *folded* columns (`deliveredemailat`) have **no underscore** and pass through
   `postgres.toCamel` unchanged, while `delivery_incomplete` **has** one and is converted.
   The author's model is right for the columns it was formed on and wrong for this one.

Both were settled by **executing** `columnFrom` against the real rename map rather than
reasoning about it. That is the only reason finding A1 below is stated as fact.

---

## accounting

### A1 — 🔴 the "delivered with issues" billing hold never fires (VERIFIED, not fixed)

`src/api/routes/invoices.ts:1644` guards invoice creation with
`if (Number(doRow.delivery_incomplete) === 1)`. The SELECT at `:1579` names the column
bare, so Postgres returns it as **`deliveryIncomplete`** — `doRow.delivery_incomplete` is
`undefined`, `Number(undefined)` is `NaN`, and `NaN === 1` is **false**. The hold is dead:
a delivery marked DELIVERED WITH ISSUES can be invoiced.

Executed proof:

```
columnFrom('delivery_incomplete') -> deliveryIncomplete     # transform applied on BOTH
columnFrom('deliveredemailat')    -> deliveredemailat       # db-pg.ts branches, :105 / :118
```

**Not fixed, deliberately.** Repairing the read *starts blocking invoices that currently
succeed*. That is an operational change with a blast radius I cannot measure from here, and
it needs the owner. **Probe first:**

```sql
SELECT COUNT(*) FROM delivery_orders WHERE delivery_incomplete = 1;
```

`0` → the fix is a no-op today and safe to land immediately. `> 0` → each row is a delivery
that was invoiced past a hold the operator set, and those need review before the guard
goes live.

**Sweep the class, do not fix one file.** The same bare read appears at
`delivery-orders/_helpers.ts:566` (so the DO payload's `deliveryIncomplete` is always
`false` → the "invoice on hold" banner never renders), `_helpers.ts:4238`
(`wasIncomplete` always false) and `delivery-orders.ts:2746` (the resolve-incomplete
endpoint would refuse every DO). The **write** side is fine — `_helpers.ts:4597` uses
snake_case in SQL. So the flag is being set correctly and read by nobody.

### A2 — 🔴 Cash Flow's "AP Outflow" is not AP (VERIFIED, not fixed)

`src/api/routes/cash-flow.ts:209-214` builds the outflow forecast from **`purchase_orders`**
bucketed by **`expectedDate`** — the expected *delivery* date — excluding only
`RECEIVED`/`CANCELLED`. It feeds `forecast[].apOutflowSen`, `summary.totalOutflowsSen`,
`summary.netCashFlowSen` and the cumulative `runningBalanceSen`, and is rendered as the
column header **"AP Outflow"** (`src/pages/accounting/cash-flow.tsx:268`) and the KPI
**"Expected Outflows (12w)"** (`:178`). Route reachable: `/accounting/cash-flow`,
`src/dashboard-routes.tsx:429`.

The logic is inverted at both ends: money is forecast out when goods are *scheduled to
arrive*, and a PO drops out of the forecast the moment it is `RECEIVED` — which is exactly
when a payable comes into existence. The real payable lives in `purchase_invoices`, which
this module already serves through `/ap-control` and `/aging`.

**This is the surviving twin of a fix already shipped.** BUG-CLASSES C15 row 5:
*"Accounts Payable Aging — aged unreceived POs by expected delivery date, not AP at all"*,
fixed 2026-08-13 (-010) on `/reports` › Financial. The same defect on the cash-flow page
was not touched. Not fixed here because choosing the replacement basis (PI due dates? PI
due dates plus un-invoiced GRNs?) is a finance decision, not a refactor.

### A3 — 🟡 `journal_entries` IS org-scoped in prod; the comment saying otherwise is wrong

`accounting.ts:1157-1162` states "journal_entries has no orgId column (it predates
multi-tenancy)" and uses that as the stated reason for not filtering. **`tests/db-schema.json`
shows `journal_entries` has `org_id`, and `journal_lines` has `org_id`.** So `GET /journals`
(`:1164-1176`) is unscoped by choice founded on a false premise, and `POST /journals`
(`:1218-1223`, `:1234-1236`) omits `orgId` from both INSERTs. C12, latent at one org.

### A4 — 🟡 `journal_entries.created_by` is client-supplied, defaulting to the literal `"admin"`

`accounting.ts:1216`: `const createdBy = body.createdBy || "admin"`. The real actor is
available and *is* used sixty lines below for the ledger leg
(`c.get("userId")`, `:1375-1378`). So the GL leg carries a true `actorUserId` while the JV
header it came from can say "admin". Attribution on a financial document should not be
client-settable.

### A5 — C14 row 9 confirmed still open, still deliberate

`accounting.ts:189` (`rowToJournal`'s `lines.filter(...)`) and `cash-flow.ts:185` both scan
the whole `journal_lines` table per entry, and both fetch it with no scope and no LIMIT on
the parent. Line anchors match the BUG-CLASSES entry. Genuinely cheap only because the GL
is unused (2 entries). **Do not "fix" it in isolation** — the class entry is explicit that
the child fetch must reuse the entries query's own `WHERE` as a sub-select, because that
query carries a `LEFT JOIN document_lifecycle` and a hand-written second predicate will
drift.

### Cleared, with evidence

- **`/aging` (`accounting.ts:465-729`) — clean, and visibly well-swept.** AR and AP both net
  face − paid; pre-opening rows are excluded through `rowBeforeOpening` /
  `apRowBeforeOpening`; unapplied supplier *and* customer advances enter as negative rows so
  the aging ties the 400-0000 / 300-0000 controls; the trade-finance block is kept separate
  by design; results are snapshot-cached with a `cacheKey` that partitions the consolidated
  read from each per-company read. Document numbers are read dual-keyed
  (`i.invoiceNo ?? i.invoice_no`).
- **Money is integer sen throughout** these routes. No float arithmetic on any path read.
- **`bank_transactions.is_reconciled` is not a C8 hazard.** It is an INTEGER column (absent
  from `tests/db-boolean-columns.json`, which lists all ten real BOOLEANs), the writes use
  SQL literals `0`/`1` rather than binds, and the read is `r.isReconciled === 1`. Consistent.
- **Bank tables exist in prod** — see the method note. `summary.currentCashSen` being 0
  would be a *data* question (`SELECT COUNT(*) FROM bank_accounts;`), not a schema one.
- **The cash-flow page's own failure state is honest** — `cash-flow.tsx:109` renders
  "Failed to load cash flow data.", not "No data". Not a C15 instance.
- **`getWeekStart` no longer 500s the whole forecast on an undated document**
  (`cash-flow.ts:83-92`), and both callers skip rather than crash.

---

## customers

> ⚠️ **C1–C5 are delegated findings that I did not personally re-read at both ends.** They
> carry file:line so they can be checked in minutes. Nothing here was fixed. The one
> customers finding I did verify myself is the `orgId` stamp, which shipped as -061.

### C1 — 🔴 four panels turn a failed request into a factual claim (reported, not fixed)

None of these check `res.ok`; a 403/500 carrying a JSON body sets state to empty and leaves
no error:

| producer | consumer | the false sentence |
|---|---|---|
| `customers.tsx:2434-2443` | `:2548-2557` | "No customer-specific sofa combos yet." |
| `customers.tsx:1673-1694` | `:1897`, `:1973-1977` | "Not seeded" + "Click **Copy from Master**…" |
| `customers.tsx:215-219` (`/api/products`, `failure` discarded) | `:3345-3348` | "All SKUs are already assigned to this customer." |
| `customers.tsx:2749-2761` | `:3008-3012` | "No scheduled or past price changes yet." |

The second row is the dangerous one: the remedy the panel offers on a *read* failure is a
button whose handler (`customer-maintenance.ts:81-89`) **unconditionally** upserts
`kv_config['variants-config:<id>'] = master`. A transient read failure can therefore end
with a customer's tuned prices overwritten by master. Not fixed here: this is four separate
fetch shapes across a 3,500-line page and belongs with the C15-row-3 list pass, which the
class entry says should be its own PR with its own before/after.

### C2 — 🟡 the customer-scope choke point is unbounded and org-blind

`src/api/lib/customer-scope.ts:117-121` runs `SELECT id, name FROM customers WHERE
salesperson_user_id IS NOT NULL AND salesperson_user_id <> ?` — no `orgId`, no LIMIT — on
**every scoped GET** under 11 route prefixes (`worker.ts:927`) and again on every customer
PUT. It then filters rows **by name**, so a same-named customer in a second tenant would
silently disappear from this tenant's lists. C12, latent, but it is the one query that
scales with every request in the app.

### C3 — 🟡 `?? 0` and `?? "PRICE_1"` rendered as measurements in the Fabrics tab

`fabric-tracking.ts:218,223` emit `priceTier: cached?.priceTier ?? "PRICE_1"` and
`soh: m?.soh ?? 0`; `customers.tsx:2065-2074` renders both. "Not computed" displays as
"zero stock", and a fabric with no cache row displays a confident "Price 1". Separately the
consumer types `priceTier` as only `PRICE_1|PRICE_2` (`:1624`) and renders
`=== "PRICE_1" ? "Price 1" : "Price 2"`, so a genuine **PRICE_3** fabric displays as
**Price 2**.

### C4 — 🟡 the credit-utilisation bar prints a green 0% for limit-less customers

`customers.tsx:3823-3838`: `pct = creditLimitSen > 0 ? (outstanding/limit)*100 : 0`, then
coloured `>80 red / >50 amber / else green`. A COD customer owing RM 50,000 renders as a
green "0%" bar. The **Available** column beside it handles the identical case honestly by
returning `—` (`:3854`) — so the correct treatment already exists one column over.

### C5 — 🟡 `POST /copy-from-master` is ~730 serialised round-trips

`customers.tsx:445-449` always posts without `productIds`, so
`customer-products.ts:857-863` falls back to `SELECT id FROM products` (all 365) and then
awaits two queries **per product** inside the loop (`:923-927`, `:940-946`). The batched
helper that fixed the same problem for the quotation export
(`resolveCustomerPricesAsOfBatch`, `:1111-1222`) already exists and was not reused.

### Cleared, with evidence

- **C9 (self-apply memo) — clean on all four helpers.** `ensureCustomerCompanyColumn`
  (`customers.ts:38-56`), `ensureCustomerGroupColumn` (`:146-161`), `ensureCustomerOemColumn`
  (`:210-229`) and `ensureCustomerStageColumns` (`customer-stage.ts:26-50`) each memoise a
  **boolean**, set **inside** the `try` **after** `await …run()`, with an empty `catch` that
  leaves the flag `false` so a failed round retries. This is the shape BUG-2026-08-04 was
  fixed to. *Cosmetic only:* three variables are still named `…Promise` while holding
  booleans — a name that invites the exact regression the comments warn about.
- **Every INSERT/UPDATE column in these five routes exists in prod**, checked against
  `tests/db-schema.json` through the rename map. The single exception was the missing
  `orgId` on the customers INSERT — now fixed.
- **The four KPI tiles are real measurements** (`customers.tsx:3678-3681`): row count, a
  sum over joined `delivery_hubs`, and two column sums. `outstandingSen` is genuinely
  ledger-owned — create force-writes `0` (`customers.ts:398-414`) and update pins it to
  `existing.outstandingSen` (`:578`), with the back-door removal documented at `:389-397`.
  No literal, no ratio, no hash, no `Math.random`.
- **Snake/camel reads are dual-keyed** in `readCustomerGroupOrgCode`, `readCustomerStage`,
  `readSalespersonUserId` and `stageOf`.
- **The two formerly-quadratic routes are genuinely fixed** — `customers.ts:334-345` and
  `customer-products.ts:148-216` both bucket into a `Map` before the row map.

---

## quality-warehouse

### Q1 — ✅ fixed: `GET /api/qc-pending` was ~80M comparisons a load

See BUG-2026-08-13-062. Parent set is **2,839** PENDING/IN_PROGRESS rows (in-repo prod
measurement, `quality.tsx:452-456`, 2026-08-01), the query has **no LIMIT**, and the page
calls the endpoint with **no query string** so nothing narrows it.

### Q2 — ✅ fixed: a NULL QC result rendered as a green PASS

See BUG-2026-08-13-063.

### Q3 — 🔴 every office stock movement is signed "Warehouse Staff"

`src/pages/warehouse.tsx:340` and `:396` post the literal
`performedBy: "Warehouse Staff"`; `warehouse.ts:537` writes it verbatim into
`stock_movements.performedBy`, and it is displayed as the **"Performed By"** column
(`warehouse.tsx:1542`) and `By {m.performedBy}` (`:1001`). The page is behind a session, so
the actual user is known and discarded. The column is 100% populated and carries no
information — the movement log cannot answer who moved the stock. QC fixed exactly this and
wrote down why (`qc-pending.ts:739-745`: *"a quality record signed by nobody"*); the
warehouse write path was never brought in line. Not fixed here: the session identity has to
be threaded through two handlers and that is a behaviour change on an audit trail.

### Q4 — 🔴 the API hands the page the Company SO and the page scrapes `notes` instead

`warehouse.ts:110` emits `companySOId: r.salesOrderNo ?? ""`, added for owner-requested SO
search (`warehouse.ts:53-56`). The page's `RackItem` type (`warehouse.tsx:25-35`) **has no
such field**; the only SO it knows comes from `rackItemSO()` (`:39-42`), a regex over
`notes`. `notes` carries `"SO <no>"` only when the row was written by the scan path
(`public-rack-qr.ts:151-156`) — a rack item created by the office stock-in form posts free
text — so **SO search silently misses every manually stocked piece** while the correct value
sits unread on the same object. Compounding it, the detail-popup query
(`warehouse.ts:576`) does not select `po.salesOrderNo` at all.

### Q5 — 🔴 a transient DB error tells a storekeeper their rack label is invalid

`public-rack-qr.ts:590-593` returns `404 {error:"rack not found"}` from a blanket `catch`,
so **any** thrown error becomes an absence claim. `rack-scan.tsx:935` renders it under the
heading **"Rack not found"** advising the user to *"ask the Hookka office for a freshly
printed rack QR"*. Same defect at `public-rack-qr.ts:760-763` → `rack-scan.tsx:405-411`
("Not recognised: `<code>`"). **The correct pattern is in the module already**:
`public-rack-write.ts:209-218` returns a **500** with "Could not load this sticker. Please
try again." and reserves 404 for a genuinely unknown token.

### Q6 — 🟡 the warehouse and QC pages render failure as emptiness

Seven `useCachedJson` calls across `warehouse.tsx` (`:200,:201,:241,:244`) and `quality.tsx`
(`:297,:1055,:1199`) destructure neither `error` nor `failure`. On a 5xx/timeout the
warehouse shows 0 racks, 0% occupancy and four "nothing here" captions; QC shows "No pending
inspections." Sharpest detail: `quality.tsx:609-625,880-884` **does** handle this correctly
for the subject dropdown, with the comment *"If this breaks again it must LOOK broken"*
citing an outage that left 3,009 inspections unsubmittable. The lesson was applied to the
dropdown and not to the three list fetches that carry the page. C15 row 3.

### Q7 — 🟡 six dead QC endpoints, two of which carry live defects

Unreached by any caller (checked against `worker.ts:1376-1378` and every `/api/qc-*` call
site in `src/`): `qc-pending.ts:1943` (`POST /:id/start`), `:2478` (`DELETE /:id`);
`qc-inspections.ts:255,336,359,445`. They matter because `POST /api/qc-inspections` still
contains `inspectorName: body.inspectorName ?? "QA Manager"` (`:282`) and `getNextQCNo`
(`:137-147`), a `COUNT(*)`-derived sequence — **the exact bug** `qc-pending.ts:202-217`
documents as having given 17 inspections a day the same number for three months. Wiring any
new UI to this route reintroduces both. (`POST /bulk-skip` at `:2421` is also uncalled but
is documented as owner-invoked — leave it.)

### Q8 — 🟡 smaller, verified

- **"Full Movement History" is silently the newest 500 rows** (`warehouse.ts:487-488`), and
  the response's `total` is the page size (`:493`), so nothing on screen can reveal it.
- **Movement-history "Rack" column shows a UUID.** UI-created racks get
  `crypto.randomUUID()` as their id (`warehouse.ts:428`) while the human name lives in
  `rack_locations.rack`; `warehouse.tsx:1515` renders `rackLabel`, which was set from the
  id (`:334`, `:386`). **Needs one probe** — if seeded racks have `id === rack`, only racks
  created since the Create-Rack button shipped are affected:
  `SELECT COUNT(*) FROM rack_locations WHERE id <> rack;`
- **`insp.department` is a dead fallback.** `qc-pending.ts:341` emits `deptCode` and never
  `department`; `quality.tsx:480,618` read `insp.deptCode || insp.department`. The trap is
  the asymmetry — `/api/qc-inspections` emits `department` and never `deptCode`, and the
  shared type declares both optional, so TypeScript cannot catch either side.
- **The generate toast cannot be reconciled.** `created` (`qc-pending.ts:1785-1800`) sums
  WIP + RM + **STORED** + FG, but `quality.tsx:316-342` neither types nor explains the
  STORED stage, so the headline is routinely larger than its own itemisation.

### Cleared, with evidence

- **Occupancy is NOT a fabricated metric.** `warehouse.ts:286` is a ratio of two genuine
  counts. Racks deliberately have no capacity (owner: *"正常一个 rack 都可以放好几样东西的
  暂时不需要 set limitation"*, quoted at `warehouse.tsx:16-17`), so "fraction of racks in
  use" is the only thing it *could* mean. Flagging it would be the over-correction
  BUG-CLASSES warns about — deleting a measured metric while cleaning up fabricated ones.
- **The FG sampling risk weights are not a fabricated figure.** `qc-fg-risk.ts:102-115` is a
  table of hand-chosen literals, but the score is **never rendered**: the page maps only
  `r.label` (`quality.tsx:517-541`), and every label is built from a real count
  (`service_cases`, `fg_units`, `bom_versions`). The file says so on purpose at `:243`:
  *"Deliberately not 'score 73' — a number tells them nothing."* A ranking key that never
  claims to be a measurement is not this bug.
- **No money anywhere in this module** — `rack_items`, `stock_movements`, `qc_inspections`
  and `qc_templates` carry no price column, and all three public routes state
  price-exclusion as a security property. Class 7 is empty here.
- **`GET /api/warehouse` and `GET /api/qc-inspections` are genuinely de-quadratic'd**
  (`warehouse.ts:272-281`, `qc-inspections.ts:232-249`), and `MovementTable` is really
  virtualised (`warehouse.tsx:1447-1553`), not sliced.
- **The QC inspection-number allocator is correct** (`qc-pending.ts:218-237`) — it takes the
  base from the highest suffix in use, not `COUNT(*)`. The unfixed `COUNT(*)` twin survives
  only in the dead route (Q7).
- **Inspector identity and clock are server-owned** (`qc-pending.ts:1922-1940`, `:2167`,
  `:2205`); `CompleteInspectionInput` carries no timestamp field by design. FAIL requires
  words **and** a photo, enforced server-side (`:2124-2160`) with the client check labelled
  a courtesy: *"a UI-only rule is not a rule."*
- **`public-rack-write.ts` is clean throughout** — correct 500-vs-404, one body field read,
  job-card id taken from the token's own row, token shape validated before any DB call.
- **Public DO edits are server-rebuilt** (`public-do-qr.ts:829-844`) — only production-order
  **ids** are accepted and each line is rebuilt from a trusted set, so a tampered payload
  cannot inject another customer's goods.

---

## rnd

### R1 — 🔴 R&D material cost falls back to six hardcoded constants (VERIFIED, not fixed)

`rd-projects.ts:195-205`:

```ts
function estimateFIFOCost(_itemCode: string, itemGroup: string): number {
  const groupCosts: Record<string, number> = {
    PLYWOOD: 4500, "B.M-FABR": 2500, "S.M-FABR": 3000,
    "B.OTHERS": 800, EQUIPMEN: 5000, SPONGE: 1500,
  };
  return groupCosts[itemGroup] ?? 2000;
}
```

Note `_itemCode` is unused — the figure does not even vary by material. It is the fallback
in `resolveFifoUnitCostSen` (`:339-352`) whenever the RM has no `rm_batches` row with
`remainingQty > 0`. That number is then **persisted** as
`rd_material_issuances.unitCostSen`/`totalCostSen` (`:1259-1260`, `:1478+`, `:1730+`),
summed into `rd_projects.actualCost` (`:1273-1284`), and rendered as real money on the
issuance table (`detail.tsx:2290-2291`), the "Actual Cost" card (`:1687`), the budget bar
and % (`:1414`, `:1699`), the over-budget / near-budget chips (`health.ts:88-95`), the
Summary KPIs (`index.tsx:500,576,580`) and the CSV export (`:794-797`). **Nothing anywhere
marks it as an estimate** — the function name is the only clue and it never leaves the file.

The population at risk is real: `rm_batches` is fed by GRN posting, so opening-balance
materials that pre-date it have no batch. **Probe:**

```sql
SELECT COUNT(*) FROM raw_materials rm
 WHERE NOT EXISTS (SELECT 1 FROM rm_batches b WHERE b.rm_id = rm.id AND b.remaining_qty > 0);
```

and, for damage already recorded, the same join against `rd_material_issuances` grouped by
`unit_cost_sen IN (4500,2500,3000,800,5000,1500,2000)`.

**Not fixed.** The honest options — refuse the issuance, or store `null` and render `—` —
both change behaviour on a write path, and choosing between them is the owner's call.
Per C15 the minimum acceptable outcome is *provenance beside the figure*.

### R2 — 🔴 R&D issuance never advances the FIFO queue

`rm_batches` is **only ever SELECTed** in `rd-projects.ts` (line 342 — verified, the only
occurrence besides comments). Issuance decrements `raw_materials.balanceQty` (`:1215`,
`:1454`, `:1692`) but never `rm_batches.remainingQty`. So the "oldest batch with stock
remaining" keeps returning the same batch, and the same price, after R&D has consumed it —
and the batch ledger and the RM balance diverge by every R&D issuance ever made. Reported
rather than fixed because the batch ledger's write contract belongs to inventory.

### R3 — 🔴 deleting an R&D project can re-issue a live project code, and orphans its children

Two defects in one handler. `POST /` derives the code from
`COUNT(*) + 1` over the whole table (`:399-403`) while formatting it as `RD-<yy><mm>-<seq>`;
`code` is `TEXT NOT NULL` with **no UNIQUE** (`0001_init.sql:1256`). `DELETE /:id` (`:2237-2259`)
is a hard `DELETE FROM rd_projects` — so after any delete, `COUNT(*)` drops and the next
create silently re-issues an existing project's code, with no error. The same DELETE removes
nothing else: `rd_prototypes`, `rd_material_issuances` and `rd_labour_hours` rows survive
pointing at a project that no longer exists, and the RM stock stays deducted with no
reachable issuance record. (The month prefix is also decorative — the sequence is global,
never per-month.)

### R4 — 🟡 R&D writes a hardcoded tenant literal

`rd_projects` has `org_id` in prod, yet `GET /` (`:371`) and `GET /:id` (`:521`) carry no
orgId predicate and `POST /` (`:429-467`) does not stamp it. Worse than relying on the
DEFAULT: `rd_prototypes` (`:739`), `rd_material_issuances` (`:1265`), `rd_labour_hours`
(`:2096`) and `rd_team_members` (`rd-team-members.ts:145`) all bind the **literal
`'hookka'`**, which actively mislabels a second tenant's rows rather than merely defaulting
them. C12 rows 6/7.

### R5 — ✅ fixed: `/rd` printed a green "all on track" tick over a dead request

See BUG-2026-08-13-064.

### Cleared, with evidence

- **The CLONE project type is safe.** `0001_init.sql:1259` restricts `project_type` to
  DEVELOPMENT/IMPROVEMENT, which would 400 every CLONE create — but migration 0089 widens
  the CHECK, and `tests/db-schema.json` shows `source_brand` / `source_price_sen` (added by
  0089/0090 in the *same files*) present in prod. So 0089 was applied and the CHECK includes
  CLONE. Likewise `target_selling_price_sen` / `target_material_cost_sen` are present, so
  the "migration 0101 maybe unapplied" `catch {}` at `:488`/`:694` is unreachable
  belt-and-braces rather than a live silent-data-loss path.
- **The batch issuance endpoint correctly aggregates per material before the stock check**
  (`:1617`, `:1649-1660`) — two lines of the same SKU cannot each pass against the same
  remaining balance. This is the C10 shape and it is handled.
- **Issuance reversal is a clean inverse** (`:1807-1890`): re-credits `balanceQty`, writes a
  counter STOCK_IN, deletes the row, recomputes `actualCost` from the post-delete sum.
- **`health.ts` is honest arithmetic end to end** — schedule from `targetLaunchDate`, budget
  from `actualCost / totalBudget`, `null` when `totalBudget` is 0 rather than a fake 0%.
  (Its inputs inherit R1's weakness, but the helper itself invents nothing.)
- **`SummaryView` matches its own comment** — it is passed `activeProjects`
  (`index.tsx:1508`), not every project, so "aggregate spend / budget" excludes drafts and
  completed work as documented.
- **PART_TIME labour contributing 0 to the per-hour bucket is intentional** and documented
  at `:230-258`; `computeLabourCostSummary` degrades to a zeroed summary rather than 500ing
  when `rd_labour_hours` is absent.
- **C8 clean:** `rd_team_members.active` is one of the ten real BOOLEAN columns and every
  write uses a JS boolean or a SQL literal (`rd-team-members.ts:145`, `:230`, `:289`), never
  `? 1 : 0`.
- **C14 rows for `rd-projects.ts:166`** were measured and closed on 2026-08-13 (≤ 7,781
  comparisons). Re-confirmed at the same line; not re-audited.

---

## Owner decisions owed

1. **A1** — run the `delivery_incomplete` probe. If `> 0`, those deliveries were invoiced
   past a hold; decide whether to review them before the guard is made live.
2. **A2** — what should "AP Outflow" actually be measured from?
3. **R1** — refuse the issuance, or store `null` and render `—`? Either way, provenance
   beside the figure.
4. **R3** — should `DELETE /api/rd-projects/:id` cascade, or refuse when a project has
   issuances? (A `UNIQUE` on `code` is wanted regardless.)
5. **Q3** — thread the session user into the warehouse stock-in/out writes.

## Related

[[BUG-CLASSES]] · [[BUG-HISTORY]] · [[CODEBASE-MAP]] · module guides:
[[accounting]] [[customers]] [[quality-warehouse]] [[rnd]]
