# Performance & Correctness Backlog

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-14** against `src/pages/employees.tsx`,
> `src/pages/m/config/modules.ts`, `src/api/routes/attendance.ts`,
> `src/api/routes/department-performance.ts`, `src/api/lib/supabase-compat.ts`,
> `src/api/lib/db-pg.ts` and `src/lib/cached-fetch.ts` — the `/employees` pass
> (P13, BUG-2026-08-13-110…-114). The 2026-08-13 verification below still holds
> for everything else in this file.
>
> **Last verified: 2026-08-13** against `vite.config.ts`, `src/pages/m/screens/Home.tsx`,
> `src/pages/reports.tsx`, `src/components/layout/sidebar.tsx`, `src/lib/scheduler.ts`,
> `src/lib/cached-fetch.ts`, `src/components/ui/data-grid.tsx`,
> `src/api/routes/delivery-orders.ts`.
>
> Corrected 2026-08-13: **the "sidebar notifications poll — not reproduced, do NOT
> chase" note below is wrong, and the refutation is what is wrong, not the finding.**
> The code polls: `src/components/layout/sidebar.tsx:455-483` calls a raw
> `fetch("/api/notifications")` on mount and then from `useInterval(fn, 60_000)`.
> `useInterval` (`src/lib/scheduler.ts:56`) defaults `pauseOnHidden: true` and
> `runImmediately: false` — so on a **visible** tab it fires at +60 s, +120 s, … The
> disproof was an idle observation of **50 s**, which is shorter than the interval and
> therefore cannot see the first tick. `/api/notifications` still has no LIMIT
> (`src/api/routes/notifications.ts:93`) and the caller passes no `?isRead=`. Re-probe
> with an idle window of ≥3 minutes before dismissing it again. (This is exactly the
> failure this file warns about — measure the call the app makes, over a window long
> enough for it to happen.)

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

## P13 — /employees + the efficiency screens  🟡 BRANCH `perf/dashboard-lag`, NOT DEPLOYED

The owner's "有一些在效率方面好像确实有点卡". Five findings, all **fan-out and payload**,
none of them a slow endpoint — exactly the shape this file says to hunt.
Full detail in docs/BUG-HISTORY.md BUG-2026-08-13-110 … -114.

| # | what | before | after | how the "after" was obtained |
| --- | --- | --- | --- | --- |
| -110 | `/employees` KPI cards + Attendance-tab month KPI pulled the FULL `/api/department-performance` payload to read `data.totals` | **4,960 KB** (31-day window) | **9.7 KB** | COMPUTED — ran the real `projectPerformanceSummary` over a synthetic payload in the handler's shape, calibrated so 61 days = the 9.5 MB prod figure |
| -111 | Employee Performance tab pulled EVERY worker's punches for its window, filtered to one in the browser | all workers | 1 worker | STRUCTURAL — `?employeeId=` added to the WHERE |
| -112 | 3 mobile `/m` sources pulled the same full payload | up to several MB | ~10 KB | same computation as -110 |
| -113 | `GET /api/attendance` ran `SELECT *`, so every list read pulled two base64 JPEG punch selfies **per worker-day** out of Postgres and discarded them | prod: 2,818 rows = 1.28 MB response but **1.7–6.3 s** | blobs no longer read | NOT QUANTIFIED — the saving is Postgres→Worker bytes, invisible from the browser |
| -114 | `/employees` held its FIRST PAINT behind an `/api/attendance?date=today` fetch whose result nothing read (`const [, setDateAttendance]`) | 1 blocking request | 0 | reading the code |

**Every "after" here is computed or structural. Nothing in this row was measured on prod** —
the branch is not deployed and prod is behind login. The "before" figures are the prod
measurements already in this file. Re-measure after deploy before repeating any of these
numbers to the owner.

**-113 is the one to re-measure first.** It is the only finding whose size is unknown, and
it is the best candidate for the actual "卡": a punch selfie is REQUIRED to clock in/out and
is stored inline on the row, and the Working Hours tab (the DEFAULT tab of `/employees`)
asks for a whole month of them on mount. It also explains the standing oddity that this
endpoint took seconds to return a 1.28 MB body.

### Found on this page and deliberately NOT changed

