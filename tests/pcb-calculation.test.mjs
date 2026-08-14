// ---------------------------------------------------------------------------
// pcb-calculation.test.mjs — BUG-2026-08-13-121.
//
// PCB (Potongan Cukai Berjadual) was never calculated: `calcStatutory` read the
// per-worker toggle and returned `pcbOn ? 0 : 0` — the same number on both
// branches — so net pay on every payslip was overstated by whatever should have
// been withheld. C15 row 36 in docs/BUG-CLASSES.md.
//
// This file asserts the ENGINE's behaviour (src/lib/pcb.ts): what the money is,
// and — just as load-bearing — that it refuses to produce a number when the
// employee's tax declaration is missing. A wrong withholding is worse than an
// absent one in both directions: too little and the employee owes LHDN later,
// too much and payroll has taken their money now.
//
// The source-level guards (the toggle is honoured, no site re-hardcodes a PCB
// figure, the screens print "—" rather than RM 0.00) live in
// tests/pcb-not-fabricated.test.mjs.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePcb,
  residentPcbSen,
  residentTaxSen,
  residentRebateSen,
  projectedChargeableIncomeSen,
  nonResidentPcbSen,
  roundUpTo5Sen,
  childReliefSenFor,
  scheduleCoversYear,
  RESIDENT_TAX_BANDS,
  REBATE_CEILING_SEN,
  REBATE_SEN,
  EPF_RELIEF_CAP_SEN,
  RESIDENT_SCHEDULE_FIRST_YA,
  RESIDENT_SCHEDULE_LAST_YA,
  NON_RESIDENT_FLAT_RATE_PCT,
} from "../src/lib/pcb.ts";

import {
  calcStatutory,
  taxProfileFromWorkerRow,
} from "../src/api/routes/payslips.ts";
import { DEFAULT_PAY_RULES } from "../src/lib/pay-rules.ts";

const RM = (ringgit) => Math.round(ringgit * 100);
const YEAR = RESIDENT_SCHEDULE_FIRST_YA;

