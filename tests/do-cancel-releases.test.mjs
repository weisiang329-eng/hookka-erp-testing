// ---------------------------------------------------------------------------
// do-cancel-releases.test.mjs — a delivery order must be cancellable, and
// cancelling it must hand everything back.
//
// THE HOLE (2026-08-07). A DO past DRAFT was IMMORTAL. VALID_TRANSITIONS had
// no CANCELLED target from any status, nothing anywhere wrote
// delivery_orders.status='CANCELLED', and DELETE refuses anything but DRAFT.
//
// The damage was not cosmetic. validateDoComposition's once-only-delivery
// guard rejects any production order sitting on a DO whose status is
// `!= 'CANCELLED'` — so the POs on a wrong delivery note were locked out of
// EVERY future delivery note, permanently. Those goods could never be shipped
// on a correct document. Owner's rule: "这种转换不是整张单锁死的" — a
// conversion must never lock permanently.
//
// This file pins the behaviour, not the wiring:
//   • cancelling releases the production orders (the duplicate guard goes
//     true again) and steps the sales order back to READY_TO_SHIP;
//   • it reverses exactly what the progression wrote — fg_units, a STOCK_IN
//     counter-movement, and the FIFO FG_DELIVERED COGS;
//   • it REFUSES while an invoice is alive, and refuses when a Delivery
//     Return already credited part of the goods back — because a
//     half-reversal corrupts the ledger worse than no reversal at all.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const DO_HELPERS = read("src/api/routes/delivery-orders/_helpers.ts");
const LOCKS = read("src/api/lib/lock-helpers.ts");

const { VALID_TRANSITIONS, buildDoCancelReleaseStatements } = await import(pathToFileURL(resolve(process.cwd(), "src/api/routes/delivery-orders/_helpers.ts")).href);

// ── A fake D1 answering from plain arrays ──────────────────────────────────

function fakeDb({
  invoices = [],
  deliveryOrders = [],
  salesOrders = [],
  doItems = [],
  prodOrders = [],
  fgUnits = [],
  costLedger = [],
  deliveryReturns = null, // null = tables absent (the query throws)
} = {}) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  return {
    prepare(sql) {
      const q = norm(sql);
      return {
        // The FG stock ledger self-applies its DDL before it reads (migration
        // files are inert on deploy in this repo). Parameterless .run().
        async run() {
          return { success: true };
        },
        bind(...args) {
          return {
            sql: q,
            args,
            async first() {
              if (/FROM invoices WHERE deliveryOrderId = \? AND status != 'CANCELLED'/.test(q)) {
                return invoices.find((i) => i.deliveryOrderId === args[0] && i.status !== "CANCELLED") ?? null;
              }
              if (/FROM delivery_returns WHERE delivery_order_id = \?/.test(q)) {
                if (deliveryReturns === null) throw new Error('relation "delivery_returns" does not exist');
                return deliveryReturns.find((r) => r.deliveryOrderId === args[0]) ?? null;
              }
              if (/COUNT\(\*\) AS n FROM cost_ledger WHERE refType = 'DELIVERY_ORDER_CANCEL'/.test(q)) {
                return { n: costLedger.filter((r) => r.refType === "DELIVERY_ORDER_CANCEL" && r.refId === args[0]).length };
              }
              if (/FROM production_orders WHERE id = \?/.test(q)) {
                return prodOrders.find((p) => p.id === args[0]) ?? null;
              }
              if (/FROM sales_orders WHERE id = \?/.test(q)) {
                return salesOrders.find((s) => s.id === args[0]) ?? null;
              }
              if (/FROM delivery_orders WHERE id IN/.test(q)) {
                const ids = args;
                return (
                  deliveryOrders.find(
                    (d) => ids.includes(d.id) && ["LOADED", "IN_TRANSIT", "DELIVERED", "INVOICED"].includes(d.status),
                  ) ?? null
                );
              }
              throw new Error("unexpected first() query: " + q);
            },
            async all() {
              if (/SELECT DISTINCT poId FROM fg_units WHERE doId = \?/.test(q)) {
                const ids = new Set(fgUnits.filter((u) => u.doId === args[0]).map((u) => u.poId));
                return { results: [...ids].map((poId) => ({ poId })) };
              }
              // The FG stock ledger reads the FROM side with the SAME predicate
              // the UPDATE uses, so the counter-rows describe exactly the units
              // that move.
              if (/SELECT id, status, productCode, batchId, poId, poNo, doId, cnId FROM fg_units WHERE doId = \?/.test(q)) {
                return { results: fgUnits.filter((u) => u.doId === args[0]) };
              }
              if (/FROM cost_ledger\s+WHERE refType = 'DELIVERY_ORDER' AND refId = \? AND type = 'FG_DELIVERED'/.test(q)) {
                return {
                  results: costLedger.filter(
                    (r) => r.refType === "DELIVERY_ORDER" && r.refId === args[0] && r.type === "FG_DELIVERED",
                  ),
                };
              }
              if (/po\.salesOrderId AS soId/.test(q)) {
                const ids = new Set();
                for (const di of doItems.filter((d) => d.deliveryOrderId === args[0])) {
                  const po = prodOrders.find((p) => p.id === di.productionOrderId);
                  if (po?.salesOrderId) ids.add(po.salesOrderId);
                }
                return { results: [...ids].map((soId) => ({ soId })) };
              }
              if (/SELECT id AS "doId" FROM delivery_orders WHERE salesOrderId = \?/.test(q)) {
                return { results: deliveryOrders.filter((d) => d.salesOrderId === args[0]).map((d) => ({ doId: d.id })) };
              }
              if (/SELECT DISTINCT di\.deliveryOrderId AS "doId"/.test(q)) {
                const ids = new Set();
                for (const po of prodOrders.filter((p) => p.salesOrderId === args[0])) {
                  for (const di of doItems.filter((d) => d.productionOrderId === po.id)) {
                    if (di.deliveryOrderId) ids.add(di.deliveryOrderId);
                  }
                }
                return { results: [...ids].map((doId) => ({ doId })) };
              }
              throw new Error("unexpected all() query: " + q);
            },
          };
        },
      };
    },
  };
}

