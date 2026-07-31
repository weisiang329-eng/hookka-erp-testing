// ---------------------------------------------------------------------------
// lead-convert.test.mjs — CRM redesign slice 2: convert a WON lead into a
// formal customer (owner 2026-07-30). The approval gate (Credit Code, Name,
// Delivery Hub, PIC, PIC Contact, Terms, Credit Limit) is collected, the
// customer is created via the canonical endpoint, and the lead's CRM record
// (contacts, activity, KYC) is MOVED onto the new customer. Wishlist was
// retired 2026-08-01; its table is still re-pointed so old rows stay coherent.
// See docs/plans/2026-07-30-crm-unified-customer.md.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const API = resolve(process.cwd(), "src/api/routes/sales-leads.ts");
const FE = resolve(process.cwd(), "src/pages/leads/index.tsx");
const api = readFileSync(API, "utf8");
const apiFlat = api.replace(/\s+/g, " ");
const feFlat = readFileSync(FE, "utf8").replace(/\s+/g, " ");

// ===========================================================================
// Backend — /api/sales-leads/:id/convert
// ===========================================================================

test("convert endpoint exists and is RBAC-gated on customers", () => {
  assert.match(apiFlat, /app\.post\("\/:id\/convert"/);
  assert.match(apiFlat, /app\.post\("\/:id\/convert"[\s\S]*?requirePermission\(c, "customers", "update"\)/);
});

test("convert re-points every entity-keyed CRM side-table to the new customer", () => {
  // Allowlisted tables (never user input) → safe to interpolate.
  for (const t of ["customer_contacts", "customer_activities", "customer_wishlist", "customer_onboarding"]) {
    assert.match(apiFlat, new RegExp(`"${t}"`), `${t} must be in the re-point allowlist`);
  }
  assert.match(apiFlat, /UPDATE \$\{table\} SET customer_id = \? WHERE customer_id = \? AND org_id = \?/);
});

test("convert stamps the lead WON and links won_customer_id", () => {
  assert.match(apiFlat, /UPDATE sales_leads SET stage = 'WON', won_customer_id = \?/);
});

test("convert requires a customerId (customer created by the canonical endpoint)", () => {
  assert.match(apiFlat, /customerId required/);
});

// ===========================================================================
// Frontend — Convert dialog + 3-step flow
// ===========================================================================

test("drawer offers Convert (and shows Converted once linked)", () => {
  assert.match(feFlat, /Convert to customer/);
  assert.match(feFlat, /alreadyCustomer = !!lead\.won_customer_id/);
  assert.match(feFlat, /alreadyCustomer \?[\s\S]*?Converted to customer/);
});

test("convert dialog collects the full approval gate", () => {
  // Credit Code, Name, Terms, Credit Limit, PIC, PIC contact, Delivery hub.
  assert.match(feFlat, /Credit Code \*/);
  assert.match(feFlat, /Customer Name \*/);
  assert.match(feFlat, /Terms/);
  assert.match(feFlat, /Credit Limit \(RM\)/);
  assert.match(feFlat, /Person in charge \(PIC\)/);
  assert.match(feFlat, /Delivery hub/);
  // State uses the shared hub-state-code picker (system-wide standardization).
  assert.match(feFlat, /<StateSelect value=\{f\.hubState\}/);
});

test("confirm runs: promote the existing account → attach hub → re-point", () => {
  // Rewritten 2026-08-01. The dialog no longer CREATES the customer — the
  // account was minted as POTENTIAL when the lead was entered, and has been
  // carrying SKU assignments, combos and quotations ever since. Confirming
  // promotes that SAME row; minting a second one would strand all of it.
  const src = readFileSync(FE, "utf8");
  const i = src.indexOf("const submit = async ()");
  assert.ok(i !== -1, "ConvertLeadDialog.submit must exist");
  const body = src.slice(i, src.indexOf("setBusy(false);", i));

  const confirm = body.indexOf("customerStage: \"CONFIRMED\"");
  const hub = body.indexOf("deliveryHubs: [{");
  const convert = body.indexOf("/convert`");
  assert.ok(confirm !== -1, "step 1 must promote the account to CONFIRMED");
  assert.ok(hub !== -1, "step 2 attach hub");
  assert.ok(convert !== -1, "step 3 POST convert");
  assert.ok(confirm < hub && hub < convert, "steps must run confirm → hub → convert in order");

  // The create path still exists, but ONLY as the fallback for a lead with no
  // customer_id — i.e. one from before this change, or whose best-effort
  // customer create failed. It must not be the primary path.
  assert.ok(
    body.includes("const existingCustomerId = String(lead.customer_id"),
    "confirm must key off the lead's existing customer",
  );
  assert.ok(
    body.indexOf("} else {") < body.indexOf('fetch("/api/customers"'),
    "POST /api/customers must sit in the else (legacy) branch",
  );
});
