// ---------------------------------------------------------------------------
// delivery-pipeline.test.mjs — unit tests for src/lib/delivery-pipeline.ts.
//
// This module is the single source of truth for the Delivery page's
// Planning / Pending Delivery classification. The dashboard's "Pending
// Delivery" card and the Delivery page both import these predicates so
// their numbers agree (they previously drifted: RM 25,218 vs RM 50,793).
//
// Predicates under test:
//   isHbOnlySpecial(specialOrder)        — substring "headboard only" (ci)
//   pickRelevantUphCards(po)             — UPHOLSTERY cards, dropping DIVAN
//                                          for BEDFRAME + HB-only POs
//   poInPlanning(po)                     — PO still in production
//   poReadyForDelivery(po, linkedPOIds)  — production done, not yet on a DO
//   buildLinkedPOIds(deliveryOrders)     — PO ids carried on a live DO
//
// Each predicate's true/false branches are exercised individually.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it on Node 22+.
}

let dp;
try {
  dp = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/delivery-pipeline.ts")).href
  );
} catch (err) {
  console.warn(
    "[delivery-pipeline.test] Could not import module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[delivery-pipeline.test] Error:", err?.message ?? err);
  throw err;
}

// Factory for a PipelinePO with sensible "in planning" defaults — one
// not-yet-done UPHOLSTERY card, SOFA, no CO link, no special order.
function po(overrides = {}) {
  return {
    id: overrides.id ?? "pord-01",
    status: overrides.status ?? "IN_PROGRESS",
    consignmentOrderId: overrides.consignmentOrderId,
    itemCategory: overrides.itemCategory ?? "SOFA",
    specialOrder: overrides.specialOrder,
    jobCards:
      overrides.jobCards ??
      [{ departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" }],
  };
}

// ---------------------------------------------------------------------------
// isHbOnlySpecial — case-insensitive substring "headboard only".
// ---------------------------------------------------------------------------
test("isHbOnlySpecial: exact 'Headboard Only' -> true", () => {
  assert.equal(dp.isHbOnlySpecial("Headboard Only"), true);
});

test("isHbOnlySpecial: case-insensitive — 'HEADBOARD ONLY' -> true", () => {
  assert.equal(dp.isHbOnlySpecial("HEADBOARD ONLY"), true);
});

test("isHbOnlySpecial: matches as a substring inside a longer note", () => {
  assert.equal(dp.isHbOnlySpecial("Customer wants headboard only this time"), true);
});

test("isHbOnlySpecial: unrelated special-order text -> false", () => {
  assert.equal(dp.isHbOnlySpecial("Rush order"), false);
});

test("isHbOnlySpecial: null -> false", () => {
  assert.equal(dp.isHbOnlySpecial(null), false);
});

test("isHbOnlySpecial: undefined -> false", () => {
  assert.equal(dp.isHbOnlySpecial(undefined), false);
});

test("isHbOnlySpecial: empty string -> false", () => {
  assert.equal(dp.isHbOnlySpecial(""), false);
});

// ---------------------------------------------------------------------------
// pickRelevantUphCards — UPHOLSTERY cards only; for BEDFRAME + HB-only POs,
// drop the stranded DIVAN cards.
// ---------------------------------------------------------------------------
test("pickRelevantUphCards: returns only UPHOLSTERY cards, filtering other depts", () => {
  const cards = dp.pickRelevantUphCards(
    po({
      jobCards: [
        { departmentCode: "FAB_CUT", status: "COMPLETED" },
        { departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" },
        { departmentCode: "PACKING", status: "PENDING" },
      ],
    }),
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].departmentCode, "UPHOLSTERY");
});

test("pickRelevantUphCards: non-BEDFRAME keeps DIVAN upholstery cards", () => {
  // Drop-DIVAN rule only fires for BEDFRAME + HB-only. A SOFA keeps them.
  const cards = dp.pickRelevantUphCards(
    po({
      itemCategory: "SOFA",
      specialOrder: "Headboard Only",
      jobCards: [
        { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "DIVAN" },
        { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "HEADBOARD" },
      ],
    }),
  );
  assert.equal(cards.length, 2);
});

test("pickRelevantUphCards: BEDFRAME + HB-only drops DIVAN upholstery cards", () => {
  const cards = dp.pickRelevantUphCards(
    po({
      itemCategory: "BEDFRAME",
      specialOrder: "Headboard Only",
      jobCards: [
        { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "DIVAN" },
        { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "HEADBOARD" },
      ],
    }),
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].wipType, "HEADBOARD");
});

test("pickRelevantUphCards: BEDFRAME without HB-only keeps DIVAN cards", () => {
  const cards = dp.pickRelevantUphCards(
    po({
      itemCategory: "BEDFRAME",
      specialOrder: undefined,
      jobCards: [
        { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "DIVAN" },
        { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "HEADBOARD" },
      ],
    }),
  );
  assert.equal(cards.length, 2);
});

test("pickRelevantUphCards: itemCategory match is case-insensitive ('bedframe')", () => {
  const cards = dp.pickRelevantUphCards(
    po({
      itemCategory: "bedframe",
      specialOrder: "headboard only",
      jobCards: [
        { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "divan" },
        { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "HEADBOARD" },
      ],
    }),
  );
  // wipType comparison is also uppercased — lowercase "divan" still dropped.
  assert.equal(cards.length, 1);
  assert.equal(cards[0].wipType, "HEADBOARD");
});

test("pickRelevantUphCards: missing jobCards array yields empty list", () => {
  const cards = dp.pickRelevantUphCards({ id: "x", status: "IN_PROGRESS" });
  assert.equal(cards.length, 0);
});

// ---------------------------------------------------------------------------
// poInPlanning — PO still in production: has upholstery cards, at least one
// not COMPLETED/TRANSFERRED, not CANCELLED/COMPLETED, not CO-sourced.
// ---------------------------------------------------------------------------
test("poInPlanning: in-progress upholstery card -> true", () => {
  assert.equal(dp.poInPlanning(po()), true);
});

test("poInPlanning: COMPLETED PO status -> false", () => {
  assert.equal(dp.poInPlanning(po({ status: "COMPLETED" })), false);
});

test("poInPlanning: CANCELLED PO status -> false", () => {
  assert.equal(dp.poInPlanning(po({ status: "CANCELLED" })), false);
});

test("poInPlanning: CO-sourced PO (consignmentOrderId set) -> false", () => {
  assert.equal(dp.poInPlanning(po({ consignmentOrderId: "co-99" })), false);
});

test("poInPlanning: no upholstery cards at all -> false", () => {
  assert.equal(
    dp.poInPlanning(
      po({ jobCards: [{ departmentCode: "FAB_CUT", status: "IN_PROGRESS" }] }),
    ),
    false,
  );
});

test("poInPlanning: all upholstery cards COMPLETED -> false (production done)", () => {
  assert.equal(
    dp.poInPlanning(
      po({ jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] }),
    ),
    false,
  );
});

