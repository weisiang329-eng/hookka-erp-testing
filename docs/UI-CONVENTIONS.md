# UI Conventions — Hookka ERP

> **Last verified: 2026-08-13** against `src/components/ui/` (all files),
> `src/components/material-picker.tsx`, `src/components/scan-po-modal.tsx`,
> `src/components/scan-supplier-modal.tsx`, `src/lib/pdf-utils.ts`,
> `src/lib/use-nav-guard.ts`, `src/main.tsx`, `src/lib/generate-*-pdf.ts`, `package.json`.
> Corrected 2026-08-13: `generate-order-pdf.ts` does not exist; `useNavGuard` lives in
> `src/lib/`, not `src/hooks/`; there is no bare `toast` export; the `Badge` usage example
> was incomplete. Everything else — every component file path, `drawLetterhead` /
> `drawSectionLabel` / `drawDocFooter` / `fmtCurrency` / `fmtRM` / `fmtDate` /
> `amountInWords` in `pdf-utils.ts`, `letterheadForPurchaseOrg` in
> `generate-purchase-order-pdf.ts:86`, `ConfirmProvider` mounted at `src/main.tsx:149`, and
> the `build:strict` rule — was verified and is correct.

The house design system. **One rule above all: reuse the shared components below — never hand-roll a header, dialog, money input, table, or PDF letterhead per page.** Almost every visual inconsistency we've had to fix came from a page hand-rolling its own version of something a shared component already does. New pages compose the shared pieces; if a shared piece is missing a capability, extend the shared piece, don't fork it.

This doc is the reference for keeping this app consistent — and for mirroring the same conventions into sister systems.

---

## 1. Shared components (use these — don't reinvent)

| Component | File | Use for |
|---|---|---|
| `PageHeader` | `src/components/ui/page-header.tsx` | **List / route-level page** header: title + subtitle + right-aligned action buttons. |
| `ObjectPageHeader` | `src/components/ui/object-page-header.tsx` | **Record / detail page** header (SAP "object page" pattern): `backTo`/`onBack`, `title`, `subtitle`, `badges` (status/lock chips), `actions` (buttons), `pager` (prev/next record). Every document detail page (SO/CO/DO/SI/PO/PI/GRN/Service Case/Supplier/Service Order) uses this. |
| `useConfirm` / `ConfirmProvider` | `src/components/ui/confirm-dialog.tsx` | **All** confirmations. `const { confirm } = useConfirm()` then `if (!(await confirm({ message, title?, danger? }))) return;`. NEVER use `window.confirm`. Provider is mounted once in `src/main.tsx`. |
| `DataGrid` | `src/components/ui/data-grid.tsx` | Sortable / filterable / selectable tables (list views, grids). Supports `groupBy`, type filters, `onSelectionChange`, per-cell `render`. |
| `MoneyInput` | `src/components/ui/money-input.tsx` | RM amount entry. `value: number|null` (dollars), `onChange(next)`. Commits on blur/Enter, clear-to-blank → null, 2-decimal display, right-aligned. Keep the parent's sen math unchanged — this is only the entry UX. |
| `MaterialPicker` | `src/components/material-picker.tsx` | Catalog autocomplete (raw-materials). Fills code+name on pick; still allows off-catalog free text. Never auto-fills price. |
| `SearchableSelect` | `src/components/ui/searchable-select.tsx` | Searchable dropdown (suppliers, customers, etc.). |
| `Badge` / `StatusBadge` | `src/components/ui/badge.tsx`, `status-badge.tsx` | Status chips. Prefer `<StatusBadge kind="so" value={...} />` for backend enums (compile-checked per enum). `<Badge variant="status" status={...} />` is the legacy path — `variant` accepts only `"default"` / `"status"`, and `variant="status"` needs the `status` prop as well. |
| `Button`, `Input`, `LoadingButton`, toasts | `src/components/ui/*` | Primitives. **Corrected 2026-08-13:** there is no `toast` object export and no `toast.error/success`. `toast.tsx` exports `ToastProvider` + `useToast()`; call `const { ... } = useToast()` inside a component. |
| `ScanPOModal` / `ScanSupplierModal` | `src/components/scan-po-modal.tsx`, `scan-supplier-modal.tsx` | OCR scan. Customer PO → SO (sales/consignment); supplier DO/invoice → GRN/PI (purchasing). **The scan button sits next to "Create"** in the page header (e.g. "Scan PO", "Scan GRN", "Scan PI"). |

