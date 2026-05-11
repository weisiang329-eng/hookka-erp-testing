// ---------------------------------------------------------------------------
// cascade-fc-aggregator.test.mjs — regression guard for `aggregateFcSlots` in
// `src/api/routes/_shared/production-builder.ts`.
//
// This is the function that decides what wipLabel + wipQty the merged FAB_CUT
// job_card gets stamped with at SO confirm / PUT cascade time. Its history is
// littered with patches (12+ commits in 6 weeks per git log) because every
// time the BOM grew a new top-level FC sub-WIP, a downstream symptom showed
// up — inflated label, double-count wipQty, etc.
//
// Root cause (2026-05-11 deep audit): the slot loop in
// `createProductionOrdersForOrder` pushes ONE FC slot per (PO × top-level BOM
// node that traverses FAB_CUT). A SOFA SO with 2 lines and a 3-sub-WIP BOM
// (Base + Cushion + Armrest) yields 6 slots. Without the per-PO collapse
// (commits 5346bb7 + ce019a6), `joinModelLabel(slot.productCode)` produced
// `5531-1A(LHF)+1A(LHF)+1A(LHF)+1A(RHF)+1A(RHF)+1A(RHF)` and `wipQty=18`.
// Same class of bug surfaced on Bedframe as `1013-(S)+(S)` because BF BOMs
// have HB + Divan both traversing FAB_CUT.
//
// These tests lock the invariants so a future cascade refactor or BOM-shape
// change can't silently re-introduce the inflation:
//   - SOFA: per-PO collapse — N POs in a group → N entries in label, sum of
//     per-PO line qty in wipQty
//   - BF/ACC: per-PO group dedupes label across sub-WIPs (HB + DV → 1
//     entry), wipQty uses min(...) to express set count (HB qty=1 + DV qty=2
//     → 1 set)
//   - Empty slot list yields empty merged list
//   - Cross-PO duplicate productCodes preserved (2 SO lines of same 1A(LHF)
//     → 2 entries) — the bdaceb4 invariant
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { aggregateFcSlots } from "../src/api/routes/_shared/production-builder.ts";

// Factory for an FcSlotInfo with sensible defaults. Caller overrides only the
// fields that matter to a given test, keeping the test body focused on the
// behaviour being asserted.
function slot(overrides = {}) {
  return {
    poId: overrides.poId ?? "pord-test-01",
    productCode: overrides.productCode ?? "5531-1A(LHF)",
    baseModel: overrides.baseModel ?? "5531",
    fabricCode: overrides.fabricCode ?? "M2402-4",
    sizeLabel: overrides.sizeLabel ?? "28",
    isBF: overrides.isBF ?? false,
    itemCategory: overrides.itemCategory ?? "SOFA",
    processCategory: overrides.processCategory ?? "FAB_CUT",
    totalH: overrides.totalH ?? 0,
    divanHeightInches: overrides.divanHeightInches ?? null,
    deptId: overrides.deptId ?? "dept-fc",
    deptCode: overrides.deptCode ?? "FAB_CUT",
    deptName: overrides.deptName ?? "Fab Cut",
    sequence: overrides.sequence ?? 0,
    dueDate: overrides.dueDate ?? "2026-05-20",
    minutes: overrides.minutes ?? 30,
    wipQty: overrides.wipQty ?? 1,
    wipKey: overrides.wipKey ?? "test-wipkey",
    wipCode: overrides.wipCode ?? "5531-1A(LHF) -Base 28 (FC)",
    wipLabel: overrides.wipLabel ?? "5531-1A(LHF) -Base 28 (FC)",
    wipType: overrides.wipType ?? "SOFA_BASE",
    branchKey: overrides.branchKey ?? "",
  };
}

test("aggregateFcSlots: empty slot list returns empty merged list", () => {
  const merged = aggregateFcSlots([], "SO-2605-110");
  assert.equal(merged.length, 0);
});

