// ---------------------------------------------------------------------------
// pricing-integrity.ts — money invariants, checked every day.
//
// WHY THIS EXISTS
// Three price defects ran for months before anyone noticed, and all three were
// found by hand only when the owner happened to ask:
//
//   RM 12,455  divan / leg height surcharge never charged on scanned POs.
//              Started May 2026. Found 2026-07-22.
//   RM  8,060  special-order surcharge, same shape. Found 2026-07-17.
//   RM 17,910  invoice lines billing below their sales order (202 lines).
//
// Every one of them is a one-line SQL invariant. Had these run nightly, the
// first would have shown up the day it started instead of after ~10 weeks and
// 105 mispriced lines. Tests protect the CODE; only a data check protects the
// DATA — a config edit, a partial migration or a new client can all break the
// invariant without a single line of code changing.
//
// Read-only by construction: every check is a SELECT.
//
// A CHECK THAT COULD NOT RUN NOW SAYS SO (2026-08-14, BUG-2026-08-13-141).
// These used to catch and return [], which the daily report rendered as "no
// pricing issues" — the strongest possible all-clear, produced by a query that
// never completed. Trap 2 below is the proof this was not theoretical: a
// boolean-vs-int type error threw on EVERY row, the catch ate it, and the check
// reported a clean book. Each check now rethrows; `collectComplianceData` marks
// it UNAVAILABLE and the report prints "could not check" instead of a zero.
//
// TWO Postgres-dialect traps this file was born with and now guards against
// (both found only by running it on prod — the unit tests use a stub and can
// never catch SQL-dialect issues):
//   1. Column ALIASES must be snake_case (`AS so_unit_sen`). Postgres folds an
//      unquoted alias to lowercase, and the SupabaseAdapter only camelCases
//      keys that contain an underscore — so `AS soUnit` comes back as `sounit`,
//      and `r.soUnit` reads undefined → the amount silently computes to 0.
//   2. `isServiceOrder` is a BOOLEAN. `COALESCE(x, 0) <> 1` is a boolean-vs-int
//      type error that throws, gets swallowed by the catch, and the whole check
//      returns [] — i.e. it misses everything, silently. Use
//      `NOT COALESCE(x, false)`, the same idiom the SO routes use.
//
// Deliberately CHEAP — this runs with the rest of the daily sweep:
//   * live, non-service sales-order lines only
//   * the invoice comparison uses the direct production_order_id join, not the
//     DO-position fallback, which is far more expensive. It therefore covers
//     newer invoices; the deeper sweep stays a manual audit script.
// ---------------------------------------------------------------------------

// Same shape compliance-report.ts uses, so this plugs straight into the daily
// sweep: everything goes through .bind() even when there are no parameters.
interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export type PricingIssueKind =
  | "UNIT_NOT_SUM_OF_PARTS"
  | "HEIGHT_CHOSEN_BUT_FREE"
  | "INVOICE_BELOW_SO";

export interface PricingIssueRow {
  kind: PricingIssueKind;
  /** Human reference — the document the operator would open. */
  ref: string;
  detail: string;
  /** Money at stake in sen. Positive = we are under-charging. */
  amountSen: number;
}

const KV_KEY = "variants-config";

/** Owner-editable height price lists. Throws when the config cannot be read —
 *  see the CANNOT-CHECK note in the header. It used to return null, and the
 *  caller turned that into `[]`, i.e. "no under-priced heights found". */
async function loadHeightPrices(
  db: DbLike,
): Promise<{ divan: Map<number, number>; leg: Map<number, number> } | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(KV_KEY)
      .first<{ value: string }>();
    if (!row?.value) return null;
    const cfg = JSON.parse(row.value) as Record<string, unknown>;
    const toMap = (key: string) => {
      const out = new Map<number, number>();
      const raw = cfg[key];
      if (!Array.isArray(raw)) return out;
      for (const e of raw) {
        if (!e || typeof e !== "object") continue;
        const { value, priceSen } = e as { value?: unknown; priceSen?: unknown };
        const m = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
        const p = Number(priceSen);
        if (!m || !Number.isFinite(p)) continue;
        out.set(Number(m[0]), p);
      }
      return out;
    };
    return { divan: toMap("divanHeights"), leg: toMap("legHeights") };
  } catch (err) {
    console.error("[pricing-integrity] loadHeightPrices failed:", err);
    throw err;
  }
}

/** unit_price must equal base + divan + leg + special (src/lib/pricing.ts).
 *  A line that fails this has had a component silently dropped or double-added. */
