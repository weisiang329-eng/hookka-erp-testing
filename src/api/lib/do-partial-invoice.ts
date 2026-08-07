// ---------------------------------------------------------------------------
// do-partial-invoice.ts — the sales-side convert chain: DO line → invoice line.
//
// WHAT WAS MISSING
// ----------------
// Purchasing has had a per-line consumed counter for a long time — a purchase
// order line carries `receivedQty`, a goods-receipt line carries
// `invoiced_qty`, and a purchase-invoice line records the GRN line it bills
// (`grn_item_id`). That is what makes a receipt billable across SEVERAL
// purchase invoices, and what lets a deleted / cancelled invoice hand its
// quantities back so somebody else can bill them.
//
// The SALES side had none of it. `delivery_order_items` had `quantity` and
// nothing else; `invoice_items` had no link to the DO line it billed. So an
// invoice was ONE-SHOT and WHOLE-DOCUMENT: bill the entire delivery or nothing,
// and a partial unique index (`uniq_invoice_active_delivery_order`) forbade a
// second live invoice at the storage layer. Owner's rule is the opposite —
// "我应该可以在其中一个 Purchase Invoice 里面 delete 掉，然后重新 generate 成
// 另外一个 Invoice": a conversion is partial and repeatable, never a lock.
//
// This module is the DB half of that chain. The ARITHMETIC is not here — it is
// `src/lib/convert-chain.ts`, the same availability / over-draw / clamped-
// restore seam purchasing uses. One seam, two chains.
//
//   consume  delivery_order_items.invoiced_qty   += billed qty   (this module)
//   link     invoice_items.delivery_order_item_id = the DO line  (this module)
//   restore  invoiced_qty -= min(billed, current) on void / delete / line drop
//
// BACKWARDS COMPATIBILITY — the part that could invite double-billing
// ------------------------------------------------------------------
// Every invoice that already exists was written before `delivery_order_item_id`
// existed, so its lines carry no link and the new counters read 0. If billed
// state were derived from the counters ALONE, every already-billed delivery
// order in the book would suddenly read as UNBILLED and become re-billable —
// the system would invite the operator to charge customers twice.
//
// So the derived state has two inputs, not one:
//
//   fullyInvoiced = (remaining quantity is 0)
//                   OR (a LIVE invoice bills this DO with no per-line links)
//
// The second clause is the legacy invoice. It is exactly the old one-shot
// whole-document bill, and it keeps behaving exactly as it does today: one live
// invoice ⇒ the DO is fully billed ⇒ a second is refused, with the same message
// the operator already knows. Nothing in the existing book changes state, and
// nothing becomes newly re-billable. Void the legacy invoice and the DO becomes
// billable again with zero consumed — which is correct, because a voided
// invoice bills nothing.
//
// We deliberately do NOT backfill `invoiced_qty` from existing invoice lines.
// The mapping would have to be guessed by product code, and two of the three
// invoice-building fallbacks (bill the SO lines / bill the SO header total)
// produce lines that have no DO line behind them at all. A guessed backfill
// that lands short is a licence to bill the difference twice, silently. A
// refusal is recoverable; a double-charged customer is not.
// ---------------------------------------------------------------------------
import type { D1Database } from "@cloudflare/workers-types";
import { availableQty, clampDecrement } from "../../lib/convert-chain";
import { runSelfApply, memoizeSelfApply } from "./self-apply";

