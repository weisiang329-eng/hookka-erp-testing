# Coverage Checklist: Conversation Requirements -> Claude Execution Docs

## Purpose
This checklist verifies that all discussed requirements are explicitly captured in docs, so nothing is accidentally omitted during phased execution.

---

## A) Scope and governance
- [x] Full ERP system scope (not only Production/Delivery)
  - Source: `docs/claude-full-system-execution-playbook.md`
- [x] No silent module skipping; deferred modules require risk/owner/date
  - Source: `docs/claude-full-system-execution-playbook.md`
- [x] Phase-gated execution (baseline -> core -> UX -> integration -> regression)
  - Source: `docs/claude-full-system-execution-playbook.md`

## B) Non-negotiable parity constraints
- [x] UI parity (columns/labels/wording/order/behavior unchanged)
- [x] Data parity (no required field removal)
- [x] Behavioral parity (search/filter/sort semantics unchanged)
- [x] Progressive rendering changes mount timing only, never result membership
  - Source: `docs/claude-master-prompt-full-erp.md`

## C) Performance architecture requirements
- [x] Query/State/Render decoupling
- [x] Progressive mount pipeline (`N0=200`, `ΔN=300`, idle append)
- [x] Cancellation safety via `queryVersion`
- [x] Unified refresh scheduler with in-flight lock + dedupe + stale-drop
  - Source: `docs/production-delivery-progressive-rendering-spec-v1.md`

## D) Problem-specific fixes discussed
- [x] Page switch stalls/freezes addressed via scheduler unification + reduced overlap
- [x] Filter clear hangs addressed via full-source recompute + cancellation/versioning
- [x] Completion Date/calendar interaction stability (pause refresh while open/focused)
- [x] Sticky/frozen header/body alignment and overlay artifacts guardrails
  - Source: `docs/production-delivery-progressive-rendering-spec-v1.md`

## E) Full-flow cross-module validation
- [x] SO -> Production -> Delivery -> Inventory integration validation
- [x] Cross-page shared state/refresh behavior validation
  - Source: `docs/claude-full-system-execution-playbook.md`

## F) Anti-regression and rollout safety
- [x] Feature-flagged rollout + rollback path
- [x] Blocking done criteria before completion
- [x] Required test evidence (unit/integration/ui/visual)
  - Source: `docs/claude-full-project-implementation.md`, `docs/claude-full-system-execution-playbook.md`

## G) Observability and success metrics
- [x] TTFI / TTFC
- [x] filter/search latency p50/p95/p99
- [x] duplicate fetch count
- [x] long task metrics
  - Source: `docs/claude-full-project-implementation.md`, `docs/production-delivery-progressive-rendering-spec-v1.md`

---

## Final instruction for Claude
Claude must include this checklist in its final report and mark each item PASS/FAIL with evidence links.

Reference prompt:
- `docs/claude-master-prompt-full-erp.md`
