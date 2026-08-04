// ---------------------------------------------------------------------------
// contact-format-phone.test.mjs — PhoneInput split/join must not "blow up" the
// number. Two operator-visible bugs are pinned here:
//   1. A "+60" shown against a national-format "011-6151 1613" (trunk 0 kept).
//   2. A dial code stacked into the local field ("+60 +60123…") after a paste
//      or a re-save.
// Both looked like the phone field was garbled and needed the dialog reopened.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { splitPhone, joinPhone, normalizeLocalNumber } from "../src/lib/contact-format.ts";

test("legacy MY number drops the national trunk 0 under +60", () => {
  assert.deepEqual(splitPhone("011-6151 1613"), { dial: "+60", local: "11-6151 1613" });
  assert.deepEqual(splitPhone("+60 011-6151 1613"), { dial: "+60", local: "11-6151 1613" });
  assert.deepEqual(splitPhone("03-1234 5678"), { dial: "+60", local: "3-1234 5678" });
});

test("a dial code pasted/typed into the local field is not stacked", () => {
  // The paste-the-whole-international case: local should NOT keep a second +60.
  assert.equal(normalizeLocalNumber("+60123456"), "123456");
  assert.equal(joinPhone("+60", "+60123456"), "+60 123456");
  // Re-splitting the join is stable — no growth on repeated edits/saves.
  assert.deepEqual(splitPhone(joinPhone("+60", "+60123456")), { dial: "+60", local: "123456" });
});

test("split → join → split is idempotent (no drift across re-saves)", () => {
  for (const stored of ["011-6151 1613", "+60 12-345 6789", "+65 8123 4567", "12345678"]) {
    const a = splitPhone(stored);
    const joined = joinPhone(a.dial, a.local);
    const b = splitPhone(joined);
    assert.deepEqual(b, a, `unstable round-trip for ${JSON.stringify(stored)}`);
    // And a second round changes nothing further.
    assert.equal(joinPhone(b.dial, b.local), joined, `second round drifted for ${stored}`);
  }
});

test("foreign dial codes are recognised, not swallowed into local", () => {
  assert.deepEqual(splitPhone("+65 8123 4567"), { dial: "+65", local: "8123 4567" });
  assert.deepEqual(splitPhone("+673 123 4567"), { dial: "+673", local: "123 4567" });
});

test("blank stays blank — never a bare dial code", () => {
  assert.equal(joinPhone("+60", ""), "");
  assert.equal(joinPhone("+60", "   "), "");
  assert.equal(joinPhone("+60", "0"), ""); // a lone trunk 0 is not a number
  assert.deepEqual(splitPhone(""), { dial: "+60", local: "" });
  assert.deepEqual(splitPhone(null), { dial: "+60", local: "" });
});
