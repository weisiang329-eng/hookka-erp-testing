// ---------------------------------------------------------------------------
// customer-stage.test.mjs — POTENTIAL vs CONFIRMED customers (owner 2026-08-01).
//
// A customer created from the Sales Pipeline is POTENTIAL: quotable and
// SKU-assignable, but NOT billable. It becomes CONFIRMED through the Confirm
// gate, which is the only place a creditor code / terms / credit limit are set.
//
// The load-bearing guarantee is the last group: a POTENTIAL customer can never
// reach a money document. That is enforced server-side, because a picker filter
// is a convenience and not a control.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles the .ts import */
}

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

// ---- stageOf: dual-keyed, and safe-by-default -------------------------------

test("stageOf reads BOTH camelCase and snake_case (Supabase driver transform)", async () => {
  const { stageOf } = await import("../src/api/lib/customer-stage.ts");
  // The driver returns camelCase; the DDL declares snake_case. Both must work —
  // a snake-only read would silently mark every customer CONFIRMED.
  assert.equal(stageOf({ customerStage: "POTENTIAL" }), "POTENTIAL");
  assert.equal(stageOf({ customer_stage: "POTENTIAL" }), "POTENTIAL");
  assert.equal(stageOf({ customerStage: "potential" }), "POTENTIAL", "case-insensitive");
  assert.equal(stageOf({ customerStage: "CONFIRMED" }), "CONFIRMED");
});

test("stageOf defaults to CONFIRMED for rows that predate the column", async () => {
  const { stageOf } = await import("../src/api/lib/customer-stage.ts");
  // Every customer that existed before 2026-08-01 is a real, billable account.
  // Defaulting the other way would lock the whole customer base out of sales.
  assert.equal(stageOf({}), "CONFIRMED");
  assert.equal(stageOf(null), "CONFIRMED");
  assert.equal(stageOf({ customerStage: "" }), "CONFIRMED");
  assert.equal(stageOf({ customerStage: "something-else" }), "CONFIRMED");
});

// ---- the billable boundary --------------------------------------------------

function dbWith(row) {
  return {
    prepare() {
      return { bind() { return this; }, async first() { return row; } };
    },
  };
}

test("assertCustomerBillable REJECTS a potential customer", async () => {
  const { assertCustomerBillable } = await import("../src/api/lib/customer-stage.ts");
  const res = await assertCustomerBillable(
    dbWith({ id: "c1", name: "Carress", customerStage: "POTENTIAL" }),
    "c1",
    "a sales order",
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /potential customer/i);
  assert.match(res.error, /a sales order/, "the message names the document");
  assert.match(res.error, /Confirm/, "the message says how to fix it");
});

test("assertCustomerBillable ALLOWS a confirmed customer and legacy rows", async () => {
  const { assertCustomerBillable } = await import("../src/api/lib/customer-stage.ts");
  assert.equal(
    (await assertCustomerBillable(dbWith({ id: "c1", customerStage: "CONFIRMED" }), "c1")).ok,
    true,
  );
  // Row with no stage column yet (pre-migration) — must not block sales.
  assert.equal((await assertCustomerBillable(dbWith({ id: "c1" }), "c1")).ok, true);
  // Missing customer / blank id are the caller's own validation problem.
  assert.equal((await assertCustomerBillable(dbWith(null), "nope")).ok, true);
  assert.equal((await assertCustomerBillable(dbWith(null), "")).ok, true);
});

test("assertCustomerBillable fails OPEN if the lookup throws", async () => {
  const { assertCustomerBillable } = await import("../src/api/lib/customer-stage.ts");
  const boom = { prepare() { throw new Error("schema race"); } };
  // Blocking every sales order on a transient schema race would be worse than
  // briefly missing the guard — and a POTENTIAL customer cannot exist at all
  // until that same column does.
  assert.equal((await assertCustomerBillable(boom, "c1")).ok, true);
});

// ---- wiring -----------------------------------------------------------------

test("sales order create is gated — the single choke point for the money chain", () => {
  const f = flat("src/api/routes/sales-orders.ts");
  assert.match(f, /import \{ assertCustomerBillable \} from "\.\.\/lib\/customer-stage"/);
  assert.match(f, /await assertCustomerBillable\( c\.var\.DB, body\.customerId, "a sales order", \)/);
  // Invoices and DOs derive from SOs/POs and take no customerId of their own,
  // so gating SO create covers the whole downstream chain.
});

