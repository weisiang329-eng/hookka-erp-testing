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
                jc.wipKey, jc.wipCode, jc.wipType, jc.wipLabel, jc.wipQty
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

    // Group job cards by wipKey.
    const groups = new Map<string, JCLite[]>();
    for (const jc of myJcs) {
      const key = jc.wipKey || "FG";
      const arr = groups.get(key);
      if (arr) arr.push(jc);
      else groups.set(key, [jc]);
    }

    // PO-level "fabric pulled" flag. The shop floor cuts the whole bolt
    // for a PO at once and the operator pulls the entire stack to Fab Sew
    // — so the moment ANY Fab Sew job card in this PO is done, every
    // remaining FAB_CUT in this PO has physically left the cutting room
    // and should disappear from FC WIP. Mirrors the wip_items "sofa Fab
    // Sew zeros all upstream FC" rule (see production-orders.ts ~L854),
    // extended to BF + ACC per Wei Siang Apr 2026.
    const anyFabSewDoneOnPO = myJcs.some(
      (jc) =>
        jc.departmentCode === "FAB_SEW" &&
        (jc.status === "COMPLETED" || jc.status === "TRANSFERRED"),
    );

    for (const [wipKey, cards] of groups) {
      const sorted = [...cards].sort((a, b) => a.sequence - b.sequence);
      const isDone = (c2: JCLite) =>
        c2.status === "COMPLETED" || c2.status === "TRANSFERRED";

      for (let i = 0; i < sorted.length; i++) {
        const card = sorted[i];
        if (!isDone(card)) continue;
        // PO-level FC suppression: any FS done in this PO clears the
        // entire FAB_CUT shelf for that PO. Per-component edge detection
        // would otherwise leave un-sewn components stranded on FC.
        if (card.departmentCode === "FAB_CUT" && anyFabSewDoneOnPO) continue;
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

        // Condensed FAB_CUT label (matches Production page's fabCutWIP):
        //   {product} | ({size}) | ({totalH"}) | (DV N") | {fabric} | (FC)
        // BF-only: height tokens included; sofa omits them.
        // NOTE: do NOT append component tags here — the BOM owns the WIP
        // naming scheme; adding HB/DV inside (FC …) breaks the user's mental
        // model (they expect identical FC labels to roll up by PO). The
        // "duplicate row" the user saw earlier is a quantity / consume bug,
        // not a labelling bug. See the wip_items consume logic in
        // production-orders.ts ~line 833.
        let wipCodeStr: string;
        if (card.departmentCode === "FAB_CUT") {
          const totalH =
            (po.gapInches || 0) +
            (po.divanHeightInches || 0) +
            (po.legHeightInches || 0);
          const isBF = po.itemCategory === "BEDFRAME";
          wipCodeStr = [
            po.productCode || "",
            po.sizeLabel ? `(${po.sizeLabel})` : "",
            isBF && totalH > 0 ? `(${totalH}")` : "",
            isBF && po.divanHeightInches ? `(DV ${po.divanHeightInches}")` : "",
            po.fabricCode || "",
            "(FC)",
          ]
            .filter(Boolean)
            .join(" | ");
        } else {
          wipCodeStr =
            card.wipLabel ||
            card.wipCode ||
            WIP_TYPE_LABELS[wipTypeShort] ||
            wipTypeShort ||
            wipKey;
        }
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

  // ---- Pass 3: merge sofas by (strippedSO, fabric) -----------------------
  // Each sofa group becomes one SET row; non-sofa groups pass through as-is.
  type SofaBucket = {
    salesOrderNo: string;
    fabric: string;
    sizeLabel: string;                              // shared across variants in the same SO+fabric bucket
    qtyByComponent: Map<string, number>;
    modelSet: Set<string>;
    baseModelSet: Set<string>;                      // base models (e.g. "5535") — used for the Product column
    setQty: number;
    oldestAgeDays: number;
    estTotalValueSen: number;
    pieceQty: number;                               // sum of component pieces
    memberItemIds: Set<string>;                     // GroupedItem.id set
    members: WIPMember[];                           // per-JC members
    // Per-PO accumulator for the SET row's `sources` array. Keyed by full
    // poCode (e.g. "SO-2604-309-02"). Each component contributes its slice
    // of pieces; we collapse to one row per PO at emit time so the dialog
    // shows "SO-XXXX qty=N" per contributing PO instead of one row per
    // (PO, component).
    sourcesByPo: Map<string, {
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
  };
  const sofaBuckets = new Map<string, SofaBucket>();
  const nonSofaItems: GroupedItem[] = [];

  for (const g of grouped.values()) {
    const allSofa =
      g.sources.length > 0 &&
      g.sources.every((s) => s.itemCategory === "SOFA");
    if (!allSofa) {
      nonSofaItems.push(g);
      continue;
    }
    for (const s of g.sources) {
      const so = stripPoSuffix(s.poCode);
      const key = `${so}::${s.fabricCode}`;
      let b = sofaBuckets.get(key);
      if (!b) {
        b = {
          salesOrderNo: so,
          fabric: s.fabricCode,
          sizeLabel: s.sizeLabel,
          qtyByComponent: new Map(),
          modelSet: new Set(),
          baseModelSet: new Set(),
          setQty: 0,
          oldestAgeDays: 0,
          estTotalValueSen: 0,
          pieceQty: 0,
          memberItemIds: new Set(),
          members: [],
          sourcesByPo: new Map(),
        };
        sofaBuckets.set(key, b);
      }
      // Roll this source up into the bucket's per-PO accumulator. Multiple
      // components of the same PO collapse to one entry; quantity sums.
      const existing = b.sourcesByPo.get(s.poCode);
      if (existing) {
        existing.quantity += s.quantity;
        if (s.ageDays > existing.ageDays) {
          existing.ageDays = s.ageDays;
          existing.completedDate = s.completedDate;
        }
      } else {
        b.sourcesByPo.set(s.poCode, {
          poCode: s.poCode,
          quantity: s.quantity,
          poQty: s.poQty,
          completedDate: s.completedDate,
          ageDays: s.ageDays,
          fabricCode: s.fabricCode,
          sizeLabel: s.sizeLabel,
          baseModel: s.baseModel,
          itemCategory: s.itemCategory,
        });
      }
      b.qtyByComponent.set(
        g.wipType,
        (b.qtyByComponent.get(g.wipType) || 0) + s.quantity,
      );
      b.modelSet.add(g.relatedProduct);
      if (s.baseModel) b.baseModelSet.add(s.baseModel);
      if (s.poQty > b.setQty) b.setQty = s.poQty;
      if (s.ageDays > b.oldestAgeDays) b.oldestAgeDays = s.ageDays;
      if (g.totalQty > 0) {
        b.estTotalValueSen += (s.quantity / g.totalQty) * g.estTotalValueSen;
      }
      b.pieceQty += s.quantity;
      b.memberItemIds.add(g.id);

      // Attach the matching raw entry as a member. Look up by
      // (poNo + wipType + completedBy) — exactly one match per source
      // since the Pass-1 loop emits a single edge per (po, wipKey-group).
      const match = raw.find(
        (r) =>
          r.poNo === s.poCode &&
          r.wipType === g.wipType &&
          r.completedBy === g.completedBy,
      );
      if (match) {
        b.members.push({
          poNo: match.poNo,
          jobCardId: match.jobCardId,
          wipType: match.wipType,
          quantity: match.quantity,
        });
      }
    }
  }

  // ---- Build response ----------------------------------------------------
  // The response is a unified array that serves both the "merged" view
  // (sofa SET rows + non-sofa per-component) and the "per-component" view
  // (every non-SET row — sofa components and BF/ACC alike). The UI
  // distinguishes them by `wipType === "SET"`.
  const rows: WIPRow[] = [];

  // Per-component sofa rows — emitted so PER_COMPONENT view can still
  // display the underlying WIPs even when MERGED view bundles them into
  // SET rows above. These mirror the original WIPItem shape exactly.
  for (const g of grouped.values()) {
    const allSofa =
      g.sources.length > 0 &&
      g.sources.every((s) => s.itemCategory === "SOFA");
    if (!allSofa) continue;
    const firstSrc = g.sources[0];
    const salesOrderNo = firstSrc ? stripPoSuffix(firstSrc.poCode) : null;
    rows.push({
      id: g.id,
      wipCode: g.wipCode,
      wipType: g.wipType,
      category: "SOFA",
      completedBy: g.completedBy,
      relatedProduct: g.relatedProduct,
      setQty: g.totalQty,
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

  // Sofa set rows (merged).
  for (const [bucketKey, b] of sofaBuckets) {
    const uniqueModels = Array.from(b.modelSet);
    // Strip shared baseModel prefix, join with "+" — same rule the frontend
    // uses. Single-model buckets keep their full code.
    let modelLabel = uniqueModels.join("+");
    if (uniqueModels.length > 1) {
      const firstDash = uniqueModels[0].indexOf("-");
      if (firstDash > 0) {
        const prefix = uniqueModels[0].slice(0, firstDash + 1);
        if (uniqueModels.every((m) => m.startsWith(prefix))) {
          modelLabel =
            prefix +
            uniqueModels.map((m) => m.slice(prefix.length)).join("+");
        }
      }
    }
    // Sofa SET label — lockstep with Production page's fabCutWIP() helper so
    // Inventory and Production Fab Cut display exactly the same wipCode:
    //   "5535-L(LHF)+2A(RHF) | (30) | PC151-02 | (FC)"
    // Sofa skips the BF-only height tokens; only model | (size) | fabric | (FC).
    const wipCode = [
      modelLabel,
      b.sizeLabel ? `(${b.sizeLabel})` : "",
      b.fabric,
      "(FC)",
    ]
      .filter(Boolean)
      .join(" | ");
    // Product column shows the base model (e.g. "5535") — variant suffixes
    // already live in the wipCode so duplicating them here just clutters the
    // column. Fall back to modelLabel for edge cases (product codes without
    // a "-" separator).
    const productLabel =
      b.baseModelSet.size === 1
        ? Array.from(b.baseModelSet)[0]
        : b.baseModelSet.size > 1
          ? Array.from(b.baseModelSet).sort().join("/")
          : modelLabel;
    const components = Array.from(b.qtyByComponent.entries())
      .map(([wipType, qty]) => ({ wipType, qty }))
      .sort((a, b2) => a.wipType.localeCompare(b2.wipType));
    const setQty = b.setQty || 1;

    rows.push({
      id: `set::${bucketKey}`,
      wipCode,
      wipType: "SET",
      category: "SOFA",
      completedBy: "FAB_CUT",
      relatedProduct: productLabel,
      setQty,
      pieceQty: b.pieceQty,
      salesOrderNo: b.salesOrderNo || null,
      fabric: b.fabric || "",
      oldestAgeDays: b.oldestAgeDays,
      estUnitCostSen:
        b.pieceQty > 0 ? b.estTotalValueSen / b.pieceQty : 0,
      estTotalValueSen: b.estTotalValueSen,
      members: b.members,
      memberItemIds: Array.from(b.memberItemIds),
      components,
      totalQty: setQty,
      sources: Array.from(b.sourcesByPo.values()),
    });
  }

  // Non-sofa pass-through rows (BF / accessory) — per-component at every
  // stage. User intentionally wants BF to show HB / Divan / etc. as
  // separate Inventory rows even at Fab Cut stage (they are physically
  // separate stock piles).
  for (const g of nonSofaItems) {
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
