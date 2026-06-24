// Malaysian-style "amount in words" for printed vouchers (PV / OR).
//
// Money is integer sen (RM × 100). The output mirrors the conventional
// Malaysian cheque / receipt wording:
//   123450 → "Ringgit One Thousand Two Hundred And Thirty Four And Sen Fifty Only"
//   100000 → "Ringgit One Thousand Only"            (whole ringgit, no sen clause)
//       50 → "Ringgit Zero And Sen Fifty Only"      (sen only)
//        0 → "Ringgit Zero Only"
//
// Conventions locked by the tests:
//  - The hundreds/tens within a group are joined by "And" (e.g. "Two Hundred
//    And Thirty Four"), matching the owner's sample.
//  - The sen part (always < 100) is spelled out and prefixed with "And Sen".
//  - Whole amounts drop the sen clause entirely.

const ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen",
] as const;

const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty",
  "Ninety",
] as const;

// Scale words for each 3-digit group, least significant first.
const SCALES = ["", "Thousand", "Million", "Billion", "Trillion"] as const;

// 0..99 → words ("" for 0 so callers can decide whether to emit "Zero").
function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones === 0 ? TENS[tens] : `${TENS[tens]} ${ONES[ones]}`;
}

// 0..999 → words, joining the hundreds and the remainder with "And"
// ("Two Hundred And Thirty Four"). Empty string for 0.
function threeDigitWords(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return rest === 0 ? "" : twoDigitWords(rest);
  const head = `${ONES[hundreds]} Hundred`;
  return rest === 0 ? head : `${head} And ${twoDigitWords(rest)}`;
}

// A non-negative integer → words ("Zero" for 0). Groups of three digits are
// labelled with their scale word (Thousand / Million / …).
function integerWords(n: number): string {
  if (n === 0) return "Zero";
  const groups: number[] = [];
  let v = n;
  while (v > 0) {
    groups.push(v % 1000);
    v = Math.floor(v / 1000);
  }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    const words = threeDigitWords(g);
    const scale = SCALES[i] ?? "";
    parts.push(scale ? `${words} ${scale}` : words);
  }
  return parts.join(" ");
}

/**
 * Spell an integer-sen money amount as Malaysian-style words.
 * Negative inputs are spelled with a leading "Minus". Non-integers are
 * rounded to the nearest sen first (money should already be whole sen).
 */
export function amountInWords(sen: number): string {
  if (!Number.isFinite(sen)) return "Ringgit Zero Only";
  const negative = sen < 0;
  const whole = Math.round(Math.abs(sen));
  const ringgit = Math.floor(whole / 100);
  const cents = whole % 100;

  const ringgitWords = integerWords(ringgit);
  const body = cents === 0
    ? `Ringgit ${ringgitWords}`
    : `Ringgit ${ringgitWords} And Sen ${twoDigitWords(cents)}`;

  return `${negative ? "Minus " : ""}${body} Only`;
}
