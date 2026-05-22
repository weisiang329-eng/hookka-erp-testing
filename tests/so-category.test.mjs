// ---------------------------------------------------------------------------
// so-category.test.mjs — unit tests for the Sales-Order category rules in
// `src/lib/so-category.ts`.
//
// Two hard restrictions live here, both enforced at SO create / edit /
// confirm:
//   1. SOFA and BEDFRAME may NOT share one Sales Order — they run on
//      completely separate production lines. (hasMixedSofaBedframe)
//   2. A SOFA line must use qty=1 — multiple sofas go on multiple lines.
//      (findInvalidSofaQty / formatSofaQtyError)
// Plus getPrimarySoCategory, which derives the SO's primary category for
// downstream routing. These are pure functions; lock every branch so a
// future refactor can't quietly weaken a rejection.
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

let sc;
try {
  sc = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/so-category.ts")).href
  );
} catch (err) {
  console.warn(
    "[so-category.test] Could not import so-category module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[so-category.test] Error:", err?.message ?? err);
  throw err;
}

// ---------------------------------------------------------------------------
// hasMixedSofaBedframe — true ONLY when both SOFA and BEDFRAME are present.
// ---------------------------------------------------------------------------
test("hasMixedSofaBedframe: SOFA + BEDFRAME together is a violation", () => {
  assert.equal(
    sc.hasMixedSofaBedframe([
      { itemCategory: "SOFA" },
      { itemCategory: "BEDFRAME" },
    ]),
    true,
  );
});

test("hasMixedSofaBedframe: BEDFRAME + SOFA (reverse order) is a violation", () => {
  // Order of the two categories must not matter.
  assert.equal(
    sc.hasMixedSofaBedframe([
      { itemCategory: "BEDFRAME" },
      { itemCategory: "SOFA" },
    ]),
    true,
  );
});

test("hasMixedSofaBedframe: all-SOFA order is allowed", () => {
  assert.equal(
    sc.hasMixedSofaBedframe([
      { itemCategory: "SOFA" },
      { itemCategory: "SOFA" },
    ]),
    false,
  );
});

test("hasMixedSofaBedframe: all-BEDFRAME order is allowed", () => {
  assert.equal(
    sc.hasMixedSofaBedframe([
      { itemCategory: "BEDFRAME" },
      { itemCategory: "BEDFRAME" },
    ]),
    false,
  );
});

test("hasMixedSofaBedframe: pure-accessory order is allowed", () => {
  // The header comment explicitly says pure-accessory SOs are valid.
  assert.equal(
    sc.hasMixedSofaBedframe([
      { itemCategory: "ACCESSORY" },
      { itemCategory: "ACCESSORY" },
    ]),
    false,
  );
});

test("hasMixedSofaBedframe: SOFA + ACCESSORY is allowed (accessories ride along)", () => {
  assert.equal(
    sc.hasMixedSofaBedframe([
      { itemCategory: "SOFA" },
      { itemCategory: "ACCESSORY" },
    ]),
    false,
  );
});

test("hasMixedSofaBedframe: BEDFRAME + ACCESSORY is allowed", () => {
  assert.equal(
    sc.hasMixedSofaBedframe([
      { itemCategory: "BEDFRAME" },
      { itemCategory: "ACCESSORY" },
    ]),
    false,
  );
});

test("hasMixedSofaBedframe: empty item list is not a violation", () => {
  assert.equal(sc.hasMixedSofaBedframe([]), false);
});

test("hasMixedSofaBedframe: category match is case-insensitive", () => {
  // The implementation upper-cases each itemCategory before comparing.
  assert.equal(
    sc.hasMixedSofaBedframe([
      { itemCategory: "sofa" },
      { itemCategory: "bedframe" },
    ]),
    true,
  );
});

test("hasMixedSofaBedframe: null/undefined/missing itemCategory is ignored", () => {
  // (it.itemCategory ?? "") -> "" -> not SOFA, not BEDFRAME.
  assert.equal(
    sc.hasMixedSofaBedframe([
      { itemCategory: null },
      { itemCategory: undefined },
      {},
      { itemCategory: "SOFA" },
    ]),
    false,
  );
});

test("hasMixedSofaBedframe: violation is detected even with accessories interleaved", () => {
  assert.equal(
    sc.hasMixedSofaBedframe([
      { itemCategory: "ACCESSORY" },
      { itemCategory: "SOFA" },
      { itemCategory: "ACCESSORY" },
      { itemCategory: "BEDFRAME" },
    ]),
    true,
  );
});

