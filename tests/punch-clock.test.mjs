// ---------------------------------------------------------------------------
// punch-clock.test.mjs — structural guards for the self-punch rollout.
//   1. The clock card (Punch In / Punch Out) is enabled on the worker home
//      (SHOW_CLOCK = true), while the not-yet-live stat grid + report-issue
//      stay gated behind SHOW_CLOCK_AND_SCAN.
//   2. Punch timestamps are Malaysia local (UTC+8), not the UTC Workers runtime
//      clock — otherwise a 9am punch records "01:00" and a pre-8am punch lands
//      on yesterday's date.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HOME = readFileSync(
  resolve(process.cwd(), "src/pages/worker/index.tsx"),
  "utf8",
);
const WORKER = readFileSync(
  resolve(process.cwd(), "src/api/routes/worker.ts"),
  "utf8",
);

test("worker home shows the Punch In/Out card (SHOW_CLOCK = true)", () => {
  assert.ok(/const SHOW_CLOCK = true/.test(HOME), "SHOW_CLOCK must be enabled");
  assert.ok(
    /\{\/\* Clock card \*\/\}\s*\{SHOW_CLOCK &&/.test(HOME),
    "the clock card must be gated by SHOW_CLOCK, not the stat-grid flag",
  );
});

test("the not-yet-live stat grid stays hidden (SHOW_CLOCK_AND_SCAN still false)", () => {
  assert.ok(
    /const SHOW_CLOCK_AND_SCAN = false/.test(HOME),
    "stat grid / report-issue remain gated until their own rollout",
  );
});

test("punch timestamps use Malaysia local time (UTC+8), not the UTC runtime", () => {
  assert.ok(
    /function malaysiaNow\(\): Date \{\s*return new Date\(Date\.now\(\) \+ 8 \* 60 \* 60 \* 1000\)/.test(
      WORKER,
    ),
    "malaysiaNow must shift the UTC runtime clock by +8h",
  );
  assert.ok(
    WORKER.includes("const my = malaysiaNow();") &&
      WORKER.includes("my.toISOString().slice(11, 16)"),
    "the clock route must derive HH:MM from malaysiaNow, not UTC getHours()",
  );
  assert.ok(
    /todayYmd[\s\S]{0,90}malaysiaNow\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(
      WORKER,
    ),
    "todayYmd must be Malaysia-local so /today and the punch agree on the date",
  );
});
