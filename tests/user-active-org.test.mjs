// ---------------------------------------------------------------------------
// user-active-org.test.mjs — BUG-2026-08-13-097.
//
// "Which company is active" lived on `inter_company_config`, a SINGLETON row
// (id = 1). One user switching company in the sidebar switcher flipped it for
// every other signed-in user, in every tenant, at the same time. It now lives
// on `users.active_org_id`.
//
// BEHAVIOURAL, like organisations-registry-projection.test.mjs: the real Hono
// handlers run against a stub DB that applies binds POSITIONALLY and models a
// `users` table, so a handler that goes back to writing the singleton — or that
// reads a user id it did not bind — fails here rather than passing over SQL
// that no longer does the work.
//
// Every assertion in this file was proved RED by reintroducing the bug; see
// tests/user-active-org-red-proof.mjs.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Hono } from "hono";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* Node 22.6+ strips types natively */
}

function phIndex(sql, col) {
  const m = new RegExp(`(?:^|[^\\w.])${col}\\s*=\\s*\\?`).exec(sql);
  if (!m) return -1;
  return (sql.slice(0, m.index).match(/\?/g) || []).length;
}

const ORGS = [
  {
    id: "org-hookka",
    org_id: "hookka",
    code: "HOOKKA",
    name: "HOOKKA INDUSTRIES SDN BHD",
    regNo: "REG-HOOKKA",
    tin: "TIN-HOOKKA",
    msic: "31009",
    msicCode: "31009",
    address: "Sungai Buloh",
    phone: "+60-1-111",
    email: "finance@hookka.example",
    businessType: "Production & Manufacturing",
    letterheadUrl: "",
    transferPricingPct: 0,
    isActive: 1,
    isDefault: true,
    displayOrder: 0,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "org-houzs",
    org_id: "hookka",
    code: "HOUZS",
    name: "HOUZS SDN BHD",
    regNo: "REG-HOUZS",
    tin: "TIN-HOUZS",
    msic: "47591",
    msicCode: "47591",
    address: "Houzs address",
    phone: "+60-1-000",
    email: "houzs@example.com",
    businessType: "Retail",
    letterheadUrl: "",
    transferPricingPct: 0,
    isActive: 1,
    isDefault: false,
    displayOrder: 1,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "org-hkmfg",
    org_id: "hookka",
    code: "HKMFG",
    name: "HK MANUFACTURING SDN BHD",
    regNo: "REG-HKMFG",
    tin: "TIN-HKMFG",
    msic: "31009",
    msicCode: "31009",
    address: "HKMFG address",
    phone: "+60-1-222",
    email: "hkmfg@example.com",
    businessType: "Production & Manufacturing",
    letterheadUrl: "",
    transferPricingPct: 0,
    isActive: 1,
    isDefault: false,
    displayOrder: 2,
    createdAt: "",
    updatedAt: "",
  },
  {
    // Another tenant's company. Never visible to a 'hookka' caller.
    id: "org-other",
    org_id: "tenant-b",
    code: "OTHERCO",
    name: "OTHER TENANT SDN BHD",
    regNo: "REG-OTHER",
    tin: "TIN-OTHER",
    msic: "",
    msicCode: "",
    address: "Somewhere else",
    phone: "",
    email: "",
    businessType: "",
    letterheadUrl: "",
    transferPricingPct: 0,
    isActive: 1,
    isDefault: false,
    displayOrder: 3,
    createdAt: "",
    updatedAt: "",
  },
];

/**
 * @param opts.users            seed rows for the `users` table
 * @param opts.globalActiveOrg  `inter_company_config.active_org_id` (the legacy singleton)
 * @param opts.usersColumnMissing  simulate an environment where the runtime
 *        self-apply has not run yet: `SELECT active_org_id FROM users` throws.
 */