## 2. Documents / PDFs

- **One shared letterhead for every PDF**: `drawLetterhead(doc, { docTitle, docNo, docDate?, statusText?, company?, companyInfo?, logo? })` in `src/lib/pdf-utils.ts`. Returns the body-start Y. NEVER hand-roll a PDF header.
- **Shared body helpers** (same file): `drawSectionLabel`, `drawDocFooter`, `PDF` constants (margin/ink/muted/rule), `fmtCurrency`/`fmtRM`/`fmtDate`, `amountInWords`.
- **Body style standard** = the Delivery Order / Invoice look: a `theme:"plain"` table (white header + black bottom-rule, hairline body lines, dashed per-row separators), `lblVal` two-column reference blocks, right-aligned `sumLine` totals. All generators (`src/lib/generate-*-pdf.ts`) follow it — `generate-do-pdf.ts` and `generate-invoice-pdf.ts` are the reference implementations. **Corrected 2026-08-13: `generate-order-pdf.ts` does not exist** and was removed from this list; the order-side references are `generate-so-pdf.ts` and `generate-purchase-order-pdf.ts`.
- "Borrow letterhead": a doc can print under a different company's letterhead (via the org registry) while the accounting entity stays the home company. See `letterheadForPurchaseOrg` in `generate-purchase-order-pdf.ts`.

## 3. Design tokens (colours + type)

- **Primary / brand**: bronze `#6B5C32` (hover `#4D4224`). **Danger**: `#9A3A2D` (hover `#7A2E24`). **Ink (titles/values)**: `#1F1D1B`.
- **Muted text**: `#6B7280` / `#9CA3AF`. **Borders / rules**: `#E2DDD8`. **Subtle backgrounds**: `#FAF9F7` / `#F0ECE9`. **Overdue/alert chip**: bg `#F9E1DA` border `#E8B2A1` text `#9A3A2D`.
- **Titles**: list page `text-2xl font-bold`, detail page `text-xl font-bold`, both `text-[#1F1D1B]`. Subtitles `text-xs`/`text-sm text-[#6B7280]`.
- **English only** in all UI strings and code.

## 4. Page patterns

- **List page**: `<PageHeader title subtitle actions={<>…</>} />` → KPI cards → filters → `<DataGrid>`. Scan button (if any) goes in `actions`, before the Create button.
- **Detail page**: `<ObjectPageHeader backTo title subtitle badges actions />` → status pipeline → detail cards / `DataGrid`. Put every action (PDF/Print/Edit/status transitions/delete) in `actions`; status & lock chips in `badges`. Use `onBack` (not `backTo`) when the back navigation is contextual or guarded.
- **Destructive / posting actions** (delete, void, post-to-stock, close): gate behind `await confirm({ danger: true, … })`.
- **Unsaved-edit guard**: `useNavGuard(dirty)` from **`src/lib/use-nav-guard.ts`** (router-level `useBlocker` + `beforeunload`; it is *not* in `src/hooks/`) — one per route, don't stack.

## 5. Before you push

- `npx tsc -p tsconfig.app.json --noEmit` must be clean (the strict app config; the base `tsconfig.json` is looser and misses errors the deploy fails on). Ignore only the 3 known sandbox module errors (jsbarcode, @zxing/library).
- The pre-commit hook runs the full test suite; the deploy gate re-runs strict typecheck + tests.

## 6. Reference commits (this is how the unification was done)

Search the git log for these to see worked examples:
- PDF letterhead unification: `958fe808`, `ce1424c7`, `5f601909`; PO/PI/GRN + SO/CO body restyle: `3433ba4c`, `e541c3c8`.
- Confirm dialog system: `86cb0f65`. MoneyInput: `3beaf14d`. Material picker: `5324025d`.
- Detail-header unification onto `ObjectPageHeader`: `58a3e424`, `599eb94f`, `852c7e68`.
- Scan-button placement next to Create: `063d1da2`, `43b835e0`.
