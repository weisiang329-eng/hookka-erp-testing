# Dashboard Data Audit — can every number on a tile be traced to a real event?

> **Last verified: 2026-08-14** against `src/pages/dashboard-b/index.tsx`,
> `src/pages/dashboard-b/OcrAccuracyCard.tsx`, `src/pages/finance-dashboard.tsx`,
> `src/pages/employees.tsx`, `src/pages/accounting/index.tsx`,
> `src/pages/daily-report.tsx`, `src/api/routes/dashboard-overview.ts`,
> `src/api/routes/job-cards.ts`, `src/api/routes/worker.ts`,
> `src/api/routes/accounting.ts`, `src/api/routes/payslips.ts`,
> `src/api/lib/compliance-report.ts`, `src/api/lib/efficiency-report.ts`,
> `src/api/lib/production-brief.ts`, `src/api/lib/do-value.ts`,
> `src/lib/salary-dept.ts`, `src/lib/cached-fetch.ts`.
>
> Every claim below was produced by opening the file and reading the logic.
> **No production database was available**, so nothing here is a row count or a
> live figure. Where the answer needs data, the row says **unmeasured** — it is
> not estimated. Reporting a projection as a measurement is the exact failure
> this audit exists to find.

Owner's question, 2026-08-14: 「我全系统的 dashboard 数据，上面有哪里是有问题的吗？」

**Short answer: yes.** Across the Command Center, Finance Dashboard, Accounting,
Employees, Planning, Production, MRP, KPI, the Hookka Report and the morning
brief, this pass found **21 fabricated figures**, **24 mislabelled ones**, and
**15 places where a clean number means "cannot see" rather than "clean"**. None
of them crashes, none of them looks wrong, and several are numbers the owner
reads every morning.

**The four he should look at first**, because each is a number he could act on
and each is provably not a measurement:

1. **Hookka Report › Workforce "Attendance %" is 100.0% by construction.**
   `SUM(status='PRESENT') / COUNT(*)` over `attendance_records.status` — and
   **every writer of that column writes the literal `'PRESENT'`**
   (`attendance.ts:255,290`; `worker.ts:1098,1104,1139`;
   `working-hour-entries.ts:117`). Nothing anywhere writes `'ABSENT'`. Absence
   creates no row, so it cannot pull the figure down. On a printed report.
2. **The Daily Report headline can read `0` / "A Quiet Day on the Floor" while
   checks are failing.** All thirteen compliance checks `catch → return []`, so
   a check that throws contributes zero, indistinguishable from clean.
3. **`/accounting/cash-flow`'s "Current Cash Position" is a demo seed.** The only
   writers of `bank_accounts.balanceSen` are migration fixtures and that page's
   own Add-Transaction form. It is also the opening value of the whole 12-week
   projection.
4. **`/planning/mrp` shortages ignore everything already on order** —
   `const onOrder = 0;` (`mrp.ts:701`) — with an invented `|| 50` MOQ and
   `|| 14` day lead time printed under the supplier's name.

---

## How to read the verdict column

| verdict | meaning |
|---|---|
| **measured** | traceable to a column a real business event writes |
| **derived** | honest arithmetic over measured inputs; label matches |
| **estimated** | a plan / standard / projection, and the screen says so |
| **MISLABELLED** | the number is real, the caption says it is something else |
| **FABRICATED** | a literal, a constant ratio, a self-referential formula, or a `?? 0` standing in for a measurement — rendered as if observed |

The three corollaries from `docs/BUG-CLASSES.md` C15 are the test applied
throughout: **`0` is a claim, not a blank**; **a total inherits the weakest
input**; **publish the provenance beside the figure**.

---

## Part 1 — the two systemic findings

These are not individual bugs. Each one is a *shape* that recurs across screens,
and each is why a reader cannot tell the good figures from the bad.

### S1. Nothing in this factory measures time. Ten tiles say it does.

`job_cards` has three time columns and **none of them is a measurement**:

* `productionTimeMinutes` — snapshotted from the master Production Times config
  (`kv_config['variants-config'].productionTimes`, keyed by dept × category) when
  the card is created, and strong-overwritten from the same master by
  `POST /api/bom/resync-job-card-times` (`src/api/routes/bom.ts:1059-1060` binds
  the **same** master value to `productionTimeMinutes` AND `estMinutes`).
* `estMinutes` — the same value.
* `actualMinutes` — written as a **copy of the standard**:
  `updated.actualMinutes = jc.productionTimeMinutes || jc.estMinutes`
  (`src/api/routes/import-completion/_shared.ts:468`), under the comment *"Use
  planned minutes as actual since we don't have real timing."*

The repo already proves this in its own source — `production-orders.ts:424-436`
records that all 4,289 non-zero `actualMinutes` values are byte-identical to
that card's `estMinutes`. **A populated column is not a measured one.**

That is not automatically a defect. `standard minutes earned ÷ clocked minutes`
is the classical efficiency metric, and where the denominator comes from
`working_hour_entries` (real clocked time) the ratio genuinely varies and is
worth having. The defect is that **not one caption on any screen says the
numerator is a standard**. "Production Time", "Production Hours", "Daily
Capacity", "actual min/set" all read as observed durations.

Affected, all **MISLABELLED**: Command Center *Worker Efficiency* + *Daily
Capacity* + *Plant Load*; Employees *Efficiency Overview*, *Dept Performance*,
*Employee Performance*; the morning brief's *efficiency* and *CNC drift*
sections; `/reports` Production (already fixed once as BUG-2026-08-13-004).

### S2. A dead request becomes a confident number — on the busiest screen

`useCachedJson` returns `{ data, loading, error, failure }` and
`isUnknownOutcome(failure)` is the single guard that separates *"the server said
there is nothing"* from *"the request died"* (C15 / BUG-2026-08-13-016).

**Not one of the Command Center's eight fetches reads `failure`.** So a timeout,
a 500 or the 30 s global abort in `src/lib/api-client.ts` paints a full page of
confident zeros:

| tile | what a dead read printed |
|---|---|
| Daily Report | a large **green `0`** under *"All clear — nothing flagged today"* |
| OCR Accuracy | *"No scans yet. Once you scan and import orders / supplier docs…"* |
| This Month Sales / Invoices | `RM 0.00` (`rm()` is `formatCurrency(sen ?? 0)`) |
| Plant Load gauge | **`0d` queue, green** |
| Workforce | `0` |
| Revenue chart | *"No revenue data."* |