// One DO carrying one PO of one SO, delivered, its invoice already voided.
const delivered = (over = {}) => ({
  invoices: [{ id: "inv-1", deliveryOrderId: "do-1", status: "CANCELLED" }],
  deliveryOrders: [{ id: "do-1", doNo: "DO-2608-001", status: "DELIVERED", salesOrderId: "so-1" }],
  salesOrders: [{ id: "so-1", status: "DELIVERED" }],
  doItems: [{ deliveryOrderId: "do-1", productionOrderId: "po-1" }],
  prodOrders: [{ id: "po-1", poNo: "PO-1", salesOrderId: "so-1", productCode: "BF-A", productName: "Bedframe A", quantity: 2, rackingNumber: "R1" }],
  fgUnits: [
    { id: "fgu-po-1-1-1", doId: "do-1", poId: "po-1", status: "DELIVERED", productCode: "BF-A", batchId: "b-1" },
    { id: "fgu-po-1-2-1", doId: "do-1", poId: "po-1", status: "DELIVERED", productCode: "BF-A", batchId: "b-1" },
  ],
  costLedger: [
    { refType: "DELIVERY_ORDER", refId: "do-1", type: "FG_DELIVERED", itemId: "prod-a", batchId: "b-1", qty: 2, unitCostSen: 15000 },
  ],
  ...over,
});

const cancelArgs = { id: "do-1", doNo: "DO-2608-001", status: "DELIVERED", salesOrderId: "so-1" };
const NOW = "2026-08-07T00:00:00.000Z";
const sqlOf = (stmts) => stmts.map((s) => s.sql);

// ── Wall 1: the status machine had no CANCELLED target at all ───────────────

test("CANCELLED is reachable from every live status", () => {
  for (const from of ["DRAFT", "LOADED", "IN_TRANSIT", "DELIVERED", "INVOICED"]) {
    assert.ok(
      VALID_TRANSITIONS[from].includes("CANCELLED"),
      `${from} had no way out — a wrong DO in that state was permanent`,
    );
  }
  assert.deepEqual(VALID_TRANSITIONS.CANCELLED, [], "a cancelled DO is evidence, not a workspace");
});

// ── Wall 2: cancelling releases the production orders ───────────────────────

test("the once-only-delivery guard skips cancelled DOs, so cancelling frees the POs", () => {
  // This is the whole point: validateDoComposition rejects a PO already on a
  // DO whose status is != 'CANCELLED'. Cancelling makes that predicate false,
  // which is what lets the goods go onto a correct delivery note.
  assert.match(
    DO_HELPERS,
    /FROM delivery_order_items di\s*\n\s*JOIN delivery_orders d ON d\.id = di\.deliveryOrderId\s*\n\s*WHERE di\.productionOrderId IN \(\$\{placeholders\}\)\s*\n\s*AND d\.status != 'CANCELLED'/,
  );
});

test("cancelling steps the sales order back to READY_TO_SHIP, audited", async () => {
  const r = await buildDoCancelReleaseStatements(fakeDb(delivered()), cancelArgs, NOW);
  assert.equal(r.ok, true);
  const sql = sqlOf(r.statements);
  assert.ok(
    sql.some((s) => /UPDATE sales_orders SET status = 'READY_TO_SHIP'.*WHERE id = \? AND status = \?/.test(s)),
    "the SO must re-enter the shippable queue, guarded on its from-status",
  );
  const audit = r.statements.find((s) => /INSERT INTO so_status_changes/.test(s.sql));
  assert.ok(audit, "every SO cascade in this codebase writes an so_status_changes row");
  assert.ok(audit.args.includes("DELIVERED") && audit.args.includes("READY_TO_SHIP"));
  assert.deepEqual(r.releasedSoIds, ["so-1"]);
});

