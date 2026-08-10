// ---------------------------------------------------------------------------
// do-partial-invoice.test.mjs — one delivery order, several invoices.
//
// THE HOLE (2026-08-07). Invoicing a delivery was ONE-SHOT and WHOLE-DOCUMENT.
// `delivery_order_items` had `quantity` and no consumed counter; `invoice_items`
// had no link to the DO line it billed; and a partial unique index
// (`uniq_invoice_active_delivery_order`) forbade a second live invoice at the
// storage layer. So a delivery was billed entirely or not at all, and a wrong
// invoice could only be replaced, never trimmed.
//
// Purchasing has done this correctly for a long time — grn_items.invoiced_qty
// plus purchase_invoice_items.grn_item_id — which is what lets a goods receipt
// be billed across several purchase invoices and hand quantities back when one
// dies. Owner's rule is the same for the sales side: 「我应该可以在其中一个
// Purchase Invoice 里面 delete 掉，然后重新 generate 成另外一个 Invoice」.
//
// This file runs the chain against a small in-memory book and asserts what the
// operator would experience, not how it is wired:
//   • a delivery billed in two halves reaches fully-invoiced and refuses a third;
//   • voiding one of two invoices frees ONLY its own quantities;
//   • dropping a line from a DRAFT invoice gives that line's quantity back;
//   • the DO's own status follows the counters, both ways;
//   • and — the part that could invite double-billing — a delivery already
//     billed by a pre-existing (link-less) invoice still reads as fully
//     invoiced and is NOT re-billable.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const {
  loadDoBillingState,
  doBillingRefusal,
  buildDrawdownStatements,
  buildInvoiceLineReleaseStatements,
  buildDoStatusSyncStatement,
} = await import(pathToFileURL(resolve(process.cwd(), "src/api/lib/do-partial-invoice.ts")).href);

const { computeDoInvoiceLines } = await import(pathToFileURL(resolve(process.cwd(), "src/api/routes/delivery-orders/_helpers.ts")).href);

// ── A tiny in-memory book ──────────────────────────────────────────────────
//
// Statements are objects, not writes — every producer in this chain returns
// them for the caller's batch. `apply` is the test's stand-in for db.batch(),
// so a two-invoice sequence really moves the counters between steps.

function book() {
  return {
    deliveryOrders: [
      { id: "do-1", doNo: "DO-2608-001", status: "DELIVERED", orgId: "hookka", salesOrderId: "so-1" },
    ],
    // 4 chairs + 2 tables delivered on one note.
    doItems: [
      { id: "di-1", deliveryOrderId: "do-1", productionOrderId: "po-1", productCode: "CHAIR", productName: "Chair", sizeLabel: "", fabricCode: "", quantity: 4, invoiced_qty: 0 },
      { id: "di-2", deliveryOrderId: "do-1", productionOrderId: "po-2", productCode: "TABLE", productName: "Table", sizeLabel: "", fabricCode: "", quantity: 2, invoiced_qty: 0 },
    ],
    prodOrders: [
      { id: "po-1", orgId: "hookka", salesOrderId: "so-1", productCode: "CHAIR", sizeCode: "", fabricCode: "" },
      { id: "po-2", orgId: "hookka", salesOrderId: "so-1", productCode: "TABLE", sizeCode: "", fabricCode: "" },
    ],
    salesOrders: [{ id: "so-1", orgId: "hookka", status: "DELIVERED", totalSen: 0 }],
    soItems: [
      { salesOrderId: "so-1", productCode: "CHAIR", sizeCode: "", fabricCode: "", unitPriceSen: 10000, quantity: 4, lineTotalSen: 40000 },
      { salesOrderId: "so-1", productCode: "TABLE", sizeCode: "", fabricCode: "", unitPriceSen: 50000, quantity: 2, lineTotalSen: 100000 },
    ],
    invoices: [],
    invoiceItems: [],
  };
}

