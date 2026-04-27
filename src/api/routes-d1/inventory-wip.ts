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
  //    BUG-2026-04-27-017 (initial fix): rows with deptStatus='UPHOLSTERY'
  //    were blanket-excluded, on the theory that UPH-completed = the piece
  //    is now FG and `deriveFGStock` surfaces it on the Finished Products
  //    tab. The blanket filter over-hid for partial-UPH POs (BF: Divan UPH
  //    done, HB UPH still WAITING; sofa: Cushion UPH done, Base/Armrest
  //    still WAITING). In that state the PO doesn't qualify as FG yet
  //    (deriveFGStock requires every UPH JC of the PO to be COMPLETED), so
  //    the completed component must remain visible on the WIP tab.
  //
  //    Refined rule (BUG-2026-04-27-017 follow-up): a UPH wip_items row is
  //    hidden ONLY when, for every PO that links to it via any JC's
  //    wipLabel, all of that PO's UPH JCs are COMPLETED/TRANSFERRED. If
  //    any linked PO still has a pending UPH JC, the row stays visible.
  //
  //    Implementation: read all non-zero rows from SQL, then post-filter
  //    in JS using the (pos, jcs) maps already loaded for derivation
  //    below. Cheaper than a triple-nested correlated subquery and reuses
  //    the indexes we build anyway. Negative-row stub semantics (deptStatus
  //    = 'PENDING', BUG-2026-04-27-013) are unaffected — only the
  //    'UPHOLSTERY' deptStatus rows are subject to the conditional hide.
  const wipRowsRes = await db
    .prepare(
      `SELECT id, code, type, relatedProduct, deptStatus, stockQty
         FROM wip_items
        WHERE stockQty != 0
        ORDER BY code`,
    )
    .all<WipItemRow>();
  const wipItemRowsAll: WipItemRow[] = (wipRowsRes.results ?? []).map((r) => ({
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

  // BUG-2026-04-27-034: a negative PENDING stub is written by the cascade
  // when an UPHOLSTERY JC completes against a missing upstream wip_items
  // row. UPHOLSTERY is the terminal dept in BF/sofa BOMs, so completing
  // it flips the PO to status='COMPLETED' in the same transaction —
  // which is then excluded from the active-status fetch below. Result:
  // jcsByLabel / jcsByPo don't contain the consumer JCs that triggered
  // the stub, so the WIP detail panel shows "0 PO(s)" for every stub.
  // Fix: also fetch JCs from POs in COMPLETED/TRANSFERRED status — we
  // index those separately so the chain walk for stub source attribution
  // (around line 411) can find the trigger consumer JCs even after
  // their PO graduated. Active-status fetches still drive everything
  // else (positive-row sources, completedBy, age, cost roll-up) — those
  // SHOULD only consider in-flight POs.
  const stubAttrStatuses = ["COMPLETED", "TRANSFERRED"];
  const stubPlaceholders = stubAttrStatuses.map(() => "?").join(",");

  const [posRes, jcsRes, stubPosRes, stubJcsRes] = await Promise.all([
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
    // Stub-attribution-only: POs that have already graduated past active.
    // Same column set as the active POs so they can share the POLite type.
    db
      .prepare(
        `SELECT id, poNo, productId, productCode, productName, itemCategory,
                sizeCode, sizeLabel, fabricCode, quantity,
                gapInches, divanHeightInches, legHeightInches,
                startDate, status
           FROM production_orders
          WHERE status IN (${stubPlaceholders})`,
      )
      .bind(...stubAttrStatuses)
      .all<POLite>(),
    // Stub-attribution-only: ALL JCs of the graduated POs above. The
    // chain walk needs both the producer JC (whose wipLabel matches the
    // stub code — typically a FOAM/WEBBING upstream JC, may be WAITING)
    // AND the trigger consumer JC (downstream UPH, COMPLETED). Both
    // belong to a now-COMPLETED PO, so we must fetch the whole chain,
    // not just UPH.
    db
      .prepare(
        `SELECT jc.id, jc.productionOrderId, jc.departmentCode, jc.sequence,
                jc.status, jc.completedDate, jc.productionTimeMinutes,
                jc.wipKey, jc.wipCode, jc.wipType, jc.wipLabel, jc.wipQty,
                jc.branchKey
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.status IN (${stubPlaceholders})`,
      )
      .bind(...stubAttrStatuses)
      .all<JCLite>(),
  ]);

  const pos: POLite[] = posRes.results ?? [];
  const jcs: JCLite[] = jcsRes.results ?? [];
  const stubPos: POLite[] = stubPosRes.results ?? [];
  const stubJcs: JCLite[] = stubJcsRes.results ?? [];

  // Indexes for fast lookup.
  const poById = new Map<string, POLite>();
  for (const p of pos) poById.set(p.id, p);
  // BUG-2026-04-27-034: stub-attribution PO lookup includes graduated
  // (COMPLETED / TRANSFERRED) POs. Used only by the negative-row chain
  // walk for source attribution. Does NOT participate in
  // poFullyUphComplete (that's an active-PO concern) or in any other
  // lookup keyed by `pos`.
  for (const p of stubPos) {
    if (!poById.has(p.id)) poById.set(p.id, p);
  }

  // jcsByPo / jcsByLabel must contain every JC the negative-row chain
  // walk references — including JCs of POs that have already graduated
  // to COMPLETED. Without the stub-PO JCs, jcsByLabel.get(stub.code)
  // returns [] for any stub whose triggering UPH lived on a now-
  // graduated PO → "0 PO(s)" in the WIP detail panel.
  const allJcs: JCLite[] = [...jcs, ...stubJcs];
  const jcsByPo = new Map<string, JCLite[]>();
  for (const jc of allJcs) {
    const arr = jcsByPo.get(jc.productionOrderId);
    if (arr) arr.push(jc);
    else jcsByPo.set(jc.productionOrderId, [jc]);
  }

  // Group every JC by its wipLabel — both producer (same code) and
  // upstream (some other JC's code that this JC consumes from). Used
  // both for positive-row source aggregation and for negative-row
  // triggering-JC lookup.
  const jcsByLabel = new Map<string, JCLite[]>();
  for (const jc of allJcs) {
    const label = jc.wipLabel || "";
    if (!label) continue;
    const arr = jcsByLabel.get(label);
    if (arr) arr.push(jc);
    else jcsByLabel.set(label, [jc]);
  }

  // ---- BUG-2026-04-27-017 follow-up: conditional UPH hide -----------
  // Pre-compute "PO is fully UPH-complete" once per PO: TRUE iff the PO
  // has at least one UPH JC AND every UPH JC is COMPLETED/TRANSFERRED.
  // A PO with no UPH JCs at all (e.g. accessory) is NOT considered
  // fully UPH-complete — but its wip_items rows wouldn't carry
  // deptStatus='UPHOLSTERY' anyway, so the flag is only consulted for
  // POs that did write a UPH producer row.
  const poFullyUphComplete = new Map<string, boolean>();
  for (const po of pos) {
    const myJcs = jcsByPo.get(po.id) ?? [];
    const uphJcs = myJcs.filter(
      (j) => (j.departmentCode || "").toUpperCase() === "UPHOLSTERY",
    );
    if (uphJcs.length === 0) {
      poFullyUphComplete.set(po.id, false);
      continue;
    }
    poFullyUphComplete.set(
      po.id,
      uphJcs.every(
        (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
      ),
    );
  }

  // BUG-2026-04-27-033 ("double entry" — user-reported): when all UPH JCs
  // of a PO are COMPLETED, the PO transitions to FG via `deriveFGStock`
  // (Layer 1: pure status, no writes). The cascade in production-orders.ts
  // (Layer 2: inventory bookkeeping) writes UPH +N producer rows for the
  // same goods. Layer 1 surfaces the goods on the FG board; Layer 2's
  // UPH +N row, if also shown on WIP, double-counts the same goods.
  //
  // Fix: hide UPHOLSTERY-tagged wip_items rows whose every linked PO is
  // fully UPH-complete — those goods are FG, not WIP.
  //
  // PENDING (-N) stub rows from BUG-2026-04-27-013 (cascade tried to
  // consume a missing upstream wip_items row) STAY VISIBLE — they are
  // an audit signal ("you skipped a dept"), independent of the
  // FG/double-entry concern. The user explicitly wants these visible
  // for reconcile, even after the PO is FG. The cascade keeps writing
  // them; the read filter does not hide them.
  //
  // Multi-PO mixed (BUG-2026-04-27-018, partial vs fully): the row stays
  // visible at the full ledger qty if any contributing PO is not yet FG;
  // the FG portion is correctly surfaced via deriveFGStock. Documented
  // in `docs/INVENTORY-WIP-FLOW.md` § 7.
  //
  // Orphan rows (no linking JC at all — legacy / migration residue /
  // external entry, BUG-2026-04-27-019) → show as-is so the user can
  // spot and reconcile.
  const wipItemRows: WipItemRow[] = wipItemRowsAll.filter((w) => {
    if ((w.deptStatus || "").toUpperCase() !== "UPHOLSTERY") return true;
    // BUG-2026-04-27-033 v2: a single UPH wip_label is SHARED across every
    // PO whose product variant produces that label (e.g. wip_label
    // "1007-(Q) -HB 22\"" matches every 1007-(Q) BF PO ever planned —
    // 263+ rows in our case). The previous filter required EVERY linked
    // UPH JC's PO (including those still WAITING in other POs) to be
    // fully UPH-complete, which is essentially never true once the row
    // is shared. Result: UPH +N rows for fully-complete POs stayed
    // visible on WIP while the same goods also surfaced on FG via
    // `deriveFGStock` → user-reported "double entry".
    //
    // Correct rule: only the UPH JCs that have already COMPLETED have
    // contributed to this row's stockQty. Hide iff ALL of those
    // contributing JCs' POs are fully UPH-complete (i.e. the entire
    // current stockQty is FG, not WIP). Other POs whose UPH is still
    // WAITING haven't written to this row yet — they'll add their share
    // later, at which point the filter re-evaluates with them included.
    const linkedCompletedUphJcs = (jcsByLabel.get(w.code) ?? []).filter(
      (jc) =>
        (jc.departmentCode || "").toUpperCase() === "UPHOLSTERY" &&
        (jc.status === "COMPLETED" || jc.status === "TRANSFERRED"),
    );
    if (
      linkedCompletedUphJcs.length > 0 &&
      linkedCompletedUphJcs.every((jc) =>
        poFullyUphComplete.get(jc.productionOrderId),
      )
    ) {
      return false; // hide — every contributing PO is now FG
    }
    return true;
  });

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

    // BUG-2026-04-27-032: trust `w.stockQty` everywhere — it's the ledger
    // truth maintained by the cascade in production-orders.ts (forward
    // consume / producer-add / rollback) plus the DO Dispatch decrement
    // (BUG-2026-04-27-021). The previous per-PO attribution sum was a
    // JC-capacity proxy, not produced stock; it inflated the displayed
    // qty when many POs shared the same UPH wipLabel.
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
