# Architecture

A bird's-eye view of how HOOKKA ERP is put together — the shape of the
frontend, the Hono API on Cloudflare Pages Functions, the Postgres data
layer, and the extension points you should know about before touching
anything.

> **2026-04-29 update** — this doc previously described a mock-data-only
> world that's been retired since the D1→Supabase migration completed
> 2026-04-27. The runtime now serves real data from Supabase Postgres
> via Hyperdrive. The mock layer (`src/api/routes-mock/*` + `src/lib/mock-data.ts`)
> is **dev-server-only** and not reachable from the deployed Pages site.

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
│         ▼  fetch('/api/...', { credentials: 'include' })│
└─────────┼───────────────────────────────────────────────┘
          │
          │  HttpOnly hookka_session cookie + X-CSRF-Token
          │  (Bearer fallback retained one release)
          │
┌─────────┴───────────────────────────────────────────────┐
│  Cloudflare Pages Function — functions/api/[[route]].ts │
│  ┌────────────────────────────────────────────────┐     │
│  │  src/api/worker.ts (Hono)                       │    │
│  │   • CORS + no-cache + security headers          │    │
│  │   • timing middleware                           │    │
│  │   • DB injection (SupabaseAdapter wraps         │    │
│  │     postgres.js → Hyperdrive)                   │    │
│  │   • authMiddleware (cookie-first / Bearer)      │    │
│  │   • tenantMiddleware (orgId from JWT)           │    │
│  │   • ~70 route subapps from src/api/routes/      │    │
│  │     each calls requirePermission + withOrgScope │    │
│  └───────────────┬────────────────────────────────┘     │
│                  │                                      │
│  ┌───────────────▼────────────────────────────────┐     │
│  │  Hyperdrive (Cloudflare-pooled Postgres)        │    │
│  │   ↓                                             │    │
│  │  Supabase Postgres (primary OLTP)               │    │
│  │   • 80+ migrations under migrations-postgres/   │    │
│  │   • org_id NOT NULL on all transaction tables   │    │
│  │   • immutable ledger_journal_entries hash chain │    │
│  │   • PITR (7d WAL) + daily pg_dump → R2          │    │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

The frontend and API live in the same repo and ship together. Production
serves real Postgres data on every `/api/*` route mounted in
`src/api/worker.ts`. The dev-only Hono node server (`src/api/index.ts` on
port 3001) and `src/api/routes-mock/*` are **not deployed** — they exist
for offline development without Hyperdrive credentials.

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

### Production server

The deployed API is a Cloudflare Pages Function — `functions/api/[[route]].ts`
imports `src/api/worker.ts` which is the real Hono app. Mounted middleware
(in order):

1. **CORS** — allowlist of Pages origin + local Vite dev (8787).
2. **Timing + observability** — `[req] ...` / `[slow-req] ...` lines via
   `wrangler tail`; W3C `traceparent` propagation; per-request DB time
   aggregated into `Server-Timing` response header.
3. **No-cache + security headers** — `X-Content-Type-Options: nosniff`,
   `X-Frame-Options: DENY`, HSTS, `Referrer-Policy`, `Permissions-Policy`,
   and CSP (report-only on the SPA shell).
4. **DB injection** — `SupabaseAdapter` wraps `postgres.js` to expose a
   D1-shaped interface as `c.var.DB`. Connection routed through Cloudflare
   Hyperdrive (pooled Supabase Postgres).
5. **authMiddleware** — soft-auth; reads `hookka_session` HttpOnly cookie
   first, falls back to `Authorization: Bearer` (legacy clients during
   migration window). On public-allowlisted routes (`/api/auth/login`,
   `/api/health`, `/api/fg-units/:id` for QR tracking, etc.) the middleware
   continues without auth but populates `userId` if a valid token IS
   present (so handlers can branch on auth state).
6. **CSRF check** — for cookie-authed mutating methods, requires
   `X-CSRF-Token` header to match the `hookka_csrf` cookie.
7. **tenantMiddleware** — resolves `users.orgId` into Hono context;
   throws `OrgIdRequiredError` (→ 401) if absent.
8. **Route subapps** — ~70 files in `src/api/routes/` mount at `/api/<resource>`.

The dev server (`src/api/index.ts`, port 3001) wires a parallel Hono app on
Node that imports `src/api/routes-mock/*` (in-memory fixtures). Start with
`npm run api`. **This is dev-only and unreachable in production.**

