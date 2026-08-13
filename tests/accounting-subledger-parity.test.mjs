// ---------------------------------------------------------------------------
// accounting-subledger-parity.test.mjs — the four defects the 2026-08-13
// accounting.ts read-through found, pinned as BEHAVIOUR.
//
// Why one file. All four are the same shape: two surfaces that must agree
// about one number, where only one of them was maintained.
//
//   BUG-2026-08-13-080  the per-party STATEMENT counted VOID/DELETED
//                       receipts/payments; the all-party LEDGER next to it
//                       (same line model, looped) did not.
//   BUG-2026-08-13-081  POST /contra flipped a purchase invoice to PAID
//                       without moving paid_amount_sen, without storing
//                       bookedSen, and without relieving the supplier
//                       counter — the only supplier_payments writer in the
//                       repo that skips those.
//   BUG-2026-08-13-082  the AP subledger relieved 400-0000 by amountSen
//                       (cash out of the bank) instead of bookedSen (what
//                       actually came off the control). They differ on a
//                       foreign-currency payment; the gap is FX, not AP.
//   BUG-2026-08-13-083  manual journals had no tenant predicate at all, on
//                       the strength of a comment claiming journal_entries
//                       "has no orgId column". tests/db-schema.json says it
//                       does, and has since migration 0087.
//
// The mocks read the SQL. A predicate that is deleted from a query stops
// filtering in the mock too, so these assertions go RED on a regression
// instead of passing over a query that no longer narrows. Each one was proved
// red by putting the bug back (see the PR body).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Hono } from "hono";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;
const { default: accountingApp } = await import(src("src/api/routes/accounting.ts"));

function mount(db, { role = "SUPER_ADMIN", userId = "user-1", orgId = "hookka" } = {}) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db);
    c.set("orgId", orgId);
    c.set("userRole", role);
    c.set("userId", userId);
    await next();
  });
  parent.route("/", accountingApp);
  return parent;
}

// A lifecycle row makes its document VOID. Both statement queries name the
// document by a different key (payment_records by id, supplier_payments by
// paymentNo) — exactly as their ledger twins do.
const LIFECYCLE = [
  { sourceType: "payment", sourceId: "pay-void", state: "VOID" },
  { sourceType: "supplier_payment", sourceId: "SP-VOID", state: "DELETED" },
];

function lifecycleKilled(sql, sourceType) {
  // Only apply the exclusion when the query actually asks for it.
  if (!new RegExp(`sourceType = '${sourceType}'`).test(sql)) return new Set();
  if (!/state IN \('VOID','DELETED'\)/.test(sql)) return new Set();
  return new Set(
    LIFECYCLE.filter((l) => l.sourceType === sourceType).map((l) => l.sourceId),
  );
}

// ---------------------------------------------------------------------------
// 1 + 3. Customer / supplier statement vs their ledger twins.
// ---------------------------------------------------------------------------

const CUSTOMER = { id: "cust-1", name: "Ah Seng Furniture", code: "300-A001", outstandingSen: 0 };
const INVOICES = [
  { customerId: "cust-1", invoiceNo: "INV-001", invoiceDate: "2026-05-02", totalSen: 500000, paidAmount: 0, status: "SENT", isOpening: 0 },
];
// One live receipt, one that was VOIDED. The voided one must not credit the
// customer on EITHER surface.
const RECEIPTS = [
  { id: "pay-live", customerId: "cust-1", receiptNumber: "OR-001", date: "2026-05-10", amount: 100000, status: "CLEARED", method: "BANK" },
  { id: "pay-void", customerId: "cust-1", receiptNumber: "OR-002", date: "2026-05-11", amount: 400000, status: "CLEARED", method: "BANK" },
];

const SUPPLIER = { id: "sup-1", name: "Kilang Kayu Sdn Bhd", code: "400-K001", outstandingSen: 0 };
const PIS = [
  { id: "pi-1", supplierId: "sup-1", supplierName: "Kilang Kayu Sdn Bhd", piNo: "PI-001", invoiceDate: "2026-05-03", amountSen: 900000, paidAmountSen: 0, status: "APPROVED", isOpening: 0, dueDate: "2026-06-03" },
];
// SP-FX: a foreign-currency settlement. RM 3,000 left the bank; RM 3,500 came
// off 400-0000. The AP subledger must move by 3,500 — the 500 is FX (530-0000).
// SP-VOID: deleted, must not appear at all.
const SUPPLIER_PAYMENTS = [
  { supplierId: "sup-1", paymentNo: "SP-FX", date: "2026-05-12", amountSen: 300000, bookedSen: 350000, method: "BANK_TRANSFER" },
  { supplierId: "sup-1", paymentNo: "SP-VOID", date: "2026-05-13", amountSen: 200000, bookedSen: 200000, method: "BANK_TRANSFER" },
];

