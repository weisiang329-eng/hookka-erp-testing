// The import route's contract — the parts a later edit could quietly undo.
//
// These read the source rather than boot a server: what matters here is not
// that a handler returns 200, it is that the handler still refuses to do two
// specific things. Both were deliberate decisions with a reason, and both are
// the kind that get "tidied up" by someone who does not know the reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/api/routes/sales-leads.ts", import.meta.url),
  "utf8",
);

/** The handler body from `app.<verb>("<path>"` to the next `app.` block. */
function handler(verb, path) {
  const start = src.indexOf(`app.${verb}("${path}"`);
  assert.notEqual(start, -1, `no handler for ${verb.toUpperCase()} ${path}`);
  const next = src.indexOf("\napp.", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

test("importing a bought list does NOT mint a customer per lead", () => {
  // POST / does mint one, and that is the owner's own ruling (2026-08-01): a
  // salesperson typing in a single lead is about to quote it. A bought list is
  // the opposite — 1,029 scraped names nobody has spoken to. Minting accounts
  // for those puts them in the table quotations, invoices and statements read
  // from, beside the 7 real customers.
  const imp = handler("post", "/import");
  assert.doesNotMatch(imp, /createPotentialCustomerForLead/);
  assert.doesNotMatch(imp, /INSERT INTO customers/i);

  // …and the single-lead path must still do it, or this test is passing for
  // the wrong reason.
  assert.match(handler("post", "/"), /createPotentialCustomerForLead/);
});

test("a dry run writes nothing", () => {
  const imp = handler("post", "/import");
  const dry = imp.indexOf("if (b.dryRun)");
  assert.notEqual(dry, -1, "no dry-run branch");
  const returnEnd = imp.indexOf("});", imp.indexOf("return c.json", dry));
  const branch = imp.slice(dry, returnEnd);
  assert.doesNotMatch(branch, /INSERT INTO/i, "the dry-run branch inserts rows");
  assert.doesNotMatch(branch, /DB\.batch/, "the dry-run branch writes a batch");
});

test("the list endpoint is bounded and reports the true total", () => {
  const get = handler("get", "/");
  assert.match(get, /LIMIT \? OFFSET \?/, "no LIMIT — this returned the whole table before");
  assert.match(get, /SELECT COUNT\(\*\) AS n FROM sales_leads/, "no total count");
  assert.match(get, /total: Number\(totalRow/, "total is not returned to the caller");
  // The cap must apply even when the caller asks for more, or a forgetful
  // caller re-creates the original problem.
  assert.match(get, /Math\.min\(/);
});

test("every imported lead carries a batch label", () => {
  const imp = handler("post", "/import");
  assert.match(imp, /makeBatchLabel\(/);
  assert.match(imp, /import_batch/);
});

test("deleting a batch refuses to silently destroy worked leads", () => {
  // Someone's phone calls live on those rows. The operator gets a count and a
  // decision, not a surprise.
  const del = handler("delete", "/import/:batch");
  assert.match(del, /workedCount/);
  assert.match(del, /409/);
  assert.match(del, /force/);
});

test("the import is tenant-scoped like everything else here", () => {
  for (const [verb, path] of [
    ["post", "/import"],
    ["delete", "/import/:batch"],
    ["get", "/batches"],
    ["get", "/industries"],
  ]) {
    assert.match(handler(verb, path), /getOrgId\(c\)/, `${verb} ${path}`);
    assert.match(handler(verb, path), /requirePermission\(/, `${verb} ${path}`);
  }
});

test("a single oversized import cannot be used to flood the table", () => {
  assert.match(handler("post", "/import"), /rows\.length > 5000/);
});
