// ---------------------------------------------------------------------------
// customer-crm-quote-recipient.test.mjs — BUG-2026-08-13-102.
//
// `POST /api/customer-crm/send-quote` took `to`, `subject` and a ≤5 MB base64
// attachment straight from the caller and never tied `to` to the customer named
// in the same request. Anyone holding `customers:update` could send an
// arbitrary PDF from the company's own sending identity to any address on the
// internet, and log the send on an unrelated customer's timeline.
//
// Behavioural: the real handler runs against a stub DB and a stubbed mail
// provider, and the test asserts on what was HANDED TO THE SENDER — an
// assertion that a source pin cannot make.
//
// Every assertion here was proved RED by reintroducing the bug; see
// tests/security-posture-red-proof.mjs.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Hono } from "hono";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* Node 22.6+ strips types natively */
}

const PDF = "JVBERi0xLjQKJcOkw7zDtsOfCg=="; // a few bytes of real-looking base64

function phIndex(sql, col) {
  const m = new RegExp(`(?:^|[^\\w.])${col}\\s*=\\s*\\?`).exec(sql);
  if (!m) return -1;
  return (sql.slice(0, m.index).match(/\?/g) || []).length;
}

function makeDb({ customers, contacts }) {
  const activities = [];
  function prepare(sql) {
    let bound = [];
    const api = {
      bind(...a) {
        bound = a;
        return api;
      },
      async first() {
        if (/FROM customers/i.test(sql)) {
          const iId = phIndex(sql, "id");
          const iOrg = phIndex(sql, "org_id");
          let out = customers;
          if (iId >= 0) out = out.filter((r) => r.id === bound[iId]);
          if (iOrg >= 0) out = out.filter((r) => r.org_id === bound[iOrg]);
          return out.length ? { ...out[0] } : null;
        }
        return null;
      },
      async all() {
        if (/FROM customer_contacts/i.test(sql)) {
          const iCust = phIndex(sql, "customer_id");
          const iOrg = phIndex(sql, "org_id");
          let out = contacts;
          if (iCust >= 0) out = out.filter((r) => r.customer_id === bound[iCust]);
          if (iOrg >= 0) out = out.filter((r) => r.org_id === bound[iOrg]);
          return { results: out.map((r) => ({ ...r })) };
        }
        return { results: [] };
      },
      async run() {
        if (/INSERT INTO customer_activities/i.test(sql)) {
          activities.push([...bound]);
        }
        return { success: true };
      },
    };
    return api;
  }
  return { db: { prepare }, activities };
}

/**
 * The seam is global `fetch`: `src/api/lib/email.ts` is a plain fetch wrapper
 * ("no SDK, just fetch()"), so intercepting it records exactly what the handler
 * asked the provider to deliver — the recipient, the subject and the
 * attachment. Nothing weaker would prove the hole is closed: the point of the
 * bug was that the wrong address reached the SENDER.
 */
async function loadRouteWithMailRecorder() {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (/api\.resend\.com|api\.brevo\.com/.test(u)) {
      sent.push({ url: u, body: JSON.parse(init?.body ?? "{}") });
      return new Response(JSON.stringify({ id: "stub-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(url, init);
  };
  const mod = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/routes/customer-crm.ts")).href +
      `?t=${Math.random()}`
  );
  return { app: mod.default, sent, restore: () => { globalThis.fetch = realFetch; } };
}

/** Resend's payload shape: `to` is an array. Normalise for the assertions. */
function recipientsOf(record) {
  const to = record.body.to;
  return (Array.isArray(to) ? to : [to]).map((x) =>
    typeof x === "string" ? x : (x?.email ?? ""),
  );
}

function wrap(routeApp, { orgId = "hookka", role = "SALES" } = {}) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", c.env?.DB);
    c.set("orgId", orgId);
    c.set("userRole", role);
    c.set("userId", "user-1");
    await next();
  });
  parent.route("/", routeApp);
  return parent;
}

