// ---------------------------------------------------------------------------
// PCB (Potongan Cukai Berjadual) — the Malaysian monthly tax deduction.
//
// WHAT THIS REPLACES. `calcStatutory` used to read the per-worker toggle and
// then return the same number on both branches:
//
//     pcb: pcbOn ? 0 : 0,
//
// so PCB has never been withheld by this system. That figure flows into
// totalDeductions and from there into NET PAY, under a Payroll tooltip that
// lists PCB as one of the deductions included. It is C15 row 36 in
// docs/BUG-CLASSES.md — a figure that reads as measured and is not.
//
// WHAT THIS MODULE WILL AND WILL NOT DO.
//
// PCB is a legal withholding. Getting it wrong costs the employee real money
// in one direction (over-withholding takes their cash now) and costs them a
// bill from LHDN in the other (under-withholding). So this module NEVER
// returns a plausible number: every path returns a discriminated `PcbOutcome`
// whose `status` says where the figure came from, and `pcbSen` is a real
// withholding ONLY when status is "COMPUTED". When an input the computation
// depends on is absent, the answer is UNKNOWN and the screen must print "—",
// not RM 0.00. "Zero withheld" and "not computed" are different statements
// about someone's pay.
//
// THE METHOD. LHDN's Computerised Calculation Method for a NORMAL
// remuneration month (Income Tax (Deduction from Remuneration) Rules 1994):
//
//     MTD = [ ((P − M) × R + B) − (Z + X) ] ÷ (n + 1)
//
//     P = Σ(Y−K) + (Y1−K1) + (Y2−K2)×n + (Yt−Kt) − [ D + S + Q + LP ]
//
// with P the projected annual chargeable income, M/R/B the band floor / rate /
// accumulated tax, Z accumulated zakat, X the MTD already withheld this year,
// and n the months remaining after this one.
//
// ((P − M) × R + B) is, by construction, `progressive tax on P` minus the
// individual (and, for Category 2, spouse) rebate. This module computes it
// that way — from the rate schedule and the rebate rule — rather than typing
// LHDN's pre-computed B column in as constants. A constant typed from memory
// is unverifiable; arithmetic over a schedule is checkable, and
// tests/pcb-calculation.test.mjs cross-checks the derived B values against
// LHDN's published table so a wrong band shows up as a wrong B.
//
// ADDITIONAL remuneration (bonus, arrears, director's fee) uses a DIFFERENT
// LHDN procedure and is deliberately NOT implemented here — see
// `PCB_NOT_IMPLEMENTED` at the bottom. This module is for the normal monthly
// run, which is the only thing POST /api/payslips produces.
//
// Money is integer sen throughout (RM × 100). Never floats.
// ---------------------------------------------------------------------------

/** Tax residency for the year of assessment. NOT the same thing as
 *  nationality: a foreign worker in Malaysia for ≥182 days in the basis year
 *  IS a tax resident, and a Malaysian posted abroad may not be. `nationality`
 *  on `workers` therefore cannot answer this and must not be used to. */
export type TaxResidency = "RESIDENT" | "NON_RESIDENT";

/** LHDN's three MTD categories. Category 1 (single) and Category 3 (married,
 *  spouse working) are arithmetically identical — neither claims spouse relief
 *  nor the spouse rebate — which is why LHDN publishes ONE B column for both.
 *  They are kept apart here because they are different declarations by the
 *  employee, and conflating them would make the stored profile unreadable. */
export type PcbCategory =
  /** Category 1 — single. */
  | "SINGLE"
  /** Category 2 — married, spouse not working (claims spouse relief). */
  | "MARRIED_SPOUSE_NOT_WORKING"
  /** Category 3 — married, spouse working. */
  | "MARRIED_SPOUSE_WORKING";

/**
 * The per-employee tax declaration. Every field is nullable and `null` means
 * NOT DECLARED — never "the default". There is no safe default: assuming
 * SINGLE over-withholds from a married sole earner, assuming RESIDENT
 * under-withholds from a non-resident by 30% of gross.
 */
export type PcbTaxProfile = {
  residency: TaxResidency | null;
  category: PcbCategory | null;
  /**
   * Annual child relief the employee has declared, in sen. `null` = not
   * declared. `0` is a legitimate declared value (no children).
   *
   * Stored as the RELIEF, not a headcount, because the per-child amount is not
   * a function of the count: LHDN gives RM 2,000 for an ordinary child,
   * RM 8,000 for one aged 18+ in full-time tertiary education, RM 6,000 for a
   * disabled child and RM 14,000 for a disabled child in tertiary education.
   * A count times 2,000 would silently over-withhold from anyone with a child
   * at university. `childReliefSenFor` builds the figure from the four counts.
   */
  childReliefSen: number | null;
};

