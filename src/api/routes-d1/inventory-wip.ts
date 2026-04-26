// ---------------------------------------------------------------------------
// GET /api/inventory/wip
//
// Phase 4.5 — single source of truth for "what's sitting in WIP per
// (SO, fabric)".
//
// Ports two frontend helpers verbatim from src/pages/inventory/index.tsx so
// the Inventory page can stop re-deriving WIP rows on every render:
//
//   deriveWIPFromPO(orders, products)   — edge-detection over every PO + JC
//                                         (JC completed, next JC in the same
//                                         wipKey not yet completed = stock
//                                         sitting here). Emits one raw WIP
//                                         entry per edge, then groups by
//                                         (wipCode, completedBy) dept.
//
//   mergeSofaWIPSets(wipItems)          — groups sofa WIPs by (strippedSO,
//                                         fabric) and produces one "SET"
//                                         row per bucket with
//                                         setQty = max(poQty).
//
// Semantics must match the frontend EXACTLY — same edge rule, same label
// builder (FAB_CUT gets the condensed "code | (size) | (totalH") | (DV N") |
// fabric | (FC)" label; BF gets the height tokens, sofa doesn't), same
// (SO, fabric) bucket key, same setQty = max(poQty) rule, same age /
// cost roll-up.
//
// Cost estimate: current frontend `bomMaterialCostPerUnitSen` returns 0
// (no D1 endpoint for batch-layer prices exists yet, so all weighted-avg
// material lookups short-circuit to 0). So estUnitCostSen in practice is
// just `doneMinsPerUnit * laborRatePerMinSen`. We port that directly —
// once GRN / batch endpoints land we can revisit here and have both
// surfaces update together.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { laborRateForDate } from "../../lib/costing";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Row types (match production_orders + job_cards column sets we need)
// ---------------------------------------------------------------------------
type POLite = {
  id: string;
  poNo: string;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  startDate: string | null;
  status: string;
};

type JCLite = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  sequence: number;
  status: string;
  completedDate: string | null;
  productionTimeMinutes: number;
  wipKey: string | null;
  wipCode: string | null;
  wipType: string | null;
  wipLabel: string | null;
  wipQty: number | null;
  branchKey: string | null;
};

// ---------------------------------------------------------------------------
// WIP type labels (mirrors WIP_TYPE_LABELS in inventory/index.tsx)
// ---------------------------------------------------------------------------
const WIP_TYPE_LABELS: Record<string, string> = {
  FG: "Finished Good",
  DIVAN: "Divan",
  HEADBOARD: "Headboard",
  SOFA_BASE: "Base",
  SOFA_CUSHION: "Cushion",
  SOFA_ARMREST: "Armrest",
  SOFA_HEADREST: "Headrest",
};

// Strip the trailing "-NN" line-number suffix from a PO code
// (e.g. "SO-2604-212-01" → "SO-2604-212"). Returns input unchanged
// when no suffix is present so non-SO codes pass through.
function stripPoSuffix(poCode: string): string {
  return poCode.replace(/-\d+$/, "");
}

// ---------------------------------------------------------------------------
// Output shapes (per the phase 4.5 spec)
// ---------------------------------------------------------------------------
type WIPMember = {
  poNo: string;
  jobCardId: string;
  wipType: string;
  quantity: number;
};