test("poInPlanning: TRANSFERRED counts as done — all TRANSFERRED -> false", () => {
  assert.equal(
    dp.poInPlanning(
      po({
        jobCards: [{ departmentCode: "UPHOLSTERY", status: "TRANSFERRED" }],
      }),
    ),
    false,
  );
});

test("poInPlanning: one done + one in-progress upholstery card -> true", () => {
  // "some" not yet done -> still in planning.
  assert.equal(
    dp.poInPlanning(
      po({
        jobCards: [
          { departmentCode: "UPHOLSTERY", status: "COMPLETED" },
          { departmentCode: "UPHOLSTERY", status: "PENDING" },
        ],
      }),
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// poReadyForDelivery — production complete (all upholstery done), not
// CANCELLED, not CO-sourced, not already on a DO.
// ---------------------------------------------------------------------------
const EMPTY_LINKED = new Set();

test("poReadyForDelivery: all upholstery COMPLETED, not on a DO -> true", () => {
  assert.equal(
    dp.poReadyForDelivery(
      po({ jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] }),
      EMPTY_LINKED,
    ),
    true,
  );
});

test("poReadyForDelivery: all upholstery TRANSFERRED counts as ready -> true", () => {
  assert.equal(
    dp.poReadyForDelivery(
      po({ jobCards: [{ departmentCode: "UPHOLSTERY", status: "TRANSFERRED" }] }),
      EMPTY_LINKED,
    ),
    true,
  );
});

test("poReadyForDelivery: a not-yet-done upholstery card -> false", () => {
  assert.equal(
    dp.poReadyForDelivery(
      po({
        jobCards: [
          { departmentCode: "UPHOLSTERY", status: "COMPLETED" },
          { departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" },
        ],
      }),
      EMPTY_LINKED,
    ),
    false,
  );
});

test("poReadyForDelivery: CANCELLED PO -> false", () => {
  assert.equal(
    dp.poReadyForDelivery(
      po({
        status: "CANCELLED",
        jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }],
      }),
      EMPTY_LINKED,
    ),
    false,
  );
});

test("poReadyForDelivery: COMPLETED PO status is still ready if cards done", () => {
  // poReadyForDelivery only excludes CANCELLED (not COMPLETED) — a
  // COMPLETED PO with all upholstery done still qualifies as ready.
  assert.equal(
    dp.poReadyForDelivery(
      po({
        status: "COMPLETED",
        jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }],
      }),
      EMPTY_LINKED,
    ),
    true,
  );
});