const CUSTOMERS = [
  { id: "cust-1", org_id: "hookka", email: "buyer@customer.example" },
  { id: "cust-2", org_id: "hookka", email: "" },
  { id: "cust-b", org_id: "tenant-b", email: "victim@othertenant.example" },
];
const CONTACTS = [
  { id: "ct-1", customer_id: "cust-1", org_id: "hookka", email: "Purchasing@Customer.Example" },
  { id: "ct-2", customer_id: "cust-1", org_id: "hookka", email: null },
];

async function send(body, opts = {}) {
  const { db, activities } = makeDb({ customers: CUSTOMERS, contacts: CONTACTS });
  const { app, sent, restore } = await loadRouteWithMailRecorder();
  try {
    const res = await wrap(app, opts).request(
      "/send-quote",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      { DB: db, RESEND_API_KEY: "stub-key-not-a-real-secret" },
    );
    return { res, json: await res.json().catch(() => ({})), sent, activities };
  } finally {
    restore();
  }
}

// ---- the hole --------------------------------------------------------------

test("an address that is NOT on the customer's file is refused, and nothing is sent", async () => {
  const { res, json, sent, activities } = await send({
    customerId: "cust-1",
    to: "attacker@evil.example",
    subject: "Your invoice is overdue",
    pdfBase64: PDF,
  });
  assert.equal(res.status, 403);
  assert.equal(json.success, false);
  assert.equal(sent.length, 0, "the mail provider must never have been called");
  assert.equal(activities.length, 0, "and no QUOTE_SENT may be logged on that customer");
});

test("a customer with NO email on file fails clearly — it does not fall back to the caller's address", async () => {
  const { res, json, sent } = await send({
    customerId: "cust-2",
    to: "attacker@evil.example",
    pdfBase64: PDF,
  });
  assert.equal(res.status, 400);
  assert.equal(sent.length, 0);
  assert.match(
    json.error,
    /no email address on file/i,
    "the refusal must tell the operator what to do, not read as a technical failure",
  );
});

test("a customer id from ANOTHER tenant resolves to no addresses, so nothing is sent", async () => {
  const { res, sent } = await send(
    { customerId: "cust-b", to: "victim@othertenant.example", pdfBase64: PDF },
    { orgId: "hookka" },
  );
  assert.notEqual(res.status, 200);
  assert.equal(sent.length, 0, "a cross-tenant customer id must not unlock its addresses");
});

// ---- the legitimate flow still works ---------------------------------------

test("the customer's OWN address still sends — this is the flow both UI callers prefill", async () => {
  const { res, json, sent, activities } = await send({
    customerId: "cust-1",
    to: "buyer@customer.example",
    filename: "Quotation-ABC.pdf",
    pdfBase64: PDF,
  });
  assert.equal(res.status, 200);
  assert.equal(json.success, true);
  assert.equal(sent.length, 1, "the legitimate send must still go out");
  assert.deepEqual(recipientsOf(sent[0]), ["buyer@customer.example"]);
  assert.equal(activities.length, 1, "and it is still logged on the timeline");
});

test("a CONTACT's address sends too, case-insensitively", async () => {
  const { res, sent } = await send({
    customerId: "cust-1",
    // Stored as "Purchasing@Customer.Example"; typed here in another case.
    to: "purchasing@customer.example",
    pdfBase64: PDF,
  });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(recipientsOf(sent[0]), ["purchasing@customer.example"]);
});

test("the existing shape checks still fire before any address lookup", async () => {
  const missingCustomer = await send({ to: "buyer@customer.example", pdfBase64: PDF });
  assert.equal(missingCustomer.res.status, 400);

  const badEmail = await send({ customerId: "cust-1", to: "not-an-email", pdfBase64: PDF });
  assert.equal(badEmail.res.status, 400);
  assert.equal(badEmail.sent.length, 0);

  const noPdf = await send({ customerId: "cust-1", to: "buyer@customer.example" });
  assert.equal(noPdf.res.status, 400);
  assert.equal(noPdf.sent.length, 0);

  const huge = await send({
    customerId: "cust-1",
    to: "buyer@customer.example",
    pdfBase64: "A".repeat(7_500_001),
  });
  assert.equal(huge.res.status, 413);
  assert.equal(huge.sent.length, 0);
});