// ── Wall 3: it reverses exactly what the progression wrote ─────────────────

test("fg_units are handed back — both the LOADED stamp and the DELIVERED stamp", async () => {
  const r = await buildDoCancelReleaseStatements(fakeDb(delivered()), cancelArgs, NOW);
  const stmt = r.statements.find((s) => /UPDATE fg_units/.test(s.sql));
  assert.ok(stmt, "units left stamped with a dead doId double-count in the warehouse view");
  assert.match(stmt.sql, /doId = NULL/);
  assert.match(stmt.sql, /status = 'PENDING'/);
  assert.match(stmt.sql, /loadedAt = NULL/);
  assert.match(stmt.sql, /deliveredAt = NULL/);
});

test("a STOCK_IN counter-movement is appended, not a deletion of history", async () => {
  const r = await buildDoCancelReleaseStatements(fakeDb(delivered()), cancelArgs, NOW);
  const sql = sqlOf(r.statements);
  assert.ok(sql.some((s) => /INSERT INTO stock_movements .*'STOCK_IN'/s.test(s)));
  assert.equal(
    sql.filter((s) => /DELETE FROM stock_movements/.test(s)).length,
    0,
    "stock_movements is immutable history — the round-trip is shown, not erased",
  );
});

test("the FG stock ledger gets a counter-row per unit, and history is not edited", async () => {
  // The per-piece stock ledger follows the SAME append-only rule as
  // stock_movements above: the OUT written at dispatch stays exactly as it was
  // and the return of the goods is a second row pointing back at it. Anything
  // else and a cancelled delivery would erase the evidence that it happened.
  const r = await buildDoCancelReleaseStatements(fakeDb(delivered()), cancelArgs, NOW);
  const events = r.statements.filter((s) => /INSERT INTO fg_stock_events/.test(s.sql));
  assert.equal(events.length, 2, "one per unit the DO claimed");
  for (const e of events) {
    assert.equal(e.args[2], "IN");
    assert.equal(e.args[3], 1, "direction is derived from DELIVERED → PENDING, not hand-chosen");
    assert.equal(e.args[4], "DELIVERED", "the from-status is READ, not assumed");
    assert.equal(e.args[16], "do-1", "the counter-row names what it reverses");
  }
  assert.equal(
    sqlOf(r.statements).filter((s) => /UPDATE fg_stock_events|DELETE FROM fg_stock_events/.test(s))
      .length,
    0,
  );
});

test("a DRAFT DO writes no STOCK_IN — it never wrote a STOCK_OUT", async () => {
  const d = delivered();
  d.deliveryOrders[0].status = "DRAFT";
  d.salesOrders[0].status = "READY_TO_SHIP";
  d.costLedger = [];
  const r = await buildDoCancelReleaseStatements(
    fakeDb(d),
    { ...cancelArgs, status: "DRAFT" },
    NOW,
  );
  assert.equal(
    sqlOf(r.statements).filter((s) => /INSERT INTO stock_movements/.test(s)).length,
    0,
    "crediting stock that never left would inflate the racking ledger",
  );
});

test("the FIFO FG_DELIVERED COGS is credited back, slice for slice", async () => {
  const r = await buildDoCancelReleaseStatements(fakeDb(delivered()), cancelArgs, NOW);
  const back = r.statements.find((s) => /UPDATE fg_batches SET remainingQty = remainingQty \+ \?/.test(s.sql));
  assert.ok(back, "the FIFO layers this DO drew down must be refilled");
  assert.deepEqual(back.args, [2, "b-1"], "give back exactly what that slice took, to the batch it took it from");
  const rev = r.statements.find((s) => /INSERT INTO cost_ledger/.test(s.sql));
  assert.ok(rev, "the COGS reversal needs its own ledger row — cost_ledger is append-only");
  assert.ok(rev.sql.includes("'DELIVERY_ORDER_CANCEL'"), "traceable + idempotent by refType");
  assert.equal(r.reversedCogsSen, 30000, "2 units × RM 150.00 comes back off COGS");
});

test("cancelling a DO that never delivered reverses no COGS", async () => {
  const d = delivered();
  d.costLedger = [];
  d.deliveryOrders[0].status = "LOADED";
  d.salesOrders[0].status = "SHIPPED";
  const r = await buildDoCancelReleaseStatements(fakeDb(d), { ...cancelArgs, status: "LOADED" }, NOW);
  assert.equal(r.reversedCogsSen, 0);
  assert.equal(sqlOf(r.statements).filter((s) => /fg_batches/.test(s)).length, 0);
});

