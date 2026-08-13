// ---------------------------------------------------------------------------
// service-case-do-scope-equivalence.test.mjs — proof that scoping the Service
// Case detail page's delivery-order fetch cannot change what the stepper shows.
//
// BUG-2026-08-13-022 (audit finding D1): src/pages/service-cases/detail.tsx
// fetched "/api/delivery-orders" BARE — 1.07 MB, ~393 DOs with every line item
// (PERF-BACKLOG P6) — so a five-step stepper could read five fields off at most
// a handful of rows. Its sibling production-order fetch three lines below was
// scoped in BUG-2026-08-13-003; this one was missed. The fix moves the filter
// into SQL via `?fields=case-pipeline&scope=<soIds>`.
//
// The claim that has to hold is: the rows the SERVER now drops are exactly the
// rows computeCasePipeline already dropped in the browser, and dropping them
// earlier cannot move any stage or any timestamp.
//
// Two independent things make that true, and both are pinned below:
//   1. case-pipeline.ts:131 filters `dos` to `!!d.salesOrderId &&
//      svIds.has(d.salesOrderId)` before reading anything. The SQL predicate
//      `salesOrderId IN (<scope>)` selects the same set — including the NULL
//      handling, because rowToOrder emitted `salesOrderId: row.salesOrderId ?? ""`
//      and `!!""` is false, just as SQL `IN` never matches NULL.
//   2. the surviving rows are folded ONLY through earliest()/latest()
//      (case-pipeline.ts:186-190), so ROW ORDER is irrelevant — the projection
//      is free to return them in any order without moving a date.
//
// These are properties of the shared helper, so this test exercises the real
// src/lib/case-pipeline.ts rather than a copy of its logic.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const { computeCasePipeline } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/case-pipeline.ts")).href
);

const SV_A = "so-sv-a";
const SV_B = "so-sv-b";
const SV_IDS = [SV_A, SV_B];

// A whole-org DO list: two DOs that belong to this case, and four that are the
// other ~391 rows the page used to download — one of which is a multi-SO DO
// carrying the "" salesOrderId that rowToOrder emits for a NULL column.
const WHOLE_ORG_DOS = [
  { id: "do-1", salesOrderId: SV_A, status: "DELIVERED", createdAt: "2026-06-10T02:00:00.000Z", dispatchedAt: "2026-06-11T02:00:00.000Z", deliveredAt: "2026-06-12T02:00:00.000Z" },
  { id: "do-2", salesOrderId: "so-other-1", status: "DELIVERED", createdAt: "2026-06-01T02:00:00.000Z", dispatchedAt: "2026-06-02T02:00:00.000Z", deliveredAt: "2026-06-03T02:00:00.000Z" },
  { id: "do-3", salesOrderId: SV_B, status: "LOADED", createdAt: "2026-06-08T02:00:00.000Z", dispatchedAt: "2026-06-09T02:00:00.000Z", deliveredAt: null },
  { id: "do-4", salesOrderId: "", status: "DELIVERED", createdAt: "2026-05-01T02:00:00.000Z", dispatchedAt: "2026-05-02T02:00:00.000Z", deliveredAt: "2026-05-03T02:00:00.000Z" },
  { id: "do-5", salesOrderId: "so-other-2", status: "DRAFT", createdAt: "2026-07-01T02:00:00.000Z", dispatchedAt: null, deliveredAt: null },
  { id: "do-6", salesOrderId: "so-other-3", status: "DELIVERED", createdAt: "2026-07-20T02:00:00.000Z", dispatchedAt: "2026-07-21T02:00:00.000Z", deliveredAt: "2026-07-22T02:00:00.000Z" },
];

/** What the SQL predicate `salesOrderId IN (<scope>)` returns. */
function serverScoped(dos, svIds) {
  const set = new Set(svIds);
  // SQL `IN` never matches NULL, and no caller can pass an empty id (the route
  // filters blanks out of the scope list), so a "" salesOrderId cannot match.
  return dos.filter((d) => !!d.salesOrderId && set.has(d.salesOrderId));
}

const CASE = {
  caseStatus: "IN_PROGRESS",
  createdAt: "2026-06-01T00:00:00.000Z",
  investigatingAt: "2026-06-02T00:00:00.000Z",
  closedAt: null,
  orders: [
    { isSv: true, status: "OPEN", createdAt: "2026-06-05T00:00:00.000Z" },
    { isSv: true, status: "OPEN", createdAt: "2026-06-06T00:00:00.000Z" },
  ],
  pos: [
    { salesOrderId: SV_A, jobCards: [{ completedDate: "2026-06-07T00:00:00.000Z" }] },
    { salesOrderId: "so-other-1", jobCards: [{ completedDate: "2026-01-01T00:00:00.000Z" }] },
  ],
  svOrderIds: SV_IDS,
};

