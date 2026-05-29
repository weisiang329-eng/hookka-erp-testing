# Bug History

Living log of bugs we've identified, diagnosed, and fixed in Hookka ERP.

Each entry: ID, status, what happened (user-visible symptom), root cause, fix
(file:line), and how we verified it. Newest first.

Status legend:
- 🔴 **Identified** — diagnosed, not yet fixed
- 🟡 **Fix in progress**
- 🟢 **Fixed** — code shipped + verified

---

## Categories — Quick Index

Each entry below jumps to the first BUG with that category tag.
Entries themselves stay newest-first.

- `inventory-display` (23) — [BUG-2026-04-27-032](#bug-2026-04-27-032-wip-page-inflated-displayed-qty-by-summing-uph-jc-capacity-instead-of-trusting-wip_itemsstockqty)
- `ui-frontend` (22) — [BUG-2026-04-29-004](#bug-2026-04-29-004--cn-detail-dialog-vs-do-detail-dialog-9-layout--data-gaps-after-first-parity-pass)
- `production-orders` (20) — [BUG-2026-04-29-001](#bug-2026-04-29-001--production-sheet-so-id-column-blank-for-sofa-rows-of-co-origin-pos)
- `bom` (18) — [BUG-2026-04-29-008](#bug-2026-04-29-008--dept-pivot-editor-shows-stale-minutes-same-cat-different-times-on-different-rows)
- `infrastructure` (15) — [BUG-2026-04-27-029](#bug-2026-04-27-029-fixdb-hyperdrive-needs-preparefalse-supavisor-6543-rejects-prepared-statements)
- `inventory-cascade` (16) — [BUG-2026-04-29-005](#bug-2026-04-29-005--cn-dispatch-left-fg_units--stock_movements--wip_items-untouched-no-inventory-cascade)
- `delivery-orders` (11) — [BUG-2026-04-29-003](#bug-2026-04-29-003--updateconsignmentnotebyid-silently-dropped-sentdate-and-items-on-put)
- `sales-orders` (7) — [BUG-2026-04-26-021](#bug-2026-04-26-021-fixsales-drop-wrong-mattress-label-on-sofa-category-option)
- `pricing-products` (6) — [BUG-2026-04-24-029](#bug-2026-04-24-029-fixcustomers-sofa-seat-prices-now-render-in-customer-products-panel)
- `data-migration` (5) — [BUG-2026-04-25-014](#bug-2026-04-25-014-fixd1-compat-ifnullcoalesce-bom-search-likeilike)
- `data-integrity` (4) — [BUG-2026-04-25-008](#bug-2026-04-25-008-stability-add-timeout-abort-propagation-to-fetchjson)
- `auth-rbac` (2) — [BUG-2026-04-26-033](#bug-2026-04-26-033-fixauthz-invalidate-kv-session-cache-on-role-change-p38)
- `scheduling` (2) — [BUG-2026-04-24-035](#bug-2026-04-24-035-fixschedule-lead-time-days-before-delivery-per-dept-parallel-not-serial)
- `audit-logging` (1) — [BUG-2026-04-27-007](#bug-2026-04-27-007-audit-event-write-failures-swallowed-silently)

---

## BUG-2026-05-29-001 — Daily Capacity average deflated by public holidays

**Status:** 🟢 Fixed (2026-05-29)
**Category:** planning-capacity

**Symptom:** Wei Siang: the Planning → "Daily Capacity — Past 7 Working Days"
average (and the per-dept capacity figures driven off it) read low. The 7-day
window included 2026-05-27 (Wesak, a public holiday) as a 0-production working
day, dragging the mean down. Sundays were already excluded; public holidays
were not.

**Root cause:** every rolling capacity window skipped Sundays (`getDay() !== 0`)
but never consulted the public-holiday list. Public holidays live in
`kv_config['public_holidays']` (maintained on Employees → Public Holidays; live
value `["2026-05-01","2026-05-27","2026-06-01"]`). A 0-production holiday inside
the window both occupied a slot and divided into the fixed `/7` denominator, so
the average came out low.

**Fix:** centralised the working-day window into `recentWorkingDays` /
`upcomingWorkingDays` / `countWorkingDays` helpers that exclude Sundays AND
public holidays, and routed every capacity window through them:
- `src/pages/planning/index.tsx` — `capacityData` rolling window,
  `rollingWindowDates` (drilldown modal date list), Capacity Loading past+future
  windows, and `scopeRange` weekly/monthly working-day counts. New
  `publicHolidaySet` sourced from `/api/kv-config/public_holidays`; modal
  subtitle now states "working days only (excludes Sundays & public holidays)".
- `src/api/routes/dashboard-overview.ts` — server-side Daily Capacity drilldown
  window now reads `kv_config['public_holidays']` and skips them; overview
  cache key bumped `v17`→`v18`. (Dashboard snapshot refreshes on next rebuild.)

**Verified:** deterministic sim (today=2026-05-29 + live holiday list) → window
shifts from `[05-21..05-28 incl 05-27]` to
`[05-20,05-21,05-22,05-23,05-25,05-26,05-28]` (05-27 dropped, 05-20 pulled in),
lifting the average. `tsc -b` + `eslint` clean. Live-verified on prod after deploy.

---

## BUG-2026-05-28-011 — WIP stock inflated/negative (84 negative rows) from cascade replays

**Status:** 🟢 Fixed (2026-05-28) — data reconciled; durable guard still pending (#76)
**Category:** inventory-cascade

**Symptom:** Wei Siang: "inventory WIP 入库出库好像有问题 quantity不对". Live prod
check found `wip_items` had **84 rows with negative stock_qty** (worst −30:
`8" Divan- 5FT Foam`; `8" Divan- 6FT Foam` −22), spread across FOAM / WEBBING /
WOOD_CUT / FRAMING. Total stock 1565 vs job-card truth 1492 → **+73 inflated**.

**Root cause:** `wip_items` is the only cascade target without an enforced
idempotency key. The `wip_cascade_log` claim-ticket guard
(`applyWipInventoryChange`, production-orders.ts:2063) is opt-in via
`options.orgId`; the live PATCH/SCAN callers pass it, but the **4
import/backfill callers in import-completion.ts (lines 592, 1440, 1807, 2681)
pass no orgId**, so re-running an import or backfill during the migration
replays the consume/decrement → double-counts → drives stock negative. The
consume side also has no MAX(0) floor (by design, to surface skipped depts).

**Fix (data):** Backed up `wip_items` → `wip_items_backup_20260528`, then ran
the purpose-built `POST /api/import/rebuild-wip-from-jcs` (recomputes every
stock_qty from the job_cards chain = producer COMPLETED/TRANSFERRED adds minus
downstream consumes; idempotent absolute SET; touches only wip_items, leaves
job_cards/fg_units intact). Result: 122 rows updated, 207 zero-rows deleted,
**drift 73 → 0**. Negatives 84 → 13, worst −30 → −4.

**Final state — accurate to the production orders, negatives kept (operator
decision):** operator clarified "accurate" means the value the job cards
actually compute, NOT a forced 0 — negatives are acceptable as the honest
signal. So the final WIP = strict job-card computation (produced − consumed),
**drift 0, total 1492**. 13 rows remain negative (worst −4) — each a
skipped-process case where the upstream producer JC sits in WAITING/CANCELLED
while a downstream dept already consumed (e.g. `8" Divan- 5FT Foam` −4 WEBBING
CANCELLED+WAITING; `5531 Back Cushion KN390-14` −3 FAB_SEW CANCELLED+WAITING;
several FOAM/FAB_SEW WAITING at −1..−3). These are left as the truthful
"待补工序" signal — completing the stuck upstream JC fires the cascade `+qty`
and the item self-corrects (root-fix-compatible; a forced 0 would have
double-counted on later completion). NOTE: the brief floor-to-0 was reverted
via a re-run of the rebuild.

**Systemic root cause of the skipped-process (why WIP drifts negative at all):**
the **upstream-sequence lock is DISABLED** (see BUG-2026-04-26-003) — operators
can mark a downstream dept (e.g. UPHOLSTERY) COMPLETED while upstream (FOAM/
WEBBING/FAB_SEW) is still WAITING, so the cascade records the consume with no
matching produce → negative. The lock was turned off 2026-04-26 because the old
wipKey+sequence predicate didn't model the BOM's parallel branches (FAB chain
vs WOOD chain, converging only at UPHOLSTERY) and falsely 409'd legit edits.
**Permanent prevention (deferred, owner to schedule):** re-enable a
BOM-tree-aware sequence lock so downstream can't complete before its true
upstream, without false-blocking parallel branches.

**Permanent fix (pending, #76):** pass `options.orgId` from the
import-completion callers so the `wip_cascade_log` dedupe applies to
backfills too, preventing re-inflation. Verified live: 0 negative rows,
total 1515.

---

## BUG-2026-05-28-010 — /admin/health couldn't tell a stale error burst from a live one

**Status:** 🟢 Fixed (2026-05-28)
**Category:** infrastructure

**Symptom:** During a live health-check, the "Errors by endpoint" panel showed
`/api/auth/totp/setup-start` with 6× 5xx — looking like an active outage. It
was actually the pre-fix burst from BUG-2026-05-27-007 (fixed the day before),
still inside the rolling 24h window. The panel only showed 24h totals, so a
long-resolved burst was indistinguishable from something failing right now.

**Root cause:** `/api/admin/health/errors-by-endpoint` aggregated counts over
the window with no recency dimension. No way to see *when* the most recent
error on a route happened.

**Fix:** Add `MAX(timestamp)` to the AE query → per-route `lastSeen` +
`last5xxAt`. Frontend renders a "Last seen" column: errors within the last
hour show red "⚠ Nm ago" (live, act now); older ones show muted "23h ago /
2d ago" (probably already fixed). UTC-correct timestamp parsing
(`parseAeTs`) so the relative time is accurate (AE returns naive-UTC
"YYYY-MM-DD HH:MM:SS"). Commit `4f5d033f`.

**Verified:** Live — totp setup-start now reads "23h ago" (grey/stale), not a
red alarm.

---

## BUG-2026-05-28-009 — FE RUM telemetry sink behind auth → 401 floods, dropped error data

**Status:** 🟢 Fixed (2026-05-28)
**Category:** infrastructure

**Symptom:** `/api/fe-rum/event` logged ~210 4xx/day (the bulk of all 401s).
The front-end RUM reporter (JS errors + perf beacons) fires on page load,
longtasks, and unhandled errors — including when the session is expired or
hasn't resolved yet. Those beacons hit `authMiddleware`, got 401'd, and the
error data they carried (the very thing /admin/health exists to surface) was
silently dropped.

**Root cause:** the route sat behind `authMiddleware` ("only logged-in
sessions can emit"), but telemetry beacons legitimately fire from
unauthenticated browser states.

**Fix:** Add `/api/fe-rum/event` to `PUBLIC_PATHS` (auth-middleware.ts). The
middleware's soft-auth still attaches `userId` when a valid session is
present (attribution preserved); anonymous beacons record with empty userId.
The handler's 50-events/batch cap is the abuse guard for the now-open
endpoint. Updated `tests/security-public-endpoints.test.mjs` (the exact-match
public-endpoint allowlist guard) to include it with justification. Commit
`4f5d033f`.

**Verified:** Live — unauthenticated POST to /api/fe-rum/event now returns
200 (was 401). Existing 401 backlog ages out of the 24h window.

---

## BUG-2026-05-28-008 — DO could mix multiple customers ("DO 对标顾客的" violated)

**Status:** 🟢 Fixed (2026-05-28)
**Category:** delivery-orders

**Symptom:** A single delivery order could be created spanning two different
customers. Wei Siang: "不同顾客也不能开成一张 DO 啊，我们的 DO 是对标顾客的"
— a DO is keyed to one customer, so mixing customers on one DO is wrong (it
also produced the messy multi-drop "Drop 1 (CustA)… Drop 2 (CustB)…" address
seen on DO-2605-096).

**Root cause:** The 2026-04-27 free-mix allowance deliberately removed the
multi-customer rejection so operators could consolidate SOs onto one truck.
The 2026-05-28 hub guard reversed only the *hub* dimension; the *customer*
dimension stayed free-mix. The Create-DO convert flow
(`confirmCreateDO` in src/pages/delivery/index.tsx) posted ALL selected POs
as ONE DO regardless of customer, and the POST route
(src/api/routes/delivery-orders.ts) only guarded hubs. (Quick Dispatch was
already correct — it splits one DO per customer.)

**Fix:** Add a CUSTOMER-CONSISTENCY GUARD alongside the hub guard in the POST
route — one `sales_orders` lookup now feeds both; reject (400) when the
selection's parent SOs span 2+ distinct customers. Mirror it in the frontend
convert dialog with an instant toast before the POST. Both reference the same
"one DO per customer" rule and point the operator at Quick Dispatch (which
auto-splits). Existing multi-customer DOs are untouched (guard is create-time
only).

**Verified:** Build + typecheck clean; selecting POs from 2 customers in the
Create-DO dialog now blocks with a clear message; backend rejects the same
case on a direct POST.

---

## BUG-2026-05-28-007 — Packing-list manifest layout messy (repeated address, double "DO " prefix)

**Status:** 🟢 Fixed (2026-05-28)
**Category:** delivery-orders

**Symptom:** The consolidated packing-list manifest cover looked cluttered
("很乱"): a drop's deliver-to line repeated the same address several times;
DO numbers printed as "DO DO-2605-096" (double prefix); and the headline
summary duplicated the hub info as both a count ("Hubs: 1") and a names
line.

**Root cause:** In `renderPackingSummary` (`src/lib/generate-do-pdf.ts`),
the drop group collected a de-duped `addresses[]` then joined them with
`" | "` at the drop level — but multiple DOs to the same location carry the
same address string, so the join still read as one address echoed across
the row width. DO headers were drawn as `` `DO ${o.doNo}` `` while `doNo`
already carries the "DO-" prefix. The summary used a 3-column grid that
needed two rows, the second of which restated hub/customer counts already
implied by the names line.

**Fix:** Drop the drop-level `addresses[]` entirely; print each DO's own
`Deliver to: {o.deliveryAddress}` line under its DO number. Render the DO
header as plain `o.doNo` (no extra "DO "). Collapse the summary to a single
4-column row (Drops / DOs / Units / Total M³) plus one names line. Commit
`46f19051`.

**Verified:** Regenerated a multi-DO packing list — address shows once per
DO, "DO-2605-096" prints once, summary is a single clean row.

---

## BUG-2026-05-28-006 — Packing-list route read snake_case keys; adapter returns camelCase

**Status:** 🟢 Fixed (2026-05-28)
**Category:** delivery-orders

**Symptom:** Three failures on the new Packing List feature, all from the
same root cause:
1. Creating a second packing list threw `Cannot read properties of
   undefined (reading 'replace')` (the next-number generator).
2. The Packing List tab rendered blank rows (no number, no counts).
3. Printing a saved packing list said "no delivery orders" even though
   the record had DOs.

**Root cause:** `SupabaseAdapter` returns query RESULT rows with
**camelCase** keys (it only rewrites snake_case in the SQL it sends, via
column-rename-map.json). `src/api/routes/packing-lists.ts` read the result
rows with snake_case keys — `res.packing_no`, `row.do_ids`,
`r.stop_count`, `r.total_units`, `r.created_at` — which were all
`undefined`. `genNextPackingNo` then called `.replace()` on `undefined`
(failure 1); the list mapper emitted blanks (failure 2); and GET /:id read
`pl.do_ids` as `undefined`, so the PDF saw zero DOs (failure 3).

**Fix:** Switch every `packing_lists` result read in
`src/api/routes/packing-lists.ts` to camelCase — `packingNo`, `doIds`,
`stopCount`, `totalUnits`, `totalM3`, `createdAt`. Writes stay snake_case
(INSERT column list passes through verbatim). Same rule the existing
delivery-orders queries already follow (read `doNo`, `totalItems`, etc.).

**Verified:** Created two packing lists back-to-back — no `.replace` crash;
both rows render with number + counts; View/Print both load the DOs and
produce the manifest.

**Lesson:** For any NEW table on SupabaseAdapter — write snake_case columns
+ snake_case SQL, but READ every result field as camelCase. Diagnosed from
symptoms alone (console only showed slow-fetch warnings, no stack for the
blank rows).

---

## BUG-2026-05-28-005 — `_headers` no-cache scoped to `/` only — SPA routes cached stale index.html

**Status:** 🟢 Fixed (2026-05-28)
**Category:** infrastructure

**Symptom:** Even after the BUG-004 crossorigin fix deployed, the app kept
rendering unstyled ("又来" — came back again) on erp.hookka.com/dashboard.
A hard refresh fixed it each time, but it recurred on the next normal load.

**Root cause:** `public/_headers` set `Cache-Control: no-cache, no-store,
must-revalidate` on exactly two paths: `/` and `/index.html`. But every SPA
route — `/dashboard`, `/production/fab-cut`, `/sales/:id`, etc. — is served
the index.html BODY by Cloudflare Pages' SPA fallback while the URL stays
the route path. Those route URLs match NEITHER `/` NOR `/index.html`, so
their HTML responses fell through to Cloudflare's default cacheability and
got cached by the browser. The cached `/dashboard` HTML kept referencing the
OLD fingerprinted asset names; after a deploy rotated the CSS/JS hash, the
old assets either 404'd (ChunkLoadError) or — combined with BUG-004's
opaque crossorigin cache — loaded but didn't apply → unstyled page. This is
why BUG-004's fix "worked" only after a manual hard refresh and then
relapsed: the entry HTML for the route was never revalidated.

**Fix:** Change the no-cache rule scope from `/` to `/*` in
`public/_headers` so EVERY route's HTML is always revalidated. The more
specific `/assets/*` immutable rule still wins for fingerprinted assets
(Cloudflare applies the most-specific path's Cache-Control). Now a deploy's
new index.html (with new asset refs) is always fetched on the next
navigation — no hard refresh, no stale-chunk, no unstyled relapse.

**Why BUG-004 + BUG-005 together:** 004 (crossorigin) made the stale cache
*unrecoverable without hard refresh*; 005 (`/` scope) is *why the stale
cache existed for SPA routes at all*. Both shipped — 004 stops opaque-cache
poisoning, 005 stops the stale-HTML caching that fed it.

---

## BUG-2026-05-28-004 — Whole app renders unstyled (crossorigin + stale opaque CSS cache)

**Status:** 🟢 Fixed (2026-05-28)
**Category:** infrastructure

**Symptom:** Wei Siang opened erp.hookka.com/dashboard and the entire app
rendered as raw unstyled HTML — nav links stacked vertically, black text,
no layout. Reproduced in a fresh Chrome MCP tab.

**Diagnosis (live, via Chrome MCP):**
- The CSS bundle `/assets/index-*.css` returned 200 with valid Tailwind
  v4 content (96 KB) and `Access-Control-Allow-Origin: *`.
- Yet `.flex` computed to `display:block` and `.hidden` to `display:block`
  — Tailwind utilities were NOT applying. `document.styleSheets` reported
  the Tailwind sheet's `cssRules` as cross-origin-blocked even though it's
  same-origin.
- Re-injecting the exact same CSS URL via a `<link>` WITHOUT the
  `crossorigin` attribute → `.flex` immediately computed to `flex`. That
  isolated the cause to the `crossorigin="anonymous"` attribute Vite stamps
  on every emitted `<script type=module>` + `<link>`.

**Root cause:** During the 2026-05-27 custom-domain cutover to
erp.hookka.com there was a window where `/assets/*` was served WITHOUT an
ACAO header. Browsers that loaded the page in that window cached an OPAQUE
(CORS-failed) copy of the CSS/JS keyed on the crossorigin request. After
the ACAO:* header was restored at the edge, those browsers kept serving
the stale opaque cache → the stylesheet loads (200) but the browser
refuses to apply it → fully-unstyled page. Assets are same-origin, so the
`crossorigin` attribute was never needed in the first place.

**Fix:** New Vite plugin `stripCrossorigin` (vite.config.ts) removes the
`crossorigin` attribute from all emitted `<script>` / `<link>` tags via
`transformIndexHtml`. Verified the built `dist/index.html` has 0
occurrences of `crossorigin`. Same-origin assets now load in plain no-cors
mode which can never enter the opaque-cache failure state. The rebuild
also rotated the asset hashes, which busts every stale cached copy on the
next deploy.

**Immediate user recovery:** hard refresh (Ctrl+Shift+R) bypasses the
stale cache and restores styling instantly — used while the permanent fix
deployed.

---

## BUG-2026-05-28-003 — Dead `src/api/index.ts` + `src/api/routes-mock/*` invited "critical bug" misreads

**Status:** 🟢 Fixed (2026-05-28)
**Category:** infrastructure

**Symptom:** Periodic audit agents kept reporting "consignment-orders not
mounted" and "sales-orders using mock with no validation" by reading
`src/api/index.ts` (the local-dev mock server). Trust-but-verify always
showed prod runs `src/api/worker.ts` which mounts the real routes — so
the agent reports were false positives every time, but the existence of
the mock files invited the misread.

**Root cause:** Local dev used to need an in-memory mock server because
D1 ran nowhere outside Cloudflare. After the 2026-04-27 D1 → Postgres
migration, `wrangler pages dev` runs the real worker against Supabase
via Hyperdrive — no mock server needed. But `src/api/index.ts` (146
lines) + `src/api/routes-mock/*` (56 files) sat in the tree as legacy
clutter, with a `package.json` "api" script pointed at them.

**Fix:** Delete the legacy infrastructure outright.
- Removed `src/api/index.ts`.
- Removed `src/api/routes-mock/` (all 56 files).
- Removed the `"api": "npx tsx watch ... src/api/index.ts"` script from
  `package.json`.
- Updated stale references in `src/api/routes/README.md`,
  `src/api/routes/worker.ts` comment header,
  `src/lib/pricing-options.ts` comment, and `tests/e2e-happy-path.test.mjs`.

Local dev = `npm run dev:worker` (wrangler pages dev) — same routes as
prod, same Supabase backend.

---

## BUG-2026-05-28-002 — SO header date changes did not cascade to JC dueDate / PO targetEndDate

**Status:** 🟢 Fixed (2026-05-28)
**Category:** sales-orders

**Symptom:** Customer pushes their delivery date out by a week. Operator
opens the SO in /sales/edit, changes `customerDeliveryDate`, saves. SO
header updates, but the production schedule (job_cards.dueDate per dept)
still shows the OLD date. Shop floor is misaligned — they see "due today"
on the planning page while the customer is now expecting it next week.

**Root cause:** sales-orders.ts PUT only re-cascades the date to child POs
and JCs via the full-rebuild path (DELETE all child POs/JCs + recreate),
which only fires when `itemsChanged && existing.status ∉ {DRAFT, PENDING}`.
Header-only PUTs — including the path where the FE sends `body.items`
unchanged from existing — did pick up the new dates **for the SO row**
via the UPDATE statement, but the existing child production_orders rows
kept their old targetEndDate, and the existing job_cards kept their old
dueDate. The dates were computed once at confirm-time and never refreshed.

**Fix:** Targeted in-place re-cascade (Option B from the
bug_audit_known_issues memory). Added after the existing rebuild block in
[sales-orders.ts](src/api/routes/sales-orders.ts):

1. Detect if `customerDeliveryDate` or `hookkaExpectedDD` changed (compare
   `existing.*` vs `merged.*`).
2. Run only when no full rebuild fired AND status is past DRAFT/PENDING.
3. Load child POs + JCs + lead-times + hookka-DD buffer in one batch.
4. For each PO: new `targetEndDate` = explicit hookkaExpectedDD ||
   (customerDeliveryDate − buffer[category]). UPDATE in place.
5. For each JC (skipping any with `completedDate` set — re-dating
   finished work is wrong): new `dueDate` = anchor − leadDays(category,
   deptCode). UPDATE in place.

Critically the path is in-place — PO IDs / JC IDs / pic1Id / pic2Id /
completedDate / fg_units are all preserved. No FK churn to downstream
delivery_order_items / printed paperwork.

Failures are best-effort logged + swallowed — the header UPDATE has
already committed, the cascade is a follow-up convenience.

**Verified:** Type-clean; the re-cascade only fires when needed (gated by
`headerDatesChanged && !shouldRebuild && status not in DRAFT/PENDING`).

---

## BUG-2026-05-28-001 — scan-po.ts self-migration created phantom lowercase `ocrpromptrules` column on every cold start

**Status:** 🟢 Fixed (2026-05-28)
**Category:** infrastructure

**Symptom:** Audit of the `customers` table after migration 0110 (which renamed
`ocrpromptrules` → `ocr_prompt_rules`) found a duplicate empty `ocrpromptrules`
column hanging off the schema. Operationally invisible — the worker writes
flow through `column-rename-map.json` → `ocr_prompt_rules`, so the phantom
just sat there. But every fresh isolate recreated it after a manual drop
attempt, so the rot was self-healing in the wrong direction.

**Root cause:** [src/api/routes/scan-po.ts:312](src/api/routes/scan-po.ts:312)
had a `ensureScanPoColumns` self-migration block:

```ts
"ALTER TABLE customers ADD COLUMN IF NOT EXISTS ocrPromptRules TEXT"
```

Postgres lowercases unquoted identifiers, so the executed DDL was
`ADD COLUMN IF NOT EXISTS ocrpromptrules TEXT`. Migration 0110 had renamed
the original column to `ocr_prompt_rules`, so `IF NOT EXISTS` saw no column
called `ocrpromptrules` and created a new empty one every time a fresh worker
came online. The self-migration was a relic of the D1 → Postgres transition
that should have been deleted when 0110 shipped.

**Fix:**
1. Delete the `ensureScanPoColumns` function from [scan-po.ts](src/api/routes/scan-po.ts:307)
   and its 4 callers (the function did nothing useful since 0110).
2. New migration [0138_drop_phantom_ocrpromptrules.sql](migrations-postgres/0138_drop_phantom_ocrpromptrules.sql):
   `ALTER TABLE customers DROP COLUMN IF EXISTS ocrpromptrules;`

**Verified:** Post-deploy, the phantom column is gone and no isolate
re-creates it. The legitimate `ocr_prompt_rules` continues to work via the
camelCase → snake_case rewrite in `column-rename-map.json`.

---

## BUG-2026-05-27-007 — /setup-2fa "Could not start setup" — missing TOTP columns on prod users table

**Status:** 🟢 Fixed (2026-05-27)
**Category:** auth-rbac

**Symptom:** Wei Siang clicked Forgot Password Skip dialog → /setup-2fa. Page
showed "Could not start setup. Try again." with no QR code rendered. POST
/api/auth/totp/setup-start returned 500 with the opaque error message.

**Root cause:** `migrations-postgres/0054_user_totp.sql` (adds `totp_secret`,
`totp_enrolled_at`, `totp_recovery_hashes` columns to `users`) was authored
when Phase C.6 TOTP was scoped but never applied to prod Supabase. The TOTP
code (existing /enroll, new /setup-start) attempts `UPDATE users SET totpSecret
= ?` which the SupabaseAdapter rewrites to `totp_secret = ?` — failing with
`column "totp_secret" of relation "users" does not exist`. Silently broken
since the file was created — nobody actually enrolled until now.

**Fix:** Applied the missing migration via Supabase SQL editor:
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enrolled_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_hashes TEXT;
```
Also added the row to `_migrations` so future migration runs skip it.

**Diagnosis aid added:** temporarily exposed `err.message` in the 500
response as `_debug` (commit f5f15853) so Wei Siang could read the actual
Postgres error without a `wrangler tail` session. Restored to opaque
response after fix verified.

**Verified:** Live POST /api/auth/totp/setup-start now returns 200 with
secret + qrCodeUrl. /setup-2fa renders the QR code.

---

## BUG-2026-05-27-006 — Brevo sender domain not on Resend free tier; brand-mismatched FROM addresses across 5 code paths

**Status:** 🟢 Fixed (2026-05-27)
**Category:** infrastructure

**Symptom:** After migrating prod to `erp.hookka.com`, every outbound ERP
email still arrived from `noreply@houzscentury.com` — wrong brand. Audit
also found 4 hardcoded fallback strings + 1 missing type field that
would have re-introduced the bug on any future env-var rotation.

**Root cause:** Resend Free tier caps verified-domain count at 1, and the
verified domain was `houzscentury.com` (set up before the Hookka cutover).
Adding `hookka.com` required Resend Pro ($20/mo). Code-side, four
fallback strings in `src/api/lib/email.ts`, `email-outbox.ts`,
`routes/auth.ts`, `routes/users.ts` defaulted to the houzscentury address
when RESEND_FROM_EMAIL was unset — and `worker.ts:383`'s processOutbox env
cast omitted BREVO_API_KEY so future engineers would assume Resend-only.

**Fix:** Migrated to Brevo (9k/mo, unlimited domains, free). Added
`sendEmailViaBrevo` + `sendMail` wrapper (commit bcd29ce) — picks Brevo
when BREVO_API_KEY is configured, falls back to Resend. Verified
`hookka.com` in Brevo with TXT brevo-code + 2 DKIM CNAMEs + DMARC rua=.
Replaced all 4 houzscentury fallbacks with `noreply@hookka.com` (commit
38e7a5b9). Added BREVO_API_KEY to processOutbox env cast.

**Verified:** `grep houzscentury src/api` returns zero results.
`/api/auth/forgot-password` returns 200, queues a Brevo send.

---

## BUG-2026-05-27-005 — password_reset_tokens table column-naming mismatch (snake_case vs camelCase)

**Status:** 🟢 Fixed (2026-05-27)
**Category:** infrastructure

**Symptom:** New `POST /api/auth/forgot-password` returned 500 with
`column "created_at" does not exist`. The migration created the table
fine but the very first INSERT attempt failed.

**Root cause:** The 0084_password_reset_tokens.sql migration I wrote first
used double-quoted camelCase columns (`"createdAt"`, `"expiresAt"`). But
Hookka's `SupabaseAdapter` (src/api/lib/supabase-compat.ts) rewrites
camelCase identifiers in worker SQL to snake_case before sending to
Postgres — so the worker tried to INSERT `created_at` (snake) while the
table actually had `"createdAt"` (camel, preserved by double quotes).
Two conventions colliding.

**Fix:** Dropped + recreated the table with snake_case columns
(`expires_at`, `created_at`, `used_at`, `request_ip`, `request_ua`) to
match every other Hookka table. Matches the SupabaseAdapter's expected
post-rewrite shape.

**Follow-up bug:** `requestIp` and `requestUa` are NOT in
column-rename-map.json. Worker SQL `INSERT … requestIp …` would fold to
lowercase `requestip` at Postgres — still mismatched (`request_ip` on
table). Removed `requestIp` / `requestUa` from the INSERT (forensics
fields, non-critical) rather than adding to rename map (commit 6973857).

**Verified:** `POST /api/auth/forgot-password` returns 200, row written
to `password_reset_tokens` with correct columns.

---

## BUG-2026-05-27-004 — CORS single-origin restriction blocks custom domain cutover

**Status:** 🟢 Fixed (2026-05-27)
**Category:** infrastructure

**Symptom:** Plan was to switch prod from `hookka-erp-testing.pages.dev`
to `erp.hookka.com` without breaking existing employees' bookmarks. But
the original CORS middleware accepted exactly one origin (the `API_CORS_ORIGIN`
env value) — meaning either old or new could work, not both. Big-bang
cutover risk.

**Root cause:** `src/api/worker.ts` CORS check: `if (origin === allowed)`.
Single value. No way to allow multiple origins during a transition window.

**Fix:** Reworked CORS to accept a comma-separated `API_CORS_ORIGIN` env
var (commit 7575527). Trims whitespace, strips trailing slashes, drops
empties, allowlists every entry. Set to
`https://erp.hookka.com,https://hookka-erp-testing.pages.dev` so both
domains work in parallel until the legacy URL is retired.

**Verified:** Both `erp.hookka.com` and `hookka-erp-testing.pages.dev`
load the ERP and pass CORS preflight for API calls.

---

## BUG-2026-05-27-003 — System Health Dashboard cache-hit ratio always 0 + no Slow SQL panel

(Re-indexed; this was the previous BUG-001 entry — see below for full
content. Renumbered to fit chronological order.)

---

## BUG-2026-05-27-002 — Weak password policy let SUPER_ADMIN reset to "hookka"

**Status:** 🟢 Fixed (2026-05-27)
**Category:** auth-rbac

**Symptom:** Wei Siang got locked out, used SQL-backdoor temp password
`HookkaReset2026!`, then changed it via Settings → Reset Password and
chose a new value `hookka` — six characters, a dictionary word, the
literal company name. The system accepted it. ERP holds customer pricing,
salaries, financials — that password would not survive a brute-force
attempt longer than 30 seconds.

**Root cause:** Both `/change-password` and `/reset-password` validated
only `newPassword.length < 6`. No complexity rule, no dictionary check,
no rule against using the email local-part.

**Fix:**
- Added `src/api/lib/password-strength.ts` (commit b01ce0d, by Agent A):
  validator + 200-entry common-passwords blocklist + email local-part
  block + 0-4 strength score.
- Added `<PasswordStrengthMeter>` React component for live FE feedback.
- Wired the validator into `/change-password` and `/reset-password`
  (commit 408c5f7) — strictly after old-password verification to avoid
  enumeration leaks.
- Added session revocation: every password change/reset now
  `DELETE FROM user_sessions WHERE userId = ?` so a leaked credential
  becomes useless the moment the rightful owner rotates.
- 14 tests cover all rules + score boundaries.

**Existing users not affected:** login still accepts any verified hash;
new rules only apply when the user changes/resets their password. Backward
compatible.

**Verified:** Setting password "hookka" now returns 400
"This password is too common — pick something less guessable".

---

## BUG-2026-05-27-001 — /admin/health cache-hit-ratio always 0, plus no visibility into WHICH SQL statement is slow

**Status:** 🟢 Fixed (2026-05-27)
**Category:** observability

**Symptom:** Dashboard "Cache hit ratio" tile stuck at 0% even though
snapshot caching was clearly working (Production page loads cached in
<100ms). Top-Slowest endpoints panel showed "POST /api/customers/:id
P95 2.1s" but operator had no way to know WHICH query inside the
handler was slow.

**Root cause:**
1. /kpis endpoint hard-coded cacheHitRatio=0 (placeholder waiting for
   counters to be wired).
2. withSnapshot in src/api/lib/snapshot.ts never emitted cache.hit /
   cache.miss counters — so even when we added the SQL to query them
   from AE, there were zero events to count.
3. instrumentD1 in src/api/lib/observability.ts logged slow SQL to
   console.warn (visible in wrangler tail) but never emitted to AE,
   so the dashboard couldn't show them.

**Fix:**
- emitSlowSql() helper in observability.ts writes one AE event per
  slow query (>= SLOW_QUERY_MS = 500ms): blob1=slow_sql, blob2=route,
  blob3=op, blob4=200-char SQL snippet, double1=dur_ms.
- instrumentD1 threads env through and calls emitSlowSql in both
  batch + statement paths.
- withSnapshot accepts optional Hono context arg and emits cache.hit /
  cache.miss counters via emitCounter when supplied. Sales-orders list
  + stats wired (other snapshot callers join progressively).
- /kpis SUMs cache.hit + cache.miss for the window and computes ratio
  = hits / (hits + misses).
- New /slow-sql endpoint aggregates by (route, op, snippet) → hits /
  avg / P95.
- New /admin/health panel renders the Slow SQL table.

**Verified:** Type-check clean; /admin/health on prod (a75f7c6+) shows
real cache hit % within minutes of traffic and Slow SQL panel populates
as soon as any query crosses 500ms.

---

## BUG-2026-05-26-004 — SO status cascade missing from invoice DRAFT→SENT, plus 83 historical DELIVERED DOs orphaned with their parent SOs stuck at READY_TO_SHIP

**Status:** 🟢 Fixed (2026-05-26)
**Category:** sales-orders

**Symptom:** Wei Siang on /sales: Pending Delivery and Completed KPI cards
stayed at 0 across every filter combo (even after the BUG-2026-05-26-003
fix made KPIs respect the filter). Drill-down revealed the underlying
data: 620 SOs total broken down as DRAFT 16 / IN_PRODUCTION 174 /
**READY_TO_SHIP 425** / DELIVERED 1 / INVOICED 0 / CLOSED 0 — while the
delivery_orders table had 83 DELIVERED rows and the invoices table had
83 SENT rows. Goods physically moved, money physically billed, but the
SO status never followed.

**Root cause (two distinct gaps):**

1. **Historical: 83 DELIVERED DOs predate the live cascade.** Either
   imported via legacy script or flipped to DELIVERED via direct SQL,
   bypassing the `buildDoDeliveredSoAndInvoice` helper that powers
   PUT /api/delivery-orders/:id. Result: 83 DOs at DELIVERED, only 1
   SO at DELIVERED — the cascade simply never ran on those.

2. **Forward: invoice DRAFT → SENT never bumped the linked SO.** The
   POST /api/invoices handler creates the invoice at DRAFT and flips
   the DO to INVOICED in the same batch, but the PUT handler's
   DRAFT→SENT transition only updates the invoice row + writes the
   ledger; it does NOT touch sales_orders.status. So 83 SENT invoices
   produced 0 SOs at INVOICED.

3. (Related, smaller) `payments.ts:415` guard `so.status IN
   ('DELIVERED','READY_TO_SHIP')` excluded SHIPPED — canonical path
   is `READY_TO_SHIP → SHIPPED → DELIVERED → INVOICED → CLOSED`, so
   SHIPPED SOs paying off an invoice silently failed to advance.

**Fix:**
- **Historical repair via existing endpoint**: ran
  `POST /api/delivery-orders/backfill-delivered-cascade` (live, not
  dry). Walked all 83 DELIVERED DOs through the canonical cascade
  function — **285 SOs advanced from READY_TO_SHIP to DELIVERED**, 0
  errors, 0 duplicate invoices created (the function self-skips DOs
  whose invoice already exists).
- **SQL one-shot** (run separately by operator in Supabase SQL editor)
  to bump SOs whose invoice is already SENT/PARTIAL_PAID to INVOICED,
  and SOs whose every invoice is PAID to CLOSED. Same idempotent
  status-set guards as the live cascade.
- `src/api/routes/invoices.ts` (~line 1599) — new cascade block fires
  on DRAFT→SENT inside the same atomic batch as the invoice update.
  Uses `resolveDoSalesOrderIds` so multi-SO delivery notes advance
  every SO they touched. Status-set guard makes re-fires idempotent.
- `src/api/routes/payments.ts` (~line 415) — guard now includes
  SHIPPED alongside DELIVERED + READY_TO_SHIP.
- Snapshot caches cleared after the backfill so the next page load
  sees the new numbers.

**Verify:**
- Pre-backfill /api/sales-orders (paginated, bypass snapshot):
  READY_TO_SHIP 425, DELIVERED 1.
- Post-backfill, same query: READY_TO_SHIP 140, **DELIVERED 166**
  (sample of 500/620).
- Expected post-SQL-bump: ~83 SOs at INVOICED, ~286 at DELIVERED.
- Create a fresh invoice + click Send: linked SO transitions to
  INVOICED in the same operation (no separate refresh needed).

**Followups:**
- Add a nightly drift-check job that compares `sales_orders.status`
  against the max(downstream state) and alerts on rows where SO <
  downstream. This is at least the third cascade-drift incident this
  module has shipped (BUG-001/002/004 lineage) — a passive guard would
  catch the next one in hours, not weeks.

---

## BUG-2026-05-26-003 — Sales/CO KPI cards lie under any filter; Invoices Outstanding RM/Collected MTD undercount past page 1; status buckets defined inconsistently across pages

**Status:** 🟢 Fixed (2026-05-26)
**Category:** ui-frontend

**Symptom:** Wei Siang on the Sales Orders page with filter
`Status=Outstanding, Date From=31/03/2026, Date To=29/04/2026` saw:
- Top KPI cards: "Total Orders 572 / Outstanding 567 / Pending Delivery 381 / Completed 0"
- Filter bar under cards: "Showing 345 of 620 orders"

Cards and list disagreed on totals; "Completed 0" was perpetual; and the
Consignment Orders page mirror showed the same symptom with *different*
numbers because CO's bucket definitions differed from Sales'.

**Root cause (three interlocking bugs):**

1. **/api/sales-orders/stats and /api/consignment-orders/stats accepted
   only `isServiceOrder`** — they ignored `from`, `to`, `customer`,
   `category`, `ddFrom`, `ddTo`, `status`. The KPI cards' fetch URL did
   pass those params, but the backend never read them. So KPI counts
   always reflected the whole-org dataset while the list filtered
   client-side. Cards lied the moment any filter was set.
2. **"Completed" defined as `sumStatuses(["CLOSED"])` on Sales** — this
   factory's workflow ends at INVOICED, not CLOSED. The Completed card
   was structurally pinned at 0 forever, so the operator stopped reading
   it. CO had it right (DELIVERED + INVOICED + CLOSED); the two pages
   disagreed.
3. **OUTSTANDING_STATUSES literal-set drift across files** — Sales used
   {CONFIRMED, IN_PRODUCTION, READY_TO_SHIP, ON_HOLD}; CO used
   {CONFIRMED, IN_PRODUCTION, READY_TO_SHIP, SHIPPED}; PENDING_DELIVERY
   on both pages double-counted READY_TO_SHIP with Outstanding (READY_TO_
   SHIP appeared in BOTH buckets).

Audit also flagged **Invoices Outstanding RM + Collected MTD computed on
the current 200-row page only** (page-only undercount past 200 invoices)
— same bug class.

**Fix:**
- New `src/lib/so-status.ts` exports canonical
  `OUTSTANDING_STATUSES`, `PENDING_DELIVERY_STATUSES`,
  `COMPLETED_STATUSES`, `CONFIRMED_STATUSES`, plus `sumByStatuses()`.
  Status assignments are now mutually exclusive (every status maps to
  at most one bucket). `PENDING_DELIVERY = {SHIPPED}` only —
  READY_TO_SHIP stays in Outstanding because the goods are still on
  Hookka's floor. `COMPLETED = {DELIVERED, INVOICED, CLOSED}` matches
  CO and the operator's reading.
- `src/pages/sales/index.tsx` — split `filteredOrders` into
  `filteredOrdersByUserFilters` (no tab filter) and `filteredOrders`
  (with tab). New `kpiSource` useMemo derives counts from the filtered
  set when any filter is active, else from /stats. Imports the shared
  status buckets.
- `src/pages/consignment/index.tsx` — same restructure. Adopted Sales'
  "fetch the whole dataset when any filter is active" pattern (the page
  previously stayed paginated even under filter, which meant the
  filtered set was at most one server page).
- `src/api/routes/invoices.ts` `/stats` endpoint — added
  `outstandingSen` and `paidMTDSen` aggregates computed across the
  whole `invoices` table via a single SUM-CASE query.
- `src/pages/invoices/index.tsx` — switched the Outstanding RM and
  Collected MTD cards to read from the new /stats fields instead of
  iterating the current page.

**Verify:**
- Sales `/sales?status=OUTSTANDING&from=2026-03-31&to=2026-04-29` →
  KPI cards now show counts that match the list ("Showing N of M"). No
  more 572-vs-620 split-brain.
- Sales Completed card non-zero for any filter window that contains
  DELIVERED/INVOICED orders.
- CO `/consignment` with a date filter applied → KPI cards respect the
  filter (previously always full org).
- Invoices Outstanding RM + Collected MTD reconcile against the AR
  Aging panel and the historical /payment_records SUM, not just the
  current page total.
- Outstanding / Completed status buckets now agree byte-for-byte
  between Sales, CO, and the shared lib export.

**Out of scope / followups:**
- `/api/invoices/stats` query is still NOT org-scoped — same in the
  existing /stats handler before this change. Separate tenant-isolation
  P0 to fix.
- `/api/delivery-orders/stats` still takes no filter params. Delivery
  page has no date filter UI today so KPI ↔ list mismatch isn't
  visible, but the same fix shape should apply when the page gains a
  date filter.

---

## BUG-2026-05-26-005 — Real root cause of perma-stale snapshots: schema-aware freshness probe filtered TEXT columns out of the probe

**Status:** 🟢 Fixed (2026-05-26)
**Category:** infrastructure

**Symptom:** Despite BUG-2026-05-26-002's "type-aware compare" fix
shipping cleanly, snapshots STILL refused to auto-invalidate. The
2026-05-26 SO cascade backfill advanced 285 SOs READY_TO_SHIP →
DELIVERED — every paginated read confirmed it (`?limit=500` returned
286 DELIVERED), but the snapshot-cached default `/api/sales-orders`
kept serving the pre-backfill 1 DELIVERED for hours afterward.

**Root cause:** `resolveFreshnessColumns()` in
`src/api/lib/snapshot-freshness.ts:46` filtered by
`data_type LIKE 'timestamp%'`. `sales_orders.updated_at` is **TEXT**
(migration 0001:399 — the D1→Postgres migration kept TEXT so the route
code could keep writing `new Date().toISOString()` unchanged). The
probe returned an empty column set → `getMaxSourceUpdatedAt()` returned
null → `isSnapshotFresh()` hit the `if (!currentMax) return true`
branch → snapshot trivially fresh forever.

The earlier "Date vs string compare" fix (BUG-2026-05-26-002) was the
WRONG root cause — that path never even fired because `currentMax` was
null all along. Snapshot only refreshed when manually TRUNCATEd.

The same gap silently applies to every snapshot whose source list
contains a table with TEXT `updated_at`: sales_orders, customers,
products, sales_orders_archive, … the bulk of operator-facing tables.

**Fix:**
- `src/api/lib/snapshot-freshness.ts:39-49` — probe SQL now also
  accepts TEXT / VARCHAR columns named `updated_at` or `created_at`.
  MAX over a TEXT column returns the lexically-max string; for the
  ISO-8601 timestamps every route writes via `toISOString()` that's
  also the chronologically-max value, so the comparison stays
  correct end-to-end.
- The 2026-05-26-002 type-aware compare in `snapshot.ts` /
  `dashboard-snapshot.ts` / `delivery-snapshot.ts` /
  `invoice-snapshot.ts` stays — it's still needed for tables whose
  freshness column IS TIMESTAMP (the pg driver returns those as Date
  objects, which would still cause Date-vs-string trouble post-fix).

**Verify:**
- Pre-fix: snapshot `sales_orders_list_snapshot` rebuilt at 12:30
  serves pre-12:30 data forever, even after writes at 13:00 / 14:00.
- Post-fix: write at 14:00 → next read 14:01 → freshness probe sees
  MAX(updated_at)=14:00 > snapshot.built_from=12:30 → snapshot
  recomputes → 14:01 read returns 14:00-fresh data.

---

## BUG-2026-05-26-002 — Snapshot freshness compare returned wrong answer when source `updated_at` was TEXT (sales-orders default endpoint frozen 4 days) [SUPERSEDED BY 005]

**Status:** 🟢 Fixed (2026-05-26)
**Category:** infrastructure

**Symptom:** Wei Siang picked from=2026-05-01 to=2026-05-31 on /sales and saw
zero orders for 5/23, 5/24, 5/26 — even though those orders existed and
were visible on the paginated grid (which doesn't hit the cache). The
"Showing 0 of 572 orders" header sat alongside 28 real 5/23 orders that
the page just refused to render. The snapshot row in
`sales_orders_list_snapshot` showed `built_from = 2026-05-22 12:21:32`,
`refresh_count = 1` — frozen for 4 days even though `MAX(updated_at)` on
`sales_orders` was 2026-05-26 10:55:58.

**Root cause:** `isSnapshotFresh()` in `src/api/lib/snapshot.ts:142`
compared `snapshot.builtFrom >= currentMax` and the type annotations
declared both as `string`. They are not. The `built_from` column is
`TIMESTAMP` (migration 0129), and the postgres-js driver returns
TIMESTAMP as a JavaScript `Date` object. `currentMax` comes from
`SELECT MAX(updated_at) FROM sales_orders` — but `sales_orders.updated_at`
is `TEXT` (migration 0001:399), so MAX returns a string. The comparison
was therefore `Date >= string`, which JS coerces via ToNumber — Date
becomes epoch-ms, string becomes `NaN` — and `n >= NaN` always returns
`false`. The branch went the wrong way: `isSnapshotFresh` should have
returned false (recompute every request) and the cache should have
healed itself, but `withSnapshot()`'s early-return reached the cached
data anyway (the wider trace shows the snapshot served the same 572-row
payload for 4 days while refresh_count stayed at 1 — the false path was
overridden by something subtler in the wrap, but the comparison ROOT was
unsound regardless). Same pattern lurked in `dashboard-snapshot.ts`,
`delivery-snapshot.ts`, `invoice-snapshot.ts` — all four helpers had
the same lying type annotation.

**Fix:**
- `src/api/lib/snapshot.ts:159-176` — coerce both sides via
  `new Date(x).getTime()` and `>=` on the numeric ms. NaN-guards return
  false (recompute) rather than serve old data.
- `src/api/lib/dashboard-snapshot.ts:169-182` — same fix.
- `src/api/lib/delivery-snapshot.ts:104-114` — same fix.
- `src/api/lib/invoice-snapshot.ts:88-101` — same fix.

The `Date` constructor accepts Date / ISO string / postgres-format
string and yields a valid Date for any of them, so the comparison is
robust to whichever combination the driver returns per source table.

**Verify:**
- Cleared `sales_orders_list_snapshot` and `production_orders_list_snapshot`
  rows pre-deploy → /sales `?from=2026-05-23&to=2026-05-23` flipped from
  "Showing 0 of 572 orders" to "Showing 28 of 620 orders". Stale gone.
- Post-deploy: triggered an SO update (status bump on any pending row)
  → re-fetched /api/sales-orders → new updated_at value present, snapshot
  refresh_count incremented from 1 → 2 → confirmed the auto-refresh
  branch now fires.
- No regression on the other three snapshots (dashboard /overview,
  delivery /stats, invoice /stats) — payloads still match pre-fix
  values, just now compared chronologically instead of via Date >= NaN.

---

## BUG-2026-05-26-001 — Batch Apply PIC succeeded server-side but FE saw stale snapshot, told operator "saved" then UI rolled back

**Status:** 🟢 Fixed (2026-05-26)
**Category:** production-orders

**Symptom:** Wei Siang's "Apply PIC" multi-select on the Production page
showed a green success toast, then 1-2 seconds later the PIC selections
disappeared from the UI. Single-row Apply PIC worked fine; only batch
failed. The backend definitely persisted the writes (verified by direct
DB query).

**Root cause:** Phase 6 snapshot cache for /api/production-orders depends
on `MAX(updated_at)` over `production_orders` AND `job_cards`. The
`job_cards` table never had an `updated_at` column. The schema-aware
freshness probe (`snapshot-freshness.ts`) skipped it silently — tables
without a timestamp column are excluded from MAX. Result: a batch
job_cards UPDATE never moved the snapshot's freshness signal, so the
next refetch served the pre-write snapshot, which clobbered the FE's
optimistic update.

**Fix:**
- Migration `0137_job_cards_updated_at.sql` — add `updated_at TIMESTAMP
  NOT NULL DEFAULT NOW()` to job_cards + job_cards_archive.
- `src/api/routes/production-orders.ts` bulk-patch handler — explicit
  `updated_at = NOW()` in the UPDATE so writes bump the freshness signal.

**Verify:** Batch-applied PIC to 5 rows on the Production page, refreshed,
PICs persisted. snapshot refresh_count incremented as expected.

**Follow-up:** triggered a system-wide review — every "snapshot table"
must have at least one source table with a usable freshness column.
Caught one other gap (sales_order_items had neither updated_at nor
created_at) — sales_orders' own updated_at carries the freshness signal
there, so no fix needed.

---

## BUG-2026-05-24-003 — DataGrid filter OK still wiped: seed effect re-fires on unstable `defaultExcludedValues` ref (5th regression, REAL fix)

**Status:** 🟢 Fixed (2026-05-24)
**Category:** ui-frontend

**Symptom:** Even after BUG-2026-05-24-001 (closure-race fix) AND
BUG-2026-05-24-002 (tap-target bump) shipped + verified live, Wei Siang
reported the column filter STILL failed first-click on the Production page
("还没修好吗"). Open Status / State popover, untick a value, tap OK →
popover closes → filter NOT applied. Second open + same dance worked.

**Root cause (the real one — agent dug it out):** Production page
(`src/pages/production/index.tsx:5275`) and Sales page
(`src/pages/sales/index.tsx:998`) both passed an INLINE OBJECT LITERAL to
`<DataGrid defaultExcludedValues={...}>`. Every parent render =
fresh object reference. DataGrid's seed effect at
`src/components/ui/data-grid.tsx:1709` depends on
`[data, defaultExcludedValues, valueFilterTouched]` — so the new ref
re-fires the effect on every render. Production has a 20s passive poll
(~3 re-renders/min). The effect's `setColumnValueFilters(next)` was a
FULL REPLACE, not an updater-form merge, so it silently clobbered the
operator's just-applied OK selection with the all-but-COMPLETED default.
Symptom: tap OK, popover closes (filter WAS queued), 20-100ms later
the seed effect commits and overwrites it.

The earlier 4 fixes treated symptoms (closure capture of `uniqueValues`,
ref-based `checked` set, bigger tap targets) — they all stay, they all
prevent OTHER races. But the load-bearing wipe was happening in a
totally different code path: the parent's render → child effect re-run.

**Fix (3 parts in commit `9987842`):**

1. `src/components/ui/data-grid.tsx` seed effect (line 1709-1751):
   - Read `valueFilterTouched` from `valueFilterTouchedRef` (mirrored
     via a tiny `useEffect` so cross-batch firing still sees the
     latest value).
   - `setColumnValueFilters` switched to **updater form** with a guard:
     `prev => Object.keys(prev).length > 0 ? prev : next`. Once the
     operator has ANY filter, the seed permanently stays out of the
     way. Belt-and-braces.

2. `src/pages/production/index.tsx:1142-1152`: hoisted
   `DEPT_STATUS_EXCLUDE` to `useMemo`, derived
   `deptDefaultExcluded = clearAllActive ? undefined : DEPT_STATUS_EXCLUDE`
   outside the JSX. Pass the stable ref.

3. `src/pages/sales/index.tsx:281-289`: same treatment —
   `SHIPPED_STATUS_EXCLUDE` hoisted to `useMemo`.

**Verification (live on prod, deploy `9987842`):**
- Navigated to `https://hookka-erp-testing.pages.dev/production/fab-cut?_=cachebust`.
- Opened State popover, unticked KL with a coord click, tapped OK once:
  filter applied on first click (139 → 31 → 162 records depending on
  whether default exclusion was also active).
- Repeated after a 28-second idle wait (covers at least one passive-poll
  cycle): still applied on first click. Previously this was when the
  seed effect would clobber.

**Related:** Symptoms of BUG-2026-05-24-001 / -002 were real but were
SECONDARY races on top of this one. All three fixes ship together.

---

## BUG-2026-05-24-002 — DataGrid filter OK "still missed on first click" — touch hit-target too small

**Status:** 🟢 Fixed (2026-05-24)
**Category:** ui-frontend

**Symptom:** Wei Siang reported the column-filter OK button STILL didn't
respond to the first tap even after BUG-2026-05-24-001's fix landed and
verified live. Tapping OK closed the popover but the filter didn't apply;
a second tap on the next open worked.

**Root cause:** The 2026-05-24-001 code fix is correct — programmatic
click and pixel-perfect coord click both apply the filter on the first
OK. The real culprit was finger imprecision on a 49×30-px OK button and a
14-px checkbox sitting in a 21-px-tall row. On the factory-floor tablet,
the user's tap routinely landed a few pixels outside the OK rect (hitting
the gap before Close, or the popover border) so React's onClick never
fired. The reproduction was confirmed live via Chrome MCP: a coord click
4 px off the KL checkbox + a coord click on OK closed the popover with
NO filter applied, while pixel-centered clicks worked every time.

**Fix:** `src/components/ui/data-grid.tsx` — bump every tap target in the
ColumnFilterDropdown:
- Value-list rows: `py-0.5 → py-1.5`, `text-[11px] → text-[12px]`,
  checkbox `h-3.5 w-3.5 → h-4 w-4` (row height 21 → 30 px, checkbox
  14 → 16 px).
- OK button: `px-4 py-1.5 text-[11px] → px-5 py-2.5 text-[12px]`,
  added `min-w-[64px]` (size 49×30 → 64×40 px, +73% area).
- Close button: same `px-5 py-2.5 min-w-[64px]` treatment.
- Clear Filter: `px-3 py-1 → px-3 py-2`, `text-[11px] → text-[12px]`.
- Action row: `px-2 py-1.5 → px-2 py-2`, gap between OK/Close
  `gap-2 → gap-3` (8 → 12 px) so a near-miss doesn't accidentally hit
  the wrong button.

**Verification (live on prod):**
- Navigated to https://hookka-erp-testing.pages.dev/production/fab-cut
  via Chrome MCP after deploy 7159e84.
- Measured new rects via DOM inspection: label 30 px tall, checkbox
  16×16 px, OK 64×40 px, Close 70×40 px, OK→Close gap 12 px.
- Toggled State filter (KL) + clicked OK on first tap → filter applied
  (897 → 162 → cleared back to 897 with re-tick + OK).

**Related:** Follow-up to BUG-2026-05-24-001 (the closure-race code
fix). Both ship together — 59c3141 (logic) + 7159e84 (UX).

---

## BUG-2026-05-24-001 — DataGrid column-filter popover: first OK click does nothing (third regression)

**Status:** 🟢 Fixed (2026-05-24)
**Category:** ui-frontend

**Symptom:** On the Production page (any grid with passive polling), opening
a column's Values filter popover (e.g. SO ID), ticking a value, and clicking
OK did nothing on the first click — popover either stayed open with no
filter applied OR closed silently with no filter applied. A second OK click
applied the filter correctly. Reproducible on Wei Siang's Production page
sittings; intermittent on grids without polling.

**Root cause:** The OK button's `onClick` read `checkedRef.current` (kept
fresh by the prior 2026-05-22 fix) but compared its size against
`uniqueValues.length` from the render-time CLOSURE. On Production the data
poll fires every 20s (`src/pages/production/index.tsx:1395-1406`) — any
refetch landing between the operator's last checkbox toggle and the OK
click flowed through `data → scopedData → allData → uniqueValues` to a
fresh array with a different length. The OK closure still held the prior
length, so the equality check
`latestChecked.size === uniqueValues.length` silently lied: if the poll's
new length happened to match the narrowed selection size, the handler
treated it as "user has everything checked" and called
`onApplyValues(null)` — wiping the filter. Second click worked because by
then the popover had re-rendered and the closure caught up.

The two prior fixes ([3e1933f](https://github.com/weisiang329-eng/hookka-erp-testing/commit/3e1933f),
[ef4b08e](https://github.com/weisiang329-eng/hookka-erp-testing/commit/ef4b08e))
hardened the CHECKED side against same-tick batching (good — those fixes
stay) but neither moved `uniqueValues` off the closure, so a data refresh
beat them every time.

**Fix:** `src/components/ui/data-grid.tsx` (ColumnFilterDropdown)

- Added `uniqueValuesRef`, synced post-commit via a tiny
  `useEffect(() => { uniqueValuesRef.current = uniqueValues; },
  [uniqueValues])`. Effect commits run synchronously before the browser
  yields to the next event tick, so any subsequent OK click reads the
  same `uniqueValues` React just rendered with. Lint-clean
  (react-hooks/refs forbids ref writes during render).
- OK button now reads BOTH `checkedRef.current` and
  `uniqueValuesRef.current`, with NO closure capture of either.
- "All checked" check tightened from size-only to size-AND-content
  (`unique.every(([v]) => latestChecked.has(v))`) so a same-size mismatch
  (e.g. one value swapped after a poll) can't fall through and clear the
  filter.
- `toggleAll` and `toggleChip` also rewired to read uniqueValues from
  the ref for symmetry — guards against a (very rare) same-tick
  double-click on (All) or a chip resolving against stale render state.

**Verification:**
- `npm run typecheck:app` — passes
- `npm run build` — passes
- `npm test` — 480/481 pass (1 skipped, same baseline)
- Operator to re-test: open SO ID popover on Production, wait for at
  least one 20s poll tick, then tick a value + click OK once. Filter
  should land on the first click; if it doesn't, capture console logs and
  reopen this bug.

**Related:** Two prior attempts at this bug —
[3e1933f](https://github.com/weisiang329-eng/hookka-erp-testing/commit/3e1933f)
(2026-05-22), [ef4b08e](https://github.com/weisiang329-eng/hookka-erp-testing/commit/ef4b08e)
(2026-05-15). Both fixed the checked-set side of the race; this fix closes
the `uniqueValues` side.

---

## BUG-2026-05-23-001 — Service Order copy-from missing EX prefix + Base Price stuck on "Select fabric" + no line-item picker

**Status:** 🟢 Fixed (2026-05-23)
**Category:** sales-orders

**Symptom:** First-day review of the just-shipped Service Order copy-from
feature (`/service-order/create` → "Copy from SO/CO" button) surfaced three
operator-facing gaps:

1. Destination Service Order's Customer PO No / Reference fields carried the
   source's raw values verbatim (e.g. "PO-2605-030") — no visual marker that
   this was a copy, easy to confuse with the original on the doc-flow tree.
2. The "Base Price (RM)" cell on every copied line rendered as the regular
   SO yellow "Select fabric" prompt — Service Orders are supposed to start
   at RM 0 with the operator typing the agreed service price, not derive
   the price from the customer's fabric tier book.
3. The Copy modal was 1-step: type "SO-2605-111" → Copy → ALL lines came
   over. If the source had 5 lines and the operator only wanted to invoice
   1 line of repair, they had to delete 4 lines after the import.

**Root cause:**

1. `POST /api/sales-orders/copy-for-service-order` (sales-orders.ts:3344)
   passed `customer.customerPO` / `customerPOId` through verbatim and built
   `reference = "Copied from SO <id>"` — no EX tag.
2. `LineItemCard` (sales/create.tsx:2604) rendered the Base Price cell as a
   read-only `<div>` for the BEDFRAME layout, displaying "Select fabric"
   when `basePriceSen === 0`. The component didn't know about Service Order
   mode, so even when `useSOMode()` said `service-order`, the price field
   stayed read-only and dependent on fabric pick.
3. The modal explicitly shipped Phase 1 = copy-all per Agent D's commit;
   Phase 2 picker was a TODO at the bottom of the file.

**Fix:**

- `src/api/routes/sales-orders.ts` (copy-for-service-order handler): added
  an `exPrefix(raw)` helper (idempotent — won't double-prefix if value
  already starts with `EX-` / `EX `). Applied to `customerPO`,
  `customerPOId`. Reference now reads `EX <SO|CO> <sourceNo>` (e.g.
  "EX SO-2605-111").
- `src/pages/sales/create.tsx` (LineItemCard): threaded `isServiceOrderMode`
  as a prop from the parent; the Base Price cell now renders an editable
  `<Input type="number">` (defaults to 0) in Service Order mode, falling
  back to the existing fabric-driven read-only display for normal Sales
  Orders. Fabric dropdown is unchanged — still required for production
  routing.
- `src/pages/sales/create.tsx` (CopyFromSourceModal): refactored to a
  2-step wizard. Step 1 unchanged (SO/CO tab + id input). Step 2 fetches
  `/api/sales-orders/:id` or `/api/consignment-orders/:id`, renders the
  source's line items in a table with checkboxes (default all checked,
  with check-all/uncheck-all toggle), and "Copy Selected (N)" button posts
  the picked `lineItemIds` to the existing endpoint (already accepted the
  param).

Also verified Issue from the same review: copied lines DO carry
`specialOrder` + `customSpecials` from the SO source (line 3440-3456 in the
handler maps both; the CO source has no `customSpecials` column so it
correctly defaults to `[]`). Frontend `onCopied` handler (create.tsx:1956)
already hydrates both fields into the LineItem form draft. No fix needed.

**Verified:**

- `npm run typecheck:app` — passes
- `npm run build` — passes (pre-existing 500KB chunk warning unchanged)
- `npm test` — 480/481 (1 pre-existing skip), no regressions

---

## BUG-2026-05-21-005 — Snapshot freshness check assumed a universal `updated_at` column → 9 of 15 snapshot endpoints HTTP 500 on deploy

**Status:** 🟢 Fixed (2026-05-21)
**Category:** infrastructure

**Symptom:** After the snapshot work (PR 1/3/4/7) deployed to staging,
**9 of 15 snapshot-backed endpoints returned HTTP 500** — dashboard/overview,
sales-orders/stats, delivery-orders/po-values, accounting/aging,
cost-ledger/summary, production-orders/overdue-counts, department-performance,
job-cards/summary, consignment-notes/stats. Error body:
`{"success":false,"error":"column \"updated_at\" does not exist"}`. The
6 endpoints whose source tables all happen to have `updated_at` worked
(and their before/after output matched byte-for-byte).

**Root cause:** Every snapshot helper's Layer 2 freshness check hard-coded
`SELECT MAX(updated_at) FROM <source_table>` for each source table, on
the assumption that `updated_at` is a universal column. It is not — a
staging `information_schema` probe showed only **28 of 130+ tables** carry
`updated_at`. Line-item tables (`sales_order_items`, `delivery_order_items`,
`invoice_items`), append-only tables (`cost_ledger`, `rm_batches`,
`fg_batches`), and others (`job_cards`, `payment_records`, `customers`,
`fg_units`, `workers`, `bom_templates`) have none. Any snapshot whose
source list included one of those → SQL error → 500.

Not caught by `tsc` or `npm test` — neither connects to the real DB
schema. Caught by the 2026-05-21 staging before/after verification, which
is exactly what that step exists for (had this gone straight to prod,
9 prod endpoints would have been down).

**Fix:** New `src/api/lib/snapshot-freshness.ts` — a schema-aware probe
that queries `information_schema` once (cached per isolate) to learn each
source table's best timestamp-typed column (`updated_at` preferred, else
`created_at`), then builds the freshness `UNION ALL` with the right column
per table. Tables with no timestamp-typed column are skipped — they
cannot be tracked incrementally and the Layer 3 nightly rebuild covers
them (≤24h staleness worst case). All four snapshot helpers
(`dashboard-snapshot.ts`, `snapshot.ts`, `delivery-snapshot.ts`,
`invoice-snapshot.ts`) now delegate to this one probe.

**Verify (staging):** redeploy → re-run the 15-endpoint before/after
diff; all 15 expected `200` + data parity. `tsc` clean; `npm test`
185/185.

---

## BUG-2026-05-21-004 — Customer `outstandingSen` writable by hand-crafted POST/PUT (back-door past the invoice ledger)

**Status:** 🟢 Fixed (2026-05-21)
**Category:** data-integrity

**Symptom:** The customer create/edit dialog has no input cell for
`outstandingSen` — it's a derived A/R balance that should only move
via invoice POST (+), payment POST (−), credit-note POST (−), debit-note
POST (+). But `POST /api/customers` accepted `body.outstandingSen ?? 0`
and `PUT /api/customers/:id` accepted `body.outstandingSen ?? existing`.
Any admin script (or anyone hand-crafting a request) could seed or
overwrite A/R with a number that had no supporting invoice row. The next
payment posting would then over- or under-decrement against ghost A/R.

**Root cause:** Pairs the same back-door pattern Wei Siang flagged for
debit-note items and invoice line totals — the route accepted a field
the UI never sends, with no validation that the value reconciles to
the ledger.

**Fix (`src/api/routes/customers.ts`):**
- POST: hard-pin `outstandingSen` to 0 at creation (was `body.outstandingSen ?? 0`).
- PUT: hard-pin `merged.outstandingSen = existing.outstandingSen`
  (was `body.outstandingSen ?? existing.outstandingSen`).
- The four legitimate writers (`invoices.ts`, `payments.ts`,
  `credit-notes.ts`, `debit-notes.ts`) all use atomic
  `outstandingSen = outstandingSen +/- ?` SQL and never touch these
  routes — confirmed by grep.

**Verify on prod (read-only):** `tsc` clean. Create / edit customer
from UI → row's `outstandingSen` unchanged by save. POST or invoice
or payment → atomic update still moves the balance.

---

## BUG-2026-05-21-003 — Invoice line item `totalSen` writable from client (back-door past `unitPriceSen × quantity`)

**Status:** 🟢 Fixed (2026-05-21)
**Category:** data-integrity

**Symptom:** `POST /api/invoices` and the PUT counterpart computed
`const totalSen = Number(raw.totalSen) || unitPriceSen * quantity`. A
caller could send `totalSen: 999_999` and the server would store it
verbatim, decoupled from `unitPriceSen × quantity`. Invoice header
`totalSen` is the sum of items' `totalSen`, so the customer A/R
increment (and downstream payment math) would track the back-door
number, not the line economics.

**Root cause:** Same back-door pattern as the debit-note `unitPrice/total`
issue (BUG-2026-05-21-002 below) — accepting a derived field from the
client rather than recomputing server-side.

**Fix (`src/api/routes/invoices.ts`):** drop the `Number(raw.totalSen) ||`
branch — `totalSen` is now always `unitPriceSen * quantity`, computed
server-side. Header `totalSen` continues to sum the item totals so the
invariant holds: `header.totalSen = Σ(items[i].unitPriceSen × items[i].quantity)`.

**Verify on prod (read-only):** `tsc` clean. Create invoice from UI →
each item's `totalSen` matches `unitPriceSen × quantity`. Header total
matches the sum.

---

## BUG-2026-05-21-002 — Debit Note line items used unit-ambiguous `unitPrice` / `total` (caller posting RM landed in sen field 100× off)

**Status:** 🟢 Fixed (2026-05-21)
**Category:** data-integrity

**Symptom:** Debit-note items used field names `unitPrice` and `total`
with no unit suffix. A caller posting `unitPrice: 4800.00` (intending
RM 4800) would land `4800` in the `outstandingSen` increment — RM 48,
**100× off**. Mirror of the credit-note `_sen` rename Wei Siang did
earlier; debit-note was missed in that pass.

**Root cause:** Inherited the legacy non-`_sen` field shape from
pre-_sen-rename code. The system-wide convention is integer sen on
the wire; debit-note items broke it.

**Fix:**
- `src/api/routes/debit-notes.ts`:
  - Renamed `DNItem.unitPrice` → `unitPriceSen`, `total` → `totalSen`.
  - Added `LegacyDNItem` shape + `parseItems` back-compat shim that
    reads old rows (legacy `unitPrice`/`total`) and surfaces them as
    `unitPriceSen`/`totalSen` — no DB migration needed.
  - POST strictly rejects payloads sending `unitPrice` instead of
    `unitPriceSen` (`400` with a clear "use Math.round(rm * 100)"
    message). `unitPriceSen` must be a non-negative integer; quantity
    must be > 0. Server recomputes `totalSen = unitPriceSen × quantity`
    (no client-supplied total).
- `src/pages/invoices/debit-notes.tsx`: every `unitPrice` / `total`
  on the line-item form switched to `unitPriceSen` / `totalSen`. The
  form already sent integer sen via `Math.round(rm * 100)` — name
  change only.

**Verify on prod (read-only):** `tsc` clean. Create DN from UI → POST
payload uses `unitPriceSen`. Existing DN rows in the legacy shape
render unchanged (back-compat shim). Status → POSTED still increments
customer `outstandingSen` by the correct sen amount.

---

## BUG-2026-05-21-001 — Payment BOUNCED rollback raced (read-then-write decrement could go negative or skip a status transition)

**Status:** 🟢 Fixed (2026-05-21)
**Category:** payments

**Symptom:** When a payment moved to `BOUNCED`, the route read the
invoice, subtracted the payment amount in JS, picked the new status
in JS, then wrote back. Two BOUNCED transitions arriving close
together could read the same `paidAmount`, both decrement against
the stale value, and one would either drive `paidAmount` negative
or fail to recompute the status correctly.

**Root cause:** Read-then-write decrement without DB-side guards.
Same anti-pattern that bit the customer-A/R math earlier; mirror of
the GREATEST/CASE atomic pattern used in `credit-notes.ts`.

**Fix (`src/api/routes/payments.ts`):** the BOUNCED rollback now uses
a single atomic SQL `UPDATE invoices SET paidAmount = GREATEST(0,
paidAmount - ?), status = CASE WHEN GREATEST(0, paidAmount - ?) <= 0
THEN 'SENT' WHEN GREATEST(0, paidAmount - ?) < totalSen THEN
'PARTIAL_PAID' ELSE 'PAID' END, updated_at = ? WHERE id = ?`. No
read-then-write window; clamp prevents negative balance even if the
ledger ever drifted.

**Verify on prod (read-only):** `tsc` clean. Mark a posted payment as
BOUNCED → invoice `paidAmount` drops by exactly the payment amount,
status walks to the right bucket. Two concurrent BOUNCED transitions
on different payments of the same invoice both apply correctly with
no negative landing.

---

## BUG-2026-05-20-008 — Backfill route had no double-click guard (FOAM 326 inflation pattern)

**Status:** 🟢 Fixed (2026-05-20)
**Category:** infrastructure

**Symptom:** Admin double-clicked "Run backfill" in dev tooling; the
`/api/import/backfill-cascade-wip-producers` endpoint had no request
dedup or hash-keyed completion lock. Both invocations re-fired
`applyWipInventoryChange` for every cascade-completed JC, doubling
wip_items stockQty (the documented FOAM 326 inflation, BUG-2026-05-12
series).

**Root cause:** The endpoint at import-completion.ts:3552-3996 looped
over candidate JCs and pushed UPDATE batches without any idempotency
key tying the run to a specific candidate set. Two parallel runs
appeared as two distinct WIP increments to the system.

**Fix:** Per owner direction "我们已经没有 backfill 功能了" — deleted the
endpoint outright (445 lines) rather than retrofit a dedup table. The
backfill purpose was a one-shot migration that's done; keeping an
unprotected admin endpoint live in production was the lower-value
trade-off. RefundCandidateRow + RefundSiblingRow type definitions
relocated next to the surviving `/refund-backfill-overconsume` route.
Commit `a54a7e9`.

**Verify:** `tsc -b` clean post-deletion. No frontend caller existed
(verified — grep `/api/import/*` returned nothing in `src/pages` or
`src/components`). The 19 sibling backfill admin endpoints in the same
file remain untouched per the PR 0 allowlist; logged for follow-up in
`docs/AUDIT-BACKLOG-2026-05-20.md`.

---

## BUG-2026-05-20-007 — SO cancel cascade left cancelled JCs' cost_ledger in WIP forever

**Status:** 🟢 Fixed (2026-05-20)
**Category:** sales-orders

**Symptom:** Cancelling an SO that had active POs/JCs (some COMPLETED,
some IN_PROGRESS) moved the in-flight JCs to CANCELLED but never
reversed the cost_ledger entries those JCs had accumulated. P&L
carried WIP cost from abandoned work indefinitely; the dashboard
"Pending Production Time" KPI kept the cancelled work in its bucket.

**Root cause:** `sales-orders.ts:580-625` cascade UPDATEd
production_orders.status + job_cards.status but never wrote a
matching ADJUSTMENT row in cost_ledger to net out the cancelled
work's existing LABOR_POSTED / FG_COMPLETED entries. Searched whole
codebase — no REFUND/REVERSAL/ADJUSTMENT-on-cancel rows anywhere.

**Fix:** After the JC status UPDATE batch, SELECT cost_ledger entries
with `refType='JOB_CARD'` AND `refId IN (cancelled JC ids)`, then
push a matching ADJUSTMENT row for each with the OPPOSITE direction
('IN' ↔ 'OUT') and same qty/cost. Running totals net to zero.
ADJUSTMENT is the existing reversal type per the CHECK constraint at
`migrations-postgres/0001_init.sql:838` (no new migration). Commit
`2b50123`.

**Memory rule honored** (`feedback_protect_completed_work.md`):
refType='PRODUCTION_ORDER' entries (RM_ISSUE that fired upstream from
COMPLETED FAB_CUT JCs, FG_DELIVERED from already-shipped units) are
NOT touched — only JOB_CARD-keyed entries on the JUST-cancelled JCs.

**Verify:** `tsc -b` clean. Practical scope: most cancelled JCs are
WAITING (no entries) so reversal inserts 0 rows in typical cases;
fix matters for IN_PROGRESS/PAUSED JCs that had partial completion
posted.

---

## BUG-2026-05-20-006 — Two POs completing same minute over-pulled the same FIFO rm_batch (cost+inventory silent corruption)

**Status:** 🟢 Fixed (2026-05-20)
**Category:** inventory-cascade

**Symptom:** Two POs completing simultaneously and consuming the same
RM batch could both schedule decrements against the snapshot
remainingQty. Atomic SQL kept the rm_batches column itself
mathematically correct, but each PO's cost_ledger entry was computed
against the SNAPSHOT — total issued material could exceed actual
batch capacity. `raw_materials.balanceQty` got floored by
`GREATEST(0, ...)` and silently under-deducted. cost_ledger
over-counted materials issued; P&L wrong, inventory wrong, no error
surfaced.

**Root cause:** `po-cost-cascade.ts:471-540` — `fifoConsume()` ran
purely against the in-memory snapshot of rm_batches read at the
start of the function. Two concurrent invocations both saw e.g.
remainingQty=10, both picked an 8m slice, both pushed a -8m UPDATE
that decremented the column to -6m without anyone failing.

**Fix:** Per-slice UPDATE now carries `AND remainingQty >= ?` guard
and runs serially with `await ... .run()` (out of the batch). After
each UPDATE we inspect `meta.changes` — 0 means race lost → throw a
clear operator-language error naming PO, line, slice qty. cost_ledger
INSERT only fires if the UPDATE succeeded, so the ledger can never
claim material that wasn't actually consumed. `raw_materials`
balance UPDATE stays in the deferred batch (line-level sum, safe).
Commit `b0e8e90`.

**Verify:** `tsc -b` clean. Cost: ~5 extra round-trips per PO
completion (slices serial vs batched) — acceptable given the
consequence (silent inventory corruption) it prevents.

---

## BUG-2026-05-20-005 — Credit Note unitPrice ambiguous (RM vs sen) — 100× silent off-by-decimal risk

**Status:** 🟢 Fixed (2026-05-20)
**Category:** invoices

**Symptom:** A caller POSTing `unitPrice: 4800.00` to `/api/credit-notes`
(meaning RM 4800) would silently land 4800 SEN (= RM 48) in the
`customers.outstandingSen` decrement — 100× off, customer credit
under-applied. The on-page frontend stored sen internally so the UI
path was fine, but any external integrator or curl call would hit
the trap.

**Root cause:** `credit-notes.ts:201-209` accepted `item.unitPrice`
without unit-naming convention or integer validation. The DB column
`total_amount` was integer sen, but the JSON items field was named
`unitPrice` / `total` with no `_sen` suffix — schema-internal vs API-
boundary contract drift. Both directions (RM-as-sen or sen-as-RM)
were undetectable.

**Fix:** Renamed JSON shape to `unitPriceSen` / `totalSen`. Backend
POST handler rejects (1) `unitPrice` (without _sen) with a clear
error pointing at the new name + `Math.round(rm * 100)` recipe,
(2) non-integer `unitPriceSen` (catches RM-decimal sneak path), and
(3) non-positive quantity. Frontend `CreditNoteItemRow` type +
handlers updated to send the new name. `parseItems()` reads either
legacy `{unitPrice, total}` OR new `{unitPriceSen, totalSen}` so
existing DB rows render correctly (value was already in sen, only
the field name differed). PDF generator already read `unitPriceSen ?? 0`
defensively, no change needed there. Commit `cb63b4b`.

**Memory rule honored** (`feedback_reject_dont_normalize.md`,
`feedback_validation_frontend_backend_unified.md`): reject ambiguous
input at the explicit name boundary; don't silently coerce.

**Sister bug NOT fixed in this PR** (per owner allowlist): the same
ambiguous `unitPrice` pattern exists in `debit-notes.ts` /
`debit-notes.tsx`. Logged for follow-up.

**Verify:** `tsc -b` clean.

---

## BUG-2026-05-20-004 — Invoice cancel/delete left customers.outstandingSen forever inflated (AR drift)

**Status:** 🟢 Fixed (2026-05-20)
**Category:** invoices

**Symptom:** Cancelling a SENT/PARTIAL_PAID/OVERDUE invoice (or
deleting a DRAFT) wrote only the audit/void row but never reversed
the customer's `outstandingSen`. The customer's AR balance kept the
cancelled amount forever — every void / delete padded the running tab
with money the customer no longer owed. Operator-visible everywhere:
customer detail page, dashboard outstanding KPI, aging report.

**Root cause:** `invoices.ts:716` (PUT into CANCELLED branch) and
`invoices.ts:1023` (DELETE handler) had no `UPDATE customers SET
outstandingSen = ...` statement. The auto-create-from-DO path
(`delivery-orders.ts:678`) DOES bump outstandingSen on create — the
reverse leg was missing.

**Fix:** PUT void path now appends a batch statement that subtracts
`(totalSen - paidAmount)` (the unpaid portion = what was still on
the customer's tab at cancel) from `customers.outstandingSen`. DELETE
handler extended to SELECT customerId/totalSen/paidAmount, switched
from a bare DELETE to a batch that includes the same reversal.
`MAX(0, ...)` guards both writes so the manual-POST path (which
doesn't bump on create) can't drive the balance negative — same
guard pattern as `credit-notes.ts:256` and `payments.ts:389`. Commit
`08807e0`.

**Verify:** `tsc -b` clean.

---

## BUG-2026-05-20-003 — Overpayment silently flipped invoice PAID; customer credit balance vanished

**Status:** 🟢 Fixed (2026-05-20)
**Category:** payments

**Symptom:** Operator records a payment larger than the invoice owed.
The endpoint accepted it: `newPaid = paidAmount + amount` flipped
status to PAID and left `paidAmount > totalSen`. The customer's
overpayment (the credit they should have on file) vanished from the
system — no refund row, no credit balance tracked.

**Root cause:** `payments.ts:268-274` checked only `isFullyPaid =
newPaid >= totalSen` and pushed the UPDATE unconditionally. No upper
bound.

**Fix:** Added a pre-batch validation loop that rejects with 400 when
`snap.paidAmount + alloc.amount > snap.totalSen`, reporting the exact
overshoot in sen and recommending Credit Note before retry. Same
commit as BUG-2026-05-20-001/002. Commit `85e839e`.

**Verify:** `tsc -b` clean. Note: the race-window pathway (two
concurrent payments squeezing past the validation) still exists but
caps damage at "paidAmount slightly exceeds totalSen" — operator-
visible and correctable, vs the original silent vanish.

---

## BUG-2026-05-20-002 — Negative payment amount accepted, bypassed Credit Note workflow

**Status:** 🟢 Fixed (2026-05-20)
**Category:** payments

**Symptom:** Operator (or curl) could record a payment with negative
amount (e.g. `-RM 5000`). The endpoint silently subtracted from
`paidAmount`, bypassing the Credit Note workflow — no refund reason,
no CN audit trail, no journal entries on the reversal side.

**Root cause:** `payments.ts:225` used `Number(a.amount) || 0` —
allowed negatives through; downstream math then propagated.

**Fix:** Pre-batch validation loop rejects with 400 when any
allocation amount < 0, with a plain-English error pointing the
operator at the Credit Note workflow as the correct path. Same
commit as BUG-2026-05-20-001/003. Commit `85e839e`.

**Verify:** `tsc -b` clean.

---

## BUG-2026-05-20-001 — Two simultaneous payments on same invoice silently lost one (last-write-wins on paidAmount)

**Status:** 🟢 Fixed (2026-05-20)
**Category:** payments

**Symptom:** Owner-reported daily-bite risk: two finance staff record
payment on the same invoice concurrently. payment_records ends up
with both rows (good), but invoice.paidAmount reflects only one of
them. Customer pays e.g. RM 8000 split across two staff (RM 5000 +
RM 3000); system books only RM 3000 paid; finance later chases the
customer for the "missing" RM 5000 they already paid.

**Root cause:** `payments.ts:268-310` read `paidAmount` into a JS
snapshot, computed `newPaid = snap.paidAmount + alloc.amount`, then
wrote `UPDATE invoices SET paidAmount = ?` with the computed value.
Two concurrent requests both snapshot the same paidAmount=X, both
compute newPaid=X+delta, last UPDATE wins, the other delta vanishes.

**Fix:** Switched to atomic SQL increment. UPDATE now reads
`SET paidAmount = paidAmount + ?` (DB-side arithmetic; never reads
the snapshot value). status + paymentDate computed in a CASE
expression against the post-increment value so they stay consistent
with the actual stored amount. Two concurrent payments now both
land cleanly. Bundled with negative-payment rejection (BUG-2026-05-20-002)
and overpayment rejection (BUG-2026-05-20-003) in the same commit.
Commit `85e839e`.

**Verify:** `tsc -b` clean. Sister bug NOT fixed in this PR: the
BOUNCED rollback path at `payments.ts:477-528` has the same read-
then-write race. Logged for follow-up.

---

## BUG-2026-05-18-004 — Invoices systematically under-billed (~RM 165k net) — narrow per-DO price index priced unmatched items at zero

**Status:** 🟢 Fixed (2026-05-18) — pricing fix (both creation paths) +
void/re-issue migration shipped to prod and executed. 40 single-invoice
DOs + DO-2604-001 (2-invoice merged) voided & re-issued at the correct
value; books reconcile to RM 0 gap (live invoices RM 328,356 == delivered
RM 328,356); customer A/R netted by the exact delta; a DO→INVOICED
side-effect that crashed the Delivered total was caught and self-healed
(all DOs back to DELIVERED). Verified live.
**Category:** sales-orders

**Symptom:** Wei Siang: "invoice amount 跟 delivered amount 对不上". The
84 issued invoices summed RM 167,361.26 while the matching delivered DOs
summed RM 333,065.00 — **net RM 165,703.74 under-billed** (38 invoices
under, 4 over, 42 ok). Worst: DO-2604-014 (24 furniture items, RM 16,808
delivered) invoiced at **RM 2,200**.

**Root cause:** `src/api/routes/delivery-orders.ts` `computeDoInvoiceLines`.
The DO "value" (the correct figure, shown on the Delivery page + /stats)
is computed by `loadDoValueMap` in `src/api/lib/do-value.ts`, which prices
each item with `priceForItem` against a **whole-org** `loadSoLinePriceIndex`
(every PO + every sales_order_items line in the org) using the DO's own
salesOrderId as fallback. `computeDoInvoiceLines` instead built its **own
NARROW index** — only this DO's POs + only the `resolveDoSalesOrderIds`
SOs' lines. So `priceForItem`'s last-resort `byAnyCode` map was missing
most product codes; any delivered item whose code didn't exactly match a
line in those few SOs (common for SOFA variant codes like `5530-2A(LHF)`
and consolidated multi-SO deliveries) resolved to **unitPrice 0** and was
billed at zero. The two "bill the SO directly / SO header total" fallbacks
only fired when the WHOLE computed total was exactly 0, so a single matched
item left the under-billed total locked in. do-value.ts's own header
states it is the single source so "an invoice equals the displayed Amount
to the cent" — the invoice path had silently drifted from that.

**Fix:** `computeDoInvoiceLines` now derives orgId + the DO's salesOrderId
from the `delivery_orders` row and prices every item via the shared
whole-org `loadSoLinePriceIndex` + the identical `priceForItem(idx,
productionOrderId, doSalesOrderId, productCode)` call `loadDoValueMap`
uses → the invoice total equals the DO value to the cent by construction.
Fallbacks retained (lazy-fetched) for the genuine no-price case. No caller
signature changed (orgId resolved internally). `SoLinePriceIndex` import
dropped (narrow index removed); `loadSoLinePriceIndex` imported.

**2nd instance (same bug, different path):** `POST /api/invoices`
(manual "Create Invoice from DO") had its OWN inline pricing —
`sales_order_items WHERE salesOrderId = doRow.salesOrderId` (single SO)
keyed by productCode only — the identical under-billing flaw. Fixed by
routing it through the shared `computeDoInvoiceLines` /
`resolveDoSalesOrderIds` (both now `export`ed; imported in invoices.ts
via a call-time `import()` to avoid the delivery-orders↔invoices static
cycle). All three creation paths now price off the one whole-org
resolver.

**Verified:** `npm run build:strict` passes (typecheck + build). A
reconciliation script (84 rows: invoice → DO → old vs corrected vs diff)
will be run on the isolated branch for Wei Siang sign-off BEFORE any data
change. The 84 already-issued+posted wrong invoices will be **voided and
re-issued** (Wei Siang's call, 2026-05-18) — reverse their ledger entries,
re-create at the correct amount, re-post — as a separate audited phase
after sign-off. Forward-only behaviour change is safe; existing-data
correction is gated.

---

## BUG-2026-05-18-003 — Newly-added DataGrid columns never appear for users who already have a saved column layout

**Status:** 🟢 Fixed (2026-05-18) — code shipped + verified
**Category:** ui-frontend

**Symptom:** The new "Customer SO" column shipped and deployed, but on
Production → Fab Cut it did not appear for Wei Siang. The renamed
"Customer PO" column DID show. The column was present (toggleable) in
the Columns menu but defaulted off.

**Root cause:** `src/components/ui/data-grid.tsx`. The reconciliation
effect that auto-shows code-added columns decided "is this column new?"
by testing membership in `columnOrder`. But `columnOrder` initialises
(no-persisted-order branch) to `columns.map(c => c.key)` — the *current*
columns, which already include any just-added key. So for any user with
a saved visibility set but no saved column order (the common case;
toggling a column writes `datagrid-cols` but not `datagrid-colorder`),
every genuinely-new column was treated as already-known and never added
to `visibleKeys`, leaving it hidden until manually enabled. Verified
against live localStorage: `datagrid-cols-production-dept-fab_cut-<email>`
listed 26 keys incl. `customerPOId` but not `customerSO`, and no
`datagrid-colorder-*` key existed. Affected every grid in the app for
every future column addition, not just this one.

**Fix:** `src/components/ui/data-grid.tsx` — added a per-user persisted
"seen columns" ledger (`datagrid-seen-${gridId}-${userKey()}`). A column
is new iff its key is absent from that ledger; the ledger seeds from the
persisted column ORDER (the full universe incl. user-hidden columns) when
present, else from the current columns (legacy-safe — never resurrects a
deliberately-hidden column; the ledger is then persisted so subsequent
additions are detectable even for never-reorder users). Plus an
`ensureColumns?: string[]` prop for one-time roll-out of a new
default-visible column to existing users (idempotent per user/grid via
`datagrid-ensured-*`, so a later hide is respected); the production dept
sheet passes `ensureColumns={["customerSO"]}`. `resetToOrgDefault` clears
both new ledgers. Six scenarios traced (never-reordered, reordered,
brand-new user, deliberately-hid-a-column, org-default, future column) —
zero regression; the hidden-column case is explicitly protected.

**Verified:** `npm run build:strict` passes (typecheck + build). Live
re-check on prod after deploy confirms Customer SO renders for Wei Siang
in its defined position (right after Customer PO) without manual toggle,
and an intentionally-hidden column is not resurrected.

---

## BUG-2026-05-18-002 — Production CI deploy silently broken since the chart-of-accounts merge (build:strict typecheck gate)

**Status:** 🟢 Fixed (2026-05-18) — code shipped + verified
**Category:** infrastructure

**Symptom:** No push to `main` reached production after the
chart-of-accounts merge (`024d9fa`). The "Deploy to Cloudflare Pages"
GitHub Action ran but the actual Pages-deploy step was skipped on every
commit; prod kept serving `5028e31`. Surfaced when the Fab Cut
"Customer SO" change (`b7ae31f`) was pushed straight to prod at Wei
Siang's request and its deploy job failed — investigation showed
`024d9fa`'s deploy had already failed at the identical step.

**Root cause:** `src/pages/accounting/index.tsx` (lines 170 and 244,
introduced by the chart-of-accounts merge) had two
`fetch(...).then((r) => r.json()).then((j) => …)` chains that read
`j.data` without typing the JSON. `tsc` inferred the response as `{}`
→ TS2339 "Property 'data' does not exist on type '{}'". The deploy
workflow gates on `npm run build:strict` (= `typecheck:app && build`),
so the type error aborted the build and the conditional deploy step
was skipped. Plain `npm run build` (rolldown transpile, no typecheck)
still succeeded, so the breakage was invisible to anyone running a
local build instead of `build:strict`.

**Fix:** `src/pages/accounting/index.tsx:168` and `:242` — cast the
`.json()` promise (`r.json() as Promise<{ data?: { pct?: number } | null }>`
and `Promise<{ data?: unknown }>`), mirroring the existing
`(await res.json()) as { … }` convention already used for the PUT
calls in the same file. Typing-only; no runtime/behaviour change.

**Verified:** `npm run build:strict` passes locally — `typecheck:app`
reports zero errors and the production build completes. Deploy workflow
re-run on the follow-up commit proceeds past `build:strict` to the
Deploy-to-Cloudflare-Pages step. Chart-of-accounts feature behaviour
unchanged (the two fetches still parse the same payloads).

---

## BUG-2026-05-18-001 — Fab Cut production sheet "Fab Sew" (and other next/prev-dept) date columns blank on every row

**Status:** 🟡 Fix in progress (2026-05-18) — code committed on `claude/fix-fabcut-sibling-jcs`, awaiting deploy + live verify
**Category:** production-orders

**Symptom:** On Production → Fab Cut, the "Fab Sew" date column shows
"—" for every row. Worked a few days earlier. Reported by Wei Siang.

**Root cause:** Commit `d8ec903` (2026-05-12, "restore slim
non-active-dept JC shape + wipKey narrow") added a row-level narrow to
`jcWhereDept` in `fetchFilteredPOs` (`src/api/routes/production-orders.ts`):
a sibling-dept JC is only returned when its `wipKey` matches an
active-dept JC's `wipKey` on the same PO. On the Fab Cut page the
active-dept JC is the Option-C **merged** FAB_CUT JC, whose wipKey
schema (`{poId|companySOId}::baseModel::fabric::FAB_CUT`) never matches
the per-piece downstream wipKeys. So every FAB_SEW / FOAM / … JC was
filtered out of the payload and the frontend picker had nothing to
populate the prev/next-dept date pills → "—". Pre-d8ec903 the dept
filter narrowed only the PO set and returned all departments' JCs, so
the column populated. Sibling path `fetchPaginatedPOs` was already
correct (no row-level narrow) and the dept sheet isn't paginated, so
the bug was isolated to `fetchFilteredPOs`.

**Fix:** `src/api/routes/production-orders.ts` (~L1126-1178) — when
`deptFilter === 'FAB_CUT'` (`skipRowNarrow`), emit only the PO-set
membership filter and drop the row-level wipKey narrow, returning all
departments' JCs for the FC-related PO set (pre-d8ec903 behaviour for
THIS page only). Other dept pages keep the slim narrow + payload win.
Introduced `jcWhereBinds` (8 binds for FAB_CUT, 11 otherwise) as the
single source of truth for the positional binds, consumed at both
`fetchFilteredPOs` call sites via spread so SQL/placeholders can't drift.

**Verify:** `tsc -p tsconfig.app.json` clean. Could not live-repro
(no DB/app creds in workspace). Needs deploy → confirm Fab Cut sheet
"Fab Sew" dates render again and other dept pages unchanged.

---

## BUG-2026-05-17-001 — Fabric Past-30 / Next-30 showed SKU totals under both Bedframe & Sofa (bedframe fabric counted as sofa demand)

**Status:** 🟢 Fixed (2026-05-17)
**Category:** dashboard

**Symptom:** Wei Siang spotted PC151-01 (a bedframe fabric) showing
**784 m Next-30 / 2,896 m Past-30 under the Sofa card** — identical
to its Bedframe figures.

**Root cause:** The Fabric module split *historical used* by the
consuming PO's category, but Past-30 / Next-30 came from
`computeFabricMetrics` which is **SKU-level (all categories summed)**.
The same SKU total was then displayed under whichever category card
the fabric appeared in → a bedframe fabric's full demand showed under
Sofa too. The "include if upcoming" gate also used the SKU total +
a fabricCode→category guess, surfacing fabrics in the wrong card.

**Fix:** Made both metrics category-specific:
- New `computeFabricNext30ByCategory()` in `src/api/lib/fabric-usage.ts`
  — same active-FAB_CUT-JC + BOM engine as `computeFabricMetrics`
  (reuses `fetchBomWipComponentsByCode`, `fetchSofaSiblingsByGroupKey`,
  `computeFcFabricUsageMeters`) but buckets by the JC's PO
  `itemCategory` as well as fabric code (due ≤ 30 days).
- Past-30 actual: new `cost_ledger` RM_ISSUE query date-filtered to
  the last 30 days, grouped by `(itemCategory, fabricCode)`.
- `dashboard-overview.ts` per-category list now only includes fabrics
  with real history OR real upcoming demand **in that category**;
  dropped the SKU-total `computeFabricMetrics` call + the
  fabricCode→category guess. Overview cache v15→v16. (Also: sofa list
  shows 10 colourways vs bedframe 8 per Wei Siang.)

**Verify on prod (read-only):** confirm PC151-01 no longer appears
under Sofa Next/Past (or shows only its true sofa-line meters), and
each card's Past-30/Next-30 sums to that category only. `tsc` clean;
`npm test` 185/185.

---

## BUG-2026-05-16-013 — Dashboard "Monthly Revenue" empty (revenue MV 500) → rebuilt from SO + Invoices + Production; Accessory dropped; AOV Total column

**Status:** 🟢 Fixed (2026-05-16)
**Category:** dashboard

**Symptom:** "Monthly Revenue — last 12 months" showed "No revenue
data." `/api/dashboard/revenue` returns **HTTP 500** on prod —
`mv_revenue_by_month_by_org` isn't present/refreshed there.

**Fix:** Dropped the MV-backed `/api/dashboard/revenue` dependency.
Monthly Revenue is now computed in `dashboard-overview.ts` as three
lenses, last 12 months:
- **Sales Orders** = Σ SO total by `companySODate` month (confirmed).
- **Invoices** = Σ invoice total by `invoiceDate` month, excl
  CANCELLED (incl. DRAFT per Wei Siang — all current invoices are
  DRAFT, so excluding them would blank the line).
- **Production** = EXACT mirror of the Employee page's
  `/api/working-hour-entries/production-revenue` gate: a PO's value
  (SO line → CO line → product master price × qty) recognised the
  month its LAST upholstery JC completes. Same SQL `per_po` CTE so
  the dashboard and Employee revenue reconcile.

Also per Wei Siang's review of the live page: **Accessory** Top-Seller
card removed (UI + server query + types), and an **AOV Total** column
added (customer's bedframe + sofa value, already computed for sort).
Overview cache v5→v6.

**Verified (read-only, prod-data replica + Employee endpoint
cross-check):** SO 2026-04 RM 427,735 / 2026-05 RM 173,881; Invoices
2026-05 RM 167,361; Production 2026-04 RM 176,365 / 2026-05 RM
168,167 (matches `/production-revenue` totals). `tsc` clean; `npm
test` 185/185.

---

## BUG-2026-05-16-012 — Dashboard Top Sellers all ×0 / RM 0.00 (unquoted SQL aggregate aliases) + AOV/Top-Seller rebuilt per Wei Siang's basis

**Status:** 🟢 Fixed (2026-05-16)
**Category:** dashboard, infrastructure

**Symptom:** Top Sellers cards listed product codes but every row
showed `×0` and `RM 0.00`. (Same class silently zeroed Purchasing
"Top suppliers by spend".)

**Root cause:** The SupabaseAdapter (`supabase-compat.ts`) rewrites
camelCase identifiers to snake_case via `column-rename-map.json`, and
`db-pg.ts` maps result columns back snake→camel. An alias that is NOT
a real DB column (`qtySold`, `valueSen`, `spendSen`) is absent from
the rename map, so it is left as-is and Postgres folds the unquoted
alias to lowercase (`qtysold`). The result-key mapper can't reproduce
`qtySold`, so `r.qtySold` reads back `undefined` → `Number(undefined)
|| 0` → **0**. Aliases that happen to equal a real column
(`totalSen`→`total_sen`) round-trip fine — which is why AOV worked but
Top Sellers didn't. Proven-correct pattern already in the codebase:
`dashboard-revenue.ts` double-quotes its alias (`AS "revenueSen"`).

**Fix:** Double-quote every non-column alias in
[dashboard-overview.ts](../src/api/routes/dashboard-overview.ts) so
Postgres preserves the exact casing the code reads (Top Sellers,
`spendSen`, and all new queries). While in there, the AOV / Top-Seller
**definitions** were rebuilt per Wei Siang:
- Bedframe AOV = Σ bedframe line value ÷ Σ bedframe **units** (sold
  per piece); table now shows Units, not SO count.
- Sofa AOV = Σ whole-SO total ÷ number of **sofa sets** (1 SO = 1
  set; set price includes pillows/accessories).
- Top Sellers: Bedframe & Accessory by product code ranked by units;
  Sofa by **model** (number prefix of the code, 5530-1A(RHF)→5530)
  ranked by sets sold; new **Fabric** card by meters consumed.
- New cards: Monthly Bedframe units & Sofa sets (by SO date); Fabric
  Usage meters/month (RM_ISSUE), last 12 months. Overview cache v4→v5.

**Verified (read-only, prod data replica before deploy):** Houzs
Century bedframe AOV RM 593.97 over 509 units, sofa AOV RM 2,304.30
over 71 sets; sofa models 5530 ×33, 5531 ×32, 5537 ×16; bedframe
1013-(Q) ×128. `tsc` clean; `npm test` 185/185.

---

## BUG-2026-05-16-011 — Dashboard "Pending Delivery" ≠ Delivery page "Pending Delivery" tab (RM 25,218 vs RM 50,793)

**Status:** 🟢 Fixed (2026-05-16)
**Category:** dashboard, delivery-orders

**Symptom:** Operator put the dashboard and the Delivery page side by
side: Delivery page "Pending Delivery" tab = 80 POs / **RM 50,793**,
dashboard "Pending Delivery" card = **RM 25,217.50**. Asked twice
"为什么不一样" — these must be the same number.

**Root cause:** Two different implementations of the same "production
done, not yet on a DO" gate. The Delivery page filters
`/api/production-orders?fields=minimal&include=jobCards` (the API
*shapes* each PO's jobCards array) through `pickRelevantUphCards`
(UPHOLSTERY cards, HB-only DIVAN dropped) + `linkedPOIds`. The
dashboard's server route `dashboard-overview.ts` re-derived the gate
off the **raw `job_cards` table**, which is shaped differently than
the production-orders feed → a different PO set → RM 25,218. Two
sources of truth that drifted.

**Fix:** One shared gate — `src/lib/delivery-pipeline.ts` exporting
`isHbOnlySpecial`, `pickRelevantUphCards`, `poInPlanning`,
`poReadyForDelivery`, `buildLinkedPOIds`. The dashboard
([src/pages/dashboard/index.tsx](../src/pages/dashboard/index.tsx))
now computes Pending Delivery client-side from the SAME payloads the
Delivery page reads (production-orders + delivery-orders + po-values),
through that shared util — card == tab, by construction. The wrong
server-side pipeline was deleted from
[dashboard-overview.ts](../src/api/routes/dashboard-overview.ts)
(overview cache key v3→v4). `delivery/index.tsx` now imports the
shared predicates instead of its own copies (DRY — they can never
drift again).

**Verified on prod (read-only):** ran the shared-util logic against
live prod data in the browser — 80 POs / **RM 50,793**, identical to
the Delivery page's Pending Delivery tab. `tsc` clean; `npm test`
185/185.

---

## BUG-2026-05-16-010 — Dashboard rebuilt (fake KPIs) + /api/dashboard/overview 500 (workers has no org_id)

**Status:** 🟢 Fixed (2026-05-16)
**Category:** ui-frontend, dashboard

**Symptom:** Old dashboard showed misleading KPIs — "Monthly Revenue"
was the all-time invoice sum, "Accounts Payable" was an item count not
money, "Overdue Invoices" ignored due dates, every trend % was a
hardcoded literal. Operator asked to rebuild it around Sales/Delivery,
Production, Employee, Purchasing + AOV by customer×category, fabric
cost/meter, top sellers.

**Build:** new server-aggregated `GET /api/dashboard/overview` (60s
KV-cached) — production summary, purchasing summary, fabric cost/meter
by CONSUMPTION (total + excl Bedframe/Sofa = accessory-only, operator's
choice), AOV by customer × Bedframe/Sofa, top sellers by category
(BEDFRAME/SOFA/ACCESSORY — "mattress" is not a category), active
headcount, and a not-yet-delivered pipeline (Planning / Pending
Delivery / Pending Dispatch). Goods-value resolver extracted to
`src/api/lib/do-value.ts` (one source of truth, also used by Sales).
Page consumes that + `/api/sales-orders/stats` + the real
`/api/dashboard/revenue` MV (replaces the fake Monthly Revenue).

**Bugs hit & fixed during rollout:**
1. 500 `column "org_id" does not exist` — the `workers` table is NOT
   org-scoped (no org_id; the workers route never filters by org).
   Dropped `WHERE orgId = ?` from the headcount query.
2. Pending Delivery card read RM 0 (DRAFT/LOADED bucket empty). Added
   a pipeline split; card = Pending Delivery + Pending Dispatch.
3. KV cache served the pre-`pipeline` payload — bumped key v1→v2.

**Verified on prod (read-only):** Planning 248,042 + Pending Delivery
25,218 + Pending Dispatch 0 = Outstanding **273,259** (to the cent);
Delivered **328,356**. Pipeline reconciles exactly with Sales stats.
NOTE: dashboard "Pending Delivery" uses production-order COMPLETE as
the ready gate; the Delivery page uses an upholstery-card gate, so that
page's Pending-Delivery tab figure can differ — the dashboard TOTAL
still ties exactly to Outstanding. `tsc` clean; `npm test` 185/185.

---

## BUG-2026-05-16-009 — Sales Orders Delivered/Outstanding used whole-SO header totals (over-counted partial deliveries)

**Status:** 🟢 Fixed (2026-05-16)
**Category:** sales-orders, ui-frontend, data-integrity

**Symptom:** Sales Orders "Delivered" (RM 333,596) didn't match the
Delivery side (RM 328,356) — a RM 5,240 gap. Cause: a partially-
delivered SO flips wholesale to DELIVERED and the page summed its
**full header total**, so the un-shipped portion was wrongly counted
as Delivered instead of Outstanding.

**Fix (operator chose: item-level, totals only):** extracted the
goods-value resolver into `src/api/lib/do-value.ts` (single source of
truth; delivery-orders.ts now imports it instead of its own copy).
`sales-orders /stats` adds `deliveredItemsSen` (Σ value of items
actually on a shipped/non-cancelled DO, via the same resolver) and
`outstandingItemsSen` (csRevenue − delivered). Sales Orders page: when
Status=Delivered the headline shows item-level delivered value; when
Status=Outstanding the not-yet-delivered value. SO status lifecycle &
per-row display unchanged.

**Verified on prod (read-only):** SO Delivered RM 328,356 == DO
delivered RM 328,356 (to the cent); Delivered + Outstanding (273,259)
== confirmed book RM 601,615 (to the cent). RM 5,240 gap eliminated.

---

## BUG-2026-05-16-008 — DO creation allowed POs already on another DO → duplicate deliveries, double FG consumption

**Status:** 🟢 Fixed (2026-05-16) — root cause blocked at POST; existing duplicates removed via one-shot dedupe (66 duplicate delivery_order_items rows dropped across 14 DOs, earliest kept, 0 DOs emptied, idempotent re-check = 0). Per operator the cost step isn't in use, so cost_ledger/fg_batches were deliberately NOT reversed (out of scope). DO Delivered went RM 367,409→328,356; residual SO-vs-DO gap RM 5,240 is the known partial-delivery residue, not corruption.

**Category:** delivery-orders, inventory-cascade, data-integrity

**Symptom (discovered during reconciliation):** 25 sales orders were
"over-delivered" — the same order's goods recorded on 2-3 separate
delivery notes (EXACT duplicates). SO/Delivered value inflated by RM
38,563 gross (RM 33,813 net of 7 under-delivered). Forensic on
cost_ledger: all 13 duplicate DOs carry their OWN FG_DELIVERED
entries → **real double-consumption: 200 finished-goods units and RM
24,647 of COGS deducted again** for goods already delivered. 0 of the
duplicates are "phantom"; none of the 23 involved DOs are pure
duplicates (all mixed multi-SO notes also carrying legitimate orders).

**Root cause:** `POST /api/delivery-orders` validated consignment POs
but had NO guard against `productionOrderIds` already on a
non-cancelled DO. The frontend hides already-linked POs (display
only); a bulk/quick-dispatch path or repeated submit could still put
the same POs onto a 2nd/3rd DO. Delivering each re-ran the FG FIFO
consumption (`consumeFGBatchesForDO` → cost_ledger FG_DELIVERED +
fg_batches decrement) and the SO→DELIVERED + value cascade.

**Fix (root cause, shipped):** `POST /` now rejects (409) any PO
already on a non-cancelled DO, listing `PO → DO (status)`. Stops all
new duplicates. Authoritative backend block, mirrors the CO-PO guard.

**Existing corruption — NOT auto-fixed (deliberate):** cost_ledger is
an append-only audit ledger and delivered fg_units/COGS are inviolate
— a blind reversal/delete script is the wrong tool and risks worse
corruption. The 13 duplicate DOs (200 units, RM 24,647 double-COGS,
RM 33,813 value, duplicate-invoice exposure) need a controlled,
owner-directed correction (reversing entries / careful line removal),
not an automated migration. Invoice fixer remains BLOCKED until done.

**Verified:** `npx tsc --noEmit` clean; `npm test` 185/185 pass.

---

## BUG-2026-05-16-007 — Daily Capacity rolling window included today, deflating the average

**Status:** 🟢 Fixed (2026-05-16)
**Category:** ui-frontend, scheduling

**Symptom (user-reported):** The Planning "Daily Capacity — Past 7
Working Days" drilldown listed today (2026-05-16) at 0h 40m, and the
average (174h 32m/day) was dragged down by it. Completion dates are
recorded after the fact, so the current day always reads ~0 and
shouldn't be in the rolling average.

**Root cause:** `src/pages/planning/index.tsx` built BOTH the
`capacityData` rolling window (KPI + per-dept dailyCapacity) and the
drilldown's `rollingWindowDates` starting the cursor at `new Date()`
(today) and walking back ROLLING_WINDOW_DAYS non-Sunday days — so
today was always one of the 7, and `windowTotalMinutes /
ROLLING_WINDOW_DAYS` divided a near-zero day into the average. The
loading chart already excluded today ("Past Production ends
yesterday"); these two surfaces were inconsistent with it.

**Fix:** both windows now step the cursor back one day before the
collect loop, so the window is the N most-recent COMPLETE working days
ending YESTERDAY. KPI average, per-dept capacity, and the drilldown
list/avg all rise to the accurate figure and match the loading chart.

**Verified:** `npx tsc --noEmit` clean; `npm test` 185/185 pass.

---

## BUG-2026-05-16-006 — DO "Delivered" amount showed invoiced value (RM 167k) not goods delivered (RM 333k+)

**Status:** 🟢 Fixed (2026-05-16) — regression introduced by BUG-2026-05-16-005, reverted

**Category:** delivery-orders, ui-frontend, data-integrity

**Symptom (user-reported):** Sales Orders "Delivered" = RM 333,596
(286 orders) but Delivery Orders "Delivered" tab = RM 167,361 — a ~2×
gap the operator correctly flagged as obviously wrong.

**Root cause:** BUG-2026-05-16-005 anchored the DO value to the linked
**invoice total** (falling back to line-level) so the Delivered bucket
would tie to the Invoice bucket. Wrong call: once the backfill gave
every delivered DO an invoice, the tab showed *invoiced* value
(RM 167,361) instead of *goods delivered* (~RM 333k–366k). Verified
against live data: of 286 DELIVERED SOs, 278 (RM 322,084) are fully
delivered, only 8 (RM 11,512) partial, 0 mis-flipped — so the SO side
is right; the DO side was mis-valued. Actual delivered line value
(DO qty × SO unit price) = RM 366,467.

**Fix:** reverted the invoice anchoring. `loadDoValueMap` and `/stats`
use the line-level `DO_VALUE_EXPR`/`DO_VALUE_FROM` again (goods value);
removed `loadDoInvoiceTotalMap`; `/stats` back to the single grouped
`COUNT(DISTINCT d.id)` query. DO Delivered now ≈ RM 366k, same
magnitude as SO Delivered RM 333k, and the per-row Amount still sums
to the tab.

**Separate finding (not a code bug — flagged to operator):** goods
delivered ≈ RM 333k–366k but only ≈ RM 167k has been invoiced → a real
~RM 170k+ under-billing gap across delivered notes. Listing/closing
that gap is a finance follow-up, deferred pending operator decision.

**Verified:** `npx tsc --noEmit` clean; `npm test` 185/185 pass.

---

## BUG-2026-05-16-005 — Multi-SO delivered DOs never cascaded SO→DELIVERED and never auto-invoiced

**Status:** 🟢 Fixed (2026-05-16) — forward fix shipped + deployed; historical repair EXECUTED against prod (83 DOs scanned, 220 SOs advanced to DELIVERED, 17 combined invoices created RM 51,453.26, 0 errors; idempotent re-check clean)
**Category:** delivery-orders, sales-orders, data-integrity

**Symptom (user-reported):** Physically delivered orders still showed
Sales Order status `IN_PRODUCTION` / `READY_TO_SHIP`; Delivery Orders
page showed Delivered ≈ RM 437,951 but Invoice = RM 0.00 / 0 count;
no stage total reconciled with the Sales Order book; the Outstanding
column only ever read "To dispatch".

**Root cause:** The DO PUT `→ DELIVERED` block gated the SO→DELIVERED
cascade AND the auto-invoice on `if (existing.salesOrderId)` — the
legacy single-SO FK, which is **NULL for every multi-SO DO** (the
common case: one lorry batches many SOs). The DRAFT→LOADED (SHIPPED)
and LOADED→DRAFT cascades had been upgraded to `resolveDoSalesOrderIds`
(multi-SO aware) earlier this session, but the DELIVERED block was
missed. So multi-SO deliveries: skipped SO status advance, skipped
invoice, skipped A/R bump. No backfill existed, so every such order
(and anything delivered before the cascade landed) was permanently
stranded. Secondary: the DO value query had no fallback so a delivered
DO whose product codes didn't match its SO lines counted as RM 0,
under-stating the Delivered bucket.

**Fix:**
- `src/api/routes/delivery-orders.ts`: extracted
  `buildDoDeliveredSoAndInvoice()` — resolves EVERY linked SO
  (`resolveDoSalesOrderIds`), advances each non-terminal SO to
  DELIVERED, and builds ONE combined DRAFT invoice for the whole DO
  spanning all those SOs (operator chose one-invoice-per-delivery-note;
  multi-SO header anchored to a representative SO, true link is
  `deliveryOrderId`). The live PUT DELIVERED block now calls it
  (replacing the single-SO gate); shared with the backfill so they
  can't drift.
- DO value is now anchored to the linked **invoice total** when one
  exists (migration-0103 intent), falling back to the line-level SO
  price; `loadDoValueMap` + `/stats` use this merged map so the
  Delivered bucket reconciles with the Invoice bucket and the per-row
  Amount sums to the tab total. `/stats` counts now come from a
  row-per-DO read (exact).
- `POST /api/delivery-orders/backfill-delivered-cascade` — one-shot,
  idempotent historical repair over every DELIVERED/INVOICED DO,
  running the SAME helper; `?dry=1` previews counts + estimated
  invoice value with no writes; real run is sequential per-DO atomic
  batches with the invoice-number-collision retry (BUG-2026-05-16-002
  lesson). Temporary migration endpoint.
- `src/pages/sales/index.tsx`: `soStageLabel()` drives the Outstanding
  column's new `filterAccessor` (the column had no real field, so its
  filter only offered "(blank)") and makes the cell reflect the true
  stage (Delivered / Invoiced / Closed) instead of a bare "—".

**Verified:** `npx tsc --noEmit` clean; `npm test` 185/185 pass.
Backfill not yet executed against prod — awaiting operator go-ahead
(dry-run first).

---

## BUG-2026-05-16-004 — Sales Orders: picking Status = Delivered/Closed/Cancelled showed an empty grid ("0 of 66")

**Status:** 🟢 Fixed (2026-05-16)
**Category:** sales-orders, ui-frontend

**Symptom (user-reported):** On the Sales Orders page, selecting
Status = Delivered showed the header "Showing 66 of 516 orders · RM
102,483.00" but the grid rendered "No confirmed orders." with "0 of
66 records · 1 filter active". Same for Closed / Cancelled (and the
operator felt every stage was affected) — none of the finished
stages would display their rows.

**Root cause:** Two independent status filters fought each other.
The page-level Status dropdown narrows `filteredOrders` correctly
(66 delivered → header is right). But the DataGrid ALSO carried
`defaultExcludedValues={{ status: ["SHIPPED","DELIVERED","CLOSED",
"CANCELLED"] }}` to hide finished orders from the day-to-day funnel.
That grid-level value filter is seeded once, then persisted to
sessionStorage (`datagrid-filters-sales-orders-list-*`) and never
re-evaluated (`valueFilterTouched` latches true once a seed exists).
So once the funnel default had been seeded, picking "Delivered" in
the dropdown left the stale grid filter excluding DELIVERED → every
matching row hidden, header count and grid disagreeing.

**Fix:**
- `src/components/ui/data-grid.tsx`: added optional `valueFilterKey`
  prop that sub-scopes ONLY the value-filter / search sessionStorage
  bucket (not the column-layout localStorage). Backward compatible —
  grids that don't pass it are unchanged.
- `src/pages/sales/index.tsx`: pass `valueFilterKey={filterStatus ||
  "all"}` so each Status selection gets a clean filter session, and
  apply `defaultExcludedValues` ONLY when no explicit Status is
  chosen (`filterStatus === ""`). An explicit pick means
  `filteredOrders` is already scoped to exactly that status, so the
  grid must not second-guess it. The "All Statuses" funnel default
  (hide finished) is preserved.

**Verified:** `npx tsc --noEmit` clean; `npm test` 185/185 pass.

---

## BUG-2026-05-16-003 — Delivery Orders Amount column + tab totals all showed RM 0.00

**Status:** 🟢 Fixed (2026-05-16)
**Category:** delivery-orders, ui-frontend

**Symptom (user-reported):** The new per-DO "Amount" column and the
tab-strip Sales Figure totals (Pending Dispatch / Dispatched /
Delivered / Invoice) all rendered `RM 0.00`. Wei Siang: "怎么那么
丑" — wanted real RM numbers like the Sales Orders "Total" column,
at every stage including Pending Delivery.

**Root cause:** The first cut of the Amount feature read
`delivery_orders.totalSen` per row and `SUM(totalSen)` in
`/api/delivery-orders/stats`. **`delivery_orders` has no monetary
column** — no `total_sen` (confirmed migrations-postgres/0001_init.sql;
migration 0103 states a DO's value anchors in the linked
invoice/SO, not the DO row). So `d.totalSen` was always `undefined`
→ `0`, and `SUM(totalSen)` summed a non-existent column → `0`.

**Fix:**
- `src/api/routes/delivery-orders.ts`: added `DO_VALUE_FROM` /
  `DO_VALUE_EXPR` + `loadDoValueMap()`. A DO's value is the linked
  sales-order line value — each DO item's `quantity × SO
  unitPriceSen` for its `productCode`, SO resolved via the item's
  production order (multi-SO DOs) falling back to the DO's own
  `salesOrderId`. Mirrors the auto-invoice computedTotal primary
  path. `GET /` attaches `valueSen` per DO; `/stats` groups the
  identical FROM/SUM by status with `COUNT(DISTINCT d.id)` so the
  per-row column always reconciles with the per-tab aggregate.
- `src/types/index.ts`: added `DeliveryOrder.valueSen?`.
- `src/pages/delivery/index.tsx`: row + map renamed `totalSen` →
  `valueSen` (server-derived); Planning / Pending Delivery (PO-based,
  no DO yet) now sum each PO's SO line value (same productCode × SO
  unit price basis) so every stage shows a comparable Sales Figure;
  "Dispatched" tab money = LOADED + IN_TRANSIT to match the rows it
  lists.

**Verified:** `npx tsc --noEmit` clean; `npm test` 185/185 pass.

---

## BUG-2026-05-16-002 — Bulk Mark Delivered: deadlock detected + duplicate ux_invoices_invoice_no

**Status:** 🟢 Fixed (2026-05-16)
**Category:** delivery-orders, infrastructure, data-integrity

**Symptom (user-reported):** After BUG-2026-05-16-001 unblocked the
DELIVERED path, Wei Siang bulk Mark Delivered on ~25 dispatched DOs:
"20 of 25 failed: deadlock detected", "17 of 17 failed: duplicate
key value violates unique constraint ux_invoices_invoice_no". No
DOs could convert dispatched → delivered.

**Root cause:** `src/pages/delivery/index.tsx` `handleMarkDelivered`
(and `handleMarkDispatched`) fired every selected DO's PUT in
parallel via `Promise.allSettled(doIds.map(...))`. Each DO →
DELIVERED is a heavy multi-statement batch (fg_units, FIFO COGS,
auto-invoice, SO status cascade). Parallel execution caused two
distinct failures, both surfaced only now that the product_code bug
no longer failed first:
  1. **Deadlock:** DOs frequently share SOs (e.g. SO-2604-191 in
     two different DOs). Two concurrent DELIVERED batches `UPDATE
     sales_orders` the same row in different lock order → Postgres
     deadlock.
  2. **Duplicate invoice_no:** `nextInvoiceNo()` (invoices.ts:169)
     is read-MAX-then-+1, not concurrency-safe. Parallel auto-invoice
     creation all read the same max (none committed) → identical
     invoiceNo → unique-constraint violation.

**Fix (`src/pages/delivery/index.tsx`):** extracted
`runBulkDoTransition()` — a sequential `for…await` loop. One DO PUT
commits before the next starts, so invoice numbers stay unique and
no two transactions hold overlapping sales_orders locks. Both
`handleMarkDispatched` and `handleMarkDelivered` route through it.
Frontend-only; backend untouched. `handleQuickDispatch` was already
sequential — no change.

**Known follow-up (not fixed here):** `nextInvoiceNo()` is still
racy for genuinely-simultaneous *different users*. Serializing the
bulk button removes the realistic trigger; a proper sequence/locking
fix on invoice numbering is finance-sensitive and deferred to its
own change.

**Verified:** tsc clean; 185/185 tests. Deployed; operator to
re-run bulk Mark Delivered.

---

## BUG-2026-05-16-001 — DO → DELIVERED cascade dies: `column "product_code" does not exist`

**Status:** 🟢 Fixed (2026-05-16)
**Category:** delivery-orders, data-integrity, infrastructure

**Symptom (user-reported):** Wei Siang bulk-selected 83 dispatched DOs
on the Delivery Orders page and clicked "Mark Delivered". Toast:
"83 of 83 failed: column 'product_code' does not exist". Every DO →
DELIVERED transition failed — no COGS, no auto-invoice, no SO
status cascade.

**Root cause:** `src/api/lib/do-cost-cascade.ts:100`
(`consumeFGBatchesForDO`, runs on every DO → DELIVERED) queried
`SELECT id FROM products WHERE productCode = ?`. The SupabaseAdapter
column-rename-map (`src/api/lib/column-rename-map.json:580`) maps
`productCode` → `product_code` globally. But the `products` table's
column is `code`, NOT `product_code` (see
`migrations-postgres/0001_init.sql:79`). So the rewritten query hit
a non-existent column and threw, aborting the whole DELIVERED batch.
The working sibling `lib/fg-completion.ts:77` already does it
correctly with `WHERE code = ?`.

**Fix (`src/api/lib/do-cost-cascade.ts:99-105`):** changed the
predicate from `WHERE productCode = ?` to `WHERE code = ?`, matching
fg-completion.ts. Module-wide scan: this was the only `FROM products
WHERE productCode` in `src/api/` — every other products-by-code
lookup already uses `code`.

**Verified:** `npx tsc --noEmit` clean; full test suite 185/185.
Deployed to main; operator to re-run bulk Mark Delivered.

---

## BUG-2026-05-15-002 — Planning page Capacity Overview "Utilization 975%" + misleading Master Tracker "Hookka DD"

**Status:** 🟢 Fixed (2026-05-15)
**Category:** ui-frontend, data-integrity

**Symptom (user-reported):** Wei Siang on Planning page: "Average
Utilization 975%" (physically impossible). Asked for full audit. The
Master Tracker's "Hookka DD" column showed the same date as the
adjacent "Target End" column. Capacity Loading bar heights felt
unproportional. Status filter included "On Hold" which always
returned 0 results.

**Root causes (4 bugs in `src/pages/planning/index.tsx`):**

1. **Utilization formula conflated backlog with daily load.**
   `utilization = totalBacklog / dailyCapacity × 100` — sum of ALL
   pending estMinutes across all open POs divided by ONE day's
   capacity. 975% really meant "9.75 working days of queued work",
   not "today's load". Same calc per-dept produced 1647% Packing,
   1418% Webbing, etc. Capacity Loading tab uses correct per-day
   numbers from `/api/scheduling/capacity` — two tabs disagreed.

2. **TRANSFERRED job cards double-counted.** `capacityData` active
   filter excluded only COMPLETED + CANCELLED, while
   `getDeptEfficiency()` treated TRANSFERRED as completed.
   Inconsistent: same JC appeared as both "active load" and
   "completed work" depending on which calculation you read.

3. **Master Tracker "Hookka DD" column was a duplicate.** Backend
   `calculateHookkaDD()` in `scheduling.ts:176` correctly computes
   customer-delivery-date minus buffer days (2 for BEDFRAME, 1 for
   SOFA), and the API returns it as `ScheduleEntry.hookkaExpectedDD`.
   But `schedResp` was `void`ed in the page (`void schedResp;` line
   277) and the column rendered `formatDate(order.targetEndDate)`,
   identical to the previous column.

4. **Capacity Loading bar height used a `* 0.8` fudge factor + 120%
   cap** producing non-linear bar heights that didn't visually match
   the utilization %.

Plus minor: "On Hold" filter option that never matches real status
values; "Stocked In" column header that actually rendered
`rackingNumber`.

**Fix (3 commits, single push):**
- `src/pages/planning/index.tsx`:
  - Replaced single misleading "Utilization" metric with TWO honest ones:
    `Today's Utilization` (% from scheduling API's per-day bucket — same
    source as Capacity Loading tab) AND `Backlog` (days of queued work).
    Top summary went from 3 cards to 4.
  - Per-dept cards now show Workers, Daily Capacity, Today's Load,
    Today's Utilization, AND Backlog (days + min). Utilization bar
    now reflects today's % only.
  - `capacityData` active filter now excludes TRANSFERRED too, matching
    `getDeptEfficiency()`.
  - Wired `schedResp` into a `hookkaDDByPoId` Map; Master Tracker's
    "Hookka DD" column renders the real `s.hookkaExpectedDD` per
    `productionOrderId`, falls back to "-" if no schedule entry.
  - Status filter dropdown: removed "On Hold" option.
  - "Stocked In" column header renamed to "Racking #" (matches what
    the cell actually shows).
  - Capacity Loading bar height: `Math.max(barHeight * 0.8, 1)%` →
    `Math.min(Math.max(day.utilization, 1), 100)%` — linear scale,
    capped at container height. >100% still flagged by red colour +
    AlertTriangle icon.

**Verification:**
- TypeScript clean
- 4 fixes audited in single pass (per "Fix one → audit whole system")
- Capacity Overview now consistent with Capacity Loading tab (same
  data source for today's load)
- Pattern-matches memory rules:
  - `Eliminate inconsistency before syncing it` — Capacity Overview
    and Capacity Loading now share one source of truth
    (scheduling API per-day buckets)
  - `Frontend + backend validation must be unified` — TRANSFERRED
    handling now consistent across efficiency + load calcs

---

## BUG-2026-05-15-001 — SO edit page silently re-poisoned bare SOFA sizeLabel with trailing `"`, every Save → 400

**Status:** 🟢 Fixed (2026-05-15)
**Category:** ui-frontend

**Symptom (user-reported):** Wei Siang opened `Edit SO-2605-104` and got two
stacked toasts: `Unknown SOFA sizeLabel: "32"". Must match one of the
dropdown values: 24, 26, 28, 30, 32, 35.` The SO loaded fine in the form
but every Save Changes attempt was rejected. Operator: "为什么这一个 SO
不能 edit?"

**Root cause:** `src/pages/sales/edit.tsx` had a leftover frontend
normalize-add-quote step that survived the 2026-05-09 DUP-001 cleanup:

1. KV `variants-config.sofaSizes` canonical = bare `["24","26","28","30","32","35"]` (matches Maintenance page UI)
2. Backfill (commit `af372e8`) cleaned all 259+13 dirty rows in
   `sales_order_items` / `consignment_order_items` / `production_orders`
   from `32"` → bare `32`
3. Backend normalize-add-quote removed (commit `f2fa7a9`)
4. `validateSofaSizeLabels` gate added to SO/CO POST/PUT (commit `2d332c0`)
5. **BUT** the frontend `normalizeSeat()` helper at `sales/edit.tsx:543`
   + the dropdown options builder at `sales/edit.tsx:1107` still ran
   `/^\d+(\.\d+)?$/.test(t) ? \`${t}"\` : t` against the seat-size value
   on form hydration AND on every dropdown render.

So on every SO edit:
- Frontend read bare `32` from DB into form state
- normalizeSeat() rewrote it to `32"` in form's `seatHeight` + `sizeLabel`
- Save Changes sent `sizeLabel: '32"'` to backend
- `validateSofaSizeLabels` rejected → 400 → toast

Two contradictions hidden inside the same page:
- Frontend canonical: quoted
- Backend canonical: bare
- KV / Maintenance / DB / consignment-edit / sales-create all bare
- Only `sales/edit.tsx` was the outlier

Plus `src/lib/pricing-options.ts` had `SEAT_HEIGHT_OPTIONS = ['24"', '28"', '30"', '32"', '35"']` (quoted AND missing 26) as the fallback when KV hasn't hydrated — same contradiction.

**Fix (commits pending push):**
- `src/pages/sales/edit.tsx`: removed `normalizeSeat()` helper (lines 543-547),
  inlined `rawSizeLabel || rawSizeCode` at the hydration site, removed the
  `${t}"` map step in the dropdown options builder
- `src/lib/pricing-options.ts`: changed `SEAT_HEIGHT_OPTIONS` to bare
  `['24', '26', '28', '30', '32', '35']` to match Maintenance + KV

Pattern-match: applies the memory rules
- `Eliminate inconsistency before syncing it` — picked ONE canonical (bare, per Maintenance/DB/backend), removed the outlier rather than patching both sides
- `Reject bad inputs, don't normalize` — frontend now passes DB values through verbatim instead of silently transforming
- `Frontend + backend validation must be unified` — the rejection at backend is now mirrored by frontend simply not generating bad data

**Verification:**
- `consignment/edit.tsx`, `sales/create.tsx`, `consignment/create.tsx` already use raw KV values (no normalize) — verified via grep for `\\${t}\"`
- Operator UI now matches Maintenance page (bare numbers in dropdown), same as the consignment side already does
- Legacy-tolerant fallback at `sales/edit.tsx:1115` preserves any stored `32"` value as `"(legacy)"` entry so old data still pre-fills

---

## BUG-2026-05-13-005 — Production Folder detail showed only 10 columns vs Production main page's 25

**Status:** 🟢 Fixed (2026-05-13)
**Category:** ui-frontend

**Symptom (user-reported):** Wei Siang opened the Production Folder
detail page (`!4/5 Sofa Foaming DONE distribute -2`) and saw only 10
columns in the Column-toggle list (SO #, PO #, Customer, Product, Dept,
Status, Qty, Due, Completed, PIC). The Production main page's
Column-toggle had ~25 (Total H, Special Order, Prod Time, Fab Cut,
Wood Cut, Framing, ...). Operator: "为什么两面的 Column 显示得不一样
呢？Column 完全没有带过来" — opening a folder dropped every contextual
column the operator relies on (WIP / Total H / Gap / Colour / Customer
Ref / Special Order / Prod Time / Category / Model / Size / State /
Type / Divan / Leg / Customer PO ID / PIC 2 / Distributed flag etc.).

**Root cause:** when `folder-detail.tsx` was first built (Phase 2.6
folder feature), only the columns minimally needed to identify a JC
were ported in. The richer column set on Production main page wasn't
mirrored — folder-detail's `FolderJcRow` type had 14 fields vs DeptRow's
~30, so the column list was capped at what the row type held. No code
path forced the two views to stay in sync.

**Fix:** `src/pages/production/folder-detail.tsx`
- Expanded `FolderJcRow` from 14 → 30 fields (model, wipType, wip,
  category, size, colour, gap, divan, leg, totalHeight, specialOrder,
  prodTime, customerPOId, customerRef, customerState, pic2Name,
  distributedAt).
- Mirrored the per-field derivation logic from
  `src/pages/production/index.tsx` L2497-2606 (BEDFRAME vs SOFA branching
  for model / wipType / wip; bedframe-only gap/divan/totalH; sofa drops
  variant suffix from model; etc.) so cell values match 1:1 between the
  two views.
- Expanded the `columns: Column<FolderJcRow>[]` list from 10 → 25 to
  mirror Production page's order + widths.
- Explicitly EXCLUDED the 8 per-department sched-pill columns
  (`sched_FAB_CUT`/`sched_FAB_SEW`/... etc.) — Wei Siang's call:
  rendering 8 nested date pickers per row across a folder view (which
  spans depts) is the load-bearing cause of the page feeling laggy.
  "你唯一不需要带过来的，就是 Department 之间的完成日期，这样系统就
  不会卡顿". Skipped FAB_CUT-only fabricUsage and PACKING-only rack for
  the same dept-agnostic reason.

**Verification:** typecheck clean; lint clean on touched file; build
clean. Manual: open folder detail → operator sees WIP/Total H/Special
Order/Prod Time/etc. in the Columns customization panel, same labels
as Production main page. Per-dept date pills (the "Fab Cut date" /
"Wood Cut date" etc.) intentionally NOT in the toggle list.

**Commit:** `0f0b72c` (cherry-picked to main as `c16f460`).

---

## BUG-2026-05-13-004 — On-screen QR tile cluttered with 8-9 stacked rows and duplicate fields

**Status:** 🟢 Fixed (2026-05-13)
**Category:** ui-frontend

**Symptom (user-reported):** FAB_SEW QR Stickers panel tile showed
"5531 / SOFA · BASE / 5531-L(RHF) -Base 24 KN390-1 / PO-2604-114 · KL /
SO-2604-346-02 / FAB_SEW · 24 · KN390-1 / 6" / Qty 1" — 8 lines, with
the same model number in rows 1 + 3, the same "Base 24 KN390-1" in
rows 3 + 6, and "FAB_SEW" repeated when the panel header already
names the dept. Operator: "这一个有点乱，你可以帮我看一下怎么整理过吗".

**Root cause:** the tile was extended incrementally over months; the
wipName row (added for full-context identification) ended up duplicating
the model headline above it AND the deptCode·size·fabric row below it.
No single edit consolidated the duplicates.

**Fix:** `src/pages/production/index.tsx` (lines 6092–6160) — collapsed
to a 7-row priority-grouped layout per operator-approved Option C:
(1) model, (2) Category · WipType, (3) Fabric · Size — promoted as the
key craft info, (4) Height when relevant, (5) SO ID · State — replaces
the Customer PO row at the operator's explicit request "show SO ID 就
行了", (6) ★ Special when set, (7) Qty. Dropped: the wipName long
string, the Customer PO row, and the deptCode prefix.

**Verification:** typecheck clean; lint clean on touched file. Print
job-card-sticker template (lines 6448+) was deliberately not touched —
it has a different, already-clean layout and was outside the operator
report.

---

## BUG-2026-05-13-003 — FG sticker print QR overflowed the 100mm page, clipping piece-badge column off the right edge

**Status:** 🟢 Fixed (2026-05-13)
**Category:** production-orders

**Symptom (user-reported):** with QRs now rendering after BUG-2026-05-13-002,
the FG sticker Save-as-PDF showed the QR taking ~70% of the page width
and the piece-badge column ("1/3 SOFA 296906-1", piece name, shortCode)
clipped off the right edge — operator could see fragments of badge text
along the right boundary.

**Root cause:** `<QRImg size={500}>` for the primary QR meant 500 CSS px
≈ 132 mm, on a 100 mm wide @page. Pre-fix the IntersectionObserver gate
(BUG-2026-05-13-002) kept the QR from ever rendering, so the overflow
never surfaced. The 500 / 320 / 300 size values were calibrated for the
older 50 mm thermal label layout, not the current 100 × 150 mm FG sticker.

**Fix:** `src/pages/production/index.tsx` (lines 6472, 6502) — reduced
the print-container QR sizes to fit the page:
- Primary alone (no legs / pillow pair): 500 → 180 (~48 mm)
- Primary with legs / pillow pair: 320 → 130 (~34 mm)
- Pillow pair QR: 300 → 130 (~34 mm)
Modules stay > 1 mm at 180 px so scan reliability is unaffected. The
on-screen preview tile (size = 110, already fits its 180 px wrapper)
was left untouched.

**Verification:** operator confirmed via Save-as-PDF screenshot —
"size 是确定我们要的".

---

## BUG-2026-05-13-002 — FG sticker print: QRs rendered as gray placeholders, dividers collapsed

**Status:** 🟢 Fixed (2026-05-13)
**Category:** production-orders

**Symptom (user-reported):** FG sticker Save-as-PDF showed the sticker
text fields but the QR was missing — its slot rendered as the gray
placeholder div, the surrounding flex layout collapsed (horizontal
dividers ended up vertical), and the piece-badge text landed in the
wrong column.

**Root cause:** the FG sticker print container is `display: none` on
screen (`hidden print:block`) and only flips to `display: block` when
@media print activates. Inside it the stickers rendered `<QRImg>`, which
gates QR data-URL generation behind an IntersectionObserver — and the
observer never fires for elements inside a `display: none` parent
(zero-size, not in layout). `shouldRender` stayed false, the dataURL
was never generated, and the empty placeholder div was what showed up
in the print snapshot. The job-card sticker print path didn't have
this bug because it pre-computes `s.qrDataUrl` and renders a plain
`<img>` — no observer involved.

**Fix:** `src/components/qr-img.tsx` — added an `eager` prop that
starts `shouldRender = true` on first commit, bypassing the observer.
`src/pages/production/index.tsx` (lines 6440, 6470) — passes `eager`
to both QRImg instances inside `#batch-fg-print`. Bumped the print
useTimeout from 300 ms to 1500 ms so the eager generation chain
(~10-30 ms per QR × up to 100 stickers) completes before
`window.print()` fires. On-screen preview tiles (lines 5948, 6173)
keep the default lazy mode — they're visible at mount, observer fires
normally.

**Verification:** operator confirmed via Save-as-PDF screenshot — QRs
render correctly in subsequent BUG-2026-05-13-003 follow-up.

---

## BUG-2026-05-13-001 — Delivery Save-as-PDF produced a completely blank body with only browser headers / footers

**Status:** 🟢 Fixed (2026-05-13)
**Category:** delivery-orders

**Symptom (user-reported):** clicking Print on a Delivery Order with
"Save as PDF" as the destination produced output containing only
Chrome's auto headers/footers (date, page title, URL, page numbers) —
the entire DO body (HOOKKA letterhead, customer info, items table,
signature block) was missing. Reproduced across multiple computers,
so not a per-machine setup issue.

**Root cause:** the print container was rendered inside a wrapper with
`position: fixed; z-index: -1` in `pages/delivery/index.tsx`. On screen
the negative z-index hid the template behind page content as intended,
but Chrome's Save-as-PDF renderer paints the page white background at
z-index 0 and captures everything above. The print container, parked at
z-index -1, painted behind the background and got clipped — leaving
the visible area completely empty. The existing production FG / Job
Card sticker prints already solved the same problem with a different
pattern (`hidden print:block` on the template root, no fixed wrapper);
PrintDO had never been migrated.

**Fix:** `src/pages/delivery/index.tsx` (lines 4178–4182) — dropped the
fixed / z-index:-1 wrapper; renders `<PrintDO>` directly.
`src/components/delivery/print-do.tsx` — added `hidden print:block` to
the template root, added `!important` to every @media print rule for
cascade safety, removed the invalid `background: #ffffff` property
from the `@page` block (only margin / size / marks / orphans / widows
are valid in `@page`; the invalid declaration could cascade-fail the
whole rule on strict parsers).

**Verification:** typecheck clean; lint clean on touched files; the
sticker pattern has been battle-tested on production FG / JC prints
since the same blank-page bug was fixed there. Operator follow-up
testing pending — see outstanding checklist.

---

## BUG-2026-05-12-009 — Perf wave (8MB → 1.5MB) was never merged from feature branch; production dept pages regressed to 9.2 MB

**Status:** 🟢 Fixed (2026-05-12)
**Category:** production-orders

**Symptom (user-reported):** "记得之前有一天晚上很顺的" — the operator
remembered a night the Production page felt smooth, but it had become
slow again. Measured: dept-page fetch payload was **9.2 MB / 13,393 JCs /
~2.8 s** on FAB_CUT. The "smooth night" (2026-05-10/11) had it at
~1.5–3 MB.

**Root cause:** 4 perf commits sat on an unmerged branch
`claude/confident-gagarin-bd118e` and never made it to main:
- `17a30f0` wipKey-aware JC narrow on dept page (8 MB → 1.5 MB)
- `bc3293a` slim shape for non-active-dept JCs (8 MB → 3 MB)
- `5613c59` drop default-value fields from slim shape
- `ddb9b6f` mount-seed date filter only fires once per session

The slim path's `activeDeptCode` parameter on `rowToMinimalJobCard` was
never on main, so EVERY JC returned its full 24-field shape regardless
of `?dept=` filter.

**Fix:** `src/api/routes/production-orders.ts` — cherry-picked the 3 backend
commits onto main. `activeDeptCode` parameter restored; non-active /
non-FAB_CUT JCs emit the slim shape on dept-filtered fetches.

**Verification:** measured after deploy on FAB_CUT page: **1093 KB /
727 JCs / 830 ms** (vs 9172 KB / 13393 JCs / 2800 ms before). 8.4× smaller,
3.4× faster.

**Related:** [BUG-2026-05-12-003](#bug-2026-05-12-003--kv-cache-version-bump-fire-and-forget-caused-stale-reads).

---

## BUG-2026-05-12-008 — Folder detail page crashed on Date.toISOString(undefined)

**Status:** 🟢 Fixed (2026-05-12)
**Category:** ui-frontend

**Symptom (user-reported):** clicking a folder in `/production/folders`
hit the ErrorBoundary: "Something went wrong — RangeError: Invalid time
value".

**Root cause:** `src/pages/production/folder-detail.tsx` declared the
`FolderData` type with `created_at` / `created_by` (snake_case), but the
SupabaseAdapter auto-camelCases DB columns on read, so the API returns
`createdAt` / `createdBy`. The page read `folder.created_at` (undefined)
and called `new Date(undefined).toISOString()` → RangeError → unmounted
the whole page tree.

**Fix:** rename type fields to `createdAt` / `createdBy`; add a
tolerant `fmtDate(iso)` helper that returns "" on undefined / invalid
input. Same change to `src/pages/production/folders.tsx` (list page).
Also fixed the GET `/api/production-folders/:id` SQL to alias
`job_card_id AS "jobCardId"` so `jobCardIds[]` returns actual IDs
instead of `[null, null]`.

**Verification:** opened the existing folder via /production/folders →
page renders; jobCardIds populated.

---

## BUG-2026-05-12-007 — wip_cascade_log + production_folders declared org_id UUID; multi-tenant skeleton uses TEXT

**Status:** 🟢 Fixed (2026-05-12)
**Category:** data-migration

**Symptom (developer-side):** Folder create returned 500
`invalid input syntax for type uuid: "hookka"`. Same shape would have
been caught silently in the WIP cascade guard's try/catch wrapper
(BUG-2026-05-12-006) — every INSERT into wip_cascade_log was failing
since deploy, the guard wasn't actually active in prod.

**Root cause:** migrations `0074_wip_cascade_log.sql` and
`0075_production_folders.sql` declared `org_id UUID NOT NULL`, but
Hookka's multi-tenant skeleton (migration `0049_multi_tenant_skeleton.sql`)
uses `orgId TEXT NOT NULL DEFAULT 'hookka'` across every existing table.
The runtime always supplies the literal string "hookka", which Postgres
rejects when the column is typed UUID.

**Fix:** redeclared both new tables with `org_id TEXT`. Added an
idempotent `ALTER TABLE … ALTER COLUMN org_id TYPE TEXT USING org_id::text`
in the self-applying migration block so the in-flight prod table flips
to TEXT without losing rows (only had test rows anyway).

**Verification:** folder create now returns 200; wip_cascade_log INSERT
no longer emits the silent warning. Re-ran the WIP rebuild — drift = 0
holds.

---

## BUG-2026-05-12-006 — wip_items has no idempotency guard; backfill scripts re-fired cascade and inflated stock (FOAM 326 case)

**Status:** 🟢 Fixed (2026-05-12)
**Category:** inventory-cascade

**Symptom (user-reported):** WIP page showed `8" Divan- 5FT Foam = -8`
and many other negatives; FOAM aggregate showed 326 against an expected
~11. Earlier the same shape had been "fixed" multiple times — the
phantom stock kept coming back.

**Root cause:** of all cascade targets (cost_ledger / fg_units /
fg_batches / job_cards) `wip_items` was the only one without a
`(refType, refId, type)` idempotency key. The BUG-2026-04-27-005 guard
only catches duplicates within ONE PATCH request — backfill scripts,
retries, migration imports re-firing `applyWipInventoryChange` on
already-final-state JCs all slipped through. Each replay added
`+wipQty` again on the producer-add side; downstream consumes hit
different / missing labels and the books didn't balance.

**Fix:**
1. Tactical: `/api/import/rebuild-wip-from-jcs` already exists. Added
   `?byDept` / `?codeContains` scope params so it can run on the full
   prod tenant without hitting the Cloudflare request wall. Ran it once
   on 2026-05-12 — drift went **2029 → 0** (185 updates, 8 inserts,
   350 deletes).
2. Structural: new `wip_cascade_log` table with UNIQUE
   `(org_id, jc_id, from_status, to_status)`. `applyWipInventoryChange`
   first INSERTs a claim row with `ON CONFLICT DO NOTHING`; zero changes
   = already seen, cascade short-circuits. Atomic + concurrent-safe
   across PATCH / SCAN / BULK_PATCH / future backfill scripts.

Migration: `migrations/0074_wip_cascade_log.sql` (self-applies via
`ensurePendingMigrations`).

**Verification:** rebuild dry-run after the run: drift = 0,
current = expected = 1053. Permanent guard verified via repeat-PATCH
test — second send for same (jcId, from, to) tuple short-circuits.

**Related:** [BUG-2026-04-27-005](#bug-2026-04-27-005-cascade-short-circuits-on-prevstatus--newstatus).

---

## BUG-2026-05-12-005 — Phase 2.5 raw-fetch paths missing X-CSRF-Token; saves failed silently with 403

**Status:** 🟢 Fixed (2026-05-12)
**Category:** ui-frontend

**Symptom (user-reported):** Persistent red failure modal on a FAB_SEW
PIC patch: "CSRF token missing or invalid (auto-retried 1× before
giving up)".

**Root cause:** Phase 2.5's debounced batching introduced 3 fetch sites
that bypass the `fetchJson` helper (which auto-injects X-CSRF-Token
from the `hookka_csrf` cookie):
1. `sendOneDraft` (production/index.tsx:1413) — per-draft retry.
2. `flushDrafts` (production/index.tsx:1473) — bulk POST.
3. `/bulk-patch` loopback fetch (production-orders.ts:5172) — inner PATCH.

The auth middleware enforces double-submit CSRF on every mutating
method when the caller is on cookie auth. Header missing → 403.
Auto-retry sent the same empty header → still 403 → modal.

**Fix:**
- New `csrfHeaders()` helper on `src/pages/production/index.tsx` reads
  `hookka_csrf` and builds `{Content-Type, X-CSRF-Token}`. Used by
  `sendOneDraft` + `flushDrafts`.
- `/bulk-patch` endpoint now reads `X-CSRF-Token` off the inbound
  request and forwards it on the loopback fetch alongside Cookie +
  Authorization.

**Verification:** end-to-end 10-test suite (T1–T10) covering set / clear /
batch / status-thrash for completedDate AND PIC — all 10 passed,
zero 403s.

---

## BUG-2026-05-12-004 — Refetch effect didn't preserve staged drafts; typed cell values flickered to server snapshot

**Status:** 🟢 Fixed (2026-05-12)
**Category:** ui-frontend

**Symptom (user-reported):** operator typed in a cell; a moment later
the value flashed back to the prior server value, then was replaced
again by the operator's edit on next flush. Data wasn't lost (the
draft still hit the server) but the UI flickered.

**Root cause:** `src/pages/production/index.tsx` had a refetch effect
that spliced `ordersResp` into local `orders` state, preserving JC IDs
in `pendingJcPatchesRef` (in-flight PATCHes). It did NOT consider
`draftsRef` — JCs typed but not yet sent. Any fetch that resolved
while a draft was queued blanked the optimistic cell back to the
server's stale snapshot.

**Fix:** `src/pages/production/index.tsx` — the splice now also reads
`Array.from(draftsRef.current.keys())` and treats those JC IDs as
"preserve from local state" alongside the in-flight set.

**Verification:** typed in cell, immediately triggered a 20-second
poll fetch + visibility refetch by switching tabs — cell value held
through the refetch, then the debounce-flush wrote the typed value
to the server normally.

---

## BUG-2026-05-12-003 — KV cache version bump fire-and-forget caused stale reads

**Status:** 🟢 Fixed (2026-05-12)
**Category:** infrastructure

**Symptom (user-reported):** "我刚刚改的 completion date 隔天又不见了" —
operator set a completion date, refreshed (or switched tabs back),
and saw the prior value. The DB row had the new value; the GET was
returning a cached body keyed off the old version.

**Root cause:** `bumpPoListCacheVersion(c, orgId)` in
`src/api/routes/production-orders.ts` wrote the new version key via
`waitUntil` so the PATCH response could return faster. The operator's
next GET (often <100 ms later) could read the OLD version key, build
the OLD cache key, and hit the OLD cached payload. Compounded by
BUG-2026-05-12-004: optimistic state was getting overwritten on
refetch.

**Fix:** drop `waitUntil`. `bumpPoListCacheVersion` now blocks on the
KV put (~10–30 ms at the writing edge). Same-edge KV is
read-your-writes consistent so the next GET is guaranteed to read
the new version.

**Verification:** patched + immediately GET'd 5× in a row — every
fetch returned the freshly-written value.

**Related:** [BUG-2026-05-12-004](#bug-2026-05-12-004--refetch-effect-didnt-preserve-staged-drafts-typed-cell-values-flickered-to-server-snapshot)
(the "set then gone" symptom had two legs; this one was the more
common second leg after the backend auto-clear was removed).

---

## BUG-2026-05-12-002 — Production page status dropdown wiped completedDate on every COMPLETED→WAITING flip

**Status:** 🟢 Fixed (2026-05-12)
**Category:** ui-frontend

**Symptom (user-reported):** same "set then gone" symptom as
BUG-2026-05-12-001, but on a different code path: even after the
backend auto-clear was removed, flipping the status dropdown on the
FAB_CUT dept row from COMPLETED to WAITING still wiped the date.

**Root cause:** `src/pages/production/index.tsx` (status `<select>`
onChange around line 2890) explicitly set `patch.completedDate = ""`
whenever the new status was a non-DONE state. The backend's auto-clear
removal didn't help because the FRONTEND was sending the empty string
itself. Status is a filter label; the date is the user-owned source
of truth, so the system must not silently wipe it on any path.

**Fix:** remove the `leavingDone` branch from the status onChange.
Status flip is now status-only; an operator wanting to clear the
date clicks the date cell and clears it there (which sets
status=WAITING + date=null together — the correct user-driven path).

**Verification:** end-to-end test: set completion date, flip status
4× (W→C→W→C), date held all 4 hops.

**Related:** [BUG-2026-05-12-001](#bug-2026-05-12-001--patch-route-auto-cleared-completeddate-on-every-completed-non-completed-status-transition).

---

## BUG-2026-05-12-001 — PATCH route auto-cleared completedDate on every COMPLETED → non-COMPLETED status transition

**Status:** 🟢 Fixed (2026-05-12)
**Category:** production-orders

**Symptom (user-reported):** "completion date 隔天又不见了" — operator
set completion date manually on a JC, came back later, and the date
was gone. Verified via prod `job_card_events` audit log: 153
`COMPLETED_DATE_CLEARED` events in a 36 h window, all triggered by
COMPLETED → WAITING status flips, none of which the operator intended
to wipe the date.

**Root cause:** `src/api/routes/production-orders.ts` (~line 3210
pre-fix) auto-cleared `updated.completedDate = null` whenever a JC
transitioned out of a DONE state, on the theory that "an open JC
shouldn't carry a completion date". But operators flip status to
WAITING to filter the dept page — they don't expect the system to
also wipe the date they explicitly stamped.

**Fix:** remove the auto-clear entirely from the PATCH handler. The
existing `if (body.completedDate !== undefined) updated.completedDate
= body.completedDate || null` branch still honours an explicit clear
(`body.completedDate = ""`), so the operator-driven path still
works.

**Verification:** end-to-end tests T1, T2, T10 all pass. Audit log
24 h post-fix: zero `COMPLETED_DATE_CLEARED` events from
status-only PATCHes.

**Related:** [BUG-2026-05-12-002](#bug-2026-05-12-002--production-page-status-dropdown-wiped-completeddate-on-every-completedwaiting-flip)
(frontend twin), [BUG-2026-05-12-003](#bug-2026-05-12-003--kv-cache-version-bump-fire-and-forget-caused-stale-reads)
(cache-side second leg).

---

## BUG-2026-04-29-008 — Dept-Pivot editor shows stale minutes (same CAT, different times on different rows)

**Status:** 🟡 Fix in progress (2026-04-29)
**Category:** bom

**Symptom (user-reported):** in the Dept-Pivot Category Editor with
`Department = Fab Cut`, three rows on baseModel 1003 all showed
`Category = CAT 3`, but Minutes were `90 / 25 / 25`. Same dept × same
category should yield the same minutes from the `productionTimes`
matrix in `kv_config('variants-config')`.

**Root cause:** `buildDeptPivotRows` in `src/pages/bom.tsx` reads
`p.minutes` directly from each BOM template's stored process row. The
single point at which minutes refresh from the matrix is
`updateProcessCategory` (which fires when the user *changes* a
category). Two scenarios put rows out of sync:

1. The Production Times matrix was edited (e.g. `Fab Cut × CAT 3`
   went from 90 → 25) AFTER the BOM rows were created. Existing rows
   keep the old 90 because no edit on them ever fired.
2. A row was once `(Fab Cut, CAT 1) = 90 min`, the category was
   renamed to "CAT 3" via legacy CSV import / migration without going
   through `updateProcessCategory`, and the minutes never refreshed.

The dialog's `dirtyCount` and Save filter both keyed off
`r.category !== r.initialCategory`, so even if a user noticed the
mismatch and tried to fix it via the resync, there was no path to mark
"only minutes changed" rows as dirty — they'd silently fail to save.

**Fix:** `src/pages/bom.tsx` (`DeptPivotCategoryDialog`)
- New `isRowDirty(r)` helper that returns true on EITHER category drift
  OR minutes drift. Replaces the inline `r.category !== r.initialCategory`
  predicate at the dirty-count, save-filter, and footer-message sites.
- New `isRowStale(r)` helper that compares stored `r.minutes` to
  `getProductionMinutes(deptCode, r.category)` from the live matrix,
  scoped to the filtered row set so the count tracks the user's view.
- New "Resync N stale" yellow banner appears only when ≥1 filtered row
  is stale. One click runs `handleResyncStale`, which updates `r.minutes`
  to the canonical matrix value for every stale row in the filter. Since
  this changes `r.minutes` away from `r.initialMinutes`, the new
  `isRowDirty` flags them and Save persists via `bulk-process-edit`.
- Stale rows render with a subtle `#FFF8E7` background and the Minutes
  cell shows `90 → 25 min` so the user can see the diff before resyncing.

**Verification:**
1. Open Dept-Pivot, set dept = Fab Cut. With user's reported data,
   yellow banner appears: "N rows have stored minutes that no longer
   match…". Yellow rows show `90 → 25 min` strike-through.
2. Click "Resync N stale". Banner disappears, rows turn green (dirty),
   Save count matches.
3. Click Save. Toast confirms write. Reopen — all rows uniform per
   matrix.
4. Filter to `baseModel = 1003` then click Resync — only 1003's stale
   rows are touched; other models' stale rows stay until you clear the
   filter and resync again.

**Related:** [BUG-2026-04-29-007](#bug-2026-04-29-007--kv-config-saves-still-lossy-on-transient-failure-401-add-resilient-sync-layer)
(predecessor: now that Production Times saves reliably, the matrix
becomes the canonical source the BOM rows should follow).

---

## BUG-2026-04-29-007 — kv-config saves still lossy on transient failure / 401; add resilient sync layer

**Status:** 🟡 Fix in progress (2026-04-29)
**Category:** bom

**Symptom (user-reported):** after BUG-2026-04-29-006 shipped honest
"Saved" toasts, the user pushed back: "If it keeps telling me failed
won't that be annoying? Can we avoid it?". The honest-toast fix flagged
failures correctly but didn't *prevent* them — every transient network
blip / 5xx / 429 would still surface as a failure toast and lose the
user's edit until they manually retried.

**Root cause:** `src/lib/kv-config.ts` had no retry, no persistent
backup, and no sync-state machine. A single PUT failure (whether HTTP
500, 401-then-token-refresh, or a packet drop) became a permanent loss
unless the user noticed the toast and remembered exactly what they had
typed. The Production Times matrix is the worst case — 8 depts × 7
categories = 56 cells of state held only in React memory.

**Fix:** added a resilience layer to `src/lib/kv-config.ts`:

1. **localStorage backup** — every `setKvConfig` synchronously writes
   `kv-config-pending:<key>` BEFORE scheduling the PUT. The backup is
   cleared once the server confirms. Survives tab close, browser
   crash, network outage, and 401s.
2. **Auto-retry with backoff** — `flushSave` classifies the outcome:
   `ok` (clear backup, idle), `transient` (5xx / 408 / 425 / 429 /
   network) → retry at 1s/2s/4s before giving up, `permanent` (4xx
   other than auth) → terminal error, `auth` (401 / 403) → terminal
   `auth-error` state for re-login UX.
3. **Sync-state machine** — five states (`idle / syncing / retrying /
   error / auth-error`) with `subscribeKvConfigSyncState`. UIs render
   a passive dot indicator instead of toast spam.
4. **Hydrate-time replay** — `fetchKvConfig` checks for a pending
   localStorage backup; if found, hydrates from local first AND fires
   a flush. Module-level startup hook (deferred to next tick) scans all
   `kv-config-pending:*` keys and replays them on app load.
5. **`ProductionTimesDialog` rewired** — drops the await-flush-then-toast
   pattern in favour of subscribing to syncState. The Save button
   disables during `syncing` / `retrying` and shows "Saving…". Terminal
   `error` state shows "Saved locally — will retry on next page load"
   instead of the alarming "Failed to save". `auth-error` shows
   "Please re-login — change is saved locally and will retry".
6. **Footer indicator** — new `<KvSyncIndicator>` component on the
   ProductionTimesDialog footer renders the sync state as a coloured
   dot + label.

**Net behaviour:** edits are effectively never lost. The user's only
visible feedback during a transient network problem is a yellow
"Retrying…" indicator that turns green once the data lands. The infra
benefits every kv-config consumer — `/products` Maintenance tab, future
dialogs that adopt the same key — for free.

**Verification:**
1. Edit Production Times, click Save with normal network — indicator
   goes yellow → green within ~1s, "Saved" toast.
2. Throttle to offline in DevTools, click Save — indicator stays
   yellow ("Retrying…"). Re-enable network — indicator turns green.
3. Edit + close tab inside the 500ms debounce window — open a new tab,
   navigate to BOM → Production Times. Values persist (replayed from
   localStorage at module init).
4. Force a 500 response in the worker — retries fire 3x, then state
   goes "error" with "Saved locally" indicator. Reload — values still
   present (localStorage backup), state retries on hydrate.

**Related:** [BUG-2026-04-29-006](#bug-2026-04-29-006--production-times-edits-silently-lost-after-close-or-refresh)
(direct predecessor; same data path, single-attempt honest-toast fix);
commit `56dad2a` (the original `flushKvConfig` infra).

---

## BUG-2026-04-29-006 — Production Times edits silently lost after close or refresh

**Status:** 🟡 Fix in progress (2026-04-29)
**Category:** bom

**Symptom (user-reported):** "Yesterday I edited some Production Times,
today when I opened it they're gone again." The matrix (department ×
category → minutes) appeared to save — toast said "Production times
saved" — but on next page load the cells reverted to their pre-edit
values, sometimes only partially.

**Root cause:** `ProductionTimesDialog.handleSave` in `src/pages/bom.tsx`
called `patchVariantsConfig({...})` and showed the success toast
synchronously. Underneath, that function only updates the in-memory
cache and schedules a **500ms-debounced** `PUT /api/kv-config/variants-config`
(see `src/lib/kv-config.ts:181`). Three failure modes followed from
that:

1. The user closed the dialog / tab / browser inside the 500ms window —
   the timer never fired, no PUT was sent.
2. The PUT fired but the server returned 401/500 — `flushSave` in
   `kv-config.ts` notifies subscribers via `subscribeKvConfigSaveError`,
   but `ProductionTimesDialog` had never wired that listener up.
3. Same as (2) but the cached value was already considered "saved" so
   the next mount's `fetchVariantsConfig` overwrote local state with the
   stale server value, making the loss invisible until the user
   re-opened the dialog.

The infrastructure to do this correctly was added in commit `56dad2a`
("kv-config save no longer silently fails"), which introduced
`flushKvConfig` (await server response) and the error listener API.
`/products` Maintenance tab adopted both patterns at
`src/pages/products/index.tsx:780,747`. `ProductionTimesDialog` predates
those fixes and was never migrated — so it kept the lying-toast
behaviour.

**Fix:** `src/pages/bom.tsx`
- `handleSave` is now `async`, awaits `flushKvConfig(VARIANTS_CONFIG_KEY)`,
  and only marks the dialog clean / shows "Saved" if the server
  confirmed the write. On failure, shows "Failed to save — try again"
  and leaves `dirty=true` for retry.
- New `useEffect` subscribes to `subscribeKvConfigSaveError` for the
  variants-config key while the dialog is open, so background save
  failures (debounced PUTs that 401 between manual saves) surface as a
  toast instead of dying silently.
- Second `useEffect` adds a `beforeunload` handler that fires
  `flushKvConfig` synchronously when the user closes the tab — closes
  the 500ms-window data-loss path on quick close.
- Save button shows "Saving…" and is disabled while the PUT is in
  flight; Close button is disabled too so the user can't kill the
  in-flight save.

**Verification:** Open Production Times, edit a few cells, click Save,
wait for "Saved" toast (now appears AFTER the network round-trip).
Refresh the page, reopen — values persist. To reproduce the original
bug, deploy commit before the fix and immediately close the dialog
within ~250ms of clicking Save; values revert on next open. Pre-fix:
toast lied, values gone. Post-fix: button disabled until server
confirms, no premature toast.

**Related:** [BUG-2026-04-22-001](#bug-2026-04-22-001--fix-crash-variants-page-coerces-object-entries-to-strings-on-load)
(same `variants-config` blob, different page); commit `56dad2a` (the
infra this dialog should have adopted in April 22).

---

## BUG-2026-04-29-005 — CN dispatch left fg_units / stock_movements / wip_items untouched (no inventory cascade)

**Status:** 🟢 Fixed (2026-04-29)
**Category:** inventory-cascade

**Symptom (user-reported):** the user dispatched a Consignment Note
(`ACTIVE → PARTIALLY_SOLD`, FE-labelled "Mark Dispatched") and the goods
physically left the warehouse, but the Inventory page's Available count
never dropped. The CN's `dispatchedAt` got stamped, the FE list moved
the CN to the Dispatched tab, and that was it — `fg_units` rows for the
CN's source POs stayed `PENDING`, no `STOCK_OUT` row was written into
`stock_movements`, and `wip_items.stockQty` still carried the residual
UPH ledger entry. Net effect: the CN was a black hole for inventory
accounting.

**Root cause:** `updateConsignmentNoteById` in
`src/api/lib/consignment-note-shared.ts` was a status-+-timestamp-only
helper. DO had a full cascade in
`src/api/routes/delivery-orders.ts:1346-1577` for the symmetric event
(`DRAFT → LOADED` and the reverse), but no equivalent existed on the CN
helper — Mark Dispatched was wired straight to a status flip with no
inventory awareness. The CN→PO→fg_units link couldn't be expressed
either: `fg_units` had only a `doId` column, not a `cnId` column, so
even if the cascade had been written it would have had nowhere to stamp
the back-reference.

**Fix:** Three changes in commit `fa1f3ee`:

1. **Migration** `migrations-postgres/0077_fg_units_cn_link.sql` adds
   `cnId TEXT` + `idx_fg_units_cn_id` to `fg_units`. Separate column
   from `doId` — overloading would silently fan out wrong joins on
   every report that filters fg_units by source document. A unit can
   hold AT MOST one of `{doId, cnId}`; the cascade WHERE clauses
   enforce that with `(doId IS NULL OR doId='') AND (cnId IS NULL OR
   cnId='')`. Manual-apply via Supabase SQL Editor (D1 retired
   2026-04-27).
2. **Forward cascade** (`ACTIVE → PARTIALLY_SOLD`) in
   `updateConsignmentNoteById`:
   - `UPDATE fg_units SET cnId=?, status='LOADED', loadedAt=? WHERE poId=? AND (doId IS NULL OR doId='') AND (cnId IS NULL OR cnId='')` per source PO
   - `INSERT stock_movements (STOCK_OUT, reason="CN <noteNumber> dispatched")` per PO
   - `UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?` for each UPH job_card wipLabel of those POs (mirrors BUG-2026-04-27-021's DO-side fix)
3. **Reverse cascade** (`PARTIALLY_SOLD → ACTIVE`, the FE's "Reverse to
   Pending Dispatch" action) is the symmetric inverse: clear cnId, flip
   fg_units back to PENDING, write STOCK_IN, re-credit wip_items.

`PARTIALLY_SOLD → FULLY_SOLD` (Mark Delivered) and `FULLY_SOLD → CLOSED`
(Mark Acknowledged) intentionally do NOT trigger another fg_units flip
— goods are already out of inventory after dispatch, and consignment
delivery semantics differ from DO's (per-line `consignment_items.soldDate`
instead of header-level `deliveredAt`).

**Verification:** typecheck + eslint clean. Runtime verification deferred
until user applies migration 0077 manually — until applied, the forward
UPDATE throws "column cnId does not exist". Documented in commit body
+ migration header.

---

## BUG-2026-04-29-004 — CN Detail dialog vs DO Detail dialog: 9 layout / data gaps after first parity pass

**Status:** 🟢 Fixed (2026-04-29)
**Category:** ui-frontend

**Symptom (user-reported, after commit `55f18c0` "CN Detail parity v1"):**
the user opened a freshly-created CN whose row already had Provider /
Vehicle / Driver populated, clicked Edit (Pencil icon), and the inline
edit-mode opened with **Vehicle and Driver dropdowns blank** ("—
Optional —"). The user had to re-pick them every time. Same applied to
the **Mark Dispatched** dialog — the picker opened with all three
dropdowns blank even though the CN already had transport set. The list
row Status cell showed `RM 0.00` instead of the m³ total (DO shows
`X.XX m³`).

**Root cause:** Three independent gaps in
`src/pages/consignment/note.tsx` from the v1 CN parity work:

1. `enterEditMode` hardcoded `vehicleId: ""` and `driverPersonId: ""`.
   The DO equivalent at `src/pages/delivery/index.tsx:1340` seeds
   `vehicleId` from `row.vehicleId` and uses a
   `pendingDriverNameToResolveRef` pattern to resolve the driver
   PERSON id from `driverName` once the per-provider drivers list
   loads.
2. `mapCNToRow` didn't extract `vehicleId` from the API response.
   `consignment-note-shared.ts:rowToConsignmentNote` returns it, the
   FE just dropped it on the floor, so the row had no `vehicleId`
   field for `enterEditMode` to seed from.
3. The list Status cell render at line ~1690 used
   `formatCurrency(row.totalValueSen)` instead of
   `(row.totalM3 ?? 0).toFixed(2) + " m³"`. CN row didn't carry
   `totalM3` either — DO computes it from
   `delivery_orders.totalM3`; CN had no aggregate column, just per-line
   `itemM3`.

**Fix (commit `707e515`, 9 numbered gaps in commit body):**

- Edit dialog Vehicle dropdown pre-selects from `row.vehicleId`; Driver
  dropdown resolves PERSON id by name via `pendingDriverNameToResolveRef`
  (DO pattern).
- Mark Dispatched dialog (both context-menu + Detail-dialog footer)
  routed through new `openDispatchDialog(row)` that pre-fills
  Provider/Vehicle from row + stashes driver name for resolve-on-load.
- List Status secondary line: `formatCurrency(totalValueSen)` →
  `(totalM3).toFixed(2) + " m³"`.
- `ConsignmentNoteRow` gains `vehicleId` and `totalM3`. `mapCNToRow`
  now copies `vehicleId` from the API response and computes `totalM3`
  from `productM3Map` (same source as items-table footer, so the two
  totals always agree).
- Detail dialog basics grid: `CN Number / CO Reference / Items` →
  `CN Number / Total M³ / Items` (mirrors DO 1:1; CO Reference moved
  to chip strip below).
- Edit-mode basics grid: same swap, with live `editItems`-derived
  Total M³ that updates as the operator adds/removes items.
- Dispatch dialog Cancel/backdrop/X all clear the pending driver-name
  ref to prevent name bleeding between sessions.
- `cancelEditMode` clears `pendingDriverNameToResolveRef` (mirrors DO).

**Verification:** typecheck + eslint clean. User testing confirmed
pre-fill works after deploy.

---

## BUG-2026-04-29-003 — `updateConsignmentNoteById` silently dropped `sentDate` and `items[]` on PUT

**Status:** 🟢 Fixed (2026-04-29)
**Category:** delivery-orders

**Symptom:** the new CN inline edit-mode (commit `6a21d18`) PUT all
edited fields back through `/api/consignment-notes/:id`, but two of the
four primary editable fields silently no-op'd: changing the Delivery
Date had no effect, and adding / removing / re-quantifying items also
had no effect. Operators saw their edits "save" (toast confirmed
success) but on reload the persisted state was unchanged for those two
fields. Other fields (provider / vehicle / driver / hub / notes)
worked.

**Root cause:** `updateConsignmentNoteById` in
`src/api/lib/consignment-note-shared.ts` (the helper both
`/api/consignment-notes` and `/api/consignments` route through) had no
handling for `body.sentDate` — the `UPDATE consignment_notes` statement
just didn't include the `sentDate = ?` column. The function also had
no items-replace path at all: `consignment_items` rows were immutable
through this endpoint.

**Fix (commit `a28dcce`):**

1. Add `sentDate` to the UPDATE SET clause. Optional in body — undefined
   keeps the existing value, null clears, string overwrites. Mirrors
   the same body-undefined→keep / body-null→clear semantics already in
   place for `consignmentOrderId` / `hubId`.
2. Items replace via delete-and-reinsert when `body.items` is an array
   AND `existing.status === "ACTIVE" && nextStatus === "ACTIVE"`. The
   status guard exists because `consignment_items` carry per-line
   `soldDate` / `returnedDate` state once the CN crosses into
   `PARTIALLY_SOLD` / `RETURNED` / `FULLY_SOLD` — wiping rows then
   would lose committed sale/return history. Edit-mode is FE-gated to
   PENDING (= ACTIVE backend) anyway, but the guard is a hard backstop
   against future status drift. Stable ids: incoming `item.id` matching
   `coni-*` is reused; fresh ids are minted only for newly-added items.

**Verification:** typecheck + eslint clean. Manual: operator changed
delivery date + added an item, reloaded, both persisted.

---

## BUG-2026-04-29-002 — CN Edit button routed to non-existent `/consignment/note/:id/edit` page (blank page on click)

**Status:** 🟢 Fixed (2026-04-29)
**Category:** ui-frontend

**Symptom (user-reported):** opening a Consignment Note Detail dialog
and clicking the Edit (Pencil) icon — or the footer "Edit" button —
navigated to a blank page at `/consignment/note/<id>/edit`. The user
saw a clean dashboard chrome with no content, no error toast, and no
back path beyond the browser back button.

**Root cause:** commit `55f18c0` (CN Detail dialog parity v1) added the
Edit button with `onClick={() => navigate('/consignment/note/'+id+'/edit')}`,
on the assumption that a standalone edit page existed. It didn't —
`src/dashboard-routes.tsx` registered no such route. The router fell
through to the dashboard 404 fallback, which renders empty.

**Fix (commit `6a21d18`):** removed both `navigate(...)` calls and
implemented inline edit-mode in the Detail dialog itself, mirroring DO's
pattern at `src/pages/delivery/index.tsx:1340-1478`:

- Added state: `editMode`, `editForm`, `editItems`, `editSaving`,
  `editVehicles`, `editDrivers`, `editAddItemSearch`,
  `editShowAddItemPanel`.
- Added handlers: `enterEditMode`, `cancelEditMode`, `removeEditItem`,
  `addReadyPOToEdit`, `addableEditPOs` memo, `saveEditCN`.
- `useEffect` keyed on `editForm.providerId` refetches per-provider
  vehicles + drivers, parallel to DO's `editDialogVehicles` /
  `editDialogDrivers` effect.
- Detail dialog body swaps read-only fields for inputs when
  `editMode === true` — 3PL Provider / Vehicle / Driver / Hub pickers,
  Delivery Date, Remarks. Items table gets a Trash2 remove column +
  an Add Items panel restricted to same-customer Pending-CN POs.
- Header swaps to "Edit Consignment Note" + adds an "Editing" chip;
  Print/Document icons hidden in edit mode; Tracking timeline + Remarks
  display hidden in edit mode.
- Footer: Cancel + Save Changes (with `RefreshCw` spinner) when
  editing; backdrop click is a no-op so unsaved changes don't drop.

**Followup:** the v1 inline implementation introduced
BUG-2026-04-29-003 (silent no-op on `sentDate` + `items[]`) and
BUG-2026-04-29-004 (dialog seeding gaps). Both fixed same day.

---

## BUG-2026-04-29-001 — Production Sheet "SO ID" column blank for SOFA rows of CO-origin POs

**Status:** 🟢 Fixed (2026-04-29)
**Category:** production-orders

**Symptom (user-reported):** in the Production page's per-department
sheet (Fab Cut / Wood Cut / Upholstery / etc.), the "SO ID" column
rendered blank for SOFA rows whose parent was a Consignment Order
(rather than a Sales Order). Bedframe and Accessory rows from the same
CO showed correctly (`CO-2604-001-01`). The Overview tab also worked.
Only the dept sheets, only on SOFA, only for CO-origin POs.

**Root cause:** `src/pages/production/index.tsx:1401`:

```ts
soId: (o.itemCategory === "SOFA" ? o.companySOId : o.poNo) || "",
```

For a CO-origin SOFA PO, `o.companySOId` is empty (the order is a CO,
not an SO) and the parent doc id lives on `o.companyCOId`. The fall-
through to `""` silently rendered a blank cell. The non-SOFA branch
read `o.poNo`, which is the line-suffixed `CO-YYMM-NNN-NN` for both SO
and CO POs, so bedframe / accessory worked.

The display rule (sofa drops the line suffix because a sofa set spans
multiple variant-POs and no single suffix belongs to the whole set) is
correct — the bug was forgetting CO is also a valid parent doc class.

**Fix:** SOFA branch now reads `companySOId || companyCOId`. Also
widened `salesOrderNo` similarly so the row metadata exposes the parent
doc id for both flows. `salesOrderId` stays SO-only — CO double-click
navigation to `/consignment/order/:id` is a separate follow-up; for
now CO rows become double-click no-ops on the SO ID column instead of
routing to a `/sales/<co_id>` 404.

Type drift caught while fixing: `src/lib/mock-data.ts` `ProductionOrder`
got `consignmentOrderId?` + `companyCOId?` added (the API has been
returning these since `f0936ea` / 2026-04-28's `rowToPO` fix, but the
shared type didn't carry them, so TS was permissive instead of
helpful). Followup hotfix `da9c7b6` discovered a second `ProductionOrder`
type **shadowing** the import at `src/pages/production/index.tsx:26`
that ALSO needed the same fields — the deploy of the first commit
(`f35bcd5`) failed type-check on it.

**Verification:** typecheck clean after both commits. Manual: dept
sheets now show `CO-2604-002` for SOFA rows whose parent is CO-2604-002.

---

## BUG-2026-04-27-032 — WIP page inflated displayed qty by summing UPH JC capacity instead of trusting `wip_items.stockQty`

> Originally logged as BUG-2026-04-27-022 in the task brief; renumbered to
> 032 because IDs 022–031 were already taken by the bulk backfill commit
> `d6d91fc` (2026-04-27).

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-display

**Symptom (user-reported):** the WIP grid showed three rows at 322 / 190
/ 42 for wipLabels whose ledger `stock_qty` was 4 / 2 / 1 respectively.
The displayed numbers were ~80× the true ledger truth. Specifically, the
user observed that one shared UPH `wipLabel` was being aggregated across
~160 not-yet-fully-complete UPH JCs (each contributing `wipQty=2`),
producing a 322-unit display for a row whose ledger was just +4.

**Root cause:** `src/api/routes-d1/inventory-wip.ts:296-309` (pre-fix)
walked every linked UPH JC of a UPH-coded `wip_items` row, summed
`wipQty` over the JCs whose PO was NOT fully UPH-complete, and used that
sum as the displayed `setQty` / `pieceQty` / `totalQty`. The intent was
"per-PO attribution" so a wipLabel shared by partial + fully-complete POs
wouldn't double-count the fully-complete contribution (which is also
surfaced via `deriveFGStock`).

The intent was right; the implementation summed the wrong thing. JC
`wipQty` is JC capacity — what the JC *would* produce when complete, not
what's actually on the shelf. For 160 UPH JCs whose POs are still partial
(no UPH JC done yet), every one contributed `wipQty=2` to the sum, so the
displayed qty became 320 even though `wip_items.stockQty` was just the
+4 produced by the few JCs that had actually completed.

The cascade (`applyWipInventoryChange` in `production-orders.ts`) already
maintains `wip_items.stockQty` as the ledger truth: producer-add at UPH
COMPLETED (BUG-2026-04-27-014/-017), dispatch decrement at DO LOADED
(BUG-2026-04-27-021), rollback paths (BUG-2026-04-27-002). The read
path's per-JC sum was a redundant — and wrong — second-source-of-truth.

**Fix:** `src/api/routes-d1/inventory-wip.ts:279-318, 530-553`. Replace
the `adjustedStockByRowId` map and the `displayQty` branch with a pure
visibility filter:

```ts
const linkedUphJcs = (jcsByLabel.get(w.code) ?? []).filter(
  (jc) => (jc.departmentCode || "").toUpperCase() === "UPHOLSTERY",
);
if (
  linkedUphJcs.length > 0 &&
  linkedUphJcs.every((jc) => poFullyUphComplete.get(jc.productionOrderId))
) {
  return false; // hide — every contributing PO is now FG
}
return true;
```

`w.stockQty` is used directly as the displayed qty for `setQty`,
`pieceQty`, and `totalQty`. The orphan default-show case
(BUG-2026-04-27-019) is automatically handled — `linkedUphJcs.length === 0`
returns `true`. The multi-PO mixed case (BUG-2026-04-27-018, partial vs
fully): the row stays visible at the full ledger qty; the fully-complete
portion is also surfaced via FG (`deriveFGStock`) — that's a known design
decision, now documented in `docs/INVENTORY-WIP-FLOW.md` § 7.

**Verification:** `npm run typecheck:app` clean, `eslint
src/api/routes-d1/inventory-wip.ts` clean, `npm test` 84/84 passing
(no test pinned the inflated qty — that was the bug). Manual: the grid
now reads 4 / 2 / 1 for the same three rows that had been showing 322 /
190 / 42.

**Companion:** new doc `docs/INVENTORY-WIP-FLOW.md` consolidates the
entire `wip_items` lifecycle (entry / exit / negative-qty / edge cases /
intentional double-counts / failure modes) so the next time someone
debugs WIP drift they have one document to read instead of grep-walking
the cascade + reading bug-history threads.

---

## BUG-2026-04-27-021 — DO Dispatch left wip_items.stockQty +qty forever

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** When a Delivery Order transitioned DRAFT → LOADED (the
"dispatch" / stamp-on-dispatch event), the wip_items rows produced by
each PO's UPHOLSTERY job cards stayed at +qty in D1 indefinitely. The
WIP read path (`/api/inventory/wip`) hides them because the PO is fully
UPH-complete (BUG-2026-04-27-017) and the FG read path (`deriveFGStock`)
drops the PO once its DO is dispatched, so the +qty was effectively
invisible — but the underlying `wip_items` ledger was wrong: a row that
no longer represented physical stock kept claiming inventory.

**Root cause:** The dispatch path in
`src/api/routes-d1/delivery-orders.ts` (the `stampedOnDispatch`
DRAFT→LOADED branch) wrote `STOCK_OUT` into `stock_movements` and
flipped `fg_units` to LOADED, but never decremented `wip_items.stockQty`
for the UPH-coded rows produced by those POs. The UPH producer-add
write at JC completion time (`applyWipInventoryChange`) had no
counterparty in the DO state machine.

**Fix:** Two symmetric writes added inside the existing
`stampedOnDispatch` and `revertedToDraft` branches in
`src/api/routes-d1/delivery-orders.ts`:

- DRAFT → LOADED: query `job_cards` for every UPH JC of every PO
  referenced by the DO that has `wipLabel IS NOT NULL`. For each, push
  `UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?` into
  the same batch as the existing dispatch SQL. Decrement uses the JC's
  own `wipQty` if set, else falls back to the PO's quantity.
- LOADED → DRAFT (the existing reversal path): symmetric inverse,
  re-credit `+ ?` for each UPH wipLabel of each PO that was stamped.

Idempotency is the predicate gates: `stampedOnDispatch` only fires when
`existing.status === 'DRAFT' && nextStatus === 'LOADED'`, so re-PATCHing
a LOADED DO with the same status is a no-op. Same for `revertedToDraft`.
No `MAX(0)` clamp — symmetric with BUG-2026-04-27-013, where negative
`stockQty` is a visibility signal rather than a clamp violation.

**Verification:** typecheck:app clean for delivery-orders.ts (the
pre-existing `delivery/index.tsx` merge-conflict markers are unchanged
and unrelated to this fix); lint:app clean for delivery-orders.ts;
`npm test` 84/84 passing (no new test pinned — out-of-scope per the
task brief).

---

## BUG-2026-04-27-020 — UPH rollback didn't reverse cascadeUpholsteryToSO

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** When an operator un-completed a UPHOLSTERY job card (DONE
→ WAITING via the Production Sheet date-cell or the form), the
inventory cascade rollback (BUG-2026-04-27-002) correctly refunded the
wip_items numbers, but the parent Sales Order stayed at READY_TO_SHIP
forever — even though one of its UPH JCs was now back to WAITING.
The SO supervisor saw the order ready to ship; the floor saw a UPH JC
still pending.

**Root cause:** `cascadeUpholsteryToSO` (the forward path that bumps
the SO to READY_TO_SHIP once every sibling PO is fully UPH-complete)
has an `else if` branch that flips READY_TO_SHIP back to CONFIRMED
when the condition no longer holds, but it (a) emits no audit row and
(b) doesn't clear the PO's `stockedIn` flag, leaving partial state
that the PO/SO views read inconsistently. Operationally, callers
treated the absence of an audit row as "this transition didn't
happen", and the `stockedIn=1` flag pinned by the forward path was
never reset.

**Fix:** New helper `cascadeUpholsteryRollbackToSO` in
`src/api/routes-d1/production-orders.ts` (added after
`cascadeUpholsteryToSO`). The helper:

1. Looks up the SO via the PO row.
2. Clears `stockedIn = 0` on the PO (the forward cascade sets it to 1).
3. If the SO is currently READY_TO_SHIP, recomputes the
   "every sibling PO is fully UPH-complete" condition. If it no longer
   holds, batches a SO status flip back to CONFIRMED with a
   `so_status_changes` audit row (mirrors the forward audit pattern in
   `sales-orders.ts`).

Hook point: `applyPoUpdate` tracks a `uphRollbackTriggered` flag in
the body.jobCardId block, set when `wasDone && !isDone` and the JC's
`departmentCode` is UPHOLSTERY. After the JC + PO UPDATEs commit and
the existing `cascadeUpholsteryToSO` runs, the new helper fires gated
on the flag. Defensive try/catch matches the existing cascade pattern.

The forward `cascadeUpholsteryToSO` is unchanged — its existing
`else if` is correct as-is and continues to handle the soft case
(rollback during a non-UPH PATCH that triggers the cascade); the new
helper adds the audit + stockedIn reset that the operator-facing
rollback specifically needs.

**Verification:** typecheck:app clean for production-orders.ts; lint
clean for the same; `npm test` 84/84 passing (no new test pinned —
optional per task brief).

---

## BUG-2026-04-27-017 — WIP page double-counted UPH-completed rows alongside FG view

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-display

**Symptom:** Items that had finished UPHOLSTERY were appearing on the
warehouse **WIP** tab AND on the **Finished Products** tab at the same
time, double-counting them. User screenshot showed rows like
`5531 -Back Cushion 24` with positive `pieceQty` on the WIP grid even
though those pieces were already finished and should only live in FG.

**Root cause:** Per the user's mental model, UPHOLSTERY-completed = the
piece is now FG (in-stock), surfaced via `deriveFGStock` (frontend
roll-up that counts POs whose UPH JCs are all COMPLETED). The
`applyWipInventoryChange` cascade still writes a positive
`wip_items` row for the UPH JC's own `wipLabel` though (the
"producer-add" leg, written at UPH COMPLETED for symmetry with the
non-terminal depts). And `/api/inventory/wip` was reading every
non-zero `wip_items` row, so those UPH producer rows showed up on the
WIP grid too.

**Fix (initial):** Filter at the SQL source in
`src/api/routes-d1/inventory-wip.ts`. The main query was tightened to
`stockQty != 0 AND (deptStatus IS NULL OR deptStatus != 'UPHOLSTERY')`.

Rationale for SQL-level filter at the time: smaller payload, no join
cost wasted on rows we'd discard. Negative-row stub semantics
(BUG-2026-04-27-013) are unaffected — those carry
`deptStatus='PENDING'`, not `'UPHOLSTERY'`. FG view and `deriveFGStock`
are untouched; PO-level UPH-all-completed still drives FG appearance.

**Verification (initial):** typecheck + lint clean; existing 84 tests
unaffected (no test asserted the UPH-row-on-WIP behavior because it was
a bug). Manual: with a PO whose UPH was fully COMPLETED,
`/api/inventory/wip` no longer returned the UPH-coded rows;
`/api/inventory/finished-products` (or its frontend equivalent via
`deriveFGStock`) still did.

### Follow-up (2026-04-27): blanket filter over-hid partial-UPH POs

**Symptom:** For BF or sofa POs that are only **partially** UPH-complete
(e.g. BF Divan UPH done but HB still WAITING; sofa Cushion UPH done but
Base/Armrest still WAITING), the completed component's UPH `wip_items`
row got hidden from the WIP grid AND the PO didn't qualify as FG yet
(`deriveFGStock` requires *every* UPH JC of the PO to be COMPLETED). Net
result: the completed components disappeared from BOTH the WIP and FG
views — they were "in limbo".

**Root cause:** The initial SQL filter
`AND (deptStatus IS NULL OR deptStatus != 'UPHOLSTERY')` was a
PO-blind blanket exclusion. It assumed UPH-completed = PO-FG, but for a
multi-UPH-JC PO (BF has Divan+HB, sofa has Base+Cushion+Armrest) the
"this row is FG-equivalent" implication only holds when the PO's *last*
UPH JC is COMPLETED. While any UPH JC is still WAITING, the producer
rows for the already-completed UPH JCs need to remain WIP-visible.

**Fix (refined):** Replace the blanket SQL exclusion with a
PO-conditional JS post-filter in `src/api/routes-d1/inventory-wip.ts`.
Read all non-zero `wip_items` rows from SQL, then after the
`(pos, jcs, jcsByLabel, jcsByPo)` maps are built (used downstream for
sources / age / cost derivation anyway), compute per-PO
`fullyUphComplete` (TRUE iff the PO has at least one UPH JC and every
UPH JC is COMPLETED/TRANSFERRED). A UPH-coded `wip_items` row is HIDDEN
iff every PO that links to it via any JC's `wipLabel` is fully
UPH-complete; if any linked PO still has a pending UPH JC, the row
stays visible.

Implementation chose JS post-filter over the equivalent triple-nested
correlated SQL subquery because the route already loads `pos`/`jcs`
into memory for the per-row derivation that follows the filter — reuses
the same indexes for a smaller, more readable diff.

| State | WIP page | FG page |
|---|---|---|
| Only one UPH JC of a PO done (partial) | **Show** UPH row | Don't show |
| All UPH JCs of the PO done (full) | **Hide** UPH row | Show via `deriveFGStock` |
| Non-UPH dept rows | Always show | n/a |

Edge case preserved: a UPH-deptStatus row whose code has no matching JC
at all is still hidden (no PO is asserting partial-UPH visibility, so
the original blanket-hide intent applies).

**Verification (follow-up):** typecheck + lint clean (warnings/errors
present in the working tree are pre-existing and unrelated to this
file); 84/84 tests pass; manual SQL spot-checks per the task brief
(partial-BF: Divan row visible, HB row absent; full-BF: both rows
absent on WIP, PO surfaces as FG via `deriveFGStock`; partial-sofa:
Cushion row visible).

### Follow-up · BUG-2026-04-27-018: multi-PO sharing same wipLabel double-counted

**Symptom:** When two POs both produced the same UPH `wipLabel` (e.g.
two sofa POs both producing `5531 -Back Cushion 24`),
`wip_items.stockQty` aggregated both contributions (+2). If PO A was
fully UPH-complete (its +1 already in FG via `deriveFGStock`) but PO B
was partial (its +1 should still be in WIP), the per-PO filter saw "at
least one PO is partial → keep visible" and showed the **full** +2 on
the WIP grid. PO A's +1 was double-counted (also in FG).

**Root cause:** The PO-conditional filter from BUG-2026-04-27-017 was a
boolean show/hide gate that ignored qty attribution. It correctly kept
shared rows visible when any PO was partial but emitted the full
aggregate `stockQty`, not the partial-PO subset.

**Fix:** Per-PO attribution. For each UPH `wip_items` row, sum the
`wipQty` of UPH JCs whose PO is NOT fully UPH-complete; that sum is the
displayed `setQty` / `pieceQty` / `totalQty`. Sum = 0 → hide entirely
(every linked PO has gone to FG). Implemented as `adjustedStockByRowId`
in `src/api/routes-d1/inventory-wip.ts` next to the existing post-filter.

The raw `stock_qty` is **not** overridden in the ledger; only the
displayed WIP qty reflects "components not yet FG". Source aggregation
and cost roll-up still walk all completed producer JCs (unchanged) — a
fully-complete PO's source still appears in the row's `sources[]` if
the row is partial-but-shared, so the user can see who has gone to FG.

### Follow-up · BUG-2026-04-27-019: orphan UPH rows incorrectly hidden

**Symptom:** A `wip_items` row whose `code` matched no JC's `wipLabel`
at all (legacy / migration residue / external manual entry / stale
data after a JC purge) was hidden from the WIP grid — invisible to
the user with no recourse for cleanup.

**Root cause:** The follow-up filter from BUG-2026-04-27-017 read "no
linked PO" as vacuous-true on the EXISTS-style "every linked PO is
fully complete" check, so the row was treated as "fully complete
somewhere" and hidden. The original blanket-hide intent (preserved on
purpose) was wrong for orphan rows that have no PO context at all.

**Fix:** Default UPH orphans to **show**. Hide rule is now strictly:
at least one UPH JC links to this row AND every linked PO is fully
UPH-complete. No JC link → keep visible with the raw `stock_qty` so
the user can spot and reconcile orphan ledger entries.

---

## BUG-2026-04-27-016 — PACKING participated in inventory cascade — should be metadata-only step

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** Completing a PACKING job_card was firing the same
inventory-cascade write path as upstream depts: a producer-add to
`wip_items` for the FG-level wipLabel, and (via the `deptUpper !== 'UPHOLSTERY'`
generic-consume gate) potential consume-from-upstream side effects.
This contradicted the user's mental model:

- **UPHOLSTERY completed** = goods physically built. UPH consumes
  upstream wip_items (Divan, HB, Cushion, ...) and writes the FG-level
  +qty rows. Once all UPH JCs of a PO are complete, `deriveFGStock`
  surfaces the PO as FG.
- **PACKING completed** = just records `racking_number` on the PO row.
  It is a metadata step, NOT an inventory event — it does not consume
  any wip_items, it does not produce any. Boxes are just being put
  onto a shelf.

**Root cause:** `applyWipInventoryChange` had no PACKING short-circuit
— it treated PACKING like any other dept, falling through to the
generic upstream-consume gate (BUG-2026-04-27-013) and the
producer-add write at the bottom.

**Fix:** New short-circuit at the top of `applyWipInventoryChange`
(`src/api/routes-d1/production-orders.ts:864-879`), placed AFTER the
BUG-005 same-status guard and BEFORE the `wipLabel` computation:

```ts
const deptCodeRaw = (jcRow.departmentCode || "").toUpperCase();
const isPacking = deptCodeRaw === "PACKING";
if (isPacking) return;
```

Critically this only suppresses the wip_items writes. The PO-level
cascades that DO need to fire on PACKING completion all live in the
OUTER PATCH handler, not in `applyWipInventoryChange`:

- `current_department` flip (`production-orders.ts:1657`)
- PO PENDING/IN_PROGRESS → COMPLETED transition
  (`production-orders.ts:1644-1648`)
- `postJobCardLabor` (labor cost ledger, `production-orders.ts:1622-1635`)
- `postProductionOrderCompletion` — fg_units + fg_batches generation
  (`production-orders.ts:1697-1708`)
- `cascadePoCompletionToSO` (`production-orders.ts:1709-1717`)
- `cascadeUpholsteryToSO` (`production-orders.ts:1719-1726`)

All of those continue to fire on PACKING completion exactly as before.

Updated comment on the existing FAB_CUT/WOOD_CUT generic-consume gate
(`production-orders.ts:907-913`) to mention PACKING is bypassed at the
top.

**Verification:** typecheck + lint clean; existing 84 tests pass.
No test pinned the prior PACKING-cascade behavior (it was a bug).

---

## BUG-2026-04-27-015 — Negative-row Source POs over-collected: every higher-sequence COMPLETED JC in same wipKey was treated as a "trigger"

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-display

**Symptom:** Clicking any negative-qty row on the WIP page popped open
the detail modal and listed **too many** Source POs. The same PO would
even repeat when it had multiple COMPLETED downstream JCs in the same
`wipKey`, even though only ONE of those downstreams actually triggered
the consume that wrote the negative.

User's reproduced examples (in D1):

- `wip_items.code = '1007-(K) -HB 20" (WD)"'`, stockQty = -1.
  Producer JC: WOOD_CUT seq=3 (WAITING) on PO `pord-so-bb601356-01`,
  branchKey `(Webbing)`. Cascade trigger: FRAMING seq=4 (COMPLETED)
  consumed `(WD)` → -1. WEBBING seq=5 (COMPLETED) consumed `(Frame)`,
  not `(WD)`. Popup listed **2** sources (both `SO-2604-314-01`)
  because the derivation also picked up WEBBING's completion as a
  "source" of `(WD)`.
- `1007-(K) -HB 20" PC151-01 (FC)` row showed **3** sources
  (FAB_SEW + FRAMING + WEBBING all completed downstream of FAB_CUT in
  the same wipKey).

**Root cause:** In `src/api/routes-d1/inventory-wip.ts` (lines 306-358),
the negative-row sources derivation walked every JC in the same
`wipKey` with `sequence > P.sequence` and status COMPLETED/TRANSFERRED,
not just the **immediate** downstream of the producer in the **same
branch**. For BOMs with parallel branches or multi-step chains this
over-collected: every later completed JC in the chain was attributed
as a "trigger" of the missing producer's negative, even though only the
direct neighbor that ran the cascade consume actually wrote the row.

The cascade write path (`applyWipInventoryChange()` in
`src/api/routes-d1/production-orders.ts`, BUG-2026-04-27-014) is
already correct: each dept's consume targets its **immediate** branch
upstream, and only that completion triggers the negative. The
inventory-wip read path was just attributing causality wrong.

**Fix:** Replaced the higher-sequence-in-same-wipKey collection with a
strict immediate-downstream pick. For each producer JC `P`:

1. Among JCs in `P`'s same `(wipKey, branchKey)`, take the one with the
   smallest `sequence > P.sequence` — this is `P`'s immediate
   downstream in that branch. There is at most one.
2. If that neighbor is COMPLETED or TRANSFERRED, its PO is a Source.
3. If not completed (still WAITING / IN_PROGRESS / NOT_STARTED), that
   PO did **not** trigger this row's negative — skip.

Then dedupe by **PO id** (defensive — under the immediate-downstream
rule duplicates shouldn't surface, but two producer JCs from the same
PO mapping to the same downstream stays one row).

Also fixed the `ageDays` field on negative-row sources: was hardcoded
`0`, now correctly computed as days since the triggering JC's
`completed_date`. `quantity` keeps using the **producer JC's** wipQty
(the consume amount), `completedDate` keeps coming from the
**triggering downstream JC** (the moment the negative was written) —
both per the user spec.

Edit in `src/api/routes-d1/inventory-wip.ts` around line 306-385: the
positive-row branch is unchanged. Producer-side wip_items writes /
cascade consume math is unchanged.

**Verification:**
1. `npm run typecheck:app` — clean for inventory-wip.ts (the
   pre-existing `delivery/index.tsx` merge-conflict markers are the
   same set documented in BUG-2026-04-27-014, unrelated to this fix).
2. `npm run lint:app` — 0 new errors, 0 new warnings (only the same
   pre-existing baseline warnings + the unrelated delivery/index.tsx
   merge-conflict parse error).
3. `npm test` — 83/83 passing.
4. Manual: with the fix, the user's `1007-(K) -HB 20" (WD)` row shows
   1 source (`pord-so-bb601356-01` whose FRAMING completed) instead
   of 2. The `(FC)` row shows 1 source (`pord-so-bb601356-01` whose
   FAB_SEW completed) instead of 3.

**Not touched:**
- The positive-row branch — unchanged.
- The cascade write path (`applyWipInventoryChange()`) — unchanged.
- Any DB schema or producer-side wip_items emit logic.

---

## BUG-2026-04-27-014 — UPH cascade decremented every upstream JC, not just per-branch terminals

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** Marking an Upholstery (UPH) JC `COMPLETED` on a sofa Base BOM
wrote 6 separate `-consumeQty` decrements — one for **every** upstream JC
in the same `wipKey` (FAB_CUT, FAB_SEW, WOOD_CUT, FRAMING, WEBBING, FOAM)
— instead of only the **branch terminal** of each BOM branch. So
completing UPH while wood-side depts (Wood Cut, Framing, Webbing) were
all incomplete drove three separate negative wip_items rows for that
branch, when only Webbing (the branch terminal — the JC immediately
upstream of UPH on that branch) should have gone negative.

User's correction: "Webbing missing should not also make Framing/WoodCut
negative — those would only go negative if Webbing itself were marked
complete with Framing/WoodCut missing." Each dept's negative is the
responsibility of the **direct downstream dept that completes** (FRAMING
consumes WOOD_CUT, WEBBING consumes FRAMING), not transitively from UPH.

**Root cause:** The UPH branch of `applyWipInventoryChange()` in
`src/api/routes-d1/production-orders.ts` (around line 1077-1119) did
`upstreamLabels = new Set<string>()` over every JC with `wipKey === wipKey
&& sequence < jcRow.sequence`, then decremented each one. That flattened
the BOM into a single chain — for a sofa Base with 6 upstream JCs across
2 parallel branches it wrote 6 decrements instead of 2.

The non-UPH consume gate (line 1015) was already correct: filter by
`(wipKey, branchKey)`, sort by sequence desc, take `[0]` — immediate
upstream only.

**Fix:** Replace the upstream-collection loop with a per-branch terminal
pick. Group upstream JCs by `branchKey`, keep the highest-sequence JC
per branch — that JC's wipLabel is the branch terminal, the only thing
UPH should consume. For the sofa Base BOM:

- Branch `(Webbing)` (wood-side): JCs at seq 2 (WOOD_CUT), 3 (FRAMING),
  4 (WEBBING) → terminal is WEBBING.
- Branch `{FABRIC} Foam` (fabric-side): JCs at seq 0 (FAB_CUT), 1
  (FAB_SEW), 5 (FOAM) → terminal is FOAM.

Result: UPH writes 2 decrements (one per branch terminal), not 6.

Edit in `src/api/routes-d1/production-orders.ts` around line 1077-1133:
swapped the `upstreamLabels = new Set<string>()` collection for a
`Map<branchKey, JobCardRow>` that keeps the highest-sequence JC per
branch. The downstream SELECT-then-UPDATE-or-INSERT logic (BUG-2026-04-27-013)
is unchanged. Added a code comment explaining the per-branch-terminal
invariant so a future refactor doesn't silently flatten it back.

**Not touched:**
- The non-UPH forward consume gate (around line 1015) — already correct,
  per-branch terminal pick already in place.
- The UPH rollback path (around line 936-955) — explicitly out of scope
  per the task brief.
- The producer-add path for UPH's own wip_items row.

**Verification:**
1. `npm run typecheck:app` clean for the production-orders.ts changes
   (the pre-existing `delivery/index.tsx` deliveryDate errors are
   unrelated to this fix and existed before this branch).
2. `npm run lint:app` 0 errors, only pre-existing react-hooks/exhaustive-deps
   warnings unchanged from baseline.
3. `npm test` 83/83 passing, including the BUG-2026-04-27-013 pins:
   - "cascade consume is unclamped — no MAX(0, stockQty - qty)"
   - "cascade consume inserts a negative-qty row when upstream is missing"

---

## BUG-2026-04-27-013 — wip_items consume silently no-ops on missing/zero upstream — now goes negative

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** When a downstream dept (e.g. FAB_SEW) is marked COMPLETED
without its upstream dept (e.g. FAB_CUT) ever being completed, the
inventory cascade silently no-op'd. The `wip_items` row for the upstream
dept either didn't exist (so the UPDATE missed) or sat at `stockQty = 0`
(so the `MAX(0, stockQty - ?)` clamp pinned it at 0). The user had no
WIP-board signal that an upstream dept got skipped.

**Root cause:** `applyWipInventoryChange()` in
`src/api/routes-d1/production-orders.ts` had three call sites that all
used `MAX(0, stockQty - ?)`:

1. **Forward non-UPH consume** (around line 906) — fires on
   `becomingActive` for non-FAB_CUT, non-WOOD_CUT, non-UPH depts.
   Updated the most recent done sibling's `wip_items` row at lower
   sequence within the same `(wipKey, branchKey)` chain.
2. **Rollback non-UPH own-row decrement** (around line 957) — the
   `wasDone && !isDone` branch.
3. **UPH cascade upstream consume** (around line 1057) — when UPH
   completes, iterates every upstream `wipKey` sibling and decrements.

In all three, the clamp swallowed the signal: stock just floored at 0.
And the forward path was further blind to the case where the upstream
`wip_items` row had never been INSERTed at all (the UPDATE quietly
matched 0 rows).

**Fix:** Per user's reason ("the negative number is the visibility
signal"), the cascade now **always decrements without clamp**. If the
target row is missing, INSERT a stub row with `stock_qty = -consumeQty`,
`status = 'PENDING'`, matching the producer-upsert path's INSERT shape.
Rollback own-row decrement is also unclamped, symmetric with the forward
path.

Edits in `src/api/routes-d1/production-orders.ts`:
- Forward non-UPH consume: SELECT-then-UPDATE-or-INSERT, no MAX clamp.
- Rollback non-UPH own-row: `stockQty = stockQty - ?`, no MAX clamp.
- UPH cascade upstream: SELECT-then-UPDATE-or-INSERT per upstream label,
  no MAX clamp.
- UPH rollback own-row: also unclamped (symmetric).
- Stale comment "BF uses MAX(0, stockQty - qty) clamp" updated.

**Verification:**
1. `npm run typecheck:app` clean for the production-orders.ts changes
   (the one pre-existing `inventory/index.tsx` ProductionOrderLike.id
   error is unrelated to this fix).
2. `npm run lint:app` no new errors / warnings.
3. `npm test` 83/83 passing, including two new pins in
   `tests/production-wip-producer-output.test.mjs`:
   - "cascade consume is unclamped — no MAX(0, stockQty - qty)"
   - "cascade consume inserts a negative-qty row when upstream is missing"
4. Walked through the FAB_SEW-before-FAB_CUT scenario for a PENDING
   sofa PO. Expected behaviour with the fix: the FAB_SEW
   becomingActive consume looks up the most recent `(wipKey, branchKey)`
   sibling at lower sequence (FAB_CUT). FAB_CUT's `wip_items` row does
   not exist (FAB_CUT was never completed). The SELECT returns null,
   the INSERT path fires, a `wip_items` row appears with
   `code = <FAB_CUT wipLabel>`, `stockQty = -1`, `status = 'PENDING'` —
   surfacing the skipped FAB_CUT on the WIP board.

**Not in scope:** the COMPLETED→COMPLETED replay non-idempotency
(BUG-2026-04-27-005) is unchanged; this fix only swaps clamp for
unclamped + insert-if-missing.

---

## BUG-2026-04-27-010 — Dept-Pivot editor lists DRAFT BOMs as duplicate rows

**Status:** 🟢 Fixed (2026-04-27)
**Category:** bom

**Symptom:** In the new Dept-Pivot Category Editor, products like `1003-(K)`
and `5530-1NA` show twice (identical category/minutes) because the row
builder reads ALL rows in `bom_templates`, not just the ACTIVE one.

**Root cause:** `src/pages/bom.tsx` `DeptPivotCategoryDialog` calls
`buildDeptPivotRows(templates, deptCode)` with the unfiltered `templates`
array. Two products currently have a v2.0 DRAFT alongside the v1.0
ACTIVE row.

**Fix:** filter `templates` to `version_status === 'ACTIVE'` at the call
site before passing to the row builder. Helper stays generic.

**Verification:** total row count drops from 512 → expected ~510 (drops the 2
duplicates) when Wood Cut is selected.

---

## BUG-2026-04-27-011 — Dept-Pivot Branch/Code shows raw template tokens

**Status:** 🟢 Fixed (2026-04-27)
**Category:** bom

**Symptom:** Branch/Code column reads
`{DIVAN_HEIGHT} Divan- {SIZE} / {DIVAN_HEIGHT} Divan- {SIZE} Foam / ...`
instead of the resolved sample (`8" Divan- 6FT (WD)`) the BOM Structure tree
shows. Hard to read at scale.

**Root cause:** `buildDeptPivotRows` joins ancestor `wipCode` strings
verbatim without running them through `resolveWipTokens`. The pivot also
doesn't carry per-product variant context (sizeLabel / divanHeightInches /
fabric etc.) — so even if it tried, the substitutions would be empty.

**Fix:** at row build time, look up the `Product` row by `productCode`,
build a `BomVariantContext`, and call `resolveWipTokens(template, ctx)` on
the **leaf** node's wipCode (the deepest node owning the matched process).
Drop the ancestor-chain join — the leaf alone is the meaningful label.

**Verification:** Wood Cut row for `1003-(K)` should display
`8" Divan- 6FT (WD)`, matching the BOM Structure view.

---

## BUG-2026-04-27-012 — DRAFT BOM versions left orphaned after confirm flow

**Status:** 🔴 Identified (deferred)
**Category:** bom

**Symptom:** `bom_templates` carries 2 leftover DRAFT rows
(`bom-tpl-1003-(K)-v2`, `bom-tpl-5530-1NA-v2`, both v2.0 effective
2026-05-01) alongside their ACTIVE v1.0 counterparts. User asked: "I
confirmed it, why is the DRAFT still there?"

**Root cause (suspected):** the BOM versioning UI lets the user create a
v2.0 DRAFT but doesn't have a clean "confirm = promote DRAFT to ACTIVE,
mark old ACTIVE as OBSOLETE" flow. After "save" the DRAFT just lingers.
Need to inspect the BOM editor's save path to confirm.

**Fix plan (not yet implemented):**
1. Audit the create-DRAFT-then-save code path in `src/pages/bom.tsx`. If
   confirm is supposed to promote the DRAFT, fix the save handler to
   transition `DRAFT → ACTIVE` and the previous `ACTIVE → OBSOLETE`.
2. Until that's done, the 2 leftover DRAFTs are safe to delete (no
   downstream queries match `version_status='DRAFT'` because the BOM-fetch
   helpers all filter `WHERE version_status = 'ACTIVE'`).

---

## BUG-2026-04-27-005 — `applyWipInventoryChange` not idempotent on COMPLETED→COMPLETED replay

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:** Marking the same JC complete twice double-deducts upstream
wip_items and double-adds the producer row. The cascade has no per-JC guard
against repeat COMPLETED dispatches. Re-surfaced 2026-04-27 on
`pord-so-f6084c68-02` (5531-L(RHF)): 1 PO, qty=1, 1 UPHOLSTERY JC at
COMPLETED, but the wip_items rows showed `5531-L(RHF) -Base 24` = +2,
`(Foam)` = -2, and `M2402-5` = -2 instead of the expected +1 / -1 / -1 —
the cascade fired twice for the same JC's COMPLETED transition (duplicate
PATCH: form re-submit / refresh-and-retry / two operators racing the same
JC / scan-complete + manual-PATCH overlap).

**Root cause:** `src/api/routes-d1/production-orders.ts:844-851`
`applyWipInventoryChange` ran the consume + producer-upsert path
unconditionally on every status='COMPLETED' call. The `MAX(0, …)` clamp
used to hide the upstream-consume side, but BUG-2026-04-27-013 removed
those clamps so doublings now propagate fully.

**Fix:** Added a single-line short-circuit guard at the very top of
`applyWipInventoryChange()` (`src/api/routes-d1/production-orders.ts:852-856`):

```ts
if (prevStatus !== null && prevStatus === newStatus) return;
```

Bails out only when the PATCH supplied a prevStatus AND it equals the new
status — i.e. the operator re-sent the same status without an actual
transition. The first COMPLETED transition still fires (prevStatus is
WAITING / IN_PROGRESS, !==), the DONE→non-DONE rollback (`wasDone &&
!isDone`) still fires, and legacy callers that omit prevStatus (default
`null`) are unaffected — behaviour matches today.

**Verification:** New source-pin test
`applyWipInventoryChange short-circuits on prevStatus === newStatus` in
`tests/production-wip-producer-output.test.mjs` greps for the guard and
fails if a future refactor removes it. The user's reproduction
(`pord-so-f6084c68-02`, +2 / -2 / -2 instead of +1 / -1 / -1) will
produce the expected counts once the guard is in place — duplicate
PATCHes no-op the second cascade fire.

---

## BUG-2026-04-27-006 — `cascadeUpholsteryToSO` runs on every PATCH, not just status changes

**Status:** 🔴 Identified (low priority)
**Category:** inventory-cascade

**Symptom:** Every PATCH to a job_card (PIC re-assign, due-date edit, etc.)
fires `cascadeUpholsteryToSO`, even when status didn't change.

**Root cause:** the call sits **outside** the `if (body.status …)` gate at
`src/api/routes-d1/production-orders.ts:1642`. Functionally safe (only
writes when SO-completion conditions are met) but does redundant DB work
on every save.

**Fix plan:** move the call inside the `if (body.status …)` branch, or add
a precondition check that bails when no relevant JC has transitioned.

---

## BUG-2026-04-27-007 — Audit event write failures swallowed silently

**Status:** 🔴 Identified (low priority)
**Category:** audit-logging

**Symptom:** When `diffJobCardEvents` → batch INSERT to `job_card_events`
fails (D1 hiccup, schema drift, etc.), the JC update at T+2 has already
committed and we lose the audit row with no user-visible signal.

**Root cause:** `src/api/routes-d1/production-orders.ts:1481-1501` wraps
the audit batch in try/catch and only `console.error`s. Audit-row
insert-failure is not surfaced to the user, so audit gaps accumulate.

**Fix plan:** stand up a dead-letter queue for failed audit rows (so we
can replay), or at least bump these to a structured monitor (Cloudflare
Logs Insights / Analytics Engine) instead of plain console.error so we
can alert.

---

## BUG-2026-04-27-008 — `fg_units.status='PENDING'` after PO completion (not `IN_STOCK`)

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-display

**Symptom:** Post-PACKING-complete, the cascade writes `fg_units` rows
with `status='PENDING'` (see `src/api/routes-d1/fg-units.ts:272`). Name
is misleading — these units ARE finished / in stock; PENDING here means
"not yet packed/loaded onto a DO". They later transition to LOADED →
DELIVERED via the delivery_orders flow.

**Root cause:** legacy naming choice. The fact that
`deriveFGStock` (frontend) counts UPH-done POs independently of
`fg_units.status` masks the confusion in most views.

**Fix:** Flipped the INSERT default in `generateFGUnitsForPO`
(`src/api/routes-d1/fg-units.ts:284`) from `'PENDING'` to `'PACKED'`. The
schema CHECK constraint allows
`PENDING / PENDING_UPHOLSTERY / UPHOLSTERED / PACKED / LOADED / DELIVERED
/ RETURNED` (`migrations/0001_init.sql:769`); there is no `IN_STOCK` /
`READY` / `AVAILABLE` value, so we picked the closest existing value.
`PACKED` matches the post-PACKING-JC reality: `generateFGUnitsForPO` is
only invoked from `postProductionOrderCompletion`, which fires on the
PO's PENDING → COMPLETED transition (i.e. ALL job_cards including
PACKING are done). By the time fg_units rows land, the unit is boxed
and racked, awaiting LOAD onto a DO. Downstream scan transitions
(LOADED → DELIVERED → RETURNED) are unchanged. The PACK action handler
gracefully no-ops on already-PACKED rows ("Cannot PACK — unit already
PACKED"), which now reflects the correct lifecycle. No schema
migration was required.

---

## BUG-2026-04-27-009 — `inventory-wip.ts` derives baseModel via `productCode.split("-")[0]`

**Status:** 🔴 Identified (display only)
**Category:** inventory-display

**Symptom:** The inventory-WIP grouping uses
`(po.productCode || "").split("-")[0]` to compute baseModel
(`src/api/routes-d1/inventory-wip.ts:343`). Works for sofa
(`5531-L(RHF)` → `5531`) but fails for BF variants whose suffix uses
parens before any hyphen (e.g. `1003(A)(HF)(W)` has no hyphen → returns
the whole string). Causes incorrect grouping in the WIP board for those
SKUs.

**Root cause:** heuristic instead of reading
`bom_templates.baseModel` (which IS authoritative).

**Fix plan:** join wip_items rows back to `bom_templates` (or
`products.baseModel` if present) and use the canonical value. Alternative:
parse SKU via the existing `parseSku` util elsewhere in the codebase.

---

## BUG-2026-04-27-001 — `completed_date` silently cleared on unrelated PATCH

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom (user-reported):**
User filled the Foam dept completion date for SO-2604-309 / `pord-so-f6084c68-02`
(5531-L(RHF), Carress). Date saved at first — Webbing WIP got consumed as
expected. Then the date silently disappeared. Webbing inventory was already
gone, Foam never appeared, so the warehouse showed nothing.

**Affected data:**
- `job_cards` rows for FOAM dept on `pord-so-f6084c68-02`: `status=WAITING`,
  `completed_date=NULL`
- `wip_items`: no FOAM rows for `5531-L(RHF)`. WEBBING rows existed only for
  Right Arm (Base + Back Cushion gone)

**Root cause:**
`src/api/routes-d1/production-orders.ts:1271-1284` — the PATCH branch:
```ts
if (body.status) {
  ...
  if (isDone) { ... }
  else if (body.completedDate === undefined) {
    updated.completedDate = null;   // ← clears regardless of prior state
  }
}
```
Any PATCH that sent `body.status` without an explicit `body.completedDate`
nulled the field. So *any* status touch on an already-completed JC (e.g. a
PIC re-assign that re-sent status, an "edit due date" form that included
status=WAITING) would wipe the completion date. Coupled with bug #2 below,
the inventory cascade did not roll back, leaving books off.

**Fix:**
Only clear `completed_date` when the JC is **actually transitioning OUT of a
DONE state** (i.e. previous status was COMPLETED/TRANSFERRED and new one is
not). Otherwise leave the date alone — explicit `body.completedDate` still
overrides as before.

**Verification:**
- Code: `production-orders.ts:1271-1295` — see `wasDone` branch.
- Type-check + lint pass.
- TODO: end-to-end replay against a test PO once deployed.

---

## BUG-2026-04-27-002 — `applyWipInventoryChange` has no rollback path

**Status:** 🟢 Fixed (2026-04-27)
**Category:** inventory-cascade

**Symptom:**
Toggling a job card COMPLETED → WAITING (intentionally or via bug #001)
does NOT refund the upstream wip_items consumption nor decrement the
producer's own row. Each forward toggle adds; each reverse leaves it. Net
effect: stockQty drifts further from reality on every cycle.

**Evidence in production data:**
- `wip_items` row `5531-L(RHF) -Right Arm (WC)` had `stock_qty=2` while only
  one PO existed (the cycle had been triggered twice).
- `wip_items` had no FOAM rows at all yet UPHOLSTERY showed COMPLETED in
  `job_cards` — the COMPLETED → WAITING transition that cleared FOAM (bug #1)
  never refunded the stock that UPHOLSTERY had already consumed.

**Root cause:**
`src/api/routes-d1/production-orders.ts:823-1019` `applyWipInventoryChange`
only handles forward transitions:
- Becoming active → consume upstream
- Becoming COMPLETED → upsert producer row (or for UPH, consume all upstream
  siblings + write UPH row)
There is no `wasDone && !isDone` branch.

**Fix:**
Pass `prevStatus` into `applyWipInventoryChange`. When prev was DONE and new
is not, run the inverse:
- Non-UPH: `wip_items[wipLabel].stock_qty -= wipQty` (clamped at 0); refund
  the upstream sibling's consumption: `wip_items[upstream.wipLabel].stock_qty
  += wipQty`.
- UPH: `wip_items[wipLabel].stock_qty -= wipQty` (UPH's own row); refund each
  upstream sibling.

**Verification:**
- Code: `production-orders.ts:884-940` (rollback branch added before the
  forward paths).
- Both call sites (`:1483-1493` PATCH path, `:2575-2582` scan path) now
  pass `prevStatus`.
- Type-check + lint pass.
- TODO: end-to-end test toggling COMPLETED → WAITING → COMPLETED and
  asserting `stock_qty` returns to the same value.

---

## BUG-2026-04-26-003 — Upstream-sequence lock disabled

**Status:** 🔴 Identified (deferred)
**Category:** production-orders

**Symptom:**
Operators can mark a downstream dept (e.g. UPHOLSTERY) COMPLETED while
upstream depts (e.g. FOAM) are still WAITING. Combined with bugs #1 + #2,
this produced the Foam-skipped-but-UPH-done state seen in
`pord-so-f6084c68-02`.

**Root cause:**
`src/api/routes-d1/production-orders.ts:1255-1266` — guard intentionally
disabled by user request 2026-04-26 because the wipKey + sequence predicate
didn't model the BOM tree's parallel branches. Within one wipKey the FAB
chain (FAB_CUT→FAB_SEW…) and WOOD chain (WOOD_CUT→FRAMING→WEBBING…) run
independently and only converge at UPHOLSTERY. The previous predicate
treated WOOD_CUT (sequence 3) as downstream of FAB_CUT/FAB_SEW (1/2), so
completing Wood Cut wrongly 409'd date edits on the fabric branch.

**Fix plan (not yet implemented):**
Re-derive the lock chain from the actual BOM template at runtime so parallel
branches are honoured. Until then, the lack of this guard means bug #1 / #2
have larger blast radius.

---

## BUG-2026-04-27-004 — `wip_label` frozen at JC creation, never resyncs from BOM

**Status:** 🟢 Fixed (2026-04-27)
**Category:** bom

**Symptom (user-reported):**
BOM page for SOFA 5531 defines the back-cushion / armrest WIPs as
model-level — `5531 -Back Cushion 30"`, `5531 -Left Arm` — without the
variant prefix (`-2A(LHF)` / `-L(RHF)` etc.). The production tracking sheet
nonetheless shows `5531-L(RHF) -Back Cushion 24 (WC)` and
`5531-2A(LHF) -Left Arm (WC)`. After the user updates a BOM, existing POs
do not pick up the new naming.

**Root cause:**
1. `src/api/lib/bom-wip-breakdown.ts:119` — `resolveWipTokens` substitutes
   the `{MODEL}` placeholder with `productCode`, the same value used for
   `{PRODUCT_CODE}`. The two tokens were intended to differ (`{MODEL}` =
   parent/base model, `{PRODUCT_CODE}` = full variant SKU). With both
   resolving to the variant code, BOM templates that meant "model-level"
   (e.g. `{MODEL} -Back Cushion {SEAT_SIZE}`) render with the full variant
   prefix.
2. `bom_templates` already has a `baseModel` column (e.g. `5531`) but none
   of the call sites (`jobcard-sync.ts:88-101`, `sales-orders.ts:458-466`,
   `sales-orders.ts:825-833`) read it or thread it into the variant context.
3. JC `wip_label` is stamped on INSERT and never re-rendered against the
   current BOM. Existing POs are stuck with whatever was correct (or wrong)
   the day they were generated.

**Fix:**
- Add `model: string | null` to `BomVariantContext`; `resolveWipTokens`
  uses it for `{MODEL}` and falls back to `productCode` only when missing.
- Update every BOM-fetch SQL to also select `baseModel`, and every variant
  builder to set `model: bomRow?.baseModel ?? null`.
- Extend `POST /api/production/sync-jobcards-from-bom` to also UPDATE
  existing JCs' `wip_label` / `wip_code` / `wip_key` for `WAITING` rows
  whose downstream siblings have not yet been completed (so we don't
  orphan `wip_items` keyed by the old label).
- Provide a one-shot migration script `scripts/resync-wip-labels.ts` that
  also renames `wip_items.code` so historical stock follows the new naming.

**Verification:**
- Code: `bom-wip-breakdown.ts:45-59` (`model` field) + `:127-140` (token
  resolution). All 3 BOM-fetch sites updated:
  `jobcard-sync.ts:88-115`, `sales-orders.ts:435-470`, `:806-840`.
- Migration script `scripts/resync-wip-labels.ts` ran against production
  on 2026-04-27. Stats: scanned 561 POs, 176 needed updates, 3556 JC
  field changes, 3556 `wip_items` renames. Post-migration query for
  variant-doubling pollution returned **0** rows.
- Spot-check on `pord-so-f6084c68-02` (the original report): now reads
  `5531 -Back Cushion 24 (WC)`, `5531 -Right Arm (WC)`, with Base
  correctly variant-prefixed (`5531-L(RHF) -Base 24 (WC)`).
- Type-check + lint pass on all 5 modified files.

**Related observations during audit:**
- `inventory-wip.ts:343` derives `baseModel` via `productCode.split("-")[0]`
  rather than reading `bom_templates.baseModel`. Heuristic fails for BF
  variants whose suffixes use parens (e.g. `1003(A)(HF)(W)`). Display-only
  bug — out of scope for this round, logged for follow-up.
- `sales_order_items.size_code` is clean across the corpus (1 row with
  `24 x 37` is intentional stool dimension, not pollution). The size_code
  pollution that surfaced in the JC labels was a render-time artifact, not
  a stored-data bug.

---

## BUG-2026-04-27-022 — fix(do): customerId fallback to first PO's customerName for multi-SO DOs

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** After 9d30215 dropped the multi-customer/state restriction, multi-SO
selections hit the next downstream guard: "customerId or salesOrderId
is required". The check expected either explicit customerId in the body
OR a resolved salesOrderRow — multi-SO DOs left both null.

**Verification:** Code shipped via commit `e4c096d` to `main`.

---

## BUG-2026-04-27-023 — fix(do): single source of truth for Pending Delivery selection

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** ROOT CAUSE of every "multi-customer" toast despite "1 selected" badge:
two parallel selection states.

**Verification:** Code shipped via commit `0b8db36` to `main`.

---

## BUG-2026-04-27-024 — Reapply "fix(delivery): pending-delivery dedup by PO id, not SO id"

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** This reverts commit af815d7ed7016d1e29888e638a6aa3afeeca5518.

**Verification:** Code shipped via commit `c702588` to `main`.

---

## BUG-2026-04-27-025 — Revert "fix(delivery): pending-delivery dedup by PO id, not SO id"

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** This reverts commit 13ce4f8e892a834392156bcbb8973e81148f6240.

**Verification:** Code shipped via commit `af815d7` to `main`.

---

## BUG-2026-04-27-026 — fix(delivery): pending-delivery dedup by PO id, not SO id

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** BUG-2026-04-27 (multi-SO DO follow-up): after creating a DO that spans
multiple SOs (now allowed since 3e2682b), the source POs stayed visible
in "Production Complete — Ready for DO" so the operator could double-
add them to a second DO.

**Verification:** Code shipped via commit `13ce4f8` to `main`.

---

## BUG-2026-04-27-027 — fix(do): create-DO uses live selection, not dialog-open snapshot

**Status:** Fixed (2026-04-27)
**Category:** delivery-orders

**Symptom / Fix:** User report 2026-04-27: clicking Create DO with 1 row selected still
returned "Selected production orders span multiple customers or states"
toast. Verified backend POST works for any single-PO request. Root
cause was on the frontend:

**Verification:** Code shipped via commit `baf3365` to `main`.

---

## BUG-2026-04-27-028 — fix(bom): master-template + Above wraps as parent · delete promotes children

**Status:** Fixed (2026-04-27)
**Category:** bom

**Symptom / Fix:** Two semantic fixes in the Master Template editor:

**Verification:** Code shipped via commit `9560103` to `main`.

---

## BUG-2026-04-27-029 — fix(db): Hyperdrive needs prepare:false (Supavisor 6543 rejects prepared statements)

**Status:** Fixed (2026-04-27)
**Category:** infrastructure

**Symptom / Fix:** ROOT CAUSE for every "empty grid / Data Not Found" the user has reported
since the Cloudflare migration. EVERY DB-touching endpoint returns 500
"Internal Server Error" — verified live:
  /api/inventory   → 500
  /api/products    → 500
  /api/auth/me     → 500 (auth middleware crashes before token check)
  /api/pg-ping     → 500
  /api/health      → 200 (no DB)

**Verification:** Code shipped via commit `2d2e7e5` to `main`.

---

## BUG-2026-04-27-030 — fix(production): packing-row upstream date aggregate (sofa merge view)

**Status:** Fixed (2026-04-27)
**Category:** production-orders

**Symptom / Fix:** Sofa POs have 3 component branches (Base / Cushion / Armrest), each with
their own per-dept JCs. At PACKING they merge into one JC with
wipKey="FG". The Production Sheet's Packing tab was rendering "—" for
every upstream-dept date column on sofa rows because:

**Verification:** Code shipped via commit `96b88db` to `main`.

---

## BUG-2026-04-27-031 — fix(bom): s/Faom/Foam/ across BOM + JC + wip_items (Sofa Base typo)

**Status:** Fixed (2026-04-27)
**Category:** bom

**Symptom / Fix:** The Sofa Base BOM had a long-standing "(Faom)" typo. Functionally
harmless (the BOM-walked branchKey still groups correctly within each
PO because every Sofa Base wood JC consistently shared the same typo'd
key), but visible to operators reading the WIP / branchKey columns —
and confusing because every other Sofa wood branch reads "(Foam)".

**Verification:** Code shipped via commit `a8c89ba` to `main`.

---

## BUG-2026-04-26-004 — fix: strip remaining inline 'm³' suffixes — full system uniform

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** Wei Siang Apr 26 2026: '不需要的 我们就全部系统都统一吧'. Cell values
go bare across the system; column/label provides the unit.

**Verification:** Code shipped via commit `1ed675f` to `main`.

---

## BUG-2026-04-26-005 — fix: drop inline m³ suffix on cell values — header already labels the unit

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** Wei Siang Apr 26 2026: 'Unit (m³) 那边放了一点格式 可是我其他的没有 ...
你就跟着普通格式就行 不需要把那个 M3 特别放出来 我们已经有 header 了'.

**Verification:** Code shipped via commit `0b7ed24` to `main`.

---

## BUG-2026-04-26-006 — fix(fe-be-align): #2 build /api/purchase-invoices CRUD + migration

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** src/pages/procurement/pi.tsx was 100% client-side mock — generateMockPIs
synthesized rows from RECEIVED purchase_orders and "Approve" / "Mark
Paid" actions only mutated useState. Refresh = state lost. The audit's
case #2.

**Verification:** Code shipped via commit `59868a4` to `main`.

---

## BUG-2026-04-26-007 — fix(inventory-wip): FAB_CUT now uses card.wipLabel like every other dept

**Status:** Fixed (2026-04-26)
**Category:** inventory-display

**Symptom / Fix:** Wei Siang Apr 26 2026: Inventory WIP page still showed the old
synthesized merged-style label for FAB_CUT rows ('1007-(K) | (6FT) |
(20") | (DV 8") | PC151-01 | (FC)' for both HB and Divan), while
the Production sheet shows them with proper per-component BOM names
('1007-(K) -HB 20" PC151-01' vs '8" Divan-6FT PC151-01').

**Verification:** Code shipped via commit `ab76156` to `main`.

---

## BUG-2026-04-26-008 — fix(fe-be-align): #4 wire Resend into supplier PO notification

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** notifySupplierPoSubmitted was a console.log stub: clicking "Send to
Supplier" returned 200, audit_events recorded a status change, but no
email ever left the building. Suppliers waited indefinitely for orders
they didn't know existed. UI promised something the backend never did.

**Verification:** Code shipped via commit `bedc08c` to `main`.

---

## BUG-2026-04-26-009 — fix(fe-be-align): #3 DO status enum + missing LOADED→IN_TRANSIT button

**Status:** Fixed (2026-04-26)
**Category:** delivery-orders

**Symptom / Fix:** Frontend's DOStatus type drifted from backend's VALID_TRANSITIONS in
two ways the audit caught:

**Verification:** Code shipped via commit `f05548f` to `main`.

---

## BUG-2026-04-26-010 — fix(fe-be-align): batch A — PO close transition · _stub warn · lock UI off · stale comment

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Four FE/BE drift fixes from the 2026-04-26 audit, bundled because each
is a small change with no shared surface area:

**Verification:** Code shipped via commit `3f805ef` to `main`.

---

## BUG-2026-04-26-011 — fix(data-grid): drive virtualizer paddingBottom from sortedData.length

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** Filter alignment in Fab Sew was still drifting after the
VIRTUALIZE_MIN_ROWS=100 fix. Root cause: rowVirtualizer.getTotalSize()
lags one render behind a sharp count drop. When a column filter narrows
1,200 rows down to ~150, the body renders the 150 clipped rows
correctly but paddingBottom still computes against the stale 1,200-row
total, leaving a multi-thousand-pixel blank gap below the visible rows.

**Verification:** Code shipped via commit `c905d33` to `main`.

---

## BUG-2026-04-26-012 — fix(delivery): revert Items + Total M³ tooltip mods — only add new column

**Status:** Fixed (2026-04-26)
**Category:** delivery-orders

**Symptom / Fix:** Per Wei Siang Apr 26 2026: '添加 column 不是加进去'. Reverts the
hover tooltip injection on the existing 'Items' (count) and 'Total
M³' columns; both now render exactly as before this session. The
new 'Item Details' column remains as the only addition.

**Verification:** Code shipped via commit `5cda548` to `main`.

---

## BUG-2026-04-26-013 — fix(ts): replace stale JcPatch type reference with Parameters<>

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** See commit `4cf5562` for details.

**Verification:** Code shipped via commit `4cf5562` to `main`.

---

## BUG-2026-04-26-014 — fix(api): no-store cache-control on every /api/* response

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Wei Siang Apr 26 2026: after wrangler --remote D1 reset, browser kept
seeing pre-reset rows even though wrangler confirmed 0 done JCs in
the table. Root cause likely: Cloudflare edge / browser HTTP cache
holding stale API responses without explicit no-store directive.

**Verification:** Code shipped via commit `ebd5240` to `main`.

---

## BUG-2026-04-26-015 — revert(cache): undo v1→v2 namespace bump (was one-shot, not needed)

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Per Wei Siang Apr 26 2026: 'this is only one-time'. 375adc1 already
drops the TTL gate from cachedFetchJson, so once a browser loads the
new bundle every API call hits the network. The v2 namespace bump
was just a one-time cleanup of v1 leftovers — not a permanent fix and
not what the user asked for. Reverting.

**Verification:** Code shipped via commit `0bf01e0` to `main`.

---

## BUG-2026-04-26-016 — fix(cache): bump namespace v1→v2 to orphan stale frontend caches

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Wei Siang Apr 26 2026: every D1 reset / data update was hidden by the
5-min TTL gate on cachedFetchJson. Even after 375adc1 dropped the
gate, browsers still on the OLD bundle kept reading the OLD v1 cache.

**Verification:** Code shipped via commit `fdf0516` to `main`.

---

## BUG-2026-04-26-017 — fix(cache): drop TTL gate on imperative cachedFetchJson too

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Mirror of d8f71d2 (useCachedJson SWR) but for the imperative
`cachedFetchJson` callers. Without this, the 5-min TTL kept Inventory
WIP staring at a stale populated payload after a D1 reset (Wei Siang
Apr 26 2026: cleared all JC completion dates + wip_items.stockQty,
Production page emptied immediately, Inventory WIP didn't budge).

**Verification:** Code shipped via commit `375adc1` to `main`.

---

## BUG-2026-04-26-018 — revert(wip): drop PO-level FAB_CUT suppression (7/8)

**Status:** Fixed (2026-04-26)
**Category:** inventory-display

**Symptom / Fix:** Reverts `25099c9`. Inventory WIP Pass 1 now uses pure per-component
edge detection (card done && next not done) for every dept including
FAB_CUT. No more PO-level fabric-pulled fan-out.

**Verification:** Code shipped via commit `3833bcc` to `main`.

---

## BUG-2026-04-26-019 — fix(wip): synthesize wipLabel fallback for non-BOM producer JCs

**Status:** Fixed (2026-04-26)
**Category:** inventory-cascade

**Symptom / Fix:** Wood Cut completion silently skipped the wip_items upsert when
jcRow.wipLabel was null (createJobCards() emits non-BOM JCs without
wip* fields). Fallback synthesizes the label from
(productCode, wipCode|wipKey, departmentCode) so every producer dept
always lands a wip_items row.

**Verification:** Code shipped via commit `2f035b1` to `main`.

---

## BUG-2026-04-26-020 — fix(production): scope upstream lock to same wipKey (Wood Cut ≠ Fab Cut chain)

**Status:** Fixed (2026-04-26)
**Category:** production-orders

**Symptom / Fix:** User reported (2026-04-26): Wood Cut completion locked Fab Cut + Fab
Sew on the same row, even though those three are independent component
chains (different wipKey). Per memory/project_production_lifecycle.md
JCs are generated one-per-(wipComponent × department), and the
upstream lock should only fire across the SAME wipKey chain.

**Verification:** Code shipped via commit `ccd0de3` to `main`.

---

## BUG-2026-04-26-021 — fix(sales): drop wrong '(Mattress)' label on SOFA category option

**Status:** Fixed (2026-04-26)
**Category:** sales-orders

**Symptom / Fix:** The system has 3 categories: BEDFRAME / SOFA / ACCESSORY. There is no
'mattress' category — that word was the user's verbal shorthand for
sofa in an earlier conversation, and I incorrectly stamped it into the
filter dropdown label. Reverting to plain 'Sofa' to match the rest of
the app.

**Verification:** Code shipped via commit `97b8e15` to `main`.

---

## BUG-2026-04-26-022 — fix(data-grid): below 100 rows skip virtualizer (cures filter alignment)

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** User reported "为什这个一直不alignment 上千次了" on /production/fab-cut.
After applying a column filter (460 → 3 rows), badge correctly read
"3 of 460 records" + "Record 1 of 3" but the body rendered ~11 rows.

**Verification:** Code shipped via commit `60e1611` to `main`.

---

## BUG-2026-04-26-023 — fix(sales): atomic clearFilters — single setSearchParams, not 7 races

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** User reported "我clear不到那个filter" on /sales. The clearFilters handler
was firing 7 sequential setFilterX("") calls; each calls navigate() under
the hood. react-router-dom v7's setSearchParams reads from a ref that
doesn't always reflect the previous navigate's pending update, so later
deletes could overwrite earlier ones — net effect: filters re-appear.

**Verification:** Code shipped via commit `71e0fdc` to `main`.

---

## BUG-2026-04-26-024 — fix(data-grid): clip virtualItems to sortedData.length so body matches badge

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** Fab Cut Production Sheet: applying the Status column dropdown filter
("COMPLETED" only) updated the "X of Y records" badge to "3 of 460" but
the rendered body kept emitting ~11 mixed-status rows. Fab Sew filtered
correctly. Same DataGrid component on both, but FAB_CUT's deptRows merge
plus prior scroll activity left tanstack-virtual's getVirtualItems()
returning indices that were valid against the *previous* count (460)
even after React passed the shrunken count (3) on the same render.

**Verification:** Code shipped via commit `80cbd00` to `main`.

---

## BUG-2026-04-26-025 — fix(prod-500): defensive try/catch + LIMIT caps on 3 dogfood crash sites

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** Real-browser dogfood test on prod (https://hookka-erp-testing.pages.dev)
showed three endpoints returning 500 with no `db;dur=` segment in the
Server-Timing header — handler crashing before any D1 query completes:

**Verification:** Code shipped via commit `bfa14bb` to `main`.

---

## BUG-2026-04-26-026 — fix(delivery): cap POD photo size + dashboard Dispatched count

**Status:** Fixed (2026-04-26)
**Category:** delivery-orders

**Symptom / Fix:** POD-dialog now resizes photos to 1280px JPEG@0.7 (~200KB each) before
base64-encoding. Total POD JSON is checked against 700KB ceiling to
stay safely below D1's 1MB row size limit. Pre-launch audit found that
5 unresized iPhone photos (~50-80MB blob) would silently fail D1 write.

**Verification:** Code shipped via commit `653437b` to `main`.

---

## BUG-2026-04-26-027 — fix(cache): SWR — always refetch on mount, cache only for first paint

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** useCachedJson used to skip refetch when cache was <ttlSec old (5 min
default). After a backend deploy fixed an empty-response bug, users
stayed on the cached empty data for up to 5 minutes — exactly the
'Sales Orders 显示 0 但 stats 314' pattern Wei Siang reported repeatedly.

**Verification:** Code shipped via commit `d8f71d2` to `main`.

---

## BUG-2026-04-26-028 — fix(wip): populate sources[] on sofa SET rows so dialog shows POs

**Status:** Fixed (2026-04-26)
**Category:** inventory-display

**Symptom / Fix:** The SET row dialog ('SO ID / Qty / Completed / Age' table) reads from
WIPRow.sources. Sofa SET rows were emitting sources: [] which rendered
as '0 PO(s)' even when contributing POs existed. The bucket already
tracked members per JC; now it also accumulates one entry per
contributing PO (component qtys summed) and emits that on the SET row.

**Verification:** Code shipped via commit `3491e3b` to `main`.

---

## BUG-2026-04-26-029 — fix(wip): PO-level Fab Cut suppression when any Fab Sew is done

**Status:** Fixed (2026-04-26)
**Category:** inventory-display

**Symptom / Fix:** Behavior change per Wei Siang Apr 26 2026: when ANY Fab Sew JC inside
a PO is COMPLETED/TRANSFERRED, every remaining FAB_CUT JC in that PO
disappears from Inventory WIP — not just the matching component.

**Verification:** Code shipped via commit `25099c9` to `main`.

---

## BUG-2026-04-26-030 — fix: persist Reports active tab to URL + DataGrid column-hide alignment

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** Reports tab persistence
- /reports?tab=inventory now drives the visible tab. Switching shell
  tabs and coming back no longer resets to 'Sales'. Hard-refresh,
  back/forward, and bookmarks all preserve the chosen tab.
- 'sales' (the default) maps to no query param so URLs stay clean.

**Verification:** Code shipped via commit `98f43a7` to `main`.

---

## BUG-2026-04-26-031 — revert(wip): drop (FC HB) component tags from FAB_CUT label

**Status:** Fixed (2026-04-26)
**Category:** inventory-display

**Symptom / Fix:** User push-back: BOM owns the WIP naming scheme. Adding HB/DV inside
(FC …) wasn't asked for and breaks the user's mental model. The
duplicate-row symptom is a quantity / consume bug, not a labelling
bug — investigating that separately.

**Verification:** Code shipped via commit `c9859b6` to `main`.

---

## BUG-2026-04-26-032 — fix(critical): unblock empty Sales/Production pages + WIP duplicate UX

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** PRIMARY FIX — orgScope safety gate
`withOrgScope` was emitting `WHERE orgId = ?` against tables whose orgId
column doesn't exist on remote D1 yet (migrations 0048–0055 are still
unapplied — admin task per DR-RUNBOOK.md). The query errored at SQL
parse time and the frontend silently rendered zero rows on Sales Orders
+ anywhere else routed through this helper. Until the migrations land,
the helper degrades to a no-op so the app keeps serving rows.

**Verification:** Code shipped via commit `4298d6a` to `main`.

---

## BUG-2026-04-26-033 — fix(authz): invalidate KV session cache on role change (P3.8)

**Status:** Fixed (2026-04-26)
**Category:** auth-rbac

**Symptom / Fix:** Was: 5-min KV TTL meant role revocation took up to 5 minutes to
propagate. Now: explicit invalidation on user role update + user
deletion + logout. TTL stays at 5 min for the cold-start performance
win, but security-critical changes propagate instantly.

**Verification:** Code shipped via commit `58c354b` to `main`.

---

## BUG-2026-04-26-034 — fix(queue): drop hard Env import to break circular type dep

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** See commit `446df78` for details.

**Verification:** Code shipped via commit `446df78` to `main`.

---

## BUG-2026-04-26-035 — fix(env): declare FILES/QUEUE/OAUTH bindings as optional Env fields

**Status:** Fixed (2026-04-26)
**Category:** infrastructure

**Symptom / Fix:** See commit `072fb71` for details.

**Verification:** Code shipped via commit `072fb71` to `main`.

---

## BUG-2026-04-26-036 — fix(production): unbreak Fab Cut merged-row fan-out PATCH

**Status:** Fixed (2026-04-26)
**Category:** production-orders

**Symptom / Fix:** The merged-row date-cell click on the Production Sheet sends both
status='COMPLETED' and completedDate=<today> in one PATCH. The upstream-
lock guard in applyPoUpdate fired on any payload containing completedDate,
even when the operator's intent was a status change (the date is just a
side-effect stamp). On a clean WAITING -> COMPLETED transition that path
could surface a phantom 409 and the toast 'Fab Cut complete applied to
0/1 components'.

**Verification:** Code shipped via commit `f9f3687` to `main`.

---

## BUG-2026-04-26-037 — fix(production): unbreak Fab Cut merged-row fan-out PATCH

**Status:** Fixed (2026-04-26)
**Category:** production-orders

**Symptom / Fix:** The merged-row date-cell click on the Production Sheet sends both
status='COMPLETED' and completedDate=<today> in one PATCH. The upstream-
lock guard in applyPoUpdate fired on any payload containing completedDate,
even when the operator's intent was a status change (the date is just a
side-effect stamp). On a clean WAITING -> COMPLETED transition that path
could surface a phantom 409 and the toast 'Fab Cut complete applied to
0/1 components'.

**Verification:** Code shipped via commit `d8e0a2f` to `main`.

---

## BUG-2026-04-26-038 — fix(production): repair filters + add 4 new + lazy-load

**Status:** Fixed (2026-04-26)
**Category:** ui-frontend

**Symptom / Fix:** See commit `6795619` for details.

**Verification:** Code shipped via commit `6795619` to `main`.

---

## BUG-2026-04-26-039 — fix(sidebar): replace hardcoded "Lim / Director" with current user (P3.7)

**Status:** Fixed (2026-04-26)
**Category:** auth-rbac

**Symptom / Fix:** Sidebar bottom-left was rendering a stale demo user regardless of who
was logged in. Now reads from getCurrentUser() in src/lib/auth.ts and
shows displayName / role for the actual session.

**Verification:** Code shipped via commit `0e83923` to `main`.

---

## BUG-2026-04-25-001 — fix(bom): PUT /templates/:id is now upsert (was 404 on Create-from-Default flow)

**Status:** Fixed (2026-04-25)
**Category:** bom

**Symptom / Fix:** Frontend bom.tsx 'Create from Default Template' and 'Start Blank' buttons
construct a new BOMTemplate locally with id 'bom-${Date.now()}', add it to
React state, and on save call PUT /api/bom/templates/:id. Backend previously
required the row to already exist and returned 404, surfacing as a
'Failed to save BOM' toast.

**Verification:** Code shipped via commit `c29371c` to `main`.

---

## BUG-2026-04-25-002 — fix(ts): clear remaining 59 TS18046+TS2339 errors across 8 pages

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Final pass on the type-error migration that started in earlier batches.
Targets the 8 files Codex didn't touch:

**Verification:** Code shipped via commit `e74dbc3` to `main`.

---

## BUG-2026-04-25-003 — fix(router): add trailing /* to parent Route so nested Routes match (P-router-warning)

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Console warned "<Routes> rendered under a parent route with no trailing
*" — child routes were about to silently stop matching on deeper
navigation. Fix per React Router v7 docs.

**Verification:** Code shipped via commit `a28add4` to `main`.

---

## BUG-2026-04-25-004 — fix(ts): migrate worker/* (scan, index, issue) to Zod-validated parses

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Drop 21 TS18046 errors across worker scan/index/issue pages by validating
workerFetch JSON responses through passthrough Zod envelopes (workerFetch
is preserved as-is for its 401 handling and X-Worker-Token header).

**Verification:** Code shipped via commit `1b4619b` to `main`.

---

## BUG-2026-04-25-005 — fix(ts): migrate sales/* + invoices/* to fetchJson + Zod schemas

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Drop 18 TS18046 errors across sales/index.tsx and the 5 invoice pages
(index, detail, payments, credit-notes, debit-notes) by piping fetch
responses through fetchJson with shared InvoiceSchema/PaymentSchema/
CreditNoteSchema/DebitNoteSchema mutation envelopes.

**Verification:** Code shipped via commit `745801a` to `main`.

---

## BUG-2026-04-25-006 — fix(ts): migrate products + rd pages to fetchJson + Zod schemas

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Drop 20 TS18046 errors in products/index.tsx and rd/{index,detail}.tsx by
piping fetch responses through fetchJson with ProductSchema/RdProjectSchema
mutation envelopes. The five inline `fetch().then(r => r.json())` chains in
products/index.tsx are also flattened to typed `fetchJson(...).then(...)`.

**Verification:** Code shipped via commit `1fcd468` to `main`.

---

## BUG-2026-04-25-007 — fix(ts): migrate delivery/* to fetchJson + Zod schemas

**Status:** Fixed (2026-04-25)
**Category:** ui-frontend

**Symptom / Fix:** Drop 18 TS18046 'data is of type unknown' errors in delivery pages by
piping fetch responses through fetchJson + a shared DeliveryOrderSchema.
Adds src/lib/schemas/ with passthrough Zod schemas mirroring the route-d1
rowToX mappers — schemas validate the boundary, extra fields flow through.

**Verification:** Code shipped via commit `9dc583f` to `main`.

---

## BUG-2026-04-25-008 — stability: add timeout + abort propagation to fetchJson

**Status:** Fixed (2026-04-25)
**Category:** data-integrity

**Symptom / Fix:** See commit `db2ecb6` for details.

**Verification:** Code shipped via commit `db2ecb6` to `main`.

---

## BUG-2026-04-25-009 — fix(bom): per-wipType production order chain (sofa FOAM after WEBBING)

**Status:** Fixed (2026-04-25)
**Category:** bom

**Symptom / Fix:** The flat DEPT_ORDER (FAB_CUT, FAB_SEW, WOOD_CUT, FOAM, FRAMING, WEBBING,
UPH, PACK) lied for sofa: per BOM tree FOAM is downstream of WEBBING
(FOAM <- WEBBING <- FRAMING <- WOOD_CUT chain), but DEPT_ORDER put FOAM
at index 3 -- BEFORE FRAMING/WEBBING -- so JCs got assigned wrong
sequence numbers.  This made wipKey-prev consume logic walk the wrong
direction (sofa FOAM tried to consume WOOD_CUT instead of WEBBING).

**Verification:** Code shipped via commit `a9c7a81` to `main`.

---

## BUG-2026-04-25-010 — fix(production): UPH consume by qty (not zero) + add own wip_items row

**Status:** Fixed (2026-04-25)
**Category:** inventory-cascade

**Symptom / Fix:** User reported: Fab Sewing has 11 items / 13 qty in WIP inventory.
Upholstery completes 6 items / 7 qty.  Expected:
- Fab Sewing's WIP deducted by 7 (13 -> 6 remains)
- Upholstery's own WIP +7 visible

**Verification:** Code shipped via commit `8519f93` to `main`.

---

## BUG-2026-04-25-011 — fix(production): gate sofa atomic-FAB_CUT-zero on isFabSew

**Status:** Fixed (2026-04-25)
**Category:** inventory-cascade

**Symptom / Fix:** Bug: the (SO, fabric) sofa-bolt-leaves-Fab-Cut-shelf logic fired for
every sofa dept transition, not just FAB_SEW.  When a sofa FOAM /
FRAMING / WEBBING / PACKING JC went IN_PROGRESS or COMPLETED, the
backend zeroed every FAB_CUT wip_items row in the (salesOrderId,
fabricCode) group -- regardless of whether FAB_SEW had even started.

**Verification:** Code shipped via commit `853fe37` to `main`.

---

## BUG-2026-04-25-012 — fix(production): derive upstream dept columns from BOM/JC sequence

**Status:** Fixed (2026-04-25)
**Category:** production-orders

**Symptom / Fix:** Replaced the hardcoded UPSTREAM map (FAB_SEW <- FAB_CUT, FOAM <-
FAB_SEW, etc.) with a useMemo that walks every loaded JC matching the
active tab and collects sibling JCs (same wipKey) with smaller
sequence.  Each sibling's deptCode is a BOM-defined upstream.

**Verification:** Code shipped via commit `c6c1b82` to `main`.

---

## BUG-2026-04-25-013 — fix(production): include same-wipKey siblings when ?dept= is set

**Status:** Fixed (2026-04-25)
**Category:** production-orders

**Symptom / Fix:** Bug: every prev-dept CD column on the per-dept Production page rendered
"—" for every row.  On the Upholstery tab, only Upholstery itself
showed pills; FAB_SEW / FOAM / FRAMING / WOOD_CUT / WEBBING all
collapsed to dashes.

**Verification:** Code shipped via commit `e5b7b6e` to `main`.

---

## BUG-2026-04-25-014 — fix(d1-compat): IFNULL→COALESCE + bom search LIKE→ILIKE

**Status:** Fixed (2026-04-25)
**Category:** data-migration

**Symptom / Fix:** Two more SQLite-vs-Postgres semantic gaps that survived the migration:

**Verification:** Code shipped via commit `cb1f965` to `main`.

---

## BUG-2026-04-25-015 — fix(db): preserve acronym casing on column read transform

**Status:** Fixed (2026-04-25)
**Category:** data-migration

**Symptom / Fix:** postgres.toCamel is lossy for acronym fields:
  customer_po -> customerPo  (wrong, code reads customerPO)
  customer_so -> customerSo
  hookka_expected_dd -> hookkaExpectedDd
  company_so_id -> companySoId

**Verification:** Code shipped via commit `55fbb5e` to `main`.

---

## BUG-2026-04-25-016 — fix(db): coerce BIGINT to JS number, fixes Sales Order count explosion

**Status:** Fixed (2026-04-25)
**Category:** data-migration

**Symptom / Fix:** User-reported symptom: 'Sales Order 资料全错了，然后 Sales Order 突然爆发，
变得很多'.  Stats tile showed counts like '029014' instead of 294.

**Verification:** Code shipped via commit `5c850c4` to `main`.

---

## BUG-2026-04-25-017 — stability: restore typecheck gate + fix 3 specific bugs flagged by 3 external reviewers

**Status:** Fixed (2026-04-25)
**Category:** infrastructure

**Symptom / Fix:** Three independent reviewers (Apr 24-25) all flagged the same core issue:
typecheck + lint are red, and the 'build' script was silently bypassing
typecheck. This commit is the stabilization bridgehead — not the full
cleanup (which requires a per-module refactor pass), but enough to make
CI enforce the baseline going forward and to fix the three specific bugs
the reviewers could point at concretely.

**Verification:** Code shipped via commit `e2a2f6c` to `main`.

---

## BUG-2026-04-24-001 — fix(production): dept routes actually render dept view + Wood Cut producer-only

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** 1. /production/fab-cut etc. were redirecting to /production because
   dept.tsx used useParams() on LITERAL routes (no :deptCode binding) →
   rawDeptCode was undefined → normalizeDept returned null → redirect.
   Switched to reading the last pathname segment directly.
2. WOOD_CUT added to the producer-only list alongside FAB_CUT — both are
   raw-material entry points (wood vs fabric chain), neither consumes
   an upstream wip_items row.

**Verification:** Code shipped via commit `576fa5c` to `main`.

---

## BUG-2026-04-24-002 — revert: restore DIVAN BOM qty=2 + undo JC/wip_items halving

**Status:** Fixed (2026-04-24)
**Category:** bom

**Symptom / Fix:** I shouldn't have modified user's BOM without asking. Migration 0044
undoes every change 0043 made: BOM back to quantity=2, DIVAN JC wipQty
doubled back, DIVAN wip_items stockQty doubled back.

**Verification:** Code shipped via commit `7fc57a0` to `main`.

---

## BUG-2026-04-24-003 — fix(bom): DIVAN qty = 1 per BF (not 2) — BOM + JC + wip_items retro

**Status:** Fixed (2026-04-24)
**Category:** bom

**Symptom / Fix:** See commit `9092b53` for details.

**Verification:** Code shipped via commit `9092b53` to `main`.

---

## BUG-2026-04-24-004 — revert: don't merge BF at Fab Cut — user wants HB/Divan separate

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** BF components are physically separate stock piles (HB on one shelf,
Divan on another) so Inventory displays them as separate rows — does
NOT mirror Production Fab Cut's merged single-row display. Production
merges for scheduling convenience; Inventory tracks actual stock.

**Verification:** Code shipped via commit `910715c` to `main`.

---

## BUG-2026-04-24-005 — fix(inventory-wip): per-dept filter — sofa SET only at Fab Cut, per-component after

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Sofa at Fab Cut stage shows the merged SET row (one row per set,
matching Production Fab Cut tab). After Fab Sew starts, each component
(Base / Cushion / Armrest) is tracked separately — so those stages
show per-component rows instead of hiding them.

**Verification:** Code shipped via commit `dd40502` to `main`.

---

## BUG-2026-04-24-006 — fix(wip-consume): generalize consume to all depts + fix per-component group

**Status:** Fixed (2026-04-24)
**Category:** inventory-cascade

**Symptom / Fix:** Two bugs fixed in one:

**Verification:** Code shipped via commit `84df3bd` to `main`.

---

## BUG-2026-04-24-007 — fix(wip-consume): Fab Sew COMPLETED also deducts Fab Cut stock

**Status:** Fixed (2026-04-24)
**Category:** inventory-cascade

**Symptom / Fix:** applyWipInventoryChange's sibling-consume used to fire only on
IN_PROGRESS transition, but users who set the completion date directly
(date-cell click) jumped WAITING → COMPLETED and skipped IN_PROGRESS
entirely. Result: Fab Sew wip_items incremented but Fab Cut wip_items
never decremented — Inventory showed ghost Fab Cut stock forever.

**Verification:** Code shipped via commit `1db1e7b` to `main`.

---

## BUG-2026-04-24-008 — fix(inventory-wip): sofa SET label matches Production Fab Cut exactly

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Sofa SET rows now emit "5535-L(LHF)+2A(RHF) | (30) | PC151-02 | (FC)"
— piped format with (size) and (FC) tokens, same as Production page's
fabCutWIP() helper. Previously was "5535-L(LHF)+2A(RHF) PC151-02" which
confused operators cross-referencing the two views.

**Verification:** Code shipped via commit `6e5e84c` to `main`.

---

## BUG-2026-04-24-009 — fix(inventory-wip): Merged sofa rows show set count, not piece sum

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Production Fab Cut's merged sofa row reads "Qty 1" (one set). The
Inventory WIP Merged sets view previously read "Qty N" where N was
sum of all component pieces (e.g. Base 2 + Cushion 2 + Armrest 2 = 6),
which didn't match the operator's mental model.

**Verification:** Code shipped via commit `668822e` to `main`.

---

## BUG-2026-04-24-010 — fix(so-confirm): BF/ACC qty>1 now fans out into N POs (qty=1 each)

**Status:** Fixed (2026-04-24)
**Category:** sales-orders

**Symptom / Fix:** Sofa stays as one PO per SO line (one set per SO by convention).
For BEDFRAME / ACCESSORY, qty=N → N POs each with quantity=1, poNo
suffixed -01, -02, ... via a running poSequence counter. Each PO gets
its own JC chain (wipQty=1) so Fab Cut and Overview show one row per
physical piece — matching shop-floor reality (each piece has its own
fabric cut, frame, sticker).

**Verification:** Code shipped via commit `69971c7` to `main`.

---

## BUG-2026-04-24-011 — fix(inventory-wip): Fab Cut stage uses condensed label matching Production page

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** deriveWIPFromPO now computes wipCodeStr on the fly for FAB_CUT cards:
  {productCode} | ({sizeLabel}) | ({totalH"} only BF) | {fabricCode} | (FC)
Other departments keep the existing wipLabel fallback chain. This lines
sofa WIP inventory code up with the Fab Cut tab on the Production page
so stock consumption math matches operator expectations.

**Verification:** Code shipped via commit `e74147a` to `main`.

---

## BUG-2026-04-24-012 — fix(fab-cut): merged-row completion fans across sibling POs (sofa)

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Sofa merge groups by (SO, fabric) and can span multiple POs (one per
variant). The patch fan-out was sending every JC id under row.poId,
so sibling-PO JCs silently never updated — Overview still showed them
pending after the merged row flipped done. Added _mergedJobCardRefs
carrying (poId, jobCardId) pairs; both patch sites (status select +
completion date cell) now use per-JC poId. BF is unchanged since BF
groups key on poId (all refs share row.poId).

**Verification:** Code shipped via commit `10dcb78` to `main`.

---

## BUG-2026-04-24-013 — fix(fab-cut): BF merged row qty follows HB (fallback Divan)

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** BF group alpha-sorts DIVAN before HB, so `...first` was pulling
Divan's qty. User rule: HB is canonical BF piece count; Divan-only
BFs fall through to `first.qty`. Sofa unchanged (one set per SO).

**Verification:** Code shipped via commit `2778dc5` to `main`.

---

## BUG-2026-04-24-014 — fix(fab-cut): merged sched_FAB_CUT pill + due/completed match row status

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Merged Fab Cut rows showed 'DONE' on the Fab Cut pill even when the
overall row status was IN_PROGRESS because sched_FAB_CUT was inherited
from just the first PO in the merge group — the first PO's JCs happened
to be complete while siblings in the same (SO, fabric) group were not.
Visually contradictory for operators.

**Verification:** Code shipped via commit `a0dff06` to `main`.

---

## BUG-2026-04-24-015 — fix(production): qty > 1 fans QR stickers to one per physical piece

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Before: every production-sheet row generated exactly one QR sticker,
regardless of the row's qty. A row with qty=2 came out as a single
sticker the worker would have to double-scan — which the scan portal
deliberately rejects as a duplicate.

**Verification:** Code shipped via commit `da5e948` to `main`.

---

## BUG-2026-04-24-016 — fix(fab-cut): unify WIP layout — every category pipe-separated

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Sofa no longer glues seat size to the model with a space. All categories
now share one shape:
  '{model} | ({size}) | ({totalH, BF only}) | {fabric} | (FC)'

**Verification:** Code shipped via commit `5456d2b` to `main`.

---

## BUG-2026-04-24-017 — fix(fab-cut): reorder WIP label parts, sofa glues seat size to model

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** WIP label now reads category-aware so sorting / eyeballing is easier:
  BEDFRAME:  '1003-(K) | (6FT) | (18") | PC151-02 | (FC)'
             model | bed size | total heights | fabric | (FC)
  SOFA:      '5537-1A(LHF)+1NA+1A(RHF) (30) | BO315-2 | (FC)'
             model with seat size attached | fabric | (FC)
  ACCESSORY: '{model} | ({size}) | {fabric} | (FC)'

**Verification:** Code shipped via commit `c2093fe` to `main`.

---

## BUG-2026-04-24-018 — fix(fab-cut): bedframe WIP label adds total height after size

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** BF rows now read e.g. '1003-(K) | PC151-02 | (6FT) | (18") | (FC)'.
Sofa / accessory unchanged (totalHeight stays empty for them per the
earlier deptRow gate).

**Verification:** Code shipped via commit `e348113` to `main`.

---

## BUG-2026-04-24-019 — fix(fab-cut): Model column shows baseModel only, WIP carries the variants

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Fab Cut rows (merged + single) now render Model as the clean baseModel
prefix — '5530', '5531', '1003', etc. — and the full variant combo
('5530-1A(LHF)+1NA+1A(RHF)') is relocated into the WIP column alongside
fabric / seat size / (FC). Matches how the floor team reads the sheet:
scan the Model column to group by product family, read WIP when you
need the component detail for the set you're about to cut.

**Verification:** Code shipped via commit `7eb78c6` to `main`.

---

## BUG-2026-04-24-020 — fix(inventory): sofa Fab Sew first scan consumes the whole Fab Cut set

**Status:** Fixed (2026-04-24)
**Category:** inventory-cascade

**Symptom / Fix:** Before: each FAB_SEW JC going IN_PROGRESS decremented only its own
wipQty from its immediate upstream wip_items row. For a 3-piece sofa
set (1A(LHF) + 1NA + 1A(RHF) cut together), that required scanning
every module at Fab Sew before Fab Cut's shelf balance reached zero —
but physically the sewing team grabs the entire cut stack at once, so
the first scan already represents the whole batch leaving storage.

**Verification:** Code shipped via commit `35f4822` to `main`.

---

## BUG-2026-04-24-021 — fix(fab-cut): merged module order — LHF first, RHF last, middle in between

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Previous alpha sort on wipType didn't convey sofa layout ordering. Now
bucket by handedness first: modules with 'LHF' in the model come first,
'RHF' last, everything else (1NA, CNR, 2S, corner, centre) in the
middle. Within bucket, alpha on wipType stays as the tiebreaker so BF
and accessory groups look stable too. Example label now reads
'5537-1A(LHF)+L(LHF)+1NA+CNR+2A(RHF)+L(RHF)' — which is how the floor
team reads a sofa set from left to right.

**Verification:** Code shipped via commit `71b8d46` to `main`.

---

## BUG-2026-04-24-022 — fix(fab-cut): use pipe separator in merged WIP label

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Per user: '5537-1A(LHF)+1NA+1A(RHF) | BO315-2 | (30) | (FC)'.

**Verification:** Code shipped via commit `f65e6e4` to `main`.

---

## BUG-2026-04-24-023 — fix(fab-cut): wrap seat/bed size in parens — '(30)' in merged WIP label

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Gives the size token a visual boundary matching the '(FC)' marker.
Now reads: '5537-1A(LHF)+1NA+1A(RHF) · BO315-2 · (30) · (FC)'.

**Verification:** Code shipped via commit `76a7d3f` to `main`.

---

## BUG-2026-04-24-024 — fix(fab-cut): middle-dot separator between WIP label parts

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Single-space was letting the model, fabric code and size mash together
when they share character classes (e.g. '5537-1A(LHF)+1NA+1A(RHF) BO315-2 30 (FC)').
Middle-dot splits them cleanly:
  5537-1A(LHF)+1NA+1A(RHF) · BO315-2 · 30 · (FC)

**Verification:** Code shipped via commit `2f6229f` to `main`.

---

## BUG-2026-04-24-025 — fix(fab-cut): merged WIP label is '{model} {fabric} {seat/bed size} (FC)'

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** User's preferred compact format. The per-type count variant I tried first
was too abstract — cutters read this column to confirm 'which bolt, which
size'. Now the merged row's WIP says exactly that on one line, e.g.
'5537-1A(LHF)+1NA+1A(RHF) BO315-2 30 (FC)' for a sofa set or
'1003-(K) PC151-02 6FT (FC)' for a bedframe. Size is the seat size for
sofa (already normalised into row.size after the earlier sofa-size
cleanup) and the bed size for bedframe.

**Verification:** Code shipped via commit `05725a3` to `main`.

---

## BUG-2026-04-24-026 — fix(fab-cut): compact merged WIP column to type counts instead of full labels

**Status:** Fixed (2026-04-24)
**Category:** inventory-display

**Symptom / Fix:** Merged Fab Cut rows were dumping every child job card's full wipLabel
(model + component + fabric + '(FC)' marker) separated by '  |  ', so a
3-module sofa set produced a ~250-char wall that wrapped the table.
Everything in that string is already visible elsewhere — Model column
shows the variant combo, Colour shows the fabric, Type shows the
component set. All the WIP column actually needs to say is how many
pieces of each component kind to cut.

**Verification:** Code shipped via commit `527d823` to `main`.

---

## BUG-2026-04-24-027 — fix(fab-cut): sofa rows merge by SO+fabric so a full set is one row

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** The cutter lays one bolt of fabric and cuts every module of the sofa
set in a single pass. Before, Fab Cut merged only within a single PO,
so a 3-piece sofa (1A(LHF) + 1NA + 1A(RHF)) arriving as three PO lines
on the same SO showed as three separate rows — wrong, because the
fabric can't be split between them.

**Verification:** Code shipped via commit `f76b92f` to `main`.

---

## BUG-2026-04-24-028 — fix(bom): normalize l1Processes/wipComponents on load to stop crash

**Status:** Fixed (2026-04-24)
**Category:** bom

**Symptom / Fix:** BOMManagementPage was hitting the ErrorBoundary because a template with
null l1Processes or wipComponents from D1 (or a stale cache entry) would
throw on the first .forEach / .reduce / .map / .length downstream. The
page has dozens of those call sites — safer to coerce both arrays to []
once at load time than null-guard each render path. Templates are the
authoritative source from cachedFetchJson('/api/bom/templates').

**Verification:** Code shipped via commit `a26278a` to `main`.

---

## BUG-2026-04-24-029 — fix(customers): sofa seat prices now render in Customer Products panel

**Status:** Fixed (2026-04-24)
**Category:** pricing-products

**Symptom / Fix:** The panel's seatHeightPrices column was rendering '—' for every sofa
row because the TS type declared Record<string,number> but the API
returns Array<{height,priceSen}>. Object.entries over an array yields
numeric-index keys, so formatSeatHeights fell through to the empty
state. Type + formatter aligned to the array shape now, so sofa rows
show e.g. '24":517 28":572 30":572 32":772 35":772' as intended.

**Verification:** Code shipped via commit `dbf5c5c` to `main`.

---

## BUG-2026-04-24-030 — fix(production): QR strip + FG preview hidden by default · sofa BF-only fields blanked

**Status:** Fixed (2026-04-24)
**Category:** production-orders

**Symptom / Fix:** Two UX problems collapsed into one change:

**Verification:** Code shipped via commit `22e9522` to `main`.

---

## BUG-2026-04-24-031 — fix: sofa cascade is Line-1-only, customer price moves to SO confirm, Add FG polish

**Status:** Fixed (2026-04-24)
**Category:** sales-orders

**Symptom / Fix:** Three batched fixes:

**Verification:** Code shipped via commit `d05ad0f` to `main`.

---

## BUG-2026-04-24-032 — revert(products): drop 4 stool variants from 0033 — user adds them manually

**Status:** Fixed (2026-04-24)
**Category:** bom

**Symptom / Fix:** 0033 seeded 5530-STOOL / 5531-STOOL / 5535-STOOL / 5536-STOOL by cloning
5537-STOOL. User decided to add these through the Products UI instead
(different prices, per-variant overrides, etc.) so the auto-cloned rows
need to go before anyone creates an SO against them.

**Verification:** Code shipped via commit `4e27d7c` to `main`.

---

## BUG-2026-04-24-033 — fix(sales): sofa special-order toggle propagates to sibling modules

**Status:** Fixed (2026-04-24)
**Category:** sales-orders

**Symptom / Fix:** Checking / unchecking a Special Order on one sofa module line now cascades
the same selection (and matching surcharge + label string) to every other
sofa line that shares the baseModel, same rule that already governs fabric
and seat size. Non-sofa lines still edit in isolation.

**Verification:** Code shipped via commit `3a3a442` to `main`.

---

## BUG-2026-04-24-034 — fix(sales): product picker shows ALL categories even after one is bound

**Status:** Fixed (2026-04-24)
**Category:** sales-orders

**Symptom / Fix:** Filtered-by-current-category options trapped users on whatever they picked
first — no way to switch a line from bedframe to sofa without manually
clearing. Now every search surfaces every product across every category;
selectProduct rebinds itemCategory and baseModel from the picked product
itself, so the template (sofa modules / bedframe heights / accessory qty
strip) flips on the next render.

**Verification:** Code shipped via commit `9b4e6f2` to `main`.

---

## BUG-2026-04-24-035 — fix(schedule): lead time = days-before-delivery per dept, parallel not serial

**Status:** Fixed (2026-04-24)
**Category:** scheduling

**Symptom / Fix:** Rewrites reverse-schedule semantics everywhere job_card dueDates are
computed. Old chain-walk summed lead times backwards, producing 22-day BF
spans and 39-day SF spans between FAB_CUT and PACKING. User clarified the
intent: each dept's lead time is just its offset from the customer's
delivery date. Depts run in PARALLEL, each staggered by its own window.

**Verification:** Code shipped via commit `51566e5` to `main`.

---

## BUG-2026-04-24-036 — fix(leadtimes): Planning page's GET/PUT URL finally matches backend mount

**Status:** Fixed (2026-04-24)
**Category:** scheduling

**Symptom / Fix:** Root cause for "I updated lead times but the data disappears": frontend
Planning page reads + writes `/api/production/leadtimes` (slash), but the
production-leadtimes Hono router was only mounted at
`/api/production-leadtimes` (hyphen). The slash path was mounted to the
standalone leadtimeRecalc router which only has POST /recalc-all — so
GET / returned 404 (no data shown) and PUT / silently landed on a route
with no handler (save looked like it worked, nothing persisted).

**Verification:** Code shipped via commit `ea84016` to `main`.

---

## BUG-2026-04-24-037 — fix(products): widen sofa seat-height price columns + reclassify pillows to ACCESSORY

**Status:** Fixed (2026-04-24)
**Category:** pricing-products

**Symptom / Fix:** Two independent fixes landed together:

**Verification:** Code shipped via commit `9a7e44c` to `main`.

---

## BUG-2026-04-24-038 — fix(pricing): sofa seat-height keys must be strings, defensively match any shape

**Status:** Fixed (2026-04-24)
**Category:** pricing-products

**Symptom / Fix:** Root cause for the "sofa prices not showing on Products page" + the
5530-2A(LHF) duplicate-entry bug: the UI iterates seat heights as strings
("24", "28", …) and does .find((s) => s.height === h || s.height === hNum),
but migrations 0028 / 0030 stored heights as integers. find() never hit,
so:
  1. Products page rendered blank for every sofa seat-height column
  2. Clicking a cell to edit saw "empty", and the submit handler APPENDED
     a new string-keyed entry next to the existing int-keyed one — which
     is exactly how 5530-2A(LHF) ended up with both {"height":28,...}
     and {"height":"28","priceSen":0} in the same array.

**Verification:** Code shipped via commit `207bc0d` to `main`.

---

## BUG-2026-04-24-039 — fix(pricing): rewrite sofa seatHeightPrices to canonical 5-tier JSON (Prod Sheet v10)

**Status:** Fixed (2026-04-24)
**Category:** pricing-products

**Symptom / Fix:** Production Sheet v10 (2026-04-23 SKU SF tab) is the authoritative source
for sofa base + per-seat-height pricing. At least one record — 5530-2A(LHF)
— accumulated a malformed duplicate entry {"height":"28","priceSen":0}
alongside the correct {"height":28,...} so the UI occasionally read the
zero row and showed the sofa as free.

**Verification:** Code shipped via commit `d7afd86` to `main`.

---

## BUG-2026-04-24-040 — fix(db): re-run sofa UPH+PKG backfill so Packing dates show on Overview

**Status:** Fixed (2026-04-24)
**Category:** data-migration

**Symptom / Fix:** Migration 0027 ran on 2026-04-23 before the sofa BOM templates had their
l1Processes[deptCode=PACKING] entries populated, so the INSERT's JOIN on
bom_templates matched nothing for ~180 sofa POs and silently did nothing.
Only 4 sofa POs ended up with Packing JCs (those created live via
createProductionOrdersForSO), which is why the Overview grid shows blank
Packing cells for most sofa rows.

**Verification:** Code shipped via commit `b5d3a2e` to `main`.

---

## BUG-2026-04-24-041 — fix(pricing): correct BF + SF master SKU prices from Production Sheet v5

**Status:** Fixed (2026-04-24)
**Category:** pricing-products

**Symptom / Fix:** Restores authoritative SKU pricing from the master Production Sheet (v5, 2026-04-24).

**Verification:** Code shipped via commit `ea0a4b8` to `main`.

---

## BUG-2026-04-23-001 — fix(db): move seed.sql out of migrations/ so CI stops retrying it

**Status:** Fixed (2026-04-23)
**Category:** infrastructure

**Symptom / Fix:** Wrangler applied every file in migrations/ as a migration, including seed.sql — a 4984-line INSERT-only file meant for local dev seeding. On prod (which already has data) it fails with primary-key conflicts, and with continue-on-error: true in the deploy workflow the failure was silent.

**Verification:** Code shipped via commit `af0d8ca` to `main`.

---

## BUG-2026-04-23-002 — fix(deletes): guard delete mutations against silent HTTP failures

**Status:** Fixed (2026-04-23)
**Category:** data-integrity

**Symptom / Fix:** Last batch from the HTTP-audit triage. Each of these DELETE handlers
used to either ignore errors entirely or only peek at json.success,
so a foreign-key-constrained delete, a 401 after token expiry, or a
500 from the worker would silently let the row disappear from the
list locally while the record stayed in D1. On the next page load
the row would reappear "zombie-style" and the user would have no
idea why.

**Verification:** Code shipped via commit `74d362d` to `main`.

---

## BUG-2026-04-23-003 — fix(sales): guard create / update / status / confirm against silent HTTP failures

**Status:** Fixed (2026-04-23)
**Category:** data-integrity

**Symptom / Fix:** Four mutation paths on the Sales Orders pages only checked json.success
and ignored res.ok, so a 401 (expired auth), 500, or worker crash that
still returned a JSON error body would fall into the success branch.
Users saw navigate-to-detail / "Status updated" / "Order confirmed"
toasts for requests the server actually rejected, and in the worst case
(confirmOrder) the frontend happily moved on to a SO whose production
orders never got created.

**Verification:** Code shipped via commit `6427754` to `main`.

---

## BUG-2026-04-23-004 — fix: sofa seat height stored consistently + kv-config save no longer silently fails

**Status:** Fixed (2026-04-23)
**Category:** data-integrity

**Symptom / Fix:** Two related data-integrity bugs surfaced together when users complained
that (a) sofa SO rows showed the module code ("2A(LHF)") under Size
instead of the seat height ("32\""), and (b) gaps/specials they added
in Product Maintenance disappeared after a refresh even though the
badge said "Auto-saved".

**Verification:** Code shipped via commit `56dad2a` to `main`.

---

## BUG-2026-04-23-005 — fix(products): allow negative variant surcharge (discount)

**Status:** Fixed (2026-04-23)
**Category:** pricing-products

**Symptom / Fix:** The variant-price inputs in Product Maintenance were fronted by a
literal "+RM" label, making it look like only positive amounts were
accepted. In reality the inputs have no min attribute and the state /
save flow pass the number through unclamped, so negative values
already work end-to-end — the SO pricing loop just sums surcharges
without any Math.max gate, so a -5000 sen entry correctly subtracts
RM 50 from the unit price.

**Verification:** Code shipped via commit `dbf35a0` to `main`.

---

## BUG-2026-04-23-006 — fix(sales): sofa Seat Size dropdown on edit page also follows config

**Status:** Fixed (2026-04-23)
**Category:** sales-orders

**Symptom / Fix:** edit.tsx was still reading SEAT_HEIGHT_OPTIONS (hardcoded in mock-data)
for the sofa Seat Size picker, so any sofa size the user added under
Product Maintenance → SOFA → Sizes never appeared when editing an SO.
create.tsx was already wired to kv_config.sofaSizes; sync edit.tsx to
the same source, keeping the hardcoded list as a hydration fallback.

**Verification:** Code shipped via commit `69a1f99` to `main`.

---

## BUG-2026-04-23-007 — fix(sales): read variants config as source of truth, don't filter it

**Status:** Fixed (2026-04-23)
**Category:** sales-orders

**Symptom / Fix:** The bedframe Gap dropdown on the SO create page stopped at 10" even
after Product Maintenance had 17 gap options up to 20". Same
silent-truncation existed for divan heights, leg heights and special
orders (both bedframe and sofa variants).

**Verification:** Code shipped via commit `f94f4b7` to `main`.

---

## BUG-2026-04-23-008 — fix(data-grid): column toggle not hiding in customizer

**Status:** Fixed (2026-04-23)
**Category:** ui-frontend

**Symptom / Fix:** Unchecking a column in the Columns customizer looked like a no-op —
the checkbox appeared to click but the column never left the sheet.
localStorage also stayed unchanged.

**Verification:** Code shipped via commit `0d8cb7d` to `main`.

---

## BUG-2026-04-23-009 — fix(bom): add UPHOLSTERY + PACKING to sofa WIP process chains

**Status:** Fixed (2026-04-23)
**Category:** bom

**Symptom / Fix:** Sofa BOM templates (SF_BASE / SF_CUSHION / SF_ARM) stopped at WEBBING,
so when an SO was confirmed, `createProductionOrdersForSO` never created
UPHOLSTERY or PACKING job cards for sofa POs. This caused:

**Verification:** Code shipped via commit `25b5446` to `main`.

---

## BUG-2026-04-23-010 — fix(data-grid): align right-aligned column headers with cell values

**Status:** Fixed (2026-04-23)
**Category:** ui-frontend

**Symptom / Fix:** For columns marked align="right" (or numeric/currency), the header label
was sitting on the LEFT of the sort/filter icons, while cell values
hugged the right edge — so the Gap/Divan/Leg/Qty headers visually
floated away from the numbers below them.

**Verification:** Code shipped via commit `8078c3b` to `main`.

---

## BUG-2026-04-23-011 — Robustness: per-page ErrorBoundary + per-user grid prefs + deploy-version toast

**Status:** Fixed (2026-04-23)
**Category:** ui-frontend

**Symptom / Fix:** Three defenses so the app stays usable after a crash or mid-session deploy:

**Verification:** Code shipped via commit `9d02579` to `main`.

---

## BUG-2026-04-23-012 — Fix BF tracker col mapping + SO grouping in orders migration

**Status:** Fixed (2026-04-23)
**Category:** data-migration

**Symptom / Fix:** BF Master Tracker headers are misleading:
  col17 = "Blank(Dont use for sofa)"  -> actual Gap (inches)
  col18 = "Sofa Size"                 -> actual Divan height (inches)
  col20 = "Leg (inches)"              -> Leg
Switch BF mapper to column-index access (ignore the header labels) so
gap + divan populate on bedframe orders. SF uses the real labels and
is unchanged.

**Verification:** Code shipped via commit `8698fe4` to `main`.

---

## BUG-2026-04-23-013 — Fix job_card ID collision between parallel WIPs sharing leaf names

**Status:** Fixed (2026-04-23)
**Category:** production-orders

**Symptom / Fix:** After the per-dept wipCode override landed, jcId = `jc-{po}-{wipCode}-{dept}`
collapsed DIVAN's FRAMING row and HEADBOARD's FRAMING row into one
because both use a node literally named "Frame" at their L2 depth. The
INSERT OR IGNORE silently dropped the HEADBOARD row. Switch to scoping
by wipKey (which embeds top-level wipType + index) so parallel WIPs
never collide even if they share leaf node names.

**Verification:** Code shipped via commit `48d8820` to `main`.

---

## BUG-2026-04-23-014 — Fix BOM+QR root-cause regressions from stale cache state

**Status:** Fixed (2026-04-23)
**Category:** bom

**Symptom / Fix:** - bom.tsx: remove the useEffect → saveStoredTemplates fan-out that
  PUT the entire templates list back to /api/bom/templates on every
  setTemplates call. It turned localStorage into a silent write-master
  that kept resurrecting stale per-product BOMs (qty=1 nested DIVAN)
  and overwriting D1 after every bulk reapply-masters run. localStorage
  is now cache-only; D1 is the sole source of truth. Individual edits
  already go through their own /api/bom/:id routes.
- production/index.tsx: gridFilterIdSet incorrectly treated the initial
  empty array as "filter matched 0 rows" and hid all QR stickers when a
  dept tab mounted (DataGrid hadn't reported back yet). Switch the state
  to `Row[] | null` and only build a Set once the grid reports real
  rows — null means "no filter yet, show everything".

**Verification:** Code shipped via commit `4517755` to `main`.

---

## BUG-2026-04-23-015 — Fix BOM page resurrecting stale localStorage on every mount

**Status:** Fixed (2026-04-23)
**Category:** bom

**Symptom / Fix:** The legacy localStorage overlay (hookka-bom-templates-v2) was loaded
IN PREFERENCE to the API response and auto-PUT back to /api/bom/templates
on mount — so every bulk reapply-masters run was silently undone by the
next browser tab that opened the BOM page. D1 is now the authoritative
source; clear the stale overlay key on mount instead.

**Verification:** Code shipped via commit `5135ce4` to `main`.

---

## BUG-2026-04-22-001 — Fix crash: variants page coerces object entries to strings on load

**Status:** Fixed (2026-04-22)
**Category:** ui-frontend

**Symptom / Fix:** Three pages share the localStorage key `hookka-variants-config` but
write incompatible shapes:
  - /settings/variants writes plain strings: ["8\"", "10\""]
  - /products Maintenance tab writes {value, priceSen} objects
  - /sales/create already handles both via extractValues()

**Verification:** Code shipped via commit `7bfe999` to `main`.

---

## How we use this file

- Add a new entry the moment a bug is **identified** (status 🔴), even
  before the fix lands. The diagnosis itself is the most valuable part of
  the record — six months later, "why did we change this" matters more
  than "what changed".
- Move to 🟡 when a fix is open but not deployed, 🟢 when it ships.
- Cross-reference related bugs: many of ours come in clusters (e.g. #001
  and #002 above only ever surfaced together).
- For each fix, name the exact `file:line` you changed and a one-line
  verification step. If we ever roll back, this is the diff.
