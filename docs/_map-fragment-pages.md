# Map fragment — unmapped pages + their paired routes

> **Last verified: 2026-08-13** against every file cited below, read in full (not grepped).
> Line counts re-derived with `wc -l`; every `file:LINE` opened and checked; route paths
> checked against `src/dashboard-routes.tsx` / `src/router.tsx`; the Hono route-ordering
> claim in §8 was **executed** against `hono@4.12.14` from this repo's lockfile, not inferred.
>
> **This is a FRAGMENT, not a doc.** It is written to be pasted into
> `docs/CODEBASE-MAP.md` by the assembling session, in the map's own table format
> (`Frontend page | API route | Primary tables | Tests`). Delete this file once merged in.

## What was NOT in the map before this fragment

| File | Lines | Prior mention in `CODEBASE-MAP.md` |
|---|---|---|
| `src/pages/login.tsx` | 1288 | **none** |
| `src/pages/finance-dashboard.tsx` | 1263 | **none** |
| `src/pages/leads/index.tsx` | 929 | **none** |
| `src/pages/hookka-report-editions.tsx` | 697 | **none** |
| `src/pages/forecast.tsx` | 575 | **none** |
| `src/pages/component-kits/index.tsx` | 502 | **none** |
| `src/pages/invoices/debit-notes.tsx` | 500 | only as the bare shorthand `debit-notes.tsx` (map L277), no full path, no route/table/test row |
| `src/api/routes/debit-notes.ts` | 450 | named twice (map L143, L277) but never described |
| `src/pages/delivery-returns/index.tsx` | 419 | **none** |
| `src/api/routes/delivery-returns.ts` | 483 | one clause inside the FG-stock-events gotcha (map L471); no row |
| `src/api/routes/three-pl-vehicles.ts` | 446 | named in the Sales table's route column (map L222); never described |
| `src/api/routes/equipment.ts` | 405 | **none** |

Nothing here is dead code — every one is reachable. Two are **not pages** despite living
under `src/pages/` (§4, §5); say so in the map or the next reader will hunt for their route.

---

## 1. Auth — Login

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/login.tsx` — `/login`, **PUBLIC / standalone** (declared in `src/router.tsx:92`, NOT in `dashboard-routes.tsx`); email+password, remember-me, soft-2FA branch, role-aware landing (1288) | `src/api/routes/auth.ts` — `POST /login` (`:148`), `GET /me/permissions` (`:487`), `POST /change-password` (`:613`), `POST /forgot-password` (`:745`), `POST /reset-password` (`:901`) | `users` (session cookie is the credential; no client token) | **NONE dedicated.** `tests/api-rate-limit.test.mjs` and `tests/security-public-endpoints.test.mjs` touch `/api/auth/login` as an endpoint only — neither reads `src/pages/login.tsx` |

**Endpoints it calls** — `POST /api/auth/login` (`src/pages/login.tsx:319`),
`GET /api/auth/me/permissions` (`:295`, inside `landingPage()`),
`POST /api/auth/totp/dismiss-prompt` (`:394`, fire-and-forget).

**Why a login page is 1,288 lines.** The auth logic is ~110 lines (`LoginPage` L227 →
`handleSubmit` end L417). The other ~90% is **two complete, independent presentations plus
their palettes**, all inlined:

- **L39–117 `LOGIN_PALETTE`** — a 20-key `Palette` type rendered twice (dark + light),
  ported verbatim from the owner's design source. Every colour is a JS style value, not a
  Tailwind class, so nothing collapses into a class string.
- **L129–205 seeded snow** — `Flake` type, a mulberry32 LCG (`makeRng` L143), two frozen
  flake arrays (`SNOW_BACK` 16, `SNOW_FRONT` 5) and the `SnowLayer` renderer.
- **L420–856 the MOBILE branch** (`< 1024px`, gated by `useMediaQuery` at L245) — the
  owner's phone-first design: `<style>` keyframe block, 64px grid, radial glow, parallax
  snow layers, theme toggle, frosted-glass form sheet. Roughly 435 lines.
- **L858–1274 the DESKTOP branch** (`>= 1024px`) — the older premium split-panel:
  shimmer/orbit keyframes, three orbit rings, three orbiting dots, brand column. Roughly
  415 lines.

Both branches share ONE form state and ONE `handleSubmit`; only presentation differs. If
you are changing auth behaviour you want L227–417 and nothing else.

**Gotchas**

- **`Math.random` here is NOT fabricated data.** L130 explains it: the design source used
  `Math.random` for snowflake positions and it was replaced by a seeded LCG so flakes are
  stable across renders. It decides pixel positions, never a figure. A fabricated-data
  sweep will hit this line — it is a false positive, don't "fix" it.
- **The 2FA hard gate is a documented dead end (BUG-2026-08-04-006).** The server can
  answer `{ success:true, totpRequired:true, userId }` with **no `data` blob**; the
  login-verify step was never built. L346–351 handles that shape explicitly and shows
  "Two-factor sign-in isn't available yet — ask an admin to reset your 2FA". The gate is
  currently disabled server-side; this branch exists so a stale worker or a re-enable
  cannot white-screen login again. The `LoginResponse` union at L207–225 models all three
  shapes — keep it that way.
- **`/dashboard` is deliberately NOT the default landing page** (L281–305). Under the RBAC
  policy `/dashboard` is Management + Super Admin only, so the page asks the SERVER for the
  role's front door via `GET /api/auth/me/permissions` → `body.home`, falling back to
  `/settings` (which everyone has). Do not reintroduce a hardcoded `/dashboard` default —
  a salesperson would land on a screen whose every figure 403s.
- **`rememberMe` defaults to `true`** (L240) and is a real behaviour switch, not cosmetics:
  unchecked ⇒ session cookie + `sessionStorage`, which incognito drops on tab close
  ("mysteriously logged out", owner 2026-06-27).
- The right panel's `SYSTEM ONLINE` dot (L1232–1241), `ERP v2.0 // 2026` (L1255) and
  `ISO 9001:2015` (L1269) are **static decorative strings** — no health check behind them.
  Their bigger sibling (a `156 ACTIVE PO / 8 DEPARTMENTS / 99.7% UPTIME` stat panel) was
  deleted 2026-05-27 for exactly that reason; the comment recording it is at L1201–1204.
  If a live status indicator is ever wanted, it must be wired, not styled.

