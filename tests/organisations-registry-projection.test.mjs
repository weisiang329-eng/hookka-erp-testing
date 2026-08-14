// ---------------------------------------------------------------------------
// organisations-registry-projection.test.mjs — BUG-2026-08-13-100.
//
// `GET /api/organisations` was the only handler across eight routers with no
// permission check, and `loadOrganisations` selected the whole table. Every
// signed-in user of every role read all four companies' TIN, registration
// number, registered address, phone and email. The same file resolved
// PATCH/:id, DELETE/:id and PUT / by bare `id` with no tenant predicate, and
// POST / stamped the literal 'hookka'.
//
// These are BEHAVIOURAL tests: the real Hono handlers run against a stub DB
// that applies binds POSITIONALLY, so deleting an `org_id = ?` predicate stops
// the filtering and the assertions fail — rather than passing over a query that
// no longer narrows.
//
// Every assertion in this file was proved RED by reintroducing the bug; see
// tests/security-posture-red-proof.mjs.
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

// ---- stub DB ---------------------------------------------------------------

/**
 * Index of the `?` that belongs to `<col> = ?`, counting placeholders from 0.
 *
 * This is what makes the tenant assertions real: the filter is derived from the
 * SQL text, so a handler that drops `AND org_id = ?` stops filtering here too.
 */
function phIndex(sql, col) {
  // The leading boundary matters: a naive /id = \?/ also matches "org_id = ?",
  // which silently pointed the id filter at the tenant's placeholder and made
  // one of these tests pass for the wrong reason.
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
    regNo: "202501060540 (1661946-X)",
    tin: "C60515534080",
    msic: "31009",
    msicCode: "31009",
    address: "2775F, Jalan Industri 12, Sungai Buloh",
    phone: "+6011-6133 3173",
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
    address: "Houzs registered address",
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
    // A SECOND tenant's company. No handler in this router may ever reach it.
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
    displayOrder: 2,
    createdAt: "",
    updatedAt: "",
  },
];

function makeDb() {
  const rows = ORGS.map((o) => ({ ...o }));
  const cfg = { id: 1, hookkaToOhanaRate: 0.65, autoCreateMirrorDocs: 1, activeOrgId: "org-hookka" };
  const writes = [];

  function prepare(sql) {
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
        if (/^UPDATE organisations/i.test(sql.trim())) {
          let out = rows;
          const iOrg = phIndex(sql, "org_id");
          const iId = phIndex(sql, "id");
          if (iId >= 0) out = out.filter((r) => r.id === bound[iId]);
          if (iOrg >= 0) out = out.filter((r) => r.org_id === bound[iOrg]);
          for (const r of out) r._touched = true;
          return { success: true, meta: { changes: out.length } };
        }
        return { success: true };
      },
    };
    return api;
  }

  return { db: { prepare }, rows, writes };
}

// `userId` became load-bearing with BUG-2026-08-13-097: the switcher's active
// organisation is stored per user (`users.active_org_id`), so PUT { orgId } now
// needs an actor to write it against. Every real request carries one —
// auth-middleware stashes it before this router is reached.
function wrap(routeApp, { role, orgId = "hookka", userId = "user-a" }) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", c.env?.DB);
    c.set("userRole", role);
    c.set("orgId", orgId);
    c.set("userId", userId);
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

const SENSITIVE = ["tin", "regNo", "address", "phone", "email", "businessType", "transferPricingPct"];

// ---- 1. the projection -----------------------------------------------------

test("GET /: a role without organisations:read gets NO tin / regNo / address / phone / email", async () => {
  const { db } = makeDb();
  const app = wrap(await loadRoute(), { role: "SALES" });
  const res = await app.request("/", { method: "GET" }, { DB: db });
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.ok(Array.isArray(json.organisations));
  assert.equal(json.organisations.length, 2, "still sees this tenant's companies");
  for (const org of json.organisations) {
    for (const key of SENSITIVE) {
      assert.ok(
        !(key in org),
        `reduced projection must OMIT ${key} (found ${JSON.stringify(org[key])}) — ` +
          `a blank string would be C16, a missing key is a fact the consumer can read`,
      );
    }
  }
  // The transfer PRICE is withheld with the rest.
  assert.ok(
    !("interCompanyConfig" in json),
    "interCompanyConfig carries hookkaToOhanaRate and must not ride along",
  );
  assert.equal(json.restricted, true, "consumers must be able to tell reduced from blank");
});

test("GET /: the company SWITCHER still works for an ordinary role", async () => {
  const { db } = makeDb();
  const app = wrap(await loadRoute(), { role: "SALES" });
  const json = await (await app.request("/", { method: "GET" }, { DB: db })).json();

  // Exactly what sidebar.tsx:427 reads, plus what the three sales-side pickers
  // read (code / name / isActive). Breaking this is worse than the exposure.
  assert.equal(json.activeOrgId, "org-hookka");
  for (const org of json.organisations) {
    assert.equal(typeof org.id, "string");
    assert.ok(org.id.length > 0);
    assert.equal(typeof org.code, "string");
    assert.ok(org.code.length > 0);
    assert.equal(typeof org.name, "string");
    assert.ok(org.name.length > 0);
    assert.equal(typeof org.isActive, "boolean");
  }
  assert.deepEqual(
    json.organisations.map((o) => o.code),
    ["HOOKKA", "HOUZS"],
  );
});