// ---------------------------------------------------------------------------
// SO_MIXED_CATEGORY_ERROR — the user-facing message. Must stay English-only
// (codebase rule: 100% English UI).
// ---------------------------------------------------------------------------
test("SO_MIXED_CATEGORY_ERROR: is a non-empty English-only string", () => {
  assert.equal(typeof sc.SO_MIXED_CATEGORY_ERROR, "string");
  assert.ok(sc.SO_MIXED_CATEGORY_ERROR.length > 0);
  // No CJK characters — the UI is English-only.
  assert.ok(
    !/[一-鿿]/.test(sc.SO_MIXED_CATEGORY_ERROR),
    "error message must not contain Chinese characters",
  );
  assert.match(sc.SO_MIXED_CATEGORY_ERROR, /Sofa and Bedframe/);
});

// ---------------------------------------------------------------------------
// findInvalidSofaQty — first SOFA line with qty > 1, else null.
// ---------------------------------------------------------------------------
test("findInvalidSofaQty: all SOFA lines qty=1 -> null (compliant)", () => {
  assert.equal(
    sc.findInvalidSofaQty([
      { itemCategory: "SOFA", quantity: 1 },
      { itemCategory: "SOFA", quantity: 1 },
    ]),
    null,
  );
});

test("findInvalidSofaQty: a SOFA line with qty>1 is flagged", () => {
  const offending = sc.findInvalidSofaQty([
    { itemCategory: "SOFA", quantity: 1 },
    { itemCategory: "SOFA", quantity: 3, productCode: "5531-1A" },
  ]);
  assert.ok(offending, "expected the qty=3 sofa line to be returned");
  assert.equal(offending.quantity, 3);
  assert.equal(offending.productCode, "5531-1A");
});

test("findInvalidSofaQty: returns the FIRST offending sofa line", () => {
  const offending = sc.findInvalidSofaQty([
    { itemCategory: "SOFA", quantity: 2, productCode: "FIRST" },
    { itemCategory: "SOFA", quantity: 5, productCode: "SECOND" },
  ]);
  assert.equal(offending.productCode, "FIRST");
});

test("findInvalidSofaQty: BEDFRAME line with qty>1 is allowed (rule is SOFA-only)", () => {
  // The comment is explicit: BEDFRAME/ACCESSORY generators expand qty>1.
  assert.equal(
    sc.findInvalidSofaQty([{ itemCategory: "BEDFRAME", quantity: 4 }]),
    null,
  );
});

test("findInvalidSofaQty: ACCESSORY line with qty>1 is allowed", () => {
  assert.equal(
    sc.findInvalidSofaQty([{ itemCategory: "ACCESSORY", quantity: 10 }]),
    null,
  );
});

test("findInvalidSofaQty: missing quantity defaults to 1 -> compliant", () => {
  // Number(it.quantity ?? 1) — a SOFA line with no quantity is treated as 1.
  assert.equal(
    sc.findInvalidSofaQty([{ itemCategory: "SOFA" }]),
    null,
  );
});

test("findInvalidSofaQty: null quantity defaults to 1 -> compliant", () => {
  assert.equal(
    sc.findInvalidSofaQty([{ itemCategory: "SOFA", quantity: null }]),
    null,
  );
});

test("findInvalidSofaQty: SOFA qty is matched case-insensitively", () => {
  const offending = sc.findInvalidSofaQty([
    { itemCategory: "sofa", quantity: 2 },
  ]);
  assert.ok(offending, "lowercase 'sofa' must still be checked for qty>1");
});

test("findInvalidSofaQty: empty list -> null", () => {
  assert.equal(sc.findInvalidSofaQty([]), null);
});

test("findInvalidSofaQty: qty exactly 1 is the compliant boundary", () => {
  // > 1 is the rejection threshold; exactly 1 must pass.
  assert.equal(
    sc.findInvalidSofaQty([{ itemCategory: "SOFA", quantity: 1 }]),
    null,
  );
});

// ---------------------------------------------------------------------------
// formatSofaQtyError — user-facing message referencing the offending line.
// ---------------------------------------------------------------------------
test("formatSofaQtyError: includes line number, product code and qty", () => {
  const msg = sc.formatSofaQtyError({
    itemCategory: "SOFA",
    quantity: 3,
    productCode: "5531-1A",
    lineNo: 2,
  });
  assert.match(msg, /line 2/);
  assert.match(msg, /\(5531-1A\)/);
  assert.match(msg, /qty=3/);
  assert.ok(msg.includes(sc.SOFA_QTY_GT_1_ERROR));
});