function projectPayment(sql, row) {
  // The route selects `COALESCE(bookedSen, amountSen) AS amountSen`. Model the
  // projection off the SQL so reverting it to a bare `amountSen` changes the
  // number the handler sees.
  const usesBooked = /COALESCE\(\s*bookedSen\s*,\s*amountSen\s*\)\s+AS\s+amountSen/i.test(sql);
  const sen = usesBooked ? (row.bookedSen ?? row.amountSen) : row.amountSen;
  return { ...row, amountSen: sen };
}

function statementDb() {
  function prepare(sql) {
    const s = sql.trim();
    let bound = [];
    const rows = () => {
      if (/FROM kv_config/i.test(s)) return [];
      if (/opening_ap_excludes/i.test(s)) return [];
      if (/FROM customers WHERE id = \?/i.test(s)) {
        return CUSTOMER.id === bound[0] ? [CUSTOMER] : [];
      }
      if (/FROM suppliers WHERE id = \?/i.test(s)) {
        return SUPPLIER.id === bound[0] ? [SUPPLIER] : [];
      }
      if (/FROM customers\b/i.test(s)) return [CUSTOMER];
      if (/FROM suppliers\b/i.test(s)) return [SUPPLIER];
      if (/FROM invoices\b/i.test(s)) return INVOICES.filter((r) => r.customerId === bound[0] || bound.length === 0);
      if (/FROM purchase_invoices\b/i.test(s)) return PIS.filter((r) => r.supplierId === bound[0] || bound.length === 0);
      if (/FROM payment_records\b/i.test(s)) {
        const dead = lifecycleKilled(s, "payment");
        return RECEIPTS.filter((r) => !dead.has(r.id)).filter(
          (r) => bound.length === 0 || r.customerId === bound[0],
        );
      }
      if (/FROM supplier_payments\b/i.test(s)) {
        const dead = lifecycleKilled(s, "supplier_payment");
        return SUPPLIER_PAYMENTS.filter((r) => !dead.has(r.paymentNo))
          .filter((r) => bound.length === 0 || r.supplierId === bound[0])
          .map((r) => projectPayment(s, r));
      }
      if (/FROM credit_notes\b/i.test(s)) return [];
      if (/FROM debit_notes\b/i.test(s)) return [];
      if (/FROM purchase_credit_notes\b/i.test(s)) return [];
      return [];
    };
    const obj = {
      bind(...a) { bound = a; return obj; },
      async first() { return rows()[0] ?? null; },
      async all() { return { results: rows() }; },
      async run() { return { success: true }; },
    };
    return obj;
  }
  return { prepare, batch: async () => [] };
}

test("BUG-080 customer statement: a VOIDED receipt does not credit the customer", async () => {
  const res = await mount(statementDb()).request("/customer-statement?customerId=cust-1");
  assert.equal(res.status, 200);
  const { data } = await res.json();
  const refs = data.rows.map((r) => `${r.type}:${r.ref}`);
  assert.ok(refs.includes("RECEIPT:OR-001"), "the live receipt still shows");
  assert.ok(
    !refs.includes("RECEIPT:OR-002"),
    "the VOIDED receipt must not appear — /debtor-ledger has excluded it all along",
  );
  // 5,000.00 invoiced − 1,000.00 genuinely received.
  assert.equal(
    data.closingSen,
    400000,
    "closing balance must be the invoice less the LIVE receipt only",
  );
});

test("BUG-080 supplier statement: a DELETED supplier payment does not relieve us", async () => {
  const res = await mount(statementDb()).request("/supplier-statement?supplierId=sup-1");
  assert.equal(res.status, 200);
  const { data } = await res.json();
  const refs = data.rows.map((r) => `${r.type}:${r.ref}`);
  assert.ok(refs.includes("PAYMENT:SP-FX"), "the live payment still shows");
  assert.ok(
    !refs.includes("PAYMENT:SP-VOID"),
    "the DELETED payment must not appear — /creditor-ledger has excluded it all along",
  );
});

