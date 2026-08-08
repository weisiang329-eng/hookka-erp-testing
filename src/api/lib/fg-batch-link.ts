// ---------------------------------------------------------------------------
// fg-batch-link.ts — which cost lot does this physical piece belong to?
//
// THE HOLE. `fg_units.batch_id` exists and is NULL on all 4,866 rows. So the
// 2,250 `fg_batches` cost lots — the only place a finished piece's unit cost
// lives — are unreachable from the piece. No unit cost, no stock value, no
// "what did this one cost us", and no way to show a lot's age against the piece
// standing in front of you. The column was there the whole time; nothing ever
// filled it.
//
// TWO HALVES, ONE RULE
//   * Write time: the completion cascade creates the lot immediately after it
//     creates the units, so the link is knowable the moment both exist. Stamped
//     there (see fg-completion.ts) and never guessed again.
//   * The 4,866 rows already in the book: an EVIDENCE LADDER, below. A wrong
//     cost link is worse than a missing one — a missing one shows as a blank an
//     operator can question, a wrong one shows as a number they will trust. So
//     the ladder only ever answers when the evidence NAMES the lot, and returns
//     null the moment two readings disagree or none exists.
//
// THE LADDER (both rungs verified against production before being written)
//   A. THE COMPLETION LEDGER. `cost_ledger` FG_COMPLETED rows carry the
//      `batch_id` the PO's completion was actually booked against. When a
//      production order's completion rows agree on exactly ONE lot, that lot is
//      a statement of record, not an inference — and it is the ONLY thing that
//      can disentangle the 145 production orders that carry DUPLICATE lots
//      (replay artefacts: same PO, same product, same quantity, one costed and
//      the rest at zero). On production it rescues 318 of the 451 units sitting
//      on such orders.
//   B. THE SOLE LOT. The production order has exactly one `fg_batches` row.
//      There is nothing to choose between, so the link is a fact about the data
//      rather than a preference.
//   otherwise NULL, and counted. On production: 284 units whose production
//   order has no cost lot at all (and no completion ledger row either — there
//   is genuinely nothing to point at), 133 units on multi-lot orders where no
//   completion row names one, and 2 whose lot describes a DIFFERENT product
//   than the unit does (5543-CNR vs 5543-SQCNR, 5530-2A(LHF) vs (RHF)) —
//   exactly the kind of near-miss a "close enough" rule would have swallowed.
//
// THE PRODUCT-CODE GUARD APPLIES TO BOTH RUNGS. A lot reached through the PO
// still has to describe the same product the piece does. Two rows fail it on
// production today, and both are single-lot orders — i.e. the rung that looks
// most certain is exactly where the mismatch hid.
// ---------------------------------------------------------------------------
import type { D1Database } from "@cloudflare/workers-types";

export type FgLotCandidate = {
  batchId: string;
  productionOrderId: string | null;
  /** products.code for the lot's product_id — null when the product is gone. */
  productCode: string | null;
};

export type FgUnitForLink = {
  id: string;
  poId: string | null;
  productCode: string | null;
};

export type FgLinkEvidence = {
  /** Distinct fg_batches ids named by this PO's FG_COMPLETED cost_ledger rows. */
  completionBatchIds: string[];
  /** Every fg_batches row recorded against this PO. */
  lots: FgLotCandidate[];
};

export type FgLinkTier = "COMPLETION_LEDGER" | "SOLE_LOT";

export type FgLinkOutcome = {
  batchId: string | null;
  tier: FgLinkTier | null;
  /** Why nothing could be established. Present only when batchId is null. */
  reason?:
    | "no lot on the production order"
    | "several lots and no completion row names one"
    | "the lot describes a different product"
    | "the unit has no production order";
};

const EMPTY_EVIDENCE: FgLinkEvidence = { completionBatchIds: [], lots: [] };

/**
 * The whole decision, as a pure function so it can be tested against the exact
 * shapes production actually holds rather than against a mock of a query.
 */
export function pickBatchForUnit(
  unit: FgUnitForLink,
  evidence: FgLinkEvidence = EMPTY_EVIDENCE,
): FgLinkOutcome {
  if (!unit.poId) {
    return { batchId: null, tier: null, reason: "the unit has no production order" };
  }
  const byId = new Map(evidence.lots.map((l) => [l.batchId, l]));

  // Rung A — the completion ledger names the lot. Only when it names ONE.
  const named = [...new Set(evidence.completionBatchIds.filter(Boolean))];
  if (named.length === 1) {
    const lot = byId.get(named[0]);
    // The named lot must still exist AND belong to this production order. A
    // ledger row pointing at a lot recorded against a DIFFERENT order is not
    // evidence about this piece, it is a data fault — say nothing.
    if (lot && lot.productionOrderId === unit.poId) {
      return finish(unit, lot, "COMPLETION_LEDGER");
    }
  }

  // Rung B — exactly one lot on the order, so there is nothing to choose.
  const own = evidence.lots.filter((l) => l.productionOrderId === unit.poId);
  if (own.length === 1) return finish(unit, own[0], "SOLE_LOT");
  if (own.length === 0) {
    return { batchId: null, tier: null, reason: "no lot on the production order" };
  }
  return {
    batchId: null,
    tier: null,
    reason: "several lots and no completion row names one",
  };
}

