# Design System

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/lib/design-tokens.ts`, `src/index.css`,
> `src/components/ui/index.ts`, `src/components/ui/status-badge.tsx`,
> `src/components/ui/badge.tsx`, `src/components/ui/button.tsx`,
> `src/components/ui/card.tsx`, `src/lib/utils.ts`.
> Corrected 2026-08-13: `<Badge>` had four variants documented but only ships two;
> `<DateRangePicker>` does not exist anywhere in `src/`; `<Card>` has no `variant` prop;
> `StatusBadge` has 14 `kind` values, not 13, and does **not** compile-error on an unknown
> enum *value*; the page background hex was wrong. Everything else in this file — the nine
> token sections, `SemanticStyle`, all seven semantic hexes, both threshold objects, the
> three class helpers, and every named `*_COLOR` map and `get*Style` resolver — was checked
> name-by-name against `design-tokens.ts` and is accurate.

HOOKKA ERP uses a token-first design system. Every colour decision and every
shared chrome pattern (page headers, filter bars, tabs, status chips) lives
in one place so the brand feel is consistent across ~60 screens.

This document is the rulebook. If you're adding a page, start here.

---

## Brand tone in one paragraph

Warm, earthy, document-forward. The primary brand colour `#6B5C32` is a
warm brown-gold (think "land of gold and moss" rather than
"dashboard-startup neon"). Semantic colours preserve their universal
meaning (green = success, red = danger, amber = warning, blue/teal = info)
but shades are muted so they sit comfortably next to the brand gold instead
of shouting over it. Card surfaces are white; borders are a soft beige
(`BRAND.border` = `#E6E0D9` on white, `BRAND.borderAlt` = `#E2DDD8` on cream).

**Page background — read this carefully, two values are in play.**
`BRAND.bgCream` in `design-tokens.ts` is `#FAF8F4`, but the actual `<body>` background
set in `src/index.css` is `--color-stone-white: #F0ECE9`. `#FAF8F4` is the cream used by
cream-surfaced pages and by the `/m` phone shell (`--m-paper` in
`src/pages/m/theme-vars.css`), not by the desktop body.

---

## Token file

**Location** — `src/lib/design-tokens.ts`
**Imports** — never hard-code hex or Tailwind shades in page code for
status / value indication. Always import from this file.

The file has nine sections:

1. **Brand palette** — chrome (primary, heading, body, border, cream bg)
2. **Semantic colours** — `SUCCESS` / `WARNING` / `WARNING_HIGH` /
   `DANGER` / `INFO` / `NEUTRAL` / `ACCENT_PLUM` as `SemanticStyle` objects
3. **Backend-enum mappings** — `COA_TYPE_COLOR`, `RACK_STATUS_COLOR`,
   `ACTIVE_COLOR`, `AGING_BUCKET_COLOR`
4. **Frontend thresholds** — `STOCK_THRESHOLD`, `WIP_AGE_THRESHOLD` +
   resolvers (`getStockSemantic`, `getWipAgeSemantic`,
   `getSignedBalanceSemantic`)
5. **Category palettes** — 7-step `CATEGORY_PALETTE`,
   `INVENTORY_TYPE_COLOR`, `FABRIC_CATEGORY_COLOR`, `ITEM_CATEGORY_COLOR`
6. **Class helpers** — `badgeClasses`, `textOnly`, `tileClasses`
7. **Backend status-enum maps** — `SO_STATUS_COLOR`,
   `PRODUCTION_STATUS_COLOR`, `JOB_CARD_STATUS_COLOR`,
   `DELIVERY_STATUS_COLOR`, `ATTENDANCE_STATUS_COLOR`,
   `CONSIGNMENT_ITEM_STATUS_COLOR`, `TRANSIT_STATUS_COLOR`,
   `RD_STAGE_COLOR`, `BOM_VERSION_STATUS_COLOR`, `FG_UNIT_STATUS_COLOR`
