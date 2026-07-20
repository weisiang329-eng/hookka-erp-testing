import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const schemas = await import(
  pathToFileURL(
    resolve(process.cwd(), "src/lib/schemas/payment-request.ts"),
  ).href
);

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");

test("customer payment contract accepts the current frontend payload", () => {
  const result = schemas.CustomerPaymentCreateRequestSchema.safeParse({
    customerId: "cust-1",
    amount: 12_345,
    method: "BANK_TRANSFER",
    reference: "REF-1",
    bankAccount: "310-0010",
    date: "2026-07-20",
    allocations: [
      { invoiceId: "inv-1", amount: 10_000 },
      { invoiceId: "inv-2", amount: 2_345 },
    ],
  });
  assert.equal(result.success, true);
});

test("customer payment rejects GL amount / allocation drift", () => {
  const result = schemas.CustomerPaymentCreateRequestSchema.safeParse({
    customerId: "cust-1",
    amount: 20_000,
    method: "BANK_TRANSFER",
    allocations: [{ invoiceId: "inv-1", amount: 10_000 }],
  });
  assert.equal(result.success, false);
  assert.match(result.error.issues[0].message, /must equal allocation total/);
});

test("customer payment rejects duplicate invoice allocations", () => {
  const result = schemas.CustomerPaymentCreateRequestSchema.safeParse({
    customerId: "cust-1",
    amount: 20_000,
    method: "BANK_TRANSFER",
    allocations: [
      { invoiceId: "inv-1", amount: 10_000 },
      { invoiceId: "inv-1", amount: 10_000 },
    ],
  });
  assert.equal(result.success, false);
  assert.match(
    result.error.issues.map((issue) => issue.message).join("\n"),
    /allocated more than once/,
  );
});

test("customer payment restate validates dates, amounts, and duplicate invoices", () => {
  const valid = schemas.CustomerPaymentRestateRequestSchema.safeParse({
    method: "BANK_TRANSFER",
    date: "2026-07-20",
    allocations: [{ invoiceId: "inv-1", amount: 10_000 }],
  });
  const invalid = schemas.CustomerPaymentRestateRequestSchema.safeParse({
    date: "20/07/2026",
    allocations: [
      { invoiceId: "inv-1", amount: 10_000 },
      { invoiceId: "inv-1", amount: 5_000 },
    ],
  });
  assert.equal(valid.success, true);
  assert.equal(invalid.success, false);
  const messages = invalid.error.issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /Invalid ISO date/);
  assert.match(messages, /allocated more than once/);
});

test("supplier payment accepts allocations or an explicit advance", () => {
  const allocation = schemas.SupplierPaymentCreateRequestSchema.safeParse({
    supplierId: "sup-1",
    payFrom: "310-0010",
    date: "2026-07-20",
    allocations: [{ piId: "pi-1", payMyrSen: 10_000 }],
  });
  const advance = schemas.SupplierPaymentCreateRequestSchema.safeParse({
    supplierId: "sup-1",
    payFrom: "310-0010",
    date: "2026-07-20",
    advanceSen: 10_000,
  });
  assert.equal(allocation.success, true);
  assert.equal(advance.success, true);
});

test("supplier payment rejects duplicate PIs and malformed dates", () => {
  const result = schemas.SupplierPaymentCreateRequestSchema.safeParse({
    supplierId: "sup-1",
    payFrom: "310-0010",
    date: "20/07/2026",
    allocations: [
      { piId: "pi-1", payMyrSen: 10_000 },
      { piId: "pi-1", payMyrSen: 5_000 },
    ],
  });
  assert.equal(result.success, false);
  const messages = result.error.issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /Invalid ISO date/);
  assert.match(messages, /allocated more than once/);
});

test("customer payment create scopes every party and money write to orgId", () => {
  const source = read("src/api/routes/payments.ts");
  assert.match(source, /customers WHERE id = \? AND orgId = \?/);
  assert.match(
    source,
    /FROM invoices\s+WHERE id IN \([^\n]+\) AND orgId = \? AND customerId = \?/,
  );
  assert.match(source, /allocations, orgId\s+\) VALUES/);
  assert.match(source, /reference, orgId\)\s+VALUES/);
  assert.match(source, /WHERE id = \? AND orgId = \? AND customerId = \?/);
  assert.match(source, /customers SET outstandingSen[\s\S]+WHERE id = \? AND orgId = \?/);
});

test("customer payment read, status, lifecycle, and restate paths fail closed by org", () => {
  const source = read("src/api/routes/payments.ts");
  assert.doesNotMatch(
    source,
    /payment_records WHERE id = \?['"`]/,
    "no payment read may authorize by id alone",
  );
  assert.doesNotMatch(
    source,
    /UPDATE payment_records SET[\s\S]{0,300}WHERE id = \?['"`]/,
    "no payment update may authorize by id alone",
  );
  assert.match(
    source,
    /PAYMENT_ALLOCATION_SCOPE_MISMATCH/,
    "restate must reject invoices outside the receipt customer/org",
  );
  assert.match(
    source,
    /WHERE id IN \([^\n]+\) AND orgId = \? AND customerId = \?/,
  );
});

test("supplier payment create scopes PI/account/supplier reads and writes", () => {
  const source = read("src/api/routes/supplier-payments.ts");
  assert.match(source, /suppliers WHERE id = \? AND orgId = \?/);
  assert.match(source, /chart_of_accounts WHERE code = \? AND orgId = \?/);
  assert.match(
    source,
    /FROM purchase_invoices\s+WHERE id = \? AND orgId = \? AND supplier_id = \?/,
  );
  assert.match(
    source,
    /UPDATE purchase_invoices[\s\S]+WHERE id = \? AND orgId = \? AND supplier_id = \?/,
  );
});

test("supplier knock-off, lifecycle, restate, and repair stay inside org", () => {
  const source = read("src/api/routes/supplier-payments.ts");
  assert.doesNotMatch(
    source,
    /supplier_payments WHERE id = \?['"`]/,
    "supplier payment rows may not be selected by id alone",
  );
  assert.doesNotMatch(
    source,
    /supplier_payments WHERE payment_no = \?\s+AND COALESCE/,
    "payment-number operations must bind org before other filters",
  );
  assert.doesNotMatch(
    source,
    /purchase_invoices WHERE id = \?['"`]/,
    "purchase invoices may not be selected by id alone",
  );
  assert.match(source, /sp\.org_id = purchase_invoices\.org_id/);
  assert.match(source, /dl\.org_id = sp\.org_id/);
  assert.match(
    source,
    /WHERE id = \? AND org_id = \?`/,
    "the absolute paid-amount truth guard must scope its target PI",
  );
});

test("Postgres rejects concurrent overpayment at the database boundary", () => {
  const migration = read(
    "migrations-postgres/0210_payment_balance_guards.sql",
  );
  assert.match(
    migration,
    /CHECK \(paid_amount >= 0 AND paid_amount <= total_sen\) NOT VALID/,
  );
  assert.match(
    migration,
    /CHECK \(paid_amount_sen >= 0 AND paid_amount_sen <= amount_sen\) NOT VALID/,
  );
});
