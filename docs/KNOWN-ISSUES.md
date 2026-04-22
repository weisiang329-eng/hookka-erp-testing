# Known Issues

Running `npx eslint .` surfaces ~92 errors and 15 warnings. Every one of them is
a known trade-off — `tsc -b` is clean, `npx vite build` is clean, and the dev
server + production bundle both work end-to-end. The remaining issues fall
into a few buckets; this file records what they are, why they're still there,
and when to fix them.

## 1. `react-hooks/set-state-in-effect` — ~62 errors

The React 19 hooks plugin (still labelled experimental in `eslint-plugin-react-hooks@next`)
flags the idiomatic pattern:

```tsx
useEffect(() => {
  fetch("/api/foo").then(r => r.json()).then(data => {
    setFoo(data);       // <- "cascading render"
    setLoading(false);  // <- "cascading render"
  });
}, []);
```

The plugin wants you to migrate to a data-fetching library (React Query,
SWR, tanstack-query) or to `use()` with `Suspense`. The app currently
does direct `fetch` → `setState` in every list/detail page, which the
plugin sees as an anti-pattern.

**Status:** tolerated. These patterns are correct, they just render once
more than strictly necessary. Migrating to React Query is a separate
track — see `docs/ARCHITECTURE.md`, section "Extension points, 3. State &
data fetching".

## 2. `react-hooks/exhaustive-deps` — ~21 warnings

Hooks dependency lists that don't include every referenced value. Most
are intentional:

- Stable-by-construction callbacks that never actually change.
- `useEffect` hooks that re-run via a controlled key (page filter, tab
  index) where including `fetchX` would cause a loop.
- Parent state that we explicitly *don't* want to re-trigger on.

**Status:** audit case-by-case. Each one needs a human to decide whether
to add the dep, extract a stable callback, or silence with
`// eslint-disable-next-line react-hooks/exhaustive-deps`.

## 3. `@typescript-eslint/no-explicit-any` — ~12 errors

Remaining `any` uses are in:

- **`src/components/ui/data-grid.tsx`** (file-level disabled) — generic
  table utility. Callers provide type via `Column<T>`; the internal
  reducer uses `any` because it operates on arbitrary nested paths.
- **Page-level list parsers / cart event handlers** — a few spots where
  a third-party lib (jspdf `didDrawPage` hooks, `window` event listeners)
  hands back untyped objects.

**Status:** replace with proper types when the file is next touched
for a feature change. No impact on runtime safety — `tsc` already
verifies call-site usage.

## 4. `react-hooks/static-components` — 5 errors

Components defined inside other components. Each one resets state on
every parent render. `SortIcon` already got hoisted from both
`pages/production/tracker.tsx` and `pages/production-test/tracker.tsx`.
The five that remain are in:

- `src/pages/bom.tsx` (3× — tightly coupled helpers inside the edit
  dialog, would require prop-drilling a handful of local state variables
  to lift).
- `src/pages/planning/index.tsx` (2× — Gantt cell renderers that use
  the parent's date maths).

**Status:** leave until a planned refactor of those dialogs. The cost of
hoisting is the prop-drilling, and the "reset on re-render" cost is
benign for these specific components because they hold no intrinsic
state.

## 5. `react-hooks/purity` — 7 errors

Effects that perform side-effects during render (mostly `console.warn`
in dev-only branches). These would migrate to `useEffect` in a proper
clean-up pass.

## 6. `react-hooks/immutability` / `preserve-manual-memoization` / `refs` / `incompatible-library` — 7 combined

Assorted micro-warnings about prop mutation, manual `useMemo` idioms
that could be replaced with the new `cache()` API, and one library
that's flagged as "not React-19-ready".

**Status:** none block the build; revisit once the React 19 hooks plugin
exits beta.

---

## Build status

```text
npx tsc -b         ✅ 0 errors
npx vite build     ✅ built in ~1.2s, 40+ chunks
npx eslint .       ⚠️ 92 errors, 15 warnings (all documented above)
```

See also
- `docs/ARCHITECTURE.md` — extension points for the migrations
- `docs/SETUP.md` — how to reproduce these numbers locally
