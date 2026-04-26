// ---------------------------------------------------------------------------
// BOM branch resolver — derives the branchKey for a job_card given its
// (departmentCode, wipType).
//
// Within one wipKey ("DIVAN" / "HEADBOARD" / "SOFA_*") the BOM has multiple
// parallel branches that converge only at UPHOLSTERY:
//
//   BF Divan    Foam-branch    : WOOD_CUT → FRAMING → WEBBING (top wipCode "Foam")
//               Fabric-branch  : FAB_CUT  → FAB_SEW           (top wipCode "{FABRIC}")
//
//   BF Headboard Webbing-branch: WOOD_CUT → FRAMING → WEBBING (top wipCode "Webbing")
//                Foam-branch   : FAB_CUT  → FAB_SEW → FOAM    (top wipCode "{FABRIC} Foam")
//
//   Sofa Foam-branch (wood)    : WOOD_CUT → FRAMING → WEBBING → FOAM
//        Fabric-branch         : FAB_CUT  → FAB_SEW
//
// The literal wipCodes contain `{FABRIC}` tokens which resolve per-PO. To
// keep the branchKey stable across POs, we use a STABLE label per branch
// rather than the resolved wipCode:
//   "Foam"    — the wood-side branch in Divan + Sofa, AND the fab-side
//               branch in BF Headboard (BOM literally names both nodes
//               "Foam" — fortunate but easy to misread).
//   "Webbing" — the wood-side branch in BF Headboard.
//   "Fabric"  — the fab-side branch in Divan + Sofa.
//   ""        — joint terminals (UPHOLSTERY, PACKING) shared by every
//               branch, so they don't get filtered out.
//
// When production-order-builder.ts walks the BOM tree it stamps the actual
// child wipCode (which DOES match these labels for known BOMs). When other
// paths (jobcard-sync, sales-orders cascade via bom-wip-breakdown) need a
// branchKey without re-walking the tree, they call this helper with the
// dept + wipType they already have.
//
// Migration 0058 used the same logic to backfill existing rows. Keep this
// in lock-step with that migration's WHERE clauses if you ever change the
// label strings.
// ---------------------------------------------------------------------------
export function deriveBranchKey(
  deptCode: string,
  wipType: string | null | undefined,
): string {
  const dept = (deptCode || "").toUpperCase();
  const t = (wipType || "").toUpperCase();
  if (dept === "UPHOLSTERY" || dept === "PACKING") return "";

  const isHB = t === "HEADBOARD";
  const isSofa = t.startsWith("SOFA_");
  const isDivan = t === "DIVAN";

  if (dept === "WOOD_CUT" || dept === "FRAMING" || dept === "WEBBING") {
    return isHB ? "Webbing" : "Foam";
  }
  if (dept === "FAB_CUT" || dept === "FAB_SEW") {
    return isHB ? "Foam" : "Fabric";
  }
  if (dept === "FOAM") {
    if (isHB) return "Foam";
    if (isSofa) return "Foam";
    return ""; // Divan has no FOAM dept
  }
  // Unknown wipType / non-BF non-Sofa categories: leave empty so the
  // (wipKey, branchKey) sibling filter doesn't accidentally exclude rows.
  void isDivan;
  return "";
}
