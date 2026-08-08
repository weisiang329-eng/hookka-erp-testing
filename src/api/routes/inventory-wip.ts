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
import { requirePermission } from "../lib/rbac";
import { reconcileWip, type WipJobCardLike } from "../lib/wip-expected";

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
  companySOId: string | null;
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
  // Option C — merged FAB_CUT JC carries the set-level itemCategory
  // (BEDFRAME / SOFA / ACCESSORY) instead of a per-piece type. Add the
  // human-readable display labels so the Inventory Type column renders
  // "Bedframe" / "Sofa" / "Accessory" for these merged set rows.
  BEDFRAME: "Bedframe",
  SOFA: "Sofa",
  ACCESSORY: "Accessory",
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
type WIPRow = {
  id: string;
  wipCode: string;
  wipType: string;
  category: "SOFA" | "BEDFRAME" | "ACCESSORY";
  completedBy: string;
  relatedProduct: string;
  salesOrderNo: string | null;
  fabric: string;
  // null for negative rows (frontend renders "—")
  oldestAgeDays: number | null;
  // 0 for negative rows (frontend renders "—")
  estUnitCostSen: number;
  estTotalValueSen: number;
  totalQty: number;
  // Row-level convenience flag: every source row is from a SOFA PO. Set
  // once at row build time so the frontend doesn't need to walk
  // `sources[]` to recompute it (the legacy SET-merge code path was the
  // sole consumer of `sources[].itemCategory`, which is no longer on the
  // wire — see slim-payload commit dropping itemCategory/poQty/baseModel).
  isAllSofa: boolean;
  sources: Array<{
    poCode: string;
    // The JC that produced (positive row) or triggered (negative stub)
    // this source. Used by the WIP detail dialog's "Job Cards" table to
    // surface the per-JC breakdown. Replaces the legacy `members[]`
    // mirror, which carried the same JC id alongside duplicates of
    // poCode/quantity/wipType that are already on the row or source.
    jobCardId: string;
    quantity: number;
    completedDate: string;
    ageDays: number;
    fabricCode: string;
  }>;
};

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  // WIP inventory view — gate with the same inventory-read permission
  // as inventory.ts.
  const denied = await requirePermission(c, "inventory", "read");
  if (denied) return denied;

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
                startDate, status, companySOId
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
                startDate, status, companySOId
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

  // BUG-2026-04-27-009 NOTE: the prior code fetched `bom_templates` to
  // resolve a canonical baseModel for each PO and emit it on every
  // `sources[]` entry. As of the slim-payload pass that field has zero
  // live UI consumers (the only readers were inside the dormant
  // SET-merge code path under `_sofaSetRows` in inventory/index.tsx),
  // so the SELECT + Map were removed along with `sources[].baseModel`.
  // If a future view needs a canonical baseModel per source, restore
  // the lookup here rather than fanning it out across the response.

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

  // BUG-2026-04-30-003: removed the UPH-row hide filter (formerly
  // BUG-2026-04-27-033 v2). The backend ledger (`wip_items`) now
  // correctly subtracts UPH +N when all UPH JCs in a PO are done — see
  // applyWipInventoryChange's UPH COMPLETED branch in
  // src/api/routes/production-orders.ts (Plan B). Once that subtract
  // fires, the row's stockQty falls to zero on its own, so frontend
  // masking is no longer needed. The pre-computed
  // `poFullyUphComplete` map (sole consumer was this filter) was also
  // removed.
  const wipItemRows: WipItemRow[] = wipItemRowsAll;

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
    let completedBy = "";
    let oldestAgeDays: number | null = null;
    let estUnitCostSen = 0;
    let estTotalValueSen = 0;
    // Track the row-level isAllSofa flag while we walk the sources, so
    // the frontend doesn't have to re-derive it (the legacy
    // `sources[].itemCategory` was the only reason the value was on the
    // wire). A row with zero sources is treated as "not all sofa".
    let sourceCount = 0;
    let sofaSourceCount = 0;

    if (isNegative) {
      // BUG-2026-04-27-035: cascade-stub source attribution.
      //
      // The cascade in production-orders.ts (UPH branch, line ~1099-1155)
      // uses a "branch terminal consume" pattern: when a UPH JC
      // completes, for each branch in its wipKey, it picks the JC at the
      // highest sequence below UPH and consumes from that JC's wipLabel.
      // If the upstream wip_items row doesn't exist (intermediate dept
      // skipped → no producer-add ever happened), it INSERTs a -N stub.
      //
      // So the stub's TRIGGER consumer is *always* the UPHOLSTERY JC of
      // the same PO/wipKey — never some "immediate downstream"
      // intermediate dept. The earlier rule (BUG-2026-04-27-015's
      // strict-immediate-downstream) misattributed: it walked from
      // producer (e.g. WEBBING) to seq+1 (FOAM, still WAITING) and
      // bailed because FOAM wasn't COMPLETED — even though UPH at seq+2
      // had already written this stub. Result: 0 PO(s) for every stub
      // whose chain has an intermediate WAITING dept between the
      // producer and the COMPLETED UPH.
      //
      // Fix: attribute by finding the COMPLETED UPHOLSTERY JC in the
      // same (PO, wipKey) — that's literally the dept the cascade
      // consumed from. branchKey doesn't constrain because UPH consumes
      // from EVERY branch terminal in the wipKey, not just one.
      //
      // The earlier "strict-immediate" rule was correct for forward
      // consume chains (e.g. FRAMING consuming (WD), then WEBBING
      // consuming (Frame), then UPH consuming (Webbing)) — each
      // intermediate dept attributes its consume to itself. But that
      // chain only fires when each dept actually completes; in the
      // user's "skip-to-UPH" workflow nothing in the middle ever
      // executed, so the only attribution candidate is the UPH itself.
      type TriggerEntry = { producer: JCLite; trigger: JCLite };
      const triggerEntries: TriggerEntry[] = [];
      for (const producer of matchedJcs) {
        if (!producer.wipKey) continue;
        const myJcs = jcsByPo.get(producer.productionOrderId) ?? [];
        // 1) Strict-immediate path (BUG-2026-04-27-015): if the JC at
        //    smallest sequence > producer is COMPLETED, it's the
        //    forward-consume trigger. This still wins for normal flow.
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
        if (immediate && isDone(immediate)) {
          triggerEntries.push({ producer, trigger: immediate });
          continue;
        }
        // 2) UPH-skip-to-terminal path (BUG-2026-04-27-035): no immediate
        //    forward consume found, but the cascade may have written
        //    this stub via a UPH branch-terminal consume. Look for any
        //    COMPLETED UPHOLSTERY JC in the same (PO, wipKey) at higher
        //    sequence. If found, that's the trigger — attribute to it.
        let uphTrigger: JCLite | null = null;
        for (const candidate of myJcs) {
          if (candidate.id === producer.id) continue;
          if (candidate.wipKey !== producer.wipKey) continue;
          if (candidate.sequence <= producer.sequence) continue;
          if (
            (candidate.departmentCode || "").toUpperCase() !== "UPHOLSTERY"
          )
            continue;
          if (!isDone(candidate)) continue;
          if (uphTrigger === null || candidate.sequence < uphTrigger.sequence) {
            uphTrigger = candidate;
          }
        }
        if (uphTrigger) {
          triggerEntries.push({ producer, trigger: uphTrigger });
        }
        // 3) Option C — merged FAB_CUT stub triggered by per-piece
        //    downstream FAB_SEW completing before the merged FC. The
        //    producer here is the merged FC JC itself (wipLabel ends
        //    with "(FC)"). Look for completed FAB_SEW JCs in the same
        //    merge group:
        //      BF/ACC → same productionOrderId
        //      SOFA   → same companySOId + fabricCode
        //    Without this attribution, the negative stub renders with
        //    no source row → search by SO id misses it on the
        //    Inventory WIP page.
        if (
          (producer.wipLabel || "").endsWith("(FC)") &&
          producer.departmentCode === "FAB_CUT"
        ) {
          const fcPo = poById.get(producer.productionOrderId);
          if (fcPo) {
            const isSofa = (fcPo.itemCategory || "") === "SOFA";
            for (const cand of allJcs) {
              if (cand.id === producer.id) continue;
              if (cand.departmentCode !== "FAB_SEW") continue;
              if (!isDone(cand)) continue;
              const candPo = poById.get(cand.productionOrderId);
              if (!candPo) continue;
              if (isSofa) {
                if (candPo.companySOId !== fcPo.companySOId) continue;
                if (candPo.fabricCode !== fcPo.fabricCode) continue;
              } else {
                if (cand.productionOrderId !== producer.productionOrderId) continue;
              }
              triggerEntries.push({ producer, trigger: cand });
            }
          }
        }
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
          jobCardId: trigger.id,
          quantity: consumeQty,
          completedDate,
          ageDays,
          fabricCode: tpo.fabricCode || "",
        });
        sourceCount++;
        if ((tpo.itemCategory || "") === "SOFA") sofaSourceCount++;
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
          jobCardId: cj.id,
          quantity: qty,
          completedDate,
          ageDays,
          fabricCode: po.fabricCode || "",
        });
        sourceCount++;
        if ((po.itemCategory || "") === "SOFA") sofaSourceCount++;
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
      salesOrderNo,
      fabric: firstSrc?.fabricCode || "",
      oldestAgeDays,
      estUnitCostSen,
      estTotalValueSen,
      totalQty: w.stockQty,
      isAllSofa: sourceCount > 0 && sofaSourceCount === sourceCount,
      sources,
    });
  }

  // Sort: code-ascending matches the wip_items SQL ORDER BY and gives
  // negative + positive rows a natural interleave by code.
  rows.sort((a, b) => a.wipCode.localeCompare(b.wipCode));

  return c.json({ success: true, data: rows });
});

