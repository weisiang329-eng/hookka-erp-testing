// ---------------------------------------------------------------------------
// job-card-stations.test.mjs — the relationship map shows one tile per
// DEPARTMENT, not one per job card.
//
// Owner 2026-08-02, looking at a real SO on prod:
//   「这个我哪里有那么多production呢 就分成8个部门就行了啊？」
//   「然后为什么show fab cut呢？」
//   「这个UI 太软了 你整合一下」
//
// SO-2607-189-01 drew ~19 tiles: Fabric Sewing ×4, Wood Cutting ×3, Framing ×4,
// Webbing ×4, Foam Bonding ×3 … because job cards are raised per COMPONENT. The
// department is the unit that means something on a chain map.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  groupJobCardsByDept,
  prettyDept,
} from "../src/lib/job-card-stations.ts";

const jc = (o) => ({ id: o.id ?? Math.random().toString(36), ...o });

test("one station per department, in route order", () => {
  const out = groupJobCardsByDept([
    jc({ departmentCode: "FAB_SEW", departmentName: "Fabric Sewing", sequence: 2, status: "COMPLETED" }),
    jc({ departmentCode: "FAB_SEW", departmentName: "Fabric Sewing", sequence: 3, status: "COMPLETED" }),
    jc({ departmentCode: "FAB_SEW", departmentName: "Fabric Sewing", sequence: 4, status: "COMPLETED" }),
    jc({ departmentCode: "FAB_CUT", departmentName: "Fabric Cutting", sequence: 1, status: "COMPLETED" }),
    jc({ departmentCode: "WOOD_CUT", departmentName: "Wood Cutting", sequence: 5, status: "WAITING" }),
  ]);
  assert.deepEqual(
    out.map((s) => s.name),
    ["Fabric Cutting", "Fabric Sewing", "Wood Cutting"],
    "5 cards over 3 departments must draw 3 tiles, ordered by earliest sequence",
  );
  assert.equal(out[1].total, 3);
  assert.equal(out[1].done, 3);
});

test("a part-finished department is NOT green", () => {
  // 「好了就亮灯」 — the lamp must mean the whole department is through.
  const [s] = groupJobCardsByDept([
    jc({ departmentCode: "FRAMING", sequence: 1, status: "COMPLETED" }),
    jc({ departmentCode: "FRAMING", sequence: 1, status: "WAITING" }),
  ]);
  assert.equal(s.state, "current", "3-of-4 done must read as in progress, not done");
  assert.equal(s.done, 1);
  assert.equal(s.total, 2);
});

test("all done is green; none started is grey", () => {
  const [done] = groupJobCardsByDept([
    jc({ departmentCode: "PACKING", status: "COMPLETED" }),
    jc({ departmentCode: "PACKING", status: "TRANSFERRED" }),
  ]);
  assert.equal(done.state, "linked");
  const [waiting] = groupJobCardsByDept([
    jc({ departmentCode: "PACKING", status: "WAITING" }),
    jc({ departmentCode: "PACKING", status: null }),
  ]);
  assert.equal(waiting.state, "pending");
});

test("an in-progress card wins over its finished siblings", () => {
  const [s] = groupJobCardsByDept([
    jc({ departmentCode: "UPH", status: "COMPLETED" }),
    jc({ departmentCode: "UPH", status: "IN_PROGRESS" }),
  ]);
  assert.equal(s.state, "current");
});

test("the roll-up aggregates dates, people and minutes without losing any", () => {
  const [s] = groupJobCardsByDept([
    jc({
      departmentCode: "WEBBING",
      status: "COMPLETED",
      completedDate: "2026-07-23",
      pic1Name: "TUN TUN NAING",
      estMinutes: 40,
      actualMinutes: 45,
    }),
    jc({
      departmentCode: "WEBBING",
      status: "COMPLETED",
      completedDate: "2026-07-31",
      pic1Name: "TUN TUN NAING",
      pic2Name: "MIN KO KO",
      estMinutes: 18,
      actualMinutes: 10,
    }),
  ]);
  assert.equal(s.completedDate, "2026-07-31", "the station finishes with its LAST card");
  assert.deepEqual(s.who, ["TUN TUN NAING", "MIN KO KO"], "names de-duplicated, order kept");
  assert.equal(s.estMinutes, 58);
  assert.equal(s.actualMinutes, 55);
});

test("no job cards means no stations (the caller renders its own empty state)", () => {
  assert.deepEqual(groupJobCardsByDept([]), []);
});

test("a department code is never shown raw", () => {
  assert.equal(prettyDept("WOOD_CUT"), "Wood Cut");
  assert.equal(prettyDept("FAB_CUT"), "Fab Cut");
  // No departmentName on the card → the code must still be humanised.
  const [s] = groupJobCardsByDept([jc({ departmentCode: "FOAM_BOND", status: "WAITING" })]);
  assert.equal(s.name, "Foam Bond");
});

test("the map renders stations, not raw job cards", () => {
  const src = readFileSync("src/components/ui/document-chain-map.tsx", "utf8");
  assert.match(src, /groupJobCardsByDept\(/, "the map must use the roll-up");
  assert.doesNotMatch(
    src,
    /\{cards\.map\(\(jc\)/,
    "the per-job-card strip that drew ~19 tiles must not return",
  );
  // Owner: 「为什么show fab cut呢」 — the PO header must not print the raw code.
  assert.match(
    src,
    /prettyDept\(po\.currentDepartment\)/,
    "the current-department tag must be humanised",
  );
});