8. **Backend category-enum maps** — `WIP_TYPE_COLOR`,
   `STOCK_CATEGORY_COLOR`, `RD_PROTOTYPE_TYPE_COLOR`,
   `RD_PROJECT_TYPE_COLOR`, `LEAD_TIME_CATEGORY_COLOR`
9. **Type-safe resolvers** — `getSOStatusStyle`, `getProductionStatusStyle`,
   ... one per enum. Plus `resolveUnknownStatus` as a dev-warning fallback.

---

## `SemanticStyle` — the primitive

Every coloured thing resolves to this shape:

```ts
type SemanticStyle = {
  text:   string;  // "text-[#4F7C3A]"
  bg:     string;  // "bg-[#EEF3E4]"
  border: string;  // "border-[#C6DBA8]"
  hex:    string;  // "#4F7C3A" (for inline SVG / chart colours)
};
```

This is what every token exports. Compose the pieces directly or use the
helpers.

### Helpers

```ts
badgeClasses(SUCCESS)
// → "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8] border rounded px-2 py-0.5 text-xs font-medium"

textOnly(DANGER)
// → "text-[#9A3A2D]"

tileClasses(INFO)
// → "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2] border rounded-lg"
```

Use `badgeClasses` for chips, `textOnly` for numeric cells / inline text,
`tileClasses` for stat-card-sized tinted blocks.

---

## The semantic palette

| Token          | Hex     | When                                                        |
| -------------- | ------- | ----------------------------------------------------------- |
| `SUCCESS`      | #4F7C3A | Positive balance, completed, approved, in stock, adequate   |
| `WARNING`      | #9C6F1E | Aging 60d, low stock, reserved, needs attention             |
| `WARNING_HIGH` | #B8601A | Aging 90d, high-risk but not yet critical                   |
| `DANGER`       | #9A3A2D | Negative balance, overdue >90d, out of stock, rejected      |
| `INFO`         | #3E6570 | AP outstanding, in-progress, assets, neutral-positive       |
| `NEUTRAL`      | #6B7280 | Draft, inactive, current aging, no special state            |
| `ACCENT_PLUM`  | #6B4A6D | Equity, and anywhere a distinct 7th category is needed      |

Pages should never pick between, say, `SUCCESS` and `INFO` arbitrarily —
they mean different things. Use the matching resolver for the enum you're
rendering.

---

## Status chips

Always use `<StatusBadge>` for backend-enum values. Never render a
status yourself with a hand-rolled chip.

```tsx
import { StatusBadge } from "@/components/ui";

<StatusBadge kind="so"          value={so.status} />
<StatusBadge kind="production"  value={po.status} />
<StatusBadge kind="jobcard"     value={jobCard.status} />
<StatusBadge kind="delivery"    value={doc.status} />
<StatusBadge kind="attendance"  value="PRESENT" />
<StatusBadge kind="consignment" value="AT_BRANCH" />
<StatusBadge kind="transit"     value="CUSTOMS" />
<StatusBadge kind="rd"          value={proj.stage} />
<StatusBadge kind="bom"         value={bom.status} />
<StatusBadge kind="fgunit"      value={fg.status} />
<StatusBadge kind="coa"         value={acc.type} />
<StatusBadge kind="rack"        value={rack.status} />
<StatusBadge kind="active"      value={worker.active ? "ACTIVE" : "INACTIVE"} />
```

Props:

- **`kind`** — one of 14 values: the 13 enum kinds listed above plus `"unknown"`
  (`StatusBadgeKind` in `status-badge.tsx:44`). **Correction (2026-08-13):** adding a new
  member to an enum *union type* does trigger a TS error, because each map is a
  `Record<EnumUnion, SemanticStyle>`. But `value` is typed `string`, and `lookupStyle`
  falls back to `resolveUnknownStatus(...)` — so passing a status the map has never heard
  of renders a NEUTRAL chip silently, with no compile error and no runtime throw.
