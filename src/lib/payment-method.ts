// ---------------------------------------------------------------------------
// How a worker is paid (owner 2026-08-01).
//
// Kept as its own module because four surfaces need the SAME list and the same
// labels — Employee Master (the default), the Payroll row (this month's value),
// the payslip, and the exports. A bank typed slightly differently on each screen
// is how a payment file ends up rejected by the bank.
// ---------------------------------------------------------------------------

export type PaymentMethod = "CASH" | "TRANSFER";

export const PAYMENT_METHODS: ReadonlyArray<{ value: PaymentMethod; label: string }> = [
  { value: "TRANSFER", label: "Bank transfer" },
  { value: "CASH", label: "Cash" },
];

/** Malaysian banks, as the owner asked — a fixed dropdown, not free text. */
export const MALAYSIAN_BANKS: readonly string[] = [
  "Maybank",
  "CIMB Bank",
  "Public Bank",
  "RHB Bank",
  "Hong Leong Bank",
  "AmBank",
  "Bank Islam",
  "OCBC Bank",
  "UOB Bank",
  "HSBC Bank",
  "Affin Bank",
  "Alliance Bank",
  "Bank Simpanan Nasional",
  "Bank Rakyat",
  "Agrobank",
  "MBSB Bank",
  "Standard Chartered",
  "Citibank",
];

/** Anything not exactly "CASH" is a transfer — the safe default for legacy rows. */
export function normalizePaymentMethod(v: unknown): PaymentMethod {
  return String(v ?? "").trim().toUpperCase() === "CASH" ? "CASH" : "TRANSFER";
}

export function paymentMethodLabel(v: unknown): string {
  return normalizePaymentMethod(v) === "CASH" ? "Cash" : "Bank transfer";
}

/**
 * One line describing where the money goes, for a payslip or an export.
 * Cash needs no bank; a transfer with nothing filled in says so plainly rather
 * than printing an empty field the office might not notice.
 */
export function paymentDestinationLabel(
  method: unknown,
  bankName?: string | null,
  bankAccount?: string | null,
): string {
  if (normalizePaymentMethod(method) === "CASH") return "Cash";
  const bank = (bankName ?? "").trim();
  const acc = (bankAccount ?? "").trim();
  if (bank && acc) return `${bank} · ${acc}`;
  if (acc) return acc;           // legacy rows: "CIMB-004XXXX" in one string
  if (bank) return bank;
  return "Bank details not set";
}