---

## 2. Forecasting — Financial Dashboard + Forecast P&L

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/finance-dashboard.tsx` — `/finance-dashboard` (`src/dashboard-routes.tsx:472`; sidebar FORECASTING → "Dashboard"); 6 cards, monthly or calendar-quarterly (1263) | `src/api/routes/accounting.ts` — `GET /dashboard` (`:10039`), SWR-cached | `accounting_dashboard_snapshot` (runtime-created at `accounting.ts:10064`) over the ledger + `kv_config['forecast_pnl']` (`:10122`) | `tests/dashboard-forecast-pct.test.mjs` (BUG-2026-08-06-002 only) |
| `src/pages/forecast.tsx` — `/forecast` (`src/dashboard-routes.tsx:471`; sidebar FORECASTING → "Forecast P&L"); planning grid, zero contact with the books (575) | `src/api/routes/accounting.ts` — `GET /forecast` (`:10673`), `PUT /forecast` (`:10688`), `GET /coa` (`:829`), `GET /pnl/section-map` (`:9757`), `GET /labor/departments` (`:9491`) | `kv_config` row `key='forecast_pnl'` (`:10719`) — **no forecast table exists**; plus `chart_of_accounts` for the line structure | **NONE** |

> **Name collision — read this before touching either.** `/forecast` (`src/pages/forecast.tsx`,
> the owner's keyed P&L plan) and `/analytics/forecast` (`src/pages/analytics/forecast.tsx`,
> `dashboard-routes.tsx:548`) are **different pages with different data**. The map must not
> collapse them. `dashboard-routes.tsx` even imports them under two names —
> `ForecastPnl` (L143) and `Forecast` (L181).

**finance-dashboard.tsx — endpoints:** exactly ONE.
`GET /api/accounting/dashboard?granularity=&periods=&from=&to=` at
`src/pages/finance-dashboard.tsx:262`. All six cards are `useMemo` projections of that one
`rows` array, which is why a card can never disagree with its report.

**Cards, in render order:** Income Statement (`:657`, 10 tabs from `PL_TABS` L40) → Production
Salary stacked-by-department (`:714`) → Cost Structure (`:915`) → Material Trend (`:1074`) →
Cash Flow with Summary/Detail (`:1133`) → Balance Sheet (`:1200`) → Financial Ratios (`:1227`).

**Money / honesty notes**

- Money is integer sen end to end. `rm` / `rm2` (L83–86) divide by 100 **for display only**;
  every derived figure uses `Math.round(... * 10000) / 100` on sen ints.
- **The forecast-percentage rule (BUG-2026-08-06-002) is load-bearing and is stated three
  times in this file** — `csForecastSales` L468, `csData` L524–529, `csTrend` L568–573: a
  forecast share divides by FORECAST revenue, an actual share by ACTUAL revenue. Dividing a
  plan by a part-billed actual once read 121.30% for a target that was 15% of plan. Pinned
  by `tests/dashboard-forecast-pct.test.mjs`.
- **This page volunteers a known-wrong figure rather than hide it** — L906–909 renders a
  standing warning that `RM / unit` uses completed-batch quantities that double-count some
  completions, so the unit count runs high and the cost runs low. Do not delete that banner
  while the defect is open; it is the difference between a weighable figure and a
  misleading one.
- No fabricated data anywhere in this file: `rows === null` renders "Loading…", `rows.length
  === 0` renders "No data yet.", and every card is gated on real content
  (`csCats.length > 0`, `labourData.some(d => d.amount !== null)`).

**forecast.tsx — endpoints:** four parallel GETs on mount (`:111`, `:112`, `:113`, `:114`)
and one `PUT /api/accounting/forecast` on Save (`:287`).

**Gotchas**

- **It stores nothing in a table.** The whole grid is one JSON blob in
  `kv_config.value WHERE key='forecast_pnl'`. `PUT` is a whole-blob replace
  (`accounting.ts:10719`, `INSERT … ON CONFLICT DO UPDATE`) — there is no per-cell write, so
  two people saving concurrently is last-write-wins over the entire forecast.
- **A cell is percent OR amount, never both** (L237–241 clear the other side). Storage:
  `{ bp }` (basis points, `strToBp` L83) or `{ amtSen }` (L273–286). A **legacy third
  shape** — a bare `bp` number — is still read at L127. Any new reader must handle all three.
- **Department rows SUPERSEDE the 750-x labour accounts** for any month that carries one
  (`monthHasDeptForecast` / `forecastEntryKind` from `src/lib/salary-dept.ts`, applied at
  `forecast.tsx:227–229` and again at `:526`). The account rows stay visible, greyed, marked
  "superseded". Summing both would double-count labour — that is what `sumGuard` (L228)
  prevents. `finance-dashboard.tsx` reads the same blob through the same rule.
- Pseudo-line keys are a deliberate namespace: `cat:<TYPE>` for material groups (L180–182),
  `dept:<CODE>` for salary departments (L195). They sit in the same `pct` map as real
  account codes. A reader that assumes every key is a COA code will break.

---

## 3. Sales — Sales Pipeline (Leads)

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/leads/index.tsx` — `/leads` (`src/dashboard-routes.tsx:414`; sidebar "SALES & CUSTOMERS → Sales Pipeline"); 6-column kanban, drag-to-move, full CRM drawer, convert-to-customer (929) | `src/api/routes/sales-leads.ts` (437) — CRUD + `/:id/stage` + `/:id/convert` + `/lead-products` | runtime-created: `sales_leads` (`src/api/routes/sales-leads.ts:35`), `lead_products` (`src/api/routes/sales-leads.ts:63`); plus `customers` — a POTENTIAL row is minted with the lead (`src/api/routes/sales-leads.ts:144`) | `tests/sales-leads.test.mjs`, `tests/sales-pipeline-lead-detail.test.mjs`, `tests/lead-convert.test.mjs`, `tests/lead-catalog.test.mjs`, `tests/crm-followups.test.mjs` |

