// ---------------------------------------------------------------------------
// cn-packing-list-record.test.mjs — behavioral tests for the SAVED CN packing
// list system (src/api/routes/cn-packing-lists.ts), the consignment twin of
// the DO packing_lists. Distinct from cn-packing-list.test.mjs, which pins the
// throwaway consolidated PRINT — this file covers the persisted
// cn_packing_lists record: create, the at-most-one-list rule, and the totals
// tally (units / M³ / revenue reconcile with the member CNs).
//
// Both functions run against a small mock D1 that pattern-matches the SELECTs
// the route issues (same mock-DB approach as cn-value.test.mjs). Assertions
// are on the resolved numbers + the conflict behaviour, not query-string
// formatting.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const { computeCnPackingListMoney, createCnPackingListCore } = await import(
  pathToFileURL(
    resolve(process.cwd(), "src/api/routes/cn-packing-lists.ts"),
  ).href
);

// ---------------------------------------------------------------------------
// Mock D1. Seed mirrors the real (camelCase) columns. A single dispatcher
// recognises every table the two functions touch:
//   consignment_notes        { id, hubId, status, consignmentOrderId, noteNumber }
//   consignment_items        { consignmentNoteId, productionOrderId, productCode, quantity }
//   consignment_order_items  { consignmentOrderId, productCode, unitPriceSen }
//   production_orders        { id, consignmentOrderId }
//   products                 { code, unitM3 }
//   delivery_hubs            { id, address, state }
//   cn_packing_lists         existing rows (for the at-most-one scan) + INSERT sink
// ---------------------------------------------------------------------------
function makeDb(seed) {
  const inserted = [];
  function prepare(rawSql) {
    const s = rawSql.trim().replace(/\s+/g, " ");
    let bound = [];
    const stmt = {
      bind(...args) {
        bound = args;
        return this;
      },
      async all() {
        if (/FROM consignment_order_items/i.test(s)) {
          return {
            results: (seed.coItems ?? []).map((r) => ({
              consignmentOrderId: r.consignmentOrderId,
              productCode: r.productCode,
              unitPriceSen: r.unitPriceSen,
            })),
          };
        }
        if (/FROM production_orders/i.test(s)) {
          return {
            results: (seed.productionOrders ?? [])
              .filter((p) => p.consignmentOrderId != null)
              .map((p) => ({ id: p.id, consignmentOrderId: p.consignmentOrderId })),
          };
        }
        if (/FROM consignment_items/i.test(s)) {
          // Two shapes are issued: the value-map read (productionOrderId) and
          // the units/M³ read (productCode, quantity). Return the superset.
          return {
            results: (seed.cnItems ?? []).map((r) => ({
              consignmentNoteId: r.consignmentNoteId,
              productionOrderId: r.productionOrderId ?? null,
              productCode: r.productCode,
              quantity: r.quantity,
            })),
          };
        }
        if (/FROM consignment_notes/i.test(s)) {
          // loadCnValueMap reads (id, consignmentOrderId); the money computer
          // reads (id, hubId, status); the create core reads (id, noteNumber).
          // When the query is id-filtered (WHERE id IN (...) — the create
          // existence-check and the money read), honor the bound ids so a
          // non-existent id genuinely doesn't come back.
          let rows = seed.cns ?? [];
          if (/WHERE .*id IN \(/i.test(s)) {
            const ids = new Set(bound.filter((b) => typeof b === "string"));
            rows = rows.filter((r) => ids.has(r.id));
          }
          return {
            results: rows.map((r) => ({
              id: r.id,
              consignmentOrderId: r.consignmentOrderId ?? null,
              hubId: r.hubId ?? null,
              status: r.status ?? null,
              noteNumber: r.noteNumber ?? r.id,
            })),
          };
        }
        if (/FROM products/i.test(s)) {
          return {
            results: (seed.products ?? []).map((p) => ({
              code: p.code,
              unitM3: p.unitM3,
            })),
          };
        }
        if (/FROM delivery_hubs/i.test(s)) {
          return {
            results: (seed.hubs ?? []).map((h) => ({
              id: h.id,
              address: h.address ?? null,
              state: h.state ?? null,
            })),
          };
        }
        if (/FROM cn_packing_lists/i.test(s)) {
          // The at-most-one scan: SELECT packing_no, cn_ids ...
          return {
            results: (seed.existingLists ?? []).map((l) => ({
              packingNo: l.packingNo,
              cnIds: JSON.stringify(l.cnIds),
            })),
          };
        }
        return { results: [] };
      },
      async first() {
        // genNextPackingNo: highest existing CPL- number (none seeded → 001).
        if (/SELECT packing_no FROM cn_packing_lists/i.test(s)) {
          const nums = (seed.existingLists ?? [])
            .map((l) => l.packingNo)
            .filter((n) => /^CPL-/.test(n));
          if (nums.length === 0) return null;
          nums.sort();
          return { packingNo: nums[nums.length - 1] };
        }
        // The post-insert read-back: return the row we just inserted.
        if (/SELECT .* FROM cn_packing_lists WHERE id = \?/i.test(s)) {
          const id = bound[0];
          const row = inserted.find((r) => r.id === id);
          return row ?? null;
        }
        return null;
      },
      async run() {
        if (/INSERT INTO cn_packing_lists/i.test(s)) {
          // Column order matches the route's INSERT:
          // id, packing_no, status('OPEN' literal), cn_ids, stop_count,
          // total_units, total_m3, remarks, created_at, created_by, org_id
          const [
            id,
            packingNo,
            cnIds,
            stopCount,
            totalUnits,
            totalM3,
            remarks,
            createdAt,
            createdBy,
            orgId,
          ] = bound;
          inserted.push({
            id,
            packingNo,
            status: "OPEN",
            cnIds,
            stopCount,
            totalUnits,
            totalM3,
            remarks,
            createdAt,
            createdBy,
            orgId,
          });
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return stmt;
  }
  return { db: { prepare }, inserted };
}

// Minimal Hono-context stand-in for createCnPackingListCore: it only reads
// c.var.DB and passes c to emitAudit (which is best-effort + .catch()ed).
function makeCtx(db) {
  return {
    var: { DB: db },
    get: () => undefined,
    set: () => {},
    // emitAudit reads c.req.header(...) for IP/UA — stub it so the best-effort
    // audit emit doesn't throw (it's .catch()ed anyway, but keeps logs clean).
    req: { header: () => undefined },
  };
}

// ---------------------------------------------------------------------------
// Shared seed: TWO CNs on one truck run.
//   cn-1 → hub-A, CO-A: 2× SOFA1 @ 100000 sen, unitM3 0.5  ⇒ value 200000, units 2, m3 1.0
//   cn-2 → hub-B, CO-B: 1× BED1  @ 250000 sen, unitM3 1.2  ⇒ value 250000, units 1, m3 1.2
// PL totals must be the SUM: value 450000, units 3, m3 2.2; 2 distinct stops.
// ---------------------------------------------------------------------------
function twoCnSeed() {
  return {
    coItems: [
      { consignmentOrderId: "co-A", productCode: "SOFA1", unitPriceSen: 100000 },
      { consignmentOrderId: "co-B", productCode: "BED1", unitPriceSen: 250000 },
    ],
    productionOrders: [
      { id: "po-A", consignmentOrderId: "co-A" },
      { id: "po-B", consignmentOrderId: "co-B" },
    ],
    cns: [
      { id: "cn-1", consignmentOrderId: "co-A", hubId: "hub-A", status: "ACTIVE", noteNumber: "CGN-2606-001" },
      { id: "cn-2", consignmentOrderId: "co-B", hubId: "hub-B", status: "PARTIALLY_SOLD", noteNumber: "CGN-2606-002" },
    ],
    cnItems: [
      { consignmentNoteId: "cn-1", productionOrderId: "po-A", productCode: "SOFA1", quantity: 2 },
      { consignmentNoteId: "cn-2", productionOrderId: "po-B", productCode: "BED1", quantity: 1 },
    ],
    products: [
      { code: "SOFA1", unitM3: 0.5 },
      { code: "BED1", unitM3: 1.2 },
    ],
    hubs: [
      { id: "hub-A", address: "1 Jalan A, Shah Alam", state: "SGR" },
      { id: "hub-B", address: "2 Jalan B, Penang", state: "PNG" },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. TOTALS TALLY — the PL's units / M³ / revenue equal the sum of its CNs,
//    and revenue per CN matches loadCnValueMap (priced off the parent CO).
// ---------------------------------------------------------------------------
test("computeCnPackingListMoney: PL totals reconcile with the sum of member CNs", async () => {
  const { db } = makeDb(twoCnSeed());
  const money = await computeCnPackingListMoney(db, "hookka", [
    { id: "cpl-1", cnIds: ["cn-1", "cn-2"] },
  ]);
  const pl = money.get("cpl-1");
  assert.ok(pl, "money map must carry an entry for the PL");

  // Per-CN expectations (the parts that must SUM):
  //   cn-1: value 200000, units 2, m3 1.0
  //   cn-2: value 250000, units 1, m3 1.2
  assert.equal(pl.revenueSen, 450000, "revenue must be Σ member-CN goods value (200000 + 250000)");
  assert.equal(pl.totalUnits, 3, "units must be Σ member-CN item quantities (2 + 1)");
  assert.equal(
    Math.round(pl.totalM3 * 100) / 100,
    2.2,
    "M³ must be Σ member-CN line m³ (0.5×2 + 1.2×1)",
  );
  assert.equal(pl.cnCount, 2, "cnCount must be the number of resolved member CNs");
  assert.equal(pl.stops, 2, "two distinct destination hub addresses ⇒ 2 stops");
  assert.deepEqual([...pl.states].sort(), ["PNG", "SGR"], "both destination states must show");
  // Status rollup: cn-1 ACTIVE = pending, cn-2 PARTIALLY_SOLD = dispatched.
  assert.deepEqual(pl.cnStatusCounts, { pending: 1, dispatched: 1, delivered: 0 });
});

test("computeCnPackingListMoney: several CNs to ONE branch collapse to ONE stop", async () => {
  const seed = twoCnSeed();
  // Point both CNs at the SAME hub address ⇒ one stop, even though 2 CNs.
  seed.cns[1].hubId = "hub-A";
  const { db } = makeDb(seed);
  const money = await computeCnPackingListMoney(db, "hookka", [
    { id: "cpl-1", cnIds: ["cn-1", "cn-2"] },
  ]);
  const pl = money.get("cpl-1");
  assert.equal(pl.stops, 1, "2 CNs to the same branch address = 1 distinct stop");
  // Totals are unaffected by the stop collapse.
  assert.equal(pl.revenueSen, 450000);
  assert.equal(pl.totalUnits, 3);
});

// ---------------------------------------------------------------------------
// 2. CREATE — happy path persists a CPL- record carrying the summed snapshot.
// ---------------------------------------------------------------------------
test("createCnPackingListCore: creates a CPL- record with summed unit/M³ snapshot", async () => {
  const { db, inserted } = makeDb(twoCnSeed());
  const res = await createCnPackingListCore(makeCtx(db), "hookka", {
    cnIds: ["cn-1", "cn-2"],
    remarks: "morning run",
  });
  assert.equal(res.ok, true, "create must succeed");
  assert.match(res.packingNo, /^CPL-\d{4}-001$/, "first list of the month is CPL-YYMM-001");
  assert.equal(inserted.length, 1, "exactly one cn_packing_lists row inserted");
  const row = inserted[0];
  assert.equal(JSON.parse(row.cnIds).length, 2, "both CN ids stored in cn_ids");
  assert.equal(row.stopCount, 2, "stop_count = number of CNs");
  assert.equal(row.totalUnits, 3, "snapshot total_units = Σ member-CN quantities (2 + 1)");
  assert.equal(Math.round(Number(row.totalM3) * 100) / 100, 2.2, "snapshot total_m3 = Σ line m³");
  assert.equal(row.remarks, "morning run");
  assert.equal(row.orgId, "hookka");
});

test("createCnPackingListCore: rejects an empty selection", async () => {
  const { db } = makeDb(twoCnSeed());
  const res = await createCnPackingListCore(makeCtx(db), "hookka", { cnIds: [] });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least one consignment note/i);
});

test("createCnPackingListCore: rejects ids that don't exist in this org", async () => {
  const { db } = makeDb(twoCnSeed());
  const res = await createCnPackingListCore(makeCtx(db), "hookka", {
    cnIds: ["cn-1", "ghost-99"],
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no longer exist/i);
});

// ---------------------------------------------------------------------------
// 3. AT-MOST-ONE RULE — a CN already on another list can't be re-grouped; the
//    error names the offending CN + the list it's already on.
// ---------------------------------------------------------------------------
test("createCnPackingListCore: a CN already in another list is rejected (at most one)", async () => {
  const seed = twoCnSeed();
  // cn-2 already lives on CPL-2606-001; trying to add it to a new list fails.
  seed.existingLists = [{ packingNo: "CPL-2606-001", cnIds: ["cn-2"] }];
  const { db, inserted } = makeDb(seed);
  const res = await createCnPackingListCore(makeCtx(db), "hookka", {
    cnIds: ["cn-1", "cn-2"],
  });
  assert.equal(res.ok, false, "must reject when any CN is already on a list");
  assert.equal(res.status, 400);
  assert.match(
    res.body.error,
    /already in another packing list/i,
    "error must explain the at-most-one rule",
  );
  assert.match(res.body.error, /CGN-2606-002/, "error must name the offending CN by its number");
  assert.match(res.body.error, /CPL-2606-001/, "error must name the list it's already on");
  assert.equal(inserted.length, 0, "no row inserted on conflict");
});

test("createCnPackingListCore: CNs free of any list create cleanly alongside an unrelated existing list", async () => {
  const seed = twoCnSeed();
  // An existing list holds some OTHER CN; cn-1 + cn-2 are still free. genNextPackingNo
  // scopes its "highest existing number" scan to the CURRENT real-clock month (it
  // takes no injectable `now` in production — see packing-list-shared.ts), so the
  // seeded existing list must be dated THIS month, not a hardcoded one, or the
  // fixture rots the moment the wall clock crosses a month boundary.
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  seed.existingLists = [{ packingNo: `CPL-${yymm}-001`, cnIds: ["cn-other"] }];
  const { db, inserted } = makeDb(seed);
  const res = await createCnPackingListCore(makeCtx(db), "hookka", {
    cnIds: ["cn-1", "cn-2"],
  });
  assert.equal(res.ok, true, "free CNs must still group even when other lists exist");
  // genNextPackingNo sees the existing CPL-<this month>-001 ⇒ next is 002.
  assert.equal(res.packingNo, `CPL-${yymm}-002`, "running number increments past the existing list");
  assert.equal(inserted.length, 1);
});