test("the scoped fetch produces the IDENTICAL pipeline to the whole-org one", () => {
  const before = computeCasePipeline({ ...CASE, dos: WHOLE_ORG_DOS });
  const after = computeCasePipeline({
    ...CASE,
    dos: serverScoped(WHOLE_ORG_DOS, SV_IDS),
  });
  assert.deepEqual(
    after,
    before,
    "server-side scoping moved the stepper — the whole point is that it cannot",
  );
});

test("row ORDER does not matter, so the projection need not reproduce it", () => {
  // The helper folds the DOs only through earliest()/latest(). If that ever
  // changed to something order-sensitive (a `[0]`, a `.find`, a "latest by
  // position"), this test fails and the projection would need an ORDER BY that
  // matches the list route's `created_at DESC` exactly.
  const scoped = serverScoped(WHOLE_ORG_DOS, SV_IDS);
  const forward = computeCasePipeline({ ...CASE, dos: scoped });
  const reversed = computeCasePipeline({ ...CASE, dos: [...scoped].reverse() });
  assert.deepEqual(reversed, forward);
});

test("a multi-SO DO (blank salesOrderId) was already invisible and stays invisible", () => {
  // delivery_orders.salesOrderId is left NULL when a DO spans several SOs, so
  // such a DO never reached this stepper even before the change. Pin that the
  // scoping did not accidentally start including — or start excluding
  // something else — by comparing against a run with the row removed entirely.
  const withoutBlank = WHOLE_ORG_DOS.filter((d) => d.salesOrderId !== "");
  assert.deepEqual(
    computeCasePipeline({ ...CASE, dos: serverScoped(WHOLE_ORG_DOS, SV_IDS) }),
    computeCasePipeline({ ...CASE, dos: serverScoped(withoutBlank, SV_IDS) }),
  );
});

test("a case with no delivery orders of its own is unaffected", () => {
  const noneMine = computeCasePipeline({ ...CASE, dos: WHOLE_ORG_DOS, svOrderIds: ["so-nobody"] , pos: []});
  const scoped = computeCasePipeline({
    ...CASE,
    dos: serverScoped(WHOLE_ORG_DOS, ["so-nobody"]),
    svOrderIds: ["so-nobody"],
    pos: [],
  });
  assert.deepEqual(scoped, noneMine);
});

// ---------------------------------------------------------------------------
// Source-level locks — the two ends of the contract, so a future edit to
// either side fails CI instead of silently re-introducing the whole-org pull.
// ---------------------------------------------------------------------------
const PAGE = readFileSync(
  resolve(process.cwd(), "src/pages/service-cases/detail.tsx"),
  "utf8",
);
const ROUTE = readFileSync(
  resolve(process.cwd(), "src/api/routes/delivery-orders.ts"),
  "utf8",
);

test("the page never fetches /api/delivery-orders whole-org again", () => {
  assert.match(
    PAGE,
    /"\/api\/delivery-orders\?fields=case-pipeline&scope="/,
    "service-cases/detail.tsx should request the scoped projection",
  );
  assert.doesNotMatch(
    PAGE,
    /useCachedJson<[\s\S]{0,600}?>\(\s*svOrderIds\.length > 0 \? "\/api\/delivery-orders"/,
    "the bare whole-org delivery-orders fetch is back (1.07 MB — BUG-2026-08-13-022)",
  );
});

test("a bare ?fields=case-pipeline returns nothing rather than the whole org", () => {
  // If a caller forgets `scope=`, the projection must NOT fall through to the
  // full list — that would quietly restore the payload this change removed.
  const block = ROUTE.slice(ROUTE.indexOf('c.req.query("fields") === "case-pipeline"'));
  assert.match(
    block.slice(0, 1200),
    /scopeIds\.length === 0[\s\S]{0,200}?data: \[\]/,
    "an unscoped ?fields=case-pipeline must return an empty list",
  );
});

test("the projection applies the same customer-scope clause as the list path", () => {
  const block = ROUTE.slice(ROUTE.indexOf('c.req.query("fields") === "case-pipeline"'));
  const handler = block.slice(0, 2000);
  assert.match(
    handler,
    /\$\{doClause\}/,
    "a customer-scoped user must be narrowed here exactly as on the list path",
  );
  assert.match(handler, /doScope\.binds/);
});
