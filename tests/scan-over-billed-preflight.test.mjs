// ---------------------------------------------------------------------------
// scan-over-billed-preflight.test.mjs — say it BEFORE Create, not after.
//
// Owner 2026-08-04: "你都知道有这种问题了，为什么你不解决呢？"
//
// Fair. The ADD WOOD invoice bills 164 of a material PO-2608-004 ordered 130 of.
// The API rejects that — correctly, it is a real over-invoice — but it did so
// only AFTER Create, as a wall of red with no way forward from where the
// operator was standing. Knowing a document will be refused and letting someone
// submit it anyway is not a guard, it is an ambush.
//
// So the preview now says it on the line itself, names both ways out, and the
// footer shows it without expanding every card. The API check is unchanged and
// remains the authority — this compares against ORDERED quantity only, since
// what other invoices already consumed needs a server round trip.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/components/scan-supplier-modal.tsx"),
  "utf8",
);

test("the over-billed line is flagged in the preview", () => {
  assert.match(SRC, /function poOrderedFor\(/);
  assert.equal(
    SRC.split("const po = poOrderedFor(line, purchaseOrders);").length - 1,
    2,
    "create-PI and create-GRN must both warn",
  );
});

test("it names BOTH ways out, not just the problem", () => {
  // A message that only says 'refused' leaves the operator exactly where they
  // were. Either the quantity is wrong here, or the PO needs amending.
  assert.match(SRC, /Change the quantity here to/);
  assert.match(SRC, /or amend \{po\.poNo\} to \{billed\} first if/);
});

test("it quotes the real numbers", () => {
  assert.match(SRC, /\{billed\} but \{po\.poNo\} only ordered \{po\.ordered\}/);
});

test("the PI wizard measures billed qty, the GRN wizard received qty", () => {
  assert.match(SRC, /const billed = Number\(line\.qty\) \|\| 0;/);
  assert.match(SRC, /const billed = Number\(line\.receivedQty\) \|\| 0;/);
});

test("the footer surfaces it without expanding every card", () => {
  assert.equal(SRC.split("const overBilledCards = cards.filter(").length - 1, 2);
  assert.match(SRC, /what the PO ordered/);
});

test("only lines actually tied to a PO are judged", () => {
  // A line with no poId has no ceiling to breach; flagging it would be noise.
  const fn = SRC.slice(SRC.indexOf("function poOrderedFor("));
  assert.match(fn.slice(0, 900), /if \(!code \|\| !line\.poId\) return null;/);
});

test("several PO lines of the same material are summed, not taken singly", () => {
  // A PO can list one material twice; comparing against one row alone would
  // report a false over-bill.
  const fn = SRC.slice(SRC.indexOf("function poOrderedFor("));
  assert.match(fn.slice(0, 900), /ordered \+= Number\(it\.quantity\) \|\| 0;/);
});

test("the client does not pretend to be the authority", () => {
  // It compares against ORDERED only; already-invoiced needs the server, and
  // the API keeps the exact check.
  assert.match(SRC, /This is the early warning, not\n \* a second authority\./);
});
