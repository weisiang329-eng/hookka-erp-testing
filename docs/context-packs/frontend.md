# Context Pack: Frontend

> **Last verified: 2026-08-13** — all cited paths exist; shared primitives confirmed in `src/components/ui/` (`page-header`, `object-page-header`, `data-grid`, `money-input`, `discount-input`, `searchable-select`). Broken link to the old root-level HOOKKA-GOTCHAS path repaired.
> Re-verified 2026-08-13 (chore/dead-code-sweep): the Procurement list named two pages that no longer exist (`pricing.tsx`, deleted earlier; `in-transit.tsx`, deleted in that sweep — both routes are now `<Navigate>` redirects). Corrected below.

Use this pack for React pages, routing, UI components, forms, tables, and browser-side API calls.

> Reuse the shared primitives — don't hand-roll: `PageHeader`/`ObjectPageHeader`, `DataGrid`, `useConfirm`, `MoneyInput`, `DiscountInput`, `SearchableSelect` (UI/PDF/grid standards in `docs/UI-CONVENTIONS.md`). If a new DB column reads back `undefined` on the frontend, suspect the camelCase fold — the API row is `toCamel`'d, so read `r.camelCase ?? r.snake_case` (see `docs/context-packs/HOOKKA-GOTCHAS.md`).

## Read first

- `src/main.tsx`
- `src/router.tsx`
- `src/dashboard-routes.tsx`
- `src/lib/api-client.ts`
- `src/components/ui/`
- The target module under `src/pages/<module>/`

## Frontend data path

Most pages call same-origin `/api/*` endpoints directly. `src/lib/api-client.ts` patches `window.fetch` so dashboard requests include credentials and CSRF handling consistently.

## Useful searches

```bash
rg -n "fetch\(|/api/" src/pages/<module> src/components src/hooks src/lib
rg -n "useEffect|useMemo|useState|useForm" src/pages/<module>
rg -n "PageHeader|FilterBar|DataGrid|DataTable|StatusBadge" src/pages/<module> src/components
```

## Common follow-up files

- Backend route: `src/api/routes/<resource>.ts`
- Shared types/helpers: `src/lib/`, `src/types/`
- Tests: `tests/*.mjs`

---

## Responsive (phone/fold/tablet)

**Foundation shipped 2026-06-21.** Desktop (≥1280px / xl) is untouched — all responsive behavior lives in `max-*` Tailwind variants which fire ONLY below their breakpoint.

Breakpoints in effect (src/index.css @theme):
- Desktop ≥1280px: unprefixed classes (unchanged)
- Tablet 768-1279px: `max-xl:` / `max-lg:`
- Phone <768px: `max-md:`
- Phone-sm <640px: `max-sm:`
- Fold <360px: `max-[360px]:` (breakpoint alias `xs` registered as `--breakpoint-xs: 360px`)

### Class recipe — copy-paste for new pages

**KPI card row (4-col desktop → 2-col tablet → 1-col phone):**
```
className="grid grid-cols-4 gap-4 max-xl:grid-cols-2 max-sm:grid-cols-1"
```

**KPI card row (3-col desktop → 2-col tablet → 1-col phone):**
```
className="grid grid-cols-3 gap-4 max-md:grid-cols-2 max-sm:grid-cols-1"
```

**Side-by-side panels (2-col desktop → 1-col phone):**
```
className="grid grid-cols-2 gap-4 max-md:grid-cols-1"
```

**Form grid (2-col desktop → 1-col phone):**
```
className="grid grid-cols-2 gap-4 max-md:grid-cols-1"
```

**Form grid (3-col desktop → 2-col tablet → 1-col phone):**
```
className="grid grid-cols-3 gap-4 max-md:grid-cols-2 max-sm:grid-cols-1"
```

**Page header (handled by PageHeader/ObjectPageHeader primitives — no extra work).**

**Filter/toolbar bar (wraps on phone):**
```
className="flex flex-wrap items-center gap-2"
```

