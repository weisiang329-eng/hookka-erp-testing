# Production + Delivery Progressive Rendering Spec (V1, Technical Revision)

## 0) Objective / Non-negotiable Constraints
This spec defines a **performance refactor without semantic drift**.

Hard constraints:
- **UI parity**: identical columns, labels, ordering, interaction semantics, and business rules.
- **Data parity**: no required field pruning for existing department/delivery views.
- **Behavioral parity**: sort/filter/search outcomes must remain logically equivalent to current production behavior.

Out of scope:
- visual redesign
- column/wording/rule changes
- feature deprecation

---

## 1) Architecture Principle: Query/State/Render Decoupling
To avoid the historical bug class (chunking breaks search/filter), enforce strict separation:

1. **Query Layer (authoritative set computation)**
   - Owns filtering, full-text search, sorting, and server cursor traversal.
   - Must execute over the **entire eligible domain**, never over viewport/chunk subsets.

2. **State Layer (canonical client model)**
   - Maintains stable row identity map and deterministic ordering.
   - Contains the current query signature, filtered row id vector, and fetch lifecycle metadata.

3. **Render Layer (presentation window)**
   - Controls virtualization + progressive row materialization only.
   - Must not affect inclusion/exclusion semantics.

Invariant:
> Membership in result set is decided before render chunking; chunking only affects mount schedule.

---

## 2) Data Contract and Identity Semantics
All current fields required by Production/Delivery (including cross-department completion/schedule fields) remain available.

Mandatory identity/version keys:
- `id`: stable unique row identity
- `updated_at` (or `version`): monotonic staleness discriminator
- `tenant_id`: multitenancy isolation key

Recommended payload metadata:
- `queryHash`: stable hash(query params + sort + filters)
- `cursor`: opaque continuation token
- `serverTs`: response generation timestamp

---

## 3) Query Semantics (Correctness First)
### 3.1 Functional Rules
1. Search/filter/sort must run against the full result source.
2. Clearing Date Range (or any filter) recomputes from full source baseline.
3. Result counters reflect full filtered cardinality, not mounted subset cardinality.
4. Sorting comparator and null-handling behavior must match legacy logic exactly.

### 3.2 Execution Modes
**Preferred mode (large-scale / 10^5–10^6 rows):**
- server-side predicate pushdown + cursor pagination + stable server sort key
- backend returns `items`, `nextCursor`, `queryHash`, `totalApprox|totalExact`

**Transitional mode (minimal API disruption):**
- hydrate a `fullRowsIndex` in memory
- compute filtered/sorted `filteredRowIds`
- progressively mount rows by window size

---

## 4) Progressive Rendering Pipeline (Viewport-safe)
Given `filteredRowIds`:

- **T0 (first paint budget)**: mount initial `N0 = 200` rows immediately.
- **T1+ (idle slices)**: append in batches `ΔN = 300` via `requestIdleCallback`.
- **Fallback scheduler**: `setTimeout(0)` if `requestIdleCallback` unavailable.
- Continue until `renderWindowCount >= filteredRowIds.length`.

Required controls:
- generation token (`queryVersion`) check before every async append
- cancellation of previous generation on query mutation
- virtualization must remain active in grouped and ungrouped modes

Performance target:
- avoid long tasks > 50ms during user input/scroll where feasible

---

## 5) Refresh Orchestration: Single Scheduler Authority
Unify all refresh triggers (polling, visibility regain, manual refresh) behind one finite-state scheduler.

Scheduler guards:
- single in-flight request lock
- minimum refresh interval (10–20s configurable)
- visibility regain debounce
- `queryHash` dedupe
- stale response suppression by request sequence/version

State machine (minimum):
- `idle`
- `fetching`
- `cooldown`

Transition safety:
- manual refresh during `fetching` queues or coalesces (no parallel duplicate fetch)

---

## 6) Calendar / Completion-Date Interaction Stability
Issue profile: focus loss and click starvation during concurrent heavy recompute.

