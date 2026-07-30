// ---------------------------------------------------------------------------
// bom-explosion.test.mjs — unit tests for the BOM → WIP explosion logic in
// `src/api/lib/bom-wip-breakdown.ts` (breakBomIntoWips + resolveWipTokens).
//
// This is high-blast-radius logic: breakBomIntoWips parses a bom_templates
// `wipComponents` JSON tree into the flat WIP list that the production-order
// builder turns into job_cards. Every product becomes work-in-progress through
// this function. The BOM module is rarely opened, so these tests are the only
// safety net against a quiet regression in the explosion math, token
// resolution, fallback chains, or wipKey stability.
//
// Tested intent (from the source-file comments):
//   - resolveWipTokens: substitute {DIVAN_HEIGHT}/{SIZE}/{FABRIC}/
//     {PRODUCT_CODE}/{TOTAL_HEIGHT}/{MODEL}/{SEAT_SIZE}; collapse whitespace;
//     {MODEL} ≠ {PRODUCT_CODE}; missing tokens → empty.
//   - breakBomIntoWips: one WipBreakdownItem per TOP-LEVEL node; processes
//     collected from the whole subtree keyed by deptCode; minutes summed;
//     quantity → quantityMultiplier (defaults to 1); empty/invalid BOM → a
//     single synthesized FG_MAIN WIP; zero-process WIP → per-wipType default
//     chain; wipKey uses the UNRESOLVED rawTopCode so it stays stable across
//     fabric/size variants.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it on Node 22+.
}

let bom;
try {
  bom = await import(
    pathToFileURL(
      resolve(process.cwd(), "src/api/lib/bom-wip-breakdown.ts"),
    ).href
  );
} catch (err) {
  console.warn(
    "[bom-explosion.test] Could not import bom-wip-breakdown module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[bom-explosion.test] Error:", err?.message ?? err);
  throw err;
}

const { breakBomIntoWips, resolveWipTokens } = bom;

// ===========================================================================
// resolveWipTokens — `{TOKEN}` substitution against a variant context.
// ===========================================================================

test("resolveWipTokens: template with no braces is returned unchanged", () => {
  // Fast-path: if there is no "{" the function short-circuits.
  assert.equal(resolveWipTokens("Plain Base", {}), "Plain Base");
});

test("resolveWipTokens: empty / null template returns as-is", () => {
  assert.equal(resolveWipTokens("", {}), "");
  // null/undefined template — guarded by the `!template` check.
  assert.equal(resolveWipTokens(null, {}), null);
  assert.equal(resolveWipTokens(undefined, {}), undefined);
});

test("resolveWipTokens: {SIZE} resolves from sizeLabel", () => {
  assert.equal(
    resolveWipTokens("Frame {SIZE}", { sizeLabel: "6FT" }),
    "Frame 6FT",
  );
});

test("resolveWipTokens: {SIZE} falls back to sizeCode when sizeLabel absent", () => {
  // size = ctx.sizeLabel || ctx.sizeCode || ""
  assert.equal(
    resolveWipTokens("Frame {SIZE}", { sizeCode: "Q" }),
    "Frame Q",
  );
});

test("resolveWipTokens: {FABRIC} and {PRODUCT_CODE} resolve", () => {
  assert.equal(
    resolveWipTokens("{PRODUCT_CODE} {FABRIC}", {
      productCode: "5531-1A(LHF)",
      fabricCode: "M2402-4",
    }),
    "5531-1A(LHF) M2402-4",
  );
});

test("resolveWipTokens: {DIVAN_HEIGHT} renders with inch mark when > 0", () => {
  assert.equal(
    resolveWipTokens("{DIVAN_HEIGHT} Divan", { divanHeightInches: 8 }),
    '8" Divan',
  );
});

