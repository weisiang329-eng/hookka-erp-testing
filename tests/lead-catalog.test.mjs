// ---------------------------------------------------------------------------
// lead-catalog.test.mjs — CRM slice 3: provisional catalog + target prices on a
// lead, merged into customer_products on convert (owner 2026-07-30).
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

test("lead_products table is runtime self-applied + kept OFF customer_products", () => {
  assert.match(apiFlat, /CREATE TABLE IF NOT EXISTS lead_products \(/);
  // Provisional table is separate — it must NOT be customer_products (which
  // joins into pricing/quotations); an unconfirmed lead can't leak into pricing.
  assert.match(apiFlat, /lead_id TEXT NOT NULL/);
});

test("lead-products GET/POST/DELETE exist, RBAC-gated", () => {
  assert.match(apiFlat, /app\.get\("\/lead-products"/);
  assert.match(apiFlat, /app\.post\("\/lead-products"/);
  assert.match(apiFlat, /app\.delete\("\/lead-products\/:id"/);
  assert.match(apiFlat, /app\.post\("\/lead-products"[\s\S]*?requirePermission\(c, "customers", "update"\)/);
});

test("convert copies the lead's catalog into customer_products (SKU-linked, idempotent)", () => {
  const start = api.indexOf('app.post("/:id/convert"');
  const body = api.slice(start, api.indexOf("\n});", start));
  assert.match(body, /FROM lead_products WHERE lead_id = \? AND org_id = \? AND product_id IS NOT NULL/);
  // INSERT OR IGNORE keeps it safe against the UNIQUE(customerId, productId).
  assert.match(body, /INSERT OR IGNORE\s+INTO customer_products/);
});

test("Lead detail drawer mounts the catalog panel wired to lead-products", () => {
  assert.match(feFlat, /<LeadCatalogPanel leadId=\{lead\.id\} \/>/);
  assert.match(feFlat, /function LeadCatalogPanel\(\{ leadId \}/);
  assert.match(feFlat, /\/api\/sales-leads\/lead-products\?leadId=/);
  assert.match(feFlat, /method: "POST"[\s\S]*?\/api\/sales-leads\/lead-products|\/api\/sales-leads\/lead-products[\s\S]*?method: "POST"/);
});