function makeDb({
  users = [{ id: "user-a", active_org_id: null }],
  globalActiveOrg = "org-hookka",
  usersColumnMissing = false,
} = {}) {
  const rows = ORGS.map((o) => ({ ...o }));
  const userRows = users.map((u) => ({ ...u }));
  const cfg = {
    id: 1,
    hookkaToOhanaRate: 0.65,
    autoCreateMirrorDocs: 1,
    activeOrgId: globalActiveOrg,
  };
  const writes = [];
  const statements = [];

  function prepare(sql) {
    statements.push(sql);
    let bound = [];
    const api = {
      bind(...a) {
        bound = a;
        return api;
      },
      async all() {
        if (/FROM organisations/i.test(sql)) {
          let out = rows;
          const i = phIndex(sql, "org_id");
          if (i >= 0) out = out.filter((r) => r.org_id === bound[i]);
          return { results: out.map((r) => ({ ...r })) };
        }
        return { results: [] };
      },
      async first() {
        if (/FROM inter_company_config/i.test(sql)) return { ...cfg };
        if (/FROM users/i.test(sql)) {
          if (usersColumnMissing) {
            throw new Error('column "active_org_id" does not exist');
          }
          const iId = phIndex(sql, "id");
          const hit = iId >= 0 ? userRows.find((u) => u.id === bound[iId]) : null;
          return hit ? { ...hit } : null;
        }
        if (/FROM organisations/i.test(sql)) {
          let out = rows;
          const iOrg = phIndex(sql, "org_id");
          const iId = phIndex(sql, "id");
          const iCode = phIndex(sql, "code");
          if (iId >= 0) out = out.filter((r) => r.id === bound[iId]);
          if (iCode >= 0) out = out.filter((r) => r.code === bound[iCode]);
          if (iOrg >= 0) out = out.filter((r) => r.org_id === bound[iOrg]);
          return out.length ? { ...out[0] } : null;
        }
        return null;
      },
      async run() {
        writes.push({ sql, bound: [...bound] });
        if (/^UPDATE users/i.test(sql.trim())) {
          const iId = phIndex(sql, "id");
          const iVal = phIndex(sql, "active_org_id");
          const target = iId >= 0 ? userRows.find((u) => u.id === bound[iId]) : null;
          if (target && iVal >= 0) target.active_org_id = bound[iVal];
          return { success: true, meta: { changes: target ? 1 : 0 } };
        }
        if (/^UPDATE inter_company_config/i.test(sql.trim())) {
          if (/active_org_id/i.test(sql)) cfg.activeOrgId = bound[0];
          return { success: true };
        }
        return { success: true };
      },
    };
    return api;
  }

  return { db: { prepare }, rows, userRows, cfg, writes, statements };
}

function wrap(routeApp, { role = "SUPER_ADMIN", orgId = "hookka", userId = "user-a" } = {}) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", c.env?.DB);
    c.set("userRole", role);
    c.set("orgId", orgId);
    if (userId !== null) c.set("userId", userId);
    await next();
  });
  parent.route("/", routeApp);
  return parent;
}

async function loadRoute() {
  const mod = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/routes/organisations.ts")).href +
      `?t=${Math.random()}`
  );
  return mod.default;
}

async function resetEnsureMemo() {
  const mod = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/lib/ensure-user-active-org.ts")).href
  );
  mod.__resetUserActiveOrgMemo();
}

const getJson = (app, db) =>
  app.request("/", { method: "GET" }, { DB: db }).then((r) => r.json());

const putSwitch = (app, db, orgId) =>
  app.request(
    "/",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    },
    { DB: db },
  );

// ---- 1. THE BUG: two users, one DB, two different answers ------------------

test("two users reading the SAME database get their OWN active organisation", async () => {
  const { db } = makeDb({
    users: [
      { id: "user-a", active_org_id: "org-houzs" },
      { id: "user-b", active_org_id: "org-hkmfg" },
    ],
    globalActiveOrg: "org-hookka",
  });
  const route = await loadRoute();

  const a = await getJson(wrap(route, { userId: "user-a" }), db);
  const b = await getJson(wrap(route, { userId: "user-b" }), db);

  assert.equal(a.activeOrgId, "org-houzs", "user-a keeps their own pick");
  assert.equal(b.activeOrgId, "org-hkmfg", "user-b keeps their own pick");
  assert.notEqual(
    a.activeOrgId,
    b.activeOrgId,
    "the whole bug: one global row made these two identical",
  );
});

test("one user switching company does NOT move another user's switcher", async () => {
  await resetEnsureMemo();
  const { db, userRows } = makeDb({
    users: [
      { id: "user-a", active_org_id: "org-hookka" },
      { id: "user-b", active_org_id: "org-hookka" },
    ],
  });
  const route = await loadRoute();

  const res = await putSwitch(wrap(route, { userId: "user-a" }), db, "org-houzs");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).activeOrgId, "org-houzs");

  assert.equal(
    userRows.find((u) => u.id === "user-a").active_org_id,
    "org-houzs",
    "the switcher must persist for the user who clicked",
  );
  assert.equal(
    userRows.find((u) => u.id === "user-b").active_org_id,
    "org-hookka",
    "and must not touch anyone else",
  );

  const b = await getJson(wrap(route, { userId: "user-b" }), db);
  assert.equal(b.activeOrgId, "org-hookka", "user-b still sees their own company");
});

