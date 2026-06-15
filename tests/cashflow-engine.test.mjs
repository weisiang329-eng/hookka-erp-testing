import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href
);

const acct = (code, type, sat = null, name = code) => ({ code, name, type, sat });

test("defaultSectionFor — debtor control → REVENUE_COLLECTION", () => {
  assert.equal(cf.defaultSectionFor(acct("300-A001", "ASSET", "SDC")), "REVENUE_COLLECTION");
  assert.equal(cf.defaultSectionFor(acct("305-0000", "REVENUE")), "REVENUE_COLLECTION");
});
test("defaultSectionFor — AP control → RAW_MATERIALS", () => {
  assert.equal(cf.defaultSectionFor(acct("400-0000", "LIABILITY", "SCC")), "RAW_MATERIALS");
});
test("defaultSectionFor — labour / overhead / general", () => {
  assert.equal(cf.defaultSectionFor(acct("750-0010", "COST")), "DIRECT_LABOUR");
  assert.equal(cf.defaultSectionFor(acct("780-0030", "COST")), "FACTORY_OVERHEAD");
  assert.equal(cf.defaultSectionFor(acct("700-1015", "COST")), "FACTORY_OVERHEAD");
  assert.equal(cf.defaultSectionFor(acct("900-0001", "EXPENSE")), "GENERAL_EXPENSE");
});
test("defaultSectionFor — capex / gst / director / fallback", () => {
  assert.equal(cf.defaultSectionFor(acct("200-0040", "ASSET")), "CAPEX");
  assert.equal(cf.defaultSectionFor(acct("350-0000", "LIABILITY")), "REVENUE_COLLECTION");
  assert.equal(cf.defaultSectionFor(acct("450-0010", "LIABILITY")), "LOAN");
  assert.equal(cf.defaultSectionFor(acct("999-9999", "EXPENSE")), "GENERAL_EXPENSE");
  assert.equal(cf.defaultSectionFor(acct("130-0000", "ASSET")), "UNALLOCATED");
});
