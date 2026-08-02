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
  assert.match(drawer, /if \(Object\.keys\(body\)\.length === 0\)/);
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
  assert.match(page.slice(at, at + 1400), /invalidateCachePrefix\("\/api\/org-chart"\)/);
});
