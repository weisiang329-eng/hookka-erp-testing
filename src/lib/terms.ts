// ---------------------------------------------------------------------------
// Payment terms — owner rule: term is a fixed 1 MONTH, by calendar MONTH not
// by day. An invoice issued in month M is due "next month" (M+1) — the whole
// of next month is the payment window, so due date = last day of M+1. It is
// "current" through the end of M+1 for DUE-DATE purposes. AGING, however, is
// reported by CALENDAR month (owner rule 2026-06-30): this month = current,
// last month = 1 month, etc. — see monthsOverdue below. The same 1-month term
// governs the due date stamped on both sales invoices and purchase invoices.
//
// Single source of truth — imported by invoices.ts / purchase-invoices.ts
// (stamp dueDate) and accounting.ts (aging buckets) so the rule can't drift.
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM(-DD…) string → { y, m } (m is 1-based). null if unparseable. */
function ym(d: string | null | undefined): { y: number; m: number } | null {
  const s = String(d ?? "").slice(0, 7);
  const mt = s.match(/^(\d{4})-(\d{2})$/);
  if (!mt) return null;
  return { y: Number(mt[1]), m: Number(mt[2]) };
}

/**
 * Due date (YYYY-MM-DD) for an invoice = last calendar day of the month
 * AFTER the invoice's month. April invoice → 2026-05-31. Dec → next-Jan-31.
 * Falls back to today if the invoice date can't be parsed.
 */
export function nextMonthDueDate(invoiceDate: string | null | undefined): string {
  const p = ym(invoiceDate);
  if (!p) return new Date().toISOString().slice(0, 10);
  // Date.UTC(y, m, 0): m is the 0-based index of the month AFTER the
  // invoice month, day 0 = its last day → last day of (invoice month + 1).
  return new Date(Date.UTC(p.y, p.m + 1, 0)).toISOString().slice(0, 10);
}

/**
 * Aging-bucket index by the invoice's CALENDAR month (owner rule, 2026-06-30):
 * THIS month = 0 (Current), last month = 1, two months ago = 2, … i.e. how many
 * whole calendar months ago the invoice was issued — the day is irrelevant.
 * The aging is independent of the payment term: the 1-month term still governs
 * the DUE DATE (nextMonthDueDate), but a last-month invoice ages into "1 month"
 * even though it is not yet past its due date.
 */
export function monthsOverdue(
  invoiceDate: string | null | undefined,
  now: Date = new Date(),
): number {
  const p = ym(invoiceDate);
  if (!p) return 0;
  const nowMonths = now.getFullYear() * 12 + (now.getMonth() + 1);
  const invMonths = p.y * 12 + p.m;
  return nowMonths - invMonths;
}