test("poReadyForDelivery: CO-sourced PO -> false", () => {
  assert.equal(
    dp.poReadyForDelivery(
      po({
        consignmentOrderId: "co-7",
        jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }],
      }),
      EMPTY_LINKED,
    ),
    false,
  );
});

test("poReadyForDelivery: PO already on a DO (in linkedPOIds) -> false", () => {
  assert.equal(
    dp.poReadyForDelivery(
      po({
        id: "pord-99",
        jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }],
      }),
      new Set(["pord-99"]),
    ),
    false,
  );
});

test("poReadyForDelivery: no upholstery cards, NOT yet COMPLETED -> false", () => {
  // Default status here is IN_PROGRESS — a non-upholstered route only becomes
  // ready once the PO itself flips to COMPLETED (see accessory tests below).
  assert.equal(
    dp.poReadyForDelivery(
      po({ jobCards: [{ departmentCode: "PACKING", status: "COMPLETED" }] }),
      EMPTY_LINKED,
    ),
    false,
  );
});

test("poReadyForDelivery: COMPLETED accessory (no upholstery, all cards done) -> true", () => {
  // ACCESSORY pillows / cushions finish via FAB_CUT -> FAB_SEW -> PACKING and
  // never get an UPHOLSTERY card. A COMPLETED PO with every card done is ready
  // to ship (BUG-2026-06-20-001: these used to be stuck out of Pending Delivery).
  assert.equal(
    dp.poReadyForDelivery(
      po({
        status: "COMPLETED",
        itemCategory: "ACCESSORY",
        jobCards: [
          { departmentCode: "FAB_CUT", status: "COMPLETED" },
          { departmentCode: "FAB_SEW", status: "COMPLETED" },
          { departmentCode: "PACKING", status: "COMPLETED" },
        ],
      }),
      EMPTY_LINKED,
    ),
    true,
  );
});

test("poReadyForDelivery: in-progress accessory (no upholstery, a card pending) -> false", () => {
  // Not COMPLETED yet -> stays excluded so half-made accessories can't ship.
  assert.equal(
    dp.poReadyForDelivery(
      po({
        status: "IN_PROGRESS",
        itemCategory: "ACCESSORY",
        jobCards: [
          { departmentCode: "FAB_CUT", status: "COMPLETED" },
          { departmentCode: "PACKING", status: "PENDING" },
        ],
      }),
      EMPTY_LINKED,
    ),
    false,
  );
});

test("poReadyForDelivery: BEDFRAME HB-only — stranded DIVAN card ignored, HB done -> true", () => {
  // The DIVAN card never completes for an HB-only BF PO. pickRelevantUphCards
  // drops it, so a packed headboard qualifies the row as ready.
  assert.equal(
    dp.poReadyForDelivery(
      po({
        itemCategory: "BEDFRAME",
        specialOrder: "Headboard Only",
        jobCards: [
          { departmentCode: "UPHOLSTERY", status: "PENDING", wipType: "DIVAN" },
          { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "HEADBOARD" },
        ],
      }),
      EMPTY_LINKED,
    ),
    true,
  );
});