### Route conventions

Each route file in `src/api/routes/` is a thin `Hono` sub-app:

```ts
const app = new Hono<Env>()

app.get('/', async (c) => {
  const denied = await requirePermission(c, "<resource>", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const rows = await c.var.DB.prepare(
    "SELECT * FROM <table> WHERE org_id = ? ORDER BY created_at DESC"
  ).bind(orgId).all();
  return c.json({ success: true, data: rows.results, total: rows.results.length });
});

app.post('/', async (c) => {
  const denied = await requirePermission(c, "<resource>", "create");
  if (denied) return denied;
  return withIdempotency(c, "<resource>", c.req.header("Idempotency-Key"),
    async () => { /* validate + insert + audit emit + return */ }
  );
});
```

Uniform envelope:

```jsonc
// success
{ "success": true, "data": …, "total"?: N }

// failure
{ "success": false, "error": "Customer not found" }
```

Validation is opt-in via `src/lib/validation.ts` Zod schemas (broader Zod
coverage on POST/PATCH bodies is a P2 follow-up — today money handlers
have first-priority).

### Data model

Types live in `src/types/index.ts` (canonical for both backend handlers
and frontend pages). `src/lib/mock-data.ts` is dev-server seed data only
and **not** shipped to the SPA bundle (ESLint `no-restricted-imports`
rule blocks value imports of it from `src/pages/**` and
`src/components/**`).

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
| `mock-data.ts`               | Dev-only seed + types re-export. Banned from page bundle.   |
| `pricing-options.ts`         | Static pricing constants (divan/leg/seat/special-order)     |
| `utils.ts`                   | `cn()`, `formatCurrency()`, `formatDate()`, `getStatusColor` |
| `pricing.ts`                 | Unit + line total calculation, seat-height price picker     |
| `costing.ts`                 | FIFO consume + month-floating labor rate (sen integer)      |
| `scheduling.ts`              | Capacity-aware production scheduling                        |
| `scheduler.ts`               | `useInterval` / `useTimeout` with `pauseOnHidden`           |
| `cached-fetch.ts`            | SWR + AbortController + in-flight dedup over `useState` cache |
| `validation.ts`              | Shared Zod schemas (SO create body, DO create body, …)      |
| `material-lookup.ts`         | SKU ↔ product match / fuzzy lookup                          |
| `po-parser.ts`               | Parse supplier-PO emails / PDFs → structured items          |
| `auth.ts`                    | `getCurrentUser`, `isAuthenticated`, login response handling |
| `csrf.ts`                    | Read `hookka_csrf` cookie + attach `X-CSRF-Token` header    |
| `image-compress.ts`          | OffscreenCanvas-based photo compression off main thread     |
| `monitoring.ts`              | Optional Sentry init (no-op if `VITE_SENTRY_DSN` unset)     |
| `qr-utils.ts`                | FG-unit QR encode/decode, track URL builder                 |
| `pdf-utils.ts`               | Shared jsPDF helpers (header, footer, signatures)           |
| `generate-*-pdf.ts`          | One generator per document (dynamic-imported on click)      |
| `production-order-builder.ts`| Explode SO item → PO(s) per department                      |

`src/api/lib/`:

| File                          | Purpose                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `auth-middleware.ts`          | Cookie-first session resolution, soft-auth on public paths |
| `rbac.ts`                     | `requirePermission(c, resource, action)` gate              |
| `tenant.ts`                   | `getOrgId`, `withOrgScope` for per-tenant SQL              |
| `rate-limit.ts`               | KV-backed login + auth-flow rate limiter                   |
| `idempotency.ts`              | `withIdempotency` for money mutations                      |
| `audit.ts`                    | `emitAudit` + `buildAuditStatement` for txn batching       |
| `journal-hash.ts`             | Append-only SHA-256 ledger, `verifyJournalChain` helper    |
| `email-outbox.ts`             | `enqueueEmail` + `processOutbox` (retry-with-backoff)      |
| `supabase-compat.ts`          | D1-shaped facade over `postgres.js`; batch = transaction   |
| `monitoring.ts`               | Optional toucan-js error capture in worker                 |
| `job-card-persistence.ts`     | Shop-floor localStorage overlay (server-only deps)         |

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

1. ~~**Mock data → real database**~~ — **DONE 2026-04-27.** Production
   serves real Postgres via Hyperdrive. The mock-data layer remains
   only for offline dev (`npm run api`).

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
