# Repository Review (April 24, 2026)

This review focuses on consistency between documentation and implementation,
TypeScript safety posture, and build reliability.

## What is working well

- The project has strong module-level documentation (`README.md`, `docs/ARCHITECTURE.md`,
  `docs/API.md`) with clear route/module mapping.
- Production bundling currently succeeds with `vite build`.
- The repo includes migration scripts and DB transition docs, indicating active
  movement from mock-only to persisted data.

## Key findings

### 1) `typecheck` currently fails with many errors (high impact)

Running `npm run typecheck` fails with a large set of strictness-related errors,
including `unknown` JSON payload usage, missing properties on typed objects,
and a crypto typing issue in `src/api/lib/password.ts`.

**Why this matters**
- CI/CD can pass a bundle while shipping type-unsafe paths.
- Refactors become high risk because the type baseline is already broken.

**Recommendation**
- Treat restoration of a green typecheck as a short-term stabilization task.
- Start with a small “typed fetch boundary” migration (below), then ratchet down
  errors per module.

### 2) Docs claim typecheck/build sequence that no longer matches scripts (high impact)

Several docs state that `npm run build` performs `tsc -b && vite build`, but
`package.json` currently defines `build` as only `vite build`.

**Why this matters**
- Team members may assume type safety gates are active in build pipelines when
  they are not.
- Local expectations in setup docs diverge from actual command behavior.

**Recommendation**
- Either restore `build` to `tsc -b && vite build`, or update docs everywhere to
  make “build vs typecheck” separation explicit.
- Prefer restoring the typecheck gate for production confidence.

### 3) New typed fetch helper exists but adoption appears incomplete (medium/high impact)

`src/lib/fetch-json.ts` introduces a strong pattern using Zod validation,
but many call-sites still behave as if `res.json()` is untyped, producing
`TS18046` (`unknown`) errors.

**Why this matters**
- Runtime/API shape drift is still possible outside validated boundaries.
- The repo pays migration complexity cost without yet getting safety benefits.

**Recommendation**
- Make `fetchJson` + schema helpers the default for all new and touched API
  interactions.
- Add a temporary lint rule / grep check to discourage raw `res.json()` in page
  modules.

### 4) TypeScript config strictness changed faster than call-site migration (medium impact)

`erasableSyntaxOnly: true` and stricter parsing have surfaced syntax and typing
incompatibilities (including in `fetch-json.ts`), indicating config evolution
outpaced code adaptation.

**Recommendation**
- Either:
  - keep strict settings and quickly align affected files, or
  - temporarily relax select options while landing the migration in scoped PRs.
- Avoid a long-lived half-strict state.

## Suggested stabilization plan (incremental)

1. **Contract alignment PR**
   - Align `README.md` / `docs/SETUP.md` / `docs/KNOWN-ISSUES.md` with actual
     scripts.
   - Decide and document whether `build` must include typecheck.

2. **Type baseline PR**
   - Fix `src/api/lib/password.ts` BufferSource typing issue.
   - Resolve `src/lib/fetch-json.ts` TS1294 syntax complaints.
   - Land a minimum “no new type errors” gate.

3. **Fetch migration PRs by module**
   - Migrate high-traffic modules first (`sales`, `delivery`, `production`).
   - Replace raw `res.json()` handling with schema-validated `fetchJson` calls.

4. **CI enforcement**
   - Require both `npm run typecheck` and `npm run build` in CI.
   - Optionally allow known-lint debt temporarily, but do not allow typecheck
     regressions.

## Bottom line

The repository is thoughtfully structured and production bundle-ready, but
currently lacks a reliable type-safety gate. The biggest value move is to
reconcile docs/scripts and restore a green, enforced typecheck baseline.
