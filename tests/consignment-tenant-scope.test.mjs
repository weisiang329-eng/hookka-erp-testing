// ---------------------------------------------------------------------------
// consignment-tenant-scope.test.mjs — the consignment surface is scoped to the
// caller's ORG, on every path that returns a document.
//
// Background. 39fd7a99 closed /api/consignment-orders/stats, which cached its
// figures per org while computing them over every org. It explicitly left the
// bigger one open: the LIST beside it, and the by-id reads, had no org
// predicate either — and where /stats leaked counts and totals, those leak the
// documents. The sweep that followed (2026-08-09) found the same hole on the
// consignment-notes router and on the legacy /api/consignments surface, which
// reads the very same tables.
//
// What is pinned here is BEHAVIOUR, not the presence of a helper call:
//
//   1. a caller in org A cannot see org B's rows through a LIST;
//   2. a caller in org A cannot see org B's row through a BY-ID read — the
//      door the list fix would otherwise just move;
//   3. the customer scope still works, and the two narrowings COMPOSE: a
//      scoped salesperson sees their own customers, and only within their own
//      org. Org scope is an additional predicate, never a replacement.
//
// The mock reads binds POSITIONALLY, in the order the predicates appear in the
// SQL — the same property the /stats test relies on. Delete the org predicate
// from a query and the mock stops filtering by org, so these assertions fail
// rather than quietly passing on a query that no longer narrows.
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
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;

const { default: consignmentOrdersApp } = await import(
  src("src/api/routes/consignment-orders.ts")
);
const { default: consignmentNotesApp } = await import(
  src("src/api/routes/consignment-notes.ts")
);
const { default: consignmentsApp } = await import(
  src("src/api/routes/consignments.ts")
);

// ---------------------------------------------------------------------------
// A two-tenant book. 'hookka' is the only org on prod today; 'acme' is the
// tenant that does not exist yet and is exactly who this predicate is for.
// ---------------------------------------------------------------------------
const COS = [
  { id: "co-1", orgId: "hookka", status: "DRAFT", customerId: "cust-mine", totalSen: 120000 },
  { id: "co-2", orgId: "hookka", status: "CONFIRMED", customerId: "cust-other", totalSen: 300000 },
  { id: "co-3", orgId: "hookka", status: "CONFIRMED", customerId: null, totalSen: 40000 },
  { id: "co-9", orgId: "acme", status: "CONFIRMED", customerId: "cust-acme", totalSen: 9900000 },
];

const CNS = [
  { id: "cn-1", orgId: "hookka", status: "ACTIVE", customerId: "cust-mine", noteNumber: "CN-001" },
  { id: "cn-2", orgId: "hookka", status: "ACTIVE", customerId: "cust-other", noteNumber: "CN-002" },
  { id: "cn-9", orgId: "acme", status: "ACTIVE", customerId: "cust-acme", noteNumber: "CN-009" },
];

/**
 * Apply a `WHERE orgId = ? AND (...)` the way Postgres would, reading binds in
 * declaration order. Returns the surviving rows plus the bind cursor, so the
 * caller can carry on consuming the remaining predicates' binds.
 */
function applyOrgScope(sql, bound, rows) {
  let i = 0;
  let out = rows;
  if (/WHERE\s+orgId\s*=\s*\?/i.test(sql)) {
    const org = String(bound[i++]);
    out = out.filter((r) => String(r.orgId ?? "hookka") === org);
  }
  return { rows: out, i };
}

/** The `customerId NOT IN (...)` half of the customer scope. */
function applyCustomerScope(sql, bound, rows, i) {
  if (!/customerId NOT IN/i.test(sql)) return rows;
  const forbidden = new Set(bound.slice(i).map(String));
  return rows.filter(
    (r) => r.customerId == null || !forbidden.has(String(r.customerId)),
  );
}