test("resolveWipTokens: {DIVAN_HEIGHT} of 0 substitutes empty (no bare inch mark)", () => {
  // divanHeightInches must be > 0 to render — a 0 collapses out and the
  // surrounding whitespace is squeezed.
  assert.equal(
    resolveWipTokens("{DIVAN_HEIGHT} Divan", { divanHeightInches: 0 }),
    "Divan",
  );
});

test("resolveWipTokens: missing {DIVAN_HEIGHT} substitutes empty", () => {
  assert.equal(
    resolveWipTokens("{DIVAN_HEIGHT} Divan", {}),
    "Divan",
  );
});

test("resolveWipTokens: {TOTAL_HEIGHT} = gap + divan + leg, with inch mark", () => {
  // totalH = gap + divan + leg; 2 + 8 + 3 = 13 → "13\"".
  assert.equal(
    resolveWipTokens("Bed {TOTAL_HEIGHT}", {
      gapInches: 2,
      divanHeightInches: 8,
      legHeightInches: 3,
    }),
    'Bed 13"',
  );
});

test("resolveWipTokens: {TOTAL_HEIGHT} of 0 substitutes empty", () => {
  // No height components → totalH 0 → empty, whitespace collapsed.
  assert.equal(resolveWipTokens("Bed {TOTAL_HEIGHT}", {}), "Bed");
});

test("resolveWipTokens: {MODEL} uses model when supplied (NOT productCode)", () => {
  // BUG-2026-04-27-004: {MODEL} is the shared parent SKU; a cushion shared
  // across variants must render the model, not the variant suffix.
  assert.equal(
    resolveWipTokens("{MODEL} -Back Cushion", {
      model: "5531",
      productCode: "5531-L(RHF)",
    }),
    "5531 -Back Cushion",
  );
});

test("resolveWipTokens: {MODEL} falls back to productCode when model is null", () => {
  // Legacy behaviour: caller didn't supply a model → fall back to productCode.
  assert.equal(
    resolveWipTokens("{MODEL} -Back Cushion", {
      productCode: "5531-L(RHF)",
    }),
    "5531-L(RHF) -Back Cushion",
  );
});

test("resolveWipTokens: {SEAT_SIZE} resolves from sizeCode", () => {
  assert.equal(
    resolveWipTokens("Cushion {SEAT_SIZE}", { sizeCode: "3S" }),
    "Cushion 3S",
  );
});

test("resolveWipTokens: unknown token substitutes empty and whitespace collapses", () => {
  // Any token with no value substitutes empty, then `\s+` is collapsed so
  // gaps don't leave double spaces or trailing dashes.
  assert.equal(
    resolveWipTokens("{SIZE}   {FABRIC}", {}),
    "",
  );
  assert.equal(
    resolveWipTokens("A {SIZE} B", {}),
    "A B",
  );
});

test("resolveWipTokens: null variant context treated as empty", () => {
  // ctx = v ?? {} — a null context must not throw.
  assert.equal(resolveWipTokens("Frame {SIZE}", null), "Frame");
});

test("resolveWipTokens: result is trimmed", () => {
  // trailing/leading whitespace from collapsed tokens is trimmed.
  assert.equal(resolveWipTokens(" {SIZE} Frame ", { sizeLabel: "Q" }), "Q Frame");
});

// ===========================================================================
// breakBomIntoWips — empty / invalid BOM fallbacks.
// ===========================================================================

test("breakBomIntoWips: null wipComponents → single FG_MAIN fallback WIP", () => {
  const wips = breakBomIntoWips(null, "5531-1A(LHF)");
  assert.equal(wips.length, 1);
  const fg = wips[0];
  assert.equal(fg.wipType, "FG_MAIN");
  assert.equal(fg.wipCode, "FG_MAIN");
  assert.equal(fg.wipLabel, "5531-1A(LHF) (main)");
  assert.equal(fg.wipKey, "5531-1A(LHF)::FG_MAIN");
  assert.equal(fg.quantityMultiplier, 1);
  // Fallback FG WIP walks the full DEPT_ORDER (9 depts incl. FOAM_CUTTING).
  assert.equal(fg.processes.length, 9);
});

