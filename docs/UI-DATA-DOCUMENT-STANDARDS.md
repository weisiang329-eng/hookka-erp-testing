# UI Data Grid, Filter, Numeric Input, and Document Layout Standards

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/components/ui/data-grid.tsx`,
> `src/components/ui/filter-bar.tsx`, `src/lib/pdf-utils.ts`, `src/lib/utils.ts`,
> `tests/money.test.mjs`, `tests/data-grid-fill.test.mjs`.
> No corrections needed. Every named API was checked and exists: the `DataGrid` column
> `type` union is exactly `"text" | "date" | "currency" | "number" | "docno" | "status"`
> (`data-grid.tsx:137`), and `gridId`, `keyField`, `emptyMessage`, `alwaysSearchKeys`,
> `groupBy`, `onSelectionChange`, `filterAccessor`, `sortAccessor` all exist as documented;
> `formatCurrency` / `formatNumber` / `formatRM` / `roundSen` are all exported from
> `src/lib/utils.ts`; `drawLetterhead` / `drawSectionLabel` / `drawDocFooter` / `tableTheme`
> are all exported from `src/lib/pdf-utils.ts`; both cited test files exist.

Purpose: provide one standard for list grids, columns, filters, sorting, numeric input, and business document layouts across Hookka ERP. Use this when adding or changing tables, filters, quotations, sales orders, delivery orders, invoices, PDFs, and printable forms.

## Current findings

The codebase already has a partial shared standard:

- `DataGrid` defines column metadata with `key`, `label`, `width`, `align`, `sortable`, `type`, `filterAccessor`, and `sortAccessor`.
- `DataGrid` supports typed rendering for `date`, `currency`, `number`, `docno`, and `status` cells.
- `DataGrid` sorts real numbers numerically when the values are numbers; otherwise it uses locale string comparison with numeric collation.
- `DataGrid` supports per-column text filters and checkbox value filters.
- `FilterBar` provides the shared list-page search/filter shell.
- Money is stored and formatted in sen; `formatRM` renders `RM <amount>` with two decimals.

The standard is not fully complete yet because many modules still define columns, numeric inputs, and document layouts locally. New work should use the rules below and should gradually refactor old modules only when they are touched.

## Data grid standard

Use `DataGrid` for list pages unless the page has a strong reason for a custom table.

### Required grid shape

Every new grid should define:

| Requirement | Standard |
| --- | --- |
| Stable `gridId` | Required for user column preferences when the grid is important or recurring. |
| `keyField` | Must use a stable database/API id, not array index. |
| Column `key` | Must match row data when possible. Use `sortAccessor`/`filterAccessor` when display is computed. |
| Column `label` | Human readable, short, consistent with module language. |
| Column `width` | Required for important identifier/date/money columns and all sticky columns. |
| Column `type` | Use `docno`, `date`, `currency`, `number`, or `status` when applicable. |
| Column alignment | Numeric and money columns right-aligned; identifiers/dates use tabular numbers. |
| Search | Use meaningful identifiers in visible columns or `alwaysSearchKeys`. |
| Empty state | Use a clear `emptyMessage`. |

### Column type rules

| Data | Column type | Display | Sort | Filter |
| --- | --- | --- | --- | --- |
| Document number (`SO-`, `DO-`, `INV-`, `PO-`) | `docno` | Tabular numbers | String with numeric collation | Text contains / exact if needed |
| Date | `date` | `DD/MM/YYYY` style via shared formatter | Sort by ISO/date value, not formatted text | Date range at page level when needed |
| Money | `currency` | `formatRM(sen)` / `formatCurrency(sen)` | Numeric sen | Range/page filter for large lists; checkbox/text only for small lists |
| Quantity/count/minutes | `number` | `formatNumber` with tabular numbers | Numeric | Range/page filter when users compare values |
| Status | `status` | Shared status badge/color | Lifecycle order only when business order matters | Checkbox value filter or top-level status filter |
| Computed label | `text` + `render` | Render visible label | Use `sortAccessor` if sortable | Use `filterAccessor` if filterable |

### Sorting rules

1. Store numeric sort values as numbers, not formatted strings.
2. Use `sortAccessor` when the visible value is computed from a map, lookup, or derived status.
3. Do not sort money by `RM 1,000.00` text. Sort by sen.
4. Do not sort dates by displayed `DD/MM/YYYY` text. Sort by ISO date or timestamp.
5. For status, use lifecycle sort order only when the business process has a clear sequence. Otherwise sort by label.

### Filter rules

1. Use `FilterBar` for page-level search and high-level filters.
2. Use DataGrid per-column text filters for simple text search.
3. Use DataGrid value filters for small finite sets such as status, branch, department, driver, or category.
4. Use page-level min/max filters for numeric ranges such as quantity, amount, M³, days overdue, or production minutes.
5. Use `filterAccessor` when the displayed filter label differs from the raw row value.
6. Avoid filtering on formatted display text if the raw value is numeric/date/currency.

## Numeric input standard

Current code uses a mix of `Number(...)`, `parseFloat(...)`, and `parseInt(...)` in page-level inputs. Going forward, use these rules.

| Input type | State shape | User input | Save payload |
| --- | --- | --- | --- |
| Quantity / pieces | `number` or `""` while editing | integer, min 1 unless business allows 0 | integer |
| Money | string while editing (`"12.34"`) | RM decimal text | sen integer via `Math.round(Number(value) * 100)` |
| Rate / dimension | string while editing | decimal allowed | number or `null` |
| Optional numeric field | `number | "" | null` | blank allowed | `null` if blank |
| Required numeric field | string while editing + validation | blank invalid | parsed number after validation |

### Numeric input rules

1. Do not coerce blank input to `0` while the user is still typing, unless the business meaning of blank is always zero.
2. Keep money as sen in API/DB and convert only at the UI boundary.
3. Use `step="0.01"` for RM, rates, and dimensions that allow decimals.
4. Use `min` only when the business rule is real, not just to hide validation problems.
5. Show validation errors before save rather than silently clamping, except for explicit quick-entry controls such as quantity steppers.
6. Use right alignment and `tabular-nums` for editable numeric cells.

## Typography and font standard

Frontend screens and generated documents should use one typography scale. The existing app already defines the screen convention in `docs/DESIGN-SYSTEM.md` and the PDF convention in `src/lib/pdf-utils.ts`; this section makes those rules explicit for new work.

### Frontend typography

| Use | Standard | Notes |
| --- | --- | --- |
| Page title | `text-2xl font-bold text-[#1F1D1B]` | Use shared `PageHeader`. |
| Detail/object title | `text-xl font-bold text-[#1F1D1B]` | Use shared `ObjectPageHeader`. |
| Section title | `text-lg font-semibold text-[#1F1D1B]` | Cards/sections only. |
| Body text | `text-sm` | Default operational text. |
| Secondary/muted text | `text-sm text-[#6B7280]` or `text-xs text-[#8A7F73]` | Use for help text, captions, metadata. |
| Table header | `text-xs font-medium uppercase tracking-wide text-[#6B7280]` | DataGrid/default table headers. |
| Table cell | `text-sm` | Use `tabular-nums` for identifiers, dates, counts, and money. |
| Dense chip/badge | `text-xs font-medium` | Status/inline metadata only. |
| Avoid | ad-hoc `text-[10px]`, `text-[11px]`, custom font sizes | Only use when a dense legacy table genuinely cannot fit; document why. |

Frontend font family should come from the app/global Tailwind/system stack. Do not set per-page font families. For printable HTML pages, use the same system stack: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `PingFang SC`, `Microsoft YaHei`, `Helvetica Neue`, `Arial`, `sans-serif`.

### PDF typography

| PDF element | Standard | Source |
| --- | --- | --- |
| Font family | `helvetica` | jsPDF built-in; do not mix fonts per document. |
| Company name | bold, 12.5pt | `drawLetterhead`. |
| Company metadata | normal, 7pt | `drawLetterhead`. |
| Document title | bold, auto-fit 18pt down to 11pt | `drawLetterhead`. |
| Document number | 11pt | `drawLetterhead`. |
| Document metadata/date/status | 8pt | `drawLetterhead`. |
| Section label | bold, 8.5pt, brand accent | `drawSectionLabel`. |
| Table body | 7.5pt | `tableTheme`. |
| Table footer | bold, 8pt | `tableTheme`. |
| Footer fine print | 6.8pt | `drawDocFooter`. |

All new PDF generators must call `drawLetterhead` for the header — never hand-roll one — plus `drawSectionLabel` and `drawDocFooter`. **`tableTheme` is NOT the house standard** (corrected 2026-08-14): it renders a solid bronze header band (`pdf-utils.ts:152-187`) and only 2 of the 17 `generate-*-pdf.ts` files call it. The house style, per the owner ruling recorded at `pdf-utils.ts:94-96` and `UI-CONVENTIONS.md:40`, is a `theme:"plain"` autoTable (white header + black bottom-rule) as in `generate-do-pdf.ts` / `generate-invoice-pdf.ts` — neither of which imports `tableTheme` instead of hand-rolling font sizes, headers, rules, or footers.

## Document layout standard

Business documents should follow one shared layout model even if they are generated by different files today.

### Shared document sections

| Section | Standard content |
| --- | --- |
| Header / letterhead | Hookka company name, registration/tax identifiers if applicable, address/contact, logo if available. |
| Document identity | Document title, document number, issue date, page number when multipage. |
| Party A / issuer | Hookka or issuing organisation details. |
| Party B / recipient | Customer/supplier/hub/ship-to details, attention/contact when relevant. |
| Reference block | Related SO/PO/DO/Invoice/customer PO/reference numbers. |
| Line table | Item code, description, fabric/variant/size, quantity, unit, unit price when financial, total when financial. |
| Logistics block | Delivery address, hub, driver/lorry/3PL, dispatch/delivered dates where relevant. |
| Totals block | Subtotal, discount/adjustment, tax if applicable, grand total. |
| Terms / notes | Payment terms, delivery notes, internal/external remarks as appropriate. |
| Footer | Prepared/checked/approved/signature blocks and page footer. |

### Document-specific layout rules

| Document | Required emphasis |
| --- | --- |
| Quotation | Validity, customer, quoted items, prices, terms, prepared-by/signature. |
| Sales Order | Customer commitment, customer PO/reference, delivery expectation, production-relevant item detail. |
| Delivery Order | Party A/B, ship-to/hub, driver/vehicle/3PL, delivered items, QR/public tracking when applicable, receiver signature. |
| Invoice | Billing customer, invoice number/date, linked DO/SO/customer PO, money totals, payment status/terms. |
| Credit/Debit Note | Original document reference, reason, affected lines/amounts, approval/signature. |
| Packing List | Loading sequence, stop grouping, item count/M³, page numbering across batches. |

### Document layout rules

1. Use the same party labels across documents: issuer/seller/Party A on the left, recipient/buyer/Party B on the right unless a statutory format requires otherwise.
2. Document numbers and dates must appear in the top identity block.
3. Customer PO/reference numbers must be visually near the document number or reference block, not buried in line notes.
4. Financial documents must right-align amounts and use sen-based formatting.
5. Delivery/packing documents may hide prices unless explicitly required.
6. Multi-page documents must keep page numbering continuous.
7. PDF/email attachment logic must not say a document is attached if size checks remove the attachment.

## Mapping to existing source

| Area | Current source of truth | Notes |
| --- | --- | --- |
| Shared grid | `src/components/ui/data-grid.tsx` | Has column types, sorting, filtering, saved views, column width behavior. |
| Shared filter shell | `src/components/ui/filter-bar.tsx` | Use for list search + filter controls. |
| UI conventions | `docs/UI-CONVENTIONS.md` | Shared component, letterhead, and typography rules. |
| Design typography | `docs/DESIGN-SYSTEM.md` | Frontend type scale and spacing conventions. |
| PDF typography/letterhead | `src/lib/pdf-utils.ts` | Shared jsPDF font sizes, letterhead, table theme, footer. |
| Money formatting | `src/lib/utils.ts` | `formatCurrency`, `formatRM`, `formatNumber`, `roundSen`. |
| Money tests | `tests/money.test.mjs` | Pins RM formatting and sen convention. |
| DataGrid width tests | `tests/data-grid-fill.test.mjs` | Pins column width/fill behavior. |
| Print/document history | `docs/BUG-HISTORY.md` | Contains past document/PDF/layout issues that should inform standardization. |

## Migration plan

1. New grids must follow this document immediately.
2. Touched grids should be normalized opportunistically: column types, right alignment, `sortAccessor`, `filterAccessor`, `gridId`, and `FilterBar`.
3. New numeric inputs must keep editable text state when blanks are valid or when the user may temporarily clear the field.
4. New PDFs/printouts must follow the shared document sections and document-specific rules above.
5. When a module is actively changed, add or update its module-specific context pack with grid/filter/document notes.
6. Do not rewrite every old page at once. Fix standards while touching the module or when inconsistency causes real operator friction.
