# HOOKKA ERP

In-house ERP for a Malaysian furniture manufacturer — covers the full flow from
sales order → production scheduling → shop-floor job cards → QR-tracked finished
goods → delivery → e-invoicing → accounting, plus procurement, inventory,
consignment, R&D, payroll, and a customer self-service portal.

Built as a single-page React app talking to a Hono API. All data is mocked
in-memory during development; swapping for a real database is a one-module
rewrite (see `docs/ARCHITECTURE.md`).

---

## Tech stack

- **UI** — React 19 + Vite 8 + TypeScript 6
- **Styling** — Tailwind CSS 4 + design tokens (`src/lib/design-tokens.ts`)
- **Routing** — React Router 7 (data router, lazy-loaded routes)
- **Forms** — React Hook Form 7 + Zod 4
- **Tables** — TanStack Table 8 + internal DataGrid wrapper
- **Charts** — Recharts 3
- **PDFs** — jsPDF 4 + jspdf-autotable (invoice / DO / SO / PO / GRN / payslip / etc.)
- **API** — Hono 4 on `@hono/node-server`
- **Icons** — lucide-react
- **Date maths** — date-fns

All dependencies are pinned in `package.json`. The app runs fully on Node ≥ 20.

---

## Quick start

```bash
# install
npm install

# run the API (port 3001)
npm run api

# in another terminal, run the Vite dev server (port 3000)
npm run dev
```

Then open http://localhost:3000. The dashboard redirect is the root route;
Vite proxies `/api/*` to the Hono server on 3001.

Other commands:

```bash
npm run build     # tsc -b && vite build  (production bundle → dist/)
npm run preview   # serve dist/ locally
npm run lint      # eslint . (flat config, see eslint.config.js)
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
| Portal       | `/portal`          | Customer-facing self-service (orders, deliveries, account)         |
| Track        | `/track`           | Public FG unit tracking (no auth, mobile)                          |
| Settings     | `/settings`        | Organisations, product variants, feature toggles                   |

The Hono API mirrors these modules 1:1 under `/api/<module>/…` — see
`docs/API.md` for the endpoint inventory.

---

## Repository layout

```
src/
  api/              Hono server + routes/ (one file per resource)
  assets/           Static images (logo, sample POs)
  components/
    layout/         Sidebar, header, page shell
    ui/             Shared UI primitives (Badge, Button, Card, DataGrid,
                    PageHeader, FilterBar, Tabs, StatusBadge, …)
  hooks/            Reusable hooks (useToast, useDebounce, …)
  layouts/          DashboardLayout + PortalLayout (route-level shells)
  lib/
    design-tokens.ts    Single source of truth for colours / status maps
    mock-data.ts        In-memory database of SOs / POs / GRNs / … used
                        by API routes and by pages during dev.
    utils.ts            cn(), formatCurrency(), formatDate(), getStatusColor()
    generate-*-pdf.ts   Per-document PDF generators
    po-parser.ts        Supplier-PO email / PDF extraction
    validation.ts       Shared Zod schemas
    …
  pages/            One directory per module (see table above)
  router.tsx        React Router config (lazy-loaded per page)
  main.tsx          App entry
  types/index.ts    Backend-style enums + interfaces

docs/
  ARCHITECTURE.md   System architecture, data flow, extension points
  MODULES.md        Per-module reference (screens + API + data model)
  SETUP.md          Dev environment setup, troubleshooting
  DESIGN-SYSTEM.md  Token usage guide + shared component catalogue
  API.md            Hono endpoint inventory
  B-FLOW.md         Sticker-identity flow (production-test + delivery-test)

eslint.config.js    Flat config (typescript-eslint + react-hooks + react-refresh)
tsconfig.*.json     Separate configs for app / node (Vite convention)
vite.config.ts      Vite + Tailwind 4 plugin
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

## What's *not* in this repo

- **Auth** — login screen is a UI stub; real SSO / token flow is out of scope
  for the MVP. Every API route trusts the caller.
- **Persistence** — `mock-data.ts` lives in memory. Restart = reset. Wire a
  real DB by swapping the in-memory maps with a Prisma / Drizzle adapter.
- **File storage** — PDFs are generated on the fly and downloaded; there is
  no uploaded-file bucket yet.

See `docs/ARCHITECTURE.md` § "Extension points" for how each of these swaps in.