- **`value`** — the raw enum string from the API.
- **`label`** — optional override (default: `value.replace(/_/g, " ")`).
- **`size`** — `"sm"` (11px, default for table cells) or `"md"`.
- **`appearance`** — `"chip"` (filled, default), `"outline"` (border-only),
  `"text"` (no chip — for inline emphasis).

Legacy escape hatch: `<Badge variant="status" />` still works via
`getStatusColor(status)` in `lib/utils.ts` which buckets known values into
semantic tokens. Prefer `<StatusBadge kind="…">` in new code — the kind
enforces enum coverage at compile time.

---

## Shared chrome components

### `<PageHeader>`

Every **list / route-level** page uses this.

**Corrected 2026-08-14 — this said "Every route-level page uses this. No exceptions."** Record
DETAIL pages use `<ObjectPageHeader>` instead (`src/components/ui/object-page-header.tsx`,
imported by path, not via the barrel): it adds `backTo`/`onBack`, `badges` and `pager`, and
renders the title at `text-xl` rather than PageHeader's `text-2xl`. `src/pages/sales/detail.tsx`
is the reference — it imports `ObjectPageHeader` and never mentions `PageHeader`. Consistent
with `UI-CONVENTIONS.md` §1/§4 and `UI-DATA-DOCUMENT-STANDARDS.md:107`.

```tsx
<PageHeader
  title="Sales Orders"
  subtitle="Quotations, confirmed orders, and closed orders"
  breadcrumbs={["Sales", "Detail", "SO-0001"]}
  actions={
    <>
      <Button variant="ghost" onClick={…}>Export</Button>
      <Button onClick={…}>New SO</Button>
    </>
  }
/>
```

**Props**

- `title` (required) — rendered as `<h1>`
- `subtitle?` — one-liner below, muted
- `breadcrumbs?: string[]` — shown above the title, small, muted, last
  segment highlighted in brand gold
- `actions?` — right-side slot for buttons / export controls; wraps
  responsively on narrow viewports

### `<FilterBar>`

List pages put search + filter controls inside this. Centralises the
magnifying-glass icon, placeholder colour, and the optional "Clear"
affordance.

```tsx
<FilterBar
  search={{
    value: q,
    onChange: setQ,
    placeholder: "Search by code or customer...",
  }}
  onClear={() => {
    setQ(""); setStatus("all"); setFrom(""); setTo("");
  }}
>
  <select value={status} onChange={…}>…</select>
  <input type="date" value={from} onChange={…} />
</FilterBar>
```

> Corrected 2026-08-13: this example used to show a `<DateRangePicker …/>`. **No such
> component exists** — `DateRangePicker` appears nowhere under `src/`. Date filters are
> built from native `<input type="date">` controls passed as `FilterBar` children.

**Props**

- `search?: { value, onChange, placeholder?, maxWidthClass? }`
- `children?` — any extra filter controls (selects, date pickers)
- `onClear?` — when provided, renders a "Clear" link on the right

### `<Tabs>`

Two variants cover every tab use-case in the app.

```tsx
// underline (default) — list pages, Inventory, RD, Procurement
<Tabs
  value={tab}
  onChange={setTab}
  tabs={[
    { key: "all",     label: "All",     count: total     },
    { key: "pending", label: "Pending", count: pending   },
    { key: "done",    label: "Done",    count: done      },
  ]}
/>

// pill — dept selector on Production shop-floor
<Tabs
  variant="pill"
  gridColsClass="grid-cols-9"
  value={dept}
  onChange={setDept}
  tabs={departments.map(d => ({ key: d.code, label: d.name }))}
/>
```

Fully controlled. Parent owns `value`, gets `onChange(key)`. The key
generic `TabItem<T extends string>` keeps the callback typed:

```ts
type SalesTab = "all" | "pending" | "done";
<Tabs<SalesTab> … />   // onChange receives SalesTab
```

---

## Other UI primitives

From `src/components/ui/` (import via the barrel
`import { X } from "@/components/ui"`):