**Endpoints called, with line refs in `src/pages/leads/index.tsx`**

| Call | Page line | Handler |
|---|---|---|
| `GET /api/sales-leads` | `:70` | `sales-leads.ts:102` |
| `GET /api/customer-crm/follow-ups` | `:81` | `src/api/routes/customer-crm.ts` |
| `POST /api/sales-leads` | `:132` | `sales-leads.ts:155` |
| `PUT /api/sales-leads/:id` | `:400` | `sales-leads.ts:228` |
| `PUT /api/sales-leads/:id/stage` | `:162` | `sales-leads.ts:258` |
| `DELETE /api/sales-leads/:id` | `:171` | `sales-leads.ts:359` |
| `POST /api/customers` | `:594` | `src/api/routes/customers.ts` |
| `PUT /api/customers/:id` | `:583`, `:609` | `src/api/routes/customers.ts` |
| `POST /api/sales-leads/:id/convert` | `:631` | `sales-leads.ts:295` |
| `GET /api/sales-leads/lead-products?leadId=` | `:740` | `sales-leads.ts:374` |
| `POST /api/sales-leads/lead-products` | `:810` | `sales-leads.ts:389` |
| `DELETE /api/sales-leads/lead-products/:id` | `:832` | `sales-leads.ts:427` |
| `GET /api/products` | `:751` | `src/api/routes/products.ts` |

