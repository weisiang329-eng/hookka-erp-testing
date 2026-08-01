// ---------------------------------------------------------------------------
// potential-customer-followups.test.mjs
//
// Three gaps left over after the POTENTIAL/CONFIRMED split shipped (#154):
//
//   1. The SO customer picker still LISTED potential customers. The server
//      refused them (assertCustomerBillable), but only on save - so an
//      operator could pick one, fill in the whole order, and lose the trip.
//      Owner, unambiguously: "potential customer 不可以开 SO 啊怎么可能可以呢".
//   2. The Customers page could not CREATE a potential customer at all: the
//      form always posted without a stage, so the server treated it as
//      CONFIRMED and demanded a creditor code. Owner wanted both entry points.
//   3. Email sent only the quotation. Owner asked for a dropdown to choose
//      quotation vs catalogue.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

test("SO create + edit pickers exclude POTENTIAL customers", () => {
  for (const p of ["src/pages/sales/create.tsx", "src/pages/sales/edit.tsx"]) {
    const f = flat(p);
    assert.match(
      f,
      /\(customersResp\?\.data \|\| \[\]\)\.filter\( \(c\) => \(c\.customerStage \?\? "CONFIRMED"\) !== "POTENTIAL", \)/,
      p + " must filter potential customers out of the picker",
    );
  }
});

test("the picker filter treats a missing stage as CONFIRMED", () => {
  // Rows predating the column are real accounts. Defaulting the other way
  // would empty the picker on deploy.
  const f = flat("src/pages/sales/create.tsx");
  assert.match(f, /c\.customerStage \?\? "CONFIRMED"/);
});

test("the UI filter is a convenience, NOT the control", () => {
  // The server guard must still exist - a picker filter is bypassable by any
  // API caller, import, or stale tab.
  const so = flat("src/api/routes/sales-orders.ts");
  assert.match(so, /assertCustomerBillable/);
});

test("Customers page creates a POTENTIAL when standing on the Potential tab", () => {
  const f = flat("src/pages/customers.tsx");
  assert.match(f, /const addingPotential = stageFilter === "POTENTIAL"/);
  assert.match(f, /customerStage: addingPotential \? "POTENTIAL" : "CONFIRMED"/);
});

test("creditor code is optional for a potential, required for a confirmed", () => {
  const f = flat("src/pages/customers.tsx");
  // Format check only when a code was actually typed.
  assert.match(f, /if \(addForm\.code\.trim\(\)\) \{ const dv = parseDebtorCode/);
  // ...and a confirmed customer still cannot be created without one.
  assert.match(f, /\} else if \(!addingPotential\) \{/);
  assert.match(f, /A creditor code is required for a confirmed customer/);
  // Submit gate matches: name always, code only when confirming.
  assert.match(
    f,
    /disabled=\{!addForm\.name \|\| \(!addingPotential && !addForm\.code\) \|\| addSaving\}/,
  );
});

test("Email offers Quotation OR Catalogue and both reuse their Export PDF", () => {
  const f = flat("src/pages/customers.tsx");
  assert.match(f, /value=\{emailDocKind\}/);
  assert.match(f, /<option value="QUOTATION">Quotation<\/option>/);
  assert.match(f, /<option value="CATALOGUE">Catalogue<\/option>/);
  // The catalogue send path is the SAME builder as the export, parameterised -
  // so the emailed file can never drift from the downloaded one.
  assert.match(f, /const handleExportCataloguePdf = async \(emailTo\?: string\)/);
  assert.match(f, /if \(emailTo\) \{/);
  // Export button must not pass its click event as a recipient.
  assert.match(f, /onClick=\{\(\) => void handleExportCataloguePdf\(\)\}/);
});

test("sending always confirms the recipient first", () => {
  // Outward action: the operator sees who it goes to and can correct it.
  const f = flat("src/pages/customers.tsx");
  assert.match(f, /const askRecipient = async \(label: string\)/);
  assert.match(f, /window\.prompt\( `Email this \$\{label\} to which address\?`/);
  assert.match(f, /That doesn't look like a valid email address/);
  assert.match(f, /title: `Send \$\{label\}\?`/);
});