function makeDb({ cos = COS, cns = CNS, foreignCustomers = [] } = {}) {
  const seen = [];
  function prepare(sql) {
    const s = sql.trim();
    let bound = [];

    const resolveRows = () => {
      if (/FROM customers WHERE salesperson_user_id/i.test(s)) {
        return foreignCustomers;
      }
      if (/FROM consignment_orders/i.test(s)) {
        // by-id read
        if (/WHERE id = \? AND orgId = \?/i.test(s)) {
          return cos.filter(
            (r) => r.id === bound[0] && String(r.orgId) === String(bound[1]),
          );
        }
        if (/WHERE id = \?/i.test(s)) {
          return cos.filter((r) => r.id === bound[0]);
        }
        const { rows, i } = applyOrgScope(s, bound, cos);
        return applyCustomerScope(s, bound, rows, i);
      }
      if (/FROM consignment_notes/i.test(s)) {
        if (/WHERE id = \? AND orgId = \?/i.test(s)) {
          return cns.filter(
            (r) => r.id === bound[0] && String(r.orgId) === String(bound[1]),
          );
        }
        if (/WHERE id = \?/i.test(s)) {
          return cns.filter((r) => r.id === bound[0]);
        }
        const { rows, i } = applyOrgScope(s, bound, cns);
        return applyCustomerScope(s, bound, rows, i);
      }
      return [];
    };

    const obj = {
      bind(...args) {
        bound = args;
        return obj;
      },
      async first() {
        seen.push({ sql: s, bound });
        // Snapshot probes must miss so withSnapshot computes fresh.
        if (/_snapshot/i.test(s)) return null;
        if (/COUNT\(\*\)/i.test(s)) return { n: resolveRows().length };
        return resolveRows()[0] ?? null;
      },
      async all() {
        seen.push({ sql: s, bound });
        if (/GROUP BY status/i.test(s)) {
          const acc = new Map();
          for (const r of resolveRows()) {
            const cur = acc.get(r.status) ?? { status: r.status, n: 0, revenueSen: 0 };
            cur.n += 1;
            cur.revenueSen += r.totalSen ?? 0;
            acc.set(r.status, cur);
          }
          return { results: [...acc.values()] };
        }
        return { results: resolveRows() };
      },
      async run() {
        return { success: true };
      },
    };
    return obj;
  }
  return { db: { prepare, batch: async () => [] }, seen };
}

function mount(routeApp, db, { role = "OFFICE", userId = "user-1", orgId = "hookka" } = {}) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db);
    c.set("orgId", orgId);
    c.set("userRole", role);
    c.set("userId", userId);
    await next();
  });
  parent.route("/", routeApp);
  return parent;
}

const ids = (body) => (body.data ?? []).map((r) => r.id).sort();

// ---------------------------------------------------------------------------
// 1. The list — the endpoint this whole pass exists for.
// ---------------------------------------------------------------------------

test("CO list: a caller sees their own org's consignment orders and no others", async () => {
  const { db } = makeDb();
  const res = await mount(consignmentOrdersApp, db).request("/");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(ids(body), ["co-1", "co-2", "co-3"]);
  assert.ok(
    !ids(body).includes("co-9"),
    "the other tenant's consignment order must not be in the list",
  );
});

test("CO list: the second tenant reads its own book, not the first's", async () => {
  const { db } = makeDb();
  const res = await mount(consignmentOrdersApp, db, { orgId: "acme" }).request("/");
  const body = await res.json();
  assert.deepEqual(ids(body), ["co-9"]);
  assert.equal(body.total, 1, "total must count the same rows it returned");
});

test("CN list: scoped to the caller's org, and the COUNT agrees with the rows", async () => {
  const { db } = makeDb();
  const res = await mount(consignmentNotesApp, db).request("/");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(ids(body), ["cn-1", "cn-2"]);
  assert.equal(
    body.total,
    2,
    "the COUNT and the page share one WHERE, so they cannot disagree",
  );
});

test("legacy /api/consignments list: same tables, same org boundary", async () => {
  const { db } = makeDb();
  const res = await mount(consignmentsApp, db, { orgId: "acme" }).request("/");
  const body = await res.json();
  assert.deepEqual(ids(body), ["cn-9"]);
});

// ---------------------------------------------------------------------------
// 2. The by-id reads — fixing only the list would move the door, not close it.
// ---------------------------------------------------------------------------

test("CO by-id: another org's id reads as 404, not as the document", async () => {
  const { db } = makeDb();
  const app = mount(consignmentOrdersApp, db, { orgId: "hookka" });

  const mine = await app.request("/co-1");
  assert.equal(mine.status, 200, "our own order still resolves");

  const theirs = await app.request("/co-9");
  assert.equal(theirs.status, 404, "the other tenant's order must not resolve");
  const body = await theirs.json();
  assert.equal(body.success, false);
});

