// ---------------------------------------------------------------------------
// production-order-builder.test.mjs — unit tests for the pure helpers in the
// production-order builder: `src/api/routes/_shared/production-builder.ts`.
//
// (There is no file literally named `production-order-builder.ts`; the
// PO-building module is `_shared/production-builder.ts`. Its async DB entry
// point `createProductionOrdersForOrder` is NOT pure — it issues D1 queries —
// so it is out of scope here. The exported PURE functions are:
//   - parseL1Processes — parse the BOM `l1Processes` JSON column.
//   - buildFcWipLabel  — assemble the human-readable FAB_CUT JC label.
//   - joinModelLabel   — join productCodes into one composite label.
//   - aggregateFcSlots — already covered by cascade-fc-aggregator.test.mjs;
//     not duplicated here.)
//
// These three drive what every merged FAB_CUT job_card is stamped with at SO
// confirm. The label/JC fields are what the cutter physically reads, so a
// silent regression here mislabels real shop-floor work.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseL1Processes,
  buildFcWipLabel,
  joinModelLabel,
} from "../src/api/routes/_shared/production-builder.ts";

// ===========================================================================
// parseL1Processes — BOM `l1Processes` column: JSON [{dept,deptCode,category,
// minutes}]. Must coerce types, drop entries with no deptCode, never throw.
// ===========================================================================

test("parseL1Processes: null input returns empty array", () => {
  assert.deepEqual(parseL1Processes(null), []);
});

test("parseL1Processes: empty string returns empty array", () => {
  assert.deepEqual(parseL1Processes(""), []);
});

test("parseL1Processes: malformed JSON returns empty array (no throw)", () => {
  assert.deepEqual(parseL1Processes("{not json"), []);
});

test("parseL1Processes: non-array JSON (object) returns empty array", () => {
  assert.deepEqual(parseL1Processes('{"deptCode":"PACKING"}'), []);
});

test("parseL1Processes: a valid single process is parsed", () => {
  const out = parseL1Processes(
    JSON.stringify([{ deptCode: "PACKING", category: "pack", minutes: 15 }]),
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    deptCode: "PACKING",
    category: "pack",
    minutes: 15,
  });
});

test("parseL1Processes: multiple processes preserve order", () => {
  const out = parseL1Processes(
    JSON.stringify([
      { deptCode: "UPHOLSTERY", category: "uph", minutes: 60 },
      { deptCode: "PACKING", category: "pack", minutes: 15 },
    ]),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].deptCode, "UPHOLSTERY");
  assert.equal(out[1].deptCode, "PACKING");
});

test("parseL1Processes: entries with no deptCode are dropped", () => {
  // `.filter((p) => p.deptCode.length > 0)` — a process must name a dept.
  const out = parseL1Processes(
    JSON.stringify([
      { deptCode: "PACKING", category: "pack", minutes: 15 },
      { category: "orphan", minutes: 99 },
      { deptCode: "", category: "empty", minutes: 5 },
    ]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].deptCode, "PACKING");
});

test("parseL1Processes: missing minutes coerces to 0", () => {
  // `Number(p.minutes) || 0` — undefined / NaN minutes become 0.
  const out = parseL1Processes(
    JSON.stringify([{ deptCode: "PACKING", category: "pack" }]),
  );
  assert.equal(out[0].minutes, 0);
});

test("parseL1Processes: non-numeric minutes coerces to 0", () => {
  const out = parseL1Processes(
    JSON.stringify([
      { deptCode: "PACKING", category: "pack", minutes: "abc" },
    ]),
  );
  assert.equal(out[0].minutes, 0);
});

test("parseL1Processes: missing category coerces to empty string", () => {
  // `String(p.category ?? "")`.
  const out = parseL1Processes(
    JSON.stringify([{ deptCode: "PACKING", minutes: 10 }]),
  );
  assert.equal(out[0].category, "");
});

