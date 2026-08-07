// ---------------------------------------------------------------------------
// purchase-edit-rules.ts — the SINGLE shared gate for "can this purchase
// document be edited beyond its old locked state, and what does the edit
// cascade into".
//
// Owner ruling 2026-06-22: PIs editable when APPROVED (not just DRAFT) and
// POSTED GRNs editable line-by-line, BOTH with stock / AP following the change.
// This module holds the PURE rules + delta math so the frontend Save handler
// and the backend PUT reject the same edits with the SAME message (no
// backend-only 422 that confuses the operator), mirroring the pattern in
// convert-chain.ts.
//
// Money stays integer sen; quantities are plain numbers (fractional metre /
// length raw materials, so no rounding of qty).
// ---------------------------------------------------------------------------

// ── Purchase Invoice ───────────────────────────────────────────────────────

/**
 * PI statuses whose header + lines may be edited.
 *   • DRAFT — pre-confirm, fully editable.
 *   • CONFIRMED — owner ruling 2026-06-29: editable, GL reverses-and-reposts on
 *     save (the existing GL CORRECTION block in purchase-invoices.ts PUT
 *     handles the delta).
 *   • APPROVED — legacy status (pre-2026-06-29 lifecycle simplification); still
 *     editable so rows that haven't been backfilled by ensurePiMigrations()
 *     don't 409 on edit. Treated the same as CONFIRMED.
 *
 * PAID / CANCELLED stay terminal-for-editing: PAID has a settled payment +
 * realised FX, CANCELLED has already released its GRN consumption.
 */
export const PI_EDITABLE_STATUSES = ["DRAFT", "CONFIRMED", "APPROVED"] as const;

export function isPiEditable(status: string | null | undefined): boolean {
  return PI_EDITABLE_STATUSES.includes(
    String(status ?? "").toUpperCase() as (typeof PI_EDITABLE_STATUSES)[number],
  );
}

/**
 * The error a blocked PI line-edit returns. Backend 409s with this exact
 * string; the frontend pre-checks with the same text so the operator sees one
 * consistent message.
 */
export function piEditBlockedError(status: string | null | undefined): string {
  return `Line items can only be edited while the invoice is DRAFT or CONFIRMED (current: ${String(status ?? "").toUpperCase() || "UNKNOWN"}).`;
}

// ── Goods Receipt Note ─────────────────────────────────────────────────────

/**
 * GRN statuses whose accepted-qty / unit-price lines may be edited.
 *   • DRAFT / CONFIRMED — pre-commit, edited freely (handled by the existing
 *     replace-items path; stock not yet posted).
 *   • POSTED — already in stock; the owner wants accepted-qty corrections that
 *     post a COMPENSATING stock movement for the delta (this module computes
 *     the per-line delta; the route reuses postGRNToStock's helpers to apply
 *     it).
 *   • CANCELLED — the receipt has been reversed; it is a historical record.
 */
export function isGrnLineEditable(status: string | null | undefined): boolean {
  const s = String(status ?? "").toUpperCase();
  return s === "DRAFT" || s === "CONFIRMED" || s === "POSTED";
}

// ── The downstream-PI lock is PER LINE, not per document ───────────────────
//
// Owner ruling 2026-06-29 (evening) froze a GRN the moment ANY line had been
// invoiced. The intent was right — an invoiced quantity must never be edited
// out from under a live invoice — but the SCOPE was the whole document, so
// billing one line of a ten-line receipt made the other nine permanently
// uncorrectable. Owner rule: "这种转换不是整张单锁死的" — a conversion locks the
// line it consumed, never the whole document.
//
// The lock is now per line: a line with invoiced_qty > 0 is frozen (no change
// at all — even an UP edit would leave the PI sitting on a stale qty/price),
// every other line on the same GRN stays correctable with the usual
// compensating stock movement.

type GrnLineInvoiced = { invoicedQty?: number | null; invoiced_qty?: number | null };

/** The qty a purchase invoice has already billed off this GRN line. */
export function grnLineInvoicedQty(item: GrnLineInvoiced): number {
  return Number(item.invoicedQty ?? item.invoiced_qty) || 0;
}

/** A single GRN line is locked when a live PI has drawn any qty off it. */
export function isGrnLineLockedByPi(item: GrnLineInvoiced): boolean {
  return grnLineInvoicedQty(item) > 0;
}

