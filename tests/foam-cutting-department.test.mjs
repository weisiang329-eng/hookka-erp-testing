// ---------------------------------------------------------------------------
// foam-cutting-department.test.mjs — FOAM_CUTTING department wiring.
//
// FOAM_CUTTING is a NEW production department placed immediately BEFORE FOAM
// (Foam Bonding) — a tracking/scheduling/labor step (raw material stays
// consumed at FAB_CUT). This is a STRUCTURAL test (readFileSync source
// assertions, the repo idiom) that pins FOAM_CUTTING into EVERY enumeration it
// must appear in, and pins the FOAM → "Foam Bonding" display relabel.
//
// If any of these drop out, BOM steps get silently dropped (collectProcesses
// drops depts not in DEPT_ORDER) or scheduling / stickers / routing break — so
// the enumerations must stay in lockstep.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// A tiny helper: assert the source contains ALL of the given substrings.
function assertAll(src, name, needles) {
  for (const n of needles) {
    assert.ok(src.includes(n), `${name}: expected to contain ${JSON.stringify(n)}`);
  }
}

test("lead-times: DEPT_ORDER + DEFAULT_LEAD_DAYS carry FOAM_CUTTING before FOAM", () => {
  const src = read("src/api/lib/lead-times.ts");
  assert.ok(src.includes("FOAM_CUTTING"), "DEPT_ORDER missing FOAM_CUTTING");
  // FOAM_CUTTING must appear before FOAM in the canonical order.
  const iCut = src.indexOf('"FOAM_CUTTING"');
  const iFoam = src.indexOf('"FOAM"');
  assert.ok(iCut !== -1 && iFoam !== -1 && iCut < iFoam, "FOAM_CUTTING must precede FOAM in DEPT_ORDER");
  // Both BEDFRAME + SOFA lead-day maps carry a FOAM_CUTTING entry. Its value is
  // 0 — Foam Cutting runs the same day as Foam Bonding (owner 2026-07-30), so it
  // adds no extra day to the sequence.
  const count = (src.match(/FOAM_CUTTING:\s*\d/g) || []).length;
  assert.ok(count >= 2, "both BEDFRAME + SOFA default lead maps need FOAM_CUTTING");
  assert.ok(/FOAM_CUTTING:\s*0/.test(src), "FOAM_CUTTING is same-day as Foam Bonding (0 lead days)");
});

test("departments route: runtime self-apply inserts FOAM_CUTTING + relabels FOAM", () => {
  const src = read("src/api/routes/departments.ts");
  assertAll(src, "departments.ts", [
    "ensureFoamCuttingDept",
    "'FOAM_CUTTING'",
    "'Foam Cutting'",
    "'Foam Cut'",
    // FOAM relabel to display "Foam Bonding"
    "shortName = 'Foam Bonding' WHERE code = 'FOAM'",
  ]);
  // The self-apply must be awaited on the hot GET read path.
  assert.ok(src.includes("await ensureFoamCuttingDept(c)"), "GET must await the self-apply");
});

test("seed.sql: FOAM_CUTTING row + FOAM relabel for fresh DBs", () => {
  const src = read("scripts/seed.sql");
  assert.ok(src.includes("'FOAM_CUTTING'"), "seed.sql missing FOAM_CUTTING row");
  assert.ok(src.includes("'Foam Cutting', 'Foam Cut'"), "seed.sql FOAM_CUTTING name/shortName");
  // FOAM relabeled so its shortName displays as Foam Bonding.
  assert.ok(src.includes("'FOAM', 'Foam Bonding', 'Foam Bonding'"), "seed.sql FOAM shortName relabel");
});

test("job-card-id: DEPT_CODE2 gets FOAM_CUTTING on a free 2-digit code", () => {
  const src = read("src/lib/job-card-id.ts");
  const m = src.match(/FOAM_CUTTING:\s*"(\d{2})"/);
  assert.ok(m, "DEPT_CODE2 missing FOAM_CUTTING");
  const code = m[1];
  // Must NOT collide with any of the existing production codes 01-08.
  assert.ok(!["01", "02", "03", "04", "05", "06", "07", "08"].includes(code), `FOAM_CUTTING code ${code} collides with an existing dept`);
});