test("the switch writes users, and NEVER the inter_company_config singleton", async () => {
  await resetEnsureMemo();
  const { db, writes, cfg } = makeDb({
    users: [{ id: "user-a", active_org_id: null }],
    globalActiveOrg: "org-hookka",
  });
  const res = await putSwitch(wrap(await loadRoute(), { userId: "user-a" }), db, "org-houzs");
  assert.equal(res.status, 200);

  const userWrite = writes.find((w) => /^UPDATE users/i.test(w.sql.trim()));
  assert.ok(userWrite, "the pick must be written to the users row");
  assert.ok(
    userWrite.bound.includes("user-a"),
    "the UPDATE must bind the CALLER's id, not a constant",
  );

  assert.ok(
    !writes.some((w) => /UPDATE inter_company_config[\s\S]*active_org_id/i.test(w.sql)),
    "writing the singleton is the bug — it flips every other user at once",
  );
  assert.equal(cfg.activeOrgId, "org-hookka", "the legacy global row is left untouched");
});

// ---- 2. nobody's session changes on deploy ---------------------------------

test("a user who has never switched still sees the legacy global value", async () => {
  const { db } = makeDb({
    users: [{ id: "user-a", active_org_id: null }],
    globalActiveOrg: "org-houzs",
  });
  const json = await getJson(wrap(await loadRoute(), { userId: "user-a" }), db);
  assert.equal(
    json.activeOrgId,
    "org-houzs",
    "falling back to the first org would visibly move every mid-session user on deploy",
  );
});

test("a user with no row at all still gets a usable active org", async () => {
  const { db } = makeDb({ users: [], globalActiveOrg: "org-hkmfg" });
  const json = await getJson(wrap(await loadRoute(), { userId: "ghost" }), db);
  assert.equal(json.activeOrgId, "org-hkmfg");
});

test("GET degrades to the legacy value when the column has not been self-applied yet", async () => {
  const { db } = makeDb({
    users: [{ id: "user-a", active_org_id: "org-houzs" }],
    // NOT the first organisation on purpose: with 'org-hookka' here this
    // assertion also passes when the legacy fallback is deleted entirely,
    // because organisations[0] is the same id. The red-proof harness caught
    // exactly that — the test was green against a broken fallback chain.
    globalActiveOrg: "org-hkmfg",
    usersColumnMissing: true,
  });
  const json = await getJson(wrap(await loadRoute(), { userId: "user-a" }), db);
  assert.equal(json.activeOrgId, "org-hkmfg", "pre-self-apply, the old value still shows");
  // The real hazard: a throw inside the Promise.all drops the WHOLE GET into
  // the FALLBACK_ORGS path, replacing the live registry with two hardcoded
  // companies over a cosmetic field.
  assert.deepEqual(
    json.organisations.map((o) => o.code),
    ["HOOKKA", "HOUZS", "HKMFG"],
    "the real registry must survive a missing users column",
  );
});

// ---- 3. stale picks ---------------------------------------------------------

test("a pick pointing at a company this caller cannot see is not used", async () => {
  // `org-other` belongs to tenant-b. sidebar.tsx matches activeOrgId against
  // the org list and prints a hardcoded 'HOOKKA INDUSTRIES' label when nothing
  // matches — so an unresolvable id shows a company that is not active.
  const { db } = makeDb({
    users: [{ id: "user-a", active_org_id: "org-other" }],
    globalActiveOrg: "org-houzs",
  });
  const json = await getJson(wrap(await loadRoute(), { userId: "user-a" }), db);
  assert.equal(json.activeOrgId, "org-houzs");
  assert.ok(
    json.organisations.some((o) => o.id === json.activeOrgId),
    "the resolved active org must always be one of the returned organisations",
  );
});

test("a legacy global pointing outside the caller's tenant falls through too", async () => {
  const { db } = makeDb({
    users: [{ id: "user-a", active_org_id: null }],
    globalActiveOrg: "org-other",
  });
  const json = await getJson(wrap(await loadRoute(), { userId: "user-a" }), db);
  assert.equal(json.activeOrgId, "org-hookka", "falls back to the first visible company");
});

// ---- 4. the response contract the clients read ------------------------------

