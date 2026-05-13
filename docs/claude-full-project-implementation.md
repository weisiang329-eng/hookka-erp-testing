# Hookka ERP Full Project Implementation Handoff (for Claude)

> Purpose: This is a single, end-to-end implementation brief you can send directly to Claude.
> Goal: Keep current UI/labels/rules/data semantics unchanged while making Production + Delivery significantly smoother and more stable.

---

## 1) Project Mission (Non-negotiable)
Claude must optimize performance **without semantic drift**:
1. Same UI and UX behavior.
2. Same columns/labels/order.
3. Same business rules and status logic.
4. Same data meaning (no required field removal).
5. Search/filter/sort correctness must match baseline outputs.

If any item above is at risk, Claude must stop and report before merging.

---

## 2) Current Pain Points to Fix (from production behavior)
1. Page switching freezes/stalls (especially Production department pages).
2. Clearing filters (including date range) can hang or become unresponsive.
3. Completion Date calendar sometimes cannot be clicked until focus is moved elsewhere.
4. Sticky/frozen column header/body misalignment and overlay artifacts in Production table.
5. Duplicate work from overlapping refresh triggers (polling + visibility + manual refresh).

---

## 3) Required Architecture Changes

### A. Query/State/Render Decoupling
- Query layer decides membership and order for the **full eligible dataset**.
- State layer stores canonical row map/index and ordered ids.
- Render layer only controls mount timing/window (virtualization + progressive chunking).
- Progressive chunking must never decide whether a row exists in results.

### B. Progressive Mounting
- Initial mount: `N0 = 200`
- Incremental append: `ΔN = 300`
- Scheduler: `requestIdleCallback`, fallback `setTimeout(0)`
- Cancel stale pipelines using `queryVersion` generation token.

### C. Unified Refresh Scheduler
- Replace multi-trigger independent refreshes with one scheduler FSM:
  - `idle -> fetching -> cooldown -> idle`
- Guards:
  - single in-flight lock
  - min refresh interval
  - visibility debounce
  - `queryHash` dedupe
  - stale response drop by sequence/version

### D. Calendar Interaction Safety
- Pause non-critical refresh while calendar popover is open/focused.
- Resume with debounce on commit/cancel.
- Isolate cell edit state from global row recomputation.

### E. Sticky/Frozen Layout Stability
- One scroll authority (`scrollLeft`) shared by header/body.
- Explicit z-index ladder for body/sticky/header/popovers.
- No transform on sticky ancestor chain.
- Deterministic shared column width calculation for header/body.

---

## 4) Data + API Contracts
Required keys:
- `id`
- `updated_at` or `version`
- `tenant_id`

Recommended metadata:
- `queryHash`
- `cursor`
- `serverTs`

Preferred large-scale mode:
- server-side filter/search/sort + cursor pagination.

Transitional mode:
- maintain `fullRowsIndex` in client memory, derive `filteredRowIds`, then progressive mount.

---

## 5) Exact Implementation Work Packages

### WP-1 Scheduler Refactor
Deliverables:
- central refresh scheduler module/hook
- page integration for Production + Delivery
- duplicate fetch prevention

Tests:
- in-flight lock test
- dedupe test
- visibility debounce test

### WP-2 Query/State/Render Refactor
Deliverables:
- canonical data model (`fullRowsIndex`, `filteredRowIds`, `queryVersion`)
- render window model (`renderWindowCount`)
- strict separation of query computation and rendering

Tests:
- search hit outside first chunk appears
- clear date range returns expected full set
- sort equivalence vs baseline fixtures

### WP-3 Progressive Mount Pipeline
Deliverables:
- initial batch + idle append pipeline
- cancellation semantics for outdated query versions

Tests:
- no stale append after query mutation
- responsive input while large result sets mount

### WP-4 Calendar Stability
Deliverables:
- refresh pause/resume hooks around date picker lifecycle
- focus-safe editing path

Tests:
- date picker remains clickable during background refresh
- no forced close due to unrelated rerender

### WP-5 Sticky/Frozen Grid Bugfix
Deliverables:
- unified horizontal scroll sync
- layering fix
- width model fix

Tests:
- no overlay artifacts after filter/search clear
- header/body alignment preserved under horizontal scroll

### WP-6 Observability + SLO Instrumentation
Capture:
- TTFI
- TTFC
- filter/search latency p50/p95/p99
- duplicate fetch suppression count
- long task count/time
- dropped frames during scroll/edit

---

## 6) Acceptance Matrix (Blocking)
1. Search result outside first render chunk is still found.
2. Clearing any filter restores full expected results.
3. No overlapping duplicate fetches on page/tab switches.
4. Calendar is always interactable when opened.
5. Result count equals full filtered cardinality.
6. Sort order identical to pre-refactor baseline.
7. UI columns/labels/rules unchanged.
8. Grouped view remains virtualized/windowed.
9. Manual refresh during fetch coalesces safely.
10. Sticky/frozen layout remains aligned and clickable.

All 10 must pass before merge.

---

## 7) Rollout and Rollback
Rollout order:
1. Production page
2. Delivery page

Use feature flags:
- `enableProgressiveMount`
- `enableUnifiedRefreshScheduler`
- `enableStickyLayoutFix`

Rollback:
- disable flags independently and revert to legacy behavior immediately.

---

## 8) Coding Requirements for Claude
1. Keep patch scope focused; avoid unrelated refactors.
2. Add/extend automated tests for each work package.
3. Maintain type safety and existing lint/style conventions.
4. Include migration notes in PR description.
5. Provide before/after metrics snapshot in PR.

---

## 9) Final Deliverables Claude Must Return
1. Code changes for WP-1..WP-6.
2. Passing automated tests.
3. Benchmark table (before vs after).
4. Risk log (any parity-risk areas and mitigations).
5. Rollback instructions validated.

---

## 10) Copy/Paste Prompt to Send Claude

"""
You are implementing a performance/stability refactor for Hookka ERP Production + Delivery pages.

Read and follow strictly:
- docs/production-delivery-progressive-rendering-spec-v1.md
- docs/claude-production-delivery-implementation-pack.md
- docs/claude-full-project-implementation.md

Hard constraints:
1) UI parity: no changes to columns/labels/order/UX semantics.
2) Data parity: do not remove required fields.
3) Behavior parity: search/filter/sort results must remain equivalent.
4) Progressive rendering can only change mount timing, never result membership.

Implement work packages WP-1..WP-6 from the full project handoff.
Add tests for scheduler dedupe/cancellation, filter/search correctness under chunking,
calendar interaction stability, and sticky/frozen alignment.

Output required:
- code diff summary
- tests run + pass/fail
- before/after metrics (TTFI, filter p95, duplicate fetch count, long tasks)
- rollback instructions

If any parity risk is discovered, stop and report exact risk + proposed mitigation.
"""
