// ---------------------------------------------------------------------------
// admin-creates-user.test.mjs — an admin can create a working account and hand
// over the credential, and the first login makes it the person's own.
//
// Owner 2026-08-02:「我给他们密码、账号,他们都可以直接登录进来,然后用的是我们的
// email,这样子他就不会影响到他自己的 email」.
//
// A normal way to run an ERP on company mailboxes: no personal Gmail needed,
// the account and the mailbox stay with the company when someone leaves, and
// nobody waits on an email that may land in spam.
//
// It is safe exactly as long as the first login forces a change. Until then the
// ADMIN knows the password too, so nothing the account does can be attributed
// to the person — the admin could equally have done it.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const users = readFileSync("src/api/routes/users.ts", "utf8");
const auth = readFileSync("src/api/routes/auth.ts", "utf8");
const drawer = readFileSync("src/components/add-user-drawer.tsx", "utf8");
const page = readFileSync("src/pages/settings/Users.tsx", "utf8");

test("creating an account still requires a password, and a real one", () => {
  assert.match(users, /email and password are required/);
  assert.match(users, /password must be at least 6 characters/);
  // The drawer refuses before the round trip too, so the operator is told early.
  assert.match(drawer, /password\.length >= 6/);
});

test("must_change_password defaults ON — opting out has to be explicit", () => {
  assert.match(users, /ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(users, /mustChangePassword === false \? false : true/);
  assert.match(drawer, /useState\(true\)/, "the tick starts on");
});

test("the flag reaches the app, and changing the password clears it", () => {
  assert.match(auth, /mustChangePassword: mustChange === true \|\| mustChange === 1/);
  assert.match(auth, /u\.mustChangePassword \?\? u\.must_change_password/, "dual-keyed");
  assert.match(auth, /UPDATE users SET must_change_password = FALSE WHERE id = \?/);
});

test("clearing the flag can NEVER block a password change", () => {
  // The column is created by the users route, so on a cold isolate where nobody
  // has opened User Management it may not exist yet. A password rotation must
  // not be blocked by a column that only controls a prompt.
  const at = auth.indexOf("UPDATE users SET must_change_password");
  const before = auth.slice(Math.max(0, at - 700), at);
  assert.match(before, /UPDATE users SET passwordHash = \? WHERE id = \?/, "password first");
  assert.match(auth.slice(at - 200, at + 400), /try \{/);
});

test("department and position are set at creation, not in a second step", () => {
  // Otherwise a new person sits in Unassigned until somebody remembers.
  assert.match(users, /displayName, department, position, must_change_password\)/);
  assert.match(drawer, /department,\s*\n\s*position: position\.trim\(\)/);
});

test("the password is never generated, stored or echoed", () => {
  // It is typed by the operator and posted. Nothing else.
  assert.doesNotMatch(drawer, /Math\.random|crypto\.randomUUID|generatePassword/);
  assert.doesNotMatch(drawer, /localStorage|sessionStorage/);
  // Cleared from the form the moment the account exists.
  assert.match(drawer, /setPassword\(""\);/);
});

test("only a SUPER_ADMIN can mint an account, and the invite flow stays", () => {
  const at = users.indexOf('requirePermission(c, "users", "create")');
  assert.ok(at > 0);
  assert.match(users.slice(at, at + 400), /requireSuperAdmin\(c\)/);
  // Both routes remain — an invite is still right for someone with their own
  // company mailbox who can accept for themselves.
  assert.match(users, /app\.post\("\/invite"/);
  assert.match(page, /<AddUserDrawer/);
});
