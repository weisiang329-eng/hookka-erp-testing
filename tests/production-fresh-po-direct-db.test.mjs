// ---------------------------------------------------------------------------
// production-fresh-po-direct-db.test.mjs — locks the "direct-to-DB" read-back
// for PIC / Completion edits on the Production page, the owner-chosen fix for a
// flicker that was patched 8× via the cache/pin and STILL recurred.
//
// Root cause (recap): after a PIC / Completion PATCH, the cached LIST refetch
// serves the STALE production_orders_list_snapshot (served serve-stale-while-
// revalidate) for the ~1-3 min rebuild window, popping the old value back. The
// fix reads the ONE just-edited PO straight from the DB (GET /:id?fresh=1,
// bypassing KV + the snapshot) and merges that authoritative row into the grid.
// Secondary fix: clearing a PIC stored "" (not null) and did NOT clear the
// underlying piece_pics scan stamp unless the card was completed — so the
// cleared PIC kept counting (piecesDone counts piece_pics WHERE pic1Id IS NOT
// NULL) and popped back.
//
// Source-level structural test (no DB / no worker runtime), matching the
// pattern of production-orders-dept-narrow-guard.test.mjs +
// production-wip-producer-output.test.mjs. These invariants are subtle and easy
// to silently regress in a future "perf" / "cleanup" PR, so pin them in CI.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "src/api/routes/production-orders.ts");
const FE = resolve(process.cwd(), "src/pages/production/index.tsx");

// production-orders.ts keeps its module-level helpers in a sibling
// production-orders/_helpers.ts (moved verbatim by a refactor). Source-grep
// guards must see BOTH the route file and its _helpers.ts, so read()
// concatenates them for the split route files only.
const SPLIT_ROUTE_RE =
  /src[\\/]api[\\/]routes[\\/](sales-orders|production-orders|delivery-orders)\.ts$/;

function read(p) {
  let src = readFileSync(p, "utf8");
  if (SPLIT_ROUTE_RE.test(p)) {
    src += "\n\n" + readFileSync(p.replace(/\.ts$/, "/_helpers.ts"), "utf8");
  }
  return src;
}

// Isolate the fetchFreshMinimalPO helper body so the cache-bypass assertions
// only inspect that function, not the rest of the 7k-line file.
function extractFreshHelper(src) {
  const start = src.indexOf("async function fetchFreshMinimalPO(");
  if (start < 0) return null;
  // The helper ends at the next top-level `async function ` / `function `
  // declaration after it. The moved helpers now live in a sibling _helpers.ts
  // where the sibling declarations are `export`-prefixed, so the terminator
  // must also recognize `export (async) function`.
  const after = src.slice(start + 1);
  const nextDecl = after.search(/\n(?:export )?(?:async function |function )/);
  return nextDecl < 0 ? src.slice(start) : src.slice(start, start + 1 + nextDecl);
}

// ---------------------------------------------------------------------------
// 1. The cache-bypassing single-PO helper exists.
// ---------------------------------------------------------------------------
test("fetchFreshMinimalPO helper exists", () => {
  const helper = extractFreshHelper(read(SRC));
  assert.ok(
    helper,
    "Could not find `async function fetchFreshMinimalPO(` in production-orders.ts. " +
      "If it was renamed, update this test — but the cache-bypass invariants below must still hold.",
  );
});

