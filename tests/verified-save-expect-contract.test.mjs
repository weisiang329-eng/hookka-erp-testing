// ---------------------------------------------------------------------------
// verified-save-expect-contract.test.mjs
//
// BUG-2026-08-13-042 — a save that WORKED, reported as a failure.
//
// `verifiedSave` writes, reads the record back, and compares the readback
// against an `expect` map. It is the one guard the operator is told to trust:
// its mismatch branch prints "Save did NOT take effect" and the caller aborts
// the navigate. The CO edit page's map named `customerPOId`, and the CO
// contract has never carried that field — `consignment_orders` has no
// customer-PO column and `rowToCO` never emitted one. So the readback answered
// `undefined`, `equalLoose` compared "PO-…" against nothing, and EVERY CO save
// with a Customer PO filled in reported a failure that had not happened, while
// every other field on the same save had persisted perfectly.
//
// The invariant, and it is not specific to that field: **every key in an
// `expect` map must be a key the endpoint actually returns.** A field the
// contract does not carry is not a failed write — it is a question the readback
// cannot answer, and asking it makes the guard a permanent liar. The rest of
// this family (`reason: "unverified"`, BUG-2026-08-13) is the same lesson from
// the other side: do not report a save as lost when you merely could not
// confirm it.
//
// Enforced two ways, because either alone is weak:
//   * BEHAVIOUR — the CO map is checked against the keys the REAL by-id handler
//     puts on the wire, so a route that stops emitting a field fails here.
//   * SOURCE — the SO twin's map is checked against `rowToSO`'s own returned
//     object, so the sibling page cannot drift the way this one did.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Hono } from "hono";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;
const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

const { default: consignmentOrdersApp } = await import(
  src("src/api/routes/consignment-orders.ts")
);

/**
 * The keys of the `expect: { … }` literal passed to verifiedSave in a page.
 *
 * The literal is shorthand (`customerId, reference, …`), which is the whole
 * hazard: a shorthand key is just an identifier, so nothing — not tsc, not the
 * editor — connects it to the response shape it is being compared against.
 */
function expectKeysOf(source, file) {
  const at = source.indexOf("expect: {");
  assert.notEqual(at, -1, `${file}: no verifiedSave expect map found`);
  const body = source.slice(at + "expect: {".length, source.indexOf("}", at));
  return body
    .split(",")
    .map((k) => k.split(":")[0].trim())
    .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
}

/** The keys `rowToX` puts on the wire, read off its own returned literal. */
function emittedKeysOf(source, fnName, file) {
  const at = source.indexOf(`function ${fnName}(`);
  assert.notEqual(at, -1, `${file}: ${fnName} not found`);
  const body = source.slice(at, at + 6000);
  return new Set([...body.matchAll(/^\s{4}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]));
}

// ---------------------------------------------------------------------------
// 1. Consignment order — the instance, checked against the real wire payload.
// ---------------------------------------------------------------------------

function makeDb(co) {
  function prepare(sql) {
    const s = String(sql).trim();
    const rows = () => {
      if (/FROM consignment_notes/i.test(s)) return [];
      if (/FROM production_orders/i.test(s)) return [];
      if (/FROM consignment_order_items/i.test(s)) return [];
      if (/FROM consignment_orders/i.test(s)) return [co];
      return [];
    };
    const obj = {
      bind: () => obj,
      first: async () => rows()[0] ?? null,
      all: async () => ({ results: rows() }),
      run: async () => ({ success: true }),
    };
    return obj;
  }
  return { prepare, batch: async () => [] };
}

function mount(db) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db);
    c.set("orgId", "hookka");
    c.set("userRole", "SUPER_ADMIN");
    c.set("userId", "user-1");
    await next();
  });
  parent.route("/", consignmentOrdersApp);
  return parent;
}

test("CO edit: every field it verifies is a field the endpoint returns", async () => {
  const page = read("src/pages/consignment/edit.tsx");
  const keys = expectKeysOf(page, "consignment/edit.tsx");
  assert.ok(keys.length >= 5, `sanity: parsed ${keys.length} expect keys`);

  const db = makeDb({
    id: "co-1",
    orgId: "hookka",
    customerId: "cust-1",
    customerName: "Test Customer",
    status: "DRAFT",
    subtotalSen: 0,
    totalSen: 0,
  });
  const res = await mount(db).request("/co-1");
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  const payload = JSON.parse(raw).data;

  const missing = keys.filter((k) => !(k in payload));
  assert.deepEqual(
    missing,
    [],
    `consignment/edit.tsx compares ${missing.join(", ")} against a payload that does ` +
      `not carry it. The readback answers \`undefined\`, so any non-empty value the ` +
      `operator typed reports "Save did NOT take effect" on a save that worked. ` +
      `Either the route must emit the field, or the field does not belong in \`expect\`.`,
  );
});

test("CO edit: it does NOT verify the field that has no column behind it", () => {
  // Named explicitly. Re-adding `customerPOId` to this page means adding
  // `consignment_orders.customer_po_id`, a write path, and a `rowToCO` emit —
  // not just an input box, which is what was there.
  const page = read("src/pages/consignment/edit.tsx");
  assert.ok(
    !expectKeysOf(page, "consignment/edit.tsx").includes("customerPOId"),
    "customerPOId has no column, no write path and no emit on the CO side",
  );
});

test("the CO page no longer collects a Customer PO it cannot keep", () => {
  // The comparison was the bug, but an input feeding a field the save discards
  // is the reason anyone ever typed into it. Both create and edit are checked:
  // fixing only the screen that reported the error would leave the other door
  // silently eating the value at create time.
  for (const f of ["src/pages/consignment/edit.tsx", "src/pages/consignment/create.tsx"]) {
    const page = read(f);
    assert.ok(
      !/value=\{customerPOId\}/.test(page),
      `${f} still renders an input bound to customerPOId — a box whose contents ` +
        `the CO write path throws away`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The sales-order twin — so the sibling cannot drift the same way.
// ---------------------------------------------------------------------------

test("SO edit: every field it verifies is a field rowToSO emits", () => {
  const page = read("src/pages/sales/edit.tsx");
  const emitted = emittedKeysOf(
    read("src/api/routes/sales-orders/_helpers.ts"),
    "rowToSO",
    "sales-orders/_helpers.ts",
  );
  assert.ok(emitted.size > 10, `sanity: parsed ${emitted.size} emitted keys from rowToSO`);

  const missing = expectKeysOf(page, "sales/edit.tsx").filter((k) => !emitted.has(k));
  assert.deepEqual(
    missing,
    [],
    `sales/edit.tsx verifies ${missing.join(", ")}, which rowToSO does not emit — the ` +
      `exact shape that made every CO save with a Customer PO report a false failure.`,
  );
});
