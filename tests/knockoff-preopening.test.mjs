// ---------------------------------------------------------------------------
// knockoff-preopening.test.mjs — the knock-off grid must not offer invoices
// the books don't carry.
//
// Owner 2026-08-06, staring at the Carress allocation grid: 「这里是不是有很多
// 旧的不录入的 invoice? 感觉很多」. It listed 18 pre-opening invoices Carress
// does not recognise, right beside the real ones. Money knocked onto one
// vanishes from the aging — the invoice it "paid" is behind the opening floor,
// so the receipt reduces nothing anyone can see. The GVP 950 (2026-07-08), the
// Houzs 25,000 and the Carress 14,418 unwound tonight all went through lists
// with exactly this trait.
//
// The list endpoint now marks each invoice `preOpening` (dated before the
// opening date AND not flagged as opening), and the grid hides those — except
// while an edited receipt still points at one, so the mistake stays undoable.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const API = read("src/api/routes/invoices.ts");
const UI = read("src/pages/invoices/payments.tsx");

test("the invoice list marks preOpening from the opening date and the flag", () => {
  assert.match(API, /const obDate = await getOpeningDate\(db\);/);
  assert.match(API, /preOpening:\s*\n?\s*!!obDate &&/);
  assert.match(API, /String\(inv\.invoiceDate \?\? ""\)\.slice\(0, 10\) < obDate/);
  assert.match(API, /!Number\(\(inv as unknown as \{ isOpening\?: number \| null \}\)\.isOpening \?\? 0\)/);
});

test("the knock-off grid hides them — but keeps one an edited receipt points at", () => {
  assert.match(UI, /\(!inv\.preOpening \|\| editBaseline\[inv\.id\] !== undefined\)/);
});

test("the hidden count is said out loud, not silently dropped", () => {
  assert.match(UI, /hiddenPreOpening/);
  assert.match(UI, /are hidden — the aging doesn't carry them/);
});

test("an opening-FLAGGED pre-opening invoice is NOT hidden", () => {
  // The six Carress ERP invoices counted as opening must stay knockable —
  // the flag is what separates them from the ghosts.
  const at = API.indexOf("preOpening:");
  assert.ok(at > 0);
  assert.match(API.slice(at, at + 260), /isOpening/);
});