// poInPlanning + poReadyForDelivery should be mutually exclusive for the
// same PO — a PO is either still in production or done, never both.
test("poInPlanning and poReadyForDelivery are mutually exclusive", () => {
  const inProd = po({
    jobCards: [{ departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" }],
  });
  assert.equal(dp.poInPlanning(inProd), true);
  assert.equal(dp.poReadyForDelivery(inProd, EMPTY_LINKED), false);

  const done = po({
    jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }],
  });
  assert.equal(dp.poInPlanning(done), false);
  assert.equal(dp.poReadyForDelivery(done, EMPTY_LINKED), true);
});

// ---------------------------------------------------------------------------
// buildLinkedPOIds — set of PO ids carried on a non-cancelled, non-virtual
// DO, built from delivery_order_items.
// ---------------------------------------------------------------------------
test("buildLinkedPOIds: collects productionOrderId from live DO items", () => {
  const set = dp.buildLinkedPOIds([
    {
      id: "do-1",
      status: "DELIVERED",
      items: [
        { productionOrderId: "pord-1" },
        { productionOrderId: "pord-2" },
      ],
    },
  ]);
  assert.equal(set.has("pord-1"), true);
  assert.equal(set.has("pord-2"), true);
  assert.equal(set.size, 2);
});

test("buildLinkedPOIds: CANCELLED DOs are skipped", () => {
  const set = dp.buildLinkedPOIds([
    { id: "do-1", status: "CANCELLED", items: [{ productionOrderId: "pord-1" }] },
  ]);
  assert.equal(set.has("pord-1"), false);
  assert.equal(set.size, 0);
});

test("buildLinkedPOIds: virtual DOs (id starts with 'virt-') are skipped", () => {
  const set = dp.buildLinkedPOIds([
    { id: "virt-abc", status: "DELIVERED", items: [{ productionOrderId: "pord-1" }] },
  ]);
  assert.equal(set.has("pord-1"), false);
});

test("buildLinkedPOIds: items with null productionOrderId are skipped", () => {
  const set = dp.buildLinkedPOIds([
    {
      id: "do-1",
      status: "DELIVERED",
      items: [
        { productionOrderId: null },
        { productionOrderId: "pord-5" },
      ],
    },
  ]);
  assert.equal(set.has("pord-5"), true);
  assert.equal(set.size, 1);
});

test("buildLinkedPOIds: DO with missing items array doesn't crash", () => {
  const set = dp.buildLinkedPOIds([{ id: "do-1", status: "DELIVERED" }]);
  assert.equal(set.size, 0);
});

test("buildLinkedPOIds: empty input -> empty set", () => {
  assert.equal(dp.buildLinkedPOIds([]).size, 0);
});

test("buildLinkedPOIds: dedupes a PO id appearing on two DOs", () => {
  const set = dp.buildLinkedPOIds([
    { id: "do-1", status: "DELIVERED", items: [{ productionOrderId: "pord-1" }] },
    { id: "do-2", status: "PENDING", items: [{ productionOrderId: "pord-1" }] },
  ]);
  assert.equal(set.size, 1);
  assert.equal(set.has("pord-1"), true);
});

// ---------------------------------------------------------------------------
// poReadyForConsignment(po, linkedPOIds) — CO mirror. Same upholstery gate as
// delivery + the accessory/pillow no-UPHOLSTERY fallback (BUG-2026-07-01-003:
// completed LONG PILLOW on CO-2606-003-01 was hard-dropped by the old inline
// filter). Requires a consignmentOrderId (SO-origin POs belong to Delivery).
// ---------------------------------------------------------------------------
const NONE = new Set();

test("poReadyForConsignment: SO-origin PO (no CO) -> false", () => {
  const p = po({ consignmentOrderId: undefined, jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] });
  assert.equal(dp.poReadyForConsignment(p, NONE), false);
});

test("poReadyForConsignment: CO sofa, all upholstery done -> true", () => {
  const p = po({ consignmentOrderId: "co-1", jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] });
  assert.equal(dp.poReadyForConsignment(p, NONE), true);
});

