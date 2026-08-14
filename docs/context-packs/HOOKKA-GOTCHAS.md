# Hookka — Hard-Won Gotchas

> **Last verified: 2026-08-13** against every file it cites — all 17 exist and carry the
> named symbols: `roundUpToRinggitSen` (`src/lib/utils.ts:270`), `distributeComboUnitPrices`
> (`src/api/lib/sofa-combo.ts`), `bedframeSizeDefault` (`src/api/routes/fg-units.ts:235`),
> `canonicalizeOrigin`/`appOrigin` (`src/lib/app-origin.ts:28,42`),
> `src/api/lib/packing-rack-write.ts`, `src/api/lib/packing-piece-identity.ts`,
> `src/api/routes/import-completion/sofa-pricing.ts`, `src/lib/api-client.ts` (global
> `window.fetch` patch). No corrections needed.
>
> **Canonical path is `docs/context-packs/HOOKKA-GOTCHAS.md`.** Several docs used to link
> the old root-level HOOKKA-GOTCHAS path, which does not exist; those links were repaired 2026-08-13.
>
> **2026-08-13, branch `fix/stock-grn-org-filter`:** added the duplicate-rename-map-key
> trap to the schema section (verified against `column-rename-map.json:815-816`,
> `db-pg.ts:57` and the prod snapshot `tests/db-schema.json`). Nothing else changed.
>
> **Last verified: 2026-08-14** — added the "no production time is measured" section at
> the top. Every claim in it was read out of the SOURCE (the binds in `bom.ts:1055-1063`
> and BOTH builders (`src/api/routes/_shared/production-builder.ts:890/893` AND
> `src/lib/production-order-builder.ts:183/186` — a bare filename here once resolved to a
> path that does not exist, which is why citations are fully qualified now), the comment at
> `import-completion/_shared.ts:464`,
> the truncations at `_helpers.ts:4242/4334`,
> the honest counter-example at `production-orders.ts:543-640`, and the schema at
> `migrations-postgres/0001_init.sql:715-718`) — not inferred from query results. That
> distinction matters here: the same conclusion was reached twice from data alone and was
> WRONG both times, once claiming the metric was measured historically and once claiming
> nobody records anything. The binds are what settle it.

Read this BEFORE touching schema, money, SQL, or shipping. These are the
non-obvious traps that have repeatedly cost real time and, in one case, nearly
shipped a broken prod. They are Hookka-specific and intentionally NOT in the
generic context packs.

---

## "PRODUCTION TIME" IS STANDARD TIME, BY DESIGN — not a measurement, and not a bug

> **CORRECTED 2026-08-14 by the owner, after this section first framed it as a defect.**
> **Read the correction before acting on anything below.**
>
> Hookka runs **standard costing**. The owner's rule, verbatim:
> 「我们的 BOM 那边已经有给一个时间了（也就是 production hours）。然后再来，当他
> complete 的时候，我们就会记录这一个员工他用的时间多少，**我们不会去计算他 start from
> 或者 end from 的**」
>
> So: the BOM time **IS** the production hours. On completion the worker is credited that
> standard time. Elapsed start→end duration is deliberately NOT computed. That makes
> `actual_minutes = est_minutes` **correct and intended** — it is how the model works, not
> a copy someone forgot to replace.
>
> **Do not "fix" it.** An earlier version of this section called it fabrication; that was
> me not understanding the costing model, and it would have sent the next reader to
> re-plumb something that is working as designed.
>
> **What follows is still worth knowing** — the columns really are one number, so never
> treat them as three independent sources or as evidence of what the floor actually did.
> **The one genuine defect in this area was `attendance_records`, and it is FIXED** (see
> the last row): a hardcoded `× 0.85` that had nothing to do with the BOM.

**All three columns carry the same standard time.** Do not treat them as independent
sources, and do not describe any of them as observed duration.

