// Pure baseRows compute module — extracted from production/index.tsx
// (Phase 1 of the Production performance refactor).
//
// This file holds the heavy, render-blocking row-building pass for the
// Production page's dept grid. It is intentionally pure: no React, no DOM,
// no module-level mutable state. Every value that the original render-scope
// closures captured (today, mode, activeTab, the orders arrays, the picker
// index) is now an explicit function parameter. Phase 2 will run these
// functions inside a Web Worker; Phase 1 keeps them running synchronously
// from index.tsx's useMemos with ZERO behavior change.

import type { JobCard, ProductionOrder, DeptRow, DeptSched, PrevState } from "./types";
import { jcMinutesTotal } from "../../lib/job-card-minutes";

// Per (poId, deptCode, wipKey) -> JobCard index. The outer Map keys on
// deptCode; the inner Map keys on wipKey ("" when none) plus a "*" entry
// for the latest-due fallback across all wipKeys in that (PO, dept).
export type PickerByDept = Map<string, Map<string, JobCard>>;

// Build a DeptSched from a candidate JobCard (or null if no card exists).
// `poJobCards` is every JobCard on the parent PO. The `locked` flag is
// computed by filtering to the **card's own** wipKey — NOT the row's
// wipKey — so that a column showing a different wipKey's JC (e.g. the
// FAB_CUT column on a WOOD_CUT row, where Wood Cut is the Divan chain
// and Fab Cut is the HB chain in a Bedframe BOM) only locks if a later
// dept in THAT card's own chain has completed. Previously the caller
// pre-filtered siblings by the row's wipKey, which created a false-
// positive lock when a row's column displayed a card from a different
// chain (Wood Cut DONE wrongly locked Fab Cut + Fab Sew on the same
// row even though those three are independent component chains —
// reported by user 2026-04-26).
// Aggregate-form DeptSched for the sofa PACKING merge-row case (wipKey
// === "FG"). At PACKING, sofa's 3 component branches (Base / Cushion /
// Armrest) collapse into one JC keyed "FG". For each upstream dept we
// need to summarize across ALL component-branch JCs in that dept on
// this PO — NOT pick one JC scoped to the row's wipKey (FG has no
// upstream). Mirrors `cellFor()`'s semantics for the Overview matrix.
//
// Output shape matches buildSched so the same DataGrid renderer works:
//   - due       = earliest non-empty dueDate across cards
//   - completed = max completedDate iff EVERY card is COMPLETED/
//                 TRANSFERRED, else "" (matches user spec — only show a
//                 date when the merged dept is fully done)
//   - state     = "done" if all done; else "overdue" if earliest due
//                 already passed; else "pending"
// jobCardId/deptCode/wipKey come from the first card so the patch
// route still resolves, but the cell is conceptually a roll-up — see
// TODO below.
export const buildSchedAgg = (
  cards: JobCard[],
  today: string,
  poId: string,
): DeptSched => {
  if (cards.length === 0) {
    return {
      due: "", completed: "", state: "none", sortKey: 0, poId,
      jobCardId: "", deptCode: "", wipKey: "", locked: false,
    };
  }
  const due =
    cards.map((c) => c.dueDate || "").filter(Boolean).sort()[0] || "";
  const allDone = cards.every(
    (c) => c.status === "COMPLETED" || c.status === "TRANSFERRED",
  );
  const completed = allDone
    ? cards.map((c) => c.completedDate || "").filter(Boolean).sort().slice(-1)[0] || ""
    : "";
  let state: PrevState;
  if (allDone) state = "done";
  else if (due && due < today) state = "overdue";
  else state = "pending";
  const sortKey = state === "overdue" ? 3 : state === "pending" ? 2 : 1;
  // TODO: aggregate cells aren't directly patch-clickable — jobCardId/
  // deptCode/wipKey reflect the first underlying card only. The
  // PACKING merge-row's upstream date columns are read-only from the
  // operator's perspective; date edits happen on the per-component
  // dept tabs (Fab Cut / Foam / Wood Cut etc.) where individual JCs
  // are still rendered.
  const first = cards[0];
  return {
    due, completed, state, sortKey, poId,
    jobCardId: first.id,
    deptCode: first.departmentCode,
    wipKey: first.wipKey || "",
    locked: false,
  };
};

