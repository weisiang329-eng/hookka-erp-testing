// ---------------------------------------------------------------------------
// finance-idempotency-transaction.test.mjs
//
// Money/ledger robustness (#18 "transactions + idempotency"). Covers:
//
//   1. TRANSACTION atomicity — the SO→PO→JC cascade (and the admin rebuild)
//      commit their multi-statement writes through `db.batch([...])`, which on
//      Postgres is `sql.begin(...)` — all-or-nothing. A mid-cascade failure
//      must roll every write back so no orphaned/half-created PO/JC survives.
//      We model that contract with a mock D1 whose batch() rolls back on any
//      statement throw, and assert the "build-first-then-atomic-batch" pattern
//      (used by admin.ts rebuildSingleSO after the fix) never leaves the wipe
//      committed without its rebuild.
//
//   2. IDEMPOTENCY — the closing-stock GL post derives its ledger source_id
//      from the CONTENT of the fresh legs (a SHA-256 of month + every
//      account/debit/credit tuple) instead of Date.now(). A double-fired
//      identical re-post hashes to the SAME source_id → detected via a
//      ledgerHasSource pre-check → posts EXACTLY ONCE. A genuine restate
//      (changed stock snapshot → different hash) still posts a fresh pair.
//
//   3. FIFO multi-slice PRESERVED — one RM claim legitimately fans out into
//      several cost_ledger rows (one per consumed batch slice). This is why a
//      naive UNIQUE on cost_ledger claim rows was REJECTED; source-level
//      idempotency keys on the immutable ledger don't touch this. We assert
//      the FIFO engine still yields all its slices.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-strip on newer Node */
}

const { fifoConsume } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/costing.ts")).href
);