test("GET /: a role WITH organisations:read still gets the whole registry", async () => {
  for (const role of ["SUPER_ADMIN", "OFFICE", "QA"]) {
    const { db } = makeDb();
    const app = wrap(await loadRoute(), { role });
    const json = await (await app.request("/", { method: "GET" }, { DB: db })).json();
    const hookka = json.organisations.find((o) => o.code === "HOOKKA");
    assert.ok(hookka, `${role} must see the registry`);
    assert.equal(hookka.tin, "C60515534080", `${role} must keep TIN`);
    assert.equal(hookka.regNo, "202501060540 (1661946-X)", `${role} must keep regNo`);
    assert.ok(hookka.address.length > 0, `${role} must keep the address`);
    assert.ok(json.interCompanyConfig, `${role} must keep interCompanyConfig`);
  }
});

test("QA gets the registry through purchase-orders, and STILL cannot see the admin page", async () => {
  const [{ permissionsForRole }, { hiddenNavPrefixes }] = await Promise.all([
    import(pathToFileURL(resolve(process.cwd(), "src/api/lib/role-policy.ts")).href),
    import(pathToFileURL(resolve(process.cwd(), "src/api/lib/nav-permissions.ts")).href),
  ]);
  const qa = permissionsForRole("QA");
  // QA prints PO / GRN / PI letterheads, so it needs the fields…
  assert.ok(qa.has("purchase-orders:*") || qa.has("purchase-orders:read"));
  // …but must NOT hold `organisations`, or the registry admin page appears in
  // its menu (hiddenNavPrefixes unhides /settings/organisations on :read).
  assert.ok(!qa.has("organisations:read"));
  assert.ok(!qa.has("organisations:*"));
  assert.ok(
    hiddenNavPrefixes(qa).includes("/settings/organisations"),
    "reading a letterhead must not open the registry admin page",
  );
  // The roles that print nothing from this registry stay reduced.
  for (const role of ["SALES", "HR", "R_AND_D"]) {
    const set = permissionsForRole(role);
    for (const p of ["organisations:read", "organisations:*", "purchase-orders:read", "purchase-orders:*"]) {
      assert.ok(!set.has(p), `${role} must not hold ${p}`);
    }
  }
});

// ---- 2. the C16 consumer ---------------------------------------------------

test("hasLetterheadDetails: a REDUCED registry row is not printable", async () => {
  // `generate-purchase-order-pdf.ts` imports through the `@/` alias, which the
  // test runner cannot resolve (see tests/payment-method.test.mjs), so the
  // decision lives in its own import-free module and is tested by RUNNING it.
  const { hasLetterheadDetails } = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/org-letterhead-row.ts")).href
  );
  // What a caller without organisations:read now holds.
  assert.equal(
    hasLetterheadDetails({ id: "org-hookka", code: "HOOKKA", name: "HOOKKA INDUSTRIES SDN BHD" }),
    false,
    "a reduced row must not be printed as a letterhead",
  );
  assert.equal(hasLetterheadDetails({ regNo: "", tin: "", address: "  " }), false);
  assert.equal(hasLetterheadDetails(null), false);
  assert.equal(hasLetterheadDetails(undefined), false);
  // A FULL row still wins over the hardcoded fallback — that is the whole
  // reason the registry is fetched (a sister company prints its own details).
  assert.equal(hasLetterheadDetails({ regNo: "REG-HOUZS" }), true);
  assert.equal(hasLetterheadDetails({ tin: "TIN-HOUZS" }), true);
  assert.equal(hasLetterheadDetails({ address: "Houzs registered address" }), true);
});

