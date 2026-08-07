// The single invoice-line unit-price sum (src/lib/invoice-line-price.ts).
//
// This exists because the price editor summed base+divan+leg+special+totalHeight
// in four places and one — the save — included totalHeight while the three
// previews did not. Opening the editor showed a price ~RM3 low, editing
// T.Height did nothing on screen, and Save wrote the low number over the
// correct one. Every call site now goes through invoiceLineUnitSen, so the
// component list can never diverge again. These tests pin that list.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const m = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/invoice-line-price.ts")).href
);

test("unit = base + divan + leg + special + totalHeight", () => {
  assert.equal(
    m.invoiceLineUnitSen({ baseSen: 30500, divanSen: 0, legSen: 0, specialSen: 0, totalHeightSen: 298 }),
    30798,
    "base 305.00 + T.Height 2.98 = 307.98 — the exact case the bug hid",
  );
  assert.equal(
    m.invoiceLineUnitSen({ baseSen: 55000, divanSen: 1000, legSen: 500, specialSen: 5000, totalHeightSen: 8000 }),
    69500,
  );
});

test("totalHeight is NOT dropped — the specific regression", () => {
  // Before the fix the previews computed base+divan+leg+special and lost this.
  const withTH = m.invoiceLineUnitSen({ baseSen: 30500, divanSen: 0, legSen: 0, specialSen: 0, totalHeightSen: 8000 });
  const withoutTH = m.invoiceLineUnitSen({ baseSen: 30500, divanSen: 0, legSen: 0, specialSen: 0, totalHeightSen: 0 });
  assert.equal(withTH - withoutTH, 8000, "editing T.Height must move the unit price");
});

test("missing / non-numeric parts count as zero, never NaN", () => {
  assert.equal(m.invoiceLineUnitSen({ baseSen: 30500 }), 30500);
  assert.equal(
    m.invoiceLineUnitSen({ baseSen: 305, divanSen: undefined, legSen: null, specialSen: NaN, totalHeightSen: "x" }),
    305,
  );
});

test("all-zero line is zero, not NaN", () => {
  assert.equal(m.invoiceLineUnitSen({ baseSen: 0, divanSen: 0, legSen: 0, specialSen: 0, totalHeightSen: 0 }), 0);
});