- **The three `/m` department-performance screens render ZERO rows and always have.** Their
  `select` peels `data.departments`; the endpoint returns
  `{range, departmentCode, category, totals, daily}` and never had that key, in either view.
  `view=summary` cuts what they download; it does not make them work. Deciding what
  "capacity / loading / dept performance" should show on a phone is a product call, and
  inventing a mapping to make three screens look populated is the failure logged three times
  on 2026-08-13 (hashed Worker Efficiency, self-dividing Department Efficiency, hardcoded
  P&L). **Owner decision.**
- **The Department Performance TAB still requests the FULL payload, on purpose.** It is the
  one caller that renders `daily[].workers[].jobs[]` when the operator expands a day.
  There is a NEGATIVE lock test so a future sweep cannot "consistently" narrow it too.
- **`useCachedJson` always re-fetches on mount** (P7 below) — untouched. It is the systemic
  lever for the whole app, not a `/employees` fix, and changing it belongs in its own change
  with its own before/after.
- **The Working Hours tab fires three parallel `nonprod-requests` calls** (PENDING /
  APPROVED / REJECTED), i.e. three slots in the serialised queue for one panel. Collapsing
  them needs an endpoint that returns all three statuses in one response, and the existing
  route has a LIMIT 200 whose semantics per-status vs combined are not obviously equivalent.
  Not worth a correctness risk without a measurement.
- **`GET /api/attendance` still has no LIMIT.** Left alone deliberately: after -113 the row
  is small, every real caller is date-scoped, and adding a cap risks silently truncating a
  month view. Revisit only with a measurement that says the row count itself is the problem.

## P1–P5 — ALL SHIPPED 2026-08-13 (see the table at the bottom)

Pending Delivery tile, /planning cold start, Service Cases hang, the dead Master
Tracker, and the fabricated Department Efficiency are done, deployed and verified
on prod. Their detail now lives in docs/BUG-HISTORY.md (BUG-2026-08-13-001..-008)
— the ledger is the source of truth for what was wrong and how it was proven.

## P10 — Financial P&L was fabricated  ✅ SHIPPED (BUG-2026-08-13-009/-010)
Reports › Financial: **COGS = `revenue × 0.65`**, and Salaries / Utilities / Rent /
Others are hardcoded **RM 50,000 / 8,000 / 15,000 / 5,000** — rendered exactly like
sourced account balances. Gross profit, net profit and every margin inherit the
invention.

Third fabricated-metric bug of the day (after Worker Efficiency from a hash of the
worker id, and Department Efficiency dividing an estimate by itself). Prod holds
only **2 journal entries / 50 journal lines**, so most lines probably CANNOT be
honestly sourced yet — a mostly-"—" P&L that states why beats an invented one.
Needs an owner decision on which accounts roll into which bucket; do NOT invent
that mapping to make the page look complete.

## P11 — Mobile home Pending-Delivery + orders-due  ✅ SHIPPED (BUG-2026-08-13-011/-013)
`src/pages/m/screens/Home.tsx` still derives Pending Delivery in the browser from
the whole-org production-order fetch — the exact read that made the desktop tile
spin forever. Desktop's fix is deployed: `GET /api/delivery-orders/pending-value`,
measured **589 ms**, reconciling exactly with the Delivery page.
Matters MORE on mobile, not less — the factory floor uses phones on worse networks.

## P12 — 1 MB PDF chunk static edge  ✅ SHIPPED (BUG-2026-08-13-012) — 53 importers → 14
`__vitePreload` got parked inside the `pdf` manual chunk, so **any chunk containing
any `await import(...)` statically pulls 1,036 KB of PDF vendor code** — measured on
`/employees` (`pdf-D5mT946N.js`, 1,013 KB, loaded on mount). Not that page's fault;
~30 chunks share the edge (dashboard-b, customers, delivery, accounting…).
`modulePreload.resolveDependencies` cannot help — it strips preload hints, not
import edges. The fix is in `manualChunks` (`vite.config.ts`); it changes how EVERY
page loads, so prove PDF generation still works before shipping.

## P6 — Fat payloads  🟡 (two of three now have a narrow read)

`/api/delivery-orders` 1.07 MB · `/api/inventory` 1.16 MB ·
`/api/production-orders/historical-wips` **8.39 MB** (only on opening the
"Create Stock PO" dialog, so not on a page-load path).

