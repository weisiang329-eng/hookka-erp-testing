# Plan — Delivery Agent auto-opens DOs at Phase 3 (moving a blueprint red line)

**Owner decision (2026-07-28):** "B" — move the Delivery Agent red line so that, at
runtime **phase 3 (full-auto)**, the agent doesn't just approve its own LOAD_PLAN — it
actually **creates the Delivery Orders**, end-to-end, instead of leaving it for the office.
This is an explicit owner upgrade per AGENTS-BLUEPRINT iron rule #1 ("护栏内自动化需 owner 明示升级").

## Scope — what changes, what does NOT

**Moves ONE red line only:** Delivery JD 禁区 line 163 `不自动确认发货（提案制）` → at phase 3,
auto-create DOs from approved LOAD_PLANs.

**KEEP the other three delivery red lines (unchanged):**
- `CN 永不开发票` (consignment notes never auto-invoice)
- `不改已 INVOICED 单据` (never touch INVOICED docs)
- **`不越过 hub 完整性规则`** (hub integrity — the guard we just hardened in the hub-vanishes fix)

**The agent auto-opens the DO and STOPS there.** It does NOT auto-invoice, auto-dispatch,
or auto-mark-delivered — those are physical/irreversible events a human confirms (there is
no auto-POD by design). "Open the DO" is the agent's realistic digital end-of-work.

## Two real architectural challenges (why this is not a 5-line change)

1. **LOAD_PLAN proposals do NOT store the PO list.** `delivery_proposals` carries only
   `so_refs` (display string), `state`, `hub`, `recipients` (JSON {customer,hub,doCount,valueSen})
   — no `productionOrderId`s. So at execution the agent must **re-derive the ready POs** for
   each (customer, hub) bucket, exactly the way the office's "Create Packing List" does.
   → Reuse the SAME ready-PO derivation the LOAD_PLAN generator uses (delivery-agent.ts
   ~889-949) so proposal-time and execution-time see the same set. Snapshot the derived PO
   set on the proposal at approval time so what gets created is auditable.

2. **`createDeliveryOrderForPOs(c, body)` needs a Hono request `Context`**, but the agent
   runs headless (heartbeat/run-now → `runDeliveryAgent(db,...)`, no `c`).
   → Extract a **context-free core** `createDeliveryOrderForPOsCore(db, orgId, actorId, body)`
   from the existing route helper; the route wraps it (byte-identical behaviour for the
   office path — regression-guarded), and the agent calls the core directly with the
   agent's orgId + `actorId='AGENT_AUTO'`. Do NOT fork the logic; the office and the agent
   MUST create DOs through the exact same guarded code.

## Guardrails (must all hold before an auto-create fires)

- **Only "clean" plans auto-open.** A bucket auto-creates a DO ONLY when it is a single
  customer + single hub, the hub is present/resolved, and every candidate PO passes
  `validateDoComposition` (one-customer / one-hub / PO-delivered-once). ANY ambiguity
  (mixed state/hub, missing hub, a PO already on a DO, cross-customer) → **leave it as an
  APPROVED proposal for the office** and log why. Never guess.
- **Reuse `validateDoComposition` verbatim** — no new composition logic. Hub-integrity red
  line stays enforced by construction.
- **Snapshot + rollback.** Every agent-created DO records a `plan_snapshots`-style row +
  ONE `audit_events` row (`actor='AGENT_AUTO'`), and is reversible via the existing
  agent-console rollback path. Mirrors production's phase-3 dueDate autonomy.
- **Behind the phase-3 gate, default OFF.** Fires only when the owner explicitly sets the
  DELIVERY family to phase 3 (`isAutoApproveOn`). Gate fails closed. Owner's Pause / global
  kill-switch / hard caps still apply.
- **Idempotent + re-entrant safe.** Re-running the agent must not double-create (guard on
  the PO-already-on-a-DO check + the approved-proposal → created linkage).

## Test strategy (TDD — write first)

- Unit: `createDeliveryOrderForPOsCore` byte-identical to the current route path for a
  known PO set (office regression — the extraction must not change office behaviour).
- Unit: bucket re-derivation returns the same PO set the LOAD_PLAN generator saw.
- Behavioral: clean single-customer/hub bucket → one DO created via the core; mixed/no-hub
  bucket → NO DO, proposal stays APPROVED, reason logged.
- Guard: hub-integrity / delivered-once cases are rejected (reuse validateDoComposition).
- Structural pin: the agent path calls the SAME core the office route calls (no forked
  DO-create logic); phase-3-gate-off → zero auto-creates.
- Full suite green + build:strict before any push.

## Rollout

Feature → **staging** (per repo rule: features go to staging). Owner flips DELIVERY to
phase 3 ON STAGING, runs the agent, verifies real DOs open correctly (right hub, right POs,
snapshot present, office invoice/POD flow still manual) → only then to prod. Live read+write
verification required (owner env; dev DB is IPv6-unreachable).

## Blueprint update (same PR)

Record the red-line move in `docs/AGENTS-BLUEPRINT.md` Delivery JD: line 163 红线 amended —
"phase 3 起 agent 自动开 DO（干净单；沿用 validateDoComposition + hub 完整性；发票/派车/POD 仍人工）",
with the 2026-07-28 owner-approval note. The other three delivery red lines stay verbatim.
