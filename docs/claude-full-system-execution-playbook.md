# Claude Full-System Execution Playbook (ERP End-to-End)

## Why this exists
You requested scope beyond Production/Delivery: execute the same quality/performance discipline across the **full ERP workflow** while minimizing frontend regressions.

This playbook defines:
1. full-system scope
2. execution governance
3. anti-regression controls
4. sign-off gates before rollout

---

## 1) Scope: Full ERP System (All Modules, Not Only Workflow)
Claude must treat this as full-system scope across **all major ERP modules**, not only SO->Production->Delivery workflow.

Minimum module coverage:
- Sales / CRM (customers, sales orders, quotations if present)
- Production (overview + all department tabs + scheduling/completion fields)
- Delivery / Logistics (delivery orders, dispatch statuses)
- Inventory / WIP / FG units
- Procurement / Purchasing (purchase orders, suppliers, GRN flows)
- Finance / Accounting surfaces touched by operational status changes
- Workforce / HR pages that share filtering/scheduler/table patterns
- Dashboard / analytics cards that fan-out to multiple APIs

Cross-cutting coverage requirements:
- cross-page navigation and shared filter/search state
- shared scheduler/refresh behavior
- shared table/grid behaviors (virtualization, sticky/frozen headers)

If any module is deferred, Claude must list it explicitly with risk, owner, and follow-up date.

---

## 2) Source Documents (authoritative)
Claude must read all of these together:
1. `docs/production-delivery-progressive-rendering-spec-v1.md`
2. `docs/claude-production-delivery-implementation-pack.md`
3. `docs/claude-full-project-implementation.md`
4. `docs/claude-full-system-execution-playbook.md` (this file)

Conflict rule:
- If instructions conflict, preserve UI/data/behavior parity first.

---

## 3) Required Execution Method (phase gates)

### Phase 0 — Baseline capture (mandatory)
Before changes, Claude must capture:
- baseline videos/screenshots for critical pages
- baseline metrics (TTFI/TTFC/filter latency/long tasks/duplicate fetch count)
- baseline behavior outputs for search/filter/sort fixtures

### Phase 1 — Core architecture upgrades
- Query/State/Render decoupling
- Progressive mount pipeline
- Unified refresh scheduler

### Phase 2 — UX stability hardening
- Calendar interaction stability
- Sticky/frozen alignment fixes
- cross-page navigation smoothness

### Phase 3 — Full-flow integration
- validate SO -> Production -> Delivery -> Inventory side effects
- validate shared state and refresh behavior across pages

### Phase 4 — Regression hardening
- run full test matrix
- run visual/regression checks
- compare before/after metrics

No phase skip allowed without explicit risk note.

---

## 4) Anti-Bug Guardrails (frontend)
To reduce “optimize then break UI” risk, Claude must enforce:
1. DOM structure stability for table header/filter row.
2. Stable keys and deterministic row identity.
3. No hidden changes to sort comparators or null ordering.
4. Cancellation safety for async pipelines (`queryVersion`).
5. Single scroll authority for sticky/frozen tables.
6. Single refresh authority for polling/visibility/manual refresh.
7. Feature-flagged rollout with immediate rollback path.

---

## 5) Done Criteria (must all pass)
1. UI parity checks pass on all in-scope workflow pages.
2. Filter/search correctness equals baseline fixtures.
3. Calendar/edit interactions remain stable under refresh load.
4. No sticky/frozen misalignment artifacts.
5. Duplicate fetch overlap eliminated by scheduler controls.
6. Performance metrics improve or remain within agreed SLO.
7. Rollback flags validated in staging.

If any item fails, do not mark complete.

---

## 6) What you send Claude (copy/paste)

"""
Implement the full ERP system performance/stability rollout (all major modules, not only a single process flow).

Read ALL docs:
- docs/production-delivery-progressive-rendering-spec-v1.md
- docs/claude-production-delivery-implementation-pack.md
- docs/claude-full-project-implementation.md
- docs/claude-full-system-execution-playbook.md

Hard constraints:
1) No UI/label/column/order/behavior regression.
2) No required data field removal.
3) Search/filter/sort semantics must remain equivalent.
4) Progressive rendering changes mount timing only, never result membership.

Execution requirements:
- follow phase gates 0..4 exactly
- include baseline capture before coding
- include anti-regression test evidence for each phase
- if anything is deferred, list explicit risk and mitigation

Output required:
- changed files list + rationale
- tests run + results
- before/after metrics table
- known risks/open items
- rollback instructions verified
"""

---

## 7) Repository location
All execution docs are under `docs/`:
- `docs/production-delivery-progressive-rendering-spec-v1.md`
- `docs/claude-production-delivery-implementation-pack.md`
- `docs/claude-full-project-implementation.md`
- `docs/claude-full-system-execution-playbook.md`
