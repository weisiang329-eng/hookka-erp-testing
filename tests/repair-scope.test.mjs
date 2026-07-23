// ---------------------------------------------------------------------------
// repair-scope.test.mjs — Service-Order Repair Scope (0160).
//
// Part 1: unit tests for the pure helpers in src/lib/repair-scope.ts —
//   the process filter (FULL no-op, preset dept sets, WIP-drop, first
//   surviving dept), the strict write validator, and the material
//   classification rules (class-based presets, branch-based CUSTOM).
//
// Part 2: structural pins (source-text assertions, same style as
//   service-hub-chain.test.mjs) — the builder filter sits after the
//   Headboard-Only filter, the cascade material filter exists, the
//   delivery-pipeline fallback exists, and the ALTERs + migration file
//   exist with the correct folded-lowercase adapter handling.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REPAIR_DEPT_CODES,
  REPAIR_SCOPE_PRESET_DEPTS,
  parseRepairScope,
  serializeRepairScope,
  validateRepairScopeInput,
  filterWipsByRepairScope,
  filterWipsByRepairComponents,
  repairComponentScale,
  canonicalizeComponentPicks,
  materialClassForItemGroup,
  materialLineInScope,
  repairScopeBadgeLabel,
} from "../src/lib/repair-scope.ts";
import { DEPT_ORDER } from "../src/api/lib/lead-times.ts";
import {
  breakBomIntoWips,
  deriveTopLevelWipKey,
} from "../src/api/lib/bom-wip-breakdown.ts";

// ===========================================================================
// Constants stay in lockstep with the production chain.
// ===========================================================================

test("REPAIR_DEPT_CODES mirrors DEPT_ORDER exactly (same codes, same order)", () => {
  assert.deepEqual([...REPAIR_DEPT_CODES], [...DEPT_ORDER]);
});

test("owner preset table is exact", () => {
  assert.deepEqual(
    [...REPAIR_SCOPE_PRESET_DEPTS.FABRIC],
    ["FAB_CUT", "FAB_SEW", "UPHOLSTERY", "PACKING"],
  );
  assert.deepEqual(
    [...REPAIR_SCOPE_PRESET_DEPTS.FRAME],
    ["WOOD_CUT", "FRAMING", "UPHOLSTERY", "PACKING"],
  );
  assert.deepEqual(
    [...REPAIR_SCOPE_PRESET_DEPTS.FOAM],
    ["FOAM", "UPHOLSTERY", "PACKING"],
  );
});

// ===========================================================================
// parseRepairScope — lenient read side.
// ===========================================================================

test("parseRepairScope: null / empty / FULL / garbage all parse to null (no filtering)", () => {
  assert.equal(parseRepairScope(null), null);
  assert.equal(parseRepairScope(undefined), null);
  assert.equal(parseRepairScope(""), null);
  assert.equal(parseRepairScope('{"preset":"FULL","depts":[]}'), null);
  assert.equal(parseRepairScope("{not json"), null);
  assert.equal(parseRepairScope('{"preset":"NONSENSE"}'), null);
  // CUSTOM with zero valid depts degrades to FULL (write-validated data
  // can't produce this — hand-tampered rows must not scope-to-nothing).
  assert.equal(parseRepairScope('{"preset":"CUSTOM","depts":["XX"]}'), null);
});

test("parseRepairScope: presets re-derive their dept set from the table", () => {
  // Stored depts are ignored for presets — the preset is authoritative.
  const scope = parseRepairScope('{"preset":"FABRIC","depts":["FOAM"]}');
  assert.deepEqual(scope, {
    preset: "FABRIC",
    depts: ["FAB_CUT", "FAB_SEW", "UPHOLSTERY", "PACKING"],
  });
});

test("parseRepairScope: CUSTOM keeps only known codes, in chain order", () => {
  const scope = parseRepairScope(
    '{"preset":"CUSTOM","depts":["PACKING","BOGUS","FOAM"]}',
  );
  assert.deepEqual(scope, { preset: "CUSTOM", depts: ["FOAM", "PACKING"] });
});

// ===========================================================================
// validateRepairScopeInput — strict write side (shared FE Save + BE POST/PUT).
// ===========================================================================

test("validate: absent / null / FULL are all canonical null", () => {
  for (const raw of [undefined, null, "", { preset: "FULL" }]) {
    const v = validateRepairScopeInput(raw);
    assert.equal(v.ok, true);
    assert.equal(v.canonical, null);
  }
});

test("validate: preset canonicalizes to the table's dept set", () => {
  const v = validateRepairScopeInput({ preset: "FOAM" });
  assert.equal(v.ok, true);
  assert.equal(
    v.canonical,
    '{"preset":"FOAM","depts":["FOAM","UPHOLSTERY","PACKING"]}',
  );
  // JSON-string input form accepted too (what the FE actually sends).
  const v2 = validateRepairScopeInput(v.canonical);
  assert.equal(v2.ok, true);
  assert.equal(v2.canonical, v.canonical);
});

