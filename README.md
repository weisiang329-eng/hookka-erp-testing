# HOOKKA ERP

In-house ERP for a Malaysian furniture manufacturer — covers the full flow from
sales order → production scheduling → shop-floor job cards → QR-tracked finished
goods → delivery → e-invoicing → accounting, plus procurement, inventory,
consignment, R&D, payroll, and a customer self-service portal.

> **Last verified: 2026-08-13** against `package.json`, `vite.config.ts`,
> `wrangler.toml`, `src/router.tsx`, `src/dashboard-routes.tsx`, `src/layouts/`,
> `src/components/`, `src/hooks/`, `src/api/lib/auth-middleware.ts`.
> Corrected 2026-08-13: this README described a **mock-data, no-auth, no-storage
> prototype**. All three claims were false and had been false since April 2026 —
> the app runs on Supabase Postgres, auth is fully wired, and files go to Supabase
> Storage. The `npm run api` / port-3001 quick start, the `/portal` module, and
> `PortalLayout` do not exist.

Built as a single-page React app talking to a Hono API that runs as a Cloudflare
Pages Function. Business data lives in **Supabase Postgres**, reached through a
Cloudflare Hyperdrive binding (`src/api/lib/db-pg.ts` presents a D1-shaped
`prepare/bind/all` interface over it). See `docs/ARCHITECTURE.md`.

**Agents: start at [`CLAUDE.md`](CLAUDE.md), then
[`docs/CODEBASE-MAP.md`](docs/CODEBASE-MAP.md).** Do not `grep`/`glob` the whole
repo — it times out at this size.

---

## Tech stack

- **UI** — React 19 + Vite 8 + TypeScript 6
- **Styling** — Tailwind CSS 4 + design tokens (`src/lib/design-tokens.ts`)
- **Routing** — React Router 7 (data router, lazy-loaded routes)
- **Forms** — React Hook Form 7 + Zod 4
- **Tables** — TanStack Table 8 + internal DataGrid wrapper
- **Charts** — Recharts 3
- **PDFs** — jsPDF 4 + jspdf-autotable (invoice / DO / SO / PO / GRN / payslip / etc.)
- **API** — Hono 4, deployed as a Cloudflare Pages Function
- **Database** — Supabase Postgres via Cloudflare Hyperdrive (`postgres` driver)
- **File storage** — Supabase Storage
- **Errors** — Sentry (browser) + toucan-js (worker)
- **Icons** — lucide-react
- **Date maths** — date-fns

All dependencies are pinned in `package.json`. The app runs fully on Node ≥ 20.

---

## Quick start

```bash
npm install

# Full stack against Supabase (needs DATABASE_URL in .dev.vars) — port 8787
npm run dev:worker

# UI-only Vite dev server — port 3000
npm run dev
```

> ⚠️ `npm run dev` alone does **not** give you a working API. `vite.config.ts`
> still proxies `/api` to `http://localhost:3001`, which is a leftover from a
> Node API server that no longer exists (there is no `npm run api` script). Use
> `npm run dev:worker`, which runs `wrangler pages dev` in front of Vite.

Other commands (this is the complete script list — anything else you read in an
older doc is gone):

```bash
npm run build            # vite build → dist/
npm run build:strict     # typecheck:app + build  ← the pre-push gate
npm run typecheck:app    # tsc -p tsconfig.app.json --noEmit
npm test                 # node --test tests/*.test.mjs  (3,768 tests, ~45 s)
npm run lint             # eslint . (flat config, see eslint.config.js)
npm run preview          # serve dist/ locally
npm run deploy           # build + wrangler pages deploy dist
npm run db:migrate:supabase        # apply pending Postgres migrations
npm run db:migrate:supabase:dry    # …dry run
```

---

## Module map

Major functional areas, each a subdirectory under `src/pages/`:

| Module       | Route              | Purpose                                                            |
| ------------ | ------------------ | ------------------------------------------------------------------ |
| Dashboard    | `/dashboard`       | KPI tiles, aging AR/AP, production throughput, stock alerts        |
| Sales        | `/sales`           | Quotations → Sales Orders, customer + variant picker, promise date |
| Production   | `/production`      | POs per SO, job cards per department, QR scanning, FG stickers     |
| Delivery     | `/delivery`        | DO build, truck load, sign-off, POD upload                         |
| Invoices     | `/invoices`        | AR invoices, payments, credit/debit notes, e-invoice submission    |
| Procurement  | `/procurement`     | Supplier POs, GRN, in-transit, pricing history, 3-way match        |
| Inventory    | `/inventory`       | Stock on hand (FG + WIP + RM), fabric runs, valuation              |
| BOM          | `/bom`, `/products`| Product variants, BOM hierarchy (FG → WIP → RM)                    |
| Customers    | `/customers`       | Customer master + delivery hubs (one customer ↔ N addresses)       |
| Warehouse    | `/warehouse`       | Rack occupancy, put-away, picking                                  |
| Consignment  | `/consignment`     | Stock at customer branch, consignment notes, returns               |
| Accounting   | `/accounting`      | Chart of accounts, P&L, balance sheet, cash flow                   |
| Planning     | `/planning`        | MRP, capacity, scheduling board                                    |
| Quality      | `/quality`         | QC inspections per production stage                                |
| R&D          | `/rd`              | Project pipeline + prototype lineage                               |
| Employees    | `/employees`       | Worker master, attendance, leaves, payroll, payslips               |
| Worker portal| `/worker`          | Shop-floor phone portal (PIN login, scan, QC, payslip)             |
| Track        | `/track`           | Public FG unit tracking (no auth, mobile)                          |
| Settings     | `/settings`        | Organisations, users, product variants, feature toggles            |

There is **no `/portal` customer self-service module** — that was planned in
April 2026 and never built. The real route table is `src/dashboard-routes.tsx`
(dashboard tree) + `src/router.tsx` (public/auth/worker/mobile shells).

The API does **not** mirror these modules 1:1 — there are 139 mounts over 136
route files. The mount table is [`docs/API.md`](docs/API.md), which is
**generated** from the source (`node scripts/gen-api-docs.mjs`), so it cannot
drift.

---

## Repository layout

```
functions/api/[[route]].ts   Cloudflare Pages Function → imports src/api/worker.ts
src/
  api/
    worker.ts       THE Hono app (middleware chain + 139 route mounts)
    routes/         136 route files, one per resource (+ 4 subdirectories)
    lib/            server-side helpers (auth, rbac, tenancy, db adapter, …)
    cron/           daily-backup.ts
    queues/         po-emission-consumer.ts
  assets/           Static images (logo, sample POs)
  components/
    layout/         Sidebar, topbar, page shell
    ui/             38 shared UI primitives (DataGrid, PageHeader, FilterBar,
                    StatusBadge, MoneyInput, StatusTabStrip, …)
  hooks/            useFormValidation, useMediaQuery
  layouts/          DashboardLayout + WorkerLayout (route-level shells)
  lib/              client-side domain logic, PDF generators, formatters
  pages/            One directory per module (see table above)
  router.tsx        Public / auth / worker / mobile shells
  dashboard-routes.tsx  The dashboard route table (lazy-loaded per page)
  main.tsx          App entry
  types/index.ts    Shared enums + interfaces

migrations-postgres/  244 Postgres migrations (the live schema)
migrations/           131 legacy SQLite migrations (D1 era, retired 2026-04-27)
tests/                ~330 node:test files — `npm test`
scripts/              one-off + operational scripts, incl. gen-api-docs.mjs
mobile/, mail-sync/, mail-inbound-worker/, agent-heartbeat-worker/
                      satellite deployables

docs/
  CODEBASE-MAP.md   THE code map — read before touching any module
  PLAYBOOKS.md      Fixed steps for recurring tasks
  BUG-CLASSES.md    Recurring bug classes + every known instance
  context-packs/HOOKKA-GOTCHAS.md   The traps (schema / money / SQL / ship)
  DOCS-INDEX.md     Documentation index
  ARCHITECTURE.md   System architecture, data flow, extension points
  API.md            GENERATED endpoint reference (gen-api-docs.mjs)
  modules/*.md      Per-module deep guides (15)
  archive/          Retired one-off docs, kept for history only

eslint.config.js    Flat config (typescript-eslint + react-hooks + react-refresh)
tsconfig.*.json     Separate configs for app / node (Vite convention)
vite.config.ts      Vite + Tailwind 4 plugin
wrangler.toml       Pages project, Hyperdrive binding, KV, vars
```

