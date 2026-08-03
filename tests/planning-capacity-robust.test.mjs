// ---------------------------------------------------------------------------
// planning-capacity-robust.test.mjs — capacity is an ORDINARY day, not the
// average of every day.
//
// Real daily output swings hard: Fabric Cutting's last 14 working days ran
// 35%-165% of its own average and Wood Cutting had a 14% day. A plain mean over
// a short window measures which days happened to be in the window; one bad day
// then drags the budget the whole factory is scheduled against.
//
// The estimate therefore drops zero-output days (absence of DATA, not evidence
// of low capacity), discards the top and bottom decile (a heroic push and a
// broken machine are both the wrong number to plan around), and averages what
// is left over a long window.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  trimmedMean,
  collectCapacitySamples,
  MIN_SAMPLES_FOR_TRIM,
} from "../src/api/lib/planning-adaptive-capacity.ts";

test("a steady series is its own value", () => {
  assert.equal(trimmedMean(Array(20).fill(900)), 900);
});

test("one heroic day cannot lift the budget", () => {
  const steady = Array(19).fill(900);
  const withSpike = [...steady, 9000];
  assert.equal(
    trimmedMean(withSpike),
    900,
    "a single 10x day must not become everyone's daily target",
  );
});

test("one broken-machine day cannot sink the budget", () => {
  const steady = Array(19).fill(900);
  const withCrash = [...steady, 20];
  assert.equal(trimmedMean(withCrash), 900);
});

test("it beats a plain mean on the owner's real spread", () => {
  // Fabric Cutting's observed shape: mostly ordinary, with two collapses and
  // two heroic days.
  const days = [951, 1450, 760, 315, 640, 1130, 660, 960, 1480, 400, 650, 920, 690, 1200];
  const plainMean = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
  const robust = trimmedMean(days);
  const ordinary = [640, 650, 660, 690, 760, 920, 951, 960, 1130, 1200];
  const ordinaryMean = Math.round(ordinary.reduce((a, b) => a + b, 0) / ordinary.length);
  assert.ok(
    Math.abs(robust - ordinaryMean) < Math.abs(plainMean - ordinaryMean),
    `robust ${robust} should sit closer to an ordinary day (${ordinaryMean}) than the plain mean ${plainMean}`,
  );
});

test("zero and negative readings never enter the estimate", () => {
  assert.equal(trimmedMean([900, 0, 900, 0, 900, -5, 900]), 900);
  assert.equal(trimmedMean([]), 0);
  assert.equal(trimmedMean([0, 0, 0]), 0);
});

test("a short series is averaged rather than trimmed away", () => {
  // A brand-new department has only a handful of days — trimming those would
  // discard signal, not noise.
  const few = Array(MIN_SAMPLES_FOR_TRIM - 1).fill(500);
  assert.equal(trimmedMean(few), 500);
  assert.equal(trimmedMean([400, 600]), 500);
});

test("the order of the readings does not matter", () => {
  const a = [100, 900, 300, 1200, 700, 500, 800, 200, 1000, 600];
  const b = [...a].reverse();
  assert.equal(trimmedMean(a), trimmedMean(b));
});

function makeDb(rows) {
  return {
    prepare(sql) {
      const exec = {
        async all() {
          return { results: sql.includes("job_cards") ? rows : [] };
        },
        async first() {
          return null;
        },
        async run() {},
      };
      return { ...exec, bind: () => exec };
    },
  };
}

test("samples are collected per working day, skipping Sundays and holidays", async () => {
  const rows = [
    { dept: "FAB_CUT", day: "2026-08-03", minutes: 900 }, // Mon
    { dept: "FAB_CUT", day: "2026-08-04", minutes: 950 }, // Tue
    { dept: "FAB_CUT", day: "2026-08-09", minutes: 5000 }, // Sunday — excluded
    { dept: "FAB_CUT", day: "2026-08-05", minutes: 4000 }, // holiday — excluded
    { dept: "FAB_CUT", day: "2026-08-06", minutes: 0 }, // no output — excluded
  ];
  const samples = await collectCapacitySamples(
    makeDb(rows),
    "2026-09-01",
    "2026-08-01",
    new Set(["2026-08-05"]),
  );
  const daily = samples.get("FAB_CUT").daily.sort((a, b) => a - b);
  assert.deepEqual(
    daily,
    [900, 950],
    "weekend overtime and holidays must not set the everyday budget",
  );
});

test("each department is sampled separately", async () => {
  const rows = [
    { dept: "FAB_CUT", day: "2026-08-03", minutes: 900 },
    { dept: "FAB_SEW", day: "2026-08-03", minutes: 2700 },
  ];
  const samples = await collectCapacitySamples(makeDb(rows), "2026-09-01", "2026-08-01", new Set());
  assert.deepEqual(samples.get("FAB_CUT").daily, [900]);
  assert.deepEqual(samples.get("FAB_SEW").daily, [2700]);
});