test("parseL1Processes: numeric deptCode is stringified, not dropped", () => {
  // `String(p.deptCode ?? "")` — a numeric value stays (length > 0).
  const out = parseL1Processes(JSON.stringify([{ deptCode: 7, minutes: 1 }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].deptCode, "7");
});

// ===========================================================================
// joinModelLabel — join productCodes into one composite label, with
// shared-prefix stripping. Preserves source order AND duplicates.
// ===========================================================================

test("joinModelLabel: empty list returns empty string", () => {
  assert.equal(joinModelLabel([]), "");
});

test("joinModelLabel: single productCode returns it unchanged", () => {
  assert.equal(joinModelLabel(["5531"]), "5531");
});

test("joinModelLabel: single variant code returns it unchanged", () => {
  assert.equal(joinModelLabel(["5531-1A(LHF)"]), "5531-1A(LHF)");
});

test("joinModelLabel: shared prefix is stripped from all but the first", () => {
  // ["5535-2A(LHF)","5535-L(RHF)"] → "5535-2A(LHF)+L(RHF)".
  assert.equal(
    joinModelLabel(["5535-2A(LHF)", "5535-L(RHF)"]),
    "5535-2A(LHF)+L(RHF)",
  );
});

test("joinModelLabel: preserves order AND duplicate productCodes", () => {
  // The cutter must see every physical piece — duplicates are NOT deduped.
  assert.equal(
    joinModelLabel([
      "5535-1A(LHF)",
      "5535-1NA",
      "5535-1A(RHF)",
      "5535-1A(LHF)",
      "5535-1A(RHF)",
      "5535-1S",
    ]),
    "5535-1A(LHF)+1NA+1A(RHF)+1A(LHF)+1A(RHF)+1S",
  );
});

test("joinModelLabel: no shared prefix → plain '+' join", () => {
  // Different base models → just join with "+", no prefix stripping.
  assert.equal(joinModelLabel(["5531", "5535"]), "5531+5535");
});

test("joinModelLabel: partial-prefix mismatch → no stripping", () => {
  // The prefix is the first code's slice up to its first dash. If not EVERY
  // code starts with it, fall through to the plain join.
  assert.equal(
    joinModelLabel(["5531-1A(LHF)", "5599-2B(RHF)"]),
    "5531-1A(LHF)+5599-2B(RHF)",
  );
});

test("joinModelLabel: code with no dash → plain join (no prefix logic)", () => {
  // firstDash <= 0 → skip the prefix branch entirely.
  assert.equal(joinModelLabel(["5531", "5531"]), "5531+5531");
});

test("joinModelLabel: falsy entries are filtered out before joining", () => {
  // `.filter(Boolean)` drops "", null, undefined.
  assert.equal(
    joinModelLabel(["5531-1A", "", "5531-2A", null, undefined]),
    "5531-1A+2A",
  );
});

test("joinModelLabel: all-falsy list returns empty string", () => {
  assert.equal(joinModelLabel(["", null, undefined]), "");
});

// ===========================================================================
// buildFcWipLabel — assemble the FAB_CUT JC label from its segments.
// Format: [modelLabel, (size), (totalH"), (DV h"), fabric, (FC)].join(" | ")
// with empty segments filtered out.
// ===========================================================================

test("buildFcWipLabel: SOFA — size shown, BF-only segments omitted", () => {
  // SOFA: isBF=false so totalH and DV segments never appear.
  const label = buildFcWipLabel(
    "5531-1A(LHF)+1A(RHF)",
    "28",
    0,
    null,
    "M2402-4",
    false,
  );
  assert.equal(label, "5531-1A(LHF)+1A(RHF) | (28) | M2402-4 | (FC)");
});

test("buildFcWipLabel: BF — totalH and DV segments included", () => {
  // BF: isBF=true, totalH>0 and divanHeightInches truthy → both render.
  const label = buildFcWipLabel("1013-(S)", "3FT", 22, 8, "PC151-18", true);
  assert.equal(label, '1013-(S) | (3FT) | (22") | (DV 8") | PC151-18 | (FC)');
});

test("buildFcWipLabel: BF with totalH 0 omits the totalH segment", () => {
  // `isBF && totalH > 0` — a 0 height drops the (X") segment.
  const label = buildFcWipLabel("1013-(S)", "3FT", 0, 8, "PC151-18", true);
  assert.equal(label, '1013-(S) | (3FT) | (DV 8") | PC151-18 | (FC)');
});

test("buildFcWipLabel: BF with null divanHeight omits the DV segment", () => {
  // `isBF && divanHeightInches` — null/0 drops the (DV X") segment.
  const label = buildFcWipLabel("1013-(S)", "3FT", 22, null, "PC151-18", true);
  assert.equal(label, '1013-(S) | (3FT) | (22") | PC151-18 | (FC)');
});

test("buildFcWipLabel: empty sizeLabel omits the size segment", () => {
  // `sizeLabel ? "(...)" : ""` — empty size drops the (size) segment.
  const label = buildFcWipLabel("5531-1A(LHF)", "", 0, null, "M2402-4", false);
  assert.equal(label, "5531-1A(LHF) | M2402-4 | (FC)");
});

test("buildFcWipLabel: empty fabricCode omits the fabric segment", () => {
  // fabricCode || "" → "" → filtered out by .filter(Boolean).
  const label = buildFcWipLabel("5531-1A(LHF)", "28", 0, null, "", false);
  assert.equal(label, "5531-1A(LHF) | (28) | (FC)");
});

test("buildFcWipLabel: (FC) suffix is always present", () => {
  // Even a label with everything else empty keeps the (FC) marker.
  const label = buildFcWipLabel("", "", 0, null, "", false);
  assert.equal(label, "(FC)");
});

test("buildFcWipLabel: SOFA never shows totalH even when totalH > 0", () => {
  // The `isBF &&` guard means a non-zero totalH on a SOFA is suppressed —
  // sofa height is not a cutter-relevant dimension.
  const label = buildFcWipLabel(
    "5531-1A(LHF)",
    "28",
    30,
    12,
    "M2402-4",
    false,
  );
  // No (30") and no (DV 12") — both BF-gated.
  assert.equal(label, "5531-1A(LHF) | (28) | M2402-4 | (FC)");
});

test("buildFcWipLabel: segments joined with ' | ' separator", () => {
  // Pin the separator — Inventory and the Production sheet are kept in
  // lockstep on this exact string.
  const label = buildFcWipLabel("M1", "Q", 0, null, "F1", false);
  assert.ok(label.includes(" | "), "segments must be ' | '-joined");
  assert.equal(label.split(" | ").length, 4); // M1, (Q), F1, (FC)
});