test("customer_stage + salesperson_user_id are runtime self-applied", () => {
  // The ensure lives in the shared lib because sales-leads.ts also inserts a
  // customer row and needs the same guarantee before writing customer_stage.
  const lib = flat("src/api/lib/customer-stage.ts");
  // Migrations are inert on deploy — a column reaches prod ONLY this way.
  assert.match(lib, /ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_stage TEXT NOT NULL DEFAULT 'CONFIRMED'/);
  assert.match(lib, /ALTER TABLE customers ADD COLUMN IF NOT EXISTS salesperson_user_id TEXT/);
  const f = flat("src/api/routes/customers.ts");
  assert.match(f, /import \{ ensureCustomerStageColumns \} from "\.\.\/lib\/customer-stage"/);
  // sales-leads must ensure them too before it mints a POTENTIAL customer.
  assert.match(flat("src/api/routes/sales-leads.ts"), /await ensureCustomerStageColumns\(c\.var\.DB\)/);
  // Awaited on the read AND both write paths.
  assert.match(f, /app\.get\("\/", async \(c\) => \{[\s\S]*?ensureCustomerStageColumns/);
  assert.match(f, /app\.post\("\/", async \(c\) => \{[\s\S]*?ensureCustomerStageColumns/);
  assert.match(f, /app\.put\("\/:id", async \(c\) => \{[\s\S]*?ensureCustomerStageColumns/);
});

test("creditor code is optional for POTENTIAL, mandatory to CONFIRM", () => {
  const f = flat("src/api/routes/customers.ts");
  // POST: a pipeline-born customer has no code yet.
  assert.match(f, /if \(stage === "CONFIRMED" && !code\)/);
  // PUT: the Confirm gate is where it stops being optional.
  assert.match(f, /if \(nextStage === "CONFIRMED" && !mergedCode\)/);
  assert.match(f, /a creditor code is required to confirm this customer/);
});

test("a confirmed customer cannot be demoted back to potential", () => {
  const f = flat("src/api/routes/customers.ts");
  // It may already carry invoices; silently making it unusable on new
  // documents would be a worse surprise than a 400.
  assert.match(f, /if \(prevStage === "CONFIRMED" && nextStage === "POTENTIAL"\)/);
  assert.match(f, /a confirmed customer cannot be moved back to potential/);
});

test("the API surfaces customerStage + salespersonUserId on every customer read", () => {
  const f = flat("src/api/routes/customers.ts");
  assert.match(f, /customerStage: readCustomerStage\(/);
  assert.match(f, /salespersonUserId: readSalespersonUserId\(/);
});

// ---- Customers page UI ------------------------------------------------------

test("customers list filters by stage and scopes the KPI tiles to it", () => {
  const f = flat("src/pages/customers.tsx");
  // Defaults to CONFIRMED: a salesperson filling the pipeline must not quietly
  // change what the accounts team sees on this page.
  assert.match(f, /useState<"CONFIRMED" \| "POTENTIAL" \| "ALL">\("CONFIRMED"\)/);
  // Rows with no stage (pre-migration) count as CONFIRMED.
  assert.match(f, /data\.filter\(\(c\) => \(c\.customerStage \?\? "CONFIRMED"\) === stageFilter\)/);
  // The money tiles read the SCOPED list, not the raw one — a potential
  // customer has no A/R and would misstate Total Outstanding / Credit Limit.
  for (const k of ["totalCustomers", "totalHubs", "totalOutstanding", "totalCreditLimit"]) {
    assert.match(
      f,
      new RegExp(`const ${k} = stageScoped`),
      `${k} must be computed from stageScoped, not the unfiltered list`,
    );
  }
  // The grid too.
  assert.match(f, /: stageScoped;/);
});

test("salesperson is stored as users.id and rendered as a name", () => {
  const f = flat("src/pages/customers.tsx");
  assert.match(f, /useCachedJson<[\s\S]*?>\("\/api\/users"\)/);
  // publicUser() exposes displayName + email — NOT name/fullName/username.
  assert.match(f, /u\.displayName \|\| ""/);
  assert.match(f, /String\(u\.email \|\| ""\)/);
  // Column renders through the id→name map.
  assert.match(f, /key: "salespersonUserId", label: "Salesperson"/);
  assert.match(f, /salespersonName\.get\(row\.salespersonUserId\)/);
  // A deactivated user's assignment must survive an unrelated dialog save.
  assert.match(f, /!salespeople\.some\(\(s\) => s\.id === editCustForm\.salespersonUserId\)/);
});

// ---- Phase 4: the lead IS the potential customer ----------------------------

test("creating a lead also mints its POTENTIAL customer — best-effort", () => {
  const f = flat("src/api/routes/sales-leads.ts");
  assert.match(f, /ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS customer_id TEXT/);
  // Asserts the STAGE, not the shape of the rest of the statement. This used to
  // be /'POTENTIAL'\)`/ — pinned to POTENTIAL being the LAST value in the
  // INSERT — so adding the orgId column that stopped leads minting cross-org
  // customers (2026-08-13) failed a test whose stated intent it never touched.
  // An assertion tied to a neighbouring column's position tests the author's
  // formatting, not the behaviour it names.
  assert.match(f, /'POTENTIAL'/, "the minted customer must be born POTENTIAL");
  // No creditor code at this point — that is the Confirm gate's job.
  assert.match(f, /INSERT INTO customers \(id, code, name,[\s\S]*?VALUES \(\?, '',/);
  assert.match(f, /UPDATE sales_leads SET customer_id = \?/);
  // Wrapped in try/catch on purpose: losing the salesperson's typed-in lead
  // because a customer insert hiccuped would be far worse than a lead whose
  // account gets created later at Confirm.
  assert.match(f, /catch \(e\) \{ console\.warn\("\[sales-leads\] potential-customer create failed/);
});

test("Confirm promotes the EXISTING customer instead of minting a second one", () => {
  const f = flat("src/pages/leads/index.tsx");
  // Promoting the same row is what keeps the SKU assignments, combos and
  // quotations that were attached while the account was potential.
  assert.match(f, /customerStage: "CONFIRMED" as const/);
  assert.match(f, /const existingCustomerId = String\(lead\.customer_id \?\? ""\)\.trim\(\)/);
  assert.match(f, /if \(existingCustomerId\) \{ const res = await fetch\(`\/api\/customers\/\$\{existingCustomerId\}`, \{ method: "PUT"/);
  // Legacy leads (pre-2026-08-01, or whose best-effort create failed) have no
  // customer_id and must still be convertible.
  assert.match(f, /\} else \{ const createRes = await fetch\("\/api\/customers", \{ method: "POST"/);
  assert.match(f, /Confirm customer<\/h2>/);
});
