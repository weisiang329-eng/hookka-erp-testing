// ---------------------------------------------------------------------------
// missing-asset-404.test.mjs — a build asset that does not exist must 404, not
// hand back the app shell under a one-year immutable cache header.
//
// Measured on prod 2026-08-02, BEFORE the fix:
//   GET /assets/not-real-xyz123.js
//   -> 200, content-type: text/html, cache-control: max-age=31536000, immutable
//
// Verified on staging AFTER:
//   -> 404, content-type: text/plain, cache-control: no-store, x-asset-miss: 1
//   and every real asset still 200 + immutable, /api/health still alive, and a
//   deep link (/definitely-not-a-route) still returns the shell at 200.
//
// Ported from Houzs-ERP #1448. These pins guard the three things that make the
// fix safe rather than the fix itself: its SCOPE, its closed extension list,
// and that it never touches a real response.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const FN = "functions/assets/[[path]].ts";

test("the interceptor exists and can only ever match /assets/*", () => {
  assert.ok(existsSync(FN), `${FN} is what makes a missing asset 404`);
  // A root functions/[[path]].ts would sit in front of /api/* and every deep
  // link. That is the whole reason this file lives under functions/assets/.
  assert.ok(
    !existsSync("functions/[[path]].ts"),
    "a root catch-all Function would intercept /api/* and every SPA deep link",
  );
});

test("only a path that looks like a build asset is eligible", () => {
  const src = readFileSync(FN, "utf8");
  // A closed list — never a guess at an unrecognised path.
  for (const ext of ["js", "css", "map", "woff2", "wasm"]) {
    assert.match(src, new RegExp(`\\b${ext}\\b`), `${ext} must be in the list`);
  }
  assert.match(src, /if \(!ASSET_EXT\.test\(url\.pathname\)\) return res;/);
});

test("a real response is never touched", () => {
  const src = readFileSync(FN, "utf8");
  // Only a 200 that came back as HTML is a miss — that is the SPA fallback
  // answering. Anything else (a real asset, a real 404, a redirect) passes
  // through untouched.
  assert.match(
    src,
    /if \(res\.status !== 200 \|\| !type\.toLowerCase\(\)\.includes\("text\/html"\)\) return res;/,
  );
});

test("the 404 itself is never cached", () => {
  // The next deploy may publish this exact filename.
  assert.match(readFileSync(FN, "utf8"), /"cache-control": "no-store"/);
});

test("real assets keep immutable — they are content-hashed", () => {
  // Houzs dropped `immutable` as well. Ours stays: once a MISSING asset 404s,
  // the shell can no longer be cached under an asset URL, so the hazard the
  // header amplified is gone and the revalidation cost is not worth paying.
  const headers = readFileSync("public/_headers", "utf8");
  assert.match(headers, /\/assets\/\*/);
  assert.match(headers, /immutable/);
});
