// ---------------------------------------------------------------------------
// purchasing-convert-flow.test.mjs — behavioral test of the PO→GRN→PI convert
// chain's per-line availability tracking, driven through the REAL grn.ts and
// purchase-invoices.ts Hono route handlers against a stateful in-memory mock
// D1.
//
// The mock D1 is a tiny SQL interpreter scoped to exactly the statements these
// routes issue against the convert-chain tables (grns / grn_items /
// purchase_orders / purchase_order_items / purchase_invoices /
// purchase_invoice_items). It stores rows in plain JS arrays and mutates them,
// so the increment / decrement / restore behaviour is exercised end-to-end —
// not re-implemented in the test.
//
// Asserts:
//   • GRN→PI consume decrements a GRN line's availableQty
//   • deleting the PI RESTORES the GRN line's availableQty
//   • the line-level guard BLOCKS over-invoicing a GRN line ...
//   • ... but ALLOWS a 2nd PI for the remaining qty (the old PO-level 409
//     wrongly blocked this)
//   • un-posting a GRN restores the parent PO line's availableQty
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Hono } from "hono";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const grnApp = (
  await import(pathToFileURL(resolve(process.cwd(), "src/api/routes/grn.ts")).href)
).default;
const piApp = (
  await import(
    pathToFileURL(resolve(process.cwd(), "src/api/routes/purchase-invoices.ts")).href
  )
).default;

