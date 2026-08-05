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
import { partLabelFromKey } from "../src/lib/repair-scope.ts";
import { formatComponentRacksNoLabel } from "../src/lib/rack-format.ts";

const BF_VARIANTS_CTX = {
  productCode: "TRION-K",
  model: "TRION",
  sizeLabel: "6FT",
  sizeCode: "",
  fabricCode: "PC151-02",
  divanHeightInches: 12,
  legHeightInches: 2,
  gapInches: 2,
};

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

test("piecesFor: King bedframe BOM → '1 HB + 2 Divan' (HB first)", () => {
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
  assert.equal(out, "1 HB + 2 Divan");
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

test("piecesFor: a complete sofa set counts as 'Sofa', not its variant pieces", () => {
  // A sofa "1A(LHF)" must NOT be broken into Base/Cushion/Arm — it ships as one
  // labelled set, counted as "Sofa" (the variant stays in the product name).
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
  assert.equal(out, "2 Sofa");
});

// --- Partial-repair component listing (DO compartment-aware print) ---------
// A partial repair lists ONLY the repaired components, by their own picker
// labels (Headboard / Divan / Base / Back Cushion / Armrest / Headrest), so the
// DO shows exactly what's delivered for repair — sofa sub-components included.
const BF_BASE = {
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
const scope = (components) => ({ preset: "CUSTOM", depts: ["UPHOLSTERY"], components });

test("piecesFor: bedframe partial repair (HB only) → '1 HB' (matches full unit)", () => {
  const out = piecesFor({
    ...BF_BASE,
    repairScope: scope([{ key: "k1", label: "HB", qty: 1 }]),
  });
  assert.equal(out, "1 HB");
});

test("piecesFor: SOFA partial repair lists sub-components (was the whole set)", () => {
  // The key fix: a sofa normally ships as ONE labelled set ("1 1A(LHF)"), but a
  // partial repair must list the repaired sub-components by their picker labels.
  const out = piecesFor({
    code: "BO315-1A(LHF)",
    baseModel: "BO315",
    wipComponents: KING_BF_BOM, // irrelevant — repair scope drives the listing
    cat: "SOFA",
    special: null,
    sizeLabel: "35",
    fabricCode: "FAB-1",
    gapInches: null,
    divanHeightInches: null,
    legHeightInches: null,
    qty: 1,
    repairScope: scope([
      { key: "k1", label: "Back Cushion", qty: 1 },
      { key: "k2", label: "Armrest", qty: 1 },
      { key: "k3", label: "Headrest", qty: 1 },
    ]),
  });
  // HB/BC/Arm stay short; Headrest / Right Arm / Left Arm spell out (Wei Siang).
  assert.equal(out, "1 BC + 1 Arm + 1 Headrest");
});

test("piecesFor: component qty × line set-qty (2 sets, 1 HB each → '2 HB')", () => {
  const out = piecesFor({
    ...BF_BASE,
    qty: 2,
    repairScope: scope([{ key: "k1", label: "HB", qty: 1 }]),
  });
  assert.equal(out, "2 HB");
});

test("piecesFor: picked component qty is respected (2 of 2 Divan → '2 Divan')", () => {
  const out = piecesFor({
    ...BF_BASE,
    repairScope: scope([{ key: "k2", label: "Divan", qty: 2 }]),
  });
  assert.equal(out, "2 Divan");
});

test("piecesFor: no repairScope → full set unchanged", () => {
  assert.equal(piecesFor({ ...BF_BASE }), "1 HB + 2 Divan");
  assert.equal(piecesFor({ ...BF_BASE, repairScope: null }), "1 HB + 2 Divan");
  // A dept-only scope (no component picks) is NOT a narrowing → full set.
  assert.equal(
    piecesFor({ ...BF_BASE, repairScope: { preset: "FABRIC", depts: ["UPHOLSTERY"] } }),
    "1 HB + 2 Divan",
  );
});

test("partLabelFromKey: clean short label from the wipKey (not the verbose label)", () => {
  assert.equal(
    partLabelFromKey("5531-2A(RHF)::0::BACK_CUSHION::BC", "5531 -Back Cushion 28"),
    "BC",
  );
  assert.equal(partLabelFromKey("5531::1::RIGHT_ARM::RA", "5531 -Right Arm"), "Right Arm");
  assert.equal(partLabelFromKey("X::0::BASE::B", "X -Base 28"), "Base");
  assert.equal(partLabelFromKey("X::0::HEADBOARD::HB", "x"), "HB");
  // Unknown wipType → title-cased; no key segments → fall back to the label.
  assert.equal(partLabelFromKey("X::0::SEAT_CUSHION::SC", "x"), "Seat Cushion");
  assert.equal(partLabelFromKey("k1", "Back Cushion"), "BC");
});

test("piecesFor: FULL-SKU repair (all components at full qty) → complete unit, not parts", () => {
  // Pick BOTH bedframe components at their full BOM qty → it's the WHOLE bed,
  // so it prints as the complete unit, NOT a broken-out repair parts list.
  const wips = breakBomIntoWips(KING_BF_BOM, "TRION-K", BF_VARIANTS_CTX);
  const components = wips.map((w) => ({
    key: w.wipKey,
    label: w.wipLabel,
    qty: w.quantityMultiplier,
  }));
  const out = piecesFor({ ...BF_BASE, repairScope: scope(components) });
  assert.equal(out, "1 HB + 2 Divan");
});

test("piecesFor: partial repair by REAL key (only HB) → '1 HB'", () => {
  const wips = breakBomIntoWips(KING_BF_BOM, "TRION-K", BF_VARIANTS_CTX);
  const hb = wips.find((w) => w.wipType.toUpperCase() === "HEADBOARD");
  const out = piecesFor({
    ...BF_BASE,
    repairScope: scope([{ key: hb.wipKey, label: hb.wipLabel, qty: 1 }]),
  });
  assert.equal(out, "1 HB");
});

test("buildRepairNote: strips counts, multi-word labels, English 'Repair: X only'", () => {
  assert.equal(buildRepairNote("1 HB"), "Repair: HB only");
  assert.equal(
    buildRepairNote("1 Back Cushion + 1 Armrest"),
    "Repair: Back Cushion + Armrest only",
  );
  assert.equal(buildRepairNote("2 Divan"), "Repair: Divan only");
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

test("formatComponentRacksNoLabel: DO-document rack line drops labels (owner's spec)", () => {
  // Single component (e.g. "1 Sofa") → just the bare rack group, NO prefix.
  assert.equal(
    formatComponentRacksNoLabel([{ label: "Sofa", racks: ["Rack 3"] }]),
    "Rack 3",
  );
  // Multi component ("1 HB 2 Divan": HB on Rack 1, Divans on Racks 2 & 3) →
  // per-component groups, NO label, " · " between components, comma within.
  assert.equal(
    formatComponentRacksNoLabel([
      { label: "HB", racks: ["Rack 1"] },
      { label: "DIVAN", racks: ["Rack 2", "Rack 3"] },
    ]),
    "Rack 1 · Rack 2, 3",
  );
  // Empty components are dropped; none / null ⇒ "".
  assert.equal(
    formatComponentRacksNoLabel([
      { label: "HB", racks: [] },
      { label: "DIVAN", racks: ["Rack 5"] },
    ]),
    "Rack 5",
  );
  assert.equal(formatComponentRacksNoLabel([]), "");
  assert.equal(formatComponentRacksNoLabel(null), "");
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

test("neither DO nor CN carries its own copy of the shared print-extras logic", () => {
  const doSrc = readFileSync(
    join(process.cwd(), "src", "api", "routes", "delivery-orders.ts"),
    "utf8",
  );
  const cnSrc = readFileSync(
    join(process.cwd(), "src", "api", "routes", "consignment-notes.ts"),
    "utf8",
  );

  // This used to assert that the IMPORT NAMES appeared in each file, which is
  // a shape, not a behaviour. When the DO route was refactored to delegate to
  // computeDoPrintExtras, its imports went dead but the test still demanded
  // they be written down — so 28 unused imports stayed pinned in place,
  // failing the pre-commit lint on every change to that file. Assert what the
  // test actually cares about instead: that neither route re-implements the
  // shared helpers.
  for (const [name, src] of [["delivery-orders", doSrc], ["consignment-notes", cnSrc]]) {
    for (const fn of ["deriveComponentRacks", "selectBestBomByCode", "piecesFor"]) {
      assert.doesNotMatch(
        src,
        new RegExp(`(function|const)\\s+${fn}\\s*[=(]`),
        `${name}.ts defines its own ${fn} — it must use the shared one`,
      );
    }
  }

  // CN builds its print extras in-route, so it must be importing the shared
  // helpers rather than doing it by hand.
  assert.match(cnSrc, /from "\.\.\/lib\/print-extras-shared"/);
  assert.match(cnSrc, /deriveComponentRacks/);
  assert.match(cnSrc, /selectBestBomByCode/);
  assert.match(cnSrc, /app\.get\("\/:id\/print-extras"/);

  // DO delegates instead — the same logic, reached a different way.
  assert.match(doSrc, /computeDoPrintExtras\(/);
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