test("BUG-082 supplier statement: AP relief is bookedSen, not the cash that left the bank", async () => {
  const res = await mount(statementDb()).request("/supplier-statement?supplierId=sup-1");
  const { data } = await res.json();
  const pay = data.rows.find((r) => r.ref === "SP-FX");
  assert.equal(
    pay.debitSen,
    350000,
    "the ledger moves by what came off 400-0000 (bookedSen), not by the 3,000 of cash",
  );
  // 9,000.00 billed − 3,500.00 relieved.
  assert.equal(data.closingSen, 550000, "closing must tie the control, not the bank");
});

test("BUG-080/082 creditor ledger: the all-party twin reports the same numbers", async () => {
  const res = await mount(statementDb()).request("/creditor-ledger");
  assert.equal(res.status, 200);
  const { data } = await res.json();
  const party = data.parties.find((p) => p.party.id === "sup-1");
  assert.ok(party, "the supplier has movements, so it must have a section");
  const refs = party.rows.map((r) => r.ref);
  assert.ok(!refs.includes("SP-VOID"), "deleted payment stays out");
  assert.equal(
    party.closingSen,
    550000,
    "the ledger and the per-party statement must not disagree about one supplier",
  );
});

// ---------------------------------------------------------------------------
// 2. POST /contra — the write that flipped a status and nothing else.
// ---------------------------------------------------------------------------

function contraDb() {
  const statements = [];
  function prepare(sql) {
    const s = sql.trim();
    let bound = [];
    const rows = () => {
      if (/FROM purchase_invoices WHERE id IN/i.test(s)) {
        return PIS.filter((p) => bound.includes(p.id));
      }
      if (/FROM customers WHERE id = \?/i.test(s)) return [CUSTOMER];
      if (/FROM invoices/i.test(s)) {
        return [{ id: "inv-1", invoiceNo: "INV-001", totalSen: 2000000, paidAmount: 0 }];
      }
      if (/FROM ledger_journal_entries/i.test(s)) return [];
      return [];
    };
    const obj = {
      bind(...a) { bound = a; statements.push({ sql: s, bound: a }); return obj; },
      async first() { return rows()[0] ?? null; },
      async all() { return { results: rows() }; },
      async run() { return { success: true }; },
    };
    // Statements that are pushed with no bind still need recording.
    return obj;
  }
  return {
    db: {
      prepare,
      batch: async (sts) => { void sts; return []; },
    },
    statements,
  };
}

async function runContra() {
  const { db, statements } = contraDb();
  const res = await mount(db).request("/contra", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerId: "cust-1", piIds: ["pi-1"] }),
  });
  return { res, statements };
}

test("BUG-081 contra: the purchase invoice's paid_amount_sen moves with its status", async () => {
  const { res, statements } = await runContra();
  assert.equal(res.status, 200, await res.text());
  const flip = statements.find(
    (st) => /UPDATE purchase_invoices/i.test(st.sql) && /status = 'PAID'/i.test(st.sql),
  );
  assert.ok(flip, "the contra must still mark the bill paid");
  assert.match(
    flip.sql,
    /paid_amount_sen\s*=\s*amount_sen/i,
    "a bill flipped to PAID with paid_amount_sen left at 0 is counted at FULL FACE by " +
      "rebuildApCounterSen, so the AP counter drift never clears",
  );
});

test("BUG-081 contra: the supplier_payments row stores bookedSen", async () => {
  const { statements } = await runContra();
  const ins = statements.find((st) => /INSERT INTO supplier_payments/i.test(st.sql));
  assert.ok(ins, "a contra still writes a supplier_payments row");
  assert.match(
    ins.sql,
    /bookedSen/,
    "every other supplier_payments INSERT in the repo stores bookedSen; without it the " +
      "row claims zero AP relief on /ap-reconciliation and in the audit log's SUM(bookedSen)",
  );
  // The relief bound must equal the PI face, not 0.
  assert.ok(
    ins.bound.includes(900000),
    "bookedSen must carry the amount actually relieved",
  );
});

