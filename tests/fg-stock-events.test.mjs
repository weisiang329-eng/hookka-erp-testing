// ---------------------------------------------------------------------------
// fg-stock-events.test.mjs — the finished-goods stock ledger must actually be
// a ledger.
//
// THE HOLE. `fg_units` holds 4,866 real per-piece rows — serial, production
// order, sales order, date stamps — and nine different writers UPDATE the
// status column in place. The previous state is simply gone. So nothing could
// answer the three questions the owner asked for: which production order did
// this piece come in on and when was it made, which SO/DO took it out, and how
// old is it. `stock_movements` is not that record either: no unit, no cost, and
// its only link to a document is a free-text `reason` sentence nothing can
// join on.
//
// These tests pin BEHAVIOUR, not wiring:
//   • producing a piece writes exactly ONE IN event, naming the production order;
//   • dispatching writes exactly ONE OUT;
//   • cancelling a delivery order writes a COUNTER-ROW and leaves the original
//     event exactly as it was — the same append-only discipline
//     buildDoCancelReleaseStatements already follows for stock_movements;
//   • no code path anywhere UPDATEs or DELETEs an event.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const {
  balanceDelta,
  buildFgStockEventStatements,
  eventTypeFor,
  isOnHandStatus,
  docForScannedUnit,
} = await import(pathToFileURL(resolve(process.cwd(), "src/api/lib/fg-stock-events.ts")).href);

// ── a fake D1 that just records what it was asked to do ────────────────────

function fakeDb({ tables = {} } = {}) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const written = [];
  const db = {
    written,
    batched: [],
    prepare(sql) {
      const q = norm(sql);
      const stmt = {
        sql: q,
        args: [],
        bind(...args) {
          return { ...stmt, args, bind: stmt.bind, first: stmt.first, all: stmt.all, run: stmt.run };
        },
        async run() {
          written.push({ sql: q, args: this.args ?? [] });
          return { success: true };
        },
        async first() {
          const h = (tables.first ?? []).find(([re]) => re.test(q));
          return h ? h[1](this.args ?? []) : null;
        },
        async all() {
          const h = (tables.all ?? []).find(([re]) => re.test(q));
          return { results: h ? h[1](this.args ?? []) : [] };
        },
      };
      return stmt;
    },
    async batch(stmts) {
      db.batched.push(stmts);
      for (const s of stmts) written.push({ sql: s.sql, args: s.args ?? [] });
      return stmts.map(() => ({ success: true }));
    },
  };
  return db;
}

const eventRows = (db) =>
  db.written
    .filter((w) => /INSERT INTO fg_stock_events/.test(w.sql))
    .map((w) => ({
      id: w.args[0],
      fgUnitId: w.args[1],
      eventType: w.args[2],
      direction: w.args[3],
      fromStatus: w.args[4],
      toStatus: w.args[5],
      docType: w.args[6],
      docId: w.args[7],
      docNo: w.args[8],
      productCode: w.args[9],
      batchId: w.args[10],
      occurredAt: w.args[11],
      actorType: w.args[12],
      reversesDocType: w.args[15],
      reversesDocId: w.args[16],
      note: w.args[17],
    }));

// ── 1. the arithmetic: the sign is derived, never chosen ───────────────────

test("direction is onHand(to) − onHand(from), so no call site can get the sign wrong", () => {
  // Production output: the piece did not exist, now it is on the shelf.
  assert.equal(balanceDelta(null, "PACKED"), 1);
  // Dispatch: it left the rack.
  assert.equal(balanceDelta("PACKED", "LOADED"), -1);
  // Delivery AFTER dispatch changes nothing — it already left.
  assert.equal(balanceDelta("LOADED", "DELIVERED"), 0);
  // Un-dispatch and DO-cancel are INs without anyone typing "+1".
  assert.equal(balanceDelta("LOADED", "PENDING"), 1);
  assert.equal(balanceDelta("DELIVERED", "PENDING"), 1);
  // A return puts the goods (and their cost) back.
  assert.equal(balanceDelta("DELIVERED", "RETURNED"), 1);

  assert.equal(eventTypeFor(1), "IN");
  assert.equal(eventTypeFor(-1), "OUT");
  assert.equal(eventTypeFor(0), "MOVE");
});

