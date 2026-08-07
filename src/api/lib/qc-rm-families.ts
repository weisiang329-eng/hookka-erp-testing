// ---------------------------------------------------------------------------
// Incoming-material (IQC) FAMILIES — the routing table between a goods receipt
// line and the checklist an inspector should actually run on it.
//
// WHY THIS EXISTS
// ---------------
// Until 2026-08-08 the RM stage generated ONE slot per day per RM template,
// gated on "was any GRN confirmed today". That collapsed two receipts into one
// inspection and told the inspector nothing about WHICH goods to look at, which
// is the opposite of the owner's model (2026-08-08):
//
//   "基本上是根据进货情况按 batch 来检。只要有了 GR … 我们只需要检查一次。
//    总之，原材料这边一定要做到每一 batch 进来都必须抽检，把所有细节全部看一遍。"
//
// So RM generation is now per GOODS RECEIPT, and each receipt is routed to the
// checklist(s) that match the MATERIAL FAMILIES actually on its lines.
//
// WHY ROUTE OFF ITEM GROUPS, NOT MATERIAL NAMES
// ---------------------------------------------
// `raw_materials.item_group` is the AutoCount accounting group already carried
// by every material master row, and `src/lib/material-lookup.ts`
// CATEGORY_TO_ITEM_GROUPS is the existing map from the BOM's StockCategory
// (`src/types/index.ts` StockCategory) onto those groups. Routing off the group
// means a NEW material code inherits the right checks the moment it is filed in
// the right group — no keyword list to maintain, no free-text matching on
// supplier descriptions that are written differently every month.
//
// The one place free text is unavoidable is B.OTHERS: the map folds BOTH
// WD_STRIP (solid wood strip) and ACCESSORIES into it, and the two need
// genuinely different checks (moisture / knots / straightness vs. thread size /
// finish / matched sets). Everything else routes on the group alone. A dedicated
// item group for wood strip would remove the last keyword probe — worth doing,
// but it is a master-data change, not a code change.
//
// BEDFRAME vs SOFA
// ----------------
// The StockCategory taxonomy splits several families by product line
// (BM_FABRIC/SM_FABRIC, B_FILLER/S_FILLER, WEBBING/S_WEBBING,
// MECHANISM/S_MECHANISM). A separate CHECKLIST is only justified where the
// OBSERVATION differs, not merely the grade:
//
//   FABRIC     — ONE template. B.M-FABR and S.M-FABR/S-FABR are different
//                grades of the same thing; the inspector does the same five
//                things (swatch, width, dye-lot, defects, length).
//   FOAM/FILLER— SPLIT. SOFA-FIL is density-graded PU foam: it has a stamped
//                density rating and a rebound spec. BED-FILL is sheet/fibre
//                filler where "density rating" does not exist — the measurable
//                is grams per square metre and loft after decompression.
//                Running the sofa checklist on bedframe filler produces four
//                N/A answers, which is how a checklist stops being read.
//   WEBBING    — ONE template. WEBBING and S_WEBBING both map to the single
//                'WEBBING' item group, so the data cannot route them apart;
//                the template carries a "matches the retained sample for THIS
//                product line" item instead, which is the check that actually
//                catches a swap.
//   MECHANISM  — ONE template, same reason (both map to 'EQUIPMEN').
//
// PER-SUPPLIER OVERRIDES (not implemented — designed for)
// -------------------------------------------------------
// `pickRmTemplate` resolves (family, supplierId) and prefers a template bound
// to the supplier over the family default. No template carries a supplier today
// and `qc_templates` has no supplier column yet, so every lookup lands on the
// default. Adding `qc_templates.supplier_id` later turns the feature on without
// reshaping generation or the templates that already exist.
// ---------------------------------------------------------------------------

export const RM_FAMILIES = [
  "FABRIC",
  "PLYWOOD",
  "TIMBER",
  "SOFA_FOAM",
  "BED_FILLER",
  "WEBBING",
  "MECHANISM",
  "PACKING",
  "ACCESSORIES",
  "GENERAL",
] as const;

export type RmFamily = (typeof RM_FAMILIES)[number];

/**
 * AutoCount item group → QC material family.
 *
 * Mirrors CATEGORY_TO_ITEM_GROUPS in `src/lib/material-lookup.ts` read in the
 * other direction. Keys are compared upper-cased and trimmed.
 */
export const ITEM_GROUP_TO_FAMILY: Record<string, RmFamily> = {
  "B.M-FABR": "FABRIC", // bedframe fabric
  "S.M-FABR": "FABRIC", // sofa fabric
  "S-FABR": "FABRIC", // sofa fabric (legacy group)
  PLYWOOD: "PLYWOOD",
  "BED-FILL": "BED_FILLER", // bedframe filler / wadding
  "SOFA-FIL": "SOFA_FOAM", // sofa PU foam
  WEBBING: "WEBBING", // both WEBBING and S_WEBBING land here
  EQUIPMEN: "MECHANISM", // both MECHANISM and S_MECHANISM land here
  PACKING: "PACKING",
  // 'B.OTHERS' is deliberately absent — see AMBIGUOUS_ITEM_GROUPS.
};

/**
 * Groups that hold more than one family and cannot be routed on the group
 * alone. Today that is only B.OTHERS (wood strip AND accessories).
 */
