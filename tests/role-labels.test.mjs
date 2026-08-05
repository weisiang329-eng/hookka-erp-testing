// ---------------------------------------------------------------------------
// role-labels.test.mjs — the picker must know every role that exists.
//
// Owner 2026-08-04: "外面看到的 Role 是 CS，可是进去里面的 Role 就是 Super
// Admin，它的整个呈现方式不对… 你确定我的 backend、frontend 和 database 全部都是
// 串通的吗？"
//
// A fair question, and the answer at the time was no. The department roles were
// in the database and enforced by the API, but this list was hardcoded to three
// entries — and a `<select>` whose value is not among its options renders the
// FIRST option. So every person on a department role opened the edit panel and
// saw "Super Admin". Nothing was wrong with their data; the picker could not
// represent it.
//
// That failure is silent and it reads as a data bug, which is the worst kind.
// These tests keep the three layers in step.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ROLE_OPTIONS,
  roleShort,
  roleLabel,
  suggestedRoleForDepartment,
} from "../src/lib/role-labels.ts";
import { CODE_ROLE_POLICIES } from "../src/api/lib/role-policy.ts";
import { ORG_ROLES } from "../src/api/lib/ensure-org-roles.ts";

const values = ROLE_OPTIONS.map((o) => o.value);

test("every role the API can enforce is offered by the picker", () => {
  // Otherwise it exists, gates real routes, and cannot be assigned.
  for (const r of Object.keys(CODE_ROLE_POLICIES)) {
    assert.ok(values.includes(r), `${r} is enforced but not offered`);
  }
  for (const r of ORG_ROLES.map((x) => x.name)) {
    assert.ok(values.includes(r), `${r} is seeded but not offered`);
  }
});

test("the 0045 roles are still offered", () => {
  // Dropping one would silently blank it on the next save.
  for (const r of [
    "SUPER_ADMIN", "ADMIN", "READ_ONLY",
    "SALES", "FINANCE", "PROCUREMENT", "PRODUCTION", "WAREHOUSE", "WORKER",
  ]) {
    assert.ok(values.includes(r), `${r} must stay in the picker`);
  }
});

test("no duplicate values — a repeated option breaks the select", () => {
  assert.equal(new Set(values).size, values.length);
});

test("R_AND_D reads as R&D", () => {
  // Owner: "它的 Role R&D 为什么那么难看呢？" — the grid was printing the stored
  // identifier.
  assert.equal(roleShort("R_AND_D"), "R&D");
  assert.equal(roleShort("READ_ONLY"), "Viewer");
  assert.equal(roleShort("SUPER_ADMIN"), "Super Admin");
});

test("an unknown role still reads as words, not an identifier", () => {
  // A role added later must degrade to "Some New Role", never SOME_NEW_ROLE.
  assert.equal(roleShort("SOME_NEW_ROLE"), "Some New Role");
  assert.equal(roleShort(""), "");
});

test("roleLabel falls back to the short form rather than the raw value", () => {
  assert.equal(roleLabel("SOME_NEW_ROLE"), "Some New Role");
  assert.match(roleLabel("R_AND_D"), /R&D/);
});

test("the grid renders the label, not the stored value", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/settings/Users.tsx"), "utf8");
  const col = src.slice(src.indexOf('key: "role",'), src.indexOf('key: "isActive"'));
  assert.match(col, /roleShort\(u\.role\)/);
  assert.doesNotMatch(col, /\{u\.role\}/, "the raw identifier must not reach the screen");
});

test("a department suggests a role without applying it", () => {
  // Owner asked for role to follow department; applying it automatically would
  // hand Management the master key off a dropdown.
  assert.equal(suggestedRoleForDepartment("R&D"), "R_AND_D");
  assert.equal(suggestedRoleForDepartment("Office"), "OFFICE");
  assert.equal(suggestedRoleForDepartment("Management"), "SUPER_ADMIN");
  assert.equal(suggestedRoleForDepartment("Legal"), null);

  const src = readFileSync(resolve(process.cwd(), "src/pages/settings/Users.tsx"), "utf8");
  assert.match(src, /suggestedRoleForDepartment\(aliasDept\)/);
  assert.match(src, /onClick=\{\(\) => setEditRole\(suggested\)\}/, "must be a click, not automatic");
});

test("a role the account already holds is preserved in the picker", () => {
  // A legacy value absent from the list would otherwise be blanked on save.
  const src = readFileSync(resolve(process.cwd(), "src/pages/settings/Users.tsx"), "utf8");
  assert.match(src, /!ROLE_OPTIONS\.some\(\(o\) => o\.value === aliasForUser\.role\)/);
});
