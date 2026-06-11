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
  materialClassForItemGroup,
  materialLineInScope,
  repairScopeBadgeLabel,
} from "../src/lib/repair-scope.ts";
import { DEPT_ORDER } from "../src/api/lib/lead-times.ts";

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
});

// ===========================================================================
// Structural pins — each link of the chain exists in the right file.
// ===========================================================================

const builderSrc = readFileSync(
  new URL("../src/api/routes/_shared/production-builder.ts", import.meta.url),
  "utf8",
);
const soSrc = readFileSync(
  new URL("../src/api/routes/sales-orders.ts", import.meta.url),
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

test("delivery-pipeline: no-UPH fallback exists and is keyed on the scope, not card absence", () => {
  assert.match(pipelineSrc, /function repairScopeExcludesUph\(/);
  assert.equal(
    (pipelineSrc.match(/if \(!repairScopeExcludesUph\(po\)\) return false;/g) ?? []).length,
    2,
    "both poInPlanning and poReadyForDelivery must gate the fallback on the scope",
  );
  // Zero job cards never qualifies.
  assert.equal(
    (pipelineSrc.match(/if \(jcs\.length === 0\) return false;/g) ?? []).length,
    2,
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