export const AMBIGUOUS_ITEM_GROUPS: Record<string, { timberOr: RmFamily }> = {
  "B.OTHERS": { timberOr: "ACCESSORIES" },
};

/**
 * The ONLY free-text probe in this file, and only reached for B.OTHERS.
 * Deliberately narrow: it looks for the words a wood strip is actually filed
 * under, and anything it does not recognise falls to ACCESSORIES rather than
 * being guessed into a timber checklist it would fail.
 */
const TIMBER_WORDS =
  /\b(WOOD|WOODEN|TIMBER|KAYU|STRIP|STRIPS|PLANK|BATTEN|LUMBER|MERANTI|RUBBERWOOD|PINE|HARDWOOD|SOFTWOOD)\b/;

export type RmLineLike = {
  itemGroup?: string | null;
  item_group?: string | null;
  materialCode?: string | null;
  material_code?: string | null;
  materialName?: string | null;
  material_name?: string | null;
};

/**
 * Which checklist family does this goods-receipt line belong to?
 *
 * Returns 'GENERAL' when the line's material could not be resolved to a
 * material master row, or its item group is not one we know. That is a real
 * outcome, not a failure: the receipt still gets an inspection (the general
 * incoming checklist), and one of that checklist's items asks the inspector to
 * say what the goods actually were, so the item group can be corrected.
 */
export function rmFamilyForLine(line: RmLineLike): RmFamily {
  const group = String(line.itemGroup ?? line.item_group ?? "")
    .trim()
    .toUpperCase();
  if (!group) return "GENERAL";

  const direct = ITEM_GROUP_TO_FAMILY[group];
  if (direct) return direct;

  const ambiguous = AMBIGUOUS_ITEM_GROUPS[group];
  if (ambiguous) {
    const text = `${line.materialCode ?? line.material_code ?? ""} ${
      line.materialName ?? line.material_name ?? ""
    }`.toUpperCase();
    return TIMBER_WORDS.test(text) ? "TIMBER" : ambiguous.timberOr;
  }

  return "GENERAL";
}

/**
 * Every distinct family present on one goods receipt, in a stable order.
 *
 * A MIXED receipt (timber + fabric on the same GRN) yields BOTH families, and
 * generation raises ONE inspection per family — see the note on
 * `generateRmForGrns` in qc-pending.ts for why that beats one blended
 * checklist.
 */
export function rmFamiliesOnReceipt(lines: RmLineLike[]): RmFamily[] {
  const seen = new Set<RmFamily>();
  for (const l of lines) seen.add(rmFamilyForLine(l));
  return RM_FAMILIES.filter((f) => seen.has(f));
}

/**
 * The seeded template id per family (migration 0215).
 *
 * Generation resolves a template by the `material_family` column FIRST; this
 * map is the fallback for a database where 0215's UPDATE has not run yet, so
 * the four families that have existed since 0068 keep working either way.
 */
export const RM_FAMILY_DEFAULT_TEMPLATE_ID: Record<RmFamily, string> = {
  FABRIC: "qct-rm-fabric",
  SOFA_FOAM: "qct-rm-foam",
  TIMBER: "qct-rm-wood",
  MECHANISM: "qct-rm-hardware",
  PLYWOOD: "qct-rm-plywood",
  BED_FILLER: "qct-rm-bedfiller",
  WEBBING: "qct-rm-webbing",
  PACKING: "qct-rm-packing",
  ACCESSORIES: "qct-rm-accessories",
  GENERAL: "qct-rm-general",
};

export type RmTemplateLike = {
  id: string;
  stage?: string | null;
  active?: number | null;
  materialFamily?: string | null;
  material_family?: string | null;
  supplierId?: string | null;
  supplier_id?: string | null;
};

/**
 * Resolve the template that should be used for (family, supplier).
 *
 * Order:
 *   1. an active RM template tagged with this family AND bound to this supplier
 *      (the per-supplier override — no such row exists today);
 *   2. an active RM template tagged with this family and bound to no supplier;
 *   3. the seeded default id for the family (covers a DB where 0215's UPDATE
 *      has not run);
 *   4. the GENERAL template, so an unrecognised family still gets inspected;
 *   5. null — the caller MUST count and report this, never swallow it. Handing
 *      a plywood delivery the solid-timber checklist would be worse than saying
 *      no template matched.
 */
export function pickRmTemplate<T extends RmTemplateLike>(
  templates: T[],
  family: RmFamily,
  supplierId?: string | null,
): T | null {
  const rm = templates.filter(
    (t) => (t.stage ?? "RM") === "RM" && (t.active ?? 1) === 1,
  );
  const famOf = (t: T) => String(t.materialFamily ?? t.material_family ?? "").toUpperCase();
  const supOf = (t: T) => String(t.supplierId ?? t.supplier_id ?? "");

  if (supplierId) {
    const bound = rm.find((t) => famOf(t) === family && supOf(t) === supplierId);
    if (bound) return bound;
  }
  const tagged = rm.find((t) => famOf(t) === family && !supOf(t));
  if (tagged) return tagged;

  const byId = rm.find((t) => t.id === RM_FAMILY_DEFAULT_TEMPLATE_ID[family]);
  if (byId) return byId;

  const general =
    rm.find((t) => famOf(t) === "GENERAL") ??
    rm.find((t) => t.id === RM_FAMILY_DEFAULT_TEMPLATE_ID.GENERAL) ??
    null;
  return general;
}
