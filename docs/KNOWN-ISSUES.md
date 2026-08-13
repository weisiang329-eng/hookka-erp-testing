# Known Issues

> **Last verified: 2026-08-13** against a full `npx eslint . -f json` run in this worktree, plus `src/pages/` and `src/components/ui/data-grid.tsx`.
> Corrected 2026-08-13: every count in this file was wrong and the shape of the debt has inverted. The old text claimed "~92 errors and 15 warnings" dominated by 62 `set-state-in-effect` errors; the measured run returns **20 errors and 97 warnings**, with `set-state-in-effect` down to **2**. Two buckets the old file listed (`react-hooks/static-components`, `react-hooks/purity`) now report **zero**, and the largest error bucket — `no-restricted-syntax` (24, the raw `setInterval`/`setTimeout` ban) — was not mentioned at all. The old §4 also cited `src/pages/production-test/tracker.tsx`, a file that does not exist in this repo.

## Measured baseline (2026-08-13, `npx eslint .`)

```text
ERRORS 20   WARNINGS 97
react-hooks/exhaustive-deps          28
no-restricted-syntax                 24   (raw setInterval/setTimeout ban — P4.3 drain)
react-hooks/incompatible-library     10
@typescript-eslint/no-unused-vars     9
no-useless-escape                     3
@typescript-eslint/no-explicit-any    3
react-hooks/set-state-in-effect       2
(remaining ~38 carry no ruleId)
```

Treat the buckets below as *rationale* for why each rule is tolerated, not as a count. Re-measure before quoting a number.

## 0. Test fidelity: 57% of the suite reads source text instead of running it

Measured 2026-08-13 against `origin/main`, while comparing this repo's CI with
Houzs ERP's:

```text
tests/*.test.mjs                    381 files
  use readFileSync on a source file 218   (57%)
  import and execute the code       235
  exercise a real database            2
```

The suite is fast — `node --test` boots once, no runtime per file — and a large
part of the reason is that more than half of it never executes the code it
covers. A test shaped like

```js
const users = readFileSync("src/api/routes/users.ts", "utf8");
test("creating an account still requires a password", () => { /* assert on text */ });
```

catches *"someone deleted the password check"*. It cannot catch *"the password
check is wrong"*, and it goes green against code that would throw on the first
request.

**Why this is on the list now.** The sibling repo hit a bug on 2026-08-13 that
this shape cannot see: a migration deleted parent rows and relied on
`ON DELETE CASCADE` to clear two child tables, so the behaviour depended
entirely on whether the engine enforced foreign keys. Only executing it against
a real database shows that. This repo runs on Cloudflare Workers against
Postgres through Hyperdrive, and **two** test files touch a database at all.

**What good looks like here** — not a rewrite, and explicitly *not* adopting the
sibling's Workers-pool harness, which costs ~1.76s of runtime startup per file
and was itself the subject of `docs/ci-capacity-coe.md` over there. The narrow
version: an integration suite against an ephemeral Postgres service container,
covering the routes where a wrong answer reaches money or stock — the same shape
as that repo's `test:pg` / `backend-postgres` job. Source-text tests stay where
they are useful (guarding a convention, pinning a config), and stop being the
only evidence for behaviour.

**Do not "fix" this by counting.** Converting source-text tests wholesale would
trade a fast suite for a slow one and buy little; the value is concentrated in
the handful of paths where an error is expensive. Pick those first.

## 1. `react-hooks/set-state-in-effect` — 2 remaining (was ~62)

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

## 2. `react-hooks/exhaustive-deps` — 28 warnings (measured)

Hooks dependency lists that don't include every referenced value. Most
are intentional:

- Stable-by-construction callbacks that never actually change.
- `useEffect` hooks that re-run via a controlled key (page filter, tab
  index) where including `fetchX` would cause a loop.
- Parent state that we explicitly *don't* want to re-trigger on.

**Status:** audit case-by-case. Each one needs a human to decide whether
to add the dep, extract a stable callback, or silence with
`// eslint-disable-next-line react-hooks/exhaustive-deps`.

## 3. `@typescript-eslint/no-explicit-any` — 3 remaining (was ~12)

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

## 4. `react-hooks/static-components` — 0 (RESOLVED; was 5)

> Corrected 2026-08-13: this rule now reports zero. The paragraph below is kept
> only to explain the original trade-off. Note it referenced
> `pages/production-test/tracker.tsx`, which has never existed in this repo.

Components defined inside other components. Each one resets state on
every parent render. `SortIcon` already got hoisted from
`pages/production/tracker.tsx`. The five that used to remain were in:

- `src/pages/bom.tsx` (3× — tightly coupled helpers inside the edit
  dialog, would require prop-drilling a handful of local state variables
  to lift).
- `src/pages/planning/index.tsx` (2× — Gantt cell renderers that use
  the parent's date maths).

**Status:** leave until a planned refactor of those dialogs. The cost of
hoisting is the prop-drilling, and the "reset on re-render" cost is
benign for these specific components because they hold no intrinsic
state.

## 5. `react-hooks/purity` — 0 (RESOLVED; was 7)

Effects that performed side-effects during render (mostly `console.warn`
in dev-only branches). The rule now reports zero.

## 6. `react-hooks/incompatible-library` — 10 warnings (and friends)

Assorted micro-warnings about prop mutation, manual `useMemo` idioms
that could be replaced with the new `cache()` API, and one library
that's flagged as "not React-19-ready".

**Status:** none block the build; revisit once the React 19 hooks plugin
exits beta.

---

## Build status

```text
npx eslint .       ⚠️ 20 errors, 97 warnings   (measured 2026-08-13)
```

> Corrected 2026-08-13: the `tsc -b` / `vite build` lines were removed because they were
> quoted as facts without a date and were not re-run for this audit. Run
> `npm run typecheck:app` (`tsc -p tsconfig.app.json --noEmit` — the gate per CLAUDE.md,
> stricter than the base `tsc -b`) and `npm run build` yourself rather than trusting a
> number in a doc.

See also
- `docs/ARCHITECTURE.md` — extension points for the migrations
- `docs/SETUP.md` — how to reproduce these numbers locally