test("BUG-081 contra: the supplier's outstanding counter is relieved, like the customer's", async () => {
  const { statements } = await runContra();
  const cust = statements.find((st) => /UPDATE customers SET outstandingSen/i.test(st.sql));
  const sup = statements.find((st) => /UPDATE suppliers SET outstandingSen/i.test(st.sql));
  assert.ok(cust, "the AR side was always relieved");
  assert.ok(
    sup,
    "the AP side needs the same mirror — without it the supplier stays 'owed' after the contra",
  );
  assert.ok(sup.bound.includes(900000), "relieved by the contra'd amount");
});

// ---------------------------------------------------------------------------
// 4. Manual journals — the tenant boundary that was argued away by a comment.
// ---------------------------------------------------------------------------

const JOURNALS = [
  { id: "je-mine", orgId: "hookka", entryNo: "JV-0001", date: "2026-05-01", description: "mine", status: "POSTED", createdBy: "a" },
  { id: "je-theirs", orgId: "acme", entryNo: "JV-9001", date: "2026-05-01", description: "theirs", status: "POSTED", createdBy: "b" },
];
const JOURNAL_LINES = [
  { id: 1, journalEntryId: "je-mine", lineOrder: 0, accountCode: "700-0000", accountName: "x", debitSen: 100, creditSen: 0, description: "", orgId: "hookka" },
  { id: 2, journalEntryId: "je-theirs", lineOrder: 0, accountCode: "700-0000", accountName: "y", debitSen: 999, creditSen: 0, description: "", orgId: "acme" },
];

function journalDb() {
  const writes = [];
  const seen = [];
  // Stateful enough for POST: a created entry has to be readable back, or the
  // handler's own re-read returns null and the 201 never happens.
  const entries = [...JOURNALS];
  const lines = [...JOURNAL_LINES];
  function prepare(sql) {
    const s = sql.trim();
    let bound = [];
    const rows = () => {
      if (/FROM journal_entries/i.test(s)) {
        let out = entries;
        let i = 0;
        if (/WHERE id = \? AND orgId = \?/i.test(s)) {
          const id = bound[0];
          const org = String(bound[1]);
          return out.filter((r) => r.id === id && String(r.orgId) === org);
        }
        if (/WHERE id = \?/i.test(s)) return out.filter((r) => r.id === bound[0]);
        // The list binds the JOIN's orgId first, then its own WHERE orgId.
        if (/dl\.orgId = \?/i.test(s)) i = 1;
        if (/journal_entries\.orgId = \?/i.test(s)) {
          const org = String(bound[i]);
          out = out.filter((r) => String(r.orgId) === org);
        }
        return out;
      }
      if (/FROM journal_lines/i.test(s)) {
        if (/WHERE journalEntryId = \?/i.test(s)) {
          return lines.filter((l) => l.journalEntryId === bound[0]);
        }
        if (/WHERE orgId = \?/i.test(s)) {
          return lines.filter((l) => String(l.orgId) === String(bound[0]));
        }
        return lines;
      }
      return [];
    };
    // Apply an INSERT so the handler's read-back finds what it just wrote. The
    // column list is parsed from the SQL, so a stamped orgId lands on the row.
    const applyInsert = (a) => {
      const m = s.match(/INSERT INTO (\w+)\s*\(([^)]*)\)/i);
      if (!m) return;
      const cols = m[2].split(",").map((x) => x.trim());
      const row = {};
      cols.forEach((col, idx) => { row[col] = a[idx]; });
      if (/journal_entries/i.test(m[1])) {
        entries.push({ status: "DRAFT", ...row });
      } else if (/journal_lines/i.test(m[1])) {
        lines.push(row);
      }
    };
    const obj = {
      bind(...a) {
        bound = a;
        if (/^(INSERT|UPDATE|DELETE)/i.test(s)) { writes.push({ sql: s, bound: a }); applyInsert(a); }
        return obj;
      },
      async first() {
        seen.push({ sql: s, bound });
        if (/COUNT\(\*\)/i.test(s)) return { c: 0 };
        return rows()[0] ?? null;
      },
      async all() { seen.push({ sql: s, bound }); return { results: rows() }; },
      async run() { return { success: true }; },
    };
    return obj;
  }
  return { db: { prepare, batch: async () => [] }, writes, seen };
}

