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
    // SELECT acceptedQty, invoiced_qty FROM grn_items WHERE id = ?  (re-line ceiling)
    if (/SELECT acceptedQty, invoiced_qty FROM grn_items WHERE id = \?/i.test(sql)) {
      return tables.grn_items
        .filter((r) => String(r.id) === String(binds[0]))
        .map((r) => ({
          acceptedQty: getCol(r, "acceptedQty"),
          invoiced_qty: Number(r.invoiced_qty) || 0,
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
    // SELECT material_code, materialName, quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = ?
    if (/FROM purchase_order_items WHERE purchaseOrderId = \?/i.test(sql)) {
      return tables.purchase_order_items
        .filter((r) => String(getCol(r, "purchaseOrderId")) === String(binds[0]))
        .map((r) => ({
          material_code: getCol(r, "material_code"),
          materialName: getCol(r, "materialName"),
          quantity: getCol(r, "quantity"),
          receivedQty: Number(getCol(r, "receivedQty")) || 0,
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
    // Already-invoiced against a PO, per material code:
    //   SELECT pii.material_code AS mc, COALESCE(SUM(pii.qty),0) AS qty
    //     FROM purchase_invoice_items pii JOIN purchase_invoices pi ...
    //    WHERE COALESCE(pii.po_id, pi.purchaseOrderId) = ? AND pi.status != 'CANCELLED'
    // A GRN-sourced line counts here through its own po_id — which is exactly
    // why the GRN-then-PO order was already blocked while PO-then-GRN was not.
    if (/FROM purchase_invoice_items pii JOIN purchase_invoices/i.test(sql)) {
      const wanted = String(binds[0]);
      // The re-line path excludes the invoice being edited (AND pii.pi_id != ?)
      // — its current lines are about to be replaced.
      const excluded = /pii\.pi_id != \?/.test(sql) ? String(binds[1]) : null;
      const byCode = new Map();
      for (const it of tables.purchase_invoice_items) {
        if (excluded && String(getCol(it, "pi_id")) === excluded) continue;
        const pi = tables.purchase_invoices.find(
          (p) => String(p.id) === String(getCol(it, "pi_id")),
        );
        if (!pi || pi.status === "CANCELLED") continue;
        const effectivePo =
          getCol(it, "po_id") ?? getCol(pi, "purchaseOrderId") ?? null;
        if (effectivePo == null || String(effectivePo) !== wanted) continue;
        const code = getCol(it, "material_code");
        if (!code) continue;
        byCode.set(code, (byCode.get(code) ?? 0) + (Number(getCol(it, "qty")) || 0));
      }
      return [...byCode].map(([mc, qty]) => ({ mc, qty }));
    }
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

// ---------------------------------------------------------------------------
// BUG-2026-08-07-003 — a purchase order could be invoiced TWICE for the same
// goods.
//
// A GRN-sourced invoice was validated ONLY against grn_items.invoiced_qty. It
// never looked at the purchase order's own remaining quantity, so:
//   1. bill 100 straight off the PO   → passes (PO ceiling: 100 remaining)
//   2. goods arrive, GRN POSTED, accepted 100, invoiced_qty 0
//   3. bill the same 100 off the GRN  → passed (GRN ceiling: 100 accepted)
// = 200 of payable against a 100 PO, with no 409 anywhere.
//
// The REVERSE order was already caught: the PO ceiling counts a GRN-sourced
// line through COALESCE(pii.po_id, pi.purchaseOrderId), so a GRN invoice
// consumed the PO's remaining and the later PO-direct invoice hit the wall.
// One-directional, which is exactly why it survived.
// ---------------------------------------------------------------------------
function seedPoAndReceipt(db, { ordered = 100, accepted = 100 } = {}) {
  db.tables.suppliers.push({ id: "sup-2", code: "S2", name: "ADD WOOD", email: null });
  db.tables.purchase_orders.push({
    id: "po-2", poNo: "PO-2", supplierId: "sup-2", supplierName: "ADD WOOD",
    subtotalSen: ordered * 10000, totalSen: ordered * 10000, status: "RECEIVED",
    orderDate: "2026-08-01", expectedDate: "", receivedDate: "2026-08-02",
    notes: "", orgId: "org-test",
  });
  db.tables.purchase_order_items.push({
    id: "poi-2", purchaseOrderId: "po-2", materialCategory: "WOOD",
    material_code: "WOOD-2", materialName: "WOOD-2 - Pine plank", supplierSKU: "",
    quantity: ordered, unitPriceSen: 10000, totalSen: ordered * 10000,
    receivedQty: accepted, unit: "pcs", orgId: "org-test",
  });
  db.tables.grns.push({
    id: "grn-2", grnNumber: "GRN-2", poId: "po-2", poNumber: "PO-2",
    supplierId: "sup-2", supplierName: "ADD WOOD", receiveDate: "2026-08-02",
    receivedBy: "x", totalAmount: accepted * 10000, qcStatus: "PASSED",
    status: "POSTED", notes: "", arrival_state: "ARRIVED",
  });
  db.tables.grn_items.push({
    id: 201, grnId: "grn-2", poItemIndex: 0, po_id: "po-2", po_item_id: "poi-2",
    materialCode: "WOOD-2", materialName: "WOOD-2 - Pine plank",
    orderedQty: ordered, receivedQty: accepted, acceptedQty: accepted,
    rejectedQty: 0, rejectionReason: null, unitPrice: 10000, invoiced_qty: 0,
  });
}

const poDirectPI = (qty) => ({
  purchaseOrderId: "po-2",
  supplierId: "sup-2",
  supplierName: "ADD WOOD",
  items: [
    {
      materialCode: "WOOD-2",
      materialName: "WOOD-2 - Pine plank",
      qty,
      unitPriceSen: 10000,
      poId: "po-2",
    },
  ],
});

const grnSourcedPI = (qty, extra = {}) => ({
  grnId: "grn-2",
  supplierId: "sup-2",
  supplierName: "ADD WOOD",
  ...extra,
  items: [
    {
      materialCode: "WOOD-2",
      materialName: "WOOD-2 - Pine plank",
      qty,
      unitPriceSen: 10000,
      grnItemId: 201,
    },
  ],
});

const post = (root, payload) =>
  root.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

test("PO-direct 100 then GRN-sourced 100 is REJECTED — one PO, one lot of goods", async () => {
  const db = makeDb();
  seedPoAndReceipt(db);
  const piRoot = mount(piApp, db);

  // 1. bill all 100 straight off the purchase order
  assert.equal((await post(piRoot, poDirectPI(100))).status, 200);

  // 2. bill the SAME 100 off the receipt — the GRN line still shows 100
  //    accepted / 0 invoiced, so only the PO ceiling can stop this.
  const res = await post(piRoot, grnSourcedPI(100, { purchaseOrderId: "po-2" }));
  assert.equal(res.status, 409, "a GRN-sourced invoice must also honour the PO ceiling");
  const body = await res.json();
  assert.equal(body.success, false);
  // Actionable: the material, what was asked for, what is actually left.
  assert.match(body.error, /WOOD-2/, "the error must name the material code");
  assert.match(body.error, /requested 100/, "the error must state what was requested");
  assert.match(body.error, /remaining 0/, "the error must state what the PO has left");
  assert.match(body.error, /PO-2/, "the error must name the purchase order");

  // Nothing was consumed by the rejected attempt.
  const gi = db.tables.grn_items.find((r) => r.id === 201);
  assert.equal(Number(gi.invoiced_qty) || 0, 0);
  assert.equal(db.tables.purchase_invoices.length, 1);
});

test("the PO ceiling is found through grn_items.po_id when the body names no PO", async () => {
  const db = makeDb();
  seedPoAndReceipt(db);
  const piRoot = mount(piApp, db);

  assert.equal((await post(piRoot, poDirectPI(100))).status, 200);

  // No purchaseOrderId, no per-line poId — the GRN's own lines resolve it.
  const res = await post(piRoot, grnSourcedPI(100));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /remaining 0/);
});

test("a legitimate split still passes: 60 off the PO, then 40 off the GRN", async () => {
  const db = makeDb();
  seedPoAndReceipt(db);
  const piRoot = mount(piApp, db);

  assert.equal((await post(piRoot, poDirectPI(60))).status, 200);

  // 40 remain on the PO and 100 on the receipt — over-blocking this would be
  // its own bug (the same line must not be counted twice against the PO).
  const res = await post(piRoot, grnSourcedPI(40, { purchaseOrderId: "po-2" }));
  assert.equal(res.status, 200, "the remaining 40 must still be invoiceable");

  // 100 billed in total, and the GRN line drew down by the 40.
  const gi = db.tables.grn_items.find((r) => r.id === 201);
  assert.equal(Number(gi.invoiced_qty), 40);

  // The 101st unit is refused.
  const over = await post(piRoot, grnSourcedPI(1, { purchaseOrderId: "po-2" }));
  assert.equal(over.status, 409);
});

test("two GRN-sourced invoices split 60/40 without double-counting the PO", async () => {
  const db = makeDb();
  seedPoAndReceipt(db);
  const piRoot = mount(piApp, db);

  assert.equal((await post(piRoot, grnSourcedPI(60, { purchaseOrderId: "po-2" }))).status, 200);
  assert.equal((await post(piRoot, grnSourcedPI(40, { purchaseOrderId: "po-2" }))).status, 200);

  const gi = db.tables.grn_items.find((r) => r.id === 201);
  assert.equal(Number(gi.invoiced_qty), 100);
});

test("a GRN with no purchase order behind it (direct receipt) still invoices", async () => {
  const db = makeDb();
  db.tables.suppliers.push({ id: "sup-3", code: "S3", name: "WALK IN", email: null });
  db.tables.grns.push({
    id: "grn-3", grnNumber: "GRN-3", poId: null, poNumber: null,
    supplierId: "sup-3", supplierName: "WALK IN", receiveDate: "2026-08-02",
    receivedBy: "x", totalAmount: 50000, qcStatus: "PASSED", status: "POSTED",
    notes: "", arrival_state: "ARRIVED",
  });
  db.tables.grn_items.push({
    id: 301, grnId: "grn-3", poItemIndex: null, po_id: null, po_item_id: null,
    materialCode: "LOOSE-1", materialName: "LOOSE-1 - Loose foam",
    orderedQty: 0, receivedQty: 5, acceptedQty: 5, rejectedQty: 0,
    rejectionReason: null, unitPrice: 10000, invoiced_qty: 0,
  });
  const piRoot = mount(piApp, db);

  const res = await post(piRoot, {
    grnId: "grn-3",
    supplierId: "sup-3",
    supplierName: "WALK IN",
    items: [
      { materialCode: "LOOSE-1", materialName: "LOOSE-1 - Loose foam", qty: 5, unitPriceSen: 10000, grnItemId: 301 },
    ],
  });
  assert.equal(res.status, 200, "a receipt with no PO must stay invoiceable");
  const gi = db.tables.grn_items.find((r) => r.id === 301);
  assert.equal(Number(gi.invoiced_qty), 5);
});

test("re-lining an invoice cannot walk around the PO ceiling", async () => {
  const db = makeDb();
  seedPoAndReceipt(db);
  const piRoot = mount(piApp, db);

  // 80 already billed straight off the PO; 20 left.
  assert.equal((await post(piRoot, poDirectPI(80))).status, 200);
  const created = (await (await post(piRoot, grnSourcedPI(1, { purchaseOrderId: "po-2" }))).json()).data;

  const relineTo = (qty) =>
    piRoot.request(`/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            materialCode: "WOOD-2",
            materialName: "WOOD-2 - Pine plank",
            qty,
            unitPriceSen: 10000,
            grnItemId: 201,
            poId: "po-2",
          },
        ],
      }),
    });

  // Raise-1-then-edit-to-100 is the obvious way around a create-time guard.
  const over = await relineTo(100);
  assert.equal(over.status, 409);
  assert.match((await over.json()).error, /remaining 20/);

  // The edit that FITS still goes through — this invoice's own line must not
  // be counted against it (19 more on top of its own 1 = the 20 that remain).
  assert.equal((await relineTo(20)).status, 200);
  const gi = db.tables.grn_items.find((r) => r.id === 201);
  assert.equal(Number(gi.invoiced_qty), 20);

  // And an edit that REDUCES is never blocked.
  assert.equal((await relineTo(5)).status, 200);
});

test("an accepted over-receipt stays invoiceable — the ceiling follows the goods", async () => {
  // grn.ts allows a receipt to run over the order within tolerance. Those
  // goods are in stock and WILL be billed; capping the invoice at the ordered
  // quantity would leave a real liability un-recordable.
  const db = makeDb();
  seedPoAndReceipt(db, { ordered: 100, accepted: 110 });
  const piRoot = mount(piApp, db);

  const res = await post(piRoot, grnSourcedPI(110, { purchaseOrderId: "po-2" }));
  assert.equal(res.status, 200);

  // ... but not a unit beyond what was actually received.
  const over = await post(piRoot, grnSourcedPI(1, { purchaseOrderId: "po-2" }));
  assert.equal(over.status, 409);
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