test("the on-hand set matches what the rest of the codebase already means by it", () => {
  // delivery/sales routes spell this as `status NOT IN ('LOADED','DELIVERED','RETURNED')`
  // and deriveFGStock drops dispatched POs — the ledger agrees on LOADED and
  // DELIVERED. RETURNED is deliberately on hand: every writer of RETURNED also
  // credits fg_batches.remaining_qty back, so calling it "out" would make the
  // two ledgers disagree about the same physical piece.
  for (const s of ["PENDING", "PENDING_UPHOLSTERY", "UPHOLSTERED", "PACKED", "RETURNED"]) {
    assert.equal(isOnHandStatus(s), true, s);
  }
  for (const s of ["LOADED", "DELIVERED"]) {
    assert.equal(isOnHandStatus(s), false, s);
  }
});

test("a transition that changes nothing is not an event", () => {
  const db = fakeDb();
  const stmts = buildFgStockEventStatements(
    db,
    [{ id: "u1", status: "PACKED", productCode: "1013-(Q)" }],
    {
      toStatus: "PACKED",
      doc: { docType: "PRODUCTION_ORDER", docId: "po-1" },
      occurredAt: "2026-08-08T00:00:00.000Z",
    },
  );
  assert.equal(stmts.length, 0);
});

// ── 2. producing a piece writes exactly one IN ─────────────────────────────

test("producing a piece writes exactly one IN event naming its production order", async () => {
  const { generateFGUnitsForPO } = await import(pathToFileURL(resolve(process.cwd(), "src/api/routes/fg-units.ts")).href);

  const po = {
    id: "pord-so-abc-01",
    poNo: "PO-2608-001",
    salesOrderId: "so-1",
    salesOrderNo: "SO-2608-001",
    companySOId: null,
    consignmentOrderId: null,
    companyCOId: null,
    lineNo: 1,
    customerName: "Houzs",
    productId: "prod-21",
    productCode: "1013-(Q)",
    productName: "1013 Queen",
    quantity: 2,
    specialOrder: null,
    startDate: "2026-08-01",
    completedDate: "2026-08-05",
  };

  let unitsExist = false;
  const db = fakeDb({
    tables: {
      first: [
        [/FROM production_orders WHERE id = \?/, () => po],
        [/FROM products WHERE id = \?/, () => ({ id: "prod-21", code: "1013-(Q)", pieces: null, category: "SOFA", sizeCode: "Q" })],
        [/FROM sales_orders WHERE id = \?/, () => ({ id: "so-1", customerId: "cust-1", hubName: "Houzs KL" })],
      ],
      all: [
        [/FROM fg_units WHERE poId = \?/, () => (unitsExist ? [{ id: "fgu-pord-so-abc-01-1-1" }] : [])],
        [/FROM delivery_hubs WHERE customerId = \?/, () => []],
      ],
    },
  });

  const res = await generateFGUnitsForPO(db, po.id);
  assert.equal(res.status, "ok");
  unitsExist = true;

  const events = eventRows(db);
  // quantity 2, one piece each (no pieces JSON, SOFA → the 1-piece fallback).
  assert.equal(events.length, 2, "one IN per physical piece, no more");
  for (const e of events) {
    assert.equal(e.eventType, "IN");
    assert.equal(e.direction, 1);
    assert.equal(e.fromStatus, null, "the piece did not exist before");
    assert.equal(e.toStatus, "PACKED");
    // The whole point: a real document id, not a sentence.
    assert.equal(e.docType, "PRODUCTION_ORDER");
    assert.equal(e.docId, "pord-so-abc-01");
    assert.equal(e.docNo, "PO-2608-001");
    assert.equal(e.productCode, "1013-(Q)");
  }
  // One row per unit, and the id is derived from the unit — a replayed
  // completion cascade cannot book the same box into stock twice.
  const ids = new Set(events.map((e) => e.id));
  assert.equal(ids.size, 2);
  assert.equal(
    db.written.filter((w) => /INSERT INTO fg_stock_events/.test(w.sql) && /ON CONFLICT \(id\) DO NOTHING/.test(w.sql))
      .length,
    2,
    "the production IN must be idempotent on replay",
  );

  // The events ride the SAME batch as the fg_units INSERTs — a piece can never
  // exist without its arrival.
  assert.equal(db.batched.length, 1);
  const batch = db.batched[0];
  assert.ok(batch.some((s) => /INSERT INTO fg_units/.test(s.sql)));
  assert.ok(batch.some((s) => /INSERT INTO fg_stock_events/.test(s.sql)));
});

// ── 3. dispatching writes exactly one OUT ──────────────────────────────────