// ---------------------------------------------------------------------------
// 2. The fresh helper must NOT touch KV or the serve-stale snapshot — that is
//    the whole point (the snapshot is exactly what serves the stale value).
// ---------------------------------------------------------------------------
test("fetchFreshMinimalPO reads DIRECTLY from the DB — no KV, no snapshot", () => {
  const helper = extractFreshHelper(read(SRC));
  assert.ok(helper, "helper missing — see previous test");

  assert.doesNotMatch(
    helper,
    /withSnapshot/,
    "fetchFreshMinimalPO must NOT call withSnapshot — the serve-stale snapshot is what pops the pre-write value back. Read the PO directly.",
  );
  assert.doesNotMatch(
    helper,
    /production_orders_list_snapshot/,
    "fetchFreshMinimalPO must NOT read production_orders_list_snapshot (the stale source).",
  );
  assert.doesNotMatch(
    helper,
    /SESSION_CACHE|kvCache|\.get\(\s*cacheKey|poListCacheVersion/,
    "fetchFreshMinimalPO must NOT go through the KV list cache.",
  );
  // Positive: it reads the single PO + its job_cards straight from the tables.
  assert.match(
    helper,
    /FROM production_orders WHERE orgId = \? AND id = \?/,
    "fetchFreshMinimalPO must SELECT the single PO directly by (orgId, id).",
  );
  assert.match(
    helper,
    /FROM job_cards WHERE orgId = \? AND productionOrderId = \?/,
    "fetchFreshMinimalPO must SELECT that PO's job_cards directly.",
  );
  // Same minimal shape the list returns.
  assert.match(
    helper,
    /rowToMinimalPO\(/,
    "fetchFreshMinimalPO must build the SAME minimal PO shape the list returns (rowToMinimalPO).",
  );
  assert.match(
    helper,
    /fetchPiecesDoneByJc\(/,
    "fetchFreshMinimalPO must populate piecesDone via fetchPiecesDoneByJc, like the list.",
  );
});

// ---------------------------------------------------------------------------
// 3. GET /:id?fresh=1 branch exists, is gated by production-orders:read, and
//    routes to the fresh helper.
// ---------------------------------------------------------------------------
test("GET /:id has a ?fresh=1 branch gated by production-orders:read", () => {
  const src = read(SRC);
  const getIdx = src.indexOf('app.get("/:id"');
  assert.ok(getIdx > 0, 'app.get("/:id") handler not found');
  // Look at the handler body (up to the next app.<verb>( registration).
  const after = src.slice(getIdx);
  const nextRoute = after.slice(1).search(/\napp\.(get|post|put|patch|delete)\(/);
  const handler = nextRoute < 0 ? after : after.slice(0, nextRoute + 1);

  assert.match(
    handler,
    /c\.req\.query\("fresh"\)\s*===\s*"1"/,
    "GET /:id must branch on ?fresh=1.",
  );
  assert.match(
    handler,
    /requirePermission\(c,\s*"production-orders",\s*"read"\)/,
    "The ?fresh=1 branch must be gated by requirePermission(c, 'production-orders', 'read') — same read perm as the job-cards sibling that reads this data.",
  );
  assert.match(
    handler,
    /fetchFreshMinimalPO\(/,
    "The ?fresh=1 branch must call fetchFreshMinimalPO.",
  );
  assert.match(
    handler,
    /Cache-Control"?\s*:\s*"no-store"/,
    "The ?fresh=1 response must send Cache-Control: no-store so no intermediary caches the fresh read.",
  );
});

// ---------------------------------------------------------------------------
// 4. PIC clear coerces to real NULL (not ""), in applyPoUpdate.
// ---------------------------------------------------------------------------
test("clearing a PIC sets pic1Id/pic2Id to NULL (not empty string)", () => {
  const src = read(SRC);
  // The clear branches live in the body.pic1Id / body.pic2Id handling.
  const p1 = src.indexOf("if (body.pic1Id !== undefined) {");
  assert.ok(p1 > 0, "body.pic1Id handling not found in applyPoUpdate");
  const block = src.slice(p1, p1 + 1400);

  // The else (clear) branch must assign null to both id and name for pic1+pic2.
  assert.match(
    block,
    /updated\.pic1Id\s*=\s*null;[\s\S]*?updated\.pic1Name\s*=\s*null;/,
    "Clearing PIC1 must set updated.pic1Id = null AND updated.pic1Name = null (not ''). '' is not nullish, so the `?? null` bind kept it and piecesDone (pic1Id IS NOT NULL) still counted it.",
  );
  assert.match(
    block,
    /updated\.pic2Id\s*=\s*null;[\s\S]*?updated\.pic2Name\s*=\s*null;/,
    "Clearing PIC2 must set updated.pic2Id = null AND updated.pic2Name = null (not '').",
  );
  // Guard against the regression: the clear branch must not re-introduce `= ""`.
  assert.doesNotMatch(
    block,
    /updated\.pic1Name\s*=\s*"";/,
    "PIC1 clear must not assign '' to pic1Name (regression guard).",
  );
});

// ---------------------------------------------------------------------------
// 5. Removing a PIC clears the matching piece_pics stamp UNCONDITIONALLY
//    (not only when the card is completed). This is the complement of the
//    completed-card swap branch.
// ---------------------------------------------------------------------------
test("removing a PIC clears the piece_pics stamp unconditionally (not gated on completedDate)", () => {
  const src = read(SRC);
  // The unconditional clear is gated on the NEGATION of the swap branch's
  // condition so the two never double-run.
  assert.match(
    src,
    /const swapHandledRemoval\s*=\s*!!updated\.completedDate\s*&&\s*jcWasCompleted;/,
    "Expected `const swapHandledRemoval = !!updated.completedDate && jcWasCompleted;` — the guard that lets the unconditional clear fire only when the completed-card swap branch did NOT.",
  );
  assert.match(
    src,
    /if\s*\(\s*!swapHandledRemoval\s*\)\s*\{/,
    "The unconditional piece_pics clear must run when !swapHandledRemoval (i.e. PIC removed on a card that is NOT completed — the case the old completedDate-gated propagation missed).",
  );
  // It must clear pic1 and pic2 stamps by the OLD pic id (leaving other
  // scanners' pieces alone).
  assert.match(
    src,
    /if\s*\(oldPic1Id\s*&&\s*!updated\.pic1Id\)[\s\S]*?UPDATE piece_pics SET pic1Id = NULL, pic1Name = NULL WHERE jobCardId = \? AND pic1Id = \?/,
    "On PIC1 removal, must clear piece_pics pic1 stamps WHERE pic1Id = <oldPic1Id>.",
  );
  assert.match(
    src,
    /if\s*\(oldPic2Id\s*&&\s*!updated\.pic2Id\)[\s\S]*?UPDATE piece_pics SET pic2Id = NULL, pic2Name = NULL WHERE jobCardId = \? AND pic2Id = \?/,
    "On PIC2 removal, must clear piece_pics pic2 stamps WHERE pic2Id = <oldPic2Id>.",
  );
});

// ---------------------------------------------------------------------------
// 6. Frontend: PIC / Completion writes read the fresh PO back and merge it.
// ---------------------------------------------------------------------------
test("frontend merges the fresh single-PO read after PIC/Completion writes", () => {
  const fe = read(FE);

  // The read-back helper exists and hits the fresh endpoint.
  assert.match(
    fe,
    /const mergeFreshPOs\s*=\s*useCallback\(/,
    "Production page must define mergeFreshPOs (the direct-to-DB read-back).",
  );
  assert.match(
    fe,
    /\/api\/production-orders\/\$\{encodeURIComponent\(poId\)\}\?fresh=1/,
    "mergeFreshPOs must fetch /api/production-orders/:id?fresh=1 for the edited PO.",
  );
  // It pins the FRESH value so the stale LIST refetch can't clobber it.
  assert.match(
    fe,
    /recentlyPatchedRef\.current\.set\(/,
    "mergeFreshPOs must set the recentlyPatchedRef pin from the fresh JC values.",
  );

  // Only PIC / Completion edits take the fresh-read path.
  assert.match(
    fe,
    /touchesPicOrCompletion/,
    "A touchesPicOrCompletion predicate must gate the fresh-read path to PIC/Completion edits.",
  );
  assert.match(
    fe,
    /"pic1Id"[\s\S]*?"pic2Id"[\s\S]*?"completedDate"/,
    "PIC_COMPLETION_KEYS must include pic1Id, pic2Id and completedDate.",
  );

  // flushDrafts wires the read-back for successful PIC/Completion drafts.
  assert.match(
    fe,
    /results\s*\.filter\(\(r\)\s*=>\s*r\.result\.success\s*&&\s*touchesPicOrCompletion\(r\.draft\.patch\)\)/,
    "flushDrafts must call mergeFreshPOs for successful drafts whose patch touched PIC/Completion.",
  );
});
