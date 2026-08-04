// ---------------------------------------------------------------------------
// scan-row-number-not-a-code.test.mjs — the "No." column is not a product code.
//
// Owner 2026-08-04: "其他的供应商都没问题，就这个 ADD WOOD 有问题."
//
// ADD WOOD's invoice is `No | Description | Qty | Unit/Price | Amount`. They
// print no product code anywhere; the leftmost column is a running 1, 2, 3. The
// extractor sees a short per-line value in the leading column and fills
// `supplierCode` with it — and one junk character there broke three separate
// things, which is why only this supplier misbehaved:
//
//   1. the description fallback was gated on `!rawSku`, so it never ran — and
//      the description is the ONLY identifying text on their lines. No amount
//      of manual picking could ever make their invoice auto-resolve;
//   2. the prefix-tolerant binding search matched any SKU ending in that digit,
//      binding a line to the wrong material silently;
//   3. the digit joined the text used for catalogue matching, where a rare
//      token carries high weight and drags the score below the bar.
//
// Fixed at both ends: the extractor is told a counter column is not a code, and
// the client refuses to read one as a code regardless of what comes back.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  looksLikeRowNumber,
  supplierCodeOf,
  resolveMaterialForLine,
  buildCandidateTiers,
  indexByCode,
  supplierSkuIndex,
  MIN_SKU_SUFFIX_MATCH,
} from "../src/lib/supplier-material-candidates.ts";

const SRC = readFileSync(
  resolve(process.cwd(), "src/components/scan-supplier-modal.tsx"),
  "utf8",
);

// ── What counts as a row number ─────────────────────────────────────────────

test("a bare short integer is a counter, not a code", () => {
  for (const v of ["1", "2", "01", "003", "12.", "3)", " 4 "]) {
    assert.equal(looksLikeRowNumber(v), true, `${JSON.stringify(v)} is a row number`);
    assert.equal(supplierCodeOf(v), "", "and must not be read as a code");
  }
});

test("anything carrying a letter or shape is a real code", () => {
  for (const v of ["AW-9", "SL 27", "OST-SL157", "9MM", "A1", "1234", "PLY-9-48-AB"]) {
    assert.equal(looksLikeRowNumber(v), false, `${JSON.stringify(v)} is a real code`);
    assert.equal(supplierCodeOf(v), v.trim());
  }
});

test("blank stays blank", () => {
  assert.equal(looksLikeRowNumber(""), false);
  assert.equal(looksLikeRowNumber(null), false);
  assert.equal(supplierCodeOf(null), "");
});

// ── The consequence it prevents ─────────────────────────────────────────────

const CATALOG = [
  { itemCode: "PLY-9-48-AB", description: "PLYWOOD 9MM 4X8 AB" },
  { itemCode: "FOAM-D24-2", description: "FOAM D24 2INCH SHEET" },
];
const byCode = indexByCode(CATALOG);

test("a row number never resolves a line by SKU lookup", () => {
  // A PO whose supplier SKU happens to normalise to "1" would otherwise be
  // returned with score 1 — treated as certain, and wrong.
  const po = {
    id: "po-1",
    supplierId: "sup-addwood",
    items: [{ materialCode: "FOAM-D24-2", supplierSKU: "1" }],
  };
  const idx = supplierSkuIndex("sup-addwood", [po], [], byCode);
  const tiers = buildCandidateTiers({
    supplierId: "sup-addwood",
    purchaseOrders: [],
    bindings: [],
    materialByCode: byCode,
    catalog: CATALOG,
  });
  assert.equal(
    resolveMaterialForLine("", tiers, { supplierSku: "1", skuIndex: idx }),
    null,
    "a counter must not be looked up as if it identified anything",
  );
  // A real code through the same path still resolves.
  const po2 = {
    id: "po-2",
    supplierId: "sup-addwood",
    items: [{ materialCode: "FOAM-D24-2", supplierSKU: "AW-24" }],
  };
  const idx2 = supplierSkuIndex("sup-addwood", [po2], [], byCode);
  const hit = resolveMaterialForLine("", tiers, { supplierSku: "AW-24", skuIndex: idx2 });
  assert.equal(hit.item.itemCode, "FOAM-D24-2");
});

test("the ADD WOOD line still resolves once the counter is dropped", () => {
  const po = {
    id: "po-1",
    supplierId: "sup-addwood",
    items: [{ materialCode: "PLY-9-48-AB" }],
  };
  const tiers = buildCandidateTiers({
    supplierId: "sup-addwood",
    linkedPo: [po],
    purchaseOrders: [],
    bindings: [],
    materialByCode: byCode,
    catalog: CATALOG,
  });
  // What the wizard now builds: sanitised code + description.
  const text = `${supplierCodeOf("1")} 9MM 4' X 8' PLYWOOD AB`.trim();
  const m = resolveMaterialForLine(text, tiers, { supplierSku: "1" });
  assert.ok(m, "this is the line the owner says should not need a pick");
  assert.equal(m.item.itemCode, "PLY-9-48-AB");
});

// ── The wiring ──────────────────────────────────────────────────────────────

test("both wizards sanitise the code column", () => {
  assert.equal(
    SRC.split("supplierCodeOf(ln.supplierCode)").length - 1,
    2,
    "create-PI and create-GRN must agree",
  );
  assert.equal(
    SRC.split(`const rawSku = (ln.supplierCode ?? "").trim();`).length - 1,
    0,
    "the raw code column must not be read directly any more",
  );
});

test("the description fallback runs whenever the SKU path FAILED", () => {
  // Gated on `!rawSku` before, so one junk character in the code column
  // disabled the only resolution path some suppliers have.
  assert.equal(
    SRC.split("if (!binding && sId && !rawSku) {").length - 1,
    0,
    "an empty code column is not the only time the fallback is needed",
  );
  assert.equal(SRC.split("if (!binding && sId) {").length - 1, 2);
});

test("suffix matching needs enough characters to identify anything", () => {
  assert.ok(MIN_SKU_SUFFIX_MATCH >= 3);
  assert.equal(
    SRC.split(
      "if (sku.length < MIN_SKU_SUFFIX_MATCH || bSku.length < MIN_SKU_SUFFIX_MATCH) continue;",
    ).length - 1,
    2,
    "both binding resolvers must hold the floor",
  );
});

test("the extractor is told a counter column is not a code", () => {
  // Fixed at the source too — the client guard is the second line of defence.
  const engine = readFileSync(
    resolve(process.cwd(), "src/api/lib/scan-engine.ts"),
    "utf8",
  );
  assert.match(engine, /simply counts the rows 1, 2, 3 is NOT a code/);
});