// ---------------------------------------------------------------------------
// GET /api/inventory/wip/reconcile — READ-ONLY. Writes nothing, ever.
//
// `wip_items.stock_qty` is a running balance that only ever gets nudged: every
// decrement the cascade missed is permanent, and nothing has ever re-derived
// the number to say so. This endpoint is that derivation. It recomputes what
// each row SHOULD be from the job cards alone (src/api/lib/wip-expected.ts —
// the same module the cascade's settle uses, so the fix and the audit can
// never drift apart) and lists every code where the stored balance disagrees.
//
// `diff = stored − expected`. Positive means the ledger is carrying stock the
// floor never reported finishing; negative means the ledger has been decremented
// for work that was never produced (the physically impossible rows).
//
// Query params:
//   ?limit=N      cap the returned rows (default 500, 0 = all). Totals always
//                 cover EVERY row, never just the returned page.
//   ?nonZeroOnly  only rows whose STORED balance is non-zero — what the WIP
//                 board actually shows today.
// ---------------------------------------------------------------------------
app.get("/reconcile", async (c) => {
  const denied = await requirePermission(c, "inventory", "read");
  if (denied) return denied;

  const db = c.var.DB;
  const url = new URL(c.req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "500");
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? limitRaw : 500;
  const nonZeroOnly = url.searchParams.get("nonZeroOnly") !== null;

  // Every PO and every job card — the derivation is a whole-ledger statement,
  // and a code shared across POs (a third of the balance is) can only be judged
  // by summing all of them. Quoted camelCase aliases: an unquoted `AS wipLabel`
  // comes back folded to lowercase.
  const [posRes, jcsRes, storedRes] = await Promise.all([
    db
      .prepare(
        `SELECT id, quantity, itemCategory AS "itemCategory",
                specialOrder AS "specialOrder"
           FROM production_orders`,
      )
      .all<{
        id: string;
        quantity: number | null;
        itemCategory: string | null;
        specialOrder: string | null;
      }>(),
    db
      .prepare(
        `SELECT id, productionOrderId AS "productionOrderId",
                departmentCode AS "departmentCode", sequence, status,
                wipKey AS "wipKey", wipLabel AS "wipLabel", wipQty AS "wipQty",
                branchKey AS "branchKey", wipType AS "wipType"
           FROM job_cards`,
      )
      .all<WipJobCardLike>(),
    db
      .prepare(`SELECT code, stockQty AS "stockQty" FROM wip_items`)
      .all<{ code: string; stockQty: number }>(),
  ]);

  const result = reconcileWip(
    posRes.results ?? [],
    jcsRes.results ?? [],
    (storedRes.results ?? []).map((r) => ({
      code: r.code,
      stockQty: Number(r.stockQty ?? 0),
    })),
  );

  const shown = nonZeroOnly
    ? result.rows.filter((r) => r.storedQty !== 0)
    : result.rows;

  return c.json({
    success: true,
    // Totals describe the WHOLE ledger regardless of limit / filter, so a
    // truncated page can never be mistaken for a clean bill of health.
    summary: {
      codesChecked: result.checked,
      agreeing: result.agreeing,
      disagreeing: result.disagreeing,
      netDiff: result.netDiff,
      overstatedUnits: result.overstatedUnits,
      understatedUnits: result.understatedUnits,
      negativeStoredRows: result.negativeStoredRows,
      nonZeroStoredDisagreeing: result.rows.filter((r) => r.storedQty !== 0)
        .length,
    },
    returned: limit > 0 ? Math.min(shown.length, limit) : shown.length,
    truncated: limit > 0 && shown.length > limit,
    rows: limit > 0 ? shown.slice(0, limit) : shown,
  });
});

export default app;
