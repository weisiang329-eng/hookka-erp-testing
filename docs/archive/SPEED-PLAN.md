> **ARCHIVED / SUPERSEDED — stopped being true 2026-07-14.** A one-off worktree plan for
> branch `feat/perf-speed` off staging `16b31d23`. Its measurements are from that commit and
> its levers have since been implemented, changed or refuted. Current perf state lives in
> `docs/PERF-BACKLOG.md` and `docs/PERF-DURABLE-ARCHITECTURE.md`; the method for NOT producing
> a false perf finding is in `docs/context-packs/HOOKKA-GOTCHAS.md` § "Diagnosing performance".
> Kept for history only. Verified 2026-08-13.

# Perf / Lag — dedicated worktree (branch: feat/perf-speed, off staging)

Base = staging (16b31d23) so it already has the freshness fixes. Goal: make pages
FAST without breaking correctness (owner's #1 = no dead-data; speed is #2).

## Measured problem (staging, cold; prod warm-cron helps SOME)
Every multi-tab page fires 9–18 parallel API calls on mount; several 1–3s.
- Dashboard: 18 calls, 12 >1s, `dashboard/overview` cold 7.3s → warm 0.6s.
- Delivery (/delivery): DO list 2.8s + packing-lists 2.4s + drivers 1.5s + products 2.3s…
- Inventory: `inventory/wip` 2.3s (loads on the Finished-Products tab it doesn't belong to).
Cold-vs-warm proven: dashboard/overview is a pure cold problem (warm=0.6s); the rest
(DO list, packing-lists, wip, products, drivers) are NOT cached — slow even warm.

## Three levers (by correctness risk)
1. **Warm cache (ZERO behaviour risk)** — add already-cached-but-unwarmed heavy endpoints to
   the warm cron; ensure staging can be warmed. Pure speed, no dead-data risk.
2. **Lazy-load per tab (LOW risk, verify)** — only fetch the ACTIVE tab's data; defer others to
   tab-click. Safe ONLY for fetches that feed NOTHING cross-tab. Confirmed-pure so far:
   delivery packing-lists + drivers (feed DO-grid/PL tabs, NOT the Planning dead-data logic);
   inventory WIP/RM (independent inventory types). ⚠ Do NOT defer delivery `doRaw` / `linked-po-ids`
   blindly — they feed the Ready/Planning dedup (BUG-2026-06-27 dead-data risk).
3. **Add caching to uncached slow endpoints (careful)** — withSnapshot with CORRECT sourceTables
   (the freshness audit discipline). Each = warm-but-stale risk if sourceTables wrong.

## Also
- Dedup duplicate global fetches (organisations ×2 on some pages).
- MOBILE lag: not touched yet — owner flagged it.
- Measure page-load BEFORE/AFTER each change (not just data correctness).

## Guardrail
Correctness first. Every change verified byte-identical + search-reaches-whole-dataset on staging.
