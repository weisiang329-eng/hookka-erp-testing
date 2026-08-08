// ---------------------------------------------------------------------------
// WHICH finished unit gets sampled. The share (10%, floor 1, ceiling 5) was
// never the problem; the DRAW was — units came back in whatever order the
// database returned them, so a day of mostly repeat production spent the
// inspection on the model the factory has built four hundred times.
//
// Owner 2026-08-08: "那些特别少出现的一些 order … 一些款式，看手工等等 … 尤其是
// 我们 service case 里面有的东西". Three signals, and he ranked them: the last
// is the strongest, and these tests hold that ranking in place.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  scoreFgUnit,
  drawReasonSummary,
  OUR_FAULT_ROOT_CAUSES,
  FG_RARITY_WINDOW_DAYS,
} from "../src/api/lib/qc-fg-risk.ts";

const codes = (r) => r.reasons.map((x) => x.code);

test("nothing known against a unit scores 0 — that is a normal answer", () => {
  const r = scoreFgUnit({});
  assert.equal(r.score, 0);
  assert.deepEqual(r.reasons, []);
  assert.match(drawReasonSummary(r), /Routine/);
});

test("a prior service case on the product code outweighs every other single signal", () => {
  // The owner singled this one out, so the weighting has to actually reflect
  // that and not merely mention it.
  const complaint = scoreFgUnit({ serviceCaseProductHits: 1 });
  const rare = scoreFgUnit({ unitsOfProductCode: 1 });
  const special = scoreFgUnit({ specialOrder: "no piping" });
  const heavy = scoreFgUnit({ bomTotalMinutes: 300, medianBomMinutes: 100 });

  assert.ok(complaint.score > rare.score, "a complaint beats rarity");
  assert.ok(complaint.score > special.score, "a complaint beats a special order");
  assert.ok(complaint.score > heavy.score, "a complaint beats hand-heavy");
  assert.deepEqual(codes(complaint), ["SERVICE_CASE_PRODUCT"]);
});

test("repeat complaints on one product code weigh more, but not without limit", () => {
  const one = scoreFgUnit({ serviceCaseProductHits: 1 }).score;
  const three = scoreFgUnit({ serviceCaseProductHits: 3 }).score;
  const forty = scoreFgUnit({ serviceCaseProductHits: 40 }).score;
  assert.ok(three > one);
  assert.ok(forty > three);
  // Capped: one pathological product code must not permanently own the draw
  // and starve everything else of inspection.
  assert.equal(forty, scoreFgUnit({ serviceCaseProductHits: 100 }).score);
});

test("a complaint traced to OUR production weighs more than one blamed on transport", () => {
  const ours = scoreFgUnit({ serviceCaseProductHits: 1, serviceCaseProductOurFaultHits: 1 });
  const theirs = scoreFgUnit({ serviceCaseProductHits: 1 });
  assert.ok(ours.score > theirs.score);
  assert.ok(codes(ours).includes("SERVICE_CASE_OUR_FAULT"));
  // Both are real complaints; only ours repeats at the bench.
  assert.ok(codes(theirs).includes("SERVICE_CASE_PRODUCT"));
});

test("the root causes that count as ours are the ones we can fix at the bench", () => {
  for (const c of ["PRODUCTION", "DESIGN", "MATERIAL", "PROCESS"]) {
    assert.ok(OUR_FAULT_ROOT_CAUSES.has(c), `${c} is ours`);
  }
  for (const c of ["TRANSPORT", "CUSTOMER", "OTHER"]) {
    assert.ok(!OUR_FAULT_ROOT_CAUSES.has(c), `${c} does not repeat at the bench`);
  }
});

test("a repeat-complaint customer is weighted, below the product signal", () => {
  const cust = scoreFgUnit({ serviceCaseCustomerHits: 2 });
  assert.ok(cust.score > 0);
  assert.ok(cust.score < scoreFgUnit({ serviceCaseProductHits: 1 }).score);
  assert.deepEqual(codes(cust), ["SERVICE_CASE_CUSTOMER"]);
});

