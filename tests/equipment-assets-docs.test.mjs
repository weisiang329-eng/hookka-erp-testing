// ---------------------------------------------------------------------------
// equipment-assets-docs.test.mjs — an equipment record carries its identity AND
// its paperwork (owner 2026-08-01: 「这个地方要可以upload我们的purchase
// agreement 和model 和这个机器的照片」).
//
// The module tracked code / name / department / type / status / maintenance
// cycle / purchase date only — enough to schedule a service, not enough to tie a
// machine on the floor back to what was bought, from whom, for how much, or
// whether it's still under warranty.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("src/api/routes/equipment.ts", "utf8");
const page = readFileSync("src/pages/maintenance.tsx", "utf8");
const docs = readFileSync("src/components/resource-documents.tsx", "utf8");
const types = readFileSync("src/types/index.ts", "utf8");

test("the six asset columns are self-applied at runtime", () => {
  // Migration files are inert on deploy (CLAUDE.md) — a new column reaches prod
  // ONLY via a runtime ALTER, awaited before the first write that names it.
  for (const col of ["model", "serial_no", "manufacturer", "supplier", "purchase_price_sen", "warranty_expiry"]) {
    assert.match(
      route,
      new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`),
      `${col} must be runtime self-applied`,
    );
  }
  assert.match(route, /_equipColsMig/, "memoised once per isolate");
});

test("the ensure runs before every path that reads or writes the new columns", () => {
  const calls = route.match(/ensureEquipmentAssetColumns\(c\.var\.DB\)/g) ?? [];
  assert.ok(calls.length >= 3, `GET + POST + PUT must all ensure, found ${calls.length}`);
});

test("new columns are snake_case in SQL and dual-keyed on read", () => {
  // CLAUDE.md: a camelCase column in route SQL silently 400s without a
  // rename-map entry; reads must tolerate either casing.
  assert.match(route, /serial_no = \?/);
  assert.match(route, /purchase_price_sen = \?/);
  assert.match(route, /row\.serialNo \?\? row\.serial_no/);
  assert.match(route, /row\.purchasePriceSen \?\? row\.purchase_price_sen/);
});

test("purchase price is stored as integer sen, never a float", () => {
  assert.match(route, /function toSen/);
  assert.match(route, /Math\.round\(n \* 100\)/);
  // The form collects ringgit and the API converts — the field name says so.
  assert.match(page, /name="purchasePriceRM"/);
  assert.match(route, /toSen\(body\.purchasePriceRM\)/);
});

test("a partial PUT can't blank fields another dialog owns", () => {
  assert.match(route, /const pick = <T,>\(fresh: T \| undefined, current: T\)/);
  assert.match(route, /model: pick\(body\.model/);
});

test("both the add and edit forms collect the asset fields", () => {
  for (const f of ["model", "serialNo", "manufacturer", "supplier", "purchasePriceRM", "warrantyExpiry"]) {
    const hits = page.match(new RegExp(`name="${f}"`, "g")) ?? [];
    assert.equal(hits.length, 2, `${f} must appear in BOTH forms, found ${hits.length}`);
  }
});

test("documents attach to the shared /api/files store — no new table", () => {
  assert.match(docs, /fd\.append\("resourceType", resourceType\)/);
  assert.match(docs, /fd\.append\("resourceId", resourceId\)/);
  assert.match(page, /resourceType="equipment"/);
  assert.match(page, /resourceId=\{editingEquipment\.id\}/);
});

test("the upload panel covers the document kinds the owner asked for", () => {
  for (const c of ["AGREEMENT", "WARRANTY", "MANUAL", "PHOTO", "OTHER"]) {
    assert.match(docs, new RegExp(`value: "${c}"`));
  }
  // Photos render as thumbnails — a nameplate shot is useless if you have to
  // download it to read it.
  assert.match(docs, /g\.value === "PHOTO"/);
  assert.match(docs, /<img/);
});

test("upload failures are reported per file, not as one blanket error", () => {
  // A size rejection applies to one file; the rest of the batch still landed.
  assert.match(docs, /failures\.push\(/);
  assert.match(docs, /for \(const f of failures\) toast\.error\(f\)/);
});

test("the Equipment type carries the new fields as optional", () => {
  // Optional: rows created before the columns existed don't have them.
  assert.match(types, /purchasePriceSen\?: number;/);
  assert.match(types, /warrantyExpiry\?: string;/);
});
