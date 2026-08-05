// ---------------------------------------------------------------------------
// derived-permissions.test.mjs — split a sub-module's gate without taking
// anything away.
//
// Owner 2026-08-04, on Delivery Return sharing delivery-orders and Service
// Cases sharing service-orders: "要继续吗？这个是的."
//
// Those routes checked the PARENT resource, so "Delivery Order read-only but
// Delivery Return editable" was not expressible at all. Giving each its own
// resource makes it expressible — but adding a gate can only ever REMOVE
// access, and a role that has never heard of `delivery-returns` would be locked
// out of a page it uses today.
//
// So the new grant is DERIVED from the parent, action for action. Behaviour on
// the day of the change is identical by construction; the two can diverge
// afterwards, which is the point.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DERIVED_RESOURCES,
  UNIVERSAL_RESOURCES,
  ensureDerivedPermissions,
  _resetDerivedPermsMemoForTests,
} from "../src/api/lib/ensure-derived-permissions.ts";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

test("each split sub-module names the parent it inherits from", () => {
  const byChild = Object.fromEntries(DERIVED_RESOURCES.map((d) => [d.child, d.parent]));
  assert.equal(byChild["delivery-returns"], "delivery-orders");
  assert.equal(byChild["service-cases"], "service-orders");
  assert.equal(byChild["purchase-returns"], "purchase-orders");
});

test("the routes now gate on their OWN resource", () => {
  // Before this they checked the parent, so they could not be controlled apart.
  assert.match(read("src/api/routes/delivery-returns.ts"), /requirePermission\(c, "delivery-returns"/);
  assert.match(read("src/api/routes/service-cases.ts"), /requirePermission\(c, "service-cases"/);
  assert.match(read("src/api/routes/purchase-returns.ts"), /requirePermission\(c, "purchase-returns"/);
});

test("no split route still checks its old parent", () => {
  // A leftover parent check would make the split silently pointless.
  assert.doesNotMatch(read("src/api/routes/delivery-returns.ts"), /requirePermission\(c, "delivery-orders"/);
  assert.doesNotMatch(read("src/api/routes/service-cases.ts"), /requirePermission\(c, "service-orders"/);
});

test("the grant is derived from the parent, action for action", () => {
  // This is what makes the change lossless. Granting a fixed set instead would
  // hand `delete` to a role that only had `read` on the parent.
  const src = read("src/api/lib/ensure-derived-permissions.ts");
  assert.match(src, /WHERE pp\.resource = \? AND pp\.action = \?/);
  assert.match(src, /JOIN permissions cp ON cp\.resource = \? AND cp\.action = \?/);
});

test("mail-center and settings go to EVERY role, not derived", () => {
  // They have no parent, and the owner's rule is that everyone has them.
  assert.deepEqual(UNIVERSAL_RESOURCES, ["mail-center", "settings"]);
  const src = read("src/api/lib/ensure-derived-permissions.ts");
  assert.match(src, /SELECT r\.id, p\.id FROM roles r, permissions p/);
});

test("seeding is additive — it never rewrites an edited role", () => {
  const src = read("src/api/lib/ensure-derived-permissions.ts");
  // Only real statements — the header comment says the words too.
  const sql = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  assert.ok(
    !sql.some((l) => /\b(DELETE FROM|UPDATE\s+\w+\s+SET)\b/.test(l)),
    "must not delete or overwrite",
  );
  assert.equal(src.split("ON CONFLICT DO NOTHING").length - 1, 3);
});

test("the four ungated routes are gated now", () => {
  // They were built outside the RBAC sweep and simply never got a gate —
  // anyone logged in could use them, whatever their role.
  for (const [file, res] of [
    ["fabrics", "fabrics"],
    ["promise-date", "promise-date"],
    ["customer-quotation", "quotations"],
    ["mail-center", "mail-center"],
  ]) {
    assert.match(
      read(`src/api/routes/${file}.ts`),
      new RegExp(`requirePermission\\(c, "${res}"`),
      `${file} must be gated`,
    );
  }
});

test("a route already behind requireSuperAdmin is not double-gated", () => {
  // Super admin is the stricter check; adding a permission gate in front of it
  // would only ever be redundant — and the first pass produced a duplicate
  // `denied` that would not compile.
  const src = read("src/api/routes/mail-center.ts");
  assert.doesNotMatch(
    src,
    /requirePermission\(c, "mail-center"[\s\S]{0,80}?requireSuperAdmin\(c\)/,
    "a permission gate must not sit in front of a super-admin gate",
  );
});

test("it runs once per isolate", async () => {
  let n = 0;
  const db = { prepare() { n++; const r = { run: async () => {} }; return { ...r, bind: () => r }; } };
  _resetDerivedPermsMemoForTests();
  await ensureDerivedPermissions(db);
  const first = n;
  await ensureDerivedPermissions(db);
  assert.equal(n, first, "a second call must be a no-op");
});

test("it is seeded where roles are managed", () => {
  assert.match(read("src/api/routes/users.ts"), /await ensureDerivedPermissions\(c\.var\.DB\)/);
});