// ---------------------------------------------------------------------------
// Faithful transactional mock D1. batch() applies every statement against a
// SCRATCH copy of the tables; if any statement throws, the scratch is
// discarded (ROLLBACK) and the live tables are untouched — exactly the
// `sql.begin()` semantics of SupabaseAdapter.batch. A bare .run() commits
// immediately (auto-commit), like a single non-batched statement.
// ---------------------------------------------------------------------------
function makeTxnDb() {
  const tables = { production_orders: [], fg_units: [], job_cards: [] };
  const clone = (t) => ({
    production_orders: t.production_orders.map((r) => ({ ...r })),
    fg_units: t.fg_units.map((r) => ({ ...r })),
    job_cards: t.job_cards.map((r) => ({ ...r })),
  });

  // A prepared statement carries a pure mutator (target) closure so batch()
  // can replay it against the scratch tables.
  function stmt(mutate) {
    return {
      _mutate: mutate,
      async run() {
        mutate(tables); // auto-commit
        return { success: true, meta: { changes: 1 } };
      },
    };
  }

  return {
    tables,
    // Helpers the "route" builds statements with.
    insertPO(id, soId) {
      return stmt((t) => t.production_orders.push({ id, salesOrderId: soId }));
    },
    insertJC(id, poId) {
      return stmt((t) => t.job_cards.push({ id, productionOrderId: poId }));
    },
    deletePOsForSO(soId) {
      return stmt((t) => {
        const goneIds = new Set(
          t.production_orders
            .filter((r) => r.salesOrderId === soId)
            .map((r) => r.id),
        );
        t.production_orders = t.production_orders.filter(
          (r) => r.salesOrderId !== soId,
        );
        // job_cards + fg_units cascade via FK on the PO delete.
        t.job_cards = t.job_cards.filter(
          (r) => !goneIds.has(r.productionOrderId),
        );
        t.fg_units = t.fg_units.filter((r) => !goneIds.has(r.po_id));
      });
    },
    // A statement that always throws mid-batch (models a failing INSERT).
    boom(msg) {
      return stmt(() => {
        throw new Error(msg);
      });
    },
    async batch(stmts) {
      const scratch = clone(tables); // BEGIN — work on a copy
      try {
        for (const s of stmts) s._mutate(scratch);
      } catch (e) {
        // ROLLBACK — discard scratch, live tables untouched.
        throw e;
      }
      // COMMIT — swap in the scratch.
      tables.production_orders = scratch.production_orders;
      tables.fg_units = scratch.fg_units;
      tables.job_cards = scratch.job_cards;
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
}

test("cascade batch is all-or-nothing: mid-cascade failure rolls back — no orphaned PO/JC", async () => {
  const db = makeTxnDb();
  // Pretend the SO already has one live PO+JC (prior confirm).
  await db.insertPO("po-old", "so-1").run();
  await db.insertJC("jc-old", "po-old").run();
  assert.equal(db.tables.production_orders.length, 1);

  // Rebuild pattern: build statements first, then commit wipe + rebuild in ONE
  // batch. Simulate the rebuild INSERT failing (e.g. an FK / constraint blow-up
  // on the 2nd new PO). The whole batch must roll back.
  const rebuild = [
    db.deletePOsForSO("so-1"),
    db.insertPO("po-new-1", "so-1"),
    db.boom("simulated INSERT failure mid-rebuild"),
    db.insertPO("po-new-2", "so-1"),
  ];
  await assert.rejects(() => db.batch(rebuild), /simulated INSERT failure/);

  // CRITICAL: the original PO/JC survive; NO half-wiped, NO orphaned new PO.
  assert.equal(db.tables.production_orders.length, 1, "wipe must not commit");
  assert.equal(db.tables.production_orders[0].id, "po-old");
  assert.equal(db.tables.job_cards.length, 1);
  assert.ok(
    !db.tables.production_orders.some((r) => r.id.startsWith("po-new")),
    "no orphaned partially-created PO",
  );
});

test("cascade batch commits fully on success: wipe + rebuild land together", async () => {
  const db = makeTxnDb();
  await db.insertPO("po-old", "so-1").run();
  await db.insertJC("jc-old", "po-old").run();

  await db.batch([
    db.deletePOsForSO("so-1"),
    db.insertPO("po-new-1", "so-1"),
    db.insertJC("jc-new-1", "po-new-1"),
  ]);

  assert.deepEqual(
    db.tables.production_orders.map((r) => r.id),
    ["po-new-1"],
    "old PO wiped, exactly one new PO",
  );
  assert.deepEqual(
    db.tables.job_cards.map((r) => r.id),
    ["jc-new-1"],
  );
});

// ---------------------------------------------------------------------------
// (2) Closing-stock content-hash idempotency. We reproduce the exact source_id
//     derivation from accounting.ts /stock/close-post and prove the
//     double-fire-vs-restate behaviour.
// ---------------------------------------------------------------------------
async function sha256Hex(input) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Mirror of the route's source_id derivation.
async function closingSourceIds(month, freshLegs, priorNet) {
  const hashInput = [
    month,
    ...freshLegs.map((l) => `${l.accountCode}:${l.debitSen}:${l.creditSen}`),
    "REV",
    ...[...priorNet.entries()].map(([code, net]) => `${code}:${net}`),
  ].join("|");
  const h = await sha256Hex(hashInput);
  return { postSourceId: `cs-${month}-${h.slice(0, 16)}`, revSourceId: `cs-rev-${h.slice(0, 16)}` };
}

// Minimal ledger with the real UNIQUE(org,source_type,source_id,leg_no)
// enforced in-memory, plus a ledgerHasSource pre-check.
function makeLedger() {
  const rows = [];
  const key = (r) => `${r.orgId}|${r.sourceType}|${r.sourceId}|${r.legNo}`;
  return {
    rows,
    hasSource(orgId, sourceType, sourceId) {
      return rows.some(
        (r) => r.orgId === orgId && r.sourceType === sourceType && r.sourceId === sourceId,
      );
    },
    // The atomic post: pre-check, then insert legs enforcing the unique index.
    post(orgId, postSourceId, legs) {
      if (this.hasSource(orgId, "closing_stock", postSourceId)) {
        return { alreadyPosted: true, inserted: 0 };
      }
      const staged = legs.map((l) => ({ ...l, orgId }));
      for (const r of staged) {
        if (rows.some((x) => key(x) === key(r))) {
          throw new Error(`duplicate ledger key ${key(r)}`);
        }
      }
      rows.push(...staged);
      return { alreadyPosted: false, inserted: staged.length };
    },
  };
}

test("closing-stock: identical double-fire posts EXACTLY ONCE (content-hash source_id + pre-check)", async () => {
  const ledger = makeLedger();
  const orgId = "org-1";
  const month = "2026-06";
  const freshLegs = [
    { sourceType: "closing_stock", legNo: 1, accountCode: "330-0010", debitSen: 500000, creditSen: 0 },
    { sourceType: "closing_stock", legNo: 2, accountCode: "531-0000", debitSen: 0, creditSen: 500000 },
  ];
  const priorNet = new Map(); // nothing posted yet

  const { postSourceId } = await closingSourceIds(month, freshLegs, priorNet);
  const legs = freshLegs.map((l) => ({ ...l, sourceId: postSourceId }));

  const first = ledger.post(orgId, postSourceId, legs);
  assert.equal(first.alreadyPosted, false);
  assert.equal(first.inserted, 2);

  // DOUBLE FIRE — identical request, identical snapshot → identical hash.
  const { postSourceId: post2 } = await closingSourceIds(month, freshLegs, priorNet);
  assert.equal(post2, postSourceId, "identical snapshot must hash to the same source_id");
  const second = ledger.post(orgId, post2, legs.map((l) => ({ ...l, sourceId: post2 })));
  assert.equal(second.alreadyPosted, true, "retry detected as already-posted");
  assert.equal(second.inserted, 0, "no second pair appended");
  assert.equal(ledger.rows.length, 2, "ledger has exactly one pair after the double-fire");
});

test("closing-stock: a GENUINE restate (changed stock snapshot) still posts a fresh pair", async () => {
  const ledger = makeLedger();
  const orgId = "org-1";
  const month = "2026-06";

  const legsV1 = [
    { sourceType: "closing_stock", legNo: 1, accountCode: "330-0010", debitSen: 500000, creditSen: 0 },
    { sourceType: "closing_stock", legNo: 2, accountCode: "531-0000", debitSen: 0, creditSen: 500000 },
  ];
  const { postSourceId: s1 } = await closingSourceIds(month, legsV1, new Map());
  ledger.post(orgId, s1, legsV1.map((l) => ({ ...l, sourceId: s1 })));

  // Stock re-counted higher (RM valuation flip). Different content → new hash.
  const legsV2 = [
    { sourceType: "closing_stock", legNo: 1, accountCode: "330-0010", debitSen: 650000, creditSen: 0 },
    { sourceType: "closing_stock", legNo: 2, accountCode: "531-0000", debitSen: 0, creditSen: 650000 },
  ];
  // Prior net now reflects the V1 post being reversed.
  const priorNet = new Map([["330-0010", 500000], ["531-0000", -500000]]);
  const { postSourceId: s2 } = await closingSourceIds(month, legsV2, priorNet);

  assert.notEqual(s2, s1, "changed snapshot must hash to a different source_id");
  const restate = ledger.post(orgId, s2, legsV2.map((l) => ({ ...l, sourceId: s2 })));
  assert.equal(restate.alreadyPosted, false, "restate is not blocked");
  assert.equal(restate.inserted, 2);
  assert.equal(ledger.rows.length, 4, "V1 pair + V2 pair coexist (append-only restate)");
});

test("closing-stock: same month, same snapshot, is idempotent even across many retries", async () => {
  const ledger = makeLedger();
  const orgId = "org-1";
  const month = "2026-06";
  const freshLegs = [
    { sourceType: "closing_stock", legNo: 1, accountCode: "330-0010", debitSen: 12345, creditSen: 0 },
    { sourceType: "closing_stock", legNo: 2, accountCode: "531-0000", debitSen: 0, creditSen: 12345 },
  ];
  const { postSourceId } = await closingSourceIds(month, freshLegs, new Map());
  const legs = freshLegs.map((l) => ({ ...l, sourceId: postSourceId }));
  for (let i = 0; i < 5; i++) ledger.post(orgId, postSourceId, legs);
  assert.equal(ledger.rows.length, 2, "5 identical fires → still one pair");
});

// ---------------------------------------------------------------------------
// (3) FIFO multi-slice preserved — one claim → many ledger rows. This is the
//     reason a naive UNIQUE on cost_ledger slices was rejected. Source-level
//     idempotency keys on the IMMUTABLE ledger don't touch this fan-out.
// ---------------------------------------------------------------------------
test("FIFO multi-slice: one RM claim consumes across 3 batches → 3 distinct slices", () => {
  const batches = [
    { id: "b1", rmId: "rm-1", source: "GRN", receivedDate: "2026-01-01", originalQty: 4, remainingQty: 4, unitCostSen: 100 },
    { id: "b2", rmId: "rm-1", source: "GRN", receivedDate: "2026-02-01", originalQty: 4, remainingQty: 4, unitCostSen: 120 },
    { id: "b3", rmId: "rm-1", source: "GRN", receivedDate: "2026-03-01", originalQty: 4, remainingQty: 4, unitCostSen: 150 },
  ];
  // Need 10 units → 4 (b1) + 4 (b2) + 2 (b3) = three slices, oldest first.
  const res = fifoConsume(batches, 10);
  assert.equal(res.slices.length, 3, "one claim fans out into 3 ledger-row slices");
  assert.equal(res.consumedQty, 10);
  assert.equal(res.shortageQty, 0);
  assert.deepEqual(
    res.slices.map((s) => s.batchId),
    ["b1", "b2", "b3"],
    "FIFO order preserved (oldest receivedDate first)",
  );
  assert.deepEqual(
    res.slices.map((s) => s.qty),
    [4, 4, 2],
  );
  // Total cost = 4*100 + 4*120 + 2*150 = 1180 sen, integer sen throughout.
  assert.equal(
    res.slices.reduce((s, sl) => s + sl.totalCostSen, 0),
    1180,
  );
});
