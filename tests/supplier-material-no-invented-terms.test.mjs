// ---------------------------------------------------------------------------
// A supplier binding must never store terms the supplier did not give.
//
// THE BUG (BUG-2026-08-13-154): `POST /api/supplier-materials` persisted
// `Number(body.leadTimeDays) || 7` and `Number(body.moq) || 1`. Leaving those
// fields blank on the create form wrote a 7-day lead time and an MOQ of 1 into
// the table — and `/planning/mrp` printed them UNDER THE SUPPLIER'S NAME, and
// derived an "Order By" date from the invented 14/7.
//
// The read side was fixed first (it renders "—" for the never-filled value).
// That is not enough on its own, and this test exists to say why: **a read-side
// "—" cannot undo a literal already written to the table.** Every row created
// through the POST path while `|| 7` was live still carries a 7 that is
// indistinguishable from a real one.
//
// 0 is the never-filled representation — both columns are
// `INTEGER NOT NULL DEFAULT 0` (`migrations-postgres/0001_init.sql:273,275`),
// so "blank" has no other encoding, and 0 is what the MRP read path already
// treats as unknown.
//
// Source-text test: there is no DB in unit tests. It asserts on the ONE
// statement, not on the file — a file-wide match proves nothing about a
// specific line (the lesson from tests/sales-leads.test.mjs, which "proved"
// tenant scoping while an INSERT wrote cross-org rows).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SRC = readFileSync("src/api/routes/supplier-materials.ts", "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("POST does not invent a lead time when the field is blank", () => {
  assert.doesNotMatch(
    CODE,
    /leadTimeDays:\s*Number\(body\.leadTimeDays\)\s*\|\|\s*[1-9]/,
    "POST is defaulting a blank lead time to a non-zero literal — that value reaches " +
      "/planning/mrp and prints beside the supplier's name as though they had stated it",
  );
});

test("POST does not invent a minimum order quantity when the field is blank", () => {
  assert.doesNotMatch(
    CODE,
    /moq:\s*Number\(body\.moq\)\s*\|\|\s*[1-9]/,
    "POST is defaulting a blank MOQ to a non-zero literal — the shortage suggestion is " +
      "then rounded up to a quantity the supplier never required",
  );
});

test("both fields are still written, so the NOT NULL columns are satisfied", () => {
  // The fix must not become "omit the column" — they are NOT NULL, so an
  // omitted bind would fail the insert rather than record "unknown".
  assert.match(CODE, /leadTimeDays:\s*Number\(body\.leadTimeDays\)\s*\|\|\s*0/);
  assert.match(CODE, /moq:\s*Number\(body\.moq\)\s*\|\|\s*0/);
});

test("the PUT path still writes only what was supplied", () => {
  // PUT was always honest. Pin it so a future "consistency" pass does not
  // level the two by making PUT invent defaults too.
  assert.match(
    CODE,
    /leadTimeDays:\s*\n?\s*body\.leadTimeDays\s*!==\s*undefined\s*\n?\s*\?\s*Number\(body\.leadTimeDays\)\s*\n?\s*:\s*existing\.leadTimeDays/,
    "PUT must keep the existing value when the field is absent, not substitute a literal",
  );
  assert.match(
    CODE,
    /moq:\s*body\.moq\s*!==\s*undefined\s*\?\s*Number\(body\.moq\)\s*:\s*existing\.moq/,
  );
});