test("a second cancel is a no-op on the ledger (idempotent)", async () => {
  const d = delivered();
  d.costLedger.push({ refType: "DELIVERY_ORDER_CANCEL", refId: "do-1", type: "ADJUSTMENT" });
  const r = await buildDoCancelReleaseStatements(fakeDb(d), cancelArgs, NOW);
  assert.equal(r.reversedCogsSen, 0);
  assert.equal(
    sqlOf(r.statements).filter((s) => /fg_batches|INSERT INTO cost_ledger/.test(s)).length,
    0,
    "replaying the reversal would credit the same goods twice",
  );
});

// ── Wall 4: it REFUSES rather than half-reversing ──────────────────────────

test("it refuses while a live invoice bills the DO, and says to void it first", async () => {
  const d = delivered();
  d.invoices = [{ id: "inv-9", invoiceNo: "INV-2608-009", deliveryOrderId: "do-1", status: "SENT" }];
  const r = await buildDoCancelReleaseStatements(fakeDb(d), cancelArgs, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /INV-2608-009/);
  assert.match(r.error, /[Vv]oid that invoice first/);
});

test("a CANCELLED invoice does not block the cancel", async () => {
  const r = await buildDoCancelReleaseStatements(fakeDb(delivered()), cancelArgs, NOW);
  assert.equal(r.ok, true, "a dead invoice bills nobody — it must not keep the DO immortal");
});

test("it refuses when a Delivery Return already credited part of the goods back", async () => {
  // reverseFGForDeliveryReturn ALREADY handed some of this DO's FG
  // consumption back, and cancelling the return does not undo that. Replaying
  // every FG_DELIVERED slice on top would credit the same units twice.
  const d = delivered({ deliveryReturns: [{ id: "dr-1", deliveryOrderId: "do-1", status: "OPEN" }] });
  const r = await buildDoCancelReleaseStatements(fakeDb(d), cancelArgs, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /twice/);
});

test("a refusal writes NOTHING — no half-reversed ledger", async () => {
  const d = delivered();
  d.invoices = [{ id: "inv-9", invoiceNo: "INV-9", deliveryOrderId: "do-1", status: "SENT" }];
  const r = await buildDoCancelReleaseStatements(fakeDb(d), cancelArgs, NOW);
  assert.equal(r.statements, undefined, "the refusal branch returns no statements at all");
});

// ── The thing that must NOT happen ─────────────────────────────────────────

test("a sales order still carried by a live sibling DO keeps its status", async () => {
  const d = delivered();
  d.deliveryOrders.push({ id: "do-2", doNo: "DO-2608-002", status: "DELIVERED", salesOrderId: "so-1" });
  const r = await buildDoCancelReleaseStatements(fakeDb(d), cancelArgs, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.releasedSoIds, [], "that other delivery really happened — do not un-ship it");
  assert.equal(sqlOf(r.statements).filter((s) => /UPDATE sales_orders/.test(s)).length, 0);
});

test("an INVOICED or CLOSED sales order is never dragged back", async () => {
  for (const st of ["INVOICED", "CLOSED", "CANCELLED", "IN_PRODUCTION"]) {
    const d = delivered();
    d.salesOrders[0].status = st;
    const r = await buildDoCancelReleaseStatements(fakeDb(d), cancelArgs, NOW);
    assert.equal(
      sqlOf(r.statements).filter((s) => /UPDATE sales_orders/.test(s)).length,
      0,
      `${st} is somebody else's state — only SHIPPED / DELIVERED were written by this DO`,
    );
  }
});

test("rack_items are NOT re-inserted — nobody physically refilled the rack", async () => {
  const r = await buildDoCancelReleaseStatements(fakeDb(delivered()), cancelArgs, NOW);
  assert.equal(
    sqlOf(r.statements).filter((s) => /rack_items/.test(s)).length,
    0,
    "same rule the LOADED → DRAFT reversal follows; the operator re-scans the pieces to a rack",
  );
});

// ── The guard that only becomes live once a DO can be cancelled ────────────

test("a cancelled invoice no longer locks its delivery order", () => {
  // The void path reverses the GL + A/R and explicitly hands the DO back, yet
  // this lock counted the dead invoice — so the DO could be re-billed but
  // never corrected first, and the error text told the operator to do the one
  // thing that would not help ("void the invoice").
  assert.match(
    LOCKS,
    /SELECT invoiceNo FROM invoices\s*\n\s*WHERE deliveryOrderId = \? AND status <> 'CANCELLED' LIMIT 1/,
  );
});
