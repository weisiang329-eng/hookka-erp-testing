// ---------------------------------------------------------------------------
// invoice-so-item-link.ts — the per-line link from a bill back to the SALES
// ORDER LINE it bills.
//
// BUG-2026-08-13-096. Every automated check that compares a sales order against
// the invoice it produced has to get from the invoice line back to the SO line.
// Measured on prod 2026-08-13, that route did not exist for 98.5% of the book:
//
//     total invoice lines             2,897
//     delivery_order_item_id IS NULL  2,854   (98.5%)
//     value on unlinked lines         RM 1,584,007.08
//
// So both of the system's own planners reported `0 items to fix` while three
// invoices demonstrably diverged from their sales orders. **"0 items" meant
// "cannot see", not "nothing wrong."**
//
// WHY NOT `delivery_order_item_id`
// --------------------------------
// That column is young — `do-partial-invoice.ts` added it for the convert-chain
// draw-down, so only invoices raised since then carry it. It is the right link
// for QUANTITY consumption and the wrong one for AUDIT REACH.
//
// `production_order_id` is the one that is actually populated. It was
// backfilled for BUG-2026-07-17-001 (355 invoices / 2,244 lines) and stood at
// **2,526 of 2,728 rows (92.6%)** when last counted on 2026-08-02. A production
// order records the SO it was made for, so it is the far better road out — and
// it is per-LINE, which means a CONSOLIDATED invoice whose lines come from
// several different sales orders resolves each line inside its OWN sales order.
// The invoice does not have to map to a single SO for the link to be exact.
//
// WHY NOT `production_orders.lineNo`
// ----------------------------------
// ⚠ It reads like the SO line number. It is not, and joining on it would write
// wrong links at scale. `_shared/production-builder.ts:786` binds **`poSequence`**
// into that column — a counter incremented once per PIECE:
//
//     for (const item of sortedItems)              // SO line
//       for (pieceIdx of 0..pieceCount)            // one PO per unit
//         poSequence++;                            // ← stored as lineNo
//
// while `sales_order_items.lineNo` is `idx + 1` per LINE
// (`routes/sales-orders.ts:2025`). The two counters agree only when every line
// on the order has quantity 1. A SO with line 1 × qty 3 then line 2 × qty 1
// produces production orders numbered 1, 2, 3, 4 — so the second SO line would
// be joined to line 4, which does not exist. Identity therefore comes from the
// production order's own SPEC, never from its lineNo.
//
// THE RULE THIS MODULE ENFORCES
// -----------------------------
// The owner's standing rule (memory: "migration copies, never computes"):
// **a migration reads the system's own value for that row, it never infers one.
// Blank stays blank. Ambiguous is SKIPPED.**
//
// A WRONG LINK IS WORSE THAN A MISSING ONE — a missing link reports "cannot
// see", which is honest; a wrong link makes a bad audit look authoritative,
// which is how the 98.5% blind spot got read as "clean" in the first place.
//
// So the resolver COUNTS candidates and refuses to pick:
//
//   exact  — inside the PO's OWN sales order, exactly ONE line matches on
//            product + size + fabric                         → link
//   code   — that key matches nothing (size/fabric drifted between the PO and
//            the SO line) AND exactly ONE line in that sales order carries the
//            product code at all                             → link
//   else   — two or more candidates, or none, or no PO link  → NULL
//
// Note what tier `code` is NOT: it is not "first one wins". If the sales order
// has two lines with that product code it is ambiguous and stays NULL. Being
// the only candidate in a specific sales order is an observation, not a guess.
//
// ⚠ DELIBERATE DIVERGENCE FROM `priceForItem` (do-value.ts). That resolver walks
// the same two tiers but its maps are built first-one-wins
// (`if (!byFull.has(fk)) byFull.set(fk, up)`), because for a PRICE any matching
// line's value will do. For IDENTITY it will not: first-one-wins is exactly the
// defect BUG-2026-07-17-001 was, where three lines inherited one SO's customer
// PO. Same two tiers, opposite tie-breaking, on purpose.
// ---------------------------------------------------------------------------
import type { D1Database } from "@cloudflare/workers-types";
import { runSelfApply, memoizeSelfApply } from "./self-apply";

