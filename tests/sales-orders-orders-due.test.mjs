// ---------------------------------------------------------------------------
// sales-orders-orders-due.test.mjs — the GET /api/sales-orders?fields=orders-due
// projection (soListToOrdersDue in src/api/routes/sales-orders/_helpers.ts).
//
// BUG-2026-08-13-013: the /m Home "Orders due this week" card fetched the BARE
// whole-org SO list (measured on prod: 2.16 MB decoded / 1,342 rows / 4,108 ms
// cold on /m) to render SIX cards of SEVEN fields. The derivation moved to the
// server; the risk of that move is that a narrowed query quietly REORDERS or
// DROPS rows — which would be a regression, not a fix.
//
// So the load-bearing test here is not "does it return six rows"; it is
// `oldClientOrdersDue` below — a VERBATIM copy of the algorithm Home.tsx ran in
// the browser before the change — asserted to produce an identical list. If
// someone later "optimises" the projection into a SQL ORDER BY that breaks
// ties differently, or starts dropping undated orders another way, this fails.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it on Node 22+.
}

let mod;
try {
  mod = await import(
    pathToFileURL(
      resolve(process.cwd(), "src/api/routes/sales-orders/_helpers.ts"),
    ).href
  );
} catch (err) {
  console.warn(
    "[sales-orders-orders-due.test] Could not import helpers module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  throw err;
}

const { soListToOrdersDue, ORDERS_DUE_DEFAULT_TOP } = mod;

// ---------------------------------------------------------------------------
// The OLD client derivation, copied verbatim from src/pages/m/screens/Home.tsx
// as it stood before this change (the `ordersDue` useMemo + TERMINAL_STATUSES).
// Do NOT "tidy" this — its value is that it is the thing that shipped.
// ---------------------------------------------------------------------------
const TERMINAL_STATUSES = new Set([
  "DELIVERED",
  "INVOICED",
  "CLOSED",
  "CANCELLED",
]);
function oldClientOrdersDue(orders, top = 6) {
  return orders
    .filter((so) => !TERMINAL_STATUSES.has(so.status) && !!so.hookkaExpectedDD)
    .sort((a, b) =>
      (a.hookkaExpectedDD || "").localeCompare(b.hookkaExpectedDD || ""),
    )
    .slice(0, top);
}

/** The exact card content OrderDueCard renders, as one comparable string. */
function fingerprint(rows) {
  const s = rows
    .map(
      (so) =>
        [
          so.id,
          so.companySO || so.companySOId,
          so.status,
          so.customerName,
          (so.hookkaExpectedDD || "").slice(0, 10),
          so.totalSen || 0,
        ].join("|"),
    )
    .join(";");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return { s, h };
}

// A list shaped like the real endpoint's output: ordered created_at DESC,
// id DESC, mixed statuses, several rows sharing an Expected DD, some undated.
const FULL_LIST = [
  { id: "so-01", companySO: "SO-2608-101", companySOId: "SO-2608-101", customerName: "Alpha",   status: "CONFIRMED",     hookkaExpectedDD: "2026-08-20", totalSen: 150000 },
  { id: "so-02", companySO: "",            companySOId: "SO-2608-102", customerName: "Beta",    status: "DELIVERED",     hookkaExpectedDD: "2026-08-01", totalSen: 220000 },
  { id: "so-03", companySO: "SO-2608-103", companySOId: "SO-2608-103", customerName: "Gamma",   status: "IN_PRODUCTION", hookkaExpectedDD: "2026-08-14", totalSen: 310000 },
  { id: "so-04", companySO: "SO-2608-104", companySOId: "SO-2608-104", customerName: "Delta",   status: "DRAFT",         hookkaExpectedDD: "",           totalSen: 40000 },
  { id: "so-05", companySO: "SO-2608-105", companySOId: "SO-2608-105", customerName: "Epsilon", status: "ON_HOLD",       hookkaExpectedDD: "2026-08-14", totalSen: 90000 },
  { id: "so-06", companySO: "SO-2608-106", companySOId: "SO-2608-106", customerName: "Zeta",    status: "CANCELLED",     hookkaExpectedDD: "2026-08-02", totalSen: 10000 },
  { id: "so-07", companySO: "SO-2608-107", companySOId: "SO-2608-107", customerName: "Eta",     status: "READY_TO_SHIP", hookkaExpectedDD: "2026-08-14", totalSen: 55000 },
  { id: "so-08", companySO: "SO-2608-108", companySOId: "SO-2608-108", customerName: "Theta",   status: "SHIPPED",       hookkaExpectedDD: "2026-08-11", totalSen: 70000 },
  { id: "so-09", companySO: "SO-2608-109", companySOId: "SO-2608-109", customerName: "Iota",    status: "INVOICED",      hookkaExpectedDD: "2026-08-03", totalSen: 80000 },
  { id: "so-10", companySO: "SO-2608-110", companySOId: "SO-2608-110", customerName: "Kappa",   status: "CONFIRMED",     hookkaExpectedDD: "2026-09-01", totalSen: 60000 },
  { id: "so-11", companySO: "SO-2608-111", companySOId: "SO-2608-111", customerName: "Lambda",  status: "CLOSED",        hookkaExpectedDD: "2026-08-05", totalSen: 20000 },
  { id: "so-12", companySO: "SO-2608-112", companySOId: "SO-2608-112", customerName: "Mu",      status: "CONFIRMED",     hookkaExpectedDD: "2026-08-12", totalSen: 45000 },
  { id: "so-13", companySO: "SO-2608-113", companySOId: "SO-2608-113", customerName: "Nu",      status: "DRAFT",         hookkaExpectedDD: "2026-08-30", totalSen: 33000 },
  { id: "so-14", companySO: "SO-2608-114", companySOId: "SO-2608-114", customerName: "Xi",      status: "CONFIRMED",     hookkaExpectedDD: "2026-08-12", totalSen: 12000 },
];

test("soListToOrdersDue renders the IDENTICAL list the old client derivation produced", () => {
  const before = oldClientOrdersDue(FULL_LIST.slice(), ORDERS_DUE_DEFAULT_TOP);
  const after = soListToOrdersDue(FULL_LIST.slice(), ORDERS_DUE_DEFAULT_TOP);

  // Same ids, same order.
  assert.deepEqual(
    after.map((r) => r.id),
    before.map((r) => r.id),
  );
  // Same rendered content — the fingerprint technique that caught every real
  // regression in the 2026-08-13 perf session.
  const fBefore = fingerprint(before);
  const fAfter = fingerprint(after);
  assert.equal(fAfter.s, fBefore.s);
  assert.equal(fAfter.h, fBefore.h);
});

test("ties on Expected DD keep the list endpoint's own order (stable sort)", () => {
  // so-03, so-05, so-07 all sit on 2026-08-14 and arrive in that order from
  // `ORDER BY created_at DESC, id DESC`. A SQL sort with a different collation
  // or an unstable sort would shuffle them — and the card would silently show
  // three different orders.
  const out = soListToOrdersDue(FULL_LIST.slice(), 10);
  const tied = out.filter((r) => r.hookkaExpectedDD === "2026-08-14");
  assert.deepEqual(
    tied.map((r) => r.id),
    ["so-03", "so-05", "so-07"],
  );
});

test("drops the four terminal statuses and keeps ON_HOLD / SHIPPED", () => {
  const out = soListToOrdersDue(FULL_LIST.slice(), 100);
  const ids = out.map((r) => r.id);
  for (const terminal of ["so-02", "so-06", "so-09", "so-11"])
    assert.ok(!ids.includes(terminal), `${terminal} is terminal and must be dropped`);
  assert.ok(ids.includes("so-05"), "ON_HOLD is NOT terminal");
  assert.ok(ids.includes("so-08"), "SHIPPED is NOT terminal");
});

test("drops rows with a blank / missing / null Expected DD", () => {
  const out = soListToOrdersDue(
    [
      { id: "blank", status: "CONFIRMED", hookkaExpectedDD: "" },
      { id: "missing", status: "CONFIRMED" },
      { id: "null", status: "CONFIRMED", hookkaExpectedDD: null },
      { id: "kept", status: "CONFIRMED", hookkaExpectedDD: "2026-08-14" },
    ],
    10,
  );
  assert.deepEqual(out.map((r) => r.id), ["kept"]);
});

test("a row with no status is NOT terminal, so it is kept (matches Set.has(undefined))", () => {
  const out = soListToOrdersDue(
    [{ id: "no-status", hookkaExpectedDD: "2026-08-14" }],
    10,
  );
  assert.deepEqual(out.map((r) => r.id), ["no-status"]);
});

test("returns at most `top` rows, default 6", () => {
  assert.equal(ORDERS_DUE_DEFAULT_TOP, 6);
  assert.equal(soListToOrdersDue(FULL_LIST.slice()).length, 6);
  assert.equal(soListToOrdersDue(FULL_LIST.slice(), 3).length, 3);
  assert.equal(soListToOrdersDue(FULL_LIST.slice(), 100).length, 9);
});

test("projects EXACTLY the seven fields the card renders — nothing more", () => {
  const [row] = soListToOrdersDue(
    [
      {
        id: "so-x",
        companySO: "SO-X",
        companySOId: "SO-X-ID",
        customerName: "Cust",
        status: "CONFIRMED",
        hookkaExpectedDD: "2026-08-14",
        totalSen: 12345,
        // Everything below must NOT leak into the phone's payload.
        customerPOImageB64: "AAAA_huge_base64",
        items: [{ productCode: "P", unitPriceSen: 1 }],
        notes: "internal",
        subtotalSen: 999,
      },
    ],
    10,
  );
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "companySO",
      "companySOId",
      "customerName",
      "hookkaExpectedDD",
      "id",
      "status",
      "totalSen",
    ],
  );
  assert.equal(row.customerPOImageB64, undefined);
  assert.equal(row.items, undefined);
  assert.equal(row.notes, undefined);
});

test("string columns default to '' exactly as rowToSO does", () => {
  const [row] = soListToOrdersDue(
    [{ id: "so-y", hookkaExpectedDD: "2026-08-14" }],
    10,
  );
  assert.equal(row.companySO, "");
  assert.equal(row.companySOId, "");
  assert.equal(row.hookkaExpectedDD, "2026-08-14");
});

test("does not mutate the caller's array", () => {
  const src = FULL_LIST.slice();
  const idsBefore = src.map((r) => r.id).join(",");
  soListToOrdersDue(src, 10);
  assert.equal(src.map((r) => r.id).join(","), idsBefore);
});

test("handles an empty list", () => {
  assert.deepEqual(soListToOrdersDue([], 6), []);
});
