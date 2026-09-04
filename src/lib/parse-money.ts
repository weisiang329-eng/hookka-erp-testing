// ---------------------------------------------------------------------------
// parseMoneyInput — the ONE way to turn a typed string into money.
//
// WHY THIS EXISTS
// `parseFloat` stops at the first character it does not understand and returns
// what it has so far, with no error:
//
//     parseFloat("12,000")  === 12      ← RM 12.00, not RM 12,000.00
//     parseFloat("1,200")   === 1
//     parseFloat("5 000")   === 5
//     parseFloat("12.000,50") === 12    ← European grouping
//
// Measured 2026-08-13: the accounting page has 119 money inputs and NOT ONE is
// `type="number"` — every one is `type="text" inputMode="decimal"`, which
// happily accepts a comma. A fixed asset entered as `12,000` was created at
// **RM 12.00** and depreciated off that figure forever. Landed cost, fund
// transfer, bill lines and opening balances shared the trap.
//
// THE RULE: SILENT TRUNCATION IS THE BUG, NOT THE COMMA.
// A user typing `12,000` means twelve thousand. Accepting it is friendly.
// What must never happen is quietly booking a different number than the one on
// screen — so anything this function cannot read with confidence returns
// `null`, and the caller shows an error instead of guessing.
//
// `type="number"` inputs (e.g. `MoneyInput`) are shielded from this by the
// browser, which refuses the comma outright. This helper is for the free-text
// inputs, which is nearly all of them here.
// ---------------------------------------------------------------------------

/** Grouping separators we accept and strip: comma, space, narrow/no-break space, apostrophe. */
const GROUPING = /[,\s\u00A0\u202F']/g;

/**
 * Parse a typed money string into a RINGGIT number (not sen).
 *
 * Accepts: "12000", "12,000", "12 000", "12,000.50", "(1,200)" → -1200,
 *          a leading "RM"/"MYR", and a leading +/-.
 * Rejects (returns null): empty, multiple decimal points, European "12.000,50",
 *          stray letters, a lone separator.
 */
export function parseMoneyInput(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;

  let s = String(raw).trim();
  if (s === "") return null;

  // Accounting parentheses mean negative: (1,200) = -1200
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  s = s.replace(/^(?:RM|MYR)\s*/i, "");

  if (/^[+-]/.test(s)) {
    if (s[0] === "-") negative = !negative;
    s = s.slice(1).trim();
  }

  // European grouping ("12.000,50") is genuinely ambiguous against "12.000"
  // meaning twelve-point-zero. Refuse it rather than pick an interpretation —
  // guessing here books a number the user never typed.
  if (/\d[.]\d{3}(?:\D|$)/.test(s) && s.includes(",") && s.lastIndexOf(",") > s.lastIndexOf(".")) {
    return null;
  }

  s = s.replace(GROUPING, "");
  if (s === "") return null;

  // After stripping grouping, only digits and AT MOST one decimal point remain.
  if (!/^\d*\.?\d*$/.test(s)) return null;
  if ((s.match(/\./g) ?? []).length > 1) return null;
  if (s === ".") return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  return negative ? -n : n;
}

/**
 * Parse a typed money string straight to integer SEN, the repo's money unit.
 * Returns null on anything unreadable — callers must surface that, never
 * fall back to 0. A silent 0 is how an unpriced line reaches the ledger.
 */
export function parseMoneyToSen(raw: string | null | undefined): number | null {
  const rm = parseMoneyInput(raw);
  if (rm === null) return null;
  return Math.round(rm * 100);
}
