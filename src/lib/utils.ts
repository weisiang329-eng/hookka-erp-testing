import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  SUCCESS,
  WARNING,
  WARNING_HIGH,
  DANGER,
  INFO,
  NEUTRAL,
  ACCENT_PLUM,
  type SemanticStyle,
} from "./design-tokens";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Per-currency cache — constructing Intl.NumberFormat per money cell was a
// chunk of grid render cost. Almost every call is MYR, so this is effectively
// one cached formatter. Output byte-identical. (2026-06-04 perf pass.)
const CURRENCY_FMTS = new Map<string, Intl.NumberFormat>();
export function formatCurrency(sen: number, currency = "MYR"): string {
  const amount = sen / 100;
  let fmt = CURRENCY_FMTS.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-MY", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    });
    CURRENCY_FMTS.set(currency, fmt);
  }
  return fmt.format(amount);
}

// Hoisted once at module load. Constructing Intl.NumberFormat is the single
// most expensive formatting primitive (~tens of µs); the data grid calls
// formatNumber for every visible numeric cell on every render, so a fresh
// construct per call was a measurable chunk of the front-end jank
// (longTaskCount). Output is byte-identical. (2026-06-04 perf pass.)
const NUM_FMT = new Intl.NumberFormat("en-MY");
export function formatNumber(n: number): string {
  return NUM_FMT.format(n);
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Today's date as YYYY-MM-DD in Malaysia time (UTC+8).
 *
 * `new Date().toISOString().slice(0,10)` is UTC, so before 08:00 MYT it returns
 * YESTERDAY — wrong for every "today" default the operator saves (production
 * completed date, price effective date, issuance date, …). Use this instead.
 */
export function todayYmdMY(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function formatDateTime(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Resolve an arbitrary status string to a `SemanticStyle`.
 *
 * Backed by the canonical palette in `design-tokens.ts` so every
 * status chip in the app is on-brand. New status values that the
 * map doesn't know yet fall back to NEUTRAL.
 *
 * Prefer `<StatusBadge kind="..." value={...} />` in new code — it
 * is kind-aware, so adding a new enum value fails to compile
 * instead of silently falling back. This function exists only for
 * legacy call-sites in Badge variant="status".
 */
export function getStatusColor(status: string): SemanticStyle {
  // positive / approved / completed family
  if (
    status === "COMPLETED" ||
    status === "PASS" ||
    status === "PASSED" ||
    status === "DELIVERED" ||
    status === "SIGNED" ||
    status === "PAID" ||
    status === "ACTIVE" ||
    status === "PRESENT" ||
    status === "POSTED" ||
    status === "RECEIVED" ||
    status === "FULL_MATCH" ||
    status === "APPROVED" ||
    status === "SOLD" ||
    status === "PRODUCTION_READY" ||
    status === "UPHOLSTERED"  // upheld value: progressed, on track
  ) {
    return SUCCESS;
  }

  // arrival pipeline — AT_CUSTOMS maps to WARNING (attention), ARRIVED to SUCCESS
  if (status === "AT_CUSTOMS") {
    return WARNING;
  }
  if (status === "NOT_ARRIVED") {
    return NEUTRAL;
  }
  if (status === "ARRIVED") {
    return SUCCESS;
  }

  // in-motion / in-progress family
  if (
    status === "IN_PROGRESS" ||
    status === "IN_PRODUCTION" ||
    status === "IN_TRANSIT" ||
    status === "CONFIRMED" ||
    status === "SHIPPED" ||
    status === "LOADED" ||
    status === "DISPATCHED" ||
    status === "PICKED" ||
    status === "PENDING_INVOICE" ||
    status === "SENT" ||
    status === "SUBMITTED" ||
    status === "AT_BRANCH" ||
    status === "MEDICAL_LEAVE" ||
    status === "ANNUAL_LEAVE" ||
    status === "CONCEPT" || status === "DESIGN" || status === "PROTOTYPE" ||
    status === "PLANNED" ||
    status === "MINOR" ||
    status === "PACKED"
  ) {
    return INFO;
  }

  // warning: attention, partial, on-hold
  if (
    status === "PENDING" ||
    status === "ON_HOLD" ||
    status === "PAUSED" ||
    status === "HALF_DAY" ||
    status === "CONDITIONAL_PASS" ||
    status === "PARTIAL" ||
    status === "PARTIAL_PAID" ||
    status === "PARTIAL_MATCH" ||
    status === "READY_TO_SHIP" ||
    status === "MAJOR" ||
    status === "TESTING" ||
    status === "RETURNED" ||
    status === "CUSTOMS"
  ) {
    return WARNING;
  }

  // warning-high: slightly worse, not yet critical
  if (
    status === "PARTIAL_RECEIVED" ||
    status === "OVERDUE" ||
    status === "BLOCKED"
  ) {
    return WARNING_HIGH;
  }

  // danger: failed, cancelled, damaged, unbalanced, overdue critical
  if (
    status === "ABSENT" ||
    status === "FAIL" ||
    status === "FAILED" ||
    status === "REVERSED" ||
    status === "MISMATCH" ||
    status === "DAMAGED" ||
    status === "CRITICAL"
  ) {
    return DANGER;
  }

  // equity/special accent — purple family, non-semantic
  if (status === "INVOICED") {
    return ACCENT_PLUM;
  }

  // neutral: draft, rest, inactive, cancelled (dead-letter)
  if (
    status === "DRAFT" ||
    status === "REST_DAY" ||
    status === "CANCELLED" ||
    status === "INACTIVE" ||
    status === "CLOSED" ||
    status === "WAITING" ||
    status === "OBSOLETE" ||
    status === "ORDERED" ||
    status === "PENDING_UPHOLSTERY"
  ) {
    return NEUTRAL;
  }

  // Unknown status — neutral fallback. If you see this in the UI,
  // add it to the appropriate bucket above (or use <StatusBadge>
  // with a `kind` that enforces enum coverage at compile time).
  return NEUTRAL;
}

/**
 * Format a date string to DD/MM/YYYY format.
 * Accepts ISO dates, Date objects, or various date string formats.
 */
export function formatDateDMY(dateStr: string | Date): string {
  if (!dateStr) return "";
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  if (isNaN(d.getTime())) return String(dateStr);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Format sen (cents) to "RM 1,234.56" display string.
 */
// Cached formatter (was `amount.toLocaleString(...)` per call, which builds an
// internal Intl object each time). Output byte-identical. (2026-06-04 perf.)
const RM_FMT = new Intl.NumberFormat("en-MY", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export function formatRM(sen: number): string {
  const amount = sen / 100;
  return `RM ${RM_FMT.format(amount)}`;
}

/**
 * The single money-rounding primitive: round a fractional-sen amount to whole
 * sen. Half rounds up (Math.round). Use this everywhere a money value is
 * displayed/stored so the rounding direction is identical across the app.
 */
export function roundSen(amountSen: number): number {
  return Math.round(amountSen);
}

/**
 * Round a sen amount UP to a whole ringgit (a multiple of 100 sen).
 *
 * Owner ruling 2026-08-07 ("我全套系统都要整除的"): every line UNIT PRICE the
 * system COMPUTES must land on a whole ringgit, and the direction is UP
 * ("进位"), not nearest — RM 995.14 → RM 996, RM 305.01 → RM 306. An amount
 * that is ALREADY whole comes back unchanged (30500 → 30500); rounding up must
 * never add a ringgit to an exact value.
 *
 * Scope, deliberately narrow:
 *  - UNIT prices only. Line subtotal then follows as `whole unit × qty`, so it
 *    is whole by construction — do NOT re-round subtotals or invoice totals.
 *  - **SST is excluded** (owner: "SST 就不需要"). Never call this on a tax
 *    figure; SST keeps its cents exactly as it computes them today.
 *  - COMPUTED values only. A price the operator typed is left as typed.
 *
 * Fractional-sen input is settled to whole sen first (`roundSen`) so float
 * noise like 30500.0000001 can't silently buy a whole extra ringgit.
 *
 * This is THE round-up primitive. Do not hand-roll `Math.ceil(x / 100) * 100`
 * at a call site — a second copy is how these bugs get born.
 */
export function roundUpToRinggitSen(amountSen: number): number {
  if (!Number.isFinite(amountSen)) return 0;
  const whole = Math.ceil(roundSen(amountSen) / 100) * 100;
  return whole === 0 ? 0 : whole; // normalise -0
}

/**
 * Round a list of fractional-sen `parts` to whole sen so that they sum EXACTLY
 * to `totalSen` — the largest-remainder (Hamilton) method.
 *
 * Why: when a single integer total (e.g. Total Payroll Cost) is broken into
 * parts (per-department labor cost), rounding each part independently can make
 * the rows sum to a sen more or less than the total. Naively shoving that
 * residual into one chosen bucket is arbitrary. Largest-remainder instead floors
 * every part, then hands the leftover sen — one each — to the parts whose
 * dropped fraction was largest (ties broken by the larger part). Every part ends
 * up within a sen of its natural rounded value, the allocation is fair, and the
 * result sums to `totalSen` to the sen. This is THE convention for splitting a
 * money total into displayed parts across the ERP.
 *
 * `totalSen` is rounded to whole sen first. Returns integers in input order.
 */
export function distributeRoundSen(parts: number[], totalSen: number): number[] {
  const n = parts.length;
  if (n === 0) return [];
  const floors = parts.map((p) => Math.floor(p));
  const baseSum = floors.reduce((a, b) => a + b, 0);
  let remainder = Math.round(totalSen) - baseSum; // whole sen still to allocate
  // Indices ordered by descending dropped fraction; ties → larger part first.
  const order = parts
    .map((p, i) => ({ i, frac: p - floors[i] }))
    .sort((a, b) => b.frac - a.frac || parts[b.i] - parts[a.i]);
  const out = floors.slice();
  // Positive residual → add a sen to the largest-fraction parts.
  for (let k = 0; k < n && remainder > 0; k++) {
    out[order[k].i] += 1;
    remainder -= 1;
  }
  // Negative residual (float noise made the floors overshoot) → shave a sen from
  // the smallest-fraction parts.
  for (let k = n - 1; k >= 0 && remainder < 0; k--) {
    out[order[k].i] -= 1;
    remainder += 1;
  }
  // Safety net: in correct use `parts` already sum to ~`totalSen`, so the loops
  // above consume the whole residual and this is a no-op. If a caller passes a
  // total far from Σparts, park the leftover on the largest part so the result
  // ALWAYS sums to totalSen exactly (never a silent mismatch).
  if (remainder !== 0) {
    let big = 0;
    for (let i = 1; i < n; i++) if (out[i] > out[big]) big = i;
    out[big] += remainder;
  }
  return out;
}

/**
 * Format a minute count as "8h 30m" / "8h" / "-". The canonical
 * hours+minutes display used across the Hookka ERP UI — Employees
 * Working Hours grid, Department Performance KPIs, Planning page
 * Efficiency Overview, etc. Returns "-" for zero / negative.
 */
export function formatHours(minutes: number): string {
  if (minutes <= 0) return "-";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
