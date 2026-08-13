// delivery_incomplete — the "delivered with issues" billing hold
// (BUG-2026-08-13-072)
//
// The hold existed since 2026-06-14 and had NEVER fired. Every reader used the
// snake_case spelling, but `delivery_incomplete` is absent from
// column-rename-map.json, so db-pg.ts's `columnFrom` falls through to
// `postgres.toCamel` and the row arrives as `deliveryIncomplete`. Each read was
// therefore `undefined`:
//
//   Number(undefined) === 1   -> false   the invoice hold never engaged
//   Number(undefined) !== 1   -> true    resolve-incomplete rejected everything
//   !!Number(undefined)       -> false   the flag never reached the UI at all
//
// Verified on prod 2026-08-13: the delivery-orders list carries the key
// `deliveryIncomplete`, not `delivery_incomplete` — the shim's behaviour, live.
//
// Two comments actively defended the wrong spelling: one called it a
// "folded-lowercase runtime column" and another said snake_case was chosen "so
// the unquoted-identifier fold can't split read/write keys". Folding applies to
// unquoted MIXED-CASE identifiers; this name has an underscore and is never
// folded. A confident wrong comment is why five readers stayed broken.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILES = [
  "src/api/routes/invoices.ts",
  "src/api/routes/delivery-orders.ts",
  "src/api/routes/delivery-orders/_helpers.ts",
  "src/api/routes/public-do-qr.ts",
];

const read = (p) =>
  readFileSync(resolve(process.cwd(), p), "utf8")
    .replace(/\r\n/g, "\n")
    // Strip comments: this file's own history proves prose can look like a fix.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("no reader takes delivery_incomplete off a row without the camelCase fallback", () => {
  const offenders = [];
  for (const f of FILES) {
    // Blank out every CORRECT pair first, then anything still holding a
    // snake_case property access is a genuine single-spelling read.
    //
    // The obvious lookahead — /\.delivery_incomplete\b(?!\s*\?\?)/ — is wrong,
    // and wrong in a way that fails LOUDLY rather than silently: in
    // `x.deliveryIncomplete ?? x.delivery_incomplete` the second half has no
    // `??` after it, so the guard flagged the fix it was written to protect.
    // Caught because the test went red against known-good code; had it been
    // inverted it would have gone green against a broken one.
    const code = read(f).replace(
      /\b(\w+)\.deliveryIncomplete\s*\?\?\s*\1\.delivery_incomplete\b/g,
      "«ok»",
    );
    // SQL strings and type declarations legitimately use the real column name;
    // requiring a leading dot restricts this to property access on a row.
    for (const m of code.matchAll(/\.delivery_incomplete\b/g)) {
      const line = code.slice(0, m.index).split("\n").length;
      offenders.push(`${f}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "read it as `row.deliveryIncomplete ?? row.delivery_incomplete` — the shim " +
      "returns the camelCase spelling, so a lone snake_case read is always undefined",
  );
});

test("every row type declares BOTH spellings", () => {
  // Declaring one spelling is what let tsc CERTIFY the wrong read rather than
  // catch it — the same mechanism that shipped RM 0.00 credit notes
  // (BUG-2026-08-13-034). With both declared, `?? ` typechecks and a lone
  // snake_case read still compiles, so the guard above is what forbids it.
  for (const f of ["src/api/routes/delivery-orders/_helpers.ts", "src/api/routes/public-do-qr.ts"]) {
    const code = read(f);
    assert.match(code, /deliveryIncomplete\?:\s*number \| null;/, `${f} must declare deliveryIncomplete`);
    assert.match(code, /delivery_incomplete\?:\s*number \| null;/, `${f} must declare delivery_incomplete`);
  }
});

test("the three behavioural readers are present and dual-keyed", () => {
  // Pin each site by its role, so deleting a guard fails loudly instead of
  // quietly passing the "no offenders" check above.
  const inv = read("src/api/routes/invoices.ts");
  assert.match(
    inv,
    /Number\(\s*doRow\.deliveryIncomplete\s*\?\?\s*doRow\.delivery_incomplete\s*\)\s*===\s*1/,
    "the invoice hold must still test the flag",
  );

  const dos = read("src/api/routes/delivery-orders.ts");
  assert.match(
    dos,
    /Number\(\s*existing\.deliveryIncomplete\s*\?\?\s*existing\.delivery_incomplete\s*\)\s*!==\s*1/,
    "resolve-incomplete must still reject DOs that are not flagged",
  );

  const helpers = read("src/api/routes/delivery-orders/_helpers.ts");
  assert.match(
    helpers,
    /deliveryIncomplete:\s*!!Number\(\s*row\.deliveryIncomplete\s*\?\?\s*row\.delivery_incomplete\s*\)/,
    "the list projection must still emit the flag to the UI",
  );
});
