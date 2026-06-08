// ---------------------------------------------------------------------------
// snapshot-freshness-latestts.test.mjs — locks the 2026-06-08 cross-format fix
// in getMaxSourceUpdatedAt (via its extracted pure helper `latestTimestamp`).
//
// The bug: the cross-table watermark was computed with SQL `SELECT MAX(t)` over
// per-table MAX(col)::text values that arrive in TWO formats — TEXT columns give
// ISO "...T...Z", TIMESTAMP columns give postgres "...space...+00". A string MAX
// puts 'T' (0x54) ABOVE the space (0x20), so a TEXT table's OLDER string beat a
// TIMESTAMP table's NEWER one. job_cards (TIMESTAMP) bumps therefore lost to
// production_orders / sales_orders (TEXT), the probe missed the edit, and the
// stale snapshot was served as "fresh" for hours ("completion saved then gone";
// also Dashboard / Dept-Performance / Fabric-Tracking).
//
// Fix: take the cross-table MAX CHRONOLOGICALLY in JS (new Date parses both
// forms). All fixtures below carry an explicit UTC marker (Z or +00) so the
// test is timezone-independent (a no-offset postgres string would parse as
// LOCAL — fine in prod since Workers run in UTC, but not in CI/dev).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const { latestTimestamp } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/snapshot-freshness.ts")).href
);

const sameInstant = (a, b) =>
  assert.equal(new Date(a).getTime(), new Date(b).getTime(), `${a} != ${b}`);

test("latestTimestamp: NEWER postgres-TIMESTAMP form beats OLDER TEXT-ISO (THE bug)", () => {
  // job_cards bumped 13:45 (space form); production_orders at 13:40 (ISO form).
  // A lexical MAX would WRONGLY pick the 13:40 ISO ('T' > ' '); chronological = 13:45.
  sameInstant(
    latestTimestamp(["2026-06-08T13:40:00.000Z", "2026-06-08 13:45:30.123+00"]),
    "2026-06-08T13:45:30.123Z",
  );
});

test("latestTimestamp: NEWER TEXT-ISO beats OLDER postgres-TIMESTAMP", () => {
  sameInstant(
    latestTimestamp(["2026-06-08 13:40:00+00", "2026-06-08T13:45:30.000Z"]),
    "2026-06-08T13:45:30.000Z",
  );
});

test("latestTimestamp: picks the latest across a mixed list of both formats", () => {
  sameInstant(
    latestTimestamp([
      "2026-06-01T08:00:00.000Z",
      "2026-06-08 13:45:30+00",
      "2026-06-05T20:00:00.000Z",
      "2026-06-08 13:45:29+00",
    ]),
    "2026-06-08T13:45:30.000Z",
  );
});

test("latestTimestamp: skips null/empty/undefined and returns the valid max", () => {
  sameInstant(
    latestTimestamp([null, "", undefined, "2026-06-08T10:00:00.000Z", null]),
    "2026-06-08T10:00:00.000Z",
  );
});

test("latestTimestamp: all null/empty -> null (caller treats as trivially fresh)", () => {
  assert.equal(latestTimestamp([null, "", undefined]), null);
  assert.equal(latestTimestamp([]), null);
});

test("latestTimestamp: skips an unparseable value but keeps the valid max", () => {
  sameInstant(
    latestTimestamp(["not-a-date", "2026-06-08T10:00:00.000Z"]),
    "2026-06-08T10:00:00.000Z",
  );
});

test("latestTimestamp: returns ISO 'Z' form regardless of input format", () => {
  const out = latestTimestamp(["2026-06-08 13:45:30+00"]);
  assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