function fakeDb(b) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const answerFirst = (q, args) => {
    if (/SELECT orgId, salesOrderId FROM delivery_orders WHERE id = \?/.test(q)) {
      return b.deliveryOrders.find((d) => d.id === args[0]) ?? null;
    }
    if (/SELECT id FROM invoice_items WHERE invoiceId = \? AND delivery_order_item_id IS NOT NULL/.test(q)) {
      return b.invoiceItems.find((it) => it.invoiceId === args[0] && it.delivery_order_item_id) ?? null;
    }
    if (/SELECT invoiced_qty AS "invoicedQty" FROM delivery_order_items WHERE id = \?/.test(q)) {
      const di = b.doItems.find((d) => d.id === args[0]);
      return di ? { invoicedQty: di.invoiced_qty } : null;
    }
    if (/COALESCE\(SUM\(totalSen\), 0\) AS t FROM sales_orders/.test(q)) {
      return { t: b.salesOrders.filter((s) => args.includes(s.id)).reduce((n, s) => n + s.totalSen, 0) };
    }
    throw new Error("unexpected first(): " + q);
  };
  const answerAll = (q, args) => {
    if (/FROM delivery_order_items\s+WHERE deliveryOrderId = \?/.test(q)) {
      return {
        results: b.doItems
          .filter((d) => d.deliveryOrderId === args[0])
          .map((d) => ({ ...d, invoicedQty: d.invoiced_qty })),
      };
    }
    if (/SELECT id, invoiceNo, status FROM invoices\s+WHERE deliveryOrderId = \? AND status <> 'CANCELLED'/.test(q)) {
      return { results: b.invoices.filter((i) => i.deliveryOrderId === args[0] && i.status !== "CANCELLED") };
    }
    if (/delivery_order_item_id AS "deliveryOrderItemId", quantity\s+FROM invoice_items WHERE invoiceId = \?/.test(q)) {
      return {
        results: b.invoiceItems
          .filter((it) => it.invoiceId === args[0])
          .map((it) => ({ deliveryOrderItemId: it.delivery_order_item_id, quantity: it.quantity })),
      };
    }
    if (/FROM production_orders WHERE orgId = \?/.test(q)) {
      return { results: b.prodOrders.filter((p) => p.orgId === args[0]) };
    }
    if (/FROM sales_order_items si JOIN sales_orders s/.test(q)) {
      return { results: b.soItems };
    }
    if (/FROM sales_order_items WHERE salesOrderId IN/.test(q)) {
      return { results: b.soItems.filter((si) => args.includes(si.salesOrderId)) };
    }
    if (/FROM delivery_return_items dri/.test(q)) {
      throw new Error('relation "delivery_returns" does not exist');
    }
    throw new Error("unexpected all(): " + q);
  };
  return {
    prepare(sql) {
      const q = norm(sql);
      return {
        async run() { return { success: true }; },      // DDL self-applies
        bind(...args) {
          return {
            sql: q,
            args,
            async run() { return { success: true }; },
            async first() { return answerFirst(q, args); },
            async all() { return answerAll(q, args); },
          };
        },
      };
    },
  };
}

/** The test's db.batch(): interpret the counter statements against the book. */
function apply(b, statements) {
  for (const st of statements) {
    let m = /^UPDATE delivery_order_items SET invoiced_qty = invoiced_qty \+ \? WHERE id = \?$/.exec(st.sql);
    if (m) {
      const di = b.doItems.find((d) => d.id === st.args[1]);
      di.invoiced_qty += st.args[0];
      continue;
    }
    m = /^UPDATE delivery_order_items SET invoiced_qty = invoiced_qty - \? WHERE id = \?$/.exec(st.sql);
    if (m) {
      const di = b.doItems.find((d) => d.id === st.args[1]);
      di.invoiced_qty -= st.args[0];
      continue;
    }
    m = /^UPDATE delivery_orders SET status = '(\w+)'/.exec(st.sql);
    if (m) {
      const d = b.deliveryOrders.find((x) => x.id === st.args[1]);
      if (d) d.status = m[1];
      continue;
    }
  }
}

/** Raise an invoice for a picked set of lines, exactly as POST /api/invoices does. */
async function raiseInvoice(b, id, select) {
  const db = fakeDb(b);
  const st = await loadDoBillingState(db, "do-1");
  const refusal = doBillingRefusal("DO-2608-001", st);
  if (refusal) return { ok: false, error: refusal };
  const { invItems, computedTotal, draws } = await computeDoInvoiceLines(
    db, "do-1", ["so-1"], select ?? null,
  );
  if (invItems.length === 0) return { ok: false, error: "nothing to invoice" };
  const drawn = buildDrawdownStatements(db, st, draws);
  if (!drawn.ok) return { ok: false, error: drawn.error };
  const drawnQty = draws.reduce((n, d) => n + d.quantity, 0);
  const fullyBilledAfter = draws.length === 0 || st.remainingQty - drawnQty <= 0;
  apply(b, drawn.statements);
  b.invoices.push({ id, invoiceNo: id.toUpperCase(), deliveryOrderId: "do-1", status: "SENT" });
  for (const it of invItems) {
    b.invoiceItems.push({
      id: it.id, invoiceId: id, quantity: it.quantity,
      delivery_order_item_id: it.deliveryOrderItemId,
      totalSen: it.totalSen,
    });
  }
  const sync = buildDoStatusSyncStatement(
    db, "do-1", b.deliveryOrders[0].status, fullyBilledAfter, "2026-08-07T00:00:00.000Z",
  );
  if (sync) apply(b, [sync]);
  return { ok: true, invItems, computedTotal, drawnQty };
}

