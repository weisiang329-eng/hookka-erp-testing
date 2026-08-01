// ---------------------------------------------------------------------------
// fifo-float-dust.test.mjs
//
// Worker scans were failing with a 500 that BLAMED CONCURRENCY:
//
//   RM batch rmb-grn-... race lost: PO SO-2607-246-01 (Fabric (from order))
//   tried to consume 6.90893484407556e-77 but another writer left less than
//   that available. Retry the completion.
//
// No race existed. fifoConsume walks batches subtracting floats, so
// `remaining` lands on residue (6.9e-77) instead of 0. The old guard
// `if (remaining <= 0) break` never fires on POSITIVE residue, so the walk
// continued and minted a slice FOR THE DUST. Downstream, po-cost-cascade
// guards each slice with `WHERE remainingQty >= ?`; a drained batch has 0, and
// 0 >= 6.9e-77 is false, so the UPDATE no-ops and the code throws.
//
// Net effect: a worker could not complete a scan, and the error pointed the
// operator at a retry that would never help.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles the .ts import */
}

const batch = (id, qty, date) => ({
  id,
  rmId: "rm-1",
  source: "GRN",
  receivedDate: date,
  originalQty: qty,
  remainingQty: qty,
  unitCostSen: 100,
  createdAt: date,
});

test("a fully-consumed multi-batch walk mints NO dust slice", async () => {
  const { fifoConsume } = await import("../src/lib/costing.ts");

  // These numbers PROVABLY leave residue: 1.0 - 0.7 = 0.30000000000000004,
  // minus 0.3 leaves 5.55e-17 - positive, so the old `<= 0` break never fired.
  const batches = [batch("b1", 0.7, "2026-01-01"), batch("b2", 0.3, "2026-01-02")];
  const res = fifoConsume(batches, 1.0);

  assert.equal(res.slices.length, 2, "one slice per real batch, no dust slice");
  for (const s of res.slices) {
    assert.ok(
      s.qty > 1e-9,
      "every emitted slice must be a physically real quantity, got " + s.qty,
    );
  }
  assert.equal(res.shortageQty, 0, "float residue must not read as a shortage");
});

test("residue never becomes a slice even with a third batch available", async () => {
  const { fifoConsume } = await import("../src/lib/costing.ts");

  // b3 is the batch the old code would have hit with the dust remainder.
  const batches = [
    batch("b1", 0.7, "2026-01-01"),
    batch("b2", 0.3, "2026-01-02"),
    batch("b3", 5, "2026-01-03"),
  ];
  const res = fifoConsume(batches, 1.0);

  assert.ok(
    !res.slices.some((s) => s.batchId === "b3"),
    "b3 must be untouched - the old bug charged it a 1e-17 slice",
  );
  assert.equal(batches[2].remainingQty, 5, "b3 stock must be unchanged");
});

test("a genuine shortage is still reported", async () => {
  const { fifoConsume, QTY_EPSILON } = await import("../src/lib/costing.ts");
  const res = fifoConsume([batch("b1", 2, "2026-01-01")], 5);
  assert.equal(res.shortageQty, 3, "real shortfall must survive the dust guard");
  assert.ok(3 > QTY_EPSILON);
});

test("epsilon is far below any real quantity but above float residue", async () => {
  const { QTY_EPSILON } = await import("../src/lib/costing.ts");
  assert.ok(QTY_EPSILON > 0);
  assert.ok(
    QTY_EPSILON < 1e-6,
    "must not swallow a real (if tiny) consumption",
  );
  assert.ok(
    QTY_EPSILON > 1e-12,
    "must sit above the residue float subtraction leaves at these magnitudes",
  );
});

test("fifoConsumeFG carries the same guard - it had the identical walk", async () => {
  const { fifoConsumeFG } = await import("../src/lib/costing.ts");
  const fg = (id, qty, d) => ({
    id,
    remainingQty: qty,
    unitCostSen: 100,
    completedDate: d,
  });
  const batches = [fg("f1", 0.7, "2026-01-01"), fg("f2", 0.3, "2026-01-02"), fg("f3", 5, "2026-01-03")];
  const res = fifoConsumeFG(batches, 1.0);
  assert.ok(
    !res.slices.some((s) => s.batchId === "f3"),
    "the FG walk must not mint a dust slice either",
  );
  assert.equal(res.shortageQty, 0);
});

test("the cascade skips dust slices before the race guard", () => {
  // Defence in depth: even if some other caller produces dust, a worker's
  // scan must not fail with a phantom "race lost".
  const src = readFileSync(
    resolve(process.cwd(), "src/api/lib/po-cost-cascade.ts"),
    "utf8",
  );
  const loop = src.slice(src.indexOf("for (const slice of result.slices)"));
  const skip = loop.indexOf("slice.qty <= QTY_EPSILON");
  const guard = loop.indexOf("remainingQty >= ?");
  assert.ok(skip !== -1, "cascade must skip sub-epsilon slices");
  assert.ok(
    skip < guard,
    "the dust skip must run BEFORE the race guard, or it still throws",
  );
});