function finish(
  unit: FgUnitForLink,
  lot: FgLotCandidate,
  tier: FgLinkTier,
): FgLinkOutcome {
  // A lot that describes a different product is a conflict, not a near miss.
  if (
    unit.productCode != null &&
    lot.productCode != null &&
    unit.productCode !== lot.productCode
  ) {
    return {
      batchId: null,
      tier: null,
      reason: "the lot describes a different product",
    };
  }
  return { batchId: lot.batchId, tier };
}

// ---------------------------------------------------------------------------
// loadFgLinkEvidence — one read per table, keyed by production order.
//
// Loads for a SET of production orders rather than per unit: the backfill runs
// over thousands of rows and a per-unit query would be thousands of round trips
// against a pooled connection.
// ---------------------------------------------------------------------------
export async function loadFgLinkEvidence(
  db: D1Database,
  poIds: string[],
): Promise<Map<string, FgLinkEvidence>> {
  const out = new Map<string, FgLinkEvidence>();
  const unique = [...new Set(poIds.filter(Boolean))];
  if (unique.length === 0) return out;

  const ensure = (poId: string): FgLinkEvidence => {
    let e = out.get(poId);
    if (!e) {
      e = { completionBatchIds: [], lots: [] };
      out.set(poId, e);
    }
    return e;
  };

  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");

    const lots = await db
      .prepare(
        `SELECT b.id AS "batchId", b.productionOrderId AS "poId", p.code AS "productCode"
           FROM fg_batches b
           LEFT JOIN products p ON p.id = b.productId
          WHERE b.productionOrderId IN (${ph})`,
      )
      .bind(...chunk)
      .all<{ batchId: string; poId: string | null; productCode: string | null }>();
    for (const l of lots.results ?? []) {
      if (!l.poId) continue;
      ensure(l.poId).lots.push({
        batchId: l.batchId,
        productionOrderId: l.poId,
        productCode: l.productCode ?? null,
      });
    }

    const completions = await db
      .prepare(
        `SELECT refId AS "poId", batchId AS "batchId"
           FROM cost_ledger
          WHERE type = 'FG_COMPLETED' AND refType = 'PRODUCTION_ORDER'
            AND batchId IS NOT NULL AND refId IN (${ph})`,
      )
      .bind(...chunk)
      .all<{ poId: string; batchId: string }>();
    for (const c of completions.results ?? []) {
      ensure(c.poId).completionBatchIds.push(c.batchId);
    }
  }
  return out;
}

export type FgLinkPlan = {
  linked: Array<{ unitId: string; batchId: string; tier: FgLinkTier }>;
  unresolved: Array<{ unitId: string; poId: string | null; reason: string }>;
  byTier: Record<string, number>;
  byReason: Record<string, number>;
};

/** Run the ladder over a set of units. Pure decision, no writes. */
export async function planFgBatchLinks(
  db: D1Database,
  units: FgUnitForLink[],
): Promise<FgLinkPlan> {
  const evidence = await loadFgLinkEvidence(
    db,
    units.map((u) => u.poId).filter((x): x is string => !!x),
  );
  const plan: FgLinkPlan = { linked: [], unresolved: [], byTier: {}, byReason: {} };
  for (const u of units) {
    const outcome = pickBatchForUnit(u, evidence.get(u.poId ?? "") ?? EMPTY_EVIDENCE);
    if (outcome.batchId && outcome.tier) {
      plan.linked.push({ unitId: u.id, batchId: outcome.batchId, tier: outcome.tier });
      plan.byTier[outcome.tier] = (plan.byTier[outcome.tier] ?? 0) + 1;
    } else {
      const reason = outcome.reason ?? "unknown";
      plan.unresolved.push({ unitId: u.id, poId: u.poId, reason });
      plan.byReason[reason] = (plan.byReason[reason] ?? 0) + 1;
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// stampFgUnitBatchIdForPo — the WRITE-TIME half.
//
// Called from the completion cascade the moment both the units and their lot
// exist. Only fills a BLANK batch_id, so it never overwrites an established
// link and is safe to replay. Only stamps the units whose product agrees with
// the lot's, for the same reason the backfill checks it: the two disagree on
// real rows today.
//
// Returns statements; the caller decides the batch it rides.
// ---------------------------------------------------------------------------
export function buildFgUnitBatchStampStatement(
  db: D1Database,
  poId: string,
  batchId: string,
  lotProductCode: string | null,
): D1PreparedStatement {
  if (lotProductCode == null) {
    return db
      .prepare(
        `UPDATE fg_units SET batchId = ?
          WHERE poId = ? AND (batchId IS NULL OR batchId = '')`,
      )
      .bind(batchId, poId);
  }
  return db
    .prepare(
      `UPDATE fg_units SET batchId = ?
        WHERE poId = ? AND (batchId IS NULL OR batchId = '')
          AND (productCode IS NULL OR productCode = ?)`,
    )
    .bind(batchId, poId, lotProductCode);
}