/** A January run with no year-to-date history — the simplest normal month. */
function january(over = {}) {
  return {
    pcbEnabled: true,
    year: YEAR,
    monthIndex: 1,
    profile: { residency: "RESIDENT", category: "SINGLE", childReliefSen: 0 },
    currentRemunerationSen: 0,
    currentEpfSen: 0,
    ytdRemunerationSen: 0,
    ytdEpfSen: 0,
    ytdPcbSen: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. The rate schedule, and the B column it implies
// ---------------------------------------------------------------------------

test("the schedule is progressive, starts at zero, and is strictly ordered", () => {
  assert.equal(RESIDENT_TAX_BANDS[0].fromSen, 0);
  assert.equal(RESIDENT_TAX_BANDS[0].ratePct, 0);
  for (let i = 1; i < RESIDENT_TAX_BANDS.length; i++) {
    assert.ok(
      RESIDENT_TAX_BANDS[i].fromSen > RESIDENT_TAX_BANDS[i - 1].fromSen,
      `band ${i} floor must exceed band ${i - 1}`,
    );
    assert.ok(
      RESIDENT_TAX_BANDS[i].ratePct > RESIDENT_TAX_BANDS[i - 1].ratePct,
      `band ${i} rate must exceed band ${i - 1}`,
    );
  }
  // The rebate ceiling has to BE a band boundary, or the ((P−M)×R+B) form
  // breaks: a band straddling RM 35,000 would need two different B values.
  assert.ok(
    RESIDENT_TAX_BANDS.some((b) => b.fromSen === REBATE_CEILING_SEN),
    "RM 35,000 must be a band boundary",
  );
});

test("the B column derived from the schedule matches LHDN's published Category 1 & 3 figures", () => {
  // B is defined as the accumulated tax at the band floor, net of the rebate
  // that applies INSIDE the band (a band above RM 35,000 gets none). LHDN
  // publishes these; deriving them from the schedule instead of typing them in
  // means a mistyped band floor or rate shows up here as a wrong B.
  //
  // ⚠️ These are the figures for the YA2023-onward schedule. Confirm against
  // LHDN's current MTD specification before enabling PCB for a new year of
  // assessment — extending RESIDENT_SCHEDULE_LAST_YA without re-checking is
  // exactly how a stale schedule gets applied to a re-rated year.
  const expectedB = [-400, -400, -250, 600, 1500, 3700, 9400, 84400, 136400, 528400];
  assert.equal(RESIDENT_TAX_BANDS.length, expectedB.length);
  RESIDENT_TAX_BANDS.forEach((band, i) => {
    const rebateInsideBand = band.fromSen < REBATE_CEILING_SEN ? REBATE_SEN : 0;
    const bSen = residentTaxSen(band.fromSen) - rebateInsideBand;
    assert.equal(bSen, RM(expectedB[i]), `B for band floor ${band.fromSen} sen`);
  });
});

test("((P − M) × R + B) reproduces tax(P) − rebate(P) at every point in every band", () => {
  // This is the identity LHDN's formula rests on. Asserting it directly means
  // the module's arithmetic IS the published method, not a lookalike.
  for (const category of ["SINGLE", "MARRIED_SPOUSE_NOT_WORKING", "MARRIED_SPOUSE_WORKING"]) {
    RESIDENT_TAX_BANDS.forEach((band, i) => {
      const next = RESIDENT_TAX_BANDS[i + 1];
      const M = band.fromSen;
      const rebateInsideBand =
        M < REBATE_CEILING_SEN ? residentRebateSen(M, category) : 0;
      const B = residentTaxSen(M) - rebateInsideBand;
      const top = next ? next.fromSen : M + RM(500_000);
      // Sample the interior of the band. P = M itself belongs to the band
      // BELOW (LHDN's ranges are M+1 … next M), so it is excluded here.
      const samples = [M + 100, Math.floor((M + top) / 2 / 100) * 100, top];
      for (const p of samples) {
        if (p <= M) continue;
        const viaFormula = Math.round(((p - M) * band.ratePct) / 100) + B;
        const direct = residentTaxSen(p) - residentRebateSen(p, category);
        assert.equal(
          viaFormula,
          direct,
          `category ${category}, band floor ${M}, P ${p}`,
        );
      }
    });
  }
});

test("Category 2 claims a second rebate, and only at or below the ceiling", () => {
  assert.equal(residentRebateSen(REBATE_CEILING_SEN, "SINGLE"), REBATE_SEN);
  assert.equal(
    residentRebateSen(REBATE_CEILING_SEN, "MARRIED_SPOUSE_NOT_WORKING"),
    REBATE_SEN * 2,
  );
  assert.equal(
    residentRebateSen(REBATE_CEILING_SEN, "MARRIED_SPOUSE_WORKING"),
    REBATE_SEN,
    "a working spouse is Category 3 — no spouse rebate",
  );
  assert.equal(residentRebateSen(REBATE_CEILING_SEN + 100, "MARRIED_SPOUSE_NOT_WORKING"), 0);
});

// ---------------------------------------------------------------------------
// 2. Known monthly figures
// ---------------------------------------------------------------------------

test("RM 5,000/month, single, EPF at 11% → RM 110.00 withheld each month", () => {
  // P = 12 × 5,000 − 4,000 (EPF, capped) − 9,000 = 47,000.
  // Tax = 150 + 450 + 6% × 12,000 = 1,320. Over 35,000 ⇒ no rebate.
  // MTD = 1,320 ÷ 12 = 110.00.
  const p = projectedChargeableIncomeSen({
    monthIndex: 1,
    currentRemunerationSen: RM(5000),
    currentEpfSen: RM(550),
    ytdRemunerationSen: 0,
    ytdEpfSen: 0,
    category: "SINGLE",
    childReliefSen: 0,
  });
  assert.equal(p, RM(47_000));
  assert.equal(residentTaxSen(p), RM(1320));
  assert.equal(residentRebateSen(p, "SINGLE"), 0);

  const out = resolvePcb(
    january({
      currentRemunerationSen: RM(5000),
      currentEpfSen: RM(550),
    }),
  );
  assert.equal(out.status, "COMPUTED");
  assert.equal(out.pcbSen, RM(110));
});

test("RM 3,000/month, single, no EPF → nothing is due (the rebate absorbs the tax)", () => {
  // P = 36,000 − 9,000 = 27,000 → tax 360, rebate 400 → nothing to withhold.
  const out = resolvePcb(january({ currentRemunerationSen: RM(3000) }));
  assert.equal(out.status, "COMPUTED");
  assert.equal(out.pcbSen, 0);
});

test("the first ringgit of PCB appears just above the rebate-absorbed band", () => {
  const at = (monthlyRM) =>
    residentPcbSen({
      monthIndex: 1,
      currentRemunerationSen: RM(monthlyRM),
      currentEpfSen: 0,
      ytdRemunerationSen: 0,
      ytdEpfSen: 0,
      ytdPcbSen: 0,
      category: "SINGLE",
      childReliefSen: 0,
    });
  // P = 12G − 9,000. Tax reaches the RM 400 rebate at P = 28,333.33, i.e.
  // G = 3,111.11. RM 3,111 is still absorbed; RM 3,112 is not.
  assert.equal(at(3111), 0);
  assert.ok(at(3112) > 0, "RM 3,112/month must produce a withholding");
  assert.ok(at(3112) < RM(1), "and it must be a few sen, not a few ringgit");
});

test("a married sole earner with children pays less than a single earner on the same salary", () => {
  const input = {
    monthIndex: 1,
    currentRemunerationSen: RM(6000),
    currentEpfSen: RM(660),
    ytdRemunerationSen: 0,
    ytdEpfSen: 0,
    ytdPcbSen: 0,
  };
  const single = residentPcbSen({ ...input, category: "SINGLE", childReliefSen: 0 });
  const marriedWorkingSpouse = residentPcbSen({
    ...input,
    category: "MARRIED_SPOUSE_WORKING",
    childReliefSen: 0,
  });
  const soleEarner = residentPcbSen({
    ...input,
    category: "MARRIED_SPOUSE_NOT_WORKING",
    childReliefSen: 0,
  });
  const soleEarnerTwoKids = residentPcbSen({
    ...input,
    category: "MARRIED_SPOUSE_NOT_WORKING",
    childReliefSen: childReliefSenFor({ ordinary: 2 }),
  });
  assert.equal(
    single,
    marriedWorkingSpouse,
    "Categories 1 and 3 are arithmetically identical — that is why LHDN gives them one B column",
  );
  assert.ok(soleEarner < single, "spouse relief must reduce the withholding");
  assert.ok(soleEarnerTwoKids < soleEarner, "child relief must reduce it further");
});

test("child relief follows the LHDN rate for the CHILD, not a flat per-head figure", () => {
  assert.equal(childReliefSenFor({ ordinary: 3 }), RM(6000));
  assert.equal(childReliefSenFor({ tertiary: 1 }), RM(8000));
  assert.equal(childReliefSenFor({ disabled: 1 }), RM(6000));
  assert.equal(childReliefSenFor({ disabledTertiary: 1 }), RM(14_000));
  assert.equal(
    childReliefSenFor({ ordinary: 2, tertiary: 1 }),
    RM(12_000),
    "a headcount × RM 2,000 would say RM 6,000 and over-withhold from this employee",
  );
  assert.equal(childReliefSenFor({}), 0);
  assert.equal(childReliefSenFor({ ordinary: -4 }), 0);
});

// ---------------------------------------------------------------------------
// 3. Projection, year-to-date and the EPF cap
// ---------------------------------------------------------------------------

test("the EPF relief is capped at RM 4,000 for the year, however much was contributed", () => {
  const p = projectedChargeableIncomeSen({
    monthIndex: 1,
    currentRemunerationSen: RM(10_000),
    currentEpfSen: RM(1100), // RM 13,200/yr — far over the cap
    ytdRemunerationSen: 0,
    ytdEpfSen: 0,
    category: "SINGLE",
    childReliefSen: 0,
  });
  assert.equal(p, RM(120_000) - EPF_RELIEF_CAP_SEN - RM(9000));
});

test("a mid-year month projects the remaining months and spreads over them", () => {
  // June (month 6): five months already paid, six remaining after this one.
  const monthly = RM(5000);
  const epf = RM(550);
  const june = residentPcbSen({
    monthIndex: 6,
    currentRemunerationSen: monthly,
    currentEpfSen: epf,
    ytdRemunerationSen: monthly * 5,
    ytdEpfSen: epf * 5,
    ytdPcbSen: 0,
    category: "SINGLE",
    childReliefSen: 0,
  });
  // Same annual picture as the January case (RM 1,320 for the year) but with
  // nothing withheld so far, so the whole year's tax lands over 7 months.
  assert.equal(june, roundUpTo5Sen(RM(1320) / 7));
});

test("PCB already withheld this year (X) reduces what is still to come", () => {
  const base = {
    monthIndex: 6,
    currentRemunerationSen: RM(5000),
    currentEpfSen: RM(550),
    ytdRemunerationSen: RM(25_000),
    ytdEpfSen: RM(2750),
    category: "SINGLE",
    childReliefSen: 0,
  };
  const withNothingWithheld = residentPcbSen({ ...base, ytdPcbSen: 0 });
  const withHalfWithheld = residentPcbSen({ ...base, ytdPcbSen: RM(660) });
  assert.ok(withHalfWithheld < withNothingWithheld);
  // Everything already withheld ⇒ nothing left, and never a negative deduction
  // (an over-withholding is refunded on assessment, not clawed back on a slip).
  assert.equal(residentPcbSen({ ...base, ytdPcbSen: RM(99_999) }), 0);
});

test("December has no months left to spread over", () => {
  const dec = residentPcbSen({
    monthIndex: 12,
    currentRemunerationSen: RM(5000),
    currentEpfSen: RM(550),
    ytdRemunerationSen: RM(55_000),
    ytdEpfSen: RM(6050),
    ytdPcbSen: RM(1210), // eleven months at RM 110
    category: "SINGLE",
    childReliefSen: 0,
  });
  assert.equal(dec, RM(110));
});

// ---------------------------------------------------------------------------
// 4. Money hygiene
// ---------------------------------------------------------------------------

test("every result is an integer number of sen, rounded up to the next 5", () => {
  assert.equal(roundUpTo5Sen(0), 0);
  assert.equal(roundUpTo5Sen(1), 5);
  assert.equal(roundUpTo5Sen(5), 5);
  assert.equal(roundUpTo5Sen(6), 10);
  assert.equal(roundUpTo5Sen(1000.4), 1005);
  for (let rm = 2500; rm <= 12_000; rm += 137) {
    const sen = residentPcbSen({
      monthIndex: 1,
      currentRemunerationSen: RM(rm),
      currentEpfSen: Math.round(RM(rm) * 0.11),
      ytdRemunerationSen: 0,
      ytdEpfSen: 0,
      ytdPcbSen: 0,
      category: "SINGLE",
      childReliefSen: 0,
    });
    assert.ok(Number.isInteger(sen), `RM ${rm} produced non-integer sen ${sen}`);
    assert.equal(sen % 5, 0, `RM ${rm} produced ${sen} sen, not a multiple of 5`);
    assert.ok(sen >= 0);
  }
});

// ---------------------------------------------------------------------------
// 5. Non-residents
// ---------------------------------------------------------------------------

test("a non-resident is withheld a flat rate on gross, with no reliefs at all", () => {
  assert.equal(nonResidentPcbSen(RM(3000)), RM(3000 * (NON_RESIDENT_FLAT_RATE_PCT / 100)));
  const out = resolvePcb(
    january({
      profile: { residency: "NON_RESIDENT", category: null, childReliefSen: null },
      currentRemunerationSen: RM(3000),
    }),
  );
  assert.equal(out.status, "COMPUTED");
  assert.equal(out.pcbSen, RM(900));
  assert.deepEqual(out.missing, [], "a non-resident needs no category or child relief");
  // The same pay as a RESIDENT single with no children is nil — which is the
  // whole reason residency may not be assumed.
  const asResident = resolvePcb(january({ currentRemunerationSen: RM(3000) }));
  assert.equal(asResident.pcbSen, 0);
});

// ---------------------------------------------------------------------------
// 6. Refusing to guess — the part that matters most
// ---------------------------------------------------------------------------

test("the per-worker toggle is honoured, and OFF is an answer rather than a gap", () => {
  const out = resolvePcb(january({ pcbEnabled: false, currentRemunerationSen: RM(20_000) }));
  assert.equal(out.status, "DISABLED");
  assert.equal(out.pcbSen, 0);
  assert.deepEqual(out.missing, []);
  // NULL / undefined reads as enabled, like the other three statutory flags.
  for (const flag of [null, undefined, true]) {
    assert.notEqual(
      resolvePcb(january({ pcbEnabled: flag, currentRemunerationSen: RM(20_000) })).status,
      "DISABLED",
      `pcbEnabled=${String(flag)} must not read as OFF`,
    );
  }
});

test("an unrecorded residency refuses outright — it cannot be inferred from pay", () => {
  const out = resolvePcb(
    january({
      profile: { residency: null, category: "SINGLE", childReliefSen: 0 },
      currentRemunerationSen: RM(20_000),
    }),
  );
  assert.equal(out.status, "UNKNOWN");
  assert.equal(out.pcbSen, 0);
  assert.deepEqual(out.missing, ["taxResidency"]);
  assert.match(out.note, /not computed/i);
  assert.match(out.note, /residency/i);
});

test("an incomplete declaration on a high salary refuses, naming what is missing", () => {
  const out = resolvePcb(
    january({
      profile: { residency: "RESIDENT", category: null, childReliefSen: null },
      currentRemunerationSen: RM(20_000),
    }),
  );
  assert.equal(out.status, "UNKNOWN");
  assert.equal(out.pcbSen, 0);
  assert.deepEqual(out.missing, ["taxCategory", "taxChildRelief"]);
});

test("an incomplete declaration on a low salary still resolves — zero is PROVEN there", () => {
  const out = resolvePcb(
    january({
      profile: { residency: "RESIDENT", category: null, childReliefSen: null },
      currentRemunerationSen: RM(2000),
    }),
  );
  assert.equal(out.status, "ZERO_PROVEN");
  assert.equal(out.pcbSen, 0);
  assert.deepEqual(out.missing, []);
});

test("ZERO_PROVEN is not reached when a GENEROUS profile would zero it but the least-relief one would not", () => {
  // RM 3,500/month, no EPF. Category 1 with no children owes ~RM 11.67 a
  // month; a married sole earner with two children owes nothing. The answer
  // therefore DEPENDS on the missing declaration, and the only honest output
  // is a refusal. If the ceiling is ever computed from a kinder profile than
  // Category 1 / no relief, this case silently starts under-withholding.
  const out = resolvePcb(
    january({
      profile: { residency: "RESIDENT", category: null, childReliefSen: null },
      currentRemunerationSen: RM(3500),
    }),
  );
  assert.equal(out.status, "UNKNOWN");
  assert.equal(out.pcbSen, 0);

  const shared = {
    monthIndex: 1,
    currentRemunerationSen: RM(3500),
    currentEpfSen: 0,
    ytdRemunerationSen: 0,
    ytdEpfSen: 0,
    ytdPcbSen: 0,
  };
  assert.ok(residentPcbSen({ ...shared, category: "SINGLE", childReliefSen: 0 }) > 0);
  assert.equal(
    residentPcbSen({
      ...shared,
      category: "MARRIED_SPOUSE_NOT_WORKING",
      childReliefSen: childReliefSenFor({ ordinary: 2 }),
    }),
    0,
  );
});

test("the ZERO_PROVEN proof holds: no resident profile ever pays more than Category 1 with no children", () => {
  // The proof this module leans on. Relief only ever reduces the chargeable
  // income and the spouse rebate only ever reduces the tax, so Category 1 with
  // zero child relief is the ceiling over the whole profile grid. If that
  // stops being true the ZERO_PROVEN branch starts under-withholding, so it is
  // asserted rather than argued.
  const categories = ["SINGLE", "MARRIED_SPOUSE_NOT_WORKING", "MARRIED_SPOUSE_WORKING"];
  const reliefs = [
    0,
    childReliefSenFor({ ordinary: 1 }),
    childReliefSenFor({ ordinary: 5 }),
    childReliefSenFor({ tertiary: 2 }),
    childReliefSenFor({ disabledTertiary: 3 }),
  ];
  for (let rm = 1000; rm <= 30_000; rm += 431) {
    for (let month = 1; month <= 12; month++) {
      const shared = {
        monthIndex: month,
        currentRemunerationSen: RM(rm),
        currentEpfSen: Math.round(RM(rm) * 0.11),
        ytdRemunerationSen: RM(rm) * (month - 1),
        ytdEpfSen: Math.round(RM(rm) * 0.11) * (month - 1),
        ytdPcbSen: 0,
      };
      const ceiling = residentPcbSen({ ...shared, category: "SINGLE", childReliefSen: 0 });
      for (const category of categories) {
        for (const childReliefSen of reliefs) {
          assert.ok(
            residentPcbSen({ ...shared, category, childReliefSen }) <= ceiling,
            `RM ${rm}, month ${month}, ${category}, relief ${childReliefSen} exceeded the ceiling`,
          );
        }
      }
    }
  }
});

test("a year of assessment with no schedule loaded refuses instead of reusing an old one", () => {
  assert.ok(scheduleCoversYear(RESIDENT_SCHEDULE_FIRST_YA));
  assert.ok(scheduleCoversYear(RESIDENT_SCHEDULE_LAST_YA));
  assert.equal(scheduleCoversYear(RESIDENT_SCHEDULE_FIRST_YA - 1), false);
  assert.equal(scheduleCoversYear(RESIDENT_SCHEDULE_LAST_YA + 1), false);
  const out = resolvePcb(
    january({ year: RESIDENT_SCHEDULE_LAST_YA + 1, currentRemunerationSen: RM(20_000) }),
  );
  assert.equal(out.status, "UNKNOWN");
  assert.deepEqual(out.missing, ["taxSchedule"]);
  assert.equal(out.pcbSen, 0);
});

test("a non-COMPUTED outcome never carries a withholding", () => {
  const cases = [
    january({ pcbEnabled: false, currentRemunerationSen: RM(50_000) }),
    january({
      profile: { residency: null, category: null, childReliefSen: null },
      currentRemunerationSen: RM(50_000),
    }),
    january({
      profile: { residency: "RESIDENT", category: null, childReliefSen: null },
      currentRemunerationSen: RM(50_000),
    }),
    january({ year: 1999, currentRemunerationSen: RM(50_000) }),
  ];
  for (const input of cases) {
    const out = resolvePcb(input);
    assert.notEqual(out.status, "COMPUTED");
    assert.equal(out.pcbSen, 0, `${out.status} must not carry a figure`);
  }
});

// ---------------------------------------------------------------------------
// 7. The payroll block itself — what actually lands on a payslip
// ---------------------------------------------------------------------------
// The engine is pure; these assert the money the ROUTE hands to the payslip,
// because that is where the bug lived: `calcStatutory` had the toggle in its
// hand and returned nothing either way.

function statutoryFor(over = {}) {
  const {
    flags = {},
    profile = { residency: null, category: null, childReliefSen: null },
    basicSalarySen = RM(3000),
    remunerationSen = RM(3000),
    monthIndex = 1,
    ytd = { ytdRemunerationSen: 0, ytdEpfSen: 0, ytdPcbSen: 0 },
  } = over;
  return calcStatutory(basicSalarySen, flags, DEFAULT_PAY_RULES, {
    year: YEAR,
    monthIndex,
    remunerationSen,
    profile,
    ...ytd,
  });
}

test("a worker who is not registered for PCB has nothing withheld, and that is an ANSWER", () => {
  const stat = statutoryFor({
    flags: { pcbEnabled: false, epfEnabled: false, socsoEnabled: false, eisEnabled: false },
    basicSalarySen: RM(20_000),
    remunerationSen: RM(20_000),
  });
  assert.equal(stat.pcb, 0);
  assert.equal(stat.pcbStatus, "DISABLED");
  const totalDeductions =
    stat.epfEmployee + stat.socsoEmployee + stat.eisEmployee + stat.pcb;
  assert.equal(totalDeductions, 0, "all four off ⇒ net pay equals gross pay");
});

test("a registered worker with no tax declaration is not silently withheld from — nor told nothing was due", () => {
  const stat = statutoryFor({
    flags: { pcbEnabled: true, epfEnabled: true },
    basicSalarySen: RM(20_000),
    remunerationSen: RM(20_000),
  });
  assert.equal(stat.pcbStatus, "UNKNOWN");
  assert.equal(stat.pcb, 0);
  assert.deepEqual(stat.pcbMissing, ["taxResidency"]);
  assert.match(stat.pcbNote, /does NOT include any tax withholding/);
  // EPF is untouched by any of this — the four lines are independent.
  assert.equal(stat.epfEmployee, Math.round(RM(20_000) * 0.11));
});

test("a declared resident IS withheld from, and the withholding reaches total deductions", () => {
  const stat = statutoryFor({
    flags: { pcbEnabled: true, epfEnabled: true, socsoEnabled: true, eisEnabled: true },
    profile: { residency: "RESIDENT", category: "SINGLE", childReliefSen: 0 },
    basicSalarySen: RM(5000),
    remunerationSen: RM(5000),
  });
  assert.equal(stat.pcbStatus, "COMPUTED");
  assert.equal(stat.pcb, RM(110));
  const totalDeductions =
    stat.epfEmployee + stat.socsoEmployee + stat.eisEmployee + stat.pcb;
  const withoutPcb = totalDeductions - stat.pcb;
  assert.equal(
    totalDeductions - withoutPcb,
    RM(110),
    "net pay is now RM 110 lower than it was before this fix — that is the bug, priced",
  );
});

test("EPF switched off removes the EPF relief too, so the withholding rises", () => {
  const base = {
    flags: { pcbEnabled: true },
    profile: { residency: "RESIDENT", category: "SINGLE", childReliefSen: 0 },
    basicSalarySen: RM(5000),
    remunerationSen: RM(5000),
  };
  const withEpf = statutoryFor({ ...base, flags: { ...base.flags, epfEnabled: true } });
  const withoutEpf = statutoryFor({ ...base, flags: { ...base.flags, epfEnabled: false } });
  assert.equal(withoutEpf.epfEmployee, 0);
  assert.ok(
    withoutEpf.pcb > withEpf.pcb,
    "no EPF contribution ⇒ no EPF relief ⇒ more chargeable income",
  );
});

test("the worker row's tax columns are read dual-keyed, and anything that is not a valid declaration reads as UNDECLARED", () => {
  assert.deepEqual(
    taxProfileFromWorkerRow({
      taxResidency: "RESIDENT",
      taxCategory: "MARRIED_SPOUSE_WORKING",
      taxChildReliefSen: 400_000,
    }),
    { residency: "RESIDENT", category: "MARRIED_SPOUSE_WORKING", childReliefSen: 400_000 },
  );
  assert.deepEqual(
    taxProfileFromWorkerRow({
      tax_residency: "non_resident",
      tax_category: "single",
      tax_child_relief_sen: "0",
    }),
    { residency: "NON_RESIDENT", category: "SINGLE", childReliefSen: 0 },
    "snake_case and lower case still resolve; a declared 0 child relief survives",
  );
  assert.deepEqual(
    taxProfileFromWorkerRow({ taxResidency: "", taxCategory: "MARRIED", taxChildReliefSen: null }),
    { residency: null, category: null, childReliefSen: null },
    "a blank, a typo and a NULL are all NOT DECLARED — never a default",
  );
  assert.equal(taxProfileFromWorkerRow({}).residency, null);
  assert.equal(taxProfileFromWorkerRow({ taxChildReliefSen: -1 }).childReliefSen, null);
});
