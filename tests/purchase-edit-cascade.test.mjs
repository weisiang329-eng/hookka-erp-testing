// ---------------------------------------------------------------------------
// purchase-edit-cascade.test.mjs — behavioral test of the editable-PI /
// editable-GRN cascades (owner ruling 2026-06-22), driven through the REAL
// grn.ts + purchase-invoices.ts Hono handlers against a stateful in-memory mock
// D1 (same approach as purchasing-convert-flow.test.mjs, with extra SQL handlers
// for the new edit paths).
//
// Asserts:
//   GRN  — editing a POSTED line's accepted qty (5 → 3) posts a compensating
//          stock movement: raw_materials.balanceQty −2, the GRN batch's
//          remaining/original −2, one cost_ledger ADJUSTMENT OUT entry; editing
//          back (3 → 5) is a NET no-op (balance + batch return to start).
//   GRN  — reducing accepted below the already-invoiced qty is BLOCKED (409).
//   PI   — editing an APPROVED PI's GRN-sourced line qty (6 → 4) drops that GRN
//          line's invoiced_qty to 4 (the convert chain follows the edit).
//   PI   — a PAID PI cannot be line-edited (409).
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
// Stateful in-memory mock D1 — a tiny SQL interpreter scoped to the statements
// these two routes issue along the edit paths.
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
    ledger_journal_entries: [],
    kv_config: [],
    suppliers: [],
    supplier_material_bindings: [],
    audit_events: [],
  };
  let autoId = 1;
  const norm = (s) => s.trim().replace(/\s+/g, " ");

  function prepare(rawSql) {
    const sql = norm(rawSql);
    let binds = [];
    return {
      bind(...args) {
        binds = args;
        return this;
      },
      async run() {
        exec(sql, binds);
        return { success: true, meta: { changes: 1 } };
      },
      async first() {
        return query(sql, binds)[0] ?? null;
      },
      async all() {
        return { results: query(sql, binds) };
      },
    };
  }

  async function batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }

  function getCol(row, col) {
    if (row[col] !== undefined) return row[col];
    const snake = col.replace(/[A-Z]/g, (x) => "_" + x.toLowerCase());
    const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return row[snake] ?? row[camel];
  }

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
        row[col] = rhs.slice(1, -1);
      } else if (rhs.includes("?")) {
        // expression with a placeholder, e.g. balanceQty = balanceQty + ? OR
        // MAX(0, COALESCE(col,0) + ?). Evaluate the few shapes we need.
        const cur = Number(getCol(row, col)) || 0;
        const arg = Number(setBinds[bi++]) || 0;
        if (/MAX\(0,/.test(rhs)) {
          row[col] = Math.max(0, cur + arg);
        } else if (/\+ \?/.test(rhs)) {
          row[col] = cur + arg;
        } else if (/- \?/.test(rhs)) {
          row[col] = cur - arg;
        } else {
          row[col] = arg;
        }
      }
    }
  }

  function exec(sql, binds) {
    if (/^ALTER TABLE/i.test(sql) || /^CREATE /i.test(sql) || /pg_advisory_xact_lock/i.test(sql)) {
      return;
    }
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
    // grn_items invoiced_qty +/- (convert chain)
    m = sql.match(/^UPDATE grn_items SET invoiced_qty = COALESCE\(invoiced_qty, 0\) \+ \? WHERE id = \?/i);
    if (m) {
      const [delta, id] = binds;
      const gi = tables.grn_items.find((r) => String(r.id) === String(id));
      if (gi) gi.invoiced_qty = (Number(gi.invoiced_qty) || 0) + Number(delta);
      return;
    }
    m = sql.match(/^UPDATE grn_items SET invoiced_qty = invoiced_qty - \? WHERE id = \?/i);
    if (m) {
      const [delta, id] = binds;
      const gi = tables.grn_items.find((r) => String(r.id) === String(id));
      if (gi) gi.invoiced_qty = (Number(gi.invoiced_qty) || 0) - Number(delta);
      return;
    }
    // grn_items accepted/received rewrite on a POSTED edit
    m = sql.match(/^UPDATE grn_items SET acceptedQty = \?, receivedQty = \? WHERE id = \?/i);
    if (m) {
      const [acc, rec, id] = binds;
      const gi = tables.grn_items.find((r) => String(r.id) === String(id));
      if (gi) {
        gi.acceptedQty = Number(acc);
        gi.receivedQty = Number(rec);
      }
      return;
    }
    // raw_materials.balanceQty bump
    m = sql.match(/^UPDATE raw_materials SET balanceQty = balanceQty \+ \? WHERE id = \?/i);
    if (m) {
      const [delta, id] = binds;
      const rm = tables.raw_materials.find((r) => String(r.id) === String(id));
      if (rm) rm.balanceQty = (Number(rm.balanceQty) || 0) + Number(delta);
      return;
    }
    // rm_batches remaining/original adjust — the production statement is
    //   SET originalQty = MAX(0, COALESCE(originalQty,0)+?),
    //       remainingQty = MAX(0, COALESCE(remainingQty,0)+?) WHERE id=?
    // The nested comma inside MAX(...) defeats a naive comma-split, so match it
    // explicitly. binds = [deltaOriginal, deltaRemaining, id].
    m = sql.match(/^UPDATE rm_batches SET originalQty = MAX\(0, COALESCE\(originalQty, 0\) \+ \?\), remainingQty = MAX\(0, COALESCE\(remainingQty, 0\) \+ \?\) WHERE id = \?/i);
    if (m) {
      const [dOrig, dRem, id] = binds;
      const b = tables.rm_batches.find((r) => String(r.id) === String(id));
      if (b) {
        b.originalQty = Math.max(0, (Number(b.originalQty) || 0) + Number(dOrig));
        b.remainingQty = Math.max(0, (Number(b.remainingQty) || 0) + Number(dRem));
      }
      return;
    }
    // generic rm_batches SET (fallback)
    m = sql.match(/^UPDATE rm_batches SET (.+) WHERE id = \?/i);
    if (m) {
      const id = binds[binds.length - 1];
      const b = tables.rm_batches.find((r) => String(r.id) === String(id));
      if (b) applySet(b, m[1], binds.slice(0, -1));
      return;
    }
    // PO receivedQty +/- (cascades)
    m = sql.match(/^UPDATE purchase_order_items SET receivedQty = receivedQty ([+-]) \? WHERE id = \?/i);
    if (m) {
      const sign = m[1] === "+" ? 1 : -1;
      const [delta, id] = binds;
      const poi = tables.purchase_order_items.find((r) => String(r.id) === String(id));
      if (poi) poi.receivedQty = (Number(poi.receivedQty) || 0) + sign * Number(delta);
      return;
    }
    m = sql.match(/^UPDATE grns SET (.+) WHERE id = \?/i);
    if (m) {
      const id = binds[binds.length - 1];
      const g = tables.grns.find((r) => String(r.id) === String(id));
      if (g) applySet(g, m[1], binds.slice(0, -1));
      return;
    }
    m = sql.match(/^UPDATE purchase_orders SET (.+) WHERE id = \?( AND status IN \([^)]*\))?/i);
    if (m) {
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
    m = sql.match(/^UPDATE purchase_invoices SET (.+) WHERE id = \?/i);
    if (m) {
      const id = binds[binds.length - 1];
      const pi = tables.purchase_invoices.find((r) => String(r.id) === String(id));
      if (pi) applySet(pi, m[1], binds.slice(0, -1));
      return;
    }
    m = sql.match(/^DELETE FROM (\w+) WHERE (\w+) = \?/i);
    if (m) {
      const [table, col] = [m[1], m[2]];
      const val = binds[0];
      tables[table] = tables[table].filter((r) => String(getCol(r, col)) !== String(val));
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
  }

  function query(sql, binds) {
    if (/FROM grns WHERE grnNumber LIKE/i.test(sql)) return [];
    if (/FROM purchase_invoices WHERE piNo LIKE/i.test(sql)) return [];
    if (/FROM purchase_orders WHERE poNo LIKE/i.test(sql)) return [];
    if (/FROM role_permissions/i.test(sql)) return [];
    if (/FROM ledger_journal_entries/i.test(sql)) {
      // getLastJournalHash — empty chain head is fine for the test.
      return [];
    }
    if (/FROM kv_config WHERE key = \?/i.test(sql)) {
      return tables.kv_config.filter((r) => String(r.key) === String(binds[0]));
    }
    if (/^SELECT \* FROM raw_materials$/i.test(sql)) return tables.raw_materials.slice();
    if (/FROM raw_materials WHERE itemCode = \?/i.test(sql)) {
      return tables.raw_materials.filter((r) => String(getCol(r, "itemCode")) === String(binds[0]));
    }
    if (/FROM raw_materials WHERE description = \?/i.test(sql)) {
      return tables.raw_materials.filter((r) => String(getCol(r, "description")) === String(binds[0]));
    }
    if (/FROM supplier_material_bindings WHERE supplierSku = \?/i.test(sql)) {
      return tables.supplier_material_bindings.filter((r) => String(getCol(r, "supplierSku")) === String(binds[0]));
    }
    if (/FROM rm_batches WHERE source = 'GRN' AND sourceRefId = \?/i.test(sql)) {
      return tables.rm_batches.filter((r) => getCol(r, "source") === "GRN" && String(getCol(r, "sourceRefId")) === String(binds[0]));
    }
    if (/SELECT id, originalQty, remainingQty FROM rm_batches WHERE id = \?/i.test(sql)) {
      return tables.rm_batches
        .filter((r) => String(r.id) === String(binds[0]))
        .map((r) => ({ id: r.id, originalQty: getCol(r, "originalQty"), remainingQty: getCol(r, "remainingQty") }));
    }
    if (/FROM grns WHERE id = \?/i.test(sql) && /SELECT poId FROM grns/i.test(sql)) {
      return tables.grns.filter((r) => String(r.id) === String(binds[0])).map((r) => ({ poId: getCol(r, "poId") }));
    }
    if (/FROM grns WHERE id = \?/i.test(sql)) {
      return tables.grns.filter((r) => String(r.id) === String(binds[0]));
    }
    if (/SELECT id, poId, poNumber FROM grns WHERE id = \?/i.test(sql)) {
      return tables.grns
        .filter((r) => String(r.id) === String(binds[0]))
        .map((r) => ({ id: r.id, poId: getCol(r, "poId"), poNumber: getCol(r, "poNumber") }));
    }
    if (/FROM grn_items WHERE grnId = \?/i.test(sql)) {
      return tables.grn_items
        .filter((r) => String(getCol(r, "grnId")) === String(binds[0]))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }
    if (/^SELECT \* FROM grn_items$/i.test(sql)) return tables.grn_items.slice();
    if (/SELECT acceptedQty, invoiced_qty FROM grn_items WHERE id = \?/i.test(sql)) {
      return tables.grn_items
        .filter((r) => String(r.id) === String(binds[0]))
        .map((r) => ({ acceptedQty: getCol(r, "acceptedQty"), invoiced_qty: Number(r.invoiced_qty) || 0 }));
    }
    if (/SELECT invoiced_qty FROM grn_items WHERE id = \?/i.test(sql)) {
      return tables.grn_items
        .filter((r) => String(r.id) === String(binds[0]))
        .map((r) => ({ invoiced_qty: Number(r.invoiced_qty) || 0 }));
    }
    // restorePOReceivedQtyForGRN reads the CURRENT receivedQty per target line
    // so a double-restore can't drive a PO line negative.
    if (/SELECT id, receivedQty FROM purchase_order_items WHERE id IN \(/i.test(sql)) {
      return tables.purchase_order_items
        .filter((r) => binds.map(String).includes(String(r.id)))
        .map((r) => ({ id: r.id, receivedQty: Number(getCol(r, "receivedQty")) || 0 }));
    }
    // The cancel path names the materials whose stock has already been issued.
    if (/SELECT id, itemCode, description FROM raw_materials WHERE id IN \(/i.test(sql)) {
      return tables.raw_materials
        .filter((r) => binds.map(String).includes(String(r.id)))
        .map((r) => ({ id: r.id, itemCode: getCol(r, "itemCode"), description: getCol(r, "description") }));
    }
    if (/SELECT id, quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = \?/i.test(sql)) {
      return tables.purchase_order_items
        .filter((r) => String(getCol(r, "purchaseOrderId")) === String(binds[0]))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((r) => ({ id: r.id, quantity: getCol(r, "quantity"), receivedQty: Number(getCol(r, "receivedQty")) || 0 }));
    }
    if (/SELECT quantity, receivedQty FROM purchase_order_items WHERE purchaseOrderId = \?/i.test(sql)) {
      return tables.purchase_order_items
        .filter((r) => String(getCol(r, "purchaseOrderId")) === String(binds[0]))
        .map((r) => ({ quantity: getCol(r, "quantity"), receivedQty: Number(getCol(r, "receivedQty")) || 0 }));
    }
    if (/FROM purchase_order_items WHERE purchaseOrderId = \?/i.test(sql)) {
      return tables.purchase_order_items
        .filter((r) => String(getCol(r, "purchaseOrderId")) === String(binds[0]))
        .map((r) => ({ material_code: getCol(r, "material_code"), materialName: getCol(r, "materialName"), quantity: getCol(r, "quantity") }));
    }
    if (/FROM purchase_invoices WHERE id = \?/i.test(sql)) {
      return tables.purchase_invoices.filter((r) => String(r.id) === String(binds[0]));
    }
    if (/SELECT piNo FROM purchase_invoices WHERE grn_id = \? AND status != 'CANCELLED'/i.test(sql)) {
      return tables.purchase_invoices
        .filter((r) => String(getCol(r, "grn_id")) === String(binds[0]) && r.status !== "CANCELLED")
        .map((r) => ({ piNo: r.piNo }));
    }
    if (/SELECT grn_item_id, qty FROM purchase_invoice_items WHERE pi_id = \?/i.test(sql)) {
      return tables.purchase_invoice_items
        .filter((r) => String(getCol(r, "pi_id")) === String(binds[0]))
        .map((r) => ({ grn_item_id: getCol(r, "grn_item_id"), qty: getCol(r, "qty") }));
    }
    if (/FROM purchase_invoice_items WHERE pi_id = \?/i.test(sql)) {
      return tables.purchase_invoice_items.filter((r) => String(getCol(r, "pi_id")) === String(binds[0]));
    }
    if (/FROM purchase_invoice_items pii JOIN purchase_invoices/i.test(sql)) return [];
    if (/FROM purchase_orders WHERE id = \?/i.test(sql)) {
      return tables.purchase_orders.filter((r) => String(r.id) === String(binds[0]));
    }
    return [];
  }

  return { tables, prepare, batch };
}

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

// A PO (one line, 10 ordered) fully received via a POSTED GRN that posted stock.
function seed(db) {
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
  // The RM the GRN resolves to (by "CODE - desc" split on materialName).
  db.tables.raw_materials.push({
    id: "rm-foam-1", itemCode: "FOAM-1", item_code: "FOAM-1", description: "FOAM-1 - Foam block",
    item_group: "B.FILLER", balanceQty: 5,
  });
  // POSTED GRN, one line: accepted 5 (so balanceQty 5 reflects the post).
  db.tables.grns.push({
    id: "grn-1", grnNumber: "GRN-1", poId: "po-1", poNumber: "PO-1",
    supplierId: "sup-1", supplierName: "ACME", receiveDate: "2026-06-02",
    receivedBy: "x", totalAmount: 50000, qcStatus: "PASSED", status: "POSTED",
    notes: "", arrival_state: "ARRIVED",
  });
  db.tables.grn_items.push({
    id: 201, grnId: "grn-1", poItemIndex: 0, materialCode: "FOAM-1",
    materialName: "FOAM-1 - Foam block", orderedQty: 10, receivedQty: 5,
    acceptedQty: 5, rejectedQty: 0, rejectionReason: null, unitPrice: 10000,
    invoiced_qty: 0,
  });
  // The batch the post wrote — line index 0 → rmb-grn-grn-1-1.
  db.tables.rm_batches.push({
    id: "rmb-grn-grn-1-1", rmId: "rm-foam-1", source: "GRN", sourceRefId: "grn-1",
    receivedDate: "2026-06-02", originalQty: 5, remainingQty: 5, unitCostSen: 10000,
    created_at: "2026-06-02", notes: "GRN GRN-1 line 1",
  });
}

async function getGrn(grnRoot, grnId) {
  const res = await grnRoot.request(`/${grnId}`);
  return (await res.json()).data;
}

async function editGrnAccepted(grnRoot, grn, lineIdx, newAccepted) {
  const items = grn.items.map((it, i) => ({
    poItemIndex: it.poItemIndex,
    materialCode: it.materialCode,
    materialName: it.materialName,
    orderedQty: it.orderedQty,
    receivedQty: it.receivedQty,
    acceptedQty: i === lineIdx ? newAccepted : it.acceptedQty,
    rejectedQty: it.rejectedQty,
    rejectionReason: it.rejectionReason,
    unitPrice: it.unitPrice,
  }));
  return grnRoot.request(`/${grn.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
}

// ---------------------------------------------------------------------------
test("GRN POSTED edit 5→3 moves stock −2; editing back 3→5 is a net no-op", async () => {
  const db = makeDb();
  seed(db);
  const grnRoot = mount(grnApp, db);

  const rm = () => db.tables.raw_materials.find((r) => r.id === "rm-foam-1");
  const batch = () => db.tables.rm_batches.find((r) => r.id === "rmb-grn-grn-1-1");
  assert.equal(rm().balanceQty, 5);
  assert.equal(batch().remainingQty, 5);

  // Reduce accepted 5 → 3.
  let grn = await getGrn(grnRoot, "grn-1");
  let res = await editGrnAccepted(grnRoot, grn, 0, 3);
  assert.equal(res.status, 200, await res.text());

  // Stock dropped by 2 (balance + batch original/remaining).
  assert.equal(rm().balanceQty, 3, "balanceQty must drop by the −2 delta");
  assert.equal(batch().remainingQty, 3, "batch remaining must drop by the delta");
  assert.equal(batch().originalQty, 3, "batch original must drop by the delta");
  // grn_items.acceptedQty now 3.
  assert.equal(db.tables.grn_items.find((r) => r.id === 201).acceptedQty, 3);
  // A compensating cost_ledger ADJUSTMENT OUT entry was written.
  const adj = db.tables.cost_ledger.filter((r) => r.type === "ADJUSTMENT" && r.direction === "OUT");
  assert.equal(adj.length, 1, "one compensating ADJUSTMENT OUT entry");
  assert.equal(Number(adj[0].qty), 2);

  // Edit back 3 → 5 — net no-op on stock.
  grn = await getGrn(grnRoot, "grn-1");
  res = await editGrnAccepted(grnRoot, grn, 0, 5);
  assert.equal(res.status, 200, await res.text());
  assert.equal(rm().balanceQty, 5, "balanceQty restored to start");
  assert.equal(batch().remainingQty, 5, "batch remaining restored to start");
  assert.equal(batch().originalQty, 5, "batch original restored to start");
  // A second compensating entry, this time RM_RECEIPT IN for +2.
  const inEntries = db.tables.cost_ledger.filter((r) => r.type === "RM_RECEIPT" && r.direction === "IN");
  assert.equal(inEntries.length, 1, "one compensating RM_RECEIPT IN entry");
  assert.equal(Number(inEntries[0].qty), 2);
});

test("GRN POSTED edit: an invoiced line is frozen (its OWN line only)", async () => {
  const db = makeDb();
  seed(db);
  // A PI has billed 4 of the 5 accepted on the receipt's only line. That line
  // cannot move — and since it is the only one, the document has nothing left
  // to correct, so the refusal is the whole-document one.
  db.tables.grn_items.find((r) => r.id === 201).invoiced_qty = 4;
  const grnRoot = mount(grnApp, db);

  const grn = await getGrn(grnRoot, "grn-1");
  const res = await editGrnAccepted(grnRoot, grn, 0, 3);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /purchase invoice/);
  // Stock untouched.
  assert.equal(db.tables.raw_materials.find((r) => r.id === "rm-foam-1").balanceQty, 5);
});

// ---------------------------------------------------------------------------
// DEFECT B — one invoiced line used to lock the whole GRN. It must lock ONLY
// itself; every other line stays correctable, with the usual compensating
// stock movement.
// ---------------------------------------------------------------------------
test("GRN POSTED edit: one invoiced line does NOT lock the rest of the receipt", async () => {
  const db = makeDb();
  seed(db);
  // Add a second, un-invoiced line (wood) with its own posted lot, and bill
  // the first line (foam) on a PI.
  db.tables.grn_items.find((r) => r.id === 201).invoiced_qty = 5;
  db.tables.raw_materials.push({
    id: "rm-wood-1", itemCode: "WOOD-1", item_code: "WOOD-1",
    description: "WOOD-1 - Wood plank", item_group: "A.WOOD", balanceQty: 8,
  });
  db.tables.purchase_order_items.push({
    id: "poi-2", purchaseOrderId: "po-1", materialCategory: "WOOD",
    material_code: "WOOD-1", materialName: "WOOD-1 - Wood plank", supplierSKU: "",
    quantity: 8, unitPriceSen: 5000, totalSen: 40000, receivedQty: 8, unit: "pcs",
    orgId: "org-test",
  });
  db.tables.grn_items.push({
    id: 202, grnId: "grn-1", poItemIndex: 1, materialCode: "WOOD-1",
    materialName: "WOOD-1 - Wood plank", orderedQty: 8, receivedQty: 8,
    acceptedQty: 8, rejectedQty: 0, rejectionReason: null, unitPrice: 5000,
    invoiced_qty: 0,
  });
  db.tables.rm_batches.push({
    id: "rmb-grn-grn-1-2", rmId: "rm-wood-1", source: "GRN", sourceRefId: "grn-1",
    receivedDate: "2026-06-02", originalQty: 8, remainingQty: 8, unitCostSen: 5000,
    created_at: "2026-06-02", notes: "GRN GRN-1 line 2",
  });
  const grnRoot = mount(grnApp, db);

  // Correct the UN-invoiced wood line 8 → 6 while the foam line stays billed.
  const grn = await getGrn(grnRoot, "grn-1");
  const res = await editGrnAccepted(grnRoot, grn, 1, 6);
  assert.equal(res.status, 200, await res.text());

  // The correctable line moved, stock followed it.
  assert.equal(db.tables.grn_items.find((r) => r.id === 202).acceptedQty, 6);
  assert.equal(db.tables.raw_materials.find((r) => r.id === "rm-wood-1").balanceQty, 6);
  assert.equal(db.tables.rm_batches.find((r) => r.id === "rmb-grn-grn-1-2").remainingQty, 6);
  // The invoiced line is untouched — qty, stock and its lot all stand still.
  assert.equal(db.tables.grn_items.find((r) => r.id === 201).acceptedQty, 5);
  assert.equal(db.tables.raw_materials.find((r) => r.id === "rm-foam-1").balanceQty, 5);

  // And the invoiced line itself still refuses to move.
  const grn2 = await getGrn(grnRoot, "grn-1");
  const blocked = await editGrnAccepted(grnRoot, grn2, 0, 4);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /purchase invoice/);
  assert.equal(db.tables.grn_items.find((r) => r.id === 201).acceptedQty, 5);
});

test("GRN POSTED edit: cannot add or remove lines (count must match)", async () => {
  const db = makeDb();
  seed(db);
  const grnRoot = mount(grnApp, db);
  const res = await grnRoot.request("/grn-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [] }), // 0 lines vs 1 existing
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /can't be added or removed/);
});

// ---------------------------------------------------------------------------
// DEFECT A — a POSTED GRN must have a way to die that RESTORES what it took.
// Cancel reverses the perpetual stock (balanceQty + the receipt's FIFO lots)
// and hands purchase_order_items.receivedQty back so the PO is receivable
// again. It refuses while a live PI draws on the lines, and refuses when the
// received stock has already been issued (a partial un-receive would corrupt
// inventory).
// ---------------------------------------------------------------------------
test("cancelling a POSTED GRN restores the PO's receivedQty and reverses stock", async () => {
  const db = makeDb();
  seed(db);
  const grnRoot = mount(grnApp, db);

  assert.equal(db.tables.purchase_order_items.find((r) => r.id === "poi-1").receivedQty, 10);
  assert.equal(db.tables.raw_materials.find((r) => r.id === "rm-foam-1").balanceQty, 5);
  assert.equal(db.tables.rm_batches.filter((r) => r.sourceRefId === "grn-1").length, 1);

  const res = await grnRoot.request("/grn-1/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200, await res.text());

  // Status is terminal-cancelled with an audit stamp.
  const grnRow = db.tables.grns.find((r) => r.id === "grn-1");
  assert.equal(grnRow.status, "CANCELLED");
  assert.ok(grnRow.cancelled_at, "cancelled_at must be stamped");

  // PO line handed back its 5, so the order is receivable again (10 − 5 = 5)
  // and its status drops out of RECEIVED.
  assert.equal(db.tables.purchase_order_items.find((r) => r.id === "poi-1").receivedQty, 5);
  assert.equal(db.tables.purchase_orders.find((r) => r.id === "po-1").status, "PARTIAL_RECEIVED");

  // Perpetual stock reversed: on-hand back down and the receipt's lot gone.
  assert.equal(db.tables.raw_materials.find((r) => r.id === "rm-foam-1").balanceQty, 0);
  assert.equal(db.tables.rm_batches.filter((r) => r.sourceRefId === "grn-1").length, 0);

  // No compensating cost_ledger row: the FIFO/P&L replay sources GRN receipts
  // from grn_items joined on status IN ('CONFIRMED','POSTED'), so CANCELLED
  // already removes the receipt — an ADJUSTMENT OUT would reduce it twice.
  assert.equal(
    db.tables.cost_ledger.filter((r) => r.type === "ADJUSTMENT").length,
    0,
    "cancel must not double-reduce material cost with an ADJUSTMENT leg",
  );

  // Terminal: the cancelled receipt can't be edited or resurrected.
  const reopen = await grnRoot.request("/grn-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "POSTED" }),
  });
  assert.equal(reopen.status, 409);
  assert.match((await reopen.json()).error, /CANCELLED/);

  // And cancelling twice is refused rather than double-restoring.
  const again = await grnRoot.request("/grn-1/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(again.status, 409);
  assert.equal(db.tables.purchase_order_items.find((r) => r.id === "poi-1").receivedQty, 5);
});

test("cancel is REFUSED while a live purchase invoice draws on the GRN", async () => {
  const db = makeDb();
  seed(db);
  db.tables.grn_items.find((r) => r.id === 201).invoiced_qty = 5;
  db.tables.purchase_invoices.push({
    id: "pi-9", piNo: "PI-9", purchaseOrderId: "po-1", grn_id: "grn-1",
    supplierId: "sup-1", supplierName: "ACME", invoiceDate: "2026-06-03",
    amountSen: 50000, status: "CONFIRMED", currency: "MYR",
  });
  const grnRoot = mount(grnApp, db);

  const res = await grnRoot.request("/grn-1/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 409);
  const err = (await res.json()).error;
  assert.match(err, /PI-9/);
  assert.match(err, /Void that invoice first/);

  // Nothing moved — not the PO, not stock, not the lot, not the status.
  assert.equal(db.tables.purchase_order_items.find((r) => r.id === "poi-1").receivedQty, 10);
  assert.equal(db.tables.raw_materials.find((r) => r.id === "rm-foam-1").balanceQty, 5);
  assert.equal(db.tables.rm_batches.filter((r) => r.sourceRefId === "grn-1").length, 1);
  assert.equal(db.tables.grns.find((r) => r.id === "grn-1").status, "POSTED");
});

test("cancel is REFUSED once the received stock has been issued", async () => {
  const db = makeDb();
  seed(db);
  // Production drew 2 of the 5 off this receipt's lot (remaining < original).
  // Un-receiving all 5 would drive balanceQty below what is physically there.
  db.tables.rm_batches.find((r) => r.id === "rmb-grn-grn-1-1").remainingQty = 3;
  db.tables.raw_materials.find((r) => r.id === "rm-foam-1").balanceQty = 3;
  const grnRoot = mount(grnApp, db);

  const res = await grnRoot.request("/grn-1/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 409);
  const err = (await res.json()).error;
  assert.match(err, /already been issued or returned/);
  assert.match(err, /FOAM-1/, "the refusal must name the material");

  // Refuse, don't guess: everything stands exactly as it was.
  assert.equal(db.tables.purchase_order_items.find((r) => r.id === "poi-1").receivedQty, 10);
  assert.equal(db.tables.raw_materials.find((r) => r.id === "rm-foam-1").balanceQty, 3);
  assert.equal(db.tables.rm_batches.filter((r) => r.sourceRefId === "grn-1").length, 1);
  assert.equal(db.tables.grns.find((r) => r.id === "grn-1").status, "POSTED");
});

// ---------------------------------------------------------------------------
// PI APPROVED edit — the GRN-sourced line qty change follows into invoiced_qty.
// ---------------------------------------------------------------------------
function seedApprovedPi(db) {
  seed(db);
  // GRN line 201 has been invoiced 6 by an APPROVED PI.
  db.tables.grn_items.find((r) => r.id === 201).acceptedQty = 10;
  db.tables.grn_items.find((r) => r.id === 201).invoiced_qty = 6;
  db.tables.purchase_invoices.push({
    id: "pi-1", piNo: "PI-1", purchaseOrderId: "po-1", poRef: "PO-1", grn_id: "grn-1",
    supplierId: "sup-1", supplierName: "ACME", invoiceDate: "2026-06-03", dueDate: "2026-07-31",
    amountSen: 60000, paid_amount_sen: 0, status: "DRAFT", remarks: "", currency: "MYR",
    created_at: "2026-06-03", updated_at: "2026-06-03",
  });
  db.tables.purchase_invoice_items.push({
    id: "pii-1", pi_id: "pi-1", material_code: "FOAM-1", material_name: "FOAM-1 - Foam block",
    supplier_sku: null, qty: 6, unit_price_sen: 10000, line_total_sen: 60000,
    line_type: "STOCKED", notes: null, grn_item_id: 201, created_at: "2026-06-03", updated_at: null,
  });
}

test("PI APPROVED edit 6→4 drops the GRN line's invoiced_qty to 4", async () => {
  const db = makeDb();
  seedApprovedPi(db);
  const piRoot = mount(piApp, db);

  assert.equal(Number(db.tables.grn_items.find((r) => r.id === 201).invoiced_qty), 6);

  // Edit the PI line down to qty 4 (keeping the GRN link).
  const res = await piRoot.request("/pi-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        { materialCode: "FOAM-1", materialName: "FOAM-1 - Foam block", qty: 4, unitPriceSen: 10000, lineType: "STOCKED", grnItemId: 201 },
      ],
    }),
  });
  assert.equal(res.status, 200, await res.text());

  // invoiced_qty followed the edit: 6 → 4.
  assert.equal(Number(db.tables.grn_items.find((r) => r.id === 201).invoiced_qty), 4);
  // The PI amount recomputed to 4 × 100.00 = 40000 sen.
  assert.equal(Number(db.tables.purchase_invoices.find((r) => r.id === "pi-1").amountSen), 40000);
});

test("PI APPROVED edit cannot push invoiced_qty past the GRN line's acceptedQty", async () => {
  const db = makeDb();
  seedApprovedPi(db);
  // acceptedQty 10, this PI billed 6, no other PIs → max this PI can claim is 10.
  const piRoot = mount(piApp, db);
  const res = await piRoot.request("/pi-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        { materialName: "FOAM-1 - Foam block", qty: 11, unitPriceSen: 10000, lineType: "STOCKED", grnItemId: 201 },
      ],
    }),
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /available/);
  // invoiced_qty unchanged.
  assert.equal(Number(db.tables.grn_items.find((r) => r.id === 201).invoiced_qty), 6);
});

test("PI CONFIRMED edit reverses GL and reposts (delta correction)", async () => {
  const db = makeDb();
  seedApprovedPi(db);
  // Flip the seed PI to CONFIRMED — and seed a pretend prior posting in the
  // ledger so the read-back proves we DIDN'T mutate it. The GL CORRECTION
  // block writes NEW rows with sourceId = `${piId}:edit-…`, not the original.
  db.tables.purchase_invoices.find((r) => r.id === "pi-1").status = "CONFIRMED";
  db.tables.ledger_journal_entries.push({
    id: "lje-orig-1", sourceType: "purchase_invoice", sourceId: "pi-1",
    legNo: 1, accountCode: "703-0010", debitSen: 60000, creditSen: 0,
    description: "Purchase · PI PI-1", orgId: "org-test",
  });
  db.tables.ledger_journal_entries.push({
    id: "lje-orig-2", sourceType: "purchase_invoice", sourceId: "pi-1",
    legNo: 2, accountCode: "400-0000", debitSen: 0, creditSen: 60000,
    description: "AP · PI PI-1", orgId: "org-test",
  });
  const beforeLedgerCount = db.tables.ledger_journal_entries.length;

  const piRoot = mount(piApp, db);

  // Edit the line down to qty 4 (from 6) — amount drops 60000 → 40000 (delta −20000).
  const res = await piRoot.request("/pi-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        { materialCode: "FOAM-1", materialName: "FOAM-1 - Foam block", qty: 4, unitPriceSen: 10000, lineType: "STOCKED", grnItemId: 201 },
      ],
    }),
  });
  assert.equal(res.status, 200, await res.text());

  const piRow = db.tables.purchase_invoices.find((r) => r.id === "pi-1");
  // PI line total recomputed: 4 × 100.00 = 40000 sen.
  assert.equal(Number(piRow.amountSen), 40000);
  // Status stayed CONFIRMED (pure edit, no transition).
  assert.equal(piRow.status, "CONFIRMED");
  // Original ledger rows are NOT mutated (append-only chain).
  const origRow = db.tables.ledger_journal_entries.find((r) => r.id === "lje-orig-1");
  assert.equal(Number(origRow.debitSen), 60000, "original ledger leg must not be mutated");

  // A correction was written: NEW rows with sourceId starting `pi-1:edit-`.
  const corrections = db.tables.ledger_journal_entries.filter(
    (r) => typeof r.sourceId === "string" && r.sourceId.startsWith("pi-1:edit-"),
  );
  assert.ok(corrections.length >= 2, `expected at least 2 correction legs, got ${corrections.length}`);
  // Net debit minus credit across the correction legs equals the delta (−20000):
  // a reduction credits the purchase account and debits AP.
  const netDr = corrections.reduce((s, r) => s + Number(r.debitSen) - Number(r.creditSen), 0);
  assert.equal(netDr, 0, "correction must balance (sum of debits = sum of credits)");
  // The AP leg posts the delta on the DEBIT side (reversal of original credit).
  const apLeg = corrections.find((r) => r.accountCode === "400-0000");
  assert.ok(apLeg, "expected an AP correction leg");
  assert.equal(Number(apLeg.debitSen), 20000);
  assert.equal(Number(apLeg.creditSen), 0);
  // And new rows were appended (not in place of existing).
  assert.ok(
    db.tables.ledger_journal_entries.length > beforeLedgerCount,
    "correction legs must be appended, not replace existing",
  );
});

test("PI PAID cannot be line-edited (locked)", async () => {
  const db = makeDb();
  seedApprovedPi(db);
  db.tables.purchase_invoices.find((r) => r.id === "pi-1").status = "PAID";
  const piRoot = mount(piApp, db);
  const res = await piRoot.request("/pi-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ materialName: "FOAM-1 - Foam block", qty: 4, unitPriceSen: 10000, lineType: "STOCKED", grnItemId: 201 }],
    }),
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /DRAFT/);
  assert.equal(Number(db.tables.grn_items.find((r) => r.id === 201).invoiced_qty), 6);
});
