// ---------------------------------------------------------------------------
// bom-wastage.test.mjs — per-material wastage % in the BOM editor (owner
// 2026-07-31, "我们的 wastage 也要这样算，跟行业标准").
//
// Industry-standard scrap factor: cut / bulk materials (fabric / foam / wood)
// carry offcut + defect waste; discrete parts (screws / legs / mechanism) stay
// 0. The consumption engine ALREADY expands each line by (1 + wastePct/100);
// the gap was that the tree-based BOM editor had no wastage input, so every BOM
// ran at 0% waste. This adds the field to every material row and confirms the
// value survives the whole round-trip (editor state → save payload → backend
// JSON → consumption).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

test("WIPMaterial carries an optional wastePct", () => {
  const f = flat("src/pages/bom.tsx");
  assert.match(f, /type WIPMaterial = \{[^}]*wastePct\?: number/);
});

test("every material row (all 6 editor contexts) has a wastage % input", () => {
  const f = read("src/pages/bom.tsx");
  const inputs = f.match(/"wastePct", parseFloat\(e\.target\.value\) \|\| 0\)/g) ?? [];
  assert.equal(inputs.length, 6, `expected a waste input at all 6 material-row sites, found ${inputs.length}`);
  // each keeps its own site-correct update handler
  assert.match(f, /updateWIPMaterial\(wi, mi, "wastePct"/);
  assert.match(f, /onUpdateMaterial\(childPath, mi, "wastePct"/);
  assert.match(f, /updateL1Material\(i, "wastePct"/);
  assert.match(f, /updateMaterialAtPath\(wi, \[\], mi, "wastePct"/);
  // value binds to the material's wastePct (blank when absent → shows placeholder 0)
  assert.match(f, /value=\{m\.wastePct \?\? ""\}/);
});

test("consumption expands every line by (1 + wastePct/100)", () => {
  const f = flat("src/api/lib/po-cost-cascade.ts");
  assert.match(f, /\(1 \+ Math\.max\(0, line\.wastePct \|\| 0\) \/ 100\)/);
  // and the tree walker reads wastePct off each BOM material node
  assert.match(f, /row\.wastePct/);
});

test("backend persists wipComponents (and thus wastePct) as-is, not field-picked", () => {
  const f = flat("src/api/routes/bom.ts");
  // JSON.stringify of the whole array — no per-material projection that would
  // silently drop the new field.
  assert.match(f, /wipComponents: JSON\.stringify\(\s*Array\.isArray\(wipComponents\) \? wipComponents : \[\]/);
});
