// ---------------------------------------------------------------------------
// invoice-death-releases-source.test.mjs — a voided invoice must hand the
// delivery order back.
//
// THE HOLE (2026-08-07). Creating an invoice flips the DO to INVOICED
// (invoices.ts POST, and the auto-on-delivery cascade). Nothing ever flipped
// it back. Void reversed the GL and the customer's A/R but wrote nothing to
// delivery_orders; DRAFT-delete reversed only customers.outstandingSen. And
// INVOICED had no outbound transition at all — while the grid button greys on
// status !== 'DELIVERED' and POST /api/invoices refuses a non-DELIVERED DO.
//
// So: goods ship → invoice is voided → that delivery can NEVER be billed
// again. Real delivered revenue silently leaves the book, with the DO parked
// in a status the UI reads as "already billed". Someone had already been
// forced to write a manual repair endpoint for the symptom
// (/backfill-normalize-invoiced-to-delivered) — which deliberately SKIPS DOs
// with zero live invoices, i.e. exactly the void case it cannot help.
//
// Three walls had to come down together; this file pins all three, plus the
// one thing that must NOT happen (a DO with two live invoices releasing when
// only one of them dies).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const INV = read("src/api/routes/invoices.ts");
const DO_HELPERS = read("src/api/routes/delivery-orders/_helpers.ts");

// pathToFileURL, not a raw absolute path: on Windows the ESM loader rejects a
// "C:\…" specifier (protocol 'c:'); it needs a file:// URL.
const {
  VALID_TRANSITIONS,
  buildInvoiceDeathReleaseStatements,
} = await import(pathToFileURL(resolve(process.cwd(), "src/api/routes/delivery-orders/_helpers.ts")).href);

// ── A fake D1 that answers from plain arrays and records what would be written ─

