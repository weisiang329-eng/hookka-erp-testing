// ---------------------------------------------------------------------------
// print-extras-shared.test.mjs — pin the BOM-pieces + per-component-racking
// helpers shared by the DO and CN /print-extras endpoints (CN/DO FE parity
// P3, 2026-06-12).
//
// These three pure functions (src/api/lib/print-extras-shared.ts) are the
// reason the CN PDF can print the SAME "1 HB + 2 DIVAN" pieces breakdown and
// per-component rack manifest the DO PDF does WITHOUT a second copy of the
// logic. The tests lock:
//   1. piecesFor — bedframe HB/DIVAN composition + PACKING filter + HB-only
//      special; sofa variants count as one labelled set.
//   2. deriveComponentRacks — distinct racks grouped by component (HB first,
//      DIVAN numeric-sorted), packedDate gated on every shipping card done,
//      HB-only special drops stranded DIVAN cards.
//   3. selectBestBomByCode — ACTIVE preferred, then latest effectiveFrom.
// Plus a source-level pin that BOTH routes import from the shared module
// (shared, not duplicated) — the whole point of the extraction.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  piecesFor,
  buildRepairNote,
  deriveComponentRacks,
  selectBestBomByCode,
} from "../src/api/lib/print-extras-shared.ts";
import { breakBomIntoWips } from "../src/api/lib/bom-wip-breakdown.ts";

// A minimal King-bedframe BOM: one HEADBOARD node + one DIVAN node, both with
// a PACKING process so they survive the "what reaches packing ships" filter.
// qty 2 on the DIVAN node so a King breaks into 1 HB + 2 DIVAN.
const KING_BF_BOM = JSON.stringify([
  {
    wipType: "HEADBOARD",
    wipCode: "HB",
    wipLabel: "Headboard",
    quantity: 1,
    processes: [{ deptCode: "PACKING", category: "PACKING", minutes: 5 }],
    children: [],
  },
  {
    wipType: "DIVAN",
    wipCode: "DIVAN",
    wipLabel: "Divan",
    quantity: 2,
    processes: [{ deptCode: "PACKING", category: "PACKING", minutes: 5 }],
    children: [],
  },
]);

test("piecesFor: King bedframe BOM → '1 HB + 2 DIVAN' (HB first)", () => {
  const out = piecesFor({
    code: "TRION-K",
    baseModel: "TRION",
    wipComponents: KING_BF_BOM,
    cat: "BEDFRAME",
    special: null,
    sizeLabel: "6FT",
    fabricCode: "PC151-02",
    gapInches: 2,
    divanHeightInches: 12,
    legHeightInches: 2,
    qty: 1,
  });
  assert.equal(out, "1 HB + 2 DIVAN");
});

test("piecesFor: HB-only BEDFRAME special drops the DIVAN pieces", () => {
  const out = piecesFor({
    code: "TRION-K",
    baseModel: "TRION",
    wipComponents: KING_BF_BOM,
    cat: "BEDFRAME",
    special: "Headboard Only",
    sizeLabel: "6FT",
    fabricCode: "PC151-02",
    gapInches: null,
    divanHeightInches: null,
    legHeightInches: null,
    qty: 1,
  });
  assert.equal(out, "1 HB");
});

test("piecesFor: a sofa variant is ONE labelled set, not WIP pieces", () => {
  // A sofa "1A(LHF)" must NOT be broken into Base/Cushion/Arm — it ships as a
  // single FG set, labelled by the product-code variant after the dash.
  const out = piecesFor({
    code: "BO315-1A(LHF)",
    baseModel: "BO315",
    wipComponents: KING_BF_BOM, // irrelevant: non-bedframe path ignores BOM
    cat: "SOFA",
    special: null,
    sizeLabel: "35",
    fabricCode: "FAB-1",
    gapInches: null,
    divanHeightInches: null,
    legHeightInches: null,
    qty: 2,
  });
  assert.equal(out, "2 1A(LHF)");
});

// --- Partial-repair component filter (DO compartment-aware print) ----------
// Derive the REAL wipKeys from the same breakdown the filter matches on, so
// the test pins behaviour without hard-coding the key format.
const BF_VARIANTS = {
  productCode: "TRION-K",
  model: "TRION",
  sizeLabel: "6FT",
  sizeCode: "",
  fabricCode: "PC151-02",
  divanHeightInches: 12,
  legHeightInches: 2,
  gapInches: 2,
};
const bfWips = breakBomIntoWips(KING_BF_BOM, "TRION-K", BF_VARIANTS);
const HB_KEY = bfWips.find((w) => w.wipType.toUpperCase() === "HEADBOARD").wipKey;
const DIVAN_KEY = bfWips.find((w) => w.wipType.toUpperCase() === "DIVAN").wipKey;
const baseArgs = {
  code: "TRION-K",
  baseModel: "TRION",
  wipComponents: KING_BF_BOM,
  cat: "BEDFRAME",
  special: null,
  sizeLabel: "6FT",
  fabricCode: "PC151-02",
  gapInches: 2,
  divanHeightInches: 12,
  legHeightInches: 2,
  qty: 1,
};