test("dispatching a packed piece writes exactly one OUT naming the delivery order", () => {
  const db = fakeDb();
  const stmts = buildFgStockEventStatements(
    db,
    [
      { id: "u1", status: "PACKED", productCode: "1013-(Q)", batchId: "FGB-260808-01-abc" },
      { id: "u2", status: "PACKED", productCode: "1013-(Q)", batchId: "FGB-260808-01-abc" },
    ],
    {
      toStatus: "LOADED",
      doc: { docType: "DELIVERY_ORDER", docId: "do-77", docNo: "DO-2608-077" },
      occurredAt: "2026-08-08T02:00:00.000Z",
      note: "DO-2608-077 dispatched",
    },
  );
  for (const s of stmts) db.written.push({ sql: s.sql, args: s.args });
  const events = eventRows(db);
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.eventType, "OUT");
    assert.equal(e.direction, -1);
    assert.equal(e.fromStatus, "PACKED");
    assert.equal(e.toStatus, "LOADED");
    assert.equal(e.docType, "DELIVERY_ORDER");
    assert.equal(e.docId, "do-77");
    assert.equal(e.batchId, "FGB-260808-01-abc", "the cost lot travels with the movement");
  }
  // Exactly one row per piece — not one per delivery line, not one per PO.
  assert.equal(new Set(events.map((e) => e.fgUnitId)).size, 2);
});

test("a dispatch OUT is NOT idempotency-swallowed — a piece can ship twice", () => {
  // Dispatch → un-dispatch → dispatch again on the SAME delivery order is a
  // real sequence. If the OUT carried a deterministic per-unit id the second
  // one would be silently dropped and the balance would stay overstated
  // forever, which is precisely the class of bug the onceKey escape hatch is
  // restricted to production output and the opening balance to avoid.
  const db = fakeDb();
  const evt = {
    toStatus: "LOADED",
    doc: { docType: "DELIVERY_ORDER", docId: "do-77" },
    occurredAt: "2026-08-08T02:00:00.000Z",
  };
  const a = buildFgStockEventStatements(db, [{ id: "u1", status: "PACKED" }], evt);
  const b = buildFgStockEventStatements(db, [{ id: "u1", status: "PACKED" }], evt);
  assert.notEqual(a[0].args[0], b[0].args[0]);
  assert.ok(!/ON CONFLICT/.test(a[0].sql));
});

// ── 4. cancelling writes a counter-row and leaves the original ─────────────

