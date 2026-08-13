// ---------------------------------------------------------------------------
// money-field — the screen-side adapter over `parse-money.ts`.
//
// This is NOT a second parser. Every function here delegates to
// `parseMoneyInput` / `parseMoneyToSen`; the only thing it adds is the one
// convention every money FORM in this app already had, spelled out once:
//
//     a BLANK field means "nothing entered" → 0
//     anything the parser cannot read       → null, and the caller REFUSES
//
// Before this existed, each form hand-rolled the blank rule as
// `parseFloat(s) || 0` or `Number.isFinite(v) ? … : 0`, which collapses
// "unreadable" into "blank" — so `12,000` (which `parseFloat` truncates to 12)
// and `oops` and `` all booked a number nobody typed. Keeping the blank rule
// here means a call site can never re-derive it slightly differently.
//
// THE RULE FOR CALLERS: `?? 0` on a value returned by anything in this module
// is the original bug in a new shape. Surface the null — refuse the submit and
// tell the operator which field could not be read.
// ---------------------------------------------------------------------------

import { parseMoneyInput, parseMoneyToSen } from "./parse-money";

/**
 * A form money field → integer SEN.
 * Blank/undefined → `0` (the field was left empty, which every one of these
 * forms treats as zero). Unreadable → `null`; the caller must refuse.
 */
export function moneyFieldToSen(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return 0;
  if (String(raw).trim() === "") return 0;
  return parseMoneyToSen(raw);
}

/**
 * A form money field → RINGGIT (not sen). Same blank/unreadable contract as
 * `moneyFieldToSen`. Use only where the surrounding code genuinely works in
 * ringgit; sen is the repo's money unit.
 */
export function moneyFieldToRinggit(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return 0;
  if (String(raw).trim() === "") return 0;
  return parseMoneyInput(raw);
}

/**
 * `true` when the field holds something the money parser cannot read.
 * Blank is NOT invalid — it is zero. Use this to mark an input red while the
 * operator is still typing, without blocking them mid-keystroke.
 */
export function isUnreadableMoney(raw: string | null | undefined): boolean {
  return moneyFieldToSen(raw) === null;
}

/**
 * The submit-time gate. Give it the labelled money fields of a form; it
 * returns a ready-to-toast message naming the FIRST field it could not read,
 * or `null` when every field is readable.
 *
 * The message quotes the value back so the operator can see what the screen
 * actually received — "Amount" alone sends people hunting.
 */
export function firstMoneyFieldError(
  fields: Array<{ label: string; value: string | null | undefined }>,
): string | null {
  for (const f of fields) {
    if (moneyFieldToSen(f.value) === null) {
      return `${f.label}: "${String(f.value ?? "").trim()}" is not a valid amount. Use digits, e.g. 12000 or 12,000.50`;
    }
  }
  return null;
}