test("aggregateFcSlots: SOFA 2 POs × 3 sub-WIPs collapses label to 2 entries, wipQty=2", () => {
  // The exact bug shape from SO-2605-110 (5531-1A LHF + 1A RHF). BOM has 3
  // top-level WIPs (Base + Back Cushion + Armrest) and every one traverses
  // FAB_CUT, so the planned loop pushes 3 slots per PO. Pre-fix this turned
  // into "5531-1A(LHF)+1A(LHF)+1A(LHF)+1A(RHF)+1A(RHF)+1A(RHF)" and
  // wipQty=6 (or 18 if the BOM had been wider).
  const slots = [
    slot({ poId: "PO-01", productCode: "5531-1A(LHF)", wipType: "SOFA_BASE" }),
    slot({ poId: "PO-01", productCode: "5531-1A(LHF)", wipType: "SOFA_CUSHION" }),
    slot({ poId: "PO-01", productCode: "5531-1A(LHF)", wipType: "SOFA_ARMREST" }),
    slot({ poId: "PO-02", productCode: "5531-1A(RHF)", wipType: "SOFA_BASE" }),
    slot({ poId: "PO-02", productCode: "5531-1A(RHF)", wipType: "SOFA_CUSHION" }),
    slot({ poId: "PO-02", productCode: "5531-1A(RHF)", wipType: "SOFA_ARMREST" }),
  ];
  const merged = aggregateFcSlots(slots, "SO-2605-110");
  assert.equal(merged.length, 1, "all 6 slots should land in one merged FC JC");
  const jc = merged[0];
  assert.match(
    jc.wipLabel,
    /5531-1A\(LHF\)\+1A\(RHF\)/,
    "label must collapse to 2 entries (per-PO), not 6 (per-slot)",
  );
  assert.equal(
    jc.wipQty,
    2,
    "wipQty must be SO line count (2 POs × 1 qty each), not 6 sub-slot count",
  );
});

test("aggregateFcSlots: BF 1 PO × HB+DV sub-WIPs collapses label to 1 entry, wipQty=1 set", () => {
  // The 1013-(S)+(S) bug shape. BF BOM has HB + Divan as separate top-level
  // WIPs; both traverse FAB_CUT. wipQty multipliers differ by sub-WIP
  // (HB.wipQty=1, DV.wipQty=2 via divanMultiplier) but the merged JC should
  // express set count (= min) not piece sum.
  const slots = [
    slot({
      poId: "PO-01",
      productCode: "1013-(S)",
      baseModel: "1013",
      itemCategory: "BEDFRAME",
      isBF: true,
      sizeLabel: "3FT",
      totalH: 22,
      divanHeightInches: 8,
      fabricCode: "PC151-18",
      wipQty: 1, // HB multiplier
      wipType: "HEADBOARD",
    }),
    slot({
      poId: "PO-01",
      productCode: "1013-(S)",
      baseModel: "1013",
      itemCategory: "BEDFRAME",
      isBF: true,
      sizeLabel: "3FT",
      totalH: 22,
      divanHeightInches: 8,
      fabricCode: "PC151-18",
      wipQty: 2, // DV multiplier
      wipType: "DIVAN",
    }),
  ];
  const merged = aggregateFcSlots(slots, "SO-2605-126");
  assert.equal(merged.length, 1);
  const jc = merged[0];
  // Label must NOT show "1013-(S)+(S)" — the bug we just fixed.
  assert.ok(
    !jc.wipLabel.includes("1013-(S)+(S)") &&
      !jc.wipLabel.includes("(S)+(S)"),
    `BF label must not duplicate productCode across sub-WIPs, got: ${jc.wipLabel}`,
  );
  assert.match(
    jc.wipLabel,
    /1013-\(S\) \| \(3FT\) \| \(22"\) \| \(DV 8"\) \| PC151-18 \| \(FC\)/,
    "BF label format must be productCode | sizeLabel | totalH | DV | fabric | (FC)",
  );
  assert.equal(
    jc.wipQty,
    1,
    "BF wipQty must be set count via min(HB.qty, DV.qty) = 1, not sum (3) or DV-only (2)",
  );
});

test("aggregateFcSlots: SOFA cross-PO duplicate productCodes are preserved (per bdaceb4)", () => {
  // bdaceb4 invariant — a SOFA SO with 2 lines of the same productCode
  // (1A(LHF) × 2) should yield 2 entries in the label, not 1 deduped entry.
  // The cutter physically cuts every piece, so duplicates per SO line must
  // surface. This is distinct from per-PO collapse: same productCode across
  // sibling POs (each from a different SO line) is legitimately listed
  // multiple times; same productCode within a single PO (sub-WIPs of the
  // same BOM) is the bug we collapse.
  const slots = [
    slot({ poId: "PO-01", productCode: "5535-1A(LHF)", wipType: "SOFA_BASE" }),
    slot({ poId: "PO-01", productCode: "5535-1A(LHF)", wipType: "SOFA_CUSHION" }),
    slot({ poId: "PO-02", productCode: "5535-1A(LHF)", wipType: "SOFA_BASE" }),
    slot({ poId: "PO-02", productCode: "5535-1A(LHF)", wipType: "SOFA_CUSHION" }),
  ];
  const merged = aggregateFcSlots(slots, "SO-2605-104");
  assert.equal(merged.length, 1);
  const jc = merged[0];
  assert.match(
    jc.wipLabel,
    /5535-1A\(LHF\)\+1A\(LHF\)/,
    "two SO lines of same productCode must both appear in label (per bdaceb4)",
  );
  assert.equal(
    jc.wipQty,
    2,
    "wipQty must reflect 2 POs (= 2 SO lines), not 4 (per-slot) or 1 (per-productCode dedup)",
  );
});

