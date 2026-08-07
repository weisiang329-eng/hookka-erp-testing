// ---------------------------------------------------------------------------
// whole-ringgit-unit-price.test.mjs — the owner's 2026-08-07 pricing policy.
//
// Owner ruling ("我全套系统都要整除的", after seeing unit prices like RM 995.14):
//   1. Every line UNIT PRICE the system COMPUTES lands on a whole ringgit.
//   2. The direction is UP ("进位"), not nearest: 995.14 → 996, 305.01 → 306.
//   3. SST is EXCLUDED ("SST 就不需要") — tax keeps its cents untouched.
//   4. Rounding is applied at the UNIT level. Line subtotal follows as
//      `whole unit × qty`, so it is whole by construction — subtotals and
//      invoice totals are NOT re-rounded.
//
// These tests pin the primitive, the combo trade-off, and the one-copy rule.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { roundUpToRinggitSen, roundSen } from "../src/lib/utils.ts";
import { parseDiscountEntrySen } from "../src/lib/pricing.ts";
import { distributeComboUnitPrices } from "../src/api/lib/sofa-combo.ts";

// fileURLToPath (NOT URL.pathname): on Windows .pathname yields "/C:/…" which
// path.join then mangles into "C:\C:\…". This resolves correctly on all OSes.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// ── 1. the primitive ────────────────────────────────────────────────────────

test("roundUpToRinggitSen: the owner's two worked examples", () => {
  assert.equal(roundUpToRinggitSen(99514), 99600, "RM 995.14 → RM 996");
  assert.equal(roundUpToRinggitSen(30501), 30600, "RM 305.01 → RM 306");
});

test("an already-whole value is returned UNCHANGED — round-up must not add a ringgit", () => {
  assert.equal(roundUpToRinggitSen(30500), 30500, "RM 305.00 stays RM 305.00");
  assert.equal(roundUpToRinggitSen(0), 0);
  assert.equal(roundUpToRinggitSen(100), 100);
  assert.equal(roundUpToRinggitSen(1234500), 1234500);
});

test("it rounds UP, never to nearest — a .01 ending still gains a whole ringgit", () => {
  assert.equal(roundUpToRinggitSen(99501), 99600, "not 99500 (nearest would be)");
  assert.equal(roundUpToRinggitSen(99599), 99600);
  assert.equal(roundUpToRinggitSen(99598), 99600, "the .98 ending that started this");
});

test("fractional-sen float noise cannot silently buy an extra ringgit", () => {
  // A prorated product like 30500 * (1/3) * 3 lands a hair off an exact value.
  assert.equal(roundUpToRinggitSen(30500.0000001), 30500);
  assert.equal(roundUpToRinggitSen(30499.9999999), 30500);
  // but a real sub-ringgit remainder still rounds up
  assert.equal(roundUpToRinggitSen(30500.6), 30600);
});

test("non-finite input degrades to 0 rather than NaN-poisoning a money column", () => {
  assert.equal(roundUpToRinggitSen(NaN), 0);
  assert.equal(roundUpToRinggitSen(Infinity), 0);
});

test("roundSen is untouched — SST and every other cents figure still round to nearest sen", () => {
  // Guard for owner rule 3: the round-UP policy must not leak into the existing
  // whole-sen primitive that tax/payroll/allocation figures go through.
  assert.equal(roundSen(99514.4), 99514);
  assert.equal(roundSen(99514.6), 99515);
  assert.equal(roundSen(60), 60, "a 60-sen SST figure keeps its cents");
});

// ── 2. the % discount producer ──────────────────────────────────────────────

test("a % discount produces a WHOLE ringgit result", () => {
  // 15% of RM 995 = RM 149.25 → RM 150. Without this, a whole unit price ×
  // qty minus 149.25 puts the cents straight back into the line total.
  assert.equal(parseDiscountEntrySen("15%", 99500), 15000);
  assert.equal(parseDiscountEntrySen("15%", 99500) % 100, 0);
  // an exact percentage is not inflated by a ringgit
  assert.equal(parseDiscountEntrySen("20%", 100000), 20000);
  assert.equal(parseDiscountEntrySen("100%", 99500), 99500);
  assert.equal(parseDiscountEntrySen("0%", 99500), 0);
});

test("a whole unit price minus a whole % discount leaves a whole line total", () => {
  const unitSen = 99600; // RM 996, post-policy
  const qty = 3;
  const discountSen = parseDiscountEntrySen("15%", unitSen * qty);
  assert.equal((unitSen * qty - discountSen) % 100, 0);
});

test("a TYPED RM discount is left exactly as typed — a typed value is not a computed one", () => {
  assert.equal(parseDiscountEntrySen("50.50", 99500), 5050);
  assert.equal(parseDiscountEntrySen("50", 99500), 5000);
  assert.equal(parseDiscountEntrySen("", 99500), null);
  assert.equal(parseDiscountEntrySen("abc", 99500), null);
  assert.equal(parseDiscountEntrySen("x%", 99500), null);
});

// ── 3. the combo trade-off — THE decision this policy forced ────────────────
//
// Sofa-combo proration exists to make N piece prices sum EXACTLY to a
// negotiated combo total. Rounding every unit UP would push the pieces above
// that agreed figure. The DECISION (implemented in distributeComboUnitPrices):
// round every unit up, then GIVE THE EXCESS BACK so the agreed combo total is
// held. An agreed customer price that silently grows is a dispute; a piece
// reading a ringgit under its neighbour is not.