type WIPRow = {
  id: string;
  wipCode: string;
  wipType: string;                                  // "SET" for merged sofa
  category: "SOFA" | "BEDFRAME" | "ACCESSORY";
  completedBy: string;
  relatedProduct: string;
  setQty: number;
  pieceQty: number;
  salesOrderNo: string | null;
  fabric: string;
  oldestAgeDays: number;
  estUnitCostSen: number;
  estTotalValueSen: number;
  members: WIPMember[];
  components?: Array<{ wipType: string; qty: number }>;
  // Only on SET rows — ids of the per-component WIPRow rows that feed
  // this set. The frontend resolves these to full rows when rendering
  // the expanded member grid (SET.members is JC-level and doesn't carry
  // the full WIPItem shape wipColumns needs).
  memberItemIds?: string[];
  // Extra fields carried for backward-compat with the frontend's WIPItem
  // shape (so per-component rows can still be rendered with the existing
  // wipColumns / wipDetail dialog without churn). These mirror what
  // deriveWIPFromPO used to emit.
  totalQty: number;                                 // alias of pieceQty
  sources: Array<{
    poCode: string;
    quantity: number;
    poQty: number;
    completedDate: string;
    ageDays: number;
    fabricCode: string;
    baseModel: string;
    itemCategory: string;
  }>;
};

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const db = c.var.DB;

  // One big fetch — POs whose status is still active (pending / in progress /
  // on hold), plus every JC for those POs. COMPLETED / CANCELLED POs have
  // nothing sitting in WIP by definition.
  const activeStatuses = ["PENDING", "IN_PROGRESS", "ON_HOLD"];
  const placeholders = activeStatuses.map(() => "?").join(",");

  const [posRes, jcsRes] = await Promise.all([
    db
      .prepare(
        `SELECT id, poNo, productId, productCode, productName, itemCategory,
                sizeCode, sizeLabel, fabricCode, quantity,
                gapInches, divanHeightInches, legHeightInches,
                startDate, status
           FROM production_orders
          WHERE status IN (${placeholders})`,
      )
      .bind(...activeStatuses)
      .all<POLite>(),
    db
      .prepare(
        `SELECT jc.id, jc.productionOrderId, jc.departmentCode, jc.sequence,
                jc.status, jc.completedDate, jc.productionTimeMinutes,
                jc.wipKey, jc.wipCode, jc.wipType, jc.wipLabel, jc.wipQty,
                jc.branchKey
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.status IN (${placeholders})`,
      )
      .bind(...activeStatuses)
      .all<JCLite>(),
  ]);

  const pos: POLite[] = posRes.results ?? [];
  const jcs: JCLite[] = jcsRes.results ?? [];

  // Group JCs by PO id.
  const jcsByPo = new Map<string, JCLite[]>();
  for (const jc of jcs) {
    const arr = jcsByPo.get(jc.productionOrderId);
    if (arr) arr.push(jc);
    else jcsByPo.set(jc.productionOrderId, [jc]);
  }

  const today = new Date();
  const todayLaborRatePerMinSen = laborRateForDate(today);

  // ---- Pass 1: raw WIP entries (one per completed→incomplete edge) --------
  type RawEntry = {
    wipCode: string;
    wipType: string;        // display label, e.g. "Divan"
    relatedProduct: string;
    completedBy: string;
    poNo: string;
    jobCardId: string;
    quantity: number;
    poQty: number;
    completedDate: string;
    ageDays: number;
    estValueSen: number;
    fabricCode: string;
    sizeLabel: string;    // piped into sofa SET label so "5535-L(LHF)+2A(RHF) | (30) | PC151-02 | (FC)" matches Production Fab Cut tab
    baseModel: string;
    itemCategory: string;
  };
  const raw: RawEntry[] = [];

  for (const po of pos) {
    const myJcs = jcsByPo.get(po.id) ?? [];

    // Upholstery all done → Finished Good, not WIP. Same early-out as the
    // frontend; we don't emit any WIP rows for such POs.
    const uphCards = myJcs.filter((jc) => jc.departmentCode === "UPHOLSTERY");
    if (
      uphCards.length > 0 &&
      uphCards.every(
        (jc) => jc.status === "COMPLETED" || jc.status === "TRANSFERRED",
      )
    ) {
      continue;
    }

    // Total production minutes for the entire PO (per unit) — used for
    // material-per-minute proration in the frontend. Kept here even though
    // bomMaterialCostPerUnitSen is currently 0 (see header comment), so
    // the algorithm stays identical and will pick up real BOM costs once
    // batch prices are wired in.
    const totalPOMinsPerUnit = myJcs.reduce(
      (s, c) => s + (Number(c.productionTimeMinutes) || 0),
      0,
    );
    // bomCostPerUnitSen is 0 here because batch-layer pricing has no D1
    // endpoint yet — see file header. Leaving the multiplication in place
    // for algorithm parity.
    const bomCostPerUnitSen = 0;
    const materialPerMinuteSen =
      totalPOMinsPerUnit > 0 ? bomCostPerUnitSen / totalPOMinsPerUnit : 0;

    // Group job cards by (wipKey, branchKey). Within one wipKey the BOM
    // has multiple parallel branches that converge only at UPHOLSTERY —
    // grouping by wipKey alone collapses them into a single chain and the
    // edge-detection loop below misclassifies a Wood Cut completion as
    // having "consumed" a Fab Sew row that's on a different branch
    // (BUG-2026-04-27 root cause). branchKey isolates each branch so each
    // branch's edge is computed independently. Joint terminals
    // (UPHOLSTERY, PACKING) carry branchKey="" which gives them their own
    // group — that's correct: their edge is shared by every branch but
    // they don't have parallel siblings within their group.
    const groups = new Map<string, JCLite[]>();
    for (const jc of myJcs) {
      const wk = jc.wipKey || "FG";
      const bk = jc.branchKey ?? "";
      const key = `${wk}::__BRANCH__::${bk}`;
      const arr = groups.get(key);
      if (arr) arr.push(jc);
      else groups.set(key, [jc]);
    }

    for (const [groupKey, cards] of groups) {
      // wipKey is the prefix before the "::__BRANCH__::" delimiter; we
      // recover it for downstream label-shape decisions that still use it.
      const wipKey = groupKey.split("::__BRANCH__::")[0];
      const sorted = [...cards].sort((a, b) => a.sequence - b.sequence);
      const isDone = (c2: JCLite) =>
        c2.status === "COMPLETED" || c2.status === "TRANSFERRED";

      for (let i = 0; i < sorted.length; i++) {
        const card = sorted[i];
        if (!isDone(card)) continue;
        const nextCard = sorted[i + 1];
        if (nextCard && isDone(nextCard)) continue;

        const completedDate = card.completedDate || po.startDate || "";
        const dComp = new Date(completedDate);
        const ageDays = completedDate
          ? Math.max(
              0,
              Math.floor((today.getTime() - dComp.getTime()) / 86400000),
            )
          : 0;

        // Parse wipType from wipKey "<product>::<idx>::<TYPE>::<code>"
        const wipTypeShort =
          card.wipType ||
          (wipKey.includes("::") ? wipKey.split("::")[2] || "" : wipKey) ||
          "";

        // FAB_CUT normalization (Wei Siang Apr 26 2026): every dept reads
        // its label from the BOM-provided card.wipLabel (with same
        // fallback chain as every other dept). The synthesized
        // "{product} | ({size}) | ({totalH}) | (DV N) | {fabric} | (FC)"
        // shape is gone — that synthesis lumped both HB and DV components
        // of one PO under an identical wipCode and surfaced as duplicate-
        // looking rows on the Inventory WIP grid. Now FAB_CUT rows use
        // the same per-component naming that ships from BOM creation
        // (e.g. '1007-(K) -HB 20" PC151-01' and '8" Divan-6FT PC151-01'),
        // matching what the Production sheet renders for the same JCs.
        const wipCodeStr =
          card.wipLabel ||
          card.wipCode ||
          WIP_TYPE_LABELS[wipTypeShort] ||
          wipTypeShort ||
          wipKey;
        const qty = card.wipQty || po.quantity;

        // Labor-so-far per unit — sum productionTimeMinutes for every done
        // card at or before `i` in THIS wipKey group.
        let doneMinsPerUnit = 0;
        for (let j = 0; j <= i; j++) {
          if (isDone(sorted[j])) {
            doneMinsPerUnit += Number(sorted[j].productionTimeMinutes) || 0;
          }
        }

        const laborPerUnitSen = doneMinsPerUnit * todayLaborRatePerMinSen;
        const materialPerUnitSen = doneMinsPerUnit * materialPerMinuteSen;
        const unitCostSen = laborPerUnitSen + materialPerUnitSen;

        raw.push({
          wipCode: wipCodeStr,
          wipType: WIP_TYPE_LABELS[wipTypeShort] || wipTypeShort || "",
          relatedProduct: po.productCode || "",
          completedBy: card.departmentCode || "",
          poNo: po.poNo,
          jobCardId: card.id,
          quantity: qty,
          poQty: po.quantity || 1,
          completedDate,
          ageDays,
          estValueSen: unitCostSen * qty,
          fabricCode: po.fabricCode || "",
          sizeLabel: po.sizeLabel || "",
          baseModel: (po.productCode || "").split("-")[0],
          itemCategory: po.itemCategory || "",
        });
      }
    }
  }

  // ---- Pass 2: group by (wipCode, completedBy) — per-component WIPItem ----
  type GroupedItem = {
    id: string;
    wipCode: string;
    wipType: string;
    relatedProduct: string;
    completedBy: string;
    totalQty: number;
    oldestAgeDays: number;
    estUnitCostSen: number;
    estTotalValueSen: number;
    sources: Array<{
      poCode: string;
      quantity: number;
      poQty: number;
      completedDate: string;
      ageDays: number;
      fabricCode: string;
      sizeLabel: string;
      baseModel: string;
      itemCategory: string;
    }>;
    members: WIPMember[];
  };
  const grouped = new Map<string, GroupedItem>();
  for (const r of raw) {
    // Grouping key MUST include wipType — for FAB_CUT the condensed wipCode
    // (e.g. "5530-L(LHF) | (30) | CH141-12 | (FC)") is the SAME for every
    // component (Base / Cushion / Armrest) of the same PO, so without
    // wipType in the key the components all collapse into one group and
    // the per-component breakdown is lost.
    const key = `${r.wipCode}__${r.completedBy}__${r.wipType}`;
    let g = grouped.get(key);
    if (!g) {
      g = {
        id: key,
        wipCode: r.wipCode,
        wipType: r.wipType,
        relatedProduct: r.relatedProduct,
        completedBy: r.completedBy,
        totalQty: 0,
        oldestAgeDays: 0,
        estUnitCostSen: 0,
        estTotalValueSen: 0,
        sources: [],
        members: [],
      };
      grouped.set(key, g);
    }
    g.totalQty += r.quantity;
    if (r.ageDays > g.oldestAgeDays) g.oldestAgeDays = r.ageDays;
    g.estTotalValueSen += r.estValueSen;
    g.sources.push({
      poCode: r.poNo,
      quantity: r.quantity,
      poQty: r.poQty,
      completedDate: r.completedDate,
      ageDays: r.ageDays,
      fabricCode: r.fabricCode,
      sizeLabel: r.sizeLabel,
      baseModel: r.baseModel,
      itemCategory: r.itemCategory,
    });
    g.members.push({
      poNo: r.poNo,
      jobCardId: r.jobCardId,
      wipType: r.wipType,
      quantity: r.quantity,
    });
  }
  // Finalise per-unit cost from grouped totals.
  for (const g of grouped.values()) {
    g.estUnitCostSen = g.totalQty > 0 ? g.estTotalValueSen / g.totalQty : 0;
  }

  // ---- Pass 3 — REMOVED.
  // Used to bucket sofa groups by (strippedSO, fabric) into one SET row
  // per bucket. Dropped per FAB_CUT normalization (Wei Siang Apr 26
  // 2026): every sofa / BF / ACC row is now emitted per-component, same
  // shape as every other dept. Every GroupedItem flows directly into the
  // response below.
  const allItems: GroupedItem[] = Array.from(grouped.values());

  // ---- Build response ----------------------------------------------------
  // Single uniform pass: every GroupedItem becomes one row. No SET merge,
  // no sofa special case. Sofa, BF, and accessory all flow through the
  // same emit loop — wipType comes straight from Pass 2 (e.g. "Headboard"
  // / "Divan" / "Base" / "Cushion") and never the synthesized "SET".
  const rows: WIPRow[] = [];

  for (const g of allItems) {
    const firstSrc = g.sources[0];
    const salesOrderNo = firstSrc ? stripPoSuffix(firstSrc.poCode) : null;
    const category: WIPRow["category"] =
      firstSrc?.itemCategory === "BEDFRAME"
        ? "BEDFRAME"
        : firstSrc?.itemCategory === "SOFA"
          ? "SOFA"
          : "ACCESSORY";
    const setQty = g.totalQty;

    rows.push({
      id: g.id,
      wipCode: g.wipCode,
      wipType: g.wipType,
      category,
      completedBy: g.completedBy,
      relatedProduct: g.relatedProduct,
      setQty,
      pieceQty: g.totalQty,
      salesOrderNo,
      fabric: firstSrc?.fabricCode || "",
      oldestAgeDays: g.oldestAgeDays,
      estUnitCostSen: g.estUnitCostSen,
      estTotalValueSen: g.estTotalValueSen,
      members: g.members,
      totalQty: g.totalQty,
      sources: g.sources,
    });
  }

  // Sort by oldest age descending (FIFO — same as the frontend).
  rows.sort((a, b) => b.oldestAgeDays - a.oldestAgeDays);

  return c.json({ success: true, data: rows });
});

export default app;