test("validate: rejects — unknown preset, unknown dept, duplicate dept, empty CUSTOM, preset/dept mismatch", () => {
  assert.equal(validateRepairScopeInput({ preset: "PARTIAL" }).ok, false);
  assert.equal(
    validateRepairScopeInput({ preset: "CUSTOM", depts: ["fab_cut"] }).ok,
    false,
    "lowercase dept code must be rejected, not normalized",
  );
  assert.equal(
    validateRepairScopeInput({ preset: "CUSTOM", depts: ["FOAM", "FOAM"] }).ok,
    false,
  );
  assert.equal(
    validateRepairScopeInput({ preset: "CUSTOM", depts: [] }).ok,
    false,
  );
  assert.equal(validateRepairScopeInput("{broken").ok, false);
  // A preset with a DIFFERENT dept list is a confused client.
  assert.equal(
    validateRepairScopeInput({ preset: "FABRIC", depts: ["FOAM"] }).ok,
    false,
  );
});

test("validate: CUSTOM canonicalizes tick-order into chain order", () => {
  const v = validateRepairScopeInput({
    preset: "CUSTOM",
    depts: ["PACKING", "FAB_CUT"],
  });
  assert.equal(v.ok, true);
  assert.equal(v.canonical, '{"preset":"CUSTOM","depts":["FAB_CUT","PACKING"]}');
});

// ===========================================================================
// filterWipsByRepairScope — the job-card process filter.
// ===========================================================================

