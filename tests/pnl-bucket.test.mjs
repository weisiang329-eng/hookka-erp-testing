import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/pnl-bucket.ts")).href);

test("defaultPnlBucket — by type and code band", () => {
  assert.equal(m.defaultPnlBucket("300-0000", "REVENUE"), "REVENUE");
  assert.equal(m.defaultPnlBucket("530-0000", "REVENUE"), "OTHER_INCOME");
  assert.equal(m.defaultPnlBucket("750-0010", "COST"), "DIRECT_LABOUR");
  assert.equal(m.defaultPnlBucket("780-0030", "COST"), "FACTORY_OVERHEAD");
  assert.equal(m.defaultPnlBucket("900-0001", "EXPENSE"), "OPERATING_EXPENSE");
  assert.equal(m.defaultPnlBucket("900-S001", "EXPENSE"), "OPEX_SALARIES");
  assert.equal(m.defaultPnlBucket("700-1015", "COST"), null);
  assert.equal(m.defaultPnlBucket("330-0000", "ASSET"), null);
});

test("pnlBucketFor — same-class override wins, cross-class ignored", () => {
  assert.equal(m.pnlBucketFor("900-0001", "EXPENSE", { "900-0001": "FACTORY_OVERHEAD" }), "FACTORY_OVERHEAD");
  assert.equal(m.pnlBucketFor("750-0010", "COST", { "750-0010": "OPERATING_EXPENSE" }), "OPERATING_EXPENSE");
  assert.equal(m.pnlBucketFor("300-0000", "REVENUE", { "300-0000": "OTHER_INCOME" }), "OTHER_INCOME");
  assert.equal(m.pnlBucketFor("900-0001", "EXPENSE", { "900-0001": "REVENUE" }), "OPERATING_EXPENSE");
  assert.equal(m.pnlBucketFor("780-0030", "COST", {}), "FACTORY_OVERHEAD");
  assert.equal(m.pnlBucketFor("700-1015", "COST", { "700-1015": "FACTORY_OVERHEAD" }), null);
});
