# Claude Master Prompt (Full ERP System, Not Production/Delivery Only)

## Scope confirmation
This prompt is for **full ERP system implementation**.
It is NOT limited to Production/Delivery pages.

Required module scope:
- Sales / CRM
- Production (all department views)
- Delivery / Logistics
- Inventory / WIP / FG
- Procurement / Purchasing
- Finance / Accounting touchpoints
- Workforce / HR pages using similar table/filter/scheduler patterns
- Dashboard / analytics surfaces

---

## Copy/paste this prompt to Claude

"""
Implement a full ERP system performance/stability refactor (all major modules), not only Production/Delivery.

Read and follow these docs together:
1) docs/production-delivery-progressive-rendering-spec-v1.md
2) docs/claude-production-delivery-implementation-pack.md
3) docs/claude-full-project-implementation.md
4) docs/claude-full-system-execution-playbook.md
5) docs/claude-master-prompt-full-erp.md

Critical constraints (non-negotiable):
- Preserve UI parity: same columns, labels, wording, order, and interaction behavior.
- Preserve data parity: do not remove required fields.
- Preserve behavioral parity: search/filter/sort semantics must remain equivalent to baseline.
- Progressive rendering may change mount timing only, never result membership.

Execution method:
- Execute by phases (baseline capture -> core architecture upgrades -> UX hardening -> full-flow integration -> regression hardening).
- Cover all major modules listed above; do not silently skip modules.
- If any module is deferred, explicitly report: module, reason, risk, owner, and follow-up date.

Technical requirements:
- Query/State/Render decoupling
- Progressive mount pipeline with cancellation safety
- Unified refresh scheduler (single in-flight + dedupe + stale-drop)
- Calendar interaction stability under refresh load
- Sticky/frozen header-column alignment stability
- Feature-flagged rollout and validated rollback

Output required:
1) Changed file list + rationale by module
2) Test evidence (unit/integration/ui/visual)
3) Before/after metrics table:
   - TTFI
   - TTFC
   - filter/search latency p50/p95/p99
   - duplicate fetch count
   - long task count/time
4) Open risks and mitigations
5) Rollback verification steps and result

Do not mark complete unless all blocking acceptance checks pass.
"""

---

## Files location
All handoff files are in repo path:
- `docs/production-delivery-progressive-rendering-spec-v1.md`
- `docs/claude-production-delivery-implementation-pack.md`
- `docs/claude-full-project-implementation.md`
- `docs/claude-full-system-execution-playbook.md`
- `docs/claude-master-prompt-full-erp.md`