| Column | What it really is | Source proof |
|---|---|---|
| `job_cards.production_time_minutes` | `= est_minutes` | `src/api/routes/bom.ts:1055-1063` binds **the same `p.target`** to both columns. **TWO builders do the same at card creation, and both are real** — `src/api/routes/_shared/production-builder.ts:890/893` (positional binds, both `p.minutes`) and `src/lib/production-order-builder.ts:183/186` (`estMinutes: p.minutes` / `productionTimeMinutes: p.minutes`). Migrations `0027`/`0029` write both from one literal `CASE`. |
| `job_cards.actual_minutes` | `= est_minutes` | `import-completion/_shared.ts:468`, under a comment that says it outright: *"Use planned minutes as actual since we don't have real timing."* Also `completion-cascades.ts:413,838`, `wip-fixes.ts:112,445` |
| `attendance_records.production_time_minutes` | **~~`= working_minutes × 0.85`~~ → now always NULL. FIXED #323, 2026-08-14.** | Verified 2026-08-14: `attendance.ts:332` is a `DELETE /:id` handler now; the only `0.85` left in `src/api` is `scheduling.ts:291`, a labelled *planning assumption* (`assumedEfficiency`), which is a legitimate use. All four former writers (`attendance.ts`, two in `worker.ts`, `working-hour-entries.ts`) write NULL, and `rowToAttendance` publishes `null` — "unknown" must stay distinguishable from "measured zero". |

They are not *coincidentally* equal — **the same variable is bound to both columns**, so
they can never differ. That is the standard-costing model, stated in code.