- **`Badge`** — legacy styled chip. **Corrected 2026-08-13:** it has exactly two variants,
  `"default"` and `"status"` (`badge.tsx:5`) — the `"success"` / `"warning"` / `"outline"`
  variants this doc used to list have never existed on this component. `variant="status"`
  also requires the separate `status` prop; it calls through to `getStatusColor()` in
  `src/lib/utils.ts:87`.
- **`Button`** — **SEVEN** CVA variants (`button.tsx:11-19`), not five: `default`, **`primary`** (brand gold `#6B5C32` — use this for the brand call to action, never a hand-rolled `bg-[#6B5C32]`), **`secondary`** (`#F0ECE9`), `ghost`, `outline`, `destructive`,
  `link`) + sizes (`default`, `sm`, `lg`, `icon`).
- **`Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`** —
  brand-coloured surface + heading. **Corrected 2026-08-13: `Card` has no `variant` prop.**
  Padding is responsive, not a variant: `p-6 max-md:p-4` baked into `CardHeader` /
  `CardContent`.
- **`Input`** — Tailwind-styled native input with the brand focus ring.
- **`FormField`** — label + hint + error wrapper for React-Hook-Form.
- **`DataGrid`** — TanStack-Table-backed grid with sticky header, sortable
  columns, double-click-to-detail handler, and a `columns` config that
  matches the TanStack column-def shape. Use for anything > 20 rows.
- **`DataTable`** — simpler striped table for small read-only lists (e.g.
  line items inside a detail page).
- **`LoadingButton`** — `<Button>` + spinner; flip `loading={true}` to
  swap the label.
- **`Skeleton`** — shimmer block for lazy-loaded content.
- **`DocumentFlowDiagram`** — read-only SVG graph of SO ↔ PO ↔ DO ↔ Invoice
  lineage. Used in audit views.
- **`ErrorBoundary` / `ErrorFallback`** — route-level error guard
  registered in `router.tsx`.
- **`ToastProvider` / `useToast`** — app-level toast host + hook. There is no bare `toast`
  object export; feedback goes through `useToast()`.

Also exported from the barrel but missing from the list above (added 2026-08-13):
`StatusTabStrip`, `SearchableSelect`, `BatchImportDialog`, and the `Skeleton*` family
(`SkeletonText`, `SkeletonCard`, `SkeletonTable`, `SkeletonDetailPage`,
`SkeletonDashboard`). Several `src/components/ui/*.tsx` files — `money-input`,
`object-page-header`, `confirm-dialog`, `filter-chips`, `record-pager`, `virtual-rows`,
`virtual-groups` and others — are **not** in the barrel and must be imported by path; see
`docs/UI-CONVENTIONS.md`.

---

## Category palettes (when colour has no semantic weight)

Use `CATEGORY_PALETTE[i]` when you need to distinguish N types and the
colour itself carries no meaning (e.g. fabric categories, WIP components,
department colour-coding).

```ts
import { CATEGORY_PALETTE, badgeClasses } from "@/lib/design-tokens";

// With known categories, take the first N entries in declaration order
const categoryStyles = {
  "B.M-FABR": CATEGORY_PALETTE[0], // teal
  "S-FABR":   CATEGORY_PALETTE[1], // plum
  "S.M-FABR": CATEGORY_PALETTE[2], // moss
  LINING:     CATEGORY_PALETTE[3], // amber
  WEBBING:    CATEGORY_PALETTE[5], // slate blue
};

// Or use the pre-baked maps where they exist:
import {
  INVENTORY_TYPE_COLOR,
  FABRIC_CATEGORY_COLOR,
  ITEM_CATEGORY_COLOR,
  STOCK_CATEGORY_COLOR,
  WIP_TYPE_COLOR,
} from "@/lib/design-tokens";
```

**Rule** — the same category always gets the same colour across the app.
If you're introducing a new category, add it to the matching pre-baked map
so other pages can pick it up.

---

## Thresholds

Frontend-only display rules live next to the tokens so the page doesn't
hard-code them inline.

