// Mail Center permission surface — the shape, not the seeded data.
//
// Measured on prod 2026-08-19: the seed had granted ALL FOUR mail-center
// actions to ALL TWELVE roles, including role_worker (the factory phone
// portal) and role_read_only (whose only member is a person at a customer
// company). `create` backs POST /compose and POST /threads/:id/reply, so
// every role in the system could send mail from an @hookka.com address.
//
// The grants themselves live in the database and were corrected by
// scripts/fix-rbac-mail-and-readonly.mjs. What these tests pin is the CODE
// those grants act on — the parts a future edit could quietly loosen:
//   * sending is guarded by a permission at all, and by the SAME one in both
//     send paths;
//   * configuration endpoints stay SUPER_ADMIN-only;
//   * every read is scoped per-user, so a permission grant alone never widens
//     which mailboxes someone can see;
//   * the sidebar shows only what the scoped endpoint returned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(
  new URL("../src/api/routes/mail-center.ts", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../src/pages/mail-center/index.tsx", import.meta.url),
  "utf8",
);

/** The handler body from `app.<verb>("<path>"` up to the next `app.` block. */
function handler(verb, path) {
  const start = route.indexOf(`app.${verb}("${path}"`);
  assert.notEqual(start, -1, `no handler for ${verb.toUpperCase()} ${path}`);
  const next = route.indexOf("\napp.", start + 1);
  return route.slice(start, next === -1 ? route.length : next);
}

test("both send paths are gated by mail-center:create", () => {
  // create IS the send switch. If either of these ever drops to :read, every
  // role that can open Mail Center can send mail from the company domain.
  for (const [verb, path] of [
    ["post", "/compose"],
    ["post", "/threads/:id/reply"],
  ]) {
    assert.match(
      handler(verb, path),
      /requirePermission\(c, "mail-center", "create"\)/,
      `${verb.toUpperCase()} ${path}`,
    );
  }
});

test("mailbox configuration stays SUPER_ADMIN-only", () => {
  // These decide who can read what. A permission grant must never reach them.
  for (const [verb, path] of [
    ["post", "/addresses"],
    ["patch", "/addresses/:id"],
    ["get", "/access"],
    ["post", "/access"],
    ["delete", "/access"],
    ["get", "/scope-levels"],
    ["put", "/scope-level"],
    ["post", "/test-inject"],
  ]) {
    assert.match(
      handler(verb, path),
      /requireSuperAdmin\(c\)/,
      `${verb.toUpperCase()} ${path} must be super-admin only`,
    );
  }
});

test("every mail read is scoped per user, not just permission-checked", () => {
  // requirePermission answers "may you use Mail Center". getMailScope answers
  // "which mailboxes are yours". Both are needed: without the second, granting
  // mail-center:read to a role would hand that role every mailbox in the org.
  for (const [verb, path] of [
    ["get", "/threads"],
    ["get", "/threads/:id"],
    ["get", "/outbox"],
    ["get", "/outbox/:id"],
    ["get", "/addresses"],
  ]) {
    const h = handler(verb, path);
    assert.match(h, /requirePermission\(c, "mail-center", "read"\)/, path);
    assert.match(h, /getMailScope\(c, orgId\)/, `${path} must scope by user`);
  }
});

test("a non-admin's sidebar shows only mailboxes the backend returned", () => {
  // GET /addresses is scoped, so an absent mailbox means "not visible to you",
  // NOT "does not exist". The page used to inject Support/Finance/HR for
  // everyone and label them "not set up" — telling a salesperson that Finance
  // had no mailbox while finance@hookka.com held 1,039 threads, and disclosing
  // the addresses in the process.
  const injection = page.slice(
    page.indexOf("const departmentGroups = useMemo("),
    page.indexOf("// The personal \"Other\" bucket"),
  );
  assert.ok(injection.length > 0, "could not locate departmentGroups");

  // Every CANONICAL_DEPT_MAILBOXES read inside that block must sit behind an
  // isSuperAdmin check.
  for (const m of injection.matchAll(/CANONICAL_DEPT_MAILBOXES/g)) {
    const before = injection.slice(Math.max(0, m.index - 260), m.index);
    assert.match(
      before,
      /if \(isSuperAdmin\) \{/,
      "canonical mailbox injection must be admin-gated",
    );
  }
  assert.match(
    injection,
    /\}, \[deptGroups, isSuperAdmin\]\);/,
    "isSuperAdmin must be a dependency or the gate goes stale",
  );
});

test("the inbox empty state does not claim receiving is switched off", () => {
  // Inbound has been live since the MX cutover; prod received mail on
  // 2026-08-19. The old copy made an empty mailbox read as a broken system.
  assert.doesNotMatch(page, /domain MX is switched to/);
  assert.match(page, /Nothing has arrived in this mailbox yet\./);
});

test("the test-inject button is not offered to people who would get a 403", () => {
  const start = page.indexOf("Nothing has arrived in this mailbox yet.");
  const region = page.slice(start, start + 900);
  assert.match(region, /isSuperAdmin && \(/, "inject button must be admin-gated");
});
