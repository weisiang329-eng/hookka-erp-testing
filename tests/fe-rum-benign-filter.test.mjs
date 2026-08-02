// The benign-camera-error filter at the fe-rum ingestion sink
// (src/api/routes/fe-rum.ts).
//
// The point of the filter is to keep the error feed honest: absorb the
// documented best-effort camera noise from stale scanner clients WITHOUT
// swallowing a real scanner regression. So the test pins both directions —
// what must be dropped, and what must always get through.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/api/routes/fe-rum.ts", "utf8");

// The module isn't import-friendly in isolation (it builds a Hono app against
// Env), so exercise the same matching contract the source declares. Extract
// the pattern list from the source so the test can't drift from it.
function extractPatterns(src) {
  const block = src.slice(
    src.indexOf("const BENIGN_FE_ERROR_PATTERNS = ["),
    src.indexOf("];", src.indexOf("const BENIGN_FE_ERROR_PATTERNS = [")) + 2,
  );
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
const patterns = extractPatterns(SRC);
const isBenign = (msg) => patterns.some((p) => msg.toLowerCase().includes(p));

test("the three documented camera messages are dropped", () => {
  assert.ok(isBenign("The associated Track is in an invalid state"));
  assert.ok(isBenign("Unsupported focusMode."));
  assert.ok(isBenign("setPhotoOptions failed"));
});

test("matching is case-insensitive and substring — real payloads vary in casing/suffix", () => {
  assert.ok(isBenign("NotSupportedError: Unsupported focusMode."));
  assert.ok(isBenign("the associated track is in an invalid state (applyConstraints)"));
});

test("a genuine scanner error is NEVER dropped", () => {
  // These are the errors that would signal an actual regression — they must
  // reach the feed.
  assert.ok(!isBenign("Cannot read properties of undefined (reading 'getVideoTracks')"));
  assert.ok(!isBenign("NotAllowedError: Permission denied"));
  assert.ok(!isBenign("getUserMedia is not a function"));
  assert.ok(!isBenign("QR decode worker crashed"));
  assert.ok(!isBenign(""));
});

test("the filter is applied before the write, and only to errors", () => {
  // Guard the wiring: the continue must sit inside the error branch, above the
  // writeDataPoint, so perf/api events are untouched.
  const errBranch = SRC.slice(
    SRC.indexOf('if (ev.kind === "error")'),
    SRC.indexOf('} else if (ev.kind === "perf")'),
  );
  assert.match(errBranch, /if \(isBenignFeError\(String\(e\.msg[^)]*\)\)\) continue;/);
  assert.ok(
    errBranch.indexOf("isBenignFeError") < errBranch.indexOf("writeDataPoint"),
    "the drop check must run before the AE write",
  );
});