// ---------------------------------------------------------------------------
// Stateful in-memory mock D1. Implements just enough SQL for the two routes.
// Identifiers are written camelCase in route SQL; here we read both camelCase
// and snake_case keys off the seeded rows so the dual-key reads work.
// ---------------------------------------------------------------------------
function makeDb() {
  const tables = {
    grns: [],
    grn_items: [],
    purchase_orders: [],
    purchase_order_items: [],
    purchase_invoices: [],
    purchase_invoice_items: [],
    goods_in_transit: [],
    rm_batches: [],
    cost_ledger: [],
    raw_materials: [],
    suppliers: [],
    supplier_material_bindings: [],
    audit_events: [],
  };
  let autoId = 1;

  const norm = (s) => s.trim().replace(/\s+/g, " ");

  function prepare(rawSql) {
    const sql = norm(rawSql);
    let binds = [];
    const api = {
      bind(...args) {
        binds = args;
        return this;
      },
      async run() {
        exec(sql, binds);
        return { success: true, meta: { changes: 1 } };
      },
      async first() {
        const rows = query(sql, binds);
        return rows[0] ?? null;
      },
      async all() {
        return { results: query(sql, binds) };
      },
    };
    return api;
  }

  async function batch(stmts) {
    // stmts are the prepared-statement objects from prepare().bind(); each
    // carries its own captured SQL+binds via the closure. We re-run them.
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }

  // ---- write side -----------------------------------------------------------
  function exec(sql, binds) {
    // ALTER / CREATE INDEX — no-op in the mock (all columns already present).
    if (/^ALTER TABLE/i.test(sql) || /^CREATE (UNIQUE )?INDEX/i.test(sql) || /^CREATE TABLE/i.test(sql)) {
      return;
    }
    // INSERT INTO <table> (cols) VALUES (?...)
    let m = sql.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]*)\)/i);
    if (m) {
      const table = m[1];
      const cols = m[2].split(",").map((c) => c.trim());
      const row = {};
      cols.forEach((col, i) => {
        row[col] = binds[i];
      });
      if (table === "grn_items" && row.id == null) row.id = autoId++;
      tables[table].push(row);
      return;
    }
    // UPDATE grn_items SET invoiced_qty = COALESCE(invoiced_qty,0) + ? WHERE id = ?
    m = sql.match(/^UPDATE grn_items SET invoiced_qty = COALESCE\(invoiced_qty, 0\) \+ \? WHERE id = \?/i);
    if (m) {
      const [delta, id] = binds;
      const gi = tables.grn_items.find((r) => String(r.id) === String(id));
      if (gi) gi.invoiced_qty = (Number(gi.invoiced_qty) || 0) + Number(delta);
      return;
    }
    // UPDATE grn_items SET invoiced_qty = invoiced_qty - ? WHERE id = ?
    m = sql.match(/^UPDATE grn_items SET invoiced_qty = invoiced_qty - \? WHERE id = \?/i);
    if (m) {
      const [delta, id] = binds;
      const gi = tables.grn_items.find((r) => String(r.id) === String(id));
      if (gi) gi.invoiced_qty = (Number(gi.invoiced_qty) || 0) - Number(delta);
      return;
    }
    // UPDATE purchase_order_items SET receivedQty = receivedQty + ? WHERE id = ?
    m = sql.match(/^UPDATE purchase_order_items SET receivedQty = receivedQty \+ \? WHERE id = \?/i);
    if (m) {
      const [delta, id] = binds;
      const poi = tables.purchase_order_items.find((r) => String(r.id) === String(id));
      if (poi) poi.receivedQty = (Number(poi.receivedQty) || 0) + Number(delta);
      return;
    }
    // UPDATE purchase_order_items SET receivedQty = receivedQty - ? WHERE id = ?
    m = sql.match(/^UPDATE purchase_order_items SET receivedQty = receivedQty - \? WHERE id = \?/i);
    if (m) {
      const [delta, id] = binds;
      const poi = tables.purchase_order_items.find((r) => String(r.id) === String(id));
      if (poi) poi.receivedQty = (Number(poi.receivedQty) || 0) - Number(delta);
      return;
    }
    // UPDATE grns SET ... WHERE id = ?  (status / qc / etc — last bind is id)
    m = sql.match(/^UPDATE grns SET (.+) WHERE id = \?/i);
    if (m) {
      const id = binds[binds.length - 1];
      const g = tables.grns.find((r) => String(r.id) === String(id));
      if (g) applySet(g, m[1], binds.slice(0, -1));
      return;
    }
    // UPDATE purchase_orders SET ... WHERE id = ? [AND status IN (...)]
    m = sql.match(/^UPDATE purchase_orders SET (.+) WHERE id = \?( AND status IN \([^)]*\))?/i);
    if (m) {
      // id is the bind right after the SET binds; trailing status filter has
      // no binds (literal). Count placeholders in the SET clause.
      const setClause = m[1];
      const nSet = (setClause.match(/\?/g) || []).length;
      const id = binds[nSet];
      const po = tables.purchase_orders.find((r) => String(r.id) === String(id));
      if (po) {
        if (m[2]) {
          const allowed = m[2].match(/'([^']+)'/g)?.map((s) => s.replace(/'/g, "")) ?? [];
          if (!allowed.includes(po.status)) return;
        }
        applySet(po, setClause, binds.slice(0, nSet));
      }
      return;
    }
    // DELETE FROM <table> WHERE <col> = ?
    m = sql.match(/^DELETE FROM (\w+) WHERE (\w+) = \?/i);
    if (m) {
      const [table, col] = [m[1], m[2]];
      const val = binds[0];
      const before = tables[table];
      tables[table] = before.filter((r) => String(getCol(r, col)) !== String(val));
      // FK cascade: deleting a grn removes its grn_items; deleting a pi removes its items.
      if (table === "grns") {
        tables.grn_items = tables.grn_items.filter((r) => String(getCol(r, "grnId")) !== String(val));
      }
      if (table === "purchase_invoices") {
        tables.purchase_invoice_items = tables.purchase_invoice_items.filter(
          (r) => String(getCol(r, "pi_id")) !== String(val),
        );
      }
      return;
    }
    // Anything else (audit inserts use the INSERT path above) — ignore.
  }

  // Apply "col = ?, col2 = expr, ..." assignments. Only handles `col = ?`,
  // `col = NULL`, and ignores function exprs we don't need to track.
  function applySet(row, setClause, setBinds) {
    let bi = 0;
    for (const part of setClause.split(",")) {
      const seg = part.trim();
      const eq = seg.match(/^(\w+) = (.+)$/);
      if (!eq) continue;
      const col = eq[1];
      const rhs = eq[2].trim();
      if (rhs === "?") {
        row[col] = setBinds[bi++];
      } else if (/^NULL$/i.test(rhs)) {
        row[col] = null;
      } else if (/^'[^']*'$/.test(rhs)) {
        // string literal, e.g. status = 'CONFIRMED'
        row[col] = rhs.slice(1, -1);
      } else {
        // expression with a placeholder, e.g. amount_sen — consume a bind if present
        if (rhs.includes("?")) bi++;
      }
    }
  }

  // ---- read side ------------------------------------------------------------
  function getCol(row, col) {
    // dual-key: try the literal col, its camel/snake twin
    if (row[col] !== undefined) return row[col];
    const snake = col.replace(/[A-Z]/g, (x) => "_" + x.toLowerCase());
    const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return row[snake] ?? row[camel];
  }

  function query(sql, binds) {
    // SELECT poNo / piNo generators — return empty so seq starts at 001.
    if (/FROM grns WHERE grnNumber LIKE/i.test(sql)) return [];
    if (/FROM purchase_invoices WHERE piNo LIKE/i.test(sql)) return [];
    if (/FROM purchase_orders WHERE poNo LIKE/i.test(sql)) return [];

    // RBAC role_permissions join — short-circuited by SUPER_ADMIN, but answer empty.
    if (/FROM role_permissions/i.test(sql)) return [];

    // SELECT * FROM grns WHERE id = ?
    if (/FROM grns WHERE id = \?/i.test(sql)) {
      return tables.grns.filter((r) => String(r.id) === String(binds[0]));
    }
    // SELECT poId FROM grns WHERE id = ?
    if (/SELECT poId FROM grns WHERE id = \?/i.test(sql)) {
      return tables.grns
        .filter((r) => String(r.id) === String(binds[0]))
        .map((r) => ({ poId: getCol(r, "poId") }));
    }
    // SELECT id, poId, poNumber FROM grns WHERE id = ?
    if (/SELECT id, poId, poNumber FROM grns WHERE id = \?/i.test(sql)) {
      return tables.grns
        .filter((r) => String(r.id) === String(binds[0]))
        .map((r) => ({ id: r.id, poId: getCol(r, "poId"), poNumber: getCol(r, "poNumber") }));
    }
    // SELECT * FROM grn_items WHERE grnId = ?  (and ORDER BY variants)
    if (/FROM grn_items WHERE grnId = \?/i.test(sql)) {
      return tables.grn_items.filter((r) => String(getCol(r, "grnId")) === String(binds[0]));
    }
    // SELECT * FROM grn_items  (list-all in GET /)
    if (/^SELECT \* FROM grn_items$/i.test(sql)) {
      return tables.grn_items.slice();
    }
    // SELECT poItemIndex, acceptedQty[, po_id, po_item_id] FROM grn_items WHERE grnId = ?
    // A GRN line may now name its OWN purchase order (a receipt can span
    // several POs), with the positional poItemIndex kept as the legacy path.
    if (/SELECT poItemIndex, acceptedQty.* FROM grn_items WHERE grnId = \?/i.test(sql)) {
      return tables.grn_items
        .filter((r) => String(getCol(r, "grnId")) === String(binds[0]))
        .map((r) => ({
          poItemIndex: getCol(r, "poItemIndex"),
          acceptedQty: getCol(r, "acceptedQty"),
          po_id: getCol(r, "po_id") ?? null,
          po_item_id: getCol(r, "po_item_id") ?? null,
        }));
    }
    // SELECT invoiced_qty FROM grn_items WHERE id = ?
    if (/SELECT invoiced_qty FROM grn_items WHERE id = \?/i.test(sql)) {
      return tables.grn_items
        .filter((r) => String(r.id) === String(binds[0]))
        .map((r) => ({ invoiced_qty: Number(r.invoiced_qty) || 0 }));
    }
    // SELECT id, quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ? ORDER BY id
    if (/SELECT id, quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = \?/i.test(sql)) {
      return tables.purchase_order_items
        .filter((r) => String(getCol(r, "purchaseOrderId")) === String(binds[0]))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((r) => ({ id: r.id, quantity: getCol(r, "quantity"), receivedQty: Number(getCol(r, "receivedQty")) || 0 }));
    }
    // SELECT quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ?
    if (/SELECT quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = \?/i.test(sql)) {
      return tables.purchase_order_items
        .filter((r) => String(getCol(r, "purchaseOrderId")) === String(binds[0]))
        .map((r) => ({ quantity: getCol(r, "quantity"), receivedQty: Number(getCol(r, "receivedQty")) || 0 }));
    }
    // SELECT material_code, materialName, quantity FROM purchase_order_items WHERE purchaseOrderId = ?
    if (/FROM purchase_order_items WHERE purchaseOrderId = \?/i.test(sql)) {
      return tables.purchase_order_items
        .filter((r) => String(getCol(r, "purchaseOrderId")) === String(binds[0]))
        .map((r) => ({
          material_code: getCol(r, "material_code"),
          materialName: getCol(r, "materialName"),
          quantity: getCol(r, "quantity"),
        }));
    }
    // SELECT id, materialName, acceptedQty, invoiced_qty FROM grn_items WHERE grnId = ?
    // (already covered by the generic grn_items WHERE grnId above — returns full rows)

    // SELECT * FROM purchase_invoices WHERE id = ?
    if (/FROM purchase_invoices WHERE id = \?/i.test(sql)) {
      return tables.purchase_invoices.filter((r) => String(r.id) === String(binds[0]));
    }
    // SELECT piNo FROM purchase_invoices WHERE grn_id = ? AND status != 'CANCELLED'
    if (/SELECT piNo FROM purchase_invoices WHERE grn_id = \? AND status != 'CANCELLED'/i.test(sql)) {
      return tables.purchase_invoices
        .filter((r) => String(getCol(r, "grn_id")) === String(binds[0]) && r.status !== "CANCELLED")
        .map((r) => ({ piNo: r.piNo }));
    }
    // SELECT grn_item_id, qty FROM purchase_invoice_items WHERE pi_id = ?
    if (/SELECT grn_item_id, qty FROM purchase_invoice_items WHERE pi_id = \?/i.test(sql)) {
      return tables.purchase_invoice_items
        .filter((r) => String(getCol(r, "pi_id")) === String(binds[0]))
        .map((r) => ({ grn_item_id: getCol(r, "grn_item_id"), qty: getCol(r, "qty") }));
    }
    // SELECT * FROM purchase_invoice_items WHERE pi_id = ?
    if (/FROM purchase_invoice_items WHERE pi_id = \?/i.test(sql)) {
      return tables.purchase_invoice_items.filter((r) => String(getCol(r, "pi_id")) === String(binds[0]));
    }
    // PO source already-invoiced JOIN — not exercised in these tests (GRN-sourced).
    if (/FROM purchase_invoice_items pii JOIN purchase_invoices/i.test(sql)) return [];
    // suppliers / poNo lookups not used here
    if (/FROM purchase_orders WHERE id = \?/i.test(sql)) {
      return tables.purchase_orders.filter((r) => String(r.id) === String(binds[0]));
    }
    return [];
  }

  return { tables, prepare, batch };
}