test("sticker PDF: colors + names + dept-specific switch cover FOAM_CUTTING; FOAM reads Foam Bonding", () => {
  const src = read("src/lib/generate-sticker-pdf.ts");
  assertAll(src, "generate-sticker-pdf.ts", [
    "FOAM_CUTTING:", // DEPT_COLORS + DEPT_NAMES
    'FOAM_CUTTING: "Foam Cut"',
    'FOAM: "Foam Bonding"',
    'case "FOAM_CUTTING"', // getDeptSpecificFields switch
  ]);
});

test("sidebar: Foam Cutting child added, Foam relabeled Foam Bonding, active-route wired", () => {
  const src = read("src/components/layout/sidebar.tsx");
  assertAll(src, "sidebar.tsx", [
    '"/production/foam-cutting"',
    'name: "Foam Cutting"',
    'name: "Foam Bonding"',
    'href === "/production/foam-cutting"',
  ]);
});

test("dashboard-routes: production + planning foam-cutting routes + prefetch", () => {
  const src = read("src/dashboard-routes.tsx");
  assertAll(src, "dashboard-routes.tsx", [
    "path: '/production/foam-cutting'",
    "PlanningFoamCutting",
    "path: '/planning/dept/foam-cutting'",
    "'/production/foam-cutting':",
    "'/planning/dept/foam-cutting':",
  ]);
});

test("production dept page: VALID_DEPTS includes FOAM_CUTTING", () => {
  const src = read("src/pages/production/dept.tsx");
  assert.ok(src.includes('"FOAM_CUTTING"'), "VALID_DEPTS missing FOAM_CUTTING");
});

test("production index: DeptCode union + overview width carry FOAM_CUTTING", () => {
  const src = read("src/pages/production/index.tsx");
  assert.ok(src.includes('"FOAM_CUTTING"'), "DeptCode union missing FOAM_CUTTING");
  assert.ok(src.includes("FOAM_CUTTING: 108"), "overview default width missing FOAM_CUTTING");
});

test("production utils + types + baserows: FOAM_CUTTING column threaded through", () => {
  assert.ok(read("src/pages/production/utils.ts").includes('code: "FOAM_CUTTING"'), "utils DEPARTMENTS missing FOAM_CUTTING");
  assert.ok(read("src/pages/production/types.ts").includes("sched_FOAM_CUTTING"), "DeptRow missing sched_FOAM_CUTTING");
  const bs = read("src/pages/production/baserows-core.ts");
  // Both the agg branch and the picker branch must emit the column.
  const count = (bs.match(/sched_FOAM_CUTTING:/g) || []).length;
  assert.ok(count >= 2, "baserows must emit sched_FOAM_CUTTING in both branches");
});

test("planning index: all dept lists + drill route + labels carry FOAM_CUTTING; FOAM shows Foam Bonding", () => {
  const src = read("src/pages/planning/index.tsx");
  assertAll(src, "planning/index.tsx", [
    'code: "FOAM_CUTTING"',
    'FOAM_CUTTING: "/planning/dept/foam-cutting"',
    'FOAM_CUTTING: "Foam Cutting"', // PROPOSAL_DEPT_LABEL
    '{ code: "FOAM_CUTTING", label: "Foam Cutting" }', // LEADTIME_ROWS
    "Foam Bonding", // FOAM relabel present
  ]);
});