/** Void an invoice: release its quantities, then re-derive the DO's status. */
async function voidInvoice(b, id) {
  const db = fakeDb(b);
  const release = await buildInvoiceLineReleaseStatements(db, id);
  apply(b, release);
  b.invoices.find((i) => i.id === id).status = "CANCELLED";
  const st = await loadDoBillingState(fakeDb(b), "do-1");
  const sync = buildDoStatusSyncStatement(
    fakeDb(b), "do-1", b.deliveryOrders[0].status, st.fullyInvoiced, "2026-08-07T00:00:00.000Z",
  );
  if (sync) apply(b, [sync]);
}

const qtyOf = (b) => b.doItems.map((d) => `${d.id}:${d.invoiced_qty}/${d.quantity}`).join(" ");

// ── The headline: a delivery billed in two halves ──────────────────────────

test("a delivery billed in two halves reaches fully-invoiced and refuses a third", async () => {
  const b = book();

  // First invoice: the 4 chairs only.
  const first = await raiseInvoice(b, "inv-1", [{ deliveryOrderItemId: "di-1", quantity: 4 }]);
  assert.equal(first.ok, true);
  assert.equal(first.computedTotal, 40000, "4 chairs at RM 100.00 — the tables are not on this bill");
  assert.equal(qtyOf(b), "di-1:4/4 di-2:0/2");
  assert.equal(
    b.deliveryOrders[0].status, "DELIVERED",
    "a HALF-billed delivery must stay DELIVERED — flipping it to INVOICED is what made the rest unbillable",
  );

  // Second invoice: whatever is left. No selection — "bill the remainder".
  const second = await raiseInvoice(b, "inv-2", null);
  assert.equal(second.ok, true);
  assert.equal(second.invItems.length, 1, "the chairs are spent; only the tables remain");
  assert.equal(second.invItems[0].productCode, "TABLE");
  assert.equal(second.computedTotal, 100000);
  assert.equal(qtyOf(b), "di-1:4/4 di-2:2/2");
  assert.equal(b.deliveryOrders[0].status, "INVOICED", "the LAST slice is what flips it");

  // Third: nothing left.
  const third = await raiseInvoice(b, "inv-3", null);
  assert.equal(third.ok, false);
  assert.match(third.error, /fully invoiced/);
  assert.match(third.error, /all 6 delivered unit\(s\)/, "the refusal must carry the numbers, not just 'already invoiced'");
});

test("the two halves together bill exactly the delivery, no more and no less", async () => {
  const b = book();
  const a = await raiseInvoice(b, "inv-1", [{ deliveryOrderItemId: "di-1", quantity: 4 }]);
  const c = await raiseInvoice(b, "inv-2", null);
  assert.equal(a.computedTotal + c.computedTotal, 140000, "4×RM100 + 2×RM500 — split billing must not change the money");
});

test("a line can be billed in two goes, not just a whole line at a time", async () => {
  const b = book();
  await raiseInvoice(b, "inv-1", [{ deliveryOrderItemId: "di-1", quantity: 1 }]);
  assert.equal(qtyOf(b), "di-1:1/4 di-2:0/2");
  const st = await loadDoBillingState(fakeDb(b), "do-1");
  assert.equal(st.lines[0].remainingQty, 3);
  assert.equal(st.remainingQty, 5);
  assert.equal(doBillingRefusal("DO-2608-001", st), null, "5 units left — the delivery is still billable");
});