async function checkUnitNotSumOfParts(db: DbLike): Promise<PricingIssueRow[]> {
  try {
    const res = await db
      .prepare(
        `SELECT so.companySOId, soi.lineNo, soi.productCode, soi.quantity,
                soi.unitPriceSen, soi.basePriceSen, soi.divanPriceSen,
                soi.legPriceSen, soi.specialOrderPriceSen, soi.totalHeightPriceSen
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.salesOrderId
          WHERE so.status <> 'CANCELLED'
            AND COALESCE(soi.unitPriceSen,0) <>
                COALESCE(soi.basePriceSen,0) + COALESCE(soi.divanPriceSen,0)
                + COALESCE(soi.legPriceSen,0) + COALESCE(soi.specialOrderPriceSen,0)
                + COALESCE(soi.totalHeightPriceSen,0)
          LIMIT 200`,
      )
      .bind()
      .all<Record<string, number | string | null>>();
    return (res.results ?? []).map((r) => {
      const parts =
        Number(r.basePriceSen ?? 0) + Number(r.divanPriceSen ?? 0) +
        Number(r.legPriceSen ?? 0) + Number(r.specialOrderPriceSen ?? 0) +
        Number(r.totalHeightPriceSen ?? 0);
      const unit = Number(r.unitPriceSen ?? 0);
      return {
        kind: "UNIT_NOT_SUM_OF_PARTS" as const,
        ref: `${r.companySOId} L${r.lineNo}`,
        detail: `${r.productCode}: unit ${unit} vs base+divan+leg+special ${parts}`,
        amountSen: (parts - unit) * (Number(r.quantity) || 1),
      };
    });
  } catch (err) {
    console.error("[pricing-integrity] unitNotSumOfParts failed:", err);
    throw err;
  }
}

/** A height the owner's list PRICES, stored at 0. This is the shape that lost
 *  RM 12,455 — scanned POs post the height with no price. */
async function checkHeightChosenButFree(db: DbLike): Promise<PricingIssueRow[]> {
  const prices = await loadHeightPrices(db);
  // A missing/empty config is a real "nothing is priced", not a failure —
  // loadHeightPrices THROWS if it could not read. `null` only survives when the
  // row itself is absent.
  if (!prices) return [];
  try {
    const res = await db
      .prepare(
        `SELECT so.companySOId, so.status, soi.lineNo, soi.productCode, soi.quantity,
                soi.divanHeightInches, soi.divanPriceSen,
                soi.legHeightInches, soi.legPriceSen
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.salesOrderId
          WHERE so.status NOT IN ('CANCELLED')
            AND NOT COALESCE(so.isServiceOrder, false)
            AND (COALESCE(soi.divanPriceSen,0) = 0 OR COALESCE(soi.legPriceSen,0) = 0)
          LIMIT 2000`,
      )
      .bind()
      .all<Record<string, number | string | null>>();
    const out: PricingIssueRow[] = [];
    for (const r of res.results ?? []) {
      const qty = Number(r.quantity) || 1;
      const owed =
        (Number(r.divanPriceSen ?? 0) === 0
          ? prices.divan.get(Number(r.divanHeightInches)) ?? 0
          : 0) +
        (Number(r.legPriceSen ?? 0) === 0
          ? prices.leg.get(Number(r.legHeightInches)) ?? 0
          : 0);
      if (owed <= 0) continue;
      out.push({
        kind: "HEIGHT_CHOSEN_BUT_FREE",
        ref: `${r.companySOId} L${r.lineNo}`,
        detail: `${r.productCode}: divan ${r.divanHeightInches ?? "-"}" / leg ${r.legHeightInches ?? "-"}" priced at 0 (${r.status})`,
        amountSen: owed * qty,
      });
    }
    return out;
  } catch (err) {
    console.error("[pricing-integrity] heightChosenButFree failed:", err);
    throw err;
  }
}

/** An issued invoice line billing less than the sales-order line it came from.
 *  Joined on productionOrderId, so this sees invoices that carry the link. */
async function checkInvoiceBelowSo(db: DbLike): Promise<PricingIssueRow[]> {
  try {
    const res = await db
      .prepare(
        `SELECT i.invoiceNo, i.status, so.companySOId, soi.lineNo, soi.productCode,
                soi.unitPriceSen AS so_unit_sen, ii.unitPriceSen AS inv_unit_sen, ii.quantity
           FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoiceId
           JOIN sales_orders so ON ii.productionOrderId LIKE 'pord-' || so.id || '-%'
           JOIN sales_order_items soi
             ON soi.salesOrderId = so.id
            AND ii.productionOrderId = 'pord-' || so.id || '-' ||
                CASE WHEN soi.lineNo < 10 THEN '0' || soi.lineNo ELSE '' || soi.lineNo END
          WHERE i.status <> 'CANCELLED'
            AND COALESCE(ii.unitPriceSen,0) < COALESCE(soi.unitPriceSen,0)
          LIMIT 200`,
      )
      .bind()
      .all<Record<string, number | string | null>>();
    return (res.results ?? []).map((r) => ({
      kind: "INVOICE_BELOW_SO" as const,
      ref: `${r.invoiceNo} ← ${r.companySOId} L${r.lineNo}`,
      detail: `${r.productCode}: invoice ${r.invUnitSen} vs SO ${r.soUnitSen} (${r.status})`,
      amountSen:
        (Number(r.soUnitSen ?? 0) - Number(r.invUnitSen ?? 0)) * (Number(r.quantity) || 1),
    }));
  } catch (err) {
    console.error("[pricing-integrity] invoiceBelowSo failed:", err);
    throw err;
  }
}

/**
 * All money invariants, worst first. `amountSen` totals what we are currently
 * failing to bill — the number that belongs in front of the owner every day.
 */
export async function checkPricingIntegrity(db: DbLike): Promise<PricingIssueRow[]> {
  const [a, b, c] = await Promise.all([
    checkUnitNotSumOfParts(db),
    checkHeightChosenButFree(db),
    checkInvoiceBelowSo(db),
  ]);
  return [...a, ...b, ...c].sort((x, y) => y.amountSen - x.amountSen);
}