// ---------------------------------------------------------------------------
// Runtime self-apply. Deploys do NOT replay migration files in this repo, so
// this is the load-bearing copy — it MUST be awaited at the top of any handler
// before the first read/write of these columns.
//
// It THROWS rather than degrading. Half of this DDL is the over-draw backstop;
// an isolate that quietly carried on without it would bill customers twice for
// exactly the race the constraint exists to lose. memoizeSelfApply drops the
// memo on failure so the next request retries instead of remembering a failed
// round as done (self-apply.ts).
// ---------------------------------------------------------------------------
let _mig: Promise<void> | null = null;
export function ensureDoPartialInvoiceColumns(db: D1Database): Promise<void> {
  return memoizeSelfApply(
    () => _mig,
    (p) => {
      _mig = p;
    },
    () =>
      runSelfApply(db, "do-partial-invoice", [
    // The per-line consumed counter. snake_case so no column-rename-map entry
    // is needed. INTEGER — delivered goods are whole units (unlike purchasing,
    // where metre/length raw materials make the GRN counter NUMERIC).
    "ALTER TABLE delivery_order_items ADD COLUMN IF NOT EXISTS invoiced_qty INTEGER NOT NULL DEFAULT 0",
    // The link from a bill line back to the DO line it bills. Nullable: legacy
    // rows have none, and the SO-line / SO-total invoice fallbacks have no DO
    // line to point at.
    "ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS delivery_order_item_id TEXT",
    "CREATE INDEX IF NOT EXISTS idx_invoice_items_do_item_id ON invoice_items (delivery_order_item_id)",
    // The storage-layer backstop that REPLACES uniq_invoice_active_delivery_order.
    // That index existed to stop a concurrent double-create (BUG-2026-07-14-006)
    // and had to go — a second live invoice is now the whole point. The race it
    // guarded is now "two concurrent bills that together draw more than the DO
    // delivered", and this CHECK is what makes the second one fail at the
    // storage layer instead of over-billing the customer.
    "ALTER TABLE delivery_order_items ADD CONSTRAINT chk_doi_invoiced_qty CHECK (invoiced_qty >= 0 AND invoiced_qty <= quantity)",
    // And drop the index it replaces. Without this the FIRST partial second
    // invoice fails at INSERT with a duplicate-key error.
    "DROP INDEX IF EXISTS uniq_invoice_active_delivery_order",
      ]),
  );
}

// ---------------------------------------------------------------------------
// The derived billing state of one delivery order.
// ---------------------------------------------------------------------------
export type DoLineBillingState = {
  id: string;
  productionOrderId: string | null;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  invoicedQty: number;
  /** quantity − invoicedQty, floored at 0 (convert-chain.availableQty). */
  remainingQty: number;
};

export type DoBillingState = {
  lines: DoLineBillingState[];
  totalQty: number;
  invoicedQty: number;
  remainingQty: number;
  /**
   * Nothing left to bill — either every line is drawn down, or a legacy
   * whole-document invoice still stands (see the header note).
   */
  fullyInvoiced: boolean;
  /**
   * EVERY live invoice on this DO whose lines carry no per-line link: the old
   * one-shot bill. Non-empty ⇒ this DO predates partial billing and must keep
   * behaving as it does today.
   *
   * A LIST, not a single row, because the caller that matters most is the
   * invoice-death path: it has to ask "is there ANOTHER legacy invoice besides
   * the one dying". With only the first match, a DO carrying two legacy bills
   * would release on the death of either.
   */
  legacyInvoices: Array<{ id: string; invoiceNo: string; status: string }>;
  /** Convenience: the first legacy invoice, or null. */
  legacyInvoice: { id: string; invoiceNo: string; status: string } | null;
  /** Live (non-CANCELLED) invoices on this DO, legacy or not. */
  liveInvoiceCount: number;
};

const num = (v: unknown): number => Number(v ?? 0) || 0;