export type PcbMissingInput =
  | "taxResidency"
  | "taxCategory"
  | "taxChildRelief"
  | "taxSchedule";

export type PcbStatus =
  /** The worker is not registered for PCB (`workers.pcb_enabled = false`).
   *  Withholding nothing is correct and intended, not a missing value. */
  | "DISABLED"
  /** Computed from a complete declaration. `pcbSen` is a real withholding. */
  | "COMPUTED"
  /** The declaration is incomplete, but the month's pay is low enough that the
   *  withholding is zero under the LEAST-relief profile any resident could
   *  have — so it is zero under every profile. A proven fact, not a default. */
  | "ZERO_PROVEN"
  /** An input the computation needs is missing. NOTHING is claimed. */
  | "UNKNOWN";

export type PcbOutcome = {
  status: PcbStatus;
  /** Integer sen to withhold. Zero on every status except COMPUTED, where it
   *  may still legitimately be zero. Never a guess. */
  pcbSen: number;
  /** Which declarations are missing. Non-empty only when status is UNKNOWN. */
  missing: PcbMissingInput[];
  /** One sentence for the screen, so the operator knows what to do. */
  note: string;
};

// ---------------------------------------------------------------------------
// The schedule. Resident rates as revised by Budget 2023, effective YA 2023.
//
// ⚠️ EFFECTIVE-DATED BY YEAR OF ASSESSMENT ON PURPOSE. `resolvePcb` refuses
// (UNKNOWN → the payslip prints "—") for any year outside the declared range
// instead of quietly applying a stale schedule to a year Parliament has
// re-rated. Extending the range is a deliberate act: confirm the schedule for
// the new YA, then move RESIDENT_SCHEDULE_LAST_YA and update the expectations
// in tests/pcb-calculation.test.mjs.
// ---------------------------------------------------------------------------
export const RESIDENT_SCHEDULE_FIRST_YA = 2023;
export const RESIDENT_SCHEDULE_LAST_YA = 2026;

/** Band floors in sen with the marginal rate that applies ABOVE each floor.
 *  Band i covers (fromSen, next.fromSen]. RM 5,000 = 500_000 sen. */
export const RESIDENT_TAX_BANDS: ReadonlyArray<{ fromSen: number; ratePct: number }> = [
  { fromSen: 0, ratePct: 0 },
  { fromSen: 500_000, ratePct: 1 },
  { fromSen: 2_000_000, ratePct: 3 },
  { fromSen: 3_500_000, ratePct: 6 },
  { fromSen: 5_000_000, ratePct: 11 },
  { fromSen: 7_000_000, ratePct: 19 },
  { fromSen: 10_000_000, ratePct: 25 },
  { fromSen: 40_000_000, ratePct: 26 },
  { fromSen: 60_000_000, ratePct: 28 },
  { fromSen: 200_000_000, ratePct: 30 },
];

/** Non-resident employment income is taxed at a flat rate with no reliefs and
 *  no rebate — the whole resident apparatus above does not apply. */
export const NON_RESIDENT_FLAT_RATE_PCT = 30;

/** Individual relief (D). RM 9,000. */
export const INDIVIDUAL_RELIEF_SEN = 900_000;
/** Spouse relief (S) — Category 2 only. RM 4,000. */
export const SPOUSE_RELIEF_SEN = 400_000;
/** Annual cap on the EPF relief (K). RM 4,000. */
export const EPF_RELIEF_CAP_SEN = 400_000;
/** Individual rebate, and the same again for a Category 2 spouse. RM 400. */
export const REBATE_SEN = 40_000;
/** The rebate applies only while chargeable income is at or below RM 35,000. */
export const REBATE_CEILING_SEN = 3_500_000;

/** The four LHDN child-relief rates, in sen. */
export const CHILD_RELIEF_RATES_SEN = {
  /** Ordinary child. RM 2,000. */
  ordinary: 200_000,
  /** Child 18+ in full-time tertiary education. RM 8,000. */
  tertiary: 800_000,
  /** Disabled child. RM 6,000. */
  disabled: 600_000,
  /** Disabled child in tertiary education. RM 14,000. */
  disabledTertiary: 1_400_000,
} as const;

