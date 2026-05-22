// ---------------------------------------------------------------------------
// scheduling.test.mjs — unit tests for src/lib/scheduling.ts, the backward-
// scheduling engine.
//
// The engine works backward from a customer delivery date, subtracting
// "working days" (Mon-Sat — Sundays are skipped) for a per-category buffer
// and for each department's lead time. The lead times come from
// `deptLeadTimes` in mock-data.ts.
//
// IMPORTANT runtime fact: `deptLeadTimes` is currently an empty array (`[]`)
// in src/lib/mock-data.ts. With no lead-time rows, `getLeadDays()` returns 0
// for every department, so calculateBackwardSchedule collapses every
// department start/end to the Hookka Expected DD (= delivery - buffer).
//
// IMPORT NOTE: scheduling.ts has exactly one value import — `deptLeadTimes`
// from "./mock-data". mock-data.ts in turn does a runtime re-export from
// "@/lib/pricing-options" (a path alias). `npm test` runs `node --import
// tsx/esm` with NO --tsconfig flag, and the root tsconfig.json carries no
// `paths` map, so tsx cannot resolve that "@/" alias — importing scheduling.ts
// directly throws ERR_MODULE_NOT_FOUND deep inside mock-data.ts.
//
// To stay self-contained (and to match the precedent set by
// scheduler.test.mjs, which transpiles its target and swaps an import),
// we transpile scheduling.ts with esbuild and rewrite its `./mock-data`
// import to a tiny inline stub exporting `deptLeadTimes = []`. That is the
// ONLY symbol scheduling.ts consumes from mock-data, and [] is its real
// runtime value — so the stub is behaviourally exact, not a simplification.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { transformSync } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Build a loadable .mjs from scheduling.ts with the ./mock-data import
// stubbed. deptLeadTimes is [] at runtime — the stub mirrors that exactly.
// ---------------------------------------------------------------------------
const schedulingSrc = readFileSync(
  resolve(__dirname, "..", "src", "lib", "scheduling.ts"),
  "utf8",
);

