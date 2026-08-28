// ---------------------------------------------------------------------------
// stock-group-accounts — what a raw material's ITEM GROUP costs you.
//
// ## Why this exists
//
// `raw_materials.itemGroup` looks like a label. It is not. It carries the REAL
// AutoCount stock-group code, and four GL accounts hang off it:
//
//   purchase          the 70x account a bought line debits
//   stock             the 33x balance-sheet account it sits in
//   opening / closing the period-stock pair in the P&L
//
// So editing a dropdown on the Inventory screen re-routes money between P&L
// accounts. Measured on prod 2026-08-21:
//
//   703-0010  PURCHASE - B.FILLER   RM 76,732.35
//   703-0020  PURCHASE - S.FILLER   RM 92,768.43
//
// Two properties of that routing are worth stating plainly, because they pull
// in opposite directions and both surprise people:
//
//   · The PURCHASE account is decided when the invoice POSTS
//     (`mapPurchaseLinesToAccounts` reads the group as it stands then), so
//     already-posted journals keep the old account forever. Moving a material
//     SPLITS its own purchase history across two accounts.
//   · The STOCK / opening / closing accounts are decided when the REPORT RUNS,
//     off the current group — so those move retroactively, including for
//     periods that closed before the change.
//
// Until today none of this left a trace: the update handler wrote the new
// group and that was it. No before-value, no actor, nothing to answer "who
// moved this material, and when did the account change?" — a question you can
// only ask after the numbers already look wrong.
//
// This module is the one place that answers "which accounts does group G map
// to, right now, including the owner's kv override". It owns no data of its
// own — the default maps stay where the posting and reporting code reads
// them, and are imported here — so there is no second copy to drift.
// ---------------------------------------------------------------------------

import type { Env } from "../worker";

export type StockGroupAccounts = {
  /** 70x — debited when a purchase invoice for this material posts. */
  purchase: string;
  /** 33x — balance-sheet stock account. */
  stock: string;
  /** P&L opening-stock account. */
  opening: string;
  /** P&L closing-stock account. */
  closing: string;
};

type KvStockMap = {
  rm?: Record<string, Partial<StockGroupAccounts>>;
  rmDefault?: Partial<StockGroupAccounts>;
};

/**
 * The owner's `coa_stock_map` override, or `null` when absent/malformed.
 *
 * Malformed is deliberately the same as absent: this runs on the audit path
 * of an ordinary edit, and a bad kv blob must never fail the edit.
 */
export async function readStockMapOverride(
  db: Env["Variables"]["DB"],
): Promise<KvStockMap | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'coa_stock_map'")
      .first<{ value: string | null }>();
    const parsed = JSON.parse(row?.value ?? "null");
    return parsed && typeof parsed === "object" ? (parsed as KvStockMap) : null;
  } catch {
    return null;
  }
}

/**
 * Overlay the owner's override on the built-in defaults for ONE group.
 *
 * Pure, so the precedence can be pinned without a database — and it has to be
 * pinned, because the two live readers do NOT agree with each other and the
 * difference is easy to "tidy up" into a wrong answer:
 *
 *   purchase  (`mapPurchaseLinesToAccounts`)
 *       kv.rm[g].purchase  →  DEFAULT_PURCHASE_MAP[g]
 *                          →  kv.rmDefault.purchase  →  DEFAULT_PURCHASE_ACCT
 *       i.e. a kv entry for ANOTHER field does not shadow the built-in
 *       account, because that reader only copies `.purchase` across.
 *
 *   stock / opening / closing  (`getStockMap`)
 *       kv.rm[g]  →  DEFAULT_STOCK_MAP.rm[g]  →  kv.rmDefault
 *                 →  DEFAULT_STOCK_MAP.rmDefault
 *       i.e. a kv entry REPLACES the whole triple; it is not merged field by
 *       field. A kv row carrying only `stock` therefore leaves opening and
 *       closing UNDEFINED rather than falling back — mirrored here on purpose.
 */
export function resolveGroupAccounts(
  group: string,
  defaults: {
    purchase: Record<string, string>;
    purchaseDefault: string;
    stock: Record<string, { stock: string; opening: string; closing: string }>;
    stockDefault: { stock: string; opening: string; closing: string };
  },
  kv: KvStockMap | null,
): StockGroupAccounts {
  const g = (group ?? "").trim();

  const purchase =
    (g && (kv?.rm?.[g]?.purchase ?? defaults.purchase[g])) ||
    kv?.rmDefault?.purchase ||
    defaults.purchaseDefault;

  const triple =
    (g ? kv?.rm?.[g] ?? defaults.stock[g] : undefined) ??
    kv?.rmDefault ??
    defaults.stockDefault;

  return {
    purchase,
    stock: triple.stock ?? defaults.stockDefault.stock,
    opening: triple.opening ?? defaults.stockDefault.opening,
    closing: triple.closing ?? defaults.stockDefault.closing,
  };
}

/**
 * The four accounts group `G` maps to right now.
 *
 * The default maps live with the code that posts and reports off them
 * (`purchase-invoices.ts` / `accounting.ts`) and are pulled in dynamically —
 * both are route modules, and a static import from a lib would drag a Hono
 * app into every consumer's module graph.
 */
export async function accountsForItemGroup(
  db: Env["Variables"]["DB"],
  group: string,
): Promise<StockGroupAccounts> {
  const [{ DEFAULT_PURCHASE_MAP, DEFAULT_PURCHASE_ACCT }, { DEFAULT_STOCK_MAP }] =
    await Promise.all([
      import("../routes/purchase-invoices"),
      import("../routes/accounting"),
    ]);
  const kv = await readStockMapOverride(db);
  return resolveGroupAccounts(
    group,
    {
      purchase: DEFAULT_PURCHASE_MAP,
      purchaseDefault: DEFAULT_PURCHASE_ACCT,
      stock: DEFAULT_STOCK_MAP.rm,
      stockDefault: DEFAULT_STOCK_MAP.rmDefault,
    },
    kv,
  );
}

/** The accounts that actually differ between two groups. */
export function accountDiff(
  before: StockGroupAccounts,
  after: StockGroupAccounts,
): Partial<Record<keyof StockGroupAccounts, { from: string; to: string }>> {
  const out: Partial<
    Record<keyof StockGroupAccounts, { from: string; to: string }>
  > = {};
  for (const k of ["purchase", "stock", "opening", "closing"] as const) {
    if (before[k] !== after[k]) out[k] = { from: before[k], to: after[k] };
  }
  return out;
}