test("rarity is banded by units actually built, and a bestseller scores nothing for it", () => {
  const veryRare = scoreFgUnit({ unitsOfProductCode: 1 }).score;
  const rare = scoreFgUnit({ unitsOfProductCode: 4 }).score;
  const uncommon = scoreFgUnit({ unitsOfProductCode: 9 }).score;
  const routine = scoreFgUnit({ unitsOfProductCode: 400 }).score;
  assert.ok(veryRare > rare && rare > uncommon && uncommon > 0);
  assert.equal(routine, 0, "the model built four hundred times is not where the surprises are");
});

test("the rarity reason names the number and the window, not just 'rare'", () => {
  const r = scoreFgUnit({ unitsOfProductCode: 2 });
  assert.match(r.reasons[0].label, /2 of this product code/);
  assert.match(r.reasons[0].label, new RegExp(String(FG_RARITY_WINDOW_DAYS)));
});

test("hand work is measured against the catalogue median, not against a guess", () => {
  const heavy = scoreFgUnit({ bomTotalMinutes: 300, medianBomMinutes: 100 });
  const above = scoreFgUnit({ bomTotalMinutes: 130, medianBomMinutes: 100 });
  const normal = scoreFgUnit({ bomTotalMinutes: 100, medianBomMinutes: 100 });
  assert.ok(heavy.score > above.score);
  assert.ok(above.score > 0);
  assert.equal(normal.score, 0);
  assert.match(heavy.reasons[0].label, /standard minutes/);
});

test("no BOM, or no median to compare against, simply does not weight — it never throws", () => {
  assert.equal(scoreFgUnit({ bomTotalMinutes: 300 }).score, 0, "300 minutes against nothing means nothing");
  assert.equal(scoreFgUnit({ medianBomMinutes: 100 }).score, 0);
  assert.equal(scoreFgUnit({ bomTotalMinutes: null, medianBomMinutes: null }).score, 0);
  assert.equal(scoreFgUnit({ unitsOfProductCode: null, serviceCaseProductHits: null }).score, 0);
});

test("a one-off written instruction is both unusual AND hand-executed", () => {
  const special = scoreFgUnit({ specialOrder: "chaise on the LEFT, no piping" });
  assert.ok(special.score > 0);
  assert.deepEqual(codes(special), ["SPECIAL_ORDER"]);
  // Whitespace is not an instruction.
  assert.equal(scoreFgUnit({ specialOrder: "   " }).score, 0);
  assert.equal(scoreFgUnit({ specialOrder: null }).score, 0);
});

test("the signals ADD — the rare hand-heavy model that also has a complaint tops the draw", () => {
  // A max() would flatten exactly the unit that most deserves the inspection.
  const all = scoreFgUnit({
    serviceCaseProductHits: 2,
    serviceCaseProductOurFaultHits: 1,
    serviceCaseCustomerHits: 1,
    unitsOfProductCode: 1,
    bomTotalMinutes: 300,
    medianBomMinutes: 100,
    specialOrder: "buttoned back",
    lineNotes: "match the showroom piece",
  });
  const justComplaint = scoreFgUnit({ serviceCaseProductHits: 2 });
  assert.ok(all.score > justComplaint.score);
  assert.equal(all.reasons.length, 7);
});

test("the summary is a sentence about what to look at, not a score", () => {
  const r = scoreFgUnit({ serviceCaseProductHits: 3, unitsOfProductCode: 1 });
  const s = drawReasonSummary(r);
  assert.doesNotMatch(s, /\bscore\b/i, "a number tells the inspector nothing about what to check");
  assert.match(s, /service cases/);
  assert.ok(s.endsWith("."));
  // Kept to the two strongest so it stays readable at the top of a checklist.
  assert.ok(s.split(". ").length <= 2);
});
