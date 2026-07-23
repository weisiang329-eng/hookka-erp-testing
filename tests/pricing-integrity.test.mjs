// ---------------------------------------------------------------------------
// pricing-integrity.test.mjs
//
// Tests protect the code; this check protects the DATA. Three price defects ran
// for months (RM 12,455 heights, RM 8,060 specials, RM 17,910 invoice-below-SO)
// and every one was a one-line SQL invariant nobody was running.
//
// What is pinned here: the check must NEVER be able to take down the daily
// report, must not invent money when it cannot read the price list, and must
// report what we are failing to bill in sen.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { checkPricingIntegrity } from "../src/api/lib/pricing-integrity.ts";

const CONFIG = JSON.stringify({
  divanHeights: [
    { value: '8"', priceSen: 0 },
    { value: '10"', priceSen: 5500 },
    { value: '12"', priceSen: 13000 },
  ],
  legHeights: [{ value: '7"', priceSen: 16000 }],
});

/** Minimal stub matching the DbLike the daily report passes in. */
function fakeDb({ config = CONFIG, unitRows = [], heightRows = [], invoiceRows = [], throwOn = null } = {}) {
  return {
    prepare(sql) {
      return {
        bind() {
          const pick = () => {
            if (sql.includes("kv_config")) return { first: async () => (config === null ? null : { value: config }) };
            if (throwOn && sql.includes(throwOn)) {
              return { all: async () => { throw new Error("boom"); } };
            }
            // Order matters: the invoice query also mentions unitPriceSen and "<>".
            if (sql.includes("invoice_items")) return { all: async () => ({ results: invoiceRows }) };
            if (sql.includes("divanHeightInches")) return { all: async () => ({ results: heightRows }) };
            if (sql.includes("unitPriceSen")) return { all: async () => ({ results: unitRows }) };
            return { all: async () => ({ results: [] }), first: async () => null };
          };
          return { ...pick(), first: async () => (sql.includes("kv_config") ? (config === null ? null : { value: config }) : null) };
        },
      };
    },
  };
}

test("a height the owner's list prices, stored at 0, is reported with the money owed", async () => {
  const out = await checkPricingIntegrity(
    fakeDb({
      heightRows: [
        { companySOId: "SO-2607-001", status: "READY_TO_SHIP", lineNo: 1, productCode: "1007-(Q)", quantity: 2, divanHeightInches: 10, divanPriceSen: 0, legHeightInches: 1, legPriceSen: 0 },
      ],
    }),
  );
  const hit = out.find((r) => r.kind === "HEIGHT_CHOSEN_BUT_FREE");
  assert.ok(hit, "the RM 12,455 shape must be caught");
  assert.equal(hit.amountSen, 11000, "RM 55 x qty 2");
  assert.match(hit.ref, /SO-2607-001 L1/);
});

test("a height the list prices at 0 is NOT an issue", async () => {
  const out = await checkPricingIntegrity(
    fakeDb({
      heightRows: [
        { companySOId: "SO-1", status: "READY_TO_SHIP", lineNo: 1, productCode: "X", quantity: 1, divanHeightInches: 8, divanPriceSen: 0, legHeightInches: null, legPriceSen: 0 },
      ],
    }),
  );
  assert.equal(out.length, 0, "8\" is the standard height and free — reporting it would be noise");
});

test("an unreadable price list reports NOTHING rather than guessing", async () => {
  const out = await checkPricingIntegrity(
    fakeDb({
      config: null,
      heightRows: [
        { companySOId: "SO-1", status: "READY_TO_SHIP", lineNo: 1, productCode: "X", quantity: 1, divanHeightInches: 10, divanPriceSen: 0, legHeightInches: null, legPriceSen: 0 },
      ],
    }),
  );
  assert.equal(out.length, 0, "no config = no opinion; never invent a price");
});

test("unit price that is not the sum of its parts is reported", async () => {
  const out = await checkPricingIntegrity(
    fakeDb({
      unitRows: [
        { companySOId: "SO-2", lineNo: 3, productCode: "2008(A)-(K)", quantity: 1, unitPriceSen: 83000, basePriceSen: 83000, divanPriceSen: 5500, legPriceSen: 0, specialOrderPriceSen: 0 },
      ],
    }),
  );
  const hit = out.find((r) => r.kind === "UNIT_NOT_SUM_OF_PARTS");
  assert.ok(hit);
  assert.equal(hit.amountSen, 5500, "the dropped divan component is the money at stake");
});

test("an invoice line below its SO line is reported", async () => {
  const out = await checkPricingIntegrity(
    fakeDb({
      invoiceRows: [
        // keys match what the SupabaseAdapter returns for `AS so_unit_sen` /
        // `AS inv_unit_sen` — snake_case alias → camelCase key. On prod these
        // came back undefined until 2026-07-23 because the alias was `AS soUnit`.
        { invoiceNo: "INV-2607-089", status: "SENT", companySOId: "SO-2607-113", lineNo: 2, productCode: "1003(A)-(Q)", soUnitSen: 83000, invUnitSen: 58500, quantity: 1 },
      ],
    }),
  );
  const hit = out.find((r) => r.kind === "INVOICE_BELOW_SO");
  assert.ok(hit, "the real prod case must be caught");
  assert.equal(hit.amountSen, 24500, "RM 245 — the line found by hand on 2026-07-22");
});

test("results are ordered worst-first", async () => {
  const out = await checkPricingIntegrity(
    fakeDb({
      heightRows: [
        { companySOId: "SO-small", status: "X", lineNo: 1, productCode: "A", quantity: 1, divanHeightInches: 10, divanPriceSen: 0, legHeightInches: null, legPriceSen: 0 },
        { companySOId: "SO-big", status: "X", lineNo: 1, productCode: "B", quantity: 1, divanHeightInches: 12, divanPriceSen: 0, legHeightInches: 7, legPriceSen: 0 },
      ],
    }),
  );
  assert.ok(out[0].amountSen >= out[out.length - 1].amountSen);
  assert.match(out[0].ref, /SO-big/);
});

test("a broken query degrades to empty — the daily report must never 500 on this", async () => {
  const out = await checkPricingIntegrity(
    fakeDb({
      throwOn: "invoice_items",
      heightRows: [
        { companySOId: "SO-1", status: "X", lineNo: 1, productCode: "A", quantity: 1, divanHeightInches: 10, divanPriceSen: 0, legHeightInches: null, legPriceSen: 0 },
      ],
    }),
  );
  // The healthy check still reports; the broken one contributes nothing.
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "HEIGHT_CHOSEN_BUT_FREE");
});