export const buildSched = (
  card: JobCard | null,
  today: string,
  poId: string,
  poJobCards: JobCard[] = [],
): DeptSched => {
  if (!card) {
    return {
      due: "", completed: "", state: "none", sortKey: 0, poId,
      jobCardId: "", deptCode: "", wipKey: "", locked: false,
    };
  }
  const due = card.dueDate || "";
  const completed = card.completedDate || "";
  const isDone = card.status === "COMPLETED" || card.status === "TRANSFERRED";
  let state: PrevState;
  if (isDone) state = "done";
  else if (due && due < today) state = "overdue";
  else state = "pending";
  const sortKey = state === "overdue" ? 3 : state === "pending" ? 2 : 1;
  // Lock UI disabled (2026-04-26) — aligns with backend.
  //
  // Backend already disabled the upstream-lock predicate at
  // src/api/routes/production-orders.ts:1255 + :2121 (PATCH guard +
  // scan-complete guard are no-ops). Frontend used to compute `locked`
  // from the same flat DEPT_ORDER + wipKey heuristic which:
  //   (a) fired false positives across BOM parallel branches — Wood Cut
  //       DONE wrongly locked Fab Cut/Sew on the same wipKey row, even
  //       though backend would happily accept the patch
  //   (b) rendered misleading 🔒 icons that no longer reflected any
  //       backend gate — UX worse than full-off
  // Until BOM-driven (per-branch) lock chain lands, set `locked = false`
  // unconditionally so frontend matches backend reality. `poJobCards`
  // stays in the signature for the eventual rewrite.
  void poJobCards;
  const locked = false;
  return {
    due, completed, state, sortKey, poId,
    jobCardId: card.id,
    deptCode: card.departmentCode,
    wipKey: card.wipKey || "",
    locked,
  };
};

// Sprint 5 F4: pre-compute the picker index. Per (poId, deptCode, wipKey)
// store the latest-due JobCard; per (poId, deptCode, "*") store the
// fallback (any wipKey on that PO/dept). The previous implementation
// ran o.jobCards.filter twice + a sort INSIDE picker(code) for every
// (PO, JC) × every dept-column the grid renders — at 500 POs × 8 JCs ×
// 8 dept-columns that's 32k filter+sort passes per render. Now: 8 ×
// (jobCards × 2) per PO at index time, O(1) lookups during render.

// Build the PickerByDept for ONE order. The order's index entry depends
// only on that order's own jobCards — entries are fully independent — so
// the worker can rebuild a single dirty PO's entry and reuse the cache
// for the rest (Phase 3). buildPickerIndex below is just this applied to
// every order; the per-order body is unchanged from before the split.
export const buildOnePickerEntry = (o: ProductionOrder): PickerByDept => {
  const byDept: PickerByDept = new Map();
  for (const j of o.jobCards) {
    const code = j.departmentCode;
    let m = byDept.get(code);
    if (!m) {
      m = new Map();
      byDept.set(code, m);
    }
    const wipKey = j.wipKey || "";
    // Latest-due wins (mirrors the previous picker's sort step).
    const prevForKey = m.get(wipKey);
    if (
      !prevForKey ||
      (j.dueDate || "").localeCompare(prevForKey.dueDate || "") > 0
    ) {
      m.set(wipKey, j);
    }
    // Track the fallback ("*") = latest-due across ALL wipKeys in
    // this (PO, dept). Mirrors the picker's second pass when no
    // wipKey-matched card exists.
    const prevAny = m.get("*");
    if (
      !prevAny ||
      (j.dueDate || "").localeCompare(prevAny.dueDate || "") > 0
    ) {
      m.set("*", j);
    }
  }
  return byDept;
};

export const buildPickerIndex = (
  orders: ProductionOrder[],
): Map<string, PickerByDept> => {
  const idx = new Map<string, PickerByDept>();
  // The entry for a given o.id depends only on that order's own jobCards,
  // so a pure display-filter change (category / search / state / date)
  // cannot alter it — and baseRows looks the index up by o.id only for
  // the orders it actually emits, so building it from the filtered set
  // yields the identical result the worker now relies on (Phase 3).
  for (const o of orders) {
    idx.set(o.id, buildOnePickerEntry(o));
  }
  return idx;
};

