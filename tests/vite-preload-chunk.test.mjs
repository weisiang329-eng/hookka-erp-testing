// ---------------------------------------------------------------------------
// vite-preload-chunk.test.mjs — `__vitePreload` must not live in the PDF chunk.
//
// BUG-2026-08-13-012. Vite injects its dynamic-import helper `__vitePreload`
// as a VIRTUAL module (`\0vite/preload-helper.js`). It has no node_modules
// path, so the old `manualChunks` callback — which returned early for anything
// outside node_modules — never named it, and rolldown's automatic chunker put
// it INSIDE the `pdf` vendor chunk (jspdf + jspdf-autotable + html2canvas +
// pdfjs-dist, 1,036 KB).
//
// Consequence: every chunk containing an `await import(...)` took a HARD
// STATIC import edge on that 1,036 KB to reach a ~1 KB function. Measured on
// the 2026-08-13 build, 53 chunks carried it — employees, accounting,
// customers, delivery, inventory, products, dashboard-b, react-router — none
// of which touch a PDF library. /employees loaded a 1,997 KB static graph on
// mount; afterwards, 962 KB.
//
// Two things are easy to undo by accident, so both are guarded here:
//   1. Reverting to `manualChunks`. rolldown maps it onto a single
//      codeSplitting group whose name() is the callback, and in that shim a
//      name returned for the preload helper is SILENTLY IGNORED — the helper
//      stays in `pdf` and no vite-preload chunk is emitted at all. Only a
//      group with an explicit `test` captures it.
//   2. Assuming `modulePreload.resolveDependencies` covers this. It strips
//      <link rel=modulepreload> HINTS, not `import` EDGES.
//
// These are source guards on vite.config.ts, not a build. The end-to-end
// evidence (53 -> 14 static importers of the pdf chunk; /employees 1,997 KB ->
// 962 KB raw / 574 KB -> 271 KB gzip) is recorded in docs/BUG-HISTORY.md;
// re-running a full `vite build` inside the unit suite would cost ~50s.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

test("the preload helper is captured by its own codeSplitting group", () => {
  assert.match(src, /codeSplitting:\s*\{/);
  assert.match(src, /name:\s*'vite-preload'/);
  // An explicit `test` is the load-bearing part — a name alone is ignored for
  // this module (see the header).
  assert.match(src, /test:\s*\/preload-helper\//);
});

test("the helper's group outranks the vendor group, and is not size-gated away", () => {
  const group = src.slice(src.indexOf("name: 'vite-preload'"));
  const body = group.slice(0, group.indexOf("}"));
  assert.match(body, /priority:\s*100/);
  assert.match(body, /minSize:\s*0/);
});

test("manualChunks is gone — setting both silently drops it", () => {
  // rolldown: "`manualChunks` option is ignored because the `codeSplitting`
  // option is specified." A revert to manualChunks would put the helper back
  // in the pdf chunk with no error and no failing build.
  assert.equal(/(^|\s)manualChunks\s*:/.test(src), false);
});

test("the vendor chunker survived the API move, rule for rule", () => {
  // The old callback's every branch, verbatim — this change must not have
  // reshuffled any other chunk.
  for (const chunk of [
    "react-core",
    "react-dom",
    "react-router",
    "charts",
    "pdf",
    "xlsx",
    "tanstack",
    "date-fns",
    "icons",
  ]) {
    assert.match(
      src,
      new RegExp(`return '${chunk}'`),
      `vendor chunk '${chunk}' no longer assigned`,
    );
  }
  // It is wired in as the second group's name(), returning null (not
  // undefined) for "no opinion" as rolldown requires.
  assert.match(src, /vendorChunkOf\(id\)\s*\?\?\s*null/);
});

test("resolveDependencies is still preload-hint filtering, not the fix", () => {
  // Kept deliberately: it stops the pdf/xlsx chunks being <link>-preloaded on
  // pages that never open a PDF. It never removed the import edge, which is
  // why this bug survived it.
  assert.match(src, /resolveDependencies/);
  assert.match(src, /\(pdf\|xlsx\)-/);
});
