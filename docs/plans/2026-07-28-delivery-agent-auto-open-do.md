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

## Design (simplified after code check — the owner's "just submit + self-approve")

Conceptually it is exactly: the agent **submits** a LOAD_PLAN and, at phase 3, **approves it
itself** — and the approve action now **creates the DO** (for clean plans). Two facts from the
code make this tractable WITHOUT refactoring the office path:

1. **`createDeliveryOrderForPOs` uses `c` almost only as `c.var.DB`** (no requirePermission
   inside; it returns a plain `DoCreateOutcome`, not `c.json`). → the headless agent can call
   it through a **minimal context shim** `{ var: { DB: db } }` (+ orgId + `actorId='AGENT_AUTO'`).
   **No fork, no risky refactor of the office DO-create path.** Office and agent hit the exact
   same guarded function.

2. **LOAD_PLAN proposals don't store the PO list** (`delivery_proposals` has `so_refs` display
   string / `state` / `hub` / `recipients`, no `productionOrderId`s). → **snapshot the derived
   PO ids onto the proposal at GENERATION time** (new self-applied column
   `delivery_proposals.production_order_ids` JSON). Then "approve = create exactly the POs you
   saw" — deterministic and auditable, no re-derivation drift.

**Where the create hangs:** on the **phase-3 approve path** (`autoApproveDeliveryProposals`,
delivery-agent.ts:1071) — after it flips a clean LOAD_PLAN to APPROVED, it calls the shared
`createDosForApprovedLoadPlan(db, orgId, proposal)` which reads the snapshotted POs, groups by
customer+hub, runs `validateDoComposition`, and calls `createDeliveryOrderForPOs` via the shim
for each clean group. Gated by phase 3 (default OFF). The human approve-button path
(`decideProposals`) stays record-only for now (unchanged office workflow); if the owner later
wants the manual button to create too, it calls the same shared function — one-line addition.

## Build-ready implementation notes (traced 2026-07-28)

- **Granularity:** `loadReadyPool(db, orgId)` returns SO-level `PoolSo` (READY_TO_SHIP, not yet
  on a non-cancelled DO), grouped by `stateCode` into one LOAD_PLAN per state. A DO is created
  per **(customerId, hubId)** group within that state (delivery-agent.ts:896-904). So the create
  step: re-run `loadReadyPool` at approve time (current-ready is correct — plans auto-expire in
  ~1 day and regenerate), filter to the approved proposal's `state`, group by (customerId, hubId).
- **Per group → one DO.** For each clean group, gather the group's SO ids → their ready
  production_order ids, then call `createDeliveryOrderForPOs(shimC, { productionOrderIds, hubId,
  salesOrderId? })`. VERIFY whether passing `salesOrderId` alone lets it derive the SO's POs
  (line ~1489 seeds from productionOrderIds; confirm the salesOrderId-only path before relying on it).
- **Shim:** `const shimC = { var: { DB: db } } as unknown as Context<Env>` — confirmed sufficient
  (the fn only touches `c.var.DB`, returns a plain `DoCreateOutcome`, does no requirePermission).
  Pass `body.createdBy='AGENT_AUTO'` / doNo auto-gen (genNextDoNo).
- **Re-derive at approve, NOT a stored snapshot** (simpler, no schema change; matches the office
  "Create Packing List" semantics — deliver what's ready now). Drop the earlier
  `production_order_ids` column idea unless drift proves to matter.
- **Wire point:** after `autoApproveDeliveryProposals` flips a clean LOAD_PLAN to APPROVED
  (delivery-agent.ts:1071), call the new shared `createDosForApprovedLoadPlan`. Only under the
  DELIVERY phase-3 gate (`isAutoApproveOn`), which the caller already checks (routes/delivery-agent.ts:307).

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