The same pattern is on `/employees` (`avgEfficiency` falls back to the string
`"0"`, `presentCount ?? 0` — `employees.tsx:11556-11559`) and on the Dept
Performance *Workers* tile (`totals?.workerCount ?? 0`, `employees.tsx:6281`,
while its three neighbours correctly print `-`).

**Why the existing guard missed it:** the class's growth test
(`tests/record-load-failure-class.test.mjs:225`) scans for pages that print the
string *"not found"*. These pages print *"All clear"*, *"No scans yet"* and
`RM 0.00`. The guard was pattern-matched to the first instance, not to the shape.

`/daily-report` reads the *same endpoint* as the Command Center's Daily Report
tile and gets it right — *"Could not load the report. Please try again."*
(`daily-report.tsx:1105-1122`). **Same data, two screens, one of them lying.**

**Fixed in this PR** for the two Command Center tiles (see Part 5). The money
tiles and the Plant Load gauge are left for a follow-up because rendering "—"
in a KTile needs a shared decision about tile-level failure state.

---

## Part 2 — FABRICATED and MISLABELLED, by screen

Lead items first: these are what the owner is looking at every day.

### 2a. FABRICATED

| Screen | Label | Source (file:line) | Wrong output |
|---|---|---|---|
| `/employees` › Labor Cost | green **"Reconciled · 0 difference"** badge — on screen **and on the printed report** | `employees.tsx:9409-9423`, rendered `:9696`, printed `:9461` | `loadedOverhead = TP − U − P − W − S`, then `reconciledSum = P+W+S+loadedOverhead+U` ≡ `TP`. `reconcileDiff` is **algebraically 0 forever**. Overhead is a closing plug. **No input can turn it red.** Exact twin of the Stock-Summary ✓ (C15 row 26) — and the code comment beside it admits *"equals totalPayrollCostSen by construction"* while the badge tells the owner his payroll reconciles. |
| `/employees` › Payroll, and **every payslip** | **PCB** line, `RM 0.00`, inside a tile captioned *"EPF (employee + employer), SOCSO, EIS **and PCB**"* | `payslips.ts:230` — `pcb: pcbOn ? 0 : 0` | Hardcoded to zero on **both** branches; the per-worker `pcbEnabled` toggle does nothing. PCB feeds `totalDeductions → netPay` (`payslips.ts:694`), so any worker above the PCB threshold has an **overstated net pay printed on a payslip**. |
| Worker phone (LIVE) + `/employees` › Leave (hidden) | **Annual leave entitlement** and "Remaining" | `employees.tsx:10087` `{ ANNUAL: 8, MEDICAL: 14 }` vs `worker.ts:2481` `annualEntitlement = 14` | Two hardcoded literals with **no entitlement column anywhere** (grepped `src/api` and both migration trees: zero hits). The office says **8 days**, the worker's phone says **14** — same worker, two answers. The office side has no year filter (`leaves.ts:52-68` returns every row ever), so "Remaining" never resets on 1 Jan and eventually goes negative. Mitigation: the office tab is commented out of `TABS` (`employees.tsx:11111`); **the phone tile is live**. |
| `/employees` › Attendance | **Clock Out** time for a forgotten punch | `worker.ts:936-957` `autoCloseForgottenPunch` | Writes a **synthetic** clock-out at shift end, `workingMinutes = workingHoursPerDay × 60`, `productionTimeMinutes = round(× 0.85)` and `efficiencyPct = round(0.85 × std / std × 100)` — **a literal 85%, always**. Flagged only in `notes`, and the table renders no notes column: an invented `18:00` is pixel-identical to a real punch. **This is a second writer of the 0.85 constant, outside `attendance.ts`** — see Part 4. |
| Morning brief §5 (emailed) | *"CNC speed drift: BEDFRAME **actual** 45m/set vs configured 8m (+466%)"* | `production-brief.ts:240` `SUM(COALESCE(jc.actualMinutes, jc.estMinutes,0))` vs `planning-capacity.ts:204-206` constants | Per S1, "actual" IS the BOM standard. So this compares **one config against another config**, is constant per category, and can never move with real cutting speed. It fires whenever \|drift\| > 25%, which it permanently is (`production-brief.ts:666`). The Command Center tile carrying this number was deleted on 2026-08-05 for reading *"BEDFRAME speed +466%"* (`dashboard-b/index.tsx:1202`) — **the email was never touched.** |
| `/finance-dashboard` › Production Salary | **TOTAL** and **%** for a month whose payroll is not yet posted | `accounting.ts:10415` + `finance-dashboard.tsx:866` | Payslips exist as soon as payroll runs; GL 750-x only after the manual "post labour" (`accounting.ts:9455`). In that window the chart shows real per-department wages while the TOTAL prints `RM 0` / `0.00%` — *"we paid nothing"*, not *"not posted yet"*. |
| `/finance-dashboard` › Cash Flow | **Money in / out / Net / Operating / Investing / Financing** on a forecast bucket | `accounting.ts:10613-10630` (reduce over a seeded `{operating:0,…}`) | `cashFlow` is never null, so a future month renders `RM 0` on every cash line — while the **P&L card on the same page** correctly renders `-` for the same month. Two cards, one period, one of them asserting zero. |
| Morning brief §3 | *"0% overall efficiency · 0 present"*, then the green *"Nobody below 60% yesterday"* | `efficiency-report.ts:387` `totalWork > 0 ? … : 0`; `:512` | `workingMinutes` comes only from `working_hour_entries` — a supervisor-entered grid. A day nobody filled the grid is emailed as **0% efficiency, 0 present**, followed by a green all-clear off an empty set. |
| **Hookka Report › Workforce** | **"Attendance %"** | `operations-report.ts:601-614` → `attendance_records.status` | `SUM(status='PRESENT')/COUNT(*)` where **every writer of the column writes the literal `'PRESENT'`** — verified across all five INSERT/UPDATE sites (`attendance.ts:255,290`, `worker.ts:1098,1104,1139`, `working-hour-entries.ts:117`); the string `'ABSENT'` appears in no route. Prints **100.0%** on any period with a punch. **Absence writes no row at all**, so the metric is structurally incapable of falling. |
| `/accounting/cash-flow` | **"Current Cash Position"**, "Total Across All Accounts", per-account "Current Balance", and the opening value of the 12-week **Running Balance** | `cash-flow.ts:158,195` → `bank_accounts.balanceSen` | The only writers are **migration fixtures** (`migrations/0011_cash_flow.sql:41-43` seeds Maybank RM 50,000 + CIMB RM 8,000; `seed-chunks/002:1968` seeds "Maybank 5142-8830-7621 RM 285,400") and **this page's own Add-Transaction form** (`cash-flow.ts:268-281`). No invoice, receipt, payment, PV/OR or transfer ever touches it. A demo balance is printed as the company's cash and **every projected week inherits it**. |
| `/accounting/cash-flow` › Bank Reconciliation | **"GL Balance"** and the red **"Difference"** | `cash-flow.tsx:339-349` → `journal_lines WHERE accountCode = "100-0001"` | Two independent faults: `100-0001` exists **only in the demo seed** — production posts bank movements to `310-0010` / `320-0000` (`payments.ts:31-35`); and `journal_entries`/`journal_lines` are the **manual-JV** tables, while every real posting goes to `ledger_journal_entries`. GL Balance is structurally `RM 0.00` in production, so "Difference" prints the entire seeded bank balance in red. |
| `/accounting` › Trade Finance | *"Draws X + unallocated Y = **account balance** Z"* — red when it doesn't tie | `TradeFinanceBlock.tsx:133`; `src/lib/trade-finance.ts:77, 94` | `unallocatedSen = accountNetSen − Σ outstandingSen` and `totals.total = Σ outstandingSen`, so `total + unallocated ≡ accountNetSen` in integer sen. **The red branch is unreachable.** The identity the owner is told to check at a glance cannot detect any discrepancy — same algebra as the Stock-Summary ✓ (C15 row 26). |
| `/accounting` › Balance Sheet | **"Balance sheet is balanced. Assets = Liabilities + Equity" ✓** + both totals | `index.tsx:11026`; data `:10844` | On any fetch failure `BalanceSheetTab` never reads `failure`, so `bsData = []` → Total Assets `RM 0.00`, Liabilities+Equity `RM 0.00`, and `0 === 0` renders the **green balanced tick**. (Trial Balance gets this right — it gates its badge on `tb &&`.) |
| `/accounting` › Overview / AR / AP | **AR Outstanding**, **AP Outstanding**, both AgingCard totals, both "Total Outstanding" | `index.tsx:531-536, 2327, 2336, 4549` | `agingResp?.success ? … : []` → a 500, a timeout or a permission denial prints a confident `RM 0.00` for every AR/AP figure. **The same component already publishes `NO_FIGURE = "—"` (`:625`) for Revenue / Cost / Net Profit** — the honest pattern exists on the page and was not applied to these five. |
| `/accounting` › Opening Balance | **"Total DR / Total CR / Balanced ✓"** and an **enabled Post button** | `index.tsx:10087-10089, 10272-10279`; loader `.catch` at `:9991` | With the fetch failed every control leg is 0, `diff === 0`, the header claims **Balanced ✓**, and `disabled={posting \|\| diff !== 0 …}` **enables Post** on a sheet that never loaded. |
| `/accounting` › General Ledger (grouped) | **TOTAL DR / TOTAL CR / Diff** + **Balanced ✓** | `index.tsx:7446-7451`; `accounting.ts:11085-11089` | `grandDr += totalDr` runs **before** the 4,000-row budget `break`, so the grand totals include one account whose rows are not rendered and exclude every account after it — a confident red `Diff` off a self-inconsistent pair. The badge also asserts double-entry balance when the user has filtered to one ledger or two accounts, where balance is impossible by construction. |
| `/kpi` › People | **"Last month" score, the ↑/↓ delta, "settled"** | `kpi.ts:144-156` reads `kpi_periods … lockedAt IS NOT NULL` | **`kpi_periods` has no writer** — verified: DDL at `ensure-kpi-tables.ts:40` and two SELECTs (`kpi.ts:146`, `:413`), no INSERT or UPDATE anywhere in the repo. `isLocked` can never be true, so every "settled" historical month is silently recomputed against **today's** data and the delta compares two live recomputations. |
| `/planning/mrp` | **Net Req · Shortage · "Shortages Found" · Sugg. PO qty · "Order By" / "14d lead"** | `mrp.ts:701` `const onOrder = 0;`; `:710` `moq = mainBinding?.moq \|\| 50`; `:714` `leadTimeDays = … \|\| 14` | Material already on an open PO reports as a **full shortage** (the real on-order figure exists at `fabric-usage.ts:551`). The suggested quantity rounds to an invented **50** (and `\|\| 50` also overrides a genuine stored MOQ of 0); the deadline that turns red is built on a literal **14 days** printed under the supplier's name. Acting on this re-orders inbound stock. |
| `/planning/mrp` | **"This Wk"**, bold red | `mrp.ts:198-207` `dateToBucket(null) → "THIS_WEEK"` | Undated demand is bucketed into *this week* and styled most-urgent. A PO with no dates contributes its whole BOM to the most alarming column. |
| `/planning/mrp` | **"On Hand"** | `mrp.ts:698` `onHand = rm ? rm.balanceQty : 0` — exact-string lookup, no `normCode` | A code-format mismatch renders "On Hand 0" plus a full shortage, indistinguishable from an empty bin. |
| `/production` Overview (cold landing) | **"0/0 cells complete"** | `production/index.tsx:8331`; matrix gated on `activeTab`, not `shouldFetch` (default `false`, `:588`) | The page says *"No orders loaded yet"* and, in the same view, asserts `0/0 complete`. |
| `/production/wip-times` | **all four tiles**, incl. **"Missing BOM time"** | `wip-times.tsx:225-243`; `loading` destructured at `:209` and never used to guard | During the fetch, on failure and on empty, all four render `0` — and "Missing BOM time" renders its `0` in **neutral** colour (amber only when `> 0`), i.e. visually all-clear. |