// Wrap a route sub-app so c.var.DB + userRole are injected (SUPER_ADMIN
// short-circuits RBAC). Mirrors what worker.ts middleware does in prod.
function mount(routeApp, db) {
  const root = new Hono();
  root.use("*", async (c, next) => {
    c.set("DB", db);
    c.set("userRole", "SUPER_ADMIN");
    c.set("userId", "test-user");
    c.set("orgId", "org-test");
    await next();
  });
  root.route("/", routeApp);
  return root;
}

function seed(db) {
  // A PO with one line (10 units), already received via a POSTED GRN.
  db.tables.suppliers.push({ id: "sup-1", code: "S1", name: "ACME", email: null });
  db.tables.purchase_orders.push({
    id: "po-1", poNo: "PO-1", supplierId: "sup-1", supplierName: "ACME",
    subtotalSen: 100000, totalSen: 100000, status: "RECEIVED", orderDate: "2026-06-01",
    expectedDate: "", receivedDate: "2026-06-02", notes: "", orgId: "org-test",
  });
  db.tables.purchase_order_items.push({
    id: "poi-1", purchaseOrderId: "po-1", materialCategory: "FOAM",
    material_code: "FOAM-1", materialName: "FOAM-1 - Foam block", supplierSKU: "",
    quantity: 10, unitPriceSen: 10000, totalSen: 100000, receivedQty: 10, unit: "pcs",
    orgId: "org-test",
  });
  // A POSTED GRN that received all 10, one line. invoiced_qty starts 0.
  db.tables.grns.push({
    id: "grn-1", grnNumber: "GRN-1", poId: "po-1", poNumber: "PO-1",
    supplierId: "sup-1", supplierName: "ACME", receiveDate: "2026-06-02",
    receivedBy: "x", totalAmount: 100000, qcStatus: "PASSED", status: "POSTED",
    notes: "", arrival_state: "ARRIVED",
  });
  db.tables.grn_items.push({
    id: 101, grnId: "grn-1", poItemIndex: 0, materialCode: "FOAM-1",
    materialName: "FOAM-1 - Foam block", orderedQty: 10, receivedQty: 10,
    acceptedQty: 10, rejectedQty: 0, rejectionReason: null, unitPrice: 10000,
    invoiced_qty: 0,
  });
}

