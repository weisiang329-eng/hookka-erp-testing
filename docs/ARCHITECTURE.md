# Architecture

A bird's-eye view of how HOOKKA ERP is put together — the shape of the
frontend, the Hono API, the shared data layer, and the extension points you
should know about before touching anything.

---

## High-level diagram

```
┌──────────────────────── Browser ────────────────────────┐
│  React 19 SPA (Vite 8, code-split per route)            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Pages      │  │ Shared UI    │  │ Design Tokens  │  │
│  │  (/sales, …)│  │ (PageHeader, │  │ (colours,      │  │
│  │             │◄─┤  DataGrid,   │◄─┤  enum maps,    │  │
│  │             │  │  StatusBadge)│  │  thresholds)   │  │
│  └──────┬──────┘  └──────────────┘  └────────────────┘  │
│         │                                               │
│         ▼  fetch('/api/...')                            │
└─────────┼───────────────────────────────────────────────┘
          │
┌─────────┴───────────────────────────────────────────────┐
│  Hono API (Node, port 3001)                             │
│  ┌────────────────────────────────────────────────┐     │
│  │  routes/   one file per resource               │     │
│  │  sales-orders.ts → mock-data.salesOrders       │     │
│  │  production-orders.ts → mock-data.productionOrders
│  │  …                                             │     │
│  └───────────────┬────────────────────────────────┘     │
│                  │                                      │
│  ┌───────────────▼────────────────────────────────┐     │
│  │  lib/mock-data.ts                              │     │
│  │  In-memory maps of every entity (SO, PO, GRN,  │     │
│  │  Customer, Worker, FGUnit, …). Shared by the   │     │
│  │  API and imported directly by pages during dev.│     │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

The frontend and API live in the same repo and ship together. In production
the Hono server would front a real database; today every route reads and
mutates `mock-data.ts` in memory.

---

## Frontend

### Entry point

`src/main.tsx` mounts `<RouterProvider>` with the router defined in
`src/router.tsx`. The router is a single flat array of route objects:

- Auth + public tracking live outside any layout.
- Everything behind the sidebar lives under `<DashboardLayout>`
  (`src/layouts/DashboardLayout.tsx` — wraps `<Sidebar>` + `<Topbar>` + an
  `<Outlet>`).
- The customer-facing self-service lives under `<PortalLayout>`.

Every page is imported with `React.lazy()` and wrapped in `<Suspense>` with a
shared skeleton fallback. Bundle chunks are per-route.

### Page anatomy

Each page under `src/pages/<module>/<screen>.tsx` typically looks like:

```tsx
export default function SalesIndex() {
  const [filters, setFilters] = useState<Filters>(initialFilters)
  const { data, isLoading } = useSalesOrders(filters)   // fetches /api/sales-orders

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales Orders"
        subtitle="Quotations, confirmed orders, and closed orders"
        actions={<Button onClick={…}>New SO</Button>}
      />

      <FilterBar search={…}>{/* status dropdown, date picker, … */}</FilterBar>

      <DataGrid
        columns={columns}
        rows={data}
        onRowDoubleClick={(row) => nav(`/sales/${row.id}`)}
      />
    </div>
  )
}
```

Three conventions every page follows:

1. **PageHeader** — never hand-roll `<h1>` + subtitle + actions. Breadcrumbs,
   responsive wrap, and typography all live in the shared component.
2. **FilterBar** — search input + arbitrary child controls; optional
   `onClear` reset button.
3. **Double-click → detail** — every row with a `/<module>/:id` detail route
   wires `onRowDoubleClick` so keyboard-heavy users are not penalised.

### Shared UI catalogue

`src/components/ui/` is the entire design system. Highlights:

| Component           | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `PageHeader`        | Title + subtitle + actions + optional breadcrumbs              |
| `FilterBar`         | Search + arbitrary child controls + reset                      |
| `Tabs`              | `variant="underline"` (Inventory-style) / `"pill"` (dept-style) |
| `StatusBadge`       | `kind`-typed chip; adding a new backend enum is a compile error |
| `DataGrid`          | TanStack-Table wrapper with double-click, sticky header, etc.  |
| `DataTable`         | Lightweight striped table for read-only summaries              |
| `Button`, `Input`   | Tailwind + CVA variants, with loading + icon slots             |
| `Card`, `Skeleton`  | Layout primitives matching the brand beige                     |
| `FormField`         | Label + hint + error wrapper for RHF forms                     |
| `DocumentFlowDiagram` | Read-only lineage diagram (SO → PO → DO → Invoice graph)     |
| `ErrorBoundary`     | Route-level fallback (used by `errorElement`)                  |
| `ToastProvider`     | Top-level toast host, opened via `useToast()`                  |

All are re-exported from `src/components/ui/index.ts` (barrel).

### State and data fetching

The codebase uses plain `fetch` + local `useState` + `useEffect` for most
screens. There is **no Redux / Zustand / React Query** — every page pulls
fresh data on mount and refetches after mutations. This is intentional for
the mocked phase; when a real backend lands, the plan is to introduce React
Query as a single wrapper around each `fetch` call (see "Extension points").

A few pieces of ambient state:

- **Toasts** — `ToastProvider` + `useToast()` in `src/components/ui/toast.tsx`.
- **Persisted job-card state** — `src/lib/job-card-persistence.ts` stashes
  shop-floor form state in `localStorage` so workers don't lose in-progress
  entries on a tab reload.

### Styling

Tailwind CSS 4 via `@tailwindcss/vite`. Tokens live in
`src/lib/design-tokens.ts`, not in `tailwind.config.*` — that file is a stub.
Pages compose hex-based classes (`text-[#4F7C3A]`, `bg-[#EEF3E4]`) through
token objects so the brand palette is the single source of truth. See
`docs/DESIGN-SYSTEM.md` for the full rulebook.

Global CSS is limited to `src/index.css` (Tailwind's base + a few element
resets).

---

## API

### Server

`src/api/index.ts` wires a single Hono app on port 3001. It mounts ~55 route
files at `/api/<resource>/…` and serves a `/health` check. CORS is open to
the Vite dev server origin. Start it with `npm run api` (which uses `tsx`
and the app tsconfig for path aliases).

### Route conventions

Each route file in `src/api/routes/` is a thin `Hono` sub-app:

```ts
const app = new Hono()

app.get('/',      (c) => c.json({ success, data, total }))
app.get('/:id',   (c) => c.json({ success, data } | { error }))
app.post('/',     (c) => /* validate + mutate + return new resource */)
app.patch('/:id', (c) => /* partial update */)
app.delete('/:id',(c) => /* soft-delete where applicable */)

export default app
```

Uniform envelope:

```jsonc
// success
{ "success": true, "data": …, "total"?: N }

// failure
{ "success": false, "error": "Customer not found" }
```

There is no shared middleware for validation today; routes call into
`src/lib/validation.ts` Zod schemas where the shape warrants it. For the
MVP, bodies are permissive.

### Data model

All types live in `src/types/index.ts` (public / widely-used) and
`src/lib/mock-data.ts` (entity interfaces + seed data). The split is
historical; types that the backend "owns" (enums, core entities) belong in
`types/` and are imported by both the API and pages.

Relationships worth calling out:

- **Customer ↔ CustomerHub** — one customer, many delivery addresses
  (`CustomerHub`). Delivery orders pick a hub, never free-text addresses.
  See `docs/MODULES.md` § Customers.
- **SO → PO → JobCard → FGUnit → DO → Invoice** — the core forward chain.
  Every PDF generator corresponds to one document on that path.
- **BOM hierarchy** — `FG → WIP (Divan + Headboard) → RM`. WIP rows are
  built dynamically per SO variant from the department configs in the
  Production Sheet; they're not a pre-defined catalogue.

### Test-flow (B-flow) routes

`/api/test/production-orders`, `/api/test/fg-units`,
`/api/test/delivery-orders` are parallel endpoints used by the
`/production-test` and `/delivery-test` pages. They share nothing with the A
endpoints on purpose — the test flow is sandboxing a new sticker-identity
flow that re-labels FG units by physical batch instead of SO item. See
`docs/B-FLOW.md`.

---

## Shared library (`src/lib/`)

The non-UI heart of the app. A selected tour:

| File                         | Purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `design-tokens.ts`           | Colours, enum maps, thresholds (see DESIGN-SYSTEM)          |
| `mock-data.ts`               | In-memory DB + seed data + `generateId` / `getNext*No` gens |
| `utils.ts`                   | `cn()`, `formatCurrency()`, `formatDate()`, `getStatusColor` |
| `pricing.ts`                 | Unit + line total calculation, seat-height price picker     |
| `scheduling.ts`              | Capacity-aware production scheduling                        |
| `validation.ts`              | Shared Zod schemas (SO create body, DO create body, …)      |
| `material-lookup.ts`         | SKU ↔ product match / fuzzy lookup                          |
| `po-parser.ts`               | Parse supplier-PO emails / PDFs → structured items          |
| `job-card-persistence.ts`    | Shop-floor localStorage autosave                            |
| `qr-utils.ts`                | FG-unit QR encode/decode, track URL builder                 |
| `pdf-utils.ts`               | Shared jsPDF helpers (header, footer, signatures)           |
| `generate-*-pdf.ts`          | One generator per document (SO, Invoice, DO, GRN, PO, …)    |
| `production-order-builder.ts`| Explode SO item → PO(s) per department                      |

### Currency and dates

- **Currency** is stored as integer sen (100 sen = 1 RM) everywhere — DB,
  API, types, formulas. Never use floats. `formatRM(sen)` and
  `formatCurrency(sen)` in `utils.ts` produce display strings.
- **Dates** — ISO strings at the API boundary; `Date` objects or
  `date-fns` formatters in-app. `formatDateDMY` returns `DD/MM/YYYY` which
  matches MY conventions and most of the printed documents.

---

## Extension points

Places explicitly designed to be swapped:

1. **Mock data → real database**
   Every API route imports from `lib/mock-data.ts`. Replace those imports
   with a Prisma / Drizzle / Kysely data-access layer that exposes the same
   shapes. Types in `src/types/index.ts` and the entity interfaces in
   `mock-data.ts` are already database-shaped (no UI concerns leak in).

2. **`fetch` → React Query**
   Most pages call `fetch('/api/…')` inline. Wrapping those in React Query
   (one `useQuery` per screen) gives caching, retry, and optimistic updates
   for free. The uniform `{ success, data }` envelope is ready for it.

3. **Auth**
   The login page is a UI stub. When wiring a real provider (OAuth, SAML),
   add a `RequireAuth` wrapper in `router.tsx` around everything except
   `/login`, `/track`, and `/portal/login`. The API side would gain Hono
   middleware that verifies the token and populates `c.var.user`.

4. **Feature toggles**
   `src/lib/constants.ts` is the place for environment-driven flags. The
   test flow (`/production-test`, `/delivery-test`) is currently enabled
   unconditionally but is a prime candidate for a flag when promoting it.

5. **PDF output**
   Generators in `src/lib/generate-*-pdf.ts` all take a typed payload and
   emit a jsPDF `Blob`. If you need a real print service (Puppeteer,
   gotenberg), the callsite passes the same payload to a fetch and the
   return contract is unchanged.

---

## Conventions recap

- **No raw Tailwind status colours** — use `design-tokens.ts`. The ESLint
  config does not enforce this yet; rely on code review + the central
  component catalogue.
- **Underscore-prefix = intentionally unused** — args for signature
  compatibility, destructured slots as positional placeholders. Configured
  in `eslint.config.js`.
- **Barrel exports in `src/components/ui/index.ts`** — import from the
  barrel in pages (`import { PageHeader, Button } from '@/components/ui'`),
  not from individual files, to keep imports short.
- **Route-level code split** — all pages are lazy-imported. Don't import a
  page module from another page; use navigation.
- **Backend-driven enums** — if a status value can come from the API, add
  it to the relevant `Record<Enum, SemanticStyle>` in `design-tokens.ts`
  and use `StatusBadge kind="..."`. The TS compiler enforces coverage.
