import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHistIdentityRemap } from "../src/lib/pnl-hist-remap.ts";

const COA = [
  { code: "701-0010", name: "PURCHASE - B.M FABRIC", type: "COST" },
  { code: "705-0020", name: "PURCHASE - PACKAGING", type: "COST" },
  { code: "780-0030", name: "UPKEEP OF FACTORY", type: "COST" },
  { code: "780-0060", name: "FACTORY GENERAL REQUISITE", type: "COST" },
  { code: "780-0010", name: "FACTORY RENTAL", type: "COST" },
  { code: "900-B001", name: "BANK CHARGES", type: "EXPENSE" },
  { code: "900-T001", name: "TRAVELLING EXPENSES", type: "EXPENSE" },
  { code: "900-S010", name: "STAFF'S HRDF", type: "EXPENSE" },
  { code: "500-0020", name: "SALES - SOFA", type: "REVENUE" },
];

test("rm groups: exact + alias matches adopt the purchase account; unknown stays", () => {
  const w = {
    rmGroups: [
      { group: "B.M Fabric", description: "B.M Fabric" },
      { group: "Packing", description: "Packing" },
      { group: "Mystery Goo", description: "Mystery Goo" },
      { group: "701-0010", description: "PURCHASE - B.M FABRIC" }, // engine era, untouched
    ],
  };
  const n = buildHistIdentityRemap(COA).remapWindow(w);
  assert.equal(n, 2);
  assert.deepEqual(w.rmGroups[0], { group: "701-0010", description: "PURCHASE - B.M FABRIC" });
  assert.deepEqual(w.rmGroups[1], { group: "705-0020", description: "PURCHASE - PACKAGING" });
  assert.equal(w.rmGroups[2].group, "Mystery Goo");
  assert.equal(w.rmGroups[3].group, "701-0010");
});

test("lines: normalized-name match rewrites code+name to the COA byte-exact", () => {
  const w = {
    expenseLines: [
      { code: "900", name: "Bank Charges" },
      { code: "900", name: "Travelling Expense" }, // alias (singular)
      { code: "900", name: "Staff's HRDF" },
      { code: "900", name: "Old-Company Only Thing" },
    ],
  };
  const n = buildHistIdentityRemap(COA).remapWindow(w);
  assert.equal(n, 3);
  assert.deepEqual(w.expenseLines[0], { code: "900-B001", name: "BANK CHARGES" });
  assert.deepEqual(w.expenseLines[1], { code: "900-T001", name: "TRAVELLING EXPENSES" });
  assert.deepEqual(w.expenseLines[2], { code: "900-S010", name: "STAFF'S HRDF" });
  assert.deepEqual(w.expenseLines[3], { code: "900", name: "Old-Company Only Thing" });
});

test("type gate: an expense line never adopts a COST account identity", () => {
  const w = { expenseLines: [{ code: "900", name: "Factory - Rental" }] }; // = FACTORY RENTAL (COST)
  const n = buildHistIdentityRemap(COA).remapWindow(w);
  assert.equal(n, 0);
  assert.equal(w.expenseLines[0].code, "900");
});

test("overhead lines match COST accounts incl. spelling alias", () => {
  const w = {
    overheadLines: [
      { code: "780", name: "Upkeep of Factory" },
      { code: "780", name: "Factory General Requistion" }, // historical typo
    ],
  };
  const n = buildHistIdentityRemap(COA).remapWindow(w);
  assert.equal(n, 2);
  assert.equal(w.overheadLines[0].code, "780-0030");
  assert.equal(w.overheadLines[1].code, "780-0060");
});

test("ambiguous normalized names are never remapped", () => {
  const coa = [
    ...COA,
    { code: "999-0001", name: "BANK  CHARGES", type: "EXPENSE" }, // normalizes same as 900-B001
  ];
  const w = { expenseLines: [{ code: "900", name: "Bank Charges" }] };
  const n = buildHistIdentityRemap(coa).remapWindow(w);
  assert.equal(n, 0);
  assert.equal(w.expenseLines[0].code, "900");
});

test("already-canonical line is a no-op (count stays 0)", () => {
  const w = { expenseLines: [{ code: "900-B001", name: "BANK CHARGES" }] };
  assert.equal(buildHistIdentityRemap(COA).remapWindow(w), 0);
});

test("rm groups: AutoCount stock-group CODES resolve via the posting map", () => {
  const coa = [
    { code: "701-0010", name: "PURCHASE - B.M FABRIC", type: "COST" },
    { code: "704-0030", name: "PURCHASE - MAINTENANCE", type: "COST" },
    { code: "704-0050", name: "PURCHASE - B.WEBBING", type: "COST" },
    { code: "900-R002", name: "RESEARCH & DEVELOPMENT", type: "EXPENSE" },
  ];
  const groupAcct = {
    "B.M-FABR": "701-0010",
    MAINTENA: "704-0030",
    "B.WEBB": "704-0050",
    "R&D": "900-R002", // EXPENSE target → must NOT remap an rm row
  };
  const w = {
    rmGroups: [
      { group: "B.M-FABR", description: "B.M Fabric" },
      { group: "MAINTENA", description: "Maintenance" },
      { group: "B.WEBB", description: "B.Webbing" },
      { group: "R&D", description: "R&D" },
    ],
  };
  const n = buildHistIdentityRemap(coa, groupAcct).remapWindow(w);
  assert.equal(n, 3);
  assert.deepEqual(w.rmGroups[0], { group: "701-0010", description: "PURCHASE - B.M FABRIC" });
  assert.deepEqual(w.rmGroups[1], { group: "704-0030", description: "PURCHASE - MAINTENANCE" });
  assert.deepEqual(w.rmGroups[2], { group: "704-0050", description: "PURCHASE - B.WEBBING" });
  assert.equal(w.rmGroups[3].group, "R&D");
});

test("rm groups: name-suffix match still wins when both indexes could apply", () => {
  const coa = [{ code: "702-0010", name: "PURCHASE - PLYWOOD", type: "COST" }];
  const w = { rmGroups: [{ group: "PLYWOOD", description: "Plywood" }] };
  const n = buildHistIdentityRemap(coa, { PLYWOOD: "702-0010" }).remapWindow(w);
  assert.equal(n, 1);
  assert.equal(w.rmGroups[0].group, "702-0010");
});

test("owner-approved E'yer → STAFFS' merges (2026-07-03)", () => {
  const coa = [
    { code: "900-S002", name: "STAFFS' SALARIES", type: "EXPENSE" },
    { code: "900-S004", name: "STAFFS' SOCSO", type: "EXPENSE" },
    { code: "900-S005", name: "STAFFS' EPF", type: "EXPENSE" },
    { code: "900-S009", name: "STAFFS' EIS", type: "EXPENSE" },
  ];
  const w = {
    expenseLines: [
      { code: "900", name: "E'yer SOCSO" },
      { code: "900", name: "E'yerEPF" },
      { code: "900", name: "E'yer EIS" },
      { code: "900", name: "Staff Salaries & Overtime" },
    ],
  };
  const n = buildHistIdentityRemap(coa).remapWindow(w);
  assert.equal(n, 4);
  assert.deepEqual(w.expenseLines.map((l) => l.code), ["900-S004", "900-S005", "900-S009", "900-S002"]);
  assert.deepEqual(w.expenseLines.map((l) => l.name), ["STAFFS' SOCSO", "STAFFS' EPF", "STAFFS' EIS", "STAFFS' SALARIES"]);
});