function fakeDb({ invoices = [], deliveryOrders = [], salesOrders = [], doItems = [], prodOrders = [], invoiceItems = [] } = {}) {
  const written = [];
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  return {
    written,
    prepare(sql) {
      const q = norm(sql);
      return {
        // The partial-billing self-apply (ensureDoPartialInvoiceColumns) runs
        // its DDL through .run() on a bare prepared statement.
        async run() {
          return { success: true };
        },
        bind(...args) {
          const stmt = { sql: q, args };
          return {
            ...stmt,
            async run() {
              return { success: true };
            },
            async first() {
              // does this invoice carry any per-line DO link? (legacy detection)
              if (/SELECT id FROM invoice_items WHERE invoiceId = \? AND delivery_order_item_id IS NOT NULL/.test(q)) {
                return (
                  invoiceItems.find(
                    (it) => it.invoiceId === args[0] && it.deliveryOrderItemId,
                  ) ?? null
                );
              }
              if (/SELECT invoiced_qty AS "invoicedQty" FROM delivery_order_items WHERE id = \?/.test(q)) {
                const di = doItems.find((d) => d.id === args[0]);
                return di ? { invoicedQty: di.invoicedQty ?? 0 } : null;
              }
              // live invoice on a DO, excluding the dying one
              if (/SELECT id FROM invoices WHERE deliveryOrderId = \? AND id != \?/.test(q)) {
                const [doId, dying] = args;
                return invoices.find((i) => i.deliveryOrderId === doId && i.id !== dying && i.status !== "CANCELLED") ?? null;
              }
              if (/SELECT id FROM invoices WHERE salesOrderId = \? AND id != \?/.test(q)) {
                const [soId, dying] = args;
                return invoices.find((i) => i.salesOrderId === soId && i.id !== dying && i.status !== "CANCELLED") ?? null;
              }
              if (/SELECT id FROM invoices WHERE deliveryOrderId IN/.test(q)) {
                const dying = args[args.length - 1];
                const doIds = args.slice(0, -1);
                return invoices.find((i) => doIds.includes(i.deliveryOrderId) && i.id !== dying && i.status !== "CANCELLED") ?? null;
              }
              if (/FROM delivery_orders WHERE id = \?/.test(q)) {
                return deliveryOrders.find((d) => d.id === args[0]) ?? null;
              }
              if (/FROM sales_orders WHERE id = \?/.test(q)) {
                return salesOrders.find((s) => s.id === args[0]) ?? null;
              }
              throw new Error("unexpected first() query: " + q);
            },
            async all() {
              // loadDoBillingState: the DO's lines with their consumed counters
              if (/FROM delivery_order_items\s+WHERE deliveryOrderId = \?/.test(q)) {
                return {
                  results: doItems
                    .filter((d) => d.deliveryOrderId === args[0])
                    .map((d) => ({
                      id: d.id ?? `${d.deliveryOrderId}-${d.productionOrderId}`,
                      productionOrderId: d.productionOrderId ?? null,
                      productCode: d.productCode ?? "",
                      productName: d.productName ?? "",
                      sizeLabel: "",
                      fabricCode: "",
                      quantity: d.quantity ?? 0,
                      invoicedQty: d.invoicedQty ?? 0,
                    })),
                };
              }
              // loadDoBillingState: live invoices on the DO
              if (/SELECT id, invoiceNo, status FROM invoices\s+WHERE deliveryOrderId = \? AND status <> 'CANCELLED'/.test(q)) {
                return {
                  results: invoices.filter(
                    (i) => i.deliveryOrderId === args[0] && i.status !== "CANCELLED",
                  ),
                };
              }
              // buildInvoiceLineReleaseStatements: what this invoice consumed
              if (/delivery_order_item_id AS "deliveryOrderItemId", quantity\s+FROM invoice_items WHERE invoiceId = \?/.test(q)) {
                return {
                  results: invoiceItems.filter((it) => it.invoiceId === args[0]),
                };
              }
              // resolveDoSalesOrderIds: DO items → production orders → SO
              if (/po\.salesOrderId AS soId/.test(q) || /SELECT DISTINCT po\.salesOrderId/.test(q)) {
                const ids = new Set();
                for (const di of doItems.filter((d) => d.deliveryOrderId === args[0])) {
                  const po = prodOrders.find((p) => p.id === di.productionOrderId);
                  if (po?.salesOrderId) ids.add(po.salesOrderId);
                }
                return { results: [...ids].map((soId) => ({ soId })) };
              }
              // resolveSalesOrderDoIds: SO → its DOs, both ways
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

// One DO, one SO, one invoice — the ordinary shape.
const simple = (invoiceStatus) => ({
  invoices: [{ id: "inv-1", deliveryOrderId: "do-1", salesOrderId: "so-1", status: invoiceStatus }],
  deliveryOrders: [{ id: "do-1", doNo: "DO-2608-001", status: "INVOICED", salesOrderId: "so-1" }],
  salesOrders: [{ id: "so-1", status: "INVOICED" }],
  doItems: [{ deliveryOrderId: "do-1", productionOrderId: "po-1" }],
  prodOrders: [{ id: "po-1", salesOrderId: "so-1" }],
});

const sqlOf = (stmts) => stmts.map((s) => s.sql);

// ── Wall 1: the status machine had no way out of INVOICED ───────────────────

test("INVOICED is no longer a dead end", () => {
  assert.ok(
    VALID_TRANSITIONS.INVOICED.includes("DELIVERED"),
    "without an outbound edge from INVOICED the DO can never return to the billable state",
  );
});

test("stepping back from INVOICED does NOT re-run the delivery cascade", () => {
  // Guarding this is what makes the new edge safe: the goods already shipped
  // once, so re-running it would re-stamp fg_units, re-emit FIFO COGS, and
  // auto-create a SECOND invoice.
  assert.match(
    DO_HELPERS,
    /const cascadedToDelivered =\s*\n\s*existing\.status !== "DELIVERED" &&\s*\n\s*existing\.status !== "INVOICED" &&\s*\n\s*nextStatus === "DELIVERED";/,
  );
});

// ── Wall 2: invoice death wrote nothing back to the source ──────────────────

test("voiding the only invoice releases the DO back to DELIVERED", async () => {
  const db = fakeDb(simple("SENT"));
  const stmts = await buildInvoiceDeathReleaseStatements(db, {
    invoiceId: "inv-1",
    deliveryOrderId: "do-1",
    salesOrderId: "so-1",
    now: "2026-08-07T00:00:00.000Z",
    reason: "void",
  });
  const sql = sqlOf(stmts);
  assert.ok(
    sql.some((s) => /UPDATE delivery_orders SET status = 'DELIVERED'.*WHERE id = \? AND status = 'INVOICED'/.test(s)),
    "the DO must step back to DELIVERED, guarded on its from-status",
  );
  // overdue carried the "INVOICED" stamp the create path set alongside status.
  assert.ok(sql.some((s) => /overdue = 'COMPLETED'/.test(s)), "overdue must be un-stamped too");
});

test("deleting a DRAFT invoice releases the DO the same way", async () => {
  const db = fakeDb(simple("DRAFT"));
  const stmts = await buildInvoiceDeathReleaseStatements(db, {
    invoiceId: "inv-1",
    deliveryOrderId: "do-1",
    salesOrderId: "so-1",
    now: "2026-08-07T00:00:00.000Z",
    reason: "delete",
  });
  assert.ok(
    sqlOf(stmts).some((s) => /UPDATE delivery_orders SET status = 'DELIVERED'/.test(s)),
    "delete is a death too — the DRAFT was created by the cascade that flipped the DO",
  );
});

test("the sales order is released with it, and the reversal is audited", async () => {
  const db = fakeDb(simple("SENT"));
  const stmts = await buildInvoiceDeathReleaseStatements(db, {
    invoiceId: "inv-1",
    deliveryOrderId: "do-1",
    salesOrderId: "so-1",
    now: "2026-08-07T00:00:00.000Z",
    reason: "void",
  });
  const sql = sqlOf(stmts);
  assert.ok(
    sql.some((s) => /UPDATE sales_orders SET status = 'DELIVERED'.*WHERE id = \? AND status = 'INVOICED'/.test(s)),
    "a voided invoice must not leave the SO stranded at INVOICED",
  );
  const audit = stmts.find((s) => /INSERT INTO so_status_changes/.test(s.sql));
  assert.ok(audit, "the SO reversal needs an so_status_changes row, like every other SO cascade");
  assert.ok(audit.args.includes("INVOICED") && audit.args.includes("DELIVERED"));
});

test("a DO already at DELIVERED is left alone (no blind downgrade)", async () => {
  const d = simple("SENT");
  d.deliveryOrders[0].status = "DELIVERED";
  const stmts = await buildInvoiceDeathReleaseStatements(fakeDb(d), {
    invoiceId: "inv-1", deliveryOrderId: "do-1", salesOrderId: "so-1",
    now: "2026-08-07T00:00:00.000Z", reason: "void",
  });
  assert.equal(sqlOf(stmts).filter((s) => /UPDATE delivery_orders/.test(s)).length, 0);
});

test("a CLOSED sales order is never resurrected by a void", async () => {
  const d = simple("SENT");
  d.salesOrders[0].status = "CLOSED";
  const stmts = await buildInvoiceDeathReleaseStatements(fakeDb(d), {
    invoiceId: "inv-1", deliveryOrderId: "do-1", salesOrderId: "so-1",
    now: "2026-08-07T00:00:00.000Z", reason: "void",
  });
  assert.equal(sqlOf(stmts).filter((s) => /UPDATE sales_orders/.test(s)).length, 0);
});

// ── The thing that must NOT happen ──────────────────────────────────────────

test("with TWO live invoices on one DO, voiding one releases NOTHING", async () => {
  const d = simple("SENT");
  d.invoices.push({ id: "inv-2", deliveryOrderId: "do-1", salesOrderId: "so-1", status: "SENT" });
  const stmts = await buildInvoiceDeathReleaseStatements(fakeDb(d), {
    invoiceId: "inv-1", deliveryOrderId: "do-1", salesOrderId: "so-1",
    now: "2026-08-07T00:00:00.000Z", reason: "void",
  });
  assert.equal(stmts.length, 0, "the DO is still genuinely billed — releasing it would invite a duplicate invoice");
});

test("a CANCELLED sibling does not count as still-billed", async () => {
  const d = simple("SENT");
  d.invoices.push({ id: "inv-2", deliveryOrderId: "do-1", salesOrderId: "so-1", status: "CANCELLED" });
  const stmts = await buildInvoiceDeathReleaseStatements(fakeDb(d), {
    invoiceId: "inv-1", deliveryOrderId: "do-1", salesOrderId: "so-1",
    now: "2026-08-07T00:00:00.000Z", reason: "void",
  });
  assert.ok(sqlOf(stmts).some((s) => /UPDATE delivery_orders/.test(s)));
});

test("a multi-DO sales order stays INVOICED while a sibling DO's invoice lives", async () => {
  const d = simple("SENT");
  d.deliveryOrders.push({ id: "do-2", doNo: "DO-2608-002", status: "INVOICED", salesOrderId: "so-1" });
  d.invoices.push({ id: "inv-2", deliveryOrderId: "do-2", salesOrderId: "so-1", status: "SENT" });
  const stmts = await buildInvoiceDeathReleaseStatements(fakeDb(d), {
    invoiceId: "inv-1", deliveryOrderId: "do-1", salesOrderId: "so-1",
    now: "2026-08-07T00:00:00.000Z", reason: "void",
  });
  const sql = sqlOf(stmts);
  assert.ok(sql.some((s) => /UPDATE delivery_orders/.test(s)), "do-1 itself has no live invoice — it releases");
  assert.equal(
    sql.filter((s) => /UPDATE sales_orders/.test(s)).length,
    0,
    "but so-1 is still billed through do-2, so it must stay INVOICED",
  );
});

// ── Wall 3: the two idempotency checks disagreed about CANCELLED ────────────

test("both invoice-creation paths ask ONE shared question, and it ignores CANCELLED", () => {
  // Originally these were two hand-written idempotency SELECTs that disagreed:
  // auto-on-delivery counted a CANCELLED invoice as "already invoiced", so a
  // voided DO went permanently silent on that path. 2026-08-07 they were
  // rebased on the SAME derived read — loadDoBillingState — so they can no
  // longer drift, and that read is `status <> 'CANCELLED'` by construction.
  assert.match(
    DO_HELPERS,
    /const billing = await loadDoBillingState\(db, doRow\.id\)/,
    "the auto-on-delivery cascade must gate on the derived billed state",
  );
  assert.match(
    DO_HELPERS,
    /if \(!billing\.fullyInvoiced &&/,
    "…and skip only when there is genuinely nothing left to bill",
  );
  assert.match(
    INV,
    /const billing = await loadDoBillingState\(c\.var\.DB, deliveryOrderId\)/,
    "the manual POST must gate on the same read",
  );
  const CHAIN = read("src/api/lib/do-partial-invoice.ts");
  assert.match(
    CHAIN,
    /WHERE deliveryOrderId = \? AND status <> 'CANCELLED'/,
    "a cancelled invoice bills nobody and must never count as billed",
  );
});

// ── The wiring: both death paths must actually call the release ────────────

test("void and DRAFT-delete both call the release, in their own batch", () => {
  const calls = INV.match(/buildInvoiceDeathReleaseStatements\(c\.var\.DB, \{/g) ?? [];
  assert.equal(calls.length, 2, "both invoice death paths (PUT→CANCELLED and DELETE) must release");
  assert.match(INV, /reason: "void"/);
  assert.match(INV, /reason: "delete"/);
  // The DELETE path could not release without knowing what it was billing.
  assert.match(
    INV,
    /SELECT id, status, customerId, totalSen, paidAmount, deliveryOrderId, salesOrderId FROM invoices WHERE id = \?/,
  );
});

test("the release rides the same batch as the death, never a separate write", () => {
  // buildInvoiceDeathReleaseStatements returns statements; it must not run them.
  const body = DO_HELPERS.slice(
    DO_HELPERS.indexOf("export async function buildInvoiceDeathReleaseStatements"),
    DO_HELPERS.indexOf("// DO / PO \"Sales Figure\" resolver"),
  );
  assert.ok(body.length > 0);
  assert.ok(!/\.run\(\)/.test(body), "the helper must not write on its own — the caller batches it atomically");
});

// ── The DB layer must not silently undo the release ────────────────────────

test("no DB constraint silently undoes the release", () => {
  // The original hazard: uniq_invoice_active_delivery_order. If it had covered
  // cancelled rows too, the release would be useless — the DO would read
  // DELIVERED but the re-invoice INSERT would hit a unique violation on the old
  // cancelled row. It was partial, so it did not.
  //
  // 2026-08-07 that index is GONE (a delivery may now carry several live
  // invoices) and the storage-layer guard is the per-line ceiling instead. The
  // hazard it has to avoid is the same one: nothing at the DB layer may block a
  // legitimate re-invoice after a death. A released quantity is decremented, so
  // the ceiling has room again by construction — and the drop must actually
  // ship, or the FIRST re-invoice fails with a duplicate key.
  const CHAIN = read("src/api/lib/do-partial-invoice.ts");
  assert.match(CHAIN, /DROP INDEX IF EXISTS uniq_invoice_active_delivery_order/);
  assert.doesNotMatch(
    INV,
    /CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_active_delivery_order/,
    "nothing may re-create the retired index after the drop",
  );
  assert.match(
    CHAIN,
    /CHECK \(invoiced_qty >= 0 AND invoiced_qty <= quantity\)/,
    "its replacement guards the invariant that actually matters: never bill " +
      "more than was delivered",
  );
});