test("piecesFor: partial repair (HB only) narrows '1 HB + 2 DIVAN' → '1 HB'", () => {
  const out = piecesFor({
    ...baseArgs,
    repairScope: {
      preset: "CUSTOM",
      depts: ["UPHOLSTERY"],
      components: [{ key: HB_KEY, label: "Headboard", qty: 1 }],
    },
  });
  assert.equal(out, "1 HB");
});

test("piecesFor: partial repair clamps a reduced qty (1 of 2 DIVAN) → '1 DIVAN'", () => {
  const out = piecesFor({
    ...baseArgs,
    repairScope: {
      preset: "CUSTOM",
      depts: ["UPHOLSTERY"],
      components: [{ key: DIVAN_KEY, label: "Divan", qty: 1 }],
    },
  });
  assert.equal(out, "1 DIVAN");
});

test("piecesFor: no repairScope → full set unchanged", () => {
  assert.equal(piecesFor({ ...baseArgs }), "1 HB + 2 DIVAN");
  assert.equal(
    piecesFor({ ...baseArgs, repairScope: null }),
    "1 HB + 2 DIVAN",
  );
});

test("piecesFor: a STALE component pick never blanks the line — falls back to full", () => {
  // BOM changed since the operator picked: the key no longer exists. For a
  // delivery note we must still print something, so it falls back to the full
  // set rather than an empty line.
  const out = piecesFor({
    ...baseArgs,
    repairScope: {
      preset: "CUSTOM",
      depts: ["UPHOLSTERY"],
      components: [{ key: "TRION-K::9::GONE::GONE", label: "Gone", qty: 1 }],
    },
  });
  assert.equal(out, "1 HB + 2 DIVAN");
});

test("buildRepairNote: strips counts, dedupes, English 'Repair: X only'", () => {
  assert.equal(buildRepairNote("1 HB"), "Repair: HB only");
  assert.equal(buildRepairNote("1 HB + 1 DIVAN"), "Repair: HB + DIVAN only");
  assert.equal(buildRepairNote("2 DIVAN"), "Repair: DIVAN only");
  assert.equal(buildRepairNote(null), null);
  assert.equal(buildRepairNote(""), null);
});

test("deriveComponentRacks: groups distinct racks, HB first then DIVAN numeric", () => {
  const jcs = [
    {
      productionOrderId: "po-1",
      wipType: "DIVAN",
      wipLabel: "Divan",
      rackingNumber: "Rack 20",
      completedDate: "2026-06-01",
      status: "COMPLETED",
    },
    {
      productionOrderId: "po-1",
      wipType: "HEADBOARD",
      wipLabel: "Headboard",
      rackingNumber: "Rack 3",
      completedDate: "2026-06-02",
      status: "COMPLETED",
    },
    {
      productionOrderId: "po-1",
      wipType: "DIVAN",
      wipLabel: "Divan",
      rackingNumber: "Rack 3",
      completedDate: "2026-06-01",
      status: "COMPLETED",
    },
  ];
  const { packedDate, componentRacks } = deriveComponentRacks(jcs, "BEDFRAME", null);
  // HB group before DIVAN group; DIVAN racks numeric-sorted (3 before 20).
  assert.deepEqual(componentRacks, [
    { label: "HB", racks: ["Rack 3"] },
    { label: "DIVAN", racks: ["Rack 3", "Rack 20"] },
  ]);
  // Every shipping card done ⇒ latest completedDate.
  assert.equal(packedDate, "2026-06-02");
});

test("deriveComponentRacks: any open packing card ⇒ packedDate null", () => {
  const jcs = [
    {
      productionOrderId: "po-1",
      wipType: "HEADBOARD",
      wipLabel: "Headboard",
      rackingNumber: "Rack 3",
      completedDate: "2026-06-02",
      status: "COMPLETED",
    },
    {
      productionOrderId: "po-1",
      wipType: "DIVAN",
      wipLabel: "Divan",
      rackingNumber: "Rack 5",
      completedDate: null,
      status: "IN_PROGRESS",
    },
  ];
  const { packedDate, componentRacks } = deriveComponentRacks(jcs, "BEDFRAME", null);
  assert.equal(packedDate, null);
  // Racks still surface for the cards that have one.
  assert.deepEqual(componentRacks, [
    { label: "HB", racks: ["Rack 3"] },
    { label: "DIVAN", racks: ["Rack 5"] },
  ]);
});