```ts
import { getStockSemantic, getWipAgeSemantic, getSignedBalanceSemantic } from "@/lib/design-tokens";

// Inventory page — stock qty coloration
<span className={textOnly(getStockSemantic(row.stockQty))}>{row.stockQty}</span>

// WIP tab — age coloration
<span className={textOnly(getWipAgeSemantic(row.ageDays))}>{row.ageDays}d</span>

// P&L / balance sheet — signed balance
<span className={textOnly(getSignedBalanceSemantic(row.netProfit))}>{formatRM(row.netProfit)}</span>
```

Thresholds:

- `STOCK_THRESHOLD` — `{ OUT: 0, LOW: 5 }`
- `WIP_AGE_THRESHOLD` — `{ WARN_DAYS: 7, CRITICAL_DAYS: 14 }`

Edit these centrally; every Inventory page updates at once.

---

## Typography & spacing

All the typography decisions live in Tailwind classes on the shared
components. If you follow the shared components, you get consistent type
for free. The conventions:

- **H1 page title** — `text-2xl font-bold text-[#1F1D1B]` (handled by
  `<PageHeader>`)
- **H2 section title** — `text-lg font-semibold text-[#1F1D1B]`
- **Body** — `text-sm text-[#6B7280]`
- **Muted caption** — `text-xs text-[#8A7F73]`
- **Table cell header** — `text-xs font-medium uppercase tracking-wide text-[#6B7280]`
- **Section gap** — `space-y-6` on the page root
- **Card padding** — `p-6`, dropping to `p-4` below the `md` breakpoint. This is
  **responsive, not a variant**: `max-md:p-4` is baked into `CardHeader` (`card.tsx:17`)
  and `CardContent` (`:38`). `<Card>` has **no `variant` prop and no `cva`** — pass
  `className` to override. *(Corrected 2026-08-14: this said "handled by `<Card>` variants",
  contradicting this same doc's correction ~100 lines above.)*

Page-level spacing convention:

```tsx
<div className="space-y-6">
  <PageHeader … />
  <FilterBar … />
  <DataGrid … />
</div>
```

---

## Anti-patterns (don't do these)

- ❌ `text-green-600`, `bg-red-50`, `border-amber-300` — use tokens.
- ❌ Hex classes outside `design-tokens.ts` (unless it's a one-off mask /
  overlay that has no semantic meaning — and even then, prefer brand
  chrome colours).
- ❌ Hand-rolled page headers (`<h1>` + `<p>` + `<div class="flex justify-between">`).
  Use `<PageHeader>`.
- ❌ Hand-rolled status chips (`<span class="bg-green-50 text-green-700 px-2 py-0.5 rounded">`).
  Use `<StatusBadge>`.
- ❌ Hard-coding a status string into a colour map in a single page. Add
  it to the relevant `*_STATUS_COLOR` in `design-tokens.ts`.
- ❌ Copying a tab bar. Use `<Tabs>`.
- ❌ Introducing an 8th semantic colour without stakeholder sign-off.
  The seven covers every observed state.

---

## Checklist for a new page

1. Import from the barrel: `import { PageHeader, FilterBar, DataGrid,
   StatusBadge, Button } from "@/components/ui"`.
2. Wrap the page body in `<div className="space-y-6">`.
3. Top with `<PageHeader title=… subtitle=… actions=…>`.
4. Filters in `<FilterBar search=… onClear=…>`.
5. List in `<DataGrid columns=… rows=… onRowDoubleClick=…>`.
6. Any status chip → `<StatusBadge kind="…" value=…>`.
7. Any colour on a numeric cell → `textOnly(getXxxSemantic(value))`.
8. Any colour on a section tile → `tileClasses(XXX)`.
9. No bare Tailwind shades anywhere for semantic indication.
10. Lint + type-check. **Use the strict app config, not the base one:**
    `npm run lint && npx tsc -p tsconfig.app.json --noEmit` (= `npm run build:strict`).
    The bare `npx tsc --noEmit` this doc used to prescribe runs the looser base
    `tsconfig.json` and misses errors the deploy gate fails on — see `CLAUDE.md`.
