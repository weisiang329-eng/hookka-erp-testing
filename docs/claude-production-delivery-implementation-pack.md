# Claude Implementation Pack: Production + Delivery Performance Refactor

## Status clarification (important)
No — the project is **not fully implemented** yet.
What is completed now:
1. technical architecture/specification
2. defect guardrails and acceptance matrix
3. rollout/rollback and observability plan

What is not completed yet:
1. runtime code refactor in Production/Delivery pages
2. scheduler unification wiring in app code
3. sticky/frozen layout bugfix in rendered grid components
4. production validation against real heavy datasets

This document is a **direct execution brief for Claude**.

---

## A) Hard constraints Claude must obey
1. Keep UI 100% identical (columns, wording, order, behavior).
2. Keep data semantics identical (do not remove required fields).
3. Keep search/filter/sort correctness identical to baseline.
4. Progressive rendering must never change query membership semantics.

Reference spec to follow:
- `docs/production-delivery-progressive-rendering-spec-v1.md`

---

## B) Work breakdown Claude should implement

### B1. Query/State/Render decoupling
- Introduce clear separation between:
  - Query layer (full-domain filter/search/sort)
  - State layer (canonical `fullRowsIndex`, `filteredRowIds`, `queryVersion`)
  - Render layer (`renderWindowCount`, virtualization, progressive append)

Acceptance:
- Search hit outside first chunk still appears.
- Clearing date range returns full expected set.

### B2. Progressive mount pipeline
- Initial mount `N0 = 200`
- Incremental append `ΔN = 300`
- Scheduler: `requestIdleCallback`; fallback `setTimeout(0)`
- Cancellation token via `queryVersion`

Acceptance:
- No stale async append mutates state after query changes.

### B3. Single refresh scheduler authority
- Unify polling + visibility + manual refresh into one FSM (`idle/fetching/cooldown`)
- Enforce single in-flight guard
- Deduplicate via `queryHash`
- Stale response suppression via sequence/version check

Acceptance:
- No duplicate overlapping fetches during tab/page switches.

### B4. Calendar interaction stability
- Pause non-critical refresh while date picker is open/focused
- Resume with debounce after commit/cancel
- Prevent focus theft from global recompute

Acceptance:
- Completion Date calendar remains clickable and stable.

### B5. Sticky/frozen column defect fix
- Ensure header/body single `scrollLeft` source
- Enforce z-index ladder for sticky body/header/popovers
- Avoid transform on sticky ancestor chain
- Use deterministic shared width model for header/body

Acceptance:
- No overlay/misalignment artifact in Production Fab Sew view after filter/search and horizontal scroll.

---

## C) Suggested implementation sequence
1. Add instrumentation first (timing + duplicate fetch counters).
2. Refactor scheduler (B3).
3. Add query/state/render model (B1) and progressive mount (B2).
4. Add calendar safety (B4).
5. Fix sticky/frozen layout (B5).
6. Run acceptance matrix and compare baseline metrics.

---

## D) Required test checklist for Claude
1. Unit tests for queryVersion cancellation semantics.
2. Unit tests for scheduler dedupe/in-flight lock.
3. Integration tests for filter clear + search correctness under chunking.
4. UI tests for calendar clickability during background refresh.
5. Visual/regression tests for sticky header/frozen column alignment.
6. Performance benchmark snapshot (before/after):
   - TTFI
   - filter latency p95
   - duplicate fetch count
   - long task count

---

## E) Copy-paste prompt for Claude
Use the prompt below as-is:

"""
Implement the Production + Delivery performance refactor according to:
- docs/production-delivery-progressive-rendering-spec-v1.md
- docs/claude-production-delivery-implementation-pack.md

Non-negotiable constraints:
1) Preserve UI parity exactly (same columns, labels, order, behavior).
2) Preserve data parity (do not remove required fields).
3) Preserve behavioral parity for search/filter/sort semantics.
4) Progressive rendering must only change mount timing, not result membership.

Deliverables:
- Code changes for B1..B5 in the implementation pack.
- Tests for cancellation, scheduler dedupe, search/filter correctness, calendar stability, sticky/frozen alignment.
- Before/after metrics summary (TTFI, filter p95, duplicate fetch count, long tasks).

If any behavior parity risk appears, stop and report exact risk before proceeding.
"""
