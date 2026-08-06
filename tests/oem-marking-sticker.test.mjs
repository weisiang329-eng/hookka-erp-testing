// ---------------------------------------------------------------------------
// The customer's OEM tag/label must reach the sticker.
//
// Owner 2026-08-06: Houzs Century (300-H) is set to TAG for sofa, and
// SO-2608-082-01 — a 5540 sofa for that customer — printed with no tag on it.
//
// The customer record was right the whole time. `oemMarkFor()` was written
// against a production-sheet row, which names the field `itemCategory`, and
// then called only with STICKERS, which name the same value `category`. So the
// lookup read undefined, bailed at the first line, and the tag never printed —
// for any customer, any category, on all four sticker layouts.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/pages/production/index.tsx"),
  "utf8",
);

// Same logic as oemMarkFor, kept in step by the source assertion below.
const oemMarkFor = (row, map) => {
  const cat = (row.itemCategory || row.category || "").toUpperCase();
  const key =
    cat === "BEDFRAME" ? "bedframe" : cat === "SOFA" ? "sofa" : cat === "ACCESSORY" ? "accessory" : "";
  if (!key) return "";
  const v = map.get(row.customerName || "")?.[key];
  return v === "TAG" || v === "LABEL" ? v : "";
};

// The live setting for 300-H on prod.
const MAP = new Map([
  ["Houzs Century", { bedframe: "NONE", sofa: "TAG", accessory: "NONE" }],
]);

test("a sticker's `category` resolves the tag, not just `itemCategory`", () => {
  assert.equal(
    oemMarkFor({ customerName: "Houzs Century", category: "SOFA" }, MAP),
    "TAG",
    "the sticker field name must be honoured — this is the reported bug",
  );
  assert.equal(
    oemMarkFor({ customerName: "Houzs Century", itemCategory: "SOFA" }, MAP),
    "TAG",
    "the production-sheet field name must keep working",
  );
});

test("only the category the customer marked gets a tag", () => {
  // 300-H is TAG for sofa and NONE for the other two — a bedframe for the same
  // customer must stay clean, or the line attaches tags to everything.
  assert.equal(oemMarkFor({ customerName: "Houzs Century", category: "BEDFRAME" }, MAP), "");
  assert.equal(oemMarkFor({ customerName: "Houzs Century", category: "ACCESSORY" }, MAP), "");
  assert.equal(oemMarkFor({ customerName: "Carress", category: "SOFA" }, MAP), "");
  assert.equal(oemMarkFor({ customerName: "", category: "SOFA" }, MAP), "");
  assert.equal(oemMarkFor({ customerName: "Houzs Century" }, MAP), "", "no category → no guess");
});

test("the source reads both field names", () => {
  assert.match(
    SRC,
    /row\.itemCategory \|\| row\.category/,
    "oemMarkFor must accept a sticker row as well as a production-sheet row",
  );
});