async function getGrnItem(grnRoot, grnId, grnItemId) {
  const res = await grnRoot.request(`/${grnId}`);
  const body = await res.json();
  return body.data.items.find((i) => String(i.id) === String(grnItemId));
}

// ---------------------------------------------------------------------------
test("GRN→PI consume decrements availableQty; deleting the PI restores it", async () => {
  const db = makeDb();
  seed(db);
  const grnRoot = mount(grnApp, db);
  const piRoot = mount(piApp, db);

  // before: GRN line 101 has 10 accepted, 0 invoiced → 10 available
  let gi = await getGrnItem(grnRoot, "grn-1", 101);
  assert.equal(gi.acceptedQty, 10);
  assert.equal(gi.invoicedQty, 0);
  assert.equal(gi.availableQty, 10);

  // create a PI from the GRN, billing 6 of 10 on that line
  const createRes = await piRoot.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grnId: "grn-1",
      supplierId: "sup-1",
      supplierName: "ACME",
      items: [
        { materialCode: "FOAM-1", materialName: "FOAM-1 - Foam block", qty: 6, unitPriceSen: 10000, grnItemId: 101 },
      ],
    }),
  });
  assert.equal(createRes.status, 200);
  const created = (await createRes.json()).data;
  assert.equal(created.grnId, "grn-1");

  // available dropped to 4
  gi = await getGrnItem(grnRoot, "grn-1", 101);
  assert.equal(gi.invoicedQty, 6);
  assert.equal(gi.availableQty, 4);

  // delete the PI → availability restored to 10
  const delRes = await piRoot.request(`/${created.id}`, { method: "DELETE" });
  assert.equal(delRes.status, 200);

  gi = await getGrnItem(grnRoot, "grn-1", 101);
  assert.equal(gi.invoicedQty, 0);
  assert.equal(gi.availableQty, 10);
});