// Heavy row-building pass. In the per-route dept pages (mode "dept" /
// "overview") it emits rows for the ACTIVE dept only — see the scopeDept
// guard inside. In legacy "full" mode it builds every dept's rows so the
// in-page tab bar can switch dept without a refetch. Each row carries
// its own `_deptCode` so the cheap `deptRows` memo below filters without
// re-running the picker / buildSched chain.
//
// The sched_FAB_CUT…sched_PACKING columns read pickerIndex / o.jobCards
// (every dept, never scoped), so they stay intact for every kept row —
// those columns are user-toggleable on any dept tab.
//
// `mode` and `activeTab` are the page-level props/state that drive the
// scopeDept guard; `today` is the ISO date string (computed once by the
// caller) used by buildSched / buildSchedAgg for the overdue check.
export const buildBaseRows = (
  filteredOrders: ProductionOrder[],
  pickerIndex: Map<string, PickerByDept>,
  mode: "full" | "dept" | "overview",
  activeTab: string,
  today: string,
): Array<DeptRow & { _deptCode: string }> => {
  const rows: Array<DeptRow & { _deptCode: string }> = [];
  let n = 1;

  // Pre-index orders by their merge-group key so the picker's cross-PO
  // sibling scan below is O(1) lookup instead of O(N) over ALL filtered
  // orders. The full scan was the main thread freeze the operator hit
  // when navigating between dept pages on large depts (e.g. fab-sew with
  // 1.8k orders × 3 JCs × 8 dept columns × 1.8k inner-scan ≈ 80M iters
  // → 45s renderer hang, "需要 refresh 才 load" symptom). The group key
  // recipe MUST stay in sync with the per-sibling computation in the
  // picker fallback (companySOId || salesOrderId || companyCOId ||
  // consignmentOrderId) — otherwise siblings vanish from the index and
  // SOFA cross-PO FAB_CUT lookups silently return null again.
  const ordersByGroup = new Map<string, ProductionOrder[]>();
  for (const o of filteredOrders) {
    const gid =
      o.companySOId ||
      o.salesOrderId ||
      o.companyCOId ||
      o.consignmentOrderId ||
      "";
    if (!gid) continue;
    const arr = ordersByGroup.get(gid);
    if (arr) arr.push(o);
    else ordersByGroup.set(gid, [o]);
  }

  // Perf 2026-05-22 — emit grid rows for the ACTIVE dept only. baseRows
  // used to build a row for ALL 8 depts' job cards (~15k rows) on every
  // dept-page load, then deptRows discarded 7/8 of them — that 8× over-
  // build is the ~0.3-0.6s synchronous main-thread freeze the operator
  // hit when switching depts. Legacy "full" mode switches dept via an
  // in-page tab bar with no refetch, so it still needs every dept pre-
  // built (scopeDept = null there).
  const scopeDept = mode === "full" ? null : activeTab;

  for (const o of filteredOrders) {
    const poDeptIndex = pickerIndex.get(o.id);
    for (const jc of o.jobCards) {
      // Skip job cards outside the active dept — see scopeDept above.
      // The sched_* columns still read pickerIndex / o.jobCards (every
      // dept, unchanged), so each kept row's cell values are identical.
      if (scopeDept && jc.departmentCode !== scopeDept) continue;
      // F4: O(1) picker lookup against the pre-built (deptCode, wipKey)
      // index. wipKey-strict only — NO cross-wipKey fallback. Previously
      // a `byDept.get("*")` fallback returned "any wipKey" JC on this PO
      // when no exact wipKey match existed, which leaked HEADBOARD's
      // FOAM JC into DIVAN rows' FOAM column (DIVAN has no FOAM JC in
      // its wipKey, so the fallback picked HB's FOAM date and showed it
      // in the wrong row). Reported by Wei Siang 2026-04-30. Now an
      // empty cell appears when this row's wipKey doesn't include the
      // queried dept — accurate to the BOM.
      const picker = (code: string): JobCard | null => {
        const byDept = poDeptIndex?.get(code);
        if (byDept && jc.wipKey) {
          const exact = byDept.get(jc.wipKey);
          if (exact) return exact;
        }
        // Option C FAB_CUT lookup: post-merge there's at most one FC JC
        // per PO (BF/ACC) or per merged (SO+baseModel+fabric) group
        // (SOFA). FAB_SEW (and other downstream) rows still have their
        // per-piece wipKey, which won't match the merged FC's wipKey,
        // so the strict per-wipKey lookup above misses. Restore the
        // "any FC on this PO" fallback ONLY for FAB_CUT — safe now
        // because per-piece FC JCs were collapsed into one.
        //
        // CRITICAL: do NOT bail on `if (!byDept) return null;` before
        // running the cross-PO scan. The merged-FC-on-anchor case (SOFA
        // sibling POs that have ZERO FC JCs of their own) needs the
        // cross-PO scan to walk the SO and find the anchor's FC, but
        // bailing on undefined byDept short-circuits before the scan
        // ever runs — the row would render "—" indefinitely.
        // Option-C-aware fallback. Two symmetric directions:
        //   (A) Looking UP at FAB_CUT from any non-FC row. The merged FC
        //       JC has a new wipKey schema that doesn't match per-piece
        //       downstream wipKeys, so the strict lookup above misses.
        //       Restore the "*" fallback ONLY for FAB_CUT — safe now
        //       because per-piece FC JCs were collapsed into one merged
        //       JC per group. If still missing on the same PO (SOFA
        //       case where FC lives on the anchor PO), scan sibling POs.
        //   (B) Looking DOWN at any dept from a FAB_CUT row. The FC row
        //       represents a merged group; per-piece downstream JCs
        //       (FAB_SEW / FRAME / etc.) on this PO have wipKeys that
        //       don't match the merged FC's wipKey. Allow "*" fallback
        //       for any dept so the FC row can surface downstream
        //       progress. For SOFA cross-PO merge, scan sibling POs of
        //       the same companySOId for that dept's JC.
        const lookingForFc = code === "FAB_CUT";
        const fromFcRow = jc.departmentCode === "FAB_CUT";
        if (lookingForFc || fromFcRow) {
          const samePoAny = byDept ? byDept.get("*") : undefined;
          if (samePoAny) return samePoAny;
          // Cross-PO scan for the merge group's siblings.
          //   SOFA  → group key is (parentDocId + baseModel + fabricCode);
          //           sibling POs span multiple modules of the same sofa.
          //   BF/ACC → group key is parentDocId itself.
          // CO-origin POs use companyCOId / consignmentOrderId — without
          // these in the fallback, every CO sofa sibling row rendered
          // FAB_CUT blank even though the anchor PO carried the merged
          // FC JC.
          const myGroupId =
            o.companySOId ||
            o.salesOrderId ||
            o.companyCOId ||
            o.consignmentOrderId ||
            "";
          if (myGroupId) {
            const isSofa = o.itemCategory === "SOFA";
            const myBase = (o.productCode || "").split("-")[0];
            const myFabric = o.fabricCode || "";
            // O(1) groupId lookup against the pre-indexed map at the top
            // of this function — no more O(N_filteredOrders) scan per call.
            // Group key recipe is duplicated in the index builder; keep
            // them in lockstep.
            const sibs = ordersByGroup.get(myGroupId);
            if (sibs) {
              for (const sib of sibs) {
                if (sib.id === o.id) continue;
                // SOFA must also match baseModel + fabric since multiple
                // sofa products can coexist in one parent doc.
                if (isSofa) {
                  if ((sib.fabricCode || "") !== myFabric) continue;
                  const sibBase = (sib.productCode || "").split("-")[0];
                  if (sibBase !== myBase) continue;
                }
                const sibJc = sib.jobCards.find(
                  (j) => j.departmentCode === code,
                );
                if (sibJc) return sibJc;
              }
            }
          }
        }
        return null;
      };

      // Pass the full PO JC list to buildSched — it filters siblings by
      // each CARD's own wipKey, so a per-column DeptSched only sees
      // wipKey-matching JCs. Pre-filtering by the row's wipKey here was
      // the source of the cross-chain false-positive lock (Wood Cut DONE
      // locking Fab Cut on the same row).
      const poJobCards: JobCard[] = o.jobCards;

      rows.push({
        id: `${o.id}:${jc.id}`,
        poId: o.id,
        jobCardId: jc.id,
        rowNo: n++,
        // SO ID display rule (sofa drops -NN suffix, BF/ACC keep it):
        //   SOFA   → parent SO (companySOId, e.g. SO-2604-293) because a
        //           sofa set spans multiple variant-POs and no single
        //           -01/-02 suffix belongs to the whole set. Multiple
        //           sofa rows from the same SO will display the same SO
        //           ID — operators distinguish by product / variant /
        //           fabric columns.
        //   BF/ACC → line-suffixed poNo (e.g. SO-2604-293-01) because
        //           qty>1 already fans out into per-piece POs and the
        //           suffix genuinely identifies one physical piece.
        // Applies to every dept tab — soId is computed once at row
        // construction and consumed by all dept render paths uniformly.
        //
        // CO-origin POs (migration 0064): companySOId is empty and the
        // parent doc id lives on companyCOId. Fall back so SOFA rows
        // from a CO display CO-YYMM-NNN instead of a blank cell. The
        // BF/ACC branch already works because o.poNo is line-suffixed
        // for both SO and CO POs (CO-2604-001-01 etc.).
        soId: (o.itemCategory === "SOFA"
                ? (o.companySOId || o.companyCOId)
                : o.poNo) || "",
        salesOrderNo: o.companySOId || o.companyCOId || "",   // parent doc (SO or CO), not unique per line
        salesOrderId: o.salesOrderId || "",
        consignmentOrderId: o.consignmentOrderId || "",
        customerPOId: o.customerPOId || "",
        customerRef: o.customerReference || "",
        customerSO: o.customerSO || "",
        customerName: o.customerName || "",
        customerState: o.customerState || "",
        // Model column display rule: sofa drops the variant suffix
        // ("5531-2A(LHF)" → "5531") because the merged FAB_CUT row joins
        // multiple variants into the WIP column already, and a Model
        // value of just "5531" matches how Wei Siang refers to sofas
        // ("5531/5535/..." base). BF/ACC keep the full productCode
        // (e.g. "1013-(Q)") since the variant IS the model identity.
        model: o.itemCategory === "SOFA"
          ? (o.productCode || "").split("-")[0]
          : (o.productCode || ""),
        productCode: o.productCode || "",
        // Compartment id — links a piece's FAB_SEW & UPHOLSTERY job cards (they
        // share a wipKey, differ only by departmentCode). Carried onto the row
        // so the per-compartment shared Sew/Uph sticker can encode it (wk=) and
        // the scanner completes just that piece, not the whole order.
        wipKey: jc.wipKey || "",
        wip: jc.wipLabel || jc.wipCode || (() => {
          // Derive WIP code from PO data when job card doesn't carry it
          if (o.itemCategory === "BEDFRAME") {
            const totalH = (o.gapInches ?? 0) + (o.divanHeightInches ?? 0) + (o.legHeightInches ?? 0);
            // Divan-producing depts
            if (["WOOD_CUT", "FRAMING", "WEBBING"].includes(jc.departmentCode) && o.divanHeightInches) {
              return `${o.divanHeightInches}" Divan-${o.sizeLabel || o.sizeCode || ""}`;
            }
            // HB-producing depts
            if (["FAB_CUT", "FAB_SEW", "FOAM_CUTTING", "FOAM", "UPHOLSTERY", "PACKING"].includes(jc.departmentCode) && totalH > 0) {
              return `${o.productCode}-HB${totalH}"`;
            }
          }
          if (o.itemCategory === "SOFA") {
            return o.productCode || "";
          }
          return "";
        })(),
        // Category: BEDFRAME / SOFA / ACCESSORY from the PO (mirrors the
        // SO item category). Shown in its own toggleable column.
        category: o.itemCategory || "",
        // wipType short label — aligned with inventory WIP page enum:
        //   HB, DIVAN, BASE, CUSHION, ARMREST, HEADREST
        // so the Production "Type" filter can line up with the inventory
        // stock filter labels.
        wipType: (() => {
          const t = (jc.wipType || "").toUpperCase();
          if (t === "HEADBOARD") return "HB";
          if (t === "SOFA_BASE") return "BASE";
          if (t === "SOFA_CUSHION") return "CUSHION";
          if (t === "SOFA_ARMREST") return "ARMREST";
          if (t === "SOFA_HEADREST") return "HEADREST";
          if (t === "DIVAN") return "DIVAN";
          if (t) return t;
          // Derive from dept + category when not set
          if (o.itemCategory === "BEDFRAME") {
            if (["WOOD_CUT", "FRAMING", "WEBBING"].includes(jc.departmentCode) && o.divanHeightInches) return "DIVAN";
            return "HB";
          }
          if (o.itemCategory === "SOFA") {
            if (o.sizeCode?.includes("A")) return "BASE";
            return "CUSHION";
          }
          return "";
        })(),
        size: o.sizeLabel || "",
        colour: o.fabricCode || "",
        // Gap / Divan / Total H are bedframe-only concepts — sofas don't
        // have them. Force empty on sofa / accessory even if DB has a
        // stray value (legacy data may have misfiled seat size into the
        // divan column). Leg is kept because sofa does have optional leg
        // heights via maintenance config.
        gap: o.itemCategory === "BEDFRAME" && o.gapInches != null ? `${o.gapInches}"` : "",
        divan: o.itemCategory === "BEDFRAME" && o.divanHeightInches != null ? `${o.divanHeightInches}"` : "",
        leg: o.legHeightInches != null ? `${o.legHeightInches}"` : "",
        // Total height = gap + divan + leg, only meaningful for bedframes.
        // Sofa TotalH would just mirror Leg so it's intentionally blank.
        totalHeight: (() => {
          if (o.itemCategory !== "BEDFRAME") return "";
          const g = o.gapInches ?? 0;
          const d = o.divanHeightInches ?? 0;
          const l = o.legHeightInches ?? 0;
          const sum = g + d + l;
          return sum > 0 ? `${sum}"` : "";
        })(),
        // Qty = the ORDER quantity. Every production row is its own
        // SO line (`SO-XXXX-01/-02/…`), so this is 1. Previously this
        // was bound to job_cards.wipQty (the cutting-recipe piece /
        // fabric-panel count) which made single-item sofa / divan rows
        // display 2/3/4/6 — see BUG-2026-06-01-001. The piece count now
        // lives in its own `piecesToCut` field below.
        qty: o.quantity ?? 0,
        // Pieces to cut for this WIP — the cutting-recipe panel / piece
        // count (job_cards.wipQty). Drives the new "Pieces" grid column
        // and every piece-count consumer (sticker fan-out, sticker-count
        // badge, the merged cutting-schedule print total). NOT the order
        // quantity.
        piecesToCut: (jc as JobCard & { wipQty?: number }).wipQty ?? o.quantity ?? 0,
        specialOrder: o.specialOrder || "",
        // Per-jc production time (minutes), TOTAL = per-unit × wipQty so the
        // sheet column shows hours of work, not per-piece. Populated on every
        // dept sheet — the FAB_CUT merge step below aggregates this across
        // merged children so the collapsed row reports a sum, matching what
        // the sticker prints. FAB_CUT stores the per-SET total already (wipQty =
        // piece count), so jcMinutesTotal does NOT re-multiply it — see helper.
        prodTime: jcMinutesTotal(
          (jc.productionTimeMinutes || jc.estMinutes || 0) as number,
          jc,
        ),
        rack: (jc as JobCard & { rackingNumber?: string }).rackingNumber || "",
        dueDate: jc.dueDate || "",
        // Planning aids (2026-05-28) — from the parent SO via attachCustomerSO.
        customerDeliveryDate:
          (o as { customerDeliveryDate?: string }).customerDeliveryDate || "",
        hookkaExpectedDD:
          (o as { hookkaExpectedDD?: string }).hookkaExpectedDD || "",
        completedDate: jc.completedDate || "",
        // Surface per-piece progress so renderCompletionCell can show
        // "X/Y" when a multi-piece JC is partially scanned. Floor
        // piecesTotal at max(1, wipQty) to mirror the API contract;
        // piecesDone defaults to 0 so single-piece JCs / payloads
        // without the new fields don't trip the partial-render branch.
        piecesTotal: Math.max(1, jc.piecesTotal ?? jc.wipQty ?? 1),
        piecesDone: jc.piecesDone ?? 0,
        // ISO timestamp the operator clicked the "Sent" tick. NULL =
        // not yet handed out; truthy = printed + given to the floor.
        distributedAt: jc.distributedAt ?? null,
        sent: jc.distributedAt ? "Yes" : "No",
        // Predicted fabric meters for FAB_CUT JCs, computed server-side
        // from bom_templates (see rowToMinimalJobCard in
        // production-orders.ts). 0 / undefined for non-FC depts —
        // surfaces as "—" in the dept sheet's Fabric Usage column.
        fabricUsage:
          (jc as JobCard & { fabricUsageMeters?: number })
            .fabricUsageMeters ?? 0,
        pic1: jc.pic1Name || "",
        pic2: jc.pic2Name || "",
        status: jc.status || "",
        poStatus: o.status || "",
        // ON HOLD reason (0185) — from the parent SO / CO (attachCustomerSO).
        holdReason: o.holdReason || "",
        heldBy: o.heldBy || "",
        heldAt: o.heldAt || "",
        // Sofa PACKING merge case: jc.wipKey === "FG" means this row IS
        // the merged Packing JC (sofa's 3 component branches —
        // Base / Cushion / Armrest — collapse here). Upstream depts
        // still have per-component JCs in this PO with non-"FG"
        // wipKeys. The picker would scope by jc.wipKey="FG" → no
        // match → fall back to most-recent-due card, which is
        // semantically wrong for a merge view. Use per-dept aggregate
        // across ALL JCs in that dept on this PO instead.  Bedframe
        // PACKING JCs use wipKeys like `1007-(K)::0::DIVAN::...` (not
        // "FG"), so this branch leaves the existing picker path alone
        // for bedframes — only the sofa Packing merge row aggregates.
        ...(jc.wipKey === "FG"
          ? {
              sched_FAB_CUT:    buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "FAB_CUT"),    today, o.id),
              sched_FAB_SEW:    buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "FAB_SEW"),    today, o.id),
              sched_FOAM:       buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "FOAM"),       today, o.id),
              sched_FOAM_CUTTING: buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "FOAM_CUTTING"), today, o.id),
              sched_WOOD_CUT:   buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "WOOD_CUT"),   today, o.id),
              sched_FRAMING:    buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "FRAMING"),    today, o.id),
              sched_WEBBING:    buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "WEBBING"),    today, o.id),
              sched_UPHOLSTERY: buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "UPHOLSTERY"), today, o.id),
              sched_PACKING:    buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "PACKING"),    today, o.id),
            }
          : {
              sched_FAB_CUT:    buildSched(picker("FAB_CUT"),    today, o.id, poJobCards),
              sched_FAB_SEW:    buildSched(picker("FAB_SEW"),    today, o.id, poJobCards),
              sched_FOAM:       buildSched(picker("FOAM"),       today, o.id, poJobCards),
              sched_FOAM_CUTTING: buildSched(picker("FOAM_CUTTING"), today, o.id, poJobCards),
              sched_WOOD_CUT:   buildSched(picker("WOOD_CUT"),   today, o.id, poJobCards),
              sched_FRAMING:    buildSched(picker("FRAMING"),    today, o.id, poJobCards),
              sched_WEBBING:    buildSched(picker("WEBBING"),    today, o.id, poJobCards),
              sched_UPHOLSTERY: buildSched(picker("UPHOLSTERY"), today, o.id, poJobCards),
              sched_PACKING:    buildSched(picker("PACKING"),    today, o.id, poJobCards),
            }),
        _deptCode: jc.departmentCode,
      });
    }
  }
  return rows;
};