// ---------------------------------------------------------------------------
// Runtime self-apply.
//
// Deploys do NOT replay `migrations-postgres/*.sql` in this repo — a migration
// file alone is INERT on prod (CLAUDE.md; HOOKKA-GOTCHAS "the #1 trap"). This
// is the load-bearing copy and MUST be awaited at the top of any handler before
// the first read/write of the column.
//
// It THROWS rather than degrading, and `memoizeSelfApply` drops the memo on
// failure so the next request retries instead of remembering a failed round as
// done (class C9). The older `invoice-po-link.ts` next door is best-effort
// because a missing PO link only degrades a PRINTOUT; this column is what an
// AUDIT reads, and an audit that silently loses its column reports "clean" —
// the precise failure this whole bug is about.
// ---------------------------------------------------------------------------
let _mig: Promise<void> | null = null;
export function ensureInvoiceSoItemLinkColumn(db: D1Database): Promise<void> {
  return memoizeSelfApply(
    () => _mig,
    (p) => {
      _mig = p;
    },
    () =>
      runSelfApply(db, "invoice-so-item-link", [
        // snake_case, so no column-rename-map entry is needed and route SQL
        // can name it directly (HOOKKA-GOTCHAS: a camelCase column without a
        // map entry silently 400s).
        "ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS so_item_id TEXT",
        "CREATE INDEX IF NOT EXISTS idx_invoice_items_so_item_id ON invoice_items (so_item_id)",
      ]),
  );
}

/** Test-only: forget the memo so a fresh self-apply round can be observed. */
export function __resetSoItemLinkMemoForTests(): void {
  _mig = null;
}

// ---------------------------------------------------------------------------
// The index + the pure resolver.
// ---------------------------------------------------------------------------

/** What a production order records about the sales-order line it was made for. */
export type PoSpec = {
  salesOrderId: string;
  productCode: string;
  sizeCode: string;
  fabricCode: string;
};

export type SoItemRow = {
  id: string;
  salesOrderId: string | null;
  productCode: string | null;
  sizeCode: string | null;
  fabricCode: string | null;
};

export type SoItemIdentityIndex = {
  /** full key → the single SO item id, present ONLY when the key is unique. */
  byFull: Map<string, string>;
  /** full keys carrying two or more SO lines — refuse, never pick. */
  ambiguousFull: Set<string>;
  /** `${soId}|${code}` → the single SO item id, present ONLY when unique. */
  byCode: Map<string, string>;
  /** code keys carrying two or more SO lines — refuse, never pick. */
  ambiguousCode: Set<string>;
};

/**
 * Why a line did or did not get a link. Reported verbatim by the dry-run
 * planner so "how many stay NULL and why" is a measured breakdown rather than
 * a single unexplained total.
 */
export type SoItemLinkOutcome =
  /** exactly one SO line on product+size+fabric, inside the PO's own SO */
  | "exact"
  /** spec drifted, but exactly one line in that SO carries the product code */
  | "code"
  /** the invoice line carries no production_order_id — nothing to resolve from */
  | "no-po-link"
  /** it carries one, but no such production order exists in this org */
  | "po-unknown"
  /** the production order has no sales order (a consignment-sourced PO) */
  | "po-has-no-so"
  /** two or more SO lines match — REFUSED, per "ambiguous is skipped" */
  | "ambiguous"
  /** the sales order has no line matching this spec or even this code */
  | "no-so-line";

export type SoItemLinkResult = {
  soItemId: string | null;
  outcome: SoItemLinkOutcome;
};

export function soItemFullKey(
  soId: string,
  code: string,
  sizeCode: string,
  fabricCode: string,
): string {
  return `${soId}|${code}|${sizeCode}|${fabricCode}`;
}

export function soItemCodeKey(soId: string, code: string): string {
  return `${soId}|${code}`;
}

/**
 * Build the identity index. PURE — takes rows, returns maps, touches no DB, so
 * the counting rule can be tested directly against adversarial fixtures.
 *
 * A key that two or more SO lines answer to is recorded in the `ambiguous*`
 * set and REMOVED from the lookup map, so there is no code path on which a
 * caller can read a contested key and get an answer.
 */
export function buildSoItemIdentity(
  soItems: readonly SoItemRow[],
): SoItemIdentityIndex {
  const byFull = new Map<string, string>();
  const ambiguousFull = new Set<string>();
  const byCode = new Map<string, string>();
  const ambiguousCode = new Set<string>();

  for (const si of soItems) {
    const soId = si.salesOrderId ?? "";
    const code = si.productCode ?? "";
    // A line with no sales order or no product code cannot be identified by
    // either key. Skip it rather than filing it under an empty key, which
    // would make every other blank line look like its twin.
    if (!soId || !code || !si.id) continue;

    const fk = soItemFullKey(soId, code, si.sizeCode ?? "", si.fabricCode ?? "");
    if (ambiguousFull.has(fk)) {
      // already contested — nothing to do
    } else if (byFull.has(fk)) {
      // Second claimant. Withdraw the first: a contested key must not resolve.
      byFull.delete(fk);
      ambiguousFull.add(fk);
    } else {
      byFull.set(fk, si.id);
    }

    const ck = soItemCodeKey(soId, code);
    if (ambiguousCode.has(ck)) {
      // already contested
    } else if (byCode.has(ck)) {
      byCode.delete(ck);
      ambiguousCode.add(ck);
    } else {
      byCode.set(ck, si.id);
    }
  }

  return { byFull, ambiguousFull, byCode, ambiguousCode };
}