Sub-components: `LeadDetailDrawer` (L370), `ConvertLeadDialog` (L529), `LeadCatalogPanel`
(L719). The drawer also mounts `CrmPanel` and `KycPanel` (L512, L514) **keyed on the LEAD
id** — those carry their own endpoints.

**Gotchas**

- **`STAGES` (L45–52) is the single source of every stage label on the page.** `key` is the
  persisted value and must stay in lockstep with `LEAD_STAGES` in `sales-leads.ts:20`;
  `label` is display-only. Owner 2026-08-01 renamed New/Won/Lost → **Potential / Confirmed /
  Dropped** by editing labels alone — no migration. Don't "tidy" the keys.
- **Convert PROMOTES, it does not create.** A `customers` row is minted as POTENTIAL when the
  lead is entered (`sales-leads.ts:144`), and has been carrying SKU assignments, combos and
  quotations ever since. `ConvertLeadDialog.submit` (L557) therefore `PUT`s that existing
  `lead.customer_id` (L582–592) and only falls through to `POST /api/customers` (L594) for
  pre-change leads that have none. Minting a second customer here would strand everything
  assigned to the first.
- **Snake-case reads here are correct, not a bug.** `sales-leads.ts:107` is
  `SELECT * FROM sales_leads`, and the physical columns are snake_case, so the page's
  `l.est_value_sen` / `l.next_follow_up` / `l.lost_reason` land. Do not "fix" them to
  camelCase — the map's dual-key rule applies where a column has BOTH forms.
- **Both writers are deliberately sequential, not `Promise.all`** — `addTicked` (L809, the
  endpoint self-applies DDL on first write and concurrent creates race it) and the analogous
  loop in Component Kits (§6). Keep them sequential.
- Money is sen: `Math.round((parseFloat(...) || 0) * 100)` at L143, L411, L574.

---

## 4. Reports — The Hookka Report, Weekly/Monthly editions

| Frontend module | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/hookka-report-editions.tsx` — **NOT a page and NOT a route.** No default export; it exports `EditionToggle` (`src/pages/hookka-report-editions.tsx:145`), `OperationsEdition` (`src/pages/hookka-report-editions.tsx:223`) and the `Edition` type (line 17). Imported ONLY by `src/pages/daily-report.tsx` (import block L16-20), which renders `OperationsEdition` (`src/pages/daily-report.tsx:1092`) and `EditionToggle` (`src/pages/daily-report.tsx:1055`, `src/pages/daily-report.tsx:1131`). Reachable only via the `/daily-report` route entry — `DailyReport` (`src/dashboard-routes.tsx:474`) (697) | `src/api/routes/reports.ts` — `GET /operations.json` (`:345`), collector `src/api/lib/operations-report.ts` (1223) | `sales_orders` / `sales_order_items` / `job_cards` / `payslips` / `attendance_records` / `workers` / `products` / `raw_materials` / `rm_batches` / `cost_ledger` / `purchase_orders` / `invoices` / `invoice_payments` / `delivery_orders` / `service_cases` / `qc_inspection_items` / `price_histories` / `departments` | **NONE** |

**Endpoints:** `GET /api/reports/operations.json?period=<edition>&date=<anchorYmd>`
(`:230-231`), `GET /api/files?resourceType=modular` (`:236-237`) for the product photos,
and `/api/files/:id/download` as an `<img src>` (`:671`).

**Gotchas**

- **Its file name looks like a page and it is filed under `src/pages/`.** It is a component
  module. `node scripts/check-codebase-map.mjs --coverage` demands a map entry for it (697
  lines > the 400 threshold) even though no route can ever point at it. Record it under
  Reports next to `daily-report.tsx`, not as a route.
- The `OperationsReport` interface (L54–~132) mirrors `src/api/lib/operations-report.ts`
  field for field. Changing a collector field without changing this interface produces
  silent `undefined`s in the newspaper, not a type error — the response is cast, not parsed.
- Daily is a different report entirely: `GET /api/reports/compliance.json` +
  `src/api/lib/compliance-report.ts`, rendered by `src/pages/daily-report.tsx` itself.
  Weekly/Monthly is the only thing this module draws.

---

## 5. Accounting — Debit Notes

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/invoices/debit-notes.tsx` — `/invoices/debit-notes`, gated `RequirePermission resource="invoices" action="read"` (`src/dashboard-routes.tsx:349-356`); DataGrid list + create modal + batch voucher print/export (500) | `src/api/routes/debit-notes.ts` (450) — `GET /` (`:122`), `POST /` (`:137`), `GET /:id` (`:282`), `PUT /:id` (`:302`) | `debit_notes` (items are JSON TEXT in one column), and on POSTED: `customers.outstandingSen`, `invoices.totalSen/subtotalSen/status`, the GL via `buildDebitNoteLedgerLegs` | **NONE dedicated.** Only cross-cutting sweeps name the file — `tests/tenant-isolation.test.mjs` lists it at line 151, plus `tests/security-route-coverage.test.mjs`, `tests/security-permission-matrix.test.mjs`, `tests/audit-coverage.test.mjs` |