test("breakBomIntoWips: empty-string wipComponents → FG_MAIN fallback", () => {
  const wips = breakBomIntoWips("", "PROD-X");
  assert.equal(wips.length, 1);
  assert.equal(wips[0].wipType, "FG_MAIN");
});

test("breakBomIntoWips: malformed JSON → FG_MAIN fallback (no throw)", () => {
  // A JSON.parse failure must be swallowed and fall back, never throw.
  const wips = breakBomIntoWips("{not valid json", "PROD-Y");
  assert.equal(wips.length, 1);
  assert.equal(wips[0].wipType, "FG_MAIN");
});

test("breakBomIntoWips: empty JSON array → FG_MAIN fallback", () => {
  const wips = breakBomIntoWips("[]", "PROD-Z");
  assert.equal(wips.length, 1);
  assert.equal(wips[0].wipType, "FG_MAIN");
});

test("breakBomIntoWips: non-array JSON (object) → FG_MAIN fallback", () => {
  const wips = breakBomIntoWips('{"wipType":"DIVAN"}', "PROD-OBJ");
  assert.equal(wips.length, 1);
  assert.equal(wips[0].wipType, "FG_MAIN");
});

// ===========================================================================
// breakBomIntoWips — normal explosion: one item per top-level node.
// ===========================================================================

test("breakBomIntoWips: a 2-node BOM explodes into 2 WIP items", () => {
  // The classic Bedframe shape — Headboard + Divan as two top-level WIPs.
  const raw = JSON.stringify([
    {
      wipCode: "HB",
      wipType: "HEADBOARD",
      quantity: 1,
      processes: [{ deptCode: "FAB_CUT", category: "cut", minutes: 30 }],
    },
    {
      wipCode: "DV",
      wipType: "DIVAN",
      quantity: 1,
      processes: [{ deptCode: "WOOD_CUT", category: "cut", minutes: 40 }],
    },
  ]);
  const wips = breakBomIntoWips(raw, "1013-(S)");
  assert.equal(wips.length, 2);
  assert.equal(wips[0].wipType, "HEADBOARD");
  assert.equal(wips[1].wipType, "DIVAN");
});

