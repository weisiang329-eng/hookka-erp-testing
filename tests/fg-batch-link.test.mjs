// ---------------------------------------------------------------------------
// fg-batch-link.test.mjs — which cost lot does a physical piece belong to?
//
// THE HOLE. `fg_units.batch_id` has existed since 0001_init and was NULL on all
// 4,866 rows. The 2,250 `fg_batches` cost lots — the only place a finished
// piece's unit cost lives — were unreachable from the piece. No unit cost, no
// stock value, no age.
//
// The rule these tests defend is a judgement, not a detail: A WRONG COST LINK
// IS WORSE THAN A MISSING ONE. A blank reads as a blank and gets questioned; a
// wrong number reads as a number and gets trusted. So the ladder answers only
// when the evidence NAMES the lot, and says nothing the moment two readings
// disagree.
//
// Every fixture here is a shape that exists in production today: the duplicate
// lots left by replayed completion cascades (145 production orders), the
// production orders with no lot at all (160), and the two units whose lot
// describes a neighbouring SKU (5543-CNR vs 5543-SQCNR).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const { pickBatchForUnit, planFgBatchLinks, buildFgUnitBatchStampStatement } =
  await import(pathToFileURL(resolve(process.cwd(), "src/api/lib/fg-batch-link.ts")).href);

const unit = (over = {}) => ({
  id: "fgu-po-1-1-1",
  poId: "po-1",
  productCode: "1013-(Q)",
  ...over,
});
const lot = (id, over = {}) => ({
  batchId: id,
  productionOrderId: "po-1",
  productCode: "1013-(Q)",
  ...over,
});

// ── the two rungs ──────────────────────────────────────────────────────────

test("one lot on the production order — nothing to choose between", () => {
  const r = pickBatchForUnit(unit(), { completionBatchIds: [], lots: [lot("FGB-1")] });
  assert.deepEqual(r, { batchId: "FGB-1", tier: "SOLE_LOT" });
});

test("duplicate lots: the completion ledger names the real one", () => {
  // The shape of 145 production orders in the book. A replayed completion
  // cascade wrote a second lot for the same PO, same product, same quantity —
  // one costed, the rest at zero. Picking by "first", "newest" or "cheapest"
  // would be a coin toss dressed as a rule; the FG_COMPLETED cost_ledger row
  // says which lot the completion was actually BOOKED against, and that is a
  // statement of record. On production it rescues 318 of the 451 units sitting
  // on such orders.
  const r = pickBatchForUnit(unit(), {
    completionBatchIds: ["FGB-real", "FGB-real"],
    lots: [lot("FGB-dupe", { productCode: "1013-(Q)" }), lot("FGB-real")],
  });
  assert.deepEqual(r, { batchId: "FGB-real", tier: "COMPLETION_LEDGER" });
});

test("duplicate lots and no completion row: NULL, not a coin toss", () => {
  const r = pickBatchForUnit(unit(), {
    completionBatchIds: [],
    lots: [lot("FGB-a"), lot("FGB-b")],
  });
  assert.equal(r.batchId, null);
  assert.equal(r.reason, "several lots and no completion row names one");
});

test("two completion rows naming DIFFERENT lots is a disagreement, not a majority vote", () => {
  const r = pickBatchForUnit(unit(), {
    completionBatchIds: ["FGB-a", "FGB-a", "FGB-b"],
    lots: [lot("FGB-a"), lot("FGB-b")],
  });
  assert.equal(r.batchId, null, "when the evidence contradicts itself, say nothing");
});

test("no lot at all on the production order", () => {
  // 160 production orders / 284 units in the book. They carry no fg_batches row
  // AND no FG_COMPLETED ledger row — there is genuinely nothing to point at,
  // and inventing a lot for them would invent a cost.
  const r = pickBatchForUnit(unit(), { completionBatchIds: [], lots: [] });
  assert.equal(r.batchId, null);
  assert.equal(r.reason, "no lot on the production order");
});

test("a unit with no production order links to nothing", () => {
  const r = pickBatchForUnit(unit({ poId: null }), { completionBatchIds: [], lots: [] });
  assert.equal(r.batchId, null);
  assert.equal(r.reason, "the unit has no production order");
});

// ── the product-code guard, on BOTH rungs ─────────────────────────────────

test("a lot describing a different product is refused — even on the sole-lot rung", () => {
  // The two real rows: 5543-CNR against a 5543-SQCNR lot, 5530-2A(LHF) against
  // a (RHF) lot. Both sit on SINGLE-lot production orders, i.e. on the rung
  // that looks most certain — which is exactly why the guard cannot be applied
  // only to the ambiguous case.
  const r = pickBatchForUnit(unit({ productCode: "5543-CNR" }), {
    completionBatchIds: [],
    lots: [lot("FGB-1", { productCode: "5543-SQCNR" })],
  });
  assert.equal(r.batchId, null);
  assert.equal(r.reason, "the lot describes a different product");
});