**Endpoints called:** `GET /api/debit-notes` (`:78`, via `useCachedJson`),
`GET /api/invoices` (`:84`, only while the create modal is open),
`POST /api/debit-notes` (`:152`).

**Gotchas — three, all worth knowing before you touch this**

1. **The page cannot post a debit note.** `PUT /api/debit-notes/:id` (`debit-notes.ts:302`)
   is the ONLY transition that charges the customer (`:339` `outstandingSen + ?`), bumps the
   linked invoice and re-opens its status (`:375-381`), and writes the GL legs (`:396-410`).
   **No frontend calls it** — the only `/api/debit-notes` references in `src/` are the list,
   the create, and the generic CRUD factory `src/lib/api/resources/billing.ts:36`. Every DN
   raised from this screen stays DRAFT, while the page's own "Posted" tile (`:254`) counts a
   status nothing in the UI can reach.
2. **Per-id handlers are not tenant-scoped.** `GET /` scopes on `WHERE orgId = ?` (`:128`),
   but `GET /:id` (`:287`), `PUT /:id` (`:309`, `:331`) and the POST re-read (`:257`) select
   and update **by id alone**. `tests/tenant-isolation.test.mjs` passes anyway because it
   only asserts each route scopes *at least one* query. This is BUG-CLASSES C12 territory —
   check it before onboarding a second org.
3. **Money is sen and is read dual-keyed on the way out** (`item.unitPriceSen ?? item.unitPrice`,
   `item.totalSen ?? item.total`) at page `:49-50` and `:342-343`, and again in the route's
   `parseItems` (`:69-70`) — the Tier-D D2 back-compat for legacy rows written before the
   `unitPrice` → `unitPriceSen` rename. POST **rejects** a body carrying `unitPrice`
   (`:185-193`). Keep both halves.

**⚠ Read bug found — the MOBILE Debit Notes list shows RM 0.00 for every note.**
`src/pages/m/config/modules.ts:819-838` builds its rows with `str(r,"dnNo","debitNoteNo")`
and `num(r,"totalSen")`. The API returns **`noteNumber`** and **`totalAmount`**
(`debit-notes.ts:80`, `:89`) — neither `dnNo`, nor `debitNoteNo`, nor `totalSen` exists in
the response. `read()` in `src/pages/m/config/helpers.ts:35-41` returns `undefined`, so
`num` yields `0` (`:48-52`) and `str` yields `""`. Result: the Reference column is blank,
`code` falls back to the raw `dn-xxxxxxxx` id, and both the card amount and the Amount
column read RM 0.00. The **credit-notes source three rows above it has the identical shape**
(`cnNo` / `creditNoteNo` / `totalSen` vs `credit-notes.ts:87`, `:96` returning
`noteNumber` / `totalAmount`), so this is a two-instance class — fix both or it recurs
(fix-then-sweep, `docs/PLAYBOOKS.md`).

---