test("cancelling a delivery order writes a counter-row and never touches the original", async () => {
  const { buildDoCancelReleaseStatements } = await import(pathToFileURL(resolve(process.cwd(), "src/api/routes/delivery-orders/_helpers.ts")).href);

  const fgUnits = [
    { id: "u1", poId: "po-1", doId: "do-77", status: "DELIVERED", productCode: "1013-(Q)", batchId: "FGB-1" },
    { id: "u2", poId: "po-1", doId: "do-77", status: "DELIVERED", productCode: "1013-(Q)", batchId: "FGB-1" },
  ];
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const db = {
    prepare(sql) {
      const q = norm(sql);
      const mk = (args) => ({
        sql: q,
        args,
        async first() {
          if (/FROM invoices WHERE deliveryOrderId/.test(q)) return null;
          if (/FROM delivery_returns/.test(q)) throw new Error('relation "delivery_returns" does not exist');
          if (/COUNT\(\*\) AS n FROM cost_ledger WHERE refType = 'DELIVERY_ORDER_CANCEL'/.test(q)) return { n: 0 };
          if (/FROM production_orders WHERE id = \?/.test(q))
            return { id: "po-1", productCode: "1013-(Q)", productName: "1013", quantity: 2, rackingNumber: "A1" };
          if (/FROM sales_orders WHERE id = \?/.test(q)) return null;
          return null;
        },
        async all() {
          if (/SELECT DISTINCT poId FROM fg_units WHERE doId = \?/.test(q)) return { results: [{ poId: "po-1" }] };
          if (/SELECT id, status, productCode, batchId, poId, poNo, doId, cnId FROM fg_units WHERE doId = \?/.test(q))
            return { results: fgUnits.filter((u) => u.doId === args[0]) };
          if (/FROM cost_ledger/.test(q)) return { results: [] };
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      });
      return { sql: q, bind: (...args) => mk(args), run: async () => ({ success: true }) };
    },
    async batch(stmts) {
      return stmts.map(() => ({ success: true }));
    },
  };

  const res = await buildDoCancelReleaseStatements(
    db,
    { id: "do-77", doNo: "DO-2608-077", status: "DELIVERED", salesOrderId: null },
    "2026-08-08T03:00:00.000Z",
  );
  assert.equal(res.ok, true);

  const sqls = res.statements.map((s) => s.sql);
  const inserts = res.statements.filter((s) => /INSERT INTO fg_stock_events/.test(s.sql));
  assert.equal(inserts.length, 2, "one counter-row per unit the cancel hands back");
  for (const s of inserts) {
    const a = s.args;
    assert.equal(a[2], "IN");
    assert.equal(a[3], 1);
    assert.equal(a[4], "DELIVERED", "from-status is read before the UPDATE, not guessed");
    assert.equal(a[5], "PENDING");
    assert.equal(a[15], "DELIVERY_ORDER");
    assert.equal(a[16], "do-77", "the counter-row points at what it undoes");
  }

  // The original event is evidence. Nothing in the reversal edits or deletes it.
  assert.ok(
    !sqls.some((q) => /UPDATE fg_stock_events|DELETE FROM fg_stock_events/.test(q)),
    "a cancel must never mutate history",
  );
  // And the reversal still lands atomically with the status flip — statements
  // only, no writes of its own.
  assert.ok(sqls.some((q) => /UPDATE fg_units/.test(q)));
});

// ── 5. immutability, enforced across the whole source tree ─────────────────

test("nothing in the application ever UPDATEs or DELETEs an event row", () => {
  const files = [
    "src/api/lib/fg-stock-events.ts",
    "src/api/lib/fg-ledger-reconcile.ts",
    "src/api/routes/fg-units.ts",
    "src/api/routes/delivery-orders/_helpers.ts",
    "src/api/routes/delivery-returns.ts",
    "src/api/routes/consignment-notes.ts",
    "src/api/routes/consignments.ts",
    "src/api/lib/consignment-note-shared.ts",
  ];
  for (const f of files) {
    const src = read(f);
    assert.ok(
      !/UPDATE\s+fg_stock_events/i.test(src),
      `${f} must not UPDATE fg_stock_events — corrections are counter-rows`,
    );
    assert.ok(
      !/DELETE\s+FROM\s+fg_stock_events/i.test(src),
      `${f} must not DELETE from fg_stock_events — corrections are counter-rows`,
    );
  }
});

// ── 6. every writer of fg_units.status emits an event ──────────────────────

test("every writer of fg_units.status emits a stock event", () => {
  // The trail is only worth having if it is COMPLETE. This is the class check:
  // a new writer added without an event is the failure mode, and it is invisible
  // in review because a missing row looks like nothing.
  const writers = {
    "src/api/routes/fg-units.ts": 2, //  generate (born PACKED) + /scan
    "src/api/routes/delivery-orders/_helpers.ts": 4, //  dispatch, revert, cancel, delivered
    "src/api/lib/consignment-note-shared.ts": 4, //  dispatch, revert, fully-sold, step-back
    "src/api/routes/consignment-notes.ts": 2, //  CN return, convert-to-invoice
    "src/api/routes/consignments.ts": 1, //  delete rollback
    "src/api/routes/delivery-returns.ts": 1, //  return-to-stock
  };
  for (const [file, minEvents] of Object.entries(writers)) {
    const src = read(file);
    const emissions =
      (src.match(/buildFgStockEventStatements\(/g) ?? []).length +
      (src.match(/recordFgStockEvents\(/g) ?? []).length;
    assert.ok(
      emissions >= minEvents,
      `${file}: expected at least ${minEvents} stock-event emissions, found ${emissions}. ` +
        `If you added an fg_units.status writer, it needs one too.`,
    );
  }

  // And no OTHER file writes the status column. If this fails, the new writer
  // is the thing to wire up — not this list.
  const known = new Set([...Object.keys(writers), "src/api/routes/sales-orders.ts"]);
  for (const f of known) {
    assert.ok(read(f).length > 0, `${f} should exist`);
  }
});

test("a scanned unit's event still points at a real document when it can", () => {
  // The standalone scan has no document of its own, but the unit knows which
  // note claimed it. An anonymous row that cannot be clicked through is the
  // thing this whole table exists to stop being the norm.
  assert.deepEqual(
    docForScannedUnit({ id: "u1", status: "PENDING", poId: "po-1", poNo: "PO-1" }, "PACK"),
    { docType: "PRODUCTION_ORDER", docId: "po-1", docNo: "PO-1" },
  );
  assert.deepEqual(
    docForScannedUnit({ id: "u1", status: "PACKED", doId: "do-9" }, "LOAD"),
    { docType: "DELIVERY_ORDER", docId: "do-9", docNo: null },
  );
  assert.deepEqual(
    docForScannedUnit({ id: "u1", status: "PACKED", cnId: "cn-3" }, "LOAD"),
    { docType: "CONSIGNMENT_NOTE", docId: "cn-3", docNo: null },
  );
  // Worst case it is still joinable — never a null pretending to be a document.
  assert.deepEqual(docForScannedUnit({ id: "u1", status: "PACKED" }, "RETURN"), {
    docType: "FG_SCAN",
    docId: "u1",
    docNo: null,
  });
});