test("formatSofaQtyError: omits line number when lineNo is absent", () => {
  const msg = sc.formatSofaQtyError({
    itemCategory: "SOFA",
    quantity: 2,
    productCode: "5531-1A",
  });
  assert.ok(!/line \d/.test(msg), "no 'line N' fragment when lineNo missing");
  assert.match(msg, /\(5531-1A\)/);
  assert.match(msg, /qty=2/);
});

test("formatSofaQtyError: omits product code when productCode is absent", () => {
  const msg = sc.formatSofaQtyError({
    itemCategory: "SOFA",
    quantity: 4,
    lineNo: 1,
  });
  assert.ok(!msg.includes("()"), "no empty parens when productCode missing");
  assert.match(msg, /line 1/);
  assert.match(msg, /qty=4/);
});

test("formatSofaQtyError: defaults qty to 1 when quantity is absent", () => {
  // quantity ?? 1 — defensive default even though such an item wouldn't be
  // flagged by findInvalidSofaQty.
  const msg = sc.formatSofaQtyError({ itemCategory: "SOFA", lineNo: 1 });
  assert.match(msg, /qty=1/);
});

// ---------------------------------------------------------------------------
// SOFA_QTY_GT_1_ERROR — English-only user-facing message.
// ---------------------------------------------------------------------------
test("SOFA_QTY_GT_1_ERROR: is a non-empty English-only string", () => {
  assert.equal(typeof sc.SOFA_QTY_GT_1_ERROR, "string");
  assert.ok(sc.SOFA_QTY_GT_1_ERROR.length > 0);
  assert.ok(
    !/[一-鿿]/.test(sc.SOFA_QTY_GT_1_ERROR),
    "error message must not contain Chinese characters",
  );
});

// ---------------------------------------------------------------------------
// getPrimarySoCategory — SOFA wins, else BEDFRAME, else ACCESSORY.
// ---------------------------------------------------------------------------
test("getPrimarySoCategory: any SOFA line -> SOFA", () => {
  assert.equal(
    sc.getPrimarySoCategory([
      { itemCategory: "ACCESSORY" },
      { itemCategory: "SOFA" },
    ]),
    "SOFA",
  );
});

test("getPrimarySoCategory: SOFA wins even when listed after BEDFRAME", () => {
  // SOFA-vs-BEDFRAME mixing is blocked upstream, but the precedence is still
  // documented as SOFA-first.
  assert.equal(
    sc.getPrimarySoCategory([
      { itemCategory: "BEDFRAME" },
      { itemCategory: "SOFA" },
    ]),
    "SOFA",
  );
});

test("getPrimarySoCategory: BEDFRAME present, no SOFA -> BEDFRAME", () => {
  assert.equal(
    sc.getPrimarySoCategory([
      { itemCategory: "ACCESSORY" },
      { itemCategory: "BEDFRAME" },
    ]),
    "BEDFRAME",
  );
});

test("getPrimarySoCategory: all-ACCESSORY order -> ACCESSORY", () => {
  assert.equal(
    sc.getPrimarySoCategory([
      { itemCategory: "ACCESSORY" },
      { itemCategory: "ACCESSORY" },
    ]),
    "ACCESSORY",
  );
});

test("getPrimarySoCategory: empty input falls back to ACCESSORY", () => {
  // The comment says empty input falls back to BEDFRAME, but the code path
  // for an empty array sets hasBedframe=false and returns ACCESSORY. The
  // ACCESSORY fallback is what the code actually does; the only documented
  // BEDFRAME fallback is for unrecognised non-empty categories (see next).
  assert.equal(sc.getPrimarySoCategory([]), "ACCESSORY");
});

test("getPrimarySoCategory: unknown category falls back to ACCESSORY", () => {
  // A line whose category is neither SOFA nor BEDFRAME contributes nothing,
  // so an all-unknown order resolves to ACCESSORY.
  assert.equal(
    sc.getPrimarySoCategory([{ itemCategory: "WIDGET" }]),
    "ACCESSORY",
  );
});

test("getPrimarySoCategory: null/missing itemCategory -> ACCESSORY", () => {
  assert.equal(
    sc.getPrimarySoCategory([{ itemCategory: null }, {}]),
    "ACCESSORY",
  );
});

test("getPrimarySoCategory: category match is case-insensitive", () => {
  assert.equal(
    sc.getPrimarySoCategory([{ itemCategory: "sofa" }]),
    "SOFA",
  );
  assert.equal(
    sc.getPrimarySoCategory([{ itemCategory: "bedframe" }]),
    "BEDFRAME",
  );
});