## 6. BOM — Component Kits

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/component-kits/index.tsx` — `/bom/component-kits` (`src/dashboard-routes.tsx:482`; sidebar PRODUCTION → "Component Kits"); kit cards + inline editor with multi-parent create (502) | `src/api/routes/component-boms.ts` (87) — `GET /` (`:30`), `GET /:parentCode` (`:38`), `PUT /:parentCode` (`:51`), `DELETE /:parentCode` (`:75`); logic in `src/api/lib/component-bom.ts` (`saveKit`, `explodeKits`) | `component_bom_lines` (runtime-created, `src/api/lib/component-bom.ts:32`) | `tests/component-kit-subbom.test.mjs` (functional explosion math + structural pins) |

**Endpoints called:** `GET /api/component-boms` (`:65`),
`GET /api/inventory?buckets=rawMaterials` (`:69`),
`PUT /api/component-boms/:parentCode` (`:150`),
`DELETE /api/component-boms/:parentCode` (`:190`).

**Gotchas**

- **`?buckets=rawMaterials` is a measured perf fix, not decoration** (`:66-69`,
  BUG-2026-08-13-021). Without it this uncached raw fetch pulled a 1.16 MB three-bucket
  payload on every `reload()`. Don't drop the query param.
- **A failed list read now THROWS on purpose** (`:75`). It used to fall through silently and
  leave the page on "No component kits yet" — indistinguishable from a genuinely empty list,
  which is exactly how a camelCase read bug in the backend stayed invisible *after a
  successful save*. This is the same de-fabrication rule the map applies elsewhere: an
  unknown must not render as a zero. Keep it loud.
- **Multi-parent save writes sequentially and reports partials** (`:144-172`). One rejected
  promise would hide which parents actually landed; the loop reports "3 of 4 saved, X
  failed" and keeps the editor open to retry. The self-reference guard runs BEFORE the loop
  (`:136-140`) so one bad pick cannot half-apply the save.
- The kit is the orthodox multi-level-BOM / phantom pattern: every product BOM referencing
  the parent SKU auto-explodes its children into consumption and costing via `explodeKits`
  (`src/api/lib/component-bom.ts:221`) and `po-cost-cascade.ts`. Never re-list the children
  in a product BOM.

---

## 7. Delivery — Delivery Returns

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/delivery-returns/index.tsx` — `/delivery-returns` (`src/dashboard-routes.tsx:300`; sidebar SALES & CUSTOMERS → "Delivery Return"); DataGrid list + create-from-DO modal; `?createFrom=<doId>` deep link from a DO (419). Detail page: `src/pages/delivery-returns/detail.tsx` at `/delivery-returns/:id` (`:302`) | `src/api/routes/delivery-returns.ts` (483) — 8 handlers, see below | `delivery_returns`, `delivery_return_items` (runtime-ensured by `ensureDeliveryReturnTables`, `src/api/lib/delivery-return-create.ts`); cascades touch `fg_batches`, `fg_units`, `cost_ledger`, `fg_stock_events` | **NONE dedicated.** The file appears only inside cross-cutting suites: `tests/fg-stock-events.test.mjs`, `tests/customer-scope.test.mjs`, `tests/customer-scope-sql.test.mjs`, `tests/derived-permissions.test.mjs`, `tests/nav-permissions.test.mjs`, `tests/permission-wildcards.test.mjs`, `tests/record-load-failure-class.test.mjs`, `tests/reverse-doc-links.test.mjs` |

**Route surface — `src/api/routes/delivery-returns.ts`**

| Handler | Line | Note |
|---|---|---|
| `GET /` | `:162` | org-scoped **and** `customerScopeSql` narrowed (`:169`), `LIMIT 500` |
| `GET /:id` | `:189` | by id only — **not** org-scoped |
| `GET /do-items?doId=` | `:213` | enrichment for the picker — **unreachable, see below** |
| `POST /` | `:227` | delegates to `createDeliveryReturnRecord` so the office flow and the driver "Not received" flow write an identical record |
| `POST /:id/return-to-stock` | `:340` | reverses COGS + flags `fg_units` RETURNED + status |
| `POST /:id/set-outcome` | `:387` | `PURE_RETURN` also runs the restock half |
| `POST /:id/mark-redelivered` | `:444` | |
| `POST /:id/cancel` | `:460` | refuses CLOSED / REDELIVERED / CN_ISSUED |

**Endpoints called by the page:** `GET /api/delivery-returns` (`:52`),
`GET /api/delivery-orders` (`:210-212`, filtered to DELIVERED/INVOICED at `:216`),
`GET /api/delivery-orders/:id` (`:233`),
`GET /api/delivery-returns/do-items?doId=` (`:243-245`),
`POST /api/delivery-returns` (`:292`).

**Gotchas**

- **Restock and repair are mutually exclusive by design.** Both `return-to-stock` (`:357`)
  and `set-outcome` (`:404`) 409 unless the DR is `OPEN`. That is what stops a unit being
  booked back as good stock *and* remade — a double count of inventory and COGS. The
  reversal itself is separately idempotent (`reverseFGForDeliveryReturn` no-ops on
  `refType='DELIVERY_RETURN' AND refId=drId`). Do not relax the OPEN check.
- `PURE_RETURN` = goods back in sellable stock **and** money refunded by CN, so `set-outcome`
  runs the restock statements inline (`:417-421`). `REPAIR_REDELIVER` touches no inventory.
