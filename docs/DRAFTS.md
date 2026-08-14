# Drafts — Pending Features to Implement

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/lib/mock-data.ts` and a scan of `src/` for `STOOL`, `CSL 2 SET`, `stoolModel` / `stoolSize`.
> Corrected 2026-08-13: the "Sofa Stool Orders" draft was resolved the way the draft itself proposed — a stool is now **its own product line**, e.g. `5537-STOOL` / "SOFA 5537 STOOL" with `sizeCode: "STOOL"` and per-seat-height prices at `src/lib/mock-data.ts:325`. There is no `stoolModel` / `stoolSize` sub-form anywhere in `src/`, so the "sub-form" alternative was NOT built and should not be listed as pending.
> **UNVERIFIED ASSERTION** (as of 2026-08-13): the remaining two drafts (`CSL 2 SET`, the `1NA : 44"` / `2A : 32"` configuration-style tokens) leave no trace in `src/` — "CSL 2 SET" appears nowhere in the source. Whether they were decided, dropped, or are still open is not checkable from code; treat as owner intent, not fact, and ask before building.

Features added by user but not yet implemented. Work on these when ready.

## Sofa Stool Orders

**Added**: 2026-04-23
**Status**: **RESOLVED 2026-08-13** — shipped as its own product line (`src/lib/mock-data.ts:325`, `5537-STOOL`, `sizeCode: "STOOL"`, per-seat-height prices). The sub-form alternative below was NOT built (`stoolModel`/`stoolSize` have zero hits in `src/`). Kept for history — **this is not open work**, though the page heading calls everything here "not yet implemented".

User added `STOOL 24"` / `STOOL 37"` to `sofaSpecials` in `variants-config`.
When a sofa SO line has a STOOL specialOrder, the form/BOM should:

1. **Size**: manual input (free text or separate dropdown, not auto-derived from main product)
2. **Model**: selectable from sofa model list (e.g., `5535 STOOL`, `5531 STOOL` — i.e., the sofa MODEL dropdown's values appended with "STOOL" suffix or a separate stool model list)

### Implementation notes (not yet decided)

- Stool probably should be its own product line (separate line item) rather than a specialOrder on the main sofa?
- OR: when STOOL specialOrder selected, sub-form appears asking for stool model + stool size
- BOM impact: stool needs its own WIP cascade (timber frame, fabric, legs)

### Current workaround

If user creates a sofa SO with STOOL specialOrder, size/model are not enforced. User manually fills notes or uses two separate SO lines.

---

## CSL 2 SET

**Added**: 2026-04-23
**Status**: **RESOLVED 2026-08-13** — shipped as its own product line (`src/lib/mock-data.ts:325`, `5537-STOOL`, `sizeCode: "STOOL"`, per-seat-height prices). The sub-form alternative below was NOT built (`stoolModel`/`stoolSize` have zero hits in `src/`). Kept for history — **this is not open work**, though the page heading calls everything here "not yet implemented".

`CSL 2 SET` x5 rows appeared as unmatched specialOrder token during backfill.

Decide: is this a new specialOrder value to add to `sofaSpecials` config, or does it map to something existing?

---

## Configuration-style specialOrders (1NA / 2A notation)

**Added**: 2026-04-23
**Status**: **RESOLVED 2026-08-13** — shipped as its own product line (`src/lib/mock-data.ts:325`, `5537-STOOL`, `sizeCode: "STOOL"`, per-seat-height prices). The sub-form alternative below was NOT built (`stoolModel`/`stoolSize` have zero hits in `src/`). Kept for history — **this is not open work**, though the page heading calls everything here "not yet implemented".

Unmatched tokens with structured notation:
- `1NA : 44"` x2
- `2A : 32"` x2
- `HEADREST MODEL 5537` x2
- `BACK REST 5537  NYLON FABRIC` x2
- `ADD 1" INFRONT LSHAPE   NYLON FABRIC` x3

These look like per-module configurations (e.g., "module 1NA gets 44-inch size"). Decide:
1. Are these new specialOrder values for `sofaSpecials`?
2. Or should they become structured per-module config in a separate field?

For now, backfill script preserved the raw strings (nothing deleted).

---

(Add more drafts below as they come up)