// A bedframe-ish breakdown: DIVAN has no FOAM step, HEADBOARD does — matches
// the live K/Q master BOM shape (see bom-wip-breakdown chain comments).
const wip = (wipType, chain) => ({
  wipType,
  processes: chain.map((deptCode, i) => ({ deptCode, minutes: 10 + i })),
});
const bfWips = () => [
  wip("DIVAN", ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"]),
  wip("HEADBOARD", ["FAB_CUT", "FAB_SEW", "FOAM", "WOOD_CUT", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"]),
];

test("filter: FULL (null scope) is a no-op — the SAME array, untouched", () => {
  const wips = bfWips();
  const out = filterWipsByRepairScope(wips, null);
  assert.equal(out, wips, "null scope must return the input array identity");
  assert.equal(out[0].processes.length, 7);
});

test("filter: FABRIC keeps exactly the 4 preset depts on every WIP", () => {
  const out = filterWipsByRepairScope(
    bfWips(),
    parseRepairScope('{"preset":"FABRIC"}'),
  );
  assert.equal(out.length, 2);
  for (const w of out) {
    assert.deepEqual(
      w.processes.map((p) => p.deptCode),
      ["FAB_CUT", "FAB_SEW", "UPHOLSTERY", "PACKING"],
    );
  }
});

test("filter: a WIP with zero surviving processes is dropped entirely", () => {
  // FOAM scope on the bedframe: DIVAN has no FOAM step → only its
  // UPHOLSTERY+PACKING survive... so instead scope CUSTOM to FOAM only:
  // DIVAN (no FOAM anywhere) drops; HEADBOARD keeps just its FOAM step.
  const out = filterWipsByRepairScope(
    bfWips(),
    parseRepairScope('{"preset":"CUSTOM","depts":["FOAM"]}'),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].wipType, "HEADBOARD");
  assert.deepEqual(out[0].processes.map((p) => p.deptCode), ["FOAM"]);
});

test("filter: first surviving dept becomes chain[0] (→ sequence 0 → prerequisiteMet=1 in the builder)", () => {
  // FOAM preset on the HEADBOARD chain: FAB_CUT/FAB_SEW are filtered out,
  // so FOAM must be the FIRST surviving process — the builder stamps
  // prerequisiteMet=1 on sequence 0 of the FILTERED chain.
  const out = filterWipsByRepairScope(
    bfWips(),
    parseRepairScope('{"preset":"FOAM"}'),
  );
  const hb = out.find((w) => w.wipType === "HEADBOARD");
  assert.ok(hb);
  assert.equal(hb.processes[0].deptCode, "FOAM");
  // Original per-process fields survive untouched (minutes preserved).
  assert.equal(hb.processes[0].minutes, 12);
});

test("filter: scopes without FAB_CUT contribute no FAB_CUT processes (no merge slots)", () => {
  const out = filterWipsByRepairScope(
    bfWips(),
    parseRepairScope('{"preset":"FRAME"}'),
  );
  for (const w of out) {
    assert.equal(w.processes.some((p) => p.deptCode === "FAB_CUT"), false);
  }
});

// ===========================================================================
// Material classification — class-based presets, branch-based CUSTOM.
// ===========================================================================

test("material class map covers the live itemGroups", () => {
  assert.equal(materialClassForItemGroup("B.M-FABR"), "FABRIC");
  assert.equal(materialClassForItemGroup("S.M-FABR"), "FABRIC");
  assert.equal(materialClassForItemGroup("S-FABRIC"), "FABRIC");
  assert.equal(materialClassForItemGroup("LINING"), "FABRIC");
  assert.equal(materialClassForItemGroup("PLYWOOD"), "WOOD");
  assert.equal(materialClassForItemGroup("WD STRIP"), "WOOD");
  assert.equal(materialClassForItemGroup("B.FILLER"), "FOAM");
  assert.equal(materialClassForItemGroup("S.FILLER"), "FOAM");
  // Out-of-class groups → null (never consumed by a scoped repair).
  assert.equal(materialClassForItemGroup("B.ACCE"), null);
  assert.equal(materialClassForItemGroup("PACKING"), null);
  assert.equal(materialClassForItemGroup(null), null);
});

test("materialLineInScope: FULL consumes everything", () => {
  assert.equal(materialLineInScope({}, "B.ACCE", null), true);
});

test("materialLineInScope: FABRIC preset keeps autoDetect-FABRIC and fabric-group lines, drops the rest", () => {
  const scope = parseRepairScope('{"preset":"FABRIC"}');
  assert.equal(materialLineInScope({ autoDetect: "FABRIC" }, null, scope), true);
  assert.equal(materialLineInScope({}, "S.M-FABR", scope), true);
  assert.equal(materialLineInScope({}, "PLYWOOD", scope), false);
  assert.equal(materialLineInScope({}, "B.FILLER", scope), false);
  // Unresolvable + unclassifiable → dropped (never over-consume).
  assert.equal(materialLineInScope({}, null, scope), false);
});

test("materialLineInScope: FRAME → wood only; FOAM → foam only", () => {
  const frame = parseRepairScope('{"preset":"FRAME"}');
  assert.equal(materialLineInScope({}, "PLYWOOD", frame), true);
  assert.equal(materialLineInScope({}, "WD STRIP", frame), true);
  assert.equal(materialLineInScope({ autoDetect: "FABRIC" }, null, frame), false);
  assert.equal(materialLineInScope({}, "S.FILLER", frame), false);
  const foam = parseRepairScope('{"preset":"FOAM"}');
  assert.equal(materialLineInScope({}, "B.FILLER", foam), true);
  assert.equal(materialLineInScope({}, "PLYWOOD", foam), false);
});

test("materialLineInScope: CUSTOM is branch-based on the owning node's processes", () => {
  const scope = parseRepairScope('{"preset":"CUSTOM","depts":["FAB_CUT","PACKING"]}');
  // Owner node runs FAB_CUT → in scope (even for a non-fabric material).
  assert.equal(
    materialLineInScope({ ownerDeptCodes: ["FAB_CUT"] }, "PLYWOOD", scope),
    true,
  );
  // Owner node's processes entirely out of scope → dropped.
  assert.equal(
    materialLineInScope({ ownerDeptCodes: ["WOOD_CUT", "FRAMING"] }, "PLYWOOD", scope),
    false,
  );
  // No owner-process info (flat bom_components fallback) → dropped.
  assert.equal(materialLineInScope({}, "PLYWOOD", scope), false);
  assert.equal(
    materialLineInScope({ ownerDeptCodes: [] }, "B.M-FABR", scope),
    false,
  );
});

// ===========================================================================
// Component-level Repair Scope — validator (strict write side).
// ===========================================================================

const DIVAN_KEY = 'BF100::0::DIVAN::{DIVAN_HEIGHT} Divan- {SIZE}';
const HB_KEY = "BF100::1::HEADBOARD::{MODEL}({SEAT_SIZE})-HB";

test("validate components: well-formed subset canonicalizes (components ride into the stored JSON)", () => {
  const v = validateRepairScopeInput({
    preset: "CUSTOM",
    depts: ["UPHOLSTERY", "PACKING"],
    components: [{ key: DIVAN_KEY, label: '8" Divan- 6FT', qty: 1 }],
  });
  assert.equal(v.ok, true);
  assert.equal(
    v.canonical,
    JSON.stringify({
      preset: "CUSTOM",
      depts: ["UPHOLSTERY", "PACKING"],
      components: [{ key: DIVAN_KEY, label: '8" Divan- 6FT', qty: 1 }],
    }),
  );
  // Canonical string re-validates to itself (fixed point).
  const v2 = validateRepairScopeInput(v.canonical);
  assert.equal(v2.ok, true);
  assert.equal(v2.canonical, v.canonical);
});

test("validate components: absent / null = all components (canonical has NO components field)", () => {
  for (const components of [undefined, null]) {
    const v = validateRepairScopeInput({ preset: "CUSTOM", depts: ["FOAM"], components });
    assert.equal(v.ok, true);
    assert.equal(v.canonical, '{"preset":"CUSTOM","depts":["FOAM"]}');
  }
});

test("validate components: rejects — empty array, bad shapes, qty bounds, duplicates, FULL+components", () => {
  const base = { preset: "CUSTOM", depts: ["FOAM"] };
  // At-least-one rule: an empty array means the operator unticked everything.
  assert.equal(validateRepairScopeInput({ ...base, components: [] }).ok, false);
  // Not an array.
  assert.equal(validateRepairScopeInput({ ...base, components: "DIVAN" }).ok, false);
  // Entry not an object.
  assert.equal(validateRepairScopeInput({ ...base, components: ["DIVAN"] }).ok, false);
  // Missing / empty / non-string key.
  assert.equal(validateRepairScopeInput({ ...base, components: [{ label: "x", qty: 1 }] }).ok, false);
  assert.equal(validateRepairScopeInput({ ...base, components: [{ key: "", label: "x", qty: 1 }] }).ok, false);
  assert.equal(validateRepairScopeInput({ ...base, components: [{ key: 5, label: "x", qty: 1 }] }).ok, false);
  // Label must be a string when sent.
  assert.equal(validateRepairScopeInput({ ...base, components: [{ key: DIVAN_KEY, label: 7, qty: 1 }] }).ok, false);
  // qty: integer ≥ 1 — reject 0, negatives, fractions, numeric strings.
  for (const qty of [0, -1, 1.5, "2", null, undefined, NaN]) {
    assert.equal(
      validateRepairScopeInput({ ...base, components: [{ key: DIVAN_KEY, label: "Divan", qty }] }).ok,
      false,
      `qty=${String(qty)} must be rejected`,
    );
  }
  // Duplicate keys.
  assert.equal(
    validateRepairScopeInput({
      ...base,
      components: [
        { key: DIVAN_KEY, label: "Divan", qty: 1 },
        { key: DIVAN_KEY, label: "Divan again", qty: 2 },
      ],
    }).ok,
    false,
  );
  // FULL never carries component picks — a full remake repairs everything.
  assert.equal(
    validateRepairScopeInput({
      preset: "FULL",
      components: [{ key: DIVAN_KEY, label: "Divan", qty: 1 }],
    }).ok,
    false,
  );
});

test("parse: components round-trip through parse ∘ serialize (canonical fixed point)", () => {
  const canon = JSON.stringify({
    preset: "CUSTOM",
    depts: ["WOOD_CUT", "FRAMING"],
    components: [
      { key: DIVAN_KEY, label: '8" Divan- 6FT', qty: 1 },
      { key: HB_KEY, label: "1013(S)-HB", qty: 1 },
    ],
  });
  const scope = parseRepairScope(canon);
  assert.ok(scope);
  assert.equal(scope.components.length, 2);
  assert.equal(serializeRepairScope(scope), canon);
});

test("parse: lenient on components — malformed entries drop; zero survivors degrades to all-components", () => {
  // Bad qty / missing key entries are hand-tampered → dropped silently.
  const scope = parseRepairScope(
    JSON.stringify({
      preset: "CUSTOM",
      depts: ["FOAM"],
      components: [
        { key: DIVAN_KEY, label: "Divan", qty: 1 },
        { key: "", label: "no key", qty: 1 },
        { key: HB_KEY, label: "bad qty", qty: 0 },
      ],
    }),
  );
  assert.ok(scope);
  assert.deepEqual(scope.components, [{ key: DIVAN_KEY, label: "Divan", qty: 1 }]);
  // All entries invalid → components field omitted (= all components),
  // mirroring the dept parser's FULL-ward degradation for tampered rows.
  const scope2 = parseRepairScope(
    JSON.stringify({ preset: "CUSTOM", depts: ["FOAM"], components: [{ qty: 9 }] }),
  );
  assert.ok(scope2);
  assert.equal(scope2.components, undefined);
});

// ===========================================================================
// filterWipsByRepairComponents — the builder's component filter.
// ===========================================================================

const componentWips = () => [
  { wipKey: DIVAN_KEY, wipType: "DIVAN", quantityMultiplier: 2, processes: [] },
  { wipKey: HB_KEY, wipType: "HEADBOARD", quantityMultiplier: 1, processes: [] },
];

test("component filter: scope without components is an identity (same array back)", () => {
  const wips = componentWips();
  const scope = parseRepairScope('{"preset":"CUSTOM","depts":["FOAM"]}');
  const out = filterWipsByRepairComponents(wips, scope);
  assert.equal(out.wips, wips, "no components → input array identity");
  assert.deepEqual(out.stale, []);
  const outNull = filterWipsByRepairComponents(wips, null);
  assert.equal(outNull.wips, wips);
});

test("component filter: keeps ONLY the picked wipKeys", () => {
  const scope = parseRepairScope(
    JSON.stringify({
      preset: "CUSTOM",
      depts: ["FOAM"],
      components: [{ key: HB_KEY, label: "HB", qty: 1 }],
    }),
  );
  const out = filterWipsByRepairComponents(componentWips(), scope);
  assert.deepEqual(out.stale, []);
  assert.equal(out.wips.length, 1);
  assert.equal(out.wips[0].wipKey, HB_KEY);
});

test("component filter: scales quantityMultiplier to min(pickedQty, bomQty) — the planned JC wipQty source", () => {
  const scope = parseRepairScope(
    JSON.stringify({
      preset: "CUSTOM",
      depts: ["FOAM"],
      components: [
        { key: DIVAN_KEY, label: "Divan", qty: 1 }, // 1 of the BOM's 2 pieces
        { key: HB_KEY, label: "HB", qty: 5 },       // over-ask clamps to BOM's 1
      ],
    }),
  );
  const out = filterWipsByRepairComponents(componentWips(), scope);
  assert.deepEqual(out.stale, []);
  const divan = out.wips.find((w) => w.wipKey === DIVAN_KEY);
  const hb = out.wips.find((w) => w.wipKey === HB_KEY);
  assert.equal(divan.quantityMultiplier, 1, "picked 1 of 2 divan pieces");
  assert.equal(hb.quantityMultiplier, 1, "pick can never scale a WIP up");
});

test("component filter: a pick whose key left the BOM is STALE (caller throws — never builds the wrong subset)", () => {
  const scope = parseRepairScope(
    JSON.stringify({
      preset: "CUSTOM",
      depts: ["FOAM"],
      components: [{ key: "BF100::9::DIVAN::gone", label: "Old Divan", qty: 1 }],
    }),
  );
  const out = filterWipsByRepairComponents(componentWips(), scope);
  assert.equal(out.stale.length, 1);
  assert.equal(out.stale[0].label, "Old Divan");
  assert.deepEqual(out.wips, [], "stale result must not hand back buildable wips");
});

test("component filter: stale-check runs against the FULL BOM key set, not the dept-narrowed survivors", () => {
  // The dept filter dropped the DIVAN wip entirely (no FOAM step), but the
  // pick is NOT stale — the key still exists in the full BOM. The scope
  // simply narrows to nothing buildable for that piece, which the builder's
  // existing zero-step guard handles.
  const allBomKeys = [DIVAN_KEY, HB_KEY];
  const survivors = componentWips().filter((w) => w.wipKey === HB_KEY);
  const scope = parseRepairScope(
    JSON.stringify({
      preset: "CUSTOM",
      depts: ["FOAM"],
      components: [{ key: DIVAN_KEY, label: "Divan", qty: 1 }],
    }),
  );
  const out = filterWipsByRepairComponents(survivors, scope, allBomKeys);
  assert.deepEqual(out.stale, [], "key exists in the full BOM → not stale");
  assert.deepEqual(out.wips, [], "picked piece has no surviving processes → nothing to build");
});

// ===========================================================================
// repairComponentScale — the cascade's material gate + qty scale.
// ===========================================================================

test("repairComponentScale: no scope / no components → 1 (byte-identical full consumption)", () => {
  assert.equal(repairComponentScale({ ownerWipKey: DIVAN_KEY, ownerWipQty: 2 }, null), 1);
  const deptOnly = parseRepairScope('{"preset":"CUSTOM","depts":["FOAM"]}');
  assert.equal(repairComponentScale({ ownerWipKey: DIVAN_KEY, ownerWipQty: 2 }, deptOnly), 1);
});

const componentScope = (qty) =>
  parseRepairScope(
    JSON.stringify({
      preset: "CUSTOM",
      depts: ["FOAM"],
      components: [{ key: DIVAN_KEY, label: "Divan", qty }],
    }),
  );

test("repairComponentScale: picked component scales by pickedQty/bomQty", () => {
  assert.equal(
    repairComponentScale({ ownerWipKey: DIVAN_KEY, ownerWipQty: 2 }, componentScope(2)),
    1,
    "full pick consumes the full line",
  );
  assert.equal(
    repairComponentScale({ ownerWipKey: DIVAN_KEY, ownerWipQty: 2 }, componentScope(1)),
    0.5,
    "1 of 2 divan pieces consumes half",
  );
  assert.equal(
    repairComponentScale({ ownerWipKey: DIVAN_KEY, ownerWipQty: 2 }, componentScope(9)),
    1,
    "over-ask clamps to the BOM qty — never over-consume",
  );
});

test("repairComponentScale: unpicked or underivable owner → null (DROP the line)", () => {
  const scope = componentScope(1);
  // Owning component not picked.
  assert.equal(repairComponentScale({ ownerWipKey: HB_KEY, ownerWipQty: 1 }, scope), null);
  // No owner key (legacy bom_versions.tree / flat bom_components fallback).
  assert.equal(repairComponentScale({}, scope), null);
  assert.equal(repairComponentScale({ ownerWipQty: 2 }, scope), null);
});

// ===========================================================================
// canonicalizeComponentPicks — storage canonicalization (shared with FE).
// ===========================================================================

const pickerOptions = [
  { key: DIVAN_KEY, label: '8" Divan- 6FT', qty: 2 },
  { key: HB_KEY, label: "1013(S)-HB", qty: 1 },
];

test("canonicalize: everything ticked at full BOM qty → undefined (field omitted — today's storage byte-identical)", () => {
  assert.equal(
    canonicalizeComponentPicks(pickerOptions, [
      { key: HB_KEY, label: "1013(S)-HB", qty: 1 },
      { key: DIVAN_KEY, label: '8" Divan- 6FT', qty: 2 },
    ]),
    undefined,
  );
  // No options at all (flat/legacy BOM) → also "all".
  assert.equal(canonicalizeComponentPicks([], []), undefined);
});

test("canonicalize: subset / reduced qty → explicit array in BOM order, clamped", () => {
  // Subset keeps the field.
  assert.deepEqual(
    canonicalizeComponentPicks(pickerOptions, [{ key: HB_KEY, label: "1013(S)-HB", qty: 1 }]),
    [{ key: HB_KEY, label: "1013(S)-HB", qty: 1 }],
  );
  // Full set but a reduced qty keeps the field; order follows the BOM.
  assert.deepEqual(
    canonicalizeComponentPicks(pickerOptions, [
      { key: HB_KEY, qty: 1 },
      { key: DIVAN_KEY, qty: 1 },
    ]),
    [
      { key: DIVAN_KEY, label: '8" Divan- 6FT', qty: 1 },
      { key: HB_KEY, label: "1013(S)-HB", qty: 1 },
    ],
  );
  // Over-ask clamps down to the BOM qty.
  assert.deepEqual(
    canonicalizeComponentPicks(pickerOptions, [{ key: DIVAN_KEY, qty: 99 }]),
    [{ key: DIVAN_KEY, label: '8" Divan- 6FT', qty: 2 }],
  );
  // Nothing ticked → [] (kept so the shared validator blocks Save).
  assert.deepEqual(canonicalizeComponentPicks(pickerOptions, []), []);
  // Unknown keys (product/BOM changed under the picker) are dropped.
  assert.deepEqual(
    canonicalizeComponentPicks(pickerOptions, [{ key: "OTHER::0::X::X", qty: 1 }]),
    [],
  );
});

// ===========================================================================
// Shared wipKey derivation — breakBomIntoWips and the cascade walk must use
// THE SAME formula. Behavioural pin: derive keys for a sample BOM both ways.
// ===========================================================================

test("deriveTopLevelWipKey matches breakBomIntoWips' wipKey for every top-level node", () => {
  const bomNodes = [
    {
      wipCode: "{DIVAN_HEIGHT} Divan- {SIZE}",
      wipType: "DIVAN",
      quantity: 2,
      processes: [{ deptCode: "WOOD_CUT", minutes: 10 }],
    },
    {
      wipCode: "{MODEL}({SEAT_SIZE})-HB",
      wipType: "HEADBOARD",
      quantity: 1,
      processes: [{ deptCode: "FAB_CUT", minutes: 5 }],
    },
    // No wipCode → key falls back to the UPPERCASED wipType.
    { wipType: "sofa_armrest", quantity: 2, processes: [{ deptCode: "FOAM", minutes: 3 }] },
  ];
  const wips = breakBomIntoWips(JSON.stringify(bomNodes), "BF100", {
    productCode: "BF100",
    sizeLabel: "6FT",
    divanHeightInches: 8,
  });
  assert.equal(wips.length, 3);
  for (let i = 0; i < bomNodes.length; i++) {
    assert.equal(
      wips[i].wipKey,
      deriveTopLevelWipKey("BF100", i, bomNodes[i]),
      `node ${i} key must match the shared helper`,
    );
  }
  assert.equal(wips[2].wipKey, "BF100::2::SOFA_ARMREST::SOFA_ARMREST");
});

// ===========================================================================
// Round-trip + labels.
// ===========================================================================

test("serialize ∘ parse is stable (canonical fixed point)", () => {
  const canon = '{"preset":"CUSTOM","depts":["WOOD_CUT","FRAMING"]}';
  assert.equal(serializeRepairScope(parseRepairScope(canon)), canon);
  assert.equal(serializeRepairScope(null), null);
});

test("badge labels are operator-readable English", () => {
  assert.equal(repairScopeBadgeLabel(null), "Full remake");
  assert.equal(
    repairScopeBadgeLabel(parseRepairScope('{"preset":"FABRIC"}')),
    "Fabric replacement",
  );
  assert.equal(
    repairScopeBadgeLabel(parseRepairScope('{"preset":"CUSTOM","depts":["FOAM","PACKING"]}')),
    "Custom: Foam + Packing",
  );
  // Component picks append a compact piece summary.
  assert.equal(
    repairScopeBadgeLabel(
      parseRepairScope(
        JSON.stringify({
          preset: "CUSTOM",
          depts: ["WOOD_CUT", "FRAMING"],
          components: [{ key: DIVAN_KEY, label: "Divan", qty: 1 }],
        }),
      ),
    ),
    "Custom: Wood Cutting + Framing · Divan ×1",
  );
});

// ===========================================================================
// Structural pins — each link of the chain exists in the right file.
// ===========================================================================

const builderSrc = readFileSync(
  new URL("../src/api/routes/_shared/production-builder.ts", import.meta.url),
  "utf8",
);
const soSrc =
  readFileSync(
    new URL("../src/api/routes/sales-orders.ts", import.meta.url),
    "utf8",
  ) +
  "\n\n" +
  readFileSync(
    new URL("../src/api/routes/sales-orders/_helpers.ts", import.meta.url),
    "utf8",
  );
const cascadeSrc = readFileSync(
  new URL("../src/api/lib/po-cost-cascade.ts", import.meta.url),
  "utf8",
);
const pipelineSrc = readFileSync(
  new URL("../src/lib/delivery-pipeline.ts", import.meta.url),
  "utf8",
);
const migrationSrc = readFileSync(
  new URL("../migrations-postgres/0160_so_items_repair_scope.sql", import.meta.url),
  "utf8",
);

test("builder: scope filter sits AFTER the Headboard-Only filter and BEFORE the reverse-schedule loop", () => {
  const hbIdx = builderSrc.indexOf('wips.filter((w) => w.wipType.toUpperCase() !== "DIVAN")');
  const scopeIdx = builderSrc.indexOf("filterWipsByRepairScope(wips, repairScope)");
  const schedIdx = builderSrc.indexOf("// ---- Reverse-schedule dept dueDates ----");
  assert.ok(hbIdx > 0, "HB-only filter must exist");
  assert.ok(scopeIdx > hbIdx, "scope filter must come after the HB-only filter");
  assert.ok(schedIdx > scopeIdx, "scope filter must run before the planned/sequence loop");
});

test("builder: L1 processes filtered by the same dept set; zero-step scope throws", () => {
  assert.match(builderSrc, /l1ProcsAll\.filter\(\(p\) =>\s*\(repairScope\.depts as readonly string\[\]\)\.includes\(p\.deptCode\)/);
  assert.match(builderSrc, /matches no production steps for product/);
});

test("builder: production_orders INSERT stamps repairScope + self-applies the column", () => {
  assert.match(
    builderSrc,
    /rackingNumber, stockedIn, repairScope, created_at, updated_at\)/,
    "INSERT column list must include repairScope",
  );
  assert.match(builderSrc, /serializeRepairScope\(repairScope\)/);
  assert.match(
    builderSrc,
    /ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS repairScope TEXT/,
  );
});

test("sales-orders: self-applied ALTERs + INSERTs + dual-key wrapper pass-through", () => {
  assert.match(
    soSrc,
    /ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS repairScope TEXT/,
  );
  assert.equal(
    (soSrc.match(/lineTotalSen, notes, repairScope\)/g) ?? []).length,
    2,
    "POST + PUT item INSERTs must both include repairScope",
  );
  assert.ok(
    (soSrc.match(/repairScope: it\.repairScope \?\? it\.repairscope \?\? null/g) ?? []).length >= 2,
    "cascade item mappings must read the folded-lowercase key dual-key",
  );
  // Both write paths run the shared validator.
  assert.ok(
    (soSrc.match(/validateRepairScopeInput\(rawItems\[i\]\.repairScope\)/g) ?? []).length >= 2,
    "POST and PUT must validate every line's repairScope",
  );
  // Normal sales orders may not carry a scope.
  assert.ok(
    (soSrc.match(/Repair Scope is only available on Service Orders/g) ?? []).length >= 2,
  );
});

test("cascade: material filter runs before consumption, keyed off the PO's stamped scope", () => {
  assert.match(
    cascadeSrc,
    /parseRepairScope\(po\.repairScope \?\? po\.repairscope\)/,
    "scope must be read dual-key off the PO row",
  );
  assert.match(cascadeSrc, /SELECT \* FROM production_orders WHERE id = \?/);
  const filterIdx = cascadeSrc.indexOf("materialLineInScope(line, rm?.itemGroup ?? null, repairScope)");
  const fifoIdx = cascadeSrc.indexOf("fifoConsume(batches, required)");
  assert.ok(filterIdx > 0, "materialLineInScope call must exist");
  assert.ok(fifoIdx > filterIdx, "scope filter must run before fifoConsume");
  // Class lookup source: raw_materials.itemGroup rides on resolveRmFromBom.
  assert.match(cascadeSrc, /SELECT id, itemCode, description, itemGroup FROM raw_materials/);
  // Owning-node depts captured for the CUSTOM branch rule.
  assert.match(cascadeSrc, /ownerDeptCodes/);
});

test("delivery-pipeline: no-UPH fallback is gated on COMPLETED status / scope, not card absence", () => {
  assert.match(pipelineSrc, /function repairScopeExcludesUph\(/);
  // poInPlanning + poInPlanningConsignment (CO mirror, BUG-2026-07-01-005) both
  // gate their no-UPH fallback on the repair scope.
  assert.equal(
    (pipelineSrc.match(/if \(!repairScopeExcludesUph\(po\)\) return false;/g) ?? []).length,
    2,
    "poInPlanning + poInPlanningConsignment must still gate the no-UPH fallback on the scope",
  );
  // poReadyForDelivery's no-UPH fallback (BUG-2026-06-20-001: ACCESSORY
  // pillows have no upholstery card) is gated on the PO's own COMPLETED status
  // OR the repair scope — never on card absence alone, so a half-made
  // (IN_PROGRESS) non-upholstered PO can't slip through.
  assert.match(pipelineSrc, /if \(po\.status === "COMPLETED"\) return allDone;/);
  assert.match(pipelineSrc, /if \(repairScopeExcludesUph\(po\)\) return allDone;/);
  // Zero job cards never qualifies (all four predicates: poInPlanning,
  // poReadyForDelivery, the CO mirror poReadyForConsignment (BUG-2026-07-01-004),
  // and the CO planning mirror poInPlanningConsignment (BUG-2026-07-01-005)).
  assert.equal(
    (pipelineSrc.match(/if \(jcs\.length === 0\) return false;/g) ?? []).length,
    4,
  );
});

test("migration 0160 exists and uses the FOLDED lowercase column name", () => {
  assert.match(
    migrationSrc,
    /ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS repairscope TEXT;/,
  );
  assert.match(
    migrationSrc,
    /ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS repairscope TEXT;/,
  );
  assert.doesNotMatch(
    migrationSrc,
    /ADD COLUMN IF NOT EXISTS repairScope/,
    "migration file must NOT use the camelCase form (runtime ALTER folds to lowercase)",
  );
});

test("builder: first-in-chain flag derives from the FILTERED chain", () => {
  // The planned loop assigns `sequence: i` over `wip.processes` (the
  // filtered chain) and the JC INSERT stamps prerequisiteMet from
  // `p.sequence === 0` — pin both so a refactor can't re-key it off an
  // unfiltered source.
  assert.match(builderSrc, /const isFirstDeptForWip = p\.sequence === 0;/);
  assert.match(builderSrc, /const chain = wip\.processes;/);
});

// ===========================================================================
// Component-level Repair Scope — structural pins.
// ===========================================================================

const breakdownSrc = readFileSync(
  new URL("../src/api/lib/bom-wip-breakdown.ts", import.meta.url),
  "utf8",
);

test("component endpoint: registered before /:id with sales-orders:read RBAC, sharing breakBomIntoWips", () => {
  const routeIdx = soSrc.indexOf('app.get("/repair-components"');
  const idRouteIdx = soSrc.indexOf('app.get("/:id"');
  assert.ok(routeIdx > 0, "GET /repair-components must be registered");
  assert.ok(idRouteIdx > routeIdx, "must be registered BEFORE the /:id catch-all");
  const routeBody = soSrc.slice(routeIdx, soSrc.indexOf("app.get", routeIdx + 10));
  assert.match(routeBody, /requirePermission\(c, "sales-orders", "read"\)/);
  assert.match(
    routeBody,
    /breakBomIntoWips\(bomRow\.wipComponents, productCode, variants\)/,
    "the picker must derive components with the builder's own breakdown",
  );
  // Same ACTIVE-first / any-version-fallback lookup the builder runs.
  assert.match(routeBody, /versionStatus = 'ACTIVE'/);
});

test("shared wipKey derivation: ONE formula, used by the breakdown AND the cascade walk", () => {
  // The formula string literal exists exactly once, inside the helper.
  assert.equal(
    (breakdownSrc.match(/\$\{productCode\}::\$\{idx\}::\$\{wipType\}::\$\{rawTopCode\}/g) ?? []).length,
    1,
    "wipKey format string must live ONLY in deriveTopLevelWipKey",
  );
  assert.match(breakdownSrc, /export function deriveTopLevelWipKey\(/);
  // breakBomIntoWips delegates to the helper.
  assert.match(breakdownSrc, /wipKey: deriveTopLevelWipKey\(productCode, idx, node\)/);
  // The cascade imports the SAME helper and tags each root's subtree.
  assert.match(cascadeSrc, /import \{ deriveTopLevelWipKey \} from "\.\/bom-wip-breakdown"/);
  assert.match(cascadeSrc, /wipKey: deriveTopLevelWipKey\(/);
  assert.doesNotMatch(
    cascadeSrc,
    /::\$\{idx\}::/,
    "the cascade must never re-implement the wipKey format inline",
  );
});

test("builder: component filter runs AFTER the dept filter, stale picks throw, scope stamps with components", () => {
  const deptFilterIdx = builderSrc.indexOf("filterWipsByRepairScope(wips, repairScope)");
  const componentFilterIdx = builderSrc.indexOf("filterWipsByRepairComponents(");
  const schedIdx = builderSrc.indexOf("// ---- Reverse-schedule dept dueDates ----");
  assert.ok(componentFilterIdx > deptFilterIdx, "component filter must come after the dept filter");
  assert.ok(schedIdx > componentFilterIdx, "component filter must run before the planned/sequence loop");
  // Stale-key detection uses the FULL pre-narrowing key set...
  assert.match(builderSrc, /const allBomWipKeys = wips\.map\(\(w\) => w\.wipKey\);/);
  // ...captured before the Headboard-Only filter.
  assert.ok(
    builderSrc.indexOf("const allBomWipKeys") <
      builderSrc.indexOf('wips.filter((w) => w.wipType.toUpperCase() !== "DIVAN")'),
    "full key set must be captured before any narrowing",
  );
  // Stale picks fail the confirm loudly.
  assert.match(builderSrc, /no longer matches the BOM for product/);
  // The stamped scope keeps the components (serializeRepairScope carries
  // them — pinned by the round-trip unit test above).
  assert.match(builderSrc, /serializeRepairScope\(repairScope\)/);
});

test("cascade: component gate + qty scale run BEFORE the FIFO walk; owner tag rides the tree walk", () => {
  const scaleIdx = cascadeSrc.indexOf("repairComponentScale(line, repairScope)");
  const fifoIdx = cascadeSrc.indexOf("fifoConsume(batches, required)");
  assert.ok(scaleIdx > 0, "repairComponentScale call must exist");
  assert.ok(fifoIdx > scaleIdx, "component gate must run before fifoConsume");
  // The scale multiplies into the required qty (shortage report included).
  assert.match(cascadeSrc, /\(1 \+ Math\.max\(0, line\.wastePct \|\| 0\) \/ 100\) \*\s*componentScale/);
  // Out-of-scope / underivable lines drop before any consumption.
  assert.match(cascadeSrc, /if \(componentScale === null\) continue;/);
  // collectTreeMaterials threads the owner tag through recursion.
  assert.match(cascadeSrc, /collectTreeMaterials\(child, out, dims, owner\)/);
  assert.match(cascadeSrc, /ownerWipKey: owner\?\.wipKey/);
  assert.match(cascadeSrc, /ownerWipQty: owner\?\.wipQty/);
});
