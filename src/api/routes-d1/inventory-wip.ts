// ---------------------------------------------------------------------------
// GET /api/inventory/wip
//
// Single source of truth: the `wip_items` ledger table.
//
// Each wip_items row with stockQty != 0 emits one grid row. Positive rows
// are produced stock waiting for the next dept; negative rows are stub
// "skipped-upstream" markers written by the cascade when a downstream
// dept gets COMPLETED before its upstream (BUG-2026-04-27-013) — they
// self-resolve to 0 once the upstream finishes too.
//
// Auxiliary columns (category, related product, sources, age, cost) are
// derived per row by joining the JC chain via `wipLabel = wip_items.code`:
//
//   POSITIVE rows:
//     completedBy   ← latest COMPLETED JC's department
//     sources[]     ← every COMPLETED JC's PO (poNo + qty + ageDays)
//     oldestAgeDays ← max ageDays across those completed JCs
//     unit cost     ← labor rate × cumulative dept minutes per unit
//                     (matches the legacy edge-detection cost roll-up)
//
//   NEGATIVE rows:
//     completedBy   ← "PENDING" (no producer yet)
//     sources[]     ← the PO of the *triggering* JC: the downstream JC
//                     that completed past this missing producer (same
//                     wipKey, higher sequence, status = COMPLETED).
//     oldestAgeDays ← null (rendered "—" in the UI)
//     unit cost     ← 0 (rendered "—" in the UI)
//
// The `anomalies` field used to ride alongside `data[]`. It's been
// removed: negative rows are now first-class members of `data[]`, so the
// frontend has a single uniform list to render.
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