Mitigation contract:
- pause non-critical background refresh while date picker popover is open/focused
- isolate cell-edit local state from global row reconstruction
- resume scheduler with short debounce after commit/cancel

UX invariant:
- date picker open/selection interaction must not be preempted by background reconciliation

---

## 7) Minimal Client State Schema
- `queryState`: search term, filter set, sort descriptors, cursor metadata
- `fullRowsIndex`: Map<rowId, row>
- `filteredRowIds`: ordered array after query evaluation
- `renderWindowCount`: mounted row upper bound
- `refreshState`: scheduler state + `inFlightToken` + `lastFetchAt`
- `queryVersion`: generation counter for cancellation safety

---

## 8) Cancellation / Concurrency Rules
On any query mutation:
1. increment `queryVersion`
2. cancel pending append tasks for prior version
3. recompute filtered/sorted ids
4. reset `renderWindowCount = N0`
5. restart progressive append pipeline

Concurrency invariant:
- async callbacks must no-op unless callback.version === current queryVersion

---

## 9) Acceptance Test Matrix (Blocking)
1. Search hit outside first 200 rows is discoverable and navigable.
2. Clearing date filter restores full expected domain.
3. Department page switches do not produce overlapping duplicate fetches.
4. Calendar popover remains interactable under background refresh pressure.
5. Reported result count equals full filtered set count.
6. Sort equivalence matches pre-refactor ordering for representative fixtures.
7. Column values/labels/rules are semantically identical to baseline UI.
8. Grouped mode remains windowed/virtualized (no full DOM fallback).
9. Manual refresh during in-flight request coalesces safely.
10. Large dataset scenario preserves responsive scroll/input/filter interaction.

---

## 10) Rollout Strategy
1. implement unified refresh scheduler
2. implement query/render decoupling + progressive mount pipeline
3. implement calendar-safe refresh pause/resume hooks
4. enable telemetry and benchmark before/after (A/B if possible)
5. rollout to Production first, then Delivery

Rollback plan:
- feature flag for progressive pipeline
- independent flag for scheduler unification
- fast fallback to legacy fetch cadence if regression detected

---

## 11) Observability / SLO-oriented Metrics
Capture per interaction/session:
- TTFI (time-to-first-interactive rows)
- TTFC (time-to-full-content for current query)
- filter/search latency (p50/p95/p99)
- duplicate fetch suppression count
- long task count and total long-task time
- dropped frame indicators during scroll/edit

Suggested service-level targets:
- p95 filter/search latency < 300ms (dataset-dependent)
- first interactive rows < 1.5s for common workloads
- zero correctness regressions in acceptance matrix

---


## 12) Production-specific UI Defect Guardrails (Current Screenshot Symptom)
Observed symptom in Production grid (Fab Sew sheet):
- header/cell alignment drift and overlay artifact near frozen columns after filter/search interactions
- intermittent click hitbox mismatch around header controls

Likely root causes (implementation-level):
- mixed positioning contexts (`position: sticky` + transform-based virtualization container)
- unsynchronized horizontal scroll state between header and body layers
- z-index stacking conflict between sticky columns, filter row, and sort control affordances

Mandatory implementation guardrails:
1. **Single scroll source of truth**
   - bind header and body to one `scrollLeft` authority (no dual listeners racing).
2. **Sticky/frozen column layering contract**
   - explicit z-index ladder, e.g. body cells < sticky body < sticky header < active popovers.
3. **No transform on sticky ancestor chain**
   - avoid `transform` on parent wrappers that contain sticky headers/columns.
4. **Deterministic column width model**
   - lock header/body width computation to same column sizing function and rounding policy.
5. **Filter-row stability**
   - clearing filter must not recreate header DOM root; preserve node identity when possible.

Regression checks for this defect class:
- horizontal scroll to middle/right keeps header-body columns perfectly aligned
- clear filter/search does not produce overlay triangles/misaligned sort icons
- sticky left columns do not obscure model/type/wip headers
- header controls remain clickable without focus-stealing rerender