**The `attendance_records` row above was the real defect, and it is FIXED (#323).** It had
nothing to do with the BOM: `attendance.ts:332` invented `working_minutes × 0.85` at
clock-out, and `efficiencyPct` / `deptBreakdown` were derived from that constant. Four
writers carried it (`attendance.ts`, two in `worker.ts`, `working-hour-entries.ts`); all
four now write NULL, because "unknown" must be distinguishable from "measured zero".

**`job_cards.completed_at` now exists (#325) — and it is NOT a contradiction of the
standard-costing model.** It records *when* a card was completed, which the code used to
capture and throw away (`_helpers.ts:4334` computed `nowIso` then did
`nowIso.split("T")[0]`; 14 such truncations). It exists so a completion can be placed in
time — for sequencing, for throughput, for tying work to a shift. **It is NOT there to
replace the BOM time as the basis of production hours**, and no efficiency calculation
reads it. Historical rows are NULL on purpose and must never be back-filled from a date:
`reconcileCompletedAt` is property-tested to prove it can only return an observed instant
or null.

**A NOTE ON `/report-summary`.** `production-orders.ts:543-640` credits a card only when
`actual_minutes > 0` and publishes `measuredDistinctCards` (cards where actual differs
from est) so a page can *"refuse to publish a percentage that only looks measured."* On
current data that count is **0**. Under standard costing that is the EXPECTED result, not
a warning — actual is supposed to equal standard. The pattern is still the right one to
copy whenever a figure's coverage is genuinely partial (see BUG-2026-08-13-096, where a
planner's "0 items" meant *cannot see* rather than *nothing wrong*); just don't read its
zero here as evidence that something is broken.

**THE METRIC THAT IS CORRECT.** `Σ(standard minutes of cards a worker completed) ÷ their
real clocked minutes` is textbook **earned-vs-actual** labour efficiency, both sides are
real data, and the numerator is *supposed* to be standard time. That is exactly what
Employees → Department Performance computes (80%). **It is the soundest number in the
system — do not "fix" it, and the label "Production Hours" stays (owner, 2026-08-14).**

**>100% IS NORMAL AND IS GOOD.** Earned > clocked means the worker beat the standard.
Nothing clamps it and nothing should: `employees.tsx:4217` colours `>= 100` GREEN, and the
only flag is `< 60` (`LOW_EFFICIENCY_THRESHOLD`). **Do not treat a 101% day as bad data.**
I made exactly that mistake — applying *utilisation* intuition (where >100% is impossible)
to an *efficiency* metric (where it is the point) — and the owner corrected it. The daily
spread on this figure (101 / 71 / 84 / 76 / 80) is real signal about how the floor ran.

**One caveat on the denominator:** `punch-autofill.ts:273` writes the *contracted shift*
when a punch-out is missing (`"(no punch-out — standard shift)"`), and aggregates sum
those identically to real punches. So the denominator is mostly-but-not-entirely clocked.

The `attendance` `× 0.85` instance was class **C15** (fabricated data presented as
measured) and is fixed. The BOM standard time is **not** a C15 instance — it is the
costing model. See `docs/BUG-CLASSES.md`.

## Schema / migrations (the #1 trap)

- **Deploys do NOT auto-run Postgres migration files.** `deploy.yml` does not
  replay `migrations-postgres/*.sql` (the D1 migrations step was retired). A
  migration file alone is **INERT on prod**. A new column reaches prod ONLY via
  a runtime self-apply: a module-level promise running idempotent
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, **awaited at the TOP of the
  relevant POST/PUT handler, before the first INSERT/UPDATE that uses the
  column.** Reference patterns: `ensurePendingMigrations` in
  `src/api/routes/sales-orders.ts`, `ensureGrnMigrations` in `grn.ts`. Skip this
  and the first write 500s on a missing column (BUG-2026-06-20-002 — caught in
  verify-live, one step from a broken prod). Still write the migration file too
  (record + SQLite test mirror), but the runtime self-apply is what's load-bearing.

- **Two rename-map entries can point at ONE column, and only the LAST one wins on
  read.** `columnFrom` (`src/api/lib/db-pg.ts:57`) resolves a `SELECT *` column
  through `snakeToCamel`, which is
  `Object.fromEntries(Object.entries(renameMap).map(([camel, snake]) => [snake, camel]))`.
  `Object.fromEntries` keeps the **last** duplicate key. `column-rename-map.json`
  maps **both** `"supplierSKU"` (line 815) and `"supplierSku"` (line 816) to
  `supplier_sku`, so every `SELECT *` row delivers **`supplierSku`** and any
  `r.supplierSKU` read is permanently `undefined` — no error, just a blank field
  or, worse, a `""` written onward. This has produced at least three live defects
  (`purchase-orders.ts:98` PO Supplier SKU, `three-way-match.ts:380` bucketing,
  and `grn.ts:1574`, which stores `grn_items.material_code = ""` on every
  PO-sourced line — BUG-2026-08-13-052). **Check the map for a duplicate target
  before trusting an acronym-cased key**, and read rows dual-keyed
  (`r.camelCase ?? r.snake_case`) so it does not matter which spelling won.

- **Make new columns snake_case.** Route SQL is written camelCase and translated
  to snake_case by `src/api/lib/supabase-compat.ts` using
  `src/api/lib/column-rename-map.json`. A camelCase column referenced in route
  SQL **without** a rename-map entry **silently 400s** ("Invalid request body").
  snake_case columns need no map entry — prefer them. CI-guarded by
  `tests/sql-write-column-coverage.test.mjs`. (A 400 on a well-formed body is
  usually a DB write throwing inside a try/catch — suspect this first.)

## Production — bedframe packing pieces (sizeCode-driven)

- **A bedframe's Headboard + Divan sticker count is derived from its `sizeCode`**, via `bedframeSizeDefault` in `src/api/routes/fg-units.ts` (`parsePieces` priority: specialOrder "Headboard Only" → 1 HB; `products.pieces` JSON → verbatim; else the size-default). It knows **K/Q → HB+2Divan, S/SS → HB+1Divan, SK → HB+2Divan, dimension codes** ("152X200") by width (≥150cm → 2 Divan). **Anything else — a BLANK sizeCode, "SP", or an unknown code — falls through to the global `{count:1, names:["Full Product"]}` fallback → ONE unit, NO Divan sticker** (BUG-2026-06-22-008: 1052 had a blank sizeCode; 18 SK/SP/dimension SKUs had unrecognised codes — each silently shipped 1 "Full Product"). Bedframe `sizeCode` is now **REQUIRED** on products POST/PUT (blank → 400). To fix already-generated orders you must set the product's sizeCode/pieces **and then** `POST /api/import/regen-fg-units {soIds, dryRun}` — `/generate/:poId` is idempotent and will NOT re-derive existing units. The sticker render loop (`production/index.tsx`) faithfully draws one sticker per fg_unit and is never the bug; the bug is always the fg_unit COUNT.

## QR / stickers / scanning / warehouse occupancy

- **QR/sticker URLs follow `window.location.origin` — the PRINT-TIME domain.**
  `packingStickerUrl` / `packingRackScanUrl` / the DO-QR / the rack-QR all encode
  `window.location.origin`, so a sticker's QR carries whatever domain it was
  **printed from**: `erp.hookka.com` (prod custom domain), the old
  `hookka-erp-testing.pages.dev` (prod fallback), or
  `staging.hookka-erp-testing.pages.dev` (staging). Scanning is **path-based and
  domain-agnostic** (the `/p/`, `/r/`, `/worker/scan` routes resolve regardless of
  host) **BUT each site resolves against ITS OWN DB** — so a **prod-printed token
  scanned on staging fails** (token doesn't exist in the staging DB), and vice
  versa. (`erp.hookka.com` is treated as prod: `worker.ts isPreviewHostname` maps
  the custom domain to prod.) **The prod fallback origin IS canonicalized →
  `erp.hookka.com` on every QR / printed link** (`src/lib/app-origin.ts`
  `canonicalizeOrigin` / `appOrigin`, owner 2026-06-26 "比较好看"); staging /
  preview / localhost keep their OWN origin so their QRs still resolve against
  their own site + DB.

- **Codes are always-scannable — there is NO time-based expiry.** A "QR expired /
  scan failed" symptom is **never a timer**; it is a **structural resolution
  failure**: an archived card (the resolver was hot-card-only), a re-exploded/edited
  order (old card deleted+rebuilt), bedframe multi-piece ambiguity, an unpersisted
  `qr_token`, or an old pre-token login-link sticker. Owner ruling (2026-06-26):
  **always-scannable, no time limit** — a 3-day expiry was explicitly **DECLINED**.
  Do NOT build a code expiry; fix the structural dying instead (archive-aware
  `resolveCard` + `pickPackingCard` + token re-read already shipped).

- **Rack assignment now mirrors warehouse occupancy via ONE choke-point —
  `applyPackingRack` (`src/api/lib/packing-rack-write.ts`).** Assigning a packing
  rack from ANY of the three entry paths — the office Packing-sheet dropdown
  (`PATCH /api/production-orders/:id {jobCardId,rackingNumber}`), the public `/p/`
  piece-sticker scan, and the worker scan — funnels through `applyPackingRack`. It
  writes the **TEXT `rackingNumber`** (job_cards + production_orders) AND **mirrors
  ONE `rack_items` row per piece** (SET inserts / re-assign MOVES / `""` CLEARS +
  recomputes `rack_locations.status` via the same CASE as the DO-dispatch stock-out),
  so the Warehouse grid shows the piece under its rack. **Before this, only the
  `/r/` rack-QR stock-in wrote `rack_items`.** The office PATCH
  (`production-orders.ts`) now calls `applyPackingRack` after its inline UPDATE
  (best-effort, hot-card only) (BUG-2026-06-25-007).

- **Warehouse identity for a packed piece = `packingPieceIdentity` ONLY** —
  `src/api/lib/packing-piece-identity.ts`, the single shared formula
  (`description = wipLabel || (productName+" "+sizeLabel).trim() || "Item"`;
  `notes = soNo ? "SO <no>" : ""`). It is used by **both** `applyPackingRack` and
  `public-rack-qr.ts` (`/p/` resolve, `currentRackOfPiece`, `pieceNotes`) so the
  office / `/p/` / `/r/` paths converge on ONE `rack_items` row (a MOVE finds the
  old row by `productName + notes`). **If you derive a piece's description/notes
  any other way you get a DUPLICATE warehouse row.** Tests:
  `tests/packing-piece-identity.test.mjs`.

## Build / ship

- **build:strict before every push** = `npx tsc -p tsconfig.app.json --noEmit`.
  The base `tsconfig.json` is LOOSER and misses errors the deploy gate fails on.
  **Measured 2026-08-13 on a clean `npm install`: exit 0, ZERO errors.** This entry used to
  say "ignore exactly 3 known sandbox module errors" (jsbarcode in `production/index.tsx`,
  @zxing/library in `rack-scan.tsx` / `worker/scan.tsx`). That carve-out did not reproduce.
  A standing "ignore these N errors" instruction is how a real error gets waved through —
  if you see any, treat them as yours until proven otherwise.
- **Verify live on prod after every deploy — read AND write path.** Deploy exit 0
  ≠ feature works (stale chunks, silent schema-apply failures, cache bite).
- Rapid back-to-back deploys make open tabs throw "Something went wrong" (stale
  dynamic-import chunk) — not a code bug; a hard refresh fixes it.

## Data shapes

- **Money is sen (integer)** = RM × 100. Use `MoneyInput` (value is `number|null`
  in RM dollars, commits on blur) for sen-int state fields. `DiscountInput`
  (`%`-aware) computes a discount off a base amount and emits sen.

- **Every COMPUTED unit price lands on a whole ringgit, rounded UP** (owner
  2026-08-07, "我全套系统都要整除的" — the complaint was unit prices reading
  RM 995.14 / `.98`). One primitive: **`roundUpToRinggitSen`** in
  `src/lib/utils.ts`, next to `roundSen` / `distributeRoundSen`. Never hand-roll
  `Math.ceil(x/100)*100` — a source-guard test fails on a second copy
  (`tests/whole-ringgit-unit-price.test.mjs`). Scope, all deliberate:
  **UNIT prices only** (line subtotal follows as `whole unit × qty`, so don't
  re-round subtotals or invoice totals); **SST is EXCLUDED** (owner:
  "SST 就不需要" — tax keeps its cents, `roundSen` is unchanged); **computed
  values only** (a price the operator TYPED is left as typed — this is why
  `DiscountInput`'s `%` branch rounds up but its RM branch does not).

- **Sofa combos: round up, then GIVE THE EXCESS BACK.** Combo proration exists
  to make N piece prices sum EXACTLY to a negotiated total, and rounding each
  unit up breaks that. `distributeComboUnitPrices` (`src/api/lib/sofa-combo.ts`)
  resolves it: round every unit up, then hand whole ringgit back — starting with
  the line the rounding flattered most — so **the agreed combo total still
  holds**. An agreed customer price that silently grows is worse than a `.98`.
  Both the backend pass AND `src/pages/sales/create.tsx` call this one function.

- **The round-up is FORWARD-ONLY — never retro-apply it.** Rounding up always
  moves money in our favour, so re-rounding an already-issued document is a
  customer dispute, not a fix. `/recompute-so-sofa-prices` and
  `/recompute-co-sofa-prices` (`src/api/routes/import-completion/sofa-pricing.ts`)
  reprice EXISTING orders and keep the OLD floor/round/residual maths on
  purpose — there is a 🛑 DELIBERATE DIVERGENCE banner on the copy. Do not
  "fix the drift" there.
- **PO line code is mashed into the name** as "CODE - DESCRIPTION" —
  `purchase_order_items` has no dedicated code column. Recover it with
  `splitCodeName(code, name)` in `pdf-utils.ts`. GRN/PI and all sales-side docs
  DO have a proper code field (`material_code` / `product_code`) — don't split those.

## Front-end fetch / CSRF

- **CSRF is injected GLOBALLY — no fetch is ever "missing" the token.**
  `src/lib/api-client.ts` (~line 58) monkey-patches `window.fetch` to auto-add
  `X-CSRF-Token` (unless the caller already set it) + `credentials:'include'` on
  **every mutating `/api/*` request**. So a raw `fetch('/api/...', {method:'POST'})`
  with no explicit header is STILL CSRF-protected. **An audit that flags "N fetches
  missing the CSRF token" is ALL FALSE POSITIVES** — do not chase it, do not sprinkle
  `csrfHeaders()` to "fix" it. (A `patchRack` CSRF "fix" was shipped, then found to
  be a no-op for exactly this reason — BUG-2026-06-25-008b.)

## Process (how this codebase is worked)

- **Money / inventory / payroll / cascade changes:** investigate → propose with
  options → confirm before coding; when fixing one case, sweep the whole dataset
  for the same pattern. Schema/cascade rewrites go on a dedicated branch.
- **`docs/BUG-HISTORY.md` is the living bug log** — append every diagnosed+fixed
  bug (newest first). It is the source of truth, not GitHub issues.
- **Shared UI primitives** (don't hand-roll): `ObjectPageHeader`/`PageHeader`,
  `useConfirm`, `DataGrid`, `MoneyInput`, `DiscountInput`, `SearchableSelect`;
  one shared PDF letterhead via `drawLetterhead`. See `docs/UI-CONVENTIONS.md`.

## Diagnosing performance / data problems — how the WRONG answer gets produced

On 2026-08-13 a single session produced **eight** confidently-stated findings
that were false. Every one traced back to three habits, not eight mistakes.
They are written here because the investigation itself is the dangerous part:
a wrong diagnosis, stated with confidence, sends whoever reads it down a road
that costs far more than having no diagnosis at all.

### 1. Measure the call the PRODUCT makes — not one that is convenient
Four of the eight came from probing something no page ever does:

- Adding a cache-buster (`&x=Date.now()`) to "get a clean number" measures the
  cold path. Real users hit the cache. Reported "30 s, the page cannot load";
  the truth was ~1.5 s, and the page in question was **dead code no route
  reached**.
- Calling `/api/attendance` bare gives 1.7–6.3 s / 1.28 MB. Every caller passes
  `?date=` or `?from=&to=` — as actually called it is **126 ms**. Nearly filed
  as a P1.
- Grepping a URL string found "45 call sites"; almost all were
  `invalidateCachePrefix(...)`, which sends no request at all.
- Setting `el.scrollTop` without dispatching `scroll` does not advance a
  virtualised list. Concluded windowing was broken; it was correct.

**Rule:** before filing a perf bug, find a live caller and copy its exact query
string. Verify the code path is REACHABLE (check the route table — this repo
has redirect-only routes and files nothing imports).

### 2. A sample is not the population, and a count is not the meaning
`actualMinutes` was diagnosed three times before it was right:
- v1: 5 orders sampled, all NULL → "the factory records nothing." **Wrong.**
- v2: counted the column, 4,340 non-null → "so it does record." Count right,
  **inference wrong.**
- v3: every one of the 4,289 non-zero values is **byte-identical to that same
  card's `estMinutes`** — a copy of the standard time, carrying no information.

**Rule:** to claim a column is empty, count it. To claim it is USEFUL, check the
distribution — a fully-populated column can still be meaningless, and that is
exactly how a KPI ends up pinned at 100%.

### 3. Do not relay an unverified claim as fact
- A code comment said the morning brief "is emailed at 07:00", so it was written
  off as a cron nobody waits on. People open the HTML in a tab to read and
  print it; it was the worst user-facing wait in the app.
- A sub-agent reported a live DB credential sitting in ~113 tracked
  `scripts/*.mjs`. It is a **placeholder inside a help message**
  (`postgresql://postgres:<PASSWORD>@db.<ref>...`). Repeated to the owner as a
  security incident before anyone opened the file.

**Rule:** a comment describes intent, not behaviour, and least of all human
behaviour. Findings inherited from another agent get re-verified before they are
repeated — especially security claims, where a false alarm burns real trust.

### What actually works
Capture a fingerprint of the live response BEFORE deploying, then compare after
— identical hash proves a projection changed nothing:

```js
const flat = (j.data||[]).map(o => o.id + '|' + (o.items||[]).map(i => i.productCode+':'+i.unitPriceSen).join(','));
let h = 0; const s = flat.join(';');
for (let i = 0; i < s.length; i++) h = ((h<<5) - h + s.charCodeAt(i)) | 0;
```

This caught every real regression risk in that session, and its absence produced
every false one. State plainly which numbers are MEASURED and which are
PROJECTED; if you could not verify something, say so rather than rounding it up
to a fact.
