// ---------------------------------------------------------------------------
// PO ↔ SO line item alignment validator.
//
// Background: SO-2605-027 surfaced a generator bug where multi-line same-
// productCode + qty>1 SOs produced production_orders whose
// (productCode, sizeLabel, sizeCode, fabricCode, divanHeightInches, ...)
// got SHUFFLED across SO lines. Wei Siang's expectation: per-unit running
// counter, with each PO carrying its source SO line's full attribute set
// AND a stamped `salesOrderItemId` for traceability.
//
// This validator audits an SO's existing production_orders against its
// sales_order_items and surfaces any mismatch. Two use cases:
//
//   (a) On-demand audit endpoint: operator calls it for a specific SO to
//       check if PO data corruption exists (and how to remediate).
//
//   (b) Defense-in-depth in the SO confirm path: after the PO cascade
//       commits, the validator re-checks alignment and surfaces a warning
//       in the response so the operator notices BEFORE production starts
//       on a corrupt batch. (Pre-INSERT blocking comes with the
//       upcoming generator fix in production-builder.ts that returns the
//       full PO row data.)
//
// Returns ValidationResult { errors[], warnings[] } — empty arrays mean
// clean alignment.
// ---------------------------------------------------------------------------

export type SoLineItem = {
  id: string;
  lineNo: number | null;
  lineSuffix: string | null;
  productCode: string | null;
  sizeLabel: string | null;
  sizeCode: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  quantity: number;
};

export type ProductionOrderRow = {
  id: string;
  poNo: string;
  productCode: string | null;
  sizeLabel: string | null;
  sizeCode: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  salesOrderItemId: string | null;
  quantity: number;
};

export type AlignmentMismatch = {
  poId: string;
  poNo: string;
  reason: string;
  expectedFromSoLine?: {
    lineSuffix: string | null;
    productCode: string | null;
    sizeLabel: string | null;
    sizeCode: string | null;
    fabricCode: string | null;
    divanHeightInches: number | null;
  };
  actualOnPo?: {
    productCode: string | null;
    sizeLabel: string | null;
    sizeCode: string | null;
    fabricCode: string | null;
    divanHeightInches: number | null;
  };
};

export type ValidationResult = {
  ok: boolean;
  expectedPoCount: number;
  actualPoCount: number;
  mismatches: AlignmentMismatch[];
  unlinkedPos: string[]; // PO ids whose salesOrderItemId is NULL
};

/**
 * Validate that production_orders for an SO match the SO line item
 * attributes. Each SO line with quantity=K should have produced K POs,
 * each carrying that line's productCode/size/fabric/divan attributes
 * and a stamped salesOrderItemId.
 *
 * Algorithm:
 *   1. Sum SO line quantities → expectedPoCount.
 *   2. Compare to actualPoCount.
 *   3. For each PO:
 *      - If salesOrderItemId is NULL → flag as unlinked (caller decides
 *        whether to attempt auto-link by attribute matching).
 *      - Else find the linked SO line. Compare critical attributes.
 *        Any mismatch is an AlignmentMismatch.
 */
export function validatePOAlignment(
  soLines: SoLineItem[],
  productionOrders: ProductionOrderRow[],
): ValidationResult {
  const expectedPoCount = soLines.reduce(
    (sum, l) => sum + (l.quantity || 1),
    0,
  );
  const lineById = new Map(soLines.map((l) => [l.id, l]));
  const mismatches: AlignmentMismatch[] = [];
  const unlinkedPos: string[] = [];

  for (const po of productionOrders) {
    if (!po.salesOrderItemId) {
      unlinkedPos.push(po.id);
      continue;
    }
    const line = lineById.get(po.salesOrderItemId);
    if (!line) {
      mismatches.push({
        poId: po.id,
        poNo: po.poNo,
        reason: `PO.salesOrderItemId=${po.salesOrderItemId} does not match any SO line item id`,
      });
      continue;
    }

    // Critical attributes that must match.
    const fields: Array<{
      name: string;
      poVal: unknown;
      lineVal: unknown;
    }> = [
      { name: "productCode", poVal: po.productCode, lineVal: line.productCode },
      { name: "sizeLabel", poVal: po.sizeLabel, lineVal: line.sizeLabel },
      { name: "sizeCode", poVal: po.sizeCode, lineVal: line.sizeCode },
      { name: "fabricCode", poVal: po.fabricCode, lineVal: line.fabricCode },
      {
        name: "divanHeightInches",
        poVal: po.divanHeightInches,
        lineVal: line.divanHeightInches,
      },
      {
        name: "legHeightInches",
        poVal: po.legHeightInches,
        lineVal: line.legHeightInches,
      },
      { name: "gapInches", poVal: po.gapInches, lineVal: line.gapInches },
    ];
    const diffs = fields.filter((f) => {
      // Treat null/undefined/empty-string as equivalent for nullable fields
      // (sizeCode/sizeLabel/fabricCode for ACCESSORY items legitimately are
      // empty on both sides). Numeric comparisons preserve null distinct
      // from 0.
      if (
        (f.poVal === null || f.poVal === undefined || f.poVal === "") &&
        (f.lineVal === null || f.lineVal === undefined || f.lineVal === "")
      ) {
        return false;
      }
      return f.poVal !== f.lineVal;
    });

    if (diffs.length > 0) {
      mismatches.push({
        poId: po.id,
        poNo: po.poNo,
        reason: `PO attributes differ from linked SO line ${line.lineSuffix ?? line.lineNo} on field(s): ${diffs.map((d) => d.name).join(", ")}`,
        expectedFromSoLine: {
          lineSuffix: line.lineSuffix,
          productCode: line.productCode,
          sizeLabel: line.sizeLabel,
          sizeCode: line.sizeCode,
          fabricCode: line.fabricCode,
          divanHeightInches: line.divanHeightInches,
        },
        actualOnPo: {
          productCode: po.productCode,
          sizeLabel: po.sizeLabel,
          sizeCode: po.sizeCode,
          fabricCode: po.fabricCode,
          divanHeightInches: po.divanHeightInches,
        },
      });
    }
  }

  return {
    ok:
      productionOrders.length === expectedPoCount &&
      mismatches.length === 0 &&
      unlinkedPos.length === 0,
    expectedPoCount,
    actualPoCount: productionOrders.length,
    mismatches,
    unlinkedPos,
  };
}

/**
 * D1 helper: load the SO lines + production orders for a given soId and
 * run the validator. Returns the same ValidationResult shape.
 */
export async function loadAndValidatePOAlignment(
  db: D1Database,
  soId: string,
): Promise<ValidationResult> {
  const linesRes = await db
    .prepare(
      `SELECT id, lineNo, lineSuffix, productCode, sizeLabel, sizeCode,
              fabricCode, divanHeightInches, legHeightInches, gapInches,
              quantity
         FROM sales_order_items WHERE salesOrderId = ?
         ORDER BY lineNo ASC`,
    )
    .bind(soId)
    .all<SoLineItem>();

  const posRes = await db
    .prepare(
      `SELECT id, poNo, productCode, sizeLabel, sizeCode, fabricCode,
              divanHeightInches, legHeightInches, gapInches, salesOrderItemId,
              quantity
         FROM production_orders WHERE salesOrderId = ?
         ORDER BY id ASC`,
    )
    .bind(soId)
    .all<ProductionOrderRow>();

  return validatePOAlignment(linesRes.results ?? [], posRes.results ?? []);
}
