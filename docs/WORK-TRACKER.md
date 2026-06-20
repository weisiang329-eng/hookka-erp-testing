# Hookka ERP — Work Tracker

Durable, cross-session list of assigned / in-progress / shipped work so nothing is
forgotten. **Newest first. Update on every state change** (assigned → in progress →
shipped/parked). Re-read this + `MEMORY.md` at the start of each session and before
reporting "done". See `docs/DEV-OPERATING-FRAMEWORK.md` for the discipline.

Status key: 🔵 in progress · 🟡 parked/needs owner · ✅ shipped to prod · ⚪ queued

---

## 2026-06-20

- ✅ **CoE / Dev-Efficiency System built** — the "big plan" ([DEV-EFFICIENCY-SYSTEM.md](DEV-EFFICIENCY-SYSTEM.md)):
  Layer 4 **Navigation** = [NAVIGATION-MAP.md](context-packs/NAVIGATION-MAP.md) (9 modules + line-range
  index for 16 monster files, verified accurate); Layer 5 **Methodology** = [PLAYBOOKS.md](PLAYBOOKS.md)
  (8 procedures); 9 Codex docs tailored; DOCS-INDEX surfaces all. **Still optional:** light docs reorg
  (merge UI-DATA-DOCUMENT-STANDARDS→UI-CONVENTIONS), Data-dictionary/glossary, ERD map, Test-selection matrix.
- 🔵 **#3 / GRN read-bug fix** — dual-key read for snake_case cols folded to camelCase
  by `toCamel` (`purchase-orders.ts` rowToItem `material_code`; `grn.ts` rowToGRN
  arrival/shipment/landed-cost). Pushed `cdfcae69`. **TODO: confirm deploy + verify
  live** (PO item code stores+reads real code; GRN arrival transition sticks on read).
- ✅ **Employees summary stale-on-date FIX** (task #55) — wired all 6 date-bearing tabs
  (handleSummaryDateChange + onDateChange prop on Efficiency/Dept-Labor/Employee-Detail/
  Dept-Performance/Labor-Cost). Done myself via NAVIGATION-MAP (read ~250 lines not 10,951).
  tsc clean, shipped `4157cf88`. **TODO left: system-wide sweep for the same KPI-stale class
  (dashboard/reports/command-center) + verify-live.**
- 🔵 **Supplier Pricing → Supplier merge** (task #54) — premium unified module
  ([Suppliers | Price Comparison] tabs; supplier detail [Pricing & SKUs | Price
  History]; retire "Supplier Pricing" nav; `/procurement/pricing` redirect). Built
  on worktree branch, commit `5064505c`. **TODO: integrate + build:strict + ship + verify.**
- ✅ **Dev Operating Framework + Work Tracker** — this doc set + the 快准省 / review-
  discipline answer + durable tracking cadence. Committed.
- ✅ **Codex docs read + efficiency framework adopted** — read all context-packs +
  LLM-CONTEXT-STRATEGY + AI-DEVELOPMENT-MODES; saved smallest-mode discipline to memory.

## Parked — needs owner one-line confirm (from 2026-06-18 queue)

- 🟡 Supplier inline **Batch Edit** in grid (scope ambiguous).
- 🟡 Supplier **quotation export / print** (scope ambiguous).
- 🟡 Purchasing **Phase D** — document-flow lineage / SmartButtons (deferred).