export async function loadDoBillingState(
  db: D1Database,
  doId: string,
): Promise<DoBillingState> {
  // Quoted camelCase aliases: an UNQUOTED `AS invoiced_qty` comes back
  // CAMELCASED by the adapter, so the quoted form is the only one that reads
  // predictably (CLAUDE.md). Still dual-keyed below for raw / mock rows.
  const itemsRes = await db
    .prepare(
      `SELECT id, productionOrderId, productCode, productName, sizeLabel,
              fabricCode, quantity, invoiced_qty AS "invoicedQty"
         FROM delivery_order_items
        WHERE deliveryOrderId = ?
        ORDER BY id`,
    )
    .bind(doId)
    .all<{
      id: string;
      productionOrderId?: string | null;
      productCode?: string | null;
      productName?: string | null;
      sizeLabel?: string | null;
      fabricCode?: string | null;
      quantity: number;
      invoicedQty?: number | null;
      invoiced_qty?: number | null;
    }>();

  const lines: DoLineBillingState[] = (itemsRes.results ?? []).map((r) => {
    const quantity = num(r.quantity);
    const invoiced = num(r.invoicedQty ?? r.invoiced_qty);
    return {
      id: String(r.id),
      productionOrderId: r.productionOrderId ?? null,
      productCode: r.productCode ?? "",
      productName: r.productName ?? "",
      sizeLabel: r.sizeLabel ?? "",
      fabricCode: r.fabricCode ?? "",
      quantity,
      invoicedQty: invoiced,
      remainingQty: availableQty(quantity, invoiced),
    };
  });

  const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
  const invoicedQty = lines.reduce((s, l) => s + l.invoicedQty, 0);
  const remainingQty = lines.reduce((s, l) => s + l.remainingQty, 0);

  // Live invoices on this DO, and whether any of them is a legacy whole-
  // document bill (no line carries a DO-line link).
  const liveRes = await db
    .prepare(
      `SELECT id, invoiceNo, status FROM invoices
        WHERE deliveryOrderId = ? AND status <> 'CANCELLED'
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(doId)
    .all<{ id: string; invoiceNo: string | null; status: string }>();
  const live = liveRes.results ?? [];

  const legacyInvoices: DoBillingState["legacyInvoices"] = [];
  for (const inv of live) {
    const linked = await db
      .prepare(
        `SELECT id FROM invoice_items
          WHERE invoiceId = ? AND delivery_order_item_id IS NOT NULL LIMIT 1`,
      )
      .bind(inv.id)
      .first<{ id: string }>();
    if (!linked) {
      legacyInvoices.push({
        id: inv.id,
        invoiceNo: inv.invoiceNo ?? inv.id,
        status: inv.status,
      });
    }
  }
  const legacyInvoice = legacyInvoices[0] ?? null;

  return {
    lines,
    totalQty,
    invoicedQty,
    remainingQty,
    // A DO with no priceable lines at all (totalQty 0) is "fully invoiced" only
    // once something bills it — otherwise a legitimate zero-quantity document
    // could never be billed at all.
    fullyInvoiced:
      legacyInvoice !== null || (totalQty > 0 && remainingQty <= 0),
    legacyInvoices,
    legacyInvoice,
    liveInvoiceCount: live.length,
  };
}

/**
 * The operator-facing reason this delivery order cannot be billed again, or
 * null when it can. ONE message per case, naming what is already billed and
 * what to do next — "already invoiced" with no numbers is what sends people
 * back to re-clicking the same button.
 */
export function doBillingRefusal(
  doNo: string,
  st: DoBillingState,
): string | null {
  if (st.legacyInvoice) {
    return `This delivery order is already invoiced (${st.legacyInvoice.invoiceNo}). Cancel that invoice before re-invoicing.`;
  }
  if (st.totalQty > 0 && st.remainingQty <= 0) {
    return `${doNo} is fully invoiced — all ${st.totalQty} delivered unit(s) are billed across ${st.liveInvoiceCount} invoice(s). Void one of them to free its quantities.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CONSUME — the draw-down that a new / edited invoice line performs.
// ---------------------------------------------------------------------------
export type DoDraw = { deliveryOrderItemId: string; quantity: number };

/**
 * Fold a requested draw-down onto the DO's current state and either return the
 * UPDATE statements or the FIRST over-draw, worded per line. Grouped by DO line
 * first, because two invoice lines can point at the same delivery line and
 * neither alone would exceed the ceiling.
 */
export function buildDrawdownStatements(
  db: D1Database,
  st: DoBillingState,
  draws: DoDraw[],
):
  | { ok: true; statements: D1PreparedStatement[] }
  | { ok: false; error: string } {
  const byLine = new Map<string, number>();
  for (const d of draws) {
    const q = num(d.quantity);
    if (!d.deliveryOrderItemId || q <= 0) continue;
    byLine.set(
      d.deliveryOrderItemId,
      (byLine.get(d.deliveryOrderItemId) ?? 0) + q,
    );
  }
  if (byLine.size === 0) return { ok: true, statements: [] };

  const lineById = new Map(st.lines.map((l) => [l.id, l]));
  const statements: D1PreparedStatement[] = [];
  for (const [doItemId, want] of byLine) {
    const line = lineById.get(doItemId);
    if (!line) {
      return {
        ok: false,
        error: `A requested line (${doItemId}) is not on this delivery order — reload the delivery order and pick the lines again.`,
      };
    }
    if (want > line.remainingQty) {
      const label = line.productCode || line.productName || doItemId;
      return {
        ok: false,
        error: `Line "${label}": requested ${want} exceeds the ${line.remainingQty} still un-invoiced (delivered ${line.quantity}, already billed ${line.invoicedQty}). Bill at most ${line.remainingQty}.`,
      };
    }
    statements.push(
      db
        .prepare(
          "UPDATE delivery_order_items SET invoiced_qty = invoiced_qty + ? WHERE id = ?",
        )
        .bind(want, doItemId),
    );
  }
  return { ok: true, statements };
}

// ---------------------------------------------------------------------------
// RESTORE — every increment is paired with its decrement.
//
// Called on invoice VOID, on DRAFT DELETE, and on a DRAFT line replacement
// (there against the OLD line set, before the new one re-consumes). Clamped
// with convert-chain's clampDecrement so a double-restore can never drive a
// counter below 0 — the same discipline buildGrnRestoreStatements follows on
// the purchasing side.
// ---------------------------------------------------------------------------
export async function buildInvoiceLineReleaseStatements(
  db: D1Database,
  invoiceId: string,
): Promise<D1PreparedStatement[]> {
  const linesRes = await db
    .prepare(
      `SELECT delivery_order_item_id AS "deliveryOrderItemId", quantity
         FROM invoice_items WHERE invoiceId = ?`,
    )
    .bind(invoiceId)
    .all<{
      deliveryOrderItemId?: string | null;
      delivery_order_item_id?: string | null;
      quantity: number;
    }>();

  const wantByLine = new Map<string, number>();
  for (const ln of linesRes.results ?? []) {
    const doItemId = ln.deliveryOrderItemId ?? ln.delivery_order_item_id ?? null;
    if (!doItemId) continue; // legacy / fallback line — nothing was consumed
    const q = num(ln.quantity);
    if (q <= 0) continue;
    wantByLine.set(String(doItemId), (wantByLine.get(String(doItemId)) ?? 0) + q);
  }
  if (wantByLine.size === 0) return [];

  const statements: D1PreparedStatement[] = [];
  for (const [doItemId, want] of wantByLine) {
    const row = await db
      .prepare(
        `SELECT invoiced_qty AS "invoicedQty" FROM delivery_order_items WHERE id = ?`,
      )
      .bind(doItemId)
      .first<{ invoicedQty?: number | null; invoiced_qty?: number | null }>();
    const current = num(row?.invoicedQty ?? row?.invoiced_qty);
    const dec = clampDecrement(current, want);
    if (dec <= 0) continue;
    statements.push(
      db
        .prepare(
          "UPDATE delivery_order_items SET invoiced_qty = invoiced_qty - ? WHERE id = ?",
        )
        .bind(dec, doItemId),
    );
  }
  return statements;
}

/**
 * The DO's own status flag, kept honest against the counters.
 *
 * The flag is no longer the source of truth — Σ invoiced_qty vs Σ quantity is
 * — but the flag still drives the grid, the "Transfer to Invoice" button and
 * POST /api/invoices' own gate, so it has to AGREE. A DO billed in halves must
 * stay DELIVERED after the first half (or the second could never be raised),
 * and must fall back to DELIVERED the moment a void frees quantity again.
 *
 * Every UPDATE re-asserts the from-status so a concurrent writer that got there
 * first turns this into a no-op rather than a downgrade.
 */
export function buildDoStatusSyncStatement(
  db: D1Database,
  doId: string,
  currentStatus: string,
  fullyInvoiced: boolean,
  now: string,
): D1PreparedStatement | null {
  if (fullyInvoiced && currentStatus === "DELIVERED") {
    return db
      .prepare(
        `UPDATE delivery_orders SET status = 'INVOICED', overdue = 'INVOICED', updated_at = ?
          WHERE id = ? AND status = 'DELIVERED'`,
      )
      .bind(now, doId);
  }
  if (!fullyInvoiced && currentStatus === "INVOICED") {
    return db
      .prepare(
        `UPDATE delivery_orders SET status = 'DELIVERED', overdue = 'COMPLETED', updated_at = ?
          WHERE id = ? AND status = 'INVOICED'`,
      )
      .bind(now, doId);
  }
  return null;
}
