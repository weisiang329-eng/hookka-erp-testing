// ---------------------------------------------------------------------------
// production-sticker-scope.test.mjs
//
// Locks the 2026-06-24 perf fix for slow Fab Sew / Foam sticker printing.
// Symptom (Wei Siang): printing Fab Sew stickers from the Fab Cut page was very
// slow / "load ä¸å‡ºæ¥" because both loaders fetched the WHOLE org's production
// orders + job cards, then filtered client-side.
//
// Fix: a ?scope=<csv tokens> filter on GET /api/production-orders (matches an
// order by id / poNo / companySOId / salesOrderId / companyCOId /
// consignmentOrderId), the JC fetch narrowed to the returned POs, and both
// loaders fetching only the visible orders (+ the SOFA group siblings, so no
// sticker is dropped â€” "æ‹‰å°ã€æ‹‰å…¨"). These source-assertions pin the contract.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 2026-08-01: scope filtering moved into _helpers.ts when the route was split. This test read only the route file, so it went red the
// moment the code moved - and nobody noticed, because the test was never
// registered in `npm test`. Reading BOTH halves means a future split cannot
// orphan it again.
const ROUTE = [
  "src/api/routes/production-orders.ts",
  "src/api/routes/production-orders/_helpers.ts",
]
  .map((f) => readFileSync(resolve(process.cwd(), f), "utf8"))
  .join(String.fromCharCode(10));
const PAGE = readFileSync(
  resolve(process.cwd(), "src/pages/production/index.tsx"),
  "utf8",
);

test("backend: GET /production-orders accepts a ?scope= token filter", () => {
  assert.match(ROUTE, /c\.req\.query\("scope"\)/, "must parse ?scope=");
  // Match an order by ANY identifier â€” internal id, poNo, and the four SO/CO
  // group ids â€” so the FE can mix po ids and human SO/CO numbers in one list.
  assert.match(
    ROUTE,
    /id IN \(\$\{scopePh\}\) OR poNo IN/,
    "scope WHERE must OR-match id + poNo â€¦",
  );
  assert.match(
    ROUTE,
    /companySOId IN \(\$\{scopePh\}\)[\s\S]*?consignmentOrderId IN \(\$\{scopePh\}\)/,
    "scope WHERE must include the SO/CO group ids",
  );
  // The JC fetch MUST narrow to the returned POs for a scoped read, else the
  // whole-org JC scan defeats the perf win.
  assert.match(
    ROUTE,
    /if \(hasFilter \|\| hasScope\)/,
    "the po-id-narrowed JC branch must trigger for hasScope",
  );
  // Scoped reads bypass the list caches (targeted + must be fresh).
  const i = ROUTE.indexOf("if (scopeTokens && scopeTokens.length > 0)");
  assert.ok(i >= 0, "scoped early-return must exist");
  assert.match(
    ROUTE.slice(i, i + 800),
    /return c\.json\(\{ success: true, data, total: data\.length \}\)/,
    "scoped fetch returns directly (before the KV/snapshot cache)",
  );
});

test("FE: Fab Sew + Foam sticker loaders fetch scoped, not the whole org", () => {
  assert.ok(
    (PAGE.match(/&scope=\$\{encodeURIComponent/g) || []).length >= 2,
    "both sticker loaders must pass &scope=",
  );
  // Fab Sew expands each visible SOFA anchor to its SO/CO group (phase 2) so a
  // merged-anchor sofa still prints every piece's Fab Sew sticker.
  assert.match(
    PAGE,
    /const sofaGids = new Set/,
    "Fab Sew loader must expand visible SOFA anchors to their group",
  );
  // A full-fetch safety net so a scoped miss can never print short.
  assert.ok(
    (PAGE.match(/const FETCH_BASE\s*=/g) || []).length >= 2,
    "both loaders must keep a full-fetch FETCH_BASE fallback",
  );
});