test("line guard BLOCKS over-invoicing but ALLOWS a 2nd PI for remaining qty", async () => {
  const db = makeDb();
  seed(db);
  const piRoot = mount(piApp, db);

  // PI #1 bills 6 of 10
  const r1 = await piRoot.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grnId: "grn-1", supplierId: "sup-1", supplierName: "ACME",
      items: [{ materialName: "FOAM-1 - Foam block", qty: 6, unitPriceSen: 10000, grnItemId: 101 }],
    }),
  });
  assert.equal(r1.status, 200);

  // PI #2 tries to bill 5 more (only 4 remain) → 409 line-level block
  const rOver = await piRoot.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grnId: "grn-1", supplierId: "sup-1", supplierName: "ACME",
      items: [{ materialName: "FOAM-1 - Foam block", qty: 5, unitPriceSen: 10000, grnItemId: 101 }],
    }),
  });
  assert.equal(rOver.status, 409);
  const overBody = await rOver.json();
  assert.equal(overBody.success, false);
  assert.match(overBody.error, /exceeds available 4/);

  // PI #2' bills exactly the remaining 4 → ALLOWED (the old PO-level 409
  // would have wrongly blocked any 2nd PI)
  const r2 = await piRoot.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grnId: "grn-1", supplierId: "sup-1", supplierName: "ACME",
      items: [{ materialName: "FOAM-1 - Foam block", qty: 4, unitPriceSen: 10000, grnItemId: 101 }],
    }),
  });
  assert.equal(r2.status, 200);

  // GRN line now fully consumed (10 of 10).
  const gi = db.tables.grn_items.find((r) => r.id === 101);
  assert.equal(Number(gi.invoiced_qty), 10);
});