test("the response shape is unchanged for BOTH projections", async () => {
  const { db } = makeDb({ users: [{ id: "user-a", active_org_id: "org-houzs" }] });
  const route = await loadRoute();

  const full = await getJson(wrap(route, { role: "SUPER_ADMIN", userId: "user-a" }), db);
  assert.ok("activeOrgId" in full);
  assert.ok(Array.isArray(full.organisations));
  assert.ok(full.interCompanyConfig, "the full projection keeps interCompanyConfig");

  // The restricted projection shipped today — the switcher renders for every
  // user, so activeOrgId has to survive the reduction (sidebar.tsx:438).
  const reduced = await getJson(wrap(route, { role: "SALES", userId: "user-a" }), db);
  assert.equal(reduced.restricted, true);
  assert.equal(reduced.activeOrgId, "org-houzs", "restricted roles keep a per-user active org");
  for (const org of reduced.organisations) {
    for (const key of ["id", "code", "name", "isActive", "displayOrder"]) {
      assert.ok(key in org, `the switcher projection must keep ${key}`);
    }
  }
});

test("PUT / still refuses to switch to another tenant's organisation", async () => {
  await resetEnsureMemo();
  const { db, userRows } = makeDb({ users: [{ id: "user-a", active_org_id: "org-hookka" }] });
  const res = await putSwitch(wrap(await loadRoute(), { userId: "user-a" }), db, "org-other");
  assert.equal(res.status, 404);
  assert.equal(
    userRows.find((u) => u.id === "user-a").active_org_id,
    "org-hookka",
    "a rejected switch must not have been persisted",
  );
});

test("a caller with a role but no user identity cannot silently 'switch'", async () => {
  await resetEnsureMemo();
  const { db, writes } = makeDb();
  const res = await putSwitch(wrap(await loadRoute(), { userId: null }), db, "org-houzs");
  assert.equal(res.status, 401, "200 would report a switch that reverts on reload");
  assert.ok(!writes.some((w) => /^UPDATE users/i.test(w.sql.trim())));
});

// ---- 5. the inert-migration rule -------------------------------------------

test("the column is self-applied BEFORE the first write, not only in a migration", async () => {
  await resetEnsureMemo();
  const { db, statements } = makeDb({ users: [{ id: "user-a", active_org_id: null }] });
  const res = await putSwitch(wrap(await loadRoute(), { userId: "user-a" }), db, "org-houzs");
  assert.equal(res.status, 200);

  const iAlter = statements.findIndex((s) =>
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS active_org_id/i.test(s),
  );
  const iUpdate = statements.findIndex((s) => /^UPDATE users/i.test(s.trim()));
  assert.ok(iAlter >= 0, "migrations are inert on deploy — the ALTER must run at runtime");
  assert.ok(iUpdate >= 0);
  assert.ok(
    iAlter < iUpdate,
    "the ALTER must be AWAITED before the UPDATE, or the first write 500s on a fresh deploy",
  );
});

test("the migration file exists and matches the runtime DDL", () => {
  const sql = readFileSync(
    new URL("../migrations-postgres/0226_user_active_org.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS active_org_id text/i);
  const ensure = readFileSync(
    new URL("../src/api/lib/ensure-user-active-org.ts", import.meta.url),
    "utf8",
  );
  assert.match(ensure, /ALTER TABLE users ADD COLUMN IF NOT EXISTS active_org_id text/i);
});

// ---- 6. source pin: the singleton write must not come back ------------------

test("no route writes inter_company_config.active_org_id any more", () => {
  const src = readFileSync(
    new URL("../src/api/routes/organisations.ts", import.meta.url),
    "utf8",
  );
  // Strip `//` comments first — the fix's own comment QUOTES the SQL it
  // removed, and a naive source scan matched that and "passed" the wrong way.
  // EOL-agnostic on purpose: these files are CRLF, so a `\n` anchor matches
  // nothing; `[^\r\n]` and the `m` flag are what actually work here.
  const code = src.replace(/^[^\r\n]*?\/\/[^\r\n]*$/gm, "");
  assert.ok(
    /\/\/ /.test(src) && code.length < src.length,
    "sanity: the comment stripper must actually have removed something",
  );
  assert.ok(
    !/UPDATE\s+inter_company_config\s+SET\s+active_org_id/i.test(code),
    "the singleton write is the bug; the pick belongs on the users row",
  );
  assert.match(
    src,
    /UPDATE\s+users\s+SET\s+active_org_id\s*=\s*\?\s+WHERE\s+id\s*=\s*\?/i,
  );
});