### 2b. MISLABELLED

| Screen | Label | What it actually measures | file:line |
|---|---|---|---|
| Command Center | **Daily Capacity · 7-day avg** (`190h`) + the drill-down column **"Production time"** | Σ *standard* minutes of the job cards completed that day ÷ working days. A throughput proxy in standard-minutes, not plant hours. | `dashboard-overview.ts:945, 973`; `dashboard-b/index.tsx:1354` |
| Command Center | **Worker Efficiency** — *"production mins ÷ clocked hours"* | standard minutes **earned** ÷ clocked hours. Denominator is real (`working_hour_entries`), numerator is the master config. | `dashboard-b/index.tsx:785`; `job-cards.ts:317-351` |
| Command Center | *"Top 3 = N% … **of total customer revenue** (RM X)"* + the card's **Total** chip | Only the **top 12** customers. `dashboard-overview.ts:1350` does `.slice(0, 12)`; the frontend sums exactly those 12 into `totalCustRev`. A truncated denominator **inflates** the concentration %, and the "All customers" row directly above uses the real all-customer total (`aovCompany.totalSen`) — two different totals on one card. | `dashboard-b/index.tsx:917, 1929`; `dashboard-overview.ts:1340-1350` |
| `/employees` header | **"Present" N/M** | Numerator = union of {WHE rows in production depts} ∪ {workers on completed JCs} ∪ {ADD_PROD approvals}, **unfiltered by status**. Denominator = `ACTIVE && !TEST`. Never reads `attendance_records`. A resigned worker with one job card inflates it (Present can exceed Total); a worker who clocked in but was credited on nothing is "absent". | `employees.tsx:11554`; `department-performance.ts:725` |
| `/employees` | **two different "Avg Efficiency" figures**, and one of them gates money | Header uses `pic1 + pic2 + piece_pics`; the Efficiency Overview and **`resolveEfficiencyAllowanceSen` (the bonus gate)** use `pic1/pic2` only. `production-orders.ts:2262` rolls piece scans up to the **first two distinct people**, so a 3rd worker on a multi-piece card is invisible to the bonus — **a real RM loss**. | `department-performance.ts:474`; `efficiency-allowance.ts:78-101` |
| `/employees` › Payroll, printed **Salary Calculation Guide** | *"Efficiency allowance — flat bonus … **(no proration)**"* | The engine **does** pro-rate: `allow × (workingDays − absentDays) / workingDays` (`efficiency-allowance.ts:296`, applied `payslips.ts:677`). The guide handed to staff states the opposite of what they are paid. | `employees.tsx:7288` |
| `/employees` › Working Hours | per-worker hour chips + amber **"OT (>9h)"** | `workerTotals` keys on `workerId` with **no date**, while the tab's default range is the whole current month (`:1041`). A month total is flagged against a **per-day** 9 h threshold — on the default view every worker reads as permanently in overtime. | `employees.tsx:1420, 1696` |
| `/employees` › Working Hours | **"{N} workers shown"** | a worker-**day** count (`groupedRows` is keyed `workerId\|\|date`). One worker over 20 days reads "20 workers shown". | `employees.tsx:1526, 1757` |
| `/employees` › Working Hours | punch tooltip *"Late past the **10-min** grace"* | the engine forgives to **15** (`attendance-rules.ts:78`, `pay-rules.ts:127`). The caption tells the operator 08:12 is docked; it is not. | `employees.tsx:1804` |
| `/employees` › Attendance | **"✓ At factory"** | shows the clock-**in** location only whenever in has GPS. Punch in at factory, out from home → **green ✓**. `offSiteCount` counts either side, so the caption can read *"3 off-site today"* with **zero** off-site badges in the table. | `employees.tsx:11364, 11221` |
| `/employees` › Attendance | **"Avg Efficiency (this month)"**, tooltip *"averaged across workers"* | ratio-of-sums, not a mean across workers (the code comment at `:11243` says so; the tooltip was never updated). Range end is the last calendar day, not "to date". | `employees.tsx:11274, 11298` |
| `/employees` › Attendance | **Avg Salary / Worker** for a past month | uses the worker's **current** `basicSalarySen`. The period-correct endpoint exists (`workers.ts:1058 /salary/effective?period=`) and two other tabs use it. | `employees.tsx:11258` |
| `/employees` › Efficiency Overview | **Efficiency %** | numerator bracketed by `job_cards.completedDate`, denominator by `working_hour_entries.date`. A card worked over a week but closed today dumps its whole standard time on one day — the tab's own comment records a real **428%**. `prodMins = 0` with hours > 0 prints a confident red **0.0%**, not "—". | `employees.tsx:4078-4117` |
| `/finance-dashboard` › Production Salary | dept stacked bars, captioned *"750-0010 SALARIES · 750-0020 EPF · …"* | the bars are **every** payslip department; the TOTAL is GL 750-x only. `DEFAULT_LABOUR_MAP` (`accounting.ts:9299`) routes `MAINTENANCE → 780-0030` and `WAREHOUSING → 780-0000`, so those bars sit **outside** the total drawn under them. Σdepts ≠ TOTAL by construction. (`salary-dept.ts:6` claims the opposite — an unreliable comment; it is comparing against `aggregateLabour`, not the GL figure the page renders.) | `accounting.ts:10355`; `finance-dashboard.tsx:720, 863` |
| `/finance-dashboard` › Ratios | **ROE / ROA** | one **month's** net over a point-in-time equity, unannualised — and profit only enters equity at the year-end close (`accounting.ts:5166`), so inside an unclosed FY the denominator excludes all year-to-date earnings and ROE is inflated by construction. | `accounting.ts:10702` |
| `/finance-dashboard` › Income Statement | **"Stock Movement"** | a residual: `cogs − materials − labour − overhead`. Every misclassification anywhere in COGS lands here under a name implying an inventory swing. | `accounting.ts:10417` |
| `/finance-dashboard` › Production Salary | **Headcount** / **RM per head** | `SELECT joinDate, resignedAt FROM workers` with **no status filter** (deliberate, owner's ruling) — but a worker with a blank `joinDate` passes the "not hired yet" test and is counted in **every month of history**. | `accounting.ts:10315` |
| **Hookka Report** › Billing Desk | the **Receivables aging strip** | **five buckets are computed, four were printed.** `d30Sen` (exactly one month overdue) was never rendered, so it vanished from a printed statement and the boxes did not add up to the "Receivables" total beside them — and every remaining label was shifted one bucket ("31–60d" was `d60Sen`, i.e. two months). The captions also claimed *days* while `monthsOverdue` buckets by whole months. **Fixed in this PR.** | `hookka-report-editions.tsx:519-524`; `operations-report.ts:919-923` |
| **Hookka Report** › Logistics **and** Production | **"On-time delivery %"** — printed twice, on two desks | scores our own internal estimate against itself: `dispatchedAt` vs `delivery_orders.hookka_expected_dd`. `kpi-metrics.ts:18-19` states the rule outright — *"`hookka_expected_dd` is OUR internal estimate and must never be scored against"*. The denominator also requires `dispatched_at IS NOT NULL`, so **an order never dispatched — the worst case — is excluded** and lateness can only be under-reported. And `operations-report.ts:1202` does `production.onTimePct = delivery.onTimePct` — the two desks print **one number twice**, appearing to corroborate each other. | `operations-report.ts:873-876, 1202` |
| `/planning` › Capacity Overview | **"Daily Capacity — 7-day rolling *actual* avg"** | `slimJobCardsToPlanningLite` (`production-orders/_helpers.ts:5311`) does not emit `actualMinutes` at all, so the `useActual` branch is **dead code** and the figure is pure `estMinutes`. The caption is false by construction. `BUG-CLASSES.md:912` already records the owed fix ("removing the `useActual` branch") — still open. | `planning/index.tsx:948, 988` |
| `/planning` › Capacity Loading | **"Past avg (N%)"** | `producedMinutes / dailyCap`, where `dailyCap` **is the rolling average of those same past days** (`:1179`). Numerator and denominator come from one dataset: a factory that halved output still reads ~100% after 7 days, because the denominator falls with it. It cannot detect a sustained decline. | `planning/index.tsx:1179, 1219` |
| `/planning/mrp` › Fabric | **"1 Week / 2 Week / 1 Month Usage"** | the source fields are commented **"forecast"**. Forecast demand printed under "Usage"; the genuine consumption figure (`lastMonthUsage`, from `cost_ledger` RM_ISSUE) exists and is not rendered. | `fabric-usage.ts:388-391` |
| `/production/:dept`, batch toolbar, **printed Production Sheet** | **"Prod Time / Total Production Time"** | `productionTimeMinutes \|\| estMinutes \|\| 0` — BOM standard time on paper handed to the floor, and the `\|\| 0` silently contributes **0 minutes** for cards with no BOM time (`planning-capacity-audit.ts:196` exists precisely because those cards cause invisible overload). | `baserows-core.ts:492` |
| `/kpi` | per-person **"actual"** and the **RM payout** | all five AUTO metrics are **company-wide** — no user predicate. Two people on the same KPI always show an identical "actual", and one person's bonus is priced off a factory-wide number. `kpi-metrics.ts:642-644` concedes it; the card does not. | `kpi-metrics.ts:85, 206, 349, 646, 688` |
| `/kpi` | **"Product master data completeness"** shown under *"Score · 2026-07"* | `setupCompleteness(c)` takes **no period and applies no date filter** — it is always today's snapshot, so its month-on-month delta is 0 by construction. | `kpi-metrics.ts:749` |
| `/accounting` › Monthly Trend | NET SALES / COGS / GROSS / OTHER INCOME / OPEX / NET PROFIT | calls `computePnlWindow` **without** the `pnl_section_map` override and **without** the `selectHistoricalWindow` swap that the other three P&L surfaces pass. So an owner-reclassified account buckets differently here than on the P&L Statement — **same label, same month, different number** — and pre-opening months print `RM 0.00` where Monthly P&L shows his `pnl_historical` figures. | `accounting.ts:7616` vs `:7660, 7741` |
| `/accounting` › Monthly P&L | Accumulated column: OPENING/CLOSING STOCK, WIP OPENING/CLOSING | when any FY month is pre-opening, `sumPnlWindows` adds the monthly windows — so stock **balances** are summed like flows and an FY "opening stock" becomes Σ of 12 monthly openings (**up to 12×**). Subtotals stay right because the errors telescope; only the component lines the owner reads are wrong. | `accounting.ts:7755`; `lib/pnl-historical.ts:128` |
| `/accounting` › AR control | *"Outstanding from invoices (gross)"* + its **"matches ✓"** badge | the badge compares the ledger control against the **net** figure (after un-knocked customer advances) while the number printed beside it is **gross**. With any receipt on account it reads "matches ✓" next to a figure that does not equal the control. **The AP twin was fixed for exactly this** (`:3960-3969`); AR was not. | `index.tsx:3653-3655` |
| `/accounting` › AP | *"Total Outstanding"* (aging) vs *"Net owed to suppliers"* (control), on one screen | `/ap-control` also subtracts unallocated posted `purchase_credit_notes`; `/aging` does not. Two different numbers, both presented as "what we owe", with no explanation of the gap. | `accounting.ts:592, 2688` |
| `/accounting` › Labour | **"Total labour cost"** and **"Post ⟨amount⟩ to GL"** | filters `WHERE status != 'CANCELLED'`, but payslip statuses are `DRAFT\|APPROVED\|PAID` — **`'CANCELLED'` is never written anywhere**, so the filter is a no-op and **unapproved DRAFT payslips are counted and posted to the GL** as direct labour. | `accounting.ts:9412`; `payslips.ts:135` |
| `/accounting` › Stock Take | header: *"Leave a group blank OR enter 0 to keep the system's automatic (FIFO) figure"* | under `rm_valuation_mode='stock_take_only'` blank is **not** automatic — `importedVal` returns 0, closing stock is zero, and `consumed = opening + purchase − 0` expenses the month's entire purchase. The header is unconditional and contradicts the mode card three rows below it. | `index.tsx:1702` vs `accounting.ts:6844` |
| `/accounting` › Cost & Expense Classes | the whole report, incl. **"TOTAL COST OF PRODUCTION"** | defaults `fy = current calendar year`; with the repo's non-December FYE that anchors on the **next, not-yet-started FY** → twelve empty columns. `CostStructureTab` was fixed for precisely this on 2026-07-28 (`fy=null`, server picks); this tab was not. Every cell renders `-` for zero but the grand total renders `formatCurrency(0)` → **"TOTAL COST OF PRODUCTION RM 0.00"**. | `index.tsx:4865, 4925` |
| `/accounting` › P&L Statement (Sofa / Bedframe) | shared DIRECT LABOUR / OVERHEAD / OPEX / OTHER INCOME | apportioned by invoiced-sales share — but **when a period has no matching invoices the ratio silently defaults to 0.5 / 0.5**, and any invoice item whose `productCode` has no `products` row falls to **sofa**. The rows carry no apportionment marker (the Cost Structure tab, by contrast, labels them `(shared)`). | `accounting.ts:7122, 7342, 7351` |
| `/accounting` › Trade Finance | the **aging tiles** "Not due / 1-30 / 31-60 / 61-90 / 90+ d" | when a draw has no keyed due date the **read endpoint invents one**: `dueDate = payment.date + tenorDays` (default 90), and if the payment row is missing, `drawDate = new Date()` — **today**, so an old unpaid draw lands in *"Not due"*. Assumed and bank-stated maturities render identically. (Side effect: a GET writes rows.) | `api/lib/trade-finance.ts:145-167` |
| `/inventory/stock-value` | **"Total Inventory Value"**, category tiles, trend | the **only** writers of `monthly_stock_values.closingValue` are that page's own POST/PUT; `closing = opening + purchases − consumption`, seeded from the prior period's closing, from 0. No GRN, PI or cost-ledger event feeds it. A parallel, hand-typed inventory book sitting beside the cost-ledger-derived Stock Summary, with nothing reconciling the two. | `stock-value.ts:66, 140, 251` |
| `/accounting` › Stock Summary | **"Consumption"** + the caption *"Opening + Purchases − Consumption = Closing … live from the cost ledger"* | consumption **is** the plug: `consumedSen = openingSen + purchaseSen − closingSen`. The identity in the caption is true by construction — this is the same tautology whose green ✓ was removed as BUG-2026-08-13-093; the underlying formula is still what the column shows. Purchases come from the PI ledger while opening/closing come from FIFO/stock-take, and the code states any timing gap "lands in CONSUMED by design". | `accounting.ts:6879`; `index.tsx:8839, 8864` |

---

## Part 3 — coverage: when a clean number means "cannot see"

This is the failure mode of BUG-2026-08-13-096 — a tile reporting *0 problems*
from a query that structurally cannot observe the problem.

| Screen | Figure | What it cannot see |
|---|---|---|
| Command Center + `/daily-report` | the **Daily Report headline count** and every chip | **All thirteen checks swallow their own errors.** `checkOverdueOrders`, `checkLowEfficiencyWorkers`, `checkProcessSkips`, `checkMissingWipTimes`, … each `catch { console.error(...); return []; }` (`compliance-report.ts:387, 428, 489, 592, 770, 863, 877, 895, 1058, 1135, 1193, 1244, 1296`). A check that throws contributes **0** to the total and to its chip, indistinguishable from a check that ran clean. The payload has no way to say "3 of 13 could not run". **Both** the tile and the printed Hookka Report inherit this. |
| Morning brief §8 | *"Forward OT Outlook — all clear"* | `agent-learning.ts:809` `if (capacity <= 0) continue;` — a department with **no completions in the window is skipped entirely**, so the department that produced nothing can never raise a signal. Load counts only `status = 'WAITING'` cards (`:764`): IN_PROGRESS, PAUSED, BLOCKED and already-overdue work contribute zero. |
| Morning brief §1 | *"Nothing due today."* | `WHERE jc.dueDate = ?` — exact equality (`schedule-overdue-report.ts:117`). Cards due last week are invisible; the line can print over a backlogged floor. |
| Command Center | **Delivered**, **Outstanding**, **Pending Delivery** | `priceForItem` ends `return idx.byAnyCode.get(code) ?? 0` (`do-value.ts:77`) — a delivered line whose price cannot be resolved contributes **RM 0** silently. And `outstandingItemsSen = Math.max(0, csRevenue − deliveredItems)` (`sales-orders.ts:1031`) subtracts an **item-level** valuation from **SO-header** totals; the `max(0, …)` clamp floors any basis mismatch to a confident `RM 0.00`. How many lines fail to resolve: **unmeasured**. |
| `/employees` › Labor Cost | **Production / Non-Production / Total Labor Cost** | `if (!w.basicSalarySen) continue` (`employees.tsx:8880`) drops that worker's hours **and** cost from the totals, with no "—" and no warning. |
| `/employees` › Working Hours | *"N pending / approved / rejected adjustments"* | three queries hard-capped at `LIMIT 200` with no `total` returned (`working-hour-entries.ts:1164`) — a ceiling shown as a count. On fetch failure all three arrays become `[]` and the card **hides itself**, so an outage looks exactly like "nothing pending". |
| `/employees` › Attendance | Avg working / production hrs per day | denominator is `daysWithEntries` — only days that already have a row. **Absence is structurally invisible**; a healthy 9.0 h can mean "cannot see". `punch-autofill.ts:141` writes the contracted shift for forgotten punch-outs and the summary SQL does not exclude them. |
| `/finance-dashboard` › Balance Sheet | Total assets / liabilities / debt-to-assets | any account whose type is not ASSET/LIABILITY/EQUITY is dropped (`accounting.ts:10468`) with no "unclassified" line and **no A = L + E check anywhere on the page**. The leg query carries **no `orgId` filter** (`:10433`) while the P&L does — whether the DB holds more than one org is **unmeasured**. |
| `/finance-dashboard` › Cash Flow | Money in / Money out | a transfer **between two bank accounts** contributes to both, inflating the pair. |
| `/accounting/cash-flow` › Forecast | **"Expected Inflows (12w)" / "AR Inflow"** | two structural omissions. (a) only `PAID`/`CANCELLED` are skipped, so **DRAFT (unissued) invoices count as expected cash** — unlike `/accounting/aging`, which excludes DRAFT. (b) the forecast reads only the **next 12 Mondays** (`getNextWeeks`), so **every overdue invoice is silently dropped** — its week key is in the past and never read. The most collectable AR is invisible in a figure captioned "Expected Inflows". Invoices with no `dueDate` are dropped too. |
| `/accounting/cash-flow` › Forecast | **"AP Outflow" / "Expected Outflows (12w)"** (C15 row 20, still open) | buckets **unreceived POs by expected DELIVERY date** and never looks at `purchase_invoices` — real AP contributes nothing. It keeps DRAFT and SUBMITTED POs, and takes the **full `totalSen` for PARTIAL_RECEIVED** POs, counting already-delivered value again as future cash out. The identical computation on `/reports` was fixed on 2026-08-13 **by relabelling it** "Open purchase orders by expected date"; this twin still calls it AP and feeds Net Cash Flow and Running Balance. |
| `/accounting` (whole page) | P&L, Balance Sheet, Cost & Expense Classes | a leg posted to a code **missing from `chart_of_accounts` is silently dropped** (`accounting.ts:7128, 7150, 7225, 8189`), while the Trial Balance shows it as `(unknown account)`. TB and BS can disagree with no warning. |
| `/accounting` › AR aging | every AR figure | the snapshot's `sourceTables` omit `payment_records` and `document_lifecycle`, which the advances loader and the void path actually write — so **AR aging serves stale data after an unallocated receipt or a void**. |
| Hookka Report | *"Stuck > 5 days after production"* | `WHERE dord.dispatched_at IS NOT NULL` — only already-dispatched DOs are visible. **A unit sitting on the floor, the actual stuck case, has no dispatched DO and is structurally invisible.** |
| Daily Report | *"N on the Floor Below Pace Yesterday"* | `addDaysYmd(todayYmd, -1)` while the sibling entry point uses the holiday-aware `previousWorkingDay`. On Mondays and post-holiday days it reads a day nobody worked → `0`. |
| `/planning/mrp` | *"Shortages Found: 0"* | POs with no BOM are skipped. The server **computes and emits** the caveat (`meta.matchedPOs` / `unmatchedPOs` + a warning); **`mrp.tsx` never reads `meta`** — it is typed away at `:95`. "0 shortages" is indistinguishable from "no PO had a usable BOM". |
| `/production` | **"Bedframe ⚠ N / Sofa ⚠ N"** overdue chips | overdue requires the SO's `hookkaExpectedDD` to be non-empty **AND** an open UPHOLSTERY card. POs with no UPHOLSTERY stage, CO-origin POs and blank Expected DD **cannot** be counted — yet the zero-state tooltip asserts *"No overdue Bedframe pieces system-wide"*. ACCESSORY has no chip at all. |
| `/production/wip-times` | **"⚠️ Missing BOM time"** | filters `versionStatus='ACTIVE'`, so a product with **no active BOM template** — the most complete form of "missing BOM time" — produces no row and is invisible. |
| `/kpi` | every AUTO metric on a historical month | `kpi_periods` is never written, so a "settled" month is recomputed against today's data (see Part 2a). |

---

## Part 4 — two things found outside this audit's scope, reported not touched

1. **The `× 0.85` fabrication has THREE sites, and two are outside
   `attendance.ts`.** `src/api/routes/worker.ts:1178` (worker PWA clock-out) and
   `:939` (`autoCloseForgottenPunch`) both write
   `productionTimeMinutes = round(minutes × 0.85)` into `attendance_records`,
   and `:940` derives `efficiencyPct` from it — which on the auto-close path
   reduces to **a literal 85%, for every forgotten punch, forever**. A fix
   scoped to `attendance.ts:332` alone leaves the constant alive on the other
   write path. **Not edited here on purpose:** it is one fix, and two agents
   editing one constant is how a half-fix ships. Whoever merges must confirm
   `worker.ts:939` and `:1178` are covered.

2. **`efficiency-report.ts:289` divides by all `working_hour_entries` with no
   `isProduction` filter**, while its own header claims it mirrors
   `/api/department-performance`, which does filter. The daily email and the
   Employees tab therefore print **different efficiencies for the same worker on
   the same day**. Also in the off-limits file; reported only.

3. **A guard file states the opposite of the truth.**
   `tests/no-fabricated-efficiency.test.mjs:6-10` asserts in prose that *"Real
   work time IS being recorded, on a minority of cards."* That was refuted by
   the later prod count recorded at `src/pages/reports.tsx:782-786` (4,289 of
   4,289 non-zero `actualMinutes` are byte-identical to `estMinutes`). The guard
   file is stale and will mislead the next reader — a comment in a **test** is
   the worst place for a wrong claim, because it reads as verified.

4. **`GET /api/cash-flow` has no `requirePermission` gate**
   (`src/api/routes/cash-flow.ts:153`), unlike every `/accounting/*` report.
   Not a data-truth defect; found on the way and worth someone's attention.

5. **The forbidden `actualMinutes ?? estMinutes` survives at ~30 sites**,
   including `planning/index.tsx` ×8, `dashboard-overview.ts` ×3 and
   `planning-adaptive-capacity.ts:324`. `tests/no-fabricated-efficiency.test.mjs`
   covers only three files. This is why "Daily Capacity" is **two different
   numbers under one label**: `dashboard-overview.ts:945` computes it from
   `actualMinutes ?? estMinutes`, `planning/index.tsx:988` from `estMinutes`
   only. They diverge on exactly those 4,289 cards; the magnitude is
   **unmeasured**.

---

## Part 5 — what this PR changed (three unambiguous, low-risk fixes)

Everything requiring a judgement call about what a metric *should* mean is in
Part 6, unfixed, per the owner's standing rule.

| bug | fix |
|---|---|
| **BUG-2026-08-13-103** | Command Center Daily Report tile: a failed read now renders **"—"** and *"Couldn't load — this is not a clean day, it is an unknown one"* with a Retry, instead of a green `0` / *"All clear"*. Gated on `isUnknownOutcome(failure)` — the repo's existing single decision. |
| **BUG-2026-08-13-104** | `OcrAccuracyCard`: *"No scans yet."* now renders only for an observed 2xx empty body; a dead read gets an honest failure card with a Retry. |
| **BUG-2026-08-13-105** | `OcrAccuracyCard` by-Supplier rows now pass `s.total` to `rateColor()` / `pct()`. `MIN_SAMPLE` was added **because that panel printed a red 0% off one document** (owner 2026-08-05) — and it was the one call site that never forwarded the sample size, so the guard was live everywhere except where it was asked for. |
| **BUG-2026-08-13-106** | The Hookka Report's printed Receivables strip now renders **all five** aging buckets. `d30Sen` — invoices exactly one month overdue — was computed and never printed, so that money vanished from a printed statement and the four boxes did not tie to the "Receivables" total beside them. The surviving labels were each shifted one bucket and claimed *days* over a whole-month calculation; they now say what the maths does. |

Guarded by **`tests/dashboard-truthfulness.test.mjs`** (structural source
assertions — nothing else can catch a plausible number). Every assertion was
proved RED by reintroducing the exact removed expression and watching it fail.

---

## Part 6 — owner decisions (collected, not decided)

Each of these needs a ruling on what the metric should *mean*. None is a
provable defect that can be fixed unilaterally.

1. **Do the "Production Hours / Production Time / Daily Capacity" captions get
   relabelled to say "standard"?** The arithmetic is defensible; the wording is
   not. Renaming ten tiles changes what the owner reads every day, so it is his
   call, not an editor's.
2. **Is real production time going to be measured at all?** Every efficiency
   figure in the system is standard-vs-clocked until something records a
   duration. Until then no tile can answer "did this card overrun?".
3. **PCB** — implement the calculation, or remove PCB from the tile caption and
   the payslip so `netPay` stops being overstated?
4. **Annual leave entitlement** — 8 or 14? It needs a column, and the year reset
   needs to exist. Today the office and the phone disagree.
5. **`freeCashFlow: cf.operating`** (`accounting.ts:10692`) carries the comment
   *"owner: treat as no fixed assets"* — but `investing` is computed in the same
   object and a fixed-assets module exists (`accounting.ts:11174`). Re-confirm
   the ruling, or make it `operating + investing`.
6. **The Cash Flow tab strip is inert.** Operating / Investing / Financing /
   Free Cash Flow change **one footer row**; the bars are hard-wired to
   `inflow`/`outflow` and the line to `net` (`finance-dashboard.tsx:1143-1145`).
   A user switching tabs sees an unchanged chart and concludes the sections are
   equal. Fix the chart, or drop the tabs.
7. **Should the compliance report be able to say "I could not check"?** Today a
   thrown check is a silent `0`. Surfacing it changes what the Daily Report
   headline number means.
8. **The Sales-by-Customer "Total" / concentration denominator** — top 12, or all
   customers? `aovCompany.totalSen` (the real total) is already in the payload.
9. **ROE / ROA** — annualise and fix the equity basis, or remove until the
   year-end close is part of the flow.
10. **`GET /api/reports/brief.json` has no page consumer** (grep across `src/`).
    The HTML brief is opened directly in a tab per
    `docs/context-packs/HOOKKA-GOTCHAS.md`; the JSON twin appears to be
    maintained for a dashboard card removed on 2026-08-05.
11. **`/accounting/cash-flow`'s bank module** — is it meant to be live? Today its
    balances are a demo seed plus this page's own form, and its Bank
    Reconciliation reads a demo account code out of the manual-JV tables. Either
    wire it to `ledger_journal_entries` + the real `SBK`/`SCH` accounts, or
    label the whole tab a scratchpad. **It should not sit under "Current Cash
    Position" as it stands.**
12. **`/kpi`'s per-person figures** — should an AUTO metric be per-user at all?
    All five are company-wide, and a bonus is priced off them. Either scope the
    queries to the user or say on the card that the figure is factory-wide.
13. **Should a "settled" KPI month actually settle?** `kpi_periods` exists, has
    a unique index, and has no writer. Either write it at month end or delete
    the lock path and the "settled" wording.
14. **Hookka Report "On-time delivery %"** — there is no customer-committed date
    being scored today. Pick the field that should be scored (the customer's
    date, not `hookka_expected_dd`) and decide whether never-dispatched orders
    count as late. Until then the figure flatters, and it is printed twice.
15. **AR aging vs AP aging vs the controls** — three "what we are owed / what we
    owe" numbers with different definitions on one page. Which one is *the*
    number?
16. **The GL grouped-view 4,000-row budget** — raise it, paginate it, or stop
    printing a grand total when the render is capped. Today the totals and the
    rows describe different populations.

---

## Part 7 — what is genuinely sound (do not "fix" these)

The mirror-image mistake is deleting a measured metric while cleaning up a
fabricated one. These were traced and are honest:

* **Command Center money**: `salesThisMonthSen` (Σ `sales_orders.totalSen` by
  `companySODate`, DRAFT/CANCELLED/ON_HOLD excluded), `invoicesThisMonthSen`
  (Σ invoice totals by `invoiceDate`, cancelled excluded), the three-lens Revenue
  chart, and `deliveredOfMonthOrdersSen` (a genuine same-cohort funnel).
* **`GET /api/delivery-orders/pending-value`** — reuses the identical readiness
  predicate the Delivery page lists, and `tests/pending-delivery-value.test.mjs`
  pins the two summations row-for-row.
* **Per-department backlog "stalled"** — `dailyCapMin = 0` yields `backlogDays =
  null` and the UI prints *"stalled"* rather than dividing by a 1-minute
  fallback (`dashboard-overview.ts:1063`). This is the right pattern.
* **`OcrAccuracyCard`'s `MIN_SAMPLE`**, the `unit` field on every bucket, and
  `rate === null → "—"`.
* **The Command Center's month-awareness tags** — *"live (no history before
  today)"* / *"≈ reconstructed (month-end est.)"* / *"as of <date>"* — are
  provenance published beside the figure, exactly as C15 asks.