**Status tab bar (scrolls horizontally on phone instead of wrapping):**
```
className="flex gap-1 overflow-x-auto"
```

**Data table horizontal scroll wrapper (never blow out page width):**
```
className="overflow-x-auto"   {/* wrap the <table> in this */}
```
DataGrid already self-contains via its internal `overflow-auto` scroll div — no extra wrapper needed for DataGrid.

**Page container padding (tighter on phone):**
```
className="p-6 max-md:p-4 max-sm:p-3"
```

**Card internal padding (handled by Card primitives — no extra work needed).**

### Pilot pages (validated 2026-06-21)

| Page | File | Changes |
|------|------|---------|
| Dashboard | `src/pages/dashboard-b/index.tsx` | KPI rail (already md-responsive), 2-col sections → 1-col on phone, filter rows flex-wrap |
| SO List | `src/pages/sales/index.tsx` | Filter rows flex-wrap, tab bar overflow-x-auto, spacing tightened |
| SO Detail | `src/pages/sales/detail.tsx` | Info grid max-[360px]:grid-cols-1, spacing tightened |
| SO Create | `src/pages/sales/create.tsx` | Action bar flex-wrap, customer info flex-wrap, LineItemCard grid max-sm:grid-cols-1 |

### Rollout list — remaining pages by module

Apply the class recipe above to each page. Pages that use only `PageHeader` + `DataGrid` need only the page container padding tweak; pages with multi-col form grids need the grid recipe.

**Sales** (2 remaining):
- `src/pages/sales/edit.tsx` — form grid recipe
- `src/pages/consignment/create.tsx`, `edit.tsx`, `detail.tsx`, `note.tsx`, `return.tsx` — form + DataGrid

**Procurement** (10 pages):
- `src/pages/procurement/index.tsx`, `detail.tsx`, `create.tsx`, `grn.tsx`, `grn/create.tsx`, `grn-detail.tsx`, `pi.tsx`, `pi/create.tsx`, `PurchaseInvoiceDetail.tsx`, `maintenance.tsx`
  (`pricing.tsx` and `in-transit.tsx` are gone — both routes are now `<Navigate>` redirects.)

**Delivery & Consignment** (3 pages):
- `src/pages/delivery/index.tsx`, `detail.tsx`
- `src/pages/consignment/note.tsx` (also need tab bar overflow-x-auto — it has many tabs)

**Accounting & Invoicing** (8 pages):
- `src/pages/accounting/index.tsx` — mega-page, focus on tab bar + section grids
- `src/pages/invoices/index.tsx`, `detail.tsx`, `payments.tsx`, `supplier-payments.tsx`, `credit-notes.tsx`, `debit-notes.tsx`, `e-invoice.tsx`
- `src/pages/accounting/cash-flow.tsx`

**Production & BOM** (8 pages):
- `src/pages/production/index.tsx`, `folders.tsx`, `folder-detail.tsx`, `tracker.tsx`, `wip-times.tsx`, `scan.tsx`, `fg-scan.tsx`
- `src/pages/bom.tsx`, `src/pages/cnc-templates.tsx`

**Inventory** (4 pages):
- `src/pages/inventory/index.tsx`, `adjustments.tsx`, `fabrics.tsx`, `stock-value.tsx`

**Products & MDM** (5 pages):
- `src/pages/products/index.tsx`, `catalog.tsx`, `bom.tsx`, `documents.tsx`
- `src/pages/maintenance.tsx`, `src/pages/maintenance/sofa-combos.tsx`

**Employees & Payroll** (2 pages):
- `src/pages/employees.tsx` — mega-page, tab bar overflow-x-auto is the key fix
- `src/pages/worker/` — already mobile-first (worker mobile UI)

**Customers & Platform** (5 pages):
- `src/pages/customers.tsx`, `src/pages/settings/Users.tsx`, `src/pages/settings/index.tsx`
- `src/pages/mail-center/index.tsx`, `detail.tsx`, `compose.tsx`

**Suppliers** (1 page):
- `src/pages/suppliers/detail.tsx`
