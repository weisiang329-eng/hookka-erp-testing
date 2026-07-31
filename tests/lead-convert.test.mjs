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

test("convert runs the 3-step flow: create customer → attach hub → re-point", () => {
  const src = readFileSync(FE, "utf8");
  const i = src.indexOf("const submit = async ()");
  assert.ok(i !== -1, "ConvertLeadDialog.submit must exist");
  const body = src.slice(i, src.indexOf("setBusy(false);", i));
  const create = body.indexOf('fetch("/api/customers"');
  const hub = body.indexOf("method: \"PUT\"");
  const convert = body.indexOf("/convert`");
  assert.ok(create !== -1, "step 1 POST /api/customers");
  assert.ok(hub !== -1, "step 2 PUT hub");
  assert.ok(convert !== -1, "step 3 POST convert");
  assert.ok(create < hub && hub < convert, "steps must run create → hub → convert in order");
});
