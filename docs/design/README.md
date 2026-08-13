# Hookka ERP — Design Sources

> **Last verified: 2026-08-13** against `docs/design/` (all listed files exist, including
> both `standalone/*.html`), `src/pages/m/` (`MobileLayout.tsx`, `theme.ts`,
> `theme-vars.css`), `src/hooks/useMediaQuery.ts`, `src/lib/design-tokens.ts`.
> Corrected 2026-08-13: the fold-detection media query lost its `orientation` clause in
> code; the mobile hex values moved out of `theme.ts` into `theme-vars.css` when dark mode
> shipped. Every hex this file lists is still correct — they are now the light-mode values.

This folder holds the **canonical design source files** for every Hookka ERP surface. They are the single source of truth designers iterate on; dev (and AI agents like Claude / Codex / Gemini) implement the React code to match them 1:1.

## Files

| File | Type | Notes |
|---|---|---|
| `Hookka ERP Mobile.dc.html` | dc source | Phone UI (~390px wide) — full app: login + Home + module list + detail + Warehouse + Production board + Mail + Editor / FilterSheet / OCR / QR modals |
| `Hookka ERP Fold.dc.html` | dc source | Galaxy Z Fold UI (~892×684 unfolded) — left rail nav + two-pane (list left, detail right) |
| `Hookka ERP Desktop.dc.html` | dc source | Desktop UI — sidebar + topbar + 23 main scenes (Dashboard / Sales / Delivery / Invoices / Procurement / Production / Planning / BOM / Inventory / Warehouse / Customers / Suppliers / Products / CNC / Consignment / Service Cases / Mail / Announcements / Accounting / e-Invoice / Employees / User Management) |
| `support.js` | helper | dc-html runtime (lucide icons, QR generator, x-dc element). Required next to every `.dc.html` to render. |
| `hookka-logo.png` | asset | Brand logo (Fold left rail uses it). |
| `standalone/Hookka ERP Mobile (Phone).html` | standalone | Pre-rendered single-file HTML — open directly in browser, no `support.js` needed. Designers who don't run dev tooling can use this. |
| `standalone/Hookka ERP Fold.html` | standalone | Same for Fold. |

## How to view

**dc source** (best — interactive, editable):
1. Open the `.dc.html` directly in Chrome / Safari / Firefox. It loads `support.js` from the same folder.
2. You see the rendered design exactly as it appears on a real phone / fold / desktop.
3. The Mobile + Fold files render a fake phone/fold frame around the UI. The Desktop file fills the browser window.

**standalone HTML** (fastest — no dev tooling):
1. Open `standalone/*.html` directly. Self-contained.

## How designers edit

1. Open the `.dc.html` source in any text editor + a browser (refresh to see changes).
2. Edit:
   - **Layout / structure** — change `<div>` nesting, grid/flex styles
   - **Spacing / colours / typography** — change inline `style="..."` values
   - **Copy / labels** — change text inside elements + the `{{ placeholder }}` data in the bottom `<script>`
   - **Add new scenes / variants** — add a new `<sc-if value="{{ isXxx }}">...</sc-if>` block + add the `isXxx` flag in the script's `render()` return
3. Save the `.dc.html`. Refresh the browser. Iterate.

Designers do NOT need to know React. Just HTML + inline CSS.

## How devs implement

1. Read the relevant scene's `<sc-if>` block in the `.dc.html`.
2. Implement 1:1 in React + TypeScript (`src/pages/m/` for mobile, `src/pages/` for desktop).
3. Use the **same** colours / spacing / radii. Design tokens in `src/lib/design-tokens.ts` (desktop) and, for mobile, **`src/pages/m/theme-vars.css`** — corrected 2026-08-13: `src/pages/m/theme.ts` no longer holds hex values, it exports `M.*` constants that resolve to CSS custom properties (`var(--m-paper)` etc.) so a `data-theme` flip re-tints the whole `/m` app. The values below are the **light-mode** set; dark mode (shipped 2026-06-29, owner request) swaps surfaces in the same file:
   - Raisin `#1F1D1B` · Taupe `#6B5C32` · Paper `#FAF8F4`
   - Card border `#E7E0D4` · Hairline `#E2DDD8` · Divider `#F2EEE6`
   - Gold `#C9A961` · Body `#F0ECE9` (desktop only — this is the actual `<body>` background in `src/index.css`, as `--color-stone-white`)
   - system-ui font · tabular-nums · lucide-react icons (stroke 1.75)

## Versioning

- Owner exports a new dc.html from his design tool when iterating.
- New versions overwrite the file in this folder (`.dc.html` is the source).
- Git tracks the diff — you can see exactly what changed visually.
- Round number is in the commit message (e.g. "design(v13): updated mobile + fold").

## Device behaviour (Fold-specific)

The Hookka phone app at `/m` is responsive:
- **Folded** (cover screen, < 720px) → renders Mobile UI from `Hookka ERP Mobile.dc.html`
- **Unfolded** (inner screen, ≥ 720px) → renders Fold UI from `Hookka ERP Fold.dc.html` (left rail + two-pane)

Detection in code: **`useMediaQuery("(min-width: 720px)")`** at `src/pages/m/MobileLayout.tsx:87`.

> Corrected 2026-08-13: this doc said the query was
> `"(min-width: 720px) and (orientation: landscape)"`. **The `orientation` clause is not in
> the code.** Consequence: any viewport ≥720px wide gets the Fold two-pane UI regardless of
> orientation — a portrait tablet, or a phone in a large-window mode, will now render Fold,
> not Mobile. If the orientation gate was intended behaviour, that is a code bug to file,
> not a doc fix; this doc has been changed to match what the code actually does.

## Workflow

```
Owner / Designer
    │
    │ edit .dc.html
    ▼
docs/design/Hookka ERP <Surface>.dc.html
    │
    │ commit + push
    ▼
GitHub main
    │
    │ Dev / AI reads + implements
    ▼
src/pages/...      (React code)
    │
    │ Cloudflare Pages deploys
    ▼
erp.hookka.com    (prod)
```