* **Morning brief §7 (Handoff Learning)** — real observed gaps between
  `completedDate`s, printing `samples` beside the average.
* **`/finance-dashboard` P&L, forecast rows, and the fg_batches double-count
  warning printed in red on the card** — a known defect stated on the screen
  that carries it.
* **`/accounting` › Overview Revenue / Cost & Expenses / Net Profit** — C15 row
  25 is **genuinely fixed**: the period reaches the query, `—` is published for
  an unposted category rather than `RM 0.00`, `COST` is back on the expense
  side, and the writers are real document events.
* **`/accounting` › Cash Flow (in-page), Trial Balance, GL single-account, Cash
  Book, and the Balance Sheet's "by company" card** — C15 rows 24 and 27 are
  genuinely fixed and the Trial Balance gates its badge on loaded data, which is
  the pattern the Balance Sheet tick should copy.
* **`production-orders.ts` `/report-summary`** (`:550-640`) — **the template for
  this whole class.** It enters the ratio only when `actualMinutes > 0`, has
  **no** `?? estMinutes` fallback, and emits `measured_distinct_cards` so the
  page can refuse to publish a percentage that merely looks measured.
* **`/planning`'s Efficiency Overview table** — renders `—` for missing inputs,
  a "No Data" status, and **discloses its own formula in the column tooltips**.
* **All nine `/planning/dept/*` pages** — caption honestly ("saved snapshot" vs
  "live recompute").
* **`promise-date.ts`** (C15 row 12) and **`scheduling.ts`** (C15 row 15) — both
  fixes held: per-product `materialAvailability` is `null`, the org-wide value
  was renamed, the real `workingHoursPerDay` is used, and `assumedEfficiency` is
  published beside the numbers.
* **`production_orders.progress`** = `donePieces / pieces` from real job-card
  statuses — measured.
* **`/kpi`'s SURVEY / MANUAL / CHECKLIST metrics** fall to `—`, not `0` — the
  pattern the AUTO metrics on the same page should follow.
