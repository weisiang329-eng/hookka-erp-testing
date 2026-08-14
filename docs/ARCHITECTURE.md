# Architecture

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/api/worker.ts`, `functions/api/[[route]].ts`,
> `src/api/lib/auth-middleware.ts`, `src/router.tsx`, `src/layouts/`, `src/components/ui/`,
> `eslint.config.js`, `package.json`, `wrangler.toml`, `.github/workflows/backup.yml`.
> Corrected 2026-08-13: this doc still described a dev-only Node API server
> (`src/api/index.ts`, `src/api/routes-mock/`, `npm run api`), a `PortalLayout`, a
> `/api/test/*` B-flow surface, and an unwired login page — **none of those exist**.
> Re-verified 2026-08-13 (chore/dead-code-sweep) against the `src/` import graph: the
> `job-card-persistence.ts`, `material-lookup.ts`, `validation.ts`, `scheduling.ts` and
> `swr-fetcher.ts` rows all described files with no importer (and three of them described
> them wrongly — see the entries below); those files are deleted and the rows corrected.
> Those sections are deleted rather than paraphrased. Counts were also stale
> (~70 routes → 139 mounts; 80+ migrations → 244).

A bird's-eye view of how HOOKKA ERP is put together — the shape of the
frontend, the Hono API on Cloudflare Pages Functions, the Postgres data
layer, and the extension points you should know about before touching
anything.

For the endpoint-level reference, read [`API.md`](API.md) — it is **generated**
from `worker.ts` + the route files (`node scripts/gen-api-docs.mjs`), so it does
not drift. For where code lives, read [`CODEBASE-MAP.md`](CODEBASE-MAP.md).

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
│  │   • tenantMiddleware (orgId on the session)     │    │
│  │   • 139 route mounts from src/api/routes/       │    │
│  │     (136 route files) — each gates itself with  │    │
│  │     requirePermission + org scoping             │    │
│  └───────────────┬────────────────────────────────┘     │
│                  │                                      │
│  ┌───────────────▼────────────────────────────────┐     │
│  │  Hyperdrive (Cloudflare-pooled Postgres)        │    │
│  │   ↓                                             │    │
│  │  Supabase Postgres (primary OLTP)               │    │
│  │   • 251 migrations under migrations-postgres/ (2026-08-14; newest prefix 0229, shared by two files)   │    │
│  │   • immutable ledger_journal_entries hash chain │    │
│  │   • daily pg_dump → Supabase Storage            │    │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

The frontend and API live in the same repo and ship together. Production
serves real Postgres data on every `/api/*` route mounted in
`src/api/worker.ts`. **There is no second API server** — no
`src/api/index.ts`, no `src/api/routes-mock/`, no `npm run api`. Local
development is `npm run dev` (Vite) or `npm run dev:worker`
(`wrangler pages dev`, which talks to Supabase via `DATABASE_URL` in
`.dev.vars`).

Nightly backup: `.github/workflows/backup.yml` runs `pg_dump -Fc` and uploads
to the Supabase Storage bucket under `backups/` (it was R2 until the
2026-04-29 storage-supabase migration — `scripts/backup-supabase.mjs`).

---

## Frontend

### Entry point

`src/main.tsx` mounts `<RouterProvider>` with the router defined in
`src/router.tsx`. The router is a single flat array of route objects:

- Auth + the public QR/scan/survey pages live outside any layout.
- Everything behind the sidebar lives under `<DashboardLayout>`
  (`src/layouts/DashboardLayout.tsx`), wrapped in `<RequireAuth>`
  (`src/components/RequireAuth.tsx`).
- The shop-floor phone portal lives under `<WorkerLayout>`
  (`src/layouts/WorkerLayout.tsx`); the compact mobile dashboard is
  `src/pages/m/MobileLayout.tsx`, which shares the dashboard cookie session.
- There is **no** `PortalLayout` and no customer self-service layout.

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
| `StatusBadge`       | Status chip. NOTE: `value` is typed `string` and unknown values fall through to a grey NEUTRAL chip via `resolveUnknownStatus` — a new backend enum does NOT produce a compile error |
| `DataGrid`          | TanStack-Table wrapper with double-click, sticky header, etc.  |
| `DataTable`         | Lightweight striped table for read-only summaries              |
| `Button`, `Input`   | Tailwind + CVA variants, with loading + icon slots             |
| `Card`, `Skeleton`  | Layout primitives matching the brand beige                     |
| `FormField`         | Label + hint + error wrapper for RHF forms                     |
| `DocumentFlowDiagram` | Read-only lineage diagram (SO → PO → DO → Invoice graph)     |
| `ErrorBoundary`     | Route-level fallback (used by `errorElement`)                  |
| `ToastProvider`     | Top-level toast host, opened via `useToast()`                  |
| `MoneyInput`        | RM entry/display for integer-sen fields (`money-input.tsx`)     |
| `StatusTabStrip`    | The ONE status tab strip (count + money per state)              |
| `DocumentDetailDrawer` | The ONE shared right slide-over document chrome              |

All are re-exported from `src/components/ui/index.ts` (barrel). The table above
is a selection, not the full list — `ls src/components/ui/` is the inventory
(38 files as of 2026-08-13).

### State and data fetching

There is **no Redux and no Zustand**. Most screens still use plain `fetch` +
`useState`/`useEffect`, but the "everything is a bare fetch" claim that used to
sit here is no longer true — three caching layers exist and new code should use
them:

- ~~`swr` with the shared fetcher in `src/lib/swr-fetcher.ts`~~ — **the fetcher
  was deleted in chore/dead-code-sweep.** It was the only importer of the `swr`
  package and nothing imported it, so this "layer" had zero adopters and was a
  third competing fetch pattern on paper only. `swr` is still listed in
  `package.json` dependencies and is now unused — removing it is a separate
  change (lockfile + bundle).
- `src/lib/cached-fetch.ts` — stale-while-revalidate + `AbortController` +
  in-flight dedup. **This is the one that is actually used** (~88 pages, via
  `useCachedJson`).
- `src/lib/api-client.ts` — patches `window.fetch` globally to attach
  `X-CSRF-Token` to every mutating `/api/*` call. **No call site needs to add
  CSRF headers**; an audit that reports "N fetches missing the CSRF token" is
  reading the wrong layer.

Windowing/virtualisation primitives for large grids: `src/lib/virtual-window.ts`,
`virtual-group-window.ts`, `incremental-window.ts`, plus
`@tanstack/react-virtual`.

A few pieces of ambient state:

- **Toasts** — `ToastProvider` + `useToast()` in `src/components/ui/toast.tsx`.
- ~~Persisted job-card state~~ — `src/api/lib/job-card-persistence.ts` was
  **deleted** in chore/dead-code-sweep. It had no importer, and the description
  here was wrong twice over: it was not `localStorage` (it wrote
  `.data/job-card-overrides.json` via `node:fs`) and it overlaid the in-memory
  `src/lib/mock-data.ts` arrays, which stopped being the data source when the
  app moved to Supabase Postgres. Job-card state is durable in the DB now.

### Styling

Tailwind CSS 4 via `@tailwindcss/vite`. Tokens live in
`src/lib/design-tokens.ts` (700 lines); there is **no `tailwind.config.*` file
at all** — Tailwind 4 is configured from `src/index.css`.
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
8. **Route subapps** — 136 files in `src/api/routes/`, 139 `app.route(...)`
   mounts. The full mount table with every registered path is in
   [`API.md`](API.md) (generated).

The precise public surface is not a matter of opinion: `PUBLIC_PATHS` and
`PUBLIC_PREFIXES` in `src/api/lib/auth-middleware.ts` are the allow-lists, plus
four regex-opened paths (`GET /api/fg-units/:id` and the three
`/api/production-orders/:id/scan-complete*` shop-floor POSTs, each of which
re-checks the worker token inside the handler). `API.md` reproduces both lists
mechanically.

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

Validation is opt-in and per-route. The reusable Zod schemas live in
`src/lib/schemas/`; broader Zod coverage on POST/PATCH bodies is a P2
follow-up (today money handlers have first priority). This paragraph used to
point at `src/lib/validation.ts` and call it Zod — it was neither Zod nor
reachable (hand-rolled `required` / `minValue` validators, zero importers) and
was deleted in chore/dead-code-sweep.

### Data model

Types live in `src/types/index.ts` (canonical for both backend handlers
and frontend pages). `src/lib/mock-data.ts` still exists as a types
re-export + seed constants; the ESLint `no-restricted-imports` rule in
`eslint.config.js` blocks **value** imports of `@/lib/mock-data`
(`allowTypeImports: true`, so `import type` is still legal — several pages use
it that way). It is not a runtime data source for anything deployed.

Relationships worth calling out:

- **Customer ↔ CustomerHub** — one customer, many delivery addresses
  (`CustomerHub`). Delivery orders pick a hub, never free-text addresses.
  See `docs/archive/MODULES.md` § Customers.
- **SO → PO → JobCard → FGUnit → DO → Invoice** — the core forward chain.
  Every PDF generator corresponds to one document on that path.
- **BOM hierarchy** — `FG → WIP (Divan + Headboard) → RM`. WIP rows are
  built dynamically per SO variant from the department configs in the
  Production Sheet; they're not a pre-defined catalogue.

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
| `scheduler.ts`               | `useInterval` / `useTimeout` with `pauseOnHidden`           |
| `cached-fetch.ts`            | SWR + AbortController + in-flight dedup over `useState` cache |
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
   serves real Postgres via Hyperdrive.

2. ~~**Auth**~~ — **DONE.** `RequireAuth` (`src/components/RequireAuth.tsx`)
   wraps the dashboard tree in `src/router.tsx`; the API side runs
   `authMiddleware` on `/api/*` with an explicit public allow-list, Google
   OAuth (`routes/auth-oauth.ts`), TOTP second factor (`routes/auth-totp.ts`),
   a separate PIN flow for the shop-floor portal (`routes/worker-auth.ts`), and
   RBAC via `src/api/lib/rbac.ts` / `role-policy.ts`. **The login page is not a
   stub.** Any doc or plan that says auth is unwired is describing April 2026.

3. **Caching wrapper consolidation**
   **TWO** approaches coexist (corrected 2026-08-14 — `src/lib/swr-fetcher.ts` does not exist and nothing under `src/` imports `swr`; it survives only as an unused `package.json` dependency): (`cached-fetch.ts`, bare
   `fetch`). Converging on one is open work, not a described state.

4. **Feature toggles**
   `src/lib/constants.ts` is the place for environment-driven flags.

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
  and use `StatusBadge kind="..."`. **The TS compiler does NOT enforce coverage** — `StatusBadgeProps.value` is `string` and an unmapped status silently renders grey (`resolveUnknownStatus`), so add the map entry deliberately.