test("deriveComponentRacks: HB-only special ignores stranded DIVAN cards", () => {
  const jcs = [
    {
      productionOrderId: "po-1",
      wipType: "HEADBOARD",
      wipLabel: "Headboard",
      rackingNumber: "Rack 3",
      completedDate: "2026-06-02",
      status: "COMPLETED",
    },
    {
      productionOrderId: "po-1",
      wipType: "DIVAN",
      wipLabel: "Divan",
      rackingNumber: "Rack 5",
      completedDate: null,
      status: "IN_PROGRESS", // would block packedDate if counted
    },
  ];
  const { packedDate, componentRacks } = deriveComponentRacks(
    jcs,
    "BEDFRAME",
    "Headboard Only",
  );
  // DIVAN card excluded: HB alone is done ⇒ packed, and no DIVAN rack shows.
  assert.equal(packedDate, "2026-06-02");
  assert.deepEqual(componentRacks, [{ label: "HB", racks: ["Rack 3"] }]);
});

test("selectBestBomByCode: ACTIVE preferred over a later DRAFT", () => {
  const m = selectBestBomByCode([
    {
      productCode: "X1",
      baseModel: "X",
      wipComponents: "DRAFT",
      versionStatus: "DRAFT",
      effectiveFrom: "2026-06-10",
    },
    {
      productCode: "X1",
      baseModel: "X",
      wipComponents: "ACTIVE",
      versionStatus: "ACTIVE",
      effectiveFrom: "2026-01-01",
    },
  ]);
  assert.equal(m.get("X1")?.wipComponents, "ACTIVE");
});

test("selectBestBomByCode: among same status, latest effectiveFrom wins", () => {
  const m = selectBestBomByCode([
    {
      productCode: "X1",
      baseModel: "X",
      wipComponents: "OLD",
      versionStatus: "ACTIVE",
      effectiveFrom: "2026-01-01",
    },
    {
      productCode: "X1",
      baseModel: "X",
      wipComponents: "NEW",
      versionStatus: "ACTIVE",
      effectiveFrom: "2026-06-01",
    },
  ]);
  assert.equal(m.get("X1")?.wipComponents, "NEW");
});

test("DO and CN routes both import the shared helpers (shared, not duplicated)", () => {
  const doSrc = readFileSync(
    join(process.cwd(), "src", "api", "routes", "delivery-orders.ts"),
    "utf8",
  );
  const cnSrc = readFileSync(
    join(process.cwd(), "src", "api", "routes", "consignment-notes.ts"),
    "utf8",
  );
  for (const src of [doSrc, cnSrc]) {
    assert.match(src, /from "\.\.\/lib\/print-extras-shared"/);
    assert.match(src, /deriveComponentRacks/);
    assert.match(src, /selectBestBomByCode/);
  }
  // CN exposes its own print-extras endpoint mirroring DO's.
  assert.match(cnSrc, /app\.get\("\/:id\/print-extras"/);
  // And the DO route no longer carries an inline copy of the pieces builder
  // (it must delegate to the shared piecesFor via the positional shim).
  assert.match(doSrc, /piecesFor as piecesForShared/);
});

test("CN PDF reuses the DO PDF's exported formatting helpers", () => {
  const cnPdf = readFileSync(
    join(process.cwd(), "src", "lib", "generate-cn-pdf.ts"),
    "utf8",
  );
  // The build-spec cell, pieces breakdown and rack manifest must come from
  // generate-do-pdf.ts — one formatter each, no CN-local re-implementation.
  assert.match(
    cnPdf,
    /import \{[\s\S]*?describe,[\s\S]*?fmtPieces,[\s\S]*?fmtComponentRacks,[\s\S]*?\} from "@\/lib\/generate-do-pdf"/,
  );
  // And generate-do-pdf.ts actually exports them.
  const doPdf = readFileSync(
    join(process.cwd(), "src", "lib", "generate-do-pdf.ts"),
    "utf8",
  );
  assert.match(doPdf, /export function describe\(/);
  assert.match(doPdf, /export function fmtPieces\(/);
  assert.match(doPdf, /export function fmtComponentRacks\(/);
});
