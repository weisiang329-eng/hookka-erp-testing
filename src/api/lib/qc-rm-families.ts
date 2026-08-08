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

/**
 * TWO KINDS OF RM CHECK, on the same families.
 *
 * Owner 2026-08-08, after the incoming work was built: "所以基本上就是有货到他
 * 才有工作，没有货到他就没有工作 … 可是有一些东西还是要 daily 检查的 … 例如我们
 * 讲的木头，那天用的木头有没有发霉？还有海绵，那天用的海绵有没有问题？"
 *
 *   INCOMING — fires on a goods receipt. "Did the supplier send us good goods?"
 *   STORED   — fires on material being ISSUED to production. "Is the batch we
 *              are about to build into a customer's sofa still good after
 *              sitting in a Malaysian warehouse?"
 *
 * They are different questions with different items on the same material, so
 * they are different TEMPLATES on the same family. `rm_check_kind` is what
 * keeps them apart; it is NOT a new `stage`, deliberately — `stage` carries a
 * CHECK constraint and a TypeScript union that reach the worker portal, the
 * completion core and every list filter, and a stored-material check behaves
 * exactly like an RM check in all of them.
 */
export const RM_CHECK_KINDS = ["INCOMING", "STORED"] as const;
export type RmCheckKind = (typeof RM_CHECK_KINDS)[number];

export type RmTemplateLike = {
  id: string;
  stage?: string | null;
  active?: number | null;
  materialFamily?: string | null;
  material_family?: string | null;
  supplierId?: string | null;
  supplier_id?: string | null;
  rmCheckKind?: string | null;
  rm_check_kind?: string | null;
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
  kind: RmCheckKind = "INCOMING",
): T | null {
  // A template with no kind is an INCOMING one — every template that existed
  // before the stored-material check did.
  const kindOf = (t: T) =>
    String(t.rmCheckKind ?? t.rm_check_kind ?? "INCOMING").toUpperCase();
  const rm = templates.filter(
    (t) => (t.stage ?? "RM") === "RM" && (t.active ?? 1) === 1 && kindOf(t) === kind,
  );
  const famOf = (t: T) => String(t.materialFamily ?? t.material_family ?? "").toUpperCase();
  const supOf = (t: T) => String(t.supplierId ?? t.supplier_id ?? "");
  const defaults =
    kind === "STORED" ? STORED_FAMILY_DEFAULT_TEMPLATE_ID : RM_FAMILY_DEFAULT_TEMPLATE_ID;

  if (supplierId) {
    const bound = rm.find((t) => famOf(t) === family && supOf(t) === supplierId);
    if (bound) return bound;
  }
  const tagged = rm.find((t) => famOf(t) === family && !supOf(t));
  if (tagged) return tagged;

  const byId = rm.find((t) => t.id === defaults[family]);
  if (byId) return byId;

  const general =
    rm.find((t) => famOf(t) === "GENERAL") ??
    rm.find((t) => t.id === defaults.GENERAL) ??
    null;
  return general;
}

/**
 * The seeded STORED template id per family (migration 0217).
 *
 * Not one per family: what degrades in a rack is not what varies at the
 * loading bay.
 *   • SOFA_FOAM and BED_FILLER share one. Incoming they are split because the
 *     MEASURABLES differ (a stamped density rating vs. GSM and loft); in store
 *     both fail the same five ways — yellowing, compression set, musty smell,
 *     surface mould, crumbling cut faces — so one list is five real answers
 *     instead of two lists of three.
 *   • ACCESSORIES shares the hardware list: rust, pitting, dried grease.
 *   • PACKING falls to the general stored list (damp, crushing, vermin), which
 *     is also the fallback so no issued batch is silently unchecked.
 */
export const STORED_FAMILY_DEFAULT_TEMPLATE_ID: Record<RmFamily, string> = {
  FABRIC: "qct-st-fabric",
  SOFA_FOAM: "qct-st-foam",
  BED_FILLER: "qct-st-foam",
  TIMBER: "qct-st-timber",
  PLYWOOD: "qct-st-plywood",
  WEBBING: "qct-st-webbing",
  MECHANISM: "qct-st-hardware",
  ACCESSORIES: "qct-st-hardware",
  PACKING: "qct-st-general",
  GENERAL: "qct-st-general",
};

/**
 * The once-a-day store-condition check. Not per family and not per batch — it
 * is about the BUILDING and about FIFO being followed, which is what removes
 * most of the per-family causes at source.
 */
export const STORE_CONDITION_TEMPLATE_ID = "qct-st-warehouse";