test("breakBomIntoWips: top-level node's processes are collected", () => {
  const raw = JSON.stringify([
    {
      wipCode: "Base",
      wipType: "SOFA_BASE",
      processes: [
        { deptCode: "WOOD_CUT", category: "cut", minutes: 25 },
        { deptCode: "UPHOLSTERY", category: "uph", minutes: 60 },
      ],
    },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  assert.equal(wips.length, 1);
  const procs = wips[0].processes;
  // Two depts touched.
  assert.equal(procs.length, 2);
  const byDept = Object.fromEntries(procs.map((p) => [p.deptCode, p]));
  assert.equal(byDept.WOOD_CUT.minutes, 25);
  assert.equal(byDept.UPHOLSTERY.minutes, 60);
});

test("breakBomIntoWips: child subtree processes roll up into the top-level WIP", () => {
  // For each TOP-LEVEL wip the function collects ALL processes from the whole
  // subtree (node + descendants) keyed by deptCode.
  const raw = JSON.stringify([
    {
      wipCode: "HB",
      wipType: "HEADBOARD",
      processes: [{ deptCode: "UPHOLSTERY", category: "uph", minutes: 50 }],
      children: [
        {
          wipCode: "HB Foam",
          processes: [{ deptCode: "FOAM", category: "foam", minutes: 20 }],
          children: [
            {
              wipCode: "HB Fab",
              processes: [
                { deptCode: "FAB_CUT", category: "cut", minutes: 15 },
              ],
            },
          ],
        },
      ],
    },
  ]);
  const wips = breakBomIntoWips(raw, "1013-(S)");
  assert.equal(wips.length, 1);
  const depts = wips[0].processes.map((p) => p.deptCode).sort();
  // FAB_CUT (depth 2) + FOAM (depth 1) + UPHOLSTERY (depth 0) all roll up.
  assert.deepEqual(depts, ["FAB_CUT", "FOAM", "UPHOLSTERY"]);
});

test("breakBomIntoWips: same dept appearing in node + child has minutes summed", () => {
  // collectProcesses: `existing.minutes += minutes` when a dept repeats.
  const raw = JSON.stringify([
    {
      wipCode: "Base",
      wipType: "SOFA_BASE",
      processes: [{ deptCode: "FOAM", category: "foam", minutes: 10 }],
      children: [
        {
          wipCode: "Sub",
          processes: [{ deptCode: "FOAM", category: "foam", minutes: 35 }],
        },
      ],
    },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  const foam = wips[0].processes.find((p) => p.deptCode === "FOAM");
  assert.equal(foam.minutes, 45, "FOAM minutes 10 + 35 should sum to 45");
});

// SUSPECTED BUG — see report. The source comment at collectProcesses
// (bom-wip-breakdown.ts:185-188) claims "Prefer the DEEPER node's code (first
// write wins via the subtree traversal order: we recurse depth-first, so by
// the time the top-level node's own processes would overwrite, the deeper
// entry is already set and we leave it alone)". That is NOT what the code
// does: collectProcesses processes a node's OWN `processes` (lines 174-200)
// BEFORE recursing into `children` (lines 201-208). So when a dept appears on
// BOTH the top-level node and a child, the TOP-LEVEL node writes the map
// entry first and the deeper child only adds minutes — the deeper, more
// specific wipCode ("8\" Divan- 6FT Frame") is lost and the top-level code
// ("8\" Divan- 6FT") is kept. This contradicts the file header (lines 13-15)
// which is the entire reason wipCode-per-node is tracked: the job_card should
// display "Frame", not the bare top-level code. Skipped so it does not
// enshrine the bug. Minutes-summing IS correct; only the wipCode pick is wrong.
test.skip("breakBomIntoWips: deeper node owns the dept's wipCode (first-write-wins, depth-first)", () => {
  const raw = JSON.stringify([
    {
      wipCode: "8 Divan- 6FT",
      wipType: "DIVAN",
      processes: [{ deptCode: "FRAMING", category: "frame", minutes: 5 }],
      children: [
        {
          wipCode: "8 Divan- 6FT Frame",
          processes: [{ deptCode: "FRAMING", category: "frame", minutes: 40 }],
        },
      ],
    },
  ]);
  const wips = breakBomIntoWips(raw, "1013-(S)");
  const framing = wips[0].processes.find((p) => p.deptCode === "FRAMING");
  // INTENDED: wipCode comes from the deeper "Frame" node.
  assert.equal(framing.wipCode, "8 Divan- 6FT Frame");
  // ...and minutes still summed across both.
  assert.equal(framing.minutes, 45);
});

test("breakBomIntoWips: a dept ONLY on a child node correctly takes the child's wipCode", () => {
  // The common, working case: when a dept lives solely on a descendant node
  // (not also on the top-level node), the deeper, more specific wipCode IS
  // used — there is no top-level entry to win the first write. This is what
  // the file header (lines 13-15) is designed for. Distinct from the skipped
  // test above, which is the dept-on-both-levels collision the code gets wrong.
  const raw = JSON.stringify([
    {
      wipCode: "8 Divan- 6FT",
      wipType: "DIVAN",
      processes: [{ deptCode: "PACKING", category: "pack", minutes: 5 }],
      children: [
        {
          wipCode: "8 Divan- 6FT Frame",
          processes: [{ deptCode: "FRAMING", category: "frame", minutes: 40 }],
        },
      ],
    },
  ]);
  const wips = breakBomIntoWips(raw, "1013-(S)");
  const framing = wips[0].processes.find((p) => p.deptCode === "FRAMING");
  assert.equal(framing.wipCode, "8 Divan- 6FT Frame");
  assert.equal(framing.minutes, 40);
});

test("breakBomIntoWips: processes for depts NOT in DEPT_ORDER are ignored", () => {
  // collectProcesses filters: `if (!DEPT_ORDER.includes(dc)) continue`.
  const raw = JSON.stringify([
    {
      wipCode: "Base",
      wipType: "SOFA_BASE",
      processes: [
        { deptCode: "WOOD_CUT", category: "cut", minutes: 25 },
        { deptCode: "NOT_A_DEPT", category: "x", minutes: 999 },
      ],
    },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  const depts = wips[0].processes.map((p) => p.deptCode);
  assert.deepEqual(depts, ["WOOD_CUT"]);
});

test("breakBomIntoWips: deptCode is upper-cased before matching", () => {
  // `const dc = String(p.deptCode).toUpperCase()` — lower-case BOM data works.
  const raw = JSON.stringify([
    {
      wipCode: "Base",
      wipType: "SOFA_BASE",
      processes: [{ deptCode: "wood_cut", category: "cut", minutes: 12 }],
    },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  const wc = wips[0].processes.find((p) => p.deptCode === "WOOD_CUT");
  assert.ok(wc, "lower-case deptCode should resolve to WOOD_CUT");
  assert.equal(wc.minutes, 12);
});

// ===========================================================================
// breakBomIntoWips — quantity multiplier.
// ===========================================================================

test("breakBomIntoWips: node quantity becomes quantityMultiplier", () => {
  const raw = JSON.stringify([
    {
      wipCode: "DV",
      wipType: "DIVAN",
      quantity: 2,
      processes: [{ deptCode: "WOOD_CUT", category: "cut", minutes: 10 }],
    },
  ]);
  const wips = breakBomIntoWips(raw, "1013-(S)");
  assert.equal(wips[0].quantityMultiplier, 2);
});

test("breakBomIntoWips: missing quantity defaults multiplier to 1", () => {
  const raw = JSON.stringify([
    {
      wipCode: "Base",
      wipType: "SOFA_BASE",
      processes: [{ deptCode: "WOOD_CUT", category: "cut", minutes: 10 }],
    },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  assert.equal(wips[0].quantityMultiplier, 1);
});

test("breakBomIntoWips: zero / negative quantity falls back to multiplier 1", () => {
  // `Number(node.quantity) > 0 ? Number(node.quantity) : 1` — a 0 or negative
  // BOM quantity must not zero out the WIP (that would emit no work).
  const rawZero = JSON.stringify([
    { wipCode: "A", wipType: "DIVAN", quantity: 0, processes: [] },
  ]);
  assert.equal(breakBomIntoWips(rawZero, "P")[0].quantityMultiplier, 1);

  const rawNeg = JSON.stringify([
    { wipCode: "A", wipType: "DIVAN", quantity: -3, processes: [] },
  ]);
  assert.equal(breakBomIntoWips(rawNeg, "P")[0].quantityMultiplier, 1);
});

// ===========================================================================
// breakBomIntoWips — zero-process WIP → per-wipType default chain.
// ===========================================================================

test("breakBomIntoWips: WIP with no processes falls back to wipType default chain", () => {
  // DEFAULT_WIP_DEPT_CHAINS.DIVAN = WOOD_CUT,FOAM,FRAMING,WEBBING,UPH,PACKING.
  const raw = JSON.stringify([
    { wipCode: "DV", wipType: "DIVAN", quantity: 1, processes: [] },
  ]);
  const wips = breakBomIntoWips(raw, "1013-(S)");
  const depts = wips[0].processes.map((p) => p.deptCode);
  assert.deepEqual(depts, [
    "WOOD_CUT",
    "FOAM_CUTTING",
    "FOAM",
    "FRAMING",
    "WEBBING",
    "UPHOLSTERY",
    "PACKING",
  ]);
  // Fallback-chain processes carry zero minutes (no BOM data to draw from).
  assert.ok(wips[0].processes.every((p) => p.minutes === 0));
});

test("breakBomIntoWips: zero-process WIP of unknown wipType falls back to full DEPT_ORDER", () => {
  // fallbackChainForType: `DEFAULT_WIP_DEPT_CHAINS[wipType] ?? DEPT_ORDER`.
  const raw = JSON.stringify([
    { wipCode: "X", wipType: "MYSTERY", quantity: 1, processes: [] },
  ]);
  const wips = breakBomIntoWips(raw, "P");
  assert.equal(wips[0].processes.length, 9); // full DEPT_ORDER (incl. FOAM_CUTTING)
});

test("breakBomIntoWips: SOFA_CUSHION default chain matches DEFAULT_WIP_DEPT_CHAINS", () => {
  const raw = JSON.stringify([
    { wipCode: "Cushion", wipType: "SOFA_CUSHION", processes: [] },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  assert.deepEqual(
    wips[0].processes.map((p) => p.deptCode),
    ["FAB_CUT", "FAB_SEW", "FOAM_CUTTING", "FOAM", "UPHOLSTERY", "PACKING"],
  );
});

// ===========================================================================
// breakBomIntoWips — process ordering per wipType.
// ===========================================================================

test("breakBomIntoWips: SOFA_BASE processes ordered FOAM-after-WEBBING per BOM chain", () => {
  // PRODUCTION_ORDER_BY_WIP_TYPE.SOFA_BASE: ...WEBBING, FOAM... — the comment
  // explains sofa FOAM is downstream of WEBBING (opposite of flat DEPT_ORDER).
  // Feed the processes deliberately out of order; they must come back sorted.
  const raw = JSON.stringify([
    {
      wipCode: "Base",
      wipType: "SOFA_BASE",
      processes: [
        { deptCode: "FOAM", category: "foam", minutes: 1 },
        { deptCode: "WEBBING", category: "web", minutes: 1 },
        { deptCode: "WOOD_CUT", category: "cut", minutes: 1 },
      ],
    },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  const order = wips[0].processes.map((p) => p.deptCode);
  // WOOD_CUT before WEBBING before FOAM.
  assert.deepEqual(order, ["WOOD_CUT", "WEBBING", "FOAM"]);
});

test("breakBomIntoWips: HEADBOARD keeps FOAM near the front (before WOOD_CUT)", () => {
  // PRODUCTION_ORDER_BY_WIP_TYPE.HEADBOARD: FAB_CUT,FAB_SEW,FOAM,WOOD_CUT...
  // BF Headboard FOAM is in the fabric branch, upstream of the webbing branch.
  const raw = JSON.stringify([
    {
      wipCode: "HB",
      wipType: "HEADBOARD",
      processes: [
        { deptCode: "WOOD_CUT", category: "cut", minutes: 1 },
        { deptCode: "FOAM", category: "foam", minutes: 1 },
      ],
    },
  ]);
  const wips = breakBomIntoWips(raw, "1013-(S)");
  const order = wips[0].processes.map((p) => p.deptCode);
  assert.deepEqual(order, ["FOAM", "WOOD_CUT"]);
});

// ===========================================================================
// breakBomIntoWips — wipKey stability + uniqueness.
// ===========================================================================

test("breakBomIntoWips: wipKey embeds productCode, index, wipType, raw code", () => {
  const raw = JSON.stringify([
    { wipCode: "Base", wipType: "SOFA_BASE", processes: [] },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  assert.equal(wips[0].wipKey, "5531-1A(LHF)::0::SOFA_BASE::Base");
});

test("breakBomIntoWips: wipKey is stable across fabric/size variants (uses raw template)", () => {
  // The comment: "We use the UNRESOLVED rawTopCode so the key stays stable
  // across SO lines with different fabric/height variants." Two explosions
  // of the same BOM with different variant contexts must yield the same key.
  const raw = JSON.stringify([
    { wipCode: "Frame {SIZE} {FABRIC}", wipType: "DIVAN", processes: [] },
  ]);
  const a = breakBomIntoWips(raw, "1013-(S)", {
    sizeLabel: "6FT",
    fabricCode: "M2402-4",
  });
  const b = breakBomIntoWips(raw, "1013-(S)", {
    sizeLabel: "5FT",
    fabricCode: "PC151-18",
  });
  assert.equal(a[0].wipKey, b[0].wipKey, "wipKey must not vary with variant");
  // ...but the resolved wipCode SHOULD differ between the two.
  assert.notEqual(a[0].wipCode, b[0].wipCode);
});

test("breakBomIntoWips: two top-level WIPs sharing a wipCode still get unique wipKeys", () => {
  // wipKey prefixes the index to guarantee uniqueness — e.g. sofa left-arm +
  // right-arm both coded "Armrest" must not collide.
  const raw = JSON.stringify([
    { wipCode: "Armrest", wipType: "SOFA_ARMREST", processes: [] },
    { wipCode: "Armrest", wipType: "SOFA_ARMREST", processes: [] },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  assert.equal(wips.length, 2);
  assert.notEqual(wips[0].wipKey, wips[1].wipKey);
  assert.match(wips[0].wipKey, /::0::/);
  assert.match(wips[1].wipKey, /::1::/);
});

// ===========================================================================
// breakBomIntoWips — token resolution flows through to wipCode/wipLabel.
// ===========================================================================

test("breakBomIntoWips: top-level wipCode/wipLabel are token-resolved", () => {
  const raw = JSON.stringify([
    {
      wipCode: "{MODEL} -Base {SIZE}",
      wipLabel: "{MODEL} -Base {SIZE} ({FABRIC})",
      wipType: "SOFA_BASE",
      processes: [],
    },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)", {
    model: "5531",
    sizeLabel: "28",
    fabricCode: "M2402-4",
  });
  assert.equal(wips[0].wipCode, "5531 -Base 28");
  assert.equal(wips[0].wipLabel, "5531 -Base 28 (M2402-4)");
});

test("breakBomIntoWips: wipLabel defaults to wipCode when label absent", () => {
  const raw = JSON.stringify([
    { wipCode: "Base 28", wipType: "SOFA_BASE", processes: [] },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  assert.equal(wips[0].wipLabel, "Base 28");
});

test("breakBomIntoWips: missing wipType on a node defaults to FG_MAIN", () => {
  // `String(node.wipType || "FG_MAIN").toUpperCase()`.
  const raw = JSON.stringify([
    { wipCode: "Whole Unit", processes: [] },
  ]);
  const wips = breakBomIntoWips(raw, "P");
  assert.equal(wips[0].wipType, "FG_MAIN");
});

test("breakBomIntoWips: non-object entries in the array are skipped", () => {
  // `if (!node || typeof node !== "object") continue` — junk entries dropped.
  const raw = JSON.stringify([
    null,
    "garbage",
    { wipCode: "Base", wipType: "SOFA_BASE", processes: [] },
  ]);
  const wips = breakBomIntoWips(raw, "5531-1A(LHF)");
  assert.equal(wips.length, 1, "only the real node should survive");
  assert.equal(wips[0].wipType, "SOFA_BASE");
});

test("breakBomIntoWips: an array of only junk entries → FG_MAIN fallback", () => {
  // After filtering, wips.length === 0 → the final fallback fires.
  const raw = JSON.stringify([null, "x", 42]);
  const wips = breakBomIntoWips(raw, "P");
  assert.equal(wips.length, 1);
  assert.equal(wips[0].wipType, "FG_MAIN");
});
