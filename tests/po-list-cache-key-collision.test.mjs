// ---------------------------------------------------------------------------
// po-list-cache-key-collision.test.mjs
//
// BUG (Violet, SO-2608-202, 2026-09): the Production Overview showed blank
// department cells and "0/0 cells complete" while the per-dept pages showed
// Fab Cut / Fab Sew completed.
//
// Root cause: buildPoListBodyKey / buildPoListCacheKey DROP query params whose
// value is the empty string. Sales / Consignment / Warehouse deliberately send
// `?fields=minimal&include=` — an EXPLICIT empty include meaning "do not ship
// jobCards" (src/api/routes/production-orders.ts: includeParam "" -> [""] ->
// includeJobCards === false). The Overview, while a search is active, drops
// excludeCompleted + the date window (src/pages/production/index.tsx:1028-1035)
// and requests the bare `?fields=minimal`.
//
// After the empty-value filter both URLs canonicalise to the SAME KV body key,
// so whichever page loads first wins and the other is served its body for the
// 300s TTL. The Overview then holds POs with `jobCards: []`, and cellFor()
// reports every cell "empty".
//
// An empty param VALUE is a claim ("no job cards"), not a blank. Same family as
// docs/BUG-CLASSES.md C15 ("`0` is a claim, not a blank").
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles the .ts import */
}

const { buildPoListBodyKey, buildPoListCacheKey } = await import(
  "../src/api/routes/production-orders/_helpers.ts"
);

const ORG = "org-test";
const u = (qs) => new URL(`https://erp.hookka.com/api/production-orders${qs}`);

// The three live request shapes that share the `fields=minimal` prefix.
const OVERVIEW_SEARCHING = "?fields=minimal";
const NO_JOB_CARDS = "?fields=minimal&include=";
const OVERVIEW_LOAD_ALL = "?fields=minimal&excludeCompleted=true";

test("KV body key: an empty `include=` must NOT collide with the bare URL", () => {
  assert.notEqual(
    buildPoListBodyKey(ORG, u(OVERVIEW_SEARCHING)),
    buildPoListBodyKey(ORG, u(NO_JOB_CARDS)),
    "Overview-while-searching and the include= (no jobCards) payload share a KV body key — one page is served the other's body",
  );
});

test("KV paginated key: same rule", () => {
  assert.notEqual(
    buildPoListCacheKey(ORG, "7", u(OVERVIEW_SEARCHING)),
    buildPoListCacheKey(ORG, "7", u(NO_JOB_CARDS)),
  );
});

test("the three fields=minimal variants are three distinct keys", () => {
  const keys = [OVERVIEW_SEARCHING, NO_JOB_CARDS, OVERVIEW_LOAD_ALL].map((qs) =>
    buildPoListBodyKey(ORG, u(qs)),
  );
  assert.equal(new Set(keys).size, 3, `expected 3 distinct keys, got ${JSON.stringify(keys)}`);
});

test("param order does not matter (canonicalisation still sorts)", () => {
  assert.equal(
    buildPoListBodyKey(ORG, u("?fields=minimal&excludeCompleted=true")),
    buildPoListBodyKey(ORG, u("?excludeCompleted=true&fields=minimal")),
  );
});

test("the KV body key matches the snapshot key's canonicalisation", () => {
  // production-orders.ts builds the snapshot key as
  //   new URL(req.url).searchParams.toString().split("&").sort().join("&")
  // which KEEPS `include=`. The KV layer sits in FRONT of the snapshot layer,
  // so if the two disagree the snapshot's correctness cannot save the request.
  for (const qs of [OVERVIEW_SEARCHING, NO_JOB_CARDS, OVERVIEW_LOAD_ALL]) {
    const snapshotKey = u(qs).searchParams.toString().split("&").sort().join("&");
    assert.equal(
      buildPoListBodyKey(ORG, u(qs)),
      `pos:body:${ORG}:${snapshotKey}`,
      `KV body key and snapshot key disagree for ${qs}`,
    );
  }
});