test("over-drawing a line is refused with the numbers, never silently clamped", async () => {
  const b = book();
  const db = fakeDb(b);
  const st = await loadDoBillingState(db, "do-1");
  const r = buildDrawdownStatements(db, st, [{ deliveryOrderItemId: "di-2", quantity: 5 }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /requested 5 exceeds the 2 still un-invoiced/);
  assert.match(r.error, /delivered 2, already billed 0/);
});

// ── Release: every increment paired with its decrement ────────────────────

test("voiding one of two invoices frees ONLY its own quantities", async () => {
  const b = book();
  await raiseInvoice(b, "inv-1", [{ deliveryOrderItemId: "di-1", quantity: 4 }]);
  await raiseInvoice(b, "inv-2", [{ deliveryOrderItemId: "di-2", quantity: 2 }]);
  assert.equal(qtyOf(b), "di-1:4/4 di-2:2/2");
  assert.equal(b.deliveryOrders[0].status, "INVOICED");

  await voidInvoice(b, "inv-1");
  assert.equal(
    qtyOf(b), "di-1:0/4 di-2:2/2",
    "the chairs come back; the tables are still genuinely billed by the surviving invoice",
  );
  assert.equal(
    b.deliveryOrders[0].status, "DELIVERED",
    "the delivery is no longer fully billed, so it must be billable again",
  );

  // …and the freed half can be re-issued as a different invoice. That is the
  // owner's rule in one line: delete one, generate another.
  const re = await raiseInvoice(b, "inv-3", null);
  assert.equal(re.ok, true);
  assert.equal(re.invItems.length, 1);
  assert.equal(re.invItems[0].productCode, "CHAIR");
  assert.equal(re.invItems[0].quantity, 4);
  assert.equal(qtyOf(b), "di-1:4/4 di-2:2/2");
});

test("a restore can never drive a counter below zero", async () => {
  const b = book();
  await raiseInvoice(b, "inv-1", [{ deliveryOrderItemId: "di-1", quantity: 2 }]);
  await voidInvoice(b, "inv-1");
  assert.equal(qtyOf(b), "di-1:0/4 di-2:0/2");
  // Replay the same release (a retry, a double-click, a re-run of the void).
  const again = await buildInvoiceLineReleaseStatements(fakeDb(b), "inv-1");
  apply(b, again);
  assert.equal(qtyOf(b), "di-1:0/4 di-2:0/2", "clampDecrement is what stops a double-restore going negative");
});

// ── Backwards compatibility: the part that could invite double-billing ────

test("a delivery already billed by a pre-existing link-less invoice is NOT re-billable", async () => {
  // Every invoice raised before this change has lines with no
  // delivery_order_item_id, and the new counters read 0. Deriving billed state
  // from the counters ALONE would make every already-billed delivery in the
  // book read as unbilled — the system would invite the operator to charge the
  // customer twice.
  const b = book();
  b.invoices.push({ id: "inv-old", invoiceNo: "INV-2605-042", deliveryOrderId: "do-1", status: "SENT" });
  b.invoiceItems.push(
    { id: "ii-1", invoiceId: "inv-old", quantity: 4, delivery_order_item_id: null, totalSen: 40000 },
    { id: "ii-2", invoiceId: "inv-old", quantity: 2, delivery_order_item_id: null, totalSen: 100000 },
  );

  const st = await loadDoBillingState(fakeDb(b), "do-1");
  assert.equal(st.invoicedQty, 0, "the counters genuinely are zero — nothing was backfilled");
  assert.equal(st.remainingQty, 6);
  assert.ok(st.legacyInvoice, "…but the link-less live invoice is recognised for what it is");
  assert.equal(st.fullyInvoiced, true, "so the delivery still reads as fully billed");

  const attempt = await raiseInvoice(b, "inv-new", null);
  assert.equal(attempt.ok, false);
  assert.match(attempt.error, /already invoiced \(INV-2605-042\)/);
  assert.match(attempt.error, /Cancel that invoice before re-invoicing/, "the exact wording operators already know");
});

test("voiding the legacy invoice makes the delivery billable again, from zero", async () => {
  const b = book();
  b.invoices.push({ id: "inv-old", invoiceNo: "INV-2605-042", deliveryOrderId: "do-1", status: "SENT" });
  b.invoiceItems.push({ id: "ii-1", invoiceId: "inv-old", quantity: 6, delivery_order_item_id: null, totalSen: 140000 });

  await voidInvoice(b, "inv-old");
  assert.equal(qtyOf(b), "di-1:0/4 di-2:0/2", "a link-less invoice consumed nothing, so it releases nothing");
  const st = await loadDoBillingState(fakeDb(b), "do-1");
  assert.equal(st.fullyInvoiced, false, "a cancelled invoice bills nobody");
  const re = await raiseInvoice(b, "inv-1", null);
  assert.equal(re.ok, true);
  assert.equal(re.computedTotal, 140000, "and the whole delivery is billable again — exactly today's behaviour");
});

test("two legacy invoices: voiding one does not make the delivery look free", async () => {
  const b = book();
  b.invoices.push(
    { id: "inv-a", invoiceNo: "INV-A", deliveryOrderId: "do-1", status: "SENT" },
    { id: "inv-b", invoiceNo: "INV-B", deliveryOrderId: "do-1", status: "SENT" },
  );
  b.invoiceItems.push(
    { id: "ii-a", invoiceId: "inv-a", quantity: 4, delivery_order_item_id: null, totalSen: 40000 },
    { id: "ii-b", invoiceId: "inv-b", quantity: 2, delivery_order_item_id: null, totalSen: 100000 },
  );
  await voidInvoice(b, "inv-a");
  const st = await loadDoBillingState(fakeDb(b), "do-1");
  assert.equal(st.fullyInvoiced, true, "INV-B still owns this delivery whole — it is a link-less bill");
  assert.equal(st.legacyInvoice.invoiceNo, "INV-B");
});

test("no backfill of invoiced_qty exists anywhere — the guess would license double-billing", () => {
  // A backfill would have to map old invoice lines to DO lines by product code,
  // and two of the three invoice-building fallbacks produce lines with no DO
  // line behind them at all. A mapping that lands SHORT silently allows the
  // difference to be billed twice. Refusing is recoverable; a double-charged
  // customer is not.
  const MIG = read("migrations-postgres/0214_do_partial_invoice.sql");
  assert.doesNotMatch(MIG, /UPDATE delivery_order_items\s+SET invoiced_qty\s*=/i);
  assert.match(MIG, /deliberately NO backfill/i, "and the decision must be written down where the next person looks");
});

// ── The DO's own status flag follows the counters, both ways ──────────────

test("the status flag is derived, not authoritative", () => {
  const db = fakeDb(book());
  const now = "2026-08-07T00:00:00.000Z";
  const up = buildDoStatusSyncStatement(db, "do-1", "DELIVERED", true, now);
  assert.match(up.sql, /status = 'INVOICED'.*WHERE id = \? AND status = 'DELIVERED'/s);
  const down = buildDoStatusSyncStatement(db, "do-1", "INVOICED", false, now);
  assert.match(down.sql, /status = 'DELIVERED'.*WHERE id = \? AND status = 'INVOICED'/s);
  assert.equal(buildDoStatusSyncStatement(db, "do-1", "DELIVERED", false, now), null, "no churn when it already agrees");
  assert.equal(buildDoStatusSyncStatement(db, "do-1", "CANCELLED", true, now), null, "a cancelled DO is nobody's to flip");
});

// ── Dropping a line from a DRAFT invoice ─────────────────────────────────

test("removing a line from a DRAFT invoice gives that quantity back", async () => {
  const b = book();
  await raiseInvoice(b, "inv-1", null);
  assert.equal(qtyOf(b), "di-1:4/4 di-2:2/2");

  // The PUT items-replacement path: release the WHOLE old set, then re-consume
  // what survives. Here the operator dropped the tables.
  const db = fakeDb(b);
  apply(b, await buildInvoiceLineReleaseStatements(db, "inv-1"));
  assert.equal(qtyOf(b), "di-1:0/4 di-2:0/2");
  b.invoiceItems = b.invoiceItems.filter((it) => it.delivery_order_item_id !== "di-2");
  const st = await loadDoBillingState(fakeDb(b), "do-1");
  const redraw = buildDrawdownStatements(fakeDb(b), st, [{ deliveryOrderItemId: "di-1", quantity: 4 }]);
  assert.equal(redraw.ok, true);
  apply(b, redraw.statements);

  assert.equal(qtyOf(b), "di-1:4/4 di-2:0/2", "the dropped line's quantity is free again");
  const after = await loadDoBillingState(fakeDb(b), "do-1");
  assert.equal(after.remainingQty, 2, "…and can be put on a different invoice");
  assert.equal(doBillingRefusal("DO-2608-001", after), null);
});

// ── The SO-level fallbacks must not fire on a second bill ────────────────

test("the sales-order fallbacks are restricted to the FIRST whole-document bill", () => {
  // They bill AROUND the delivery order (its lines priced at zero), so they
  // consume nothing. Firing one on a SECOND invoice would charge the whole
  // sales order again on top of what the first invoice already billed.
  const H = read("src/api/routes/delivery-orders/_helpers.ts");
  assert.match(H, /const freshWholeDo =/);
  assert.match(H, /if \(computedTotal === 0 && freshWholeDo\) \{/);
  assert.equal(
    (H.match(/if \(computedTotal === 0 && freshWholeDo\) \{/g) ?? []).length,
    2,
    "both fallbacks — the SO lines and the SO header total — must be gated",
  );
});