test("COMBO INTENT: whole-ringgit units AND the agreed combo total is held", () => {
  // The real SO-2603-133 shape: RM 1,250 + RM 700 pieces, agreed combo
  // RM 1,707. Ideals 1,094.23 + 612.77 → rounded up 1,095 + 613 = RM 1,708.
  const bases = distributeComboUnitPrices(
    [
      { lineTotalSen: 125000, quantity: 1, surchargesPerUnitSen: 0 },
      { lineTotalSen: 70000, quantity: 1, surchargesPerUnitSen: 0 },
    ],
    170700,
  );
  assert.deepEqual(bases, [109400, 61300], "RM 1,094 + RM 613");
  for (const b of bases) assert.equal(b % 100, 0, "every unit is a whole ringgit");
  assert.equal(
    bases.reduce((s, b) => s + b, 0),
    170700,
    "the agreed RM 1,707 combo total must NOT grow — this is the whole point",
  );
});

test("COMBO INTENT: the give-back lands on the line the round-up flattered most", () => {
  // 2A prorates to 106,382.98 (gains 17.02 sen from rounding up); L prorates to
  // 93,617.02 (gains 82.98). L gives the ringgit back, not 2A.
  const bases = distributeComboUnitPrices(
    [
      { lineTotalSen: 125000, quantity: 1, surchargesPerUnitSen: 0 },
      { lineTotalSen: 110000, quantity: 1, surchargesPerUnitSen: 0 },
    ],
    200000,
  );
  assert.deepEqual(bases, [106400, 93600]);
  assert.equal(bases[0] + bases[1], 200000);
});

test("combo: three pieces still land whole AND on the agreed total", () => {
  const lines = [
    { lineTotalSen: 125000, quantity: 1, surchargesPerUnitSen: 0 },
    { lineTotalSen: 110000, quantity: 1, surchargesPerUnitSen: 0 },
    { lineTotalSen: 50000, quantity: 1, surchargesPerUnitSen: 0 },
  ];
  const bases = distributeComboUnitPrices(lines, 250000);
  for (const b of bases) assert.equal(b % 100, 0);
  assert.equal(bases.reduce((s, b) => s + b, 0), 250000);
});

test("combo: surcharges ride along — base + surcharges is the whole-ringgit UNIT", () => {
  // basePriceSen is what gets stored; the UNIT the customer sees is
  // base + divan/leg/special. It is the UNIT that must be whole.
  const lines = [
    { lineTotalSen: 133000, quantity: 1, surchargesPerUnitSen: 8000 },
    { lineTotalSen: 70000, quantity: 1, surchargesPerUnitSen: 0 },
  ];
  const bases = distributeComboUnitPrices(lines, 170700);
  const units = bases.map((b, i) => b + lines[i].surchargesPerUnitSen);
  for (const u of units) assert.equal(u % 100, 0, "unit price is whole");
  assert.equal(units.reduce((s, u) => s + u, 0), 170700);
});

test("combo: a group whose ideal split is ALREADY whole is not nudged up a ringgit", () => {
  const bases = distributeComboUnitPrices(
    [
      { lineTotalSen: 100000, quantity: 1, surchargesPerUnitSen: 0 },
      { lineTotalSen: 70000, quantity: 1, surchargesPerUnitSen: 0 },
    ],
    170000,
  );
  assert.deepEqual(bases, [100000, 70000]);
});

test("combo: an unprorateable group returns null so the caller leaves prices alone", () => {
  assert.equal(distributeComboUnitPrices([], 170700), null);
  assert.equal(distributeComboUnitPrices([{ lineTotalSen: 0, quantity: 1, surchargesPerUnitSen: 0 }], 170700), null);
  assert.equal(
    distributeComboUnitPrices([{ lineTotalSen: 100000, quantity: 1, surchargesPerUnitSen: 0 }], 0),
    null,
  );
});

test("combo: when the agreed total is UNREACHABLE from whole units, the miss is under RM 1", () => {
  // A combo rule priced with cents (RM 1,707.50) can't be hit by whole-ringgit
  // units. Documented behaviour: the group settles in [agreed, agreed + 0.99],
  // never keeping cents on a piece, and never drifting by a ringgit or more.
  const bases = distributeComboUnitPrices(
    [
      { lineTotalSen: 125000, quantity: 1, surchargesPerUnitSen: 0 },
      { lineTotalSen: 70000, quantity: 1, surchargesPerUnitSen: 0 },
    ],
    170750,
  );
  const sum = bases.reduce((s, b) => s + b, 0);
  for (const b of bases) assert.equal(b % 100, 0);
  assert.ok(sum >= 170750 && sum < 170750 + 100, `sum ${sum} within [170750, 170849]`);
});

// ── 4. ONE copy of the rule ─────────────────────────────────────────────────

const walk = (dir) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
};

test("nobody hand-rolls Math.ceil(x / 100) * 100 — roundUpToRinggitSen is the only copy", () => {
  const offenders = [];
  for (const f of walk(SRC)) {
    const src = readFileSync(f, "utf8");
    if (/Math\.ceil\s*\([^)]*\/\s*100\s*\)\s*\*\s*100/.test(src)) {
      // Normalize separators so the utils.ts exclusion holds on Windows too
      // (walk() yields backslash paths there).
      const rel = f.slice(SRC.length).replace(/\\/g, "/");
      if (rel !== "lib/utils.ts") offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], "use roundUpToRinggitSen from @/lib/utils");
});

test("the combo distribution has ONE implementation — the create page imports it", () => {
  const page = readFileSync(join(SRC, "pages/sales/create.tsx"), "utf8");
  assert.ok(
    /import \{ distributeComboUnitPrices \} from "@\/api\/lib\/sofa-combo"/.test(page),
    "src/pages/sales/create.tsx must call the shared distributor, not re-derive it",
  );
  assert.ok(
    !/adjustedLineTotal/.test(page),
    "the create page's own floor/round/residual copy must stay deleted",
  );
});
