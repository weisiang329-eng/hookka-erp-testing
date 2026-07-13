// ---------------------------------------------------------------------------
// fg-stock.test.mjs — unit tests for src/lib/fg-stock.ts.
//
// This module is the single source of truth for Finished-Goods stock: the
// Inventory page and the GET /api/inventory/fg-stock endpoint both call
// deriveFGStock, and the endpoint ships its result as deltas (splitFgDeltas)
// that the page merges back (mergeFgDeltas). The critical invariant is that the
// deltas round-trip is byte-identical to computing deriveFGStock on the client:
//   mergeFgDeltas(products, splitFgDeltas(deriveFGStock(...))) ≡ deriveFGStock(...)
// on per-item stock/reserved. If this drifts, the FG page (and its Available /
// Reserved tallies) would silently diverge after the perf swap.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveFGStock,
  splitFgDeltas,
  mergeFgDeltas,
} from "../src/lib/fg-stock.ts";

const prod = (id, code, category = "BEDFRAME") => ({
  id,
  code,
  name: `${code} name`,
  category,
  description: "",
  baseModel: code,
  sizeCode: "",
  sizeLabel: "",
  fabricUsage: 0,
  unitM3: 0,
  status: "ACTIVE",
  costPriceSen: 12345,
  productionTimeMinutes: 0,
  subAssemblies: [],
  bomComponents: [],
  deptWorkingTimes: [],
});

const po = (id, productId, productCode, quantity, statuses) => ({
  id,
  productId,
  productCode,
  productName: `${productCode} name`,
  itemCategory: "BEDFRAME",
  sizeCode: "K",
  sizeLabel: "King",
  quantity,
  jobCards: statuses.map((status) => ({ departmentCode: "UPHOLSTERY", status })),
});

test("UPH all completed, no DO state → free stock", () => {
  const items = deriveFGStock([prod("p1", "A")], [po("po1", "p1", "A", 3, ["COMPLETED"])], new Map());
  const a = items.find((i) => i.id === "p1");
  assert.equal(a.stockQty, 3);
  assert.equal(a.reservedQty, 0);
});

test("DRAFT DO earmark → reserved, not free stock", () => {
  const state = new Map([["po1", "DRAFT"]]);
  const items = deriveFGStock([prod("p1", "A")], [po("po1", "p1", "A", 2, ["COMPLETED", "TRANSFERRED"])], state);
  const a = items.find((i) => i.id === "p1");
  assert.equal(a.stockQty, 0);
  assert.equal(a.reservedQty, 2);
});

test("DISPATCHED → drops out of inventory entirely", () => {
  const state = new Map([["po1", "DISPATCHED"]]);
  const items = deriveFGStock([prod("p1", "A")], [po("po1", "p1", "A", 5, ["COMPLETED"])], state);
  const a = items.find((i) => i.id === "p1");
  assert.equal(a.stockQty, 0);
  assert.equal(a.reservedQty, 0);
});

test("incomplete UPH → not a finished good", () => {
  const items = deriveFGStock([prod("p1", "A")], [po("po1", "p1", "A", 4, ["COMPLETED", "IN_PROGRESS"])], new Map());
  assert.equal(items.find((i) => i.id === "p1").stockQty, 0);
});

test("off-catalog PO → dynamic fg-dyn-* row", () => {
  const items = deriveFGStock([], [po("po1", "ghost", "GHOST", 7, ["COMPLETED"])], new Map());
  const dyn = items.find((i) => i.id === "fg-dyn-GHOST");
  assert.ok(dyn, "dyn row created");
  assert.equal(dyn.stockQty, 7);
  assert.equal(dyn.code, "GHOST");
});

test("splitFgDeltas ships only rows carrying stock", () => {
  const products = [prod("p1", "A"), prod("p2", "B"), prod("p3", "C")];
  const pos = [
    po("po1", "p1", "A", 3, ["COMPLETED"]), // free stock
    po("po2", "p2", "B", 2, ["COMPLETED"]), // reserved
  ];
  const state = new Map([["po2", "DRAFT"]]);
  const deltas = splitFgDeltas(deriveFGStock(products, pos, state));
  // p3 has no PO → no counts row; p1 + p2 carry stock → 2 counts rows.
  assert.equal(deltas.counts.length, 2);
  assert.equal(deltas.dyn.length, 0);
  assert.ok(!deltas.counts.some((c) => c.id === "p3"));
});

test("round-trip identity: merge(split(derive)) ≡ derive on stock/reserved", () => {
  const products = [
    prod("p1", "A"),
    prod("p2", "B", "SOFA"),
    prod("p3", "C"),
    prod("p4", "D"),
  ];
  const pos = [
    po("po1", "p1", "A", 3, ["COMPLETED"]),
    po("po2", "p2", "B", 2, ["COMPLETED", "TRANSFERRED"]),
    po("po3", "p3", "C", 5, ["COMPLETED"]),
    po("po4", "p1", "A", 1, ["COMPLETED"]), // second PO for same product → accumulates
    po("po5", "ghost", "GHOST", 4, ["COMPLETED"]), // off-catalog → dyn
    po("po6", "p4", "D", 9, ["COMPLETED"]), // will be dispatched → excluded
  ];
  const state = new Map([
    ["po2", "DRAFT"], // p2 reserved
    ["po6", "DISPATCHED"], // p4 excluded
  ]);

  const direct = deriveFGStock(products, pos, state);
  const round = mergeFgDeltas(products, splitFgDeltas(direct));

  // Compare per-id stock/reserved — the two must agree exactly.
  const key = (arr) =>
    new Map(arr.map((i) => [i.id, `${i.stockQty}/${i.reservedQty}`]));
  const dm = key(direct);
  const rm = key(round);
  for (const [id, v] of dm) {
    assert.equal(rm.get(id), v, `stock/reserved mismatch for ${id}`);
  }
  // Tallies identical.
  const tally = (arr) => ({
    stock: arr.reduce((s, i) => s + i.stockQty, 0),
    reserved: arr.reduce((s, i) => s + i.reservedQty, 0),
  });
  assert.deepEqual(tally(round), tally(direct));
  // p1=3+1, p3=5, ghost=4 free; p2=2 reserved; p4 dispatched → excluded.
  assert.deepEqual(tally(direct), { stock: 3 + 1 + 5 + 4, reserved: 2 });
  // ghost dyn present in the merged output with its shell shape.
  const ghost = round.find((i) => i.id === "fg-dyn-GHOST");
  assert.ok(ghost);
  assert.equal(ghost.stockQty, 4);
  assert.equal(ghost.costPriceSen, 0);
});
