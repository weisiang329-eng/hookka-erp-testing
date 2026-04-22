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

export function formatCurrency(sen: number, currency = "MYR"): string {
  const amount = sen / 100;
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-MY").format(n);
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
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
export function formatRM(sen: number): string {
  const amount = sen / 100;
  return `RM ${amount.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