type WipItemRow = {
  id: string;
  code: string;
  type: string | null;
  relatedProduct: string | null;
  deptStatus: string | null;
  stockQty: number;
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
// Output shapes — preserved verbatim from the legacy JC-derivation path
// so the frontend doesn't need to learn a new shape.
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
  wipType: string;
  category: "SOFA" | "BEDFRAME" | "ACCESSORY";
  completedBy: string;
  relatedProduct: string;
  setQty: number;
  pieceQty: number;
  salesOrderNo: string | null;
  fabric: string;
  // null for negative rows (frontend renders "—")
  oldestAgeDays: number | null;
  // 0 for negative rows (frontend renders "—")
  estUnitCostSen: number;
  estTotalValueSen: number;
  members: WIPMember[];
  components?: Array<{ wipType: string; qty: number }>;
  memberItemIds?: string[];
  totalQty: number;
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

  // 1) The ledger — every wip_items row with non-zero stock. This is
  //    the row set we project to the grid.
  //
  //    BUG-2026-04-27-017: rows with deptStatus='UPHOLSTERY' are excluded.
  //    Per the user's mental model, UPHOLSTERY-completed = the piece is now
  //    Finished Good in stock, surfaced via deriveFGStock() on the Inventory
  //    > Finished Products tab. Showing it on the WIP tab too double-counted
  //    it (user-reported screenshot showed e.g. `5531 -Back Cushion 24` rows
  //    with positive qty appearing on WIP after UPH completion). Filtering
  //    at the SQL level keeps the negative-row stub semantics intact:
  //    cascade-written stubs carry deptStatus='PENDING' (BUG-2026-04-27-013)
  //    and still surface here.
  const wipRowsRes = await db
    .prepare(
      `SELECT id, code, type, relatedProduct, deptStatus, stockQty
         FROM wip_items
        WHERE stockQty != 0
          AND (deptStatus IS NULL OR deptStatus != 'UPHOLSTERY')
        ORDER BY code`,
    )
    .all<WipItemRow>();
  const wipItemRows: WipItemRow[] = (wipRowsRes.results ?? []).map((r) => ({
    id: r.id,
    code: r.code,
    type: r.type ?? "",
    relatedProduct: r.relatedProduct ?? "",
    deptStatus: r.deptStatus ?? "",
    stockQty: Number(r.stockQty) || 0,
  }));

  // 2) Fetch every PO + JC across active POs in one round-trip — same
  //    set the legacy JC-derivation walked. We need the join to derive
  //    sources / category / completedBy / age / cost per wip_items row.
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

  // Indexes for fast lookup.
  const poById = new Map<string, POLite>();
  for (const p of pos) poById.set(p.id, p);

  const jcsByPo = new Map<string, JCLite[]>();
  for (const jc of jcs) {
    const arr = jcsByPo.get(jc.productionOrderId);
    if (arr) arr.push(jc);
    else jcsByPo.set(jc.productionOrderId, [jc]);
  }

  // Group every JC by its wipLabel — both producer (same code) and
  // upstream (some other JC's code that this JC consumes from). Used
  // both for positive-row source aggregation and for negative-row
  // triggering-JC lookup.
  const jcsByLabel = new Map<string, JCLite[]>();
  for (const jc of jcs) {
    const label = jc.wipLabel || "";
    if (!label) continue;
    const arr = jcsByLabel.get(label);
    if (arr) arr.push(jc);
    else jcsByLabel.set(label, [jc]);
  }

  const today = new Date();
  const todayLaborRatePerMinSen = laborRateForDate(today);

  // Helper: given a producer JC, walk every JC in its (PO, wipKey,
  // branchKey) group up to and including this JC's sequence and sum
  // their productionTimeMinutes. Mirrors the legacy edge-detection cost
  // roll-up.
  const cumulativeMinsForCard = (jc: JCLite): number => {
    const myJcs = jcsByPo.get(jc.productionOrderId) ?? [];
    const wk = jc.wipKey || "FG";
    const bk = jc.branchKey ?? "";
    const sameBranch = myJcs.filter(
      (j) => (j.wipKey || "FG") === wk && (j.branchKey ?? "") === bk,
    );
    sameBranch.sort((a, b) => a.sequence - b.sequence);
    let mins = 0;
    for (const c2 of sameBranch) {
      if (
        c2.status === "COMPLETED" ||
        c2.status === "TRANSFERRED"
      ) {
        mins += Number(c2.productionTimeMinutes) || 0;
      }
      if (c2.id === jc.id) break;
    }
    return mins;
  };

  const isDone = (j: JCLite) =>
    j.status === "COMPLETED" || j.status === "TRANSFERRED";

  const rows: WIPRow[] = [];

  for (const w of wipItemRows) {
    // Producer JCs: those whose own wipLabel matches this code AND
    // are completed. They populate sources/age/cost on positive rows.
    const matchedJcs = jcsByLabel.get(w.code) ?? [];
    const completedJcs = matchedJcs.filter(isDone);
    const isNegative = w.stockQty < 0;

    // ---- Category & related product -----------------------------------
    // Prefer the JC join (gives accurate item_category from the PO);
    // fall back to wip_items.relatedProduct.
    const seedJc = matchedJcs[0];
    const seedPo = seedJc ? poById.get(seedJc.productionOrderId) : undefined;
    const fallbackProductCode = w.relatedProduct || "";
    const productCode = seedPo?.productCode || fallbackProductCode;
    const itemCategory = seedPo?.itemCategory || "";
    const category: WIPRow["category"] =
      itemCategory === "BEDFRAME"
        ? "BEDFRAME"
        : itemCategory === "SOFA"
          ? "SOFA"
          : "ACCESSORY";

    // ---- wipType display label ----------------------------------------
    // wip_items.type is the short uppercase form ("DIVAN", "HEADBOARD",
    // ...). The frontend expects the long display label, same as the
    // legacy path.
    const shortType = (w.type || "").toUpperCase();
    const wipTypeLabel =
      WIP_TYPE_LABELS[shortType] || (seedJc?.wipType
        ? WIP_TYPE_LABELS[(seedJc.wipType || "").toUpperCase()] || seedJc.wipType
        : shortType || "");

    // ---- Sources, completedBy, age, cost ------------------------------
    const sources: WIPRow["sources"] = [];
    const members: WIPMember[] = [];
    let completedBy = "";
    let oldestAgeDays: number | null = null;
    let estUnitCostSen = 0;
    let estTotalValueSen = 0;

    if (isNegative) {
      // Find the JC that triggered the consume. Strict rule
      // (BUG-2026-04-27-015): for each producer JC `P` (its wipLabel ==
      // this row's code), look at the **immediate** downstream in the
      // same `(wipKey, branchKey)` — the JC with the smallest sequence
      // strictly greater than P.sequence. Only that JC could have
      // written this row's decrement. If that neighbor is COMPLETED/
      // TRANSFERRED, its PO is a Source. If not completed, that PO did
      // not trigger this negative — skip it.
      //
      // Earlier code grabbed every higher-sequence COMPLETED JC in the
      // same wipKey. That over-collected: cascading later depts in the
      // chain (e.g. WEBBING after FRAMING already consumed (WD)) would
      // each show up as a "source" of (WD), even though only FRAMING
      // actually triggered the decrement.
      //
      // Edge case: when wip_items.code has no matching JC (the row was
      // INSERTed by the cascade because the upstream JC didn't exist
      // yet) we can't recover the wipKey — sources stays empty. This is
      // correct: there's literally no JC chain to reference.
      type TriggerEntry = { producer: JCLite; trigger: JCLite };
      const triggerEntries: TriggerEntry[] = [];
      for (const producer of matchedJcs) {
        if (!producer.wipKey) continue;
        const myJcs = jcsByPo.get(producer.productionOrderId) ?? [];
        const producerBk = producer.branchKey ?? "";
        let immediate: JCLite | null = null;
        for (const candidate of myJcs) {
          if (candidate.id === producer.id) continue;
          if (candidate.wipKey !== producer.wipKey) continue;
          if ((candidate.branchKey ?? "") !== producerBk) continue;
          if (candidate.sequence <= producer.sequence) continue;
          if (immediate === null || candidate.sequence < immediate.sequence) {
            immediate = candidate;
          }
        }
        if (!immediate) continue;
        if (!isDone(immediate)) continue;
        triggerEntries.push({ producer, trigger: immediate });
      }

      // Dedupe by PO id — a PO contributes at most one Source row even
      // if multiple producer-JCs in that PO map to the same downstream.
      const seenPoIds = new Set<string>();
      const uniqueEntries = triggerEntries.filter((e) => {
        const poId = e.trigger.productionOrderId;
        if (seenPoIds.has(poId)) return false;
        seenPoIds.add(poId);
        return true;
      });

      for (const { producer, trigger } of uniqueEntries) {
        const tpo = poById.get(trigger.productionOrderId);
        if (!tpo) continue;
        const consumeQty = producer.wipQty || tpo.quantity || 0;
        const completedDate = trigger.completedDate || tpo.startDate || "";
        const ageDays = completedDate
          ? Math.max(
              0,
              Math.floor(
                (today.getTime() - new Date(completedDate).getTime()) /
                  86400000,
              ),
            )
          : 0;
        sources.push({
          poCode: tpo.poNo,
          quantity: consumeQty,
          poQty: tpo.quantity || 1,
          completedDate,
          ageDays,
          fabricCode: tpo.fabricCode || "",
          baseModel: (tpo.productCode || "").split("-")[0],
          itemCategory: tpo.itemCategory || "",
        });
        members.push({
          poNo: tpo.poNo,
          jobCardId: trigger.id,
          wipType: wipTypeLabel,
          quantity: consumeQty,
        });
      }
      completedBy = "PENDING";
      oldestAgeDays = null;
      estUnitCostSen = 0;
      estTotalValueSen = 0;
    } else {
      // Positive row — aggregate from this code's COMPLETED producer JCs.
      // completedBy is the dept of the most-recent completion (mirrors
      // the legacy edge logic which keyed by completedBy dept).
      let bestCompletedJc: JCLite | null = null;
      let bestAge = -1;
      for (const cj of completedJcs) {
        const po = poById.get(cj.productionOrderId);
        if (!po) continue;
        const completedDate = cj.completedDate || po.startDate || "";
        const ageDays = completedDate
          ? Math.max(
              0,
              Math.floor(
                (today.getTime() - new Date(completedDate).getTime()) /
                  86400000,
              ),
            )
          : 0;
        const qty = cj.wipQty || po.quantity || 0;
        sources.push({
          poCode: po.poNo,
          quantity: qty,
          poQty: po.quantity || 1,
          completedDate,
          ageDays,
          fabricCode: po.fabricCode || "",
          baseModel: (po.productCode || "").split("-")[0],
          itemCategory: po.itemCategory || "",
        });
        members.push({
          poNo: po.poNo,
          jobCardId: cj.id,
          wipType: wipTypeLabel,
          quantity: qty,
        });
        if (ageDays > bestAge) {
          bestAge = ageDays;
          bestCompletedJc = cj;
          oldestAgeDays = ageDays;
        }

        // Per-unit cost (labor only — material BOM cost is 0 until
        // batch-layer pricing lands; see legacy header note). Each
        // producer JC contributes its cumulative dept-minutes × today's
        // labor rate, weighted by qty.
        const doneMinsPerUnit = cumulativeMinsForCard(cj);
        const laborPerUnitSen = doneMinsPerUnit * todayLaborRatePerMinSen;
        estTotalValueSen += laborPerUnitSen * qty;
      }
      // completedBy: dept_status from wip_items wins (it's what the
      // cascade writes); fall back to the latest completed JC's dept.
      completedBy =
        w.deptStatus ||
        bestCompletedJc?.departmentCode ||
        "";
      const totalQtyAbs = Math.abs(w.stockQty);
      estUnitCostSen = totalQtyAbs > 0 ? estTotalValueSen / totalQtyAbs : 0;
    }

    const firstSrc = sources[0];
    const salesOrderNo = firstSrc ? stripPoSuffix(firstSrc.poCode) : null;

    rows.push({
      id: w.id,
      wipCode: w.code,
      wipType: wipTypeLabel,
      category,
      completedBy,
      relatedProduct: productCode,
      setQty: w.stockQty,
      pieceQty: w.stockQty,
      salesOrderNo,
      fabric: firstSrc?.fabricCode || "",
      oldestAgeDays,
      estUnitCostSen,
      estTotalValueSen,
      members,
      totalQty: w.stockQty,
      sources,
    });
  }

  // Sort: code-ascending matches the wip_items SQL ORDER BY and gives
  // negative + positive rows a natural interleave by code.
  rows.sort((a, b) => a.wipCode.localeCompare(b.wipCode));

  return c.json({ success: true, data: rows });
});

export default app;
