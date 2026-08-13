# Performance & Correctness Backlog

Owner-facing queue for the 2026-08-13 slowdown investigation. Ordered by **how
much it hurts a real person**, not by how interesting it is.

Everything here was measured live on prod (erp.hookka.com) in the owner's own
browser, not inferred from code. Where a claim was later disproved it is marked
so — trusting a wrong diagnosis costs more than having no diagnosis.

---

## THE ROOT CAUSE (read this before picking anything up)

The API tier **serializes concurrent requests**. Same endpoint, measured on prod:

| calls in flight | result |
| --- | --- |
| 1 | **41 ms** |
| 6 parallel | 39 / 66 / 101 / 138 / 166 / **194 ms** |
| 12 parallel | 1511 / 1549 / … / **1902 ms** |

Perfect ~40 ms stair-steps. The protocol is **h3 (HTTP/3)**, so this is NOT the
browser's 6-connection limit — it is server-side. Every page fires **12–18 API
calls on mount**, so whatever lands last pays for the entire queue.

**Consequences that look like unrelated bugs:**
- Individual endpoints are fast (30–90 ms). Chasing "slow endpoints" is the wrong
  hunt. Chase **fan-out** and **payload size**.
- Rapid navigation aborts in-flight requests → `signal is aborted without reason`.
  Measured: **45 module hops produced 99 aborted calls.** Those aborts are what
  users experience as "报错、不能用".
- Anything whose loading flag never clears after an abort hangs forever (see P1).

**The failure shape is a CLIFF, not a slope.** Work is cached; the cache dies the
moment anyone saves a related record — constant during a working day. Once the
rebuild takes longer than the gap between invalidations, the page flips from
"usually instant" to "usually rebuilding". That is why it felt fine and then
suddenly did not: `git log -S "720 SOs"` shows the dashboard projection was written
2026-06-07 when there were **720 sales orders**; there are now **1,334** (+85% in
~2 months). Expect other snapshot-backed paths to hit the same cliff as data grows.

---

## P1 — Pending Delivery KPI tile never renders  🔴 user-visible breakage

`/dashboard` (src/pages/dashboard-b/index.tsx). Reproduced: SALES, INVOICES and
OUTSTANDING all render; **PENDING DELIVERY has no value at all** — it spins forever.

Not "wrong data" — *absent* data. The gate is
`pendingL = poL || doL || poValL || soItemsL` (~line 775), and `poL` is a bare
`/api/production-orders?fields=minimal&include=jobCards` (~line 713) over all
~2,539 orders **with** their job cards. It can exceed the 30 s abort in
`src/lib/api-client.ts`; when it aborts the loading flag never clears.

**Fix:** compute it server-side and return one number.
**Do NOT translate the rule into SQL.** Reuse `poReadyForDelivery()` from
`src/lib/delivery-pipeline.ts` inside the Worker (`src/api` already imports from
`../../lib/`). It encodes sofa upholstery cards, ACCESSORY products with no
UPHOLSTERY step (BUG-2026-06-20-001), ON_HOLD, CANCELLED, consignment, and
DO-linked exclusion. Re-deriving that in SQL will quietly change a ringgit figure.

Trap already hit once: `jobCards` appears in dashboard-b **only in the URL**, so it
looks unused — but `poReadyForDelivery` reads `po.jobCards` internally. Dropping the
include would have produced a fast, wrong number.

Money path: baseline the current sen figure first, assert the new one is identical.

## P2 — /planning cold start ~9.6 s  🔴 daily pain

`GET /api/production-orders?fields=minimal&include=jobCards-lite&excludeCompleted=true`
→ 1st call **9,587 ms / 4.3 MB**, 2nd 554 ms. Same with and without cache-busting,
so it is real, not a probe artifact.

Owner's decision: **option A — reduce the work, do not remove features.** /planning
is a genuine 4,060-line scheduling tool (PIC assignment, capacity, lead times); it
is not to be reduced to a dashboard.

