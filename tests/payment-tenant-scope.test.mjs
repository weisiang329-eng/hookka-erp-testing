// Every payment handler is scoped to the caller's own company.
//
// Three were not (measured 2026-08-20), and they were not equally bad:
//
//   GET /payments/:id                     — read another company's payment by id
//   POST /supplier-payments/recompute-pi-paid — REWRITE another company's payable
//   GET  /supplier-payments/debug/last-restate-error — read another company's error
//
// The middle one is the sharp edge: it overwrites purchase_invoices.paid_amount_sen
// and status outright, so unscoped it is a cross-tenant WRITE to the books, not a
// disclosure. It was found while triaging an abandoned branch that tried to fix
// the same class in 1,180 lines; this is the same fix in three predicates.
//
// One company uses the system today, so none of this is exploitable right now.
// It becomes exploitable the moment a second one is onboarded, which is exactly
// when nobody will re-audit payments — hence the pins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const payments = read("../src/api/routes/payments.ts");
const supplier = read("../src/api/routes/supplier-payments.ts");

/**
 * Strip // and /* *\/ comments.
 *
 * Needed because an assertion like "this handler must not mention 403" happily
 * matches the COMMENT that explains why it must not mention 403 — which is what
 * happened the first time this file was written. A test that reads its own
 * prose is not testing anything.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:])\/\/.*$/gm, "$1");
}

/** A handler body, from `app.<verb>("<path>"` to the next top-level `app.`. */
function handler(src, verb, path) {
  const start = src.indexOf(`app.${verb}("${path}"`);
  assert.notEqual(start, -1, `no handler for ${verb.toUpperCase()} ${path}`);
  const next = src.indexOf("\napp.", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

/** Every app.<verb>("<path>" in a route file, with its body. */
function allHandlers(src) {
  const out = [];
  const re = /^app\.(get|post|put|patch|delete)\("([^"]+)"/gm;
  let m;
  const starts = [];
  while ((m = re.exec(src))) starts.push({ verb: m[1], path: m[2], at: m.index });
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length;
    out.push({ ...starts[i], body: src.slice(starts[i].at, end) });
  }
  return out;
}

test("reading one payment cannot reach another company's books", () => {
  const h = handler(payments, "get", "/:id");
  assert.match(h, /FROM payment_records WHERE id = \? AND org_id = \?/);
  assert.match(h, /getOrgId\(c\)/);
});

test("a payment that is not yours reads as 404, never 403", () => {
  // "Not found" and "not yours" must be indistinguishable, or the endpoint
  // becomes a way to confirm an id exists in someone else's ledger.
  const h = code(handler(payments, "get", "/:id"));
  assert.match(h, /"Payment not found"/);
  assert.doesNotMatch(h, /\b403\b/, "an ownership failure must not be distinguishable");
});

test("the PI repair cannot rewrite another company's payable", () => {
  // The sharpest of the three: this overwrites paid_amount_sen and status.
  const h = handler(supplier, "post", "/recompute-pi-paid");
  assert.match(h, /FROM purchase_invoices WHERE id = \? AND org_id = \?/);
  assert.match(h, /\.bind\(piId, getOrgId\(c\)\)/);
});

test("the restate error log is per company, both writing and reading", () => {
  assert.match(supplier, /`last_supplier_restate_error:\$\{getOrgId\(c\)\}`/);
  // The old global key must be gone from BOTH sides, or one of them keeps
  // pointing at a shared row.
  assert.doesNotMatch(
    supplier,
    /'last_supplier_restate_error'/,
    "a bare global key is still in use somewhere",
  );
});

test("no payment handler is left without a company predicate", () => {
  // The sweep, so the next handler added here cannot quietly skip it. Listing
  // the exemptions by name is the point: an exemption should be a decision
  // someone wrote down, not an omission nobody noticed.
  const EXEMPT = new Set([
    // (none — every handler in these two files is tenant-scoped)
  ]);
  const missing = [];
  for (const src of [payments, supplier]) {
    for (const h of allHandlers(src)) {
      const key = `${h.verb} ${h.path}`;
      if (EXEMPT.has(key)) continue;
      if (!/getOrgId\(c\)/.test(h.body)) missing.push(key);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `payment handlers with no company scoping:\n  ${missing.join("\n  ")}`,
  );
});
