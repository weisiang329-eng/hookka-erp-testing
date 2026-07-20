import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const schemas = await import(
  pathToFileURL(resolve("src/lib/schemas/user-admin.ts")).href
);
const passwordPolicy = await import(
  pathToFileURL(resolve("src/api/lib/password-strength.ts")).href
);

const {
  AcceptInviteRequestSchema,
  AdminCreateUserRequestSchema,
  AdminResetPasswordRequestSchema,
  AdminUpdateUserRequestSchema,
  InviteUserRequestSchema,
} = schemas;
const { validatePasswordStrength } = passwordPolicy;

test("admin update accepts the supported partial FE payloads", () => {
  assert.equal(
    AdminUpdateUserRequestSchema.safeParse({ isActive: false }).success,
    true,
  );
  assert.equal(
    AdminUpdateUserRequestSchema.safeParse({ role: "READ_ONLY" }).success,
    true,
  );
  assert.equal(
    AdminUpdateUserRequestSchema.safeParse({
      department: "Production",
      position: "Supervisor",
      reportsTo: "user-manager",
    }).success,
    true,
  );
});

test("admin update rejects truthy strings, empty writes, and unknown fields", () => {
  assert.equal(
    AdminUpdateUserRequestSchema.safeParse({ isActive: "false" }).success,
    false,
    "a string false must never enable an account through truthiness",
  );
  assert.equal(AdminUpdateUserRequestSchema.safeParse({}).success, false);
  assert.equal(
    AdminUpdateUserRequestSchema.safeParse({ passwordHash: "injected" })
      .success,
    false,
  );
});

test("create and invite reject malformed emails and unknown roles", () => {
  assert.equal(
    AdminCreateUserRequestSchema.safeParse({
      email: "not-an-email",
      password: "Strong-Enough-2026!",
    }).success,
    false,
  );
  assert.equal(
    InviteUserRequestSchema.safeParse({
      email: "new.user@example.com",
      role: "SUPER_ADMlN",
    }).success,
    false,
  );
});

test("reset and invite acceptance use bounded strict request contracts", () => {
  assert.equal(
    AdminResetPasswordRequestSchema.safeParse({
      newPassword: "Strong-Enough-2026!",
      userId: "someone-else",
    }).success,
    false,
  );
  assert.equal(
    AcceptInviteRequestSchema.safeParse({
      token: "invite-token",
      password: "Strong-Enough-2026!",
      displayName: "New User",
    }).success,
    true,
  );
});

test("all alternate account password writes call the canonical policy", () => {
  const usersRoute = readFileSync(resolve("src/api/routes/users.ts"), "utf8");
  const authRoute = readFileSync(resolve("src/api/routes/auth.ts"), "utf8");

  assert.match(usersRoute, /AdminCreateUserRequestSchema\.safeParse/);
  assert.match(usersRoute, /AdminResetPasswordRequestSchema\.safeParse/);
  assert.match(usersRoute, /validatePasswordStrength\(password, email\)/);
  assert.match(
    usersRoute,
    /validatePasswordStrength\(newPassword, existing\.email\)/,
  );
  assert.match(authRoute, /AcceptInviteRequestSchema\.safeParse/);
  assert.match(authRoute, /validatePasswordStrength\(password, invite\.email\)/);
  assert.doesNotMatch(usersRoute, /password\.length\s*<\s*6/);
  assert.doesNotMatch(authRoute, /password\.length\s*<\s*6/);

  assert.equal(validatePasswordStrength("hookka").ok, false);
});

test("permission navigation and backend authorization share users.role", () => {
  const authRoute = readFileSync(resolve("src/api/routes/auth.ts"), "utf8");
  const permissionsHandler = authRoute.slice(
    authRoute.indexOf('app.get("/me/permissions"'),
    authRoute.indexOf("// ----- POST /api/auth/change-password"),
  );

  assert.match(permissionsHandler, /SELECT u\.role AS role/);
  assert.match(permissionsHandler, /WHERE r\.name = \?/);
  assert.match(
    permissionsHandler,
    /roleName === "SUPER_ADMIN" \|\| roleName === "ADMIN"/,
  );
  assert.doesNotMatch(permissionsHandler, /u\.roleId/);
});

test("both password-setting screens use the same client-side policy", () => {
  const adminPage = readFileSync(
    resolve("src/pages/settings/Users.tsx"),
    "utf8",
  );
  const invitePage = readFileSync(resolve("src/pages/InviteAccept.tsx"), "utf8");

  assert.match(adminPage, /validatePasswordStrength\(/);
  assert.match(invitePage, /validatePasswordStrength\(/);
  assert.match(adminPage, /<PasswordStrengthMeter/);
  assert.match(invitePage, /<PasswordStrengthMeter/);
  assert.doesNotMatch(adminPage, /at least 6 characters/i);
  assert.doesNotMatch(invitePage, /at least 6 characters/i);
});