**Trap:** the route's `dueFrom`/`dueTo` filter on the PO's `targetEndDate`.
**Never set a lower bound** — overdue orders have a targetEndDate in the past and a
lower bound hides exactly the work that most needs scheduling. Upper bound only;
rows with NULL targetEndDate are already preserved by the route.
Derive the horizon from the page's own constants (`LOADING_CHART_PAST_DAYS = 14`,
`LOADING_CHART_FUTURE_DAYS = 21`, **working** days Mon–Sat) plus margin.

## P3 — Service Cases fires the same unscoped 30 s call  🟠 cliff risk

`src/pages/service-cases/index.tsx` (~258) and `detail.tsx` (~283) call
`?fields=minimal&include=jobCards` bare. Same cliff as P1.
`src/pages/production/index.tsx` (~4494) shows the safe pattern: same base URL plus
`&scope=<ids>` so only on-screen rows are fetched.

## P4 — Dead code advertised to users  🟡

`src/pages/production/tracker.tsx` is unreachable: `src/dashboard-routes.tsx:258`
routes `/production/tracker` to `<Navigate to="/planning" replace />`, and nothing
imports the file. Yet `src/components/layout/global-search.tsx:121` still offers a
"Master Tracker" result that just bounces to /planning. Delete the page, fix or
repoint the search entry.

## P5 — A fabricated efficiency figure is on screen  🟡 trust issue

**Verified on prod:** `job_cards.actualMinutes` is NULL on *every* finished job card
(5 COMPLETED orders, 14–26 finished cards each), and `productionTimeMinutes` is not
a substitute — it equals `estMinutes` exactly on every row (standard time, not a
measurement). The factory records no work duration at all; only `completedDate`.

So any UI doing `actualMinutes || estMinutes` divides the estimate by itself and
prints **exactly 100% forever**. Show "-"/"No data" instead of inventing a KPI.

**Do NOT touch `department-performance` / employee / payslip efficiency — it is
REAL.** Its denominator is genuine clocked time from `working_hour_entries`, and it
varies on prod (80% overall, 64% on one day, 48% for one worker). Only remove
figures whose denominator is an estimate standing in for a measurement.

Open business question (not a code fix): whether to start capturing real start/stop
time on the floor. Until then, efficiency-from-job-cards cannot exist.

## P6 — Fat payloads  🟡

`/api/delivery-orders` 1.07 MB · `/api/inventory` 1.16 MB ·
`/api/production-orders/historical-wips` **8.39 MB** (only on opening the
"Create Stock PO" dialog, so not on a page-load path).

## P7 — Duplicate calls per navigation  🟡

Across 7 module hops: `customers` ×8, `datagrid-layouts` ×8, `organisations` ×6,
`notifications` ×2–4. Wasted slots in a queue that is the bottleneck.

## P8 — Aborts surface as user-facing errors  🟡

`verifiedSave` now distinguishes a cancelled readback (`reason: "unverified"`), and
`customers.tsx` keeps the edit on screen. **Other save pages still show the old
false "failed"** — extend the same handling. `cached-fetch` already swallows aborts
on the read path.

## Cleared by the 2026-08-13 sweep — do NOT re-open these