test("a POSTED (received) GRN is LOCKED — un-post is blocked (owner option A)", async () => {
  const db = makeDb();
  seed(db);
  const grnRoot = mount(grnApp, db);

  // before: PO line fully received (receivedQty 10) → 0 available
  const poi = db.tables.purchase_order_items.find((r) => r.id === "poi-1");
  assert.equal(poi.receivedQty, 10);

  // try to un-post the GRN: POSTED → DRAFT — must be REJECTED (stock is in;
  // un-posting would free the PO line while the stock stays. Reverse via a
  // stock adjustment instead).
  const res = await grnRoot.request("/grn-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "DRAFT" }),
  });
  assert.equal(res.status, 409);

  // receivedQty stays consumed (NOT restored) — the received GRN is locked
  assert.equal(poi.receivedQty, 10);
  const po = db.tables.purchase_orders.find((r) => r.id === "po-1");
  assert.equal(po.status, "RECEIVED");
});

test("a POSTED (received) GRN is LOCKED — delete is blocked (owner option A)", async () => {
  const db = makeDb();
  seed(db);
  const grnRoot = mount(grnApp, db);

  const res = await grnRoot.request("/grn-1", { method: "DELETE" });
  assert.equal(res.status, 409);

  // GRN still exists, PO line still consumed
  assert.ok(db.tables.grns.find((r) => r.id === "grn-1"));
  const poi = db.tables.purchase_order_items.find((r) => r.id === "poi-1");
  assert.equal(poi.receivedQty, 10);
});

// ---------------------------------------------------------------------------
// No-Draft create-status mapping (owner ruling 2026-06-21).
//
// Manual create is a REAL document, not a throwaway draft:
//   • OCR/scan (body.ocrUsed)                 → DRAFT  (parked for review)
//   • local goods arrived (default ARRIVED)   → POSTED (stock in now)
//   • import in transit (arrival_state set)   → DRAFT  (arrival-pipeline tracked)
// Posting to stock happens ONLY when arrival === ARRIVED — the arrival gate is
// never bypassed at create time.
// ---------------------------------------------------------------------------

// Seed an open PO (CONFIRMED, nothing received) the create endpoint can receive.
function seedOpenPo(db) {
  db.tables.suppliers.push({ id: "sup-9", code: "S9", name: "OPEN CO", email: null });
  db.tables.purchase_orders.push({
    id: "po-9", poNo: "PO-9", supplierId: "sup-9", supplierName: "OPEN CO",
    subtotalSen: 50000, totalSen: 50000, status: "CONFIRMED", orderDate: "2026-06-01",
    expectedDate: "", receivedDate: "", notes: "", orgId: "org-test",
  });
  db.tables.purchase_order_items.push({
    id: "poi-9", purchaseOrderId: "po-9", materialCategory: "FOAM",
    material_code: "FOAM-9", materialName: "FOAM-9 - Foam block", supplierSKU: "",
    quantity: 5, unitPriceSen: 10000, totalSen: 50000, receivedQty: 0, unit: "pcs",
    orgId: "org-test",
  });
}