test("CO by-id: edit-eligibility does not answer for another org's order", async () => {
  const { db } = makeDb();
  const res = await mount(consignmentOrdersApp, db).request("/co-9/edit-eligibility");
  assert.equal(
    res.status,
    404,
    "an editability verdict is a disclosure that the order exists",
  );
});

test("CN by-id: print-extras refuses another org's note", async () => {
  const { db } = makeDb();
  const res = await mount(consignmentNotesApp, db).request("/cn-9/print-extras");
  assert.equal(res.status, 404, "print-extras is the note in printable form");
});

test("legacy /api/consignments by-id: another org's note reads as 404", async () => {
  const { db } = makeDb();
  const app = mount(consignmentsApp, db);
  assert.equal((await app.request("/cn-1")).status, 200);
  assert.equal((await app.request("/cn-9")).status, 404);
});

// ---------------------------------------------------------------------------
// 3. Customer scope survives — org scope is an ADDITIONAL predicate.
// ---------------------------------------------------------------------------

test("CO list: a salesperson still sees only their own customers, and only in their org", async () => {
  const { db } = makeDb({
    // ONLY cust-other is foreign. cust-acme is deliberately absent from this
    // set, so the other tenant's co-9 can be excluded by the ORG predicate and
    // by nothing else — otherwise the customer scope would carry this
    // assertion on its own and the test would still pass with org scope gone.
    foreignCustomers: [{ id: "cust-other", name: "Somebody Else" }],
  });
  const res = await mount(consignmentOrdersApp, db, {
    role: "SALES",
    userId: "user-sales",
  }).request("/");
  const body = await res.json();
  // co-2 dropped by CUSTOMER scope, co-9 by ORG scope, co-3 kept because an
  // unassigned customer is public (owner 2026-08-04).
  assert.deepEqual(
    ids(body),
    ["co-1", "co-3"],
    "both narrowings must apply — neither replaces the other",
  );
});

test("CO list: an unscoped role sees the whole org book but never another org's", async () => {
  const { db } = makeDb({
    foreignCustomers: [{ id: "cust-other", name: "Somebody Else" }],
  });
  const res = await mount(consignmentOrdersApp, db, { role: "OFFICE" }).request("/");
  const body = await res.json();
  assert.deepEqual(
    ids(body),
    ["co-1", "co-2", "co-3"],
    "OFFICE is not customer-scoped, but it is still tenant-scoped",
  );
});

test("CN list: a salesperson's notes narrow by customer AND by org", async () => {
  const { db } = makeDb({
    foreignCustomers: [{ id: "cust-other", name: "Somebody Else" }],
  });
  const res = await mount(consignmentNotesApp, db, {
    role: "SALES",
    userId: "user-sales",
  }).request("/");
  const body = await res.json();
  assert.deepEqual(ids(body), ["cn-1"]);
});

// ---------------------------------------------------------------------------
// 4. The CN aggregate — the sibling of the bug 39fd7a99 fixed on the CO side.
// ---------------------------------------------------------------------------

test("CN /stats: the counts cover the caller's org only", async () => {
  const { db } = makeDb();
  const res = await mount(consignmentNotesApp, db, { orgId: "hookka" }).request("/stats");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(
    body.data.pendingDispatch,
    2,
    "the other tenant's ACTIVE note is not ours to count",
  );
});

test("CN /stats: the second tenant gets its own figures", async () => {
  const { db } = makeDb();
  const res = await mount(consignmentNotesApp, db, { orgId: "acme" }).request("/stats");
  const body = await res.json();
  assert.equal(body.data.pendingDispatch, 1);
});

test("CN /stats: the snapshot key was bumped, so a pre-fix org-wide cache cannot be served", async () => {
  const { db, seen } = makeDb();
  await mount(consignmentNotesApp, db, { orgId: "hookka" }).request("/stats");
  const snapshotReads = seen.filter((q) => /consignment_notes_stats_snapshot/i.test(q.sql));
  assert.ok(snapshotReads.length > 0, "the endpoint must still be cache-aside");
  assert.ok(
    snapshotReads.some((q) => q.bound.some((b) => String(b) === "v2")),
    "rows written before the org predicate are still fresh by timestamp — only a " +
      "new cacheKey retires figures whose MEANING changed",
  );
});