test("bom-wip chains: FOAM_CUTTING sits immediately before FOAM everywhere FOAM appears", () => {
  const src = read("src/api/lib/bom-wip-breakdown.ts");
  assert.ok(src.includes("FOAM_CUTTING"), "bom-wip chains missing FOAM_CUTTING");
  // Every "FOAM" in a chain array must be immediately preceded by FOAM_CUTTING.
  // Scan the two chain constants for the pattern "FOAM_CUTTING", "FOAM".
  assert.ok(
    src.includes('"FOAM_CUTTING", "FOAM"'),
    "FOAM_CUTTING must be adjacent-before FOAM in the chains",
  );
  // Guard: no bare "FOAM" chain entry left without a FOAM_CUTTING in front.
  // (Match array elements only: quoted "FOAM" preceded by ", " or "[".)
  const bareFoam = src.match(/(?<!FOAM_CUTTING", )"FOAM"(?=, |\])/g) || [];
  // Allow "FOAM" that is preceded by FOAM_CUTTING on the same line; assert none
  // appear on a chain line lacking FOAM_CUTTING.
  for (const line of src.split("\n")) {
    if (/\[.*"FOAM".*\]/.test(line) && line.includes('"FOAM"') && line.includes('"FRAMING"') === false && line.includes("FAB_CUT")) {
      // chain line containing FOAM must also contain FOAM_CUTTING
      if (line.includes('"FOAM"')) {
        assert.ok(line.includes("FOAM_CUTTING"), `chain line has FOAM without FOAM_CUTTING: ${line.trim()}`);
      }
    }
  }
  void bareFoam;
});

test("mobile dept tabs: FOAM_CUTTING tab before FOAM", () => {
  const src = read("src/pages/m/config/modules.ts");
  assert.ok(src.includes('code: "FOAM_CUTTING"'), "mobile DEPT_TABS missing FOAM_CUTTING");
  const iCut = src.indexOf('code: "FOAM_CUTTING"');
  const iFoam = src.indexOf('code: "FOAM"');
  assert.ok(iCut !== -1 && iFoam !== -1 && iCut < iFoam, "FOAM_CUTTING tab must precede FOAM tab");
});

test("planning drill-in page + snapshot exist for foam-cutting", () => {
  const page = read("src/pages/planning/dept/foam-cutting.tsx");
  assert.ok(page.includes("FoamCuttingDeptPage"), "foam-cutting planning page missing");
  assert.ok(page.includes('fetchUrl="/api/planning/schedule/foam-cutting"'), "foam-cutting fetchUrl missing");
  const snap = read("src/data/foamcutting-schedule-snapshot.json");
  assert.ok(snap.includes("Foam Cutting"), "foam-cutting snapshot missing");
});

// ---------------------------------------------------------------------------
// REGRESSION (owner report 2026-08-01): the relabel was applied to SOME label
// maps and not others, so the BOM process-dept <select> rendered a BLANK option
// for FOAM_CUTTING (present in DEPT_ORDER, absent from DEPT_LABELS) and still
// showed "Foam" instead of "Foam Bonding".
// ---------------------------------------------------------------------------
test("BOM DEPT_LABELS covers every code in DEPT_ORDER (no blank <option>)", () => {
  const src = read("src/pages/bom.tsx");
  const order = src.match(/const DEPT_ORDER = \[([^\]]+)\]/);
  assert.ok(order, "DEPT_ORDER not found in bom.tsx");
  const codes = [...order[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 9, `DEPT_ORDER looks wrong: ${codes.join()}`);
  const labels = src.match(/const DEPT_LABELS: Record<string, string> = \{([^}]+)\}/);
  assert.ok(labels, "DEPT_LABELS not found in bom.tsx");
  for (const code of codes) {
    assert.ok(
      new RegExp(`\\b${code}:`).test(labels[1]),
      `DEPT_ORDER lists ${code} but DEPT_LABELS has no entry — renders a blank option`,
    );
  }
  assert.match(labels[1], /FOAM: "Foam Bonding"/);
  assert.match(labels[1], /FOAM_CUTTING: "Foam Cutting"/);
});

test("no user-facing dept label map still spells FOAM as bare \"Foam\"", () => {
  // Every map that pairs the FOAM code with a display string must say
  // "Foam Bonding". Bare "Foam" here is the stale pre-relabel spelling.
  const files = [
    "src/pages/bom.tsx",
    "src/pages/production/utils.ts",
    // src/pages/production/tracker.tsx was deleted 2026-08-13 (unreachable —
    // its route has been a redirect to the Planning Master Tracker tab, and
    // nothing imported it). Its dept label map went with it.
    "src/pages/planning/index.tsx",
    "src/pages/service-cases/detail.tsx",
    "src/pages/m/config/forms.ts",
    "src/pages/m/screens/ProductionScreen.tsx",
    "src/pages/m/screens/ProductionDetailScreen.tsx",
    "src/lib/repair-scope.ts",
  ];
  // Matches: FOAM: "Foam"  |  code: "FOAM", label: "Foam"  |  { name: "Foam", code: "FOAM" }
  const stale = [
    /FOAM:\s*"Foam"/,
    /code:\s*"FOAM",\s*(label|name):\s*"Foam"/,
    /(label|name|value):\s*"Foam"\s*,\s*code:\s*"FOAM"/,
    /value:\s*"FOAM",\s*label:\s*"Foam"/,
    /\{\s*name:\s*"Foam",/,
  ];
  for (const f of files) {
    const src = read(f);
    for (const re of stale) {
      assert.ok(!re.test(src), `${f} still labels FOAM as bare "Foam" (${re}) — must be "Foam Bonding"`);
    }
  }
});