test("aggregateFcSlots: SOFA 1 PO × 1 sub-WIP (pre-Cushion/Arm BOM shape) still works", () => {
  // Sanity guard — the original Option C (a871743) shape where BOM only had
  // one FC sub-WIP per product. Must continue producing the expected 1-entry
  // label so the per-PO collapse doesn't regress simpler BOMs.
  const slots = [
    slot({
      poId: "PO-01",
      productCode: "5530-2A(LHF)",
      baseModel: "5530",
      wipType: "SOFA_BASE",
    }),
  ];
  const merged = aggregateFcSlots(slots, "SO-2605-079");
  assert.equal(merged.length, 1);
  const jc = merged[0];
  assert.match(
    jc.wipLabel,
    /5530-2A\(LHF\)/,
    "single-slot SOFA group must produce single-entry label",
  );
  assert.equal(jc.wipQty, 1);
});

test("aggregateFcSlots: SOFA wipKey is SO-scoped, BF wipKey is PO-scoped", () => {
  // Merge identity invariant — SOFA merges across POs of the same SO so the
  // wipKey must NOT embed poId (otherwise sibling POs scope to different
  // keys and the cross-PO merge breaks). BF/ACC merges within one PO so the
  // wipKey embeds poId to keep multi-set SOs (2 BF lines of same model)
  // separate.
  const sofaSlots = [
    slot({ poId: "PO-01", productCode: "5531-1A(LHF)", itemCategory: "SOFA" }),
  ];
  const sofaMerged = aggregateFcSlots(sofaSlots, "SO-2605-110");
  assert.ok(
    sofaMerged[0].wipKey.includes("SO-2605-110"),
    "SOFA wipKey must contain companySOId for cross-PO merge",
  );
  assert.ok(
    !sofaMerged[0].wipKey.includes("PO-01"),
    "SOFA wipKey must NOT embed poId — that would break cross-line merge",
  );

  const bfSlots = [
    slot({
      poId: "PO-01",
      productCode: "1013-(S)",
      baseModel: "1013",
      itemCategory: "BEDFRAME",
      isBF: true,
      wipType: "HEADBOARD",
    }),
  ];
  const bfMerged = aggregateFcSlots(bfSlots, "SO-2605-126");
  assert.ok(
    bfMerged[0].wipKey.includes("PO-01"),
    "BF wipKey must embed poId so multi-line BF SOs stay separate",
  );
});

test("aggregateFcSlots: totalMinutes sums across all sub-WIP slots (not collapsed)", () => {
  // Per-PO collapse applies to label + wipQty, NOT minutes. The cutter does
  // cut all sub-pieces of the set, so the total cutting time is the sum of
  // each sub-WIP's minutes. Confirm minutes math isn't collapsed.
  const slots = [
    slot({ poId: "PO-01", wipType: "SOFA_BASE", minutes: 70 }),
    slot({ poId: "PO-01", wipType: "SOFA_CUSHION", minutes: 30 }),
    slot({ poId: "PO-01", wipType: "SOFA_ARMREST", minutes: 20 }),
    slot({ poId: "PO-02", wipType: "SOFA_BASE", minutes: 70 }),
    slot({ poId: "PO-02", wipType: "SOFA_CUSHION", minutes: 30 }),
    slot({ poId: "PO-02", wipType: "SOFA_ARMREST", minutes: 20 }),
  ];
  const merged = aggregateFcSlots(slots, "SO-2605-110");
  assert.equal(
    merged[0].minutes,
    240,
    "totalMinutes must sum all 6 slots' minutes (cutting time for the whole set across both POs), not collapse to one PO",
  );
});