/**
 * Resolve ONE invoice/DO line's sales-order line, from the production order it
 * was built for. PURE.
 *
 * Returns `soItemId: null` for every outcome that is not `exact` / `code`.
 * There is deliberately no "best effort" branch — see the header.
 */
export function resolveSoItemId(
  idx: SoItemIdentityIndex,
  poById: ReadonlyMap<string, PoSpec>,
  productionOrderId: string | null | undefined,
): SoItemLinkResult {
  if (!productionOrderId) return { soItemId: null, outcome: "no-po-link" };
  const po = poById.get(productionOrderId);
  if (!po) return { soItemId: null, outcome: "po-unknown" };
  if (!po.salesOrderId) return { soItemId: null, outcome: "po-has-no-so" };

  const fk = soItemFullKey(
    po.salesOrderId,
    po.productCode,
    po.sizeCode,
    po.fabricCode,
  );
  // Contested on the tight key. Do NOT fall through to the looser one — a key
  // that two lines answer to cannot become decidable by asking a vaguer
  // question, and falling through is how a "smarter guess" gets written.
  if (idx.ambiguousFull.has(fk)) return { soItemId: null, outcome: "ambiguous" };
  const exact = idx.byFull.get(fk);
  if (exact) return { soItemId: exact, outcome: "exact" };

  // No line matches the tight key at all — the PO's size/fabric drifted from
  // the SO line's (the same drift `priceForItem` tier 2 exists for). Accept
  // ONLY if the product code has a single claimant in this sales order.
  const ck = soItemCodeKey(po.salesOrderId, po.productCode);
  if (idx.ambiguousCode.has(ck)) return { soItemId: null, outcome: "ambiguous" };
  const byCode = idx.byCode.get(ck);
  if (byCode) return { soItemId: byCode, outcome: "code" };

  return { soItemId: null, outcome: "no-so-line" };
}

/**
 * Resolve a HANDFUL of production orders to their sales-order lines, without
 * loading the whole org. For paths that touch one invoice (the invoice PUT, the
 * backfill's per-batch pass) — `loadSoLinePriceIndex` already carries the
 * whole-org index for paths that need the prices anyway.
 *
 * ⚠ Why a subset is safe here, and would not be if it were sliced differently:
 * ambiguity is decided WITHIN one sales order, and step 2 loads **every** line
 * of each sales order involved — not just the lines that look like a match. So
 * a contested key is seen as contested. Narrowing that second query to, say,
 * the product codes on the invoice would silently turn "two claimants" into
 * "one" and start writing exactly the wrong links this module exists to refuse.
 */
export async function resolveSoItemIdsForPoIds(
  db: D1Database,
  poIds: readonly string[],
): Promise<Map<string, SoItemLinkResult>> {
  const out = new Map<string, SoItemLinkResult>();
  const ids = [...new Set(poIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;

  const poRes = await db
    .prepare(
      `SELECT id, salesOrderId, productCode, sizeCode, fabricCode
         FROM production_orders WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(...ids)
    .all<{
      id: string;
      salesOrderId: string | null;
      productCode: string | null;
      sizeCode: string | null;
      fabricCode: string | null;
    }>();

  const poById = new Map<string, PoSpec>();
  for (const p of poRes.results ?? []) {
    poById.set(p.id, {
      salesOrderId: p.salesOrderId ?? "",
      productCode: p.productCode ?? "",
      sizeCode: p.sizeCode ?? "",
      fabricCode: p.fabricCode ?? "",
    });
  }

  const soIds = [
    ...new Set(
      [...poById.values()].map((p) => p.salesOrderId).filter((x) => !!x),
    ),
  ];
  let soItems: SoItemRow[] = [];
  if (soIds.length > 0) {
    const siRes = await db
      .prepare(
        `SELECT id, salesOrderId, productCode, sizeCode, fabricCode
           FROM sales_order_items
          WHERE salesOrderId IN (${soIds.map(() => "?").join(",")})`,
      )
      .bind(...soIds)
      .all<SoItemRow>();
    soItems = siRes.results ?? [];
  }

  const idx = buildSoItemIdentity(soItems);
  for (const poId of ids) out.set(poId, resolveSoItemId(idx, poById, poId));
  return out;
}

/**
 * Read the link off an invoice-item row, dual-keyed. The runtime ALTER makes it
 * snake_case, but a driver or mirror echoing camelCase must not silently read
 * `undefined` — that would send an audit back to reporting "nothing to fix"
 * without a word, which is the bug.
 */
export function readInvoiceItemSoLink(
  row: Record<string, unknown> | null | undefined,
): string | null {
  if (!row) return null;
  const v =
    (row as { soItemId?: unknown }).soItemId ??
    (row as { so_item_id?: unknown }).so_item_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}