**2026-08-13 — the whole-org-fetch-shape pass (BUG-2026-08-13-020..-026).** The
endpoints are unchanged by default; what changed is that callers can now ask for
what they read:

| endpoint | narrow read added | callers moved |
| --- | --- | --- |
| `/api/inventory` | `?buckets=finishedProducts\|wipItems\|rawMaterials` | **all 14** — none read more than one bucket. Plus `procurement/detail` and `suppliers/detail` now GATE the fetch behind the edit toggle / the modal, so a page being READ fetches nothing. |
| `/api/delivery-orders` | `?fields=case-pipeline&scope=<soIds>` | `service-cases/detail` (the fetch BUG-2026-08-13-003 missed) |
| `/api/sales-orders` | `?fields=customer-mini` | the `/m` Customer detail's Recent-Orders panel (2.16 MB → 8 keys/row) |
| `/api/customers` | *(none needed — `/:id` already existed)* | `service-cases/detail` |

**Still fat, and why not touched:** `historical-wips` (8.39 MB) is dialog-gated, so
it is not on a page-load path. `/api/invoices` and `/api/purchase-orders` are still
pulled whole by the `/m` customer and supplier panels — the first has a
`?customerId=` that filters on a **different key** than the panel does (the D6 trap,
on a money surface), the second has no filter and no projection at all.

**Every "after" number in that pass is COMPUTED or structural, never measured** —
the branch is not deployed and the prod API is behind login. The "before" figures
are the prod measurements already in this file.

## P7 — Duplicate calls per navigation  🟡

Across 7 module hops: `customers` ×8, `datagrid-layouts` ×8, `organisations` ×6,
`notifications` ×2–4. Wasted slots in a queue that is the bottleneck.

