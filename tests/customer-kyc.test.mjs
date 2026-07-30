// ---------------------------------------------------------------------------
// customer-kyc.test.mjs — pins the CRM onboarding/KYC slice (owner 2026-07-30):
// collect consent letter + TIN + e-Invoice + SSM before extending credit.
// Structural pins; live UX verified on staging.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../src/api/routes/customer-crm.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("../src/components/customer/KycPanel.tsx", import.meta.url), "utf8");
const customers = readFileSync(new URL("../src/pages/customers.tsx", import.meta.url), "utf8");

test("onboarding endpoints exist, gated + tenant-scoped, with a self-applied table", () => {
  assert.match(route, /CREATE TABLE IF NOT EXISTS customer_onboarding/);
  assert.match(route, /app\.get\("\/onboarding"/);
  assert.match(route, /app\.put\("\/onboarding"/);
  assert.match(route, /ON CONFLICT\(customer_id\) DO UPDATE/, "PUT upserts the KYC block");
  assert.match(route, /getOrgId\(c\)/);
});

test("KYC panel captures TIN + e-Invoice + consent + docs-requested, and is mounted", () => {
  assert.match(panel, /export function KycPanel/);
  assert.match(panel, /\/api\/customer-crm\/onboarding/);
  for (const f of [/tinNumber/, /einvoiceId/, /consentReceived/, /docsRequestedAt/]) {
    assert.match(panel, f, `KYC form must capture ${f}`);
  }
  assert.match(customers, /import \{ KycPanel \} from "@\/components\/customer\/KycPanel"/);
  assert.match(customers, /<KycPanel customerId=\{cust\.id\}/);
});