test("BUG-083 journals list: a caller sees their own tenant's journals only", async () => {
  const { db } = journalDb();
  const res = await mount(db).request("/journals");
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.data.map((j) => j.id);
  assert.deepEqual(ids, ["je-mine"], "the other tenant's journal must not be listed");
});

// NOT a demonstrated leak, and the test says so rather than overclaiming: the
// per-entry mapper filters lines by journalEntryId, so a foreign tenant's line
// could never attach to one of our entries even when the fetch was unscoped.
// What the predicate buys is (a) defence in depth, so the boundary does not
// depend on a downstream filter, and (b) not pulling EVERY tenant's
// journal_lines over the wire on every list call. Asserted on the SQL, because
// there is no output difference to assert on.
test("BUG-083 journals list: the LINES fetch carries the tenant predicate too", async () => {
  const { db, seen } = journalDb();
  const res = await mount(db).request("/journals");
  assert.equal(res.status, 200);
  const linesQuery = seen.find((q) => /FROM journal_lines/i.test(q.sql));
  assert.ok(linesQuery, "the list still batches the lines in one query");
  assert.match(
    linesQuery.sql,
    /FROM journal_lines\s+WHERE\s+orgId\s*=\s*\?/i,
    "an unscoped SELECT * FROM journal_lines reads every tenant's lines on every call",
  );
  assert.equal(String(linesQuery.bound[0]), "hookka", "and binds the caller's org");
});

test("BUG-083 journals by-id: another tenant's entry reads as 404, not as the document", async () => {
  const { db } = journalDb();
  const app = mount(db, { orgId: "hookka" });
  assert.equal((await app.request("/journals/je-mine")).status, 200);
  assert.equal(
    (await app.request("/journals/je-theirs")).status,
    404,
    "a by-id read is the same disclosure as a list row",
  );
});

test("BUG-083 journals create: orgId is STAMPED, not left to the column DEFAULT", async () => {
  const { db, writes } = journalDb();
  const res = await mount(db, { orgId: "acme" }).request("/journals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      date: "2026-05-05",
      description: "test",
      lines: [
        { accountCode: "700-0000", debitSen: 100, creditSen: 0 },
        { accountCode: "300-0000", debitSen: 0, creditSen: 100 },
      ],
    }),
  });
  assert.equal(res.status, 201, await res.text());
  const head = writes.find((w) => /INSERT INTO journal_entries/i.test(w.sql));
  const line = writes.find((w) => /INSERT INTO journal_lines/i.test(w.sql));
  assert.ok(head && /orgId/.test(head.sql), "the entry INSERT must name orgId");
  assert.ok(line && /orgId/.test(line.sql), "the line INSERT must name orgId");
  assert.ok(
    head.bound.includes("acme") && line.bound.includes("acme"),
    "read scoping without write stamping is half a boundary: the writer's own rows " +
      "would land labelled 'hookka' and then be hidden from them",
  );
});

// ---------------------------------------------------------------------------
// 5. Class guard — no source file may carry a raw NUL byte.
//
// A NUL makes GNU grep call the file binary: it answers "Binary file matches"
// and prints NOTHING. accounting.ts carried one (a9d413f6) and every
// grep-driven audit had been silently skipping all 13,064 lines of the money
// module. Five more files still had one, two of them on the money path
// (src/lib/ap-recon.ts, src/lib/pnl-historical.ts). Write `\u0000` — identical
// at runtime, visible to every tool.
// ---------------------------------------------------------------------------
test("no source or doc file carries a raw NUL byte (it makes grep go blind)", () => {
  const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".wrangler"]);
  const EXT = /\.(ts|tsx|mjs|cjs|js|jsx|json|md|sql|css|html)$/;
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (EXT.test(name) && readFileSync(p).includes(0)) offenders.push(p);
    }
  };
  for (const root of ["src", "docs", "tests", "scripts", "functions"]) {
    try { walk(root); } catch { /* directory absent in this checkout */ }
  }
  assert.deepEqual(
    offenders,
    [],
    `raw NUL byte(s) found — grep will report "Binary file matches" and print nothing ` +
      `for these files, so every grep-based audit silently skips them. Replace the byte ` +
      `with the escape sequence \\u0000 (identical at runtime):\n  ${offenders.join("\n  ")}`,
  );
});
