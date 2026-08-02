// ---------------------------------------------------------------------------
// user-drawer-wired.test.mjs — the side panel is actually reachable.
//
// Owner 2026-08-02:「我要做到像 employee master 这样子,在旁边去做 maintenance,
// 去 add、去 save…全部功能应该都要有:删除、disable、edit」.
//
// The drawer edits the USER row. The modal it replaces wrote Department and
// Position to the @hookka.com ALIAS, which meant two things: the grid and the
// org chart (both of which read the user row) showed "—", and the seven
// accounts with no mailbox could not be given a department AT ALL.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/pages/settings/Users.tsx", "utf8");
const drawer = readFileSync("src/components/user-detail-drawer.tsx", "utf8");

test("the row's edit action opens the drawer, not the alias modal", () => {
  assert.match(page, /setDrawerUser\(u\);/);
  assert.match(page, /<UserDetailDrawer/);
});

test("it edits the USER row — no mailbox required", () => {
  assert.match(drawer, /`\/api\/users\/\$\{encodeURIComponent\(user\.id\)\}`/);
  assert.doesNotMatch(drawer, /mail-center\/addresses/);
});

test("Save sends only what CHANGED", () => {
  // A department edit must never silently rewrite a role.
  assert.match(drawer, /if \(displayName !== user\.displayName\)/);
  assert.match(drawer, /if \(role !== user\.role\) body\.role = role;/);
  assert.match(drawer, /if \(Object\.keys\(body\)\.length === 0 && !uplineChanged\)/);
});

test("every action the owner listed is there", () => {
  // JSX puts these next to their icon, so match the word, not a tag boundary.
  for (const w of ["Disable", "Enable", "Delete", "Saving…"]) {
    assert.ok(drawer.includes(w), w);
  }
  assert.match(drawer, /<Save className="h-4 w-4" \/>/);
});

test("you cannot lock yourself out, and delete asks by name", () => {
  assert.match(drawer, /const isSelf = user\.id === currentUserId;/);
  assert.match(drawer, /\{!isSelf && \(/);
  assert.match(drawer, /Delete <strong>\{user\.displayName \|\| user\.email\}<\/strong>\?/);
  assert.match(drawer, /This cannot be undone/);
});

test("the server's wording wins on a refusal", () => {
  // "You can't disable the last active Super Admin" is actionable in a way
  // "Save failed" is not.
  assert.match(drawer, /setError\(j\.error \|\| `Save failed \(HTTP \$\{res\.status\}\)`\)/);
});

test("saving busts the org-chart cache", () => {
  // The chart groups on department; it must not serve the old one all session.
  const at = page.indexOf("<UserDetailDrawer");
  assert.match(page.slice(at, at + 2500), /invalidateCachePrefix\("\/api\/org-chart"\)/);
});

// --- the reporting line reads and writes the REAL edge ----------------------

test("the drawer shows the reporting line the CHART draws, not the legacy column", () => {
  // users.reports_to is blank for everyone whose line was set through the org
  // chart — the edges live in org_reporting, keyed (source, id) so they can
  // cross `users` and `workers`. Seeding from the column made the drawer say
  // "no manager (top)" for people the chart draws a line for.
  assert.match(drawer, /useState\(currentManagerKey \?\? ""\)/);
  assert.match(page, /currentManagerKey=\{/);
  assert.match(page, /orgPeople\.find\(\(p\) => p\.key === `user:\$\{drawerUser\.id\}`\)\?\.managerKey/);
});

test("saving the upline writes org_reporting, not users.reports_to", () => {
  assert.match(drawer, /"\/api\/org-chart\/reporting"/);
  assert.match(drawer, /personKey: `user:\$\{user\.id\}`/);
  // The server's loop message is the useful sentence.
  assert.match(drawer, /Could not save the reporting line/);
});

test("the upline list includes the factory floor", () => {
  // A reporting line is allowed to cross the two tables; offering office
  // accounts only would make half the company unpickable.
  assert.match(page, /uplineOptions=\{orgPeople/);
  assert.doesNotMatch(page, /uplineOptions=\{activeUsers/);
});

test("switching person REMOUNTS the drawer instead of setState-ing in an effect", () => {
  // The re-seed effect was a cascading render. A key is the fix; suppressing
  // the rule is not.
  assert.match(page, /<UserDetailDrawer\n\s*key=\{drawerUser\.id\}/);
  assert.doesNotMatch(drawer, /useEffect/);
});

test("the flat table under the chart is gone, and nothing dead was left behind", () => {
  assert.doesNotMatch(page, /\{orgRows\.map\(/);
  // Code only — one comment still NAMES POSITIONS_BY_DEPARTMENT as the Houzs
  // file it was mirrored from, and that reference is worth keeping.
  const code = page
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  for (const dead of [
    "DeptBadge",
    "DEPT_BADGE_CLASSES",
    "POSITIONS_BY_DEPARTMENT",
    "uplineCandidates",
    "effectiveDept",
    "deptOrderIndex",
  ]) {
    assert.ok(!code.includes(dead), `${dead} should have gone with the table`);
  }
});
