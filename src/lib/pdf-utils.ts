// ============================================================
// HOOKKA ERP - Shared PDF Utility Functions
// ============================================================

/**
 * Format sen amount as "1,234.56" (no RM prefix).
 */
export function fmtCurrency(sen: number): string {
  return (sen / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format sen amount as "RM 1,234.56".
 */
export function fmtRM(sen: number): string {
  return `RM ${fmtCurrency(sen)}`;
}

/**
 * Format sen amount as plain number string "1,234.56" (no RM prefix, with thousands separator).
 */
export function fmtCurrencyPlain(sen: number): string {
  return (sen / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format ISO date string as "16 Apr 2026".
 * Returns "-" for empty, null, undefined, or unparseable values so PDFs
 * never render a blank "Invalid Date" cell.
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Convert a whole number into English words.
 * e.g. 1234 -> "One Thousand Two Hundred and Thirty Four"
 */
export function numberToWords(amount: number): string {
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen",
  ];
  const tens = [
    "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
  ];

  if (amount === 0) return "Zero";

  function convertGroup(n: number): string {
    if (n === 0) return "";
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
    return ones[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " and " + convertGroup(n % 100) : "");
  }

  const parts: string[] = [];
  const units = ["", "Thousand", "Million", "Billion"];
  let remaining = Math.floor(amount);
  let unitIdx = 0;

  while (remaining > 0) {
    const group = remaining % 1000;
    if (group > 0) {
      const groupStr = convertGroup(group);
      parts.unshift(units[unitIdx] ? groupStr + " " + units[unitIdx] : groupStr);
    }
    remaining = Math.floor(remaining / 1000);
    unitIdx++;
  }

  return parts.join(" ");
}

/**
 * Convert sen amount to Malaysian Ringgit words for cheque / PDF display.
 * e.g. 123456 -> "Ringgit Malaysia One Thousand Two Hundred and Thirty Four and Fifty Six Sen Only"
 */
export function amountInWords(sen: number): string {
  const ringgit = Math.floor(Math.abs(sen) / 100);
  const cents = Math.abs(sen) % 100;
  if (ringgit === 0 && cents === 0) return "Ringgit Malaysia Zero Only";

  let result = "Ringgit Malaysia " + numberToWords(ringgit);
  if (cents > 0) {
    result += " and " + numberToWords(cents) + " Sen";
  }
  result += " Only";
  return result;
}