---

## Design system at a glance

Every colour decision routes through `src/lib/design-tokens.ts`:

- **Brand chrome** — `#6B5C32` (primary, warm gold), `#1F1D1B` (heading),
  `#6B7280` (body), `#E6E0D9` (border), `#FAF8F4` (page cream).
- **Semantic palette** — `SUCCESS`, `WARNING`, `WARNING_HIGH`, `DANGER`, `INFO`,
  `NEUTRAL`, `ACCENT_PLUM`. Each is a `SemanticStyle` with `text`, `bg`,
  `border`, and raw `hex` so pages compose Tailwind classes without hard-coded
  shades.
- **Backend enum maps** — `SO_STATUS_COLOR`, `PRODUCTION_STATUS_COLOR`,
  `DELIVERY_STATUS_COLOR`, etc. Adding a new status value to the backend enum
  fails the TypeScript build until the map is updated — no silent fallbacks.
- **Thresholds** — `STOCK_THRESHOLD`, `WIP_AGE_THRESHOLD` consolidate the
  "what counts as low stock / aged WIP" decisions in one file.

Full token reference + component API: `docs/DESIGN-SYSTEM.md`.

---

## Conventions

- **No hard-coded Tailwind shades** for status / value indication. Use tokens.
- **Underscore-prefix** (`_foo`) marks intentionally-unused args / destructured
  slots. The ESLint rule ignores them (see `eslint.config.js`).
- **Double-click navigation** — every DataGrid row with a detail page wires
  `onRowDoubleClick` so tables are keyboard-navigable *and* fast.
- **Customer ↔ Hub** — one customer record, N delivery addresses
  (`CustomerHub`). Delivery orders pick a hub, never re-enter addresses.
- **BOM hierarchy** — `FG → WIP (Divan + Headboard) → RM`. WIP is generated
  dynamically per SO variant; the BOM page shows rolled-up RM totals.
- **Sen (cents)** — all currency stored as integer sen to avoid float error;
  `formatRM(sen)` / `formatCurrency(sen)` handle presentation.

---

## Corrections to what this README used to say

This section previously listed auth, persistence and file storage as **not
built**. All three shipped in April 2026 and the claim survived here for four
months. For the record, so nobody re-derives it from an old copy:

- **Auth is wired.** `RequireAuth` (`src/components/RequireAuth.tsx`) gates the
  dashboard tree; `authMiddleware` gates `/api/*` with an explicit public
  allow-list (`src/api/lib/auth-middleware.ts`); Google OAuth, TOTP 2FA, a
  separate PIN flow for the shop-floor portal, and RBAC (`src/api/lib/rbac.ts`,
  `role-policy.ts`) all exist. **API routes do not trust the caller.**
- **Persistence is real.** Supabase Postgres via Hyperdrive, 244 migrations.
  `src/lib/mock-data.ts` survives only as a types re-export + pricing constants;
  `eslint.config.js` blocks value imports of it.
- **File storage is real.** Supabase Storage (`src/api/lib/supabase-storage.ts`,
  `src/api/routes/files.ts`), plus nightly `pg_dump` uploads
  (`.github/workflows/backup.yml`).

See `docs/ARCHITECTURE.md` § "Extension points" for what genuinely remains open.