test("manual GRN (goods in hand) is born POSTED and posts to stock", async () => {
  const db = makeDb();
  const grnRoot = mount(grnApp, db);

  // Manual receipt: no poId, no arrival override → backend default ARRIVED →
  // status POSTED (No-Draft: a real document, stock in immediately).
  const res = await grnRoot.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      supplierId: "sup-9",
      supplierName: "OPEN CO",
      receivedBy: "Ahmad",
      items: [
        { materialName: "Loose foam", materialCode: "F-LOOSE", receivedQty: 3, acceptedQty: 3, rejectedQty: 0 },
      ],
    }),
  });
  assert.equal(res.status, 201);
  const data = (await res.json()).data;
  assert.equal(data.status, "POSTED", "manual arrived GRN must be born POSTED, not DRAFT");
  assert.equal(data.arrival_state, "ARRIVED");
});

test("OCR/scan GRN lands as DRAFT for review (not posted)", async () => {
  const db = makeDb();
  const grnRoot = mount(grnApp, db);

  const res = await grnRoot.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      supplierId: "sup-9",
      supplierName: "OPEN CO",
      receivedBy: "Ahmad",
      ocrUsed: true, // built from a scanned supplier document
      items: [
        { materialName: "Scanned foam", materialCode: "F-SCAN", receivedQty: 3, acceptedQty: 3, rejectedQty: 0 },
      ],
    }),
  });
  assert.equal(res.status, 201);
  const data = (await res.json()).data;
  assert.equal(data.status, "DRAFT", "scanned GRN must be DRAFT for review");
});

test("import in transit (PO-linked, not arrived) is DRAFT and does NOT post to stock", async () => {
  const db = makeDb();
  seedOpenPo(db);
  const grnRoot = mount(grnApp, db);

  // PO-linked receipt with goods still en-route: defaults NOT_ARRIVED → DRAFT.
  const res = await grnRoot.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      poId: "po-9",
      receivedBy: "Ahmad",
      arrival_state: "NOT_ARRIVED",
      items: [{ poItemIndex: 0, receivedQty: 5, acceptedQty: 5, rejectedQty: 0 }],
    }),
  });
  assert.equal(res.status, 201);
  const data = (await res.json()).data;
  assert.equal(data.status, "DRAFT", "in-transit import must stay DRAFT (arrival-pipeline tracked)");
  assert.equal(data.arrival_state, "NOT_ARRIVED");

  // NOT posted to stock → the parent PO line's receivedQty stays 0 (no cascade).
  const poi = db.tables.purchase_order_items.find((r) => r.id === "poi-9");
  assert.equal(Number(poi.receivedQty) || 0, 0, "in-transit GRN must not bump PO receivedQty");
});

test("PO-linked + arrival ARRIVED at create → POSTED + receivedQty cascades", async () => {
  const db = makeDb();
  seedOpenPo(db);
  const grnRoot = mount(grnApp, db);

  // Goods physically arrived against the PO at receipt time → arrival ARRIVED →
  // born POSTED → postGRNToStock + cascadePOStatusAfterGRNPost run.
  const res = await grnRoot.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      poId: "po-9",
      receivedBy: "Ahmad",
      arrival_state: "ARRIVED",
      items: [{ poItemIndex: 0, receivedQty: 5, acceptedQty: 5, rejectedQty: 0 }],
    }),
  });
  assert.equal(res.status, 201);
  const data = (await res.json()).data;
  assert.equal(data.status, "POSTED");

  // receivedQty cascade fired: PO line went 0 → 5 and the PO is now RECEIVED.
  const poi = db.tables.purchase_order_items.find((r) => r.id === "poi-9");
  assert.equal(Number(poi.receivedQty), 5, "post-on-create must cascade receivedQty");
  const po = db.tables.purchase_orders.find((r) => r.id === "po-9");
  assert.equal(po.status, "RECEIVED");
});

test("explicit body.status DRAFT forces DRAFT even for arrived goods", async () => {
  const db = makeDb();
  const grnRoot = mount(grnApp, db);

  const res = await grnRoot.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      supplierId: "sup-9",
      supplierName: "OPEN CO",
      receivedBy: "Ahmad",
      status: "DRAFT", // caller forces review even though goods are in hand
      items: [
        { materialName: "Loose foam", materialCode: "F-LOOSE", receivedQty: 1, acceptedQty: 1, rejectedQty: 0 },
      ],
    }),
  });
  assert.equal(res.status, 201);
  const data = (await res.json()).data;
  assert.equal(data.status, "DRAFT");
});