// scheduling.ts:  import { deptLeadTimes } from "./mock-data";
// Replace with an inline const so no module resolution is needed.
const patchedSrc = schedulingSrc.replace(
  /import\s*\{\s*deptLeadTimes\s*\}\s*from\s*["']\.\/mock-data["'];?/,
  // The real runtime value of deptLeadTimes is an empty array.
  "const deptLeadTimes = [];",
);

if (patchedSrc === schedulingSrc) {
  throw new Error(
    "[scheduling.test] Failed to patch the ./mock-data import — the import " +
      "shape in scheduling.ts changed; update the regex.",
  );
}

const { code: js } = transformSync(patchedSrc, {
  loader: "ts",
  format: "esm",
  target: "es2020",
});

const tmp = mkdtempSync(resolve(tmpdir(), "scheduling-test-"));
const tmpFile = resolve(tmp, "scheduling.mjs");
writeFileSync(tmpFile, js, "utf8");

const scheduling = await import(pathToFileURL(tmpFile).href);

// deptLeadTimes is empty in this build (stubbed to its real [] value), so
// the per-dept date assertions that depend on that hold.
const LEAD_TIMES_EMPTY = true;

// ---------------------------------------------------------------------------
// calculateHookkaDD — delivery date minus the category buffer, in working
// days (Sundays skipped). This is the cleanest public window onto the
// internal subtractWorkingDays math.
//
// Buffer: BEDFRAME = 2 working days, SOFA = 1 working day.
// ---------------------------------------------------------------------------
test("calculateHookkaDD: SOFA buffer is 1 working day — Fri delivery -> Thu", () => {
  // 2026-05-22 is a Friday. Minus 1 working day -> Thu 2026-05-21.
  assert.equal(scheduling.calculateHookkaDD("2026-05-22", "SOFA"), "2026-05-21");
});

test("calculateHookkaDD: BEDFRAME buffer is 2 working days — Fri delivery -> Wed", () => {
  // 2026-05-22 Friday. Minus 2 working days -> Wed 2026-05-20 (no Sunday
  // in the span).
  assert.equal(
    scheduling.calculateHookkaDD("2026-05-22", "BEDFRAME"),
    "2026-05-20",
  );
});

test("calculateHookkaDD: subtraction skips Sunday — Mon delivery, SOFA -> Sat", () => {
  // 2026-05-25 is a Monday. Going back 1 working day must skip Sunday
  // (2026-05-24) and land on Sat 2026-05-23.
  assert.equal(scheduling.calculateHookkaDD("2026-05-25", "SOFA"), "2026-05-23");
});

test("calculateHookkaDD: Mon delivery, BEDFRAME (2 wd) skips Sunday -> Fri", () => {
  // 2026-05-25 Monday. Back 2 working days: Sun skipped -> Sat, then Fri.
  // Result: Fri 2026-05-22.
  assert.equal(
    scheduling.calculateHookkaDD("2026-05-25", "BEDFRAME"),
    "2026-05-22",
  );
});

test("calculateHookkaDD: crosses a month boundary — Jun 1 delivery -> May 30", () => {
  // 2026-06-01 is a Monday. SOFA buffer 1 wd: Sun (05-31) skipped, lands
  // Sat 2026-05-30. Confirms the Date arithmetic rolls the month back.
  assert.equal(scheduling.calculateHookkaDD("2026-06-01", "SOFA"), "2026-05-30");
});

test("calculateHookkaDD: result is a valid ISO yyyy-mm-dd string", () => {
  const out = scheduling.calculateHookkaDD("2026-05-22", "SOFA");
  assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------------------------------------------------------------------
// calculateBackwardSchedule — full department schedule.
//
// Returns exactly 8 department rows in a fixed order. With deptLeadTimes
// empty (current runtime state) every department's lead time is 0, so each
// department's start AND end collapse onto the Hookka Expected DD.
// ---------------------------------------------------------------------------
test("calculateBackwardSchedule: returns all 8 departments in fixed order", () => {
  const sched = scheduling.calculateBackwardSchedule("2026-05-22", "SOFA");
  assert.equal(sched.length, 8);
  assert.deepEqual(
    sched.map((s) => s.deptCode),
    [
      "FAB_CUT",
      "FAB_SEW",
      "FOAM",
      "WOOD_CUT",
      "FRAMING",
      "WEBBING",
      "UPHOLSTERY",
      "PACKING",
    ],
  );
});

test("calculateBackwardSchedule: every row carries a deptName and ISO dates", () => {
  const sched = scheduling.calculateBackwardSchedule("2026-05-22", "BEDFRAME");
  for (const row of sched) {
    assert.ok(row.deptName.length > 0, `${row.deptCode} missing deptName`);
    assert.match(row.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(row.endDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("calculateBackwardSchedule: with empty lead times every dept date == Hookka DD", () => {
  // Documents the current reality: deptLeadTimes is []. getLeadDays -> 0
  // everywhere, so packing/upholstery/feeder all subtract 0 working days
  // and collapse onto the Hookka Expected DD.
  assert.equal(LEAD_TIMES_EMPTY, true);
  const hookkaDD = scheduling.calculateHookkaDD("2026-05-22", "SOFA");
  const sched = scheduling.calculateBackwardSchedule("2026-05-22", "SOFA");
  for (const row of sched) {
    assert.equal(
      row.startDate,
      hookkaDD,
      `${row.deptCode} startDate should collapse to Hookka DD (empty lead times)`,
    );
    assert.equal(
      row.endDate,
      hookkaDD,
      `${row.deptCode} endDate should collapse to Hookka DD (empty lead times)`,
    );
  }
});

test("calculateBackwardSchedule: every leadDays is 0 while deptLeadTimes is empty", () => {
  const sched = scheduling.calculateBackwardSchedule("2026-05-22", "BEDFRAME");
  for (const row of sched) {
    assert.equal(
      row.leadDays,
      0,
      `${row.deptCode} leadDays should be 0 with no lead-time config`,
    );
  }
});

test("calculateBackwardSchedule: BEDFRAME buffer (2) lands earlier than SOFA (1)", () => {
  // Same delivery date — BEDFRAME's larger buffer means its packing end
  // (Hookka DD) is one working day earlier than SOFA's.
  const sofa = scheduling.calculateBackwardSchedule("2026-05-22", "SOFA");
  const bf = scheduling.calculateBackwardSchedule("2026-05-22", "BEDFRAME");
  const sofaPacking = sofa.find((s) => s.deptCode === "PACKING");
  const bfPacking = bf.find((s) => s.deptCode === "PACKING");
  assert.ok(
    bfPacking.endDate < sofaPacking.endDate,
    `BEDFRAME packing end (${bfPacking.endDate}) should precede SOFA (${sofaPacking.endDate})`,
  );
});

// ---------------------------------------------------------------------------
// getEarliestStart — min of all startDate strings in a schedule.
// ISO yyyy-mm-dd is lexicographically orderable, so string min == date min.
// ---------------------------------------------------------------------------
test("getEarliestStart: returns the minimum startDate of a real schedule", () => {
  const sched = scheduling.calculateBackwardSchedule("2026-05-22", "SOFA");
  const earliest = scheduling.getEarliestStart(sched);
  for (const row of sched) {
    assert.ok(
      earliest <= row.startDate,
      `earliest (${earliest}) must be <= every startDate, found ${row.startDate}`,
    );
  }
});

test("getEarliestStart: picks the lexicographically smallest date", () => {
  const fake = [
    { deptCode: "A", deptName: "A", startDate: "2026-03-15", endDate: "x", leadDays: 0 },
    { deptCode: "B", deptName: "B", startDate: "2026-01-02", endDate: "x", leadDays: 0 },
    { deptCode: "C", deptName: "C", startDate: "2026-12-31", endDate: "x", leadDays: 0 },
  ];
  assert.equal(scheduling.getEarliestStart(fake), "2026-01-02");
});

test("getEarliestStart: empty schedule returns empty string (no crash)", () => {
  // schedule[0]?.startDate || "" — the reduce seed handles the empty case.
  assert.equal(scheduling.getEarliestStart([]), "");
});

test("getEarliestStart: single-row schedule returns that row's startDate", () => {
  const one = [
    { deptCode: "X", deptName: "X", startDate: "2026-07-04", endDate: "x", leadDays: 0 },
  ];
  assert.equal(scheduling.getEarliestStart(one), "2026-07-04");
});

// ---------------------------------------------------------------------------
// DEPT_COLORS — static map. Light sanity only: confirm the 8 department
// codes each have a colour, since the Gantt UI keys off these and a missing
// entry renders an undefined fill.
// ---------------------------------------------------------------------------
test("DEPT_COLORS: every scheduled department has a hex colour", () => {
  for (const code of [
    "FAB_CUT",
    "FAB_SEW",
    "WOOD_CUT",
    "FOAM",
    "FRAMING",
    "WEBBING",
    "UPHOLSTERY",
    "PACKING",
  ]) {
    assert.match(
      scheduling.DEPT_COLORS[code] ?? "",
      /^#[0-9A-Fa-f]{6}$/,
      `DEPT_COLORS[${code}] should be a hex colour`,
    );
  }
});
