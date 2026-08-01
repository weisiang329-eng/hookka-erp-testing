// ---------------------------------------------------------------------------
// party-alias.test.mjs — the scanners remember who a document belongs to.
//
// Owner 2026-08-01: 「无论什么情况我们改对了 OCR 就应该学习…都教导他了啊」.
//
// Before this, party IDENTITY had zero learned state: the confirm endpoints
// never persisted the corrected partyId, the queue wizards never reached
// confirm at all, and the weekly distill takes partyId as an INPUT (it learns a
// known party's document layout, never who the party is). An operator could
// correct the same supplier a hundred times and the hundred-and-first scan
// would still miss.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  aliasKey,
  resolveAlias,
  isPartyType,
  PARTY_TYPES,
} from "../src/api/lib/party-alias.ts";

test("aliasKey collapses legal suffix + punctuation so one alias covers the variants", () => {
  // These are the SAME letterhead as far as the memory is concerned.
  const variants = [
    "ADD WOOD TRADING SDN BHD",
    "ADD WOOD TRADING SDN. BHD.",
    "  add wood trading   sdn bhd  ",
    "ADD-WOOD-TRADING-SDN-BHD",
  ];
  const keys = new Set(variants.map(aliasKey));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(" | ")}`);
  assert.equal(aliasKey("ADD WOOD TRADING SDN BHD"), "ADDWOODTRADING");
});

test("aliasKey rejects names with no letters or digits", () => {
  for (const v of [null, undefined, "", "   ", "---", "Sdn Bhd"]) {
    assert.equal(aliasKey(v), "", `${JSON.stringify(v)} must not become a key`);
  }
});

test("a taught alias resolves the exact case that defeated every matcher", () => {
  // The master record reads "ADD WOORD…" (typo). Once taught, the invoice's
  // spelling resolves directly — no heuristic involved.
  const map = { ADDWOODTRADING: "sup-20d0fa1f" };
  assert.equal(resolveAlias(map, "ADD WOOD TRADING SDN BHD"), "sup-20d0fa1f");
  assert.equal(resolveAlias(map, "add wood trading sdn. bhd."), "sup-20d0fa1f");
});

test("resolveAlias misses safely", () => {
  const map = { ADDWOODTRADING: "sup-1" };
  assert.equal(resolveAlias(map, "SOMEONE ELSE"), null);
  assert.equal(resolveAlias(map, ""), null);
  assert.equal(resolveAlias(null, "ADD WOOD TRADING"), null);
  assert.equal(resolveAlias(undefined, "ADD WOOD TRADING"), null);
});

test("party types are a closed set — a customer alias can't resolve a supplier", () => {
  assert.deepEqual([...PARTY_TYPES], ["CUSTOMER", "SUPPLIER", "OTHER_PARTY"]);
  assert.ok(isPartyType("SUPPLIER"));
  assert.ok(!isPartyType("supplier"), "case-sensitive by design");
  assert.ok(!isPartyType("ANYTHING_ELSE"));
});

// --- wiring guards: every OCR surface must teach AND consult -----------------

test("PI and GRN wizards consult the alias map and teach after create", () => {
  const src = readFileSync("src/components/scan-supplier-modal.tsx", "utf8");
  assert.match(src, /usePartyAliases\("SUPPLIER", open\)/);
  // Both wizards pass the map into the matcher.
  const consults = src.match(/pickSupplierFromName\([^)]*supplierAliases\)/g) ?? [];
  assert.equal(consults.length, 2, `PI + GRN must both consult, found ${consults.length}`);
  // Both teach after a successful create.
  const teaches = src.match(/teachPartyAlias\(\{\s*partyType: "SUPPLIER"/g) ?? [];
  assert.equal(teaches.length, 2, `PI + GRN must both teach, found ${teaches.length}`);
});

test("customer PO wizard consults the alias map and teaches after create", () => {
  const src = readFileSync("src/components/scan-po-modal.tsx", "utf8");
  assert.match(src, /usePartyAliases\("CUSTOMER", open\)/);
  const consults = src.match(/resolveScanParty\([^)]*customerAliases\)/g) ?? [];
  assert.ok(consults.length >= 4, `all resolve sites must pass the map, found ${consults.length}`);
  assert.match(src, /teachPartyAlias\(\{\s*partyType: "CUSTOMER"/);
});

test("finance bills consult the alias map and teach after save", () => {
  const src = readFileSync("src/pages/accounting/index.tsx", "utf8");
  assert.match(src, /usePartyAliases\("OTHER_PARTY", true\)/);
  assert.match(src, /scanNameMatch\(allSideParties, d\.partyName, partyAliases\)/);
  assert.match(src, /teachPartyAlias\(\{\s*partyType: "OTHER_PARTY"/);
  // The old first-hit-wins containment had no ambiguity guard — 2+ hits must
  // now fall through to ranking instead of silently taking the first.
  assert.match(src, /if \(contained\.length === 1\) return contained\[0\];/);
  assert.match(src, /bestMatch\(list, name\)\?\.party/);
});

test("the alias check runs BEFORE the string heuristics", () => {
  // A human's answer must outrank every guess, or teaching achieves nothing.
  const sup = readFileSync("src/components/scan-supplier-modal.tsx", "utf8");
  const aliasAt = sup.indexOf("resolveAlias(aliasMap, guess)");
  const exactAt = sup.indexOf("const exact = suppliers.filter");
  assert.ok(aliasAt > 0 && exactAt > 0, "both steps must exist");
  assert.ok(aliasAt < exactAt, "alias lookup must precede the exact-name filter");

  const res = readFileSync("src/lib/scan-party-resolve.ts", "utf8");
  const aAt = res.indexOf("resolveAlias(aliasMap, po.customerName)");
  const mAt = res.indexOf("matchByCompanyName(customers");
  assert.ok(aAt > 0 && mAt > 0);
  assert.ok(aAt < mAt, "alias lookup must precede matchByCompanyName");
});

test("fuzzy ranking is the LAST resort, after the exact-ish heuristics", () => {
  const sup = readFileSync("src/components/scan-supplier-modal.tsx", "utf8");
  const containingAt = sup.indexOf("if (containing.length === 1) return containing[0];");
  const fuzzyAt = sup.indexOf("bestMatch(suppliers, guess)");
  assert.ok(containingAt > 0 && fuzzyAt > containingAt, "fuzzy must come last");
});