test("letterheadForPurchaseOrg actually CALLS the guard in its branch condition", () => {
  // The C15 lesson: a guard whose identifier merely appears in the file, while
  // the branch has been short-circuited past it, passes a naive source pin.
  const src = readFileSync(
    new URL("../src/lib/generate-purchase-order-pdf.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /import \{ hasLetterheadDetails \} from "\.\/org-letterhead-row"/);
  assert.match(
    src,
    /if \(org && org\.name && hasLetterheadDetails\(org\)\) \{/,
    "the registry branch must be gated on the call, not merely mention it",
  );
});

// ---- 3. the tenant predicates ----------------------------------------------

test("GET /: another tenant's company is not in the list", async () => {
  const { db } = makeDb();
  const app = wrap(await loadRoute(), { role: "SUPER_ADMIN" });
  const json = await (await app.request("/", { method: "GET" }, { DB: db })).json();
  assert.ok(
    !json.organisations.some((o) => o.code === "OTHERCO"),
    "a second tenant's registry row must not appear",
  );
});

test("PATCH /:id cannot reach another tenant's organisation", async () => {
  const { db, rows } = makeDb();
  const app = wrap(await loadRoute(), { role: "SUPER_ADMIN", orgId: "hookka" });
  const res = await app.request(
    "/org-other",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HIJACKED" }),
    },
    { DB: db },
  );
  assert.equal(res.status, 404, "must 404, not edit another tenant's company");
  assert.ok(!rows.find((r) => r.id === "org-other")._touched, "no UPDATE may have matched");
});

test("PATCH /:id still edits this tenant's own organisation", async () => {
  const { db, rows } = makeDb();
  const app = wrap(await loadRoute(), { role: "SUPER_ADMIN", orgId: "hookka" });
  const res = await app.request(
    "/org-houzs",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+60-1-999" }),
    },
    { DB: db },
  );
  assert.equal(res.status, 200);
  assert.ok(rows.find((r) => r.id === "org-houzs")._touched, "the legitimate edit must land");
});

test("DELETE /:id cannot soft-delete another tenant's organisation", async () => {
  const { db, rows } = makeDb();
  const app = wrap(await loadRoute(), { role: "SUPER_ADMIN", orgId: "hookka" });
  const res = await app.request("/org-other", { method: "DELETE" }, { DB: db });
  assert.equal(res.status, 404);
  assert.ok(!rows.find((r) => r.id === "org-other")._touched);
});

test("PUT / cannot switch to, or edit, another tenant's organisation", async () => {
  const { db, rows } = makeDb();
  const app = wrap(await loadRoute(), { role: "SUPER_ADMIN", orgId: "hookka" });

  const sw = await app.request(
    "/",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: "org-other" }),
    },
    { DB: db },
  );
  assert.equal(sw.status, 404, "switching the active org to another tenant's row must 404");

  const ed = await app.request(
    "/",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organisation: { id: "org-other", name: "HIJACKED" } }),
    },
    { DB: db },
  );
  assert.equal(ed.status, 404);
  assert.ok(!rows.find((r) => r.id === "org-other")._touched);
});

test("PUT / still switches to this tenant's own organisation", async () => {
  const { db } = makeDb();
  const app = wrap(await loadRoute(), { role: "SUPER_ADMIN", orgId: "hookka" });
  const res = await app.request(
    "/",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: "org-houzs" }),
    },
    { DB: db },
  );
  assert.equal(res.status, 200, "the switcher must keep working");
  const json = await res.json();
  assert.equal(json.activeOrgId, "org-houzs");
});

test("POST / stamps the CALLER's org, not the literal 'hookka', and dedupes per tenant", async () => {
  const { db, writes } = makeDb();
  const app = wrap(await loadRoute(), { role: "SUPER_ADMIN", orgId: "tenant-b" });
  const res = await app.request(
    "/",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "NEWCO", name: "NEW CO SDN BHD" }),
    },
    { DB: db },
  );
  assert.equal(res.status, 201);
  const insert = writes.find((w) => /INSERT INTO organisations/i.test(w.sql));
  assert.ok(insert, "an INSERT must have run");
  // Column list: (id, org_id, code, ...) → bind[1] is org_id.
  assert.equal(insert.bound[1], "tenant-b", "org_id must be the caller's tenant");
  assert.notEqual(insert.bound[1], "hookka");
});

test("POST /: a code taken in ANOTHER tenant does not block this one", async () => {
  const { db } = makeDb();
  const app = wrap(await loadRoute(), { role: "SUPER_ADMIN", orgId: "tenant-b" });
  const res = await app.request(
    "/",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "HOUZS", name: "Tenant B's own HOUZS" }),
    },
    { DB: db },
  );
  assert.equal(res.status, 201, "the dedupe must be per (org_id, code), matching the unique index");
});

test("POST /: a code already taken in THIS tenant is still refused", async () => {
  const { db } = makeDb();
  const app = wrap(await loadRoute(), { role: "SUPER_ADMIN", orgId: "hookka" });
  const res = await app.request(
    "/",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "HOUZS", name: "duplicate" }),
    },
    { DB: db },
  );
  assert.equal(res.status, 409);
});

// ---- 4. source pins --------------------------------------------------------

test("the endpoint is NOT gated as a whole — the switcher must render for everyone", () => {
  const src = readFileSync(
    new URL("../src/api/routes/organisations.ts", import.meta.url),
    "utf8",
  );
  const get = src.slice(src.indexOf('app.get("/"'), src.indexOf('app.post("/"'));
  assert.ok(
    !/requirePermission\(/.test(get),
    "gating the whole GET would empty the company switcher for ordinary staff",
  );
  assert.match(get, /hasPermission\(c, "organisations", "read"\)/);
  assert.match(
    get,
    /hasPermission\(c, "purchase-orders", "read"\)/,
    "the letterhead consumers must keep their fields",
  );
});