/** Build the annual child relief from the counts the employee declared. */
export function childReliefSenFor(counts: {
  ordinary?: number;
  tertiary?: number;
  disabled?: number;
  disabledTertiary?: number;
}): number {
  const n = (v: number | undefined) => (Number.isFinite(v) && (v as number) > 0 ? Math.floor(v as number) : 0);
  return (
    n(counts.ordinary) * CHILD_RELIEF_RATES_SEN.ordinary +
    n(counts.tertiary) * CHILD_RELIEF_RATES_SEN.tertiary +
    n(counts.disabled) * CHILD_RELIEF_RATES_SEN.disabled +
    n(counts.disabledTertiary) * CHILD_RELIEF_RATES_SEN.disabledTertiary
  );
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** Income tax on a resident's chargeable income, before any rebate. Integer
 *  sen in, integer sen out. */
export function residentTaxSen(chargeableSen: number): number {
  const p = Math.max(0, Math.floor(chargeableSen));
  let tax = 0;
  for (let i = 0; i < RESIDENT_TAX_BANDS.length; i++) {
    const lo = RESIDENT_TAX_BANDS[i].fromSen;
    if (p <= lo) break;
    const hi =
      i + 1 < RESIDENT_TAX_BANDS.length
        ? RESIDENT_TAX_BANDS[i + 1].fromSen
        : Number.POSITIVE_INFINITY;
    tax += ((Math.min(p, hi) - lo) * RESIDENT_TAX_BANDS[i].ratePct) / 100;
  }
  return Math.round(tax);
}

/** The rebate a resident gets at this chargeable income. Category 2 claims the
 *  spouse rebate as well as the individual one. */
export function residentRebateSen(chargeableSen: number, category: PcbCategory): number {
  if (chargeableSen > REBATE_CEILING_SEN) return 0;
  return category === "MARRIED_SPOUSE_NOT_WORKING" ? REBATE_SEN * 2 : REBATE_SEN;
}

/** LHDN rounds the monthly deduction UP to the next 5 sen. */
export function roundUpTo5Sen(sen: number): number {
  return Math.ceil(sen / 5) * 5;
}

/** P — chargeable income projected over the year, floored to whole ringgit as
 *  LHDN's method requires. Exported for the tests, which assert the projection
 *  separately from the tax on it. */
export function projectedChargeableIncomeSen(a: {
  monthIndex: number;
  currentRemunerationSen: number;
  currentEpfSen: number;
  ytdRemunerationSen: number;
  ytdEpfSen: number;
  category: PcbCategory;
  childReliefSen: number;
}): number {
  // n = months remaining AFTER this one. LHDN projects the current month's
  // normal remuneration across them (Y2 = Y1, K2 = K1).
  const n = Math.max(0, 12 - a.monthIndex);
  const remuneration =
    a.ytdRemunerationSen + a.currentRemunerationSen * (1 + n);
  const epfUncapped = a.ytdEpfSen + a.currentEpfSen * (1 + n);
  const epfRelief = Math.min(epfUncapped, EPF_RELIEF_CAP_SEN);
  const spouse = a.category === "MARRIED_SPOUSE_NOT_WORKING" ? SPOUSE_RELIEF_SEN : 0;
  const chargeable =
    remuneration - epfRelief - INDIVIDUAL_RELIEF_SEN - spouse - Math.max(0, a.childReliefSen);
  // Floored to a whole ringgit (100 sen), never negative.
  return Math.max(0, Math.floor(chargeable / 100) * 100);
}

export type ResidentPcbInput = {
  /** 1–12, the month being paid. */
  monthIndex: number;
  currentRemunerationSen: number;
  currentEpfSen: number;
  /** Earlier months of the SAME calendar year that were actually paid. */
  ytdRemunerationSen: number;
  ytdEpfSen: number;
  /** X — PCB already withheld this year (including by a previous employer, if
   *  the office has keyed it). */
  ytdPcbSen: number;
  /** Z — zakat paid through this employer this year. LHDN's default when the
   *  employee has not declared any is 0, which is what payroll passes. */
  ytdZakatSen?: number;
  category: PcbCategory;
  childReliefSen: number;
};

/** The month's PCB for a RESIDENT, in integer sen. Never negative: a projected
 *  over-deduction is refunded on assessment, not clawed back through payroll. */
export function residentPcbSen(a: ResidentPcbInput): number {
  const n = Math.max(0, 12 - a.monthIndex);
  const p = projectedChargeableIncomeSen(a);
  const annualTax = residentTaxSen(p) - residentRebateSen(p, a.category);
  const remaining = annualTax - (a.ytdZakatSen ?? 0) - a.ytdPcbSen;
  if (remaining <= 0) return 0;
  return roundUpTo5Sen(remaining / (n + 1));
}

/** The month's PCB for a NON-RESIDENT: a flat rate on gross, no reliefs, no
 *  rebate, no projection. */
export function nonResidentPcbSen(currentRemunerationSen: number): number {
  const gross = Math.max(0, currentRemunerationSen);
  return roundUpTo5Sen((gross * NON_RESIDENT_FLAT_RATE_PCT) / 100);
}

// ---------------------------------------------------------------------------
// The single entry point payroll calls
// ---------------------------------------------------------------------------

export type PcbInput = {
  /** `workers.pcb_enabled`. NULL/undefined reads as TRUE, matching the other
   *  three statutory flags. */
  pcbEnabled: boolean | null | undefined;
  /** Calendar year of the period being paid — the year of assessment. */
  year: number;
  /** 1–12. */
  monthIndex: number;
  profile: PcbTaxProfile;
  currentRemunerationSen: number;
  currentEpfSen: number;
  ytdRemunerationSen: number;
  ytdEpfSen: number;
  ytdPcbSen: number;
  ytdZakatSen?: number;
};

const MISSING_NOTE: Record<PcbMissingInput, string> = {
  taxResidency:
    "tax residency (resident / non-resident) has not been recorded for this employee",
  taxCategory:
    "marital category (single / married with non-working spouse / married with working spouse) has not been recorded",
  taxChildRelief: "child relief has not been declared",
  taxSchedule: "no tax schedule is loaded for this year of assessment",
};

function unknown(missing: PcbMissingInput[]): PcbOutcome {
  return {
    status: "UNKNOWN",
    pcbSen: 0,
    missing,
    note:
      "PCB not computed — " +
      missing.map((m) => MISSING_NOTE[m]).join("; ") +
      ". Net pay below does NOT include any tax withholding.",
  };
}

export function scheduleCoversYear(year: number): boolean {
  return (
    Number.isInteger(year) &&
    year >= RESIDENT_SCHEDULE_FIRST_YA &&
    year <= RESIDENT_SCHEDULE_LAST_YA
  );
}

/**
 * Resolve one worker's PCB for one month.
 *
 * The ZERO_PROVEN branch is the reason a missing declaration does not stop
 * every low-paid worker's payroll: relief only ever REDUCES the chargeable
 * income, and the spouse rebate only ever reduces the tax, so Category 1 with
 * no child relief is the largest PCB any resident profile can produce at a
 * given pay. If that maximum is zero, zero is the answer for every profile —
 * a proof, not an assumption. `tests/pcb-calculation.test.mjs` asserts the
 * monotonicity that proof rests on across the whole profile grid.
 */
export function resolvePcb(input: PcbInput): PcbOutcome {
  if (input.pcbEnabled === false) {
    return {
      status: "DISABLED",
      pcbSen: 0,
      missing: [],
      note: "Not registered for PCB — no tax is withheld for this employee.",
    };
  }
  if (!scheduleCoversYear(input.year)) {
    return unknown(["taxSchedule"]);
  }

  const residency = input.profile.residency;
  if (residency !== "RESIDENT" && residency !== "NON_RESIDENT") {
    return unknown(["taxResidency"]);
  }

  if (residency === "NON_RESIDENT") {
    return {
      status: "COMPUTED",
      pcbSen: nonResidentPcbSen(input.currentRemunerationSen),
      missing: [],
      note: `Non-resident — flat ${NON_RESIDENT_FLAT_RATE_PCT}% of gross, no reliefs.`,
    };
  }

  const category = input.profile.category;
  const childRelief = input.profile.childReliefSen;
  const categoryKnown =
    category === "SINGLE" ||
    category === "MARRIED_SPOUSE_NOT_WORKING" ||
    category === "MARRIED_SPOUSE_WORKING";
  const childReliefKnown =
    typeof childRelief === "number" && Number.isFinite(childRelief) && childRelief >= 0;

  const base = {
    monthIndex: input.monthIndex,
    currentRemunerationSen: input.currentRemunerationSen,
    currentEpfSen: input.currentEpfSen,
    ytdRemunerationSen: input.ytdRemunerationSen,
    ytdEpfSen: input.ytdEpfSen,
    ytdPcbSen: input.ytdPcbSen,
    ytdZakatSen: input.ytdZakatSen ?? 0,
  };

  if (categoryKnown && childReliefKnown) {
    return {
      status: "COMPUTED",
      pcbSen: residentPcbSen({
        ...base,
        category: category as PcbCategory,
        childReliefSen: childRelief as number,
      }),
      missing: [],
      note: "Resident — LHDN computerised calculation on this month's normal remuneration.",
    };
  }

  // Incomplete declaration. Compute the CEILING over every resident profile
  // (least relief) and accept a zero, because zero is then the answer whatever
  // the missing declaration turns out to say.
  const ceilingSen = residentPcbSen({
    ...base,
    category: "SINGLE",
    childReliefSen: 0,
  });
  if (ceilingSen === 0) {
    return {
      status: "ZERO_PROVEN",
      pcbSen: 0,
      missing: [],
      note:
        "No PCB is due at this pay level under any tax profile, so the missing " +
        "declaration cannot change the answer.",
    };
  }

  const missing: PcbMissingInput[] = [];
  if (!categoryKnown) missing.push("taxCategory");
  if (!childReliefKnown) missing.push("taxChildRelief");
  return unknown(missing);
}

// ---------------------------------------------------------------------------
// Reading a STORED payslip's PCB — shared by the API, the office grid, the
// worker's phone and the printed slip, so they cannot disagree about what a
// zero means.
// ---------------------------------------------------------------------------

/** A payslip generated before PCB was computed at all carries no status. That
 *  is not the same as DISABLED (nobody decided the worker was exempt) and not
 *  the same as COMPUTED-zero (nothing was calculated). */
export type StoredPcbStatus = PcbStatus | "NOT_RECORDED";

export function normalizeStoredPcbStatus(raw: unknown): StoredPcbStatus {
  const s = String(raw ?? "").toUpperCase();
  return s === "DISABLED" ||
    s === "COMPUTED" ||
    s === "ZERO_PROVEN" ||
    s === "UNKNOWN"
    ? (s as PcbStatus)
    : "NOT_RECORDED";
}

/**
 * May the sen figure beside this status be PRINTED as an amount?
 *
 * Only when something was actually worked out. A zero under DISABLED, UNKNOWN
 * or NOT_RECORDED is a placeholder, and rendering it as "RM 0.00" states that
 * no tax was due — which is exactly the claim this bug was making on every
 * payslip. Those must render "—".
 */
export function pcbHasFigure(status: StoredPcbStatus): boolean {
  return status === "COMPUTED" || status === "ZERO_PROVEN";
}

/** What to put in the cell's tooltip / the slip's footnote. */
export const PCB_STATUS_NOTE: Record<StoredPcbStatus, string> = {
  COMPUTED: "PCB withheld under LHDN's monthly deduction schedule.",
  ZERO_PROVEN:
    "No PCB is due at this pay level under any tax profile.",
  DISABLED: "Not registered for PCB — no tax is withheld for this employee.",
  UNKNOWN:
    "PCB could not be computed: this employee's tax residency, marital category or child relief has not been recorded. Net pay does NOT include any tax withholding.",
  NOT_RECORDED:
    "This payslip was generated before PCB was calculated by the system, so no withholding was worked out. Net pay does NOT include any tax withholding.",
};

/**
 * Deliberately NOT implemented, so nobody mistakes silence for coverage:
 *
 *  • ADDITIONAL remuneration (bonus, commission, arrears, director's fee).
 *    LHDN prescribes a separate procedure (compute the year's MTD with and
 *    without the additional payment and withhold the difference). POST
 *    /api/payslips has no bonus field, so no path reaches it today. Anything
 *    that adds one must implement this first, or the bonus month withholds
 *    against the wrong schedule.
 *  • TP1 reliefs beyond child relief (medical, lifestyle, education fees,
 *    SSPN, life insurance premium LP). LHDN's own default when the employee
 *    files no TP1 is zero, which is what this module applies — so an employee
 *    who has filed a TP1 with their employer is currently over-withheld and
 *    recovers it on assessment. Wiring TP1 means storing the declared amounts,
 *    not inferring them.
 *  • Zakat paid through the employer (Z). Passed in as 0; there is no zakat
 *    field on payroll.
 *  • CP38 instalment directives from LHDN — a separate deduction line, not
 *    part of MTD.
 */
export const PCB_NOT_IMPLEMENTED = [
  "additional-remuneration",
  "tp1-reliefs",
  "zakat",
  "cp38",
] as const;