- Creating a return invalidates the DO cache (`page :149`) because
  `GET /api/delivery-orders/:id` now returns `linkedReturns`.

**⚠ Route bug found and REPRODUCED — `GET /api/delivery-returns/do-items` is unreachable.**

`app.get("/:id")` is registered at `:189`; `app.get("/do-items")` at `:213`, **24 lines
later**. Hono matches in registration order here, so the param handler wins. Executed
against this repo's own `hono@4.12.14`, replicating the exact registration order:

```
/          -> list
/abc       -> byid:abc
/do-items  -> byid:do-items      ← should be "do-items"
```

So the request lands on the `/:id` handler, looks up a delivery return whose id is the
literal string `"do-items"`, finds none, and returns
`404 { success:false, error:"Delivery return not found" }`.

**Why nobody noticed:** the caller at `src/pages/delivery-returns/index.tsx:242-266` does not
throw on a 404 — `r2.json()` parses fine, `j2?.data ?? []` becomes an empty array, every
`refs.get(...)` misses, and each item is kept unmodified. No error, no toast, not even the
`catch` fallback at `:264`. The enrichment simply never happens, silently.

**What that costs:** the Cust PO / Ref line at `:383-395` is what tells two identical
products on one DO apart. Those fields are exactly the ones the DO's own items do **not**
carry — which is why `/do-items` was built (`:207-212`, and `:237-241`). The owner's
2026-07-16 complaint ("要不然我怎麼知道要選那個" — how am I supposed to know which one to
pick) is therefore still live in production. The list column at `:87-91` reads
`row.items[0].reference` off the persisted record, so it is unaffected; only the picker is.

**Fix:** move `app.get("/do-items")` above `app.get("/:id")`. The sibling route
`src/api/routes/three-pl-vehicles.ts:153-156` already documents this exact rule in a comment
and gets it right — cite it in the fix.

---

## 8. Fleet & Maintenance — 3PL Vehicles, Equipment

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| No page of its own — consumed by `src/pages/delivery/index.tsx` (provider/vehicle dialogs: `:1751`, `:2036`, `:2061`), `src/pages/consignment/note.tsx` (`:873`, `:927`, `:963`) and `src/pages/m/config/modules.ts:3999` | `src/api/routes/three-pl-vehicles.ts` (446) — `GET /collisions` (`:165`), `GET /` (`:195`), `POST /` (`:211`), `GET /:id` (`:305`), `PUT /:id` (`:320`), `DELETE /:id` (`:428`) | `three_pl_vehicles` (FK to the misnamed `drivers` table = 3PL **providers**) | `tests/tenant-isolation.test.mjs`, `tests/houzs-sweep-hardening.test.mjs` — **no feature test** |
| `src/pages/maintenance.tsx` — `/maintenance` (`src/dashboard-routes.tsx:480`); calls `/api/equipment` at `:79`, `:176`, `:211`, `:253`, `:257` | `src/api/routes/equipment.ts` (405) — `GET /` (`:110`), `POST /` (`:163`), `GET /:id` (`:213`, nested `logs`), `PUT /:id` (`:236`), `DELETE /:id` (`:389`) | `equipment`, `maintenance_logs` | `tests/equipment-assets-docs.test.mjs`, `tests/tenant-isolation.test.mjs` |

**`three-pl-vehicles.ts` gotchas**

- **`drivers` holds PROVIDERS, not people.** Migration 0014's naming misnomer; each provider
  row owns many vehicles here, and pricing follows the truck (`ratePerTripSen`,
  `ratePerExtraDropSen`) because a 3-ton and a 5-ton from the same dispatcher quote
  different rates. DO POST/PUT looks a vehicle up here to denormalise plate + type onto the
  DO row and recompute `deliveryCostSen`.
- **This file is the repo's reference example of Hono route ordering** — `/collisions` is
  mounted at `:165`, before `/:id` at `:305`, with the reason written down at `:153-156`.
  §7 above is the same file family getting it wrong; use this one as the fix template.
- **`plate_norm` is deliberately NON-unique** (`:55-59`). Production already contains
  collisions and a unique index would either fail to build or start rejecting saves before
  anyone decides which duplicate wins and what happens to the delivery history on the loser.
  `GET /collisions` reports them; the repair is the owner's call. New duplicates are blocked
  at POST (`:249-262`), so the list can only shrink. Renaming a plate re-normalises it
  (`:400-402`) or the row keeps matching its old identity forever.