22 endpoints across Invoices, Accounting, Customers, Suppliers, Products,
Warehouse, Consignment, Leads, Workers, Attendance, Payslips, Service Cases,
Delivery Returns, Purchase Invoices, Cost Ledger, Fabric Tracking, Scheduling and
Lead Times were measured individually (sequentially, so none could hide behind
another's queueing). **20 of 22 came back under 1 s.** After the fixes below, the
only remaining hot spots are P1–P3.

**`/api/attendance` is NOT slow — do not "fix" it.** A bare call measures
1.7–6.3 s / 1.28 MB, but no page ever makes one: every caller in
`src/pages/employees.tsx` passes `?date=` or `?from=&to=`. As actually called it is
**126 ms**; a 30-day range is 1,081 ms. This was very nearly filed as a P1.

**Measure the call the APP makes, not a convenient one.** Three separate false
alarms this session came from probes the product never issues — a cache-busted URL
(inflated "30 s"), an unparameterised endpoint (this one), and a page that turned
out to be unreachable. Always confirm a live caller with the exact query string
before filing a performance bug.

## P9 — Housekeeping

- Dead code: the two `?fields=` projection blocks in `src/api/routes/sales-orders.ts`
  after the snapshot call are now unreachable (the fast paths cover the same cases).
- `node scripts/check-bundle-size.mjs` FAILS on main: `finance-dashboard`
  29.45 → 30.94 KB (+5.1%) from bf08623b, baseline not regenerated. Fix with
  `--write-baseline` + commit `.bundle-baseline.json`.
- **GitHub Actions is billing-blocked** — private repo, metered minutes. Deploys are
  currently manual (see below). Do NOT "solve" this by making the repo public: git
  history contains full prod and staging Postgres connection strings **with
  passwords** (commits titled "remove embedded database credentials" — removal from
  HEAD does not remove them from history) plus ~12 other secret-pattern hits.
  **Those credentials should be rotated regardless.**

---

## How to work an item

1. Own worktree + branch off `origin/main`, then **`npm install` immediately** —
   a fresh worktree has no node_modules and every command fails confusingly.
2. Measure the CURRENT behaviour on prod first and write the number down.
3. Change it.
4. Prove equivalence — same rows, same totals, same fingerprint. For anything with
   a ringgit figure this is mandatory, not optional.
5. Gates: `npx tsc -p tsconfig.app.json --noEmit` (ignore only the 3 jsbarcode/@zxing
   errors), `npm test`, `npx eslint <changed>`.
6. PR describing what changed and how it was verified.

### Verification technique that worked
Capture a fingerprint of the live response **before** deploying, then compare after:

```js
const flat = (j.data||[]).map(o => o.id + '|' + (o.items||[]).map(i => i.productCode+':'+i.unitPriceSen).join(','));
let h = 0; const s = flat.join(';');
for (let i = 0; i < s.length; i++) h = ((h<<5) - h + s.charCodeAt(i)) | 0;
```
Identical hash before/after = the projection genuinely did not change the data.

### Deploying while Actions is blocked
```
CLOUDFLARE_ACCOUNT_ID=27cd35c9d93a9f81daa809d0b800b059 \
  npx wrangler pages deploy dist --project-name=hookka-erp-testing --branch=main --commit-dirty=true
```
`hookka-erp-testing` (→ erp.hookka.com) lives on the **Weisiang329@gmail.com**
Cloudflare account, NOT hello@houzscentury.com (which only has houzs-erp*). Wrangler
pins a stale account id even after re-login, so `CLOUDFLARE_ACCOUNT_ID` must be set
explicitly or it 404s "Project not found". Run the CI gates locally first.

---

## Already shipped 2026-08-13 (all verified on prod)

| Change | Result | PR |
| --- | --- | --- |
| PO editable until goods received (was DRAFT-only) | Edit button confirmed on a CONFIRMED, 0%-received PO | #266 |
| `/api/users` off the /sales mount burst | 485 ms → 3401 ms start, out of the queue | #267 → #268 |
| Cancelled readback = "unverified", not "failed" | Stops reverting a save that succeeded | #268 |
| `?fields=price-index` narrow read | **10,963 ms → 815 ms**, fingerprint identical | #269 |
| `?fields=delivery-refs` narrow read | cold 929 ms, fingerprint identical | #271 |
| HTML morning brief cached per date | **10,887 ms → 105 ms**, content unchanged | #272 |
| `tracker-summary` aggregate | 845 ms; 2,539 orders reconciled exactly | #273 |

### Two corrections worth keeping
- **"The Production Tracker page cannot load" was wrong twice over.** The 30 s figure
  came from a cache-busted probe (overstated), and the page turned out to be dead
  code. The *live* callers of that URL are dashboard-b and Service Cases.
- **"reports/brief is a cron nobody waits on" was wrong.** People open it in a tab to
  read and print. It was the worst user-facing wait in the app until #272.