/**
 * True only when EVERY line is invoiced — i.e. there is genuinely nothing left
 * to correct on this receipt. Used by the UI to hide the edit affordance
 * entirely; a partially-invoiced GRN still opens for edit, with the invoiced
 * lines individually locked.
 */
export function isGrnFullyLockedByDownstreamPi(items: GrnLineInvoiced[]): boolean {
  return items.length > 0 && items.every(isGrnLineLockedByPi);
}

/** How many lines on this GRN are frozen by a downstream PI. */
export function countGrnLinesLockedByPi(items: GrnLineInvoiced[]): number {
  return items.filter(isGrnLineLockedByPi).length;
}

/** The per-line refusal. Names the line so the operator knows which one. */
export function grnLineLockedByPiError(ref: string, invoicedQty: number): string {
  return `Line "${ref}" has been billed on a purchase invoice (${invoicedQty} invoiced) and can't be changed. Void or edit that invoice first — the other lines on this receipt can still be corrected.`;
}

/** The whole-document refusal, only used when every line is invoiced. */
export function grnLockedByDownstreamPiError(): string {
  return "Every line on this GRN has been billed on a purchase invoice. Void or edit the linked PI first to unlock the receipt for edit.";
}

/**
 * A POSTED GRN line whose accepted qty is being changed. Pure check, and the
 * ONE place the downstream-PI lock is applied per line:
 *
 *   • a line a PI has already billed (invoiced_qty > 0) is FROZEN — no change
 *     in either direction, because the invoice is sitting on that qty/price;
 *   • dropping below invoiced_qty gets its own, more specific message (it is
 *     the mistake operators actually make);
 *   • every other line is free to move, and a delta of 0 is always allowed so
 *     the unchanged lines of a partially-invoiced GRN pass straight through.
 *
 * Returns the per-line delta (new − old) when allowed, or a blocking error.
 * qty may be fractional.
 */
export type GrnLineEditResult =
  | { ok: true; delta: number }
  | { ok: false; error: string };

export function checkGrnLineQtyEdit(args: {
  ref: string;
  oldAcceptedQty: number;
  newAcceptedQty: number;
  invoicedQty: number;
}): GrnLineEditResult {
  const oldQty = Number(args.oldAcceptedQty) || 0;
  // Do NOT collapse the incoming qty with `|| 0` — a blank/NaN input must be
  // rejected, not silently treated as 0 (which would zero out the line).
  const newQty = Number(args.newAcceptedQty);
  const invoiced = Number(args.invoicedQty) || 0;

  if (!Number.isFinite(newQty) || newQty < 0) {
    return {
      ok: false,
      error: `Line "${args.ref}": accepted quantity must be 0 or more.`,
    };
  }
  // Can't reduce a received line below what a PI has already billed against it
  // — that would leave the invoice claiming more than the GRN now receives.
  if (newQty < invoiced) {
    return {
      ok: false,
      error: `Line "${args.ref}": can't reduce accepted quantity to ${newQty} — ${invoiced} has already been invoiced. Cancel or reduce the purchase invoice first.`,
    };
  }
  // An invoiced line is frozen at its billed figure. Unchanged is fine (delta
  // 0) so the rest of the receipt can still be saved around it.
  if (invoiced > 0 && newQty !== oldQty) {
    return { ok: false, error: grnLineLockedByPiError(args.ref, invoiced) };
  }
  return { ok: true, delta: newQty - oldQty };
}

/**
 * Plain-language summary of the stock movement a POSTED-GRN edit will make,
 * for the Confirm dialog. Positive delta = stock goes up; negative = down.
 * Returns null when nothing moves (all deltas zero).
 */
export function describeGrnStockDelta(
  lines: { ref: string; delta: number }[],
): string | null {
  const moving = lines.filter((l) => (Number(l.delta) || 0) !== 0);
  if (moving.length === 0) return null;
  const parts = moving.map((l) => {
    const d = Number(l.delta) || 0;
    const dir = d > 0 ? "+" : "−";
    return `${l.ref}: ${dir}${Math.abs(d)}`;
  });
  return `This will adjust stock on hand — ${parts.join(", ")}.`;
}