- **`GET /` (`:195`) and `GET /:id` (`:305`) carry NO `requirePermission` gate**; only
  POST/PUT/DELETE do (`lorries` create/update/delete). And only `GET /` is org-scoped
  (`:200-201`) — `/:id`, PUT and DELETE act by id alone, and the POST duplicate check
  (`:250`) is org-WIDE with no comment saying whether that is intentional. Contrast the
  consignment routers, where the deliberate org-wide reads are commented in place.
- **Minor read bug: `createdAt` / `updatedAt` are always `""` in this route's responses.**
  `rowToVehicle` (`:128-129`) reads `row.created_at` / `row.updated_at`, but the queries are
  `SELECT *` and the PG adapter rewrites snake→camel on read
  (`src/api/lib/db-pg.ts:47-59`, using the inverse of `column-rename-map.json`, which maps
  `createdAt→created_at` and `updatedAt→updated_at`). So the row keys are `createdAt` /
  `updatedAt` and the snake reads miss. The `boxLengthFt` family two lines below is dual-keyed
  correctly (`:133-135`) — these two were missed. No current caller displays them, hence low
  severity; fix with `row.createdAt ?? row.created_at`.

**`equipment.ts` gotchas**

- `PUT /:id` is **two endpoints in one**: a `{ logMaintenance: {...} }` body appends a
  `maintenance_logs` row, advances `lastMaintenanceDate`/`nextMaintenanceDate` by
  `maintenanceCycleDays`, and clears MAINTENANCE/REPAIR back to OPERATIONAL (`:254-306`);
  anything else is a partial merge update (`:308-347`). The `pick()` helper (`:311`) exists
  so a partial PUT from one dialog cannot blank fields another dialog owns.
- The asset-identity columns (model / serial_no / manufacturer / supplier /
  purchase_price_sen / warranty_expiry, owner 2026-08-01) are **runtime self-applied** by
  `ensureEquipmentAssetColumns` (`:133-155`) — migration files are inert on deploy. The memo
  flag is set only when EVERY statement lands (`ok`, `:135`/`:154`) so a half-applied schema
  is retried rather than remembered as done. Reads are dual-keyed (`:72`, `:77`, `:78`).
- `maintenance_logs` has **no `created_at` column in production** — the INSERT at `:262-264`
  omits it deliberately (BUG-2026-08-13-031); the note lives in `routes/maintenance-logs.ts`.
- Money: `toSen` (`:158-161`) converts the form's ringgit to integer sen on the way in;
  storage is `purchase_price_sen`. Never store the ringgit.
- **`GET /` (`:110`) and `GET /:id` (`:213`) carry no `requirePermission` gate**; and only
  `GET /` is org-scoped (`:114`). Same shape as the 3PL route above.

---

## Verification performed

- `node scripts/check-codebase-map.mjs` — see the PR body for the run output.
- `wc -l` on all 12 target files + `src/dashboard-routes.tsx`; every count in the tables above
  is that command's output. **`wc -l` is this map's convention** — checked against a row that
  has not drifted: the map says `src/pages/sales/index.tsx` (2181) and `wc -l` says 2181.
  `scripts/check-codebase-map.mjs` prints counts **one higher** (`login.tsx (1289 lines)`)
  because it measures `split(/\r?\n/).length`, which yields a trailing empty element on any
  newline-terminated file. Both numbers are right about different things; the MAP uses
  `wc -l`. Recording this so the two figures stop being "corrected" into each other.
- Every `file:LINE` in this fragment was opened and read; no claim rests on grep or on a
  comment alone.
- The §7 routing bug was reproduced by executing the registration order against
  `hono@4.12.14` resolved from this repo — not inferred from documentation.
- The §5 mobile read bug was confirmed by reading `read()`/`str()`/`num()` in
  `src/pages/m/config/helpers.ts:35-52` against the response builders in
  `src/api/routes/debit-notes.ts:77-93` and `src/api/routes/credit-notes.ts:87,96`.
- Fabricated-data sweep over all 12 files: **clean**. The only `Math.random` hits are
  `src/pages/login.tsx:130` (a comment recording that it was REPLACED by a seeded LCG for
  snowflake positions) and `src/api/routes/debit-notes.ts:100` (a comment recording a fixed
  2026-04-28 DN-numbering bug). No mock rows, no invented document numbers, no statuses
  rendered as real. `login.tsx:1201-1204` records an earlier fabricated stat panel that was
  already deleted.
- **No test names were invented.** Where a file has no test, this fragment says **NONE** and
  names the cross-cutting suites that merely mention it.
