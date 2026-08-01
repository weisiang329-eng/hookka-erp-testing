// ---------------------------------------------------------------------------
// scanner-constraint-rejections.test.mjs
//
// Health reported these as unhandled JS errors on /worker/scan over 24h:
//     "The associated Track is in an invalid state"  x16
//     "Unsupported focusMode."                        x5
//
// Every call site LOOKED guarded:
//     try { void track.applyConstraints({...}); } catch { /* best-effort */ }
// but applyConstraints() returns a Promise. try/catch only catches a
// SYNCHRONOUS throw, so those catch blocks could never fire - the rejection
// escaped as an unhandled rejection. The guards were decorative.
//
// Both messages are normal on real hardware (focusMode unsupported on many
// lenses; the track goes invalid when the camera is torn down mid-call), so
// they must be ABSORBED, not fixed. This test pins the general property rather
// than the five known sites, so a sixth added later cannot regress silently.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCANNERS = [
  "src/pages/worker/scan.tsx",
  "src/pages/rack-scan.tsx",
  "src/pages/m/components/ScanSheet.tsx",
];

// Find every `<expr>.applyConstraints(` and return the slice that follows, so
// we can check what happens to the returned promise.
function constraintCalls(src) {
  const out = [];
  const needle = ".applyConstraints(";
  let i = src.indexOf(needle);
  while (i !== -1) {
    // Walk to the matching close paren of the call.
    let depth = 0;
    let j = i + needle.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ index: i, after: src.slice(j + 1, j + 60) });
    i = src.indexOf(needle, j);
  }
  return out;
}

test("every applyConstraints call handles its own rejection", () => {
  let checked = 0;
  for (const p of SCANNERS) {
    const src = readFileSync(resolve(process.cwd(), p), "utf8");
    // Skip comment-only mentions (the header note quotes the old pattern).
    for (const call of constraintCalls(src)) {
      const line = src.slice(src.lastIndexOf("\n", call.index) + 1, call.index);
      if (line.trim().startsWith("//")) continue;
      checked++;
      const settled =
        /^\s*\.catch\(/.test(call.after) ||
        /^\s*\.then\(/.test(call.after) ||
        // `await track.applyConstraints(...)` inside try/catch is fine: an
        // awaited rejection IS caught synchronously by the enclosing catch.
        /await\s*$/.test(
          src.slice(Math.max(0, call.index - 40), call.index).split(".").slice(0, -1).join("."),
        ) ||
        src.slice(Math.max(0, call.index - 60), call.index).includes("await ");
      assert.ok(
        settled,
        `${p}: an applyConstraints promise is neither awaited nor .catch()ed - ` +
          `a rejection here becomes an unhandled rejection, which is exactly ` +
          `how "Unsupported focusMode." reached the error feed`,
      );
    }
  }
  assert.ok(checked >= 5, `expected to inspect the known call sites, saw ${checked}`);
});

test("worker/scan specifically no longer relies on try/catch for async rejects", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/worker/scan.tsx"), "utf8");
  // Every `void ....applyConstraints(...)` must chain a .catch.
  // Exclude comment lines - the header note deliberately quotes the OLD
  // pattern to explain the bug, and matching that would be self-defeating.
  const voids = [...src.matchAll(/void\s+\w+\.applyConstraints\(/g)].filter(
    (m) => !src.slice(src.lastIndexOf(String.fromCharCode(10), m.index) + 1, m.index).trim().startsWith("//"),
  );
  assert.ok(voids.length >= 5, "the fire-and-forget sites should still exist");
  for (const m of voids) {
    const tail = src.slice(m.index, m.index + 600);
    assert.match(
      tail,
      /\}\)\s*\.catch\(/,
      "a void-ed applyConstraints must chain .catch() - try/catch cannot see an async rejection",
    );
  }
});