test("poReadyForConsignment: CO sofa, upholstery still in progress -> false", () => {
  const p = po({ consignmentOrderId: "co-1", jobCards: [{ departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" }] });
  assert.equal(dp.poReadyForConsignment(p, NONE), false);
});

test("poReadyForConsignment: COMPLETED accessory pillow, no UPHOLSTERY card -> true (the fix)", () => {
  const p = po({
    consignmentOrderId: "co-1",
    itemCategory: "ACCESSORY",
    status: "COMPLETED",
    jobCards: [
      { departmentCode: "FAB_CUT", status: "COMPLETED" },
      { departmentCode: "FAB_SEW", status: "COMPLETED" },
      { departmentCode: "PACKING", status: "COMPLETED" },
    ],
  });
  assert.equal(dp.poReadyForConsignment(p, NONE), true);
});

test("poReadyForConsignment: accessory pillow NOT yet complete (packing pending) -> false", () => {
  const p = po({
    consignmentOrderId: "co-1",
    itemCategory: "ACCESSORY",
    status: "IN_PRODUCTION",
    jobCards: [
      { departmentCode: "FAB_CUT", status: "COMPLETED" },
      { departmentCode: "FAB_SEW", status: "COMPLETED" },
      { departmentCode: "PACKING", status: "IN_PROGRESS" },
    ],
  });
  assert.equal(dp.poReadyForConsignment(p, NONE), false);
});

test("poReadyForConsignment: already linked to a CN -> false", () => {
  const p = po({ id: "pord-x", consignmentOrderId: "co-1", jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] });
  assert.equal(dp.poReadyForConsignment(p, new Set(["pord-x"])), false);
});

test("poReadyForConsignment: CANCELLED -> false", () => {
  const p = po({ consignmentOrderId: "co-1", status: "CANCELLED", jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] });
  assert.equal(dp.poReadyForConsignment(p, NONE), false);
});

test("poReadyForConsignment: ON_HOLD CO-PO with cards done -> false (parity with Delivery)", () => {
  // A held CO-PO is paused work — must NOT surface as ready-to-consign even if
  // its cards completed before the hold. DO excluded ON_HOLD; CN had drifted.
  const p = po({ consignmentOrderId: "co-1", status: "ON_HOLD", jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] });
  assert.equal(dp.poReadyForConsignment(p, NONE), false);
});

// ---------------------------------------------------------------------------
// poInPlanningConsignment — CO mirror of poInPlanning. Requires a CO link;
// shares pickRelevantUphCards + the scoped-repair fallback so it can't drift
// from the ready gate (the CN Planning tab had a hand-inlined raw filter).
// ---------------------------------------------------------------------------
test("poInPlanningConsignment: CO sofa, upholstery in progress -> true", () => {
  const p = po({ consignmentOrderId: "co-1", jobCards: [{ departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" }] });
  assert.equal(dp.poInPlanningConsignment(p), true);
});

test("poInPlanningConsignment: SO-origin PO (no CO) -> false", () => {
  const p = po({ consignmentOrderId: undefined, jobCards: [{ departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" }] });
  assert.equal(dp.poInPlanningConsignment(p), false);
});

test("poInPlanningConsignment: CO sofa, all upholstery done -> false (production done)", () => {
  const p = po({ consignmentOrderId: "co-1", jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] });
  assert.equal(dp.poInPlanningConsignment(p), false);
});

test("poInPlanningConsignment: CO COMPLETED/CANCELLED -> false", () => {
  const done = po({ consignmentOrderId: "co-1", status: "COMPLETED", jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] });
  assert.equal(dp.poInPlanningConsignment(done), false);
  const cancelled = po({ consignmentOrderId: "co-1", status: "CANCELLED", jobCards: [{ departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" }] });
  assert.equal(dp.poInPlanningConsignment(cancelled), false);
});

test("poInPlanningConsignment: BEDFRAME HB-only — stranded DIVAN in progress ignored, HB done -> false", () => {
  // pickRelevantUphCards drops the never-completing DIVAN card, so an HB-only
  // CO-BF whose headboard is done is NOT still in planning (the raw inline
  // filter would have kept waiting on the DIVAN card forever).
  const p = po({
    consignmentOrderId: "co-1",
    itemCategory: "BEDFRAME",
    specialOrder: "Headboard Only",
    jobCards: [
      { departmentCode: "UPHOLSTERY", status: "IN_PROGRESS", wipType: "DIVAN" },
      { departmentCode: "UPHOLSTERY", status: "COMPLETED", wipType: "HEADBOARD" },
    ],
  });
  assert.equal(dp.poInPlanningConsignment(p), false);
});

// ---------------------------------------------------------------------------
// buildCnReadyPlanning — the shared CN Planning/Pending-CN row builder used by
// BOTH note.tsx and GET /api/consignment-notes/ready-planning. Guards against
// the two surfaces drifting: the endpoint's rows must equal what the page would
// have computed client-side (verified live 2026-07-14; this locks it in).
// ---------------------------------------------------------------------------
function cnPo(overrides = {}) {
  return {
    id: overrides.id ?? "pord-cn",
    poNo: overrides.poNo ?? "PO-CN-1",
    status: overrides.status ?? "IN_PROGRESS",
    consignmentOrderId:
      "consignmentOrderId" in overrides ? overrides.consignmentOrderId : "co-1",
    companyCOId: overrides.companyCOId ?? "",
    customerId: overrides.customerId,
    customerName: overrides.customerName ?? "Houzs",
    customerState: overrides.customerState ?? "KL",
    productCode: overrides.productCode ?? "P1",
    itemCategory: overrides.itemCategory ?? "SOFA",
    quantity: overrides.quantity ?? 1,
    targetEndDate: overrides.targetEndDate ?? "2026-07-06",
    jobCards:
      overrides.jobCards ??
      [{ departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" }],
  };
}

test("buildCnReadyPlanning: splits Planning (in production) vs Pending CN (done, not consigned)", () => {
  const inProd = cnPo({ id: "a", jobCards: [{ departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" }] });
  const doneReady = cnPo({ id: "b", productCode: "P2", jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED", completedDate: "2026-07-05" }] });
  const doneConsigned = cnPo({ id: "c", jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] });
  const soOrigin = cnPo({ id: "d", consignmentOrderId: undefined, jobCards: [{ departmentCode: "UPHOLSTERY", status: "IN_PROGRESS" }] });

  const out = dp.buildCnReadyPlanning({
    allPOs: [inProd, doneReady, doneConsigned, soOrigin],
    coMap: new Map([["co-1", { hookkaExpectedDD: "2026-07-10", companyCOId: "CO-2607-002", customerId: "cust-9" }]]),
    cnLinkedPOIds: new Set(["c"]), // 'c' already on a CN → excluded from ready
    cnLinkedCustomersLegacy: new Set(),
    productM3Map: new Map([["P2", 1.5]]),
  });

  assert.deepEqual(out.planning.map((r) => r.id), ["a"]); // SO-origin 'd' excluded
  assert.deepEqual(out.ready.map((r) => r.id), ["b"]);    // 'c' deduped out
  const b = out.ready[0];
  assert.equal(b.consignmentOrderNo, "CO-2607-002"); // from coMap fallback
  assert.equal(b.customerId, "cust-9");              // po.customerId absent → coMap
  assert.equal(b.hookkaExpectedDD, "2026-07-10");    // coMap wins over targetEndDate
  assert.equal(b.unitM3, 1.5);                       // productM3Map
  assert.equal(b.uphCompletedDate, "2026-07-05");    // latest UPH completedDate
});

test("buildCnReadyPlanning: legacy-customer dedup hides an otherwise-ready PO", () => {
  const done = cnPo({ id: "e", customerId: "legacy-cust", jobCards: [{ departmentCode: "UPHOLSTERY", status: "COMPLETED" }] });
  const out = dp.buildCnReadyPlanning({
    allPOs: [done],
    coMap: new Map(),
    cnLinkedPOIds: new Set(),
    cnLinkedCustomersLegacy: new Set(["legacy-cust"]),
    productM3Map: new Map(),
  });
  assert.deepEqual(out.ready.map((r) => r.id), []); // hidden by legacy-customer dedup
});