test("the guard applies to the completion-ledger rung too", () => {
  const r = pickBatchForUnit(unit({ productCode: "5530-2A(LHF)" }), {
    completionBatchIds: ["FGB-1"],
    lots: [lot("FGB-1", { productCode: "5530-2A(RHF)" })],
  });
  assert.equal(r.batchId, null);
});

test("a completion row pointing at another order's lot is a fault, not evidence", () => {
  const r = pickBatchForUnit(unit(), {
    completionBatchIds: ["FGB-elsewhere"],
    lots: [lot("FGB-elsewhere", { productionOrderId: "po-999" }), lot("FGB-mine")],
  });
  // It falls through to rung B, which finds exactly one lot that IS this
  // order's, and links that.
  assert.deepEqual(r, { batchId: "FGB-mine", tier: "SOLE_LOT" });
});

test("a missing product on either side does not block an otherwise clean link", () => {
  // A deleted catalog product leaves the lot's code null. That is an absence of
  // evidence against the link, not evidence against it — the PO is still the
  // same PO.
  assert.equal(
    pickBatchForUnit(unit(), {
      completionBatchIds: [],
      lots: [lot("FGB-1", { productCode: null })],
    }).batchId,
    "FGB-1",
  );
  assert.equal(
    pickBatchForUnit(unit({ productCode: null }), {
      completionBatchIds: [],
      lots: [lot("FGB-1")],
    }).batchId,
    "FGB-1",
  );
});

// ── the plan over a set ────────────────────────────────────────────────────

test("planning over a set reports what it linked AND what it refused to", async () => {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const lots = [
    { batchId: "FGB-1", poId: "po-1", productCode: "1013-(Q)" },
    { batchId: "FGB-2a", poId: "po-2", productCode: "1007-(K)" },
    { batchId: "FGB-2b", poId: "po-2", productCode: "1007-(K)" },
  ];
  const completions = [{ poId: "po-2", batchId: "FGB-2b" }];
  const db = {
    prepare(sql) {
      const q = norm(sql);
      return {
        bind(...args) {
          return {
            async all() {
              if (/FROM fg_batches b/.test(q)) {
                return { results: lots.filter((l) => args.includes(l.poId)) };
              }
              if (/FROM cost_ledger/.test(q)) {
                return { results: completions.filter((c) => args.includes(c.poId)) };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };

  const plan = await planFgBatchLinks(db, [
    { id: "u1", poId: "po-1", productCode: "1013-(Q)" },
    { id: "u2", poId: "po-2", productCode: "1007-(K)" }, // duplicate lots, ledger names one
    { id: "u3", poId: "po-3", productCode: "9999" }, // no lot anywhere
  ]);

  assert.deepEqual(
    plan.linked,
    [
      { unitId: "u1", batchId: "FGB-1", tier: "SOLE_LOT" },
      { unitId: "u2", batchId: "FGB-2b", tier: "COMPLETION_LEDGER" },
    ],
  );
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].unitId, "u3");
  assert.deepEqual(plan.byTier, { SOLE_LOT: 1, COMPLETION_LEDGER: 1 });
  assert.deepEqual(plan.byReason, { "no lot on the production order": 1 });
});

// ── the write-time stamp ───────────────────────────────────────────────────

test("the write-time stamp only ever fills a BLANK link", () => {
  const db = { prepare: (sql) => ({ sql, bind: (...args) => ({ sql, args }) }) };
  const s = buildFgUnitBatchStampStatement(db, "po-1", "FGB-1", "1013-(Q)");
  assert.match(
    s.sql.replace(/\s+/g, " "),
    /UPDATE fg_units SET batchId = \? WHERE poId = \? AND \(batchId IS NULL OR batchId = ''\)/,
    "an established link is never overwritten, so the cascade is safe to replay",
  );
  assert.match(s.sql, /productCode IS NULL OR productCode = \?/, "same product guard as the backfill");
  assert.deepEqual(s.args, ["FGB-1", "po-1", "1013-(Q)"]);
});

test("the completion cascade stamps the link, and refuses when the order has several lots", () => {
  const src = read("src/api/lib/fg-completion.ts");
  // It must read ALL the lots, not LIMIT 1 — with only the first row it cannot
  // tell a clean order from one carrying replay duplicates, and would link the
  // pieces to whichever lot happened to come back.
  assert.ok(
    !/SELECT id FROM fg_batches WHERE productionOrderId = \? LIMIT 1/.test(src),
    "reading one lot cannot distinguish a sole lot from the first of several",
  );
  assert.match(src, /existingBatches\.length === 1 \? existingBatches\[0\]\.id : null/);
  assert.match(src, /buildFgUnitBatchStampStatement\(/);
});
