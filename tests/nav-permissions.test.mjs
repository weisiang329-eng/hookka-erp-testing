// ---------------------------------------------------------------------------
// nav-permissions.test.mjs — the menu must agree with the gate.
//
// Owner 2026-08-05: "全部生效了吗？因为我看到还有很多东西，好像和我们之前看的是
// 一样的." It HAD taken effect — on the API. The sidebar was the half that had
// not: it carried a hand-written list of NINE links, all Finance, and defaulted
// the other eighty-four to visible. A salesperson still saw Payroll,
// Procurement, Warehouse and R&D in the menu and only found out on click.
//
// That is worse than no filtering. It teaches people the app errors at random,
// and it makes a permission change look like it did nothing.
//
// Then: "我不要用 frontend loading 等等的，直接从 backend 就挡掉嘛." So the
// decision is computed server-side and handed over as a list of path prefixes;
// the browser never learns which resource guards which page.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resourceForNav, hiddenNavPrefixes, homeForPermissions, NAV_RESOURCE } from "../src/api/lib/nav-permissions.ts";
import { permissionsForRole, ALL_RESOURCES } from "../src/api/lib/role-policy.ts";

const allows = (set, resource, action) =>
  set.has(`${resource}:${action}`) || set.has(`${resource}:*`) ||
  set.has(`*:${action}`) || set.has(`*:*`);

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const SIDEBAR = read("src/components/layout/sidebar.tsx");
const LINKS = [...new Set(
  [...SIDEBAR.matchAll(/\{ name: "[^"]+", href: "([^"]+)"/g)].map((m) => m[1]),
)];

test("a longer prefix wins over a shorter one", () => {
  // /delivery-returns must not be swallowed by /delivery, and
  // /inventory/fabrics must resolve to fabrics rather than inventory.
  assert.equal(resourceForNav("/delivery-returns"), "delivery-returns");
  assert.equal(resourceForNav("/delivery"), "delivery-orders");
  assert.equal(resourceForNav("/inventory/fabrics"), "fabrics");
  assert.equal(resourceForNav("/inventory"), "inventory");
  assert.equal(resourceForNav("/maintenance/sofa-combos"), "sofa-combos");
  assert.equal(resourceForNav("/maintenance"), "equipment");
});

test("a query string does not change the answer", () => {
  // The Finance section is thirty ?tab= views over one page and one resource.
  assert.equal(resourceForNav("/accounting?tab=pl"), "accounting");
  assert.equal(resourceForNav("/accounting?tab=ocreditorpay"), "accounting");
});

test("an unmapped link stays visible", () => {
  // Hiding by omission is how a menu quietly loses a page.
  assert.equal(resourceForNav("/something-added-tomorrow"), null);
});

test("the dashboard is management-only, and everyone still has a home", () => {
  // Owner 2026-08-05: "Dashboard VUCA report，除了 Management、Super Admin 可以
  // 看到，其他人都看不到." It is also the post-login landing page, so hiding it
  // without giving each role somewhere else to land would break login for them.
  assert.equal(resourceForNav("/dashboard"), "accounting");

  for (const role of ["SALES", "OFFICE", "QA", "HR", "R_AND_D"]) {
    const perms = permissionsForRole(role);
    assert.ok(
      hiddenNavPrefixes(perms).includes("/dashboard"),
      `${role} should not see the dashboard`,
    );
    const home = homeForPermissions(perms, role);
    assert.notEqual(home, "/dashboard", `${role} must not land on the dashboard`);
    assert.ok(
      !hiddenNavPrefixes(perms).some((h) => home === h || home.startsWith(`${h}/`)),
      `${role} lands on ${home}, which its own menu hides`,
    );
  }

  const admin = new Set(["*"]);
  assert.ok(!hiddenNavPrefixes(admin).includes("/dashboard"));
  assert.equal(homeForPermissions(admin, "SUPER_ADMIN"), "/dashboard");
});

test("almost every sidebar link is mapped", () => {
  // Before this, 84 of 93 were unmapped and therefore always shown.
  const unmapped = LINKS.filter((h) => !resourceForNav(h));
  assert.ok(
    unmapped.length <= 3,
    `too many unmapped links, RBAC would be invisible again:\n${unmapped.join("\n")}`,
  );
});

test("super admin is told to hide nothing", () => {
  assert.deepEqual(hiddenNavPrefixes(new Set(["*"])), []);
  assert.deepEqual(hiddenNavPrefixes(new Set(["*:*"])), []);
});

test("a role is told to hide exactly what it cannot read", () => {
  const sales = permissionsForRole("SALES");
  const hidden = new Set(hiddenNavPrefixes(sales));
  // SALES has customers and sales orders…
  assert.ok(!hidden.has("/customers"));
  assert.ok(!hidden.has("/sales"));
  // …and none of the money or people modules.
  for (const p of ["/accounting", "/employees", "/forecast"]) {
    assert.ok(hidden.has(p), `SALES should not see ${p}`);
  }
});

test("HR is told to hide the commercial menu", () => {
  const hidden = new Set(hiddenNavPrefixes(permissionsForRole("HR")));
  for (const p of ["/sales", "/customers", "/procurement", "/inventory", "/accounting"]) {
    assert.ok(hidden.has(p), `HR should not see ${p}`);
  }
  assert.ok(!hidden.has("/employees"), "HR must keep Employees");
});

test("the decision is made on the server, not in the browser", () => {
  // The mapping must not leave the API — otherwise it drifts from the gate.
  // Both halves of the decision — what the permissions hide, and what a role
  // is simply not shown while keeping the permission (hiddenNavForRole) — are
  // computed on the API and merged there.
  const auth = read("src/api/routes/auth.ts");
  assert.match(auth, /hiddenNavPrefixes\(/);
  assert.match(auth, /hiddenNavForRole\(roleName\)/);
  assert.doesNotMatch(SIDEBAR, /NAV_RESOURCE|resourceForNav/, "the browser must not map hrefs");
  assert.match(SIDEBAR, /isNavAllowed\(href\)/);
});

test("the permissions endpoint uses the SAME source as the gate", () => {
  // It used to read role_permissions directly while rbac.ts short-circuited to
  // the code policy — so the browser got a different answer from the one the
  // API enforced: menus for pages that 403, or pages hidden that work.
  const auth = read("src/api/routes/auth.ts");
  const coded = auth.indexOf("const coded = permissionsForRole(roleName);");
  const query = auth.indexOf("FROM role_permissions rp");
  assert.ok(coded > 0 && query > coded, "the code policy must be consulted first");
});

test("a prefix matches a path segment, never a bare string", () => {
  // Hiding /delivery must not also hide /delivery-returns.
  const hook = read("src/lib/use-permission.ts");
  assert.match(hook, /path === p \|\| path\.startsWith\(`\$\{p\}\/`\)/);
});

test("an empty hidden list shows everything", () => {
  // Loading, or a failed fetch, must not blank the menu — the API refuses
  // anything the user should not reach anyway.
  const hook = read("src/lib/use-permission.ts");
  assert.match(hook, /if \(!navHidden\.length\) return true;/);
});

test("every mapped resource is a real one", () => {
  // A typo here hides a menu for everyone, silently — and it would look like a
  // permissions bug, not a string mistake.
  const known = new Set(ALL_RESOURCES);
  for (const [prefix, res] of Object.entries(NAV_RESOURCE)) {
    assert.ok(known.has(res), `${prefix} maps to "${res}", which is not a known resource`);
  }
});


test("a denied route never redirects into another denied route", () => {
  // <RequirePermission> sends a denied user to their home. If that home were
  // itself guarded against them the browser would bounce forever — which is
  // exactly what /dashboard as the default became once it was restricted to
  // Management and Super Admin, and then guarded.
  for (const role of ["SALES", "OFFICE", "QA", "HR", "R_AND_D"]) {
    const perms = permissionsForRole(role);
    const home = homeForPermissions(perms, role);
    const guard = resourceForNav(home);
    if (!guard) continue; // unguarded page — always reachable
    assert.ok(
      allows(perms, guard, "read"),
      `${role} is redirected to ${home}, which guards on ${guard}:read that ${role} lacks — redirect loop`,
    );
  }
});
