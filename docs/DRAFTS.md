# Drafts — Pending Features to Implement

Features added by user but not yet implemented. Work on these when ready.

## Sofa Stool Orders

**Added**: 2026-04-23
**Status**: Parked — user to fix tomorrow

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
**Status**: Parked — user to fix tomorrow

`CSL 2 SET` x5 rows appeared as unmatched specialOrder token during backfill.

Decide: is this a new specialOrder value to add to `sofaSpecials` config, or does it map to something existing?

---

## Configuration-style specialOrders (1NA / 2A notation)

**Added**: 2026-04-23
**Status**: Parked — user to fix tomorrow

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
