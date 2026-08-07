// ---------------------------------------------------------------------------
// convert-chain.ts — pure availability / double-convert math for the
// purchasing convert chain (PO → GRN → PI).
//
// The chain tracks per-line CONSUMED quantity so the convert flow can:
//   (a) consolidate multiple upstream documents,
//   (b) prevent double-convert / double-bill at the LINE level, and
//   (c) restore availability when a converted line is deleted / cancelled.
//
// This module holds ONLY the arithmetic + validation. The DB reads/writes
// (and the runtime ALTER self-applies) live in the routes:
//   - PO → GRN consume:   purchase_order_items.receivedQty   (grn.ts)
//   - GRN → PI consume:    grn_items.invoiced_qty             (purchase-invoices.ts)
//
// Money stays integer sen; quantities are plain numbers (qty can be
// fractional for metre/length-based raw materials, so we do NOT round).
// ---------------------------------------------------------------------------

/**
 * Remaining available quantity on a line = ordered − consumed, floored at 0.
 *
 * A negative result (consumed > ordered, e.g. an over-receipt past the
 * tolerance) is clamped to 0 so a picker never offers a negative remaining.
 */
export function availableQty(orderedQty: number, consumedQty: number): number {
  const ordered = Number(orderedQty) || 0;
  const consumed = Number(consumedQty) || 0;
  const avail = ordered - consumed;
  return avail > 0 ? avail : 0;
}

/** A single requested convert line, mapped to its upstream source line. */
export type ConvertLineRequest = {
  /** Stable key for error messages — the source line id or a label. */
  ref: string;
  /** Quantity ordered on the upstream source line. */
  orderedQty: number;
  /** Quantity already consumed on the upstream source line. */
  consumedQty: number;
  /** Quantity this convert is requesting from the source line. */
  requestedQty: number;
};

export type LineGuardResult =
  | { ok: true }
  | { ok: false; ref: string; available: number; requested: number; error: string };

/**
 * Line-level over-convert guard. Validates that a single requested quantity
 * does not exceed the source line's remaining availability.
 *
 * Replaces the old PO-LEVEL 409 (which blocked ANY 2nd invoice for a PO even
 * when quantity remained). Here a 2nd convert is allowed as long as every
 * requested line still has availability — only the over-drawn line is
 * rejected.
 *
 * A request of 0 (or negative) is always allowed (no-op line / credit line).
 */
export function checkLineAvailable(line: ConvertLineRequest): LineGuardResult {
  const requested = Number(line.requestedQty) || 0;
  if (requested <= 0) return { ok: true };
  const available = availableQty(line.orderedQty, line.consumedQty);
  if (requested > available) {
    return {
      ok: false,
      ref: line.ref,
      available,
      requested,
      error: `Line "${line.ref}": requested ${requested} exceeds available ${available} (ordered ${Number(line.orderedQty) || 0}, already converted ${Number(line.consumedQty) || 0}).`,
    };
  }
  return { ok: true };
}

/**
 * Validate a whole convert payload. Returns ok only when EVERY line passes;
 * otherwise returns the FIRST failing line so the caller can 409 with a clear
 * per-line message. Lines that draw 0 are skipped (fee / tax / rebate lines
 * that don't map to a stocked source line).
 */
export function checkConvertAvailability(
  lines: ConvertLineRequest[],
): LineGuardResult {
  for (const line of lines) {
    const r = checkLineAvailable(line);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/**
 * The quantity a PURCHASE ORDER line may be invoiced for, in total.
 *
 * Normally that is what was ordered. But a receipt is allowed to run slightly
 * OVER the order (grn.ts accepts up to the over-receipt tolerance), and goods
 * that were accepted into stock WILL be invoiced — refusing that invoice would
 * leave a real liability un-recordable. So the ceiling is the GREATER of
 * ordered and actually-received.
 *
 * One ceiling for both invoice paths (straight off the PO, and off a GRN that
 * resolves to the PO). Two ceilings that can disagree is what let a PO be
 * billed twice for the same goods — BUG-2026-08-07-003.
 */
export function poInvoiceCeiling(orderedQty: number, receivedQty: number): number {
  const ordered = Number(orderedQty) || 0;
  const received = Number(receivedQty) || 0;
  return received > ordered ? received : ordered;
}

/**
 * Error text for a PO-ceiling block. An operator told only "over the limit"
 * retries the same number, so this names the MATERIAL, what was REQUESTED, and
 * what the purchase order actually has LEFT.
 */
export function poCeilingError(o: {
  materialCode: string;
  materialName?: string | null;
  poNo?: string | null;
  requested: number;
  remaining: number;
  ceiling: number;
  invoiced: number;
}): string {
  // PO line names are mashed as "CODE - DESCRIPTION" — don't print the code twice.
  const raw = (o.materialName ?? "").trim();
  const desc = raw.startsWith(`${o.materialCode} - `)
    ? raw.slice(o.materialCode.length + 3)
    : raw;
  const named = desc && desc !== o.materialCode ? ` (${desc})` : "";
  const po = o.poNo ? `PO ${o.poNo}` : "this purchase order";
  return `Line "${o.materialCode}"${named}: requested ${o.requested} exceeds ${po} remaining ${o.remaining} — the PO allows ${o.ceiling} and ${o.invoiced} is already invoiced. Bill at most ${o.remaining} against this PO, or amend the PO.`;
}

/**
 * Clamp a decrement so a restore can never drive a consumed counter below 0.
 * Used by the delete / cancel restore paths: decrement by min(amount, current).
 */
export function clampDecrement(currentConsumed: number, decrementBy: number): number {
  const current = Number(currentConsumed) || 0;
  const dec = Number(decrementBy) || 0;
  if (dec <= 0) return 0;
  return dec > current ? current : dec;
}