Root cause now known (audit, PR #288): **`useCachedJson` ALWAYS re-fetches on
mount** (`cached-fetch.ts:478`, `void ttlSec`). "The cache is warm from the list
page" is false for the network — the whole burst fires again on every navigation
into a record. That is the lever for P7, not per-page deduplication.

## Grid search loads the whole table  🟠  (measured 2026-08-13)

When a filter/search goes active, several grids drop pagination and fetch the
entire dataset to filter in the browser. Deliberate (so the grid can show every
match), but the cost scales with the table:

| page | measured | server `search=`? |
| --- | --- | --- |
| `/sales` | **2,215 KB decoded**, 4,480 ms on the first keystroke | **YES** — pg_trgm, `?search=` returns 164 matches in **172 ms** and already includes `total` |
| `/procurement` | 0.16 MB / 113 ms (only 165 POs) | no |
| `/procurement/grn` | not measured | no |
| `/production` | **fires nothing** — the page starts empty by design ("Pick a filter or Load all") | no |

`/sales` is the only one that currently hurts. **The trap before swapping in the
server search:** the client matches **17 visible columns**, the server matches 5 —
a naive swap silently stops matching status, state, company, current-dept and the
three date columns. Any fix needs a before/after result-set comparison, not just
a timing.

~~Not reproduced, do NOT chase: an audit reported the sidebar re-polling the whole
notifications feed every 60 s app-wide. Measured on `/sales`, idle 50 s:
**zero notification requests**. Whatever the code path implies, it is not firing
in normal use.~~
**RETRACTED 2026-08-13 — the disproof was invalid, the finding stands.** A 50-second
idle window cannot observe a 60-second interval that does not run immediately.
`sidebar.tsx:455-483` = raw `fetch("/api/notifications")` + `useInterval(…, 60_000)`;
`scheduler.ts:56` fires at +60 s on a visible tab. Re-probe idle for ≥3 minutes.

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

> **AMENDED 2026-08-14 — the note above is still right and was still hiding two
> real defects.** "Nobody makes the bare call" remains true and is why this was
> correctly not a P1. But (a) a caller can be date-scoped and STILL over-fetch on
> a different axis — the Employee Performance tab pulled every worker's punches
> to render one worker's (BUG-2026-08-13-111); and (b) the numbers in this very
> paragraph contain a clue that went unread for a day: **1.28 MB should not take
> 6 seconds** on a table with no joins. It was `SELECT *` hauling two base64
> punch selfies per worker-day out of Postgres and discarding them
> (BUG-2026-08-13-113). "Not slow as called" answered the question that was
> asked; the ratio between the payload and the time was the question nobody
> asked. Both are fixed on `perf/dashboard-lag`, neither is deployed.

**Measure the call the APP makes, not a convenient one.** Three separate false
alarms this session came from probes the product never issues — a cache-busted URL
(inflated "30 s"), an unparameterised endpoint (this one), and a page that turned
out to be unreachable. Always confirm a live caller with the exact query string
before filing a performance bug.

## P9 — Housekeeping

- Dead code: the two `?fields=` projection blocks in `src/api/routes/sales-orders.ts`
  after the snapshot call are now unreachable (the fast paths cover the same cases).
- ~~`check-bundle-size.mjs` FAILS on main~~ **RESOLVED (re-read 2026-08-14).**
  `.bundle-baseline.json` already carries `finance-dashboard: 31684` (= 30.94 KB) and is
  **auto-regenerated and committed on every push to `main`** by
  `.github/workflows/refresh-bundle-baseline.yml:26`. Do not hand-edit it. The `deploy.yml`
  bundle gate is still `continue-on-error: true`.
- **⚠️ CORRECTED 2026-08-14 — THE REPO IS ALREADY PUBLIC, and Actions IS running.**
  `docs/runbooks/ROTATE-DB-PASSWORDS.md:51` says so outright ("Treat both passwords as
  **already disclosed**"), and `ios-build.yml:14` / `secret-hygiene.yml:11-14` describe it
  as public in the present tense; `deploy.yml` and `refresh-bundle-baseline.yml` both fire
  on push to `main`. This bullet said the repo was PRIVATE and warned against making it
  public — a reader trusting it concludes the credentials are still contained. **They are
  not: rotation is outstanding REMEDIATION, not hygiene.** The original wording, for the
  record: git history contains full prod and staging Postgres connection strings **with
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
5. Gates: `npx tsc -p tsconfig.app.json --noEmit` — **measured clean 2026-08-14: exit 0, zero errors. The carve-out below is RETIRED; treat every error as yours.** ~~(ignore only the 3 jsbarcode/@zxing
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
| Pending Delivery tile computed server-side | **never rendered → 7 ms**; ties to the Delivery page to the sen | #274 |
| `/planning` de-quadratic (35 M comparisons → grouped) | **9,587 ms → 2,412 ms**, 957 rows byte-identical | #275 |
| Service Cases scoped + dead Tracker deleted + Dept Efficiency paired | **30 s abort → 671 ms / 15 KB**; fake 100% → honest "—" | #276 |
| Quadratic-join class sweep (30 sites audited, 4 fixed) | largest survivor 20.8 ms; sha-256 identical | #278 |
| Reports Production summary + Employee metrics de-fabricated | **30,012 ms abort → 1,064 ms**; hash-derived KPIs → real | #279 |
| `/employees` Working Hours windowed | **46,137 → 2,214 nodes; scroll froze >45 s → 0 ms blocking** | #281 |
| Comment corrections (twice) + verification discipline written up | see below | #277, #280, #282 |

### Corrections worth keeping — the investigation is the dangerous part
Eight confidently-stated findings that session were false. Full analysis now lives
in `docs/context-packs/HOOKKA-GOTCHAS.md` ("how the WRONG answer gets produced").
The headlines:
- **"The Production Tracker page cannot load" was wrong twice over.** The 30 s figure
  came from a cache-busted probe (overstated), and the page turned out to be dead
  code. The *live* callers of that URL were dashboard-b and Service Cases.
- **"reports/brief is a cron nobody waits on" was wrong.** People open it in a tab to
  read and print. It was the worst user-facing wait in the app until #272.
- **`actualMinutes` took three passes.** 5 NULL rows → "never recorded"; a non-null
  count → "does record"; finally all 4,289 values are byte-identical copies of
  `estMinutes` and mean nothing. Count a column to call it empty; check its
  DISTRIBUTION to call it useful.
- **The "credential in ~113 tracked scripts" alarm was false** — a placeholder in a
  help string. Repeated to the owner before anyone opened the file. The git-history
  credentials (P9) are real and still need rotating; don't let the false alarm bury
  the true one.
